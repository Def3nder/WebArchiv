/**
 * Einmalige Übernahme der Privat-Markierung der Hörbücher aus audiobook-progress.json
 * (früher unter __global.__private bzw. pro Nutzer unter <E-Mail>.__private) nach
 * audiobook-private.json ({ version: 1, books: { <Buch-ID>: true } }).
 *
 * Nutzung – den Dienst vorher stoppen, damit er die Dateien nicht gleichzeitig schreibt:
 *   node scripts/migrate-audiobook-private.js --dry-run   # nur anzeigen
 *   node scripts/migrate-audiobook-private.js             # übernehmen
 * Pfade wie beim Server: AUDIOBOOK_PROGRESS_FILE / AUDIOBOOK_PRIVATE_FILE oder
 * --progress <Datei> / --private <Datei>; Standard sind die Dateien im Projektordner.
 *
 * Reihenfolge: erst audiobook-private.json schreiben (vorhandene Markierungen bleiben),
 * dann die alten Einträge aus dem Hörfortschritt entfernen. Mehrfach ausführbar.
 */

const fs = require('fs');
const path = require('path');
const { readJsonFile, writeJsonAtomic } = require('../lib/atomic-file.cjs');

const ROOT = path.join(__dirname, '..');
const LEGACY_GLOBAL_KEY = '__global';
const LEGACY_PRIVATE_KEY = '__private';
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

// Alte Markierungen einsammeln; liefert sie und den Hörfortschritt ohne sie (Eingabe bleibt unverändert).
function splitLegacyPrivate(progress) {
  const books = {};
  const cleaned = structuredClone(isPlainObject(progress) ? progress : {});
  const collect = map => {
    if (!isPlainObject(map)) return;
    for (const [bookId, value] of Object.entries(map)) if (value) books[bookId] = true;
  };
  for (const [key, entry] of Object.entries(cleaned)) {
    if (!isPlainObject(entry) || !(LEGACY_PRIVATE_KEY in entry)) continue;
    collect(entry[LEGACY_PRIVATE_KEY]);
    delete entry[LEGACY_PRIVATE_KEY];
    if (!Object.keys(entry).length) delete cleaned[key];
  }
  // Das globale Objekt diente nur der Privat-Markierung.
  if (isPlainObject(cleaned[LEGACY_GLOBAL_KEY]) && !Object.keys(cleaned[LEGACY_GLOBAL_KEY]).length) {
    delete cleaned[LEGACY_GLOBAL_KEY];
  }
  return { books, cleaned };
}

async function migrate({ progressFile, privateFile, dryRun = false, io = fs.promises, log = console.log }) {
  const progress = readJsonFile(progressFile, null);
  if (!progress) {
    log(`${progressFile} fehlt oder ist leer – nichts zu übernehmen.`);
    return { migrated: 0 };
  }
  const { books, cleaned } = splitLegacyPrivate(progress);
  const ids = Object.keys(books);
  if (!ids.length) {
    log('Keine alten Privat-Markierungen gefunden – nichts zu tun.');
    return { migrated: 0 };
  }
  const existing = readJsonFile(privateFile, null);
  const merged = { ...(isPlainObject(existing?.books) ? existing.books : {}), ...books };
  log(`${ids.length} private(s) Hörbuch/Hörbücher gefunden:`);
  for (const id of ids) log(`  ${id}`);
  if (dryRun) {
    log('Probelauf: keine Datei geändert.');
    return { migrated: ids.length, dryRun: true };
  }
  await writeJsonAtomic(privateFile, { version: 1, books: merged }, io, 0o600);
  log(`Geschrieben: ${privateFile}`);
  await writeJsonAtomic(progressFile, cleaned, io, 0o600);
  log(`Alte Einträge entfernt aus: ${progressFile}`);
  return { migrated: ids.length };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

if (require.main === module) {
  migrate({
    progressFile: path.resolve(argument('--progress') || process.env.AUDIOBOOK_PROGRESS_FILE || path.join(ROOT, 'audiobook-progress.json')),
    privateFile: path.resolve(argument('--private') || process.env.AUDIOBOOK_PRIVATE_FILE || path.join(ROOT, 'audiobook-private.json')),
    dryRun: process.argv.includes('--dry-run'),
  }).catch(error => {
    console.error('Übernahme fehlgeschlagen:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { splitLegacyPrivate, migrate };
