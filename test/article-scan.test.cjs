'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createArticleScanner, parseArticleContent, articleMedia } = require('../lib/article-scan.cjs');
const { createDirectoryCache } = require('../lib/archive-files.cjs');

// Archiv mit Autor Joe (eigenes Bild, standard.jpg, lokales und externes Audio, Video, PDF,
// Unterordner unter einem Jahr) und Infografiken samt Papierkorb.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'article-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wwwDir = path.join(root, 'www');
  const audioDir = path.join(root, 'audio');
  const write = (dir, relative, content = 'x') => {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const md = (title, date, extra = '') => `${title}\n\nDatum: ${date}\n${extra}\n****\n\nText über Achtsamkeit und Meditation im Alltag.\n`;
  write(wwwDir, 'Joe/standard.jpg');
  write(wwwDir, 'Joe/2026/a.md', md('Mit Bild', '2026-01-05', 'Zusammenfassung: Kurz gesagt.\n'));
  for (const ext of ['.jpg', '.mp4', '.pdf']) write(wwwDir, `Joe/2026/a${ext}`);
  write(wwwDir, 'Joe/2026/b.md', md('Externes Audio', '2026-01-06'));
  write(audioDir, 'Joe/2026/b.mp3');
  write(wwwDir, 'Joe/2026/c.md', md('Lokales Audio', '2026-01-07'));
  write(wwwDir, 'Joe/2026/c.mp3');
  write(wwwDir, 'Joe/2025/extra/d.md', md('Unterordner', '2025-03-01'));
  write(wwwDir, 'Joe/2026/notiz.txt');
  write(wwwDir, 'Infografiken/2026/grafik_1.md', 'Grafik\n\nDatum: 2026-01-05\n');
  write(wwwDir, 'Infografiken/2026/grafik_1.png');
  write(wwwDir, 'Infografiken/trash/2026/alt/geloescht.md', md('Gelöscht', '2026-01-01'));
  return { wwwDir, audioDir, trashDir: path.join(wwwDir, 'Infografiken', 'trash') };
}

async function scanAll(data, options = {}) {
  let counted = 0;
  const { scanDir } = createArticleScanner({
    ...data, wantsDuplicateProfile: author => author === 'Joe', onArticle: () => { counted++; }, ...options,
  });
  const collector = [];
  const directories = createDirectoryCache();
  for (const author of ['Joe', 'Infografiken']) {
    await scanDir(path.join(data.wwwDir, author), author, null, collector, { directories });
  }
  return { byId: new Map(collector.map(entry => [entry.id, entry])), collector, counted };
}

test('Scan: IDs, Jahre, Medien und Papierkorb', async t => {
  const data = fixture(t);
  const { byId, collector, counted } = await scanAll(data);
  assert.deepEqual([...byId.keys()].sort(), [
    'Infografiken/2026/grafik_1', 'Joe/2025/extra/d', 'Joe/2026/a', 'Joe/2026/b', 'Joe/2026/c',
  ]);
  assert.equal(counted, collector.length);

  const a = byId.get('Joe/2026/a');
  assert.match(a.imageUrl, /^\/files\/Joe\/2026\/a\.jpg\?v=\d+$/);
  assert.match(a.videoUrl, /^\/files\/Joe\/2026\/a\.mp4\?v=\d+$/);
  assert.match(a.pdfUrl, /^\/files\/Joe\/2026\/a\.pdf\?v=\d+$/);
  assert.deepEqual([a.ownImage, a.audioUrl, a.year, a.filePath], [true, null, '2026', path.join(data.wwwDir, 'Joe', '2026', 'a.md')]);

  const b = byId.get('Joe/2026/b');
  assert.match(b.imageUrl, /^\/files\/Joe\/standard\.jpg\?v=\d+$/);
  assert.match(b.audioUrl, /^\/audio-files\/Joe\/2026\/b\.mp3\?v=\d+$/);
  assert.deepEqual([b.ownImage, b.hasExternalAudio], [false, true]);

  const c = byId.get('Joe/2026/c');
  assert.match(c.audioUrl, /^\/files\/Joe\/2026\/c\.mp3\?v=\d+$/);
  assert.equal(c.hasExternalAudio, false);

  assert.equal(byId.get('Joe/2025/extra/d').year, '2025', 'Unterordner erben das Jahr');
  const grafik = byId.get('Infografiken/2026/grafik_1');
  assert.deepEqual([grafik.ownImage, grafik.hasBody, grafik.duplicateProfile], [true, false, null]);
});

