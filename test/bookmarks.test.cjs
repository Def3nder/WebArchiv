const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createBookmarkStore, installBookmarkRoutes } = require('../bookmarks.cjs');

async function tempFile(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webarchiv-bookmarks-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'bookmarks.json');
}

test('Lesezeichen setzen, lesen, löschen und nach Neustart wieder laden', async t => {
  const file = await tempFile(t);
  const store = createBookmarkStore({ file });
  store.load();
  await store.add('A@b.de', 'Joe Turan/2026/artikel');
  await store.add('a@b.de', 'Telegram/2026/post');
  await store.add('a@b.de', 'Joe Turan/2026/artikel'); // doppelt: bleibt ein Eintrag
  assert.deepEqual([...store.idsFor('a@B.de')].sort(), ['Joe Turan/2026/artikel', 'Telegram/2026/post']);
  assert.equal(store.has('a@b.de', 'Telegram/2026/post'), true);
  assert.equal(store.has('andere@b.de', 'Telegram/2026/post'), false);

  await store.remove('a@b.de', 'Telegram/2026/post');
  const reloaded = createBookmarkStore({ file });
  reloaded.load();
  assert.deepEqual([...reloaded.idsFor('a@b.de')], ['Joe Turan/2026/artikel']);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('Gäste haben keine Lesezeichen; Nutzer löschen entfernt seine Einträge', async t => {
  const store = createBookmarkStore({ file: await tempFile(t) });
  store.load();
  assert.equal(store.idsFor(null).size, 0);
  await assert.rejects(store.add(null, 'x'), { status: 401 });
  await store.add('a@b.de', 'x');
  await store.add('c@d.de', 'x');
  await store.remove('a@b.de', 'x');
  assert.equal(store.idsFor('a@b.de').size, 0);
  await store.removeUser('C@d.de');
  assert.equal(store.idsFor('c@d.de').size, 0);
});

async function server(t, store, sessionUser) {
  const articles = new Map([
    ['Joe Turan/2026/a b', { id: 'Joe Turan/2026/a b', author: 'Joe Turan' }],
    ['Privat/2026/geheim', { id: 'Privat/2026/geheim', author: 'Privat' }],
  ]);
  const app = express();
  app.use((req, _res, next) => { req.session = { user: sessionUser }; next(); });
  installBookmarkRoutes(app, {
    store,
    requireAuth: (req, res, next) => (req.session.user ? next() : res.status(401).json({ error: 'Not authenticated' })),
    getArticle: id => articles.get(id),
    canAccessAuthor: (user, author) => user.allowedAuthors === null || user.allowedAuthors.includes(author),
  });
  const listener = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => listener.close());
  const base = `http://127.0.0.1:${listener.address().port}/api/bookmarks/`;
  return (id, method, headers = {}) => fetch(base + id.split('/').map(encodeURIComponent).join('/'), { method, headers });
}

test('Routen: setzen und löschen mit Rechteprüfung', async t => {
  const store = createBookmarkStore({ file: await tempFile(t) });
  store.load();
  const user = { email: 'a@b.de', role: 'user', allowedAuthors: ['Joe Turan'] };
  const call = await server(t, store, user);

  let r = await call('Joe Turan/2026/a b', 'PUT');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { id: 'Joe Turan/2026/a b', bookmarked: true });
  assert.equal(store.has('a@b.de', 'Joe Turan/2026/a b'), true);

  // Fremder Autor und unbekannter Artikel: wie „nicht gefunden“.
  assert.equal((await call('Privat/2026/geheim', 'PUT')).status, 404);
  assert.equal((await call('Joe Turan/2026/gibt-es-nicht', 'PUT')).status, 404);
  // Cross-Site-Schreibanfragen werden abgewiesen.
  assert.equal((await call('Joe Turan/2026/a b', 'DELETE', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(store.has('a@b.de', 'Joe Turan/2026/a b'), true);

  r = await call('Joe Turan/2026/a b', 'DELETE');
  assert.equal(r.status, 200);
  assert.equal(store.has('a@b.de', 'Joe Turan/2026/a b'), false);
  // Verwaiste Einträge lassen sich ebenfalls löschen.
  assert.equal((await call('Joe Turan/2026/gibt-es-nicht', 'DELETE')).status, 200);
});

test('Routen: ohne Anmeldung 401', async t => {
  const store = createBookmarkStore({ file: await tempFile(t) });
  store.load();
  const call = await server(t, store, null);
  assert.equal((await call('Joe Turan/2026/a b', 'PUT')).status, 401);
  assert.equal((await call('Joe Turan/2026/a b', 'DELETE')).status, 401);
});
