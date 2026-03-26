'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    pickFolder:    ()    => ipcRenderer.invoke('pick-folder'),
    saveConfig:    (cfg) => ipcRenderer.invoke('save-config', cfg),
    getConfig:     ()    => ipcRenderer.invoke('get-config'),
});
