// Lesezeichen pro Nutzer (bookmarks.json): E-Mail (klein) → Artikel-ID → Zeitpunkt.
// Nur für angemeldete Nutzer; Gäste haben keine Lesezeichen.

const fs = require('fs/promises');
const { createJsonState } = require('../lib/atomic-file.cjs');
const { httpError: fail, jsonRoute } = require('../lib/http-errors.cjs');

const emailKey = email => String(email || '').toLowerCase();
const EMPTY = new Set();

function createBookmarkStore({ file, io = fs }) {
  // Änderungen wirken erst, wenn bookmarks.json geschrieben ist (createJsonState).
  const state = createJsonState({ file, io, fromDocument: parsed => (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) });

  return {
    load: () => { state.load(); },
    // Menge der Artikel-IDs mit Lesezeichen (leer für Gäste).
    idsFor(email) {
      const entries = email ? state.value[emailKey(email)] : null;
      return entries ? new Set(Object.keys(entries)) : EMPTY;
    },
    has(email, id) {
      return !!(email && state.value[emailKey(email)]?.[id]);
    },
    async add(email, id) {
      if (!email) throw fail(401, 'Nicht angemeldet.');
      const key = emailKey(email);
      await state.update(data => {
        if (data[key]?.[id]) return false;
        data[key] = { ...(data[key] || {}), [id]: new Date().toISOString() };
        return true;
      });
    },
    async remove(email, id) {
      if (!email) throw fail(401, 'Nicht angemeldet.');
      const key = emailKey(email);
      await state.update(data => {
        if (!data[key]?.[id]) return false;
        delete data[key][id];
        if (!Object.keys(data[key]).length) delete data[key];
        return true;
      });
    },
    async removeUser(email) {
      const key = emailKey(email);
      await state.update(data => {
        if (!data[key]) return false;
        delete data[key];
        return true;
      });
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
      await state.update(data => {
        let changed = false;
        for (const entries of Object.values(data)) {
          for (const { oldId, newId } of valid) {
            if (!entries?.[oldId]) continue;
            entries[newId] = entries[newId] || entries[oldId];
            delete entries[oldId];
            changed = true;
          }
        }
        return changed;
      });
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
