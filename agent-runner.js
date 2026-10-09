// Installs and runs agents, keeping each one ticking on its own schedule
// for as long as the app is open, and picking back up automatically on
// restart. One AgentManager instance owns everything -- installing,
// removing, pausing, the actual per-agent tick loops, and now packages
// and secrets.

const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { unzipSync, strFromU8 } = require('fflate')
const { createClient } = require('./scryboard-client')
const { WakeListener } = require('./wake-listener')
const { loadStore, saveStore, agentFilesDir, encryptToken, decryptToken } = require('./store')

// Must stay in sync with VETTED_PACKAGES in src/lib/agentPackage.ts (the
// website's own copy of this same list, checked at submission time). This
// is the runner's copy -- it decides what actually gets bundled into the
// app and linked into an agent's folder at install time.
const VETTED_PACKAGES = ['@anthropic-ai/sdk', 'pdf-parse', 'jimp', 'zod', 'date-fns']

// Folders a package never gets to ship into an install, wherever they
// appear in a path -- the same list as isIgnorable() in the website's
// src/lib/agentPackage.ts, which drops them before validating a
// submission. The raw zip is what gets stored and downloaded, though, so
// without this a developer's own state/ (dev fixtures, test ledgers) or
// dev/ scripts would land in every buyer's install -- and on an update,
// a shipped state/ file would overwrite the buyer's real one.
const IGNORED_SEGMENTS = new Set(['.DS_Store', '.git', 'node_modules', 'dev', 'state', 'output', 'input'])

// Folders an app writes to at runtime, never part of its code. An update
// leaves them alone; see removeStaleCodeFiles.
const RUNTIME_FOLDERS = new Set(['input', 'state', 'output', 'node_modules'])

// Unzips a downloaded package into { 'relative/path': bytes }.
//
// Entry names are normalised first: a zip made on Windows can store
// backslash separators ("lib\\render.mjs"), which the website's scanner
// and this file's own ignore rules would otherwise read as one odd
// filename. Anything that could write outside the app's own folder (an
// absolute path, a drive letter, "..", a colon for an alternate data
// stream) fails the whole install rather than being quietly skipped.
function unpackPackage(bytes) {
  const raw = unzipSync(bytes)
  const files = {}
  for (const [name, data] of Object.entries(raw)) {
    const normalised = name.replace(/\\/g, '/')
    if (normalised.endsWith('/') || normalised.startsWith('__MACOSX/')) continue
    const segments = normalised.split('/').filter((s) => s !== '' && s !== '.')
    if (segments.length === 0) continue
    if (normalised.startsWith('/') || segments.some((s) => s === '..' || s.includes(':'))) {
      throw new Error(`The package contains an unsafe file path ("${name}").`)
    }
    if (segments.some((s) => IGNORED_SEGMENTS.has(s))) continue
    files[segments.join('/')] = data
  }
  return stripCommonRoot(files)
}

// The manifest's `external` block (third-party services the app talks to
// directly -- see docs/agent-manifest.md on the website), trimmed to the
// fields the install prompt shows. The website already validated it at
// submission; this only guards against a malformed entry breaking the
// prompt.
function externalServices(manifest) {
  const direct = !Array.isArray(manifest.external) ? [] : manifest.external
    .filter((e) => e && typeof e.name === 'string' && e.name.trim())
    .map((e) => ({
      name: e.name,
      reads: typeof e.reads === 'string' ? e.reads : '',
      writes: typeof e.writes === 'string' ? e.writes : '',
      requiresPaidAccount: e.requires_paid_account === true,
      costNote: typeof e.cost_note === 'string' ? e.cost_note : '',
    }))
  return [...direct, ...scryboardServices(manifest)]
}

// The manifest's `services` block: providers the app reaches THROUGH
// Scryboard, which holds the key (server-held keys, 0.2.9). Nothing to type
// here -- the buyer only needs to know whose key pays. Shown in the same
// install-prompt list as `external`, flagged viaScryboard.
const SCRYBOARD_SERVICE_TEXT = {
  claude: {
    name: 'Claude (Anthropic)',
    note: 'Uses the Anthropic key saved in your Scryboard account (Settings, then "Your own AI key"), billed to your own Anthropic account. No key is entered here.',
  },
  elevenlabs_tts: {
    name: 'ElevenLabs voices',
    note: "Provided by the app's developer: you don't need an ElevenLabs account. The developer sets how many lines each buyer gets per month or year.",
  },
}

function scryboardServices(manifest) {
  if (!Array.isArray(manifest.services)) return []
  return manifest.services
    .filter((s) => s && SCRYBOARD_SERVICE_TEXT[s.service])
    .map((s) => ({
      name: SCRYBOARD_SERVICE_TEXT[s.service].name,
      reads: '',
      writes: typeof s.why === 'string' ? s.why : '',
      requiresPaidAccount: false,
      costNote: SCRYBOARD_SERVICE_TEXT[s.service].note,
      viaScryboard: true,
    }))
}

// Writes a package's files into an app's folder as raw bytes (never
// re-decoded as text, so an image or other binary asset survives intact).
async function writePackageFiles(dir, files) {
  for (const [filePath, content] of Object.entries(files)) {
    const dest = path.join(dir, filePath)
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(dest, content)
  }
}

// Zip entries for a wrapped folder, macOS metadata, etc. -- same tolerance
// as the web app's own upload handling (src/lib/agentPackage.ts), since
// this reads the exact same files that path validated at submission time.
function stripCommonRoot(files) {
  const paths = Object.keys(files).filter((p) => !p.endsWith('/') && !p.startsWith('__MACOSX/'))
  if (paths.length === 0) return files
  const firstSegments = new Set(paths.map((p) => p.split('/')[0]))
  if (firstSegments.size !== 1 || paths.some((p) => !p.includes('/'))) {
    return Object.fromEntries(paths.map((p) => [p, files[p]]))
  }
  const root = `${[...firstSegments][0]}/`
  return Object.fromEntries(paths.map((p) => [p.slice(root.length), files[p]]))
}

// Total bytes a single declared input may add up to across all its picked
// files -- generous enough for a real multi-photo character sheet, bounded
// enough that picking the wrong folder fails fast instead of silently
// copying gigabytes.
const MAX_INPUT_BYTES = 25 * 1024 * 1024

