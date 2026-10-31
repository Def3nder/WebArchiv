'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDirectoryCache, findSibling } = require('../server.js');
const { paginationParams } = require('../modules/articles.cjs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webarchiv-scan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Verzeichnis-Cache liest jedes Verzeichnis nur einmal, auch fehlende', t => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'a.mp3'), 'x');
  const missing = path.join(dir, 'gibt-es-nicht');
  const original = fs.readdirSync;
  let calls = 0;
  fs.readdirSync = (...args) => { calls++; return original.apply(fs, args); };
  t.after(() => { fs.readdirSync = original; });
  const cache = createDirectoryCache();
  for (let i = 0; i < 50; i++) {
    findSibling(dir, `artikel-${i}`, ['.mp3'], cache.get(dir));
    assert.equal(findSibling(missing, 'a', ['.mp3'], cache.get(missing)), null);
  }
  assert.equal(calls, 2);
  assert.equal(findSibling(dir, 'a', ['.mp3'], cache.get(dir)), path.join(dir, 'a.mp3'));
});

test('findSibling: exakter Name vor abweichender Schreibweise, Endungen in Reihenfolge', t => {
  const dir = tempDir(t);
  for (const name of ['Artikel.JPG', 'artikel.png', 'nur-gross.MP3', 'zweiter.jpeg', 'zweiter.jpg']) {
    fs.writeFileSync(path.join(dir, name), 'x');
  }
  const cache = createDirectoryCache();
  const listing = cache.get(dir);
  // Exakter Treffer (.png) schlägt die nur in der Schreibweise passende .jpg.
  assert.equal(findSibling(dir, 'artikel', ['.jpg', '.jpeg', '.png'], listing), path.join(dir, 'artikel.png'));
  // Ohne exakten Treffer greift der Vergleich ohne Groß-/Kleinschreibung mit dem echten Namen.
  assert.equal(findSibling(dir, 'NUR-GROSS', ['.mp3'], listing), path.join(dir, 'nur-gross.MP3'));
  // Reihenfolge der Endungen bleibt maßgeblich.
  assert.equal(findSibling(dir, 'zweiter', ['.jpg', '.jpeg', '.png'], listing), path.join(dir, 'zweiter.jpg'));
  assert.equal(findSibling(dir, 'fehlt', ['.jpg'], listing), null);
  assert.equal(findSibling(dir, 'artikel', ['.jpg'], null), null);
});

test('findSibling ignoriert Unterverzeichnisse, findet aber verlinkte Dateien', t => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'ordner.mp3'));
  fs.writeFileSync(path.join(dir, 'ziel.mp3'), 'x');
  let linked = true;
  try { fs.symlinkSync(path.join(dir, 'ziel.mp3'), path.join(dir, 'link.mp3')); } catch { linked = false; }
  const listing = createDirectoryCache().get(dir);
  assert.equal(findSibling(dir, 'ordner', ['.mp3'], listing), null);
  if (linked) assert.equal(findSibling(dir, 'link', ['.mp3'], listing), path.join(dir, 'link.mp3'));
});

test('Seitenparameter: ungültige Werte fallen auf Vorgaben zurück statt NaN', () => {
  assert.deepEqual(paginationParams(undefined, undefined), { page: 1, limit: 24 });
  assert.deepEqual(paginationParams('abc', 'xyz'), { page: 1, limit: 24 });
  assert.deepEqual(paginationParams('3', '48'), { page: 3, limit: 48 });
  assert.deepEqual(paginationParams('-2', '0'), { page: 1, limit: 24 });
  assert.deepEqual(paginationParams('2', '500'), { page: 2, limit: 100 });
  assert.deepEqual(paginationParams('2.9', '12abc'), { page: 2, limit: 12 });
});
