'use strict';

// Known version hashes at offset 0 (from zelda-botw.js Constants.HEADER, both platforms)
const VALID_HEADERS = new Set([
    0x24e2, 0x24ee, 0x2588, 0x29c0, 0x2a46, 0x2f8e,
    0x3ef8, 0x3ef9, 0x471a, 0x471b, 0x471e,
    0x0f423d, 0x0f423e, 0x0f423f, 0x4730
]);

const MIN_SIZE = 896976;   // smallest known valid save slot
const MAX_SIZE = 1500000;  // modded ceiling from checkValidSavegame

/**
 * Lightweight save buffer validation — mirrors the format checks in
 * SavegameEditor.checkValidSavegame() (zelda-botw.js) without a full
 * hash scan. Checks file size range, known version hash, and sentinel.
 *
 * @param {Buffer} buf
 * @returns {{ valid: boolean, reason: string }}
 *   reason: 'ok' | 'file_too_small' | 'file_too_large' | 'invalid_header'
 */
function validateSaveBuffer(buf) {
    if (!buf || buf.length < 8) return { valid: false, reason: 'file_too_small' };
    if (buf.length < MIN_SIZE)  return { valid: false, reason: 'file_too_small' };
    if (buf.length > MAX_SIZE)  return { valid: false, reason: 'file_too_large' };

    // Try big-endian (Wii U), then little-endian (Switch)
    for (const le of [false, true]) {
        const header   = le ? buf.readUInt32LE(0) : buf.readUInt32BE(0);
        const sentinel = le ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
        if (VALID_HEADERS.has(header) && sentinel === 0xffffffff) {
            return { valid: true, reason: 'ok' };
        }
    }
    return { valid: false, reason: 'invalid_header' };
}

module.exports = { validateSaveBuffer };
