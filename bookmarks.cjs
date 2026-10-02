// Lesezeichen pro Nutzer (bookmarks.json): E-Mail (klein) → Artikel-ID → Zeitpunkt.
// Nur für angemeldete Nutzer; Gäste haben keine Lesezeichen.

const fsSync = require('fs');
const fs = require('fs/promises');
const { writeJsonAtomic } = require('./user-store.cjs');

const fail = (status, message) => Object.assign(new Error(message), { status });
const emailKey = email => String(email || '').toLowerCase();
const EMPTY = new Set();

function createBookmarkStore({ file, io = fs }) {
  let data = {};
  let queue = Promise.resolve();

  function load() {
    try {
      const parsed = JSON.parse(fsSync.readFileSync(file, 'utf8').replace(/^﻿/, ''));
      data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('bookmarks.json nicht geladen —', err.message);
      data = {};
    }
  }

  function persist() {
    const run = queue.then(() => writeJsonAtomic(file, data, io, 0o600));
    queue = run.catch(err => console.error('Lesezeichen konnten nicht gespeichert werden:', err.message));
    return run;
  }

  return {
    load,
    // Menge der Artikel-IDs mit Lesezeichen (leer für Gäste).
    idsFor(email) {
      const entries = email ? data[emailKey(email)] : null;
      return entries ? new Set(Object.keys(entries)) : EMPTY;
    },
    has(email, id) {
      return !!(email && data[emailKey(email)]?.[id]);
    },
    async add(email, id) {
      if (!email) throw fail(401, 'Nicht angemeldet.');
      const key = emailKey(email);
      if (data[key]?.[id]) return;
      data[key] = { ...(data[key] || {}), [id]: new Date().toISOString() };
      await persist();
    },
    async remove(email, id) {
      if (!email) throw fail(401, 'Nicht angemeldet.');
      const key = emailKey(email);
      if (!data[key]?.[id]) return;
      const { [id]: _removed, ...rest } = data[key];
      if (Object.keys(rest).length) data[key] = rest;
      else delete data[key];
      await persist();
    },
    async removeUser(email) {
      const key = emailKey(email);
      if (!data[key]) return;
      delete data[key];
      await persist();
    },
  };
}

// PUT setzt, DELETE löscht das Lesezeichen. Setzen nur für vorhandene Artikel eines
// erlaubten Autors; Löschen auch für verwaiste Einträge (Artikel umbenannt/gelöscht).
function installBookmarkRoutes(app, { store, requireAuth, getArticle, canAccessAuthor }) {
  const route = handler => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (req.get('sec-fetch-site') === 'cross-site') throw fail(403, 'Änderungen sind nur aus dem Archiv erlaubt.');
      res.json(await handler(req.params[0], req.session.user));
    } catch (error) {
      if (!error.status) console.error('Lesezeichen:', error);
      res.status(error.status || 500).json({ error: error.status ? error.message : 'Die Anfrage ist fehlgeschlagen.' });
    }
  };

  app.put('/api/bookmarks/*', requireAuth, route(async (id, user) => {
    const article = getArticle(id);
    if (!article || !canAccessAuthor(user, article.author)) throw fail(404, 'Artikel nicht gefunden.');
    await store.add(user.email, id);
    return { id, bookmarked: true };
  }));
  app.delete('/api/bookmarks/*', requireAuth, route(async (id, user) => {
    await store.remove(user.email, id);
    return { id, bookmarked: false };
  }));
}

module.exports = { createBookmarkStore, installBookmarkRoutes };
