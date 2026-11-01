'use strict';

// Persistenter Index-Cache: speichert den Parse-Teil des Artikel-Scans
// (parseArticleContent in lib/article-scan.cjs) pro Datei mit ihrer Signatur
// (Größe, Änderungszeit). Ein Scan liest eine unveränderte .md nicht erneut.
// Die Medien neben der .md bestimmt der Scan weiter jedes Mal frisch.
//
// Die Versionskennung umfasst den Quelltext der Parse-Logik und die Dubletten-
// Autoren: Ändert sich z. B. eine Suchwortliste der Taxonomie, gilt der ganze
// Cache als veraltet. Korrekt bleibt der Index auch ohne gespeicherten Cache;
// die Datei beschleunigt nur den Start und Voll-Reindexe.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('./atomic-file.cjs');
const { wordShingles } = require('./duplicates.cjs');

// Bei Änderungen am Dateiformat erhöhen (der Quelltext dieser Datei zählt ohnehin mit).
const CACHE_SCHEMA = 1;
const PARSER_SOURCES = ['article-parser.cjs', 'taxonomy.cjs', 'duplicates.cjs', 'article-scan.cjs',
  'html-sanitizer.cjs', 'index-cache.cjs'].map(name => path.join(__dirname, name));

function indexCacheVersion(extra = null, sources = PARSER_SOURCES) {
  const hash = crypto.createHash('sha256').update(String(CACHE_SCHEMA));
  for (const file of sources) hash.update('\0').update(fs.readFileSync(file));
  return hash.update('\0').update(JSON.stringify(extra)).digest('hex');
}

// Dublettenprofile enthalten Sets. Gespeichert wird der normalisierte Text, die
// Wortfolgen (shingles) entstehen beim Laden neu: mit ihnen wäre die Datei rund
// sechsmal so groß, das Neubilden kostet weniger als die Normalisierung.
function serializeParsed(parsed) {
  const profile = parsed.duplicateProfile;
  return {
    ...parsed,
    duplicateProfile: profile && {
      hash: profile.hash, normalized: profile.normalized, tokenCount: profile.tokenCount,
      titleTokens: [...profile.titleTokens],
    },
  };
}

function reviveParsed(data) {
  const profile = data.duplicateProfile;
  return {
    ...data,
    duplicateProfile: profile && {
      hash: profile.hash,
      normalized: profile.normalized,
      tokenCount: profile.tokenCount,
      shingles: wordShingles(profile.normalized ? profile.normalized.split(' ') : []),
      titleTokens: new Set(profile.titleTokens),
    },
  };
}

// get liefert für eine unveränderte Datei immer dasselbe Objekt: Die Dublettenerkennung
// erkennt „nichts geändert“ an der Identität des Profils und rechnet dann nicht neu.
function createIndexCache({ file, version, io = fs.promises, log = console }) {
  let entries = new Map(); // Schlüssel (Pfad relativ zu www/) → { size, mtimeMs, parsed }
  let seen = new Set();
  let dirty = false;
  let loaded = false;
  let stats = { hits: 0, misses: 0 };

  const matches = (entry, signature) => entry
    && entry.size === signature.size && entry.mtimeMs === signature.mtimeMs;

  return {
    // Einmal vor dem ersten Scan. Fehlende, kaputte oder veraltete Dateien ergeben einen leeren Cache.
    async load() {
      if (loaded) return;
      loaded = true;
      let document;
      try {
        document = JSON.parse(await io.readFile(file, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') log.warn(`Index-Cache nicht lesbar, wird neu aufgebaut: ${error.message}`);
        return;
      }
      if (document?.version !== version || !document.entries || typeof document.entries !== 'object') {
        log.log('Index-Cache gehört zu einer anderen Parser-Version und wird neu aufgebaut.');
        return;
      }
      for (const [key, value] of Object.entries(document.entries)) {
        if (!Array.isArray(value) || value.length !== 3 || !value[2] || typeof value[2] !== 'object') continue;
        entries.set(key, { size: value[0], mtimeMs: value[1], parsed: reviveParsed(value[2]) });
      }
    },
    get(key, signature) {
      const entry = entries.get(key);
      if (!matches(entry, signature)) { stats.misses++; return null; }
      seen.add(key);
      stats.hits++;
      return entry.parsed;
    },
    set(key, signature, parsed) {
      entries.set(key, { size: signature.size, mtimeMs: signature.mtimeMs, parsed });
      seen.add(key);
      dirty = true;
    },
    // Vor einem vollständigen Scan: danach behält save() nur die dabei gesehenen Dateien.
    beginFullScan() {
      seen = new Set();
      stats = { hits: 0, misses: 0 };
    },
    get stats() { return { ...stats, entries: entries.size }; },
    // Nach einem vollständigen Scan; schreibt nur, wenn sich etwas geändert hat.
    async save() {
      for (const key of entries.keys()) {
        if (!seen.has(key)) { entries.delete(key); dirty = true; }
      }
      if (!dirty) return false;
      const document = { version, entries: {} };
      for (const [key, entry] of entries) document.entries[key] = [entry.size, entry.mtimeMs, serializeParsed(entry.parsed)];
      await writeFileAtomic(file, JSON.stringify(document), { io, defaultMode: 0o600 });
      dirty = false;
      return true;
    },
  };
}

module.exports = { indexCacheVersion, createIndexCache, PARSER_SOURCES };
