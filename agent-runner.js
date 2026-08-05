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

  // Step 1: download and validate. If the agent needs secrets, this stops
  // here and hands back what to ask for, rather than finishing the install
  // -- the caller (main.js) is expected to prompt and call completeInstall.
  // If it needs nothing, it finishes immediately, same as before.
  async beginInstall(rawUrl) {
    const parsed = new URL(rawUrl)
    if (parsed.protocol.replace(':', '') !== 'scryboard-agent') {
      throw new Error('Expected a scryboard-agent:// link.')
    }
    const token = parsed.searchParams.get('token')
    const base = parsed.searchParams.get('base')
    if (!token || !base) throw new Error('Link is missing a token or base URL.')

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
    if (requiredSecrets.length === 0) {
      return this.finishInstall({ files, manifest, token, base, agentName, campaignName, secretValues: {} })
    }

    const pendingId = crypto.randomUUID()
    this.pendingInstalls.set(pendingId, { files, manifest, token, base, agentName, campaignName })
    return {
      needsSecrets: true,
      pendingId,
      agentName,
      secrets: requiredSecrets.map((s) => ({ key: s.key, label: s.label || s.key, help: s.help || '' })),
    }
  }

  // Step 2, only reached when beginInstall (or updateAgent) asked for
  // secrets. Branches on pending.updateId -- set only when this pending
  // request came from updateAgent -- so the same modal/IPC round trip in
  // the renderer works for both a fresh install and an update that
  // introduced a new required secret, without the renderer needing to know
  // which one it's in.
  async completeInstall(pendingId, secretValues) {
    const pending = this.pendingInstalls.get(pendingId)
    if (!pending) throw new Error("This install request has expired -- try again.")
    this.pendingInstalls.delete(pendingId)

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
      const encryptedSecrets = { ...(record.encryptedSecrets || {}) }
      for (const [key, value] of Object.entries(secretValues || {})) {
        if (!value) continue
        encryptedSecrets[key] = encryptToken(value)
        this.allSecretKeys.add(key)
      }
      record.encryptedSecrets = encryptedSecrets
      this.secrets.set(pending.updateId, { ...existing, ...secretValues })
      return this.finishUpdate(pending.updateId, pending)
    }

    const required = (pending.manifest.secrets ?? []).filter((s) => s.required !== false)
    for (const s of required) {
      if (!secretValues[s.key] || !String(secretValues[s.key]).trim()) {
        throw new Error(`Missing a value for "${s.label || s.key}".`)
      }
    }

    return this.finishInstall({ ...pending, secretValues })
  }

  cancelInstall(pendingId) {
    this.pendingInstalls.delete(pendingId)
  }

  async finishInstall({ files, manifest, token, base, agentName, campaignName, secretValues }) {
    const id = crypto.randomUUID()
    const dir = agentFilesDir(id)
    for (const [filePath, content] of Object.entries(files)) {
      const dest = path.join(dir, filePath)
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.writeFile(dest, strFromU8(content))
    }

    if ((manifest.dependencies ?? []).length > 0) {
      await this.linkPackages(dir)
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
    if (missingSecrets.length > 0) {
      const pendingId = crypto.randomUUID()
      this.pendingInstalls.set(pendingId, { files, manifest, updateId: id })
      return {
        needsSecrets: true,
        isUpdate: true,
        pendingId,
        agentName: record.name,
        secrets: missingSecrets.map((s) => ({ key: s.key, label: s.label || s.key, help: s.help || '' })),
      }
    }

    return this.finishUpdate(id, { files, manifest })
  }

  // Overwrites the agent's own files with whatever the token currently
  // resolves to. The whole directory is cleared first -- not just
  // overwritten -- so a file removed in the new version can't linger and
  // get imported by accident.
  async finishUpdate(id, { files, manifest }) {
    const record = this.records.find((r) => r.id === id)
    if (!record) throw new Error('Agent no longer installed.')

    const dir = agentFilesDir(id)
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    for (const [filePath, content] of Object.entries(files)) {
      const dest = path.join(dir, filePath)
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.writeFile(dest, strFromU8(content))
    }
    if ((manifest.dependencies ?? []).length > 0) {
      await this.linkPackages(dir)
    }

    record.entry = manifest.entry
    record.poll = manifest.poll || {}
    record.version = manifest.version || record.version || null
    await this.persist()
    this.setStatus(id, 'idle', `Updated to v${record.version || '?'}`)
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
    this.records = this.records.filter((r) => r.id !== id)
    await this.persist()
    // Best-effort -- an in-flight tick for this id may still be running;
    // it'll find no matching record and just no-op harmlessly when it
    // finishes, rather than being force-cancelled mid-flight.
    await fs.rm(agentFilesDir(id), { recursive: true, force: true }).catch(() => {})
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
    try {
      sessionActive = !!(await client.getActiveSession())
    } catch {
      // Fall back to the slower cadence rather than spinning on a broken
      // token or connection.
    }

    try {
      this.setStatus(id, 'working', 'Running…')

      // Clear every secret key any agent has ever used, then set only
      // this one's own -- so a previous agent's tick can never leave a
      // stray value visible to a different agent's run.
      for (const key of this.allSecretKeys) delete process.env[key]
      const mySecrets = this.secrets.get(id) || {}
      for (const [key, value] of Object.entries(mySecrets)) process.env[key] = value

      const entryFile = path.join(agentFilesDir(id), record.entry)
      const mod = await import(pathToFileURL(entryFile).href)
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
    const timer = setTimeout(() => this.runTick(id), sessionActive ? activeMs : idleMs)
    this.timers.set(id, timer)
  }
}

module.exports = { AgentManager }
