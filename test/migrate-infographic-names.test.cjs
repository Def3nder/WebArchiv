const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { collectArticles, planMigration, formatMigrationReport, applyMigration, main } = require('../scripts/migrate-infographic-names.js');
const { linkInfographics } = require('../server.js');

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(__dirname, '.infographic-names-test-'));
  const www = path.join(root, 'www');
  const info = path.join(www, 'Infografiken', '2026');
  const author = path.join(www, 'Joe Turan', '2026');
  await fs.mkdir(info, { recursive: true });
  await fs.mkdir(author, { recursive: true });
  try { await run({ root, www, info, author }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function pair(dir, stem, title = 'Grafik', body = '') {
  await fs.writeFile(path.join(dir, stem + '.md'), `# ${title}\nDatum: 2026-10-20\n----\n${body}`);
  await fs.writeFile(path.join(dir, stem + '.png'), stem);
}

test('Migration nummeriert Artikelanhänge ab _1 und erhält eigenständige Basisbilder', async () => {
  await fixture(async ({ www, info, author }) => {
    await fs.writeFile(path.join(author, 'artikel.md'), '# Artikel\nDatum: 2026-10-20\n----\nText');
    await pair(info, 'artikel');
    await pair(info, 'artikel_2', 'Grafik (2)');
    await fs.writeFile(path.join(info, 'artikel_3.md'), '');
    await fs.writeFile(path.join(info, 'artikel_3.png'), 'drittes Bild');
    await pair(info, 'eigenstaendig', 'Eigenständig', 'Eigener Text');
    await pair(info, 'eigenstaendig_2', 'Eigenständig (2)', 'Kopierter Text');
    await pair(info, 'ohne-artikel', 'Ohne Artikel');
    await pair(info, 'verwaist_2', 'Ohne Basis');

    const plan = await planMigration(www);
    assert.equal(plan.skipped.length, 0);
    assert.deepEqual(plan.changes.flatMap(change => change.renames).map(item => `${item.from}>${item.to}`).sort(),
      ['artikel>artikel_1', 'eigenstaendig_2>eigenstaendig_1']);
    assert.equal(plan.standalone, 3);
    const report = formatMigrationReport(plan);
    assert.match(report, /1\. Infografiken, die einen zugewiesenen Artikel haben \(4\)/);
    assert.match(report, /1\.1 Davon nur mit Kopf oder leerer MD-Datei \(3\)/);
    assert.match(report, /1\.2 Davon mit eigenem Textkörper \(0\)/);
    assert.match(report, /1\.3 Infografiken, die eine Infografik als Artikeltext haben \(1\)/);
    assert.match(report, /2\. Infografiken, die keinen zugewiesenen Artikel haben \(3\)/);
    assert.match(report, /3\. Bereits migrierte Infografiken \(0\)/);
    assert.ok(report.indexOf('1.1 ') < report.indexOf('1.2 ')
      && report.indexOf('1.2 ') < report.indexOf('1.3 ')
      && report.indexOf('1.3 ') < report.indexOf('2. Infografiken'));
    assert.match(report, /Artikel haben \(4\)\n\n\n1\.1/);
    assert.match(report, /artikel_3 \| Artikel: Joe Turan\/2026\/artikel\n\n\n1\.2/);
    assert.match(report, /\(keine\)\n\n\n1\.3/);
    assert.match(report, /eigenstaendig_2 → Infografiken\/2026\/eigenstaendig_1 \| Artikel: Infografiken\/2026\/eigenstaendig\n\n\n2\./);
    assert.match(report, /artikel → Infografiken\/2026\/artikel_1 \| Artikel: Joe Turan\/2026\/artikel/);
    assert.match(report, /eigenstaendig_2 → Infografiken\/2026\/eigenstaendig_1 \| Artikel: Infografiken\/2026\/eigenstaendig/);
    assert.equal(await fs.readFile(path.join(info, 'artikel.png'), 'utf8'), 'artikel');
    await applyMigration(plan);
    assert.equal(await fs.readFile(path.join(info, 'artikel_1.png'), 'utf8'), 'artikel');
    assert.equal(await fs.readFile(path.join(info, 'artikel_2.png'), 'utf8'), 'artikel_2');
    assert.equal(await fs.readFile(path.join(info, 'artikel_3.md'), 'utf8'), '');
    assert.equal(await fs.readFile(path.join(info, 'eigenstaendig.png'), 'utf8'), 'eigenstaendig');
    assert.equal(await fs.readFile(path.join(info, 'eigenstaendig_1.png'), 'utf8'), 'eigenstaendig_2');
    assert.equal(await fs.readFile(path.join(info, 'eigenstaendig_1.md'), 'utf8'),
      '# Eigenständig\nDatum: 2026-10-20\n----\nKopierter Text');
    assert.equal(await fs.readFile(path.join(info, 'ohne-artikel.png'), 'utf8'), 'ohne-artikel');
    assert.equal(await fs.readFile(path.join(info, 'verwaist_2.png'), 'utf8'), 'verwaist_2');
    assert.equal((await planMigration(www)).changes.length, 0);
  });
});

test('Infografik mit eigenem Audio bleibt auch bei gleichem Artikelstamm eigenständig', async () => {
  await fixture(async ({ root, www, info, author }) => {
    await fs.writeFile(path.join(author, 'thema.md'), '# Thema\nDatum: 2026-10-20\n----\nText');
    await pair(info, 'thema');
    await pair(info, 'thema_2');
    const audio = path.join(root, 'audio', 'Infografiken', '2026');
    await fs.mkdir(audio, { recursive: true });
    await fs.writeFile(path.join(audio, 'thema.mp3'), 'Audio');
    const plan = await planMigration(www);
    assert.deepEqual(plan.changes.flatMap(change => change.renames).map(item => `${item.from}>${item.to}`),
      ['thema_2>thema_1']);
    await applyMigration(plan);
    assert.equal(await fs.readFile(path.join(info, 'thema.png'), 'utf8'), 'thema');
    assert.equal(await fs.readFile(path.join(info, 'thema_1.png'), 'utf8'), 'thema_2');
  });
});

test('Mehrdeutige Basis plus _1 wird nicht automatisch verschoben', async () => {
  await fixture(async ({ www, info, author }) => {
    await fs.writeFile(path.join(author, 'artikel.md'), '# Artikel\nDatum: 2026-10-20\n----\nText');
    await pair(info, 'artikel');
    await pair(info, 'artikel_1');
    const plan = await planMigration(www);
    assert.equal(plan.changes.length, 0);
    assert.match(plan.skipped[0].reason, /mehrdeutig/);
    await assert.rejects(main(['--root', www, '--apply']), /Wegen übersprungener Gruppen/);
    assert.equal(await fs.readFile(path.join(info, 'artikel.png'), 'utf8'), 'artikel');
  });
});

test('Mehrdeutige Artikelzuordnung und belegte Zielstämme werden ausgelassen', async () => {
  await fixture(async ({ www, info, author }) => {
    const other = path.join(www, 'Coaching', '2026');
    await fs.mkdir(other, { recursive: true });
    for (const dir of [author, other]) {
      await fs.writeFile(path.join(dir, 'thema.md'), '# Thema\nDatum: 2026-10-20\n----\nText');
    }
    await pair(info, 'thema');
    await pair(info, 'thema_2');
    await fs.writeFile(path.join(author, 'klar.md'), '# Klar\nDatum: 2026-10-20\n----\nText');
    await pair(info, 'klar');
    await fs.writeFile(path.join(info, 'klar_1.webp'), 'fremd');
    const plan = await planMigration(www);
    assert.equal(plan.changes.length, 0);
    assert.match(plan.skipped.find(item => item.anchorId.includes('thema')).reason, /mehrdeutig/);
    assert.match(plan.skipped.find(item => item.anchorId.includes('klar')).reason, /Zielstamm bereits belegt/);
  });
});

test('Bereich 1.1 migriert nur leere Anhänge und lässt Textkörper unverändert', async () => {
  await fixture(async ({ www, info, author }) => {
    await fs.writeFile(path.join(author, 'artikel.md'), '# Artikel\nDatum: 2026-10-20\n----\nText');
    await pair(info, 'artikel');
    await pair(info, 'artikel_2', 'Grafik (2)', 'Eigener Text');
    const plan = await planMigration(www, { section: '1.1' });
    assert.deepEqual(plan.changes.flatMap(change => change.renames).map(item => `${item.from}>${item.to}`),
      ['artikel>artikel_1']);
    assert.equal(plan.skipped.length, 0);
    await main(['--root', www, '--section', '1.1', '--apply']);
    assert.equal(await fs.readFile(path.join(info, 'artikel_1.png'), 'utf8'), 'artikel');
    assert.equal(await fs.readFile(path.join(info, 'artikel_2.png'), 'utf8'), 'artikel_2');
    assert.equal((await planMigration(www, { section: '1.2' })).changes.length, 0);
  });
});

test('Bereich 1.3 migriert Zusätze einer eigenständigen Infografik unabhängig vom eigenen Textkörper', async () => {
  await fixture(async ({ www, info }) => {
    await pair(info, 'eigenstaendig', 'Eigenständig', 'Eigener Text');
    await pair(info, 'eigenstaendig_2');
    await pair(info, 'eigenstaendig_3', 'Zusatz (3)', 'Eigener Zusatztext');

    assert.equal((await planMigration(www, { section: '1.1' })).changes.length, 0);
    assert.equal((await planMigration(www, { section: '1.2' })).changes.length, 0);
    const plan = await planMigration(www, { section: '1.3' });
    assert.deepEqual(plan.changes.flatMap(change => change.renames).map(item => `${item.from}>${item.to}`),
      ['eigenstaendig_2>eigenstaendig_1', 'eigenstaendig_3>eigenstaendig_2']);
    assert.equal(plan.skipped.length, 0);
    await main(['--root', www, '--section', '1.3', '--apply']);
    assert.equal(await fs.readFile(path.join(info, 'eigenstaendig_1.png'), 'utf8'), 'eigenstaendig_2');
    assert.equal(await fs.readFile(path.join(info, 'eigenstaendig_2.png'), 'utf8'), 'eigenstaendig_3');
    assert.equal(await fs.readFile(path.join(info, 'eigenstaendig.png'), 'utf8'), 'eigenstaendig');
  });
});

test('Leere Basis-Infografik ohne normalen Artikel bleibt Stamm, auch wenn ein Zusatz eigenen Text hat', async () => {
  await fixture(async ({ www, info }) => {
    await pair(info, 'eigenstaendig');
    await pair(info, 'eigenstaendig_2');
    await pair(info, 'eigenstaendig_3', 'Zusatz (3)', 'Eigener Text');
    const plan = await planMigration(www, { section: '1.3' });
    assert.equal(plan.skipped.length, 0);
    assert.deepEqual(plan.changes.flatMap(change => change.renames).map(item => `${item.from}>${item.to}`),
      ['eigenstaendig_2>eigenstaendig_1', 'eigenstaendig_3>eigenstaendig_2']);
    const report = formatMigrationReport(plan);
    assert.match(report, /1\.3 Infografiken, die eine Infografik als Artikeltext haben \(2\)/);
    assert.match(report, /2\. Infografiken, die keinen zugewiesenen Artikel haben \(1\)/);
    await applyMigration(plan);
    assert.equal(await fs.readFile(path.join(info, 'eigenstaendig.png'), 'utf8'), 'eigenstaendig');
    assert.equal(await fs.readFile(path.join(info, 'eigenstaendig_1.png'), 'utf8'), 'eigenstaendig_2');
    assert.equal(await fs.readFile(path.join(info, 'eigenstaendig_2.png'), 'utf8'), 'eigenstaendig_3');
    const linked = linkInfographics(await collectArticles(www));
    assert.deepEqual(linked.groups.get('Infografiken/2026/eigenstaendig').map(item => item.id),
      ['Infografiken/2026/eigenstaendig_1', 'Infografiken/2026/eigenstaendig_2']);
    assert.equal((await planMigration(www, { section: '1.3' })).alreadyMigrated.length, 1);
  });
});

test('Ein vorhandenes _1 markiert den ganzen Artikelstamm als bereits migriert', async () => {
  await fixture(async ({ www, info, author }) => {
    await fs.writeFile(path.join(author, 'artikel.md'), '# Artikel\nDatum: 2026-10-20\n----\nText');
    await pair(info, 'artikel_1');
    await pair(info, 'artikel_3');
    const plan = await planMigration(www, { section: '1.3' });
    assert.equal(plan.changes.length, 0);
    assert.equal(plan.skipped.length, 0);
    assert.equal(plan.alreadyMigrated.length, 1);
    assert.equal(plan.alreadyMigrated[0].anchorId, 'Joe Turan/2026/artikel');
    const report = formatMigrationReport(plan);
    assert.match(report, /1\. Infografiken, die einen zugewiesenen Artikel haben \(0\)/);
    assert.match(report, /1\.1 Davon nur mit Kopf oder leerer MD-Datei \(0\)/);
    assert.match(report, /3\. Bereits migrierte Infografiken \(2\)/);
    assert.match(report, /artikel_3 \| Artikel: Joe Turan\/2026\/artikel \| BEREITS MIGRIERT \(_1: 2026\/artikel_1\./);
    assert.equal(report.match(/Infografiken\/2026\/artikel_3 \| Artikel:/g).length, 1);
    assert.match(report, /0 Gruppen geplant, 1 bereits migriert, 0 übersprungen/);
    await main(['--root', www, '--section', '3', '--apply']);
    assert.equal(await fs.readFile(path.join(info, 'artikel_3.png'), 'utf8'), 'artikel_3');
  });
});

test('Eine einzelne _1-Datei außerhalb des Jahresordners zählt, der Papierkorb nicht', async () => {
  await fixture(async ({ www, info }) => {
    await pair(info, 'eigenstaendig', 'Eigenständig', 'Eigener Text');
    await pair(info, 'eigenstaendig_2');
    const olderYear = path.join(www, 'Infografiken', '2025');
    await fs.mkdir(olderYear);
    await fs.writeFile(path.join(olderYear, 'eigenstaendig_1.md'), 'Marker');
    const plan = await planMigration(www, { section: '1.3' });
    assert.equal(plan.changes.length, 0);
    assert.deepEqual(plan.alreadyMigrated.map(item => item.marker), ['2025/eigenstaendig_1.md']);

    await fs.rm(path.join(olderYear, 'eigenstaendig_1.md'));
    const trash = path.join(www, 'Infografiken', 'trash', '2025');
    await fs.mkdir(trash, { recursive: true });
    await fs.writeFile(path.join(trash, 'eigenstaendig_1.md'), 'kein aktiver Marker');
    await fs.writeFile(path.join(info, 'eigenstaendig_10.txt'), 'anderer Suffix');
    const withoutMarker = await planMigration(www, { section: '1.3' });
    assert.equal(withoutMarker.alreadyMigrated.length, 0);
    assert.deepEqual(withoutMarker.changes.flatMap(change => change.renames).map(item => `${item.from}>${item.to}`),
      ['eigenstaendig_2>eigenstaendig_1']);
  });
});

test('Bereich 2 bleibt unverändert und unbekannte Abschnitte werden abgelehnt', async () => {
  await fixture(async ({ www, info }) => {
    await pair(info, 'eigenstaendig', 'Eigenständig', 'Eigener Text');
    const plan = await planMigration(www, { section: '2' });
    assert.equal(plan.changes.length, 0);
    assert.equal(plan.skipped.length, 0);
    assert.match(formatMigrationReport(plan), /keine Migration nötig/);
    await main(['--root', www, '--section', '2', '--apply']);
    assert.equal(await fs.readFile(path.join(info, 'eigenstaendig.png'), 'utf8'), 'eigenstaendig');
    await assert.rejects(planMigration(www, { section: '4' }), /Ungültiger Bereich/);
    await assert.rejects(main(['--root', www, '--section', 'all', '--section', '1.1']), /Nutzung:/);
  });
});
