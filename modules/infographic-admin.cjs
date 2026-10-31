'use strict';

// Infografiken (Admin): Upload zu einem Artikel, Verwaltung der Artikelgrafiken
// (Reihenfolge, Papierkorb, Instagram-Poster), Prüfmodus und neue eigenständige
// Infografik. Zuordnung, Benennung und Kopfbearbeitung liegen in lib/infographics.cjs;
// nach jeder Änderung wird nur der betroffene Jahrgang neu eingelesen.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { httpError, jsonRoute } = require('../lib/http-errors.cjs');
const { isPathInside, resolveUnder } = require('../lib/archive-files.cjs');
const { parseArticle } = require('../lib/article-parser.cjs');
const {
  INFOGRAPHICS_AUTHOR, imageExtensionFromContentType, infographicStemExists, infographicAttachmentStem,
  validateInfographicHeader, buildInfographicMarkdown, retitleInfographicMarkdown, setInstagramPosterMetadata,
  moveInfographicFiles, slugify, normalizeNewInfographicMarkdown, detectImageType,
} = require('../lib/infographics.cjs');

const INFOGRAPHIC_MAX_BYTES = 10 * 1024 * 1024;
const MEDIA_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.mp3', '.mp4', '.pdf']);

// Eine suffixlose Infografik unter dem Dateistamm des Artikels, die nicht zu ihm gehört.
function conflictingInfographicBase(article, byId, anchorOf) {
  if (article.author === INFOGRAPHICS_AUTHOR) return false;
  const year = article.year || article.date?.slice(0, 4) || '';
  const stem = path.basename(article.filePath, '.md');
  const base = byId.get([INFOGRAPHICS_AUTHOR, year, stem].join('/'));
  return !!base && anchorOf.get(base.id) !== article.id;
}

function firstAvailableInfographicOrdinal(article, byId, anchorOf) {
  const year = article.year || article.date?.slice(0, 4) || '';
  const stem = path.basename(article.filePath, '.md');
  const base = byId.get([INFOGRAPHICS_AUTHOR, year, stem].join('/'));
  // Solange eine alte suffixlose Grafik noch diesem Artikel gehört, darf _1
  // nicht neu entstehen: sonst würde die alte Basis als Original erscheinen.
  return base && anchorOf.get(base.id) === article.id ? 2 : 1;
}

// Markdown und gleichnamige Medien einer Infografik (auch für den Dubletten-Umzug).
function filesForInfographic(article) {
  const dir = path.dirname(article.filePath);
  const stem = path.basename(article.filePath, '.md').toLowerCase();
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .filter(entry => {
      const ext = path.extname(entry.name).toLowerCase();
      return path.basename(entry.name, ext).toLowerCase() === stem
        && (ext === '.md' || MEDIA_EXTENSIONS.has(ext));
    })
    .map(entry => path.join(dir, entry.name));
}

async function setManagedInfographicInstagramPoster(item, enabled) {
  if (typeof enabled !== 'boolean') throw httpError(400, 'Der Instagram-Poster-Wert ist ungültig.');
  const original = await fs.promises.readFile(item.mdPath, 'utf8');
  const updated = setInstagramPosterMetadata(original, enabled);
  if (updated === original) return async () => {};
  return moveInfographicFiles([{ source: item.mdPath, target: item.mdPath, content: updated }]);
}

