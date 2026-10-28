'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { parseArticle } = require('../lib/article.cjs');
const { buildDuplicateProfile, detectDuplicateCandidates, DEFAULT_THRESHOLDS } = require('../lib/duplicates.cjs');
const { companionsFor, scanFolder } = require('../lib/scan.cjs');
const { moveArticle, createMoveLog } = require('../lib/mover.cjs');
const diff = require('../../public/duplicate-diff.js');

const BODY = Array.from({ length: 60 }, (_, i) => `Wort${i} steht hier im Satz Nummer ${i}.`).join(' ');

function articleText(title, date, body) {
  return `${title}\nDatum: ${date}\nZusammenfassung: Kurz.\n****\n${body}\n`;
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dup-tool-'));
}

async function write(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

test('parseArticle trennt Metadaten und Body wie im WebArchiv', () => {
  const parsed = parseArticle(articleText('**Titel**', '03.02.2021', 'Erster Absatz.'), 'x.md');
  assert.equal(parsed.title, 'Titel');
  assert.equal(parsed.date, '2021-02-03');
  assert.equal(parsed.body, 'Erster Absatz.');
});

test('detectDuplicateCandidates findet A↔B-Paare, nicht innerhalb eines Ordners', () => {
  const make = (id, title, date, body) => ({ id, title, date, duplicateProfile: buildDuplicateProfile(title, body) });
  const a = [make('A:1', 'Titel', '2021-01-01', BODY), make('A:2', 'Anders', '2021-01-01', BODY.replace(/Wort/g, 'Satz'))];
  const b = [make('B:1', 'Titel', '2021-01-05', `${BODY} Noch ein Zusatz.`), make('B:2', 'Fremd', '2021-01-01', 'zu kurz')];
  const matches = detectDuplicateCandidates(a, b, DEFAULT_THRESHOLDS);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].original.id, 'A:1');
  assert.equal(matches[0].candidate.id, 'B:1');
  assert.ok(matches[0].score > 0.9);
});

test('companionsFor nimmt Basisnamen und _N-Varianten, aber keine eigenen Artikel', () => {
  const names = ['foo.md', 'foo.jpg', 'foo_1.png', 'foo_2.md', 'foo_2.jpg', 'foobar.jpg', 'Foo.mp3'];
  assert.deepEqual(companionsFor('foo.md', names), ['foo_1.png', 'Foo.mp3', 'foo.jpg']
    .sort((x, y) => x.localeCompare(y, 'de', { numeric: true })));
  assert.deepEqual(companionsFor('foo_2.md', names), ['foo_2.jpg']);
});

