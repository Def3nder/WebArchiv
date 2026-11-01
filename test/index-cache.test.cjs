'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIndexCache, indexCacheVersion } = require('../lib/index-cache.cjs');
const { createArticleScanner, parseArticleContent } = require('../lib/article-scan.cjs');
const { buildDuplicateProfile } = require('../lib/duplicates.cjs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'index-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const quietLog = () => {
  const messages = [];
  return { messages, log: (...args) => messages.push(args.join(' ')), warn: (...args) => messages.push(args.join(' ')) };
};

const CONTENT = 'Titel\n\nDatum: 2026-01-05\nZusammenfassung: Kurz.\n\n****\n\nEin Text über Achtsamkeit, der lang genug ist, um Wortfolgen zu bilden.\n';

test('Index-Cache: speichern, laden, Sets wiederherstellen, dasselbe Objekt je Datei', async t => {
  const file = path.join(tempDir(t), 'index-cache.json');
  const parsed = parseArticleContent(CONTENT, '/a.md', { duplicateProfile: true });
  const signature = { size: 120, mtimeMs: 1730000000123.456 };

  const first = createIndexCache({ file, version: 'v1' });
  await first.load();
  assert.equal(first.get('Joe/a.md', signature), null);
  first.set('Joe/a.md', signature, parsed);
  assert.equal(await first.save(), true);
  assert.equal(await first.save(), false, 'unverändert: nicht erneut schreiben');

  const second = createIndexCache({ file, version: 'v1' });
  await second.load();
  const revived = second.get('Joe/a.md', signature);
  assert.ok(revived);
  assert.equal(second.get('Joe/a.md', signature), revived, 'dasselbe Objekt (Dublettenerkennung prüft Identität)');
  const fresh = buildDuplicateProfile('Titel', 'Ein Text über Achtsamkeit, der lang genug ist, um Wortfolgen zu bilden.');
  assert.deepEqual(revived.duplicateProfile, fresh);
  assert.ok(revived.duplicateProfile.shingles instanceof Set && revived.duplicateProfile.titleTokens instanceof Set);
  const { duplicateProfile, ...rest } = revived;
  const { duplicateProfile: _ignored, ...expected } = parsed;
  assert.deepEqual(rest, expected);

  assert.equal(second.get('Joe/a.md', { ...signature, mtimeMs: signature.mtimeMs + 1 }), null, 'andere Änderungszeit');
  assert.equal(second.get('Joe/a.md', { ...signature, size: 121 }), null, 'andere Größe');
  assert.deepEqual(second.stats, { hits: 2, misses: 2, entries: 1 });
});

test('Index-Cache: andere Version oder kaputte Datei ergeben einen leeren Cache', async t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'index-cache.json');
  const signature = { size: 1, mtimeMs: 2 };
  const writer = createIndexCache({ file, version: 'alt' });
  writer.set('x.md', signature, parseArticleContent(CONTENT, '/x.md'));
  await writer.save();

  const quiet = quietLog();
  const other = createIndexCache({ file, version: 'neu', log: quiet });
  await other.load();
  assert.equal(other.get('x.md', signature), null);
  assert.match(quiet.messages[0], /anderen Parser-Version/);

  fs.writeFileSync(file, '{ kaputt');
  const broken = createIndexCache({ file, version: 'alt', log: quiet });
  await broken.load();
  assert.equal(broken.get('x.md', signature), null);
  assert.match(quiet.messages[1], /nicht lesbar/);
});

test('Index-Cache: nach einem vollständigen Scan bleiben nur gesehene Dateien', async t => {
  const file = path.join(tempDir(t), 'index-cache.json');
  const cache = createIndexCache({ file, version: 'v1' });
  const signature = { size: 1, mtimeMs: 2 };
  cache.set('bleibt.md', signature, parseArticleContent(CONTENT, '/b.md'));
  cache.set('geloescht.md', signature, parseArticleContent(CONTENT, '/g.md'));
  await cache.save();

  cache.beginFullScan();
  assert.ok(cache.get('bleibt.md', signature));
  assert.equal(await cache.save(), true, 'Löschung muss geschrieben werden');
  const reloaded = createIndexCache({ file, version: 'v1' });
  await reloaded.load();
  assert.deepEqual([reloaded.get('bleibt.md', signature) !== null, reloaded.get('geloescht.md', signature)], [true, null]);
});

