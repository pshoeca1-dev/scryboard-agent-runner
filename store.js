// Persistence for installed agents -- survives app restarts.
//
// Everything except the token is plain JSON (name, manifest, timestamps --
// none of it sensitive). The token is the one real secret here, so it's
// encrypted with the operating system's own credential protection
// (Keychain on macOS, DPAPI on Windows) via Electron's built-in
// safeStorage before it ever touches disk -- no extra dependency needed
// for that.

const { app, safeStorage } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')

function storePath() {
  return path.join(app.getPath('userData'), 'installed-agents.json')
}

function agentFilesDir(id) {
  return path.join(app.getPath('userData'), 'agents', id)
}

async function loadStore() {
  try {
    const raw = await fs.readFile(storePath(), 'utf8')
    return JSON.parse(raw)
  } catch {
    return []
  }
}

async function saveStore(records) {
  await fs.mkdir(path.dirname(storePath()), { recursive: true })
  await fs.writeFile(storePath(), JSON.stringify(records, null, 2))
}

function encryptToken(token) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is not available on this system -- cannot safely save a token.')
  }
  return safeStorage.encryptString(token).toString('base64')
}

function decryptToken(encrypted) {
  return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
}

module.exports = { loadStore, saveStore, agentFilesDir, encryptToken, decryptToken }
