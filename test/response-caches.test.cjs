const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { cachedTextFile, createAppShellVersion, computeAppShellVersion } = require('../lib/app-shell.cjs');
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

test('cachedTextFile liest und transformiert nur nach einer Änderung neu', t => {
  const file = path.join(tempDir(t), 'index.html');
  touch(file, 'eins', 1000);
  let calls = 0;
  const read = cachedTextFile(file, text => { calls++; return text.toUpperCase(); });
  assert.equal(read(), 'EINS');
  assert.equal(read(), 'EINS');
  assert.equal(calls, 1);
  touch(file, 'zwei', 2000);
  assert.equal(read(), 'ZWEI');
  assert.equal(calls, 2);
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
