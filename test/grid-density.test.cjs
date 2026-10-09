const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const gridDensity = require('../public/grid-density.js');

test('Browser-Script stellt die Berechnung vor app.js global bereit', () => {
  const context = { globalThis: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public', 'grid-density.js'), 'utf8'), context);
  assert.equal(typeof context.globalThis.WebArchivGridDensity?.columnsForCardWidth, 'function');
});

test('Das gesamte Raster reserviert Pinch-Gesten und lässt vertikales Scrollen zu', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  assert.match(css, /body:not\(\.layout-list\) \.article-grid\s*\{[^}]*touch-action:\s*pan-y;/s);
  assert.match(css, /\.article-grid\s*\{[^}]*overflow-anchor:\s*none;/s);
});

test('Kachel-Zoom verankert den Artikel unter Fingern oder Mauszeiger', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(app, /async function changeGridColumns\(step, scaleAnchor = null\)/);
  assert.match(app, /changeGridColumns\(ratio < 1 \? 1 : -1, scaleAnchor\)/);
  assert.match(app, /changeGridColumns\(step, captureListScaleAnchor\(event\.clientX, event\.clientY\)\)/);
  assert.match(app, /if \(!restoreListScaleAnchor\(scaleAnchor\)\) await restoreListPosition\(position\)/);
});

test('Drehen erhält ungefähr die Kachelbreite und erhöht die Spaltenzahl', () => {
  const portraitWidth = gridDensity.cardWidthForColumns(390, 8, 2);
  assert.equal(portraitWidth, 191);
  assert.equal(gridDensity.columnsForCardWidth(844, 8, portraitWidth), 4);
});

test('Die App merkt bereits die responsive Ausgangsbreite vor dem ersten Drehen', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(app, /preferredWidth = Math\.max\(GRID_MIN_CARD_WIDTH/);
  assert.match(app, /state\.gridCardWidths = \{ \.\.\.state\.gridCardWidths, \[layout\]: preferredWidth \}/);
});

test('Quadratische und längliche Präferenzen lassen sich unabhängig anwenden', () => {
  assert.equal(gridDensity.columnsForCardWidth(1000, 16, 180), 5);
  assert.equal(gridDensity.columnsForCardWidth(1000, 16, 300), 3);
});

test('Mindestbreite und maximale Spaltenzahl begrenzen das Raster', () => {
  assert.equal(gridDensity.maxColumns(320, 8), 2);
  assert.equal(gridDensity.columnsForCardWidth(320, 8, 40), 2);
  assert.equal(gridDensity.columnsForCardWidth(3000, 16, 110), 8);
});
