'use strict';

// Sitzungen in einer JSON-Datei (sessions.json, Rechte 0600), damit ein Neustart
// niemanden abmeldet. express-session fragt den Store bei jeder Anfrage; der
// Store hält deshalb alles im Speicher und schreibt Änderungen gebündelt und
// atomar. Abgelaufene Sitzungen werden beim Laden und stündlich entfernt.
// Die Datei enthält nur Sitzungs-IDs und -Inhalte ({ email, sessionVersion, …});
// ohne das SESSION_SECRET lässt sich daraus kein gültiges Cookie bilden.

const fs = require('fs/promises');
const session = require('express-session');
const { readJsonFile, writeJsonAtomic } = require('./atomic-file.cjs');

const DEFAULT_MAX_AGE = 24 * 60 * 60 * 1000;

class FileSessionStore extends session.Store {
  constructor({ file, io = fs, flushDelayMs = 1000, pruneIntervalMs = 60 * 60 * 1000, now = Date.now } = {}) {
    super();
    this.file = file;
    this.io = io;
    this.now = now;
    this.flushDelayMs = flushDelayMs;
    this.sessions = new Map(); // sid → { expires, data }
    this.timer = null;
    this.writing = Promise.resolve();
    const stored = readJsonFile(file, {});
    for (const [sid, entry] of Object.entries(stored && typeof stored === 'object' ? stored : {})) {
      if (entry && typeof entry.data === 'object' && Number(entry.expires) > now()) {
        this.sessions.set(sid, { expires: Number(entry.expires), data: entry.data });
      }
    }
    this.pruneTimer = setInterval(() => this.prune(), pruneIntervalMs);
    this.pruneTimer.unref?.();
  }

  expiresFor(sess) {
    const expires = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : NaN;
    return Number.isFinite(expires) ? expires : this.now() + (sess?.cookie?.originalMaxAge || DEFAULT_MAX_AGE);
  }

  get(sid, callback) {
    const entry = this.sessions.get(sid);
    if (!entry) return callback(null, null);
    if (entry.expires <= this.now()) {
      this.sessions.delete(sid);
      this.scheduleFlush();
      return callback(null, null);
    }
    // Kopie: express-session verändert das Objekt, gespeichert wird erst über set().
    callback(null, structuredClone(entry.data));
  }

  set(sid, sess, callback = () => {}) {
    this.sessions.set(sid, { expires: this.expiresFor(sess), data: JSON.parse(JSON.stringify(sess)) });
    this.scheduleFlush();
    callback(null);
  }

  touch(sid, sess, callback = () => {}) {
    // express-session ruft touch bei jeder Anfrage; geschrieben wird nur, wenn
    // sich der Ablauf tatsächlich verschiebt.
    const entry = this.sessions.get(sid);
    const expires = this.expiresFor(sess);
    if (entry && entry.expires !== expires) {
      entry.expires = expires;
      if (sess?.cookie) entry.data.cookie = JSON.parse(JSON.stringify(sess.cookie));
      this.scheduleFlush();
    }
    callback(null);
  }

  destroy(sid, callback = () => {}) {
    if (this.sessions.delete(sid)) this.scheduleFlush();
    callback(null);
  }

  length(callback) { callback(null, this.sessions.size); }

  clear(callback = () => {}) {
    this.sessions.clear();
    this.scheduleFlush();
    callback(null);
  }

  prune() {
    const now = this.now();
    let removed = 0;
    for (const [sid, entry] of this.sessions) {
      if (entry.expires <= now) { this.sessions.delete(sid); removed++; }
    }
    if (removed) this.scheduleFlush();
    return removed;
  }

  scheduleFlush() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, this.flushDelayMs);
    this.timer.unref?.();
  }

  // Schreibt den aktuellen Stand (nacheinander, nie zwei Schreibvorgänge parallel).
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const snapshot = Object.fromEntries(this.sessions);
    const run = this.writing.then(() => writeJsonAtomic(this.file, snapshot, this.io, 0o600));
    this.writing = run.catch(error => console.error('sessions.json nicht gespeichert —', error.message));
    return run;
  }

  // Beim Beenden nur schreiben, wenn noch eine Änderung aussteht.
  close() {
    clearInterval(this.pruneTimer);
    return this.timer ? this.flush() : this.writing;
  }
}

module.exports = { FileSessionStore };
