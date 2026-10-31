'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createLoginLimiter, tooManyAttemptsError } = require('../lib/login-limiter.cjs');
const { renderSafeMarkdown, sanitizeRenderedHtml, safeHttpUrl } = require('../lib/html-sanitizer.cjs');
const { createSecurityHeaders, installCspReportRoute, cspMode } = require('../lib/security-headers.cjs');
const { installUserRoutes } = require('../user-store.cjs');
const { app: serverApp, resolveSessionSecret, parseTrustProxy, extractSourceUrl } = require('../server.js');

const quiet = { warn: () => {} };

async function listen(t, app) {
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return (method, path, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, method, path,
      headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── SESSION_SECRET und Proxy ───────────────────────────────────────────────

test('SESSION_SECRET: Produktion ohne oder mit unsicherem Secret startet nicht', () => {
  for (const secret of [undefined, '', 'zu-kurz', 'webarchiv-dev-secret-change-in-prod']) {
    assert.throws(() => resolveSessionSecret({ env: { NODE_ENV: 'production', SESSION_SECRET: secret }, strict: true, log: quiet }),
      /SESSION_SECRET/);
  }
  const good = 'a'.repeat(64);
  assert.equal(resolveSessionSecret({ env: { NODE_ENV: 'production', SESSION_SECRET: good }, strict: true, log: quiet }), good);
});

test('SESSION_SECRET: ohne strict (Tests, Skripte) bzw. in Entwicklung zufälliges Secret mit Warnung', () => {
  const warnings = [];
  const log = { warn: message => warnings.push(message) };
  const first = resolveSessionSecret({ env: { NODE_ENV: 'production' }, strict: false, log });
  const second = resolveSessionSecret({ env: {}, strict: true, log });
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
  assert.equal(warnings.length, 2);
});

test('TRUST_PROXY: Vorgabe ist Loopback plus NPMplus, „true“ wird abgelehnt', () => {
  assert.deepEqual(parseTrustProxy(''), ['loopback', '192.168.1.14']);
  assert.deepEqual(parseTrustProxy(' 10.0.0.2 , loopback '), ['10.0.0.2', 'loopback']);
  assert.throws(() => parseTrustProxy('true'), /TRUST_PROXY/);
});

// ─── Login-Begrenzung ──────────────────────────────────────────────────────

test('Login-Begrenzung: 5 Fehlversuche sperren Konto + IP, der Inhaber kommt von seiner Adresse weiter rein', () => {
  let time = 0;
  const limiter = createLoginLimiter({ now: () => time });
  for (let i = 0; i < 4; i++) limiter.failure('1.1.1.1', 'A@Example.test');
  assert.equal(limiter.check('1.1.1.1', 'a@example.test').allowed, true);
  limiter.failure('1.1.1.1', 'a@example.test');
  // Gesperrt für diese Adresse, unabhängig von Groß-/Kleinschreibung …
  const blocked = limiter.check('1.1.1.1', 'A@EXAMPLE.TEST');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 15 * 60);
  // … aber nicht für den Inhaber an einer anderen Adresse und nicht für andere Konten.
  assert.equal(limiter.check('3.3.3.3', 'a@example.test').allowed, true);
  assert.equal(limiter.check('1.1.1.1', 'b@example.test').allowed, true);
  time += 15 * 60 * 1000;
  assert.equal(limiter.check('1.1.1.1', 'a@example.test').allowed, true);
});

test('Login-Begrenzung: verteiltes Durchprobieren eines Kontos sperrt es nach 50 Fehlversuchen überall', () => {
  let time = 0;
  const limiter = createLoginLimiter({ now: () => time });
  for (let i = 0; i < 49; i++) limiter.failure(`10.0.0.${i}`, 'admin@example.test');
  assert.equal(limiter.check('10.0.1.1', 'admin@example.test').allowed, true);
  limiter.failure('10.0.0.99', 'admin@example.test');
  assert.equal(limiter.check('10.0.1.1', 'admin@example.test').allowed, false);
  assert.equal(limiter.check('10.0.1.1', 'leser@example.test').allowed, true);
  time += 15 * 60 * 1000;
  assert.equal(limiter.check('10.0.1.1', 'admin@example.test').allowed, true);
});

test('Login-Begrenzung: Erfolg setzt das Konto zurück, IP-Grenze gilt für viele Konten', () => {
  let time = 0;
  const limiter = createLoginLimiter({ now: () => time, maxPerIp: 3 });
  limiter.failure('9.9.9.9', 'x@example.test');
  limiter.success('9.9.9.9', 'x@example.test');
  limiter.failure('9.9.9.9', 'y@example.test');
  assert.equal(limiter.check('8.8.8.8', 'z@example.test').allowed, true);
  limiter.failure('9.9.9.9', 'z@example.test');
  assert.equal(limiter.check('9.9.9.9', 'neu@example.test').allowed, false);
  assert.equal(limiter.check('8.8.8.8', 'neu@example.test').allowed, true);
  // Zähler außerhalb des Zeitfensters verfallen ohne Sperre.
  time += 16 * 60 * 1000;
  assert.equal(limiter.check('9.9.9.9', 'neu@example.test').allowed, true);
});

test('Login-Begrenzung: Meldung nennt die Wartezeit', () => {
  const error = tooManyAttemptsError({ allowed: false, retryAfterSeconds: 61 });
  assert.equal(error.status, 429);
  assert.equal(error.retryAfter, 61);
  assert.match(error.message, /in 2 Minuten erneut/);
  assert.match(tooManyAttemptsError({ retryAfterSeconds: 5 }).message, /in 1 Minute erneut/);
});

test('POST /api/login: nach 5 Fehlversuchen 429 mit Retry-After, ohne Konto zu verraten', async t => {
  const request = await listen(t, serverApp);
  const email = `gibt-es-nicht-${Date.now()}@example.test`;
  for (let i = 0; i < 5; i++) {
    const response = await request('POST', '/api/login', { body: { email, password: 'falsch' } });
    assert.equal(response.status, 401);
  }
  const blocked = await request('POST', '/api/login', { body: { email, password: 'falsch' } });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  assert.match(JSON.parse(blocked.text).error, /Zu viele Anmeldeversuche/);
});

test('POST /api/me/password: falsches aktuelles Kennwort zählt, Sperre greift vor der Prüfung', async t => {
  let checks = 0;
  const store = {
    async changeOwnPassword() {
      checks++;
      throw Object.assign(new Error('Das aktuelle Kennwort ist nicht korrekt.'), { status: 400, wrongPassword: true });
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { email: 'nutzer@example.test' } }; next(); });
  installUserRoutes(app, {
    store, requireAuth: (_req, _res, next) => next(), requireAdmin: (_req, _res, next) => next(),
    getAuthors: () => [], passwordLimiter: createLoginLimiter({ maxPerAccount: 2 }),
  });
  const request = await listen(t, app);
  const body = { currentPassword: 'falsch', newPassword: 'neues-kennwort' };
  assert.equal((await request('POST', '/api/me/password', { body })).status, 400);
  assert.equal((await request('POST', '/api/me/password', { body })).status, 400);
  const blocked = await request('POST', '/api/me/password', { body });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  assert.equal(checks, 2);
});

