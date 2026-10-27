'use strict';

// Infografiken: Zuordnung zu Artikeln und Gruppen, Dateinamen und Nummerierung,
// Bearbeitung des Markdown-Kopfs (Titelzusatz, Kategorien, Instagram-Poster)
// und das gemeinsame Umbenennen bzw. Verschieben von Bild/Markdown-Paaren.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { httpError } = require('./http-errors.cjs');
const { normalizeDate, TAXONOMY_LABELS } = require('./article-parser.cjs');

const INFOGRAPHICS_AUTHOR = 'Infografiken';

// Zuordnung Infografik → Artikel über Jahr + Dateistamm. Anhänge heißen
// „<Stamm>_1“, „<Stamm>_2“ …; der Stamm ohne Suffix bleibt einem eigenständigen
// Artikel samt Hauptbild vorbehalten. Die Endung _N wird nur abgeschnitten, wenn es
// den verkürzten Stamm tatsächlich gibt – sonst gehört die Zahl zum Namen
// (Stefan Hiene: „…_Audioquickie_2961“).
function resolveInfographicStem(stem, hasArticle, hasInfographic) {
  if (hasArticle(stem)) return { baseStem: stem, ordinal: 1 };
  const m = stem.match(/^(.+)_(\d+)$/);
  if (m && /^[1-9]\d*$/.test(m[2]) && (hasArticle(m[1]) || hasInfographic(m[1]))) {
    return { baseStem: m[1], ordinal: parseInt(m[2], 10) };
  }
  return { baseStem: stem, ordinal: 1 };
}

