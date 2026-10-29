const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  retitleInfographicMarkdown, moveInfographicFiles, reorderManagedInfographics,
  replaceInfographicYearArticles, prepareLinkedArticles, setInstagramPosterMetadata, parseArticle,
} = require('../server.js');

test('Instagram-Poster-Metadatum steht als eigener Absatz nach Datum und nur im Ja-Fall', () => {
  const original = '# Grafik\r\n\r\nDatum: 2026-10-25\r\n\r\nZusammenfassung: Text\r\n';
  const marked = setInstagramPosterMetadata(original, true);
  assert.equal(marked,
    '# Grafik\r\n\r\nDatum: 2026-10-25\r\n\r\nInstagram-Poster: Ja\r\n\r\nZusammenfassung: Text\r\n');
  assert.equal(parseArticle(marked, 'grafik.md').instagramPoster, true);
  assert.equal(setInstagramPosterMetadata(marked, false), original);
  assert.equal(parseArticle(original, 'grafik.md').instagramPoster, false);
});

test('Instagram-Poster-Markierung wird beim erneuten Aktivieren nicht dupliziert', () => {
  const original = '# Grafik\nDatum: 2026-10-25\nInstagram-Poster: Ja\nInstagram-Poster: Nein\n';
  const marked = setInstagramPosterMetadata(original, true);
  assert.equal(marked, '# Grafik\nDatum: 2026-10-25\n\nInstagram-Poster: Ja\n');
});

