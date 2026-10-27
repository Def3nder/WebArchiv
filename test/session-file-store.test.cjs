const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const express = require('express');
const session = require('express-session');
const { FileSessionStore } = require('../lib/session-file-store.cjs');

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webarchiv-sessions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'sessions.json');
}
const api = store => ({
  get: promisify(store.get.bind(store)),
  set: promisify(store.set.bind(store)),
  touch: promisify(store.touch.bind(store)),
  destroy: promisify(store.destroy.bind(store)),
});
// fetch hält Keep-alive-Verbindungen offen; ohne closeAllConnections wartet close() ewig.
const stop = server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); };
const sess = (expires, user = { email: 'a@example.test', sessionVersion: 1 }) => ({ cookie: { expires: new Date(expires).toISOString(), originalMaxAge: 1000 }, user });

test('Sitzungen überstehen einen Neustart, abgelaufene nicht', async t => {
  const file = tempFile(t);
  let now = 1_000_000;
  const first = new FileSessionStore({ file, now: () => now });
  const a = api(first);
  await a.set('aktiv', sess(now + 60_000));
  await a.set('alt', sess(now + 10));
  await first.flush();
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  now += 1000;
  const second = new FileSessionStore({ file, now: () => now });
  const b = api(second);
  assert.deepEqual((await b.get('aktiv')).user, { email: 'a@example.test', sessionVersion: 1 });
  assert.equal(await b.get('alt'), null);
  await b.destroy('aktiv');
  await second.flush();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
  await first.close();
  await second.close();
});

test('get liefert eine Kopie; abgelaufene Sitzungen verschwinden, touch schreibt nur bei neuem Ablauf', async t => {
  const file = tempFile(t);
  let now = 5_000;
  const store = new FileSessionStore({ file, now: () => now, flushDelayMs: 60_000 });
  const s = api(store);
  await s.set('x', sess(now + 1000));
  (await s.get('x')).user.email = 'verändert@example.test';
  assert.equal((await s.get('x')).user.email, 'a@example.test');

  await store.flush();
  await s.touch('x', sess(now + 1000));
  assert.equal(store.timer, null, 'gleicher Ablauf → kein Schreibauftrag');
  await s.touch('x', sess(now + 5000));
  assert.notEqual(store.timer, null);

  now += 10_000;
  assert.equal(await s.get('x'), null);
  assert.equal(store.sessions.size, 0);
  await store.close();
});

test('express-session arbeitet mit dem Datei-Store (Anmeldung bleibt nach Neustart erhalten)', async t => {
  const file = tempFile(t);
  const start = async () => {
    const store = new FileSessionStore({ file, flushDelayMs: 1 });
    const app = express();
    app.use(session({ secret: 'x'.repeat(32), resave: false, saveUninitialized: false, store }));
    app.post('/login', (req, res) => { req.session.user = { email: 'a@example.test' }; res.json({ ok: true }); });
    app.get('/me', (req, res) => res.json({ user: req.session.user || null }));
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    return { store, server, base: `http://127.0.0.1:${server.address().port}` };
  };
  const one = await start();
  const cookie = (await fetch(one.base + '/login', { method: 'POST' })).headers.get('set-cookie').split(';')[0];
  await one.store.close();
  await stop(one.server);

  const two = await start();
  const me = await (await fetch(two.base + '/me', { headers: { cookie } })).json();
  assert.deepEqual(me.user, { email: 'a@example.test' });
  await two.store.close();
  await stop(two.server);
});
