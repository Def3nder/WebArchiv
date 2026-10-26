const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { renderSafeMarkdown, safeHttpUrl } = require('./html-sanitizer.cjs');
const Fuse = require('fuse.js');
const session = require('express-session');
const sharp   = require('sharp');
const { spawn } = require('child_process');
const { createTtsJobs, installTtsRoutes } = require('./tts/jobs.cjs');
const { createTtsVoiceSettings, MAX_AUDIO_BYTES: TTS_VOICE_MAX_BYTES } = require('./tts/voice-settings.cjs');
const { createMarkdownEditor, installMarkdownRoutes } = require('./article-editor.cjs');
const { createUserStore, installUserRoutes } = require('./user-store.cjs');
const {
  AUDIOBOOK_AUTHOR, createAudiobookLibrary, createProgressStore, loadAudiobookConfig, installAudiobookRoutes,
} = require('./audiobooks.cjs');
const { createBookmarkStore, installBookmarkRoutes } = require('./bookmarks.cjs');
const { isPathInside, installMediaRoutes } = require('./media-files.cjs');
const { createLoginLimiter, tooManyAttemptsError } = require('./login-limiter.cjs');
const { createSecurityHeaders, installCspReportRoute, REPORT_PATH: CSP_REPORT_PATH } = require('./security-headers.cjs');

// Kommagetrennte Adressen/Subnetze bzw. Express-Schlüsselwörter (loopback,
// linklocal, uniquelocal). „true“ wird bewusst nicht unterstützt.
function parseTrustProxy(value) {
  const entries = String(value || TRUST_PROXY_DEFAULT).split(',').map(entry => entry.trim()).filter(Boolean);
  if (entries.some(entry => /^(true|\*)$/i.test(entry))) {
    throw new Error('TRUST_PROXY darf nicht „true“ sein; bitte die Adresse des Reverse Proxys angeben.');
  }
  return entries;
}

// In Produktion ist ein eigenes, ausreichend langes Secret Pflicht. Ohne Secret
// würde jeder, der den öffentlichen Entwicklungswert kennt, Sitzungscookies
// fälschen können. Skripte und Tests, die server.js nur laden, laufen weiter
// (strict = false) und erhalten ein zufälliges Secret.
const LEGACY_DEV_SECRET = 'webarchiv-dev-secret-change-in-prod';
const MIN_SESSION_SECRET_LENGTH = 32;

function resolveSessionSecret({ env = process.env, strict = false, log = console } = {}) {
  const secret = env.SESSION_SECRET || '';
  const usable = secret.length >= MIN_SESSION_SECRET_LENGTH && secret !== LEGACY_DEV_SECRET;
  if (usable) return secret;
  const problem = secret
    ? `SESSION_SECRET ist zu kurz oder unsicher (mindestens ${MIN_SESSION_SECRET_LENGTH} Zeichen, z. B. „openssl rand -hex 32“).`
    : 'SESSION_SECRET ist nicht gesetzt.';
  if (strict && env.NODE_ENV === 'production') throw new Error(problem);
  log.warn(`${problem} Es wird ein zufälliges Secret verwendet; Anmeldungen enden beim Neustart.`);
  return crypto.randomBytes(32).toString('hex');
}
const {
  loadDuplicateConfig, buildDuplicateProfile, detectDuplicateCandidates,
  createDuplicateStore, decisionStillApplies,
} = require('./duplicates.cjs');

const app = express();
// Hinter dem Reverse-Proxy (NPMplus/HTTPS) X-Forwarded-Proto/Host/For nur von
// bekannten Proxy-Adressen übernehmen. Sonst könnte jeder Client über einen
// gefälschten X-Forwarded-For-Header die Login-Begrenzung pro IP umgehen.
const TRUST_PROXY_DEFAULT = 'loopback, 192.168.1.14';
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');
const WWW_DIR = path.join(__dirname, 'www');
const AUDIO_DIR = path.join(__dirname, 'audio');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const INFOGRAPHICS_AUTHOR = 'Infografiken';
const INFOGRAPHIC_TRASH_DIR = path.join(WWW_DIR, INFOGRAPHICS_AUTHOR, 'trash');
const INFOGRAPHIC_MAX_BYTES = 10 * 1024 * 1024;
const PWA_SHELL_EXTENSIONS = new Set(['.css', '.html', '.ico', '.js', '.json', '.png', '.svg']);
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ADMIN_ASSET_PATHS = new Set([
  '/user-admin.js',
  '/tts-settings.js',
  '/duplicates.js',
  '/infographic-new.js',
  '/infographic-manager.js',
  '/article-editor.js',
  '/audiobook-extras-manager.js',
  '/markdown-editors.js',
  '/duplicate-diff.js',
  '/vendor/duplicate-diff.bundle.js',
  '/vendor/article-editor.bundle.js',
]);

function computeAppShellVersion(publicDir = PUBLIC_DIR) {
  const hash = crypto.createHash('sha256');
  const files = fs.readdirSync(publicDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && PWA_SHELL_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'));

  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(publicDir, file)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

function serviceWorkerSource(version) {
  return `'use strict';
const APP_VERSION = ${JSON.stringify(version)};

self.addEventListener('install', () => {
  // Aktualisierte Worker warten, bis der Benutzer im Hinweis zustimmt.
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
`;
}

// ─── Users ─────────────────────────────────────────────────────────────────

// Nutzer, öffentliche Autoren und die davon unabhängige Autoren-Priorität werden
// über die Benutzerverwaltung gepflegt und zur Laufzeit geschrieben.
const userStore = createUserStore({
  usersFile: process.env.USERS_FILE || path.join(__dirname, 'users.json'),
  publicFile: process.env.PUBLIC_DIRS_FILE || path.join(__dirname, 'public-directories.txt'),
  settingsFile: CONFIG_FILE,
  // Hörbücher sind nie öffentlich, auch nicht per public-directories.txt.
  privateAuthors: [AUDIOBOOK_AUTHOR],
});
userStore.load();
console.log(`Public-Autoren: ${userStore.publicAuthors.length ? userStore.publicAuthors.join(', ') : '(keine)'}`);

let articles = [];
// Unverknüpfte Scan-Ergebnisse: linkInfographics verändert abgeleitete Felder.
// Für einen Teil-Neuindex müssen die übrigen Artikel aus diesem Stand neu verknüpft werden.
let sourceArticles = [];
let articleById = new Map();
// Infografik-Gruppen (siehe linkInfographics): Anker-ID → Mitglieder, Mitglied → Anker-ID.
let infographicGroups = new Map();
let groupAnchorOf = new Map();
let duplicateCanonicalOf = new Map();
let duplicateCandidates = [];
let meta = { authors: [], years: [], categories: [] };
let fuseIndex = null;
let reindexState = { running: false, processed: 0, articles: 0, done: true };
let scrapeState = { running: false, sources: null, exitCode: null, startedAt: null, done: true, error: null };
let infographicWrites = 0;
const SCRAPER_CHANGED_FILES_MARKER = '@@WEBARCHIV_CHANGED_FILES@@';

// Hörbücher: je ein Ordner unter audio/Hoerbuecher/ (oder audio/Hörbücher/), eigener Index neben den Artikeln.
const audiobookConfig = loadAudiobookConfig(CONFIG_FILE);
const audiobookProgress = createProgressStore({
  file: process.env.AUDIOBOOK_PROGRESS_FILE || path.join(__dirname, 'audiobook-progress.json'),
});
audiobookProgress.load();
// Lesezeichen pro Nutzer (nur angemeldet).
const bookmarks = createBookmarkStore({
  file: process.env.BOOKMARKS_FILE || path.join(__dirname, 'bookmarks.json'),
});
bookmarks.load();
const duplicateConfig = loadDuplicateConfig(CONFIG_FILE);
const duplicateStore = createDuplicateStore({
  file: process.env.DUPLICATES_FILE || path.join(__dirname, 'duplicate-decisions.json'),
});
duplicateStore.load();
const audiobooks = createAudiobookLibrary({
  audioRoot: AUDIO_DIR,
  directory: audiobookConfig.directory,
  excerpt: text => bodyExcerpt(text || ''),
  renderMarkdown: renderSafeMarkdown,
  progress: audiobookProgress,
});

const ttsVoiceSettings = createTtsVoiceSettings();

const markdownEditor = createMarkdownEditor({
  // Artikel liegen unter www/, die abstract.md der Hörbücher unter audio/.
  root: [WWW_DIR, AUDIO_DIR],
  getArticle: id => articles.find(a => a.id === id) || audiobooks.get(id),
  canAccessAuthor,
  busy: () => reindexState.running || scrapeState.running || infographicWrites > 0 || ttsJobs.running,
  reindex: refreshMarkdownIndex,
});
const ttsJobs = createTtsJobs({
  root: WWW_DIR,
  audioRoot: AUDIO_DIR,
  getArticle: id => articles.find(a => a.id === id),
  canAccessAuthor,
  busy: () => reindexState.running || scrapeState.running || infographicWrites > 0 || markdownEditor.running,
  reindex: refreshMarkdownIndex,
  selectedVoice: ttsVoiceSettings.selectedVoice,
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

async function scanDir(dirPath, author, year, collector, { strict = false, targetFile = null } = {}) {
  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (strict) throw error;
    return;
  }
  const filesByLowerName = indexFilesByLowerName(entries);
  const resolvedTarget = targetFile ? path.resolve(targetFile) : null;

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (resolvedTarget && !isPathInside(fullPath, resolvedTarget)) continue;
      // Gelöschte Infografiken bleiben als Dateien erhalten, gehören aber nie
      // wieder in den Artikelindex oder in eine Bildgruppe.
      if (author === INFOGRAPHICS_AUTHOR && fullPath === INFOGRAPHIC_TRASH_DIR) continue;
      const nextYear = /^\d{4}$/.test(entry.name) ? entry.name : year;
      await scanDir(fullPath, author, nextYear, collector, { strict, targetFile: resolvedTarget });
      continue;
    }
    if (!entry.name.endsWith('.md')) continue;
    if (resolvedTarget && path.resolve(fullPath) !== resolvedTarget) continue;

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
        instagramPoster: parsed.instagramPoster,
        filePath: fullPath,
        // Intern (nicht in der API): eigenes Bild statt standard.jpg, eigener Text.
        ownImage: !!ownImgPath,
        hasBody: !!parsed.body.trim(),
        duplicateProfile: (author === duplicateConfig.blogAuthor || duplicateConfig.facebookAuthors.includes(author))
          ? buildDuplicateProfile(parsed.title, parsed.body)
          : null,
      });
      reindexState.processed++;
    } catch (err) {
      if (resolvedTarget) throw err;
      // skip unparseable files silently
    }
  }
}

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