// Copies buyer-picked files into <agentDir>/input/<key>/, replacing
// whatever was there for that key. This is the whole mechanism -- an
// agent that already watches ./input/ next to itself (the folder-watch
// pattern from the character-sheet agent) needs zero code changes beyond
// pointing at the keyed subfolder, since nothing here talks to the agent's
// code directly.
async function copyPickedFiles(agentDir, key, filePaths) {
  const destDir = path.join(agentDir, 'input', key)
  await fs.rm(destDir, { recursive: true, force: true }).catch(() => {})
  if (!filePaths || filePaths.length === 0) return
  await fs.mkdir(destDir, { recursive: true })

  let total = 0
  for (const src of filePaths) {
    const stat = await fs.stat(src)
    total += stat.size
    if (total > MAX_INPUT_BYTES) {
      await fs.rm(destDir, { recursive: true, force: true }).catch(() => {})
      throw new Error(`Selected files are too large (max ${Math.round(MAX_INPUT_BYTES / 1024 / 1024)}MB total).`)
    }
    await fs.copyFile(src, path.join(destDir, path.basename(src)))
  }
}

// Where an agent's code actually lives. A personal agent runs from the
// folder the author already has on disk (see localPath below); everything
// else runs from a copy this app downloaded and owns.
function agentDirFor(record, id) {
  return record.localPath || agentFilesDir(id)
}

// The addresses that all serve the one live Scryboard (same site, same
// database). An install from any of them counts as the same site, so a key
// saved from one is reused from another.
const LIVE_SITE_HOSTS = ['scryboard.net', 'scryboard.vercel.app']

function siteOf(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^www\./, '')
    return LIVE_SITE_HOSTS.includes(host) ? 'live' : String(baseUrl).replace(/\/+$/, '')
  } catch {
    return baseUrl
  }
}

function sameSite(a, b) {
  return siteOf(a) === siteOf(b)
}

// Two installs are the same app when they have the same name from the same
// Scryboard site -- e.g. Previously On in two campaigns. Their keys are
// shared (see savedSecretsFor and updateAgentSecrets).
function sameApp(a, b) {
  return a.name === b.name && sameSite(a.baseUrl, b.baseUrl)
}

// Only the saved keys this manifest actually declares, non-empty.
function pickSecrets(manifest, values) {
  const out = {}
  for (const s of manifest.secrets ?? []) {
    const v = values?.[s.key]
    if (v && String(v).trim()) out[s.key] = v
  }
  return out
}

// Newest mtime across an agent's own code, used to cache-bust the dynamic
// import in runTick.
//
// Node caches ES modules by URL forever, so without this an agent keeps
// running whatever code was loaded the first time -- which broke two
// things quietly: a marketplace agent kept running its old version after
// an update until the whole app was restarted, and a personal agent
// running from a local folder would never pick up an edit at all,
// defeating the point of pointing at the folder in the first place.
// Keying the query string on mtime (rather than Date.now()) means
// unchanged code still hits the module cache instead of leaking a fresh
// module graph on every tick.
async function maxCodeMtime(dir) {
  let newest = 0
  async function walk(current) {
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      // Runtime folders are skipped, not just input/: an app rewriting
      // state/*.json every tick would otherwise bump the stamp every tick
      // and re-import (and leak) a fresh copy of its whole module graph.
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      if (current === dir && RUNTIME_FOLDERS.has(entry.name)) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (/\.(mjs|cjs|js|json)$/.test(entry.name)) {
        const stat = await fs.stat(full).catch(() => null)
        if (stat && stat.mtimeMs > newest) newest = stat.mtimeMs
      }
    }
  }
  await walk(dir)
  return Math.round(newest)
}

// Files an agent has written to <agentDir>/output/, for the Runner's own
// "Open folder" affordance. output/ is the documented convention for
// anything an agent produces for its buyer to use outside Scryboard (an
// export to drag into a note uploader, a generated report, etc.) -- see
// docs/agent-manifest.md on the website. Not recursive; a flat folder is
// the whole convention.
async function scanOutputFiles(agentDir) {
  try {
    const entries = await fs.readdir(path.join(agentDir, 'output'), { withFileTypes: true })
    const files = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const stat = await fs.stat(path.join(agentDir, 'output', entry.name)).catch(() => null)
      if (stat) files.push({ name: entry.name, mtimeMs: Math.round(stat.mtimeMs) })
    }
    return files
  } catch {
    return [] // no output/ folder yet -- not every agent has one, and none do before their first tick
  }
}

// An update replaces an app's code, but everything the app itself has
// written must survive it: state/ (ledgers, cursors, "already billed for
// this" records), output/ (for some apps the only copy of what the buyer
// paid for), a root-level processed.json, the buyer's input/ files. An
// earlier version deleted everything except input/ and node_modules,
// which wiped all of that on every update.
//
// So an update now only ever deletes files it can prove were CODE: the
// ones the previous version's own package contained (record.codeFiles,
// saved at install/update) that the new package no longer has. Anything
// not on that list is left alone. An install from before that list was
// kept has none, and then nothing is deleted at all -- a leftover file
// from an old version is harmless (nothing imports a file its own code
// no longer ships), a deleted ledger is not.
async function removeStaleCodeFiles(dir, previousFiles, nextFiles) {
  if (!Array.isArray(previousFiles)) return
  const keep = new Set(nextFiles)
  const root = path.resolve(dir)
  for (const rel of previousFiles) {
    if (keep.has(rel) || RUNTIME_FOLDERS.has(rel.split('/')[0])) continue
    const full = path.resolve(root, rel)
    if (!full.startsWith(root + path.sep)) continue // never outside the app's own folder
    await fs.rm(full, { force: true }).catch(() => {})
    // Tidy up folders the removed file leaves empty (rmdir refuses a
    // non-empty one, which is exactly the stopping condition wanted).
    let parent = path.dirname(full)
    while (parent !== root && parent.startsWith(root + path.sep)) {
      try { await fs.rmdir(parent) } catch { break }
      parent = path.dirname(parent)
    }
  }
}

// Whether an installed app's record belongs to the campaign a download
// link resolved to. By id when both sides have one; otherwise by name,
// which is all older Scryboard versions send -- and which can't tell two
// campaigns with the same name apart.
function sameCampaign(record, campaignId, campaignName) {
  if (record.campaignId && campaignId) return record.campaignId === campaignId
  return record.campaignName === campaignName
}

// The longest one tick may run before the Runner gives up on it. Every
// app's tick holds the shared tick lock (see withTickLock), so without a
// cap one hung request -- a third-party API that never answers -- stopped
// that app ticking AND every other installed app behind it, until the
// Runner was restarted. Generous on purpose: a real tick that calls an
// LLM and a text-to-speech service, or waits out a partner API's rate
// limit, can legitimately take several minutes.
const TICK_TIMEOUT_MS = 10 * 60 * 1000
// Nudge-started ticks of one app are at least this far apart (0.2.7).
const WAKE_GAP_MS = 3 * 1000

// Resolves/rejects with `promise`, or rejects with onTimeout()'s error
// after `ms`. The original promise is not cancelled (JavaScript can't),
// only no longer waited for -- onTimeout is where the caller cuts off
// what it can.
function withTimeout(promise, ms, onTimeout) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

