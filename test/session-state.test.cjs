const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sessionState = require('../public/session-state.js');

function storage() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    values,
  };
}

const user = { email: 'Ralf@Example.de', role: 'admin' };

test('Eine neue Seitengröße behält die erste gerade sichtbare Kachel im Sichtfeld', () => {
  assert.equal(sessionState.pageForLimitChange(2, 96, 24), 5);
  assert.equal(sessionState.pageForLimitChange(2, 96, 24, 30), 6);
  assert.equal(sessionState.pageForLimitChange(5, 24, 96, 12), 2);
  assert.equal(sessionState.pageForLimitChange(5, 24, 96), 2);
  assert.equal(sessionState.pageForLimitChange(3, 24, 48), 2);
  assert.equal(sessionState.pageForLimitChange(1, 96, 12), 1);
});

test('Der Limit-Handler sichert und restauriert die erste gerade sichtbare Kachel', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /const position = captureListPosition\(\)[\s\S]*?pageForLimitChange\([\s\S]*?position\.anchorIndex[\s\S]*?await loadArticles\(\)[\s\S]*?await restoreListPosition\(position\)/);
});

test('Sitzungsansicht wird pro Benutzer vollständig und normalisiert gespeichert', () => {
  const device = storage();
  assert.equal(sessionState.save(device, user, {
    list: {
      q: 'Liebe', author: 'Joe Turan', externalAudio: false, year: '2026', category: 'Beziehungen',
      telegram: true, bookmarks: true, page: 4, limit: 48, layout: 'list', bookSort: 'title',
      gridCardWidths: { square: 182.5, tall: 248 },
    },
    view: {
      kind: 'detail', itemId: 'Joe Turan/2026/artikel.md',
      listPosition: { authorScope: 'Joe Turan', anchorId: 'Joe Turan/2026/artikel.md', anchorIndex: 5, offset: 12, top: 900 },
      detailPosition: { top: 620, ratio: 0.42 },
    },
  }), true);

  const restored = sessionState.load(device, { email: 'ralf@example.de', role: 'user' });
  assert.equal(restored.list.page, 4);
  assert.equal(restored.list.layout, 'list');
  assert.deepEqual(restored.list.gridCardWidths, { square: 182.5, tall: 248 });
  assert.equal(restored.view.kind, 'detail');
  assert.equal(restored.view.listPosition.authorScope, 'Joe Turan');
  assert.equal(restored.view.detailPosition.ratio, 0.42);
  assert.equal(device.values.size, 1);
});

test('Ältere Listenpositionen werden beim Laden dem gespeicherten Autor zugeordnet', () => {
  const normalized = sessionState.normalize({
    version: 1,
    list: { author: 'Joe Turan', layout: 'tall' },
    view: { kind: 'list', listPosition: { top: 750 } },
  });
  assert.equal(normalized.view.listPosition.authorScope, 'Joe Turan');
});

test('Benutzer und Gast erhalten getrennte Speicherstände; Abmelden kann gezielt löschen', () => {
  const device = storage();
  sessionState.save(device, user, { list: { page: 3 }, view: { kind: 'list' } });
  sessionState.save(device, { role: 'guest' }, { list: { page: 1, author: 'Öffentlich' }, view: { kind: 'list' } });

  assert.equal(sessionState.load(device, user).list.page, 3);
  assert.equal(sessionState.load(device, { role: 'guest' }).list.author, 'Öffentlich');
  assert.equal(sessionState.clear(device, user), true);
  assert.equal(sessionState.load(device, user), null);
  assert.ok(sessionState.load(device, { role: 'guest' }));
});

test('Beschädigte, unbekannte und übergroße Werte fallen sicher auf Standardwerte zurück', () => {
  const device = storage();
  device.setItem(sessionState.storageKey(user), '{kaputt');
  assert.equal(sessionState.load(device, user), null);

  device.setItem(sessionState.storageKey(user), JSON.stringify({ version: 99 }));
  assert.equal(sessionState.load(device, user), null);

  const normalized = sessionState.normalize({
    version: 1,
    list: { page: -4, limit: 9999, layout: 'riesig', bookSort: 'falsch' },
    view: { kind: 'reader', itemId: '' },
  });
  assert.equal(normalized.list.page, 1);
  assert.equal(normalized.list.limit, 24);
  assert.equal(normalized.list.layout, 'tall');
  assert.deepEqual(normalized.list.gridCardWidths, { square: null, tall: null });
  assert.equal(normalized.view.kind, 'list');
});

test('Bevorzugte Kachelbreiten werden getrennt gespeichert und sicher begrenzt', () => {
  assert.deepEqual(sessionState.normalize({
    version: 1,
    list: { gridCardWidths: { square: 110, tall: 1920 } },
    view: { kind: 'list' },
  }).list.gridCardWidths, { square: 110, tall: 1920 });

  assert.deepEqual(sessionState.normalize({
    version: 1,
    list: { gridCardWidths: { square: 109, tall: 1921 } },
    view: { kind: 'list' },
  }).list.gridCardWidths, { square: null, tall: null });
});
