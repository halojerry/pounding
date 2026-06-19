#!/usr/bin/env node
/**
 * Patch node_modules/electron/index.js to return the real Electron API
 * (app, BrowserWindow, etc.) when require('electron') is called inside
 * an Electron main process.
 *
 * Electron v34+ ships a simplified index.js that only returns the path
 * to the Electron binary. This breaks electron-vite (and any bundler
 * that externalizes 'electron' as require('electron')).
 *
 * The fix: when running inside Electron, load the built-in module from
 * electron/js2c/browser_init instead of returning the path string.
 *
 * Usage: node scripts/patch-electron.cjs
 */

const fs = require('fs');
const path = require('path');

const electronIndex = path.resolve(__dirname, '..', 'node_modules', 'electron', 'index.js');
if (!fs.existsSync(electronIndex)) {
  console.log('[patch-electron] node_modules/electron/index.js not found, skipping');
  process.exit(0);
}

const original = fs.readFileSync(electronIndex, 'utf-8');

if (original.includes('POUNDING PATCH')) {
  console.log('[patch-electron] Already patched, skipping');
  process.exit(0);
}

const patched = `// POUNDING PATCH: resolve to built-in Electron API at runtime
const fs = require('fs');
const path = require('path');

const pathFile = path.join(__dirname, 'path.txt');

function getElectronPath () {
  let executablePath;
  if (fs.existsSync(pathFile)) {
    executablePath = fs.readFileSync(pathFile, 'utf-8');
  }
  if (process.env.ELECTRON_OVERRIDE_DIST_PATH) {
    return path.join(process.env.ELECTRON_OVERRIDE_DIST_PATH, executablePath || 'electron');
  }
  if (executablePath) {
    return path.join(__dirname, 'dist', executablePath);
  } else {
    throw new Error('Electron failed to install correctly, please delete node_modules/electron and try installing again');
  }
}

// When running inside an Electron process, load the built-in electron module
// from electron/js2c/browser_init (bundled inside the Electron binary).
// The npm electron package only returns the binary path string.
if (typeof process.versions.electron === 'string') {
  try {
    // Delete ourselves from cache so this require() finds the built-in
    const Module = require('module');
    const selfKey = path.join(__dirname, 'index.js');
    delete Module._cache[selfKey];
    // Load the real Electron API from the built-in module (bundled in the binary)
    module.exports = require('electron/js2c/browser_init');
  } catch (_) {
    // Fall through to path string if built-in not available
    module.exports = getElectronPath();
  }
} else {
  module.exports = getElectronPath();
}
`;

fs.writeFileSync(electronIndex, patched, 'utf-8');
console.log('[patch-electron] Patched node_modules/electron/index.js');
