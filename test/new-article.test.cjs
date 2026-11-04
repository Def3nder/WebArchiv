'use strict';

// Neuer eigener Artikel (Dialog „Neuer Artikel“, Typ „Artikel“): lesbarer Dateiname, optionales
// Bild, Konflikte, Kategorien und gezieltes Neueinlesen der neuen Datei.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { installNewArticleRoutes } = require('../modules/new-article.cjs');
const { NEW_ARTICLE_AUTHOR, MAX_TITLE_CHARS, readableFileStem, articleStemExists } = require('../lib/new-article.cjs');
const { createArchiveLock } = require('../lib/archive-lock.cjs');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('bild')]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('bild')]);

test('Lesbarer Dateiname: verbotene Zeichen, Doppelpunkt, Länge, Ränder', () => {
  assert.equal(NEW_ARTICLE_AUTHOR, 'Ralf');
  assert.equal(readableFileStem('ChatGPT: Steckbrief Mandy & Ralf'), 'ChatGPT - Steckbrief Mandy & Ralf');
  assert.equal(readableFileStem('Joe Turan - Übung 1'), 'Joe Turan - Übung 1');
  assert.equal(readableFileStem('Krieg/Frieden\\Mitte|Ende'), 'Krieg-Frieden-Mitte-Ende');
  assert.equal(readableFileStem('Was? "Wirklich" <so> *gut* #1 100%'), 'Was Wirklich so gut 1 100');
  assert.equal(readableFileStem('  Zeile\teins\nzwei  '), 'Zeile eins zwei');
  assert.equal(readableFileStem('...versteckt.'), 'versteckt');
  assert.equal(readableFileStem('Frage: - Antwort'), 'Frage - Antwort');
  assert.equal(readableFileStem('Ü'.normalize('NFD')), 'Ü');
  assert.equal(readableFileStem('???'), '');
  const long = readableFileStem('Wort '.repeat(40));
  assert.ok(long.length <= MAX_TITLE_CHARS);
  assert.match(long, /Wort$/, 'an einer Wortgrenze gekürzt');
});

test('Belegter Dateistamm: Artikel oder Begleitdatei, Groß/Klein egal, fehlender Ordner ist frei', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'new-article-stem-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '2026-11-04_Titel.mp3'), '');
  assert.equal(articleStemExists(dir, '2026-11-04_Titel'), true);
  assert.equal(articleStemExists(dir, '2026-11-04_titel'), true);
  assert.equal(articleStemExists(dir, '2026-11-04_Anderer'), false);
  assert.equal(articleStemExists(path.join(dir, 'fehlt'), 'x'), false);
});

async function start(t, { lock = createArchiveLock(), role = 'admin', refresh = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'new-article-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wwwDir = path.join(root, 'www');
  const refreshed = [];
  const app = express();
  app.use('/api/new-article', express.json({ limit: '20mb' }));
  const requireAdmin = (_req, res, next) => (role === 'admin' ? next() : res.status(403).json({ error: 'Nur für Administratoren.' }));
  installNewArticleRoutes(app, {
    requireAdmin, lock, wwwDir,
    refreshFiles: refresh || (async files => { refreshed.push(...files); }),
  });
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async body => {
    const res = await fetch(base + '/api/new-article', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  return { call, wwwDir, refreshed, dir: path.join(wwwDir, 'Ralf', '2026') };
}

const markdown = (title = 'Mein Titel: Teil 1', date = '2026-11-04') =>
  `# ${title}\n\nDatum: ${date}\n\n----\n\nErster Absatz.\n`;

test('Neuer Artikel ohne Bild: lesbarer Name unter Ralf/<Jahr>, Kategorien, Neueinlesen', async t => {
  const { call, dir, refreshed } = await start(t);
  const res = await call({ markdown: markdown(), categories: ['Beziehungen', 'Unbekannt'] });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual(res.data, { ok: true, id: 'Ralf/2026/2026-11-04_Mein Titel - Teil 1' });
  const file = path.join(dir, '2026-11-04_Mein Titel - Teil 1.md');
  assert.deepEqual(fs.readdirSync(dir), ['2026-11-04_Mein Titel - Teil 1.md']);
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /^# Mein Titel: Teil 1\n\nDatum: 2026-11-04\nKategorien: Beziehungen\n/,'nur Taxonomie-Labels');
  assert.deepEqual(refreshed, [file]);
});

test('Neuer Artikel mit Bild: Bild als gleichnamige Begleitdatei, Konflikt hängt -2 an', async t => {
  const { call, dir } = await start(t);
  let res = await call({ markdown: markdown('Bildartikel'), image: PNG.toString('base64') });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  res = await call({ markdown: markdown('Bildartikel'), image: JPG.toString('base64') });
  assert.deepEqual(res.data, { ok: true, id: 'Ralf/2026/2026-11-04_Bildartikel-2' });
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    '2026-11-04_Bildartikel-2.jpg', '2026-11-04_Bildartikel-2.md', '2026-11-04_Bildartikel.md', '2026-11-04_Bildartikel.png',
  ]);
  // Ein vorhandenes Bild ohne Artikel belegt den Namen ebenfalls.
  fs.writeFileSync(path.join(dir, '2026-11-04_Nur Bild.jpg'), JPG);
  res = await call({ markdown: markdown('Nur Bild') });
  assert.equal(res.data.id, 'Ralf/2026/2026-11-04_Nur Bild-2');
});

test('Neuer Artikel: Prüfungen, Sperre und Rechte', async t => {
  const lock = createArchiveLock();
  let busy = false;
  lock.register('Audio-Erzeugung', () => busy);
  const { call, wwwDir } = await start(t, { lock });
  const cases = [
    [{ markdown: '# [Titel]\n\nDatum: 2026-11-04\n' }, 400, /Titel/],
    [{ markdown: '# Ungültiges Datum\n\nDatum: irgendwann\n\n----\n\nText\n' }, 400, /Datum/],
    [{ markdown: markdown('???') }, 400, /Dateiname/],
    [{ markdown: markdown(), image: Buffer.from('kein Bild').toString('base64') }, 415, /PNG/],
    [{ markdown: markdown(), image: Buffer.alloc(10 * 1024 * 1024 + 1, 0x89).toString('base64') }, 413, /10 MB/],
  ];
  for (const [body, status, message] of cases) {
    const res = await call(body);
    assert.equal(res.status, status, JSON.stringify(res.data));
    assert.match(res.data.error, message);
  }
  busy = true;
  const res = await call({ markdown: markdown() });
  assert.equal(res.status, 409);
  assert.match(res.data.error, /Audio-Erzeugung/);
  assert.equal(fs.existsSync(wwwDir), false, 'nichts geschrieben');

  const member = await start(t, { role: 'user' });
  assert.equal((await member.call({ markdown: markdown() })).status, 403);
  assert.equal(fs.existsSync(member.wwwDir), false);
});

test('Neuer Artikel: Fehler beim Neueinlesen meldet einen Fehler, die Datei bleibt für den Watcher', async t => {
  const { call, dir } = await start(t, { refresh: async () => { throw new Error('Index kaputt'); } });
  const original = console.error;
  console.error = () => {};
  try {
    const res = await call({ markdown: markdown('Bleibt') });
    assert.equal(res.status, 500);
    assert.match(res.data.error, /Artikel konnte nicht gespeichert werden/);
  } finally {
    console.error = original;
  }
  assert.deepEqual(fs.readdirSync(dir), ['2026-11-04_Bleibt.md']);
});