test('moveArticle bildet die Struktur nach, vergibt Suffixe und lässt sich rückgängig machen', async () => {
  const root = await tempDir();
  const folderB = path.join(root, 'B');
  const target = path.join(root, 'Ziel');
  await write(path.join(folderB, '2020', 'foo.md'), articleText('T', '2020-01-01', BODY));
  await write(path.join(folderB, '2020', 'foo.jpg'), 'bild');
  await write(path.join(folderB, '2020', 'foo_1.jpg'), 'bild1');
  await write(path.join(target, '2020', 'foo.md'), 'schon da');

  const [article] = await scanFolder(folderB, { side: 'B' });
  assert.deepEqual(article.companions, ['foo_1.jpg', 'foo.jpg'].sort((x, y) => x.localeCompare(y, 'de', { numeric: true })));
  const files = await moveArticle(article, target);
  const targets = files.map(item => path.relative(target, item.to)).sort();
  assert.deepEqual(targets, [path.join('2020', 'foo (2).jpg'), path.join('2020', 'foo (2).md'), path.join('2020', 'foo (2)_1.jpg')].sort());
  await assert.rejects(fs.stat(path.join(folderB, '2020', 'foo.md')));

  const log = createMoveLog({ file: path.join(root, 'data', 'moves.json') });
  log.load();
  const entry = await log.add({ files });
  await log.undo(entry.id);
  assert.equal(await fs.readFile(path.join(folderB, '2020', 'foo_1.jpg'), 'utf8'), 'bild1');
  assert.equal(log.all().length, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test('Diff-Modul arbeitet in Node mit dem diff-Paket', () => {
  const rows = diff.renderUnifiedRows(['Ein Satz hier.'], ['Ein anderer Satz hier.']);
  assert.ok(rows.some(row => row.kind === 'removed'));
  assert.ok(rows.some(row => row.kind === 'added'));
});

test('API: scannen, vergleichen, ignorieren, verschieben, rückgängig', async () => {
  const root = await tempDir();
  const folderA = path.join(root, 'A');
  const folderB = path.join(root, 'B');
  const target = path.join(root, 'B', '_dubletten');
  await write(path.join(folderA, 'orig.md'), articleText('Titel', '2021-01-01', BODY));
  await write(path.join(folderB, 'kopie.md'), articleText('Titel', '2021-01-02', `${BODY} Zusatz.`));
  await write(path.join(folderB, 'kopie.jpg'), 'bild');
  process.env.DUPLICATES_TOOL_CONFIG = path.join(root, 'config.json');
  process.env.DUPLICATES_TOOL_DATA = path.join(root, 'data');
  const { app } = require('../server.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (url, options = {}) => {
    const response = await fetch(base + url, {
      ...options,
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    let result = await call('/api/config', { method: 'PUT', body: { originals: [folderA], folderB, target: folderA } });
    assert.equal(result.status, 400);
    result = await call('/api/config', { method: 'PUT', body: { originals: [folderA, path.join(folderA, 'sub')], folderB, target } });
    assert.equal(result.status, 400);
    result = await call('/api/config', { method: 'PUT', body: { originals: [folderA], folderB, target } });
    assert.equal(result.status, 200);
    await call('/api/scan', { method: 'POST' });
    result = await call('/api/duplicates');
    assert.equal(result.data.pending.length, 1);
    const pair = result.data.pending[0];
    assert.deepEqual(pair.candidate.companions, ['kopie.jpg']);

    const compare = await call(`/api/duplicates/compare?originalId=${encodeURIComponent(pair.original.id)}&candidateId=${encodeURIComponent(pair.candidate.id)}`);
    assert.match(compare.data.original.bodyHtml, /<p>/);

    const vendor = await fetch(`${base}/vendor/duplicate-diff.bundle.js`);
    assert.equal(vendor.status, 200);
    assert.match(vendor.headers.get('content-type'), /javascript/);

    const image = await fetch(`${base}/api/file?id=${encodeURIComponent(pair.candidate.id)}&name=kopie.jpg`);
    assert.equal(image.status, 200);
    const traversal = await fetch(`${base}/api/file?id=${encodeURIComponent(pair.candidate.id)}&name=..%2FA%2Forig.md`);
    assert.equal(traversal.status, 404);

    const ids = { originalId: pair.original.id, candidateId: pair.candidate.id };
    await call('/api/duplicates', { method: 'POST', body: { action: 'ignore', ...ids } });
    result = await call('/api/duplicates');
    assert.equal(result.data.pending.length, 0);
    assert.equal(result.data.ignored.length, 1);
    await call('/api/duplicates', { method: 'POST', body: { action: 'reset', ...ids } });

    result = await call('/api/move', { method: 'POST', body: { items: [ids] } });
    assert.equal(result.data.moved.length, 1, JSON.stringify(result.data));
    await fs.stat(path.join(target, 'kopie.md'));
    await fs.stat(path.join(target, 'kopie.jpg'));
    result = await call('/api/duplicates');
    assert.equal(result.data.pending.length, 0);
    assert.equal(result.data.moved.length, 1);

    // „Verschoben“ zeigt nur Einträge des aktuellen B-Ordners.
    const otherB = path.join(root, 'B2');
    await fs.mkdir(otherB);
    await call('/api/config', { method: 'PUT', body: { folderB: otherB, target: path.join(root, 'Ziel2') } });
    assert.equal((await call('/api/duplicates')).data.moved.length, 0);
    await call('/api/config', { method: 'PUT', body: { folderB, target } });
    assert.equal((await call('/api/duplicates')).data.moved.length, 1);

    // Der Ziel-Ordner liegt in B, wird aber nicht mitgescannt.
    await call('/api/scan', { method: 'POST' });
    assert.equal((await call('/api/duplicates')).data.pending.length, 0);

    await call(`/api/moves/${result.data.moved[0].id}/undo`, { method: 'POST' });
    result = await call('/api/duplicates');
    assert.equal(result.data.pending.length, 1);
    assert.equal(result.data.moved.length, 0);

    const foreign = await fetch(`${base}/api/scan`, { method: 'POST', headers: { Origin: 'http://evil.example' } });
    assert.equal(foreign.status, 403);
  } finally {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('API: mehrere Original-Ordner werden gemeinsam als Seite A verglichen', async () => {
  const root = await tempDir();
  const first = path.join(root, 'Blog');
  const second = path.join(root, 'Archiv');
  const folderB = path.join(root, 'B');
  const otherBody = BODY.replace(/Wort/g, 'Begriff');
  await write(path.join(first, 'gleich.md'), articleText('Gleich', '2021-01-01', BODY));
  await write(path.join(second, 'gleich.md'), articleText('Anders', '2021-01-01', otherBody));
  await write(path.join(folderB, 'eins.md'), articleText('Gleich', '2021-01-02', BODY));
  await write(path.join(folderB, 'zwei.md'), articleText('Anders', '2021-01-02', otherBody));
  // Alte Konfiguration mit nur „folderA“ wird als erster Original-Ordner gelesen.
  await write(path.join(root, 'config.json'), JSON.stringify({ folderA: first, folderB }));
  process.env.DUPLICATES_TOOL_CONFIG = path.join(root, 'config.json');
  process.env.DUPLICATES_TOOL_DATA = path.join(root, 'data');
  delete require.cache[require.resolve('../server.js')];
  const { app } = require('../server.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (url, options = {}) => {
    const response = await fetch(base + url, {
      ...options,
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    let result = await call('/api/config');
    assert.deepEqual(result.data.config.originals, [first]);
    result = await call('/api/config', { method: 'PUT', body: { originals: [first, second] } });
    assert.equal(result.status, 200);
    const stored = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
    assert.deepEqual(stored.originals, [first, second]);
    assert.equal(stored.folderA, undefined);

    await call('/api/scan', { method: 'POST' });
    result = await call('/api/duplicates');
    assert.deepEqual(result.data.scan.originalFolders, [first, second]);
    const byCandidate = Object.fromEntries(result.data.pending.map(item => [item.candidate.relPath, item.original]));
    assert.equal(byCandidate['eins.md'].id, 'A1:gleich.md');
    assert.equal(byCandidate['zwei.md'].id, 'A2:gleich.md');
    assert.equal(byCandidate['zwei.md'].rootIndex, 2);
    assert.equal(byCandidate['zwei.md'].rootName, 'Archiv');
  } finally {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('detectDuplicateCandidates findet umformulierte Texte mit anderem Titel inhaltlich', () => {
  const make = (id, title, date, body) => ({ id, title, date, duplicateProfile: buildDuplicateProfile(title, body) });
  const sentences = Array.from({ length: 30 }, (_, i) =>
    `Vertrauen${i} Beziehung${i} Nähe${i} Partnerschaft${i} Verletzlichkeit${i} Heilung${i}`);
  // Gleiche Inhaltswörter, aber jede Wortfolge umgedreht und mit anderen Füllwörtern: keine gemeinsamen 5-Wort-Folgen.
  const original = sentences.map(s => `Die ${s} ist wichtig.`).join(' ');
  const paraphrase = sentences.map(s => `Und auch ${s.split(' ').reverse().join(' und ')} sind so.`).join(' ');
  const unrelated = Array.from({ length: 30 }, (_, i) => `Garten${i} Werkzeug${i} Schaufel${i} Rasen${i} Blume${i} Erde${i}`).join(' ');
  const a = [make('A:1', 'Über Vertrauen', '2021-01-01', original), make('A:2', 'Gartenarbeit', '2021-01-01', unrelated)];
  const b = [make('B:1', 'Ein völlig anderer Titel', '2021-02-01', paraphrase)];

  const off = detectDuplicateCandidates(a, b, { ...DEFAULT_THRESHOLDS, minContentSimilarity: 100 });
  assert.equal(off.length, 0);
  const matches = detectDuplicateCandidates(a, b, DEFAULT_THRESHOLDS);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].original.id, 'A:1');
  assert.equal(matches[0].method, 'content');
  assert.ok(matches[0].reasons.includes('Anderer Titel'));
});

test('API: Schwelle wird gespeichert, letzte fünf B- und Ziel-Ordner werden gemerkt', async () => {
  const root = await tempDir();
  const folderA = path.join(root, 'A');
  const bs = Array.from({ length: 7 }, (_, i) => path.join(root, `B${i}`));
  for (const dir of [folderA, ...bs]) await fs.mkdir(dir, { recursive: true });
  process.env.DUPLICATES_TOOL_CONFIG = path.join(root, 'config.json');
  process.env.DUPLICATES_TOOL_DATA = path.join(root, 'data');
  delete require.cache[require.resolve('../server.js')];
  const { app } = require('../server.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = body => fetch(`${base}/api/config`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(response => response.json());
  try {
    for (const [i, folderB] of bs.entries()) {
      await put({ originals: [folderA], folderB, target: path.join(root, `Ziel${i % 2}`), minContentSimilarity: 60 });
    }
    // B2 erneut verwenden: rückt nach vorn, keine Doppelung.
    const result = await put({ folderB: bs[2] });
    assert.equal(result.apiVersion, 4);
    assert.deepEqual(result.config.recentFolderB, [bs[2], bs[6], bs[5], bs[4], bs[3]]);
    assert.deepEqual(result.config.recentTargets, [path.join(root, 'Ziel0'), path.join(root, 'Ziel1')]);
    const stored = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
    assert.equal(stored.minContentSimilarity, 60);
    assert.deepEqual(stored.recentFolderB, result.config.recentFolderB);
    const config = await fetch(`${base}/api/config`).then(response => response.json());
    assert.equal(config.config.minContentSimilarity, 60);
  } finally {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Vergleichsansicht bereinigt HTML wie das WebArchiv', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /bodyHtml: renderSafeMarkdown\(article\.body\)/);
  assert.doesNotMatch(source, /require\('marked'\)/);
  const { renderSafeMarkdown } = require('../../html-sanitizer.cjs');
  assert.doesNotMatch(renderSafeMarkdown('Text <script>alert(1)</script><img src=x onerror=alert(1)>'), /<script|onerror/i);
});
