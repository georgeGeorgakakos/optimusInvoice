const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Get app information
  getAppPath: () => ipcRenderer.invoke('get-app-path'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  
  // File operations
  selectFile: () => ipcRenderer.invoke('select-file'),
  
  // Platform information
  platform: process.platform,
  isElectron: true
});

// Log that preload script has loaded
console.log('[Preload] Script loaded successfully');
