const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  AUDIOBOOK_AUTHOR, parseAbstract, trackTitles, createAudiobookLibrary, createProgressStore, loadAudiobookConfig,
} = require('./audiobooks.cjs');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webarchiv-books-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fixture(t) {
  const dir = await tempDir(t);
  const root = path.join(dir, AUDIOBOOK_AUTHOR);
  const book = path.join(root, 'Karin Kuschik - 50 Fragen');
  await fs.mkdir(book, { recursive: true });
  for (const name of ['10 - Kapitel zehn.mp3', '2 - Kapitel zwei.mp3', '01 - Intro.mp3', 'cover.jpg', 'notiz.txt']) {
    await fs.writeFile(path.join(book, name), 'x');
  }
  await fs.writeFile(path.join(book, 'abstract.md'),
    '﻿Titel: 50 Fragen\r\n\r\nAutor: Karin Kuschik\r\n\r\nDatum: 25.09.2025\r\n\r\nInhalt:\r\n\r\n**Fett** und Text.\r\n');
  const bare = path.join(root, 'Emily Nagoski - Kommt Zusammen!');
  await fs.mkdir(bare);
  await fs.writeFile(path.join(bare, '01 - Vorspann - Kommt Zusammen - Emily Nagoski.m4b'), 'x');
  await fs.writeFile(path.join(bare, '02 - Einleitung - Kommt Zusammen - Emily Nagoski.m4b'), 'x');
  await fs.mkdir(path.join(root, 'Leerer Ordner'));
  await fs.writeFile(path.join(root, 'standard.png'), 'x');
  const progress = createProgressStore({ file: path.join(dir, 'progress.json') });
  progress.load();
  const library = createAudiobookLibrary({
    root, progress, excerpt: text => text.replace(/\*/g, '').slice(0, 320), renderMarkdown: text => `<p>${text}</p>`,
  });
  await library.rebuild();
  return { dir, root, library, progress };
}

test('abstract.md: feste Felder, Inhalt als Markdown-Rest, Markierungen toleriert', () => {
  const parsed = parseAbstract('**Titel:** Ein Buch\n# Autor: Jemand\nDatum: 2024-3-5\nInhalt:\nErste Zeile\n\nZweiter *Absatz*\n');
  assert.deepEqual(parsed, { title: 'Ein Buch', author: 'Jemand', date: '2024-03-05', description: 'Erste Zeile\n\nZweiter *Absatz*' });
  assert.equal(parseAbstract('Datum: 25.09.2025').date, '2025-09-25');
});

test('Tracktitel ohne Nummer und ohne gemeinsamen Buch-Anhang', () => {
  assert.deepEqual(
    trackTitles(['01 - Vorspann - Kommt Zusammen - Emily Nagoski.m4b', '02 - Einleitung Wie - Kommt Zusammen - Emily Nagoski.m4b']),
    ['Vorspann', 'Einleitung Wie'],
  );
  assert.deepEqual(trackTitles(['001 - Einleitung, Teil 1.mp3']), ['Einleitung, Teil 1']);
});

test('Bibliothek: natürliche Sortierung, Cover, Fallbacks, leere Ordner übersprungen', async t => {
  const { library } = await fixture(t);
  assert.deepEqual(library.books.map(b => b.title), ['50 Fragen', 'Kommt Zusammen!']);
  const [kuschik, nagoski] = library.books;
  assert.equal(kuschik.bookAuthor, 'Karin Kuschik');
  assert.equal(kuschik.date, '2025-09-25');
  assert.deepEqual(kuschik.tracks.map(tr => tr.file), ['01 - Intro.mp3', '2 - Kapitel zwei.mp3', '10 - Kapitel zehn.mp3']);
  assert.match(kuschik.imageUrl, /^\/audio-files\/H%C3%B6rb%C3%BCcher\/Karin%20Kuschik%20-%2050%20Fragen\/cover\.jpg\?v=\d+$/);
  assert.equal(nagoski.bookAuthor, 'Emily Nagoski');
  assert.equal(nagoski.filePath, null);
  assert.match(nagoski.imageUrl, /\/audio-files\/H%C3%B6rb%C3%BCcher\/standard\.png/);
  const detail = library.detail({ email: 'a@b.de' }, kuschik.id);
  assert.equal(detail.descriptionHtml, '<p>**Fett** und Text.</p>');
  assert.equal(detail.hasAbstract, true);
  assert.equal(detail.filePath, undefined);
  assert.equal(library.list({ email: 'a@b.de' }).items[0].tracks, undefined);
});

test('Hörfortschritt pro Nutzer: speichern, Sortierung „zuletzt gehört“, Nutzer löschen', async t => {
  const { dir, library, progress } = await fixture(t);
  const nagoski = library.books[1];
  await assert.rejects(progress.set('a@b.de', nagoski, { trackIndex: 5, position: 0 }), { status: 400 });
  await assert.rejects(progress.set('a@b.de', nagoski, { trackIndex: 0, position: 1, speed: 9 }), { status: 400 });
  await progress.set('A@b.de', nagoski, { trackIndex: 1, position: 12.34, speed: 1.25 });

  const list = library.list({ email: 'a@b.de' }, { sort: 'recent' });
  assert.deepEqual(list.items.map(b => b.title), ['Kommt Zusammen!', '50 Fragen']);
  assert.deepEqual(list.items[0].progress.trackIndex, 1);
  assert.equal(library.list({ email: 'andere@b.de' }, { sort: 'recent' }).items[0].title, '50 Fragen');
  assert.equal(library.list({ email: 'a@b.de' }, { sort: 'title' }).items[0].title, '50 Fragen');

  const saved = JSON.parse(await fs.readFile(path.join(dir, 'progress.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved), ['a@b.de']);
  assert.equal(saved['a@b.de'][nagoski.id].position, 12.3);
  assert.equal(saved['a@b.de'][nagoski.id].file, '02 - Einleitung - Kommt Zusammen - Emily Nagoski.m4b');

  // Neu laden: Stand bleibt; Dateiname hat Vorrang vor dem Index.
  const reloaded = createProgressStore({ file: path.join(dir, 'progress.json') });
  reloaded.load();
  assert.equal(reloaded.get('a@b.de', nagoski.id).speed, 1.25);

  await progress.removeUser('a@B.de');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'progress.json'), 'utf8')), {});
});

test('config.json: Sprungweiten mit Standardwerten', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'config.json');
  assert.deepEqual(loadAudiobookConfig(file), { skipLongSeconds: 600, skipShortSeconds: 30 });
  await fs.writeFile(file, JSON.stringify({ audiobooks: { skipLongSeconds: 300, skipShortSeconds: -1 } }));
  assert.deepEqual(loadAudiobookConfig(file), { skipLongSeconds: 300, skipShortSeconds: 30 });
});
