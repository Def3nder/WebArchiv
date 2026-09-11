const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_BYTES = 1024 * 1024;
const versionOf = content => createHash('sha256').update(content).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });

// Dateizugriff und Schreibsperre gelten auch während des anschließenden Reindex.
function createMarkdownEditor({ root, getArticle, canAccessAuthor, busy, reindex, io = fs }) {
  let running = false;
  async function resolve(id, user) {
    if (user?.role !== 'admin') throw fail(403, 'Nur Administratoren dürfen Artikel editieren.');
    const article = getArticle(id);
    if (!article) throw fail(404, 'Artikel nicht gefunden.');
    if (!canAccessAuthor(user, article.author)) throw fail(403, 'Kein Zugriff auf diesen Artikel.');
    const base = await io.realpath(root);
    const filename = await io.realpath(article.filePath);
    if (!filename.startsWith(base + path.sep) || path.extname(filename) !== '.md') {
      throw fail(403, 'Ungültiger Artikelpfad.');
    }
    // Ein Austausch würde sonst den Link statt der Originaldatei ersetzen.
    if ((await io.lstat(article.filePath)).isSymbolicLink()) throw fail(403, 'Verknüpfte Artikeldateien können nicht editiert werden.');
    return filename;
  }
  async function read(id, user) {
    const filename = await resolve(id, user);
    const content = await io.readFile(filename);
    if (content.length > MAX_BYTES) throw fail(413, 'Der Artikel ist größer als 1 MB.');
    return { markdown: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content), version: versionOf(content) };
  }
  async function save(id, user, input) {
    if (user?.role !== 'admin') throw fail(403, 'Nur Administratoren dürfen Artikel editieren.');
    if (typeof input?.markdown !== 'string' || !input.markdown.trim() || input.markdown.includes('\0')
        || !/^[a-f0-9]{64}$/.test(input.version || '')) throw fail(400, 'Markdown-Text und gültige Dateiversion sind erforderlich.');
    if (Buffer.byteLength(input.markdown) > MAX_BYTES) throw fail(413, 'Der Artikel ist größer als 1 MB.');
    if (running || busy()) throw fail(409, 'Es läuft bereits ein Reindex-, Scrape-, Audio- oder Speicherauftrag. Bitte später erneut speichern.');
    running = true;
    let temp;
    try {
      const filename = await resolve(id, user);
      const original = await io.readFile(filename);
      const assertVersion = content => {
        if (versionOf(content) !== input.version) throw fail(409, 'Die Datei wurde inzwischen geändert. Ihr Entwurf bleibt erhalten. Bitte kopieren Sie ihn und laden Sie die aktuelle Datei neu.');
      };
      assertVersion(original);
      // Textareas normalisieren Zeilenenden; das ursprüngliche Dateiformat erhalten.
      const oldText = original.toString('utf8');
      let markdown = input.markdown.replace(/\r\n/g, '\n');
      if (oldText.includes('\r\n')) markdown = markdown.replace(/\n/g, '\r\n');
      if (oldText.startsWith('\uFEFF') && !markdown.startsWith('\uFEFF')) markdown = '\uFEFF' + markdown;
      if (Buffer.byteLength(markdown) > MAX_BYTES) throw fail(413, 'Der Artikel ist größer als 1 MB.');
      const stat = await io.stat(filename);
      temp = path.join(path.dirname(filename), `.article-edit-${randomUUID()}.tmp`);
      const handle = await io.open(temp, 'wx', stat.mode & 0o777);
      try {
        await handle.writeFile(markdown, 'utf8');
        if (process.platform !== 'win32') {
          await handle.chown(stat.uid, stat.gid);
          await handle.chmod(stat.mode & 0o777);
        }
        await handle.sync();
      } finally { await handle.close(); }
      if (await resolve(id, user) !== filename) throw fail(409, 'Der Artikelpfad wurde inzwischen geändert.');
      assertVersion(await io.readFile(filename));
      await io.rename(temp, filename);
      temp = null;
      const result = { saved: true, version: versionOf(markdown) };
      try { await reindex(); }
      catch { result.warning = 'Die Datei wurde gespeichert, aber der Index konnte nicht aktualisiert werden. Bitte das Archiv neu indizieren.'; }
      return result;
    } finally {
      try { if (temp) await io.unlink(temp); }
      finally { running = false; }
    }
  }
  return { read, save, get running() { return running; } };
}

function installMarkdownRoutes(app, requireAdmin, editor) {
  const route = handler => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json(await handler(req)); }
    catch (error) {
      const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
      res.status(status).json({ error: error.status ? error.message : status === 404
        ? 'Artikeldatei nicht gefunden.' : 'Artikeldatei konnte nicht gelesen oder gespeichert werden.' });
    }
  };
  app.get('/api/article-markdown/*', requireAdmin, route(req => editor.read(req.params[0], req.session.user)));
  app.put('/api/article-markdown/*', requireAdmin, route(req => {
    if (req.get('sec-fetch-site') === 'cross-site') throw fail(403, 'Speichern ist nur aus dem Archiv erlaubt.');
    return editor.save(req.params[0], req.session.user, req.body);
  }));
}

module.exports = { createMarkdownEditor, installMarkdownRoutes };
