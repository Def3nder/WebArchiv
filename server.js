const express = require('express');
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const Fuse = require('fuse.js');
const session = require('express-session');
const bcrypt  = require('bcryptjs');
const sharp   = require('sharp');
const { spawn } = require('child_process');

const app = express();
// Hinter dem Reverse-Proxy (Caddy/HTTPS) X-Forwarded-Proto/Host respektieren,
// damit absolute og:*-URLs (Link-Vorschau) korrekt https:// und Host tragen.
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;
const WWW_DIR = path.join(__dirname, 'www');
const INFOGRAPHICS_AUTHOR = 'Infografiken';
const INFOGRAPHIC_MAX_BYTES = 10 * 1024 * 1024;

// ─── Users ─────────────────────────────────────────────────────────────────

const USERS_FILE = path.join(__dirname, 'users.json');
let users = [];
try {
  const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  users = Array.isArray(parsed) ? parsed : (parsed.users || []);
} catch (err) {
  console.error('WARNING: users.json nicht geladen —', err.message);
}

const PUBLIC_DIRS_FILE = path.join(__dirname, 'public-directories.txt');
let publicAuthors = [];
try {
  const parsed = JSON.parse(fs.readFileSync(PUBLIC_DIRS_FILE, 'utf8'));
  publicAuthors = Array.isArray(parsed['public-directories'])
    ? parsed['public-directories'] : [];
  console.log(`Public-Autoren: ${publicAuthors.length ? publicAuthors.join(', ') : '(keine)'}`);
} catch (err) {
  console.warn('public-directories.txt nicht geladen —', err.message);
}

let articles = [];
let meta = { authors: [], years: [], categories: [] };
let fuseIndex = null;
let reindexState = { running: false, processed: 0, articles: 0, done: true };
let scrapeState = { running: false, sources: null, exitCode: null, startedAt: null, done: true, error: null };

// ─── Parsers ───────────────────────────────────────────────────────────────

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

function bodyExcerpt(text) {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/_/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 320);
}

// ─── Auto-categorizer ──────────────────────────────────────────────────────

const TAXONOMY = [
  { label: 'Sexualität',       keys: ['sexualit', 'orgasmus', 'libido', 'erotik', 'tantra', 'lustempfind', 'intimität', 'begehren', 'penetration', 'yoni', 'becken', 'cunnilingus', 'analsex', 'masturbation', 'lust ', 'sexleben', 'sexuell', 'sexuelle', 'sexuellen'] },
  { label: 'Beziehungen',      keys: ['beziehung', 'partner', 'liebe', 'bindung', 'ehe', 'trennung', 'vertrauen', 'nähe', 'intimität', 'begegnung', 'beziehungsangst', 'paartherapie', 'paardynamik', 'nähe und distanz', 'beziehungsmodell'] },
  { label: 'Trauma & Heilung', keys: ['trauma', 'heilung', 'verletzung', 'kindheit', 'therapie', 'wunde', 'schmerz', 'vergangenheit', 'missbrauch', 'heilungsprozess', 'traumatisch', 'verwundbar'] },
  { label: 'Psychologie',      keys: ['psychologie', 'dopamin', 'gehirn', 'neurobiologie', 'muster', 'konditionier', 'unbewusst', 'manipulation', 'narziss', 'bindungsangst', 'sucht', 'abhängig', 'mechanismus', 'verhaltens'] },
  { label: 'Spiritualität',    keys: ['spiritualit', 'bewusstsein', 'meditation', 'seele', 'energie', 'erwachen', 'yoga', 'stille', 'präsenz', 'geist', 'göttlich', 'heilig', 'gebet', 'mystik', 'erleuchtung', 'bewusst sein'] },
  { label: 'Persönlichkeit',   keys: ['selbstwert', 'authentizit', 'ego', 'identität', 'grenzen', 'selbstliebe', 'würde', 'selbstbild', 'selbstwahrnehmung', 'ich-sein', 'charakter', 'reife', 'integrität', 'selbstverantwortung'] },
  { label: 'Gesundheit',       keys: ['gesundheit', 'hormon', 'stress', 'wohlbefinden', 'nervensystem', 'körpergefühl', 'schlaf', 'erschöpfung', 'burnout', 'ernährung', 'immunsystem', 'menstruation', 'zyklus'] },
  { label: 'Philosophie',      keys: ['philosophie', 'wahrheit', 'freiheit', 'sinn', 'bedeutung', 'leere', 'gedanke', 'denken', 'erkenntnis', 'wissen', 'wirklichkeit', 'existenz', 'sein und haben'] },
  { label: 'Männer & Frauen',  keys: ['männer', 'frauen', 'maskulin', 'feminin', 'gender', 'attraktion', 'maskulinität', 'feminität', 'geschlechter', 'männlichkeit', 'weiblichkeit', 'nice guy', 'toxisch'] },
  { label: 'Achtsamkeit',      keys: ['achtsamkeit', 'mindfulness', 'präsenz', 'augenblick', 'gegenwart', 'atmung', 'entspannung', 'bewusste wahrnehmung', 'innehalten', 'entschleunig'] },
  { label: 'Gesellschaft',     keys: ['gesellschaft', 'kultur', 'normen', 'herrschaft', 'autorität', 'kollektiv', 'sozial', 'politisch', 'anarchie', 'system', 'konventionen', 'tabu'] },
  { label: 'Selbsterkenntnis', keys: ['selbsterkenntnis', 'beobachtung', 'wahrnehmung', 'reflexion', 'innenschau', 'selbstreflexion', 'erkennen', 'introspektion', 'bewusst werden', 'selbstbeobachtung'] },
];

