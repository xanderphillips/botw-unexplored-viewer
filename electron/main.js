'use strict';
const { app, Tray, Menu, shell, nativeImage } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { execFileSync, execSync } = require('child_process');

const { openSetupWindow } = require('./setup-window');

// ── Config ────────────────────────────────────────────────────────────────────

const APP_DATA_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'botw-live-savegame-monitor');
const CONFIG_FILE  = path.join(APP_DATA_DIR, 'config.json');
const ERROR_LOG    = path.join(APP_DATA_DIR, 'error.log');
const VERSION_FILE           = path.join(APP_DATA_DIR, 'version.json');
const SCHEMA_VERSION         = 1;
const OBSOLETE_APPDATA_FILES = []; // add filenames here when removing AppData files in future versions

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

function writeVersionFile() {
    try {
        fs.mkdirSync(APP_DATA_DIR, { recursive: true });
        fs.writeFileSync(VERSION_FILE, JSON.stringify({
            appVersion:    app.getVersion(),
            schemaVersion: SCHEMA_VERSION,
        }, null, 2), 'utf8');
    } catch (e) {
        logError('writeVersionFile failed: ' + e.message);
    }
}

function readVersionFile() {
    try {
        return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
    } catch { return null; }
}

function killOtherInstances() {
    try {
        const out = execSync(
            'tasklist /FI "IMAGENAME eq botw-ls-monitor.exe" /FO CSV /NH',
            { timeout: 5000, encoding: 'utf8' }
        );
        const lines = out.trim().split('\n').filter(Boolean);
        for (const line of lines) {
            const parts = line.split(',');
            if (parts.length < 2) continue;
            const pid = parseInt(parts[1].replace(/"/g, ''), 10);
            if (!pid || pid === process.pid) continue;
            try {
                execSync(`taskkill /F /PID ${pid}`, { timeout: 3000 });
            } catch (e) {
                logError(`taskkill /PID ${pid} failed: ` + e.message);
            }
        }
    } catch (e) {
        logError('killOtherInstances failed: ' + e.message);
    }
}

/**
 * Checks AppData state and handles version/schema migration.
 * Returns 'ok' to continue startup, 'setup' to open setup window, or 'quit' to exit.
 */
async function checkAndMigrateVersion() {
    const configExists  = fs.existsSync(CONFIG_FILE);
    const versionExists = fs.existsSync(VERSION_FILE);

    // Both absent: genuine first run
    if (!configExists && !versionExists) return 'setup';

    // version.json present, config.json absent: config deleted manually — treat as first run
    if (!configExists && versionExists) return 'setup';

    // config.json present, version.json absent: crash recovery or pre-version install
    if (configExists && !versionExists) {
        writeVersionFile();
        return 'ok';
    }

    // Both present: compare versions
    const stored = readVersionFile();
    if (!stored) {
        // Corrupt version.json — treat as routine upgrade, rewrite it
        writeVersionFile();
        return 'ok';
    }

    if (stored.schemaVersion > SCHEMA_VERSION) {
        // Downgrade
        const { response } = await require('electron').dialog.showMessageBox({
            type: 'warning',
            title: 'BotW Live Savegame Monitor',
            message: 'Older version detected',
            detail: 'This version is older than your existing install. Settings cannot be carried forward.\n\nTo recover, manually download the latest version.',
            buttons: ['Reset & Continue', 'Quit'],
            defaultId: 1,
            cancelId: 1,
        });
        if (response === 1) return 'quit';
        wipeAppData();
        return 'setup';
    }

    if (stored.schemaVersion < SCHEMA_VERSION) {
        // Schema upgrade
        const { response } = await require('electron').dialog.showMessageBox({
            type: 'info',
            title: 'BotW Live Savegame Monitor',
            message: 'Configuration format updated',
            detail: 'This update changes the configuration format. Your settings will be reset.',
            buttons: ['Reset & Continue', 'Quit'],
            defaultId: 0,
            cancelId: 1,
        });
        if (response === 1) return 'quit';
        wipeAppData();
        return 'setup';
    }

    // Schema matches — routine upgrade or same version
    if (stored.appVersion !== app.getVersion()) {
        for (const f of OBSOLETE_APPDATA_FILES) {
            try { fs.unlinkSync(path.join(APP_DATA_DIR, f)); } catch { /* already gone */ }
        }
        writeVersionFile();
    }
    return 'ok';
}

function wipeAppData() {
    try {
        const entries = fs.readdirSync(APP_DATA_DIR);
        for (const entry of entries) {
            fs.rmSync(path.join(APP_DATA_DIR, entry), { recursive: true, force: true });
        }
    } catch (e) {
        logError('wipeAppData failed: ' + e.message);
    }
}

function createDesktopShortcut() {
    if (!app.isPackaged) return;
    const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const ps = [
        `$ws = New-Object -ComObject WScript.Shell`,
        `$s = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\\BotW Live Savegame Monitor.lnk')`,
        `$s.TargetPath = '${exePath.replace(/'/g, "''")}'`,
        `$s.Save()`,
    ].join('; ');
    try {
        execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 5000 });
    } catch (e) {
        logError('Shortcut creation failed: ' + e.message);
    }
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
        currentHttpServer.closeAllConnections();
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

// Prevent multiple instances. If another instance holds the lock, quit immediately.
// The lock is released on app.quit(), so auto-update (quitAndInstall) is unaffected —
// the new exe launches after the old one exits and can acquire the lock normally.
if (!app.requestSingleInstanceLock()) {
    app.quit();
    process.exit(0);
}

app.on('window-all-closed', () => { /* prevent default quit — we live in the tray */ });

app.whenReady().then(async () => {
    app.setName('BotW Live Savegame Monitor');
    app.setAppUserModelId('com.xanderphillips.botw-live-savegame-monitor');

    currentConfig = loadConfig();
    const isFirstRun = !currentConfig;

    if (isFirstRun) {
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

    // Only show the "tray icon may be hidden" balloon on first run
    if (isFirstRun) {
        tray.displayBalloon({
            title: 'BotW Live Savegame Monitor',
            content: 'Running in the system tray. Right-click the icon to open the browser or quit.',
            iconType: 'info',
        });
    }
});
