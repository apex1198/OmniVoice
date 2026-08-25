const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('omniSpeak', {
  getStatus: () => ipcRenderer.invoke('status:get'),
  runSetup: () => ipcRenderer.invoke('setup:run'),
  startService: () => ipcRenderer.invoke('service:start'),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  showLog: () => ipcRenderer.invoke('log:show'),
  apiBase: 'http://127.0.0.1:8001',
  onSetupProgress: (callback) => ipcRenderer.on('setup-progress', (_event, value) => callback(value)),
  onSetupError: (callback) => ipcRenderer.on('setup-error', (_event, value) => callback(value)),
  onRuntimeLog: (callback) => ipcRenderer.on('runtime-log', (_event, value) => callback(value)),
});
