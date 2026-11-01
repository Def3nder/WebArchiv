'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createArchiveWatcher } = require('../lib/archive-watcher.cjs');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Nachgebildetes fs.watch: der Test löst Ereignisse selbst aus.
function fakeWatch({ failFor = [] } = {}) {
  const watchers = new Map();
  const watch = (dir, options, listener) => {
    if (failFor.includes(dir)) throw Object.assign(new Error(`ENOENT: ${dir}`), { code: 'ENOENT' });
    assert.deepEqual(options, { recursive: true });
    const watcher = Object.assign(new EventEmitter(), { closed: false, close() { this.closed = true; } });
    watcher.fire = filename => listener('rename', filename);
    watchers.set(dir, watcher);
    return watcher;
  };
  return { watch, watchers };
}

const quiet = () => {
  const messages = [];
  return { messages, warn: message => messages.push(message) };
};

test('Watcher: bündelt Ereignisse bis zur Ruhe und ignoriert Temp-, Teil- und Papierkorbdateien', async () => {
  const { watch, watchers } = fakeWatch();
  const calls = [];
  const watcher = createArchiveWatcher({
    roots: [
      { dir: '/app/www', ignore: ([author, folder]) => author === 'Infografiken' && folder === 'trash' },
      { dir: '/app/audio' },
    ],
    onChange: changes => calls.push(changes),
    quietMs: 200, maxWaitMs: 5000, watch,
  });
  assert.equal(watcher.start(), 2);
  const www = watchers.get('/app/www');
  www.fire(path.join('Joe', '2026', 'a.md'));
  www.fire(path.join('Joe', '2026', 'a.md'));
  www.fire(path.join('Joe', '2026', '.a.md-1234.tmp'));
  www.fire(path.join('Joe', '2026', 'b.jpg.filepart'));
  www.fire(path.join('Infografiken', 'trash', '2026', 'x.md'));
  watchers.get('/app/audio').fire(null);
  await wait(100);
  www.fire('Joe/2026/a.jpg');
  await wait(100);
  assert.equal(calls.length, 0, 'noch keine Ruhe');
  await wait(300);
  assert.deepEqual(calls, [['www/Joe/2026/a.md', 'audio/?', 'www/Joe/2026/a.jpg']]);

  www.fire(path.join('.trash', 'x'));
  await wait(300);
  assert.equal(calls.length, 1, 'nur Ignoriertes: keine Meldung');
  watcher.stop();
});

test('Watcher: spätestens nach maxWaitMs, auch wenn ständig Neues kommt', async () => {
  const { watch, watchers } = fakeWatch();
  const calls = [];
  const watcher = createArchiveWatcher({
    roots: [{ dir: '/app/www' }], onChange: changes => calls.push(changes), quietMs: 200, maxWaitMs: 300, watch,
  });
  watcher.start();
  const started = Date.now();
  for (let i = 0; i < 60 && !calls.length; i++) {
    watchers.get('/app/www').fire(`Joe/2026/datei-${i}.md`);
    await wait(25);
  }
  assert.equal(calls.length, 1);
  assert.ok(Date.now() - started < 1200, 'nicht endlos aufgeschoben');
  watcher.stop();
});

test('Watcher: fehlender Ordner und Laufzeitfehler nur im Log, stop() räumt auf', async () => {
  const { watch, watchers } = fakeWatch({ failFor: ['/app/audio'] });
  const log = quiet();
  const calls = [];
  const watcher = createArchiveWatcher({
    roots: [{ dir: '/app/www' }, { dir: '/app/audio' }], onChange: changes => calls.push(changes),
    quietMs: 30, watch, log,
  });
  assert.equal(watcher.start(), 1);
  assert.match(log.messages[0], /audio nicht gestartet: ENOENT/);

  const www = watchers.get('/app/www');
  www.fire('Joe/2026/a.md');
  watcher.stop();
  await wait(60);
  assert.deepEqual([calls.length, www.closed], [0, true], 'stop verwirft Vorgemerktes');

  const again = createArchiveWatcher({ roots: [{ dir: '/app/www' }], onChange: () => {}, watch, log });
  again.start();
  watchers.get('/app/www').emit('error', new Error('inotify-Limit erreicht'));
  assert.match(log.messages[1], /beendet: inotify-Limit erreicht/);
  assert.equal(watchers.get('/app/www').closed, true);
});

test('Watcher mit echtem fs.watch: neue Datei in einem Unterordner wird gemeldet', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-watcher-'));
  const wwwDir = path.join(root, 'www');
  fs.mkdirSync(path.join(wwwDir, 'Joe', '2026'), { recursive: true });
  let resolveChange;
  const changed = new Promise(resolve => { resolveChange = resolve; });
  const watcher = createArchiveWatcher({ roots: [{ dir: wwwDir }], onChange: resolveChange, quietMs: 50 });
  t.after(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(watcher.start(), 1);
  await wait(50);
  fs.writeFileSync(path.join(wwwDir, 'Joe', '2026', 'neu.md'), 'Titel\n');
  const changes = await Promise.race([changed, wait(5000).then(() => null)]);
  assert.ok(changes, 'Änderung innerhalb von 5 s gemeldet');
  assert.ok(changes.some(change => change.endsWith('neu.md')), changes.join(', '));
});
