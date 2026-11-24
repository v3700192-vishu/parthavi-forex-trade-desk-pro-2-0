'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/manifest.webmanifest'), 'utf8'));
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const pwa = fs.readFileSync(path.join(root, 'public/pwa.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');

assert.equal(manifest.display, 'standalone');
assert.ok(manifest.icons.some(icon => icon.sizes === '192x192'));
assert.ok(manifest.icons.some(icon => icon.sizes === '512x512'));
for (const icon of manifest.icons) {
  const filePath = path.join(root, 'public', icon.src.replace(/^\.\//, ''));
  assert.ok(fs.existsSync(filePath), 'missing manifest icon: ' + icon.src);
}
assert.match(html, /id="installAppButton"/);
assert.match(html, /<link rel="manifest" href="\.\/manifest\.webmanifest">/);
assert.match(html, /<script src="\.\/pwa\.js" defer><\/script>/);
assert.match(pwa, /beforeinstallprompt/);
assert.match(pwa, /serviceWorker\.register/);
assert.match(sw, /self\.addEventListener\('fetch'/);
assert.match(sw, /Never cache live API data/);
assert.match(sw, /\/api\//);
console.log('PWA manifest, icons, install prompt and offline-shell tests passed.');
