'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { installDuplicateRoutes } = require('../modules/duplicate-admin.cjs');
const { createArchiveLock } = require('../lib/archive-lock.cjs');
const { createDuplicateStore } = require('../lib/duplicates.cjs');

// Kleines Archiv: ein Blogartikel, ein Quellartikel und dessen Infografik (Bild + Platzhalter).
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-admin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wwwDir = path.join(root, 'www');
  const write = (relative, content) => {
    const file = path.join(wwwDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const blog = {
    id: 'Blog/2026/2026-01-05_titel', author: 'Blog', year: '2026', date: '2026-01-05', title: 'Titel',
    filePath: write('Blog/2026/2026-01-05_titel.md', 'Titel\n\nDatum: 2026-01-05\n\n****\n\nText\n'),
    duplicateProfile: { hash: 'blog-hash' },
  };
  const facebook = {
    id: 'Facebook/2026/2026-01-04_post', author: 'Facebook', year: '2026', date: '2026-01-04', title: 'Post',
    filePath: write('Facebook/2026/2026-01-04_post.md', 'Post\n\nDatum: 2026-01-04\n\n****\n\nText\n'),
    duplicateProfile: { hash: 'facebook-hash' },
  };
  const infographic = {
    id: 'Infografiken/2026/2026-01-04_post', author: 'Infografiken', title: 'Post', ownImage: true, hasBody: false,
    imageUrl: '/files/Infografiken/2026/2026-01-04_post.png',
    filePath: write('Infografiken/2026/2026-01-04_post.md', 'Post\n\nDatum: 2026-01-04\n'),
  };
  write('Infografiken/2026/2026-01-04_post.png', 'PNG');
  const archive = {
    articleById: new Map([blog, facebook, infographic].map(item => [item.id, item])),
    infographicGroups: new Map([[facebook.id, [infographic]]]),
    duplicateCandidates: [{ blog, facebook, score: 0.97, exact: false, containment: 0.9, titleSimilarity: 1, days: 1, reasons: [] }],
  };
  const store = createDuplicateStore({ file: path.join(root, 'decisions.json') });
  store.load();
  const calls = { refreshState: 0, years: [], replacements: [] };
  return { root, wwwDir, blog, facebook, archive, store, calls };
}

async function start(t, data, { lock = createArchiveLock(), filesFor = null } = {}) {
  const app = express();
  app.use(express.json());
  const admin = (req, _res, next) => { req.session = { user: { email: 'admin@example.test', role: 'admin' } }; next(); };
  installDuplicateRoutes(app, {
    requireAdmin: admin, lock, archive: data.archive, wwwDir: data.wwwDir,
    store: data.store, config: { blogAuthor: 'Blog', facebookAuthors: ['Facebook'] },
    bookmarks: { replaceArticleIds: async replacements => { data.calls.replacements.push(...replacements); } },
    articleBodies: { get: async () => ({ bodyHtml: '<p>Text</p>', summary: '' }) },
    infographics: {
      conflictingBase: () => null,
      firstAvailableOrdinal: () => 1,
      filesFor: filesFor || (item => [item.filePath, item.filePath.replace(/\.md$/, '.png')]),
    },
    refreshInfographicsForYears: async years => { data.calls.years.push(...years); },
    refreshState: () => { data.calls.refreshState += 1; },
  });
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (url, body) => {
    const res = await fetch(base + url, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, cache: res.headers.get('cache-control'), data: await res.json() };
  };
}

test('Dubletten: Liste, Vergleich mit Migrationsplan, Ignorieren und Zurücksetzen', async t => {
  const data = fixture(t);
  const call = await start(t, data);
  const ids = { blogId: data.blog.id, facebookId: data.facebook.id };

  let res = await call('/api/duplicates');
  assert.equal(res.cache, 'no-store');
  assert.equal(res.data.pending.length, 1);
  assert.deepEqual([res.data.pending[0].facebook.infographicCount, res.data.pending[0].score], [1, 0.97]);

  res = await call(`/api/duplicates/compare?blogId=${encodeURIComponent(ids.blogId)}&facebookId=${encodeURIComponent(ids.facebookId)}`);
  assert.equal(res.status, 200);
  assert.equal(res.data.blog.bodyHtml, '<p>Text</p>');
  assert.deepEqual(res.data.migration, [{
    kind: 'infographic', target: 'Infografiken/2026/2026-01-05_titel_1', files: ['2026-01-05_titel_1.md', '2026-01-05_titel_1.png'],
  }]);
  assert.equal(res.data.migrationUnavailable, '');

  res = await call('/api/duplicates', { action: 'ignore', ...ids });
  assert.deepEqual([res.status, res.data], [200, { ok: true }]);
  assert.equal(data.store.find(ids.blogId, ids.facebookId).status, 'ignored');
  res = await call('/api/duplicates', { action: 'reset', ...ids });
  assert.equal(data.store.find(ids.blogId, ids.facebookId), null);
  assert.equal(data.calls.refreshState, 2);

  res = await call('/api/duplicates', { action: 'migrate', ...ids });
  assert.deepEqual([res.status, res.data], [409, { error: 'Grafiken können erst nach dem Verknüpfen migriert werden.' }]);
  res = await call('/api/duplicates', { action: 'quatsch', ...ids });
  assert.deepEqual([res.status, res.data], [400, { error: 'Unbekannte Dublettenaktion.' }]);
  res = await call('/api/duplicates', { action: 'link', blogId: 'fehlt', facebookId: ids.facebookId });
  assert.deepEqual([res.status, res.data], [404, { error: 'Einer der Artikel wurde nicht gefunden.' }]);
});

test('Dubletten: Verknüpfen mit Migration zieht Dateien um und liest nur den Jahrgang neu ein', async t => {
  const data = fixture(t);
  const call = await start(t, data);
  const res = await call('/api/duplicates', { action: 'link', blogId: data.blog.id, facebookId: data.facebook.id, migrateImages: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.migrations.map(item => item.to), [
    'Infografiken/2026/2026-01-05_titel_1.md', 'Infografiken/2026/2026-01-05_titel_1.png',
  ]);
  const target = path.join(data.wwwDir, 'Infografiken', '2026');
  assert.equal(fs.existsSync(path.join(target, '2026-01-04_post.png')), false);
  assert.equal(fs.readFileSync(path.join(target, '2026-01-05_titel_1.png'), 'utf8'), 'PNG');
  assert.match(fs.readFileSync(path.join(target, '2026-01-05_titel_1.md'), 'utf8'), /^Titel/);
  const decision = data.store.find(data.blog.id, data.facebook.id);
  assert.deepEqual([decision.status, decision.createdBy, decision.migrations.length], ['linked', 'admin@example.test', 2]);
  assert.deepEqual(data.calls.replacements, [{ oldId: data.facebook.id, newId: data.blog.id }]);
  assert.deepEqual(data.calls.years, ['2026']);
  assert.equal(data.calls.refreshState, 0);
});

test('Dubletten-Sammelaktion: Prüfung, Sperre (409) und Verknüpfen ohne Migration', async t => {
  const data = fixture(t);
  const lock = createArchiveLock();
  let tts = true;
  lock.register('Audio-Erzeugung', () => tts);
  const call = await start(t, data, { lock });
  const item = { blogId: data.blog.id, facebookId: data.facebook.id };

  let res = await call('/api/duplicates/batch', { items: [item] });
  assert.deepEqual([res.status, res.data], [409, { error: 'Es läuft bereits: Audio-Erzeugung. Bitte später erneut versuchen.' }]);
  res = await call('/api/duplicates', { action: 'ignore', ...item });
  assert.equal(res.status, 409, 'Einzelaktion wartet ebenfalls auf die Sperre');
  tts = false;

  res = await call('/api/duplicates/batch', { items: [] });
  assert.deepEqual([res.status, res.data], [400, { error: 'Bitte 1 bis 500 Dublettenpaare auswählen.' }]);
  res = await call('/api/duplicates/batch', { items: [item, item] });
  assert.deepEqual([res.status, res.data], [400, { error: 'Ein Quellartikel darf nur einmal in einer Sammelaktion vorkommen.' }]);

  res = await call('/api/duplicates/batch', { items: [item] });
  assert.deepEqual([res.status, res.data], [200, { ok: true, linked: 1, failed: [], migrations: [] }]);
  assert.equal(data.store.find(item.blogId, item.facebookId).status, 'linked');
  assert.equal(data.calls.refreshState, 1, 'ohne Migration nur der Dublettenstatus');
  assert.equal(lock.busy, false);
});

test('Dublettenvergleich: eigene Gründe gegen die Migration sichtbar, Systemfehler nur im Log', async t => {
  const data = fixture(t);
  data.archive.infographicGroups.get(data.facebook.id)[0].hasBody = true;
  let call = await start(t, data);
  const query = `/api/duplicates/compare?blogId=${encodeURIComponent(data.blog.id)}&facebookId=${encodeURIComponent(data.facebook.id)}`;
  let res = await call(query);
  assert.equal(res.status, 200);
  assert.match(res.data.migrationUnavailable, /enthält eigenen Text/);

  data.archive.infographicGroups.get(data.facebook.id)[0].hasBody = false;
  call = await start(t, data, { filesFor: () => { throw new Error('EACCES: /opt/nodeapp/www'); } });
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    res = await call(query);
  } finally { console.error = original; }
  assert.equal(res.status, 200);
  assert.equal(res.data.migrationUnavailable, 'Die Migration kann gerade nicht geplant werden.');
  assert.equal(logged.length, 1);
});
