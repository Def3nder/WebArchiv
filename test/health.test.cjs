'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createHealthService, installHealthRoutes, diskLevel, lastCronRun } = require('../modules/health.cjs');
const { createEventLog } = require('../lib/event-log.cjs');
const { createArchiveLock } = require('../lib/archive-lock.cjs');

const GB = 1024 ** 3;
const NOW = new Date('2026-11-01T12:00:00').getTime();

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = {
    reindex: { running: false, done: true },
    lastRun: { at: NOW - 60000, durationMs: 800, fresh: false, unchanged: true, cacheHits: 7153, cacheMisses: 0 },
    disks: { '/www': { blocks: 1000, bavail: 500, bsize: 4096, frsize: GB }, '/audio': { blocks: 1000, bavail: 500, bsize: GB } },
    qwenCalls: 0,
    qwen: true,
    scrape: { running: false, startedAt: null, exitCode: null, error: null },
  };
  const eventLog = createEventLog({ now: () => NOW });
  const lock = createArchiveLock();
  const cronLogFile = path.join(dir, 'cron-scrape.log');
  let clock = NOW;
  const service = createHealthService({
    archive: { articles: new Array(7153), scanIssues: [] },
    audiobooks: { books: new Array(47) },
    reindexState: () => state.reindex,
    lastIndexRun: () => state.lastRun,
    archiveLock: lock,
    watcher: () => ({ enabled: true, active: true, roots: 2, directories: 174 }),
    eventLog,
    scrapeJob: { get state() { return state.scrape; } },
    cronLogFile,
    qwenAvailable: async () => { state.qwenCalls++; return state.qwen; },
    volumes: [{ name: 'www', dir: '/www' }, { name: 'audio', dir: '/audio' }],
    cspMode: 'enforce',
    startedAt: NOW - 3600 * 1000,
    statfs: async dir => {
      if (!state.disks[dir]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return state.disks[dir];
    },
    now: () => clock,
    ...overrides,
  });
  return { service, state, eventLog, lock, cronLogFile, setClock: value => { clock = value; } };
}

test('Speicher-Stufen: Fehler unter 2 GB oder 2 %, Warnung unter 10 GB oder 5 %', () => {
  // Die Volumes www und audio haben je 100 GB.
  assert.equal(diskLevel(15 * GB, 100 * GB), 'ok');
  assert.equal(diskLevel(9 * GB, 100 * GB), 'warning', 'unter 10 GB');
  assert.equal(diskLevel(1.5 * GB, 100 * GB), 'error', 'unter 2 GB');
  // Große Disks (lokal 1,8 TB): dort zählt der Anteil.
  assert.equal(diskLevel(171 * GB, 1862 * GB), 'ok', '9 % sind dort kein Problem');
  assert.equal(diskLevel(80 * GB, 1862 * GB), 'warning', 'unter 5 %');
  assert.equal(diskLevel(30 * GB, 1862 * GB), 'error', 'unter 2 %');
  assert.equal(diskLevel(0, 0), 'warning');
});

test('Letzter Cron-Scrape aus dem Ende von cron-scrape.log', async t => {
  const { cronLogFile } = setup(t);
  assert.equal(await lastCronRun(cronLogFile), null, 'Datei fehlt');
  fs.writeFileSync(cronLogFile, [
    '2026-10-31 04:10:00 Scraper exit 0',
    '2026-10-31 04:10:01 SIGHUP an nodeapp (PID 12) gesendet',
    'irgendeine Scraper-Ausgabe',
    '2026-11-01 04:10:00 Scraper exit 1',
    '2026-11-01 04:10:01 SIGHUP an nodeapp (PID 12) gesendet',
    '',
  ].join('\n'));
  assert.deepEqual(await lastCronRun(cronLogFile), { at: new Date('2026-11-01T04:10:00').getTime(), exitCode: 1 });
});

test('Status: startet ohne Index, ok, beeinträchtigt bei Indexfehler oder vollem Datenträger', async t => {
  const { service, state } = setup(t);
  assert.equal(await service.status(), 'ok');
  state.disks['/audio'].bavail = 10;
  assert.equal(await service.status(), 'degraded', 'audio unter 2 %');
  state.disks['/audio'].bavail = 500;
  state.reindex = { running: false, done: true, error: 'EIO' };
  assert.equal(await service.status(), 'degraded');
  state.reindex = { running: true, done: false };
  state.lastRun = null;
  assert.equal(await service.status(), 'starting');
  state.qwen = false;
  state.lastRun = { at: NOW };
  state.reindex = { running: false, done: true };
  assert.equal(await service.status(), 'ok', 'Qwen aus ist kein Ausfall');
});

