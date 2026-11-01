'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createEventLog, createLogTail, parseScraperLogLine, parseCronLogLine, splitMessage,
} = require('../lib/event-log.cjs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Meldungen: gleiche zusammengefasst, neueste zuerst, „seit id“ zählt Wiederholungen mit', () => {
  let clock = 1000;
  const log = createEventLog({ now: () => clock });
  log.record('error', 'Datei kaputt\n    at stack (x.js:1)');
  clock = 2000;
  log.record('warning', 'Langsam');
  const seen = log.lastId;
  clock = 3000;
  log.record('error', 'Datei kaputt\n    at stack (x.js:1)');

  const [first, second] = log.list();
  assert.deepEqual([first.message, first.count, first.firstAt, first.lastAt, first.detail],
    ['Datei kaputt', 2, 1000, 3000, 'at stack (x.js:1)']);
  assert.equal(second.message, 'Langsam');
  assert.deepEqual(log.list({ after: seen }).map(entry => entry.message), ['Datei kaputt'], 'Wiederholung gilt als neu');
  assert.deepEqual(log.summary(seen), { lastId: log.lastId, newErrors: 2, latest: log.list({ after: seen })[0] });
  assert.equal(log.summary(log.lastId).newErrors, 0);
  assert.throws(() => log.record('info', 'x'), /Unbekannte Stufe/);
  log.clear();
  assert.deepEqual(log.list(), []);
});

test('Meldungen: höchstens maxEntries, gekürzte Texte, leere Meldung', () => {
  const log = createEventLog({ maxEntries: 3 });
  for (let i = 1; i <= 5; i++) log.record('error', `Fehler ${i}`);
  assert.deepEqual(log.list().map(entry => entry.message), ['Fehler 5', 'Fehler 4', 'Fehler 3']);
  const { message, detail } = splitMessage(`${'x'.repeat(400)}\n${'y'.repeat(3000)}`);
  assert.deepEqual([message.length, detail.length], [300, 2000]);
  assert.equal(splitMessage('   ').message, '(leere Meldung)');
});

test('Meldungen: Konsole erfassen, Ausgabe bleibt, Wiederherstellen', () => {
  const printed = [];
  const fakeConsole = { error: (...args) => printed.push(['error', ...args]), warn: (...args) => printed.push(['warn', ...args]) };
  const log = createEventLog();
  const restore = log.captureConsole(fakeConsole);
  fakeConsole.error('Artikel %s:', 'Joe/a', new Error('ENOENT'));
  fakeConsole.warn('Watcher beendet');
  assert.equal(printed.length, 2, 'Journal-Ausgabe bleibt');
  assert.deepEqual(log.list().map(entry => [entry.level, entry.message]), [
    ['warning', 'Watcher beendet'], ['error', 'Artikel Joe/a: Error: ENOENT'],
  ]);
  restore();
  fakeConsole.error('nach dem Wiederherstellen');
  assert.equal(log.list().length, 2);
});

test('Meldungen: speichern, laden und frühe Meldungen zusammenführen', async t => {
  const file = path.join(tempDir(t), 'health-events.json');
  const first = createEventLog({ file, saveDelayMs: 10 });
  first.record('error', 'Alt');
  first.record('warning', 'SESSION_SECRET fehlt');
  first.source('scrapeLog', { offset: 42, ino: 7 });
  assert.equal(await first.flush(), true);
  assert.equal(await first.flush(), false, 'unverändert: nicht erneut schreiben');

  const second = createEventLog({ file });
  second.record('warning', 'SESSION_SECRET fehlt');
  second.record('error', 'Neu beim Start');
  await second.load();
  assert.deepEqual(second.list().map(entry => [entry.message, entry.count]), [
    ['Neu beim Start', 1], ['SESSION_SECRET fehlt', 2], ['Alt', 1],
  ]);
  assert.deepEqual(second.source('scrapeLog'), { offset: 42, ino: 7 });
  assert.ok(second.lastId > first.lastId);

  fs.writeFileSync(file, '{ kaputt');
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(message);
  try {
    const broken = createEventLog({ file });
    await broken.load();
    assert.deepEqual(broken.list(), []);
  } finally { console.warn = originalWarn; }
  assert.match(warnings[0], /nicht geladen/);
});

test('Zeilen erkennen: Scraper-Fehler und Cron-Skript', () => {
  assert.deepEqual(parseScraperLogLine('2026-09-22 17:47:42 [ERROR] [FEHLER] facebook abgebrochen'),
    { level: 'error', message: '[FEHLER] facebook abgebrochen', at: new Date('2026-09-22T17:47:42').getTime() });
  assert.equal(parseScraperLogLine('2026-10-21 19:07:35 [WARN] kein HTML/GraphQL-Treffer'), null);
  assert.equal(parseScraperLogLine('Browser logs:'), null);
  assert.equal(parseCronLogLine('2026-11-01 04:10:00 Scraper exit 0'), null);
  assert.equal(parseCronLogLine('2026-11-01 04:10:00 Scraper exit 1').message, 'Cron-Scrape mit Exit-Code 1 beendet');
  assert.equal(parseCronLogLine('2026-11-01 04:10:01 FEHLER: SIGHUP an nodeapp nicht gesendet (MainPID \'0\')').message,
    'Cron-Skript: SIGHUP an nodeapp nicht gesendet (MainPID \'0\')');
  assert.equal(parseCronLogLine('2026-11-01 04:10:01 SIGHUP an nodeapp (PID 12) gesendet'), null);
});

test('Log-Datei: erst ab Dateiende, dann nur Neues, halbe Zeilen warten, geleerte Datei von vorn', async t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'scrape_all.log');
  const log = createEventLog();
  const poll = createLogTail({ name: 'scrapeLog', file, eventLog: log, parse: parseScraperLogLine, source: 'scraper' });

  assert.equal(await poll(), 0, 'Datei fehlt');
  fs.writeFileSync(file, '2026-09-22 17:47:42 [ERROR] uralt\n');
  assert.equal(await poll(), 0, 'erster Lauf: alte Fehler ignorieren');

  fs.appendFileSync(file, '2026-11-01 04:00:00 [INFO] los\n2026-11-01 04:01:00 [ERROR] Größe falsch\n2026-11-01 04:02:00 [ERR');
  assert.equal(await poll(), 1);
  assert.deepEqual(log.list().map(entry => [entry.source, entry.message]), [['scraper', 'Größe falsch']]);

  fs.appendFileSync(file, 'OR] halbe Zeile fertig\n');
  assert.equal(await poll(), 1, 'unvollständige Zeile beim zweiten Mal gelesen');
  assert.equal(log.list()[0].message, 'halbe Zeile fertig');
  assert.equal(await poll(), 0, 'nichts Neues');

  fs.writeFileSync(file, '2026-11-02 04:01:00 [ERROR] nach dem Leeren\n');
  assert.equal(await poll(), 1, 'kürzer geworden: von vorn');
  assert.equal(log.list()[0].message, 'nach dem Leeren');
});
