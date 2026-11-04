'use strict';

// Neuer eigener Artikel (Admin, Dialog „Neuer Artikel“, Typ „Artikel“): Markdown und optional
// ein Bild in einer Anfrage (Bild base64 in JSON wie bei /api/new-infographic). Ziel ist
// www/<NEW_ARTICLE_AUTHOR>/<Jahr>/<Datum>_<lesbarer Titel>.md; ohne eigenes Bild greift das
// standard-Bild des Autors. Danach wird nur die neue Datei eingelesen.

const fs = require('fs');
const path = require('path');
const { httpError, jsonRoute } = require('../lib/http-errors.cjs');
const { resolveUnder } = require('../lib/archive-files.cjs');
const { parseArticle } = require('../lib/article-parser.cjs');
const { validateInfographicHeader, normalizeNewInfographicMarkdown, detectImageType } = require('../lib/infographics.cjs');
const { NEW_ARTICLE_AUTHOR, readableFileStem, articleStemExists } = require('../lib/new-article.cjs');

const NEW_ARTICLE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

// Das JSON-Limit für /api/new-article (Bild als base64) setzt server.js vor express.json().
// refreshFiles(absolutePaths): gezieltes Neueinlesen, läuft innerhalb der Sperre.
function installNewArticleRoutes(app, { requireAdmin, lock, wwwDir, refreshFiles, author = NEW_ARTICLE_AUTHOR }) {
  app.post('/api/new-article', requireAdmin, jsonRoute(async req => {
    if (lock.busy) throw lock.conflictError();
    const categories = Array.isArray(req.body?.categories) ? req.body.categories.map(String) : [];
    const markdown = normalizeNewInfographicMarkdown(req.body?.markdown, categories);
    const header = validateInfographicHeader(markdown);
    const title = parseArticle(markdown, 'neu.md').title;
    if (!header.hasTitle || /\[titel\]/i.test(title)) throw httpError(400, 'Bitte in der ersten Zeile einen Titel eintragen.');
    if (!header.date) throw httpError(400, 'Die Datum-Zeile fehlt oder ist ungültig (JJJJ-MM-TT).');
    const name = readableFileStem(title);
    if (!name) throw httpError(400, 'Aus dem Titel lässt sich kein Dateiname ableiten.');

    const image = req.body?.image ? Buffer.from(String(req.body.image), 'base64') : null;
    let imageExt = null;
    if (image) {
      if (!image.length) throw httpError(400, 'Die Bilddatei ist leer.');
      if (image.length > NEW_ARTICLE_IMAGE_MAX_BYTES) throw httpError(413, 'Die Bilddatei ist größer als 10 MB.');
      imageExt = detectImageType(image);
      if (!imageExt) throw httpError(415, 'Nur PNG- und JPG-Bilder sind erlaubt.');
    }

    const year = header.date.slice(0, 4);
    const dir = resolveUnder(wwwDir, author, year);
    if (!dir) throw httpError(400, 'Kein gültiger Zielordner.');
    const baseStem = `${header.date}_${name}`;
    let stem = baseStem;
    for (let n = 2; articleStemExists(dir, stem); n++) stem = `${baseStem}-${n}`;
    const mdPath = path.join(dir, stem + '.md');
    const imagePath = imageExt ? path.join(dir, stem + imageExt) : null;

    // Zwischen Prüfung oben und hier liegt nur synchroner Code; die Sperre ist frei.
    return lock.run('Neuen Artikel speichern', async () => {
      await fs.promises.mkdir(dir, { recursive: true });
      // Bild zuerst: ein Artikel ohne sein Bild wäre schon sichtbar, ein Bild ohne Artikel nicht.
      if (imagePath) await fs.promises.writeFile(imagePath, image, { flag: 'wx' });
      try {
        await fs.promises.writeFile(mdPath, markdown, { flag: 'wx' });
      } catch (err) {
        if (imagePath) await fs.promises.unlink(imagePath).catch(() => {});
        throw err;
      }
      await refreshFiles([mdPath]);
      return { ok: true, id: [author, year, stem].join('/') };
    });
  }, {
    label: 'Neuer Artikel', fallback: 'Artikel konnte nicht gespeichert werden.',
    mapError: error => (error.code === 'EEXIST'
      ? httpError(409, 'Eine Datei mit diesem Namen existiert bereits. Bitte erneut speichern.') : null),
  }));
}

module.exports = { NEW_ARTICLE_IMAGE_MAX_BYTES, installNewArticleRoutes };
