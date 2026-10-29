const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { app } = require('../server.js');
const { installTtsRoutes } = require('../tts/jobs.cjs');
const { sendRouteError } = require('../lib/http-errors.cjs');

async function listen(t, handler) {
  const server = await new Promise(resolve => { const s = handler.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('zu große oder kaputte JSON-Anfragen erhalten eine passende Meldung', async t => {
  const base = await listen(t, app);
  const big = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'x'.repeat(200 * 1024) }),
  });
  assert.equal(big.status, 413);
  assert.deepEqual(await big.json(), { error: 'Die Anfrage ist zu groß.' });

  const broken = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"email":' });
  assert.equal(broken.status, 400);
  assert.deepEqual(await broken.json(), { error: 'Ungültige Anfrage.' });
});

test('TTS-Routen geben bei unerwarteten Fehlern keine internen Meldungen weiter', async t => {
  const ttsApp = express();
  const allow = (req, _res, next) => { req.session = { user: { role: 'admin', email: 'a@example.test' } }; next(); };
  const jobs = { latest() { throw new Error('ENOENT: /opt/nodeapp/geheim'); }, status() { throw Object.assign(new Error('Auftrag nicht gefunden.'), { status: 404 }); } };
  installTtsRoutes(ttsApp, allow, jobs, async () => ({ providers: [] }));
  const base = await listen(t, ttsApp);
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  try {
    const unexpected = await fetch(`${base}/api/tts/latest`);
    assert.equal(unexpected.status, 500);
    const body = await unexpected.json();
    assert.doesNotMatch(body.error, /opt|ENOENT/);
    assert.equal(logged.length, 1, 'Details landen im Log');
  } finally { console.error = original; }

  const known = await fetch(`${base}/api/tts/x/status`);
  assert.equal(known.status, 404);
  assert.deepEqual(await known.json(), { error: 'Auftrag nicht gefunden.' });
});

test('Anmelde- und Rechtefehler haben deutsche Meldungen und feste Codes', async t => {
  const base = await listen(t, app);
  const anonymous = await fetch(`${base}/api/bookmarks/x`, { method: 'PUT' });
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: 'Nicht angemeldet.', code: 'not_authenticated' });
  const notAdmin = await fetch(`${base}/api/scrape/log`);
  assert.equal(notAdmin.status, 403);
  assert.deepEqual(await notAdmin.json(), { error: 'Nur für Administratoren.', code: 'admin_required' });
});

test('Scrape- und Reindex-Status nur für Administratoren', async t => {
  const base = await listen(t, app);
  for (const path of ['/api/scrape/status', '/api/reindex/status']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 403, path);
    assert.deepEqual(await response.json(), { error: 'Nur für Administratoren.', code: 'admin_required' });
  }
});

function fakeResponse() {
  return {
    statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(name, value) { this.headers[name] = value; return this; },
  };
}

test('sendRouteError: eigene Meldungen gehen an die Oberfläche, interne nur ins Log', () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  try {
    const unexpected = fakeResponse();
    sendRouteError(unexpected, new Error("ENOENT: rename '/opt/nodeapp/www/Infografiken/2026/a.png'"),
      { label: 'Infografik-Verwaltung', fallback: 'Infografiken konnten nicht geändert werden.' });
    assert.equal(unexpected.statusCode, 500);
    assert.deepEqual(unexpected.body, { error: 'Infografiken konnten nicht geändert werden.' });
    assert.equal(logged.length, 1);

    const known = fakeResponse();
    sendRouteError(known, Object.assign(new Error('Infografik nicht gefunden.'), { status: 404 }), { label: 'x', fallback: 'y' });
    assert.equal(known.statusCode, 404);
    assert.deepEqual(known.body, { error: 'Infografik nicht gefunden.' });
    assert.equal(logged.length, 1, 'eigene Fehler werden nicht geloggt');

    const rollback = fakeResponse();
    sendRouteError(rollback, Object.assign(new Error('Zieldatei existiert bereits.'), { status: 409 }), {
      label: 'x', fallback: 'y', rollbackError: new Error("EPERM: rename '/opt/nodeapp/www/geheim'"),
    });
    assert.equal(rollback.statusCode, 409);
    assert.match(rollback.body.error, /^Zieldatei existiert bereits\. Wiederherstellung fehlgeschlagen; Details stehen im Server-Log\.$/);
    assert.equal(logged.length, 2, 'Ursache der fehlgeschlagenen Wiederherstellung steht im Log');
  } finally { console.error = original; }
});

