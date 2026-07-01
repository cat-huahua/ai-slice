'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit API surface exposed to the renderer. No Node access leaks
// through; the API key never round-trips to the renderer (only booleans do).
contextBridge.exposeInMainWorld('ai', {
  listProviders: () => ipcRenderer.invoke('providers:list'),
  listPrinters: () => ipcRenderer.invoke('printers:list'),

  keyStatus: () => ipcRenderer.invoke('keys:status'),
  setKey: (provider, key) => ipcRenderer.invoke('keys:set', { provider, key }),

  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  setPrefs: (prefs) => ipcRenderer.invoke('prefs:set', prefs),

  pickModel: () => ipcRenderer.invoke('model:pick'),
  analyze: (file) => ipcRenderer.invoke('model:analyze', file),
  modelBytes: (file) => ipcRenderer.invoke('model:bytes', file),

  optimize: (opts) => ipcRenderer.invoke('ai:optimize', opts),
  slice: (opts) => ipcRenderer.invoke('slice:run', opts),
  saveProfile: (opts) => ipcRenderer.invoke('profile:save', opts),
});