function autoCategorize(text) {
  const lower = text.toLowerCase();
  const scores = TAXONOMY.map(bucket => {
    const count = bucket.keys.reduce((n, k) => {
      let pos = 0, hits = 0;
      while ((pos = lower.indexOf(k, pos)) !== -1) { hits++; pos += k.length; }
      return n + hits;
    }, 0);
    return { label: bucket.label, count };
  });
  return scores
    .filter(s => s.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map(s => s.label);
}

function extractSourceUrl(clean) {
  const stripTrail = u => u.trim().replace(/[*_)\].,;\s]+$/, '');
  const md = clean.match(/\[[^\]]*\]\(([^)]+)\)/);
  if (md) return stripTrail(md[1]);
  const bare = clean.match(/(https?:\/\/\S+)/);
  if (bare) return stripTrail(bare[1]);
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

  return { title, date, sourceUrl, summary, tags, episodeNum, categories: [], body };
}

// ─── File scanner ──────────────────────────────────────────────────────────

function findSibling(dir, basename, exts) {
  for (const ext of exts) {
    const p = path.join(dir, basename + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Cache-Busting: mtime der Datei als Versions-Query an die /files-URL hängen,
// damit ein ausgetauschtes Bild (gleicher Name) im Browser neu geladen wird.
function fileUrl(relPath, absPath) {
  let v = '';
  try { v = '?v=' + Math.floor(fs.statSync(absPath).mtimeMs); } catch { /* Datei weg */ }
  return `/files/${relPath}${v}`;
}

async function scanDir(dirPath, author, year, collector) {
  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nextYear = /^\d{4}$/.test(entry.name) ? entry.name : year;
      await scanDir(fullPath, author, nextYear, collector);
      continue;
    }
    if (!entry.name.endsWith('.md')) continue;

    const basename = entry.name.slice(0, -3);
    const relDir = path.relative(path.join(WWW_DIR, author), dirPath);
    const id = [author, relDir, basename].filter(Boolean).join('/').replace(/\\/g, '/');

    try {
      const content = await fs.promises.readFile(fullPath, 'utf8');
      const parsed = parseArticle(content, fullPath);

      const imgPath = findSibling(dirPath, basename, ['.jpg', '.jpeg', '.png'])
        || findSibling(path.join(WWW_DIR, author), 'standard', ['.jpg', '.jpeg', '.png']);
      const audioPath = findSibling(dirPath, basename, ['.mp3']);
      const videoPath = findSibling(dirPath, basename, ['.mp4']);
      const pdfPath   = findSibling(dirPath, basename, ['.pdf']);

      const relImg   = imgPath   ? path.relative(WWW_DIR, imgPath).replace(/\\/g, '/')   : null;
      const relAudio = audioPath ? path.relative(WWW_DIR, audioPath).replace(/\\/g, '/') : null;
      const relVideo = videoPath ? path.relative(WWW_DIR, videoPath).replace(/\\/g, '/') : null;
      const relPdf   = pdfPath   ? path.relative(WWW_DIR, pdfPath).replace(/\\/g, '/')   : null;

      // categories = unified taxonomy labels (for filtering); tags = raw Kategorien field (display only)
      const searchText = parsed.title + ' ' + (parsed.summary || '') + ' ' + parsed.body;
      const categories = autoCategorize(searchText);
      const tags = (parsed.tags || []).slice(0, 10);

      const excerpt = parsed.summary
        ? parsed.summary.slice(0, 320)
        : bodyExcerpt(parsed.body);

      collector.push({
        id,
        author,
        year: year || (parsed.date ? parsed.date.slice(0, 4) : ''),
        title: parsed.title,
        date: parsed.date,
        categories,
        tags,
        excerpt,
        summary: parsed.summary || null,
        sourceUrl: parsed.sourceUrl || null,
        preview: bodyExcerpt(parsed.body).slice(0, 200),
        imageUrl: relImg   ? fileUrl(relImg, imgPath)     : null,
        audioUrl: relAudio ? fileUrl(relAudio, audioPath) : null,
        videoUrl: relVideo ? fileUrl(relVideo, videoPath) : null,
        pdfUrl:   relPdf   ? fileUrl(relPdf, pdfPath)     : null,
        episodeNum: parsed.episodeNum,
        filePath: fullPath,
      });
      reindexState.processed++;
    } catch (err) {
      // skip unparseable files silently
    }
  }
}

async function buildIndex() {
  console.log('Building article index…');
  const t0 = Date.now();
  reindexState = { running: true, processed: 0, articles: 0, done: false };
  const collector = [];

  let authorDirs;
  try {
    authorDirs = (await fs.promises.readdir(WWW_DIR, { withFileTypes: true })).filter(d => d.isDirectory());
  } catch (err) {
    console.error('Cannot read www directory:', err.message);
    reindexState = { running: false, processed: 0, articles: 0, done: true };
    return;
  }

  for (const dir of authorDirs) {
    await scanDir(path.join(WWW_DIR, dir.name), dir.name, null, collector);
  }

  // Deduplicate by id (orig/ subdirs may duplicate files)
  const seen = new Set();
  articles = collector.filter(a => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });

  const isInfografik = a => (a.author === 'Infografiken' ? 1 : 0);
  articles.sort((a, b) =>
    (b.date || '').localeCompare(a.date || '') ||
    (a.title || '').localeCompare(b.title || '', 'de', { sensitivity: 'base' }) ||
    isInfografik(a) - isInfografik(b)
  );

  const authorsSet = new Set(articles.map(a => a.author));
  const yearsSet = new Set(articles.map(a => a.year).filter(Boolean));
  const catsSet = new Set(articles.flatMap(a => a.categories));

  meta = {
    authors: [...authorsSet].sort(),
    years: [...yearsSet].sort().reverse(),
    categories: [...catsSet].filter(Boolean).sort((a, b) => a.localeCompare(b, 'de')),
  };

  fuseIndex = new Fuse(articles, {
    keys: [
      { name: 'title',      weight: 3 },
      { name: 'author',     weight: 1.5 },
      { name: 'categories', weight: 1 },
      { name: 'excerpt',    weight: 0.8 },
    ],
    threshold: 0.35,
    includeScore: true,
    ignoreLocation: true,
    minMatchCharLength: 2,
  });

  reindexState = { running: false, processed: articles.length, articles: articles.length, done: true };
  console.log(`✓ ${articles.length} articles indexed in ${Date.now() - t0}ms`);
}

