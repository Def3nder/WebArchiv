const express = require('express');
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const Fuse = require('fuse.js');
const session = require('express-session');
const sharp   = require('sharp');
const { spawn } = require('child_process');
const { createTtsJobs, installTtsRoutes } = require('./tts/jobs.cjs');
const { createMarkdownEditor, installMarkdownRoutes } = require('./article-editor.cjs');
const { createUserStore, installUserRoutes } = require('./user-store.cjs');
const {
  AUDIOBOOK_AUTHOR, createAudiobookLibrary, createProgressStore, loadAudiobookConfig, installAudiobookRoutes,
} = require('./audiobooks.cjs');

const app = express();
// Hinter dem Reverse-Proxy (Caddy/HTTPS) X-Forwarded-Proto/Host respektieren,
// damit absolute og:*-URLs (Link-Vorschau) korrekt https:// und Host tragen.
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;
const WWW_DIR = path.join(__dirname, 'www');
const AUDIO_DIR = path.join(__dirname, 'audio');
const INFOGRAPHICS_AUTHOR = 'Infografiken';
const INFOGRAPHIC_MAX_BYTES = 10 * 1024 * 1024;

// ─── Users ─────────────────────────────────────────────────────────────────

// Nutzer (users.json) und öffentliche Autoren (public-directories.txt) werden
// über die Benutzerverwaltung gepflegt und zur Laufzeit geschrieben.
const userStore = createUserStore({
  usersFile: process.env.USERS_FILE || path.join(__dirname, 'users.json'),
  publicFile: process.env.PUBLIC_DIRS_FILE || path.join(__dirname, 'public-directories.txt'),
  // Hörbücher sind nie öffentlich, auch nicht per public-directories.txt.
  privateAuthors: [AUDIOBOOK_AUTHOR],
});
userStore.load();
console.log(`Public-Autoren: ${userStore.publicAuthors.length ? userStore.publicAuthors.join(', ') : '(keine)'}`);

let articles = [];
let articleById = new Map();
// Infografik-Gruppen (siehe linkInfographics): Anker-ID → Mitglieder, Mitglied → Anker-ID.
let infographicGroups = new Map();
let groupAnchorOf = new Map();
let meta = { authors: [], years: [], categories: [] };
let fuseIndex = null;
let reindexState = { running: false, processed: 0, articles: 0, done: true };
let scrapeState = { running: false, sources: null, exitCode: null, startedAt: null, done: true, error: null };
let infographicWrites = 0;

// Hörbücher: je ein Ordner unter audio/Hoerbuecher/ (oder audio/Hörbücher/), eigener Index neben den Artikeln.
const audiobookConfig = loadAudiobookConfig(path.join(__dirname, 'config.json'));
const audiobookProgress = createProgressStore({
  file: process.env.AUDIOBOOK_PROGRESS_FILE || path.join(__dirname, 'audiobook-progress.json'),
});
audiobookProgress.load();
const audiobooks = createAudiobookLibrary({
  audioRoot: AUDIO_DIR,
  directory: audiobookConfig.directory,
  excerpt: text => bodyExcerpt(text || ''),
  renderMarkdown: text => marked.parse(text),
  progress: audiobookProgress,
});

const markdownEditor = createMarkdownEditor({
  // Artikel liegen unter www/, die abstract.md der Hörbücher unter audio/.
  root: [WWW_DIR, AUDIO_DIR],
  getArticle: id => articles.find(a => a.id === id) || audiobooks.get(id),
  canAccessAuthor,
  busy: () => reindexState.running || scrapeState.running || infographicWrites > 0 || ttsJobs.running,
  reindex: buildIndex,
});
const ttsJobs = createTtsJobs({
  root: WWW_DIR,
  audioRoot: AUDIO_DIR,
  getArticle: id => articles.find(a => a.id === id),
  canAccessAuthor,
  busy: () => reindexState.running || scrapeState.running || infographicWrites > 0 || markdownEditor.running,
  reindex: buildIndex,
  mediaUrl: filename => audioFileUrl(path.relative(AUDIO_DIR, filename).split(path.sep).map(encodeURIComponent).join('/'), filename),
});

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

