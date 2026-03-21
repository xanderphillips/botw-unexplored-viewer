/**
 * server.js — Express server for the BotW Unexplored Area Viewer
 *
 * Responsibilities:
 *   - Serve static frontend files (HTML, CSS, JS, map image)
 *   - Proxy the Cemu save file to the browser via /data/game_data.sav
 *   - Expose /api/mtime so the browser can poll for save file changes
 *   - Expose /api/state/* for authenticated UI state management
 *   - Expose /api/config for browser API key bootstrap
 *   - Parse save file metrics server-side and expose them via /api (debug)
 *
 * Save file path is configured via SAVE_PATH in server/.env, mounted
 * into the container at /app/data/game_data.sav.
 *
 * Authentication: all /api/state/* endpoints require the X-API-Key header
 * matching the API_KEY environment variable from server/.env.
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { readState, writeState } = require('./state');

const app = express();
const PORT = 3000;

app.use(express.json());

// All six save slots: 0 = manual save, 1–5 = auto-saves
const SAVE_SLOTS = Array.from({ length: 6 }, (_, i) =>
    path.join(__dirname, `data/game_data_${i}.sav`)
);

// Find the most recently modified save slot.
// Calls callback(filePath, mtimeMs) with the winner, or callback(null, null) if none are readable.
function getMostRecentSave(callback) {
    let remaining = SAVE_SLOTS.length;
    let bestPath = null;
    let bestMtime = -1;
    SAVE_SLOTS.forEach((filePath) => {
        fs.stat(filePath, (err, stats) => {
            if (!err && stats.isFile() && stats.mtimeMs > bestMtime) {
                bestMtime = stats.mtimeMs;
                bestPath = filePath;
            }
            if (--remaining === 0)
                callback(bestPath, bestMtime > -1 ? bestMtime : null);
        });
    });
}

// Auth middleware — requires X-API-Key header matching API_KEY env var.
// If API_KEY is not configured, all state endpoints return 503.
function requireApiKey(req, res, next) {
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
        res.status(503).json({ ok: false, error: 'API_KEY not configured on server' });
        return;
    }
    if (req.headers['x-api-key'] !== apiKey) {
        res.status(401).json({ ok: false, error: 'Invalid or missing X-API-Key header' });
        return;
    }
    next();
}

// Serve static files from app directory (where Dockerfile copies them)
app.use(express.static(__dirname));

// Serve the most recently modified save slot
app.get('/data/game_data.sav', (req, res) => {
    getMostRecentSave((filePath, mtime) => {
        if (!filePath) {
            res.status(404).send('No save files found');
            return;
        }
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.status(404).send('Save file not found');
                return;
            }
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', data.length);
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-File-Mtime', mtime);
            res.send(data);
        });
    });
});

// Lightweight mtime endpoint — returns the mtime of the most recently modified save slot
app.get('/api/mtime', (req, res) => {
    getMostRecentSave((filePath, mtime) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json({ mtime, stateVersion: readState().stateVersion || 0 });
    });
});

// Config endpoint — returns the API key for browser bootstrap.
// No auth required: the key itself is the credential.
// Safe for LAN-only deployment.
app.get('/api/config', (req, res) => {
    res.json({ apiKey: process.env.API_KEY || null });
});

// ── SSE push ──────────────────────────────────────────────────────────────────

const sseClients = new Set();

function broadcastStateChange(nextState) {
    if (sseClients.size === 0) return;
    // Include full state in the event so browsers can apply it immediately
    // without a follow-up GET /api/state round-trip.
    const msg = `event: state-change\ndata: ${JSON.stringify({ stateVersion: nextState.stateVersion, state: nextState })}\n\n`;
    sseClients.forEach((client) => {
        try {
            client.write(msg);
        } catch {
            sseClients.delete(client);
        }
    });
}

// Wrap writeState so every state mutation triggers an SSE broadcast
function writeStateAndBroadcast(patch) {
    const next = writeState(patch);
    broadcastStateChange(next);
    return next;
}

// Tell all connected browsers to reload their save file data from /data/game_data.sav.
// Used after test completion so stats revert to actual in-game values.
function broadcastReloadSave() {
    if (sseClients.size === 0) return;
    const msg = `event: reload-save\ndata: {}\n\n`;
    sseClients.forEach((client) => {
        try {
            client.write(msg);
        } catch {
            sseClients.delete(client);
        }
    });
}

// GET /api/events — SSE stream; pushes state-change events on any state mutation
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
});

// ── State API ─────────────────────────────────────────────────────────────────
// All endpoints require X-API-Key. All return { ok, state } on success.

// GET /api/state — return full state
app.get('/api/state', requireApiKey, (req, res) => {
    res.json({ ok: true, state: readState() });
});

// PUT /api/state — replace full state (used for bulk sync from client)
app.put('/api/state', requireApiKey, (req, res) => {
    const next = writeStateAndBroadcast(req.body || {});
    res.json({ ok: true, state: next });
});

// PATCH /api/state/hidden-types — toggle icon type visibility
// Body: { type: string, hidden: boolean }
app.patch('/api/state/hidden-types', requireApiKey, (req, res) => {
    const { type, hidden } = req.body || {};
    if (typeof type !== 'string' || typeof hidden !== 'boolean') {
        res.status(400).json({ ok: false, error: 'Body must include type (string) and hidden (boolean)' });
        return;
    }
    const state = readState();
    const set = new Set(state.hiddenTypes);
    hidden ? set.add(type) : set.delete(type);
    res.json({ ok: true, state: writeStateAndBroadcast({ hiddenTypes: Array.from(set) }) });
});

// PATCH /api/state/hidden-services — toggle service filter visibility
// Body: { service: string, hidden: boolean }
app.patch('/api/state/hidden-services', requireApiKey, (req, res) => {
    const { service, hidden } = req.body || {};
    if (typeof service !== 'string' || typeof hidden !== 'boolean') {
        res.status(400).json({ ok: false, error: 'Body must include service (string) and hidden (boolean)' });
        return;
    }
    const state = readState();
    const set = new Set(state.hiddenServices);
    hidden ? set.add(service) : set.delete(service);
    res.json({ ok: true, state: writeStateAndBroadcast({ hiddenServices: Array.from(set) }) });
});

// PATCH /api/state/test-mode — show or hide the testing banner in the browser
// Body: { enabled: boolean, phase?: string }
// When enabled, testMode stores the phase label shown in the banner.
app.patch('/api/state/test-mode', requireApiKey, (req, res) => {
    const { enabled, phase } = req.body || {};
    if (typeof enabled !== 'boolean') {
        res.status(400).json({ ok: false, error: 'Body must include enabled (boolean)' });
        return;
    }
    const label = enabled ? (typeof phase === 'string' && phase ? phase : 'TEST MODE ACTIVE') : '';
    res.json({ ok: true, state: writeStateAndBroadcast({ testMode: label }) });
});

// PATCH /api/state/player-position — override player position for testing
// Body: { x: number, z: number }  (BotW world coordinates)
app.patch('/api/state/player-position', requireApiKey, (req, res) => {
    const { x, z } = req.body || {};
    if (typeof x !== 'number' || typeof z !== 'number') {
        res.status(400).json({ ok: false, error: 'Body must include x and z (numbers)' });
        return;
    }
    res.json({ ok: true, state: writeStateAndBroadcast({ playerPositionOverride: { x, z } }) });
});

// DELETE /api/state/player-position — clear player position override
app.delete('/api/state/player-position', requireApiKey, (req, res) => {
    res.json({ ok: true, state: writeStateAndBroadcast({ playerPositionOverride: null }) });
});

// PUT /api/state/stat-overrides — override stat display values for testing
// Body: { koroks, locations, shrines, shrinesCompleted, towers, divineBeasts } (all optional numbers)
app.put('/api/state/stat-overrides', requireApiKey, (req, res) => {
    const { koroks, locations, shrines, shrinesCompleted, towers, divineBeasts } = req.body || {};
    res.json({ ok: true, state: writeStateAndBroadcast({ statOverrides: { koroks, locations, shrines, shrinesCompleted, towers, divineBeasts } }) });
});

// DELETE /api/state/stat-overrides — clear stat overrides
app.delete('/api/state/stat-overrides', requireApiKey, (req, res) => {
    res.json({ ok: true, state: writeStateAndBroadcast({ statOverrides: null }) });
});

// PUT /api/state/player-stat-overrides — override player stat display values for testing
// Body: { hearts, stamina, playtime, rupees, motorcycle } (all optional)
app.put('/api/state/player-stat-overrides', requireApiKey, (req, res) => {
    const { hearts, stamina, playtime, rupees, motorcycle } = req.body || {};
    res.json({ ok: true, state: writeStateAndBroadcast({ playerStatOverrides: { hearts, stamina, playtime, rupees, motorcycle } }) });
});

// DELETE /api/state/player-stat-overrides — clear player stat overrides
app.delete('/api/state/player-stat-overrides', requireApiKey, (req, res) => {
    res.json({ ok: true, state: writeStateAndBroadcast({ playerStatOverrides: null }) });
});

// PUT /api/state/server-status-override — override server status dot and timestamp display
// Body: { timestamp: number (ms), online: boolean }
app.put('/api/state/server-status-override', requireApiKey, (req, res) => {
    const { timestamp, online } = req.body || {};
    res.json({ ok: true, state: writeStateAndBroadcast({ serverStatusOverride: { timestamp, online } }) });
});

// DELETE /api/state/server-status-override — clear server status override
app.delete('/api/state/server-status-override', requireApiKey, (req, res) => {
    res.json({ ok: true, state: writeStateAndBroadcast({ serverStatusOverride: null }) });
});

// PATCH /api/state/track-player — enable or disable player position tracking
// Body: { enabled: boolean }
app.patch('/api/state/track-player', requireApiKey, (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
        res.status(400).json({ ok: false, error: 'Body must include enabled (boolean)' });
        return;
    }
    res.json({ ok: true, state: writeStateAndBroadcast({ trackPlayer: enabled }) });
});

// PATCH /api/state/track-zoom — set player tracking zoom level
// Body: { zoom: number (5–90) }
app.patch('/api/state/track-zoom', requireApiKey, (req, res) => {
    const { zoom } = req.body || {};
    if (typeof zoom !== 'number' || zoom < 5 || zoom > 90) {
        res.status(400).json({ ok: false, error: 'Body must include zoom (number, 5–90)' });
        return;
    }
    res.json({ ok: true, state: writeStateAndBroadcast({ trackZoom: zoom }) });
});

// PATCH /api/state/map-view — set map pan/zoom viewport
// Body: { scale: number|null, panX: number|null, panY: number|null }
app.patch('/api/state/map-view', requireApiKey, (req, res) => {
    const { scale, panX, panY } = req.body || {};
    res.json({ ok: true, state: writeStateAndBroadcast({ mapView: { scale, panX, panY } }) });
});

// POST /api/state/dismissed — mark a waypoint as manually dismissed
// Body: { type: 'korok'|'location', name: string }
app.post('/api/state/dismissed', requireApiKey, (req, res) => {
    const { type, name } = req.body || {};
    if ((type !== 'korok' && type !== 'location') || typeof name !== 'string') {
        res.status(400).json({ ok: false, error: 'Body must include type ("korok"|"location") and name (string)' });
        return;
    }
    const state = readState();
    const key = type === 'korok' ? 'koroks' : 'locations';
    const list = new Set(state.dismissedWaypoints[key]);
    list.add(name);
    res.json({
        ok: true,
        state: writeStateAndBroadcast({ dismissedWaypoints: { ...state.dismissedWaypoints, [key]: Array.from(list) } })
    });
});

// DELETE /api/state/dismissed — restore a dismissed waypoint
// Body: { type: 'korok'|'location', name: string }
app.delete('/api/state/dismissed', requireApiKey, (req, res) => {
    const { type, name } = req.body || {};
    if ((type !== 'korok' && type !== 'location') || typeof name !== 'string') {
        res.status(400).json({ ok: false, error: 'Body must include type ("korok"|"location") and name (string)' });
        return;
    }
    const state = readState();
    const key = type === 'korok' ? 'koroks' : 'locations';
    const list = new Set(state.dismissedWaypoints[key]);
    list.delete(name);
    res.json({
        ok: true,
        state: writeStateAndBroadcast({ dismissedWaypoints: { ...state.dismissedWaypoints, [key]: Array.from(list) } })
    });
});

// DELETE /api/state/dismissed/all — clear all dismissed waypoints
// Called when save file mtime changes (new game state supersedes UI overlay)
app.delete('/api/state/dismissed/all', requireApiKey, (req, res) => {
    res.json({
        ok: true,
        state: writeStateAndBroadcast({ dismissedWaypoints: { koroks: [], locations: [] } })
    });
});

// ── Debug endpoint ────────────────────────────────────────────────────────────

// Parse map-locations.js to extract hash → internal_name tables for each category
function loadMapHashes() {
    const content = fs.readFileSync(
        path.join(__dirname, 'assets/js/map-locations.js'),
        'utf8'
    );

    function extractSection(name) {
        const start = content.indexOf(`var ${name} = {`);
        if (start < 0) return {};
        const end = content.indexOf('\n    };', start);
        const section = content.slice(start, end);
        const result = {};
        const re = /0x([0-9a-fA-F]+):\s*\{"internal_name":"([^"]+)"/g;
        let m;
        while ((m = re.exec(section)) !== null)
            result[parseInt(m[1], 16)] = m[2];
        return result;
    }

    const warps = extractSection('warps');
    const shrines = {},
        towers = {},
        divineBeasts = {},
        otherWarps = {};
    for (const h in warps) {
        const n = warps[h];
        if (n.startsWith('Location_Dungeon')) shrines[h] = n;
        else if (n.startsWith('Location_MapTower')) towers[h] = n;
        else if (n.startsWith('Location_Remains')) divineBeasts[h] = n;
        else otherWarps[h] = n;
    }

    return {
        locations: extractSection('locations'),
        shrines,
        towers,
        divineBeasts,
        koroks: extractSection('koroks'),
        shrineCompletions: extractSection('shrineCompletions')
    };
}

// Cache map hashes at startup — map-locations.js never changes at runtime
const cachedMapHashes = loadMapHashes();

// Scan save buffer for found/total counts of a hash table
// A flag is "found" when its value field (offset+4) is non-zero
function scanFlags(buf, readU32, hashTable) {
    const found = new Set();
    const total = Object.keys(hashTable).length;
    for (let i = 0x0c; i < buf.length - 4; i += 8) {
        const hash = readU32(i);
        if (
            Object.prototype.hasOwnProperty.call(hashTable, hash) &&
            readU32(i + 4) !== 0
        )
            found.add(hash);
    }
    return { found: found.size, total };
}

// Parse BotW save file hashes server-side for debug inspection
function parseSaveMetrics(buf) {
    function makeReaders(le) {
        return {
            u32: (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o)),
            f32: (o) => (le ? buf.readFloatLE(o) : buf.readFloatBE(o))
        };
    }
    function searchHash(readU32, hash) {
        for (var i = 0x0c; i < buf.length - 4; i += 8)
            if (readU32(i) === hash) return i;
        return -1;
    }

    // Detect endianness via KOROK_SEED_COUNTER
    var r, le;
    var beReaders = makeReaders(false);
    var leReaders = makeReaders(true);
    if (searchHash(beReaders.u32, 0x8a94e07a) >= 0) {
        r = beReaders;
        le = false;
    } else if (searchHash(leReaders.u32, 0x8a94e07a) >= 0) {
        r = leReaders;
        le = true;
    } else
        return {
            error: 'KOROK_SEED_COUNTER not found — not a valid BotW save'
        };

    var metrics = { console: le ? 'Switch' : 'Wii U' };

    var targets = {
        KOROK_SEED_COUNTER: { hash: 0x8a94e07a, type: 'u32' },
        MAX_HEARTS: { hash: 0x2906f327, type: 'u32' }, // quarter-heart units
        MAX_STAMINA: { hash: 0x3adff047, type: 'f32' },
        PLAYTIME: { hash: 0x73c29681, type: 'u32' },
        RUPEES: { hash: 0x23149bf8, type: 'u32' },
        MOTORCYCLE: { hash: 0xc9328299, type: 'u32' },
        PLAYER_POSITION: { hash: 0xa40ba103, type: 'f32x3' },
        MAP: { hash: 0x0bee9e46, type: 'u32' },
        MAPTYPE: { hash: 0xd913b769, type: 'u32' }
    };

    for (var name in targets) {
        var t = targets[name];
        var off = searchHash(r.u32, t.hash);
        if (off < 0) {
            metrics[name] = null;
            continue;
        }
        if (t.type === 'u32') {
            metrics[name] = r.u32(off + 4);
        } else if (t.type === 'f32') {
            metrics[name] = r.f32(off + 4);
        } else if (t.type === 'f32x3') {
            // Three consecutive [hash,value] pairs with the same hash: X at +4, Y(height) at +12, Z at +20
            metrics[name] = {
                x: r.f32(off + 4),
                y: r.f32(off + 12),
                z: r.f32(off + 20),
                raw_hex: buf.slice(off, off + 24).toString('hex')
            };
        }
    }

    // Hearts stored as quarter-heart units (÷4 = displayed heart count)
    if (metrics.MAX_HEARTS != null)
        metrics.MAX_HEARTS_display = metrics.MAX_HEARTS / 4;
    // Stamina stored as F32 in units of 1/1000 wheel
    if (metrics.MAX_STAMINA != null)
        metrics.MAX_STAMINA_display = +(metrics.MAX_STAMINA / 1000).toFixed(1);

    if (metrics.PLAYTIME != null) {
        var s = metrics.PLAYTIME;
        var h = Math.floor(s / 3600),
            m = Math.floor((s % 3600) / 60),
            sec = s % 60;
        metrics.PLAYTIME_formatted =
            h +
            ':' +
            (m < 10 ? '0' + m : m) +
            ':' +
            (sec < 10 ? '0' + sec : sec);
    }

    // Location flag scans — mirror the sidebar metrics
    try {
        const map = cachedMapHashes;
        metrics.locations = scanFlags(buf, r.u32, map.locations);
        metrics.locations.total = 226; // hardcoded per game sources (matches sidebar)
        metrics.shrines_discovered = scanFlags(buf, r.u32, map.shrines);
        metrics.shrines_completed = scanFlags(
            buf,
            r.u32,
            map.shrineCompletions
        );
        metrics.towers = scanFlags(buf, r.u32, map.towers);
        metrics.divine_beasts = scanFlags(buf, r.u32, map.divineBeasts);
        metrics.koroks_discovered = scanFlags(buf, r.u32, map.koroks);
    } catch (e) {
        metrics.location_scan_error = e.message;
    }

    return metrics;
}

// Debug endpoint — only available when DEBUG=1 env var is set
if (process.env.DEBUG) app.get('/api', (req, res) => {
    getMostRecentSave((filePath, mtime) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!filePath) {
            res.status(404).json({ error: 'No save files found' });
            return;
        }
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.status(404).json({ error: 'Save file not found' });
                return;
            }
            res.json(parseSaveMetrics(data));
        });
    });
});

// POST /api/test/run — run the full server-side UI test suite
// Long-running (~30s); broadcasts SSE updates throughout so the browser animates live.
let _testRunning = false;
app.post('/api/test/run', requireApiKey, async (req, res) => {
    if (_testRunning) {
        res.status(409).json({ ok: false, error: 'Test already running' });
        return;
    }
    _testRunning = true;
    try {
        const { runTest } = require('./test');
        const results = await runTest({ writeStateAndBroadcast, readState, broadcastReloadSave });
        res.json({ ok: true, results });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    } finally {
        _testRunning = false;
    }
});

// Export app for Supertest integration tests
if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}

module.exports = { app };
