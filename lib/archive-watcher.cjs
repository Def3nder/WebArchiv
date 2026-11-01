'use strict';

// Datei-Watcher für das Archiv: meldet Änderungen unter www/ und audio/ gebündelt,
// sobald eine Weile Ruhe ist (Entprellen), spätestens aber nach maxWaitMs, damit
// ein langer Upload nicht endlos aufschiebt. Was dann passiert (gecachter Neu-Scan),
// entscheidet der Aufrufer; dank Index-Cache ist ein Neu-Scan ohne echte Änderung
// billig, deshalb unterscheidet der Watcher nicht zwischen Datei-Arten.
//
// Ignoriert werden Punkt-Dateien (eigene Temp-Dateien heißen ".….tmp"), WinSCP-
// Teildateien (*.filepart) und was roots[].ignore(segments) zurückweist.

const fs = require('fs');
const path = require('path');

const ignoredByDefault = segments => segments.some(segment => segment.startsWith('.'))
  || /\.filepart$/i.test(segments[segments.length - 1] || '');

// roots: [{ dir, ignore? }]; onChange(changes): changes = ['www/Joe/2026/a.md', …] (relativ zu
// dir, mit dem Ordnernamen davor; unbekannter Dateiname als '<dir>/?').
function createArchiveWatcher({
  roots, onChange, quietMs = 5000, maxWaitMs = 60000, watch = fs.watch, log = console,
}) {
  const watchers = [];
  const pending = new Set();
  let firstAt = 0;
  let timer = null;

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

  function record(root, filename) {
    const label = path.basename(root.dir);
    if (!filename) {
      pending.add(`${label}/?`);
      schedule();
      return;
    }
    const segments = String(filename).split(/[\\/]+/).filter(Boolean);
    if (!segments.length || ignoredByDefault(segments) || root.ignore?.(segments)) return;
    pending.add(`${label}/${segments.join('/')}`);
    schedule();
  }

  return {
    start() {
      for (const root of roots) {
        try {
          const watcher = watch(root.dir, { recursive: true }, (_event, filename) => record(root, filename));
          watcher.on?.('error', error => {
            log.warn(`Datei-Watcher für ${root.dir} beendet: ${error.message}`);
            watcher.close();
          });
          watchers.push(watcher);
        } catch (error) {
          log.warn(`Datei-Watcher für ${root.dir} nicht gestartet: ${error.message}`);
        }
      }
      return watchers.length;
    },
    stop() {
      for (const watcher of watchers.splice(0)) watcher.close();
      if (timer) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}

module.exports = { createArchiveWatcher };