const TAXONOMY_LABELS = new Set(TAXONOMY.map(bucket => bucket.label));

// Filter-Kategorien: ausdrücklich in „Kategorien:“ genannte Taxonomie-Labels
// zählen immer (zuerst), danach die automatisch erkannten; höchstens fünf.
function mergeCategories(tags, autoCategories) {
  const explicit = (tags || []).filter(tag => TAXONOMY_LABELS.has(tag));
  return [...new Set([...explicit, ...autoCategories])].slice(0, 5);
}

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

  return { title, date, sourceUrl, summary, tags, episodeNum, categories: [], body };
}

// ─── File scanner ──────────────────────────────────────────────────────────

function indexFilesByLowerName(entries) {
  const files = new Map();
  for (const entry of entries) {
    if (entry.isFile()) files.set(entry.name.toLowerCase(), entry.name);
  }
  return files;
}

function findSibling(dir, basename, exts, filesByLowerName = null) {
  // Schneller Normalfall: exakt gleichnamige Datei mit erwarteter Endung.
  for (const ext of exts) {
    const p = path.join(dir, basename + ext);
    if (fs.existsSync(p)) return p;
  }

  // Auf dem Debian-Zielsystem ist das Dateisystem case-sensitive. Medien sollen
  // trotzdem autorenunabhängig erkannt werden, wenn nur Groß-/Kleinschreibung
  // von Basisname oder Endung abweicht (z. B. Artikel.md + artikel.MP3).
  if (!filesByLowerName) {
    try {
      filesByLowerName = indexFilesByLowerName(
        fs.readdirSync(dir, { withFileTypes: true })
      );
    } catch {
      return null;
    }
  }

  for (const ext of exts) {
    const actualName = filesByLowerName.get((basename + ext).toLowerCase());
    if (actualName) return path.join(dir, actualName);
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

function audioFileUrl(relPath, absPath) {
  let v = '';
  try { v = '?v=' + Math.floor(fs.statSync(absPath).mtimeMs); } catch { /* Datei weg */ }
  return `/audio-files/${relPath}${v}`;
}

async function scanDir(dirPath, author, year, collector) {
  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  const filesByLowerName = indexFilesByLowerName(entries);

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

      const ownImgPath = findSibling(dirPath, basename, ['.jpg', '.jpeg', '.png'], filesByLowerName);
      const imgPath = ownImgPath
        || findSibling(path.join(WWW_DIR, author), 'standard', ['.jpg', '.jpeg', '.png']);
      const localAudioPath = findSibling(dirPath, basename, ['.mp3'], filesByLowerName);
      const externalAudioDir = path.join(AUDIO_DIR, author, relDir);
      const externalAudioPath = localAudioPath
        ? null
        : findSibling(externalAudioDir, basename, ['.mp3']);
      const audioPath = localAudioPath || externalAudioPath;
      const videoPath = findSibling(dirPath, basename, ['.mp4'], filesByLowerName);
      const pdfPath   = findSibling(dirPath, basename, ['.pdf'], filesByLowerName);

      const relImg   = imgPath   ? path.relative(WWW_DIR, imgPath).replace(/\\/g, '/')   : null;
      const relAudio = audioPath
        ? path.relative(localAudioPath ? WWW_DIR : AUDIO_DIR, audioPath).replace(/\\/g, '/')
        : null;
      const relVideo = videoPath ? path.relative(WWW_DIR, videoPath).replace(/\\/g, '/') : null;
      const relPdf   = pdfPath   ? path.relative(WWW_DIR, pdfPath).replace(/\\/g, '/')   : null;

      // categories = unified taxonomy labels (for filtering); tags = raw Kategorien field (display only)
      const searchText = parsed.title + ' ' + (parsed.summary || '') + ' ' + parsed.body;
      const tags = (parsed.tags || []).slice(0, 10);
      const categories = mergeCategories(tags, autoCategorize(searchText));

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
        // Lang genug, um in der Listenansicht auch auf breiten Bildschirmen drei volle Zeilen zu füllen.
        preview: bodyExcerpt(parsed.body, 1000),
        imageUrl: relImg   ? fileUrl(relImg, imgPath)     : null,
        audioUrl: relAudio
          ? (localAudioPath ? fileUrl(relAudio, audioPath) : audioFileUrl(relAudio, audioPath))
          : null,
        hasExternalAudio: !!externalAudioPath,
        videoUrl: relVideo ? fileUrl(relVideo, videoPath) : null,
        pdfUrl:   relPdf   ? fileUrl(relPdf, pdfPath)     : null,
        episodeNum: parsed.episodeNum,
        filePath: fullPath,
        // Intern (nicht in der API): eigenes Bild statt standard.jpg, eigener Text.
        ownImage: !!ownImgPath,
        hasBody: !!parsed.body.trim(),
      });
      reindexState.processed++;
    } catch (err) {
      // skip unparseable files silently
    }
  }
}