// Verknüpft Infografiken mit ihrem Originalartikel:
//  - Platzhalter-Infografiken (ohne eigenen Text) werden Mitglieder einer Gruppe,
//    deren Anker der Originalartikel ist – oder, ohne Artikel, die Basis-Infografik.
//  - Eine Basis-Infografik mit eigenem Text ist selbst ein Original; ihre Varianten
//    gehören zu ihr (deren doppelter Text wird nicht angezeigt).
//  - Mitglieder erben Kategorien/Tags des Ankers, Infografiken ohne eigenes Audio
//    das Audio der Basis-Infografik bzw. des Artikels (Zugriff bleibt beim Ursprung).
// Mehrdeutige Basis (gleicher Stamm bei mehreren Autoren): zuerst konfigurierte
// Autoren-Priorität, danach eindeutiger Kandidat mit Audio, sonst keine Zuordnung.
function linkInfographics(articleList, authorPriority = []) {
  const key = (year, stem) => `${year || ''}/${stem}`;
  const stemOf = article => path.basename(article.filePath, '.md');
  const priorityByAuthor = new Map(authorPriority.map((author, index) => [author, index]));
  const candidatesByKey = new Map();
  const infographicsByKey = new Map();
  for (const article of articleList) {
    const k = key(article.year, stemOf(article));
    if (article.author === INFOGRAPHICS_AUTHOR) infographicsByKey.set(k, article);
    else candidatesByKey.set(k, [...(candidatesByKey.get(k) || []), article]);
  }
  const baseArticleFor = k => {
    const candidates = candidatesByKey.get(k) || [];
    const ranked = candidates
      .filter(article => priorityByAuthor.has(article.author))
      .sort((a, b) => priorityByAuthor.get(a.author) - priorityByAuthor.get(b.author));
    if (ranked.length) return ranked[0];
    const withAudio = candidates.filter(article => article.audioUrl);
    if (withAudio.length === 1) return withAudio[0];
    return candidates.length === 1 ? candidates[0] : null;
  };

  const infographics = articleList.filter(article => article.author === INFOGRAPHICS_AUTHOR);
  for (const info of infographics) {
    const { baseStem, ordinal } = resolveInfographicStem(stemOf(info),
      stem => candidatesByKey.has(key(info.year, stem)),
      stem => infographicsByKey.has(key(info.year, stem)));
    info.infographicBase = baseStem;
    info.infographicOrdinal = ordinal;
  }

  const groups = new Map();   // Anker-ID → Mitglieder (sortiert)
  const anchorOf = new Map(); // Mitglieds-ID → Anker-ID
  for (const info of infographics) {
    // Eigene Audio-Datei bedeutet eigenständige Infografik, nicht Artikelanhang.
    if (info.audioUrl) continue;
    const k = key(info.year, info.infographicBase);
    const baseArticle = baseArticleFor(k);
    const baseInfo = infographicsByKey.get(k);
    // Eine vorhandene _1 macht die suffixlose Infografik eindeutig zum
    // eigenständigen Anker. Ohne _1 bleibt die alte Basis-Zuordnung bis zur
    // Dateimigration lesbar.
    const standaloneBase = baseInfo && (baseInfo.hasBody
      || (baseInfo.audioUrl && !baseInfo.inheritedAudioAuthor)
      || infographicsByKey.has(key(info.year, infographicAttachmentStem(info.infographicBase, 1))));
    const isBase = baseInfo === info;
    let anchor = null;
    if (isBase) {
      if (!standaloneBase && baseArticle) anchor = baseArticle;
    } else if (standaloneBase) {
      anchor = baseInfo;
    } else if (!info.hasBody) {
      // Ohne Artikel ist die Basis-Infografik der Anker (und selbst das erste Bild).
      anchor = baseArticle || (baseInfo && !baseInfo.hasBody ? baseInfo : null);
    }
    if (!anchor) continue;
    anchorOf.set(info.id, anchor.id);
    groups.set(anchor.id, [...(groups.get(anchor.id) || []), info]);
  }
  for (const members of groups.values()) members.sort((a, b) => a.infographicOrdinal - b.infographicOrdinal);

  const byId = new Map(articleList.map(article => [article.id, article]));
  for (const [memberId, anchorId] of anchorOf) {
    const member = byId.get(memberId);
    const anchor = byId.get(anchorId);
    if (anchor.author === INFOGRAPHICS_AUTHOR && !anchor.hasBody) continue;
    member.categories = [...anchor.categories];
    member.tags = [...anchor.tags];
  }

  // Audio-Vererbung (unabhängig davon, ob die Infografik gruppiert ist).
  for (const info of infographics) {
    if (info.audioUrl) continue;
    const k = key(info.year, info.infographicBase);
    const baseInfo = infographicsByKey.get(k);
    const source = (baseInfo && baseInfo !== info && baseInfo.audioUrl ? baseInfo : null) || baseArticleFor(k);
    if (!source || !source.audioUrl) continue;
    info.audioUrl = source.audioUrl;
    info.hasExternalAudio = !!source.hasExternalAudio;
    info.episodeNum = info.episodeNum || source.episodeNum;
    info.inheritedAudioAuthor = source.inheritedAudioAuthor || source.author;
    info.inheritedAudioArticleId = source.inheritedAudioArticleId || source.id;
  }
  return { groups, anchorOf };
}

function infographicYearsFromMigrations(migrations) {
  const years = new Set();
  for (const migration of migrations || []) {
    for (const relativePath of [migration?.from, migration?.to]) {
      if (!relativePath) continue;
      const parts = String(relativePath).replace(/\\/g, '/').split('/');
      if (parts[0] === INFOGRAPHICS_AUTHOR && /^\d{4}$/.test(parts[1] || '')) years.add(parts[1]);
    }
  }
  return [...years];
}

function imageExtensionFromContentType(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (type === 'image/png') return '.png';
  if (type === 'image/jpeg') return '.jpg';
  return null;
}

function infographicStemExists(dir, stem) {
  return ['.md', '.jpg', '.jpeg', '.png'].some(ext => fs.existsSync(path.join(dir, stem + ext)));
}

function infographicAttachmentStem(baseStem, ordinal) {
  return `${baseStem}_${ordinal}`;
}

