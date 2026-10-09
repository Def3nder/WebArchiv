const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SETTINGS_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'settings.js'), 'utf8');

function loadSettings(initialStorage = {}) {
  const storage = new Map(Object.entries(initialStorage));
  const form = { addEventListener() {}, querySelector() { return null; } };
  const dialog = {
    open: false,
    addEventListener() {},
    showModal() { this.open = true; },
    focus() { this.focused = true; },
    close() { this.open = false; },
    getBoundingClientRect() { return { left: 0, right: 0, top: 0, bottom: 0 }; },
  };
  const body = { dataset: {} };
  const context = {
    console,
    document: {
      body,
      getElementById(id) {
        if (id === 'settings-dialog') return dialog;
        if (id === 'settings-form') return form;
        if (id === 'reindex-btn') return { focus() {} };
        return null;
      },
    },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
    },
    requestAnimationFrame(callback) { callback(); return 1; },
    window: {
      matchMedia() { return { matches: false, addEventListener() {} }; },
    },
  };
  vm.createContext(context);
  vm.runInContext(SETTINGS_SOURCE, context, { filename: 'public/settings.js' });
  return { context, storage, body };
}

test('Filter-Beschriftungen werden lokal pro Nutzer getrennt gespeichert', () => {
  const { context, storage, body } = loadSettings();
  const ralf = { role: 'user', email: 'Ralf@Example.de' };
  const anna = { role: 'user', email: 'anna@example.de' };

  context.setDisplayUser(ralf);
  context.setDisplaySetting('filterLabels', 'hidden');
  assert.equal(body.dataset.filterLabels, 'hidden');
  assert.equal(storage.get('wa-filter-labels:ralf%40example.de'), 'hidden');

  context.setDisplayUser(anna);
  assert.equal(body.dataset.filterLabels, 'auto');

  context.setDisplayUser(ralf);
  assert.equal(body.dataset.filterLabels, 'hidden');
});

test('Gäste erhalten unabhängig vom gespeicherten Nutzerwert die Vorgabe', () => {
  const { context, body } = loadSettings({
    'wa-filter-labels:ralf%40example.de': 'hidden',
  });

  context.setDisplayUser({ role: 'user', email: 'ralf@example.de' });
  assert.equal(body.dataset.filterLabels, 'hidden');

  context.setDisplayUser({ role: 'guest' });
  assert.equal(body.dataset.filterLabels, 'auto');
});

test('Dialog verwendet Dropdowns und die neuen Sichtbarkeitseinstellungen', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

  assert.match(html, /Filter-Beschriftungen/);
  assert.match(html, /<select class="settings-select" name="filterLabels">/);
  assert.match(html, /name="cardCategories"/);
  assert.match(html, /name="resetFilters"/);
  assert.match(css, /body\[data-filter-labels="hidden"\] \.filter-label/);
  assert.match(css, /data-card-categories="hidden"/);
  assert.match(css, /data-reset-filters="hidden"/);
  assert.match(app, /document\.body\.dataset\.filterLabels === 'hidden'/);
  assert.match(app, /setDisplayUser\(user\)/);
});

test('Neue Installationen starten im hellen Farbschema', () => {
  const { body } = loadSettings();
  assert.equal(body.dataset.theme, 'light');
  assert.equal(body.dataset.cardCategories, 'visible');
  assert.equal(body.dataset.resetFilters, 'visible');
});

test('Der Einstellungsdialog fokussiert kein Dropdown automatisch', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(html, /id="settings-dialog"[^>]*tabindex="-1"/);
  assert.doesNotMatch(SETTINGS_SOURCE, /querySelector\('select'\)\?\.focus/);
  assert.match(SETTINGS_SOURCE, /\$settingsDialog\.focus/);
});

test('Listen-Zeilenhöhe lässt sich per Geste und Strg+Mausrad ändern', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(css, /--list-row-height/);
  assert.match(css, /body\.layout-list \.card\s*\{[^}]*height:\s*var\(--list-row-height[^}]*min-height:\s*0;/s);
  assert.match(css, /@media \(max-width: 600px\), \(hover: none\) and \(pointer: coarse\)/);
  assert.match(app, /changeListRowHeight/);
  assert.match(app, /LIST_ROW_BASE_HEIGHT = window\.matchMedia/);
  assert.doesNotMatch(app, /--list-mobile-row-height/);
  assert.doesNotMatch(css, /calc\([^)]*px\s*\*\s*var\(--list-row-scale/);
  assert.match(css, /card-image \{ flex: 0 0 var\(--list-row-height[^}]*height: var\(--list-row-height/);
  assert.match(css, /card-image \{ flex-basis: var\(--list-row-height[^}]*height: var\(--list-row-height/);
  assert.match(app, /gridTouchGesture\.layout === 'list'/);
  assert.match(app, /event\.ctrlKey/);
  assert.match(app, /LIST_ROW_SCALES = \[0\.7, 1, 1\.55, 2\.4\]/);
  assert.match(app, /currentIndex \+ Math\.sign\(step\)/);
  assert.match(app, /captureListScaleAnchor\(midpointX, midpointY\)/);
  assert.match(app, /rect\.top \+ rect\.height \* anchor\.ratio/);
  assert.match(app, /anchoredY - anchor\.viewportY/);
  assert.match(app, /function restoreListScaleAnchor\(anchor\)/);
  assert.doesNotMatch(app, /async function restoreListScaleAnchor/);
  assert.match(app, /if \(!restoreListScaleAnchor\(scaleAnchor\)\)/);
  assert.match(app, /window\.scrollBy\(\{ top: anchoredY - anchor\.viewportY, behavior: 'instant' \}\)/);
  assert.match(css, /\.article-grid\s*\{[^}]*overflow-anchor:\s*none;/s);
});

test('Die Listenansicht zeigt das Datum nach dem Autor', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(app, /class="author-badge"[\s\S]*class="card-date"/);
  assert.doesNotMatch(css, /body\.layout-list \.card-date,\s*body\.layout-list \.episode-num/);
});

test('Der Infografiken-Badge wird nur bei ausreichend breiten Handykacheln komprimiert', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  assert.match(css, /container:\s*article-card-body \/ inline-size/);
  assert.match(css, /@container article-card-body \(min-width: 132px\)/);
  assert.match(css, /card\[data-author="Infografiken"\] \.card-meta\s*\{[^}]*flex-wrap:\s*nowrap;/s);
  assert.match(css, /card\[data-author="Infografiken"\] \.author-badge\s*\{[^}]*font-size:\s*calc\(0\.65rem - 1px\);/s);
});
