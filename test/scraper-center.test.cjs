'use strict';

// Scraper-Zentrale: Prüfen neuer Quellen, Cookie-Ablauf, notwendige Aktionen und die Admin-Routen.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const {
  sourceEntry, cookieExpiry, summarizeSource, sourceActions, cronState, listSources,
} = require('../lib/scraper-sources.cjs');
const { createScraperCenter, installScraperCenterRoutes } = require('../modules/scraper-center.cjs');
const { createArchiveLock } = require('../lib/archive-lock.cjs');

const NOW = Date.parse('2026-11-02T12:00:00Z');
const DAY = 24 * 3600 * 1000;
const doc = () => ({
  Blog: [{ Name: 'Joe Turan', URL: 'https://www.joeturan.com/blog', OutputPath: '../www/Joe Turan' }],
  Facebook: [{ Name: 'Facebook', URL: 'https://www.facebook.com/x/', OutputPath: '../www/Facebook', Exclude: 'kuschel' }],
  Telegram: [{ Name: 'Telegram', URL: 'https://t.me/s/joeturan', OutputPath: '../www/Telegram' }],
});
const rejects = (fn, status, pattern) => assert.throws(fn, error => error.status === status && pattern.test(error.message));

test('Neue Quelle: Name ist Ordnername, eindeutig und nicht reserviert; URL passt zum Typ', () => {
  const input = { type: 'facebook', name: 'Nawal Boussi', url: 'https://facebook.com/nawal.boussi' };
  assert.deepEqual(sourceEntry(input, { doc: doc() }), {
    type: 'facebook', section: 'Facebook',
    entry: { Name: 'Nawal Boussi', URL: 'https://facebook.com/nawal.boussi', OutputPath: '../www/Nawal Boussi' },
  });
  rejects(() => sourceEntry({ ...input, name: '../etc' }, { doc: doc() }), 400, /Ordnername/);
  rejects(() => sourceEntry({ ...input, name: 'a/b' }, { doc: doc() }), 400, /Ordnername/);
  rejects(() => sourceEntry({ ...input, name: 'Infografiken' }, { doc: doc() }), 400, /reserviert/);
  rejects(() => sourceEntry({ ...input, name: 'telegram' }, { doc: doc() }), 409, /gibt es schon/);
  rejects(() => sourceEntry({ ...input, type: 'mastodon' }, { doc: doc() }), 400, /Quellentyp/);
  rejects(() => sourceEntry({ ...input, url: 'http://facebook.com/x' }, { doc: doc() }), 400, /https/);
  rejects(() => sourceEntry({ ...input, url: 'https://example.org/x' }, { doc: doc() }), 400, /facebook\.com/);
  rejects(() => sourceEntry({ type: 'telegram', name: 'Kanal', url: 'https://t.me/kanal' }, { doc: doc() }), 400, /t\.me\/s\//);
  assert.equal(sourceEntry({ type: 'telegram', name: 'Kanal', url: 'https://t.me/s/kanal' }, { doc: doc() }).entry.URL, 'https://t.me/s/kanal');
  assert.equal(sourceEntry({ type: 'blog', name: 'Ein Blog', url: 'https://blog.example.org/' }, { doc: doc() }).section, 'Blog');
});

test('Optionale Felder: Dateiautor, Signatur, Ausschluss-Ausdruck werden geprüft', () => {
  const base = { type: 'telegram', name: 'Kanal', url: 'https://t.me/s/kanal' };
  const { entry } = sourceEntry({ ...base, fileAuthor: 'Joe Turan', signatureName: 'Joe Turan', signatureWebsite: 'joeturan.com', exclude: 'kuschel[\\s-]*workshop' }, { doc: doc() });
  assert.deepEqual([entry.FileAuthor, entry.Signature, entry.Exclude], ['Joe Turan', { Name: 'Joe Turan', Website: 'joeturan.com' }, 'kuschel[\\s-]*workshop']);
  rejects(() => sourceEntry({ ...base, fileAuthor: 'a:b' }, { doc: doc() }), 400, /Dateiautor/);
  rejects(() => sourceEntry({ ...base, signatureWebsite: 'x.de' }, { doc: doc() }), 400, /Signatur braucht einen Namen/);
  rejects(() => sourceEntry({ ...base, exclude: '(' }, { doc: doc() }), 400, /Ausschluss-Ausdruck/);
  rejects(() => sourceEntry({ ...base, exclude: 'x'.repeat(201) }, { doc: doc() }), 400, /zu lang/);
});

test('Bearbeiten behält Name, Typ und Pause; listSources liefert die flache Liste', () => {
  const config = doc();
  config.Facebook[0].Aktiv = false;
  const existing = { type: 'facebook', section: 'Facebook', index: 0, entry: config.Facebook[0] };
  const { entry } = sourceEntry({ name: 'Anders', type: 'blog', url: 'https://www.facebook.com/neu/' }, { doc: config, existing });
  assert.deepEqual(entry, { Name: 'Facebook', URL: 'https://www.facebook.com/neu/', OutputPath: '../www/Facebook', Aktiv: false });
  assert.deepEqual(listSources(config).map(source => [source.type, source.name, source.active]),
    [['blog', 'Joe Turan', true], ['facebook', 'Facebook', false], ['telegram', 'Telegram', true]]);
});

test('cookies.txt: nur Anzahl und Ablauf der Facebook-Anmeldung (c_user, xs), Sitzungs-Cookies gelten als abgelaufen', () => {
  const line = (name, expiry, domain = '.facebook.com') => [domain, 'TRUE', '/', 'TRUE', String(expiry), name, 'GEHEIM'].join('\t');
  const later = Math.floor((NOW + 30 * DAY) / 1000);
  const sooner = Math.floor((NOW + 3 * DAY) / 1000);
  const text = ['# Netscape HTTP Cookie File', line('c_user', later), `#HttpOnly_${line('xs', sooner)}`, line('datr', later)].join('\n');
  const result = cookieExpiry(text);
  assert.deepEqual(result, { exists: true, count: 3, sessionExpiresAt: sooner * 1000 });
  assert.ok(!JSON.stringify(result).includes('GEHEIM'), 'keine Werte');
  assert.equal(cookieExpiry([line('c_user', later)].join('\n')).sessionExpiresAt, null, 'xs fehlt');
  assert.equal(cookieExpiry([line('c_user', 0), line('xs', later)].join('\n')).sessionExpiresAt, 0);
  assert.deepEqual(cookieExpiry(null), { exists: false, count: 0, sessionExpiresAt: null });
});

test('Stand je Quelle und notwendige Aktionen', () => {
  const facebook = { type: 'facebook', name: 'Facebook', active: true };
  const runs = [
    { id: 'r3', trigger: 'cron', startedAt: new Date(NOW - 1 * DAY).toISOString(), sources: [
      { type: 'facebook', name: 'Facebook', status: 'failed', error: 'Timeout', saved: 0, skipped: 0, finishedAt: new Date(NOW - 1 * DAY).toISOString(), warnings: { 'no-posts': 1, 'dom-fallback': 4 } }] },
    { id: 'r2', startedAt: new Date(NOW - 20 * DAY).toISOString(), sources: [
      { type: 'facebook', name: 'Facebook', status: 'ok', saved: 2, finishedAt: new Date(NOW - 20 * DAY).toISOString() }] },
    { id: 'r1', startedAt: new Date(NOW - 40 * DAY).toISOString(), sources: [
      { type: 'facebook', name: 'Facebook', status: 'ok', saved: 5, finishedAt: new Date(NOW - 40 * DAY).toISOString() }] },
  ];
  const summary = summarizeSource(facebook, runs, NOW);
  assert.deepEqual([summary.last.runId, summary.last.trigger, summary.lastNewAt, summary.newLast30Days], ['r3', 'cron', NOW - 20 * DAY, 2]);
  const cookies = { exists: true, sessionExpiresAt: NOW + 2 * DAY };
  const { actions, level } = sourceActions(facebook, summary, { cookies, now: NOW });
  assert.deepEqual(actions.map(action => `${action.level}:${action.code}`),
    ['error:failed', 'warning:cookies-expiring', 'warning:no-posts', 'info:dom-fallback', 'info:stale']);
  assert.equal(level, 'error');
  assert.match(actions[0].text, /Timeout/);

  const missing = sourceActions(facebook, { last: null, lastNewAt: null }, { cookies: { exists: false }, now: NOW });
  assert.deepEqual(missing.actions.map(action => action.code), ['never-run', 'cookies-missing']);
  const expired = sourceActions(facebook, { last: null }, { cookies: { exists: true, sessionExpiresAt: NOW - 1 }, now: NOW });
  assert.ok(expired.actions.some(action => action.code === 'cookies-expired'));
  // Cookies betreffen nur Facebook; eine pausierte Quelle meldet nur die Pause.
  const blog = sourceActions({ type: 'blog', active: true }, { last: { status: 'ok', warnings: {} } }, { cookies: { exists: false }, now: NOW });
  assert.deepEqual([blog.actions, blog.level], [[], 'ok']);
  const paused = sourceActions({ ...facebook, active: false }, { last: null }, { cookies: { exists: false }, now: NOW });
  assert.deepEqual(paused.actions.map(action => action.code), ['paused']);
});

test('Cron: ausgefallen nach 26 Stunden, Exit-Code ungleich 0 ist ein Fehler', () => {
  assert.equal(cronState({ at: NOW - 3600000, exitCode: 0 }, NOW).level, 'ok');
  assert.equal(cronState({ at: NOW - 27 * 3600000, exitCode: 0 }, NOW).level, 'warning');
  assert.equal(cronState({ at: NOW - 3600000, exitCode: 1 }, NOW).level, 'error');
  assert.equal(cronState(null, NOW).level, 'info');
});

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-center-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = {
    configFile: path.join(dir, 'scraper-config.json'),
    exampleFile: path.join(dir, 'example-scraper-config.json'),
    statusFile: path.join(dir, 'scrape-status.json'),
    cookiesFile: path.join(dir, 'cookies.txt'),
    cronLogFile: path.join(dir, 'cron-scrape.log'),
  };
  fs.writeFileSync(files.exampleFile, JSON.stringify(doc()));
  fs.writeFileSync(files.statusFile, JSON.stringify({ version: 1, runs: [{ id: 'r1', trigger: 'web', startedAt: new Date(NOW - DAY).toISOString(), finishedAt: new Date(NOW - DAY).toISOString(), exitCode: 0,
    sources: [{ type: 'telegram', name: 'Telegram', status: 'ok', saved: 1, skipped: 3, finishedAt: new Date(NOW - DAY).toISOString(), warnings: {},
      newFiles: ['Telegram/2026/2026-11-01_neu.md', 'Telegram/2026/2026-11-01_weg.md'] }] }] }));
  fs.writeFileSync(files.cronLogFile, '2026-11-02 04:10:00 Scraper exit 0\n');
  const archive = { articleById: new Map([['Telegram/2026/2026-11-01_neu', { title: 'Neuer Beitrag' }]]) };
  const center = createScraperCenter({ ...files, archive, now: () => NOW });
  const job = { running: false, started: [], start(types, options) { this.started.push(options); return { started: true, sources: [], source: options.source }; } };
  const lock = createArchiveLock();
  lock.register('Scraper-Lauf', () => job.running);
  const app = express();
  app.use(express.json());
  installScraperCenterRoutes(app, { requireAdmin: (_req, _res, next) => next(), center, job, lock });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  return { files, job, call };
}

