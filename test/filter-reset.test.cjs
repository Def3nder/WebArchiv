const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');

test('Reset erscheint nur bei einer aktiven Suche oder einem aktiven Filter', () => {
  assert.match(HTML, /id="reset-filters"[^>]*\shidden(?:\s|>)/);
  assert.match(APP, /function hasActiveListFilter\(\) \{[\s\S]*?state\.q[\s\S]*?state\.author[\s\S]*?state\.externalAudio[\s\S]*?state\.year[\s\S]*?state\.category[\s\S]*?state\.telegram[\s\S]*?state\.bookmarks[\s\S]*?\);\s*\}/);
  assert.match(APP, /\$resetFilters\.hidden = hidden/);
  assert.match(APP, /async function loadArticles\(\) \{\s*updateResetFiltersVisibility\(\);/);
  assert.match(APP, /state\.q = val;\s*updateResetFiltersVisibility\(\);/);
});

test('die persönliche Einstellung zum Ausblenden bleibt wirksam', () => {
  assert.match(CSS, /body\[data-reset-filters="hidden"\] #reset-filters \{ display: none; \}/);
  assert.match(HTML, /app\.js\?v=106/);
});
