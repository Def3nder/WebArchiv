const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { app } = require('../server.js');
const { installTtsRoutes } = require('../tts/jobs.cjs');

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

test('Die Oberfläche reagiert auf Fehlercodes, nicht auf Meldungstexte', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const publicDir = path.join(__dirname, '..', 'public');
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /data\?\.code === 'admin_required'/);
  assert.match(app, /data\?\.code === 'password_change_required'/);
  for (const file of ['app.js', 'book-reader.js', 'password.js', 'user-admin.js', 'audiobook-extras-manager.js']) {
    const source = fs.readFileSync(path.join(publicDir, file), 'utf8');
    assert.doesNotMatch(source, /'Session expired'|'Admin only'/, file);
  }
});