function appendOrdinalToMarkdownTitle(lines, ordinal) {
  if (ordinal <= 1) return lines;
  const appendSuffix = (line) => {
    const suffix = ` (${ordinal})`;
    const trailingWhitespace = line.match(/\s*$/)?.[0] || '';
    const core = line.slice(0, line.length - trailingWhitespace.length);
    for (const marker of ['**', '*', '__', '_']) {
      if (core.endsWith(marker)) return core.slice(0, -marker.length) + suffix + marker + trailingWhitespace;
    }
    return core + suffix + trailingWhitespace;
  };

  let datumIdx = -1;
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
      break;
    }
  }

  const limitIdx = datumIdx >= 0 ? datumIdx : Math.min(lines.length, 5);
  for (let i = limitIdx - 1; i >= 0; i--) {
    const clean = lines[i]
      .replace(/^#+\s*/, '')
      .replace(/\*\*/g, '')
      .replace(/^\*|\*$/g, '')
      .trim()
      .replace(/^_+|_+$/g, '')
      .trim();
    if (!clean || /^quelle:/i.test(clean)) continue;
    lines[i] = appendSuffix(lines[i]);
    break;
  }
  return lines;
}

function validateInfographicHeader(content) {
  const lines = content.split(/\r?\n/);
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
    if (!/^datum:/i.test(clean)) continue;

    datumIdx = i;
    const raw = clean.replace(/^datum:\s*/i, '').trim();
    date = normalizeDate(raw) || normalizeDate(lines[i]) || '';
    break;
  }

  let hasTitle = false;
  if (datumIdx >= 0) {
    for (let i = 0; i < datumIdx; i++) {
      const clean = lines[i]
        .replace(/^#+\s*/, '')
        .replace(/\*\*/g, '')
        .replace(/^\*|\*$/g, '')
        .replace(/^_+|_+$/g, '')
        .replace(/[»«]/g, '')
        .trim();
      if (clean && !/^quelle:/i.test(clean)) {
        hasTitle = true;
        break;
      }
    }
  }

  return {
    hasTitle,
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
  };
}

// Infografiken erben die Kategorien ihres Artikels; eine eigene „Kategorien:“-Zeile
// im Kopf entfällt (samt einer dadurch doppelten Leerzeile).
function removeCategoryLines(lines) {
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const clean = lines[i].replace(/\*\*/g, '').replace(/^#+\s*/, '').trim().replace(/^_+|_+$/g, '').trim();
    if (!/^kategorien:/i.test(clean)) { result.push(lines[i]); continue; }
    if (result.length && result[result.length - 1].trim() === '' && (lines[i + 1] ?? '').trim() === '') i++;
  }
  return result;
}

function buildInfographicMarkdown(content, ordinal) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);

  let datumIdx = -1;
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
      break;
    }
  }

  let inSummary = false;
  let lastMetaIdx = datumIdx >= 0 ? datumIdx : -1;
  let separatorIdx = -1;

  for (let i = (datumIdx >= 0 ? datumIdx + 1 : 0); i < lines.length; i++) {
    const raw = lines[i];
    const clean = raw.replace(/\*\*/g, '').replace(/^#+\s*/, '').trim().replace(/^_+|_+$/g, '').trim();

    if (/^\*{4,}$|^-{4,}$/.test(raw.trim())) {
      inSummary = false;
      separatorIdx = i;
      break;
    }
    if (inSummary) continue;

    if (/^audioquickie:/i.test(clean) || /^kategorien:/i.test(clean) || /^quelle:/i.test(clean)) {
      lastMetaIdx = i;
      continue;
    }
    if (/^zusammenfassung:/i.test(clean)) {
      inSummary = true;
      lastMetaIdx = i;
    }
  }

  const cutIdx = separatorIdx >= 0 ? separatorIdx : (lastMetaIdx >= 0 ? lastMetaIdx + 1 : lines.length);
  const keptLines = appendOrdinalToMarkdownTitle(removeCategoryLines(lines.slice(0, cutIdx)), ordinal);
  while (keptLines.length && keptLines[keptLines.length - 1].trim() === '') keptLines.pop();
  return keptLines.join(eol) + eol;
}

