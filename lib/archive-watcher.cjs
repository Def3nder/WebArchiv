'use strict';

// Datei-Watcher für das Archiv: meldet Änderungen unter www/ und audio/ gebündelt,
// sobald eine Weile Ruhe ist (Entprellen), spätestens aber nach maxWaitMs, damit
// ein langer Upload nicht endlos aufschiebt. Was dann passiert (gecachter Neu-Scan),
// entscheidet der Aufrufer; dank Index-Cache ist ein Neu-Scan ohne echte Änderung
// billig, deshalb unterscheidet der Watcher nicht zwischen Datei-Arten.
//
// Jeder Ordner bekommt ein eigenes (nicht rekursives) fs.watch. Das rekursive fs.watch
// von Node bricht unter Linux für den ganzen Baum ab, sobald ein Unterordner nicht
// lesbar ist – auf den Archiv-Disks liegt lost+found (root, 0700). Neu angelegte Ordner
// werden nachträglich überwacht, gelöschte fallen heraus.
//
// Ignoriert werden Punkt-Dateien und -Ordner (eigene Temp-Dateien heißen ".….tmp"),
// WinSCP-Teildateien (*.filepart), lost+found und was roots[].ignore(segments) zurückweist.

const fs = require('fs');
const path = require('path');
const { isPathInside } = require('./archive-files.cjs');

const ignoredByDefault = segments => segments.some(segment => segment.startsWith('.') || segment === 'lost+found')
  || /\.filepart$/i.test(segments[segments.length - 1] || '');

// roots: [{ dir, ignore? }]; onChange(changes): changes = ['www/Joe/2026/a.md', …] (relativ zu
// dir, mit dem Ordnernamen davor; unbekannter Dateiname als '<dir>/?').
function createArchiveWatcher({
  roots, onChange, quietMs = 5000, maxWaitMs = 60000, watch = fs.watch, io = fs.promises, log = console,
}) {
  const watchers = new Map(); // absoluter Ordner → fs.FSWatcher
  const pending = new Set();
  let firstAt = 0;
  let timer = null;
  let stopped = false;

  function flush() {
    timer = null;
    const changes = [...pending];
    pending.clear();
    if (changes.length) onChange(changes);
  }

  function schedule() {
    const now = Date.now();
    if (!timer) firstAt = now;
    else clearTimeout(timer);
    timer = setTimeout(flush, Math.max(0, Math.min(quietMs, firstAt + maxWaitMs - now)));
    timer.unref?.();
  }

  const skipped = (root, segments) => ignoredByDefault(segments) || !!root.ignore?.(segments);

  function unwatch(dir) {
    for (const [watched, watcher] of watchers) {
      if (watched === dir || isPathInside(dir, watched)) {
        watcher.close();
        watchers.delete(watched);
      }
    }
  }

  // Ordner und alle Unterordner überwachen. Liefert false, wenn dir selbst nicht überwacht werden kann.
  async function addTree(root, dir, segments) {
    if (stopped || watchers.has(dir) || skipped(root, segments)) return true;
    let watcher;
    try {
      watcher = watch(dir, (_event, filename) => onEvent(root, dir, segments, filename));
    } catch (error) {
      log.warn(`Datei-Watcher: ${dir} nicht überwacht: ${error.message}`);
      return false;
    }
    watcher.on?.('error', error => {
      // Typisch: Ordner wurde gelöscht. Andere Fehler (z. B. inotify-Limit) ins Log.
      if (error.code !== 'ENOENT' && error.code !== 'EPERM') log.warn(`Datei-Watcher für ${dir} beendet: ${error.message}`);
      unwatch(dir);
    });
    watchers.set(dir, watcher);
    let entries = [];
    try { entries = await io.readdir(dir, { withFileTypes: true }); }
    catch (error) {
      if (error.code !== 'ENOENT') log.warn(`Datei-Watcher: ${dir} nicht lesbar: ${error.message}`);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await addTree(root, path.join(dir, entry.name), [...segments, entry.name]);
    }
    return true;
  }

  function onEvent(root, dir, dirSegments, filename) {
    const label = path.basename(root.dir);
    if (!filename) {
      pending.add(`${label}/${[...dirSegments, '?'].join('/')}`);
      schedule();
      return;
    }
    const segments = [...dirSegments, ...String(filename).split(/[\\/]+/).filter(Boolean)];
    if (!segments.length || skipped(root, segments)) return;
    pending.add(`${label}/${segments.join('/')}`);
    schedule();
    // Neuer Ordner: mit Unterordnern überwachen; verschwundener Ordner: Watcher schließen.
    const target = path.join(root.dir, ...segments);
    io.stat(target).then(
      stat => { if (stat.isDirectory()) return addTree(root, target, segments); },
      () => { if (watchers.has(target)) unwatch(target); },
    ).catch(error => log.warn(`Datei-Watcher: ${target}: ${error.message}`));
  }

  return {
    // Liefert die Zahl der überwachten Wurzeln (www/, audio/).
    async start() {
      let started = 0;
      for (const root of roots) {
        if (await addTree(root, root.dir, [])) started++;
      }
      return started;
    },
    get directoryCount() { return watchers.size; },
    stop() {
      stopped = true;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      if (timer) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}

module.exports = { createArchiveWatcher };
