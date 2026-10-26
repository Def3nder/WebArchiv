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

function createArchiveLock() {
  const sources = [];
  let holder = null;

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
    conflictError() {
      const current = lock.current || 'ein anderer Auftrag';
      return Object.assign(new Error(`Es läuft bereits: ${current}. Bitte später erneut versuchen.`), {
        status: 409, busy: current,
      });
    },
    async run(label, task) {
      const release = lock.tryAcquire(label);
      if (!release) throw lock.conflictError();
      try { return await task(); }
      finally { release(); }
    },
  };
  return lock;
}

module.exports = { createArchiveLock };