// ─── Auth helpers ──────────────────────────────────────────────────────────

function findUser(email) {
  return users.find(u => u.email.toLowerCase() === (email || '').toLowerCase());
}

function canAccessAuthor(sessionUser, author) {
  if (!sessionUser) return false;
  if (sessionUser.allowedAuthors === null) return true;
  return sessionUser.allowedAuthors.includes(author);
}

function isPublicAuthor(author) {
  return publicAuthors.includes(author);
}

function canUploadInfographic(sessionUser, article) {
  return !!(
    sessionUser?.role === 'admin' &&
    article &&
    canAccessAuthor(sessionUser, article.author) &&
    article.author !== INFOGRAPHICS_AUTHOR &&
    !isPublicAuthor(article.author)
  );
}

function imageExtensionFromContentType(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (type === 'image/png') return '.png';
  if (type === 'image/jpeg') return '.jpg';
  return null;
}

function resolveUnder(root, ...segments) {
  const absPath = path.resolve(path.join(root, ...segments));
  if (absPath !== root && !absPath.startsWith(root + path.sep)) return null;
  return absPath;
}

function infographicStemExists(dir, stem) {
  return ['.md', '.jpg', '.jpeg', '.png'].some(ext => fs.existsSync(path.join(dir, stem + ext)));
}