test('Routen: Übersicht mit Stand, neuen Artikeln und Aktionen; Config entsteht beim ersten Schreiben aus der Vorlage', async t => {
  const { files, call } = await setup(t);
  let res = await call('GET', '/api/scraper/sources');
  assert.equal(res.status, 200);
  assert.equal(res.data.usesExample, true);
  const telegram = res.data.sources.find(source => source.name === 'Telegram');
  assert.deepEqual([telegram.last.trigger, telegram.last.saved, telegram.newLast30Days], ['web', 1, 1]);
  assert.deepEqual(telegram.last.newArticles, [
    { id: 'Telegram/2026/2026-11-01_neu', title: 'Neuer Beitrag', exists: true },
    { id: 'Telegram/2026/2026-11-01_weg', title: null, exists: false },
  ]);
  assert.deepEqual(res.data.sources.find(source => source.name === 'Facebook').actions.map(action => action.code), ['never-run', 'cookies-missing']);
  assert.equal(res.data.cron.level, 'ok');
  assert.deepEqual(res.data.cookies, { exists: false, sessionExpiresAt: null });

  res = await call('POST', '/api/scraper/sources', { type: 'facebook', name: 'Nawal Boussi', url: 'https://facebook.com/nawal.boussi' });
  assert.deepEqual([res.status, res.data], [200, { name: 'Nawal Boussi' }]);
  const written = JSON.parse(fs.readFileSync(files.configFile, 'utf8'));
  assert.deepEqual(written.Facebook.map(entry => entry.Name), ['Facebook', 'Nawal Boussi']);
  assert.equal(written.Facebook[0].Exclude, 'kuschel', 'bestehende Einträge bleiben unverändert');
  assert.equal((await call('GET', '/api/scraper/sources')).data.usesExample, false);

  res = await call('PUT', '/api/scraper/sources/Nawal%20Boussi', { url: 'https://www.facebook.com/nawal.boussi/' });
  assert.equal(res.status, 200);
  res = await call('PUT', '/api/scraper/sources/nawal%20boussi/active', { active: false });
  assert.deepEqual([res.status, res.data], [200, { name: 'Nawal Boussi', active: false }]);
  let entry = JSON.parse(fs.readFileSync(files.configFile, 'utf8')).Facebook[1];
  assert.deepEqual(entry, { Name: 'Nawal Boussi', URL: 'https://www.facebook.com/nawal.boussi/', OutputPath: '../www/Nawal Boussi', Aktiv: false });
  await call('PUT', '/api/scraper/sources/Nawal%20Boussi/active', { active: true });
  entry = JSON.parse(fs.readFileSync(files.configFile, 'utf8')).Facebook[1];
  assert.equal('Aktiv' in entry, false);

  res = await call('POST', '/api/scraper/sources', { type: 'facebook', name: 'Nawal Boussi', url: 'https://facebook.com/x' });
  assert.equal(res.status, 409);
  res = await call('DELETE', '/api/scraper/sources/Nawal%20Boussi');
  assert.deepEqual([res.status, res.data], [200, { name: 'Nawal Boussi', removed: true }]);
  assert.equal((await call('DELETE', '/api/scraper/sources/Nawal%20Boussi')).status, 404);
});

