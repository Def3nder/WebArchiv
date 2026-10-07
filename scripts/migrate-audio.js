const fs = require('fs');
const path = require('path');

const ROOT_DIR = __dirname;
const WWW_DIR = path.join(ROOT_DIR, 'www');
const AUDIO_DIR = path.join(ROOT_DIR, 'audio');
const LOG_FILE = path.join(ROOT_DIR, 'migrate-audio.log');

const rawArgs = process.argv.slice(2);
const dryRun = rawArgs.includes('--dry-run');
const authorParts = rawArgs.filter(arg => arg !== '--dry-run');
const author = authorParts.join(' ').trim();

const summary = {
  found: 0,
  moved: 0,
  dryRun: 0,
  skipped: 0,
  errors: 0,
};

const logLines = [];

function timestamp() {
  return new Date().toISOString();
}

function log(message) {
  const line = `[${timestamp()}] ${message}`;
  logLines.push(line);
  console.log(message);
}

function writeLog() {
  const header = [
    '',
    `===== migrate-audio ${timestamp()} =====`,
  ];
  fs.appendFileSync(LOG_FILE, header.concat(logLines, '').join('\n'), 'utf8');
}

function usage() {
  console.error('Nutzung: node migrate-audio.js <Autorenname> [--dry-run]');
  console.error('Beispiel: node migrate-audio.js "Joe Turan" --dry-run');
}

function ensureInside(baseDir, targetPath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + path.sep);
}

async function walk(dir, onFile) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    summary.errors++;
    log(`FEHLER: Kann Verzeichnis nicht lesen: ${dir} (${err.message})`);
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, onFile);
      continue;
    }
    if (entry.isFile()) await onFile(fullPath);
  }
}

async function moveFile(sourcePath, targetPath) {
  try {
    await fs.promises.rename(sourcePath, targetPath);
    return 'rename';
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
  }

  await fs.promises.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);

  const [sourceStat, targetStat] = await Promise.all([
    fs.promises.stat(sourcePath),
    fs.promises.stat(targetPath),
  ]);
  if (sourceStat.size !== targetStat.size) {
    throw new Error(`Kopierte Datei hat andere Groesse (${sourceStat.size} != ${targetStat.size})`);
  }

  await fs.promises.unlink(sourcePath);
  return 'copy-unlink';
}

async function moveAudioFile(sourcePath, sourceAuthorDir, targetAuthorDir) {
  if (path.extname(sourcePath).toLowerCase() !== '.mp3') return;

  summary.found++;
  const relPath = path.relative(sourceAuthorDir, sourcePath);
  const targetPath = path.join(targetAuthorDir, relPath);

  if (!ensureInside(sourceAuthorDir, sourcePath)) {
    summary.errors++;
    log(`FEHLER: Quelle verlaesst Autorenverzeichnis: ${sourcePath}`);
    return;
  }

  if (!ensureInside(targetAuthorDir, targetPath)) {
    summary.errors++;
    log(`FEHLER: Ziel verlaesst Audio-Autorenverzeichnis: ${targetPath}`);
    return;
  }

  try {
    await fs.promises.access(targetPath, fs.constants.F_OK);
    summary.skipped++;
    log(`UEBERSPRUNGEN: Ziel existiert bereits: ${targetPath}`);
    return;
  } catch {
    // Ziel existiert nicht, Verschieben ist moeglich.
  }

  if (dryRun) {
    summary.dryRun++;
    log(`DRY-RUN: ${sourcePath} -> ${targetPath}`);
    return;
  }

  try {
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    const method = await moveFile(sourcePath, targetPath);
    summary.moved++;
    log(`VERSCHOBEN (${method}): ${sourcePath} -> ${targetPath}`);
  } catch (err) {
    summary.errors++;
    log(`FEHLER: Konnte nicht verschieben: ${sourcePath} -> ${targetPath} (${err.message})`);
  }
}

async function main() {
  if (!author) {
    usage();
    process.exitCode = 1;
    return;
  }

  const sourceAuthorDir = path.join(WWW_DIR, author);
  const targetAuthorDir = path.join(AUDIO_DIR, author);

  log(`Autor: ${author}`);
  log(`Modus: ${dryRun ? 'Dry-Run' : 'Live'}`);
  log(`Quelle: ${sourceAuthorDir}`);
  log(`Ziel: ${targetAuthorDir}`);

  if (!ensureInside(WWW_DIR, sourceAuthorDir) || !ensureInside(AUDIO_DIR, targetAuthorDir)) {
    log('FEHLER: Autorenname ergibt einen Pfad ausserhalb der erlaubten Verzeichnisse.');
    process.exitCode = 1;
    return;
  }

  let stat;
  try {
    stat = await fs.promises.stat(sourceAuthorDir);
  } catch {
    log(`FEHLER: Autorenverzeichnis nicht gefunden: ${sourceAuthorDir}`);
    process.exitCode = 1;
    return;
  }

  if (!stat.isDirectory()) {
    log(`FEHLER: Pfad ist kein Verzeichnis: ${sourceAuthorDir}`);
    process.exitCode = 1;
    return;
  }

  await walk(sourceAuthorDir, filePath => moveAudioFile(filePath, sourceAuthorDir, targetAuthorDir));

  log(`Zusammenfassung: gefunden=${summary.found}, verschoben=${summary.moved}, dryRun=${summary.dryRun}, uebersprungen=${summary.skipped}, fehler=${summary.errors}`);
  if (summary.errors > 0) process.exitCode = 1;
}

main()
  .catch(err => {
    summary.errors++;
    log(`FEHLER: Unerwarteter Abbruch: ${err.stack || err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    writeLog();
  });
