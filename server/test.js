'use strict';

/**
 * test.js — Server-side UI test runner for the BotW Unexplored Area Viewer
 *
 * Triggered via POST /api/test/run. Exercises all API-controllable UI state
 * in 5 phases, broadcasting each change via SSE so the browser updates in
 * real time. Returns a JSON results summary when complete.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TYPES = [
    'korok', 'location', 'location-discovered', 'shrine', 'shrine-completed',
    'tower', 'divine-beast', 'labo', 'warp', 'player-position'
];
const SVCS = [
    'hatago', 'village', 'settlement', 'great_fairy', 'goddess',
    'yadoya', 'shop_yorozu', 'shop_bougu', 'shop_jewel'
];

const FAST = 60;      // ms between rapid-fire steps
const SLOW = 2500;    // ms between quadrant moves
const ZOOM_STEP = 300; // ms between zoom steps
const BLINK = 300;    // ms between blink toggles

async function runTest({ writeStateAndBroadcast, readState, broadcastReloadSave }) {
    const checks = [];

    function check(label, pass) {
        checks.push({ label, pass });
        console.log(`  ${pass ? 'PASS' : 'FAIL'}: ${label}`);
    }

    function setPhase(phase) {
        writeStateAndBroadcast({ testMode: phase });
    }

    function setHiddenTypes(hidden) {
        writeStateAndBroadcast({ hiddenTypes: hidden });
    }

    function setHiddenServices(hidden) {
        writeStateAndBroadcast({ hiddenServices: hidden });
    }

    const pre = readState();

    // ── Phase 1: Sidebar Metrics ───────────────────────────────────────────────
    console.log('--- Phase 1: Sidebar Metrics ---');
    setPhase('Phase 1: Sidebar Metrics');

    // Ensure all enabled to start
    setHiddenTypes([]);
    setHiddenServices([]);

    // Roll disable first → last
    const hiddenTypes = [];
    for (const type of TYPES) {
        hiddenTypes.push(type);
        setHiddenTypes([...hiddenTypes]);
        await sleep(FAST);
    }
    // Roll enable last → first
    for (let i = TYPES.length - 1; i >= 0; i--) {
        hiddenTypes.splice(hiddenTypes.indexOf(TYPES[i]), 1);
        setHiddenTypes([...hiddenTypes]);
        await sleep(FAST);
    }
    check('all types visible', readState().hiddenTypes.length === 0);

    // Roll services disable first → last
    const hiddenSvcs = [];
    for (const svc of SVCS) {
        hiddenSvcs.push(svc);
        setHiddenServices([...hiddenSvcs]);
        await sleep(FAST);
    }
    // Roll services enable last → first
    for (let i = SVCS.length - 1; i >= 0; i--) {
        hiddenSvcs.splice(hiddenSvcs.indexOf(SVCS[i]), 1);
        setHiddenServices([...hiddenSvcs]);
        await sleep(FAST);
    }
    check('all services visible', readState().hiddenServices.length === 0);

    // ── Phase 2: Map Stats Sweep ───────────────────────────────────────────────
    console.log('--- Phase 2: Map Stats Sweep ---');
    setPhase('Phase 2: Map Stats Sweep');

    for (const step of [...Array(26).keys(), ...[...Array(26).keys()].reverse()]) {
        const pct = step / 25;
        writeStateAndBroadcast({ statOverrides: {
            koroks:              Math.round(pct * 900),
            locations:           Math.round(pct * 226),
            shrines:             Math.round(pct * 120),
            shrinesCompleted:    Math.round(pct * 120),
            shrinesNotActivated: Math.round((1 - pct) * 120),
            towers:              Math.round(pct * 15),
            divineBeasts:        Math.round(pct * 4)
        }});
        await sleep(FAST);
    }
    writeStateAndBroadcast({ statOverrides: null });
    check('map stats sweep complete', true);

    // ── Phase 3: Player Stats Sweep ───────────────────────────────────────────
    console.log('--- Phase 3: Player Stats Sweep ---');
    setPhase('Phase 3: Player Stats Sweep');

    for (const step of [...Array(26).keys(), ...[...Array(26).keys()].reverse()]) {
        const pct = step / 25;
        writeStateAndBroadcast({ playerStatOverrides: {
            hearts:   Math.round(pct * 30),
            stamina:  Math.round(pct * 30) / 10,
            playtime: Math.round(pct * 86400),
            rupees:   Math.round(pct * 1000000)
        }});
        await sleep(FAST);
    }
    for (let i = 0; i < 2; i++) {
        writeStateAndBroadcast({ playerStatOverrides: { motorcycle: true } });
        await sleep(BLINK);
        writeStateAndBroadcast({ playerStatOverrides: { motorcycle: false } });
        await sleep(BLINK);
    }
    writeStateAndBroadcast({ playerStatOverrides: null });
    check('player stats sweep complete', true);

    // ── Phase 4: Last Update / Server Status ──────────────────────────────────
    console.log('--- Phase 4: Last Update / Server Status ---');
    setPhase('Phase 4: Last Update');

    for (const step of [...Array(26).keys(), ...[...Array(26).keys()].reverse()]) {
        const pct = step / 25;
        const year   = 1900 + Math.round(pct * 100);
        const hour   = Math.round(pct * 23);
        const minute = Math.round(pct * 59);
        const ts = Date.UTC(year, 0, 1, hour, minute, 0);
        writeStateAndBroadcast({ serverStatusOverride: { timestamp: ts, online: true } });
        await sleep(FAST);
    }
    for (let i = 0; i < 2; i++) {
        writeStateAndBroadcast({ serverStatusOverride: { timestamp: Date.now(), online: true } });
        await sleep(BLINK);
        writeStateAndBroadcast({ serverStatusOverride: { timestamp: Date.now(), online: false } });
        await sleep(BLINK);
    }
    writeStateAndBroadcast({ serverStatusOverride: null });
    check('last update sweep complete', true);

    // ── Phase 5: Player Tracking ──────────────────────────────────────────────
    console.log('--- Phase 5: Player Tracking ---');
    setPhase('Phase 5: Player Tracking');

    const typesWithoutPlayer = readState().hiddenTypes.filter((t) => t !== 'player-position');
    writeStateAndBroadcast({ trackPlayer: true, hiddenTypes: typesWithoutPlayer });

    writeStateAndBroadcast({ playerPositionOverride: { x: 0, z: 0 } });
    await sleep(1000);

    for (const zoom of [5, 15, 30, 50, 70, 90, 70, 50, 30, 15]) {
        writeStateAndBroadcast({ trackZoom: zoom });
        await sleep(ZOOM_STEP);
    }

    for (const { name, x, z } of [
        { name: 'NW', x: -4500, z: -3000 },
        { name: 'NE', x:  4500, z: -3000 },
        { name: 'SE', x:  4500, z:  3000 },
        { name: 'SW', x: -4500, z:  3000 },
        { name: 'Center', x: 0, z: 0 }
    ]) {
        console.log(`  ${name}...`);
        writeStateAndBroadcast({ playerPositionOverride: { x, z } });
        await sleep(name === 'Center' ? 1000 : SLOW);
    }

    check('trackPlayer still enabled', readState().trackPlayer === true);
    writeStateAndBroadcast({ trackPlayer: false, playerPositionOverride: null });

    // ── Restore ───────────────────────────────────────────────────────────────
    console.log('--- Restoring pre-test state ---');
    setPhase('Restoring...');

    writeStateAndBroadcast({
        trackPlayer:          pre.trackPlayer,
        trackZoom:            pre.trackZoom,
        hiddenTypes:          pre.hiddenTypes || [],
        hiddenServices:       pre.hiddenServices || [],
        mapView:              { scale: null, panX: null, panY: null },
        dismissedWaypoints:   { koroks: [], locations: [] },
        playerPositionOverride: null,
        statOverrides:        null,
        playerStatOverrides:  null,
        serverStatusOverride: null,
        testMode:             ''
    });
    // Tell browsers to reload save file so stats revert to actual in-game values
    if (broadcastReloadSave) broadcastReloadSave();

    const passed = checks.filter((c) => c.pass).length;
    const failed = checks.filter((c) => !c.pass).length;
    console.log(`=== Test complete: ${passed} passed, ${failed} failed ===`);
    return { passed, failed, checks };
}

module.exports = { runTest };
