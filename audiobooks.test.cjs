const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  AUDIOBOOK_AUTHOR, resolveAudiobookDirectory, parseAbstract, trackTitles, createAudiobookLibrary, createProgressStore, loadAudiobookConfig,
} = require('./audiobooks.cjs');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webarchiv-books-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fixture(t) {
  const dir = await tempDir(t);
  // Server-Variante: Ordner ohne Umlaute, Anzeige bleibt „Hörbücher“.
  const root = path.join(dir, 'audio', 'Hoerbuecher');
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
    audioRoot: path.join(dir, 'audio'), progress, excerpt: text => text.replace(/\*/g, '').slice(0, 320), renderMarkdown: text => `<p>${text}</p>`,
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
  assert.equal(library.directory, 'Hoerbuecher');
  assert.equal(kuschik.id, `${AUDIOBOOK_AUTHOR}/Karin Kuschik - 50 Fragen`);
  assert.equal(kuschik.author, AUDIOBOOK_AUTHOR);
  assert.match(kuschik.imageUrl, /^\/audio-files\/Hoerbuecher\/Karin%20Kuschik%20-%2050%20Fragen\/cover\.jpg\?v=\d+$/);
  assert.equal(kuschik.tracks[0].url, '/audio-files/Hoerbuecher/Karin%20Kuschik%20-%2050%20Fragen/01%20-%20Intro.mp3');
  assert.equal(nagoski.bookAuthor, 'Emily Nagoski');
  assert.equal(nagoski.filePath, null);
  assert.match(nagoski.imageUrl, /\/audio-files\/Hoerbuecher\/standard\.png/);
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

test('config.json: Sprungweiten mit Standardwerten, optionales Verzeichnis', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'config.json');
  assert.deepEqual(loadAudiobookConfig(file), { skipLongSeconds: 600, skipShortSeconds: 30, directory: null });
  await fs.writeFile(file, JSON.stringify({ audiobooks: { skipLongSeconds: 300, skipShortSeconds: -1, directory: '../etc' } }));
  assert.deepEqual(loadAudiobookConfig(file), { skipLongSeconds: 300, skipShortSeconds: 30, directory: null });
  await fs.writeFile(file, JSON.stringify({ audiobooks: { directory: 'Meine Hoerbuecher' } }));
  assert.equal(loadAudiobookConfig(file).directory, 'Meine Hoerbuecher');
});

test('Verzeichnis: Hoerbuecher vor Hörbücher, konfigurierter Name hat Vorrang', async t => {
  const dir = await tempDir(t);
  assert.equal(resolveAudiobookDirectory(dir, null), null);
  await fs.mkdir(path.join(dir, AUDIOBOOK_AUTHOR));
  assert.equal(resolveAudiobookDirectory(dir, null), AUDIOBOOK_AUTHOR);
  await fs.mkdir(path.join(dir, 'Hoerbuecher'));
  assert.equal(resolveAudiobookDirectory(dir, null), 'Hoerbuecher');
  await fs.mkdir(path.join(dir, 'Andere'));
  assert.equal(resolveAudiobookDirectory(dir, 'Andere'), 'Andere');
  assert.equal(resolveAudiobookDirectory(dir, 'Fehlt'), null);
});

async function ebookFixture(t) {
  const dir = await tempDir(t);
  const root = path.join(dir, 'audio', 'Hoerbuecher');
  const makeBook = async (name, files) => {
    const book = path.join(root, name);
    await fs.mkdir(book, { recursive: true });
    await fs.writeFile(path.join(book, '01 - Teil.mp3'), 'x');
    for (const [file, content] of Object.entries(files)) await fs.writeFile(path.join(book, file), content);
  };
  await makeBook('Autor - Mit Markdown', { 'Autor - Mit Markdown.md': '﻿# Kapitel\n\nText', 'abstract.md': 'Titel: Mit Markdown\nInhalt:\nKurz' });
  await makeBook('Autor - Mit Text', { 'Autor - Mit Text.TXT': 'Erste Zeile\r\nzweite <b>Zeile</b>\r\n\r\nNeuer Absatz' });
  await makeBook('Autor - Zeilenweise', { 'Autor - Zeilenweise.txt': 'Eins\nZwei' });
  await makeBook('Autor - Mit PDF', { 'Autor - Mit PDF.pdf': '%PDF' });
  await makeBook('Autor - Ohne', { 'notiz.txt': 'gehört nicht zum Buch', 'abstract.md': 'Titel: Ohne' });
  await makeBook('Autor - Beides', { 'Autor - Beides.pdf': '%PDF', 'Autor - Beides.txt': 'Text' });
  const progress = createProgressStore({ file: path.join(dir, 'progress.json') });
  progress.load();
  const library = createAudiobookLibrary({
    audioRoot: path.join(dir, 'audio'), progress, excerpt: text => text, renderMarkdown: text => `<md>${text}</md>`,
  });
  await library.rebuild();
  const byTitle = title => library.books.find(b => b.title === title);
  return { dir, library, progress, byTitle };
}

