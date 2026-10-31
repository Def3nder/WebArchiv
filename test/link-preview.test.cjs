'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const sharp = require('sharp');
const { installLinkPreviewRoutes, installPromptRoutes } = require('../modules/link-preview.cjs');

async function start(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'link-preview-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wwwDir = path.join(root, 'www');
  const audioDir = path.join(root, 'audio');
  const promptsDir = path.join(root, 'prompts');
  for (const dir of [path.join(wwwDir, 'Joe', '2026'), audioDir, promptsDir]) fs.mkdirSync(dir, { recursive: true });
  await sharp({ create: { width: 40, height: 80, channels: 3, background: '#336699' } })
    .jpeg().toFile(path.join(wwwDir, 'Joe', '2026', 'a.jpg'));
  fs.writeFileSync(path.join(root, 'geheim.jpg'), 'nicht teilen');
  fs.writeFileSync(path.join(promptsDir, '2_Zweiter.txt'), 'URL:\nhttps://example.com/b\n\nPROMPT:\nPrompt B\n');
  fs.writeFileSync(path.join(promptsDir, '1_Erster.txt'), 'URL:\nhttps://example.com/a\n\nPROMPT:\nPrompt A\n');
  fs.writeFileSync(path.join(promptsDir, 'kaputt.txt'), 'nur Text\n');
  fs.writeFileSync(path.join(promptsDir, 'notiz.md'), 'kein Prompt\n');

  const blog = {
    id: 'Joe/2026/a', title: 'Titel <b>& mehr</b>', summary: 'Kurz'.repeat(80), imageUrl: '/files/Joe/2026/a.jpg?v=1',
  };
  const facebook = { id: 'Facebook/2026/a', title: 'Dublette', imageUrl: null };
  const escaping = { id: 'Joe/2026/raus', title: 'Raus', imageUrl: '/files/..%2F..%2Fgeheim.jpg' };
  const archive = { articleById: new Map([blog, facebook, escaping].map(item => [item.id, item])) };
  const app = express();
  app.use((_req, res, next) => { res.locals.cspNonce = 'nonce123'; next(); });
  installLinkPreviewRoutes(app, {
    archive, wwwDir, audioDir,
    duplicateCanonicalFor: item => (item.id === facebook.id ? blog : null),
    audiobooks: { getForUser: (user, id) => (user === null && id === 'Hörbücher/Buch' ? { id, title: 'Buch', imageUrl: null } : null) },
  });
  installPromptRoutes(app, { attachUser: (_req, _res, next) => next(), promptsDir });
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('Link-Vorschau: Open-Graph-Tags, kanonische Dublette, Hörbuch und Unbekanntes', async t => {
  const base = await start(t);
  const page = async id => (await fetch(`${base}/a/${encodeURIComponent(id)}`)).text();

  let html = await page('Joe/2026/a');
  assert.match(html, /<meta property="og:title" content="Titel &lt;b&gt;&amp; mehr&lt;\/b&gt;" \/>/);
  assert.match(html, /<meta property="og:description" content="(Kurz){49}K…" \/>/);
  assert.match(html, /og:image" content="http:\/\/127\.0\.0\.1:\d+\/og-image\/Joe%2F2026%2Fa"/);
  assert.match(html, /<script nonce="nonce123">location\.replace\("\/#\/article\/Joe%2F2026%2Fa"\);<\/script>/);

  html = await page('Facebook/2026/a');
  assert.match(html, /og:url" content="http:\/\/127\.0\.0\.1:\d+\/a\/Joe%2F2026%2Fa"/);
  html = await page('Hörbücher/Buch');
  assert.match(html, /<meta property="og:title" content="Buch" \/>/);
  assert.match(html, /twitter:card" content="summary"/);
  html = await page('gibt/es/nicht');
  assert.match(html, /<meta property="og:type" content="website" \/>/);
  assert.doesNotMatch(html, /og:image/);
});

test('Vorschaubild: verkleinert, quadratisch für die Media Session, nie außerhalb des Archivs', async t => {
  const base = await start(t);
  let res = await fetch(`${base}/og-image/${encodeURIComponent('Joe/2026/a')}`);
  assert.deepEqual([res.status, res.headers.get('content-type'), res.headers.get('cache-control')],
    [200, 'image/jpeg', 'public, max-age=86400']);
  res = await fetch(`${base}/og-image/${encodeURIComponent('Joe/2026/a')}?sq=256`);
  const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
  assert.deepEqual([meta.width, meta.height], [256, 256]);

  res = await fetch(`${base}/og-image/${encodeURIComponent('Facebook/2026/a')}`);
  assert.equal(res.status, 200, 'verknüpfte Dublette zeigt das Bild ihres Blogartikels');

  for (const id of ['Joe/2026/raus', 'gibt/es/nicht']) {
    res = await fetch(`${base}/og-image/${encodeURIComponent(id)}`);
    assert.equal(res.status, 404, id);
  }
});

test('Prompts: Reihenfolge nach Zahl, ungültige Dateien ignoriert, Einzelabruf mit Pfadschutz', async t => {
  const base = await start(t);
  const original = console.warn;
  console.warn = () => {};
  let list;
  try { list = await (await fetch(`${base}/api/prompts`)).json(); } finally { console.warn = original; }
  assert.deepEqual(list.map(item => [item.label, item.url, item.prompt]), [
    ['Erster', 'https://example.com/a', 'Prompt A'], ['Zweiter', 'https://example.com/b', 'Prompt B'],
  ]);

  let res = await fetch(`${base}/api/prompts/1_Erster.txt`);
  assert.deepEqual([res.status, res.headers.get('content-type').split(';')[0], await res.text()], [200, 'text/plain', 'Prompt A']);
  res = await fetch(`${base}/api/prompts/kaputt.txt`);
  assert.deepEqual([res.status, await res.text()], [422, 'URL:- oder PROMPT:-Abschnitt fehlt.']);
  assert.equal((await fetch(`${base}/api/prompts/fehlt.txt`)).status, 404);
  assert.equal((await fetch(`${base}/api/prompts/notiz.md`)).status, 400);
  assert.equal((await fetch(`${base}/api/prompts/..%2F..%2Fgeheim.txt`)).status, 404, 'nur der Dateiname zählt');
});