function getInfographicTarget(article, imageExt) {
  const year = article.year || (article.date ? article.date.slice(0, 4) : '');
  if (!/^\d{4}$/.test(year)) return null;

  const dir = resolveUnder(WWW_DIR, INFOGRAPHICS_AUTHOR, year);
  if (!dir) return null;

  const baseStem = path.basename(article.filePath, '.md');
  for (let ordinal = 1; ordinal < 1000; ordinal++) {
    const stem = ordinal === 1 ? baseStem : `${baseStem}_${ordinal}`;
    if (!infographicStemExists(dir, stem)) {
      return {
        dir,
        year,
        ordinal,
        stem,
        mdPath: path.join(dir, stem + '.md'),
        imagePath: path.join(dir, stem + imageExt),
        id: [INFOGRAPHICS_AUTHOR, year, stem].join('/'),
      };
    }
  }
  return null;
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
  const keptLines = appendOrdinalToMarkdownTitle(lines.slice(0, cutIdx), ordinal);
  while (keptLines.length && keptLines[keptLines.length - 1].trim() === '') keptLines.pop();
  return keptLines.join(eol) + eol;
}

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

function requireAdmin(req, res, next) {
  if (req.session?.user?.role === 'admin') return next();
  res.status(403).json({ error: 'Admin only' });
}

function getEffectiveUser(req) {
  if (req.session?.user) return req.session.user;
  return { email: null, role: 'guest', allowedAuthors: publicAuthors };
}

// Soft auth: attaches req.user (session user or anonymous guest with public-author whitelist).
// Returns 401 only when no session AND no public authors are configured.
function attachUser(req, res, next) {
  req.user = getEffectiveUser(req);
  if (req.user.role === 'guest' && publicAuthors.length === 0) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// ─── API ───────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'webarchiv-dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' },
}));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth routes (public) ──────────────────────────────────────────────────

app.get('/api/me', (req, res) => {
  res.json(getEffectiveUser(req));
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = findUser(email);
  if (!user || !(await bcrypt.compare(password || '', user.passwordHash || ''))) {
    return res.status(401).json({ error: 'Ungültige E-Mail oder Passwort' });
  }
  req.session.user = { email: user.email, role: user.role, allowedAuthors: user.allowedAuthors };
  res.json(req.session.user);
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('connect.sid'); res.json({ ok: true }); });
});

// ─── Authenticated file handler (replaces express.static for /files) ───────