test('eBook: Dateiname = Ordnername, Endung md/txt/pdf, abstract.md und fremde Dateien zählen nicht', async t => {
  const { library, byTitle } = await ebookFixture(t);
  assert.deepEqual(byTitle('Mit Markdown').ebook, { format: 'md', file: 'Autor - Mit Markdown.md' });
  assert.deepEqual(byTitle('Mit Text').ebook, { format: 'txt', file: 'Autor - Mit Text.TXT' });
  assert.equal(byTitle('Mit PDF').ebook.format, 'pdf');
  assert.equal(byTitle('Ohne').ebook, null);
  assert.equal(byTitle('Beides').ebook.format, 'txt');   // md vor txt vor pdf
  const detail = library.detail({ email: 'a@b.de' }, byTitle('Mit PDF').id);
  assert.equal(detail.ebook.format, 'pdf');
  assert.equal(detail.bookDir, undefined);
  assert.equal(library.list({ email: 'a@b.de' }).items.every(b => b.bookDir === undefined), true);
});

test('eBook-Inhalt: Markdown gerendert, Text escaped und in Absätze, PDF als Medien-URL', async t => {
  const { library, byTitle } = await ebookFixture(t);
  assert.deepEqual(await library.ebookText(byTitle('Mit Markdown')), { format: 'md', html: '<md># Kapitel\n\nText</md>' });
  assert.deepEqual(await library.ebookText(byTitle('Mit Text')),
    { format: 'txt', html: '<p>Erste Zeile zweite &lt;b&gt;Zeile&lt;/b&gt;</p>\n<p>Neuer Absatz</p>' });
  assert.equal((await library.ebookText(byTitle('Zeilenweise'))).html, '<p>Eins</p>\n<p>Zwei</p>');
  const pdf = await library.ebookText(byTitle('Mit PDF'));
  assert.match(pdf.url, /^\/audio-files\/Hoerbuecher\/Autor%20-%20Mit%20PDF\/Autor%20-%20Mit%20PDF\.pdf\?v=\d+$/);
  await assert.rejects(library.ebookText(byTitle('Ohne')), { status: 404 });
});

test('Leseposition: pro Nutzer und Buch, getrennt vom Hörstand, Format und Werte geprüft', async t => {
  const { dir, library, progress, byTitle } = await ebookFixture(t);
  const text = byTitle('Mit Text');
  const pdf = byTitle('Mit PDF');
  await assert.rejects(progress.setText('a@b.de', text, { position: 1.5 }), { status: 400 });
  await assert.rejects(progress.setText('a@b.de', pdf, { position: 0.5 }), { status: 400 });
  await assert.rejects(progress.setText('a@b.de', byTitle('Ohne'), { position: 0.5 }), { status: 404 });
  await progress.set('A@b.de', text, { trackIndex: 0, position: 5 });
  await progress.setText('A@b.de', text, { position: 0.123456 });
  await progress.setText('a@b.de', pdf, { position: 42 });

  assert.equal(progress.getText('a@b.de', text.id, 'txt'), 0.1235);
  assert.equal(progress.getText('a@b.de', pdf.id, 'pdf'), 42);
  assert.equal(progress.getText('a@b.de', pdf.id, 'md'), null);       // Format gewechselt → ignoriert
  assert.equal(progress.getText('andere@b.de', text.id, 'txt'), null);
  assert.equal(progress.get('a@b.de', text.id).position, 5);          // Hörstand bleibt erhalten
  assert.equal(library.detail({ email: 'a@b.de' }, pdf.id).ebookPosition, 42);
  assert.equal(library.detail({ email: 'a@b.de' }, byTitle('Ohne').id).ebookPosition, null);

  // Hören nach Lesen überschreibt die Leseposition nicht.
  await progress.set('a@b.de', text, { trackIndex: 0, position: 9 });
  assert.equal(progress.getText('a@b.de', text.id, 'txt'), 0.1235);
  // „Zuletzt gehört“ und Tracksuche bleiben unberührt vom Text-Eintrag.
  assert.equal(library.list({ email: 'a@b.de' }, { sort: 'recent' }).items[0].title, 'Mit Text');

  const reloaded = createProgressStore({ file: path.join(dir, 'progress.json') });
  reloaded.load();
  assert.equal(reloaded.getText('a@b.de', pdf.id, 'pdf'), 42);
  await progress.removeUser('a@b.de');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'progress.json'), 'utf8')), {});
});
