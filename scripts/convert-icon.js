'use strict';
// scripts/convert-icon.js — build-time only: converts favicon.png → favicon.ico
const fs = require('fs');
const path = require('path');
const { default: pngToIco } = require('png-to-ico');

const src = path.join(__dirname, '..', 'favicon.png');
const out = path.join(__dirname, '..', 'favicon.ico');

pngToIco(src)
    .then((buf) => {
        fs.writeFileSync(out, buf);
        console.log('favicon.ico written (' + buf.length + ' bytes)');
    })
    .catch((e) => {
        console.error('Icon conversion failed:', e.message);
        process.exit(1);
    });
