const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = __dirname;
const SETTINGS_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'settings.js'), 'utf8');

function loadSettings(initialStorage = {}) {
  const storage = new Map(Object.entries(initialStorage));
  const form = { addEventListener() {}, querySelector() { return null; } };
  const dialog = {
    open: false,
    addEventListener() {},
    showModal() { this.open = true; },
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

test('Dialog, CSS und Filterleiste verwenden die neue Einstellung', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

  assert.match(html, /Filter-Beschriftungen/);
  assert.match(html, /name="filterLabels" value="auto"/);
  assert.match(html, /name="filterLabels" value="hidden"/);
  assert.match(css, /body\[data-filter-labels="hidden"\] \.filter-label/);
  assert.match(app, /document\.body\.dataset\.filterLabels === 'hidden'/);
  assert.match(app, /setDisplayUser\(user\)/);
});