function buildArticleSearchIndex(articleList) {
  return new Fuse(articleList, {
    keys: [
      { name: 'title',      weight: 3 },
      { name: 'episodeNum', weight: 2 },
      { name: 'author',     weight: 1.5 },
      { name: 'categories', weight: 1 },
      { name: 'excerpt',    weight: 0.8 },
    ],
    threshold: 0.35,
    includeScore: true,
    ignoreLocation: true,
    minMatchCharLength: 2,
  });
}

function articleDisplayAuthor(article, linkedArticle = null) {
  if (article?.author !== INFOGRAPHICS_AUTHOR) return article?.author || '';
  return linkedArticle?.author || INFOGRAPHICS_AUTHOR;
}

// Nur interne Felder entfernen und geerbtes Audio ohne Recht am Ursprung verbergen.
function exposeArticleForUser(article, user) {
  const {
    filePath, inheritedAudioAuthor, inheritedAudioArticleId,
    ownImage, hasBody, infographicBase, infographicOrdinal, duplicateProfile, ...rest
  } = article;
  const exposed = inheritedAudioAuthor && !canAccessAuthor(user, inheritedAudioAuthor)
    ? { ...rest, audioUrl: null, hasExternalAudio: false, episodeNum: null }
    : rest;
  // Die echte Autorenzuordnung bleibt für ACL und Routing unverändert. Für die
  // Anzeige übernimmt jede verknüpfte Infografik jedoch den Autor ihres
  // sichtbaren Hauptartikels – auch wenn Telegram in der Liste ausgeblendet ist.
  if (article.author !== INFOGRAPHICS_AUTHOR) return exposed;
  return { ...exposed, displayAuthor: articleDisplayAuthor(article, visibleGroupAnchor(article, user)) };
}

function refreshDuplicateState() {
  const nextCanonical = new Map();
  for (const decision of duplicateStore.all()) {
    if (decision.status !== 'linked') continue;
    const blog = articleById.get(decision.blogId);
    const facebook = articleById.get(decision.facebookId);
    if (!blog || !facebook) continue;
    if (blog.author !== duplicateConfig.blogAuthor || !duplicateConfig.facebookAuthors.includes(facebook.author)) continue;
    nextCanonical.set(facebook.id, blog.id);
  }
  duplicateCanonicalOf = nextCanonical;
  duplicateCandidates = detectDuplicateCandidates(articles, duplicateConfig).filter(candidate => {
    if (duplicateCanonicalOf.has(candidate.facebook.id)) return false;
    const decision = duplicateStore.find(candidate.blog.id, candidate.facebook.id);
    return !decisionStillApplies(decision, candidate.blog, candidate.facebook);
  });
}

function duplicateCanonicalFor(article, user = null) {
  const canonical = articleById.get(duplicateCanonicalOf.get(article?.id));
  if (!canonical) return null;
  if (user && !canAccessAuthor(user, canonical.author)) return null;
  return canonical;
}

// Anker der Gruppe, zu der eine Infografik gehört – nur wenn der Nutzer ihn sehen
// darf. Sonst (z. B. Gast ohne Recht am Artikel) bleibt die Infografik einzeln.
function visibleGroupAnchor(article, user, { hideTelegram = false } = {}) {
  const anchor = articleById.get(groupAnchorOf.get(article?.id));
  if (!anchor || !canAccessAuthor(user, anchor.author)) return null;
  if (hideTelegram && anchor.author === 'Telegram') return null;
  return anchor;
}