async function fixture(run) {
  const dir = await fs.mkdtemp(path.join(__dirname, '.infographic-manager-test-'));
  try { await run(dir); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('Ordinal im Infografik-Kopf ändert sich ohne Verlust anderer Inhalte oder Zeilenenden', () => {
  const original = '# Artikel (2)\r\n\r\nDatum: 2026-10-20\r\n\r\nZusammenfassung: bleibt\r\n';
  assert.equal(retitleInfographicMarkdown(original, 2, 1),
    '# Artikel\r\n\r\nDatum: 2026-10-20\r\n\r\nZusammenfassung: bleibt\r\n');
  assert.equal(retitleInfographicMarkdown(original, 2, 3),
    '# Artikel (3)\r\n\r\nDatum: 2026-10-20\r\n\r\nZusammenfassung: bleibt\r\n');
  assert.equal(retitleInfographicMarkdown('# Artikel\nDatum: 2026-10-20\n', 1, 2),
    '# Artikel (2)\nDatum: 2026-10-20\n');
});

test('Umordnen vertauscht Bild/Markdown-Paare und hält die Titelnummern synchron', async () => {
  await fixture(async dir => {
    const base = '2026-10-20_artikel';
    const first = path.join(dir, base);
    const second = path.join(dir, base + '_2');
    await fs.writeFile(first + '.md', '# Artikel\nDatum: 2026-10-20\n');
    await fs.writeFile(first + '.png', 'erstes Bild');
    await fs.writeFile(second + '.md', '# Artikel (2)\nDatum: 2026-10-20\n');
    await fs.writeFile(second + '.jpg', 'zweites Bild');
    const context = {
      dir, baseStem: base,
      bundles: [
        { id: 'eins', ordinal: 1, files: [first + '.md', first + '.png'] },
        { id: 'zwei', ordinal: 2, files: [second + '.md', second + '.jpg'] },
      ],
    };
    const undo = await reorderManagedInfographics(context, ['zwei', 'eins']);
    assert.equal(await fs.readFile(first + '_1.jpg', 'utf8'), 'zweites Bild');
    assert.equal(await fs.readFile(first + '_1.md', 'utf8'), '# Artikel\nDatum: 2026-10-20\n');
    assert.equal(await fs.readFile(second + '.png', 'utf8'), 'erstes Bild');
    assert.equal(await fs.readFile(second + '.md', 'utf8'), '# Artikel (2)\nDatum: 2026-10-20\n');
    await undo();
    assert.equal(await fs.readFile(first + '.png', 'utf8'), 'erstes Bild');
    assert.equal(await fs.readFile(second + '.jpg', 'utf8'), 'zweites Bild');
    assert.equal(await fs.readFile(second + '.md', 'utf8'), '# Artikel (2)\nDatum: 2026-10-20\n');
  });
});

test('Verschieben in den Papierkorb erhält beide Dateien und lässt sich bei Fehlern zurücknehmen', async () => {
  await fixture(async dir => {
    const source = path.join(dir, 'artikel');
    const trash = path.join(dir, 'trash', '2026', 'vorgang');
    await fs.mkdir(trash, { recursive: true });
    await fs.writeFile(source + '.md', '# Artikel\n');
    await fs.writeFile(source + '.png', 'Bild');
    const undo = await moveInfographicFiles([
      { source: source + '.md', target: path.join(trash, 'artikel.md') },
      { source: source + '.png', target: path.join(trash, 'artikel.png') },
    ]);
    assert.equal(await fs.readFile(path.join(trash, 'artikel.md'), 'utf8'), '# Artikel\n');
    assert.equal(await fs.readFile(path.join(trash, 'artikel.png'), 'utf8'), 'Bild');
    await undo();
    assert.equal(await fs.readFile(source + '.png', 'utf8'), 'Bild');
    await assert.rejects(fs.stat(path.join(trash, 'artikel.png')), { code: 'ENOENT' });
  });
});

test('Nach dem Entfernen der ersten Grafik rückt _2 samt Titel auf _1', async () => {
  await fixture(async dir => {
    const base = path.join(dir, 'artikel');
    const second = path.join(dir, 'artikel_2');
    const trash = path.join(dir, 'trash', '2026', 'vorgang');
    await fs.mkdir(trash, { recursive: true });
    for (const [stem, title, image] of [
      [base, '# Artikel\nDatum: 2026-10-20\n', 'alt'],
      [second, '# Artikel (2)\nDatum: 2026-10-20\n', 'bleibt'],
    ]) {
      await fs.writeFile(stem + '.md', title);
      await fs.writeFile(stem + '.png', image);
    }
    await moveInfographicFiles(['.md', '.png'].map(ext => ({
      source: base + ext, target: path.join(trash, 'artikel' + ext),
    })));
    await reorderManagedInfographics({
      dir, baseStem: 'artikel',
      bundles: [{ id: 'zwei', ordinal: 2, files: [second + '.md', second + '.png'] }],
    }, ['zwei']);
    assert.equal(await fs.readFile(base + '_1.md', 'utf8'), '# Artikel\nDatum: 2026-10-20\n');
    assert.equal(await fs.readFile(base + '_1.png', 'utf8'), 'bleibt');
    assert.equal(await fs.readFile(path.join(trash, 'artikel.png'), 'utf8'), 'alt');
    await assert.rejects(fs.stat(second + '.md'), { code: 'ENOENT' });
  });
});

test('Eine eigenständige Basis-Infografik wird beim Sortieren nicht überschrieben', async () => {
  await fixture(async dir => {
    const base = path.join(dir, 'artikel');
    const attached = path.join(dir, 'artikel_2');
    await fs.writeFile(base + '.md', '# Eigenständig\nDatum: 2026-10-20\n');
    await fs.writeFile(base + '.png', 'unberührt');
    await fs.writeFile(attached + '.md', '# Artikel (2)\nDatum: 2026-10-20\n');
    await fs.writeFile(attached + '.jpg', 'Anhang');
    await reorderManagedInfographics({
      dir, baseStem: 'artikel',
      bundles: [{ id: 'anhang', ordinal: 2, files: [attached + '.md', attached + '.jpg'] }],
    }, ['anhang']);
    assert.equal(await fs.readFile(base + '.png', 'utf8'), 'unberührt');
    assert.equal(await fs.readFile(base + '_1.jpg', 'utf8'), 'Anhang');
    assert.equal(await fs.readFile(base + '_1.md', 'utf8'), '# Artikel\nDatum: 2026-10-20\n');
  });
});

test('Ein belegtes Ziel wird vor der ersten Dateibewegung abgewiesen', async () => {
  await fixture(async dir => {
    const source = path.join(dir, 'quelle.md');
    const target = path.join(dir, 'ziel.md');
    await fs.writeFile(source, 'Quelle');
    await fs.writeFile(target, 'Ziel');
    await assert.rejects(moveInfographicFiles([{ source, target }]), /Zieldatei existiert bereits/);
    assert.equal(await fs.readFile(source, 'utf8'), 'Quelle');
    assert.equal(await fs.readFile(target, 'utf8'), 'Ziel');
  });
});

test('Scheitert das Zurückrollen bei einer Datei, laufen die übrigen weiter und die Reste werden genannt', async t => {
  await fixture(async dir => {
    const markdown = path.join(dir, 'a.md');
    const image = path.join(dir, 'b.png');
    await fs.writeFile(markdown, 'alt');
    await fs.writeFile(image, 'Bild');
    // Der Zielordner des Bildes fehlt: das Verschieben scheitert nach dem Markdown.
    const mappings = [
      { source: markdown, target: path.join(dir, 'a_1.md'), content: 'neu' },
      { source: image, target: path.join(dir, 'fehlt', 'b.png') },
    ];
    const rename = fs.rename;
    t.mock.method(fs, 'rename', async (from, to) => {
      if (to === markdown && path.basename(from).startsWith('.infographic-')) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return rename(from, to);
    });
    t.mock.method(console, 'error', () => {});

    await assert.rejects(moveInfographicFiles(mappings), error => {
      assert.equal(error.status, 500);
      assert.match(error.message, /nicht vollständig wiederhergestellt/);
      assert.match(error.message, /Betroffen: \.infographic-[0-9a-f]+-0\.tmp → a\.md\./);
      assert.equal(error.cause.code, 'ENOENT');
      return true;
    });
    // Das Bild ist trotz des Fehlers beim Markdown zurück an seinem Platz.
    assert.equal(await fs.readFile(image, 'utf8'), 'Bild');
    await assert.rejects(fs.stat(markdown), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(dir, 'a_1.md')), { code: 'ENOENT' });
    const leftover = (await fs.readdir(dir)).filter(name => name.startsWith('.infographic-'));
    assert.equal(leftover.length, 1);
    assert.equal(await fs.readFile(path.join(dir, leftover[0]), 'utf8'), 'alt', 'Originalinhalt zurückgesetzt');
  });
});

test('Manager bleibt auf Artikelgruppen beschränkt und der Papierkorb bleibt unsichtbar', async () => {
  const server = await fs.readFile(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /if \(author === INFOGRAPHICS_AUTHOR && fullPath === INFOGRAPHIC_TRASH_DIR\) continue/);
  // Auslieferungssperre des Papierkorbs: Verhalten in test/media-files.test.cjs geprüft.
  const mediaRoutes = await fs.readFile(path.join(__dirname, '..', 'media-files.cjs'), 'utf8');
  assert.match(mediaRoutes, /sameName\(author, infographicsAuthor\) && String\(second \|\| ''\)\.toLowerCase\(\) === 'trash'/);
  assert.match(server, /infographicGroups\.get\(article\.id\)/);
  assert.match(server, /item\.author !== INFOGRAPHICS_AUTHOR[\s\S]*item\.infographicBase !== baseStem/);
});

test('Teil-Neuindex ersetzt nur Infografiken des Jahres und verknüpft aus unveränderten Rohdaten', () => {
  const article = {
    id: 'Joe Turan/2026/artikel', author: 'Joe Turan', year: '2026',
    filePath: path.join('www', 'Joe Turan', '2026', 'artikel.md'),
    categories: ['Thema'], tags: ['Original'], audioUrl: '/audio/artikel.mp3',
  };
  const oldInfo = {
    id: 'Infografiken/2026/artikel_1', author: 'Infografiken', year: '2026',
    filePath: path.join('www', 'Infografiken', '2026', 'artikel_1.md'),
    categories: [], tags: [], audioUrl: null, hasBody: false,
  };
  const otherYear = {
    id: 'Infografiken/2025/anderer_1', author: 'Infografiken', year: '2025',
    filePath: path.join('www', 'Infografiken', '2025', 'anderer_1.md'),
    categories: [], tags: [], audioUrl: null, hasBody: false,
  };
  const raw = [article, oldInfo, otherYear];
  const first = prepareLinkedArticles(raw, ['Joe Turan']);
  assert.deepEqual(first.groups.get(article.id).map(item => item.id), [oldInfo.id]);
  assert.deepEqual(first.groups.get(article.id)[0].categories, ['Thema']);
  assert.equal(first.groups.get(article.id)[0].audioUrl, article.audioUrl);
  assert.deepEqual(oldInfo.categories, []);
  assert.equal(oldInfo.audioUrl, null);

  const newInfo = { ...oldInfo, id: 'Infografiken/2026/artikel_2',
    filePath: path.join('www', 'Infografiken', '2026', 'artikel_2.md') };
  const nextRaw = replaceInfographicYearArticles(raw, '2026', [newInfo]);
  assert.equal(nextRaw[0], article);
  assert.equal(nextRaw[1], otherYear);
  assert.equal(nextRaw.includes(oldInfo), false);
  const second = prepareLinkedArticles(nextRaw, ['Joe Turan']);
  assert.deepEqual(second.groups.get(article.id).map(item => item.id), [newInfo.id]);
  assert.deepEqual(newInfo.categories, []);
  assert.equal(newInfo.audioUrl, null);

  const removed = prepareLinkedArticles(replaceInfographicYearArticles(nextRaw, '2026', []), ['Joe Turan']);
  assert.equal(removed.groups.has(article.id), false);
  assert.equal(removed.articles.some(item => item.id === otherYear.id), true);
});

test('Manager-Aktionen und Upload lesen nur das betroffene Infografik-Jahr neu ein', async () => {
  const server = await fs.readFile(path.join(__dirname, '..', 'server.js'), 'utf8');
  const manager = server.slice(server.indexOf("app.post('/api/infographic-manager/*'"), server.indexOf("'/api/infographics/*'"));
  const upload = server.slice(server.indexOf("'/api/infographics/*'"), server.indexOf('// ─── Neue eigenständige Infografik'));
  assert.match(manager, /await refreshInfographicsForYear\(context\.year\)/);
  assert.doesNotMatch(manager, /await buildIndex\(\)/);
  assert.match(upload, /await refreshInfographicsForYear\(header\.date\.slice\(0, 4\)\)/);
  assert.doesNotMatch(upload, /await buildIndex\(\)/);
});

test('Prüfmodus speichert atomar und veröffentlicht alle betroffenen Jahre nur einmal', async () => {
  const server = await fs.readFile(path.join(__dirname, '..', 'server.js'), 'utf8');
  const batch = server.slice(
    server.indexOf("app.post('/api/infographic-review'"),
    server.indexOf("'/api/infographics/*'"),
  );
  assert.match(batch, /prepareInfographicPosterBatch\(req\.body\?\.changes\)/);
  assert.match(batch, /moveInfographicFiles\(batch\.mappings\)/);
  assert.match(batch, /refreshInfographicsForYears\(years\)/);
  assert.doesNotMatch(batch, /buildIndex\(/);

  const refresh = server.slice(
    server.indexOf('async function refreshInfographicsForYears'),
    server.indexOf('async function rebuildIndex'),
  );
  assert.match(refresh, /for \(const year of uniqueYears\)/);
  assert.match(refresh, /nextSourceArticles = replaceInfographicYearArticles/);
  assert.equal((refresh.match(/publishArticleIndex\(/g) || []).length, 1);
});

test('Escape schließt nur die oberste Ebene des Infografik-Managers und erhält den Artikel', async () => {
  const manager = await fs.readFile(path.join(__dirname, '..', 'public', 'infographic-manager.js'), 'utf8');
  const html = await fs.readFile(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(manager, /function igmEscape\(\)[\s\S]*!\$igmPreview\.hidden[\s\S]*igmClosePreview\(\)[\s\S]*else igmClose\(\)/);
  assert.match(manager, /document\.addEventListener\('keydown'[\s\S]*!\$igm\.open \|\| event\.key !== 'Escape'[\s\S]*event\.preventDefault\(\)[\s\S]*event\.stopImmediatePropagation\(\)[\s\S]*igmEscape\(\)/);
  assert.match(manager, /\$igm\.addEventListener\('cancel'[\s\S]*event\.preventDefault\(\)[\s\S]*event\.stopImmediatePropagation\(\)[\s\S]*igmEscape\(\)/);
  assert.match(manager, /igmState\.returnFocus = document\.activeElement[\s\S]*\$igm\.addEventListener\('close'[\s\S]*returnFocus\?\.isConnected[\s\S]*article-overlay/);
  assert.match(html, /infographic-manager\.js(?:\?v=[a-f0-9]+)?/);
});

test('Manager bietet pro Grafik eine sofort gespeicherte Instagram-Markierung an', async () => {
  const manager = await fs.readFile(path.join(__dirname, '..', 'public', 'infographic-manager.js'), 'utf8');
  const server = await fs.readFile(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(manager, /data-igm-instagram/);
  assert.match(manager, /action: 'instagram-poster', id, enabled/);
  // Während eines Uploads oder Speicherns bleibt der Haken bedienbar und wird vorgemerkt.
  assert.match(manager, /const locked = value && control\.dataset\.igmInstagram === undefined;/);
  assert.match(manager, /if \(instagram\) \{ igmTogglePoster\(item, instagram\.checked\); return; \}\s*if \(igmState\.busy\) return;/);
  assert.match(manager, /function igmPosterValue\(item\) \{[\s\S]*?pendingPoster\.has\(item\.id\)/);
  assert.match(manager, /finally \{\s*igmBusy\(false\);[\s\S]*?queueMicrotask\(igmFlushPoster\);/);
  // Die Markdown-Bearbeitung liegt in lib/infographics.cjs, die Route in server.js.
  const infographics = await fs.readFile(path.join(__dirname, '..', 'lib', 'infographics.cjs'), 'utf8');
  assert.match(infographics, /Instagram-Poster: Ja/);
  assert.match(server, /setManagedInfographicInstagramPoster/);
  assert.match(server, /ownGraphic[\s\S]*article\.author === INFOGRAPHICS_AUTHOR[\s\S]*fixed: true/);
  assert.match(manager, /item\.fixed \? 'Artikelgrafik'/);
  assert.match(manager, /filter\(item => !item\.fixed\)/);
});
