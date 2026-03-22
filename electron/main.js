'use strict';
const { app, Tray, Menu, shell, nativeImage } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const { openSetupWindow } = require('./setup-window');

// ── Config ────────────────────────────────────────────────────────────────────

const APP_DATA_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'botw-live-savegame-monitor');
const CONFIG_FILE  = path.join(APP_DATA_DIR, 'config.json');
const ERROR_LOG    = path.join(APP_DATA_DIR, 'error.log');

// Scan the standard Cemu save tree for BotW save roots (folders containing 0–5 slot subfolders).
// Returns an array of matching paths, most recently modified first.
function scanCemuSavePaths() {
    const userDir = path.join(
        os.homedir(), 'AppData', 'Roaming',
        'Cemu', 'mlc01', 'usr', 'save', '00050000', '101c9400', 'user'
    );
    try {
        return fs.readdirSync(userDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => path.join(userDir, e.name))
            .filter((p) =>
                [0, 1, 2, 3, 4, 5].some((i) =>
                    fs.existsSync(path.join(p, String(i), 'game_data.sav'))
                )
            );
    } catch { return []; }
}

function loadConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
        const cfg = JSON.parse(raw);
        if (!cfg.savePath || !cfg.port) return null;
        return cfg;
    } catch { return null; }
}

function saveConfig(cfg) {
    fs.mkdirSync(APP_DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function logError(msg) {
    try {
        fs.mkdirSync(APP_DATA_DIR, { recursive: true });
        fs.appendFileSync(ERROR_LOG, '[' + new Date().toISOString() + '] ' + msg + '\n', 'utf8');
    } catch { /* ignore */ }
}

// ── Server ────────────────────────────────────────────────────────────────────

// IMPORTANT: STATE_DIR and STATIC_ROOT MUST be set before requiring server/server.js.
// state.js reads STATE_DIR at module load time (line 15). If set after require, it uses
// the default (__dirname/data) instead of AppData. This ordering is load-order-sensitive.
process.env.STATE_DIR   = APP_DATA_DIR;
// STATIC_ROOT tells server.js where to find index.html and assets/.
// app.getAppPath() returns the bundle root in both dev and packaged builds.
// In packaged portable (asar:false), this is the extraction dir under %LOCALAPPDATA%.
process.env.STATIC_ROOT = app.getAppPath();

const { startServer, drainSseClients } = require('../server/server');

let currentHttpServer = null;
let currentConfig     = null;
let tray              = null;
let hasOpenedBrowser  = false;

async function startExpressServer(config) {
    try {
        const { httpServer } = await startServer(config.port, config.savePath);
        currentHttpServer = httpServer;
        return true;
    } catch (e) {
        logError('Server start failed: ' + e.message);
        return false;
    }
}

function stopExpressServer() {
    return new Promise((resolve) => {
        drainSseClients();
        if (!currentHttpServer) { resolve(); return; }
        currentHttpServer.close(() => {
            currentHttpServer = null;
            resolve();
        });
    });
}

// ── Tray ──────────────────────────────────────────────────────────────────────

function getIconPath() {
    // In packaged app, icon is in resources/app (or asar root)
    // In dev, it's at the repo root
    const base = app.isPackaged ? path.join(process.resourcesPath, 'app') : app.getAppPath();
    return path.join(base, 'favicon.ico');
}

function buildMenu(serverOk) {
    const url = currentConfig ? `http://localhost:${currentConfig.port}` : null;
    return Menu.buildFromTemplate([
        serverOk && url
            ? { label: 'Open Browser', click: () => shell.openExternal(url) }
            : { label: 'Server error — Reconfigure…', click: reconfigure },
        { type: 'separator' },
        { label: 'Reconfigure…', click: reconfigure },
        { type: 'separator' },
        { label: 'Quit', click: quit },
    ]);
}

function createTray() {
    const iconPath = getIconPath();
    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon);
    tray.setToolTip('BotW Live Savegame Monitor');
    tray.setContextMenu(buildMenu(true));
}

function setTrayError() {
    if (tray) tray.setContextMenu(buildMenu(false));
}

// ── Reconfigure ───────────────────────────────────────────────────────────────

async function reconfigure() {
    const result = await openSetupWindow(currentConfig);
    if (!result) return; // user cancelled — keep existing config and server
    saveConfig(result);
    currentConfig = result;
    await stopExpressServer();
    const ok = await startExpressServer(result);
    if (ok) {
        tray.setContextMenu(buildMenu(true));
        tray.setToolTip('BotW Live Savegame Monitor');
    } else {
        setTrayError();
    }
    // Do NOT auto-open browser on reconfigure (hasOpenedBrowser stays true)
}

// ── Quit ──────────────────────────────────────────────────────────────────────

async function quit() {
    await stopExpressServer();
    if (tray) { tray.destroy(); tray = null; }
    app.quit();
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.on('window-all-closed', () => { /* prevent default quit — we live in the tray */ });

app.whenReady().then(async () => {
    app.setAppUserModelId('com.xanderphillips.botw-live-savegame-monitor');

    currentConfig = loadConfig();

    if (!currentConfig) {
        const candidates = scanCemuSavePaths();
        const suggested = candidates.length > 0 ? { savePath: candidates[0], port: 8080 } : null;
        const result = await openSetupWindow(suggested);
        if (!result) { app.quit(); return; }
        saveConfig(result);
        currentConfig = result;
    }

    createTray();

    const ok = await startExpressServer(currentConfig);
    if (!ok) {
        setTrayError();
        return;
    }

    // Auto-open browser on first cold start
    if (!hasOpenedBrowser) {
        const url = `http://localhost:${currentConfig.port}`;
        shell.openExternal(url);
        hasOpenedBrowser = true;
    }
});
