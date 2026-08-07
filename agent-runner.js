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
const { loadStore, saveStore, agentFilesDir, encryptToken, decryptToken } = require('./store')

// Must stay in sync with VETTED_PACKAGES in src/lib/agentPackage.ts (the
// website's own copy of this same list, checked at submission time). This
// is the runner's copy -- it decides what actually gets bundled into the
// app and linked into an agent's folder at install time.
const VETTED_PACKAGES = ['@anthropic-ai/sdk', 'pdf-parse', 'jimp', 'zod', 'date-fns']

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

// An update overwrites an agent's own code, but a buyer's already-picked
// input files (and whatever the agent itself has written to remember
// state, e.g. processed.json) must survive it -- losing your character
// sheet because the agent's code got a bugfix would be a bad surprise.
// Removes everything in the directory except input/ and the node_modules
// package junction, rather than the previous wipe-then-rewrite-everything.
// Where an agent's code actually lives. A personal agent runs from the
// folder the author already has on disk (see localPath below); everything
// else runs from a copy this app downloaded and owns.
function agentDirFor(record, id) {
  return record.localPath || agentFilesDir(id)
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
      if (entry.name === 'node_modules' || entry.name === 'input' || entry.name.startsWith('.')) continue
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

async function clearAgentCodeFiles(dir) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === 'input' || entry.name === 'node_modules') continue
    await fs.rm(path.join(dir, entry.name), { recursive: true, force: true }).catch(() => {})
  }
}

class AgentManager {
  constructor(onListChange) {
    this.records = []          // persisted fields plus transient status/statusDetail
    this.tokens = new Map()    // id -> decrypted token, kept in memory only, never persisted raw
    this.secrets = new Map()   // id -> { KEY: decrypted value }, same -- memory only
    this.timers = new Map()    // id -> pending setTimeout handle
    this.stopped = new Set()
    this.pendingInstalls = new Map() // pendingId -> download already done, waiting on secret input
    this.allSecretKeys = new Set()   // every secret key name ever used, across every agent --
                                      // lets runTick wipe all of them before/after each tick so one
                                      // agent's key can never linger and leak into another's run
    this.onListChange = onListChange || (() => {})
  }

