'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { renderIndexForSession, requireAdminAccess } = require('../server.js');

function request({ role = 'admin', method = 'POST', token, sessionToken = token, origin, fetchSite } = {}) {
  const headers = {
    host: 'archiv.example.test',
    ...(token === undefined ? {} : { 'x-csrf-token': token }),
    ...(origin === undefined ? {} : { origin }),
    ...(fetchSite === undefined ? {} : { 'sec-fetch-site': fetchSite }),
  };
  return {
    method,
    protocol: 'https',
    session: role ? { user: { role }, adminCsrfToken: sessionToken } : {},
    get(name) { return headers[String(name).toLowerCase()]; },
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('Gast- und Benutzer-Shell enthalten keine Admin-Dialoge oder Admin-Skripte', () => {
  for (const role of [null, 'guest', 'user']) {
    const html = renderIndexForSession({ session: role ? { user: { role } } : {} });
    assert.doesNotMatch(html, /id="(?:scrape-overlay|tts-overlay|article-editor|infographic-manager|tts-settings-dialog|user-admin|duplicate-review)"/);
    assert.doesNotMatch(html, /data-action="(?:reindex|scrape|log|tts-job|tts-settings|new-infographic|review-infographics|duplicates|users)"/);
    assert.doesNotMatch(html, /(?:user-admin|tts-settings|duplicates|article-editor\.bundle|infographic-new|infographic-manager)\.js/);
    assert.doesNotMatch(html, /admin-csrf-token/);
    assert.match(html, /id="password-dialog"/);
    assert.match(html, /password\.js\?v=1/);
    assert.match(html, /data-action="settings"/);
  }
});

test('Admin-Shell enthält die vollständige Oberfläche und ein sitzungsgebundenes Token', () => {
  const req = { session: { user: { role: 'admin', mustChangePassword: false } } };
  const html = renderIndexForSession(req);
  assert.match(html, /id="user-admin"/);
  assert.match(html, /id="tts-settings-dialog"/);
  assert.match(html, /user-admin\.js\?v=12/);
  assert.doesNotMatch(html, /password\.js\?v=1/);
  assert.match(html, new RegExp(`<meta name="admin-csrf-token" content="${req.session.adminCsrfToken}">`));
  assert.match(req.session.adminCsrfToken, /^[a-f0-9]{64}$/);
});

test('Admin mit ausstehendem Kennwortwechsel erhält zunächst nur die normale Shell', () => {
  const html = renderIndexForSession({
    session: { user: { role: 'admin', mustChangePassword: true } },
  });
  assert.doesNotMatch(html, /id="user-admin"/);
  assert.match(html, /password\.js\?v=1/);
});

test('zentrale Admin-Middleware schützt Rolle, Herkunft und CSRF-Token', () => {
  let nextCalled = false;
  let res = response();
  requireAdminAccess(request({ role: 'user', token: 'x' }), res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);

  res = response();
  requireAdminAccess(request({ token: undefined }), res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /Sicherheitstoken/);

  res = response();
  requireAdminAccess(request({ token: 'secret', fetchSite: 'cross-site' }), res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /Archiv/);

  res = response();
  requireAdminAccess(request({ token: 'secret', origin: 'https://evil.example' }), res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /Anfrageherkunft/);

  res = response();
  requireAdminAccess(request({ token: 'wrong', sessionToken: 'secret' }), res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /Sicherheitstoken/);

  nextCalled = false;
  res = response();
  requireAdminAccess(request({ token: 'secret', origin: 'https://archiv.example.test' }), res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 200);
  assert.equal(nextCalled, true);

  nextCalled = false;
  res = response();
  requireAdminAccess(request({ method: 'GET', token: undefined }), res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('Frontend hängt das Admin-CSRF-Token zentral an schreibende API-Aufrufe', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const editor = fs.readFileSync(path.join(ROOT, 'public', 'article-editor.js'), 'utf8');
  const infographic = fs.readFileSync(path.join(ROOT, 'public', 'infographic-new.js'), 'utf8');
  assert.match(app, /meta\[name="admin-csrf-token"\]/);
  assert.match(app, /'X-CSRF-Token': csrf/);
  assert.match(editor, /apiFetch\(`\/api\/article-markdown/);
  assert.match(infographic, /apiFetch\('\/api\/new-infographic'/);
});