test('Details: Index, Speicher, Dienste, Server, Meldungen und Gesamtstufe', async t => {
  const { service, state, eventLog, lock, cronLogFile, setClock } = setup(t);
  let details = await service.details();
  assert.equal(details.level, 'ok');
  assert.deepEqual([details.index.articles, details.index.audiobooks, details.index.busy, details.index.level], [7153, 47, null, 'ok']);
  // www rechnet mit frsize, audio (ohne frsize) mit bsize: je 1.000 GB gesamt, 500 GB frei.
  assert.deepEqual(details.disks.map(disk => [disk.name, disk.free / GB, disk.total / GB, disk.level]),
    [['www', 500, 1000, 'ok'], ['audio', 500, 1000, 'ok']]);
  assert.deepEqual([details.services.qwen.reachable, details.services.scrape.web, details.services.scrape.cron], [true, null, null]);
  assert.deepEqual([details.server.uptimeSeconds, details.server.cspMode], [3600, 'enforce']);

  state.disks['/audio'] = { blocks: 1000, bavail: 40, bsize: GB };
  assert.deepEqual([(await service.details()).disks[1].level, (await service.details()).level], ['warning', 'warning'], 'audio unter 5 %');
  state.disks['/audio'] = { blocks: 1000, bavail: 500, bsize: GB };
  const release = lock.tryAcquire('Infografiken ändern');
  state.scrape = { running: false, startedAt: NOW - 1000, exitCode: 0, error: null };
  fs.writeFileSync(cronLogFile, '2026-11-01 04:10:00 Scraper exit 0\n');
  details = await service.details();
  release();
  assert.equal(details.index.busy, 'Infografiken ändern');
  assert.deepEqual(details.disks.map(disk => disk.level), ['ok', 'ok']);
  assert.deepEqual([details.services.scrape.web.exitCode, details.services.scrape.cron.exitCode, details.services.scrape.level], [0, 0, 'ok']);
  assert.equal(details.level, 'ok');

  eventLog.record('warning', 'SESSION_SECRET fehlt');
  assert.equal((await service.details()).level, 'warning');
  eventLog.record('error', 'Datei kaputt');
  details = await service.details();
  assert.deepEqual([details.events.level, details.level, details.events.entries.length], ['error', 'error', 2]);
  setClock(NOW + 2 * 24 * 3600 * 1000);
  assert.equal((await service.details()).events.level, 'ok', 'Meldungen älter als 24 h färben die Ampel nicht');
});

test('Details: Qwen 60 s gemerkt, Watcher, nicht lesbare Dateien, Scrape-Fehler, Datenträger fehlt', async t => {
  let watcherState = { enabled: true, active: false, roots: 0, directories: 0 };
  const { service, state, cronLogFile, setClock } = setup(t, { watcher: () => watcherState });
  await service.details();
  await service.details();
  assert.equal(state.qwenCalls, 1, 'innerhalb von 60 s nicht erneut fragen');
  setClock(NOW + 61 * 1000);
  state.qwen = false;
  let details = await service.details();
  assert.deepEqual([state.qwenCalls, details.services.qwen.level], [2, 'warning']);
  assert.equal(details.index.level, 'warning', 'Watcher sollte laufen, läuft aber nicht');
  watcherState = { enabled: false, active: false, roots: 0, directories: 0 };
  assert.equal((await service.details()).index.level, 'ok', 'bewusst abgeschaltet');

  fs.writeFileSync(cronLogFile, '2026-11-01 04:10:00 Scraper exit 2\n');
  delete state.disks['/audio'];
  details = await service.details();
  assert.equal(details.services.scrape.level, 'error');
  assert.deepEqual([details.disks[1].level, details.disks[1].error], ['warning', 'ENOENT']);
});

test('Routen: öffentlich nur der Status, Details und Meldungen nur für Admins', async t => {
  const { service, state, eventLog } = setup(t);
  const app = express();
  app.use(express.json());
  const requireAdmin = (req, res, next) => (req.get('x-admin') === '1' ? next() : res.status(403).json({ code: 'admin_required' }));
  installHealthRoutes(app, { requireAdmin, service, eventLog });
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (url, { admin = false, method = 'GET' } = {}) => {
    const res = await fetch(base + url, { method, headers: admin ? { 'x-admin': '1' } : {} });
    return { status: res.status, cache: res.headers.get('cache-control'), data: await res.json() };
  };

  let res = await call('/api/health');
  assert.deepEqual([res.status, res.cache, res.data], [200, 'no-store', { status: 'ok' }]);
  state.lastRun = null;
  res = await call('/api/health');
  assert.deepEqual([res.status, res.data], [503, { status: 'starting' }]);

  assert.equal((await call('/api/health/details')).status, 403);
  res = await call('/api/health/details', { admin: true });
  assert.deepEqual([res.status, res.data.index.articles, res.data.disks.length], [200, 7153, 2]);

  eventLog.record('error', 'Erster Fehler');
  const seen = eventLog.lastId;
  eventLog.record('error', 'Zweiter Fehler');
  assert.equal((await call(`/api/health/events?after=${seen}`)).status, 403);
  res = await call(`/api/health/events?after=${seen}`, { admin: true });
  assert.deepEqual([res.data.newErrors, res.data.latest.message, res.data.lastId], [1, 'Zweiter Fehler', eventLog.lastId]);
  res = await call('/api/health/events?after=abc', { admin: true });
  assert.equal(res.data.newErrors, 2, 'ungültiges after zählt ab 0');

  assert.equal((await call('/api/health/events/clear', { method: 'POST' })).status, 403);
  res = await call('/api/health/events/clear', { admin: true, method: 'POST' });
  assert.deepEqual([res.status, res.data.ok, eventLog.list().length], [200, true, 0]);
});
