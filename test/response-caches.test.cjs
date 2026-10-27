const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createVersionedIndex, createAppShellVersion, computeAppShellVersion } = require('../lib/app-shell.cjs');
const { createArticleBodyCache } = require('../lib/article-body-cache.cjs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webarchiv-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// Änderungszeit ausdrücklich setzen, damit der Test nicht von der Zeitauflösung abhängt.
function touch(file, content, seconds) {
  fs.writeFileSync(file, content);
  fs.utimesSync(file, seconds, seconds);
}

test('index.html bekommt automatische ?v=-Versionen aus dem Dateiinhalt', t => {
  const dir = tempDir(t);
  const index = path.join(dir, 'index.html');
  touch(index, '<link rel="stylesheet" href="styles.css" />\n<script src="app.js?v=7"></script>\n'
    + '<script src="https://cdn.example/x.js"></script>\n<link rel="icon" href="favicon.ico" />', 1000);
  touch(path.join(dir, 'styles.css'), 'body {}', 1000);
  touch(path.join(dir, 'app.js'), 'const a = 1;', 1000);
  let builds = 0;
  const shell = createVersionedIndex(index, html => { builds++; return html; });

  const first = shell();
  const appVersion = first.match(/app\.js\?v=([a-f0-9]{10})"/)?.[1];
  assert.ok(appVersion, 'handgepflegte Nummer wird durch den Hash ersetzt');
  assert.match(first, /href="styles\.css\?v=[a-f0-9]{10}"/);
  assert.match(first, /src="https:\/\/cdn\.example\/x\.js"/, 'externe Skripte bleiben unverändert');
  assert.match(first, /href="favicon\.ico"/, 'nur JS und CSS werden versioniert');
  assert.equal(shell(), first);
  assert.equal(builds, 1, 'ohne Änderung kein Neuaufbau');

  touch(path.join(dir, 'app.js'), 'const a = 2;', 2000);
  const second = shell();
  assert.notEqual(second.match(/app\.js\?v=([a-f0-9]{10})"/)[1], appVersion);
  assert.equal(second.match(/styles\.css\?v=([a-f0-9]{10})"/)[1], first.match(/styles\.css\?v=([a-f0-9]{10})"/)[1]);
  assert.equal(builds, 2);
});

test('index.html enthält keine handgepflegten ?v=-Nummern mehr', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /\.(?:js|css)\?v=/);
});

test('App-Shell-Version wird nur bei geänderten Dateien neu berechnet und stimmt mit der direkten Berechnung überein', t => {
  const dir = tempDir(t);
  touch(path.join(dir, 'index.html'), '<script src="app.js"></script>', 1000);
  touch(path.join(dir, 'app.js'), 'const version = 1;', 1000);
  const version = createAppShellVersion(dir);
  const first = version();
  assert.equal(first, computeAppShellVersion(dir));
  assert.equal(version(), first);
  touch(path.join(dir, 'app.js'), 'const version = 2;', 2000);
  const second = version();
  assert.notEqual(second, first);
  assert.equal(second, computeAppShellVersion(dir));
  touch(path.join(dir, 'neu.css'), 'body {}', 2000);
  assert.notEqual(version(), second);
});

test('Artikeltext-Cache rendert nur nach Dateiänderung neu und verdrängt die ältesten Einträge', async t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'a.md');
  touch(file, 'Titel\nDatum: 2026-01-01\n\n----\n\nErster **Text**', 1000);
  let reads = 0;
  const io = { stat: fsp.stat, readFile: (...args) => { reads++; return fsp.readFile(...args); } };
  const cache = createArticleBodyCache({ maxEntries: 2, io });
  const first = await cache.get(file);
  assert.match(first.bodyHtml, /<strong>Text<\/strong>/);
  await cache.get(file);
  assert.equal(reads, 1);
  touch(file, 'Titel\nDatum: 2026-01-01\n\n----\n\nZweiter Text', 2000);
  assert.match((await cache.get(file)).bodyHtml, /Zweiter Text/);
  assert.equal(reads, 2);

  for (const name of ['b.md', 'c.md']) {
    touch(path.join(dir, name), `Titel\nDatum: 2026-01-01\n\n----\n\n${name}`, 1000);
    await cache.get(path.join(dir, name));
  }
  assert.equal(cache.size, 2);
  await cache.get(file);
  assert.equal(reads, 5, 'a.md wurde verdrängt und muss neu gelesen werden');
});

test('Artikeltext-Cache bereinigt das HTML weiterhin', async t => {
  const file = path.join(tempDir(t), 'x.md');
  touch(file, 'Titel\nDatum: 2026-01-01\n\n----\n\n<script>alert(1)</script><img src=x onerror=alert(1)>', 1000);
  const { bodyHtml } = await createArticleBodyCache().get(file);
  assert.doesNotMatch(bodyHtml, /<script|onerror/i);
});