  async init() {
    this.records = await loadStore()
    for (const record of this.records) {
      record.status = 'idle'
      record.statusDetail = ''
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
    this.onListChange(this.list())
  }

  list() {
    return this.records.map((r) => ({
      id: r.id,
      name: r.name,
      campaignName: r.campaignName,
      version: r.version || null,
      enabled: r.enabled,
      installedAt: r.installedAt,
      status: r.status || 'idle',
      statusDetail: r.statusDetail || '',
      inputs: r.inputs || [],
      localPath: r.localPath || null,
    }))
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
    const bytes = new Uint8Array(await res.arrayBuffer())

    const files = stripCommonRoot(unzipSync(bytes))
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
    if (requiredSecrets.length === 0 && declaredInputs.length === 0) {
      return this.finishInstall({ files, manifest, token, base, agentName, campaignName, secretValues: {}, inputFiles: {} })
    }

    const pendingId = crypto.randomUUID()
    this.pendingInstalls.set(pendingId, { files, manifest, token, base, agentName, campaignName })
    return {
      needsSecrets: true,
      pendingId,
      agentName,
      secrets: requiredSecrets.map((s) => ({ key: s.key, label: s.label || s.key, help: s.help || '' })),
      inputs: declaredInputs.map((i) => ({
        key: i.key,
        label: i.label || i.key,
        help: i.help || '',
        accept: i.accept || [],
        multiple: !!i.multiple,
        required: i.required !== false,
      })),
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
      if (!record) throw new Error('Agent no longer installed.')
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

    const required = (pending.manifest.secrets ?? []).filter((s) => s.required !== false)
    for (const s of required) {
      if (!secretValues[s.key] || !String(secretValues[s.key]).trim()) {
        throw new Error(`Missing a value for "${s.label || s.key}".`)
      }
    }
    const requiredInputs = (pending.manifest.inputs ?? []).filter((i) => i.required !== false)
    for (const i of requiredInputs) {
      if (!inputFiles[i.key] || inputFiles[i.key].length === 0) {
        throw new Error(`Missing files for "${i.label || i.key}".`)
      }
    }

    return this.finishInstall({ ...pending, secretValues, inputFiles })
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
      throw new Error("No scryboard.json in that folder -- pick the folder that holds your agent's code.")
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

    // Secrets still get asked for, but anything the author already has
    // sitting in their own input/ folder counts as already provided --
    // re-picking files they'd have to browse back to would be busywork.
    const requiredSecrets = (manifest.secrets ?? []).filter((s) => s.required !== false)
    const requiredInputs = []
    for (const i of (manifest.inputs ?? []).filter((i) => i.required !== false)) {
      if (!(await this.hasInputFiles(folderPath, i.key))) requiredInputs.push(i)
    }

    const next = { ...pending, manifest, localPath: folderPath }
    this.pendingInstalls.set(pendingId, next)

    if (requiredSecrets.length === 0 && requiredInputs.length === 0) {
      this.pendingInstalls.delete(pendingId)
      return { installed: await this.finishInstall({ ...next, secretValues: {}, inputFiles: {} }) }
    }

    return {
      needsSecrets: true,
      pendingId,
      agentName: pending.agentName,
      secrets: requiredSecrets.map((s) => ({ key: s.key, label: s.label || s.key, help: s.help || '' })),
      inputs: requiredInputs.map((i) => ({
        key: i.key,
        label: i.label || i.key,
        help: i.help || '',
        accept: i.accept || [],
        multiple: !!i.multiple,
        required: true,
      })),
    }
  }

  async finishInstall({ files, manifest, token, base, agentName, campaignName, secretValues, inputFiles, localPath }) {
    const id = crypto.randomUUID()
    // A personal agent runs where the author keeps it. Nothing is written
    // into that folder except the packages junction and any input files
    // they picked -- their own source is never touched.
    const dir = localPath || agentFilesDir(id)
    if (!localPath) {
      for (const [filePath, content] of Object.entries(files)) {
        const dest = path.join(dir, filePath)
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await fs.writeFile(dest, strFromU8(content))
      }
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
      baseUrl: base,
      entry: manifest.entry,
      version: manifest.version || null,
      poll: manifest.poll || {},
      inputs: manifest.inputs || [],
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
    if (!record) throw new Error('Agent not found.')
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
    const files = stripCommonRoot(unzipSync(bytes))
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

    if (missingSecrets.length > 0 || missingInputs.length > 0) {
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
      }
    }

    return this.finishUpdate(id, { files, manifest })
  }

  // Overwrites the agent's own code with whatever the token currently
  // resolves to. Everything except input/ and node_modules is cleared
  // first -- not just overwritten -- so a file removed in the new version
  // can't linger and get imported by accident, while a buyer's
  // already-picked input files and the shared package junction survive.
  async finishUpdate(id, { files, manifest, inputFiles }) {
    const record = this.records.find((r) => r.id === id)
    if (!record) throw new Error('Agent no longer installed.')

    const dir = agentDirFor(record, id)
    // Never for a personal agent: that folder is the author's own working
    // copy, and clearing it would delete the source they're editing.
    // There's nothing to write there anyway -- their code is already the
    // newest version of itself.
    if (!record.localPath) {
      await clearAgentCodeFiles(dir)
      for (const [filePath, content] of Object.entries(files)) {
        const dest = path.join(dir, filePath)
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await fs.writeFile(dest, strFromU8(content))
      }
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
    if (!record) throw new Error('Agent not found.')
    const dir = agentDirFor(record, id)
    await copyPickedFiles(dir, key, filePaths)
    await fs.rm(path.join(dir, 'processed.json'), { force: true }).catch(() => {})
    this.setStatus(id, record.status || 'idle', record.statusDetail || '')
    return this.list()
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

  async remove(id) {
    this.stopped.add(id)
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
      const timer = this.timers.get(id)
      if (timer) clearTimeout(timer)
      this.timers.delete(id)
      this.setStatus(id, 'idle', 'Paused')
    }
  }

  scheduleLoop(id) {
    this.stopped.delete(id)
    this.runTick(id)
  }

  async runTick(id) {
    if (this.stopped.has(id)) return
    const record = this.records.find((r) => r.id === id)
    if (!record) return
    const token = this.tokens.get(id)
    if (!token) {
      this.setStatus(id, 'error', 'No credentials available.')
      return
    }

    const client = createClient({ token, baseUrl: record.baseUrl })

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

    try {
      this.setStatus(id, 'working', 'Running…')

      // Clear every secret key any agent has ever used, then set only
      // this one's own -- so a previous agent's tick can never leave a
      // stray value visible to a different agent's run.
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
      await mod.tick(client)
      this.setStatus(id, 'running', `Last ran ${new Date().toLocaleTimeString()}`)
    } catch (err) {
      this.setStatus(id, 'error', err.message)
    } finally {
      for (const key of this.allSecretKeys) delete process.env[key]
    }

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