test('Routen: einzelne Quelle starten; während eines Laufs keine Änderungen (409)', async t => {
  const { job, call } = await setup(t);
  let res = await call('POST', '/api/scraper/run', { source: 'telegram' });
  assert.deepEqual([res.status, job.started], [200, [{ source: 'Telegram' }]], 'Name aus der Config');
  assert.equal((await call('POST', '/api/scraper/run', { source: 'Unbekannt' })).status, 404);
  job.running = true;
  res = await call('POST', '/api/scraper/run', { source: 'Telegram' });
  assert.deepEqual([res.status, res.data.started], [409, false]);
  res = await call('POST', '/api/scraper/sources', { type: 'telegram', name: 'Kanal', url: 'https://t.me/s/kanal' });
  assert.equal(res.status, 409);
  assert.match(res.data.error, /Scraper-Lauf/);
});

test('Facebook-Anmeldung: nur mit aktiver Facebook-Quelle; fehlt/abgelaufen = Fehler, < 7 Tage = Warnung', () => {
  const { facebookLoginState } = require('../lib/scraper-sources.cjs');
  assert.deepEqual(facebookLoginState({ exists: false }, { needed: false, now: NOW }).level, 'ok');
  assert.match(facebookLoginState({ exists: false }, { needed: true, now: NOW }).text, /cookies\.txt fehlt/);
  assert.equal(facebookLoginState({ exists: true, sessionExpiresAt: NOW - 1 }, { needed: true, now: NOW }).level, 'error');
  assert.equal(facebookLoginState({ exists: true, sessionExpiresAt: null }, { needed: true, now: NOW }).level, 'error');
  const soon = facebookLoginState({ exists: true, sessionExpiresAt: Date.parse('2026-11-05T12:00:00Z') }, { needed: true, now: NOW });
  assert.deepEqual([soon.level, soon.text], ['warning', 'Facebook-Anmeldung des Scrapers läuft am 05.11.2026 ab – cookies.txt erneuern.']);
  assert.equal(facebookLoginState({ exists: true, sessionExpiresAt: NOW + 30 * DAY }, { needed: true, now: NOW }).level, 'ok');
});

