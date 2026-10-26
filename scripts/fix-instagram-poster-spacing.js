#!/usr/bin/env node
/**
 * Einmalige Korrektur für bestehende Infografik-Markdowns:
 *
 *   Datum: 2026-10-25
 *   Instagram-Poster: Ja
 *
 * wird zu zwei getrennten Markdown-Absätzen. Standardmäßig wird nur eine
 * Vorschau ausgegeben; --write legt eine Sicherung an und schreibt atomar.
 *
 * Nutzung:
 *   node scripts/fix-instagram-poster-spacing.js
 *   node scripts/fix-instagram-poster-spacing.js --write
 *   node scripts/fix-instagram-poster-spacing.js --root /pfad/zu/www/Infografiken --write
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_ROOT = path.join(REPO_ROOT, 'www', 'Infografiken');

const cleanMetadataLine = line => line.replace(/\*\*/g, '').replace(/^#+\s*/, '')
  .replace(/^\*|\*$/g, '').replace(/^_+|_+$/g, '').trim();

function fixInstagramPosterSpacing(content) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  let changed = false;
  for (let index = 1; index < lines.length; index++) {
    if (!/^instagram-poster:\s*ja\s*$/i.test(cleanMetadataLine(lines[index]))) continue;
    if (!/^datum:/i.test(cleanMetadataLine(lines[index - 1]))) continue;
    lines.splice(index, 0, '');
    index++;
    changed = true;
  }
  return changed ? lines.join(eol) : null;
}

function listMarkdownFiles(root) {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() !== 'trash') walk(file);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.md') {
        files.push(file);
      }
    }
  }
  walk(root);
  return files;
}

function writeAtomic(file, content) {
  const stat = fs.statSync(file);
  const temp = path.join(path.dirname(file), `.poster-spacing-${process.pid}.tmp`);
  fs.writeFileSync(temp, content, { mode: stat.mode & 0o777 });
  try {
    if (process.platform !== 'win32') fs.chownSync(temp, stat.uid, stat.gid);
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function parseArguments(argv) {
  const options = { write: false, root: DEFAULT_ROOT };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--write') options.write = true;
    else if (argument === '--root' && argv[index + 1]) options.root = path.resolve(argv[++index]);
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unbekannter Parameter: ${argument}`);
  }
  return options;
}

function backupName() {
  return `backup-instagram-poster-spacing-${new Date().toISOString()
    .replace(/\.\d{3}Z$/, 'Z').replace(/[:]/g, '-')}`;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log('Nutzung: node scripts/fix-instagram-poster-spacing.js [--root VERZEICHNIS] [--write]');
    return;
  }
  if (!fs.existsSync(options.root) || !fs.statSync(options.root).isDirectory()) {
    throw new Error(`Infografiken-Verzeichnis nicht gefunden: ${options.root}`);
  }

  const files = listMarkdownFiles(options.root);
  const changes = files.map(file => ({ file, content: fixInstagramPosterSpacing(fs.readFileSync(file, 'utf8')) }))
    .filter(change => change.content !== null);
  for (const { file } of changes) {
    console.log(`${options.write ? '[Schreiben]' : '[Vorschau]'} ${path.relative(options.root, file)}`);
  }
  console.log(`${files.length} Markdown-Datei(en) geprüft, ${changes.length} Korrektur(en) gefunden.`);
  if (!options.write || !changes.length) {
    if (!options.write && changes.length) console.log('Zum Anwenden erneut mit --write aufrufen.');
    return;
  }

  const backupRoot = path.join(REPO_ROOT, 'download', backupName());
  for (const { file } of changes) {
    const relative = path.relative(options.root, file);
    const backup = path.join(backupRoot, relative);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.copyFileSync(file, backup);
  }
  console.log(`Sicherung: ${path.relative(REPO_ROOT, backupRoot)}`);
  for (const { file, content } of changes) writeAtomic(file, content);
  console.log('Korrektur abgeschlossen.');
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { fixInstagramPosterSpacing, parseArguments };