test('server.js reicht keine rohen Fehlermeldungen an die Oberfläche weiter', () => {
  const fs = require('node:fs');
  const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  assert.doesNotMatch(server, /error: (?:err|error)\.message \|\|/);
  assert.doesNotMatch(server, /\.status\((?:err|error)\.status \|\| \d+\)\.json/);
  assert.doesNotMatch(server, /' Wiederherstellung fehlgeschlagen: ' \+ rollbackError\.message/);
});

test('Unbehandelte Fehler: API-Pfade erhalten JSON ohne Stacktrace, andere Pfade bleiben bei Express', async t => {
  const { handleRequestError } = require('../server.js');
  const testApp = express();
  testApp.get('/api/kaputt', () => { throw new Error("ENOENT: open '/opt/nodeapp/www/geheim.md'"); });
  testApp.get('/api/abgelehnt', () => { throw Object.assign(new Error('bad charset utf-7'), { status: 415 }); });
  testApp.get('/seite', () => { throw new Error('Seitenfehler'); });
  testApp.use(handleRequestError);
  testApp.use((err, _req, res, _next) => res.status(599).send('express'));
  const base = await listen(t, testApp);
  t.mock.method(console, 'error', () => {});

  const broken = await fetch(`${base}/api/kaputt`);
  assert.equal(broken.status, 500);
  assert.deepEqual(await broken.json(), { error: 'Die Anfrage ist fehlgeschlagen.', code: 'internal' });
  assert.equal(console.error.mock.callCount(), 1, 'Ursache steht im Log');

  const rejected = await fetch(`${base}/api/abgelehnt`);
  assert.equal(rejected.status, 415);
  assert.deepEqual(await rejected.json(), { error: 'Ungültige Anfrage.' });

  const page = await fetch(`${base}/seite`);
  assert.equal(page.status, 599);
});

test('Zu große Anfragen nennen die passende Grenze für Artikel und Markdown-Extras', () => {
  const { handleRequestError } = require('../server.js');
  const tooLarge = { type: 'entity.too.large' };
  const sent = route => {
    const res = { headersSent: false, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    handleRequestError(tooLarge, { path: route, method: 'PUT' }, res, () => { throw new Error('nicht erwartet'); });
    return [res.code, res.body.error];
  };
  assert.deepEqual(sent('/api/article-markdown/a'), [413, 'Die Anfrage ist zu groß. Artikel dürfen höchstens 1 MB enthalten.']);
  assert.deepEqual(sent('/api/audiobook-extra-source/b'), [413, 'Die Anfrage ist zu groß. Markdown-Extras dürfen höchstens 1 MB enthalten.']);
  assert.deepEqual(sent('/api/audiobook-extra-create/b'), [413, 'Die Anfrage ist zu groß. Markdown-Extras dürfen höchstens 1 MB enthalten.']);
});

test('Die Oberfläche reagiert auf Fehlercodes, nicht auf Meldungstexte', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const publicDir = path.join(__dirname, '..', 'public');
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /data\?\.code === 'admin_required'/);
  assert.match(app, /data\?\.code === 'password_change_required'/);
  // Veraltetes CSRF-Token: neu laden statt einer unverständlichen Meldung.
  assert.match(app, /data\?\.code === 'csrf_invalid'\) \{\s*location\.reload\(\);/);
  for (const file of ['app.js', 'book-reader.js', 'password.js', 'user-admin.js', 'audiobook-extras-manager.js']) {
    const source = fs.readFileSync(path.join(publicDir, file), 'utf8');
    assert.doesNotMatch(source, /'Session expired'|'Admin only'/, file);
  }
});