// ─── HTML-Bereinigung ──────────────────────────────────────────────────────

test('HTML-Bereinigung: Skripte, Event-Attribute und gefährliche Links werden entfernt', () => {
  assert.equal(sanitizeRenderedHtml('<p>a<script>alert(1)</script>b</p>'), '<p>ab</p>');
  assert.equal(sanitizeRenderedHtml('<p>a<svg onload="x()"><g/></svg>b</p><p>c</p>'), '<p>ab</p><p>c</p>');
  assert.equal(sanitizeRenderedHtml('<p>a<iframe srcdoc="<script>1</script>"></iframe>b</p>'), '<p>ab</p>');
  assert.equal(sanitizeRenderedHtml('<img src="x" onerror="alert(1)">'), '<img src="x" />');
  assert.equal(sanitizeRenderedHtml('<div style="position:fixed" onclick="x()">d</div>'), '<div>d</div>');
  for (const href of ['javascript:alert(1)', 'jAvAsCrIpT:alert(1)', '&#106;avascript:alert(1)', '//evil.example', 'data:text/html,x']) {
    assert.equal(sanitizeRenderedHtml(`<a href="${href}">x</a>`), '<a>x</a>', href);
  }
  assert.equal(renderSafeMarkdown('[x](javascript:alert(1))'), '<p><a>x</a></p>\n');
  assert.equal(sanitizeRenderedHtml('<p>a<input type="text" value="x">b</p>'), '<p>ab</p>');
});

test('HTML-Bereinigung: Inhalte des Archivs bleiben erhalten', () => {
  assert.equal(renderSafeMarkdown('Siehe<sup><a href="#anm-1">1</a></sup> <a id="ref-1"></a>'),
    '<p>Siehe<sup><a href="#anm-1">1</a></sup> <a id="ref-1"></a></p>\n');
  assert.match(renderSafeMarkdown('| a | b |\n|:-|-:|\n| 1 | 2 |'), /<th align="left">a<\/th>[\s\S]*<td align="right">2<\/td>/);
  assert.match(renderSafeMarkdown('- [x] erledigt'), /<input checked disabled type="checkbox" \/> erledigt/);
  assert.match(renderSafeMarkdown('```js\nx<y\n```'), /<code class="language-js">x&lt;y/);
  assert.match(renderSafeMarkdown('![Bild](images/a%20b.jpg)'), /<img src="images\/a%20b.jpg" alt="Bild" \/>/);
  assert.match(renderSafeMarkdown('H<sub>2</sub>O, Zeile<br>zwei'), /H<sub>2<\/sub>O, Zeile<br \/>zwei/);
  assert.match(renderSafeMarkdown('[Mail](mailto:a@b.de) [Web](https://example.org/x?y=1)'),
    /<a href="mailto:a@b.de">Mail<\/a> <a href="https:\/\/example.org\/x\?y=1">Web<\/a>/);
});

