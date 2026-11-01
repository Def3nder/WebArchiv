'use strict';

// Meldungssammler für den Health-Check: Fehler und Warnungen des Servers (console.error/
// console.warn, die weiterhin auch ins Journal gehen) und Fehler aus Log-Dateien anderer
// Prozesse (Scraper, Cron-Skript). Gleiche Meldungen werden zusammengefasst („12 ×,
// zuletzt …“); die Liste übersteht einen Neustart (JSON-Datei, gitignored).
//
// Jede neue oder wiederholte Meldung bekommt eine fortlaufende id. Wer „seit id N“ fragt,
// erfährt so auch von Wiederholungen (Grundlage für den Hinweis in der Oberfläche).

const fs = require('fs');
const util = require('util');
const { writeFileAtomic } = require('./atomic-file.cjs');

const MESSAGE_LIMIT = 300;
const DETAIL_LIMIT = 2000;
const LEVELS = new Set(['error', 'warning']);

// Erste Zeile als Meldung, der Rest (z. B. Stack) als Detail; beides gekürzt.
function splitMessage(text) {
  const clean = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  const [first, ...rest] = clean.split('\n');
  return {
    message: first.slice(0, MESSAGE_LIMIT) || '(leere Meldung)',
    detail: rest.join('\n').trim().slice(0, DETAIL_LIMIT) || null,
  };
}

function createEventLog({ file, maxEntries = 200, saveDelayMs = 2000, io = fs.promises, now = () => Date.now() } = {}) {
  let entries = new Map(); // Schlüssel level|source|message → Eintrag
  let lastId = 0;
  let sources = {}; // Lesestand der Log-Dateien (siehe createLogTail)
  let saveTimer = null;
  let dirty = false;
  // Eigene Fehler nur über die ursprünglichen Konsolenfunktionen: sonst würde ein
  // Speicherfehler als Meldung erfasst, die wieder gespeichert werden soll.
  let quiet = { warn: console.warn.bind(console), error: console.error.bind(console) };

  function scheduleSave() {
    dirty = true;
    if (!file || saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; save().catch(() => {}); }, saveDelayMs);
    saveTimer.unref?.();
  }

  function prune() {
    if (entries.size <= maxEntries) return;
    const oldest = [...entries.entries()].sort((a, b) => a[1].id - b[1].id);
    for (const [key] of oldest.slice(0, entries.size - maxEntries)) entries.delete(key);
  }

  function record(level, text, { source = 'server', at = now() } = {}) {
    if (!LEVELS.has(level)) throw new Error(`Unbekannte Stufe: ${level}`);
    const { message, detail } = splitMessage(text);
    const key = `${level}|${source}|${message}`;
    const existing = entries.get(key);
    lastId += 1;
    if (existing) {
      // Neu einsortieren, damit die Map in Reihenfolge der letzten Meldung bleibt.
      entries.delete(key);
      entries.set(key, { ...existing, id: lastId, count: existing.count + 1, lastAt: Math.max(existing.lastAt, at), detail: detail || existing.detail });
    } else {
      entries.set(key, { id: lastId, level, source, message, detail, count: 1, firstAt: at, lastAt: at });
    }
    prune();
    scheduleSave();
    return lastId;
  }

  // Neueste zuerst; after: nur Einträge mit neuer Meldung seit dieser id.
  function list({ after = 0, level = null } = {}) {
    return [...entries.values()]
      .filter(entry => entry.id > after && (!level || entry.level === level))
      .sort((a, b) => b.id - a.id)
      .map(entry => ({ ...entry }));
  }

  async function save() {
    if (!file || !dirty) return false;
    dirty = false;
    const document = { version: 1, lastId, sources, entries: [...entries.values()] };
    try {
      await writeFileAtomic(file, JSON.stringify(document), { io, defaultMode: 0o600 });
      return true;
    } catch (error) {
      dirty = true;
      quiet.warn(`Meldungen nicht gespeichert: ${error.message}`);
      return false;
    }
  }

  return {
    record,
    list,
    get lastId() { return lastId; },
    // Für den Hinweis: Anzahl neuer Fehler seit after und der neueste davon.
    summary(after = 0) {
      const errors = list({ after, level: 'error' });
      return { lastId, newErrors: errors.reduce((sum, entry) => sum + entry.count, 0), latest: errors[0] || null };
    },
    clear() {
      entries = new Map();
      scheduleSave();
    },
    // Lesestand einer Log-Datei (createLogTail); wird mitgespeichert.
    source(name, value) {
      if (value === undefined) return sources[name];
      sources = { ...sources, [name]: value };
      scheduleSave();
      return value;
    },
    async load() {
      if (!file) return;
      let document;
      try { document = JSON.parse(await io.readFile(file, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') quiet.warn(`Meldungen nicht geladen: ${error.message}`);
        return;
      }
      if (document?.version !== 1 || !Array.isArray(document.entries)) return;
      // Meldungen, die schon vor dem Laden entstanden sind (z. B. beim Start), kommen danach dazu.
      const early = [...entries.values()].sort((a, b) => a.id - b.id);
      lastId = Number.isInteger(document.lastId) ? document.lastId : 0;
      sources = { ...(document.sources && typeof document.sources === 'object' ? document.sources : {}), ...sources };
      entries = new Map();
      for (const entry of document.entries.sort((a, b) => a.id - b.id)) {
        if (!LEVELS.has(entry?.level) || typeof entry.message !== 'string') continue;
        entries.set(`${entry.level}|${entry.source}|${entry.message}`, entry);
        lastId = Math.max(lastId, entry.id);
      }
      for (const entry of early) {
        const key = `${entry.level}|${entry.source}|${entry.message}`;
        const loaded = entries.get(key);
        lastId += 1;
        entries.delete(key);
        entries.set(key, loaded
          ? { ...loaded, id: lastId, count: loaded.count + entry.count, lastAt: Math.max(loaded.lastAt, entry.lastAt) }
          : { ...entry, id: lastId });
      }
      prune();
      if (early.length) scheduleSave();
    },
    save,
    async flush() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      return save();
    },
    // console.error → Fehler, console.warn → Warnung; die Ausgabe ins Journal bleibt.
    // Liefert eine Funktion, die die ursprünglichen Konsolenfunktionen wiederherstellt.
    captureConsole(target = console) {
      const original = { error: target.error, warn: target.warn };
      quiet = { warn: original.warn.bind(target), error: original.error.bind(target) };
      target.error = (...args) => {
        original.error.apply(target, args);
        try { record('error', util.format(...args)); } catch { /* Meldung nie verlieren wollen, aber nie werfen */ }
      };
      target.warn = (...args) => {
        original.warn.apply(target, args);
        try { record('warning', util.format(...args)); } catch { /* s. o. */ }
      };
      return () => { target.error = original.error; target.warn = original.warn; };
    },
  };
}

