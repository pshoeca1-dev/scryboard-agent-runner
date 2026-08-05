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

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification } = require('electron')
const path = require('node:path')
const { AgentManager } = require('./agent-runner')

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

// A small solid-color square, generated in code rather than shipped as an
// image file -- keeps every file in this project plain, reviewable source,
// nothing binary to just trust. Not meant to be a real logo, just enough
// to prove a real, distinct tray icon actually appears.
function createAppIcon() {
  const size = 32
  const buffer = Buffer.alloc(size * size * 4)
  // BGRA byte order -- Electron's raw-bitmap convention on Windows/Linux.
  // If this renders with an odd tint instead of gold, the order needs
  // flipping to RGBA, but the icon will visibly appear as a distinct
  // square either way -- that's what this step is actually proving.
  for (let i = 0; i < size * size; i++) {
    buffer[i * 4 + 0] = 0x40 // B
    buffer[i * 4 + 1] = 0xa8 // G
    buffer[i * 4 + 2] = 0xd4 // R -- 0xd4a840, the app's own gold
    buffer[i * 4 + 3] = 0xff // A
  }
  return nativeImage.createFromBuffer(buffer, { width: size, height: size })
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
    if (result && result.needsSecrets) {
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
  tray = new Tray(createAppIcon())
  tray.on('click', showWindow)
  updateTrayMenu(manager?.list() ?? [])
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 640,
    height: 560,
    icon: createAppIcon(),
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
ipcMain.handle('complete-install', async (_event, pendingId, secretValues) => {
  try {
    const list = await manager.completeInstall(pendingId, secretValues)
    sendAgentList(list)
  } catch (err) {
    sendInstallError(err.message)
  }
})
ipcMain.handle('cancel-install', (_event, pendingId) => manager.cancelInstall(pendingId))
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
