'use strict';

// Kurze Teilen-IDs für /a/<id>: Artikel-IDs enthalten Leerzeichen, Umlaute und
// Schrägstriche. Manche Teilen-Wege (System-Teilen-Menü, WhatsApp) dekodieren %20
// wieder zu einem Leerzeichen, und der Link endet dort. Die Teilen-ID besteht nur
// aus [A-Za-z0-9_-] und ist stabil, solange die Artikel-ID gleich bleibt.

const crypto = require('crypto');

const SHARE_ID_LENGTH = 12;
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{12}$/;

function shareIdFor(id) {
  return crypto.createHash('sha256').update(String(id)).digest('base64url').slice(0, SHARE_ID_LENGTH);
}

// Zuordnung Teilen-ID → ID; wird neu berechnet, sobald sich eine der Listen ändert
// (jeder Reindex ersetzt die Arrays). getLists liefert Arrays von Objekten mit id.
function createShareIdLookup(getLists) {
  let cachedLists = [];
  let byShareId = new Map();
  return function resolveShareId(shareId) {
    if (!SHARE_ID_PATTERN.test(shareId)) return null;
    const lists = getLists();
    if (lists.length !== cachedLists.length || lists.some((list, index) => list !== cachedLists[index])) {
      byShareId = new Map();
      for (const list of lists) for (const item of list) byShareId.set(shareIdFor(item.id), item.id);
      cachedLists = lists;
    }
    return byShareId.get(shareId) || null;
  };
}

module.exports = { shareIdFor, createShareIdLookup, SHARE_ID_PATTERN };
