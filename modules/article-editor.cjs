const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { writeFileAtomic } = require('../lib/atomic-file.cjs');
const { isPathInside } = require('../lib/archive-files.cjs');
const { httpError: fail, jsonRoute } = require('../lib/http-errors.cjs');

const MAX_BYTES = 1024 * 1024;
const versionOf = content => createHash('sha256').update(content).digest('hex');

// Dateizugriff und Schreibsperre gelten auch während des anschließenden Reindex.
function createMarkdownEditor({ root, getArticle, canAccessAuthor, busy, reindex, io = fs }) {
  let running = false;
  async function resolve(id, user) {
    if (user?.role !== 'admin') throw fail(403, 'Nur Administratoren dürfen Artikel editieren.');
    const article = getArticle(id);
    if (!article) throw fail(404, 'Artikel nicht gefunden.');
    if (!canAccessAuthor(user, article.author)) throw fail(403, 'Kein Zugriff auf diesen Artikel.');
    if (!article.filePath) throw fail(404, 'Zu diesem Eintrag gibt es keine Markdown-Datei.');
    const bases = await Promise.all([].concat(root).map(dir => io.realpath(dir).catch(() => null)));
    const filename = await io.realpath(article.filePath);
    if (!bases.some(base => base && isPathInside(base, filename)) || path.extname(filename) !== '.md') {
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
      // Vor dem Ersetzen Pfad und Version erneut prüfen; der Eigentümer muss übernommen werden.
      await writeFileAtomic(filename, markdown, {
        io, prefix: 'article-edit', strictOwner: true,
        beforeRename: async () => {
          if (await resolve(id, user) !== filename) throw fail(409, 'Der Artikelpfad wurde inzwischen geändert.');
          assertVersion(await io.readFile(filename));
        },
      });
      const result = { saved: true, version: versionOf(markdown) };
      try { await reindex({ id, filename }); }
      catch { result.warning = 'Die Datei wurde gespeichert, aber der Index konnte nicht aktualisiert werden. Bitte das Archiv neu indizieren.'; }
      return result;
    } finally {
      running = false;
    }
  }
  return { read, save, get running() { return running; } };
}

function installMarkdownRoutes(app, requireAdmin, editor) {
  const route = handler => jsonRoute(handler, {
    label: 'Artikel-Editor',
    fallback: 'Artikeldatei konnte nicht gelesen oder gespeichert werden.',
    crossSiteMessage: 'Speichern ist nur aus dem Archiv erlaubt.',
    mapError: error => error.code === 'ENOENT' ? fail(404, 'Artikeldatei nicht gefunden.') : null,
  });
  app.get('/api/article-markdown/*', requireAdmin, route(req => editor.read(req.params[0], req.session.user)));
  app.put('/api/article-markdown/*', requireAdmin, route(req => editor.save(req.params[0], req.session.user, req.body)));
}

module.exports = { createMarkdownEditor, installMarkdownRoutes };
