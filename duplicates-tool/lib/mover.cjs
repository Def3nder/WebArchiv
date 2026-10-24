// Verschieben einer Dublette (.md + Begleitdateien) in den Ziel-Ordner, mit
// Protokoll für „Rückgängig“. Die Ordnerstruktur aus B wird im Ziel nachgebildet;
// bei Namenskonflikten bekommt die ganze Gruppe dasselbe Suffix „ (2)“, „ (3)“ …
'use strict';

const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const { writeJsonAtomic } = require('./json-file.cjs');
const { splitName } = require('./scan.cjs');

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function moveFile(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.rename(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    // Anderes Laufwerk: kopieren (ohne zu überschreiben), dann Quelle löschen.
    await fs.copyFile(from, to, fsSync.constants.COPYFILE_EXCL);
    const stat = await fs.stat(from);
    await fs.utimes(to, stat.atime, stat.mtime).catch(() => {});
    await fs.unlink(from);
  }
}

function renamedWithSuffix(name, mdStem, suffix) {
  if (!suffix) return name;
  return mdStem + suffix + name.slice(mdStem.length);
}

// Freie Zielnamen für die gesamte Gruppe suchen.
async function planTargets(sourceDir, names, targetDir) {
  const mdName = names[0];
  const mdStem = splitName(mdName).stem;
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? '' : ` (${n})`;
    const planned = names.map(name => ({
      from: path.join(sourceDir, name),
      to: path.join(targetDir, renamedWithSuffix(name, mdStem, suffix)),
    }));
    const taken = await Promise.all(planned.map(item => exists(item.to)));
    if (!taken.some(Boolean)) return planned;
  }
  throw fail(409, 'Keine freien Dateinamen im Ziel-Ordner gefunden.');
}

async function moveGroup(files) {
  const done = [];
  try {
    for (const item of files) {
      await moveFile(item.from, item.to);
      done.push(item);
    }
  } catch (error) {
    // Bereits verschobene Dateien zurücklegen, damit keine halbe Gruppe übrig bleibt.
    for (const item of done.reverse()) await moveFile(item.to, item.from).catch(() => {});
    throw error;
  }
}

// article: Eintrag aus scanFolder (Seite B); target: Ziel-Wurzel.
async function moveArticle(article, target) {
  const sourceDir = path.dirname(article.absPath);
  const names = [path.basename(article.absPath), ...article.companions];
  for (const name of names) {
    const stat = await fs.lstat(path.join(sourceDir, name)).catch(() => null);
    if (!stat) throw fail(409, `Datei fehlt: ${name} – bitte neu scannen.`);
    if (!stat.isFile() || stat.isSymbolicLink()) throw fail(409, `Keine normale Datei: ${name}`);
  }
  const targetDir = path.join(path.resolve(target), path.dirname(article.relPath));
  const files = await planTargets(sourceDir, names, targetDir);
  await moveGroup(files);
  return files;
}

function createMoveLog({ file, io = fs }) {
  let moves = [];
  let queue = Promise.resolve();

  function load() {
    try {
      const parsed = JSON.parse(fsSync.readFileSync(file, 'utf8').replace(/^﻿/, ''));
      moves = Array.isArray(parsed?.moves) ? parsed.moves.filter(Boolean) : [];
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`${file} nicht geladen —`, error.message);
      moves = [];
    }
  }

  function persist() {
    const run = queue.then(() => writeJsonAtomic(file, { version: 1, moves }, io));
    queue = run.catch(error => console.error('Verschiebe-Protokoll konnte nicht gespeichert werden:', error.message));
    return run;
  }

  return {
    load,
    all() { return moves.map(entry => ({ ...entry })); },
    async add(entry) {
      const stored = { id: randomUUID(), movedAt: new Date().toISOString(), ...entry };
      moves.unshift(stored);
      await persist();
      return { ...stored };
    },
    async undo(id) {
      const entry = moves.find(item => item.id === id);
      if (!entry) throw fail(404, 'Eintrag nicht gefunden.');
      for (const item of entry.files) {
        if (!(await exists(item.to))) throw fail(409, `Datei im Ziel fehlt: ${path.basename(item.to)}`);
        if (await exists(item.from)) throw fail(409, `Am ursprünglichen Ort existiert bereits: ${path.basename(item.from)}`);
      }
      await moveGroup(entry.files.map(item => ({ from: item.to, to: item.from })));
      moves = moves.filter(item => item.id !== id);
      await persist();
      return entry;
    },
  };
}

module.exports = { moveArticle, createMoveLog, planTargets };
