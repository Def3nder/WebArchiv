/**
 * Entfernt die „Kategorien:“-Zeile aus dem Kopf der Infografik-Markdown-Dateien
 * (www/Infografiken/**.md) ohne eigenen Text. Solche Infografiken erben die Kategorien ihres Artikels;
 * eine eigene Zeile ist überflüssig und würde veraltete Kategorien anzeigen.
 *
 * Nutzung:
 *   node scripts/strip-infographic-categories.js --dry-run   # nur anzeigen
 *   node scripts/strip-infographic-categories.js             # sichern + ändern
 *
 * Vor dem Ändern werden die betroffenen Dateien nach
 * download/backup-<JJJJ-MM-TT>/Infografiken/… kopiert. Nur der Kopf (bis zur
 * ersten Textzeile nach „Datum:“) wird angefasst; BOM und Zeilenenden bleiben.
 * Danach das Archiv neu einlesen (Aktionen → Archiv neu einlesen oder SIGHUP).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'www', 'Infografiken');
const dryRun = process.argv.includes('--dry-run');

const clean = line => line.replace(/\*\*/g, '').replace(/^#+\s*/, '').replace(/^\*|\*$/g, '')
  .trim().replace(/^_+|_+$/g, '').trim();

function listMarkdown(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...listMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push(full);
  }
  return result;
}

// Gibt den neuen Inhalt zurück oder null, wenn nichts zu ändern ist.
function stripCategories(content) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const datumIdx = lines.slice(0, 20).findIndex(line => /^datum:/i.test(clean(line)));
  if (datumIdx < 0) return null;
  let end = datumIdx + 1;
  while (end < lines.length) {
    const c = clean(lines[end]);
    if (c && !/^(audioquickie|kategorien|quelle):/i.test(c)) break;
    end++;
  }
  // Infografiken mit eigenem Text sind Originale; ihre Kategorien bleiben.
  if (lines.slice(end).some(line => line.trim() && !/^(\*{4,}|-{3,})$/.test(line.trim()))) return null;
  const head = [];
  let changed = false;
  for (let i = 0; i < end; i++) {
    if (i <= datumIdx || !/^kategorien:/i.test(clean(lines[i]))) { head.push(lines[i]); continue; }
    changed = true;
    // Die dadurch doppelte Leerzeile mit entfernen.
    if (head.length && head[head.length - 1].trim() === '' && i + 1 < lines.length && lines[i + 1].trim() === '') i++;
  }
  return changed ? [...head, ...lines.slice(end)].join(eol) : null;
}

function writeAtomic(file, content) {
  const stat = fs.statSync(file);
  const temp = path.join(path.dirname(file), `.strip-categories-${process.pid}.tmp`);
  fs.writeFileSync(temp, content, { mode: stat.mode & 0o777 });
  try {
    if (process.platform !== 'win32') fs.chownSync(temp, stat.uid, stat.gid);
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function main() {
  const changes = [];
  for (const file of listMarkdown(DIR)) {
    const next = stripCategories(fs.readFileSync(file, 'utf8'));
    if (next !== null) changes.push({ file, next });
  }
  for (const { file } of changes) console.log((dryRun ? '[Probelauf] ' : '') + path.relative(ROOT, file));
  console.log(`${changes.length} Datei(en) mit Kategorien-Zeile.`);
  if (dryRun || !changes.length) return;

  const backup = path.join(ROOT, 'download', `backup-${new Date().toISOString().slice(0, 10)}`);
  for (const { file } of changes) {
    const target = path.join(backup, path.relative(path.join(ROOT, 'www'), file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.copyFileSync(file, target);
  }
  console.log(`Sicherung: ${path.relative(ROOT, backup)}`);
  for (const { file, next } of changes) writeAtomic(file, next);
  console.log('Fertig. Bitte das Archiv neu einlesen.');
}

if (require.main === module) main();
module.exports = { stripCategories };
