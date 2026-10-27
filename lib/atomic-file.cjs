// Atomares Schreiben: temporäre Datei im selben Verzeichnis, danach rename.
// Rechte und Eigentümer einer vorhandenen Datei bleiben erhalten.

const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { httpError } = require('./http-errors.cjs');

const tempPath = (file, prefix) => path.join(path.dirname(file), `.${prefix || path.basename(file)}-${randomUUID()}.tmp`);

// strictOwner: ein fehlgeschlagenes chown bricht ab (Artikel), sonst wird es ignoriert.
// beforeRename: letzte Prüfung nach dem Schreiben; wirft sie, bleibt das Original unberührt.
async function writeFileAtomic(file, content, { io = fs, defaultMode = 0o644, prefix, strictOwner = false, beforeRename } = {}) {
  let stat = null;
  try { stat = await io.stat(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const mode = stat ? stat.mode & 0o777 : defaultMode;
  const temp = tempPath(file, prefix);
  try {
    const handle = await io.open(temp, 'wx', mode);
    try {
      await handle.writeFile(content, typeof content === 'string' ? 'utf8' : undefined);
      if (process.platform !== 'win32') {
        if (stat) await handle.chown(stat.uid, stat.gid).catch(err => { if (strictOwner) throw err; });
        await handle.chmod(mode);
      }
      await handle.sync();
    } finally { await handle.close(); }
    if (beforeRename) await beforeRename();
    await io.rename(temp, file);
  } catch (err) {
    await io.unlink(temp).catch(() => {});
    throw err;
  }
}

async function writeJsonAtomic(file, data, io = fs, defaultMode = 0o600) {
  try {
    await writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n', { io, defaultMode });
  } catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      throw httpError(500, `${path.basename(file)} konnte nicht gespeichert werden: keine Schreibberechtigung.`);
    }
    throw err;
  }
}

// Für Kommandozeilenskripte: nur vorhandene Dateien, Eigentümer muss übernommen werden.
function writeFileAtomicSync(file, content, { prefix } = {}) {
  const stat = fsSync.statSync(file);
  const mode = stat.mode & 0o777;
  const temp = tempPath(file, prefix);
  fsSync.writeFileSync(temp, content, { mode, flag: 'wx' });
  try {
    if (process.platform !== 'win32') {
      fsSync.chownSync(temp, stat.uid, stat.gid);
      fsSync.chmodSync(temp, mode);
    }
    fsSync.renameSync(temp, file);
  } catch (err) {
    fsSync.rmSync(temp, { force: true });
    throw err;
  }
}

// JSON-Datei tolerant lesen (BOM, fehlende Datei → fallback).
function readJsonFile(file, fallback) {
  try { return JSON.parse(fsSync.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch (err) {
    if (err.code !== 'ENOENT') console.warn(`${path.basename(file)} nicht geladen —`, err.message);
    return fallback;
  }
}

// Zustand eines JSON-Speichers (Lesezeichen, Hörfortschritt, Dubletten).
// update(mutate) ändert eine Kopie und übernimmt sie erst, wenn die Datei
// geschrieben ist; scheitert das Schreiben, bleiben Speicher und Datei gleich.
// Änderungen laufen nacheinander, jede sieht den zuvor übernommenen Stand.
// fromDocument normalisiert den Dateiinhalt, toDocument bildet ihn wieder ab.
function createJsonState({ file, io = fs, mode = 0o600, fromDocument = doc => doc, toDocument = value => value }) {
  let value = fromDocument(null);
  let queue = Promise.resolve();
  const enqueue = task => {
    const run = queue.then(task);
    queue = run.catch(err => console.error(`${path.basename(file)} nicht gespeichert —`, err.message));
    return run;
  };
  return {
    get value() { return value; },
    load() { value = fromDocument(readJsonFile(file, null)); return value; },
    // Aktuellen Stand unverändert schreiben (z. B. nach einer Migration beim Laden).
    save() { return enqueue(() => writeJsonAtomic(file, toDocument(value), io, mode)); },
    // mutate(draft) ändert die Kopie und gibt ein Ergebnis zurück; false = keine Änderung.
    update(mutate) {
      return enqueue(async () => {
        const draft = structuredClone(value);
        const result = mutate(draft);
        if (result === false) return false;
        await writeJsonAtomic(file, toDocument(draft), io, mode);
        value = draft;
        return result;
      });
    },
  };
}

module.exports = { writeFileAtomic, writeJsonAtomic, writeFileAtomicSync, readJsonFile, createJsonState };
