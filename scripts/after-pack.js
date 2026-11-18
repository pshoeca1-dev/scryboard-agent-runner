// electron-builder normally stamps the app icon onto the .exe for us, but
// it does that in the same step as code signing -- and this project sets
// `signAndEditExecutable: false`, because the signing toolchain refuses to
// unpack here (it ships macOS symlinks, and creating symlinks on Windows
// needs a privilege a normal account doesn't have).
//
// Without this hook the built .exe keeps Electron's default atom icon, so
// the desktop and Start-menu shortcuts show it even though the installer
// and the running app both show the real logo. rcedit is the same tool
// electron-builder would have reached for; calling it directly does the
// icon half without dragging the signing half along.

// When signing is switched on (see scripts/signing.js), the same switch
// that skips the icon also skips signing the app's own .exe files -- only
// the installer and uninstaller would be signed. So this hook signs them
// too, after the icon is stamped: changing a file after signing it breaks
// the signature.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function exeFilesUnder(dir) {
  const found = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    // The app's own node_modules hold no .exe the Runner starts; skipping
    // them keeps this to a handful of files instead of a long crawl.
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') found.push(...exeFilesUnder(full))
    } else if (entry.name.toLowerCase().endsWith('.exe')) {
      found.push(full)
    }
  }
  return found
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)
  const icon = path.join(__dirname, '..', 'assets', 'icon.ico')
  // x64 because this is the tool doing the editing, not the thing being
  // built -- it follows the build machine, not the app's target arch.
  const rcedit = path.join(__dirname, '..', 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe')

  execFileSync(rcedit, [exe, '--set-icon', icon], { stdio: 'inherit' })
  console.log(`  • stamped app icon onto ${path.basename(exe)}`)

  const azure = context.packager.platformSpecificBuildOptions.azureSignOptions
  if (!azure) return

  // Not packager.sign(): this electron-builder version (25.1.8) hands the
  // file path to PowerShell without quotes, so "Scryboard App Runner.exe"
  // is read as three separate words and the signing tool looks for a file
  // called "...\Scryboard". Everything here goes in through environment
  // variables instead, where a space is just a space.
  //
  // Waiting on azureSignManager first is what installs Microsoft's signing
  // module and checks the sign-in details are present.
  await context.packager.azureSignManager.value
  const { endpoint, certificateProfileName, codeSigningAccountName, ...extra } = azure
  const names = { FileDigest: 'SHA256', ...extra }
  const command =
    'Invoke-TrustedSigning -Endpoint $env:SIGN_ENDPOINT ' +
    '-CertificateProfileName $env:SIGN_PROFILE -CodeSigningAccountName $env:SIGN_ACCOUNT ' +
    Object.keys(names)
      .map((key) => {
        if (!/^[A-Za-z0-9]+$/.test(key)) throw new Error(`unexpected signing option "${key}"`)
        return `-${key} $env:SIGN_OPT_${key}`
      })
      .join(' ') +
    ' -Files $env:SIGN_FILE'

  for (const file of exeFilesUnder(context.appOutDir)) {
    const env = {
      ...process.env,
      SIGN_ENDPOINT: endpoint,
      SIGN_PROFILE: certificateProfileName,
      SIGN_ACCOUNT: codeSigningAccountName,
      SIGN_FILE: file,
    }
    for (const [key, value] of Object.entries(names)) env[`SIGN_OPT_${key}`] = String(value)
    console.log(`  • signing ${path.basename(file)}`)
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      env,
      stdio: 'inherit',
    })
  }
}
