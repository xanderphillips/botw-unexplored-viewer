// scripts/analyze-save.js
// Usage: node scripts/analyze-save.js <path-to-save.sav>
'use strict';
const fs = require('fs');
const path = require('path');

const savePath = process.argv[2];
if (!savePath) { console.error('Usage: node analyze-save.js <path>'); process.exit(1); }

const buf = fs.readFileSync(savePath);
const size = buf.length;

// Read header and sentinel in both endiannesses
function peek(le) {
    return {
        endian: le ? 'LE' : 'BE',
        header: buf[le ? 'readUInt32LE' : 'readUInt32BE'](0).toString(16).padStart(8, '0'),
        sentinel: buf[le ? 'readUInt32LE' : 'readUInt32BE'](4).toString(16).padStart(8, '0'),
        byte8: buf[le ? 'readUInt32LE' : 'readUInt32BE'](8).toString(16).padStart(8, '0'),
    };
}

// Known vanilla headers (from zelda-botw.js Constants.HEADER)
const KNOWN_HEADERS = new Set([
    '000024e2','000024ee','00002588','000029c0','00002a46','00002f8e',
    '00003ef8','00003ef9','0000471a','0000471b','0000471e',
    '000f423d','000f423e','000f423f','00004730'
]);

// Scan hash table (offset 0x0c, stride 8) for a specific hash
function findHash(hash32) {
    for (let i = 0x0c; i < size - 4; i += 8) {
        if (buf.readUInt32BE(i) === hash32) return { found: true, offset: `0x${i.toString(16)}`, valueBE: buf.readUInt32BE(i+4).toString(16) };
    }
    return { found: false };
}
function findHashLE(hash32) {
    for (let i = 0x0c; i < size - 4; i += 8) {
        if (buf.readUInt32LE(i) === hash32) return { found: true, offset: `0x${i.toString(16)}`, valueLE: buf.readUInt32LE(i+4).toString(16) };
    }
    return { found: false };
}

const beInfo = peek(false);
const leInfo = peek(true);
const headerKnownBE = KNOWN_HEADERS.has(beInfo.header);
const headerKnownLE = KNOWN_HEADERS.has(leInfo.header);

// Hash probes
const KOROK_HASH   = 0x8a94e07a;
const PLAYER_HASH  = 0xa40ba103;
const MAP_HASH     = 0x0bee9e46;

const result = {
    file: path.basename(savePath),
    size_bytes: size,
    size_hex: `0x${size.toString(16)}`,
    known_size_range: size >= 896976 && size <= 1500000,
    be: beInfo,
    le: leInfo,
    header_known_BE: headerKnownBE,
    header_known_LE: headerKnownLE,
    sentinel_ok_BE: beInfo.sentinel === 'ffffffff',
    sentinel_ok_LE: leInfo.sentinel === 'ffffffff',
    first_32_bytes_hex: buf.slice(0, 32).toString('hex'),
    hash_scan_BE: {
        KOROK_SEED_COUNTER: findHash(KOROK_HASH),
        PLAYER_POSITION:    findHash(PLAYER_HASH),
        MAP_STRING:         findHash(MAP_HASH),
    },
    hash_scan_LE: {
        KOROK_SEED_COUNTER: findHashLE(KOROK_HASH),
        PLAYER_POSITION:    findHashLE(PLAYER_HASH),
        MAP_STRING:         findHashLE(MAP_HASH),
    },
};

console.log(JSON.stringify(result, null, 2));
