'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createInfographicAdmin, installInfographicRoutes } = require('../modules/infographic-admin.cjs');
const { createArchiveLock } = require('../lib/archive-lock.cjs');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('bild')]);

// Ein Blogartikel mit zwei gruppierten Infografiken (_1, _2) im Jahrgang 2026.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'infographic-admin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wwwDir = path.join(root, 'www');
  const write = (relative, content) => {
    const file = path.join(wwwDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const base = '2026-01-05_titel';
  const article = {
    id: `Blog/2026/${base}`, author: 'Blog', year: '2026', date: '2026-01-05', title: 'Titel',
    filePath: write(`Blog/2026/${base}.md`, 'Titel\n\nDatum: 2026-01-05\n\n****\n\nText\n'),
  };
  const member = ordinal => {
    const stem = `${base}_${ordinal}`;
    write(`Infografiken/2026/${stem}.png`, `Bild ${ordinal}`);
    return {
      id: `Infografiken/2026/${stem}`, author: 'Infografiken', year: '2026', title: `Titel (${ordinal})`,
      filePath: write(`Infografiken/2026/${stem}.md`, `Titel (${ordinal})\n\nDatum: 2026-01-05\n`),
      infographicBase: base, infographicOrdinal: ordinal, ownImage: true, imageUrl: `/files/${stem}.png`,
    };
  };
  const members = [member(1), member(2)];
  const archive = {
    articleById: new Map([article, ...members].map(item => [item.id, item])),
    infographicGroups: new Map([[article.id, members]]),
    groupAnchorOf: new Map(members.map(item => [item.id, article.id])),
  };
  const refreshed = [];
  return { root, wwwDir, base, article, members, archive, refreshed, dir: path.join(wwwDir, 'Infografiken', '2026') };
}

async function start(t, data, { lock = createArchiveLock(), refresh = null, role = 'admin' } = {}) {
  const admin = createInfographicAdmin({
    archive: data.archive, wwwDir: data.wwwDir, trashDir: path.join(data.wwwDir, 'Infografiken', 'trash'),
    canAccessAuthor: user => !!user, duplicateCanonicalFor: () => null,
  });
  const app = express();
  app.use('/api/new-infographic', express.json({ limit: '20mb' }));
  app.use(express.json());
  const requireAdmin = (req, _res, next) => { req.session = { user: { email: 'a@example.test', role, allowedAuthors: null } }; next(); };
  const record = async years => { data.refreshed.push(...[].concat(years)); };
  installInfographicRoutes(app, {
    requireAdmin, lock, admin, archive: data.archive, wwwDir: data.wwwDir, duplicateCanonicalFor: () => null,
    refreshInfographicsForYear: refresh || record, refreshInfographicsForYears: refresh || record,
  });
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (url, { body, type = 'application/json' } = {}) => {
    const init = body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': type }, body: Buffer.isBuffer(body) ? body : JSON.stringify(body),
    };
    const res = await fetch(base + url, init);
    return { status: res.status, cache: res.headers.get('cache-control'), data: await res.json() };
  };
}

const quiet = async fn => {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try { return { result: await fn(), logged }; } finally { console.error = original; }
};

test('Upload: Prüfungen, Sperre und neue Grafik als nächste Nummer', async t => {
  const data = fixture(t);
  const lock = createArchiveLock();
  let tts = true;
  lock.register('Audio-Erzeugung', () => tts);
  const call = await start(t, data, { lock });
  const url = `/api/infographics/${encodeURIComponent(data.article.id)}`;

  let res = await call(url, { body: PNG, type: 'image/png' });
  assert.deepEqual([res.status, res.data], [409, { error: 'Es läuft bereits: Audio-Erzeugung. Bitte später erneut versuchen.' }]);
  tts = false;

  res = await call('/api/infographics/fehlt', { body: PNG, type: 'image/png' });
  assert.deepEqual([res.status, res.data], [404, { error: 'Artikel nicht gefunden.' }]);
  res = await call(`/api/infographics/${encodeURIComponent(data.members[0].id)}`, { body: PNG, type: 'image/png' });
  assert.equal(res.status, 403, 'gruppierte Grafik ist kein Upload-Ziel');
  res = await call(url, { body: [], type: 'application/json' });
  assert.deepEqual([res.status, res.data], [415, { error: 'Nur PNG- und JPG-Bilder sind erlaubt.' }]);

  res = await call(url, { body: PNG, type: 'image/png' });
  assert.equal(res.cache, 'no-store');
  assert.deepEqual([res.status, res.data], [200, {
    ok: true, id: `Infografiken/2026/${data.base}_3`, filename: `${data.base}_3.png`, ordinal: 3,
  }]);
  assert.deepEqual(fs.readFileSync(path.join(data.dir, `${data.base}_3.png`)), PNG);
  assert.match(fs.readFileSync(path.join(data.dir, `${data.base}_3.md`), 'utf8'), /^Titel \(3\)/);
  assert.deepEqual(data.refreshed, ['2026']);
  assert.equal(lock.busy, false);
});

