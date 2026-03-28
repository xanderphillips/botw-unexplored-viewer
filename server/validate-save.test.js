// server/validate-save.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateSaveBuffer } = require('./validate-save.js');

// Helpers to build minimal test buffers
function makeMinBuf(size, headerBE, sentinelBE) {
    const buf = Buffer.alloc(size);
    buf.writeUInt32BE(headerBE, 0);
    buf.writeUInt32BE(sentinelBE, 4);
    return buf;
}
function makeMinBufLE(size, headerLE, sentinelLE) {
    const buf = Buffer.alloc(size);
    buf.writeUInt32LE(headerLE, 0);
    buf.writeUInt32LE(sentinelLE, 4);
    return buf;
}

const VALID_HEADER_BE = 0x471b;   // v1.3.1 / v1.5* Wii U
const VALID_HEADER_LE = 0x471b;   // same value, Switch
const SENTINEL        = 0xffffffff;
const VALID_SIZE      = 1027208;  // v1.6 Wii U

test('returns invalid for null input', () => {
    assert.deepEqual(validateSaveBuffer(null), { valid: false, reason: 'file_too_small' });
});

test('returns invalid for buffer under min size', () => {
    const buf = makeMinBuf(1000, VALID_HEADER_BE, SENTINEL);
    assert.deepEqual(validateSaveBuffer(buf), { valid: false, reason: 'file_too_small' });
});

test('returns invalid for buffer over max size', () => {
    const buf = makeMinBuf(1600000, VALID_HEADER_BE, SENTINEL);
    assert.deepEqual(validateSaveBuffer(buf), { valid: false, reason: 'file_too_large' });
});

test('returns invalid for unknown header (big-endian)', () => {
    const buf = makeMinBuf(VALID_SIZE, 0xdeadbeef, SENTINEL);
    assert.deepEqual(validateSaveBuffer(buf), { valid: false, reason: 'invalid_header' });
});

test('returns invalid when sentinel is wrong', () => {
    const buf = makeMinBuf(VALID_SIZE, VALID_HEADER_BE, 0x00000000);
    assert.deepEqual(validateSaveBuffer(buf), { valid: false, reason: 'invalid_header' });
});

test('returns valid for correct big-endian (Wii U) header', () => {
    const buf = makeMinBuf(VALID_SIZE, VALID_HEADER_BE, SENTINEL);
    assert.deepEqual(validateSaveBuffer(buf), { valid: true, reason: 'ok' });
});

test('returns valid for correct little-endian (Switch) header', () => {
    // On Switch the bytes are LE: header and sentinel written LE, read LE
    const buf = makeMinBufLE(VALID_SIZE, VALID_HEADER_LE, SENTINEL);
    assert.deepEqual(validateSaveBuffer(buf), { valid: true, reason: 'ok' });
});

test('returns valid for modded file within size window', () => {
    // modded files: MIN_SIZE <= size <= MAX_SIZE with valid header
    const buf = makeMinBuf(1200000, 0x3ef8, SENTINEL);
    assert.deepEqual(validateSaveBuffer(buf), { valid: true, reason: 'ok' });
});

test('returns valid for Waikuteru Randomizer save (0x471b header, 1022272 bytes)', () => {
    // Randomizer save analysed 2026-03-27: structurally valid Wii U v1.5 format,
    // 1022272 bytes (smaller than vanilla 1027208, within modded size window)
    const buf = makeMinBuf(1022272, 0x471b, SENTINEL);
    assert.deepEqual(validateSaveBuffer(buf), { valid: true, reason: 'ok' });
});
