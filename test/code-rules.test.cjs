'use strict';

// Regeln aus CLAUDE.md, die sich im Quelltext prüfen lassen.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
// Quellordner des Projekts (ohne Tests, Abhängigkeiten, Bundles und Archivdaten).
const SOURCE_DIRS = ['lib', 'modules', 'scripts', 'tts', 'scraper', 'duplicates-tool', 'epub-tool', 'public'];
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'test']);
// Die einzige erlaubte Umsetzung der Pfadprüfung.
const PATH_HELPER = path.join(root, 'lib', 'archive-files.cjs');
const isSource = name => /\.(c|m)?js$/.test(name);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (isSource(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function sourceFiles() {
  const files = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && isSource(entry.name))
    .map(entry => path.join(root, entry.name));
  for (const dir of SOURCE_DIRS) walk(path.join(root, dir), files);
  return files;
}

test('Pfadprüfungen laufen über isPathInside/resolveUnder, nie über startsWith', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    if (file === PATH_HELPER) continue;
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
      if (/startsWith\([^)]*path\.sep/.test(line) || /startsWith\(\s*['"`]\.\./.test(line)) {
        offenders.push(`${path.relative(root, file)}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});

test('server.js und modules/ überschreiben Archivdateien nur atomar; writeFile legt ausschließlich neue Dateien an', () => {
  const files = [path.join(root, 'server.js'), ...walk(path.join(root, 'modules'), [])];
  const offenders = files.flatMap(file => fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => /fs\.promises\.writeFile\(/.test(line) && !/flag: 'wx'/.test(line))
    .map(({ line, number }) => `${path.relative(root, file)}:${number}: ${line}`));
  assert.deepEqual(offenders, []);
});
