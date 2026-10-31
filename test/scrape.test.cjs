'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createScrapeJob, installScrapeRoutes } = require('../modules/scrape.cjs');
const { createArchiveLock } = require('../lib/archive-lock.cjs');
const { SCRAPER_CHANGED_FILES_MARKER } = require('../lib/article-index.cjs');

// Nachgebildeter Kindprozess: Ausgabe und Ende steuert der Test.
function fakeSpawn() {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    calls.push({ command, args, options, child });
    return child;
  };
  return { spawn, calls };
}

function scrapeJob(overrides = {}) {
  const runs = { reindex: 0, refreshed: [] };
  const { spawn, calls } = fakeSpawn();
  const job = createScrapeJob({
    scraperDir: path.join('/app', 'scraper'),
    reindex: async () => { runs.reindex += 1; },
    refreshFiles: async files => { runs.refreshed.push(files); },
    reindexRunning: () => false,
    spawn,
    ...overrides,
  });
  return { job, runs, calls };
}

// Die Ausgabe des Kindprozesses spiegelt das Modul ins Dienst-Log; im Test stumm.
function quietly(fn) {
  const out = process.stdout.write;
  const err = process.stderr.write;
  const log = console.log;
  const error = console.error;
  const logged = [];
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  console.log = () => {};
  console.error = (...args) => logged.push(args);
  return Promise.resolve().then(fn).finally(() => {
    process.stdout.write = out;
    process.stderr.write = err;
    console.log = log;
    console.error = error;
  }).then(() => logged);
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('Scrape: Quellen filtern, Aufruf im Scraper-Ordner, Manifest liest nur geänderte Artikel neu', () => quietly(async () => {
  const { job, runs, calls } = scrapeJob();
  assert.equal(job.running, false);
  const started = job.start(['facebook', 'unbekannt', 'telegram']);
  assert.deepEqual(started, { started: true, sources: ['facebook', 'telegram'] });
  assert.equal(job.running, true);
  const [{ command, args, options, child }] = calls;
  assert.equal(command, process.execPath);
  assert.deepEqual(args, [path.join('/app', 'scraper', 'scrape_all.js'), '--facebook', '--telegram']);
  assert.equal(options.cwd, path.join('/app', 'scraper'));

  child.stdout.emit('data', Buffer.from('2 neue Beiträge\n'));
  child.stdout.emit('data', Buffer.from(`${SCRAPER_CHANGED_FILES_MARKER}["/app/www/a.md"]\nFertig\n`));
  child.emit('close', 0);
  await settle();
  assert.equal(job.running, false);
  assert.deepEqual([job.state.done, job.state.exitCode], [true, 0]);
  assert.equal(job.state.output, '2 neue Beiträge\nFertig\n');
  assert.deepEqual(runs, { reindex: 0, refreshed: [['/app/www/a.md']] });
}));

test('Scrape: ohne Angabe alle Quellen, ohne Manifest vollständiger Reindex, Ausgabe gekappt', () => quietly(async () => {
  const { job, runs, calls } = scrapeJob();
  assert.deepEqual(job.start(undefined).sources, ['blog', 'facebook', 'telegram']);
  assert.deepEqual(calls[0].args.slice(1), []);
  calls[0].child.stderr.emit('data', 'x'.repeat(25000));
  assert.equal(job.state.output.length, 20000);
  calls[0].child.emit('close', 1);
  await settle();
  assert.deepEqual(runs, { reindex: 1, refreshed: [] });
}));

test('Scrape: Startfehler, laufender Reindex und gescheitertes gezieltes Einlesen', async () => {
  const failed = scrapeJob();
  await quietly(() => {
    failed.job.start([]);
    failed.calls[0].child.emit('error', new Error('spawn ENOENT'));
  });
  assert.deepEqual([failed.job.running, failed.job.state.exitCode, failed.job.state.error], [false, -1, 'spawn ENOENT']);

  const busy = scrapeJob({ reindexRunning: () => true });
  await quietly(async () => {
    busy.job.start([]);
    busy.calls[0].child.emit('close', 0);
    await settle();
  });
  assert.deepEqual(busy.runs, { reindex: 0, refreshed: [] });

  const broken = scrapeJob({ refreshFiles: async () => { throw new Error('ungültiger Pfad'); } });
  const logged = await quietly(async () => {
    broken.job.start([]);
    broken.calls[0].child.stdout.emit('data', `${SCRAPER_CHANGED_FILES_MARKER}["/app/www/a.md"]\n`);
    broken.calls[0].child.emit('close', 0);
    await settle();
  });
  assert.equal(broken.runs.reindex, 1, 'Fallback: vollständiger Reindex');
  assert.match(String(logged[0][0]), /Gezielter Scraper-Reindex fehlgeschlagen/);
});

test('Scrape-Routen: Sperre antwortet 409 mit started: false, Status und Log ohne Zwischenspeicher', async t => {
  const scraperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrape-'));
  t.after(() => fs.rmSync(scraperDir, { recursive: true, force: true }));
  const lock = createArchiveLock();
  let tts = true;
  lock.register('Audio-Erzeugung', () => tts);
  const { job, calls } = scrapeJob({ scraperDir });
  lock.register('Scraper-Lauf', () => job.running);

  const app = express();
  app.use(express.json());
  installScrapeRoutes(app, { requireAdmin: (_req, _res, next) => next(), job, lock });
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = () => fetch(`${base}/api/scrape`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sources: ['blog'] }),
  });

  let res = await post();
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { started: false, error: 'Es läuft bereits: Audio-Erzeugung. Bitte später erneut versuchen.' });
  assert.equal(calls.length, 0);

  tts = false;
  await quietly(async () => {
    res = await post();
    assert.deepEqual([res.status, await res.json()], [200, { started: true, sources: ['blog'] }]);
    res = await post();
    assert.equal(res.status, 409, 'der laufende Scrape belegt die Sperre');
    calls[0].child.emit('close', 0);
    await settle();
  });

  res = await fetch(`${base}/api/scrape/status`);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const status = await res.json();
  assert.deepEqual([status.running, status.done, status.exitCode, status.sources], [false, true, 0, ['blog']]);

  res = await fetch(`${base}/api/scrape/log`);
  assert.deepEqual(await res.json(), { text: '(keine Logdatei gefunden)' });
  fs.writeFileSync(path.join(scraperDir, 'scrape_all.log'), Array.from({ length: 150 }, (_, i) => `Zeile ${i}`).join('\n'));
  res = await fetch(`${base}/api/scrape/log`);
  const { text } = await res.json();
  assert.deepEqual([text.split('\n').length, text.split('\n')[0]], [100, 'Zeile 50']);
});
