/**
 * launcher.js — Windows executable entry point for the BotW Live Savegame Monitor
 *
 * Responsibilities:
 *   - Load or create configuration (%APPDATA%\botw-live-savegame-monitor\config.json)
 *   - On first run (or --setup flag): show native folder picker for Cemu save path
 *     and auto-detect an available port
 *   - Inject configuration as env vars before starting the Express server
 *   - Open the browser automatically after startup
 *
 * Run with --setup to reconfigure save path and port at any time.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { execSync, exec } = require('child_process');
const readline = require('readline');

const VERSION = require('./package.json').version;

const APP_DATA_DIR = path.join(
    os.homedir(),
    'AppData',
    'Roaming',
    'botw-live-savegame-monitor'
);
const CONFIG_FILE = path.join(APP_DATA_DIR, 'config.json');

// Ports tried in order during auto-detection. Port 80 requires admin on Windows.
const CANDIDATE_PORTS = [80, 8080, 8081, 3000];

function printBanner() {
    console.log('');
    console.log('  BOTW Live Savegame Monitor v' + VERSION);
    console.log('  ================================');
    console.log('');
}

function isPortFree(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(port, '127.0.0.1', () => {
            server.close(() => resolve(true));
        });
        server.on('error', () => resolve(false));
    });
}

async function pickPort() {
    for (const port of CANDIDATE_PORTS) {
        const free = await isPortFree(port);
        if (free) {
            if (port === 80) {
                console.log(
                    '  Port 80 is available but requires running as Administrator.\n' +
                    '  Falling back to 8080...'
                );
                continue;
            }
            return port;
        }
    }
    // None of the candidates worked — ask the user
    console.log('  Ports 80, 8080, 8081, and 3000 are all in use.');
    const answer = await prompt('  Enter a port number to use: ');
    return parseInt(answer, 10) || 8080;
}

// Scan the standard Cemu save tree for folders that look like BotW save roots.
// A valid root contains at least one slot subfolder (0–5) with game_data.sav.
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
    } catch {
        return [];
    }
}

function prompt(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
    });
}

function openFolderPicker(startPath) {
    // Write PS1 to a temp file to avoid quoting issues with -Command
    const tmpScript = path.join(os.tmpdir(), 'botw-folder-picker.ps1');
    const ps = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        "$d.Description = 'Select your Cemu save folder (the one containing 0/, 1/, 2/ subfolders)'",
        '$d.ShowNewFolderButton = $false',
        startPath
            ? `if (Test-Path '${startPath}') { $d.SelectedPath = '${startPath}' }`
            : '',
        "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { 'CANCELLED' }"
    ].join('\n');

    fs.writeFileSync(tmpScript, ps, 'utf8');
    try {
        const result = execSync(
            `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpScript}"`,
            { encoding: 'utf8' }
        ).trim();
        return result && result !== 'CANCELLED' ? result : null;
    } catch (e) {
        console.error('  Failed to open folder picker:', e.message);
        return null;
    } finally {
        try { fs.unlinkSync(tmpScript); } catch { /* ignore */ }
    }
}

async function pickSavePath() {
    const candidates = scanCemuSavePaths();

    if (candidates.length === 1) {
        console.log('  Found Cemu save folder:');
        console.log('    ' + candidates[0]);
        const answer = await prompt('  Use this path? [Y/n]: ');
        if (!answer || answer.toLowerCase() === 'y') return candidates[0];
    } else if (candidates.length > 1) {
        console.log('  Found multiple Cemu save folders:');
        candidates.forEach((p, i) => console.log(`    ${i + 1}. ${p}`));
        const answer = await prompt('  Enter number to use, or 0 to browse manually: ');
        const choice = parseInt(answer, 10);
        if (choice >= 1 && choice <= candidates.length) return candidates[choice - 1];
    } else {
        console.log('  No Cemu save folder found automatically. Opening folder picker...');
    }

    // Fall back to folder picker dialog, starting at the Cemu user dir if it exists
    const fallbackStart = path.join(
        os.homedir(), 'AppData', 'Roaming',
        'Cemu', 'mlc01', 'usr', 'save', '00050000', '101c9400', 'user'
    );
    return openFolderPicker(fs.existsSync(fallbackStart) ? fallbackStart : null);
}

function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
        return null;
    }
}

function saveConfig(config) {
    fs.mkdirSync(APP_DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

async function runSetup() {
    console.log('  No configuration found. Starting setup...\n');

    const savePath = await pickSavePath();
    if (!savePath) {
        console.error('  Setup cancelled — no save folder selected. Exiting.');
        process.exit(1);
    }
    console.log('  Save path: ' + savePath + '\n');

    console.log('  Checking port availability...');
    const port = await pickPort();
    console.log('  Using port: ' + port + '\n');

    const config = { savePath, port };
    saveConfig(config);
    console.log('  Configuration saved to: ' + CONFIG_FILE + '\n');
    return config;
}

async function main() {
    printBanner();

    const isSetup = process.argv.includes('--setup');
    let config = isSetup ? null : loadConfig();

    if (!config) {
        config = await runSetup();
    } else {
        console.log('  Config:    ' + CONFIG_FILE);
        console.log('  Save path: ' + config.savePath);
        console.log('  Port:      ' + config.port);
        console.log('\n  (Run with --setup to reconfigure)\n');
    }

    // Assets are bundled into the exe via pkg (virtual fs) and also live one
    // level up from server/ in dev — __dirname resolves correctly in both cases.
    const staticRoot = path.join(__dirname, '..');

    // Set env vars before requiring server so module-level code picks them up
    process.env.SAVE_PATH_BASE = config.savePath;
    process.env.STATE_DIR = APP_DATA_DIR;
    process.env.STATIC_ROOT = staticRoot;

    const { app } = require('./server');
    const url = `http://localhost:${config.port}`;

    app.listen(config.port, '0.0.0.0', () => {
        console.log('  Server running at ' + url);
        console.log('  Press Ctrl+C to stop.\n');
        // Open default browser after a short delay so the server is fully ready
        setTimeout(() => exec(`start "" "${url}"`), 1000);
    });
}

main().catch((err) => {
    console.error('\nFatal error:', err.message);
    process.exit(1);
});
