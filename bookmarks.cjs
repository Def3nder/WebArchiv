// Lesezeichen pro Nutzer (bookmarks.json): E-Mail (klein) → Artikel-ID → Zeitpunkt.
// Nur für angemeldete Nutzer; Gäste haben keine Lesezeichen.

const fs = require('fs/promises');
const { createJsonFile } = require('./lib/atomic-file.cjs');
const { httpError: fail, jsonRoute } = require('./lib/http-errors.cjs');

const emailKey = email => String(email || '').toLowerCase();
const EMPTY = new Set();

function createBookmarkStore({ file, io = fs }) {
  const store = createJsonFile({ file, io });
  let data = {};

  function load() {
    const parsed = store.read({});
    data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }

  const persist = () => store.write(data);

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
    // Beim Verknüpfen einer Dublette bleiben vorhandene Lesezeichen erhalten,
    // zeigen aber künftig auf den kanonischen Blogartikel.
    async replaceArticleId(oldId, newId) {
      await this.replaceArticleIds([{ oldId, newId }]);
    },
    // Sammelverknüpfungen schreiben bookmarks.json nur einmal, unabhängig davon,
    // wie viele Facebook-Artikel auf ihre Blogfassungen umgebogen werden.
    async replaceArticleIds(replacements) {
      const valid = (Array.isArray(replacements) ? replacements : [])
        .filter(item => item?.oldId && item?.newId && item.oldId !== item.newId);
      if (!valid.length) return;
      let changed = false;
      for (const [key, entries] of Object.entries(data)) {
        let next = entries;
        for (const { oldId, newId } of valid) {
          if (!next?.[oldId]) continue;
          const timestamp = next[newId] || next[oldId];
          const { [oldId]: _removed, ...rest } = next;
          next = { ...rest, [newId]: timestamp };
          changed = true;
        }
        if (next !== entries) data[key] = next;
      }
      if (changed) await persist();
    },
  };
}

// PUT setzt, DELETE löscht das Lesezeichen. Setzen nur für vorhandene Artikel eines
// erlaubten Autors; Löschen auch für verwaiste Einträge (Artikel umbenannt/gelöscht).
function installBookmarkRoutes(app, { store, requireAuth, getArticle, canAccessAuthor }) {
  const route = handler => jsonRoute(req => handler(req.params[0], req.session.user), { label: 'Lesezeichen' });

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