test('Erinnerung: je Stufe höchstens einmal am Tag ins Meldungsprotokoll, Eskalation sofort, „ok“ setzt zurück', async () => {
  const { createLoginReminder } = require('../modules/scraper-center.cjs');
  const recorded = [];
  let clock = NOW;
  let state = { level: 'warning', text: 'läuft am 05.11.2026 ab' };
  const reminder = createLoginReminder({
    loginState: async () => state, now: () => clock,
    eventLog: { record: (level, text, options) => recorded.push([level, text, options.source]) },
  });
  await reminder.check();
  await reminder.check();
  assert.deepEqual(recorded, [['warning', 'Scraper: läuft am 05.11.2026 ab', 'scraper']]);
  state = { level: 'error', text: 'abgelaufen' };
  await reminder.check();
  clock += 23 * 3600 * 1000;
  await reminder.check();
  assert.equal(recorded.length, 2, 'Fehler sofort, aber nicht stündlich');
  clock += 2 * 3600 * 1000;
  await reminder.check();
  assert.equal(recorded.length, 3, 'nach einem Tag erneut (die Sprechblase erinnert wieder)');
  state = { level: 'ok', text: 'gültig' };
  await reminder.check();
  state = { level: 'error', text: 'abgelaufen' };
  await reminder.check();
  assert.equal(recorded.length, 4, 'nach „ok“ beginnt es neu');
});

test('Routen: loginState liest Config und cookies.txt, ohne Werte', async t => {
  const { files } = await setup(t);
  const center = createScraperCenter({ ...files, archive: { articleById: new Map() }, now: () => NOW });
  assert.equal((await center.loginState()).level, 'error', 'aktive Facebook-Quelle, aber keine cookies.txt');
  const expiry = Math.floor((NOW + 30 * DAY) / 1000);
  fs.writeFileSync(files.cookiesFile, ['.facebook.com', 'TRUE', '/', 'TRUE', expiry, 'c_user', 'GEHEIM'].join('\t') + '\n'
    + ['.facebook.com', 'TRUE', '/', 'TRUE', expiry, 'xs', 'GEHEIM'].join('\t'));
  const state = await center.loginState();
  assert.equal(state.level, 'ok');
  assert.ok(!JSON.stringify(state).includes('GEHEIM'));
});
