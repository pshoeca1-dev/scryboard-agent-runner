// Builds the installer: `npm run dist`.
//
// With no signing.local.json this is the same unsigned build as always.
// With one, the installer, the uninstaller and the app's own .exe files are
// signed through Microsoft's signing service, and the build fails unless
// Windows then reports each signature as valid -- so a release can never be
// "signed" in name only.

const { spawnSync, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { loadSigning } = require('./signing')

const root = path.join(__dirname, '..')

let signing
try {
  signing = loadSigning()
} catch (err) {
  console.error(`\n  x ${err.message}\n`)
  process.exit(1)
}

const args = [require.resolve('electron-builder/cli.js'), '--win']
const env = { ...process.env }

if (signing) {
  console.log('  • signing is ON (signing.local.json found)')
  // The signing tool reads the sign-in from these three, by these names.
  env.AZURE_TENANT_ID = signing.tenantId
  env.AZURE_CLIENT_ID = signing.clientId
  env.AZURE_CLIENT_SECRET = signing.clientSecret
  // Windows PowerShell won't load any add-on module by default, Microsoft's
  // signing one included ("the module could not be loaded"). This allows it
  // for the PowerShell windows this build starts, and nothing else: the
  // computer's own setting is left alone.
  env.PSExecutionPolicyPreference = 'Bypass'
  const opt = (key, value) => args.push(`-c.win.azureSignOptions.${key}=${value}`)
  opt('endpoint', signing.endpoint)
  opt('codeSigningAccountName', signing.codeSigningAccountName)
  opt('certificateProfileName', signing.certificateProfileName)
  // The certificate itself only lives three days. The timestamp is what
  // keeps a signature valid after that, so it is not optional.
  opt('TimestampRfc3161', 'http://timestamp.acs.microsoft.com')
  opt('TimestampDigest', 'SHA256')
} else {
  console.log('  • signing is OFF (no signing.local.json) -- this installer will be UNSIGNED')
}

const built = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' })
if (built.status !== 0) process.exit(built.status ?? 1)

if (signing) {
  const pkg = require(path.join(root, 'package.json'))
  const unpacked = path.join(root, 'dist', 'win-unpacked')
  const files = [
    path.join(root, 'dist', 'Scryboard-App-Runner-Setup.exe'),
    path.join(unpacked, `${pkg.build.productName}.exe`),
  ]
  let bad = 0
  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.error(`  x expected ${file} but it was not built`)
      bad++
      continue
    }
    // The path goes in through an environment variable, not the command
    // text, so a space or quote in it can't change what PowerShell runs.
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$s = Get-AuthenticodeSignature -LiteralPath $env:SIGN_CHECK_FILE; ' +
          '"$($s.Status)|$($s.SignerCertificate.Subject)|$([bool]$s.TimeStamperCertificate)"',
      ],
      { env: { ...process.env, SIGN_CHECK_FILE: file }, encoding: 'utf8' },
    ).trim()
    const [status, subject, stamped] = out.split('|')
    const name = path.basename(file)
    if (status !== 'Valid') {
      console.error(`  x ${name}: signature is "${status}", not Valid`)
      bad++
    } else if (stamped !== 'True') {
      console.error(`  x ${name}: signed but not timestamped (it would stop being valid in days)`)
      bad++
    } else {
      console.log(`  • ${name}: signed and timestamped by ${subject}`)
    }
  }
  if (bad) {
    console.error('\n  x Signing did not hold. Do NOT release this build.\n')
    process.exit(1)
  }
}
