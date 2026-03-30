/**
 * state.js — Server-side state persistence for the BotW Unexplored Area Viewer
 *
 * State is stored as JSON in state.json inside the configured data directory.
 * In Docker the directory is /app/data (the mounted volume). When running as
 * a Windows exe, STATE_DIR is set by launcher.js to %APPDATA%\botw-live-savegame-monitor.
 * Writes are atomic: data is written to a .tmp file first, then renamed over
 * the target, preventing corrupt reads if a write is interrupted.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, 'data');
fs.mkdirSync(STATE_DIR, { recursive: true });
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const STATE_TMP = STATE_FILE + '.tmp';

const DEFAULT_STATE = {
    schemaVersion: 1,
    stateVersion: 0,
    hiddenTypes: [],
    hiddenServices: [],
    testMode: '',
    trackPlayer: false,
    trackZoom: 15,
    mapView: {
        scale: null,
        panX: null,
        panY: null
    },
    dismissedWaypoints: {
        koroks: [],
        locations: []
    },
    playerPositionOverride: null,
    statOverrides: null,
    playerStatOverrides: null,
    serverStatusOverride: null
};

function readState() {
    try {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        // Merge with defaults so new fields added in future schema versions
        // are always present even if the file predates them
        return Object.assign({}, DEFAULT_STATE, parsed, {
            mapView: Object.assign(
                {},
                DEFAULT_STATE.mapView,
                parsed.mapView || {}
            ),
            dismissedWaypoints: Object.assign(
                {},
                DEFAULT_STATE.dismissedWaypoints,
                parsed.dismissedWaypoints || {}
            )
        });
    } catch {
        return Object.assign({}, DEFAULT_STATE, {
            mapView: Object.assign({}, DEFAULT_STATE.mapView),
            dismissedWaypoints: Object.assign(
                {},
                DEFAULT_STATE.dismissedWaypoints
            )
        });
    }
}

function writeState(patch) {
    try {
        const current = readState();
        const next = Object.assign({}, current, patch, {
            stateVersion: (current.stateVersion || 0) + 1,
            mapView: Object.assign({}, current.mapView, patch.mapView || {}),
            dismissedWaypoints: Object.assign(
                {},
                current.dismissedWaypoints,
                patch.dismissedWaypoints || {}
            )
        });
        fs.writeFileSync(STATE_TMP, JSON.stringify(next, null, 2), 'utf8');
        fs.renameSync(STATE_TMP, STATE_FILE);
        return next;
    } catch (e) {
        console.error('[state] write failed:', e.message);
        return current;
    }
}

module.exports = { readState, writeState, DEFAULT_STATE };
