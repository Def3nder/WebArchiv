const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { retitleInfographicMarkdown, moveInfographicFiles, reorderManagedInfographics } = require('../server.js');

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

test('Manager bleibt auf Artikelgruppen beschränkt und der Papierkorb bleibt unsichtbar', async () => {
  const server = await fs.readFile(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /if \(author === INFOGRAPHICS_AUTHOR && fullPath === INFOGRAPHIC_TRASH_DIR\) continue/);
  assert.match(server, /segments\[1\]\?\.toLowerCase\(\) === 'trash'/);
  assert.match(server, /infographicGroups\.get\(article\.id\)/);
  assert.match(server, /item\.author !== INFOGRAPHICS_AUTHOR[\s\S]*item\.infographicBase !== baseStem/);
});