test('Versionskennung ändert sich mit dem Parser-Quelltext und den Zusatzangaben', t => {
  const dir = tempDir(t);
  const source = path.join(dir, 'parser.cjs');
  fs.writeFileSync(source, 'eins');
  const base = indexCacheVersion({ blogAuthor: 'Joe' }, [source]);
  assert.equal(indexCacheVersion({ blogAuthor: 'Joe' }, [source]), base);
  assert.notEqual(indexCacheVersion({ blogAuthor: 'Anna' }, [source]), base);
  fs.writeFileSync(source, 'zwei');
  assert.notEqual(indexCacheVersion({ blogAuthor: 'Joe' }, [source]), base);
  assert.match(indexCacheVersion(), /^[0-9a-f]{64}$/, 'Standardquellen sind lesbar');
});

test('Scan mit Cache: unveränderte Dateien nicht neu parsen, Medien trotzdem frisch', async t => {
  const dir = tempDir(t);
  const wwwDir = path.join(dir, 'www');
  const yearDir = path.join(wwwDir, 'Joe', '2026');
  fs.mkdirSync(yearDir, { recursive: true });
  fs.writeFileSync(path.join(yearDir, 'a.md'), CONTENT);
  fs.writeFileSync(path.join(yearDir, 'b.md'), CONTENT.replace('Titel', 'Zweiter'));
  const file = path.join(dir, 'index-cache.json');

  const scan = async cache => {
    const { scanDir } = createArticleScanner({
      wwwDir, audioDir: path.join(dir, 'audio'), trashDir: path.join(wwwDir, 'trash'),
      wantsDuplicateProfile: () => true, cache,
    });
    const collector = [];
    cache.beginFullScan();
    await scanDir(path.join(wwwDir, 'Joe'), 'Joe', null, collector);
    await cache.save();
    return new Map(collector.map(entry => [entry.id, entry]));
  };

  const cache = createIndexCache({ file, version: 'v1' });
  await cache.load();
  const first = await scan(cache);
  assert.deepEqual(cache.stats, { hits: 0, misses: 2, entries: 2 });

  fs.writeFileSync(path.join(yearDir, 'a.jpg'), 'bild');
  const second = await scan(cache);
  assert.deepEqual(cache.stats, { hits: 2, misses: 0, entries: 2 });
  assert.equal(second.get('Joe/2026/a').duplicateProfile, first.get('Joe/2026/a').duplicateProfile);
  assert.match(second.get('Joe/2026/a').imageUrl, /a\.jpg\?v=\d+$/, 'neues Bild trotz Cache-Treffer');
  assert.equal(second.get('Joe/2026/a').ownImage, true);

  // Nach einem Neustart (neue Instanz) liest der Cache aus der Datei; eine geänderte Datei wird neu geparst.
  const changed = path.join(yearDir, 'b.md');
  fs.writeFileSync(changed, CONTENT.replace('Titel', 'Geänderter Titel'));
  const restarted = createIndexCache({ file, version: 'v1' });
  await restarted.load();
  const third = await scan(restarted);
  assert.deepEqual(restarted.stats, { hits: 1, misses: 1, entries: 2 });
  assert.equal(third.get('Joe/2026/b').title, 'Geänderter Titel');
  assert.deepEqual(third.get('Joe/2026/a').categories, first.get('Joe/2026/a').categories);

  fs.rmSync(changed);
  await scan(restarted);
  assert.equal(restarted.stats.entries, 1, 'gelöschte Datei fliegt aus dem Cache');
});