// Zuordnung Infografik → Artikel über Jahr + Dateistamm. Varianten heißen
// „<Stamm>_2“, „<Stamm>_3“ … Die Endung _N wird aber nur abgeschnitten, wenn es
// den verkürzten Stamm tatsächlich gibt – sonst gehört die Zahl zum Namen
// (Stefan Hiene: „…_Audioquickie_2961“).
function resolveInfographicStem(stem, hasArticle, hasInfographic) {
  if (hasArticle(stem)) return { baseStem: stem, ordinal: 1 };
  const m = stem.match(/^(.+)_(\d+)$/);
  if (m && (hasArticle(m[1]) || hasInfographic(m[1]))) return { baseStem: m[1], ordinal: parseInt(m[2], 10) };
  return { baseStem: stem, ordinal: 1 };
}

// Verknüpft Infografiken mit ihrem Originalartikel:
//  - Platzhalter-Infografiken (ohne eigenen Text) werden Mitglieder einer Gruppe,
//    deren Anker der Originalartikel ist – oder, ohne Artikel, die Basis-Infografik.
//  - Eine Basis-Infografik mit eigenem Text ist selbst ein Original; ihre Varianten
//    gehören zu ihr (deren doppelter Text wird nicht angezeigt).
//  - Mitglieder erben Kategorien/Tags des Ankers, Infografiken ohne eigenes Audio
//    das Audio der Basis-Infografik bzw. des Artikels (Zugriff bleibt beim Ursprung).
// Mehrdeutige Basis (gleicher Stamm bei mehreren Autoren): eindeutiger Kandidat mit
// Audio, sonst keine Zuordnung.
function linkInfographics(articleList) {
  const key = (year, stem) => `${year || ''}/${stem}`;
  const stemOf = article => path.basename(article.filePath, '.md');
  const candidatesByKey = new Map();
  const infographicsByKey = new Map();
  for (const article of articleList) {
    const k = key(article.year, stemOf(article));
    if (article.author === INFOGRAPHICS_AUTHOR) infographicsByKey.set(k, article);
    else candidatesByKey.set(k, [...(candidatesByKey.get(k) || []), article]);
  }
  const baseArticleFor = k => {
    const candidates = candidatesByKey.get(k) || [];
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
    const k = key(info.year, info.infographicBase);
    const baseArticle = baseArticleFor(k);
    const baseInfo = infographicsByKey.get(k);
    const isBase = baseInfo === info;
    let anchor = null;
    if (isBase) {
      if (!info.hasBody && baseArticle) anchor = baseArticle;
    } else if (baseInfo?.hasBody) {
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

// Nur interne Felder entfernen und geerbtes Audio ohne Recht am Ursprung verbergen.
function exposeArticleForUser(article, user) {
  const {
    filePath, inheritedAudioAuthor, inheritedAudioArticleId,
    ownImage, hasBody, infographicBase, infographicOrdinal, ...rest
  } = article;
  if (inheritedAudioAuthor && !canAccessAuthor(user, inheritedAudioAuthor)) {
    return { ...rest, audioUrl: null, hasExternalAudio: false, episodeNum: null };
  }
  return rest;
}

// Anker der Gruppe, zu der eine Infografik gehört – nur wenn der Nutzer ihn sehen
// darf. Sonst (z. B. Gast ohne Recht am Artikel) bleibt die Infografik einzeln.
function visibleGroupAnchor(article, user, { hideTelegram = false } = {}) {
  const anchor = articleById.get(groupAnchorOf.get(article?.id));
  if (!anchor || !canAccessAuthor(user, anchor.author)) return null;
  if (hideTelegram && anchor.author === 'Telegram') return null;
  return anchor;
}

// Bilder einer Gruppe: eigenes Artikelfoto (kein standard.jpg), dann die
// Infografiken in Reihenfolge. null, wenn der Nutzer keine Grafik der Gruppe sieht.
function groupImagesFor(anchor, user) {
  const members = (infographicGroups.get(anchor.id) || [])
    .filter(member => member.ownImage && canAccessAuthor(user, member.author));
  if (!members.length) return null;
  const images = anchor.ownImage
    ? [{ id: anchor.id, url: anchor.imageUrl, kind: anchor.author === INFOGRAPHICS_AUTHOR ? 'infographic' : 'photo' }]
    : [];
  for (const member of members) images.push({ id: member.id, url: member.imageUrl, kind: 'infographic' });
  return images;
}

function exposeGroupForUser(anchor, user) {
  const exposed = exposeArticleForUser(anchor, user);
  const images = groupImagesFor(anchor, user);
  return images ? { ...exposed, imageUrl: images[0].url, images } : exposed;
}

async function buildIndex() {
  try { await rebuildIndex(); }
  catch (error) {
    reindexState = { ...reindexState, running: false, done: true, error: error.message };
    throw error;
  }
}

async function rebuildIndex() {
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
    throw err;
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

  ({ groups: infographicGroups, anchorOf: groupAnchorOf } = linkInfographics(articles));
  articleById = new Map(articles.map(article => [article.id, article]));
  await audiobooks.rebuild();

  const isInfografik = a => (a.author === 'Infografiken' ? 1 : 0);
  articles.sort((a, b) =>
    (b.date || '').localeCompare(a.date || '') ||
    (a.title || '').localeCompare(b.title || '', 'de', { sensitivity: 'base' }) ||
    isInfografik(a) - isInfografik(b)
  );

  const authorsSet = new Set(articles.map(a => a.author));
  if (audiobooks.books.length) authorsSet.add(AUDIOBOOK_AUTHOR);
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
  console.log(`✓ ${articles.length} articles, ${audiobooks.books.length} Hörbücher indexed in ${Date.now() - t0}ms`);
}

// ─── Auth helpers ──────────────────────────────────────────────────────────

function canAccessAuthor(sessionUser, author) {
  if (!sessionUser) return false;
  if (author === AUDIOBOOK_AUTHOR && sessionUser.role === 'guest') return false;
  if (sessionUser.allowedAuthors === null) return true;
  return sessionUser.allowedAuthors.includes(author);
}

function canUploadInfographic(sessionUser, article) {
  return !!(
    sessionUser?.role === 'admin' &&
    article &&
    canAccessAuthor(sessionUser, article.author) &&
    article.author !== INFOGRAPHICS_AUTHOR
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
  return { email: null, role: 'guest', allowedAuthors: userStore.publicAuthors };
}

// Soft auth: attaches req.user (session user or anonymous guest with public-author whitelist).
// Returns 401 only when no session AND no public authors are configured.
function attachUser(req, res, next) {
  req.user = getEffectiveUser(req);
  if (req.user.role === 'guest' && userStore.publicAuthors.length === 0) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// ─── API ───────────────────────────────────────────────────────────────────

app.use('/api/article-markdown', express.json({ limit: '2mb' }));
// Neue Infografik: Bild base64 in JSON (bis 10 MB Bild → ~14 MB JSON).
app.use('/api/new-infographic', express.json({ limit: Math.ceil(INFOGRAPHIC_MAX_BYTES * 1.4) + 2 * 1024 * 1024 }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'webarchiv-dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' },
}));
// Session-Nutzer bei jeder Anfrage frisch aus dem Nutzerbestand auflösen: geänderte
// Rechte wirken sofort; gelöschte Nutzer oder neu vergebene Kennwörter beenden Sitzungen.
app.use((req, res, next) => {
  if (req.session?.user) {
    const fresh = userStore.sessionUser(req.session.user);
    if (fresh) req.session.user = fresh;
    else delete req.session.user;
  }
  next();
});

// Solange eine Kennwortänderung aussteht, sind nur Anmelde-/Kennwortrouten erlaubt.
const PASSWORD_PENDING_ALLOWED = new Set(['/api/me', '/api/me/password', '/api/login', '/api/logout']);
app.use((req, res, next) => {
  if (!req.session?.user?.mustChangePassword || PASSWORD_PENDING_ALLOWED.has(req.path)) return next();
  if (/^\/(api|files|audio-files)\//.test(req.path)) {
    return res.status(403).json({ error: 'Bitte zuerst ein neues Kennwort festlegen.', mustChangePassword: true });
  }
  next();
});
// index.html immer beim Server nachfragen (sonst hält v. a. Safari eine alte Seite
// mit alten ?v=-Verweisen); JS/CSS werden über ?v= in index.html aktualisiert.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// ─── Auth routes (public) ──────────────────────────────────────────────────

function meView(user) {
  const { sessionVersion, ...view } = user;
  return view;
}

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(meView(getEffectiveUser(req)));
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const auth = await userStore.authenticate(email, password);
  if (!auth) {
    return res.status(401).json({ error: 'Ungültige E-Mail oder Passwort' });
  }
  // Neue Session-ID nach der Anmeldung (Schutz vor Session-Fixation).
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Anmeldung fehlgeschlagen.' });
    req.session.user = userStore.sessionUser(auth);
    res.json(meView(req.session.user));
  });
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

app.get('/audio-files/*', attachUser, (req, res) => {
  const relPath = req.params[0];
  // Das Hörbuch-Verzeichnis (z. B. „Hoerbuecher“) gehört zum Autor „Hörbücher“.
  const topDir  = relPath.split('/')[0];
  const author  = topDir === audiobooks.directory ? AUDIOBOOK_AUTHOR : topDir;
  if (!canAccessAuthor(req.user, author)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const absPath = path.resolve(path.join(AUDIO_DIR, relPath));
  if (!absPath.startsWith(AUDIO_DIR + path.sep)) {
    return res.status(403).end();
  }
  // Hörbuch-Tracks (.m4b/.m4a) kennt die MIME-Tabelle nicht; Browser brauchen audio/mp4.
  if (/\.m4[ab]$/i.test(absPath)) res.type('audio/mp4');
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
    <meta http-equiv="refresh" content="0; url=${escapeHtml(target)}" />
    <link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />${tags}
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
  if (ttsJobs.running || scrapeState.running || infographicWrites || markdownEditor.running) return res.status(409).json({ started: false, error: 'Es läuft bereits ein Audio-, Scrape- oder Speicherauftrag.' });
  if (reindexState.running) return res.json({ started: false, reason: 'already running' });
  buildIndex().catch(console.error);
  res.json({ started: true });
});

app.post(
  '/api/infographics/*',
  requireAdmin,
  express.raw({ type: ['image/png', 'image/jpeg'], limit: INFOGRAPHIC_MAX_BYTES }),
  async (req, res) => {
    if (ttsJobs.running || markdownEditor.running) return res.status(409).json({ error: 'Es läuft bereits ein Audio- oder Speicherauftrag.' });
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

    infographicWrites++;
    try {
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
    } finally { infographicWrites--; }
  }
);

// ─── Neue eigenständige Infografik (Admin, Aktionen-Menü) ───────────────────
//
// Markdown + Bild in einer Anfrage (Bild base64 in JSON, keine Zusatz-Abhängigkeit).
// Dateiname: <Datum>_<Slug aus dem Titel>; Konflikt → -2, -3 … (nicht _2, das
// bedeutet „Variante“). Unveränderte Platzhalter der Vorlage werden entfernt.

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

app.post('/api/new-infographic', requireAdmin, async (req, res) => {
  if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Speichern ist nur aus dem Archiv erlaubt.' });
  if (reindexState.running || scrapeState.running || ttsJobs.running || markdownEditor.running || infographicWrites) {
    return res.status(409).json({ error: 'Es läuft bereits ein Reindex-, Scrape-, Audio- oder Speicherauftrag. Bitte gleich erneut speichern.' });
  }
  const categories = Array.isArray(req.body?.categories) ? req.body.categories.map(String) : [];
  const markdown = normalizeNewInfographicMarkdown(req.body?.markdown, categories);
  const header = validateInfographicHeader(markdown);
  const title = parseArticle(markdown, 'neu.md').title;
  if (!header.hasTitle || /\[titel\]/i.test(title)) return res.status(400).json({ error: 'Bitte in der ersten Zeile einen Titel eintragen.' });
  if (!header.date) return res.status(400).json({ error: 'Die Datum-Zeile fehlt oder ist ungültig (JJJJ-MM-TT).' });
  const slug = slugify(title);
  if (!slug) return res.status(400).json({ error: 'Aus dem Titel lässt sich kein Dateiname ableiten.' });

  const image = Buffer.from(String(req.body?.image || ''), 'base64');
  if (!image.length) return res.status(400).json({ error: 'Bitte eine Grafik auswählen.' });
  if (image.length > INFOGRAPHIC_MAX_BYTES) return res.status(413).json({ error: 'Die Bilddatei ist größer als 10 MB.' });
  const imageExt = detectImageType(image);
  if (!imageExt) return res.status(415).json({ error: 'Nur PNG- und JPG-Bilder sind erlaubt.' });

  const year = header.date.slice(0, 4);
  const dir = resolveUnder(WWW_DIR, INFOGRAPHICS_AUTHOR, year);
  if (!dir) return res.status(400).json({ error: 'Kein gültiger Zielordner.' });
  const baseStem = `${header.date}_${slug}`;
  let stem = baseStem;
  for (let n = 2; infographicStemExists(dir, stem); n++) stem = `${baseStem}-${n}`;
  const mdPath = path.join(dir, stem + '.md');
  const imagePath = path.join(dir, stem + imageExt);

  infographicWrites++;
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(mdPath, markdown, { flag: 'wx' });
    try {
      await fs.promises.writeFile(imagePath, image, { flag: 'wx' });
    } catch (err) {
      await fs.promises.unlink(mdPath).catch(() => {});
      throw err;
    }
    await buildIndex();
    res.json({ ok: true, id: [INFOGRAPHICS_AUTHOR, year, stem].join('/') });
  } catch (err) {
    if (err.code === 'EEXIST') return res.status(409).json({ error: 'Eine Datei mit diesem Namen existiert bereits. Bitte erneut speichern.' });
    res.status(500).json({ error: err.message || 'Infografik konnte nicht gespeichert werden.' });
  } finally { infographicWrites--; }
});

// ─── Scrape (Admin): externen Scraper starten, danach automatisch reindexen ──
//
// Startet scraper/scrape_all.js als eigenen Node-Prozess (self-contained mit
// eigenen node_modules; playwright bleibt aus den App-Abhängigkeiten heraus).
// Läuft im Hintergrund; der Fortschritt wird über /api/scrape/status gepollt.

app.get('/api/scrape/status', requireAuth, (_req, res) => res.json(scrapeState));

app.post('/api/scrape', requireAdmin, (req, res) => {
  if (ttsJobs.running || infographicWrites || markdownEditor.running) return res.status(409).json({ started: false, error: 'Es läuft bereits ein Audio- oder Speicherauftrag.' });
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
  const { q, author, year, category, page = '1', limit = '24', telegram, externalAudio } = req.query;
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
  if (externalAudio === '1') {
    filtered = filtered.filter(a =>
      a.hasExternalAudio &&
      (!a.inheritedAudioAuthor || canAccessAuthor(user, a.inheritedAudioAuthor))
    );
  }

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

  const p = Math.max(1, parseInt(page));
  const lim = Math.min(100, Math.max(1, parseInt(limit)));

  // Kachelansichten: Artikel und ihre Infografiken als eine Kachel. Eine Gruppe
  // erscheint an der ersten Stelle, an der der Anker oder eine Grafik passt.
  // Nicht für die Liste und nicht beim Autorenfilter „Infografiken“.
  if (req.query.group === '1' && author !== INFOGRAPHICS_AUTHOR) {
    const hideTelegram = telegram !== '1' && author !== 'Telegram';
    const tiles = [];
    const seen = new Set();
    let total = 0;
    for (const article of filtered) {
      const tile = visibleGroupAnchor(article, user, { hideTelegram }) || article;
      if (seen.has(tile.id)) continue;
      seen.add(tile.id);
      const images = groupImagesFor(tile, user);
      total += 1 + (images ? images.length - (tile.ownImage ? 1 : 0) : 0);
      tiles.push(tile);
    }
    const items = tiles.slice((p - 1) * lim, p * lim).map(tile => exposeGroupForUser(tile, user));
    return res.json({ total, page: p, limit: lim, pages: Math.ceil(tiles.length / lim), items });
  }

  const total = filtered.length;
  const items = filtered.slice((p - 1) * lim, p * lim).map(article => exposeArticleForUser(article, user));

  res.json({ total, page: p, limit: lim, pages: Math.ceil(total / lim), items });
});

app.get('/api/articles/*', attachUser, (req, res) => {
  const id = req.params[0];
  const requested = articleById.get(id);
  if (!requested) return res.status(404).json({ error: 'Not found' });

  if (!canAccessAuthor(req.user, requested.author)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  // Eine gruppierte Infografik öffnet ihre Gruppe; requestedId sagt, welches Bild gemeint war.
  const anchor = visibleGroupAnchor(requested, req.user);
  const article = anchor || requested;

  try {
    const content = fs.readFileSync(article.filePath, 'utf8');
    const parsed = parseArticle(content, article.filePath);
    const bodyHtml = marked.parse(parsed.body);
    const rest = exposeGroupForUser(article, req.user);
    res.json({
      ...rest, bodyHtml, canUploadInfographic: canUploadInfographic(req.user, article),
      ...(anchor ? { requestedId: id } : {}),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────

installTtsRoutes(app, requireAdmin, ttsJobs);
installMarkdownRoutes(app, requireAdmin, markdownEditor);
installUserRoutes(app, {
  store: userStore, requireAuth, requireAdmin, getAuthors: () => meta.authors,
  onUserDeleted: email => audiobookProgress.removeUser(email),
});
installAudiobookRoutes(app, {
  library: audiobooks, progress: audiobookProgress, config: audiobookConfig, requireAuth, canAccessAuthor,
});

app.use((err, _req, res, next) => {
  if (_req.path.startsWith('/api/article-markdown/')) {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Die Anfrage ist zu groß. Artikel dürfen höchstens 1 MB enthalten.' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ungültige Speicheranfrage.' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Die Bilddatei ist größer als 10 MB.' });
  }
  next(err);
});

if (require.main === module) {
  // Reindex ohne Neustart: SIGHUP löst einen Index-Neuaufbau aus – der Prozess
  // läuft weiter, bestehende Sessions bleiben erhalten. Aus Cron als derselbe
  // User (ralf) ohne sudo aufrufbar:
  //   kill -HUP "$(systemctl show -p MainPID --value nodeapp)"
  process.on('SIGHUP', () => {
    console.log('SIGHUP empfangen → Reindex');
    if (!reindexState.running && !scrapeState.running && !ttsJobs.running && !infographicWrites && !markdownEditor.running) buildIndex().catch(console.error);
  });

  buildIndex().catch(console.error);
  const server = app.listen(PORT, () => {
    console.log(`WebArchiv → http://localhost:${PORT}`);
  });

  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    await ttsJobs.shutdown();
    process.exit(0);
  });
}

module.exports = { parseArticle, linkInfographics, buildInfographicMarkdown, removeCategoryLines, slugify, normalizeNewInfographicMarkdown, mergeCategories };