async function reorderManagedInfographics(context, orderedIds) {
  const { bundles, baseStem, dir } = context;
  if (!Array.isArray(orderedIds) || orderedIds.length !== bundles.length
    || new Set(orderedIds).size !== bundles.length
    || orderedIds.some(id => !bundles.some(item => item.id === id))) {
    throw httpError(400, 'Die Reihenfolge enthält nicht genau die vorhandenen Infografiken.');
  }
  if (!bundles.length) return async () => {};
  const byId = new Map(bundles.map(item => [item.id, item]));
  const key = file => process.platform === 'win32' ? file.toLowerCase() : file;
  const ownedFiles = new Set(bundles.flatMap(item => item.files).map(key));
  const blockedStems = new Set(fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .filter(entry => ['.md', '.png', '.jpg', '.jpeg'].includes(path.extname(entry.name).toLowerCase()))
    .filter(entry => !ownedFiles.has(key(path.join(dir, entry.name))))
    .map(entry => path.basename(entry.name, path.extname(entry.name)).toLowerCase()));
  const mappings = [];
  let nextOrdinal = 1;
  for (const id of orderedIds) {
    const bundle = byId.get(id);
    while (nextOrdinal < 1000) {
      const candidate = infographicAttachmentStem(baseStem, nextOrdinal);
      if (!blockedStems.has(candidate.toLowerCase())) break;
      nextOrdinal++;
    }
    if (nextOrdinal >= 1000) throw httpError(409, 'Keine freien Infografik-Dateinamen gefunden.');
    const ordinal = nextOrdinal++;
    const stem = infographicAttachmentStem(baseStem, ordinal);
    for (const source of bundle.files) {
      const extension = path.extname(source).toLowerCase();
      const item = { source, target: path.join(dir, stem + extension) };
      if (extension === '.md' && ordinal !== bundle.ordinal) {
        item.content = retitleInfographicMarkdown(await fs.promises.readFile(source, 'utf8'), bundle.ordinal, ordinal);
      }
      if (source !== item.target) mappings.push(item);
    }
  }
  return moveInfographicFiles(mappings);
}

