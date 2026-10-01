#!/usr/bin/env node
// EPUB → Markdown für den eBook-Text eines Hörbuchs.
//   node epub-tool/epub-to-md.js "Buch.epub" [--out <Ordner>] [--name <Dateiname>] [--force] [--dry-run]
// Schreibt <Ordner>/<Name>.md und <Ordner>/images/*. Standard für Ordner und Name: Dateiname des EPUB
// (ohne .epub) neben der Datei; der Hörbuch-Reader erwartet <Buchordner>/<Buchordner>.md.
import fs from 'node:fs';
import path from 'node:path';
import { convertEpub } from './convert.js';

const HELP = `Aufruf: node epub-tool/epub-to-md.js <buch.epub> [Optionen]
  --out <Ordner>   Zielordner (Standard: Ordner neben dem EPUB, benannt wie die Datei)
  --name <Name>    Name der .md ohne Endung (Standard: Name des Zielordners)
  --force          vorhandene .md und Bilder überschreiben
  --dry-run        nur konvertieren und berichten, nichts schreiben`;

function parseArgs(argv) {
  const opts = { force: false, dryRun: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--name') opts.name = argv[++i];
    else if (a === '-h' || a === '--help') opts.help = true;
    else rest.push(a);
  }
  opts.input = rest[0];
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.input) { console.log(HELP); process.exit(opts.help ? 0 : 1); }

try {
  const input = path.resolve(opts.input);
  if (!fs.existsSync(input)) throw new Error(`Datei nicht gefunden: ${input}`);
  const outDir = path.resolve(opts.out || path.join(path.dirname(input), path.basename(input, path.extname(input))));
  const name = opts.name || path.basename(outDir);
  const mdFile = path.join(outDir, `${name}.md`);

  const result = convertEpub(input);
  const { stats, check } = result;

  if (!opts.dryRun) {
    const imageDir = path.join(outDir, 'images');
    const targets = [mdFile, ...result.images.map(i => path.join(imageDir, i.name))];
    const existing = targets.filter(t => fs.existsSync(t));
    if (existing.length && !opts.force) {
      console.error(`Abbruch: ${existing.length} Zieldatei(en) vorhanden, z. B. ${existing[0]}\nMit --force überschreiben.`);
      process.exit(2);
    }
    fs.mkdirSync(imageDir, { recursive: true });
    fs.writeFileSync(mdFile, result.markdown, 'utf8');
    for (const img of result.images) fs.writeFileSync(path.join(imageDir, img.name), img.data);
  }

  console.log(`${opts.dryRun ? '[Probelauf] ' : ''}${result.meta.author ? result.meta.author + ' – ' : ''}${result.meta.title || path.basename(input)}`);
  console.log(`  Kapitel: ${stats.chapters}   Inhaltsverzeichnis: ${stats.tocEntries} Einträge   Anmerkungen: ${stats.notes}   Bilder: ${stats.images}`);
  console.log(`  Verweise: ${check.links} im Text, ohne Ziel: ${check.missing.length}; ${stats.unresolved} Verweis(e) zu fehlenden Zielen als Text belassen`);
  if (stats.notesUnreferenced) console.log(`  Hinweis: ${stats.notesUnreferenced} Anmerkung(en) ohne Verweis im Text (bleiben an ihrer Stelle)`);
  for (const w of result.warnings.slice(0, 30)) console.log(`  Warnung: ${w}`);
  if (result.warnings.length > 30) console.log(`  … ${result.warnings.length - 30} weitere Warnungen`);
  if (check.missing.length) console.log(`  Fehlende Ziele: ${check.missing.slice(0, 10).join(', ')}`);
  if (!opts.dryRun) console.log(`  geschrieben: ${mdFile} (${(Buffer.byteLength(result.markdown) / 1024).toFixed(0)} KB)`);
} catch (err) {
  console.error(`Fehler: ${err.message}`);
  process.exit(1);
}
