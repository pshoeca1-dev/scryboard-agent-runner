// Preload for the hidden playback window (see playback.js). The page only
// ever needs three things: receive a play order, receive a stop order,
// and report back what happened.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('playbackBridge', {
  onPlay: (callback) => ipcRenderer.on('playback-play', (_event, spec) => callback(spec)),
  onStop: (callback) => ipcRenderer.on('playback-stop', () => callback()),
  report: (event, detail) => ipcRenderer.send('playback-page-event', event, detail),
})
