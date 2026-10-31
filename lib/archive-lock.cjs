'use strict';

// Zentrale Sperre für alle Aufträge, die Archivdateien oder den Index verändern.
// Zwei Arten von Teilnehmern:
//  - register(label, isActive): Aufträge mit eigenem Zustand (Index-Neuaufbau,
//    Scraper, Artikel-Editor, Audio-Erzeugung). Sie setzen ihren Zustand selbst
//    synchron, nachdem sie busy geprüft haben.
//  - tryAcquire(label) / run(label, task): exklusive Schreibaufträge ohne
//    eigenen Zustand (Infografiken, Dubletten, Hörbuch-Verwaltung).
// Ein Teil-Reindex, den ein laufender Auftrag selbst anstößt, holt die Sperre
// nicht erneut; er zählt zum auslösenden Auftrag.

const { httpError, sendRouteError } = require('./http-errors.cjs');

function createArchiveLock() {
  const sources = [];
  let holder = null;
  let idleTimer = null;

  const lock = {
    register(label, isActive) {
      sources.push({ label, isActive });
    },
    // Bezeichnung des laufenden Auftrags oder null.
    get current() {
      if (holder) return holder.label;
      return sources.find(source => source.isActive())?.label || null;
    },
    get busy() {
      return lock.current !== null;
    },
    // Nur der exklusive Halter (ohne registrierte Aufträge).
    get holder() {
      return holder?.label || null;
    },
    // Liefert eine Freigabefunktion oder null, wenn bereits etwas läuft.
    tryAcquire(label) {
      if (lock.busy) return null;
      const token = { label };
      holder = token;
      return () => { if (holder === token) holder = null; };
    },
    // 409-Fehler mit dem laufenden Auftrag; extra sind Zusatzfelder der Antwort.
    conflictError(extra = null) {
      const current = lock.current || 'ein anderer Auftrag';
      return Object.assign(httpError(409, `Es läuft bereits: ${current}. Bitte später erneut versuchen.`, extra), {
        busy: current,
      });
    },
    async run(label, task) {
      const release = lock.tryAcquire(label);
      if (!release) throw lock.conflictError();
      try { return await task(); }
      finally { release(); }
    },
    // task ausführen, sobald nichts mehr läuft; bis dahin alle intervalMs erneut
    // prüfen (z. B. SIGHUP-Reindex während einer Audio-Erzeugung). onWait meldet
    // einmal, worauf gewartet wird. Wartet bereits ein Aufruf, wird der neue mit
    // ihm zusammengefasst (Rückgabe false).
    whenIdle(task, { intervalMs = 30 * 1000, onWait = null } = {}) {
      if (idleTimer) return false;
      const attempt = () => {
        const current = lock.current;
        if (current) {
          if (!idleTimer) onWait?.(current);
          idleTimer = setTimeout(attempt, intervalMs);
          idleTimer.unref?.();
          return;
        }
        idleTimer = null;
        task();
      };
      attempt();
      return true;
    },
  };
  return lock;
}

// 409-Antwort für Routen, die die Sperre nicht bekommen haben (Routen mit jsonRoute
// werfen stattdessen lock.conflictError()).
function sendArchiveBusy(res, lock, extra = null) {
  return sendRouteError(res, lock.conflictError(extra));
}

module.exports = { createArchiveLock, sendArchiveBusy };