class AgentManager {
  constructor(onListChange, playback = null) {
    this.records = []          // persisted fields plus transient status/statusDetail
    this.tokens = new Map()    // id -> decrypted token, kept in memory only, never persisted raw
    this.secrets = new Map()   // id -> { KEY: decrypted value }, same -- memory only
    this.timers = new Map()    // id -> pending setTimeout handle
    this.stopped = new Set()
    // "Run now" nudges (0.2.7) -- see wake-listener.js and wake() below.
    this.wakers = new Map()    // id -> WakeListener
    this.inFlight = new Set()  // ids whose tick is running right now
    this.wakeAgain = new Set() // ids nudged mid-tick: run once more when it ends
    this.lastWokenAt = new Map() // id -> ms of the last nudge-started tick
    this.pendingInstalls = new Map() // pendingId -> download already done, waiting on secret input
    this.allSecretKeys = new Set()   // every secret key name ever used, across every agent --
                                      // lets runTick wipe all of them before/after each tick so one
                                      // agent's key can never linger and leak into another's run
    this.onListChange = onListChange || (() => {})
    this.playback = playback   // PlaybackManager (or null in a build without one)
    this.tickLock = Promise.resolve() // see withTickLock()
  }

  // Every installed agent polls on its own independent timer, but they all
  // share ONE Node process -- and therefore one process.env. runTick below
  // stamps this agent's secrets into it, runs the agent's code, then wipes
  // them, on the assumption that only one agent's tick is ever "in" that
  // window at a time. That assumption doesn't hold on its own: a tick can
  // sit awaiting network calls (an LLM call, a TTS call) for many seconds,
  // which is plenty of time for a faster-polling agent's own timer to fire
  // and run the exact same clear-then-set dance in the middle of it --
  // wiping the first agent's keys out from under it (or leaking its own
  // in). This queue makes "one agent's tick at a time" actually true
  // instead of merely likely.
  withTickLock(fn) {
    const previous = this.tickLock
    let release
    this.tickLock = new Promise((resolve) => { release = resolve })
    return previous.then(fn).finally(release)
  }

  // Which device capabilities this agent actually holds right now.
  //
  // Two sources, deliberately different: a DOWNLOADED app's capabilities
  // are whatever was consented to at install/update time and stored on
  // the record -- editing a manifest server-side must never grow an
  // ability without the buyer seeing a prompt. A PERSONAL agent
  // (localPath) reads its own folder's scryboard.json fresh every tick:
  // it's the user's own code in the user's own folder, the same trust
  // grant as pointing the Runner at it in the first place, and it means
  // an edit takes effect on the next tick instead of needing a
  // remove-and-reconnect.
  async capabilitiesFor(record) {
    if (record.localPath) {
      try {
        const manifest = JSON.parse(
          await fs.readFile(path.join(record.localPath, 'scryboard.json'), 'utf8')
        )
        return new Set(Array.isArray(manifest.capabilities) ? manifest.capabilities : [])
      } catch {
        return new Set() // unreadable manifest -- no capabilities rather than stale ones
      }
    }
    return new Set(record.capabilities || [])
  }

  async init() {
    this.records = await loadStore()
    let backfilled = false
    for (const record of this.records) {
      record.status = 'idle'
      record.statusDetail = ''
      // Records saved before "secrets" schema started being persisted
      // (i.e. installed before "Update keys" existed) won't have it --
      // backfill from the agent's own on-disk scryboard.json, which is
      // already there from install/update, so the button can appear right
      // away instead of only after the next manual Update.
      if (record.secrets === undefined) {
        try {
          const dir = agentDirFor(record, record.id)
          const manifest = JSON.parse(await fs.readFile(path.join(dir, 'scryboard.json'), 'utf8'))
          record.secrets = manifest.secrets || []
        } catch {
          record.secrets = []
        }
        backfilled = true
      }
      try {
        this.tokens.set(record.id, decryptToken(record.encryptedToken))
        const secretValues = {}
        for (const [key, encrypted] of Object.entries(record.encryptedSecrets || {})) {
          secretValues[key] = decryptToken(encrypted) // generic string decryption, same helper
          this.allSecretKeys.add(key)
        }
        this.secrets.set(record.id, secretValues)
      } catch (err) {
        this.setStatus(record.id, 'error', `Could not unlock saved credentials: ${err.message}`)
        continue
      }
      if (record.enabled) this.scheduleLoop(record.id)
      else { record.status = 'idle'; record.statusDetail = 'Paused' }
    }
    if (backfilled) await this.persist()
    this.onListChange(this.list())
  }

  list() {
    return this.records.map((r) => {
      const outputFiles = r.outputFiles || []
      const acknowledgedAt = r.outputAcknowledgedAt || 0
      return {
        id: r.id,
        name: r.name,
        campaignName: r.campaignName,
        version: r.version || null,
        enabled: r.enabled,
        installedAt: r.installedAt,
        status: r.status || 'idle',
        statusDetail: r.statusDetail || '',
        inputs: r.inputs || [],
        secrets: r.secrets || [],
        localPath: r.localPath || null,
        outputFiles,
        // True when this app has written something to output/ since the
        // buyer last opened its folder -- drives the "new file" highlight
        // on the Open Folder button so a generated export doesn't sit
        // there unnoticed.
        hasNewOutput: outputFiles.some((f) => f.mtimeMs > acknowledgedAt),
      }
    })
  }

  setStatus(id, status, detail) {
    const record = this.records.find((r) => r.id === id)
    if (record) { record.status = status; record.statusDetail = detail }
    this.onListChange(this.list())
  }

  // status/statusDetail are recomputed fresh every time the app starts
  // (first tick tells us the truth) -- not meaningful to persist.
  async persist() {
    await saveStore(this.records.map(({ status: _s, statusDetail: _sd, ...rest }) => rest))
  }

