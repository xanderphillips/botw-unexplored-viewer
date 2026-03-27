'use strict';
const path = require('path');
const { BrowserWindow, ipcMain, dialog } = require('electron');

let _currentConfig = null;
let _windowOpen    = false;

/**
 * openSetupWindow(existingConfig)
 * Opens the setup BrowserWindow.
 * Resolves with { savePath, port } on save, or null if closed without saving.
 * If a setup window is already open, focuses it and returns null immediately.
 */
function openSetupWindow(existingConfig, isFirstRun = false, getCemuPaths = () => []) {
    if (_windowOpen) return Promise.resolve(null);
    _windowOpen = true;
    _currentConfig = existingConfig;

    return new Promise((resolve) => {
        let resolved = false;
        const win = new BrowserWindow({
            width: 520,
            height: 400,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            title: 'BotW Live Savegame Monitor — Setup',
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
            },
        });

        win.setMenu(null);
        win.loadFile(path.join(__dirname, 'setup.html'));

        // IPC: renderer requests folder picker
        const handlePickFolder = async () => {
            const result = await dialog.showOpenDialog(win, {
                title: 'Select Cemu Save Folder',
                properties: ['openDirectory'],
                defaultPath: _currentConfig ? _currentConfig.savePath : undefined,
            });
            return result.canceled ? null : result.filePaths[0];
        };
        ipcMain.handle('pick-folder', handlePickFolder);

        // IPC: renderer submits config
        const handleSaveConfig = (event, cfg) => {
            const { savePath, port } = cfg || {};
            if (!savePath || typeof savePath !== 'string') {
                return { ok: false, error: 'Invalid save path' };
            }
            if (!path.isAbsolute(savePath.trim())) {
                return { ok: false, error: 'Save path must be an absolute path' };
            }
            const p = parseInt(port, 10);
            if (!p || p < 1024 || p > 65535) {
                return { ok: false, error: 'Invalid port' };
            }
            resolved = true;
            resolve({ savePath: savePath.trim(), port: p });
            win.close();
            return { ok: true };
        };
        ipcMain.handle('save-config', handleSaveConfig);

        // IPC: renderer asks for existing config (invoke-based)
        const handleGetConfigInvoke = () => _currentConfig;
        ipcMain.handle('get-config', handleGetConfigInvoke);

        // IPC: renderer asks for default Cemu save paths
        const handleScanCemuPaths = () => getCemuPaths();
        ipcMain.handle('scan-cemu-paths', handleScanCemuPaths);

        // Clean up all handlers when the window closes
        win.on('closed', () => {
            _windowOpen = false;
            ipcMain.removeHandler('pick-folder');
            ipcMain.removeHandler('save-config');
            ipcMain.removeHandler('get-config');
            ipcMain.removeHandler('scan-cemu-paths');
            if (!resolved) resolve(null);
        });
    });
}

module.exports = { openSetupWindow };