test('HTML-Bereinigung: unbekannte Tags werden als Text sichtbar', () => {
  assert.equal(sanitizeRenderedHtml('<p>a<kontext>k</kontext>b</p>'), '<p>a&lt;kontext&gt;k&lt;/kontext&gt;b</p>');
});

test('Quelle-Links: nur http(s) wird übernommen', () => {
  assert.equal(safeHttpUrl('https://example.org/a'), 'https://example.org/a');
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(extractSourceUrl('[Hier](javascript:alert(1))'), null);
  assert.equal(extractSourceUrl('[Blog](https://joeturan.com/blog/x)'), 'https://joeturan.com/blog/x');
  assert.equal(extractSourceUrl('https://t.me/kanal/12.'), 'https://t.me/kanal/12');
});

// ─── CSP und Sicherheits-Header ────────────────────────────────────────────

function headerApp(mode) {
  const app = express();
  app.use(createSecurityHeaders({ mode }));
  app.get('/*', (_req, res) => res.send('ok'));
  return app;
}

test('CSP: Report-Only als Vorgabe, strikte Skripte, Nonce pro Antwort, weitere Header', async t => {
  const request = await listen(t, headerApp(undefined));
  const first = await request('GET', '/');
  const second = await request('GET', '/');
  const policy = first.headers['content-security-policy-report-only'];
  assert.ok(policy);
  assert.equal(first.headers['content-security-policy'], undefined);
  assert.match(policy, /script-src 'self' 'nonce-[A-Za-z0-9+/=]+';/);
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /frame-ancestors 'self'/);
  assert.match(policy, /font-src 'self' https:\/\/fonts\.gstatic\.com/);
  assert.match(policy, /report-uri \/api\/csp-report/);
  assert.notEqual(policy, second.headers['content-security-policy-report-only']);
  assert.equal(first.headers['x-content-type-options'], 'nosniff');
  assert.equal(first.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.match(first.headers['permissions-policy'], /microphone=\(self\)/);
});

test('CSP: enforce setzt die echte Richtlinie, PDF.js erhält WebAssembly, off nur übrige Header', async t => {
  const enforce = await listen(t, headerApp('enforce'));
  const app = await enforce('GET', '/');
  assert.ok(app.headers['content-security-policy']);
  assert.equal(app.headers['content-security-policy-report-only'], undefined);
  assert.doesNotMatch(app.headers['content-security-policy'], /wasm-unsafe-eval/);
  const pdf = await enforce('GET', '/vendor/pdfjs/web/viewer.html');
  assert.match(pdf.headers['content-security-policy'], /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(pdf.headers['content-security-policy'], /worker-src 'self' blob:/);
  const off = await listen(t, headerApp('off'));
  const response = await off('GET', '/');
  assert.equal(response.headers['content-security-policy'], undefined);
  assert.equal(response.headers['content-security-policy-report-only'], undefined);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.throws(() => cspMode('streng'), /CSP_MODE/);
});

test('CSP-Meldungen werden begrenzt ins Protokoll geschrieben', async t => {
  const warnings = [];
  const app = express();
  installCspReportRoute(app, express, { log: { warn: message => warnings.push(message) } });
  const request = await listen(t, app);
  const report = { 'csp-report': {
    'violated-directive': 'script-src-elem', 'blocked-uri': 'inline', 'document-uri': 'https://archiv/x',
    'source-file': 'https://archiv/app.js', 'line-number': 12,
  } };
  const response = await request('POST', '/api/csp-report', {
    body: report, headers: { 'content-type': 'application/csp-report' },
  });
  assert.equal(response.status, 204);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /CSP-Verstoß: script-src-elem blockiert inline auf https:\/\/archiv\/x \(https:\/\/archiv\/app\.js:12\)/);
  for (let i = 0; i < 30; i++) {
    await request('POST', '/api/csp-report', { body: report, headers: { 'content-type': 'application/csp-report' } });
  }
  assert.equal(warnings.length, 20);
});

test('Link-Vorschau /a/*: Weiterleitungs-Skript trägt die Nonce der CSP', async t => {
  const request = await listen(t, serverApp);
  const response = await request('GET', '/a/gibt-es-nicht');
  const nonce = response.headers['content-security-policy-report-only'].match(/'nonce-([^']+)'/)[1];
  assert.match(response.text, new RegExp(`<script nonce="${nonce.replace(/[+/=]/g, '\\$&')}">location\\.replace`));
});

test('Frontend: Kachelbilder ohne Inline-Handler, zentraler Fehler-Listener', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', 'public');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const books = fs.readFileSync(path.join(root, 'audiobooks.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const source of [app, books, html]) assert.doesNotMatch(source, /\son[a-z]+="/);
  assert.match(app, /document\.addEventListener\('error', event => \{[\s\S]*?data-fallback[\s\S]*?\}, true\);/);
});
