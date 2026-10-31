const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { writeFileAtomic, writeJsonAtomic, writeFileAtomicSync, readJsonFile, createJsonState } = require('../lib/atomic-file.cjs');
const { jsonRoute } = require('../lib/http-errors.cjs');
const { escapeHtml } = require('../lib/html-sanitizer.cjs');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webarchiv-helpers-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('writeFileAtomic ersetzt die Datei und hinterlässt keine temporären Dateien', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'a.md');
  await writeFileAtomic(file, 'neu');
  await writeFileAtomic(file, Buffer.from('zweiter Stand'));
  assert.equal(await fs.readFile(file, 'utf8'), 'zweiter Stand');
  assert.deepEqual(await fs.readdir(dir), ['a.md']);
});

test('writeFileAtomic: beforeRename kann abbrechen, das Original bleibt', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'a.md');
  await fs.writeFile(file, 'original');
  await assert.rejects(writeFileAtomic(file, 'neu', { beforeRename: () => { throw Object.assign(new Error('geändert'), { status: 409 }); } }), { status: 409 });
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(dir), ['a.md']);
});

test('writeJsonAtomic meldet fehlende Schreibrechte als 500 mit Dateinamen', async t => {
  const dir = await tempDir(t);
  const io = { ...fs, rename: async () => { throw Object.assign(new Error('nein'), { code: 'EACCES' }); } };
  await assert.rejects(writeJsonAtomic(path.join(dir, 'x.json'), {}, io, 0o600),
    { status: 500, message: 'x.json konnte nicht gespeichert werden: keine Schreibberechtigung.' });
  assert.deepEqual(await fs.readdir(dir), []);
});

test('writeFileAtomicSync ersetzt nur vorhandene Dateien', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'b.md');
  assert.throws(() => writeFileAtomicSync(file, 'x'), { code: 'ENOENT' });
  await fs.writeFile(file, 'alt');
  writeFileAtomicSync(file, 'neu', { prefix: 'test' });
  assert.equal(await fs.readFile(file, 'utf8'), 'neu');
  assert.deepEqual(await fs.readdir(dir), ['b.md']);
});

test('readJsonFile liest tolerant (BOM, fehlende Datei)', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'store.json');
  assert.deepEqual(readJsonFile(file, { leer: true }), { leer: true });
  await fs.writeFile(file, '\uFEFF{"a":1}');
  assert.deepEqual(readJsonFile(file, {}), { a: 1 });
});

test('createJsonState übernimmt Änderungen erst nach erfolgreichem Schreiben', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'state.json');
  let failWrites = false;
  const io = { ...fs, rename: async (...args) => {
    if (failWrites) throw Object.assign(new Error('Platte voll'), { code: 'ENOSPC' });
    return fs.rename(...args);
  } };
  const state = createJsonState({ file, io, fromDocument: doc => doc || {} });
  state.load();
  assert.equal(await state.update(data => { data.a = 1; return 'ok'; }), 'ok');
  assert.deepEqual(state.value, { a: 1 });

  failWrites = true;
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    await assert.rejects(state.update(data => { data.b = 2; }), { code: 'ENOSPC' });
  } finally { console.error = original; }
  assert.deepEqual(state.value, { a: 1 }, 'Speicher bleibt beim alten Stand');
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { a: 1 }, 'Datei bleibt beim alten Stand');
  assert.equal(errors.length, 1);

  failWrites = false;
  assert.equal(await state.update(() => false), false, 'ohne Änderung wird nicht geschrieben');
  await Promise.all([1, 2, 3].map(n => state.update(data => { data.n = (data.n || 0) + n; })));
  assert.equal(state.value.n, 6, 'nacheinander, jede Änderung sieht die vorige');
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { a: 1, n: 6 });
});

function fakeResponse() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
const request = (method, site) => ({ method, path: '/x', get: name => (name === 'sec-fetch-site' ? site : undefined) });

test('jsonRoute: no-store, Cross-Site nur für schreibende Aufrufe, Fehler ohne Details', async () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const ok = jsonRoute(() => ({ ok: true }), { label: 'Test' });
    let res = fakeResponse();
    await ok(request('GET', 'cross-site'), res);
    assert.deepEqual([res.statusCode, res.body, res.headers['Cache-Control']], [200, { ok: true }, 'no-store']);
    res = fakeResponse();
    await ok(request('PUT', 'cross-site'), res);
    assert.deepEqual([res.statusCode, res.body], [403, { error: 'Änderungen sind nur aus dem Archiv erlaubt.' }]);

    const broken = jsonRoute(() => { throw new Error('geheimer Pfad /opt'); }, { label: 'Test', fallback: 'Allgemein.' });
    res = fakeResponse();
    await broken(request('POST', 'same-origin'), res);
    assert.deepEqual([res.statusCode, res.body], [500, { error: 'Allgemein.' }]);
    assert.equal(errors.length, 1);

    const limited = jsonRoute(() => { throw Object.assign(new Error('Zu viele Versuche.'), { status: 429, retryAfter: 60 }); });
    res = fakeResponse();
    await limited(request('POST'), res);
    assert.deepEqual([res.statusCode, res.headers['Retry-After']], [429, '60']);

    const missing = jsonRoute(() => { throw Object.assign(new Error('ENOENT: /opt/x'), { code: 'ENOENT' }); },
      { mapError: e => e.code === 'ENOENT' ? Object.assign(new Error('Nicht gefunden.'), { status: 404 }) : null });
    res = fakeResponse();
    await missing(request('GET'), res);
    assert.deepEqual([res.statusCode, res.body], [404, { error: 'Nicht gefunden.' }]);
    assert.equal(errors.length, 1);
  } finally { console.error = original; }
});

test('escapeHtml maskiert alle HTML-Sonderzeichen', () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(0), '0');
});

test('isPathInside, resolveUnder und yearFromRelativeDir prüfen Pfade an einer Stelle', () => {
  const { isPathInside, resolveUnder, yearFromRelativeDir } = require('../lib/archive-files.cjs');
  const root = path.resolve(os.tmpdir(), 'archiv');
  assert.equal(isPathInside(root, path.join(root, 'Autor', 'a.md')), true);
  assert.equal(isPathInside(root, root), false, 'die Wurzel selbst liegt nicht „innerhalb“');
  assert.equal(isPathInside(root, path.join(root, '..', 'anderes')), false);
  assert.equal(isPathInside(root, root + '-nachbar'), false, 'gleicher Präfix, anderer Ordner');
  if (process.platform === 'win32') assert.equal(isPathInside(root, path.join(root.toUpperCase(), 'x')), true);

  assert.equal(resolveUnder(root, 'Autor', '2024'), path.join(root, 'Autor', '2024'));
  assert.equal(resolveUnder(root), root);
  assert.equal(resolveUnder(root, '..', 'x'), null);

  assert.equal(yearFromRelativeDir('2024'), '2024');
  assert.equal(yearFromRelativeDir(path.join('2019', 'orig', '2024')), '2024');
  assert.equal(yearFromRelativeDir('2024/orig'), '2024');
  assert.equal(yearFromRelativeDir('orig'), null);
  assert.equal(yearFromRelativeDir(''), null);
});
