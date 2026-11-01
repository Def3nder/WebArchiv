'use strict';

// Artikel-Scan: Markdown-Dateien unter www/<Autor>/… zu Rohindex-Einträgen.
// Getrennt in zwei Teile, damit der teure Teil später gecacht werden kann:
//  - parseArticleContent: hängt nur vom Inhalt der .md ab (Titel, Kategorien,
//    Auszüge, Dublettenprofil …) und ist damit pro Datei-Signatur wiederverwendbar.
//  - articleMedia: hängt nur von den Verzeichnislisten ab (Bild, Audio, Video,
//    PDF samt ?v=-Cache-Buster) und wird bei jedem Scan neu bestimmt.
// fileSignature (Größe, Änderungszeit) ist intern und geht nie an die API.

const fs = require('fs');
const path = require('path');
const { parseArticle, bodyExcerpt, mergeCategories, autoCategorize } = require('./article-parser.cjs');
const { buildDuplicateProfile } = require('./duplicates.cjs');
const { createDirectoryCache, findSibling, fileUrl, audioFileUrl, isPathInside } = require('./archive-files.cjs');

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png'];

function parseArticleContent(content, filePath, { duplicateProfile = false } = {}) {
  const parsed = parseArticle(content, filePath);
  // categories = unified taxonomy labels (for filtering); tags = raw Kategorien field (display only)
  const tags = (parsed.tags || []).slice(0, 10);
  return {
    title: parsed.title,
    date: parsed.date,
    // Der Titel zählt bei der Kategorisierung stärker als der übrige Text.
    categories: mergeCategories(tags, autoCategorize((parsed.summary || '') + ' ' + parsed.body, parsed.title)),
    tags,
    excerpt: parsed.summary ? parsed.summary.slice(0, 320) : bodyExcerpt(parsed.body),
    summary: parsed.summary || null,
    sourceUrl: parsed.sourceUrl || null,
    // Lang genug, um in der Listenansicht auch auf breiten Bildschirmen drei volle Zeilen zu füllen.
    preview: bodyExcerpt(parsed.body, 1000),
    episodeNum: parsed.episodeNum,
    instagramPoster: parsed.instagramPoster,
    // Intern (nicht in der API): eigener Text, Profil für die Dublettenerkennung.
    hasBody: !!parsed.body.trim(),
    duplicateProfile: duplicateProfile ? buildDuplicateProfile(parsed.title, parsed.body) : null,
  };
}

// Medien gleichen Namens neben der .md; Audio auch unter audio/<Autor>/<Pfad>,
// Bild ersatzweise www/<Autor>/standard.jpg. listing ist die Liste von dirPath.
function articleMedia({ wwwDir, audioDir, dirPath, author, relDir, basename, listing, directories }) {
  const ownImgPath = findSibling(dirPath, basename, IMAGE_EXTENSIONS, listing);
  const authorDir = path.join(wwwDir, author);
  const imgPath = ownImgPath || findSibling(authorDir, 'standard', IMAGE_EXTENSIONS, directories.get(authorDir));
  const localAudioPath = findSibling(dirPath, basename, ['.mp3'], listing);
  const externalAudioDir = path.join(audioDir, author, relDir);
  const externalAudioPath = localAudioPath
    ? null
    : findSibling(externalAudioDir, basename, ['.mp3'], directories.get(externalAudioDir));
  const audioPath = localAudioPath || externalAudioPath;
  const videoPath = findSibling(dirPath, basename, ['.mp4'], listing);
  const pdfPath   = findSibling(dirPath, basename, ['.pdf'], listing);

  const relative = (root, file) => path.relative(root, file).replace(/\\/g, '/');
  return {
    imageUrl: imgPath ? fileUrl(relative(wwwDir, imgPath), imgPath) : null,
    audioUrl: audioPath
      ? (localAudioPath
        ? fileUrl(relative(wwwDir, audioPath), audioPath)
        : audioFileUrl(relative(audioDir, audioPath), audioPath))
      : null,
    hasExternalAudio: !!externalAudioPath,
    videoUrl: videoPath ? fileUrl(relative(wwwDir, videoPath), videoPath) : null,
    pdfUrl:   pdfPath   ? fileUrl(relative(wwwDir, pdfPath), pdfPath)     : null,
    // Intern (nicht in der API): eigenes Bild statt standard.jpg.
    ownImage: !!ownImgPath,
  };
}

// trashDir: gelöschte Infografiken bleiben als Dateien erhalten, gehören aber nie
// wieder in den Index. wantsDuplicateProfile(author): Blog- und Quellautoren.
// onArticle: nach jedem eingelesenen Artikel (Fortschritt des Reindex).
function createArticleScanner({ wwwDir, audioDir, trashDir, wantsDuplicateProfile = () => false, onArticle = () => {} }) {
  async function scanDir(dirPath, author, year, collector, {
    strict = false, targetFile = null, directories = createDirectoryCache(),
  } = {}) {
    let entries;
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      if (strict) throw error;
      return;
    }
    directories.seed(dirPath, entries);
    const listing = directories.get(dirPath);
    const resolvedTarget = targetFile ? path.resolve(targetFile) : null;

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (resolvedTarget && !isPathInside(fullPath, resolvedTarget)) continue;
        if (fullPath === trashDir) continue;
        const nextYear = /^\d{4}$/.test(entry.name) ? entry.name : year;
        await scanDir(fullPath, author, nextYear, collector, { strict, targetFile: resolvedTarget, directories });
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      if (resolvedTarget && path.resolve(fullPath) !== resolvedTarget) continue;

      const basename = entry.name.slice(0, -3);
      const relDir = path.relative(path.join(wwwDir, author), dirPath);
      const id = [author, relDir, basename].filter(Boolean).join('/').replace(/\\/g, '/');

      try {
        const stat = await fs.promises.stat(fullPath);
        const content = await fs.promises.readFile(fullPath, 'utf8');
        const parsed = parseArticleContent(content, fullPath, { duplicateProfile: wantsDuplicateProfile(author) });
        collector.push({
          id,
          author,
          year: year || (parsed.date ? parsed.date.slice(0, 4) : ''),
          ...parsed,
          ...articleMedia({ wwwDir, audioDir, dirPath, author, relDir, basename, listing, directories }),
          filePath: fullPath,
          fileSignature: { size: stat.size, mtimeMs: stat.mtimeMs },
        });
        onArticle();
      } catch (err) {
        if (resolvedTarget) throw err;
        // skip unparseable files silently
      }
    }
  }

  return { scanDir };
}

module.exports = { parseArticleContent, articleMedia, createArticleScanner };