  // Step 1: download and validate. If the agent needs secrets or declares
  // any inputs (files), this stops here and hands back what to ask for,
  // rather than finishing the install -- the caller (main.js) is expected
  // to prompt and call completeInstall. If it needs nothing, it finishes
  // immediately, same as before.
  //
  // Inputs differ from secrets in one deliberate way: the prompt fires for
  // ANY declared input, not just required ones. A required secret blocks
  // install because the agent can't function without it; an optional file
  // input is worth offering up front (skippable) rather than only
  // surfacing once something's already broken.
  async beginInstall(rawUrl) {
    const parsed = new URL(rawUrl)
    if (parsed.protocol.replace(':', '') !== 'scryboard-agent') {
      throw new Error('Expected a scryboard-agent:// link.')
    }
    const token = parsed.searchParams.get('token')
    const base = parsed.searchParams.get('base')
    if (!token || !base) throw new Error('Link is missing a token or base URL.')

    // Ask what this token points at before fetching anything -- a personal
    // agent's code is already on this machine, so downloading a copy of it
    // would be a pointless round trip (and would mean every edit needed a
    // re-upload before it took effect).
    const infoRes = await fetch(`${base}/api/agent/info`, { headers: { Authorization: `Bearer ${token}` } })
    if (!infoRes.ok) {
      const body = await infoRes.json().catch(() => ({}))
      throw new Error(body.error || `Could not read that link (HTTP ${infoRes.status})`)
    }
    const info = (await infoRes.json()).data || {}

    if (info.source === 'personal') {
      const pendingId = crypto.randomUUID()
      this.pendingInstalls.set(pendingId, {
        token,
        base,
        agentName: info.agent_name || 'agent',
        campaignName: info.campaign_name || '',
      })
      return {
        needsFolder: true,
        pendingId,
        agentName: info.agent_name || 'agent',
        campaignName: info.campaign_name || '',
      }
    }

    const res = await fetch(`${base}/api/agent/download`, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `Download failed (HTTP ${res.status})`)
    }
    const agentName = decodeURIComponent(res.headers.get('x-agent-name') || 'agent')
    const campaignName = decodeURIComponent(res.headers.get('x-campaign-name') || '')
    // Not sent by every Scryboard version yet. When it is, it's what tells
    // two same-named campaigns apart below; see sameCampaign.
    const campaignId = res.headers.get('x-campaign-id') || null

    // Same app, same campaign, already installed here -> this link carries
    // a RE-ISSUED token (the website's "Update and re-issue token" flow:
    // a new version needed different access, so the old token was revoked
    // and a new one minted). Swap the token on the app we already have and
    // run the normal update against it, instead of making the buyer remove
    // the app and set it up again -- that would throw away its secrets and
    // its state/ folder (ledgers, caches) for nothing.
    const existing = this.records.find((r) =>
      !r.localPath && sameSite(r.baseUrl, base) && r.name === agentName && sameCampaign(r, campaignId, campaignName))
    if (existing) {
      existing.encryptedToken = encryptToken(token)
      if (campaignId && !existing.campaignId) existing.campaignId = campaignId
      this.tokens.set(existing.id, token)
      await this.persist()
      // The old token's wake topic is dead; listen on the new one's.
      this.stopWaker(existing.id)
      this.startWaker(existing.id)
      this.setStatus(existing.id, 'idle', 'Token replaced — updating…')
      return this.updateAgent(existing.id)
    }

    const bytes = new Uint8Array(await res.arrayBuffer())

    const files = unpackPackage(bytes)
    const manifestSource = files['scryboard.json']
    if (!manifestSource) throw new Error('No scryboard.json found in the downloaded package.')
    const manifest = JSON.parse(strFromU8(manifestSource))

    for (const dep of manifest.dependencies ?? []) {
      if (!VETTED_PACKAGES.includes(dep)) {
        throw new Error(`"${dep}" isn't a package this runner supports. Supported: ${VETTED_PACKAGES.join(', ')}.`)
      }
    }
    if (files[manifest.entry] === undefined) {
      throw new Error(`Entry file "${manifest.entry}" wasn't found in the package.`)
    }

    const requiredSecrets = (manifest.secrets ?? []).filter((s) => s.required !== false)
    const declaredInputs = manifest.inputs ?? []
    const declaredCapabilities = manifest.capabilities ?? []
    const declaredExternal = externalServices(manifest)
    // Keys belong to the app, not the campaign: installing an app this
    // computer already runs for another campaign reuses the keys saved for
    // it, instead of asking the buyer to paste them all again.
    const saved = this.savedSecretsFor(agentName, base)
    const savedValues = pickSecrets(manifest, saved?.values)
    const stillNeeded = requiredSecrets.filter((s) => !savedValues[s.key])
    // Capabilities force the prompt even when nothing else would -- a
    // device ability (play sound through the speakers) is exactly the
    // thing that must never be granted by a silent auto-finish. Third-party
    // services do too: campaign content leaving for another company, or a
    // second bill, is something the buyer sees here as well as on the
    // listing page.
    if (stillNeeded.length === 0 && declaredInputs.length === 0 && declaredCapabilities.length === 0 && declaredExternal.length === 0) {
      return this.finishInstall({ files, manifest, token, base, agentName, campaignName, campaignId, secretValues: savedValues, inputFiles: {} })
    }

