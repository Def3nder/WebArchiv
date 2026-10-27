const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readStyles = require('./support/read-styles.cjs');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const CSS = readStyles();
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const ARIA = fs.readFileSync(path.join(ROOT, 'public', 'aria-menu.js'), 'utf8');

test('Alle Desktop-Auswahlfilter verwenden das vorhandene Aktionsmenü', () => {
  for (const id of ['filter-author', 'filter-year', 'filter-category', 'filter-book-sort', 'filter-limit']) {
    assert.match(HTML, new RegExp(`class="header-menu filter-header-menu" data-filter-aria-menu="${id}"[\\s\\S]*?class="header-menu-dropdown" role="menu"`));
  }
  assert.match(HTML, /class="filter-select filter-menu-trigger" aria-haspopup="menu" aria-expanded="false"/);
  assert.match(ARIA, /item\.className = 'header-menu-item'/);
  assert.match(ARIA, /item\.setAttribute\('role', 'menuitemradio'\)/);
  assert.match(ARIA, /item\.setAttribute\('aria-checked', String\(option\.value === select\.value\)\)/);
  assert.match(APP, /WebArchivAriaMenu\.bindSelect\(document\.getElementById\(root\.dataset\.filterAriaMenu\), root\)/);
  assert.match(HTML, /<script src="aria-menu\.js(?:\?v=[a-f0-9]+)?"><\/script>[\s\S]*<script src="app\.js/);
});

test('Aktionsmenü-Stil liefert Rundungen und Schatten, während Mobilgeräte native Selects behalten', () => {
  const actionMenuRule = CSS.match(/^\.header-menu-dropdown\s*\{([^}]+)\}/m)?.[1] || '';
  assert.match(actionMenuRule, /border-radius:\s*var\(--radius\)/);
  assert.match(actionMenuRule, /box-shadow:/);
  assert.match(CSS, /@media \(min-width: 601px\) and \(hover: hover\) and \(pointer: fine\)[\s\S]*?filter-menu-native \{ display: none; \}[\s\S]*?filter-header-menu \{ display: inline-flex; \}/);
  assert.match(CSS, /\.header-menu\.filter-header-menu \{ display: none; \}/);
  assert.doesNotMatch(HTML, /filter-menus\.js/);
});

test('Filter-Popups und ihre Auslöser verschwenden keinen horizontalen Platz', () => {
  assert.match(CSS, /\.filter-menu-trigger \{[\s\S]*?width: fit-content;/);
  assert.doesNotMatch(CSS, /\[data-filter-aria-menu="(?:filter-author|filter-year|filter-category|filter-book-sort)"\] \.filter-menu-trigger \{ width:/);
  assert.match(CSS, /\.filter-header-menu \.header-menu-dropdown \{[\s\S]*?width: max-content;[\s\S]*?min-width: 0;/);
  assert.match(CSS, /\[data-filter-aria-menu="filter-limit"\] \.header-menu-dropdown \{[\s\S]*?width: 100%;[\s\S]*?min-width: 100%;[\s\S]*?max-width: 100%;/);
});

test('Filtermenüs unterstützen Auswahl, Tastatur, Escape und Klick außerhalb', () => {
  // Das Verhalten selbst prüft test/aria-menu.test.cjs; hier nur die Kopplung.
  assert.match(ARIA, /select\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\)/);
  assert.match(ARIA, /function keepInViewport\(menu, margin = VIEWPORT_MARGIN\)[\s\S]*?window\.innerWidth - margin/);
  assert.match(APP, /function closeFilterAriaMenu\(root, restoreFocus = false\)[\s\S]*?selectController\(select\)\?\.close\(\{ restoreFocus \}\)/);
  assert.match(APP, /\[\$filterAuthor, \$filterYear, \$filterCategory\]\.forEach\(syncFilterAriaMenu\)/);
});

test('Metadaten-Refresh übernimmt den aktuellen Filterzustand in Select und ARIA-Menü', () => {
  const loadMeta = APP.slice(
    APP.indexOf('async function loadMeta()'),
    APP.indexOf('function applySavedListState('),
  );
  assert.match(loadMeta, /applySavedFilterControls\(\);[\s\S]*?requestAnimationFrame\(updateFilterLabelLayout\)/);

  // Reindex ist eine Admin-Aufgabe und liegt in admin-tasks.js.
  const ADMIN = fs.readFileSync(path.join(ROOT, 'public', 'admin-tasks.js'), 'utf8');
  const reindex = ADMIN.slice(
    ADMIN.indexOf('async function runReindex()'),
    ADMIN.indexOf('function openScrapeModal('),
  );
  assert.match(reindex, /await loadMeta\(\);[\s\S]*?state\.page = 1;[\s\S]*?await loadArticles\(\)/);
});

test('Menüzeilen sind am Desktop kompakt, Touch behält größere Tippflächen', () => {
  const desktop = CSS.match(/@media \(hover: hover\) and \(pointer: fine\) \{\s*\.header-menu-item, \.copy-prompt-item \{([^}]+)\}/)?.[1] || '';
  assert.match(desktop, /padding: 5px 12px;/);
  assert.match(desktop, /line-height: 1\.45;/);
  // Grundregel (Touch) bleibt unverändert.
  assert.match(CSS, /^\.header-menu-item \{[\s\S]*?padding: 8px 12px;/m);
});

test('Layoutwechsel ganz oben verschiebt die Seite nicht', () => {
  const restore = APP.slice(APP.indexOf('async function restoreListPosition('), APP.indexOf('function captureDetailPosition('));
  assert.match(restore, /if \(\(position\.top \|\| 0\) <= 1\) \{\s*window\.scrollTo\(\{ top: 0, behavior: 'auto' \}\);\s*return;/);
  assert.ok(restore.indexOf('position.top || 0) <= 1') < restore.indexOf('window.scrollBy'), 'Prüfung vor dem Ausgleich');
});
