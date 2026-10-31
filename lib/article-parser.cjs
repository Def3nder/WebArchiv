'use strict';

// Markdown-Artikel ohne Frontmatter einlesen (Titel, Datum, Quelle, Metadaten,
// Body), Suchanfragen in Datums- und Textanteile zerlegen und Kategorien über
// die feste Taxonomie bestimmen. Reine Funktionen ohne Dateizugriff.

const path = require('path');
const { renderSafeMarkdown, safeHttpUrl } = require('./html-sanitizer.cjs');
const { TAXONOMY, TAXONOMY_LABELS, mergeCategories, autoCategorize } = require('./taxonomy.cjs');

function parseDateQuery(q) {
  const s = (q || '').trim();
  if (!s) return null;
  // Voll: ISO yyyy-mm-dd
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { kind: 'exact', value: s };
  // Voll: deutsch dd.mm.yyyy
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return { kind: 'exact', value: `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}` };
  // Monat: ISO yyyy-mm
  if (/^\d{4}-\d{2}$/.test(s)) return { kind: 'prefix', value: s };
  // Monat: deutsch mm.yyyy
  m = s.match(/^(\d{1,2})\.(\d{4})$/);
  if (m) return { kind: 'prefix', value: `${m[2]}-${m[1].padStart(2,'0')}` };
  // Jahr: yyyy
  if (/^\d{4}$/.test(s)) return { kind: 'prefix', value: s };
  return null;
}

function parseArticleSearchQuery(query, knownYears = []) {
  const dateConstraints = [];
  const textTokens = [];
  const years = new Set(knownYears);
  for (const token of String(query || '').trim().split(/\s+/).filter(Boolean)) {
    const explicitEpisode = token.match(/^#(\d+)$/);
    if (explicitEpisode) {
      textTokens.push(explicitEpisode[1]);
      continue;
    }
    const dateQuery = parseDateQuery(token);
    // Nur tatsächlich vorhandene vierstellige Jahre als Datumsfilter behandeln.
    // Andere Zahlen sind unter anderem Audioquickie-Nummern (z. B. 2961).
    if (dateQuery && (!/^\d{4}$/.test(token) || years.has(token))) dateConstraints.push(dateQuery);
    else textTokens.push(token);
  }
  return { dateConstraints, text: textTokens.join(' ').trim() };
}

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

// ─── Auto-categorizer ──────────────────────────────────────────────────────
// Taxonomie und Bewertung liegen in taxonomy.cjs; hier nur weitergereicht.

// Nur http(s): Die Quelle wird im Artikel als anklickbarer Link angezeigt.
function extractSourceUrl(clean) {
  const stripTrail = u => u.trim().replace(/[*_)\].,;\s]+$/, '');
  const md = clean.match(/\[[^\]]*\]\(([^)]+)\)/);
  if (md) return safeHttpUrl(stripTrail(md[1]));
  const bare = clean.match(/(https?:\/\/\S+)/);
  if (bare) return safeHttpUrl(stripTrail(bare[1]));
  return null;
}