    const pendingId = crypto.randomUUID()
    this.pendingInstalls.set(pendingId, { files, manifest, token, base, agentName, campaignName, campaignId, savedValues })
    return {
      needsSecrets: true,
      pendingId,
      agentName,
      reuseFrom: Object.keys(savedValues).length > 0 ? saved.campaignName || 'another campaign' : null,
      secrets: requiredSecrets.map((s) => ({ key: s.key, label: s.label || s.key, help: s.help || '', saved: !!savedValues[s.key] })),
      inputs: declaredInputs.map((i) => ({
        key: i.key,
        label: i.label || i.key,
        help: i.help || '',
        accept: i.accept || [],
        multiple: !!i.multiple,
        required: i.required !== false,
      })),
      capabilities: declaredCapabilities,
      external: declaredExternal,
    }
  }

  // Step 2, only reached when beginInstall (or updateAgent) asked for
  // secrets. Branches on pending.updateId -- set only when this pending
  // request came from updateAgent -- so the same modal/IPC round trip in
  // the renderer works for both a fresh install and an update that
  // introduced a new required secret, without the renderer needing to know
  // which one it's in.
  async completeInstall(pendingId, secretValues, inputFiles) {
    const pending = this.pendingInstalls.get(pendingId)
    if (!pending) throw new Error("This install request has expired -- try again.")
    this.pendingInstalls.delete(pendingId)
    inputFiles = inputFiles || {}

    if (pending.updateId) {
      const record = this.records.find((r) => r.id === pending.updateId)
      if (!record) throw new Error('App no longer installed.')
      const existing = this.secrets.get(pending.updateId) || {}
      const required = (pending.manifest.secrets ?? []).filter((s) => s.required !== false)
      for (const s of required) {
        if (!existing[s.key] && (!secretValues[s.key] || !String(secretValues[s.key]).trim())) {
          throw new Error(`Missing a value for "${s.label || s.key}".`)
        }
      }
      const requiredInputs = (pending.manifest.inputs ?? []).filter((i) => i.required !== false)
      const dir = agentFilesDir(pending.updateId)
      for (const i of requiredInputs) {
        const alreadyHas = await this.hasInputFiles(dir, i.key)
        if (!alreadyHas && !(inputFiles[i.key] && inputFiles[i.key].length > 0)) {
          throw new Error(`Missing files for "${i.label || i.key}".`)
        }
      }
      const encryptedSecrets = { ...(record.encryptedSecrets || {}) }
      for (const [key, value] of Object.entries(secretValues || {})) {
        if (!value) continue
        encryptedSecrets[key] = encryptToken(value)
        this.allSecretKeys.add(key)
      }
      record.encryptedSecrets = encryptedSecrets
      this.secrets.set(pending.updateId, { ...existing, ...secretValues })
      return this.finishUpdate(pending.updateId, { ...pending, inputFiles })
    }

    // A field left blank keeps the key saved for this app on another
    // campaign (see beginInstall); a typed value is used for this install.
    const merged = { ...(pending.savedValues || {}) }
    for (const [key, value] of Object.entries(secretValues || {})) {
      if (value && String(value).trim()) merged[key] = value
    }
    const required = (pending.manifest.secrets ?? []).filter((s) => s.required !== false)
    for (const s of required) {
      if (!merged[s.key] || !String(merged[s.key]).trim()) {
        throw new Error(`Missing a value for "${s.label || s.key}".`)
      }
    }
    const requiredInputs = (pending.manifest.inputs ?? []).filter((i) => i.required !== false)
    for (const i of requiredInputs) {
      if (!inputFiles[i.key] || inputFiles[i.key].length === 0) {
        throw new Error(`Missing files for "${i.label || i.key}".`)
      }
    }

    return this.finishInstall({ ...pending, secretValues: merged, inputFiles })
  }

  async hasInputFiles(agentDir, key) {
    try {
      const entries = await fs.readdir(path.join(agentDir, 'input', key))
      return entries.length > 0
    } catch {
      return false
    }
  }

  cancelInstall(pendingId) {
    this.pendingInstalls.delete(pendingId)
  }

  // Second half of a personal agent's install: the author has pointed at
  // the folder their code already lives in, so read the manifest straight
  // out of it. Nothing is copied anywhere -- the folder stays theirs, and
  // this app only remembers where it is.
  async provideAgentFolder(pendingId, folderPath) {
    const pending = this.pendingInstalls.get(pendingId)
    if (!pending) throw new Error('That install is no longer pending -- start again from the link.')
    if (!folderPath) throw new Error('No folder chosen.')

    let manifestSource
    try {
      manifestSource = await fs.readFile(path.join(folderPath, 'scryboard.json'), 'utf8')
    } catch {
      throw new Error("No scryboard.json in that folder -- pick the folder that holds your app's code.")
    }

    let manifest
    try {
      manifest = JSON.parse(manifestSource)
    } catch (err) {
      throw new Error(`scryboard.json isn't valid JSON: ${err.message}`)
    }

    for (const dep of manifest.dependencies ?? []) {
      if (!VETTED_PACKAGES.includes(dep)) {
        throw new Error(`"${dep}" isn't a package this runner supports. Supported: ${VETTED_PACKAGES.join(', ')}.`)
      }
    }

    const entryPath = path.join(folderPath, manifest.entry || '')
    try {
      await fs.access(entryPath)
    } catch {
      throw new Error(`Entry file "${manifest.entry}" isn't in that folder.`)
    }

    // Every declared input gets offered, not just the required ones --
    // same as a marketplace install. An optional input is still usually
    // the whole point of the agent (a character sheet to read, a file to
    // watch); skipping the offer just because it's optional leaves you
    // with an agent that runs perfectly and does nothing.
    //
    // The exception is an input the author already has files sitting in,
    // inside their own folder -- that's already provided, and asking them
    // to browse back to it would be busywork.
    const requiredSecrets = (manifest.secrets ?? []).filter((s) => s.required !== false)
    const promptInputs = []
    for (const i of manifest.inputs ?? []) {
      if (!(await this.hasInputFiles(folderPath, i.key))) promptInputs.push(i)
    }
    const saved = this.savedSecretsFor(pending.agentName, pending.base)
    const savedValues = pickSecrets(manifest, saved?.values)
    const stillNeeded = requiredSecrets.filter((s) => !savedValues[s.key])

    const next = { ...pending, manifest, localPath: folderPath, savedValues }
    this.pendingInstalls.set(pendingId, next)

    if (stillNeeded.length === 0 && promptInputs.length === 0) {
      this.pendingInstalls.delete(pendingId)
      return { installed: await this.finishInstall({ ...next, secretValues: savedValues, inputFiles: {} }) }
    }

    return {
      needsSecrets: true,
      pendingId,
      agentName: pending.agentName,
      reuseFrom: Object.keys(savedValues).length > 0 ? saved.campaignName || 'another campaign' : null,
      secrets: requiredSecrets.map((s) => ({ key: s.key, label: s.label || s.key, help: s.help || '', saved: !!savedValues[s.key] })),
      inputs: promptInputs.map((i) => ({
        key: i.key,
        label: i.label || i.key,
        help: i.help || '',
        accept: i.accept || [],
        multiple: !!i.multiple,
        required: i.required !== false,
      })),
      // Shown for information -- a personal agent's capabilities are
      // live-read from its own folder (see capabilitiesFor), so this line
      // tells the author what their manifest currently grants.
      capabilities: manifest.capabilities ?? [],
      external: externalServices(manifest),
    }
  }

  async finishInstall({ files, manifest, token, base, agentName, campaignName, campaignId, secretValues, inputFiles, localPath }) {
    const id = crypto.randomUUID()
    // A personal agent runs where the author keeps it. Nothing is written
    // into that folder except the packages junction and any input files
    // they picked -- their own source is never touched.
    const dir = localPath || agentFilesDir(id)
    if (!localPath) {
      await writePackageFiles(dir, files)
    }

    if ((manifest.dependencies ?? []).length > 0) {
      await this.linkPackages(dir)
    }

    for (const [key, paths] of Object.entries(inputFiles || {})) {
      await copyPickedFiles(dir, key, paths)
    }

    const encryptedSecrets = {}
    for (const [key, value] of Object.entries(secretValues || {})) {
      if (!value) continue
      encryptedSecrets[key] = encryptToken(value) // generic string encryption, same helper as the token
      this.allSecretKeys.add(key)
    }

    const record = {
      id,
      name: agentName,
      campaignName,
      campaignId: campaignId || null,
      baseUrl: base,
      entry: manifest.entry,
      version: manifest.version || null,
      poll: manifest.poll || {},
      inputs: manifest.inputs || [],
      // Schema only (key/label/help/required) -- never values, those live
      // encrypted in encryptedSecrets. Lets the UI offer "Update keys" on
      // an already-installed agent without re-running install/update.
      secrets: manifest.secrets || [],
      // Device capabilities consented to at this install. For a localPath
      // agent this is informational only -- capabilitiesFor() live-reads
      // the folder's own manifest instead.
      capabilities: manifest.capabilities || [],
      // Third-party services shown (and accepted) at this install -- an
      // update that adds one prompts again; see updateAgent.
      external: externalServices(manifest),
      // Every file this install's package wrote -- the only files a later
      // update is allowed to delete (see removeStaleCodeFiles). Null for a
      // personal agent, whose folder the Runner never writes code into.
      codeFiles: localPath ? null : Object.keys(files),
      // Set only for personal agents -- the folder the author keeps their
      // code in. Its presence is what marks this agent as "runs from where
      // it already lives" everywhere else in this file.
      localPath: localPath || null,
      encryptedToken: encryptToken(token),
      encryptedSecrets,
      enabled: true,
      installedAt: new Date().toISOString(),
      status: 'idle',
      statusDetail: '',
    }
    this.records.push(record)
    this.tokens.set(id, token)
    this.secrets.set(id, secretValues || {})
    await this.persist()

    this.scheduleLoop(id)
    return this.list()
  }

  // Re-downloads with this agent's own already-stored token rather than a
  // fresh link -- there's no way to hand the renderer a new
  // scryboard-agent:// link after install (the raw token is never shown
  // again by design), so an update can only ever be this app pulling with
  // what it already has. That token still resolves correctly after an
  // update, because the website side of "update" (updateInstalledAgent)
  // only ever repoints the install's installed_version_id -- the token
  // itself never changes.
  async updateAgent(id) {
    const record = this.records.find((r) => r.id === id)
    if (!record) throw new Error('App not found.')
    const token = this.tokens.get(id)
    if (!token) throw new Error('No credentials available -- try reinstalling.')

    // A personal agent has no newer copy to fetch -- the folder it runs
    // from is the source of truth, and edits there are already live on the
    // next tick. Re-read the manifest in case poll/inputs/version changed,
    // and leave the code alone.
    if (record.localPath) {
      let manifest
      try {
        manifest = JSON.parse(await fs.readFile(path.join(record.localPath, 'scryboard.json'), 'utf8'))
      } catch {
        throw new Error(`Couldn't read scryboard.json in ${record.localPath} -- has the folder moved?`)
      }
      return this.finishUpdate(id, { files: {}, manifest })
    }

    const res = await fetch(`${record.baseUrl}/api/agent/download`, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `Update check failed (HTTP ${res.status})`)
    }
    const bytes = new Uint8Array(await res.arrayBuffer())
    const files = unpackPackage(bytes)
    const manifestSource = files['scryboard.json']
    if (!manifestSource) throw new Error('No scryboard.json found in the downloaded package.')
    const manifest = JSON.parse(strFromU8(manifestSource))

    for (const dep of manifest.dependencies ?? []) {
      if (!VETTED_PACKAGES.includes(dep)) {
        throw new Error(`"${dep}" isn't a package this runner supports. Supported: ${VETTED_PACKAGES.join(', ')}.`)
      }
    }
    if (files[manifest.entry] === undefined) {
      throw new Error(`Entry file "${manifest.entry}" wasn't found in the package.`)
    }

    const existingSecrets = this.secrets.get(id) || {}
    const requiredSecrets = (manifest.secrets ?? []).filter((s) => s.required !== false)
    const missingSecrets = requiredSecrets.filter((s) => !existingSecrets[s.key])

    const requiredInputs = (manifest.inputs ?? []).filter((i) => i.required !== false)
    const dir = agentDirFor(record, id)
    const missingInputs = []
    for (const i of requiredInputs) {
      if (!(await this.hasInputFiles(dir, i.key))) missingInputs.push(i)
    }

    // A capability the installed version didn't have is a NEW grant, and
    // an update must never widen what an app may do to this machine
    // silently -- it goes through the same prompt a fresh install would.
    const newCapabilities = (manifest.capabilities ?? []).filter(
      (c) => !(record.capabilities || []).includes(c)
    )

    // Same for a third-party service the installed version didn't talk to
    // (or one that newly needs a paid account): the buyer hears about it
    // before the new code runs, not from a bill. An install from before
    // the record kept this list falls back to the manifest still on disk,
    // which is the installed version's own.
    let previousExternal = record.external
    if (!Array.isArray(previousExternal)) {
      try {
        previousExternal = externalServices(JSON.parse(await fs.readFile(path.join(dir, 'scryboard.json'), 'utf8')))
      } catch {
        previousExternal = []
      }
    }
    const newExternal = externalServices(manifest).filter((e) => !previousExternal.some(
      (p) => p.name === e.name && (p.requiresPaidAccount || !e.requiresPaidAccount)
    ))

    if (missingSecrets.length > 0 || missingInputs.length > 0 || newCapabilities.length > 0 || newExternal.length > 0) {
      const pendingId = crypto.randomUUID()
      this.pendingInstalls.set(pendingId, { files, manifest, updateId: id })
      return {
        needsSecrets: true,
        isUpdate: true,
        pendingId,
        agentName: record.name,
        secrets: missingSecrets.map((s) => ({ key: s.key, label: s.label || s.key, help: s.help || '' })),
        inputs: missingInputs.map((i) => ({
          key: i.key,
          label: i.label || i.key,
          help: i.help || '',
          accept: i.accept || [],
          multiple: !!i.multiple,
          required: true,
        })),
        capabilities: newCapabilities,
        external: newExternal,
      }
    }

    return this.finishUpdate(id, { files, manifest })
  }

  // Overwrites the agent's own code with whatever the token currently
  // resolves to. The new files are written first, then only the previous
  // version's own code files that the new one dropped are removed -- so
  // state/, output/, input/, the package junction and anything else the
  // app wrote for itself all survive (see removeStaleCodeFiles), and a
  // failure part-way leaves extra files behind rather than missing ones.
  async finishUpdate(id, { files, manifest, inputFiles }) {
    const record = this.records.find((r) => r.id === id)
    if (!record) throw new Error('App no longer installed.')

    const dir = agentDirFor(record, id)
    // Never for a personal agent: that folder is the author's own working
    // copy, and clearing it would delete the source they're editing.
    // There's nothing to write there anyway -- their code is already the
    // newest version of itself.
    if (!record.localPath) {
      await writePackageFiles(dir, files)
      await removeStaleCodeFiles(dir, record.codeFiles, Object.keys(files))
      record.codeFiles = Object.keys(files)
    }
    if ((manifest.dependencies ?? []).length > 0) {
      await this.linkPackages(dir)
    }
    for (const [key, paths] of Object.entries(inputFiles || {})) {
      await copyPickedFiles(dir, key, paths)
    }

    record.entry = manifest.entry
    record.poll = manifest.poll || {}
    record.version = manifest.version || record.version || null
    record.inputs = manifest.inputs || record.inputs || []
    record.secrets = manifest.secrets || record.secrets || []
    // Reaching here means any newly-declared capability already went
    // through the update prompt (see updateAgent) -- and one the new
    // version DROPPED comes off the record too; consent doesn't outlive
    // the declaration.
    record.capabilities = manifest.capabilities || []
    record.external = externalServices(manifest)
    await this.persist()
    this.setStatus(id, 'idle', `Updated to v${record.version || '?'}`)
    return this.list()
  }

  // Standalone re-pick, outside the install/update flow entirely -- the
  // actual answer to "how does a buyer update their character sheet
  // later": pick new files, replace what's there, and clear the agent's
  // own processed.json if it has one, since re-picking through this UI is
  // an explicit "use this now" signal that should force a fresh pass even
  // if the filename happens to be unchanged.
  async updateAgentInputFiles(id, key, filePaths) {
    const record = this.records.find((r) => r.id === id)
    if (!record) throw new Error('App not found.')
    const dir = agentDirFor(record, id)
    await copyPickedFiles(dir, key, filePaths)
    await fs.rm(path.join(dir, 'processed.json'), { force: true }).catch(() => {})
    this.setStatus(id, record.status || 'idle', record.statusDetail || '')
    return this.list()
  }

  // Standalone re-entry of secret values, outside the install/update flow
  // entirely -- the "Update keys" button on an already-installed agent's
  // row. Mirrors updateAgentInputFiles above: no other route lets you
  // change a secret once it's set, since a required secret only gets
  // re-prompted at update time if it's still MISSING, never to let you
  // rotate a key that's already there (e.g. a revoked/rotated ElevenLabs
  // key for an app like Previously On).
  //
  // The renderer never shows what's currently stored (secrets are
  // password-masked and never round-tripped back out), so a blank field is
  // the only way to say "leave this one alone" -- only keys with a
  // non-empty typed value are touched.
  //
  // applyToAll: also save the typed keys on every other install of the same
  // app (same name, same Scryboard site) -- keys belong to the app, so one
  // change usually means every campaign running it. Each install only takes
  // the keys its own manifest declares.
  async updateAgentSecrets(id, secretValues, applyToAll = false) {
    const record = this.records.find((r) => r.id === id)
    if (!record) throw new Error('App not found.')
    const targets = applyToAll ? this.records.filter((r) => sameApp(r, record)) : [record]
    for (const target of targets) {
      const declared = new Set((target.secrets || []).map((s) => s.key))
      const existing = this.secrets.get(target.id) || {}
      const encryptedSecrets = { ...(target.encryptedSecrets || {}) }
      const updatedValues = { ...existing }
      for (const [key, value] of Object.entries(secretValues || {})) {
        if (!value || !String(value).trim()) continue
        if (target !== record && !declared.has(key)) continue
        encryptedSecrets[key] = encryptToken(value)
        updatedValues[key] = value
        this.allSecretKeys.add(key)
      }
      target.encryptedSecrets = encryptedSecrets
      this.secrets.set(target.id, updatedValues)
    }
    await this.persist()
    for (const target of targets) this.setStatus(target.id, target.status || 'idle', target.statusDetail || '')
    return this.list()
  }

  // The keys saved for the most recently installed copy of this app (same
  // name, same Scryboard site) on this computer, or null. Decrypted values
  // stay in this process; the renderer only learns which keys are covered.
  savedSecretsFor(agentName, base) {
    const candidates = this.records
      .filter((r) => r.name === agentName && sameSite(r.baseUrl, base))
      .filter((r) => Object.keys(this.secrets.get(r.id) || {}).length > 0)
      .sort((a, b) => String(b.installedAt || '').localeCompare(String(a.installedAt || '')))
    const from = candidates[0]
    return from ? { campaignName: from.campaignName, values: this.secrets.get(from.id) || {} } : null
  }

  // Bridges the gap between where an agent's code lives (this app's own
  // data folder) and where its allowed packages actually are (this app's
  // own node_modules) -- a junction, not a copy, so every agent shares one
  // real install of these packages instead of duplicating them per agent.
  // Junction, specifically, because that's the one kind of Windows
  // directory link that doesn't need admin rights or Developer Mode.
  async linkPackages(agentDir) {
    const runnerNodeModules = path.join(__dirname, 'node_modules')
    const linkPath = path.join(agentDir, 'node_modules')
    try {
      await fs.symlink(runnerNodeModules, linkPath, 'junction')
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
  }

  // Where an agent's files actually live on disk -- for the Runner's own
  // "Open folder" button, so a buyer can get to whatever an agent wrote
  // for them (an export, a report) without knowing AppData exists.
  getAgentDir(id) {
    const record = this.records.find((r) => r.id === id)
    return record ? agentDirFor(record, id) : null
  }

  // Clears the "new output" highlight. Called when the buyer opens the
  // folder -- opening it *is* "I've seen it," the same way a badge clears
  // when you open the thing it's pointing at.
  async acknowledgeOutput(id) {
    const record = this.records.find((r) => r.id === id)
    if (record) {
      record.outputAcknowledgedAt = Date.now()
      await this.persist()
    }
    return this.list()
  }

  async remove(id) {
    this.stopped.add(id)
    this.stopWaker(id)
    // A removed app doesn't get to keep making sound.
    this.playback?.stop(id)
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
    this.tokens.delete(id)
    this.secrets.delete(id)
    const record = this.records.find((r) => r.id === id)
    this.records = this.records.filter((r) => r.id !== id)
    await this.persist()
    // Only ever deletes a copy this app made and owns. A personal agent's
    // folder belongs to the person who wrote it -- removing it from this
    // list means "stop running it," never "delete my source code."
    // Best-effort -- an in-flight tick for this id may still be running;
    // it'll find no matching record and just no-op harmlessly when it
    // finishes, rather than being force-cancelled mid-flight.
    if (!record?.localPath) {
      await fs.rm(agentFilesDir(id), { recursive: true, force: true }).catch(() => {})
    }
    this.onListChange(this.list())
  }

  async setEnabled(id, enabled) {
    const record = this.records.find((r) => r.id === id)
    if (!record) return
    record.enabled = enabled
    await this.persist()
    if (enabled) {
      this.scheduleLoop(id)
    } else {
      this.stopped.add(id)
      this.stopWaker(id)
      // Pausing an app silences it too -- "make it stop" is half of why
      // anyone reaches for Pause on an audio-playing app.
      this.playback?.stop(id)
      const timer = this.timers.get(id)
      if (timer) clearTimeout(timer)
      this.timers.delete(id)
      this.setStatus(id, 'idle', 'Paused')
    }
  }

  scheduleLoop(id) {
    this.stopped.delete(id)
    this.startWaker(id)
    this.runTick(id)
  }

  // ---- "Run now" nudges (0.2.7) ----
  //
  // Scryboard sends one when this app's button is clicked or its settings
  // box is saved, so the app reacts in a second or two instead of on its
  // next timer. The timer itself is untouched: a nudge only ever brings a
  // tick FORWARD, and an app on a server or network without the wake
  // channel simply keeps polling as before.
  startWaker(id) {
    if (this.wakers.has(id)) return
    const record = this.records.find((r) => r.id === id)
    if (!record?.baseUrl) return
    const waker = new WakeListener({
      fetchChannel: async () => {
        const token = this.tokens.get(id)
        if (!token) throw Object.assign(new Error('no token'), { status: 401 })
        const res = await fetch(`${record.baseUrl}/api/agent/wake-channel`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15 * 1000),
        })
        if (!res.ok) throw Object.assign(new Error(`wake-channel HTTP ${res.status}`), { status: res.status })
        return (await res.json()).data
      },
      onWake: () => this.wake(id),
    })
    this.wakers.set(id, waker)
    waker.start()
  }

  stopWaker(id) {
    const waker = this.wakers.get(id)
    if (waker) waker.stop()
    this.wakers.delete(id)
  }

  // Bring this app's next tick forward to now. A few quick clicks are one
  // early tick, not a burst: mid-tick nudges collapse into a single re-run
  // when the tick ends, and nudge-started ticks are at least WAKE_GAP_MS
  // apart (so a stream of clicks, or a forged stream of nudges, can't run
  // an app -- and whatever it spends -- faster than that).
  wake(id) {
    if (this.stopped.has(id)) return
    if (!this.records.some((r) => r.id === id && r.enabled)) return
    if (this.inFlight.has(id)) {
      this.wakeAgain.add(id)
      return
    }
    const since = Date.now() - (this.lastWokenAt.get(id) ?? 0)
    const delay = Math.max(0, WAKE_GAP_MS - since)
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.set(id, setTimeout(() => {
      this.lastWokenAt.set(id, Date.now())
      this.runTick(id)
    }, delay))
  }

  async runTick(id) {
    if (this.stopped.has(id)) return
    // A nudge can land while this app's own timer is also due; never run
    // the same app twice at once.
    if (this.inFlight.has(id)) {
      this.wakeAgain.add(id)
      return
    }
    const record = this.records.find((r) => r.id === id)
    if (!record) return
    this.inFlight.add(id)
    try {
      await this.runTickOnce(id, record)
    } finally {
      this.inFlight.delete(id)
      // Nudged while running: the tick that just ended may have read its
      // clicks before the new one landed, so run once more.
      if (this.wakeAgain.delete(id)) this.wake(id)
    }
  }

  async runTickOnce(id, record) {
    const token = this.tokens.get(id)
    if (!token) {
      this.setStatus(id, 'error', 'No credentials available.')
      return
    }

    // Per-agent playback bridge: the client checks the capability set (it
    // knows what this agent declared); the manager behind it validates the
    // media and owns the one-thing-plays-at-a-time policy. Every play/stop
    // is stamped with this agent's identity so the UI can say WHO is
    // making noise and stop() can't cross agents.
    const capabilities = await this.capabilitiesFor(record)
    const playback = this.playback
      ? {
          capabilities,
          play: (spec) => this.playback.play({ ...spec, agentId: id, agentName: record.name }),
          stop: () => this.playback.stop(id),
        }
      : null

    // Aborted if this tick runs past TICK_TIMEOUT_MS: every Scryboard call
    // the abandoned tick still makes then fails at once, so it can't keep
    // writing after the Runner has given up on it.
    const tickAbort = new AbortController()
    const client = createClient({ token, baseUrl: record.baseUrl, playback, signal: tickAbort.signal })

    let sessionActive = false
    let session = null
    try {
      session = await client.getActiveSession()
      sessionActive = !!session
    } catch {
      // Fall back to the slower cadence rather than spinning on a broken
      // token or connection.
    }

    // Only agents that opted into `poll.encounterSeconds` pay for this --
    // it's an extra request every tick, and most agents don't read
    // combatants at all (their token may not even have that scope).
    let inEncounter = false
    if (sessionActive && record.poll?.encounterSeconds) {
      try {
        const combatants = await client.get('combatants', { session_id: session.id })
        inEncounter = Array.isArray(combatants) && combatants.length > 0
      } catch {
        // No combatants scope, or the call failed -- just run at the
        // normal active cadence instead.
      }
    }

    await this.withTickLock(async () => {
      try {
        this.setStatus(id, 'working', 'Running…')

        // Clear every secret key any agent has ever used, then set only
        // this one's own -- so a previous agent's tick can never leave a
        // stray value visible to a different agent's run. Safe against
        // overlap now: withTickLock guarantees no other agent's tick is
        // in this section at the same time.
        for (const key of this.allSecretKeys) delete process.env[key]
        const mySecrets = this.secrets.get(id) || {}
        for (const [key, value] of Object.entries(mySecrets)) process.env[key] = value

        const agentDir = agentDirFor(record, id)
        const entryFile = path.join(agentDir, record.entry)
        // ?v=<newest mtime> so edited code is actually picked up -- see
        // maxCodeMtime. Without it Node serves the module it cached on the
        // first tick forever.
        const stamp = await maxCodeMtime(agentDir)
        const mod = await import(`${pathToFileURL(entryFile).href}?v=${stamp}`)
        if (typeof mod.tick !== 'function') {
          throw new Error(`${record.entry} does not export an async tick(scryboard) function.`)
        }
        await withTimeout(mod.tick(client), TICK_TIMEOUT_MS, () => {
          tickAbort.abort()
          return new Error(
            `Stopped a run that took longer than ${Math.round(TICK_TIMEOUT_MS / 60000)} minutes (a request probably hung). ` +
            'It will try again on its next scheduled run.'
          )
        })
        // scanOutputFiles never throws (see its own try/catch) -- a missing
        // or unreadable output/ just means no new-file highlight this tick.
        record.outputFiles = await scanOutputFiles(agentDir)
        this.setStatus(id, 'running', `Last ran ${new Date().toLocaleTimeString()}`)
      } catch (err) {
        this.setStatus(id, 'error', err.message)
      } finally {
        for (const key of this.allSecretKeys) delete process.env[key]
      }
    })

    if (this.stopped.has(id)) return
    const activeMs = (record.poll?.activeSeconds ?? 30) * 1000
    const idleMs = (record.poll?.idleSeconds ?? 300) * 1000
    const encounterMs = (record.poll?.encounterSeconds ?? record.poll?.activeSeconds ?? 30) * 1000
    const delay = !sessionActive ? idleMs : inEncounter ? encounterMs : activeMs
    const timer = setTimeout(() => this.runTick(id), delay)
    this.timers.set(id, timer)
  }
}

module.exports = { AgentManager }
