'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { createArchiveLock } = require('../lib/archive-lock.cjs');
const { installAudiobookRoutes } = require('../audiobooks.cjs');

test('Sperre: exklusiv, Freigabe idempotent, alte Freigabe löst keinen neuen Halter', () => {
  const lock = createArchiveLock();
  assert.equal(lock.busy, false);
  assert.equal(lock.current, null);
  const release = lock.tryAcquire('Infografiken ändern');
  assert.equal(typeof release, 'function');
  assert.equal(lock.current, 'Infografiken ändern');
  assert.equal(lock.holder, 'Infografiken ändern');
  assert.equal(lock.tryAcquire('Dublettenaktion'), null);
  release();
  assert.equal(lock.busy, false);
  const next = lock.tryAcquire('Dublettenaktion');
  release();
  assert.equal(lock.current, 'Dublettenaktion');
  next();
  assert.equal(lock.busy, false);
});

test('Sperre: registrierte Aufträge blockieren und werden in Reihenfolge benannt', () => {
  const lock = createArchiveLock();
  const state = { reindex: false, tts: false };
  lock.register('Index-Neuaufbau', () => state.reindex);
  lock.register('Audio-Erzeugung', () => state.tts);
  state.tts = true;
  assert.equal(lock.current, 'Audio-Erzeugung');
  assert.equal(lock.holder, null);
  assert.equal(lock.tryAcquire('Infografik hochladen'), null);
  state.reindex = true;
  assert.equal(lock.current, 'Index-Neuaufbau');
  state.reindex = false;
  state.tts = false;
  assert.ok(lock.tryAcquire('Infografik hochladen'));
});

test('Sperre: run gibt nach Erfolg und Fehler frei, Konflikt nennt den Auftrag', async () => {
  const lock = createArchiveLock();
  assert.equal(await lock.run('A', async () => 42), 42);
  assert.equal(lock.busy, false);
  await assert.rejects(lock.run('A', async () => { throw new Error('kaputt'); }), /kaputt/);
  assert.equal(lock.busy, false);

  let running = true;
  lock.register('Scraper-Lauf', () => running);
  await assert.rejects(lock.run('Hörbuch-Verwaltung', async () => 'nie'), error => {
    assert.equal(error.status, 409);
    assert.equal(error.busy, 'Scraper-Lauf');
    assert.equal(error.message, 'Es läuft bereits: Scraper-Lauf. Bitte später erneut versuchen.');
    return true;
  });
  running = false;
  assert.equal(await lock.run('Hörbuch-Verwaltung', async () => 'ok'), 'ok');
});

test('Hörbuch-Verwaltung: Admin-Schreibzugriffe laufen über die zentrale Sperre', async t => {
  const lock = createArchiveLock();
  const book = { id: 'Hörbücher/Buch' };
  const saved = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { email: 'admin@example.test', role: 'admin', allowedAuthors: null } }; next(); });
  installAudiobookRoutes(app, {
    library: { getForUser: () => book },
    progress: { setPrivate: async (id, value) => { saved.push([id, value]); return { private: value }; } },
    config: {}, requireAuth: (_req, _res, next) => next(), canAccessAuthor: () => true,
    exclusive: (label, task) => lock.run(label, task),
  });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const put = () => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, method: 'PUT',
      path: `/api/audiobook-private/${encodeURIComponent(book.id)}`, headers: { 'content-type': 'application/json' },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ private: true }));
  });

  const release = lock.tryAcquire('Dublettenaktion');
  const blocked = await put();
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /Es läuft bereits: Dublettenaktion/);
  assert.deepEqual(saved, []);
  release();
  const ok = await put();
  assert.equal(ok.status, 200);
  assert.deepEqual(saved, [[book.id, true]]);
  assert.equal(lock.busy, false);
});

test('server.js: keine verstreuten Busy-Prüfungen mehr, alle Aufträge an der zentralen Sperre', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(server, /infographicWrites/);
  // Zustände der laufenden Aufträge erscheinen außerhalb der Registrierung nicht in Busy-Ketten.
  assert.doesNotMatch(server, /\.running \|\| \w+(State)?\.running/);
  // Start von Reindex und Scrape prüft nur die Sperre (409 mit Auftragsname).
  assert.doesNotMatch(server, /if \((reindex|scrape)State\.running\) return res/);
  for (const route of ["app.post('/api/reindex'", "app.post('/api/scrape'"]) {
    const start = server.indexOf(route);
    assert.match(server.slice(start, start + 400), /if \(archiveLock\.busy\) return sendArchiveBusy\(res, \{ started: false \}\);/, route);
  }
  for (const label of ['Index-Neuaufbau', 'Scraper-Lauf', 'Artikel speichern', 'Audio-Erzeugung']) {
    assert.match(server, new RegExp(`archiveLock\\.register\\('${label}'`));
  }
  for (const label of ['Infografiken ändern', 'Infografik-Prüfung speichern', 'Infografik hochladen',
    'Neue Infografik speichern', 'Dubletten-Sammelaktion', 'Dublettenaktion']) {
    assert.match(server, new RegExp(`archiveLock\\.tryAcquire\\('${label}'\\)`));
  }
  assert.match(server, /exclusive: \(label, task\) => archiveLock\.run\(label, task\)/);
  assert.match(server, /process\.on\('SIGHUP'[\s\S]*?archiveLock\.whenIdle\(\(\) => buildIndex\(\)/);
  assert.match(server, /SIGHUP-Reindex wartet auf: \$\{current\}/);
});

test('Sperre: whenIdle holt einen Auftrag nach, sobald das Archiv frei ist', async () => {
  const lock = createArchiveLock();
  let tts = true;
  lock.register('Audio-Erzeugung', () => tts);
  const runs = [];
  const waits = [];
  const options = { intervalMs: 5, onWait: label => waits.push(label) };
  assert.equal(lock.whenIdle(() => runs.push('reindex'), options), true);
  // Ein zweites Signal, während der erste noch wartet, wird zusammengefasst.
  assert.equal(lock.whenIdle(() => runs.push('doppelt'), options), false);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(runs, []);
  assert.deepEqual(waits, ['Audio-Erzeugung'], 'Warten wird nur einmal gemeldet');
  tts = false;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(runs, ['reindex']);

  // Ist nichts belegt, startet der Auftrag sofort.
  assert.equal(lock.whenIdle(() => runs.push('sofort')), true);
  assert.deepEqual(runs, ['reindex', 'sofort']);
});

test('run-scrape.sh signalisiert den Dienst ohne sudo und protokolliert das Ergebnis', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scraper', 'run-scrape.sh'), 'utf8');
  assert.doesNotMatch(script, /\r\n/, 'LF-Zeilenenden für bash');
  assert.doesNotMatch(script, /^\s*sudo\b/m, 'sudo fragt im Cron nach einem Kennwort');
  assert.match(script, /PID=\$\(\/usr\/bin\/systemctl show -p MainPID --value nodeapp\)/);
  assert.match(script, /kill -HUP "\$PID"/);
  assert.match(script, /SIGHUP an nodeapp \(PID \$PID\) gesendet/);
  assert.match(script, /FEHLER: SIGHUP an nodeapp nicht gesendet/);
});