// Liest neue Zeilen einer Log-Datei ab dem gespeicherten Lesestand. Beim allerersten Mal
// beginnt sie am Dateiende: Alte Fehler aus der Zeit vor dem Health-Check sollen keinen
// Hinweis auslösen. Wird die Datei kürzer (geleert oder ersetzt), liest sie von vorn.
// Eine noch unvollständige letzte Zeile bleibt für den nächsten Durchlauf liegen.
// parse(line) → { level, message, at } oder null.
function createLogTail({ name, file, eventLog, parse, source, io = fs.promises }) {
  return async function poll() {
    let stat;
    try { stat = await io.stat(file); }
    catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
    const state = eventLog.source(name);
    const replaced = state && state.ino !== undefined && stat.ino !== undefined && state.ino !== stat.ino;
    if (!state) {
      eventLog.source(name, { offset: stat.size, ino: stat.ino });
      return 0;
    }
    let offset = replaced || stat.size < state.offset ? 0 : state.offset;
    if (stat.size === offset) {
      if (replaced) eventLog.source(name, { offset, ino: stat.ino });
      return 0;
    }
    const handle = await io.open(file, 'r');
    let text;
    try {
      const buffer = Buffer.alloc(stat.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      text = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
    const end = text.lastIndexOf('\n');
    if (end < 0) return 0;
    let recorded = 0;
    for (const line of text.slice(0, end).split('\n')) {
      const event = parse(line.replace(/\r$/, ''));
      if (!event) continue;
      eventLog.record(event.level, event.message, { source, at: event.at });
      recorded++;
    }
    offset += Buffer.byteLength(text.slice(0, end + 1), 'utf8');
    eventLog.source(name, { offset, ino: stat.ino });
    return recorded;
  };
}

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) /;
const localTime = (date, time) => new Date(`${date}T${time}`).getTime();

// scraper/scrape_all.log: „2026-09-22 17:47:42 [ERROR] …“ (Warnungen wie „DOM-Fallback“ sind normal).
function parseScraperLogLine(line) {
  const match = line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \[ERROR\] (.+)$/);
  return match ? { level: 'error', message: match[3], at: localTime(match[1], match[2]) } : null;
}

// scraper/cron-scrape.log (scraper/run-scrape.sh): „… Scraper exit N“ und „… FEHLER: SIGHUP …“.
function parseCronLogLine(line) {
  const stamp = line.match(TIMESTAMP);
  if (!stamp) return null;
  const at = localTime(stamp[1], stamp[2]);
  const exit = line.match(/ Scraper exit (\d+)$/);
  if (exit && exit[1] !== '0') return { level: 'error', message: `Cron-Scrape mit Exit-Code ${exit[1]} beendet`, at };
  const failure = line.match(/ FEHLER: (.+)$/);
  return failure ? { level: 'error', message: `Cron-Skript: ${failure[1]}`, at } : null;
}

module.exports = { createEventLog, createLogTail, parseScraperLogLine, parseCronLogLine, splitMessage };
