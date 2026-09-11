const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createMarkdownEditor, installMarkdownRoutes } = require('./article-editor.cjs');

const admin = { role: 'admin', allowedAuthors: null };
const original = '\uFEFF# Prüfung\r\n\r\nDatum: 2026-09-11\r\nKategorien: Wissen\r\n****\r\nEin **Text** mit Umlauten: äöü.\r\n';
async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'webarchiv-editor-'));
  const root = path.join(base, 'www');
  await fs.mkdir(root);
  const filePath = path.join(root, 'artikel.md');
  await fs.writeFile(filePath, original);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const article = { id: 'Autor/2026/Prüfung', author: 'Autor', filePath };
  let indexes = 0;
  const editor = createMarkdownEditor({ root, getArticle: id => id === article.id ? article : null,
    canAccessAuthor: (user, author) => user.allowedAuthors === null || user.allowedAuthors.includes(author),
    busy: () => false, reindex: async () => { indexes++; }, ...options });
  return { editor, root, filePath, article, indexes: () => indexes };
}
test('Originaldatei, Unicode, Metadaten, BOM und CRLF bleiben erhalten; Reindex folgt', async t => {
  const f = await fixture(t);
  const loaded = await f.editor.read(f.article.id, admin);
  assert.equal(loaded.markdown, original);
  const updated = loaded.markdown.replace(/\r\n/g, '\n').replace('Ein **Text**', 'Geänderter **Text**');
  const result = await f.editor.save(f.article.id, admin, { ...loaded, markdown: updated });
  assert.equal(result.saved, true);
  assert.equal(await fs.readFile(f.filePath, 'utf8'), original.replace('Ein **Text**', 'Geänderter **Text**'));
  assert.equal(result.version, (await f.editor.read(f.article.id, admin)).version);
  assert.equal(f.indexes(), 1);
  assert.deepEqual(await fs.readdir(f.root), ['artikel.md']);
});
test('Gast, Benutzer, fremder Autor und unbekannte ID werden abgewiesen', async t => {
  const f = await fixture(t);
  for (const user of [null, { role: 'user' }, { role: 'admin', allowedAuthors: [] }]) {
    await assert.rejects(f.editor.read(f.article.id, user), { status: 403 });
    const input = { markdown: 'Text', version: 'a'.repeat(64) };
    await assert.rejects(f.editor.save(f.article.id, user, input), { status: 403 });
  }
  await assert.rejects(f.editor.read('../secret', admin), { status: 404 });
});
test('Indexpfade außerhalb www und Verzeichnislinks nach außen werden abgewiesen', async t => {
  const f = await fixture(t);
  const external = path.join(path.dirname(f.root), 'outside');
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, 'secret.md'), 'secret');
  f.article.filePath = path.join(external, 'secret.md');
  await assert.rejects(f.editor.read(f.article.id, admin), { status: 403 });
  const link = path.join(f.root, 'link');
  await fs.symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  f.article.filePath = path.join(link, 'secret.md');
  await assert.rejects(f.editor.read(f.article.id, admin), { status: 403 });
});
test('Versionskonflikte überschreiben keine externen Änderungen', async t => {
  const f = await fixture(t);
  const loaded = await f.editor.read(f.article.id, admin);
  await fs.writeFile(f.filePath, 'Extern bearbeitet');
  await assert.rejects(f.editor.save(f.article.id, admin, { ...loaded, markdown: 'Mein Entwurf' }), { status: 409 });
  assert.equal(await fs.readFile(f.filePath, 'utf8'), 'Extern bearbeitet');
  assert.equal(f.editor.running, false);
});
test('Fehler beim Ersetzen erhalten Original und entfernen temporäre Datei', async t => {
  const f = await fixture(t, { io: { ...fs, rename: async () => { throw Object.assign(new Error('Schreibschutz'), { code: 'EACCES' }); } } });
  const loaded = await f.editor.read(f.article.id, admin);
  await assert.rejects(f.editor.save(f.article.id, admin, { ...loaded, markdown: 'Entwurf' }), { code: 'EACCES' });
  assert.equal(await fs.readFile(f.filePath, 'utf8'), original);
  assert.deepEqual(await fs.readdir(f.root), ['artikel.md']);
  assert.equal(f.editor.running, false);
});
test('Auftragssperre bleibt bis zum Ende des Reindex aktiv', async t => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { reindex: () => { started(); return barrier; } });
  const loaded = await f.editor.read(f.article.id, admin);
  const saving = f.editor.save(f.article.id, admin, { ...loaded, markdown: 'Neu' });
  await ready;
  try {
    assert.equal(f.editor.running, true);
    await assert.rejects(f.editor.save(f.article.id, admin, { ...loaded, markdown: 'Parallel' }), { status: 409 });
  } finally { release(); await saving; }
  assert.equal(f.editor.running, false);
});
test('Laufende Fremdaufträge blockieren; fehlerhafter Reindex meldet gespeicherte Datei', async t => {
  const f = await fixture(t, { busy: () => true });
  const loaded = await f.editor.read(f.article.id, admin);
  await assert.rejects(f.editor.save(f.article.id, admin, { ...loaded, markdown: 'Neu' }), { status: 409 });
  const g = await fixture(t, { reindex: async () => { throw new Error('Indexfehler'); } });
  const result = await g.editor.save(g.article.id, admin, { ...loaded, markdown: 'Gespeichert' });
  assert.equal(result.saved, true);
  assert.match(result.warning, /gespeichert/);
  assert.match(await fs.readFile(g.filePath, 'utf8'), /Gespeichert/);
});
test('Leere, ungültige und zu große Eingaben werden abgewiesen', async t => {
  const f = await fixture(t);
  const loaded = await f.editor.read(f.article.id, admin);
  for (const markdown of ['', '  ', null, 'Text\0']) {
    await assert.rejects(f.editor.save(f.article.id, admin, { ...loaded, markdown }), { status: 400 });
  }
  await assert.rejects(f.editor.save(f.article.id, admin, { ...loaded, markdown: 'ä'.repeat(600000) }), { status: 413 });
});
test('HTTP-Endpunkte prüfen Session, Autor und Cross-Site-Schreiben', async t => {
  const f = await fixture(t);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { user: req.get('x-test-admin') ? admin : null }; next(); });
  installMarkdownRoutes(app, (req, res, next) => req.session.user ? next() : res.sendStatus(403), f.editor);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/api/article-markdown/${f.article.id.split('/').map(encodeURIComponent).join('/')}`;
  assert.equal((await fetch(url)).status, 403);
  const response = await fetch(url, { headers: { 'x-test-admin': '1' } });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const loaded = await response.json();
  const options = { method: 'PUT', headers: { 'x-test-admin': '1', 'content-type': 'application/json' }, body: JSON.stringify({ ...loaded, markdown: 'Neu' }) };
  assert.equal((await fetch(url, { ...options, headers: { ...options.headers, 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(url, options)).status, 200);
  assert.equal((await fetch(url, options)).status, 409);
});
