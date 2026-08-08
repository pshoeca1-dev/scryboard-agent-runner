// Scryboard Agent Runner -- proof-of-concept build, phase 4.
//
// Phase 1 proved an agent could be downloaded, unpacked, and run once.
// Phase 2 made it remember what's installed and keep ticking across
// restarts. Phase 3 made it backgroundable (a tray icon; closing the
// window no longer quits). Phase 4 (current, in agent-runner.js) adds
// packages (a small vetted list, bundled with the app, not installed live)
// and secrets (prompted for at install time, stored the same secure way as
// the token). The prompt-for-secrets flow lives partly here: beginInstall
// either finishes right away or hands back what to ask for, and the
// renderer calls complete-install once the buyer's typed them in.
//
// Still not here: code signing.

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, dialog } = require('electron')
const path = require('node:path')
const { AgentManager } = require('./agent-runner')
const { loadSettings, saveSettings } = require('./store')

// Agents only tick while this app is running, so an app that isn't running
// is indistinguishable from agents that quietly stopped working -- come
// back to a campaign after a week away and your widgets are simply gone,
// with nothing on screen explaining why. Starting with the machine is what
// makes "it just keeps working" true, and it's the norm for background
// apps of this kind.
//
// Applied once, on first run only, so turning it off afterwards sticks
// instead of being re-enabled on every launch. The main window shows the
// state and lets it be switched off -- silently adding yourself to
// startup is exactly the behaviour that earns an app a bad reputation.
async function applyStartOnLoginDefault() {
  const settings = await loadSettings()
  if (settings.loginDefaultApplied) return
  try {
    app.setLoginItemSettings({ openAtLogin: true })
  } catch {
    // Not fatal -- some environments don't allow it, and the app still
    // works, it just won't start on its own.
  }
  await saveSettings({ ...settings, loginDefaultApplied: true })
}

// Electron's file dialog filters on extensions, not the MIME types a
// manifest declares in `accept` -- this is the (small, known) translation
// between the two. Anything not in this map is dropped from the filter
// rather than failing the dialog outright; an unrecognized MIME type just
// means "no extension filter for that one," not "reject the picker."
const MIME_TO_EXTENSIONS = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
}

function acceptToFilters(accept) {
  const extensions = [...new Set((accept || []).flatMap((m) => MIME_TO_EXTENSIONS[m] || []))]
  if (extensions.length === 0) return [{ name: 'All files', extensions: ['*'] }]
  return [{ name: 'Supported files', extensions }]
}

const PROTOCOL = 'scryboard-agent'

// Windows launches a brand-new process for a protocol click. Without this,
// clicking a link while the app's already open would spawn a second,
// separate copy instead of handing the link to the one already running.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let mainWindow = null
let tray = null
let pendingUrl = null
let manager = null
let isQuitting = false
let hasShownTrayHint = false

function extractProtocolUrl(argv) {
  return argv.find((arg) => arg.startsWith(`${PROTOCOL}://`)) ?? null
}

function registerProtocolHandler() {
  // In development (running via `electron .`, not a packaged .exe), Windows
  // needs to be told the exact command line to relaunch with -- this is
  // Electron's own documented pattern for that case.
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])])
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL)
  }
}

// The placeholder gold square this used to draw in code is gone -- it was
// only ever there to prove a distinct tray icon appears. This is the real
// logo. assets/icon.svg is the source of truth; the PNGs beside it are
// generated from it by `npm run build:icons`, because nativeImage doesn't
// read SVG.
const ASSETS = path.join(__dirname, 'assets')

function loadIcon(file) {
  const image = nativeImage.createFromPath(path.join(ASSETS, file))
  if (image.isEmpty()) {
    // createFromPath returns a blank image rather than throwing, and a
    // blank tray icon is invisible -- the app looks like it failed to
    // start at all. Worth a line in the log rather than silence.
    console.error(`Icon ${file} is missing or unreadable. Run \`npm run build:icons\`.`)
  }
  return image
}

// Windows draws the tray at 16px, or 32px on a HiDPI display. Supplying
// both beats handing it one size and letting it rescale, which is where
// tray icons usually turn to mush.
function createTrayIcon() {
  const icon = loadIcon('icon-16.png')
  const hidpi = loadIcon('icon-32.png')
  if (!icon.isEmpty() && !hidpi.isEmpty()) {
    icon.addRepresentation({ scaleFactor: 2, buffer: hidpi.toPNG() })
  }
  return icon
}

// The taskbar and alt-tab pull from this one, both of which want something
// considerably bigger than the tray does.
function createWindowIcon() {
  return loadIcon('icon-256.png')
}

function showWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function updateTrayMenu(list) {
  if (!tray) return
  const agents = list ?? manager?.list() ?? []
  const running = agents.filter((a) => a.enabled && a.status !== 'error').length
  tray.setToolTip(`Scryboard Agent Runner — ${running}/${agents.length} agent(s) running`)

  const menu = Menu.buildFromTemplate([
    { label: 'Open Scryboard Agent Runner', click: showWindow },
    { type: 'separator' },
    {
      label: 'Start on login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
}

function sendAgentList(list) {
  if (mainWindow) mainWindow.webContents.send('agent-list', list)
  updateTrayMenu(list)
}

function sendInstallError(message) {
  if (mainWindow) mainWindow.webContents.send('install-error', message)
}

async function handleInstallUrl(rawUrl) {
  try {
    const result = await manager.beginInstall(rawUrl)
    if (result && result.needsFolder) {
      // A personal agent -- nothing was downloaded, because its code is
      // already on this machine. The renderer asks where, then calls
      // provide-agent-folder below.
      if (mainWindow) mainWindow.webContents.send('folder-needed', result)
    } else if (result && result.needsSecrets) {
      // Doesn't finish here -- the renderer prompts for these, then calls
      // complete-install (below) with what was entered.
      if (mainWindow) mainWindow.webContents.send('secrets-needed', result)
    } else {
      sendAgentList(result)
    }
  } catch (err) {
    sendInstallError(err.message)
  }
}

function createTray() {
  tray = new Tray(createTrayIcon())
  tray.on('click', showWindow)
  updateTrayMenu(manager?.list() ?? [])
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 640,
    height: 560,
    icon: createWindowIcon(),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  mainWindow.loadFile('index.html')

  // The actual "backgroundable" behavior lives here: closing the window
  // hides it instead of destroying it, so every installed agent keeps
  // ticking. Only the tray's own Quit (or an OS-level quit) sets
  // isQuitting and lets the close through for real.
  mainWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    mainWindow.hide()
    if (!hasShownTrayHint) {
      hasShownTrayHint = true
      new Notification({
        title: 'Still running',
        body: 'Scryboard Agent Runner keeps your agents running in the background. Right-click the tray icon to reopen or quit.',
      }).show()
    }
  })

  mainWindow.webContents.once('did-finish-load', () => {
    sendAgentList(manager.list())
    if (pendingUrl) {
      const url = pendingUrl
      pendingUrl = null
      handleInstallUrl(url)
    }
  })
}

registerProtocolHandler()

app.on('second-instance', (_event, argv) => {
  const url = extractProtocolUrl(argv)
  if (url) handleInstallUrl(url)
  showWindow()
})

app.on('open-url', (event, url) => {
  // macOS's equivalent of second-instance for protocol links.
  event.preventDefault()
  if (mainWindow) handleInstallUrl(url)
  else pendingUrl = url
})

app.on('activate', () => {
  // macOS convention: clicking the dock icon with no window open should
  // bring one back.
  if (mainWindow) showWindow()
  else if (manager) createWindow()
})

app.on('before-quit', () => {
  isQuitting = true
})

app.whenReady().then(async () => {
  await applyStartOnLoginDefault()

  manager = new AgentManager(sendAgentList)
  await manager.init() // resumes ticking every previously-installed, enabled agent

  createTray()

  const url = extractProtocolUrl(process.argv)
  if (url) pendingUrl = url
  createWindow()
})

// Backgroundability means closing every window must NOT quit anymore --
// the tray is what keeps the app (and every agent's ticking) alive now.
// Quitting only happens via the tray's own Quit item or an OS-level quit
// (both go through before-quit above).
app.on('window-all-closed', () => {
  // Intentionally does nothing.
})

ipcMain.handle('manual-install', (_event, url) => handleInstallUrl(url))
ipcMain.handle('list-agents', () => (manager ? manager.list() : []))
ipcMain.handle('remove-agent', (_event, id) => manager.remove(id))
ipcMain.handle('set-enabled', (_event, id, enabled) => manager.setEnabled(id, enabled))
ipcMain.handle('complete-install', async (_event, pendingId, secretValues, inputFiles) => {
  try {
    const list = await manager.completeInstall(pendingId, secretValues, inputFiles)
    sendAgentList(list)
  } catch (err) {
    sendInstallError(err.message)
  }
})
ipcMain.handle('cancel-install', (_event, pendingId) => manager.cancelInstall(pendingId))

// Surfaced in the window as well as the tray menu -- an app that adds
// itself to startup should say so somewhere you'd actually look.
ipcMain.handle('get-start-on-login', () => app.getLoginItemSettings().openAtLogin)
ipcMain.handle('set-start-on-login', (_event, enabled) => {
  app.setLoginItemSettings({ openAtLogin: !!enabled })
  updateTrayMenu(manager?.list() ?? [])
  return app.getLoginItemSettings().openAtLogin
})

// Folder picker for a personal agent's own code. Same shape as
// choose-input-files: the renderer never sees or touches the path itself
// beyond displaying it.
ipcMain.handle('choose-agent-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
  if (result.canceled) return null
  return result.filePaths[0] ?? null
})

ipcMain.handle('provide-agent-folder', async (_event, pendingId, folderPath) => {
  try {
    const result = await manager.provideAgentFolder(pendingId, folderPath)
    if (result && result.needsSecrets) {
      if (mainWindow) mainWindow.webContents.send('secrets-needed', result)
    } else if (result && result.installed) {
      sendAgentList(result.installed)
    }
  } catch (err) {
    sendInstallError(err.message)
  }
})

// Must run in the main process -- the renderer never gets raw filesystem
// access, same posture as every other Electron app. Returns the picked
// absolute paths (or an empty array if the buyer cancelled); the renderer
// only ever sees filenames for display, never touches the files itself.
ipcMain.handle('choose-input-files', async (_event, { accept, multiple }) => {
  const properties = ['openFile']
  if (multiple) properties.push('multiSelections')
  const result = await dialog.showOpenDialog(mainWindow, {
    properties,
    filters: acceptToFilters(accept),
  })
  if (result.canceled) return []
  return result.filePaths
})

// Standalone re-pick, outside the install/update flow -- the "Files"
// button on an already-installed agent's row.
ipcMain.handle('update-agent-inputs', async (_event, id, key, filePaths) => {
  try {
    const list = await manager.updateAgentInputFiles(id, key, filePaths)
    sendAgentList(list)
  } catch (err) {
    sendInstallError(err.message)
  }
})
ipcMain.handle('update-agent', async (_event, id) => {
  try {
    const result = await manager.updateAgent(id)
    if (result && result.needsSecrets) {
      if (mainWindow) mainWindow.webContents.send('secrets-needed', result)
    } else {
      sendAgentList(result)
    }
  } catch (err) {
    sendInstallError(err.message)
  }
})