function parseArticle(content, filePath) {
  const lines = content.split('\n');

  // Find Datum line (case-insensitive, ignore **, *, _ wrappers)
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

  // Title: non-empty lines before Datum, strip markdown markers
  // Optional "Quelle: <URL>" line is extracted separately and excluded from title.
  const titleLines = [];
  let sourceUrl = null;
  const limitIdx = datumIdx >= 0 ? datumIdx : Math.min(lines.length, 5);
  for (let i = 0; i < limitIdx; i++) {
    const s = lines[i]
      .replace(/^#+\s*/, '')
      .replace(/\*\*/g, '')
      .replace(/^\*|\*$/g, '')
      .replace(/^_+|_+$/g, '')
      .replace(/[»«]/g, '')
      .trim();
    if (!s) continue;
    if (/^quelle:/i.test(s)) {
      if (!sourceUrl) sourceUrl = extractSourceUrl(s.replace(/^quelle:\s*/i, ''));
      continue;
    }
    titleLines.push(s);
  }

  // Parse header section after Datum: collect episode, tags, summary until ****
  let episodeNum = null;
  let instagramPoster = false;
  let tags = [];
  let summaryLines = [];
  let inSummary = false;
  let lastMetaIdx = datumIdx >= 0 ? datumIdx : -1;
  let bodyStartIdx = -1;

  for (let i = (datumIdx >= 0 ? datumIdx + 1 : 0); i < lines.length; i++) {
    const raw = lines[i];
    const clean = raw.replace(/\*\*/g, '').replace(/^#+\s*/, '').trim().replace(/^_+|_+$/g, '').trim();

    // Separator: ends summary section; body follows after last separator
    if (/^\*{4,}$|^-{4,}$/.test(raw.trim())) {
      inSummary = false;
      bodyStartIdx = i + 1;
      continue;
    }

    // Collect summary lines until separator
    if (inSummary) {
      summaryLines.push(raw);
      continue;
    }

    // Past the last separator — skip (body sliced after loop)
    if (bodyStartIdx >= 0) continue;

    if (/^audioquickie:/i.test(clean)) {
      const m = clean.match(/\d+/);
      if (m) episodeNum = parseInt(m[0]);
      lastMetaIdx = i;
      continue;
    }

    if (/^instagram-poster:/i.test(clean)) {
      instagramPoster = /^instagram-poster:\s*ja\s*$/i.test(clean);
      lastMetaIdx = i;
      continue;
    }

    if (/^kategorien:/i.test(clean)) {
      const val = clean.replace(/^kategorien:\s*/i, '');
      tags = val ? val.split(/,\s*/).map(t => t.trim()).filter(Boolean) : [];
      lastMetaIdx = i;
      continue;
    }

    if (/^quelle:/i.test(clean)) {
      if (!sourceUrl) sourceUrl = extractSourceUrl(clean.replace(/^quelle:\s*/i, ''));
      lastMetaIdx = i;
      continue;
    }

    if (/^zusammenfassung:/i.test(clean)) {
      inSummary = true;
      lastMetaIdx = i;
      const rest = clean.replace(/^zusammenfassung:\s*/i, '').trim();
      if (rest) summaryLines.push(rest);
      continue;
    }

    // Ohne expliziten Trenner beginnt der Artikel mit der ersten normalen
    // Textzeile nach Datum und optionalen Metadaten. Spätere Zeilen wie
    // "Quelle:" gehören dann zum Inhalt und dürfen den Body nicht abschneiden.
    if (datumIdx >= 0 && raw.trim()) {
      bodyStartIdx = i;
      break;
    }
  }

  const summary = summaryLines.join('\n').trim() || null;

  // Body: after last separator, or after last metadata line if no separator present
  let bodyLines;
  if (bodyStartIdx >= 0) {
    bodyLines = lines.slice(bodyStartIdx);
  } else {
    let start = lastMetaIdx + 1;
    while (start < lines.length && lines[start].trim() === '') start++;
    bodyLines = lines.slice(start);
  }

  let body = bodyLines.join('\n').trim();
  // Manche Quellen (z. B. Facebook, Telegram) trennen Kopf und Text mit einer
  // einzelnen "---"-Zeile (3 Bindestriche). Da der Separator oben nur 4+ Zeichen
  // erkennt, bliebe diese Zeile sonst am Body-Anfang stehen und erschiene als
  // literales "---" in der Kachel sowie als zusätzliche <hr> unter dem Divider.
  body = body.replace(/^(?:-{3,}|\*{3,}|_{3,})[ \t]*(?:\r?\n|$)/, '').trimStart();
  const title = titleLines.join(' ').trim()
    || path.basename(filePath, '.md').replace(/_/g, ' ').replace(/^\d{4}-\d{2}-\d{2}\s+/, '');

  return { title, date, sourceUrl, summary, tags, episodeNum, instagramPoster, categories: [], body };
}

// Bereinigt (html-sanitizer.cjs): Der Body wird im Browser per innerHTML eingesetzt.
function renderArticleBody(body) {
  return renderSafeMarkdown(body);
}

module.exports = {
  parseDateQuery, parseArticleSearchQuery, normalizeDate, extractDate, bodyExcerpt,
  TAXONOMY, TAXONOMY_LABELS, mergeCategories, autoCategorize,
  extractSourceUrl, parseArticle, renderArticleBody,
};
