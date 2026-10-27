'use strict';

// Medien neben Artikeln finden (Verzeichnis-Cache je Scan), URLs mit
// Cache-Buster bilden und Pfade sicher unter einer Wurzel auflösen.

const fs = require('fs');
const path = require('path');

// Dateinamen eines Verzeichnisses: exakt (Normalfall) und klein geschrieben.
// Symlinks zählen mit, weil sie bisher über existsSync ebenfalls gefunden wurden.
function directoryListing(entries) {
  const exact = new Set();
  const lower = new Map();
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    exact.add(entry.name);
    const key = entry.name.toLowerCase();
    if (!lower.has(key)) lower.set(key, entry.name);
  }
  return { exact, lower };
}

// Ein Scan liest jedes Verzeichnis höchstens einmal: den Artikelordner, den
// parallelen Ordner unter audio/ und den Autorenordner (standard.jpg). Vorher
// kostete jeder Artikel ohne lokale MP3 ein eigenes readdir des Audio-Ordners
// plus mehrere existsSync – bei rund 7.000 Artikeln tausende Dateisystemaufrufe.
function createDirectoryCache() {
  const listings = new Map();
  return {
    seed(dir, entries) { listings.set(dir, directoryListing(entries)); },
    get(dir) {
      if (!listings.has(dir)) {
        let listing = null; // Verzeichnis fehlt: keine Medien
        try { listing = directoryListing(fs.readdirSync(dir, { withFileTypes: true })); } catch { /* fehlt */ }
        listings.set(dir, listing);
      }
      return listings.get(dir);
    },
  };
}

function findSibling(dir, basename, exts, listing) {
  if (!listing) return null;
  // Normalfall: exakt gleichnamige Datei mit erwarteter Endung.
  for (const ext of exts) {
    if (listing.exact.has(basename + ext)) return path.join(dir, basename + ext);
  }
  // Auf dem Debian-Zielsystem ist das Dateisystem case-sensitive. Medien sollen
  // trotzdem autorenunabhängig erkannt werden, wenn nur Groß-/Kleinschreibung
  // von Basisname oder Endung abweicht (z. B. Artikel.md + artikel.MP3).
  for (const ext of exts) {
    const actualName = listing.lower.get((basename + ext).toLowerCase());
    if (actualName) return path.join(dir, actualName);
  }
  return null;
}

// Cache-Busting: mtime der Datei als Versions-Query an die /files-URL hängen,
// damit ein ausgetauschtes Bild (gleicher Name) im Browser neu geladen wird.
// ?v=<mtime> lädt eine ersetzte Datei gleichen Namens im Browser neu.
function versionedUrl(url, absPath) {
  try { return `${url}?v=${Math.floor(fs.statSync(absPath).mtimeMs)}`; }
  catch { return url; } // Datei weg
}

const fileUrl = (relPath, absPath) => versionedUrl(`/files/${relPath}`, absPath);
const audioFileUrl = (relPath, absPath) => versionedUrl(`/audio-files/${relPath}`, absPath);

function resolveUnder(root, ...segments) {
  const absPath = path.resolve(path.join(root, ...segments));
  if (absPath !== root && !absPath.startsWith(root + path.sep)) return null;
  return absPath;
}

module.exports = { directoryListing, createDirectoryCache, findSibling, versionedUrl, fileUrl, audioFileUrl, resolveUnder };
