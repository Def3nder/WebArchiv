// Startet server.js als eigenen Prozess auf einem Testarchiv (test/fixtures/smoke-archive.cjs) – im Testprozess
// selbst ginge das nicht: Alle Tests teilen sich ein geladenes server.js mit dem echten Archiv. Freier Port,
// Datei-Watcher aus, CSP wie in Produktion erzwungen. client() spricht die API wie die Oberfläche an
// (Session-Cookie, CSRF-Token der Admin-Seite).
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

async function startFixtureServer(env, { timeoutMs = 60000 } = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: '0', WATCH_ARCHIVE: '0', CSP_MODE: 'enforce',
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'), ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
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
    return { base, stop, log: () => log };
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

module.exports = { startFixtureServer, client };
