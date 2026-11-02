// Startet server.js als eigenen Prozess auf einem Testarchiv (test/fixtures/smoke-archive.cjs) – im Testprozess
// selbst ginge das nicht: Alle Tests teilen sich ein geladenes server.js mit dem echten Archiv. Freier Port,
// Datei-Watcher aus, CSP wie in Produktion erzwungen. client() spricht die API wie die Oberfläche an
// (Session-Cookie, CSRF-Token der Admin-Seite).
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

// echo: Serverausgabe zusätzlich durchreichen (npm run dev:fixture).
async function startFixtureServer(env, { timeoutMs = 60000, echo = false } = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: '0', WATCH_ARCHIVE: '0', CSP_MODE: 'enforce',
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'), ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; if (echo) process.stdout.write(chunk); });
  child.stderr.on('data', chunk => { log += chunk; if (echo) process.stderr.write(chunk); });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const stop = async () => {
    if (child.exitCode === null) child.kill();
    await exited;
  };

  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server startet nicht:\n${log}`)), timeoutMs);
      const check = () => {
        const match = log.match(/WebArchiv -> http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      };
      child.stdout.on('data', check);
      exited.then(code => { clearTimeout(timer); reject(new Error(`Server beendet (${code}):\n${log}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    // Bereit, sobald der Index steht (vorher meldet /api/health „starting“).
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await fetch(`${base}/api/health`).then(res => res.json()).then(data => data.status, () => null);
      if (status && status !== 'starting') break;
      if (Date.now() > deadline) throw new Error(`Index wird nicht fertig:\n${log}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { base, stop, log: () => log, exited };
  } catch (error) {
    await stop();
    throw error;
  }
}

function client(base) {
  let cookie = '';
  let csrf = '';
  async function request(method, url, body) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (csrf) headers['x-csrf-token'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + url, {
      method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const set of res.headers.getSetCookie()) if (set.startsWith('connect.sid=')) cookie = set.split(';')[0];
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* HTML oder leer */ }
    return { status: res.status, ok: res.ok, data };
  }
  return {
    get: url => request('GET', url),
    post: (url, body) => request('POST', url, body),
    put: (url, body) => request('PUT', url, body),
    del: url => request('DELETE', url),
    async login(email, password) {
      const res = await request('POST', '/api/login', { email, password });
      if (!res.ok) throw new Error(`Anmeldung ${email}: ${res.status} ${JSON.stringify(res.data)}`);
      // Admin-Schreibzugriffe brauchen das CSRF-Token aus der Admin-Seite.
      const page = await request('GET', '/');
      csrf = String(page.data).match(/<meta name="admin-csrf-token" content="([^"]+)">/)?.[1] || '';
      return res.data;
    },
  };
}

// Testarchiv in dir bauen, Server darauf starten und alle Fälle vorbereiten (Verknüpfen, Ignorieren, privat setzen,
// Dateiänderungen mit frischem Reindex). Gemeinsam für test/fixture-archive.test.cjs und npm run dev:fixture.
// Liefert server, ctx (Zugriffe je Rolle für die Erwartungen der Fälle) und die Kennwörter dieses Laufs.
async function startFixtureArchive(dir, serverOptions = {}) {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const { CASES, USERS, build } = require('../fixtures/smoke-archive.cjs');
  const { env, passwords } = await build(dir);
  const server = await startFixtureServer({ ...env, ...serverOptions.env }, serverOptions);
  try {
    const clients = { guest: client(server.base) };
    for (const [role, user] of Object.entries(USERS)) {
      clients[role] = client(server.base);
      await clients[role].login(user.email, passwords[role]);
    }
    const query = params => new URLSearchParams(params).toString();
    // Alle Seiten einer Liste (höchstens 100 Einträge je Seite).
    const allPages = async (role, url, params) => {
      const items = [];
      for (let page = 1; ; page++) {
        const res = await clients[role].get(`${url}?${query({ limit: '100', ...params, page: String(page) })}`);
        assert.equal(res.status, 200, `${url} ${JSON.stringify(params)}: ${JSON.stringify(res.data)}`);
        items.push(...res.data.items);
        if (page >= (res.data.pages || 1)) return items;
      }
    };
    const ctx = {
      migrations: {},
      as: role => clients[role],
      list: (role, params = {}) => allPages(role, '/api/articles', params),
      tiles: (role, params = {}) => allPages(role, '/api/articles', { ...params, group: '1' }),
      books: (role, params = {}) => allPages(role, '/api/audiobooks', params),
      async detail(role, id) {
        const res = await clients[role].get(`/api/articles/${encodeURI(id)}`);
        assert.equal(res.status, 200, `${id}: ${JSON.stringify(res.data)}`);
        return res.data;
      },
      async duplicateAction(body) {
        const res = await clients.admin.post('/api/duplicates', body);
        assert.equal(res.status, 200, `${JSON.stringify(body)}: ${JSON.stringify(res.data)}`);
        return res.data;
      },
    };

    // Vorbereitung über die echten Routen, danach Dateiänderungen und ein frischer Reindex.
    for (const testCase of CASES) if (testCase.setup) await testCase.setup(ctx);
    const edits = CASES.filter(testCase => testCase.edit);
    for (const { edit } of edits) await fs.promises.appendFile(path.join(dir, edit.file), edit.append);
    if (edits.length) {
      assert.equal((await clients.admin.post('/api/reindex')).status, 200);
      for (let i = 0; (await clients.admin.get('/api/reindex/status')).data.running; i++) {
        assert.ok(i < 300, 'Reindex wird nicht fertig');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    ctx.duplicates = (await clients.admin.get('/api/duplicates')).data;
    ctx.pending = ctx.duplicates.pending;
    return { server, ctx, passwords };
  } catch (error) {
    await server.stop();
    throw error;
  }
}

module.exports = { startFixtureServer, startFixtureArchive, client };
