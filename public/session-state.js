/* WebArchiv — gerätebezogener Sitzungszustand pro Benutzer */
(function exposeSessionState(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WebArchivSessionState = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createSessionState() {
  'use strict';

  const VERSION = 1;
  const KEY_PREFIX = 'wa-session-view-v1:';
  const LAYOUTS = new Set(['square', 'tall', 'list']);
  const BOOK_SORTS = new Set(['recent', 'title', 'date']);
  const VIEW_KINDS = new Set(['list', 'detail', 'reader']);

  function shortString(value, max = 2048) {
    return typeof value === 'string' ? value.slice(0, max) : '';
  }

  function finiteNumber(value, min, max, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  function positiveInteger(value, fallback, max = 100000) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 1 && number <= max ? number : fallback;
  }

  function gridColumn(value) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 1 && number <= 8 ? number : null;
  }

  function position(value, fallbackAuthorScope = '') {
    if (!value || typeof value !== 'object') return null;
    return {
      authorScope: typeof value.authorScope === 'string'
        ? shortString(value.authorScope, 500)
        : fallbackAuthorScope,
      anchorId: shortString(value.anchorId),
      anchorIndex: Math.round(finiteNumber(value.anchorIndex, 0, 100000, 0)),
      offset: finiteNumber(value.offset, -100000, 100000, 0),
      top: finiteNumber(value.top, 0, 100000000, 0),
      ratio: finiteNumber(value.ratio, 0, 1, 0),
    };
  }

  function normalize(value) {
    if (!value || typeof value !== 'object' || value.version !== VERSION) return null;
    const list = value.list && typeof value.list === 'object' ? value.list : {};
    const view = value.view && typeof value.view === 'object' ? value.view : {};
    const layout = LAYOUTS.has(list.layout) ? list.layout : 'tall';
    const bookSort = BOOK_SORTS.has(list.bookSort) ? list.bookSort : 'recent';
    const kind = VIEW_KINDS.has(view.kind) ? view.kind : 'list';
    const itemId = shortString(view.itemId);
    const author = shortString(list.author, 500);
    const externalAudio = list.externalAudio === true;
    const authorScope = externalAudio ? '__external_audio__' : author;
    const gridColumns = list.gridColumns && typeof list.gridColumns === 'object'
      ? list.gridColumns
      : {};

    return {
      version: VERSION,
      savedAt: finiteNumber(value.savedAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
      list: {
        q: shortString(list.q, 500),
        author,
        externalAudio,
        year: shortString(list.year, 20),
        category: shortString(list.category, 500),
        telegram: list.telegram === true,
        bookmarks: list.bookmarks === true,
        page: positiveInteger(list.page, 1),
        limit: positiveInteger(list.limit, 24, 200),
        layout,
        gridColumns: {
          square: gridColumn(gridColumns.square),
          tall: gridColumn(gridColumns.tall),
        },
        bookSort,
      },
      view: {
        kind: (kind === 'list' || itemId) ? kind : 'list',
        itemId,
        listPosition: position(view.listPosition, authorScope),
        detailPosition: position(view.detailPosition),
      },
    };
  }

  function userIdentity(user) {
    if (!user || typeof user !== 'object') return '';
    if (user.role === 'guest') return 'guest';
    const email = shortString(user.email, 320).trim().toLocaleLowerCase('de-DE');
    return email ? `user:${email}` : '';
  }

  function storageKey(user) {
    const identity = userIdentity(user);
    return identity ? KEY_PREFIX + encodeURIComponent(identity) : '';
  }

  function load(storage, user) {
    const key = storageKey(user);
    if (!storage || !key) return null;
    try {
      return normalize(JSON.parse(storage.getItem(key) || 'null'));
    } catch {
      return null;
    }
  }

  function save(storage, user, value) {
    const key = storageKey(user);
    if (!storage || !key) return false;
    const normalized = normalize({ ...value, version: VERSION, savedAt: Date.now() });
    if (!normalized) return false;
    try {
      storage.setItem(key, JSON.stringify(normalized));
      return true;
    } catch {
      return false;
    }
  }

  function clear(storage, user) {
    const key = storageKey(user);
    if (!storage || !key) return false;
    try {
      storage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }

  return { VERSION, storageKey, normalize, load, save, clear };
}));
