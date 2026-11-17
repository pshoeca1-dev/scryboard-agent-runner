// showFile() for apps (0.2.20): "show me the file this app just made".
//
// Asked for by Paul for STL Forge (2026-11-17): a DM clicks "Show STL
// file" on the campaign card, the app sees the click on its next run, and
// the Runner opens File Explorer with that file selected -- the file never
// leaves this computer and Scryboard stores nothing.
//
// Open to any app, but narrow on purpose:
//   - only a file inside that app's own output/ folder (no "..", no
//     absolute paths, no folders, nothing outside it even via a link);
//   - the file must exist;
//   - at most once every REVEAL_GAP_MS per app, so an app can't open
//     window after window on its own.
// It opens a folder view; it never runs or opens the file itself.

const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')

const REVEAL_GAP_MS = 5 * 1000

// Selects the file in the system's file browser.
function defaultOpener(fullPath) {
  if (process.platform === 'win32') {
    // explorer.exe reports a non-zero exit even when the window opened,
    // so its result is not an error signal (same as "Open folder").
    execFile('explorer.exe', [`/select,${fullPath}`], () => {})
  } else if (process.platform === 'darwin') {
    execFile('open', ['-R', fullPath], () => {})
  } else {
    execFile('xdg-open', [path.dirname(fullPath)], () => {})
  }
}

function createRevealer({ outputDir, opener = defaultOpener, now = () => Date.now() }) {
  let lastAt = -Infinity

  return async function showFile(relPath) {
    if (typeof relPath !== 'string' || !relPath.trim()) {
      throw new Error('showFile needs a file name inside this app\'s output folder')
    }
    if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) {
      throw new Error('showFile takes a path inside output/, not a full path')
    }
    const root = path.resolve(outputDir)
    const full = path.resolve(root, relPath.replace(/^output[\\/]/, ''))
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new Error('showFile can only show files inside this app\'s output folder')
    }
    let stat
    try {
      // realpath: a link inside output/ must not point somewhere else.
      const real = await fs.realpath(full)
      const realRoot = await fs.realpath(root)
      if (!real.startsWith(realRoot + path.sep)) throw new Error('outside')
      stat = await fs.stat(real)
    } catch {
      throw new Error(`No file called ${path.basename(full)} in this app's output folder`)
    }
    if (!stat.isFile()) throw new Error('showFile shows files, not folders')

    const t = now()
    if (t - lastAt < REVEAL_GAP_MS) return { shown: false, reason: 'too_soon' }
    lastAt = t
    opener(full)
    return { shown: true, file: path.basename(full) }
  }
}

module.exports = { createRevealer, REVEAL_GAP_MS }