test('Scan: Datei-Signatur, Dublettenprofil nur für gewünschte Autoren', async t => {
  const data = fixture(t);
  const { byId } = await scanAll(data);
  const a = byId.get('Joe/2026/a');
  const stat = fs.statSync(a.filePath);
  assert.deepEqual(a.fileSignature, { size: stat.size, mtimeMs: stat.mtimeMs });
  assert.equal(typeof a.duplicateProfile.hash, 'string');
  assert.equal(byId.get('Infografiken/2026/grafik_1').duplicateProfile, null);
});

test('Scan: Zieldatei gezielt einlesen, fehlender Ordner nur im strikten Modus ein Fehler', async t => {
  const data = fixture(t);
  const { scanDir } = createArticleScanner(data);
  const collector = [];
  const target = path.join(data.wwwDir, 'Joe', '2026', 'c.md');
  await scanDir(path.join(data.wwwDir, 'Joe'), 'Joe', null, collector, { strict: true, targetFile: target });
  assert.deepEqual(collector.map(entry => entry.id), ['Joe/2026/c']);

  await scanDir(path.join(data.wwwDir, 'Fehlt'), 'Fehlt', null, collector);
  await assert.rejects(scanDir(path.join(data.wwwDir, 'Fehlt'), 'Fehlt', null, collector, { strict: true }), { code: 'ENOENT' });
});

test('parseArticleContent: nur vom Inhalt abhängig; articleMedia: nur von den Verzeichnislisten', async t => {
  const content = 'Titel\n\nDatum: 2026-02-01\nKategorien: Eigenes\nZusammenfassung: Die Zusammenfassung.\n\n****\n\nMeditation und Achtsamkeit.\n';
  const first = parseArticleContent(content, '/x/eins.md');
  const second = parseArticleContent(content, '/y/zwei.md');
  assert.deepEqual(first, second, 'gleicher Inhalt, gleiches Ergebnis');
  assert.deepEqual([first.title, first.date, first.tags, first.excerpt, first.summary, first.hasBody],
    ['Titel', '2026-02-01', ['Eigenes'], 'Die Zusammenfassung.', 'Die Zusammenfassung.', true]);
  assert.ok(Array.isArray(first.categories) && !first.categories.includes('Eigenes'), 'nur Taxonomie-Labels');
  assert.equal(first.duplicateProfile, null);
  assert.equal(typeof parseArticleContent(content, '/x/eins.md', { duplicateProfile: true }).duplicateProfile.hash, 'string');

  const data = fixture(t);
  const directories = createDirectoryCache();
  const dirPath = path.join(data.wwwDir, 'Joe', '2026');
  const media = articleMedia({
    wwwDir: data.wwwDir, audioDir: data.audioDir, dirPath, author: 'Joe', relDir: '2026', basename: 'fehlt',
    listing: directories.get(dirPath), directories,
  });
  assert.deepEqual(Object.keys(media).sort(), ['audioUrl', 'hasExternalAudio', 'imageUrl', 'ownImage', 'pdfUrl', 'videoUrl']);
  assert.match(media.imageUrl, /standard\.jpg/);
  assert.deepEqual([media.ownImage, media.audioUrl, media.videoUrl, media.pdfUrl], [false, null, null, null]);
});
