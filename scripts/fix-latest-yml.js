'use strict';
// Post-build script: regenerate latest.yml to reference the portable exe.
// electron-builder only writes latest.yml for NSIS targets, so after a combined
// NSIS+portable build the manifest points at the Setup exe. This script fixes it.
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const distDir = path.join(__dirname, '..', 'dist');

// Find the portable exe: an .exe in dist/ that is NOT a Setup exe
const exes = fs.readdirSync(distDir).filter(
    (f) => f.endsWith('.exe') && !f.includes('Setup')
);
if (exes.length === 0) {
    console.error('fix-latest-yml: no portable exe found in dist/');
    process.exit(1);
}
if (exes.length > 1) {
    console.warn('fix-latest-yml: multiple portable exes found, using first:', exes[0]);
}

const exeName = exes[0];
const exePath = path.join(distDir, exeName);
const buf     = fs.readFileSync(exePath);
const sha512  = crypto.createHash('sha512').update(buf).digest('base64');
const size    = buf.length;
const urlName = exeName.replace(/ /g, '-');

const yaml = [
    `version: ${exeName.match(/(\d+\.\d+\.\d+)/)[1]}`,
    `files:`,
    `  - url: ${urlName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${urlName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
].join('\n');

fs.writeFileSync(path.join(distDir, 'latest.yml'), yaml, 'utf8');
console.log(`fix-latest-yml: latest.yml updated -> ${urlName} (${(size / 1024 / 1024).toFixed(1)} MB)`);
