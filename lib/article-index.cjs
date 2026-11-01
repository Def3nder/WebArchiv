'use strict';

// Hilfen für den In-Memory-Index: Fuse-Suchindex, angezeigter Autor von
// Infografiken, Listenoperationen der Teil-Reindexe und das Änderungsmanifest
// des Scrapers.

const Fuse = require('fuse.js');
const { INFOGRAPHICS_AUTHOR } = require('./infographics.cjs');

const SCRAPER_CHANGED_FILES_MARKER = '@@WEBARCHIV_CHANGED_FILES@@';

function buildArticleSearchIndex(articleList) {
  return new Fuse(articleList, {
    keys: [
      { name: 'title',      weight: 3 },
      { name: 'episodeNum', weight: 2 },
      { name: 'author',     weight: 1.5 },
      { name: 'categories', weight: 1 },
      { name: 'excerpt',    weight: 0.8 },
    ],
    threshold: 0.35,
    includeScore: true,
    ignoreLocation: true,
    minMatchCharLength: 2,
  });
}

function articleDisplayAuthor(article, linkedArticle = null) {
  if (article?.author !== INFOGRAPHICS_AUTHOR) return article?.author || '';
  return linkedArticle?.author || INFOGRAPHICS_AUTHOR;
}

function uniqueArticles(articleList) {
  const seen = new Set();
  return articleList.filter(article => {
    if (seen.has(article.id)) return false;
    seen.add(article.id);
    return true;
  });
}

// Hat ein Neu-Scan denselben Rohindex ergeben? Mit Index-Cache sind unveränderte Einträge
// feldweise identisch (gleiche Objekte und Arrays aus dem Cache, gleiche Medien-URLs samt ?v=);
// nur fileSignature entsteht je Scan neu und wird nach Größe und Änderungszeit verglichen.
// Ohne Cache neu geparste Einträge gelten als geändert (sicherer Fall: veröffentlichen).
function sameSourceArticles(previous, next) {
  if (previous.length !== next.length) return false;
  const byId = new Map(previous.map(article => [article.id, article]));
  return next.every(entry => {
    const old = byId.get(entry.id);
    if (!old) return false;
    const keys = Object.keys(entry);
    if (keys.length !== Object.keys(old).length) return false;
    return keys.every(key => (key === 'fileSignature'
      ? old.fileSignature?.size === entry.fileSignature?.size && old.fileSignature?.mtimeMs === entry.fileSignature?.mtimeMs
      : old[key] === entry[key]));
  });
}

function replaceInfographicYearArticles(articleList, year, scanned) {
  const folderPrefix = `${INFOGRAPHICS_AUTHOR}/${year}/`;
  return uniqueArticles([
    ...articleList.filter(article => !article.id.startsWith(folderPrefix)),
    ...scanned,
  ]);
}

function replaceArticleIndexEntry(articleList, id, replacement) {
  const index = articleList.findIndex(article => article.id === id);
  if (index < 0) throw new Error(`Artikel „${id}“ fehlt im Rohindex.`);
  if (!replacement || replacement.id !== id) throw new Error(`Artikel „${id}“ wurde unter einer unerwarteten ID eingelesen.`);
  const next = articleList.slice();
  next[index] = replacement;
  return next;
}

function upsertArticleIndexEntries(articleList, replacements) {
  const next = articleList.slice();
  const positions = new Map(next.map((article, index) => [article.id, index]));
  for (const replacement of replacements) {
    const index = positions.get(replacement.id);
    if (index === undefined) {
      positions.set(replacement.id, next.length);
      next.push(replacement);
    } else {
      next[index] = replacement;
    }
  }
  return uniqueArticles(next);
}

function parseScraperChangedFiles(output) {
  const markerLine = String(output || '').split(/\r?\n/)
    .findLast(line => line.startsWith(SCRAPER_CHANGED_FILES_MARKER));
  if (!markerLine) return null;
  try {
    const parsed = JSON.parse(markerLine.slice(SCRAPER_CHANGED_FILES_MARKER.length));
    return Array.isArray(parsed) && parsed.every(filename => typeof filename === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

module.exports = {
  buildArticleSearchIndex, articleDisplayAuthor, uniqueArticles, sameSourceArticles, replaceInfographicYearArticles,
  replaceArticleIndexEntry, upsertArticleIndexEntries, parseScraperChangedFiles, SCRAPER_CHANGED_FILES_MARKER,
};
