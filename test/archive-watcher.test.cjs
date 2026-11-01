'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createArchiveWatcher } = require('../lib/archive-watcher.cjs');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition, timeoutMs = 5000) => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) return false;
    await wait(25);
  }
  return true;
};

// Nachgebildetes fs.watch (je Ordner, nicht rekursiv): der Test löst Ereignisse selbst aus.
function fakeWatch({ failFor = [] } = {}) {
  const watchers = new Map();
  const watch = (dir, listener) => {
    if (failFor.includes(dir)) throw Object.assign(new Error(`EACCES: permission denied, watch '${dir}'`), { code: 'EACCES' });
    const watcher = Object.assign(new EventEmitter(), { closed: false, close() { this.closed = true; } });
    watcher.fire = filename => listener('rename', filename);
    watchers.set(dir, watcher);
    return watcher;
  };
  return { watch, watchers };
}

// Nachgebildetes Dateisystem für readdir/stat: Ordner als Set absoluter Pfade.
function fakeIo(dirs) {
  const dirent = name => ({ name, isDirectory: () => true });
  return {
    dirs,
    async readdir(dir) {
      if (!dirs.has(dir)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return [...dirs].filter(other => path.dirname(other) === dir && other !== dir).map(other => dirent(path.basename(other)));
    },
    async stat(target) {
      if (dirs.has(target)) return { isDirectory: () => true };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  };
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
    quietMs: 200, maxWaitMs: 5000, watch, io: fakeIo(new Set()),
  });
  assert.equal(await watcher.start(), 2);
  const www = watchers.get('/app/www');
  www.fire(path.join('Joe', '2026', 'a.md'));
  www.fire(path.join('Joe', '2026', 'a.md'));
  www.fire(path.join('Joe', '2026', '.a.md-1234.tmp'));
  www.fire(path.join('Joe', '2026', 'b.jpg.filepart'));
  www.fire(path.join('Infografiken', 'trash', '2026', 'x.md'));
  www.fire(path.join('lost+found', '#1234'));
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
    roots: [{ dir: '/app/www' }], onChange: changes => calls.push(changes), quietMs: 200, maxWaitMs: 300,
    watch, io: fakeIo(new Set()),
  });
  await watcher.start();
  const started = Date.now();
  for (let i = 0; i < 60 && !calls.length; i++) {
    watchers.get('/app/www').fire(`Joe/2026/datei-${i}.md`);
    await wait(25);
  }
  assert.equal(calls.length, 1);
  assert.ok(Date.now() - started < 1200, 'nicht endlos aufgeschoben');
  watcher.stop();
});

test('Watcher: echter Ordnerbaum ohne lost+found, Punkt-Ordner und Papierkorb; neuer Ordner kommt dazu', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-watcher-'));
  const wwwDir = path.join(root, 'www');
  for (const dir of ['Joe/2026', 'Infografiken/2026', 'Infografiken/trash/2026', 'lost+found', '.hidden/sub']) {
    fs.mkdirSync(path.join(wwwDir, dir), { recursive: true });
  }
  const calls = [];
  const watcher = createArchiveWatcher({
    roots: [{ dir: wwwDir, ignore: ([author, folder]) => author === 'Infografiken' && folder === 'trash' }],
    onChange: changes => calls.push(changes), quietMs: 100,
  });
  t.after(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(await watcher.start(), 1);
  assert.equal(watcher.directoryCount, 5, 'www, Joe, Joe/2026, Infografiken, Infografiken/2026');

  fs.writeFileSync(path.join(wwwDir, 'Joe', '2026', 'a.md'), 'Titel\n');
  assert.ok(await until(() => calls.length === 1), 'Änderung gemeldet');
  assert.ok(calls[0].includes('www/Joe/2026/a.md'), calls[0].join(', '));

  fs.mkdirSync(path.join(wwwDir, 'Joe', '2027', 'extra'), { recursive: true });
  assert.ok(await until(() => watcher.directoryCount === 7), `neuer Ordner überwacht (${watcher.directoryCount})`);
  await until(() => calls.length === 2);
  fs.writeFileSync(path.join(wwwDir, 'Joe', '2027', 'extra', 'neu.md'), 'Titel\n');
  assert.ok(await until(() => calls.some(changes => changes.includes('www/Joe/2027/extra/neu.md'))), 'Datei im neuen Unterordner');
});

test('Watcher: nicht überwachbarer Ordner nur im Log, gelöschter Ordner fällt heraus, Fehler und stop', async () => {
  const P = (...segments) => path.join(path.sep, 'app', ...segments);
  const io = fakeIo(new Set([P('www'), P('www', 'Joe'), P('www', 'Joe', '2026'), P('www', 'gesperrt')]));
  const { watch, watchers } = fakeWatch({ failFor: [P('www', 'gesperrt'), P('audio')] });
  const log = quiet();
  const calls = [];
  const watcher = createArchiveWatcher({
    roots: [{ dir: P('www') }, { dir: P('audio') }], onChange: changes => calls.push(changes), quietMs: 30, watch, io, log,
  });
  assert.equal(await watcher.start(), 1, 'www läuft, audio nicht');
  assert.equal(watcher.directoryCount, 3);
  assert.equal(log.messages.length, 2);
  assert.ok(log.messages[0].includes(P('www', 'gesperrt')) && /EACCES/.test(log.messages[0]), log.messages[0]);
  assert.ok(log.messages[1].includes(P('audio')), log.messages[1]);

  io.dirs.delete(P('www', 'Joe', '2026'));
  watchers.get(P('www', 'Joe')).fire('2026');
  assert.ok(await until(() => watcher.directoryCount === 2), 'gelöschter Ordner nicht mehr überwacht');
  assert.equal(watchers.get(P('www', 'Joe', '2026')).closed, true);

  watchers.get(P('www', 'Joe')).emit('error', new Error('inotify-Limit erreicht'));
  assert.match(log.messages[2], /beendet: inotify-Limit erreicht/);
  assert.equal(watcher.directoryCount, 1);

  watchers.get(P('www')).fire('Joe/a.md');
  watcher.stop();
  const before = calls.length;
  await wait(80);
  assert.deepEqual([calls.length, watchers.get(P('www')).closed], [before, true], 'stop verwirft Vorgemerktes');
});
