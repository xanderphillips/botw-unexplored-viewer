/**
 * server.js — Express server for the BotW Unexplored Area Viewer
 *
 * Responsibilities:
 *   - Serve static frontend files (HTML, CSS, JS, map image)
 *   - Proxy the Cemu save file to the browser via /data/game_data.sav
 *   - Expose /api/mtime so the browser can poll for save file changes
 *   - Expose /api/state/* for UI state management
 *   - Parse save file metrics server-side and expose them via /api (debug)
 *
 * Save file path is configured via SAVE_PATH in server/.env, mounted
 * into the container at /app/data/game_data.sav.
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { readState, writeState } = require('./state');
const { validateSaveBuffer } = require('./validate-save.js');

// Cache last validation result so /api/mtime doesn't re-read the file on every poll.
// Invalidated when mtime changes.
let _saveValidationCache = { mtime: null, status: 'not_found' };

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// When running as a Windows exe (via launcher.js), STATIC_ROOT is set to the
// directory containing the exe so static assets are served from alongside it.
// In Docker __dirname is /app and all static files are copied there.
const STATIC_ROOT = process.env.STATIC_ROOT || __dirname;

app.use(express.json());

// All six save slots: 0 = manual save, 1–5 = auto-saves.
// When SAVE_PATH_BASE is set (Windows exe), slots are resolved as
// <SAVE_PATH_BASE>/<i>/game_data.sav (matching Cemu's layout).
let _savePathBase = process.env.SAVE_PATH_BASE || null;

let _reconfigureHandler = null;
function registerReconfigureHandler(fn) { _reconfigureHandler = fn; }

function getSaveSlots() {
    return _savePathBase
        ? Array.from({ length: 6 }, (_, i) =>
              path.join(_savePathBase, String(i), 'game_data.sav')
          )
        : Array.from({ length: 6 }, (_, i) =>
              path.join(__dirname, `data/game_data_${i}.sav`)
          );
}

// Find the most recently modified save slot.
// Calls callback(filePath, mtimeMs) with the winner, or callback(null, null) if none are readable.
function getMostRecentSave(callback) {
    const slots = getSaveSlots();
    let remaining = slots.length;
    let bestPath = null;
    let bestMtime = -1;
    slots.forEach((filePath) => {
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

// Serve static files from STATIC_ROOT (see definition above)
app.use(express.static(STATIC_ROOT));

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

// Lightweight mtime endpoint — returns mtime and server-side save validation status.
// saveStatus: 'ok' | 'not_found' | 'unreadable' | 'invalid_format'
app.get('/api/mtime', (req, res) => {
    getMostRecentSave((filePath, mtime) => {
        res.setHeader('Cache-Control', 'no-store');
        const stateVersion = readState().stateVersion || 0;

        if (!filePath) {
            _saveValidationCache = { mtime: null, status: 'not_found' };
            res.json({ mtime: null, stateVersion, saveStatus: 'not_found' });
            return;
        }

        // Cache hit — mtime unchanged, reuse previous validation result
        if (mtime === _saveValidationCache.mtime) {
            res.json({ mtime, stateVersion, saveStatus: _saveValidationCache.status });
            return;
        }

        // Cache miss — file changed (or first request): read and validate
        fs.readFile(filePath, (err, buf) => {
            const status = err
                ? 'unreadable'
                : validateSaveBuffer(buf).valid ? 'ok' : 'invalid_format';
            _saveValidationCache = { mtime, status };
            res.json({ mtime, stateVersion, saveStatus: status });
        });
    });
});

// POST /api/request-reconfigure — signal Electron to open the setup window.
// Only functional when running as a Windows exe (handler registered by main.js).
app.post('/api/request-reconfigure', (req, res) => {
    if (typeof _reconfigureHandler === 'function') {
        _reconfigureHandler();
        res.json({ ok: true });
    } else {
        res.status(501).json({ ok: false, error: 'Not supported in this environment' });
    }
});

// GET /api/version — return the app version from root package.json
app.get('/api/version', (req, res) => {
    try {
        // STATIC_ROOT is set by launcher.js to the app root (electron binary).
        // In Docker, __dirname is already the app root and package.json.root is used.
        const rootDir = process.env.STATIC_ROOT || __dirname;
        let packageJsonContent;
        try {
            packageJsonContent = fs.readFileSync(path.join(rootDir, 'package.json.root'), 'utf-8');
        } catch {
            packageJsonContent = fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8');
        }
        const packageJson = JSON.parse(packageJsonContent);
        res.json({ ok: true, version: packageJson.version });
    } catch (err) {
        res.status(500).json({ ok: false, error: 'Failed to read version' });
    }
});

// ── SSE push ──────────────────────────────────────────────────────────────────

const sseClients = new Set();

function broadcast(eventName, data) {
    if (sseClients.size === 0) return;
    const msg = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach((client) => {
        try {
            client.write(msg);
        } catch {
            sseClients.delete(client);
        }
    });
}

function broadcastStateChange(nextState) {
    // Include full state in the event so browsers can apply it immediately
    // without a follow-up GET /api/state round-trip.
    broadcast('state-change', { stateVersion: nextState.stateVersion, state: nextState });
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
    broadcast('reload-save', {});
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
// All endpoints return { ok, state } on success.

// GET /api/state — return full state
app.get('/api/state', (req, res) => {
    res.json({ ok: true, state: readState() });
});

// PUT /api/state — replace full state (used for bulk sync from client)
app.put('/api/state', (req, res) => {
    const next = writeStateAndBroadcast(req.body || {});
    res.json({ ok: true, state: next });
});

// PATCH /api/state/hidden-types — toggle icon type visibility
// Body: { type: string, hidden: boolean }
app.patch('/api/state/hidden-types', (req, res) => {
    const { type, hidden } = req.body || {};
    if (typeof type !== 'string' || typeof hidden !== 'boolean') {
        res.status(400).json({
            ok: false,
            error: 'Body must include type (string) and hidden (boolean)'
        });
        return;
    }
    const state = readState();
    const set = new Set(state.hiddenTypes);
    hidden ? set.add(type) : set.delete(type);
    res.json({
        ok: true,
        state: writeStateAndBroadcast({ hiddenTypes: Array.from(set) })
    });
});

// PATCH /api/state/hidden-services — toggle service filter visibility
// Body: { service: string, hidden: boolean }
app.patch('/api/state/hidden-services', (req, res) => {
    const { service, hidden } = req.body || {};
    if (typeof service !== 'string' || typeof hidden !== 'boolean') {
        res.status(400).json({
            ok: false,
            error: 'Body must include service (string) and hidden (boolean)'
        });
        return;
    }
    const state = readState();
    const set = new Set(state.hiddenServices);
    hidden ? set.add(service) : set.delete(service);
    res.json({
        ok: true,
        state: writeStateAndBroadcast({ hiddenServices: Array.from(set) })
    });
});

// PATCH /api/state/hidden-types-bulk — show or hide all supplied map types at once
// Body: { types: string[], hidden: boolean }
app.patch('/api/state/hidden-types-bulk', (req, res) => {
    const { types, hidden } = req.body || {};
    if (
        !Array.isArray(types) ||
        types.length === 0 ||
        typeof hidden !== 'boolean'
    ) {
        res.status(400).json({
            ok: false,
            error: 'Body must include types (non-empty string[]) and hidden (boolean)'
        });
        return;
    }
    const state = readState();
    const set = new Set(state.hiddenTypes);
    types.forEach((t) => (hidden ? set.add(t) : set.delete(t)));
    res.json({
        ok: true,
        state: writeStateAndBroadcast({ hiddenTypes: Array.from(set) })
    });
});

// PATCH /api/state/hidden-services-bulk — show or hide all supplied services at once
// Body: { services: string[], hidden: boolean }
app.patch('/api/state/hidden-services-bulk', (req, res) => {
    const { services, hidden } = req.body || {};
    if (
        !Array.isArray(services) ||
        services.length === 0 ||
        typeof hidden !== 'boolean'
    ) {
        res.status(400).json({
            ok: false,
            error: 'Body must include services (non-empty string[]) and hidden (boolean)'
        });
        return;
    }
    const state = readState();
    const set = new Set(state.hiddenServices);
    services.forEach((s) => (hidden ? set.add(s) : set.delete(s)));
    res.json({
        ok: true,
        state: writeStateAndBroadcast({ hiddenServices: Array.from(set) })
    });
});

// PATCH /api/state/test-mode — show or hide the testing banner in the browser
// Body: { enabled: boolean, phase?: string }
// When enabled, testMode stores the phase label shown in the banner.
app.patch('/api/state/test-mode', (req, res) => {
    const { enabled, phase } = req.body || {};
    if (typeof enabled !== 'boolean') {
        res.status(400).json({
            ok: false,
            error: 'Body must include enabled (boolean)'
        });
        return;
    }
    const label = enabled
        ? typeof phase === 'string' && phase
            ? phase
            : 'TEST MODE ACTIVE'
        : '';
    res.json({ ok: true, state: writeStateAndBroadcast({ testMode: label }) });
});

// PATCH /api/state/player-position — override player position for testing
// Body: { x: number, z: number }  (BotW world coordinates)
app.patch('/api/state/player-position', (req, res) => {
    const { x, z } = req.body || {};
    if (typeof x !== 'number' || typeof z !== 'number') {
        res.status(400).json({
            ok: false,
            error: 'Body must include x and z (numbers)'
        });
        return;
    }
    res.json({
        ok: true,
        state: writeStateAndBroadcast({ playerPositionOverride: { x, z } })
    });
});

// DELETE /api/state/player-position — clear player position override
app.delete('/api/state/player-position', (req, res) => {
    res.json({
        ok: true,
        state: writeStateAndBroadcast({ playerPositionOverride: null })
    });
});

// PUT /api/state/stat-overrides — override stat display values for testing
// Body: { koroks, locations, shrines, shrinesCompleted, shrinesNotActivated, towers, divineBeasts, divineBeatsCompleted } (all optional numbers)
app.put('/api/state/stat-overrides', (req, res) => {
    const {
        koroks,
        locations,
        shrines,
        shrinesCompleted,
        shrinesNotActivated,
        towers,
        divineBeasts,
        divineBeatsCompleted
    } = req.body || {};
    res.json({
        ok: true,
        state: writeStateAndBroadcast({
            statOverrides: {
                koroks,
                locations,
                shrines,
                shrinesCompleted,
                shrinesNotActivated,
                towers,
                divineBeasts,
                divineBeatsCompleted
            }
        })
    });
});

// DELETE /api/state/stat-overrides — clear stat overrides
app.delete('/api/state/stat-overrides', (req, res) => {
    res.json({
        ok: true,
        state: writeStateAndBroadcast({ statOverrides: null })
    });
});

// PUT /api/state/player-stat-overrides — override player stat display values for testing
// Body: { hearts, stamina, playtime, rupees, motorcycle } (all optional)
app.put('/api/state/player-stat-overrides', (req, res) => {
    const { hearts, stamina, playtime, rupees, motorcycle } = req.body || {};
    res.json({
        ok: true,
        state: writeStateAndBroadcast({
            playerStatOverrides: {
                hearts,
                stamina,
                playtime,
                rupees,
                motorcycle
            }
        })
    });
});

// DELETE /api/state/player-stat-overrides — clear player stat overrides
app.delete('/api/state/player-stat-overrides', (req, res) => {
    res.json({
        ok: true,
        state: writeStateAndBroadcast({ playerStatOverrides: null })
    });
});

// PUT /api/state/server-status-override — override server status dot and timestamp display
// Body: { timestamp: number (ms), online: boolean }
app.put('/api/state/server-status-override', (req, res) => {
    const { timestamp, online } = req.body || {};
    res.json({
        ok: true,
        state: writeStateAndBroadcast({
            serverStatusOverride: { timestamp, online }
        })
    });
});

// DELETE /api/state/server-status-override — clear server status override
app.delete('/api/state/server-status-override', (req, res) => {
    res.json({
        ok: true,
        state: writeStateAndBroadcast({ serverStatusOverride: null })
    });
});

// PATCH /api/state/track-player — enable or disable player position tracking
// Body: { enabled: boolean }
app.patch('/api/state/track-player', (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
        res.status(400).json({
            ok: false,
            error: 'Body must include enabled (boolean)'
        });
        return;
    }
    res.json({
        ok: true,
        state: writeStateAndBroadcast({ trackPlayer: enabled })
    });
});

// PATCH /api/state/track-zoom — set player tracking zoom level
// Body: { zoom: number (5–90) }
app.patch('/api/state/track-zoom', (req, res) => {
    const { zoom } = req.body || {};
    if (typeof zoom !== 'number' || zoom < 5 || zoom > 90) {
        res.status(400).json({
            ok: false,
            error: 'Body must include zoom (number, 5–90)'
        });
        return;
    }
    res.json({ ok: true, state: writeStateAndBroadcast({ trackZoom: zoom }) });
});

// PATCH /api/state/map-view — set map pan/zoom viewport
// Body: { scale: number|null, panX: number|null, panY: number|null }
app.patch('/api/state/map-view', (req, res) => {
    const { scale, panX, panY } = req.body || {};
    res.json({
        ok: true,
        state: writeStateAndBroadcast({ mapView: { scale, panX, panY } })
    });
});

// POST /api/state/dismissed — mark a waypoint as manually dismissed
// Body: { type: 'korok'|'location', name: string }
app.post('/api/state/dismissed', (req, res) => {
    const { type, name } = req.body || {};
    if ((type !== 'korok' && type !== 'location') || typeof name !== 'string') {
        res.status(400).json({
            ok: false,
            error: 'Body must include type ("korok"|"location") and name (string)'
        });
        return;
    }
    const state = readState();
    const key = type === 'korok' ? 'koroks' : 'locations';
    const list = new Set(state.dismissedWaypoints[key]);
    list.add(name);
    res.json({
        ok: true,
        state: writeStateAndBroadcast({
            dismissedWaypoints: {
                ...state.dismissedWaypoints,
                [key]: Array.from(list)
            }
        })
    });
});

// DELETE /api/state/dismissed — restore a dismissed waypoint
// Body: { type: 'korok'|'location', name: string }
app.delete('/api/state/dismissed', (req, res) => {
    const { type, name } = req.body || {};
    if ((type !== 'korok' && type !== 'location') || typeof name !== 'string') {
        res.status(400).json({
            ok: false,
            error: 'Body must include type ("korok"|"location") and name (string)'
        });
        return;
    }
    const state = readState();
    const key = type === 'korok' ? 'koroks' : 'locations';
    const list = new Set(state.dismissedWaypoints[key]);
    list.delete(name);
    res.json({
        ok: true,
        state: writeStateAndBroadcast({
            dismissedWaypoints: {
                ...state.dismissedWaypoints,
                [key]: Array.from(list)
            }
        })
    });
});

// DELETE /api/state/dismissed/all — clear all dismissed waypoints
// Called when save file mtime changes (new game state supersedes UI overlay)
app.delete('/api/state/dismissed/all', (req, res) => {
    res.json({
        ok: true,
        state: writeStateAndBroadcast({
            dismissedWaypoints: { koroks: [], locations: [] }
        })
    });
});

// ── Debug endpoint ────────────────────────────────────────────────────────────

// Parse map-locations.js to extract hash → internal_name tables for each category
function loadMapHashes() {
    const content = fs.readFileSync(
        path.join(STATIC_ROOT, 'assets/js/map-locations.js'),
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
        shrineCompletions: extractSection('shrineCompletions'),
        divineBeastCompletions: extractSection('divineBeastCompletions')
    };
}

// Cache map hashes at startup — map-locations.js never changes at runtime.
// Non-fatal: if assets aren't present (e.g. bare exe without extracted zip)
// the server still starts; only the /api debug endpoint will be unavailable.
let cachedMapHashes;
try {
    cachedMapHashes = loadMapHashes();
} catch {
    cachedMapHashes = null;
}

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
        if (!cachedMapHashes) throw new Error('map-locations.js not loaded');
        const map = cachedMapHashes;
        metrics.locations = scanFlags(buf, r.u32, map.locations);
        metrics.locations.total = 226; // hardcoded per game sources (matches sidebar)
        metrics.shrines_discovered = scanFlags(buf, r.u32, map.shrines);
        metrics.shrines_completed = scanFlags(
            buf,
            r.u32,
            map.shrineCompletions
        );
        metrics.shrines_not_activated = {
            found:
                metrics.shrines_discovered.total -
                metrics.shrines_discovered.found,
            total: metrics.shrines_discovered.total
        };
        metrics.towers = scanFlags(buf, r.u32, map.towers);
        const _dbDiscovered = scanFlags(buf, r.u32, map.divineBeasts);
        const _dbCompleted = scanFlags(buf, r.u32, map.divineBeastCompletions);
        metrics.divine_beasts_incomplete = {
            found: _dbDiscovered.total - _dbCompleted.found,
            total: _dbDiscovered.total
        };
        metrics.divine_beasts_completed = {
            found: _dbCompleted.found,
            total: _dbDiscovered.total
        };
        metrics.koroks_discovered = scanFlags(buf, r.u32, map.koroks);
    } catch (e) {
        metrics.location_scan_error = e.message;
    }

    return metrics;
}

// GET /openapi.json — OpenAPI 3.0 API discovery document
app.get('/openapi.json', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({
        openapi: '3.0.3',
        info: {
            title: 'BotW Live Savegame Monitor',
            version: '1.6.5',
            description:
                'API for the BotW Unexplored Area Viewer — reads Cemu/Switch save files and manages UI state.'
        },
        paths: {
            '/data/game_data.sav': {
                get: {
                    summary: 'Download the most recently modified save file',
                    responses: {
                        200: {
                            description: 'Raw binary save file',
                            content: { 'application/octet-stream': {} }
                        },
                        404: { description: 'No save file found' }
                    }
                }
            },
            '/api/mtime': {
                get: {
                    summary: 'Return save file mtime and state version',
                    responses: {
                        200: {
                            description: 'OK',
                            content: {
                                'application/json': {
                                    schema: {
                                        type: 'object',
                                        properties: {
                                            mtime: { type: 'number' },
                                            stateVersion: { type: 'integer' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            '/api/version': {
                get: {
                    summary: 'Return the app version',
                    responses: {
                        200: {
                            description: 'OK',
                            content: {
                                'application/json': {
                                    schema: {
                                        type: 'object',
                                        properties: {
                                            ok: { type: 'boolean' },
                                            version: { type: 'string' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            '/api/events': {
                get: {
                    summary:
                        'SSE stream — pushes state-change and reload-save events',
                    responses: {
                        200: {
                            description: 'text/event-stream',
                            content: { 'text/event-stream': {} }
                        }
                    }
                }
            },
            '/api/state': {
                get: {
                    summary: 'Return full UI state',
                    responses: { 200: { description: 'OK' } }
                },
                put: {
                    summary: 'Replace full UI state',
                    responses: { 200: { description: 'OK' } }
                }
            },
            '/api/state/hidden-types': {
                patch: {
                    summary: 'Toggle icon type visibility',
                    requestBody: {
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        type: { type: 'string' },
                                        hidden: { type: 'boolean' }
                                    },
                                    required: ['type', 'hidden']
                                }
                            }
                        }
                    },
                    responses: {
                        200: { description: 'OK' },
                        400: { description: 'Bad request' }
                    }
                }
            },
            '/api/state/hidden-services': {
                patch: {
                    summary: 'Toggle service filter visibility',
                    requestBody: {
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        service: { type: 'string' },
                                        hidden: { type: 'boolean' }
                                    },
                                    required: ['service', 'hidden']
                                }
                            }
                        }
                    },
                    responses: {
                        200: { description: 'OK' },
                        400: { description: 'Bad request' }
                    }
                }
            },
            '/api/state/test-mode': {
                patch: {
                    summary: 'Show or hide the testing banner',
                    requestBody: {
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        enabled: { type: 'boolean' },
                                        phase: { type: 'string' }
                                    },
                                    required: ['enabled']
                                }
                            }
                        }
                    },
                    responses: {
                        200: { description: 'OK' },
                        400: { description: 'Bad request' }
                    }
                }
            },
            '/api/state/player-position': {
                patch: {
                    summary: 'Override player position (BotW world coords)',
                    requestBody: {
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        x: { type: 'number' },
                                        z: { type: 'number' }
                                    },
                                    required: ['x', 'z']
                                }
                            }
                        }
                    },
                    responses: {
                        200: { description: 'OK' },
                        400: { description: 'Bad request' }
                    }
                },
                delete: {
                    summary: 'Clear player position override',
                    responses: { 200: { description: 'OK' } }
                }
            },
            '/api/state/stat-overrides': {
                put: {
                    summary: 'Override stat display values for testing',
                    requestBody: {
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        koroks: { type: 'number' },
                                        locations: { type: 'number' },
                                        shrines: { type: 'number' },
                                        shrinesCompleted: { type: 'number' },
                                        shrinesNotActivated: { type: 'number' },
                                        towers: { type: 'number' },
                                        divineBeasts: { type: 'number' },
                                        divineBeatsCompleted: { type: 'number' }
                                    }
                                }
                            }
                        }
                    },
                    responses: { 200: { description: 'OK' } }
                },
                delete: {
                    summary: 'Clear stat overrides',
                    responses: { 200: { description: 'OK' } }
                }
            },
            '/api/state/player-stat-overrides': {
                put: {
                    summary: 'Override player stat display values for testing',
                    requestBody: {
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        hearts: { type: 'number' },
                                        stamina: { type: 'number' },
                                        playtime: { type: 'number' },
                                        rupees: { type: 'number' },
                                        motorcycle: { type: 'number' }
                                    }
                                }
                            }
                        }
                    },
                    responses: { 200: { description: 'OK' } }
                },
                delete: {
                    summary: 'Clear player stat overrides',
                    responses: { 200: { description: 'OK' } }
                }
            },
            '/api/state/server-status-override': {
                put: {
                    summary: 'Override server status dot and timestamp display',
                    requestBody: {
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        timestamp: { type: 'number' },
                                        online: { type: 'boolean' }
                                    }
                                }
                            }
                        }
                    },
                    responses: { 200: { description: 'OK' } }
                },
                delete: {
                    summary: 'Clear server status override',
                    responses: { 200: { description: 'OK' } }
                }
            },
            '/api/state/track-player': {
                patch: {
                    summary: 'Enable or disable player position tracking',
                    requestBody: {
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        enabled: { type: 'boolean' }
                                    },
                                    required: ['enabled']
                                }
                            }
                        }
                    },
                    responses: {
                        200: { description: 'OK' },
                        400: { description: 'Bad request' }
                    }
                }
            },
            '/api/state/track-zoom': {
                patch: {
                    summary: 'Set player tracking zoom level (5–90)',
                    requestBody: {
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        zoom: {
                                            type: 'number',
                                            minimum: 5,
                                            maximum: 90
                                        }
                                    },
                                    required: ['zoom']
                                }
                            }
                        }
                    },
                    responses: {
                        200: { description: 'OK' },
                        400: { description: 'Bad request' }
                    }
                }
            },
            '/api/state/map-view': {
                patch: {
                    summary: 'Set map pan/zoom viewport',
                    requestBody: {
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        scale: {
                                            type: 'number',
                                            nullable: true
                                        },
                                        panX: {
                                            type: 'number',
                                            nullable: true
                                        },
                                        panY: { type: 'number', nullable: true }
                                    }
                                }
                            }
                        }
                    },
                    responses: { 200: { description: 'OK' } }
                }
            },
            '/api/state/dismissed': {
                post: {
                    summary: 'Mark a waypoint as manually dismissed',
                    requestBody: {
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        type: {
                                            type: 'string',
                                            enum: ['korok', 'location']
                                        },
                                        name: { type: 'string' }
                                    },
                                    required: ['type', 'name']
                                }
                            }
                        }
                    },
                    responses: {
                        200: { description: 'OK' },
                        400: { description: 'Bad request' }
                    }
                },
                delete: {
                    summary: 'Restore a dismissed waypoint',
                    requestBody: {
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        type: {
                                            type: 'string',
                                            enum: ['korok', 'location']
                                        },
                                        name: { type: 'string' }
                                    },
                                    required: ['type', 'name']
                                }
                            }
                        }
                    },
                    responses: {
                        200: { description: 'OK' },
                        400: { description: 'Bad request' }
                    }
                }
            },
            '/api/state/dismissed/all': {
                delete: {
                    summary: 'Clear all dismissed waypoints',
                    responses: { 200: { description: 'OK' } }
                }
            },
            '/api': {
                get: {
                    summary: 'Debug — parse save file and return raw metrics',
                    responses: {
                        200: { description: 'Parsed save metrics' },
                        404: { description: 'No save file found' }
                    }
                }
            },
            '/api/test/run': {
                post: {
                    summary: 'Run the full server-side UI test suite (~30s)',
                    responses: {
                        200: { description: 'Test results' },
                        409: { description: 'Test already running' },
                        500: { description: 'Test error' }
                    }
                }
            }
        }
    });
});

app.get('/api', (req, res) => {
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
app.post('/api/test/run', async (req, res) => {
    if (_testRunning) {
        res.status(409).json({ ok: false, error: 'Test already running' });
        return;
    }
    _testRunning = true;
    try {
        const { runTest } = require('./test');
        const results = await runTest({
            writeStateAndBroadcast,
            readState,
            broadcastReloadSave,
            hasBrowserClients
        });
        res.json({ ok: true, results });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    } finally {
        _testRunning = false;
    }
});

/**
 * startServer(port, savePath) — create and start a new http.Server instance.
 * Returns Promise<{ httpServer, watcher: null }>.
 * Each call is independent; caller must close the previous httpServer before calling again.
 * watcher is always null (no fs.watch in this server; included for interface consistency).
 */
function startServer(port, savePath) {
    _savePathBase = savePath;
    return new Promise((resolve, reject) => {
        const httpServer = app.listen(port, '0.0.0.0');
        httpServer.once('listening', () =>
            resolve({ httpServer, watcher: null })
        );
        httpServer.once('error', reject);
    });
}

/** Close all open SSE connections immediately. Call before httpServer.close(). */
function drainSseClients() {
    sseClients.forEach((client) => {
        try {
            client.end();
        } catch {
            /* ignore */
        }
    });
    sseClients.clear();
}

/** Returns true if at least one browser SSE client is currently connected. */
function hasBrowserClients() {
    return sseClients.size > 0;
}

// Export app for Supertest integration tests
if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}

module.exports = { app, startServer, drainSseClients, hasBrowserClients, registerReconfigureHandler };