app.get('/files/*', attachUser, (req, res) => {
  const relPath = req.params[0];
  const author  = relPath.split('/')[0];
  if (!canAccessAuthor(req.user, author)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const absPath = path.resolve(path.join(WWW_DIR, relPath));
  if (!absPath.startsWith(WWW_DIR + path.sep)) {
    return res.status(403).end();
  }
  res.sendFile(absPath, err => { if (err && !res.headersSent) res.status(404).end(); });
});

// ─── Link-Vorschau (Open Graph) ────────────────────────────────────────────
// Crawler (WhatsApp, Signal, Telegram …) führen kein JS aus und ignorieren
// den #-Teil der URL. Deshalb liefert /a/<id> serverseitig og:*-Meta-Tags und
// leitet echte Besucher per JS/meta-refresh in den SPA (#/article/<id>) weiter.

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// imageUrl ("/files/<relPath>?v=…") → absoluter Dateipfad unter WWW_DIR.
// Gibt null zurück, wenn kein Bild oder der Pfad WWW_DIR verlässt (Traversal).
function resolveArticleImagePath(article) {
  if (!article || !article.imageUrl) return null;
  const rel = article.imageUrl.replace(/^\/files\//, '').split('?')[0];
  const absPath = path.resolve(path.join(WWW_DIR, rel));
  if (!absPath.startsWith(WWW_DIR + path.sep)) return null;
  return absPath;
}

function ogDescription(article) {
  const raw = (article.summary || article.excerpt || '').replace(/\s+/g, ' ').trim();
  return raw.length > 200 ? raw.slice(0, 197).trimEnd() + '…' : raw;
}

app.get('/a/*', (req, res) => {
  const id = req.params[0];
  const article = articles.find(a => a.id === id);
  const base = `${req.protocol}://${req.get('host')}`;
  const canonical = base + '/a/' + encodeURIComponent(id);

  let tags;
  if (article) {
    const title = escapeHtml(article.title || 'WebArchiv');
    const desc  = escapeHtml(ogDescription(article));
    const img   = article.imageUrl ? base + '/og-image/' + encodeURIComponent(id) : '';
    tags = `
    <title>${title}</title>
    <meta name="description" content="${desc}" />
    <meta property="og:site_name" content="WebArchiv" />
    <meta property="og:type" content="article" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${desc}" />
    <meta property="og:url" content="${escapeHtml(canonical)}" />
    ${img ? `<meta property="og:image" content="${escapeHtml(img)}" />` : ''}
    <meta name="twitter:card" content="${img ? 'summary_large_image' : 'summary'}" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${desc}" />
    ${img ? `<meta name="twitter:image" content="${escapeHtml(img)}" />` : ''}`;
  } else {
    tags = `
    <title>WebArchiv</title>
    <meta property="og:site_name" content="WebArchiv" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="WebArchiv" />
    <meta property="og:url" content="${escapeHtml(base + '/')}" />`;
  }

  // JS-Weiterleitung für Menschen; Crawler lesen nur die Meta-Tags oben.
  const target = '/#/article/' + encodeURIComponent(id);
  res.type('html').send(`<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="refresh" content="0; url=${escapeHtml(target)}" />${tags}
</head>
<body>
    <p>Weiterleitung … <a href="${escapeHtml(target)}">Zum Artikel</a></p>
    <script>location.replace(${JSON.stringify(target)});</script>
</body>
</html>`);
});

// Auth-freie, heruntergerechnete Bild-Auslieferung nur für die Link-Vorschau.
// Bewusst ohne canAccessAuthor: die Vorschau-Metadaten aller Artikel sind
// öffentlich (Nutzer-Entscheidung). Bild wird auf max. 1200px/JPEG skaliert,
// damit nie die Originalauflösung geteilt wird. Ergebnis pro mtime gecacht.
const ogImageCache = new Map(); // key: absPath+':'+mtime → Buffer

app.get('/og-image/*', async (req, res) => {
  const id = req.params[0];
  const article = articles.find(a => a.id === id);
  const absPath = resolveArticleImagePath(article);
  if (!absPath) return res.status(404).end();

  let mtime = 0;
  try { mtime = Math.floor(fs.statSync(absPath).mtimeMs); } catch { return res.status(404).end(); }

  const key = absPath + ':' + mtime;
  res.set('Cache-Control', 'public, max-age=86400');

  const cached = ogImageCache.get(key);
  if (cached) return res.type('image/jpeg').send(cached);

  try {
    const buf = await sharp(absPath)
      .resize({ width: 1200, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    // Cache begrenzen (einfaches FIFO), um Speicher im kleinen LXC zu schonen.
    if (ogImageCache.size >= 200) ogImageCache.delete(ogImageCache.keys().next().value);
    ogImageCache.set(key, buf);
    res.type('image/jpeg').send(buf);
  } catch (err) {
    // Fallback: Original ausliefern, damit die Vorschau funktionsfähig bleibt.
    res.sendFile(absPath, e => { if (e && !res.headersSent) res.status(404).end(); });
  }
});

// ─── Protected API routes ──────────────────────────────────────────────────

app.get('/api/meta', attachUser, (req, res) => {
  const user = req.user;
  const authors = user.allowedAuthors === null
    ? meta.authors
    : meta.authors.filter(a => user.allowedAuthors.includes(a));
  res.json({ authors, years: meta.years, categories: meta.categories });
});

app.get('/api/reindex/status', requireAuth, (_req, res) => res.json(reindexState));

const PROMPTS_DIR = path.join(__dirname, 'prompts');

// Liste der verfügbaren Prompt-Dateien; Zahlen-Präfix steuert Reihenfolge
// und wird aus dem Label entfernt (z. B. "1_Infografik-Prompt-ChatGPT.txt").
app.get('/api/prompts', attachUser, (_req, res) => {
  try {
    const prompts = fs.readdirSync(PROMPTS_DIR)
      .filter(f => f.toLowerCase().endsWith('.txt'))
      .map(file => {
        const stem = file.slice(0, -4);
        const m = stem.match(/^(\d+)_(.*)$/);
        return {
          file,
          label: m ? m[2] : stem,
          order: m ? parseInt(m[1], 10) : Infinity,
        };
      })
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
      .map(({ file, label }) => ({ file, label }));
    res.json(prompts);
  } catch {
    res.json([]);
  }
});

// Inhalt einer einzelnen Prompt-Datei (Path-Traversal-Schutz wie /files/*)
app.get('/api/prompts/:file', attachUser, (req, res) => {
  const file = path.basename(req.params.file);
  if (!file.toLowerCase().endsWith('.txt')) return res.status(400).end();
  const absPath = path.resolve(path.join(PROMPTS_DIR, file));
  if (!absPath.startsWith(PROMPTS_DIR + path.sep)) return res.status(400).end();
  try {
    const txt = fs.readFileSync(absPath, 'utf8');
    res.type('text/plain').send(txt);
  } catch {
    res.status(404).end();
  }
});

app.post('/api/reindex', requireAdmin, (req, res) => {
  if (reindexState.running) return res.json({ started: false, reason: 'already running' });
  buildIndex().catch(console.error);
  res.json({ started: true });
});

app.post(
  '/api/infographics/*',
  requireAdmin,
  express.raw({ type: ['image/png', 'image/jpeg'], limit: INFOGRAPHIC_MAX_BYTES }),
  async (req, res) => {
    const id = req.params[0];
    const article = articles.find(a => a.id === id);
    if (!article) return res.status(404).json({ error: 'Artikel nicht gefunden.' });

    if (!canUploadInfographic(req.session.user, article)) {
      return res.status(403).json({ error: 'Für diesen Artikel ist kein Infografik-Upload erlaubt.' });
    }

    const imageExt = imageExtensionFromContentType(req.get('content-type'));
    if (!imageExt) {
      return res.status(415).json({ error: 'Nur PNG- und JPG-Bilder sind erlaubt.' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Keine Bilddatei empfangen.' });
    }

    let originalContent;
    try {
      originalContent = await fs.promises.readFile(article.filePath, 'utf8');
    } catch {
      return res.status(500).json({ error: 'Artikeldatei konnte nicht gelesen werden.' });
    }

    const header = validateInfographicHeader(originalContent);
    if (!header.hasTitle) {
      return res.status(400).json({ error: 'Der Artikel enthält keinen Titel.' });
    }
    if (!header.date) {
      return res.status(400).json({ error: 'Der Artikel enthält keine gültige Datum-Zeile.' });
    }

    const target = getInfographicTarget({ ...article, date: header.date, year: header.date.slice(0, 4) }, imageExt);
    if (!target) {
      return res.status(400).json({ error: 'Kein gültiger Zielpfad für die Infografik gefunden.' });
    }

    try {
      await fs.promises.mkdir(target.dir, { recursive: true });
      await fs.promises.writeFile(target.mdPath, buildInfographicMarkdown(originalContent, target.ordinal), { flag: 'wx' });
      try {
        await fs.promises.writeFile(target.imagePath, req.body, { flag: 'wx' });
      } catch (err) {
        await fs.promises.unlink(target.mdPath).catch(() => {});
        throw err;
      }

      await buildIndex();
      res.json({
        ok: true,
        id: target.id,
        filename: path.basename(target.imagePath),
        ordinal: target.ordinal,
      });
    } catch (err) {
      if (err.code === 'EEXIST') {
        return res.status(409).json({ error: 'Eine Infografik mit diesem Namen existiert bereits. Bitte erneut versuchen.' });
      }
      res.status(500).json({ error: err.message || 'Infografik konnte nicht gespeichert werden.' });
    }
  }
);

// ─── Scrape (Admin): externen Scraper starten, danach automatisch reindexen ──
//
// Startet scraper/scrape_all.js als eigenen Node-Prozess (self-contained mit
// eigenen node_modules; playwright bleibt aus den App-Abhängigkeiten heraus).
// Läuft im Hintergrund; der Fortschritt wird über /api/scrape/status gepollt.

app.get('/api/scrape/status', requireAuth, (_req, res) => res.json(scrapeState));

app.post('/api/scrape', requireAdmin, (req, res) => {
  if (scrapeState.running) return res.json({ started: false, reason: 'already running' });
  if (reindexState.running) return res.json({ started: false, reason: 'reindex running' });

  // Optionale Quellenauswahl: { sources: ["blog","facebook","telegram"] }.
  // Ohne Angabe laufen alle drei (Reihenfolge bestimmt der Scraper selbst).
  const allowed = ['blog', 'facebook', 'telegram'];
  const sources = Array.isArray(req.body?.sources)
    ? req.body.sources.filter(s => allowed.includes(s))
    : [];

  const scriptPath = path.join(__dirname, 'scraper', 'scrape_all.js');
  const args = [scriptPath, ...sources.map(s => `--${s}`)];

  scrapeState = {
    running: true,
    sources: sources.length ? sources : allowed,
    exitCode: null,
    startedAt: Date.now(),
    done: false,
    error: null,
    output: '',
  };
  console.log(`Scrape gestartet: ${scrapeState.sources.join(', ')}`);

  // Ausgabe des Kindprozesses für die Live-Anzeige im Web-UI sammeln (gekappt
  // auf die letzten ~20 000 Zeichen, damit ein großer Erstlauf den Speicher
  // nicht sprengt). Die Zusammenfassung des Scrapers steht am Ende.
  const captureOutput = (chunk) => {
    scrapeState.output += chunk.toString();
    if (scrapeState.output.length > 20000) {
      scrapeState.output = scrapeState.output.slice(-20000);
    }
  };

  const child = spawn(process.execPath, args, { cwd: path.join(__dirname, 'scraper') });
  child.stdout.on('data', d => { process.stdout.write(`[scrape] ${d}`); captureOutput(d); });
  child.stderr.on('data', d => { process.stderr.write(`[scrape] ${d}`); captureOutput(d); });
  child.on('error', err => {
    console.error('Scrape konnte nicht gestartet werden:', err.message);
    scrapeState = { ...scrapeState, running: false, done: true, exitCode: -1, error: err.message };
  });
  child.on('close', code => {
    console.log(`Scrape beendet (exit ${code}) — Reindex …`);
    scrapeState = { ...scrapeState, running: false, done: true, exitCode: code };
    // Auch bei Teil-Fehler (exit 1) reindexen: bereits gespeicherte Artikel aufnehmen.
    if (!reindexState.running) buildIndex().catch(console.error);
  });

  res.json({ started: true, sources: scrapeState.sources });
});

// Letzte 100 Zeilen des Scraper-Logs (für die "Scrape-Log anzeigen"-Ansicht).
app.get('/api/scrape/log', requireAdmin, (_req, res) => {
  const logPath = path.join(__dirname, 'scraper', 'scrape_all.log');
  try {
    const stat = fs.statSync(logPath);
    const start = Math.max(0, stat.size - 256 * 1024);  // nur den Tail lesen (Log rotiert nicht)
    const buf = Buffer.alloc(stat.size - start);
    const fd = fs.openSync(logPath, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const text = buf.toString('utf8').split(/\r?\n/).slice(-100).join('\n');
    res.json({ text });
  } catch {
    res.json({ text: '(keine Logdatei gefunden)' });
  }
});

app.get('/api/articles', attachUser, (req, res) => {
  const { q, author, year, category, page = '1', limit = '24', telegram } = req.query;
  const user = req.user;
  let filtered = articles;

  // ACL pre-filter: restrict to allowed authors
  if (user.allowedAuthors !== null) {
    filtered = filtered.filter(a => user.allowedAuthors.includes(a.author));
  }

  // "Telegram"-Artikel standardmäßig ausblenden; einbeziehen bei telegram=1
  // oder wenn explizit nach Autor "Telegram" gefiltert wird.
  if (telegram !== '1' && author !== 'Telegram') {
    filtered = filtered.filter(a => a.author !== 'Telegram');
  }

  if (author) {
    if (!canAccessAuthor(user, author)) {
      return res.json({ total: 0, page: 1, limit: 24, pages: 0, items: [] });
    }
    filtered = filtered.filter(a => a.author === author);
  }
  if (year)     filtered = filtered.filter(a => a.year === year);
  if (category) filtered = filtered.filter(a => a.categories.includes(category));

  if (q) {
    // Query in Tokens zerlegen: Datums-Tokens → Datumsfilter, Rest → Fuse-Text.
    // So sind Text-Suche und Datumseingrenzung kombinierbar ("Achtsamkeit 2025").
    const tokens = q.trim().split(/\s+/);
    const dateConstraints = [];
    const textTokens = [];
    for (const t of tokens) {
      const dq = parseDateQuery(t);
      if (dq) dateConstraints.push(dq);
      else textTokens.push(t);
    }
    // Datums-Tokens als Filter anwenden (AND)
    for (const dq of dateConstraints) {
      filtered = dq.kind === 'exact'
        ? filtered.filter(a => a.date === dq.value)
        : filtered.filter(a => a.date && a.date.startsWith(dq.value));
    }
    // Restlicher Text über Fuse, auf die datums-gefilterte Teilmenge eingeschränkt
    const text = textTokens.join(' ').trim();
    if (text && fuseIndex) {
      const filteredIds = new Set(filtered.map(a => a.id));
      const results = fuseIndex.search(text, { limit: 2000 });
      filtered = results.filter(r => filteredIds.has(r.item.id)).map(r => r.item);
    }
  }

  const total = filtered.length;
  const p = Math.max(1, parseInt(page));
  const lim = Math.min(100, Math.max(1, parseInt(limit)));
  const items = filtered.slice((p - 1) * lim, p * lim).map(({ filePath, ...rest }) => rest);

  res.json({ total, page: p, limit: lim, pages: Math.ceil(total / lim), items });
});

app.get('/api/articles/*', attachUser, (req, res) => {
  const id = req.params[0];
  const article = articles.find(a => a.id === id);
  if (!article) return res.status(404).json({ error: 'Not found' });

  if (!canAccessAuthor(req.user, article.author)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const content = fs.readFileSync(article.filePath, 'utf8');
    const parsed = parseArticle(content, article.filePath);
    const bodyHtml = marked.parse(parsed.body);
    const { filePath, ...rest } = article;
    res.json({ ...rest, bodyHtml, canUploadInfographic: canUploadInfographic(req.user, article) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────

app.use((err, _req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Die Bilddatei ist größer als 10 MB.' });
  }
  next(err);
});

// Reindex ohne Neustart: SIGHUP löst einen Index-Neuaufbau aus – der Prozess
// läuft weiter, bestehende Sessions bleiben erhalten. Aus Cron als derselbe
// User (ralf) ohne sudo aufrufbar:
//   kill -HUP "$(systemctl show -p MainPID --value nodeapp)"
process.on('SIGHUP', () => {
  console.log('SIGHUP empfangen → Reindex');
  if (!reindexState.running) buildIndex().catch(console.error);
});

buildIndex().catch(console.error);
app.listen(PORT, () => {
  console.log(`WebArchiv → http://localhost:${PORT}`);
});
