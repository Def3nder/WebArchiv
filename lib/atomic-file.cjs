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

// JSON-Datei als Speicher: tolerant laden (BOM, fehlende Datei), Schreibvorgänge nacheinander.
function createJsonFile({ file, io = fs, mode = 0o600 }) {
  let queue = Promise.resolve();
  return {
    read(fallback) {
      try { return JSON.parse(fsSync.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
      catch (err) {
        if (err.code !== 'ENOENT') console.warn(`${path.basename(file)} nicht geladen —`, err.message);
        return fallback;
      }
    },
    write(data) {
      const run = queue.then(() => writeJsonAtomic(file, data, io, mode));
      queue = run.catch(err => console.error(`${path.basename(file)} nicht gespeichert —`, err.message));
      return run;
    },
  };
}

module.exports = { writeFileAtomic, writeJsonAtomic, writeFileAtomicSync, createJsonFile };
