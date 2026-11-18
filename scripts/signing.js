// Code signing settings for the installer build.
//
// Signing proves to Windows that the installer came from Scryboard and was
// not changed on the way. It uses Microsoft's signing service (Azure
// Artifact Signing, formerly Trusted Signing), which needs an approved
// account. Until there is one, there is no signing.local.json and every
// build is unsigned, exactly as before.
//
// signing.local.json holds a password (clientSecret), so it is in
// .gitignore and must never be committed. signing.local.example.json shows
// its shape.

const fs = require('node:fs')
const path = require('node:path')

const FILE = path.join(__dirname, '..', 'signing.local.json')

const REQUIRED = [
  'endpoint',
  'codeSigningAccountName',
  'certificateProfileName',
  'tenantId',
  'clientId',
  'clientSecret',
]

// Returns null when signing is not set up, or the settings when it is.
// Throws, with a message a person can act on, when the file exists but is
// incomplete: a half-filled file should stop the build, not quietly produce
// an unsigned installer that then gets released.
function loadSigning() {
  if (!fs.existsSync(FILE)) return null

  let raw
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch (err) {
    throw new Error(`signing.local.json is not valid JSON: ${err.message}`)
  }

  const missing = REQUIRED.filter(
    (key) => typeof raw[key] !== 'string' || !raw[key].trim() || raw[key].startsWith('PASTE-'),
  )
  if (missing.length) {
    throw new Error(
      `signing.local.json is missing: ${missing.join(', ')}. ` +
        'Fill them in, or delete the file to build an unsigned installer.',
    )
  }

  const settings = {}
  for (const key of REQUIRED) settings[key] = raw[key].trim()

  if (!/^https:\/\/[a-z0-9]+\.codesigning\.azure\.net\/?$/i.test(settings.endpoint)) {
    throw new Error(
      `signing.local.json: endpoint "${settings.endpoint}" should look like ` +
        'https://eus.codesigning.azure.net (the one for the region the signing account was made in).',
    )
  }
  return settings
}

module.exports = { loadSigning, SIGNING_FILE: FILE }