function retitleInfographicMarkdown(content, oldOrdinal, newOrdinal) {
  if (oldOrdinal === newOrdinal) return content;
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  let datumIdx = lines.findIndex((line, index) => index < 20
    && /^datum:/i.test(line.replace(/\*\*/g, '').replace(/^#+\s*/, '').replace(/^_+|_+$/g, '').trim()));
  if (datumIdx < 0) datumIdx = Math.min(lines.length, 5);
  if (oldOrdinal > 1) {
    for (let i = datumIdx - 1; i >= 0; i--) {
      const clean = lines[i].replace(/^#+\s*/, '').replace(/\*\*/g, '')
        .replace(/^\*|\*$/g, '').replace(/^_+|_+$/g, '').trim();
      if (!clean || /^quelle:/i.test(clean)) continue;
      const suffix = new RegExp(' \\(' + oldOrdinal + '\\)(?=(?:\\*\\*|__|\\*|_)?\\s*$)');
      lines[i] = lines[i].replace(suffix, '');
      break;
    }
  }
  appendOrdinalToMarkdownTitle(lines, newOrdinal);
  return lines.join(eol);
}

function setInstagramPosterMetadata(content, enabled) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const cleanMetadataLine = line => line.replace(/\*\*/g, '').replace(/^#+\s*/, '')
    .replace(/^\*|\*$/g, '').replace(/^_+|_+$/g, '').trim();
  const hadMarker = lines.some(line => /^instagram-poster:/i.test(cleanMetadataLine(line)));
  if (!enabled && !hadMarker) return content;
  const withoutMarker = lines.filter(line => !/^instagram-poster:/i.test(cleanMetadataLine(line)));
  const datumIdx = withoutMarker.findIndex((line, index) => index < 20
    && /^datum:/i.test(cleanMetadataLine(line)));
  if (datumIdx < 0) {
    if (enabled) throw httpError(409, 'Die Infografik hat keine Datum-Zeile.');
    return withoutMarker.join(eol);
  }

  // Der Marker ist ein eigener Markdown-Absatz. Vorhandene Leerzeilen direkt
  // nach dem Datum werden dabei vereinheitlicht, damit Aktivieren und Entfernen
  // keine immer größeren Lücken erzeugt.
  let nextContentIdx = datumIdx + 1;
  while (nextContentIdx < withoutMarker.length && !withoutMarker[nextContentIdx].trim()) {
    nextContentIdx++;
  }
  withoutMarker.splice(datumIdx + 1, nextContentIdx - datumIdx - 1,
    ...(enabled ? ['', 'Instagram-Poster: Ja', ''] : ['']));
  return withoutMarker.join(eol);
}

// Alle Quellen erst in temporäre Namen verschieben, dann die Ziele belegen:
// dadurch sind auch Vertauschungen von _1, _2, _3 usw. ohne Überschreiben
// möglich. Fehler rollen sowohl Dateinamen als auch Markdown-Inhalte zurück.
async function moveInfographicFiles(mappings) {
  if (!mappings.length) return async () => {};
  const key = file => process.platform === 'win32' ? file.toLowerCase() : file;
  const sources = new Set(mappings.map(item => key(item.source)));
  const targets = new Set();
  if (sources.size !== mappings.length) throw httpError(409, 'Eine Infografikdatei ist mehrfach enthalten.');
  for (const item of mappings) {
    const targetKey = key(item.target);
    if (targets.has(targetKey)) throw httpError(409, 'Zwei Infografikdateien hätten denselben Zielnamen.');
    targets.add(targetKey);
    const stat = await fs.promises.lstat(item.source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw httpError(409, 'Symbolische Links oder Ordner können nicht verschoben werden.');
    try {
      await fs.promises.lstat(item.target);
      if (!sources.has(targetKey)) throw httpError(409, 'Zieldatei existiert bereits: ' + path.basename(item.target));
    } catch (error) {
      if (error.status) throw error;
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const token = crypto.randomBytes(8).toString('hex');
  const work = await Promise.all(mappings.map(async (item, index) => ({
    ...item,
    temp: path.join(path.dirname(item.source), '.infographic-' + token + '-' + index + '.tmp'),
    original: item.content === undefined ? undefined : await fs.promises.readFile(item.source),
    state: 'source',
  })));
  try {
    for (const item of work) {
      await fs.promises.rename(item.source, item.temp);
      item.state = 'temp';
    }
    for (const item of work) {
      if (item.content !== undefined) await fs.promises.writeFile(item.temp, item.content);
    }
    for (const item of work) {
      await fs.promises.rename(item.temp, item.target);
      item.state = 'target';
    }
  } catch (error) {
    for (const item of work.filter(item => item.state === 'target').reverse()) {
      await fs.promises.rename(item.target, item.temp);
      item.state = 'temp';
    }
    for (const item of work) {
      if (item.state === 'temp' && item.original !== undefined) await fs.promises.writeFile(item.temp, item.original);
    }
    for (const item of [...work].reverse()) {
      if (item.state === 'temp') await fs.promises.rename(item.temp, item.source);
    }
    throw error;
  }
  return async () => {
    await moveInfographicFiles(work.map(item => ({
      source: item.target, target: item.source, content: item.original,
    })));
  };
}

function slugify(title) {
  return String(title || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 80).replace(/-+$/, '');
}

// „Kategorien: [a, b]“ → „Kategorien: a, b“, leere Liste entfernen; ein
// stehengebliebenes „[Inhalt]“ unter der Trennlinie entfernen. Im Dialog
// angehakte Kategorien (nur Taxonomie-Labels) kommen erst hier in die Datei:
// in eine vorhandene Kategorien-Zeile, sonst als neue Zeile nach „Datum:“.
function normalizeNewInfographicMarkdown(markdown, categories = []) {
  const checked = [...new Set((categories || []).filter(label => TAXONOMY_LABELS.has(label)))];
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const result = [];
  const separatorIdx = lines.findIndex(line => /^(\*{4,}|-{4,})\s*$/.test(line.trim()));
  const hasCategoryLine = lines.slice(0, separatorIdx < 0 ? lines.length : separatorIdx)
    .some(line => /^\s*\**_?kategorien:/i.test(line));
  let afterSeparator = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(\*{4,}|-{4,})\s*$/.test(line.trim())) afterSeparator = true;
    const m = !afterSeparator && line.match(/^(\s*\**_?kategorien:\**_?\s*)(.*)$/i);
    if (m) {
      const values = [...new Set([...m[2].replace(/^\[|\]$/g, '').split(',').map(v => v.trim()).filter(Boolean), ...checked])];
      checked.length = 0;
      if (values.length) result.push(m[1] + values.join(', '));
      else if (result.length && result[result.length - 1].trim() === '' && (lines[i + 1] ?? '').trim() === '') i++;
      continue;
    }
    result.push(line);
    if (checked.length && !hasCategoryLine && !afterSeparator && /^[\s*_]*datum:/i.test(line)) {
      result.push(`Kategorien: ${checked.join(', ')}`);
      checked.length = 0;
    }
  }
  let text = result.join('\n');
  text = text.replace(/(\n(?:\*{4,}|-{4,})[ \t]*\n)\s*\[Inhalt\]\s*$/i, '$1');
  return text.replace(/\s+$/, '') + '\n';
}

function detectImageType(buffer) {
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  return null;
}

module.exports = {
  INFOGRAPHICS_AUTHOR, resolveInfographicStem, linkInfographics, infographicYearsFromMigrations,
  imageExtensionFromContentType, infographicStemExists, infographicAttachmentStem,
  appendOrdinalToMarkdownTitle, validateInfographicHeader, removeCategoryLines, buildInfographicMarkdown,
  retitleInfographicMarkdown, setInstagramPosterMetadata, moveInfographicFiles,
  slugify, normalizeNewInfographicMarkdown, detectImageType,
};
