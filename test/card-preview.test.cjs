const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('abgeschnittene Kachelvorschauen erhalten zuverlässig ein Auslassungszeichen', () => {
  assert.match(APP, /preview\.scrollHeight > preview\.clientHeight \+ 1/);
  assert.match(APP, /preview\.classList\.toggle\('is-truncated'/);
  assert.match(APP, /new ResizeObserver\(updateCardPreviewTruncation\)/);
  assert.match(APP, /applyGridColumns\(\);\s*watchCardPreviews\(\);/);
  assert.match(CSS, /\.card-preview\s*\{[^}]*position:\s*relative;[^}]*min-height:\s*0;/s);
  assert.match(CSS, /\.card-preview\.is-truncated::after\s*\{[^}]*content:\s*'…';[^}]*bottom:\s*0;/s);
});

test('geänderte Vorschau-Ressourcen werden ohne alten Browser-Cache geladen', () => {
  assert.match(HTML, /styles\.css\?v=124/);
  assert.match(HTML, /app\.js\?v=106/);
});