// Eine Infografik-Kachel öffnet ihren Anker (auch einen ausgeblendeten Telegram-Artikel);
// dessen Lesezeichen gilt deshalb auch für die Kachel.
function isBookmarkedTile(item, user, marks) {
  return marks.has(item.id) || marks.has(visibleGroupAnchor(item, user)?.id);
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

function uniqueArticles(articleList) {
  const seen = new Set();
  return articleList.filter(article => {
    if (seen.has(article.id)) return false;
    seen.add(article.id);
    return true;
  });
}

function replaceInfographicYearArticles(articleList, year, scanned) {
  const folderPrefix = `${INFOGRAPHICS_AUTHOR}/${year}/`;
  return uniqueArticles([
    ...articleList.filter(article => !article.id.startsWith(folderPrefix)),
    ...scanned,
  ]);
}

function prepareLinkedArticles(nextSourceArticles, authorPriority) {
  // Gruppen, Kategorien und Audio-Vererbung nur auf Kopien berechnen; die
  // unverknüpften Scan-Ergebnisse bleiben für spätere Teil-Neuindizes sauber.
  const nextArticles = nextSourceArticles.map(article => ({
    ...article,
    categories: [...article.categories],
    tags: [...article.tags],
  }));
  const { groups, anchorOf } = linkInfographics(nextArticles, authorPriority);
  return { articles: nextArticles, groups, anchorOf };
}

function publishArticleIndex(nextSourceArticles) {
  const { articles: nextArticles, groups, anchorOf } = prepareLinkedArticles(nextSourceArticles, userStore.authorPriority);
  const nextById = new Map(nextArticles.map(article => [article.id, article]));
  const isInfografik = article => (article.author === INFOGRAPHICS_AUTHOR ? 1 : 0);
  nextArticles.sort((a, b) =>
    (b.date || '').localeCompare(a.date || '') ||
    (a.title || '').localeCompare(b.title || '', 'de', { sensitivity: 'base' }) ||
    isInfografik(a) - isInfografik(b)
  );

  const authorsSet = new Set(nextArticles.map(article => article.author));
  if (audiobooks.books.length) authorsSet.add(AUDIOBOOK_AUTHOR);
  const yearsSet = new Set(nextArticles.map(article => article.year).filter(Boolean));
  const catsSet = new Set(nextArticles.flatMap(article => article.categories));
  const nextMeta = {
    authors: [...authorsSet].sort(),
    years: [...yearsSet].sort().reverse(),
    categories: [...catsSet].filter(Boolean).sort((a, b) => a.localeCompare(b, 'de')),
  };
  const nextFuseIndex = buildArticleSearchIndex(nextArticles);

  sourceArticles = nextSourceArticles;
  articles = nextArticles;
  infographicGroups = groups;
  groupAnchorOf = anchorOf;
  articleById = nextById;
  meta = nextMeta;
  fuseIndex = nextFuseIndex;
  refreshDuplicateState();
}

function replaceArticleIndexEntry(articleList, id, replacement) {
  const index = articleList.findIndex(article => article.id === id);
  if (index < 0) throw new Error(`Artikel „${id}“ fehlt im Rohindex.`);
  if (!replacement || replacement.id !== id) throw new Error(`Artikel „${id}“ wurde unter einer unerwarteten ID eingelesen.`);
  const next = articleList.slice();
  next[index] = replacement;
  return next;
}

function upsertArticleIndexEntries(articleList, replacements) {
  const next = articleList.slice();
  const positions = new Map(next.map((article, index) => [article.id, index]));
  for (const replacement of replacements) {
    const index = positions.get(replacement.id);
    if (index === undefined) {
      positions.set(replacement.id, next.length);
      next.push(replacement);
    } else {
      next[index] = replacement;
    }
  }
  return uniqueArticles(next);
}

// Vom Scraper gemeldete Markdown-Dateien einzeln einlesen und anschließend
// gemeinsam veröffentlichen. Ein gültiges leeres Manifest bedeutet, dass der
// Scraper nichts geändert hat und gar kein Neuindex nötig ist.
async function refreshScrapedMarkdownFiles(filenames) {
  const uniqueFiles = [...new Set((filenames || []).map(filename => path.resolve(String(filename))))];
  if (!uniqueFiles.length) return;
  if (!sourceArticles.length) return buildIndex();

  const t0 = Date.now();
  reindexState = { running: true, processed: 0, articles: articles.length, done: false };
  try {
    const replacements = [];
    for (const filename of uniqueFiles) {
      if (path.extname(filename).toLowerCase() !== '.md' || !isPathInside(WWW_DIR, filename)) {
        throw new Error('Der Scraper hat einen ungültigen Artikelpfad gemeldet.');
      }
      const relative = path.relative(WWW_DIR, filename);
      const segments = relative.split(path.sep);
      const author = segments.shift();
      if (!author || !segments.length) throw new Error('Der Scraper-Artikel hat keinen gültigen Autorpfad.');
      const relativeDir = path.dirname(segments.join(path.sep));
      const year = relativeDir.split(path.sep).filter(segment => /^\d{4}$/.test(segment)).at(-1) || null;
      const scanned = [];
      await scanDir(path.dirname(filename), author, year, scanned, { strict: true, targetFile: filename });
      const replacement = scanned.find(article => path.resolve(article.filePath) === filename);
      if (!replacement) throw new Error(`Scraper-Artikel „${relative}“ konnte nicht eingelesen werden.`);
      replacements.push(replacement);
    }
    publishArticleIndex(upsertArticleIndexEntries(sourceArticles, replacements));
    reindexState = { running: false, processed: articles.length, articles: articles.length, done: true };
    console.log(`✓ ${replacements.length} Scraper-Artikel gezielt neu eingelesen (${Date.now() - t0}ms)`);
  } catch (error) {
    reindexState = { ...reindexState, running: false, done: true, error: error.message };
    throw error;
  }
}

async function republishArticleIndex() {
  if (!sourceArticles.length) return buildIndex();
  const t0 = Date.now();
  publishArticleIndex(sourceArticles);
  console.log(`✓ Artikelverknüpfungen aus dem Speicher aktualisiert (${Date.now() - t0}ms)`);
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

function parseScraperChangedFiles(output) {
  const markerLine = String(output || '').split(/\r?\n/)
    .findLast(line => line.startsWith(SCRAPER_CHANGED_FILES_MARKER));
  if (!markerLine) return null;
  try {
    const parsed = JSON.parse(markerLine.slice(SCRAPER_CHANGED_FILES_MARKER.length));
    return Array.isArray(parsed) && parsed.every(filename => typeof filename === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

// Nach einer Editor-Änderung nur die betroffene Markdown-Datei erneut von der
// Platte lesen. Verknüpfungen, Metadaten, Suche und Duplikatstatus werden danach
// aus dem vorhandenen Rohindex im Speicher neu abgeleitet; andere Dateien und
// die Hörbuchbibliothek werden nicht erneut gescannt.
async function refreshMarkdownIndex({ id, filename } = {}) {
  if (!id || !filename) return buildIndex();

  const t0 = Date.now();
  reindexState = { running: true, processed: 0, articles: articles.length, done: false };
  try {
    if (isPathInside(AUDIO_DIR, filename)) {
      await audiobooks.refresh(id);
      reindexState = { running: false, processed: articles.length, articles: articles.length, done: true };
      console.log(`✓ Hörbuch „${id}“ gezielt aktualisiert (${Date.now() - t0}ms)`);
      return;
    }
    if (!isPathInside(WWW_DIR, filename)) throw new Error('Der bearbeitete Artikel liegt außerhalb des Archivs.');
    if (!sourceArticles.length) return buildIndex();

    const current = sourceArticles.find(article => article.id === id);
    if (!current) return buildIndex();
    if (path.resolve(current.filePath) !== path.resolve(filename)) {
      throw new Error(`Artikel „${id}“ verweist auf einen unerwarteten Dateipfad.`);
    }

    const authorRoot = path.join(WWW_DIR, current.author);
    const relativeDir = path.relative(authorRoot, path.dirname(filename));
    const year = relativeDir.split(path.sep).filter(segment => /^\d{4}$/.test(segment)).at(-1) || null;
    const scanned = [];
    await scanDir(path.dirname(filename), current.author, year, scanned, { strict: true, targetFile: filename });
    const replacement = scanned.find(article => article.id === id);
    publishArticleIndex(replaceArticleIndexEntry(sourceArticles, id, replacement));

    reindexState = { running: false, processed: articles.length, articles: articles.length, done: true };
    console.log(`✓ Artikel „${id}“ gezielt neu eingelesen (${Date.now() - t0}ms)`);
  } catch (error) {
    reindexState = { ...reindexState, running: false, done: true, error: error.message };
    throw error;
  }
}

async function refreshInfographicsForYears(years) {
  const uniqueYears = [...new Set(years)];
  if (!uniqueYears.length) return;
  if (uniqueYears.some(year => !/^\d{4}$/.test(year))) throw new Error('Ungültiges Infografik-Jahr.');
  if (!sourceArticles.length) return buildIndex();
  const t0 = Date.now();
  reindexState = { running: true, processed: 0, articles: 0, done: false };
  try {
    let nextSourceArticles = sourceArticles;
    let scannedCount = 0;
    for (const year of uniqueYears) {
      const yearDir = resolveUnder(WWW_DIR, INFOGRAPHICS_AUTHOR, year);
      const stat = await fs.promises.lstat(yearDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Infografik-Jahresverzeichnis ist ungültig.');
      const scanned = [];
      await scanDir(yearDir, INFOGRAPHICS_AUTHOR, year, scanned, { strict: true });
      nextSourceArticles = replaceInfographicYearArticles(nextSourceArticles, year, scanned);
      scannedCount += scanned.length;
    }
    // Mehrere geänderte Jahrgänge gemeinsam veröffentlichen: Leser sehen so
    // entweder vollständig den alten oder vollständig den neuen Indexstand.
    publishArticleIndex(nextSourceArticles);
    reindexState = { running: false, processed: articles.length, articles: articles.length, done: true };
    console.log(`✓ Infografiken ${uniqueYears.join(', ')} neu eingelesen (${scannedCount} Einträge, ${Date.now() - t0}ms)`);
  } catch (error) {
    reindexState = { ...reindexState, running: false, done: true, error: error.message };
    throw error;
  }
}

async function refreshInfographicsForYear(year) {
  return refreshInfographicsForYears([year]);
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

  // Deduplicate by id (orig/ subdirs may duplicate files).
  // Hörbücher werden nur beim vollständigen Neuindex erneut eingelesen.
  await audiobooks.rebuild();
  publishArticleIndex(uniqueArticles(collector));

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
    (article.author !== INFOGRAPHICS_AUTHOR || !groupAnchorOf.has(article.id)) &&
    !conflictingInfographicBase(article)
  );
}

function conflictingInfographicBase(article, byId = articleById, anchorOf = groupAnchorOf) {
  if (article.author === INFOGRAPHICS_AUTHOR) return false;
  const year = article.year || article.date?.slice(0, 4) || '';
  const stem = path.basename(article.filePath, '.md');
  const base = byId.get([INFOGRAPHICS_AUTHOR, year, stem].join('/'));
  return !!base && anchorOf.get(base.id) !== article.id;
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

function infographicAttachmentStem(baseStem, ordinal) {
  return `${baseStem}_${ordinal}`;
}

function firstAvailableInfographicOrdinal(article, byId = articleById, anchorOf = groupAnchorOf) {
  const year = article.year || article.date?.slice(0, 4) || '';
  const stem = path.basename(article.filePath, '.md');
  const base = byId.get([INFOGRAPHICS_AUTHOR, year, stem].join('/'));
  // Solange eine alte suffixlose Grafik noch diesem Artikel gehört, darf _1
  // nicht neu entstehen: sonst würde die alte Basis als Original erscheinen.
  return base && anchorOf.get(base.id) === article.id ? 2 : 1;
}

function getInfographicTarget(article, imageExt) {
  const year = article.year || (article.date ? article.date.slice(0, 4) : '');
  if (!/^\d{4}$/.test(year)) return null;

  const dir = resolveUnder(WWW_DIR, INFOGRAPHICS_AUTHOR, year);
  if (!dir) return null;

  const baseStem = path.basename(article.filePath, '.md');
  for (let ordinal = firstAvailableInfographicOrdinal(article); ordinal < 1000; ordinal++) {
    const stem = infographicAttachmentStem(baseStem, ordinal);
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

const DUPLICATE_MEDIA_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.mp3', '.mp4', '.pdf']);

function duplicateFail(status, message) {
  return Object.assign(new Error(message), { status });
}

function duplicateInfographicViews(article) {
  return (infographicGroups.get(article.id) || [])
    .filter(item => item.ownImage)
    .map(item => ({
      id: item.id,
      title: item.title,
      imageUrl: item.imageUrl,
    }));
}

function duplicateArticleView(article) {
  if (!article) return null;
  const infographics = duplicateInfographicViews(article);
  return {
    id: article.id,
    author: article.author,
    title: article.title,
    date: article.date,
    excerpt: article.excerpt,
    sourceUrl: article.sourceUrl,
    imageUrl: article.ownImage ? article.imageUrl : null,
    hasOwnImage: !!article.ownImage,
    hash: article.duplicateProfile?.hash || '',
    infographicCount: infographics.length,
    infographics,
  };
}

function duplicatePair(blogId, facebookId) {
  const blog = articleById.get(blogId);
  const facebook = articleById.get(facebookId);
  if (!blog || !facebook) throw duplicateFail(404, 'Einer der Artikel wurde nicht gefunden.');
  if (blog.author !== duplicateConfig.blogAuthor || !duplicateConfig.facebookAuthors.includes(facebook.author)) {
    throw duplicateFail(400, 'Diese Autoren können nicht als Blog-/Quellen-Dublette verknüpft werden.');
  }
  return { blog, facebook };
}

function filesForInfographic(article) {
  const dir = path.dirname(article.filePath);
  const stem = path.basename(article.filePath, '.md').toLowerCase();
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .filter(entry => {
      const ext = path.extname(entry.name).toLowerCase();
      return path.basename(entry.name, ext).toLowerCase() === stem
        && (ext === '.md' || DUPLICATE_MEDIA_EXTENSIONS.has(ext));
    })
    .map(entry => path.join(dir, entry.name));
}

// Die Artikelverwaltung bearbeitet ausschließlich die zu diesem Artikel
// gruppierten Grafiken. Eine eigenständige Basis-Infografik (mit eigenem Text
// oder Audio) wird niemals durch Umordnen/Löschen ihrer Anhänge verändert.
function managedInfographicContext(id, user) {
  const requested = articleById.get(id);
  if (!requested) throw duplicateFail(404, 'Artikel nicht gefunden.');
  const article = duplicateCanonicalFor(requested, user) || requested;
  if (!canUploadInfographic(user, article)) throw duplicateFail(403, 'Keine Berechtigung für diese Infografiken.');
  const year = article.year || article.date?.slice(0, 4) || '';
  if (!/^\d{4}$/.test(year)) throw duplicateFail(400, 'Der Artikel hat kein gültiges Jahr.');
  const dir = resolveUnder(WWW_DIR, INFOGRAPHICS_AUTHOR, year);
  const baseStem = path.basename(article.filePath, '.md');
  if (!dir || !baseStem) throw duplicateFail(400, 'Kein gültiges Infografik-Ziel gefunden.');
  const members = (infographicGroups.get(article.id) || []).filter(item => item.ownImage);
  const bundles = members.map(item => {
    if (item.author !== INFOGRAPHICS_AUTHOR || path.resolve(path.dirname(item.filePath)) !== dir
      || item.infographicBase !== baseStem) {
      throw duplicateFail(409, 'Eine Grafik gehört nicht zu den verwaltbaren Artikel-Infografiken.');
    }
    const files = filesForInfographic(item);
    const imageFiles = files.filter(file => ['.png', '.jpg', '.jpeg'].includes(path.extname(file).toLowerCase()));
    if (files.length !== 2 || imageFiles.length !== 1 || !files.includes(item.filePath)) {
      throw duplicateFail(409, 'Eine Infografik hat zusätzliche oder unvollständige Dateien und kann nicht automatisch verwaltet werden.');
    }
    return { id: item.id, ordinal: item.infographicOrdinal, title: item.title,
      imageUrl: item.imageUrl, instagramPoster: item.instagramPoster === true,
      files, mdPath: item.filePath };
  });
  const ownGraphic = article.author === INFOGRAPHICS_AUTHOR && article.ownImage
    ? {
        id: article.id, ordinal: 0, title: article.title, imageUrl: article.imageUrl,
        instagramPoster: article.instagramPoster === true, files: filesForInfographic(article),
        mdPath: article.filePath, fixed: true,
      }
    : null;
  return { article, dir, year, baseStem, bundles, items: ownGraphic ? [ownGraphic, ...bundles] : bundles };
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
    if (enabled) throw duplicateFail(409, 'Die Infografik hat keine Datum-Zeile.');
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

async function setManagedInfographicInstagramPoster(item, enabled) {
  if (typeof enabled !== 'boolean') throw duplicateFail(400, 'Der Instagram-Poster-Wert ist ungültig.');
  const original = await fs.promises.readFile(item.mdPath, 'utf8');
  const updated = setInstagramPosterMetadata(original, enabled);
  if (updated === original) return async () => {};
  return moveInfographicFiles([{ source: item.mdPath, target: item.mdPath, content: updated }]);
}

async function prepareInfographicPosterBatch(changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 2000) {
    throw duplicateFail(400, 'Bitte mindestens eine und höchstens 2000 Änderungen senden.');
  }
  const seen = new Set();
  const mappings = [];
  const years = new Set();
  const updated = [];
  const root = path.resolve(WWW_DIR, INFOGRAPHICS_AUTHOR) + path.sep;

  for (const change of changes) {
    const id = typeof change?.id === 'string' ? change.id : '';
    if (!id || seen.has(id) || typeof change.enabled !== 'boolean'
        || (change.expected !== undefined && typeof change.expected !== 'boolean')) {
      throw duplicateFail(400, 'Eine Poster-Änderung ist ungültig oder doppelt enthalten.');
    }
    seen.add(id);
    const article = articleById.get(id);
    const mdPath = article?.filePath ? path.resolve(article.filePath) : '';
    if (!article || article.author !== INFOGRAPHICS_AUTHOR || !article.ownImage
        || !mdPath.startsWith(root) || path.extname(mdPath).toLowerCase() !== '.md') {
      throw duplicateFail(404, 'Infografik nicht gefunden: ' + id);
    }
    const current = article.instagramPoster === true;
    if (change.expected !== undefined && change.expected !== current) {
      throw duplicateFail(409, 'Die Poster-Markierung wurde zwischenzeitlich geändert. Bitte die Ansicht neu laden.');
    }
    if (current === change.enabled) continue;
    const original = await fs.promises.readFile(mdPath, 'utf8');
    const content = setInstagramPosterMetadata(original, change.enabled);
    mappings.push({ source: mdPath, target: mdPath, content });
    years.add(article.year);
    updated.push({ id, instagramPoster: change.enabled });
  }

  return { mappings, years: [...years], updated };
}

// Alle Quellen erst in temporäre Namen verschieben, dann die Ziele belegen:
// dadurch sind auch Vertauschungen von _1, _2, _3 usw. ohne Überschreiben
// möglich. Fehler rollen sowohl Dateinamen als auch Markdown-Inhalte zurück.
async function moveInfographicFiles(mappings) {
  if (!mappings.length) return async () => {};
  const key = file => process.platform === 'win32' ? file.toLowerCase() : file;
  const sources = new Set(mappings.map(item => key(item.source)));
  const targets = new Set();
  if (sources.size !== mappings.length) throw duplicateFail(409, 'Eine Infografikdatei ist mehrfach enthalten.');
  for (const item of mappings) {
    const targetKey = key(item.target);
    if (targets.has(targetKey)) throw duplicateFail(409, 'Zwei Infografikdateien hätten denselben Zielnamen.');
    targets.add(targetKey);
    const stat = await fs.promises.lstat(item.source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw duplicateFail(409, 'Symbolische Links oder Ordner können nicht verschoben werden.');
    try {
      await fs.promises.lstat(item.target);
      if (!sources.has(targetKey)) throw duplicateFail(409, 'Zieldatei existiert bereits: ' + path.basename(item.target));
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

async function reorderManagedInfographics(context, orderedIds) {
  const { bundles, baseStem, dir } = context;
  if (!Array.isArray(orderedIds) || orderedIds.length !== bundles.length
    || new Set(orderedIds).size !== bundles.length
    || orderedIds.some(id => !bundles.some(item => item.id === id))) {
    throw duplicateFail(400, 'Die Reihenfolge enthält nicht genau die vorhandenen Infografiken.');
  }
  if (!bundles.length) return async () => {};
  const byId = new Map(bundles.map(item => [item.id, item]));
  const key = file => process.platform === 'win32' ? file.toLowerCase() : file;
  const ownedFiles = new Set(bundles.flatMap(item => item.files).map(key));
  const blockedStems = new Set(fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .filter(entry => ['.md', '.png', '.jpg', '.jpeg'].includes(path.extname(entry.name).toLowerCase()))
    .filter(entry => !ownedFiles.has(key(path.join(dir, entry.name))))
    .map(entry => path.basename(entry.name, path.extname(entry.name)).toLowerCase()));
  const mappings = [];
  let nextOrdinal = 1;
  for (const id of orderedIds) {
    const bundle = byId.get(id);
    while (nextOrdinal < 1000) {
      const candidate = infographicAttachmentStem(baseStem, nextOrdinal);
      if (!blockedStems.has(candidate.toLowerCase())) break;
      nextOrdinal++;
    }
    if (nextOrdinal >= 1000) throw duplicateFail(409, 'Keine freien Infografik-Dateinamen gefunden.');
    const ordinal = nextOrdinal++;
    const stem = infographicAttachmentStem(baseStem, ordinal);
    for (const source of bundle.files) {
      const extension = path.extname(source).toLowerCase();
      const item = { source, target: path.join(dir, stem + extension) };
      if (extension === '.md' && ordinal !== bundle.ordinal) {
        item.content = retitleInfographicMarkdown(await fs.promises.readFile(source, 'utf8'), bundle.ordinal, ordinal);
      }
      if (source !== item.target) mappings.push(item);
    }
  }
  return moveInfographicFiles(mappings);
}

async function infographicTrashFolder(year) {
  const root = await fs.promises.realpath(path.join(WWW_DIR, INFOGRAPHICS_AUTHOR));
  const ensureDirectory = async dir => {
    try {
      const stat = await fs.promises.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw duplicateFail(409, 'Der Infografik-Papierkorb ist kein sicherer Ordner.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.promises.mkdir(dir);
    }
    const real = await fs.promises.realpath(dir);
    if (!real.startsWith(root + path.sep)) throw duplicateFail(403, 'Der Papierkorb liegt außerhalb des Infografik-Ordners.');
  };
  await ensureDirectory(INFOGRAPHIC_TRASH_DIR);
  const yearDir = path.join(INFOGRAPHIC_TRASH_DIR, year);
  await ensureDirectory(yearDir);
  for (let attempt = 0; attempt < 10; attempt++) {
    const name = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(4).toString('hex');
    const folder = path.join(yearDir, name);
    try { await fs.promises.mkdir(folder); return folder; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw duplicateFail(409, 'Kein freier Platz im Infografik-Papierkorb gefunden.');
}

function nextDuplicateInfographicTarget(blog, reserved) {
  if (conflictingInfographicBase(blog)) {
    throw duplicateFail(409, 'Unter diesem Dateistamm existiert eine eigenständige oder anders zugeordnete Infografik.');
  }
  const year = blog.year || blog.date?.slice(0, 4) || '';
  if (!/^\d{4}$/.test(year)) throw duplicateFail(400, 'Der Blogartikel hat kein gültiges Jahr.');
  const dir = resolveUnder(WWW_DIR, INFOGRAPHICS_AUTHOR, year);
  if (!dir) throw duplicateFail(400, 'Kein gültiges Infografik-Ziel gefunden.');
  const baseStem = path.basename(blog.filePath, '.md');
  for (let ordinal = firstAvailableInfographicOrdinal(blog); ordinal < 1000; ordinal++) {
    const stem = infographicAttachmentStem(baseStem, ordinal);
    if (!reserved.has(stem.toLowerCase()) && !infographicStemExists(dir, stem)) {
      reserved.add(stem.toLowerCase());
      return { dir, stem, ordinal };
    }
  }
  throw duplicateFail(409, 'Es konnte kein freier Infografik-Dateiname gefunden werden.');
}

function planDuplicateMigration(blog, facebook) {
  const bundles = [];
  for (const info of infographicGroups.get(facebook.id) || []) {
    if (!info.ownImage) continue;
    if (info.hasBody) throw duplicateFail(409, `„${info.title}“ enthält eigenen Text und wird nicht automatisch migriert.`);
    bundles.push({ kind: 'infographic', sourceArticle: info, files: filesForInfographic(info) });
  }
  const reserved = new Set();
  return bundles.map(bundle => {
    const target = nextDuplicateInfographicTarget(blog, reserved);
    const mappings = bundle.files.map(source => ({
      source,
      target: path.join(target.dir, target.stem + path.extname(source).toLowerCase()),
    }));
    return { ...bundle, ...target, mappings };
  });
}

function publicMigrationPlan(plan) {
  return plan.map(bundle => ({
    kind: bundle.kind,
    target: path.relative(WWW_DIR, path.join(bundle.dir, bundle.stem)).replace(/\\/g, '/'),
    files: bundle.mappings.map(item => path.basename(item.target)),
  }));
}

async function migrateDuplicateInfographics(blog, facebook) {
  const plan = planDuplicateMigration(blog, facebook);
  if (!plan.length) return { migrations: [], rollback: async () => {} };
  const blogContent = await fs.promises.readFile(blog.filePath, 'utf8');
  const header = validateInfographicHeader(blogContent);
  if (!header.hasTitle || !header.date) throw duplicateFail(400, 'Der Blogartikel hat keinen gültigen Titel- und Datumskopf.');

  const moved = [];
  const created = [];
  const overwrittenMarkdown = [];
  const archiveRoot = await fs.promises.realpath(WWW_DIR);
  const isInsideArchive = file => {
    const root = process.platform === 'win32' ? archiveRoot.toLowerCase() : archiveRoot;
    const candidate = process.platform === 'win32' ? file.toLowerCase() : file;
    return candidate.startsWith(root + path.sep);
  };
  const rollback = async () => {
    for (const file of [...created].reverse()) await fs.promises.unlink(file).catch(() => {});
    for (const item of [...overwrittenMarkdown].reverse()) await fs.promises.writeFile(item.path, item.content).catch(() => {});
    for (const mapping of [...moved].reverse()) await fs.promises.rename(mapping.target, mapping.source).catch(() => {});
  };
  try {
    for (const bundle of plan) {
      await fs.promises.mkdir(bundle.dir, { recursive: true });
      const realTargetDir = await fs.promises.realpath(bundle.dir);
      if (!isInsideArchive(realTargetDir)) throw duplicateFail(403, 'Das Infografik-Ziel liegt außerhalb des Archivs.');
      for (const mapping of bundle.mappings) {
        const source = path.resolve(mapping.source);
        const target = path.resolve(mapping.target);
        if (!source.startsWith(WWW_DIR + path.sep) || !target.startsWith(WWW_DIR + path.sep)) {
          throw duplicateFail(403, 'Ein Medienpfad liegt außerhalb des Archivs.');
        }
        const stat = await fs.promises.lstat(source);
        if (stat.isSymbolicLink() || !stat.isFile()) throw duplicateFail(409, 'Symbolische Links können nicht migriert werden.');
        const realSource = await fs.promises.realpath(source);
        if (!isInsideArchive(realSource)) throw duplicateFail(403, 'Eine Quelldatei liegt außerhalb des Archivs.');
        try { await fs.promises.access(target); throw duplicateFail(409, `Zieldatei existiert bereits: ${path.basename(target)}`); }
        catch (error) { if (error.status) throw error; if (error.code !== 'ENOENT') throw error; }
      }

      const mdMapping = bundle.mappings.find(item => path.extname(item.source).toLowerCase() === '.md');
      for (const mapping of bundle.mappings) {
        await fs.promises.rename(mapping.source, mapping.target);
        moved.push(mapping);
      }
      const mdTarget = path.join(bundle.dir, bundle.stem + '.md');
      if (mdMapping) {
        overwrittenMarkdown.push({ path: mdTarget, content: await fs.promises.readFile(mdTarget) });
        await fs.promises.writeFile(mdTarget, buildInfographicMarkdown(blogContent, bundle.ordinal));
      } else {
        await fs.promises.writeFile(mdTarget, buildInfographicMarkdown(blogContent, bundle.ordinal), { flag: 'wx' });
        created.push(mdTarget);
      }
    }
  } catch (error) {
    await rollback();
    throw error;
  }

  const migrations = plan.flatMap(bundle => [
    ...bundle.mappings.map(item => ({
      from: path.relative(WWW_DIR, item.source).replace(/\\/g, '/'),
      to: path.relative(WWW_DIR, item.target).replace(/\\/g, '/'),
    })),
    ...(!bundle.mappings.some(item => path.extname(item.source).toLowerCase() === '.md') ? [{
      from: null,
      to: path.relative(WWW_DIR, path.join(bundle.dir, bundle.stem + '.md')).replace(/\\/g, '/'),
    }] : []),
  ]);
  return { migrations, rollback };
}

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

function requireAdmin(req, res, next) {
  if (req.session?.user?.role === 'admin') return next();
  res.status(403).json({ error: 'Admin only' });
}

function isAdminUiSession(req) {
  return req.session?.user?.role === 'admin' && !req.session.user.mustChangePassword;
}

function adminCsrfToken(req) {
  if (!req.session.adminCsrfToken) req.session.adminCsrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.adminCsrfToken;
}

function sameStringSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

// Einheitlicher Schutz für sämtliche Admin-Endpunkte. Lesende Aufrufe benötigen
// nur die Admin-Rolle; schreibende Aufrufe zusätzlich dieselbe Herkunft und das
// pro Sitzung in die Admin-Seite eingebettete CSRF-Token.
function requireAdminAccess(req, res, next) {
  return requireAdmin(req, res, () => {
    if (SAFE_HTTP_METHODS.has(req.method)) return next();
    if (req.get('sec-fetch-site') === 'cross-site') {
      return res.status(403).json({ error: 'Änderungen sind nur aus dem Archiv erlaubt.' });
    }
    const origin = req.get('origin');
    const expectedOrigin = `${req.protocol}://${req.get('host')}`;
    if (origin && origin !== expectedOrigin) {
      return res.status(403).json({ error: 'Ungültige Anfrageherkunft.' });
    }
    if (!sameStringSecret(req.get('x-csrf-token'), req.session.adminCsrfToken)) {
      return res.status(403).json({ error: 'Ungültiges oder fehlendes Sicherheitstoken.' });
    }
    next();
  });
}

function renderIndexForSession(req) {
  let html = fs.readFileSync(INDEX_FILE, 'utf8');
  const isAdmin = isAdminUiSession(req);
  html = html.replace('<!-- ADMIN_CSRF_META -->', isAdmin
    ? `<meta name="admin-csrf-token" content="${adminCsrfToken(req)}">`
    : '');
  if (isAdmin) {
    return html.split(/\r?\n/)
      .filter(line => !line.includes('data-non-admin-asset'))
      .join('\n');
  }
  html = html.replace(/<!-- ADMIN_ONLY_START -->[\s\S]*?<!-- ADMIN_ONLY_END -->/g, '');
  html = html.split(/\r?\n/)
    .filter(line => !line.includes('data-admin-only') && !line.includes('data-admin-asset'))
    .join('\n');
  return html;
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

// CSP (zunächst Report-Only, siehe CSP_MODE) und weitere Sicherheits-Header für alle Antworten.
app.use(createSecurityHeaders({ mode: process.env.CSP_MODE }));
app.use('/api/article-markdown', express.json({ limit: '2mb' }));
app.use('/api/audiobook-extra-source', express.json({ limit: '2mb' }));
app.use('/api/audiobook-extra-create', express.json({ limit: '2mb' }));
// Neue Infografik: Bild base64 in JSON (bis 10 MB Bild → ~14 MB JSON).
app.use('/api/new-infographic', express.json({ limit: Math.ceil(INFOGRAPHIC_MAX_BYTES * 1.4) + 2 * 1024 * 1024 }));
// Kurze Mikrofonaufnahme als Base64-JSON; die eigentliche Voice-Datei entsteht nur auf dem Qwen-Server.
app.use('/api/tts/voices', express.json({ limit: Math.ceil(TTS_VOICE_MAX_BYTES * 1.4) + 1024 * 1024 }));
app.use(express.json());
app.use(session({
  secret: resolveSessionSecret({ strict: require.main === module }),
  resave: false,
  saveUninitialized: false,
  // secure: 'auto' setzt das Secure-Flag, sobald die Anfrage (über den
  // vertrauenswürdigen Proxy) per HTTPS kam; lokal per HTTP bleibt es aus.
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: 'auto' },
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
const PASSWORD_PENDING_ALLOWED = new Set(['/api/me', '/api/me/password', '/api/login', '/api/logout', CSP_REPORT_PATH]);
app.use((req, res, next) => {
  if (!req.session?.user?.mustChangePassword || PASSWORD_PENDING_ALLOWED.has(req.path)) return next();
  if (/^\/(api|files|audio-files)\//.test(req.path)) {
    return res.status(403).json({ error: 'Bitte zuerst ein neues Kennwort festlegen.', mustChangePassword: true });
  }
  next();
});
installCspReportRoute(app, express);

// Der Worker cached selbst keine Dateien. Sein automatisch berechneter Inhalt ändert
// sich aber bei jeder Änderung der App-Shell und löst damit den Update-Hinweis aus.
app.get('/service-worker.js', (_req, res) => {
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Service-Worker-Allowed': '/',
  });
  res.type('application/javascript').send(serviceWorkerSource(computeAppShellVersion()));
});

// Die HTML-Shell ist rollenabhängig und darf weder im Browser-Cache noch in
// einem Shared Cache landen. Ohne bestätigte Admin-Sitzung fehlen Admin-Menüs,
// Redaktionsdialoge und deren Script-Tags vollständig in der Antwort.
app.get(['/', '/index.html'], (req, res) => {
  res.set({
    'Cache-Control': 'private, no-store, max-age=0',
    Pragma: 'no-cache',
    Vary: 'Cookie',
  });
  res.type('html').send(renderIndexForSession(req));
});

// Admin-spezifische Browser-Module liegen aus Gründen der bestehenden
// Build-Struktur weiterhin unter public/, werden aber vor express.static
// abgefangen und ohne aktive Admin-Sitzung nicht ausgeliefert.
for (const assetPath of ADMIN_ASSET_PATHS) {
  app.get(assetPath, (req, res) => {
    if (!isAdminUiSession(req)) return res.status(404).end();
    res.set('Cache-Control', 'private, no-store');
    res.sendFile(path.join(PUBLIC_DIR, assetPath));
  });
}

// index.html immer beim Server nachfragen (sonst hält v. a. Safari eine alte Seite
// mit alten ?v=-Verweisen); JS/CSS werden über ?v= in index.html aktualisiert.
app.use(express.static(PUBLIC_DIR, {
  index: false,
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

// Gemeinsam für Anmeldung und eigene Kennwortänderung: Fehlversuche zählen
// pro Konto und pro IP (req.ip berücksichtigt nur vertrauenswürdige Proxys).
const loginLimiter = createLoginLimiter();

function sendTooManyAttempts(res, limit) {
  const error = tooManyAttemptsError(limit);
  res.set('Retry-After', String(error.retryAfter));
  return res.status(error.status).json({ error: error.message });
}

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  // Gesperrt wird vor bcrypt: spart Rechenzeit und verrät nicht, ob es das Konto gibt.
  const limit = loginLimiter.check(req.ip, email);
  if (!limit.allowed) return sendTooManyAttempts(res, limit);
  const auth = await userStore.authenticate(email, password);
  if (!auth) {
    loginLimiter.failure(req.ip, email);
    return res.status(401).json({ error: 'Ungültige E-Mail oder Passwort' });
  }
  loginLimiter.success(req.ip, email);
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
// Pfadprüfung, Autor-ACL und Papierkorb-Sperren: siehe media-files.cjs.

installMediaRoutes(app, {
  wwwDir: WWW_DIR, audioDir: AUDIO_DIR,
  infographicsAuthor: INFOGRAPHICS_AUTHOR, audiobookAuthor: AUDIOBOOK_AUTHOR,
  audiobooks, canAccessAuthor, attachUser,
});

// ─── Link-Vorschau (Open Graph) ────────────────────────────────────────────
// Crawler (WhatsApp, Signal, Telegram …) führen kein JS aus und ignorieren
// den #-Teil der URL. Deshalb liefert /a/<id> serverseitig og:*-Meta-Tags und
// leitet echte Besucher per JS/meta-refresh in den SPA (#/article/<id>) weiter.
// Die ID kann zu einem Artikel oder Hörbuch gehören.

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Artikelbilder liegen unter /files, Hörbuch-Cover unter /audio-files. Für die
// öffentliche Vorschau wird der URL-Pfad sicher auf die jeweilige Wurzel begrenzt.
function resolvePreviewImagePath(item) {
  if (!item?.imageUrl) return null;
  const pathname = item.imageUrl.split('?')[0];
  const root = pathname.startsWith('/files/') ? WWW_DIR
    : pathname.startsWith('/audio-files/') ? AUDIO_DIR
    : null;
  if (!root) return null;
  let rel;
  try { rel = decodeURIComponent(pathname.replace(/^\/(?:files|audio-files)\//, '')); }
  catch { return null; }
  const absPath = path.resolve(path.join(root, rel));
  if (!absPath.startsWith(root + path.sep)) return null;
  return absPath;
}

function ogDescription(article) {
  const raw = (article.summary || article.excerpt || '').replace(/\s+/g, ' ').trim();
  return raw.length > 200 ? raw.slice(0, 197).trimEnd() + '…' : raw;
}

function publicShareItem(id) {
  const article = articleById.get(id);
  return (article ? (duplicateCanonicalFor(article) || article) : null) || audiobooks.getForUser(null, id);
}

app.get('/a/*', (req, res) => {
  const id = req.params[0];
  const article = publicShareItem(id);
  const canonicalId = article?.id || id;
  const base = `${req.protocol}://${req.get('host')}`;
  const canonical = base + '/a/' + encodeURIComponent(canonicalId);

  let tags;
  if (article) {
    const title = escapeHtml(article.title || 'WebArchiv');
    const desc  = escapeHtml(ogDescription(article));
    const img   = article.imageUrl ? base + '/og-image/' + encodeURIComponent(canonicalId) : '';
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
  const target = '/#/article/' + encodeURIComponent(canonicalId);
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
    <script nonce="${escapeHtml(res.locals.cspNonce)}">location.replace(${JSON.stringify(target)});</script>
</body>
</html>`);
});

// Auth-freie, heruntergerechnete Bild-Auslieferung nur für die Link-Vorschau.
// Bewusst ohne canAccessAuthor: die Vorschau-Metadaten aller Artikel und
// Hörbücher sind öffentlich (Nutzer-Entscheidung). Das Bild wird auf max. 1200px/JPEG skaliert,
// damit nie die Originalauflösung geteilt wird. Ergebnis pro mtime gecacht.
const ogImageCache = new Map(); // key: absPath+':'+mtime+':'+Kantenlänge → Buffer
// ?sq=<Kantenlänge>: quadratischer Ausschnitt vom oberen Bildteil (Sperrbildschirm/Media Session).
const OG_SQUARE_SIZES = new Set([256, 512]);

app.get('/og-image/*', async (req, res) => {
  const id = req.params[0];
  const article = publicShareItem(id);
  const absPath = resolvePreviewImagePath(article);
  if (!absPath) return res.status(404).end();

  let mtime = 0;
  try { mtime = Math.floor(fs.statSync(absPath).mtimeMs); } catch { return res.status(404).end(); }

  const square = OG_SQUARE_SIZES.has(Number(req.query.sq)) ? Number(req.query.sq) : 0;
  const key = absPath + ':' + mtime + ':' + square;
  res.set('Cache-Control', 'public, max-age=86400');

  const cached = ogImageCache.get(key);
  if (cached) return res.type('image/jpeg').send(cached);

  try {
    const image = square
      ? sharp(absPath).resize({ width: square, height: square, fit: 'cover', position: 'top' })
      : sharp(absPath).resize({ width: 1200, withoutEnlargement: true });
    const buf = await image.jpeg({ quality: 80 }).toBuffer();
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

function parsePromptDefinition(content) {
  const lines = String(content).replace(/^\uFEFF/, '').split(/\r?\n/);
  const urlMarker = lines.findIndex(line => line.trim().toUpperCase() === 'URL:');
  const promptMarker = lines.findIndex((line, index) => index > urlMarker && line.trim().toUpperCase() === 'PROMPT:');
  if (urlMarker < 0 || promptMarker < 0) throw new Error('URL:- oder PROMPT:-Abschnitt fehlt.');

  const urlText = lines.slice(urlMarker + 1, promptMarker).map(line => line.trim()).find(Boolean);
  if (!urlText) throw new Error('Die Prompt-URL fehlt.');
  let url;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error('Die Prompt-URL ist ungültig.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Die Prompt-URL muss HTTP oder HTTPS verwenden.');

  const prompt = lines.slice(promptMarker + 1).join('\n').trim();
  if (!prompt) throw new Error('Der Prompt ist leer.');
  return { url: url.href, prompt };
}

// Liste der verfügbaren Prompt-Dateien; Zahlen-Präfix steuert Reihenfolge
// und wird aus dem Label entfernt (z. B. "1_Infografik-Prompt-ChatGPT.txt").
app.get('/api/prompts', attachUser, (_req, res) => {
  try {
    const prompts = fs.readdirSync(PROMPTS_DIR)
      .filter(f => f.toLowerCase().endsWith('.txt'))
      .map(file => {
        const stem = file.slice(0, -4);
        const m = stem.match(/^(\d+)_(.*)$/);
        try {
          const definition = parsePromptDefinition(fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf8'));
          return {
            file,
            label: m ? m[2] : stem,
            order: m ? parseInt(m[1], 10) : Infinity,
            ...definition,
          };
        } catch (err) {
          console.warn(`Prompt-Datei „${file}“ wird ignoriert: ${err.message}`);
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
      .map(({ file, label, url, prompt }) => ({ file, label, url, prompt }));
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
    const { prompt } = parsePromptDefinition(txt);
    res.type('text/plain').send(prompt);
  } catch (err) {
    if (err?.code === 'ENOENT') return res.status(404).end();
    if (err instanceof Error) return res.status(422).type('text/plain').send(err.message);
    res.status(404).end();
  }
});

app.post('/api/reindex', requireAdminAccess, (req, res) => {
  if (ttsJobs.running || scrapeState.running || infographicWrites || markdownEditor.running) return res.status(409).json({ started: false, error: 'Es läuft bereits ein Audio-, Scrape- oder Speicherauftrag.' });
  if (reindexState.running) return res.json({ started: false, reason: 'already running' });
  buildIndex().catch(console.error);
  res.json({ started: true });
});

app.get('/api/infographic-manager/*', requireAdminAccess, (req, res) => {
  if (infographicWrites) return res.status(409).json({ error: 'Infografiken werden gerade geändert. Bitte gleich erneut öffnen.' });
  try {
    const context = managedInfographicContext(req.params[0], req.session.user);
    res.set('Cache-Control', 'no-store').json({
      articleId: context.article.id,
      title: context.article.title,
      items: context.items.map(item => ({
        id: item.id, title: item.title, ordinal: item.ordinal,
        filename: path.basename(item.files.find(file => ['.png', '.jpg', '.jpeg']
          .includes(path.extname(file).toLowerCase())) || item.mdPath),
        imageUrl: item.imageUrl, instagramPoster: item.instagramPoster, fixed: item.fixed === true,
      })),
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Infografiken konnten nicht geladen werden.' });
  }
});

app.post('/api/infographic-manager/*', requireAdminAccess, async (req, res) => {
  if (req.get('sec-fetch-site') === 'cross-site') {
    return res.status(403).json({ error: 'Speichern ist nur aus dem Archiv erlaubt.' });
  }
  if (ttsJobs.running || scrapeState.running || reindexState.running || infographicWrites || markdownEditor.running) {
    return res.status(409).json({ error: 'Es läuft bereits ein Speicher- oder Indexauftrag.' });
  }
  infographicWrites++;
  let undoOrder = null;
  let undoTrash = null;
  let undoInstagramPoster = null;
  let trashFolder = null;
  let context = null;
  try {
    context = managedInfographicContext(req.params[0], req.session.user);
    if (req.body?.action === 'order') {
      undoOrder = await reorderManagedInfographics(context, req.body.ids);
    } else if (req.body?.action === 'instagram-poster') {
      const item = context.items.find(candidate => candidate.id === req.body.id);
      if (!item) throw duplicateFail(404, 'Infografik nicht gefunden.');
      undoInstagramPoster = await setManagedInfographicInstagramPoster(item, req.body.enabled);
    } else if (req.body?.action === 'trash') {
      const item = context.bundles.find(bundle => bundle.id === req.body.id);
      if (!item) throw duplicateFail(404, 'Infografik nicht gefunden.');
      trashFolder = await infographicTrashFolder(context.year);
      undoTrash = await moveInfographicFiles(item.files.map(source => ({
        source, target: path.join(trashFolder, path.basename(source)),
      })));
      const remaining = context.bundles.filter(bundle => bundle.id !== item.id);
      undoOrder = await reorderManagedInfographics(
        { ...context, bundles: remaining }, remaining.map(bundle => bundle.id));
    } else {
      throw duplicateFail(400, 'Unbekannte Infografik-Aktion.');
    }
    await refreshInfographicsForYear(context.year);
    res.json({ ok: true, trash: trashFolder
      ? path.relative(WWW_DIR, trashFolder).replace(/\\/g, '/') : undefined });
  } catch (error) {
    let rollbackError = null;
    try {
      if (undoOrder) await undoOrder();
      if (undoTrash) await undoTrash();
      if (undoInstagramPoster) await undoInstagramPoster();
      if ((undoOrder || undoTrash || undoInstagramPoster) && context) await refreshInfographicsForYear(context.year);
      if (trashFolder) await fs.promises.rmdir(trashFolder).catch(() => {});
    } catch (failed) { rollbackError = failed; }
    res.status(error.status || 500).json({ error: rollbackError
      ? (error.message + ' Wiederherstellung fehlgeschlagen: ' + rollbackError.message)
      : (error.message || 'Infografiken konnten nicht geändert werden.') });
  } finally {
    infographicWrites--;
  }
});

// Admin-Prüfmodus: Änderungen über beliebig viele Ergebnisseiten sammeln und
// in einem atomaren Dateivorgang speichern. Anschließend werden ausschließlich
// die tatsächlich betroffenen Infografik-Jahrgänge neu eingelesen.
app.post('/api/infographic-review', requireAdminAccess, async (req, res) => {
  if (req.get('sec-fetch-site') === 'cross-site') {
    return res.status(403).json({ error: 'Speichern ist nur aus dem Archiv erlaubt.' });
  }
  if (ttsJobs.running || scrapeState.running || reindexState.running || infographicWrites || markdownEditor.running) {
    return res.status(409).json({ error: 'Es läuft bereits ein Speicher- oder Indexauftrag.' });
  }
  infographicWrites++;
  let undo = null;
  let years = [];
  try {
    const batch = await prepareInfographicPosterBatch(req.body?.changes);
    years = batch.years;
    undo = await moveInfographicFiles(batch.mappings);
    await refreshInfographicsForYears(years);
    return res.json({ ok: true, updated: batch.updated });
  } catch (error) {
    let rollbackError = null;
    try {
      if (undo) await undo();
      if (undo && years.length) await refreshInfographicsForYears(years);
    } catch (failed) { rollbackError = failed; }
    return res.status(error.status || 500).json({ error: rollbackError
      ? (error.message + ' Wiederherstellung fehlgeschlagen: ' + rollbackError.message)
      : (error.message || 'Poster-Markierungen konnten nicht gespeichert werden.') });
  } finally {
    infographicWrites--;
  }
});

app.post(
  '/api/infographics/*',
  requireAdminAccess,
  express.raw({ type: ['image/png', 'image/jpeg'], limit: INFOGRAPHIC_MAX_BYTES }),
  async (req, res) => {
    if (req.get('sec-fetch-site') === 'cross-site') {
      return res.status(403).json({ error: 'Speichern ist nur aus dem Archiv erlaubt.' });
    }
    if (ttsJobs.running || scrapeState.running || reindexState.running || infographicWrites || markdownEditor.running) {
      return res.status(409).json({ error: 'Es läuft bereits ein Speicher- oder Indexauftrag.' });
    }
    const id = req.params[0];
    const requested = articleById.get(id);
    if (!requested) return res.status(404).json({ error: 'Artikel nicht gefunden.' });
    const article = duplicateCanonicalFor(requested, req.session.user) || requested;

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

      await refreshInfographicsForYear(header.date.slice(0, 4));
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

app.post('/api/new-infographic', requireAdminAccess, async (req, res) => {
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
    await refreshInfographicsForYear(year);
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

app.post('/api/scrape', requireAdminAccess, (req, res) => {
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
    const changedFiles = parseScraperChangedFiles(scrapeState.output);
    if (scrapeState.output.includes(SCRAPER_CHANGED_FILES_MARKER)) {
      scrapeState.output = scrapeState.output.split(/\r?\n/)
        .filter(line => !line.startsWith(SCRAPER_CHANGED_FILES_MARKER)).join('\n');
    }
    console.log(`Scrape beendet (exit ${code}) — ${changedFiles === null ? 'vollständiger Sicherheits-Reindex' : `${changedFiles.length} geänderte Artikel`} …`);
    scrapeState = { ...scrapeState, running: false, done: true, exitCode: code };
    // Auch bei Teil-Fehler (exit 1) bereits gespeicherte Artikel aufnehmen. Bei
    // älteren Scraper-Versionen ohne Manifest bleibt der Voll-Reindex erhalten.
    if (!reindexState.running) {
      const refresh = changedFiles === null ? buildIndex() : refreshScrapedMarkdownFiles(changedFiles);
      refresh.catch(error => {
        console.error('Gezielter Scraper-Reindex fehlgeschlagen:', error);
        if (changedFiles !== null && !reindexState.running) buildIndex().catch(console.error);
      });
    }
  });

  res.json({ started: true, sources: scrapeState.sources });
});

// Letzte 100 Zeilen des Scraper-Logs (für die "Scrape-Log anzeigen"-Ansicht).
app.get('/api/scrape/log', requireAdminAccess, (_req, res) => {
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

function duplicateDecisionView(decision) {
  const blog = articleById.get(decision.blogId);
  const facebook = articleById.get(decision.facebookId);
  return {
    ...decision,
    blog: duplicateArticleView(blog),
    facebook: duplicateArticleView(facebook),
    missing: !blog || !facebook,
    changed: !!(blog && facebook && (
      decision.blogHash !== blog.duplicateProfile?.hash
      || decision.facebookHash !== facebook.duplicateProfile?.hash
    )),
  };
}

async function linkDuplicatePair({ blogId, facebookId, userEmail, migrateImages = false, deferDecision = false }) {
  const { blog, facebook } = duplicatePair(blogId, facebookId);
  const existing = duplicateStore.find(blogId, facebookId);
  const migrationResult = migrateImages
    ? await migrateDuplicateInfographics(blog, facebook)
    : { migrations: [], rollback: async () => {} };
  const decision = {
    blogId, facebookId, status: 'linked',
    blogHash: blog.duplicateProfile.hash,
    facebookHash: facebook.duplicateProfile.hash,
    user: userEmail,
    migrations: [...(existing?.migrations || []), ...migrationResult.migrations],
  };
  if (!deferDecision) {
    try { await duplicateStore.set(decision); }
    catch (error) { await migrationResult.rollback(); throw error; }
  }
  return { blogId, facebookId, migrations: migrationResult.migrations, decision, rollback: migrationResult.rollback };
}

app.get('/api/duplicates', requireAdminAccess, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const decisions = duplicateStore.all();
  const pending = duplicateCandidates.map(candidate => ({
    blog: duplicateArticleView(candidate.blog),
    facebook: duplicateArticleView(candidate.facebook),
    score: candidate.score,
    exact: candidate.exact,
    containment: candidate.containment,
    titleSimilarity: candidate.titleSimilarity,
    days: candidate.days,
    reasons: candidate.reasons,
  }));
  const linked = decisions.filter(item => item.status === 'linked').map(duplicateDecisionView);
  const ignored = decisions.filter(item => item.status === 'ignored').map(duplicateDecisionView);
  res.json({ pending, linked, ignored, config: duplicateConfig });
});

app.get('/api/duplicates/compare', requireAdminAccess, (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { blog, facebook } = duplicatePair(String(req.query.blogId || ''), String(req.query.facebookId || ''));
    const read = article => {
      const parsed = parseArticle(fs.readFileSync(article.filePath, 'utf8'), article.filePath);
      return { ...duplicateArticleView(article), bodyHtml: renderArticleBody(parsed.body), summary: parsed.summary || '' };
    };
    let migration = [];
    let migrationUnavailable = '';
    try { migration = publicMigrationPlan(planDuplicateMigration(blog, facebook)); }
    catch (error) { migrationUnavailable = error.message; }
    res.json({ blog: read(blog), facebook: read(facebook), migration, migrationUnavailable });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Der Vergleich konnte nicht geladen werden.' });
  }
});

app.post('/api/duplicates/batch', requireAdminAccess, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.get('sec-fetch-site') === 'cross-site') {
    return res.status(403).json({ error: 'Änderungen sind nur aus dem Archiv erlaubt.' });
  }
  if (reindexState.running || scrapeState.running || infographicWrites || markdownEditor.running || ttsJobs.running) {
    return res.status(409).json({ error: 'Es läuft bereits ein anderer Archiv- oder Speicherauftrag.' });
  }
  const rawItems = req.body?.items;
  if (!Array.isArray(rawItems) || !rawItems.length || rawItems.length > 500) {
    return res.status(400).json({ error: 'Bitte 1 bis 500 Dublettenpaare auswählen.' });
  }
  const items = rawItems.map(item => ({
    blogId: String(item?.blogId || ''),
    facebookId: String(item?.facebookId || ''),
  }));
  const facebookIds = new Set();
  try {
    for (const item of items) {
      duplicatePair(item.blogId, item.facebookId);
      if (facebookIds.has(item.facebookId)) {
        throw duplicateFail(400, 'Ein Quellartikel darf nur einmal in einer Sammelaktion vorkommen.');
      }
      facebookIds.add(item.facebookId);
    }
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message });
  }

  infographicWrites++;
  const prepared = [];
  const failed = [];
  try {
    for (const item of items) {
      try {
        prepared.push(await linkDuplicatePair({
          ...item,
          userEmail: req.session.user.email,
          migrateImages: !!req.body?.migrateImages,
          deferDecision: true,
        }));
      } catch (error) {
        failed.push({ ...item, error: error.status ? error.message : 'Verknüpfung fehlgeschlagen.' });
        if (!error.status) console.error('Dubletten-Sammelaktion:', error);
      }
    }
    try {
      if (prepared.length) await duplicateStore.setMany(prepared.map(item => item.decision));
    } catch (error) {
      for (const item of [...prepared].reverse()) await item.rollback();
      throw error;
    }
    if (prepared.length) {
      await bookmarks.replaceArticleIds(prepared.map(item => ({ oldId: item.facebookId, newId: item.blogId })));
    }
    const migrations = prepared.flatMap(item => item.migrations);
    if (migrations.length) await refreshInfographicsForYears(infographicYearsFromMigrations(migrations));
    else refreshDuplicateState();
    return res.json({ ok: failed.length === 0, linked: prepared.length, failed, migrations });
  } catch (error) {
    if (!error.status) console.error('Dubletten-Sammelaktion:', error);
    return res.status(error.status || 500).json({ error: error.status ? error.message : 'Die Sammelaktion ist fehlgeschlagen.' });
  } finally {
    infographicWrites--;
  }
});

app.post('/api/duplicates', requireAdminAccess, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.get('sec-fetch-site') === 'cross-site') {
    return res.status(403).json({ error: 'Änderungen sind nur aus dem Archiv erlaubt.' });
  }
  if (reindexState.running || scrapeState.running || infographicWrites || markdownEditor.running || ttsJobs.running) {
    return res.status(409).json({ error: 'Es läuft bereits ein anderer Archiv- oder Speicherauftrag.' });
  }
  const action = String(req.body?.action || '');
  const blogId = String(req.body?.blogId || '');
  const facebookId = String(req.body?.facebookId || '');
  infographicWrites++;
  try {
    if (action === 'reset') {
      await duplicateStore.remove(blogId, facebookId);
      refreshDuplicateState();
      return res.json({ ok: true });
    }
    const { blog, facebook } = duplicatePair(blogId, facebookId);
    if (action === 'ignore') {
      await duplicateStore.set({
        blogId, facebookId, status: 'ignored',
        blogHash: blog.duplicateProfile.hash,
        facebookHash: facebook.duplicateProfile.hash,
        user: req.session.user.email,
      });
      refreshDuplicateState();
      return res.json({ ok: true });
    }
    if (!['link', 'migrate'].includes(action)) throw duplicateFail(400, 'Unbekannte Dublettenaktion.');
    const existing = duplicateStore.find(blogId, facebookId);
    if (action === 'migrate' && existing?.status !== 'linked') {
      throw duplicateFail(409, 'Grafiken können erst nach dem Verknüpfen migriert werden.');
    }
    const result = await linkDuplicatePair({
      blogId, facebookId,
      userEmail: req.session.user.email,
      migrateImages: !!req.body?.migrateImages || action === 'migrate',
    });
    await bookmarks.replaceArticleId(facebookId, blogId);
    if (result.migrations.length) await refreshInfographicsForYears(infographicYearsFromMigrations(result.migrations));
    else refreshDuplicateState();
    return res.json({ ok: true, migrations: result.migrations });
  } catch (error) {
    if (!error.status) console.error('Dublettenverwaltung:', error);
    return res.status(error.status || 500).json({ error: error.status ? error.message : 'Die Dublettenaktion ist fehlgeschlagen.' });
  } finally {
    infographicWrites--;
  }
});

app.get('/api/articles', attachUser, (req, res) => {
  const {
    q, author, year, category, page = '1', limit = '24', telegram, externalAudio,
    instagram, infographic, infographicReview,
  } = req.query;
  const user = req.user;
  const infographicReviewMode = infographicReview === '1';
  if (infographicReviewMode && user.role !== 'admin') {
    return res.status(403).json({ error: 'Der Infografik-Prüfmodus ist nur für Administratoren verfügbar.' });
  }
  const marks = bookmarks.idsFor(user.email);
  const onlyBookmarks = req.query.bookmarks === '1';
  let filtered = articles;

  // ACL pre-filter: restrict to allowed authors
  if (user.allowedAuthors !== null) {
    filtered = filtered.filter(a => user.allowedAuthors.includes(a.author));
  }

  // Bestätigte Facebook-Dubletten verschwinden aus allen normalen Ansichten,
  // sofern der Nutzer ihren kanonischen Blogartikel sehen darf.
  filtered = filtered.filter(article => !duplicateCanonicalFor(article, user));

  // Nur Artikel mit Lesezeichen (Gäste: keine). Die übrigen Filter gelten weiter.
  if (onlyBookmarks) filtered = filtered.filter(a => marks.has(a.id));

  // "Telegram"-Artikel standardmäßig ausblenden; einbeziehen bei telegram=1,
  // wenn explizit nach Autor "Telegram" gefiltert wird oder bei Lesezeichen.
  const hideTelegram = telegram !== '1' && author !== 'Telegram' && !onlyBookmarks;
  if (hideTelegram) {
    filtered = filtered.filter(a => a.author !== 'Telegram');
  }

  if (author) {
    if (!canAccessAuthor(user, author)) {
      return res.json({ total: 0, page: 1, limit: 24, pages: 0, items: [] });
    }
    filtered = filtered.filter(a => a.author === author);
  }
  const infographicFilter = author === INFOGRAPHICS_AUTHOR
    ? (infographic === 'classic' ? 'classic' : ((infographic === 'poster' || instagram === '1') ? 'poster' : 'all'))
    : 'all';
  const instagramPosterMode = infographicFilter === 'poster';
  const classicInfographicMode = infographicFilter === 'classic';
  if (instagramPosterMode) filtered = filtered.filter(a => a.instagramPoster && a.ownImage);
  if (classicInfographicMode) filtered = filtered.filter(a => !a.instagramPoster && a.ownImage);
  if (infographicReviewMode) filtered = filtered.filter(a => a.author === INFOGRAPHICS_AUTHOR && a.ownImage);
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
    const { dateConstraints, text } = parseArticleSearchQuery(q, meta.years);
    // Datums-Tokens als Filter anwenden (AND)
    for (const dq of dateConstraints) {
      filtered = dq.kind === 'exact'
        ? filtered.filter(a => a.date === dq.value)
        : filtered.filter(a => a.date && a.date.startsWith(dq.value));
    }
    // Restlicher Text über Fuse, auf die datums-gefilterte Teilmenge eingeschränkt
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
    const tiles = [];
    const seen = new Set();
    let total = 0;
    for (const article of filtered) {
      const tile = visibleGroupAnchor(article, user, { hideTelegram }) || article;
      if (seen.has(tile.id)) continue;
      seen.add(tile.id);
      const images = groupImagesFor(tile, user);
      // Bei Lesezeichen zählt jede Kachel einmal (ein Lesezeichen = ein Treffer).
      total += onlyBookmarks ? 1 : 1 + (images ? images.length - (tile.ownImage ? 1 : 0) : 0);
      tiles.push(tile);
    }
    const items = tiles.slice((p - 1) * lim, p * lim)
      .map(tile => ({ ...exposeGroupForUser(tile, user), bookmarked: isBookmarkedTile(tile, user, marks) }));
    return res.json({ total, page: p, limit: lim, pages: Math.ceil(tiles.length / lim), items });
  }

  const total = filtered.length;
  const items = filtered.slice((p - 1) * lim, p * lim)
    .map(article => ({ ...exposeArticleForUser(article, user), bookmarked: isBookmarkedTile(article, user, marks) }));

  res.json({ total, page: p, limit: lim, pages: Math.ceil(total / lim), items });
});

app.get('/api/articles/*', attachUser, (req, res) => {
  const id = req.params[0];
  const requested = articleById.get(id);
  if (!requested) return res.status(404).json({ error: 'Not found' });

  const canonical = duplicateCanonicalFor(requested, req.user);
  const visibleRequested = canonical || requested;
  if (!canAccessAuthor(req.user, visibleRequested.author)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  // Eine gruppierte Infografik öffnet ihre Gruppe; requestedId sagt, welches Bild gemeint war.
  const anchor = visibleGroupAnchor(visibleRequested, req.user);
  const article = anchor || visibleRequested;

  try {
    const content = fs.readFileSync(article.filePath, 'utf8');
    const parsed = parseArticle(content, article.filePath);
    const bodyHtml = renderArticleBody(parsed.body);
    const rest = exposeGroupForUser(article, req.user);
    res.json({
      ...rest, bodyHtml, canUploadInfographic: canUploadInfographic(req.user, article),
      bookmarked: bookmarks.has(req.user.email, article.id),
      ...((anchor || canonical) ? { requestedId: id } : {}),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────

installTtsRoutes(app, requireAdminAccess, ttsJobs, undefined, ttsVoiceSettings);
installMarkdownRoutes(app, requireAdminAccess, markdownEditor);
installUserRoutes(app, {
  store: userStore, requireAuth, requireAdmin: requireAdminAccess, getAuthors: () => meta.authors,
  passwordLimiter: loginLimiter,
  onUserDeleted: email => Promise.all([audiobookProgress.removeUser(email), bookmarks.removeUser(email)]),
  onAuthorPriorityChanged: republishArticleIndex,
});
installBookmarkRoutes(app, {
  store: bookmarks, requireAuth, getArticle: id => articleById.get(id), canAccessAuthor,
});
installAudiobookRoutes(app, {
  library: audiobooks, progress: audiobookProgress, config: audiobookConfig,
  requireAuth, requireAdmin: requireAdminAccess, canAccessAuthor,
  busy: () => reindexState.running || scrapeState.running || infographicWrites > 0 || markdownEditor.running || ttsJobs.running,
});

app.use((err, _req, res, next) => {
  if (_req.path.startsWith('/api/audiobook-extra-upload/') && err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Die Datei ist größer als 20 MB.' });
  }
  if (_req.path.startsWith('/api/article-markdown/')
      || _req.path.startsWith('/api/audiobook-extra-source/')
      || _req.path.startsWith('/api/audiobook-extra-create/')) {
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

module.exports = {
  app, resolveSessionSecret, parseTrustProxy, extractSourceUrl,
  parseArticle, linkInfographics, buildArticleSearchIndex, parseArticleSearchQuery,
  articleDisplayAuthor,
  replaceInfographicYearArticles, replaceArticleIndexEntry, upsertArticleIndexEntries,
  infographicYearsFromMigrations, parseScraperChangedFiles, prepareLinkedArticles,
  buildInfographicMarkdown, removeCategoryLines, slugify,
  normalizeNewInfographicMarkdown, mergeCategories, parsePromptDefinition,
  computeAppShellVersion, serviceWorkerSource,
  renderIndexForSession, requireAdminAccess,
  infographicAttachmentStem, firstAvailableInfographicOrdinal,
  canUploadInfographic, conflictingInfographicBase, retitleInfographicMarkdown,
  moveInfographicFiles, reorderManagedInfographics,
  setInstagramPosterMetadata, setManagedInfographicInstagramPoster,
};
