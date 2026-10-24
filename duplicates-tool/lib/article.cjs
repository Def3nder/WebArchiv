// Markdown-Artikel ohne Frontmatter einlesen – übernommen aus parseArticle in
// WebArchiv/server.js, damit Titel, Datum und Body genauso erkannt werden.
'use strict';

const path = require('path');

function normalizeDate(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  // ISO yyyy-mm-dd
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // German dd.mm.yyyy
  const de = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (de) return `${de[3]}-${de[2].padStart(2, '0')}-${de[1].padStart(2, '0')}`;
  // Slash dd/mm/yyyy
  const sl = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (sl) return `${sl[3]}-${sl[2].padStart(2, '0')}-${sl[1].padStart(2, '0')}`;
  return '';
}

function extractDate(lines, filename) {
  for (const line of lines.slice(0, 12)) {
    const d = normalizeDate(line);
    if (d) return d;
  }
  const fm = path.basename(filename).match(/^(\d{4}-\d{2}-\d{2})/);
  return fm ? fm[1] : '';
}

function bodyExcerpt(text, maxLength = 320) {
  const clean = text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/_/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (clean.length <= maxLength) return clean;
  // An der letzten Wortgrenze kürzen, damit kein Wort mitten abbricht.
  const cut = clean.slice(0, maxLength);
  const space = cut.search(/\s\S*$/);
  return (space > maxLength * 0.8 ? cut.slice(0, space) : cut).trimEnd() + ' …';
}

function parseArticle(content, filePath) {
  const lines = String(content).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');

  // Datum-Zeile suchen (Groß-/Kleinschreibung egal, **, *, _ ignorieren)
  let datumIdx = -1;
  let date = '';
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const clean = lines[i]
      .replace(/\*\*/g, '')
      .replace(/^#+\s*/, '')
      .replace(/^\*|\*$/g, '')
      .trim()
      .replace(/^_+|_+$/g, '')
      .trim();
    if (/^datum:/i.test(clean)) {
      datumIdx = i;
      const raw = clean.replace(/^datum:\s*/i, '').trim();
      date = normalizeDate(raw) || normalizeDate(lines[i]) || '';
      break;
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    date = extractDate(lines, filePath);
  }

  // Titel: nicht-leere Zeilen vor Datum; „Quelle:“ gehört nicht zum Titel.
  const titleLines = [];
  const limitIdx = datumIdx >= 0 ? datumIdx : Math.min(lines.length, 5);
  for (let i = 0; i < limitIdx; i++) {
    const s = lines[i]
      .replace(/^#+\s*/, '')
      .replace(/\*\*/g, '')
      .replace(/^\*|\*$/g, '')
      .replace(/^_+|_+$/g, '')
      .replace(/[»«]/g, '')
      .trim();
    if (!s || /^quelle:/i.test(s)) continue;
    titleLines.push(s);
  }

  // Kopfbereich nach Datum: Metadaten und Zusammenfassung bis zum Trenner
  let inSummary = false;
  let lastMetaIdx = datumIdx >= 0 ? datumIdx : -1;
  let bodyStartIdx = -1;

  for (let i = (datumIdx >= 0 ? datumIdx + 1 : 0); i < lines.length; i++) {
    const raw = lines[i];
    const clean = raw.replace(/\*\*/g, '').replace(/^#+\s*/, '').trim().replace(/^_+|_+$/g, '').trim();

    // Trenner beendet die Zusammenfassung; der Body folgt nach dem letzten Trenner
    if (/^\*{4,}$|^-{4,}$/.test(raw.trim())) {
      inSummary = false;
      bodyStartIdx = i + 1;
      continue;
    }
    if (inSummary) continue;
    if (bodyStartIdx >= 0) continue;

    if (/^(audioquickie|kategorien|quelle):/i.test(clean)) {
      lastMetaIdx = i;
      continue;
    }
    if (/^zusammenfassung:/i.test(clean)) {
      inSummary = true;
      lastMetaIdx = i;
      continue;
    }

    // Ohne expliziten Trenner beginnt der Artikel mit der ersten normalen
    // Textzeile nach Datum und optionalen Metadaten.
    if (datumIdx >= 0 && raw.trim()) {
      bodyStartIdx = i;
      break;
    }
  }

  let bodyLines;
  if (bodyStartIdx >= 0) {
    bodyLines = lines.slice(bodyStartIdx);
  } else {
    let start = lastMetaIdx + 1;
    while (start < lines.length && lines[start].trim() === '') start++;
    bodyLines = lines.slice(start);
  }

  let body = bodyLines.join('\n').trim();
  // Einzelne "---"-Zeile am Body-Anfang (Facebook-/Telegram-Export) entfernen.
  body = body.replace(/^(?:-{3,}|\*{3,}|_{3,})[ \t]*(?:\r?\n|$)/, '').trimStart();
  const title = titleLines.join(' ').trim()
    || path.basename(filePath, '.md').replace(/_/g, ' ').replace(/^\d{4}-\d{2}-\d{2}\s+/, '');

  return { title, date, body };
}

module.exports = { normalizeDate, bodyExcerpt, parseArticle };
