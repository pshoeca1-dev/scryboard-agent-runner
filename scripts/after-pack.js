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

const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)
  const icon = path.join(__dirname, '..', 'assets', 'icon.ico')
  // x64 because this is the tool doing the editing, not the thing being
  // built -- it follows the build machine, not the app's target arch.
  const rcedit = path.join(__dirname, '..', 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe')

  execFileSync(rcedit, [exe, '--set-icon', icon], { stdio: 'inherit' })
  console.log(`  • stamped app icon onto ${path.basename(exe)}`)
}