// archive: Indexzustand aus server.js (Felder erst beim Aufruf lesen).
// canAccessAuthor / duplicateCanonicalFor: Rechte und Dubletten-Zuordnung aus server.js.
function createInfographicAdmin({ archive, wwwDir, trashDir, canAccessAuthor, duplicateCanonicalFor }) {
  const conflictingBase = article => conflictingInfographicBase(article, archive.articleById, archive.groupAnchorOf);
  const firstAvailableOrdinal = article => firstAvailableInfographicOrdinal(article, archive.articleById, archive.groupAnchorOf);

  function canUploadInfographic(sessionUser, article) {
    return !!(
      sessionUser?.role === 'admin' &&
      article &&
      canAccessAuthor(sessionUser, article.author) &&
      (article.author !== INFOGRAPHICS_AUTHOR || !archive.groupAnchorOf.has(article.id)) &&
      !conflictingBase(article)
    );
  }

  function getInfographicTarget(article, imageExt) {
    const year = article.year || (article.date ? article.date.slice(0, 4) : '');
    if (!/^\d{4}$/.test(year)) return null;

    const dir = resolveUnder(wwwDir, INFOGRAPHICS_AUTHOR, year);
    if (!dir) return null;

    const baseStem = path.basename(article.filePath, '.md');
    for (let ordinal = firstAvailableOrdinal(article); ordinal < 1000; ordinal++) {
      const stem = infographicAttachmentStem(baseStem, ordinal);
      if (!infographicStemExists(dir, stem)) {
        return {
          dir,
          year,
          ordinal,
          stem,
          mdPath: path.join(dir, stem + '.md'),
          imagePath: path.join(dir, stem + imageExt),
          id: [INFOGRAPHICS_AUTHOR, year, stem].join('/'),
        };
      }
    }
    return null;
  }

  // Die Artikelverwaltung bearbeitet ausschließlich die zu diesem Artikel
  // gruppierten Grafiken. Eine eigenständige Basis-Infografik (mit eigenem Text
  // oder Audio) wird niemals durch Umordnen/Löschen ihrer Anhänge verändert.
  function managedInfographicContext(id, user) {
    const requested = archive.articleById.get(id);
    if (!requested) throw httpError(404, 'Artikel nicht gefunden.');
    const article = duplicateCanonicalFor(requested, user) || requested;
    if (!canUploadInfographic(user, article)) throw httpError(403, 'Keine Berechtigung für diese Infografiken.');
    const year = article.year || article.date?.slice(0, 4) || '';
    if (!/^\d{4}$/.test(year)) throw httpError(400, 'Der Artikel hat kein gültiges Jahr.');
    const dir = resolveUnder(wwwDir, INFOGRAPHICS_AUTHOR, year);
    const baseStem = path.basename(article.filePath, '.md');
    if (!dir || !baseStem) throw httpError(400, 'Kein gültiges Infografik-Ziel gefunden.');
    const members = (archive.infographicGroups.get(article.id) || []).filter(item => item.ownImage);
    const bundles = members.map(item => {
      if (item.author !== INFOGRAPHICS_AUTHOR || path.resolve(path.dirname(item.filePath)) !== dir
        || item.infographicBase !== baseStem) {
        throw httpError(409, 'Eine Grafik gehört nicht zu den verwaltbaren Artikel-Infografiken.');
      }
      const files = filesForInfographic(item);
      const imageFiles = files.filter(file => ['.png', '.jpg', '.jpeg'].includes(path.extname(file).toLowerCase()));
      if (files.length !== 2 || imageFiles.length !== 1 || !files.includes(item.filePath)) {
        throw httpError(409, 'Eine Infografik hat zusätzliche oder unvollständige Dateien und kann nicht automatisch verwaltet werden.');
      }
      return { id: item.id, ordinal: item.infographicOrdinal, title: item.title,
        imageUrl: item.imageUrl, instagramPoster: item.instagramPoster === true,
        files, mdPath: item.filePath };
    });
    const ownGraphic = article.author === INFOGRAPHICS_AUTHOR && article.ownImage
      ? {
          id: article.id, ordinal: 0, title: article.title, imageUrl: article.imageUrl,
          instagramPoster: article.instagramPoster === true, files: filesForInfographic(article),
          mdPath: article.filePath, fixed: true,
        }
      : null;
    return { article, dir, year, baseStem, bundles, items: ownGraphic ? [ownGraphic, ...bundles] : bundles };
  }

  async function prepareInfographicPosterBatch(changes) {
    if (!Array.isArray(changes) || !changes.length || changes.length > 2000) {
      throw httpError(400, 'Bitte mindestens eine und höchstens 2000 Änderungen senden.');
    }
    const seen = new Set();
    const mappings = [];
    const years = new Set();
    const updated = [];
    const root = path.join(wwwDir, INFOGRAPHICS_AUTHOR);

    for (const change of changes) {
      const id = typeof change?.id === 'string' ? change.id : '';
      if (!id || seen.has(id) || typeof change.enabled !== 'boolean'
          || (change.expected !== undefined && typeof change.expected !== 'boolean')) {
        throw httpError(400, 'Eine Poster-Änderung ist ungültig oder doppelt enthalten.');
      }
      seen.add(id);
      const article = archive.articleById.get(id);
      const mdPath = article?.filePath ? path.resolve(article.filePath) : '';
      if (!article || article.author !== INFOGRAPHICS_AUTHOR || !article.ownImage
          || !isPathInside(root, mdPath) || path.extname(mdPath).toLowerCase() !== '.md') {
        throw httpError(404, 'Infografik nicht gefunden: ' + id);
      }
      const current = article.instagramPoster === true;
      if (change.expected !== undefined && change.expected !== current) {
        throw httpError(409, 'Die Poster-Markierung wurde zwischenzeitlich geändert. Bitte die Ansicht neu laden.');
      }
      if (current === change.enabled) continue;
      const original = await fs.promises.readFile(mdPath, 'utf8');
      const content = setInstagramPosterMetadata(original, change.enabled);
      mappings.push({ source: mdPath, target: mdPath, content });
      years.add(article.year);
      updated.push({ id, instagramPoster: change.enabled });
    }

    return { mappings, years: [...years], updated };
  }

  async function infographicTrashFolder(year) {
    const root = await fs.promises.realpath(path.join(wwwDir, INFOGRAPHICS_AUTHOR));
    const ensureDirectory = async dir => {
      try {
        const stat = await fs.promises.lstat(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw httpError(409, 'Der Infografik-Papierkorb ist kein sicherer Ordner.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await fs.promises.mkdir(dir);
      }
      const real = await fs.promises.realpath(dir);
      if (!isPathInside(root, real)) throw httpError(403, 'Der Papierkorb liegt außerhalb des Infografik-Ordners.');
    };
    await ensureDirectory(trashDir);
    const yearDir = path.join(trashDir, year);
    await ensureDirectory(yearDir);
    for (let attempt = 0; attempt < 10; attempt++) {
      const name = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(4).toString('hex');
      const folder = path.join(yearDir, name);
      try { await fs.promises.mkdir(folder); return folder; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    throw httpError(409, 'Kein freier Platz im Infografik-Papierkorb gefunden.');
  }

  return {
    canUploadInfographic, conflictingBase, firstAvailableOrdinal, filesFor: filesForInfographic,
    getInfographicTarget, managedInfographicContext, prepareInfographicPosterBatch, infographicTrashFolder,
  };
}

// admin: createInfographicAdmin; refreshInfographicsForYear(s): Teil-Reindex der Jahrgänge.
// Das JSON-Limit für /api/new-infographic (Bild als base64) setzt server.js vor express.json().
function installInfographicRoutes(app, {
  requireAdmin, lock, admin, archive, wwwDir, duplicateCanonicalFor,
  refreshInfographicsForYear, refreshInfographicsForYears,
}) {
  app.get('/api/infographic-manager/*', requireAdmin, jsonRoute(req => {
    // Nur während exklusiver Dateiänderungen (z. B. Umbenennen) nicht lesen;
    // ein laufender Scrape oder eine Audio-Erzeugung stört das Öffnen nicht.
    if (lock.holder) throw httpError(409, `Es läuft gerade: ${lock.holder}. Bitte gleich erneut öffnen.`);
    const context = admin.managedInfographicContext(req.params[0], req.session.user);
    return {
      articleId: context.article.id,
      title: context.article.title,
      items: context.items.map(item => ({
        id: item.id, title: item.title, ordinal: item.ordinal,
        filename: path.basename(item.files.find(file => ['.png', '.jpg', '.jpeg']
          .includes(path.extname(file).toLowerCase())) || item.mdPath),
        imageUrl: item.imageUrl, instagramPoster: item.instagramPoster, fixed: item.fixed === true,
      })),
    };
  }, { label: 'Infografik-Verwaltung', fallback: 'Infografiken konnten nicht geladen werden.' }));

  app.post('/api/infographic-manager/*', requireAdmin, jsonRoute(req => lock.run('Infografiken ändern', async () => {
    let undoOrder = null;
    let undoTrash = null;
    let undoInstagramPoster = null;
    let trashFolder = null;
    let context = null;
    try {
      context = admin.managedInfographicContext(req.params[0], req.session.user);
      if (req.body?.action === 'order') {
        undoOrder = await reorderManagedInfographics(context, req.body.ids);
      } else if (req.body?.action === 'instagram-poster') {
        const item = context.items.find(candidate => candidate.id === req.body.id);
        if (!item) throw httpError(404, 'Infografik nicht gefunden.');
        undoInstagramPoster = await setManagedInfographicInstagramPoster(item, req.body.enabled);
      } else if (req.body?.action === 'trash') {
        const item = context.bundles.find(bundle => bundle.id === req.body.id);
        if (!item) throw httpError(404, 'Infografik nicht gefunden.');
        trashFolder = await admin.infographicTrashFolder(context.year);
        undoTrash = await moveInfographicFiles(item.files.map(source => ({
          source, target: path.join(trashFolder, path.basename(source)),
        })));
        const remaining = context.bundles.filter(bundle => bundle.id !== item.id);
        undoOrder = await reorderManagedInfographics(
          { ...context, bundles: remaining }, remaining.map(bundle => bundle.id));
      } else {
        throw httpError(400, 'Unbekannte Infografik-Aktion.');
      }
      await refreshInfographicsForYear(context.year);
      return { ok: true, trash: trashFolder
        ? path.relative(wwwDir, trashFolder).replace(/\\/g, '/') : undefined };
    } catch (error) {
      try {
        if (undoOrder) await undoOrder();
        if (undoTrash) await undoTrash();
        if (undoInstagramPoster) await undoInstagramPoster();
        if ((undoOrder || undoTrash || undoInstagramPoster) && context) await refreshInfographicsForYear(context.year);
        if (trashFolder) await fs.promises.rmdir(trashFolder).catch(() => {});
      } catch (failed) { error.rollbackError = failed; }
      throw error;
    }
  }), { label: 'Infografik-Verwaltung', fallback: 'Infografiken konnten nicht geändert werden.' }));

  // Admin-Prüfmodus: Änderungen über beliebig viele Ergebnisseiten sammeln und
  // in einem atomaren Dateivorgang speichern. Anschließend werden ausschließlich
  // die tatsächlich betroffenen Infografik-Jahrgänge neu eingelesen.
  app.post('/api/infographic-review', requireAdmin, jsonRoute(req => lock.run('Infografik-Prüfung speichern', async () => {
    let undo = null;
    let years = [];
    try {
      const batch = await admin.prepareInfographicPosterBatch(req.body?.changes);
      years = batch.years;
      undo = await moveInfographicFiles(batch.mappings);
      await refreshInfographicsForYears(years);
      return { ok: true, updated: batch.updated };
    } catch (error) {
      try {
        if (undo) await undo();
        if (undo && years.length) await refreshInfographicsForYears(years);
      } catch (failed) { error.rollbackError = failed; }
      throw error;
    }
  }), { label: 'Infografik-Prüfung', fallback: 'Poster-Markierungen konnten nicht gespeichert werden.' }));

  app.post(
    '/api/infographics/*',
    requireAdmin,
    express.raw({ type: ['image/png', 'image/jpeg'], limit: INFOGRAPHIC_MAX_BYTES }),
    jsonRoute(async req => {
      if (lock.busy) throw lock.conflictError();
      const requested = archive.articleById.get(req.params[0]);
      if (!requested) throw httpError(404, 'Artikel nicht gefunden.');
      const article = duplicateCanonicalFor(requested, req.session.user) || requested;
      if (!admin.canUploadInfographic(req.session.user, article)) {
        throw httpError(403, 'Für diesen Artikel ist kein Infografik-Upload erlaubt.');
      }
      const imageExt = imageExtensionFromContentType(req.get('content-type'));
      if (!imageExt) throw httpError(415, 'Nur PNG- und JPG-Bilder sind erlaubt.');
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw httpError(400, 'Keine Bilddatei empfangen.');

      // Zwischen Prüfung oben und hier liegt nur synchroner Code; die Sperre ist frei.
      return lock.run('Infografik hochladen', async () => {
        let originalContent;
        try {
          originalContent = await fs.promises.readFile(article.filePath, 'utf8');
        } catch {
          throw httpError(500, 'Artikeldatei konnte nicht gelesen werden.');
        }
        const header = validateInfographicHeader(originalContent);
        if (!header.hasTitle) throw httpError(400, 'Der Artikel enthält keinen Titel.');
        if (!header.date) throw httpError(400, 'Der Artikel enthält keine gültige Datum-Zeile.');

        const target = admin.getInfographicTarget({ ...article, date: header.date, year: header.date.slice(0, 4) }, imageExt);
        if (!target) throw httpError(400, 'Kein gültiger Zielpfad für die Infografik gefunden.');

        await fs.promises.mkdir(target.dir, { recursive: true });
        await fs.promises.writeFile(target.mdPath, buildInfographicMarkdown(originalContent, target.ordinal), { flag: 'wx' });
        try {
          await fs.promises.writeFile(target.imagePath, req.body, { flag: 'wx' });
        } catch (err) {
          await fs.promises.unlink(target.mdPath).catch(() => {});
          throw err;
        }
        await refreshInfographicsForYear(header.date.slice(0, 4));
        return { ok: true, id: target.id, filename: path.basename(target.imagePath), ordinal: target.ordinal };
      });
    }, {
      label: 'Infografik hochladen', fallback: 'Infografik konnte nicht gespeichert werden.',
      mapError: error => (error.code === 'EEXIST'
        ? httpError(409, 'Eine Infografik mit diesem Namen existiert bereits. Bitte erneut versuchen.') : null),
    }),
  );

  // ─── Neue eigenständige Infografik (Admin, Aktionen-Menü) ───────────────────
  //
  // Markdown + Bild in einer Anfrage (Bild base64 in JSON, keine Zusatz-Abhängigkeit).
  // Dateiname: <Datum>_<Slug aus dem Titel>; Konflikt → -2, -3 … (nicht _2, das
  // bedeutet „Variante“). Unveränderte Platzhalter der Vorlage werden entfernt.
  app.post('/api/new-infographic', requireAdmin, jsonRoute(async req => {
    if (lock.busy) throw lock.conflictError();
    const categories = Array.isArray(req.body?.categories) ? req.body.categories.map(String) : [];
    const markdown = normalizeNewInfographicMarkdown(req.body?.markdown, categories);
    const header = validateInfographicHeader(markdown);
    const title = parseArticle(markdown, 'neu.md').title;
    if (!header.hasTitle || /\[titel\]/i.test(title)) throw httpError(400, 'Bitte in der ersten Zeile einen Titel eintragen.');
    if (!header.date) throw httpError(400, 'Die Datum-Zeile fehlt oder ist ungültig (JJJJ-MM-TT).');
    const slug = slugify(title);
    if (!slug) throw httpError(400, 'Aus dem Titel lässt sich kein Dateiname ableiten.');

    const image = Buffer.from(String(req.body?.image || ''), 'base64');
    if (!image.length) throw httpError(400, 'Bitte eine Grafik auswählen.');
    if (image.length > INFOGRAPHIC_MAX_BYTES) throw httpError(413, 'Die Bilddatei ist größer als 10 MB.');
    const imageExt = detectImageType(image);
    if (!imageExt) throw httpError(415, 'Nur PNG- und JPG-Bilder sind erlaubt.');

    const year = header.date.slice(0, 4);
    const dir = resolveUnder(wwwDir, INFOGRAPHICS_AUTHOR, year);
    if (!dir) throw httpError(400, 'Kein gültiger Zielordner.');
    const baseStem = `${header.date}_${slug}`;
    let stem = baseStem;
    for (let n = 2; infographicStemExists(dir, stem); n++) stem = `${baseStem}-${n}`;
    const mdPath = path.join(dir, stem + '.md');
    const imagePath = path.join(dir, stem + imageExt);

    // Zwischen Prüfung oben und hier liegt nur synchroner Code; die Sperre ist frei.
    return lock.run('Neue Infografik speichern', async () => {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(mdPath, markdown, { flag: 'wx' });
      try {
        await fs.promises.writeFile(imagePath, image, { flag: 'wx' });
      } catch (err) {
        await fs.promises.unlink(mdPath).catch(() => {});
        throw err;
      }
      await refreshInfographicsForYear(year);
      return { ok: true, id: [INFOGRAPHICS_AUTHOR, year, stem].join('/') };
    });
  }, {
    label: 'Neue Infografik', fallback: 'Infografik konnte nicht gespeichert werden.',
    mapError: error => (error.code === 'EEXIST'
      ? httpError(409, 'Eine Datei mit diesem Namen existiert bereits. Bitte erneut speichern.') : null),
  }));
}

module.exports = {
  INFOGRAPHIC_MAX_BYTES, createInfographicAdmin, installInfographicRoutes,
  conflictingInfographicBase, firstAvailableInfographicOrdinal, filesForInfographic,
  reorderManagedInfographics, setManagedInfographicInstagramPoster,
};