test('Verwaltung: Liste, Umordnen, Papierkorb und Sperre während exklusiver Aufträge', async t => {
  const data = fixture(t);
  const lock = createArchiveLock();
  const call = await start(t, data, { lock });
  const url = `/api/infographic-manager/${encodeURIComponent(data.article.id)}`;

  const release = lock.tryAcquire('Infografiken ändern');
  let res = await call(url);
  assert.deepEqual([res.status, res.data], [409, { error: 'Es läuft gerade: Infografiken ändern. Bitte gleich erneut öffnen.' }]);
  release();

  res = await call(url);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.items.map(item => [item.ordinal, item.filename]),
    [[1, `${data.base}_1.png`], [2, `${data.base}_2.png`]]);

  res = await call(url, { body: { action: 'order', ids: [data.members[1].id, data.members[0].id] } });
  assert.deepEqual([res.status, res.data], [200, { ok: true }]);
  assert.equal(fs.readFileSync(path.join(data.dir, `${data.base}_1.png`), 'utf8'), 'Bild 2');
  assert.equal(fs.readFileSync(path.join(data.dir, `${data.base}_2.png`), 'utf8'), 'Bild 1');

  res = await call(url, { body: { action: 'unbekannt' } });
  assert.deepEqual([res.status, res.data], [400, { error: 'Unbekannte Infografik-Aktion.' }]);
});

test('Verwaltung: Papierkorb verschiebt beide Dateien und nummeriert den Rest neu', async t => {
  const data = fixture(t);
  const call = await start(t, data);
  const res = await call(`/api/infographic-manager/${encodeURIComponent(data.article.id)}`,
    { body: { action: 'trash', id: data.members[0].id } });
  assert.equal(res.status, 200);
  assert.match(res.data.trash, /^Infografiken\/trash\/2026\//);
  const trash = path.join(data.wwwDir, ...res.data.trash.split('/'));
  assert.deepEqual(fs.readdirSync(trash).sort(), [`${data.base}_1.md`, `${data.base}_1.png`]);
  assert.equal(fs.readFileSync(path.join(data.dir, `${data.base}_1.png`), 'utf8'), 'Bild 2');
  assert.equal(fs.existsSync(path.join(data.dir, `${data.base}_2.png`)), false);
  assert.deepEqual(data.refreshed, ['2026']);
});

test('Verwaltung: gescheitertes Zurückrollen meldet den Hinweis aufs Log', async t => {
  const data = fixture(t);
  const call = await start(t, data, { refresh: async () => { throw new Error('EIO: /opt/nodeapp/www'); } });
  const { result: res, logged } = await quiet(() => call(`/api/infographic-manager/${encodeURIComponent(data.article.id)}`,
    { body: { action: 'order', ids: [data.members[1].id, data.members[0].id] } }));
  assert.equal(res.status, 500);
  assert.equal(res.data.error,
    'Infografiken konnten nicht geändert werden. Wiederherstellung fehlgeschlagen; Details stehen im Server-Log.');
  assert.doesNotMatch(res.data.error, /opt|EIO/);
  assert.equal(logged.length, 2);
  // Die Dateien selbst sind zurückgetauscht; nur der Neuaufbau ist gescheitert.
  assert.equal(fs.readFileSync(path.join(data.dir, `${data.base}_1.png`), 'utf8'), 'Bild 1');
});

test('Prüfmodus: Poster-Markierungen speichern und ungültige Änderungen ablehnen', async t => {
  const data = fixture(t);
  const call = await start(t, data);
  let res = await call('/api/infographic-review', { body: { changes: [] } });
  assert.deepEqual([res.status, res.data], [400, { error: 'Bitte mindestens eine und höchstens 2000 Änderungen senden.' }]);

  res = await call('/api/infographic-review', { body: { changes: [{ id: data.members[1].id, enabled: true, expected: false }] } });
  assert.deepEqual([res.status, res.data], [200, { ok: true, updated: [{ id: data.members[1].id, instagramPoster: true }] }]);
  assert.match(fs.readFileSync(data.members[1].filePath, 'utf8'), /Instagram-Poster: Ja/);
  assert.deepEqual(data.refreshed, ['2026']);

  data.members[0].instagramPoster = true;
  res = await call('/api/infographic-review', { body: { changes: [{ id: data.members[0].id, enabled: false, expected: false }] } });
  assert.equal(res.status, 409);
});

test('Neue Infografik: Dateiname aus Datum und Titel, Konflikt mit -2, Prüfungen', async t => {
  const data = fixture(t);
  const call = await start(t, data);
  const markdown = 'Größe zählt\n\nDatum: 2026-03-04\n\n****\n\nInhalt\n';
  const image = PNG.toString('base64');

  let res = await call('/api/new-infographic', { body: { markdown, image } });
  assert.deepEqual([res.status, res.data], [200, { ok: true, id: 'Infografiken/2026/2026-03-04_groesse-zaehlt' }]);
  res = await call('/api/new-infographic', { body: { markdown, image } });
  assert.deepEqual(res.data, { ok: true, id: 'Infografiken/2026/2026-03-04_groesse-zaehlt-2' });
  assert.deepEqual(fs.readFileSync(path.join(data.dir, '2026-03-04_groesse-zaehlt-2.png')), PNG);
  assert.deepEqual(data.refreshed, ['2026', '2026']);

  res = await call('/api/new-infographic', { body: { markdown: 'Datum: 2026-03-04\n', image } });
  assert.deepEqual([res.status, res.data], [400, { error: 'Bitte in der ersten Zeile einen Titel eintragen.' }]);
  res = await call('/api/new-infographic', { body: { markdown, image: Buffer.from('kein Bild').toString('base64') } });
  assert.deepEqual([res.status, res.data], [415, { error: 'Nur PNG- und JPG-Bilder sind erlaubt.' }]);
});
