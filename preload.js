const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('runner', {
  onAgentList: (callback) => ipcRenderer.on('agent-list', (_event, list) => callback(list)),
  onInstallError: (callback) => ipcRenderer.on('install-error', (_event, message) => callback(message)),
  onSecretsNeeded: (callback) => ipcRenderer.on('secrets-needed', (_event, info) => callback(info)),
  manualInstall: (url) => ipcRenderer.invoke('manual-install', url),
  completeInstall: (pendingId, secretValues) => ipcRenderer.invoke('complete-install', pendingId, secretValues),
  cancelInstall: (pendingId) => ipcRenderer.invoke('cancel-install', pendingId),
  listAgents: () => ipcRenderer.invoke('list-agents'),
  removeAgent: (id) => ipcRenderer.invoke('remove-agent', id),
  setEnabled: (id, enabled) => ipcRenderer.invoke('set-enabled', id, enabled),
  updateAgent: (id) => ipcRenderer.invoke('update-agent', id),
})
