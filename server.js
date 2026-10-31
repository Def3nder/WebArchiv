const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { renderSafeMarkdown, safeHttpUrl, escapeHtml } = require('./lib/html-sanitizer.cjs');
const session = require('express-session');
const sharp   = require('sharp');
const { createTtsJobs, installTtsRoutes } = require('./tts/jobs.cjs');
const { createTtsVoiceSettings, MAX_AUDIO_BYTES: TTS_VOICE_MAX_BYTES } = require('./tts/voice-settings.cjs');
const { createMarkdownEditor, installMarkdownRoutes } = require('./modules/article-editor.cjs');
const { createUserStore, installUserRoutes } = require('./modules/user-store.cjs');
const {
  AUDIOBOOK_AUTHOR, createAudiobookLibrary, createProgressStore, loadAudiobookConfig, installAudiobookRoutes,
} = require('./modules/audiobooks.cjs');
const { createBookmarkStore, installBookmarkRoutes } = require('./modules/bookmarks.cjs');
const { createScrapeJob, installScrapeRoutes } = require('./modules/scrape.cjs');
const { installMediaRoutes } = require('./modules/media-files.cjs');
const { createLoginLimiter, tooManyAttemptsError } = require('./lib/login-limiter.cjs');
const { createSecurityHeaders, installCspReportRoute, REPORT_PATH: CSP_REPORT_PATH } = require('./lib/security-headers.cjs');
const { createArchiveLock, sendArchiveBusy } = require('./lib/archive-lock.cjs');
// Reine Logik ohne Serverzustand (auch für Skripte nutzbar, ohne server.js zu laden).
const { httpError, isCrossSite, sendApiError, sendRouteError } = require('./lib/http-errors.cjs');
const { computeAppShellVersion, createAppShellVersion, createVersionedIndex, serviceWorkerSource } = require('./lib/app-shell.cjs');
const { createArticleBodyCache } = require('./lib/article-body-cache.cjs');
const { FileSessionStore } = require('./lib/session-file-store.cjs');
const { writeFileAtomic } = require('./lib/atomic-file.cjs');
const {
  parseArticleSearchQuery, bodyExcerpt, mergeCategories, autoCategorize,
  extractSourceUrl, parseArticle,
} = require('./lib/article-parser.cjs');
const {
  createDirectoryCache, findSibling, fileUrl, audioFileUrl, isPathInside, resolveUnder, yearFromRelativeDir,
} = require('./lib/archive-files.cjs');
const { resolveMediaRequest } = require('./modules/media-files.cjs');
const {
  INFOGRAPHICS_AUTHOR, linkInfographics, infographicYearsFromMigrations, imageExtensionFromContentType,
  infographicStemExists, infographicAttachmentStem, validateInfographicHeader, removeCategoryLines,
  buildInfographicMarkdown, retitleInfographicMarkdown, setInstagramPosterMetadata, moveInfographicFiles,
  slugify, normalizeNewInfographicMarkdown, detectImageType,
} = require('./lib/infographics.cjs');
const {
  buildArticleSearchIndex, articleDisplayAuthor, uniqueArticles, replaceInfographicYearArticles,
  replaceArticleIndexEntry, upsertArticleIndexEntries, parseScraperChangedFiles,
} = require('./lib/article-index.cjs');

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
  loadDuplicateConfig, buildDuplicateProfile, createDuplicateDetection,
  createDuplicateStore, decisionStillApplies, finishDuplicateLinks,
} = require('./lib/duplicates.cjs');

const app = express();
// Hinter dem Reverse-Proxy (NPMplus/HTTPS) X-Forwarded-Proto/Host/For nur von
// bekannten Proxy-Adressen übernehmen. Sonst könnte jeder Client über einen
// gefälschten X-Forwarded-For-Header die Login-Begrenzung pro IP umgehen.
const TRUST_PROXY_DEFAULT = 'loopback, 192.168.1.14';
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');
// Gerenderte Artikeltexte für Detailansicht und Dubletten-Vergleich.
const articleBodies = createArticleBodyCache();
const WWW_DIR = path.join(__dirname, 'www');
const AUDIO_DIR = path.join(__dirname, 'audio');
const CONFIG_FILE = path.join(__dirname, 'config.json');
// Telegram ist in Listen ausgeblendet, außer mit ?telegram=1 oder author=Telegram.
const TELEGRAM_AUTHOR = 'Telegram';
const INFOGRAPHIC_TRASH_DIR = path.join(WWW_DIR, INFOGRAPHICS_AUTHOR, 'trash');
const INFOGRAPHIC_MAX_BYTES = 10 * 1024 * 1024;
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ADMIN_ASSET_PATHS = new Set([
  '/admin-tasks.js',
  '/infographic-review.js',
  '/user-admin.js',
  '/tts-settings.js',
  '/duplicates.js',
  '/css/duplicates.css',
  '/infographic-new.js',
  '/infographic-manager.js',
  '/article-editor.js',
  '/audiobook-extras-manager.js',
  '/markdown-editors.js',
  '/duplicate-diff.js',
  '/vendor/duplicate-diff.bundle.js',
  '/vendor/article-editor.bundle.js',
]);

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

// Indexzustand: publishArticleIndex und refreshDuplicateState ersetzen die Felder
// bei jedem (Teil-)Reindex. Wer das Objekt bekommt, liest die Felder erst beim
// Aufruf (archive.articleById.get(id)) und hält nie eine Map von früher fest.
const archive = {
  articles: [],
  // Unverknüpfte Scan-Ergebnisse: linkInfographics verändert abgeleitete Felder.
  // Für einen Teil-Neuindex müssen die übrigen Artikel aus diesem Stand neu verknüpft werden.
  sourceArticles: [],
  articleById: new Map(),
  // Infografik-Gruppen (siehe linkInfographics): Anker-ID → Mitglieder, Mitglied → Anker-ID.
  infographicGroups: new Map(),
  groupAnchorOf: new Map(),
  duplicateCanonicalOf: new Map(),
  duplicateCandidates: [],
  meta: { authors: [], years: [], categories: [] },
  fuseIndex: null,
};
let reindexState = { running: false, processed: 0, articles: 0, done: true };
// Zentrale Sperre für Schreib- und Indexaufträge (archive-lock.cjs); die
// Aufträge mit eigenem Zustand werden unten nach ihrer Erzeugung registriert.
const archiveLock = createArchiveLock();

// Hörbücher: je ein Ordner unter audio/Hoerbuecher/ (oder audio/Hörbücher/), eigener Index neben den Artikeln.
const audiobookConfig = loadAudiobookConfig(CONFIG_FILE);
const audiobookProgress = createProgressStore({
  file: process.env.AUDIOBOOK_PROGRESS_FILE || path.join(__dirname, 'audiobook-progress.json'),
  privateFile: process.env.AUDIOBOOK_PRIVATE_FILE || path.join(__dirname, 'audiobook-private.json'),
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
// Rechnet die Kandidaten nur neu, wenn sich Blog- oder Quellartikel geändert haben.
const duplicateDetection = createDuplicateDetection();
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
  getArticle: id => archive.articleById.get(id) || audiobooks.get(id),
  canAccessAuthor,
  busy: () => archiveLock.busy,
  reindex: refreshMarkdownIndex,
});
const ttsJobs = createTtsJobs({
  root: WWW_DIR,
  audioRoot: AUDIO_DIR,
  getArticle: id => archive.articleById.get(id),
  canAccessAuthor,
  busy: () => archiveLock.busy,
  reindex: refreshMarkdownIndex,
  selectedVoice: ttsVoiceSettings.selectedVoice,
  mediaUrl: filename => audioFileUrl(path.relative(AUDIO_DIR, filename).split(path.sep).map(encodeURIComponent).join('/'), filename),
});
// Scraper als eigener Prozess; danach die gemeldeten Artikel gezielt neu einlesen.
const scrapeJob = createScrapeJob({
  scraperDir: path.join(__dirname, 'scraper'),
  reindex: () => buildIndex(),
  refreshFiles: files => refreshScrapedMarkdownFiles(files),
  reindexRunning: () => reindexState.running,
});
// Editor und TTS prüfen archiveLock.busy und setzen danach synchron ihren eigenen
// Zustand; ihr eigener Eintrag ist zum Prüfzeitpunkt daher noch nicht aktiv.
archiveLock.register('Index-Neuaufbau', () => reindexState.running);
archiveLock.register('Scraper-Lauf', () => scrapeJob.running);
archiveLock.register('Artikel speichern', () => markdownEditor.running);
archiveLock.register('Audio-Erzeugung', () => ttsJobs.running);

// ─── Parsers ───────────────────────────────────────────────────────────────

// ─── File scanner ──────────────────────────────────────────────────────────

async function scanDir(dirPath, author, year, collector, {
  strict = false, targetFile = null, directories = createDirectoryCache(),
} = {}) {
  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (strict) throw error;
    return;
  }
  directories.seed(dirPath, entries);
  const listing = directories.get(dirPath);
  const resolvedTarget = targetFile ? path.resolve(targetFile) : null;

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (resolvedTarget && !isPathInside(fullPath, resolvedTarget)) continue;
      // Gelöschte Infografiken bleiben als Dateien erhalten, gehören aber nie
      // wieder in den Artikelindex oder in eine Bildgruppe.
      if (author === INFOGRAPHICS_AUTHOR && fullPath === INFOGRAPHIC_TRASH_DIR) continue;
      const nextYear = /^\d{4}$/.test(entry.name) ? entry.name : year;
      await scanDir(fullPath, author, nextYear, collector, { strict, targetFile: resolvedTarget, directories });
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

      const ownImgPath = findSibling(dirPath, basename, ['.jpg', '.jpeg', '.png'], listing);
      const authorDir = path.join(WWW_DIR, author);
      const imgPath = ownImgPath
        || findSibling(authorDir, 'standard', ['.jpg', '.jpeg', '.png'], directories.get(authorDir));
      const localAudioPath = findSibling(dirPath, basename, ['.mp3'], listing);
      const externalAudioDir = path.join(AUDIO_DIR, author, relDir);
      const externalAudioPath = localAudioPath
        ? null
        : findSibling(externalAudioDir, basename, ['.mp3'], directories.get(externalAudioDir));
      const audioPath = localAudioPath || externalAudioPath;
      const videoPath = findSibling(dirPath, basename, ['.mp4'], listing);
      const pdfPath   = findSibling(dirPath, basename, ['.pdf'], listing);

      const relImg   = imgPath   ? path.relative(WWW_DIR, imgPath).replace(/\\/g, '/')   : null;
      const relAudio = audioPath
        ? path.relative(localAudioPath ? WWW_DIR : AUDIO_DIR, audioPath).replace(/\\/g, '/')
        : null;
      const relVideo = videoPath ? path.relative(WWW_DIR, videoPath).replace(/\\/g, '/') : null;
      const relPdf   = pdfPath   ? path.relative(WWW_DIR, pdfPath).replace(/\\/g, '/')   : null;

      // categories = unified taxonomy labels (for filtering); tags = raw Kategorien field (display only)
      const tags = (parsed.tags || []).slice(0, 10);
      // Der Titel zählt bei der Kategorisierung stärker als der übrige Text.
      const categories = mergeCategories(tags, autoCategorize((parsed.summary || '') + ' ' + parsed.body, parsed.title));

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
    const blog = archive.articleById.get(decision.blogId);
    const facebook = archive.articleById.get(decision.facebookId);
    if (!blog || !facebook) continue;
    if (blog.author !== duplicateConfig.blogAuthor || !duplicateConfig.facebookAuthors.includes(facebook.author)) continue;
    nextCanonical.set(facebook.id, blog.id);
  }
  archive.duplicateCanonicalOf = nextCanonical;
  archive.duplicateCandidates = duplicateDetection.candidates(archive.articles, duplicateConfig).candidates.filter(candidate => {
    if (archive.duplicateCanonicalOf.has(candidate.facebook.id)) return false;
    const decision = duplicateStore.find(candidate.blog.id, candidate.facebook.id);
    return !decisionStillApplies(decision, candidate.blog, candidate.facebook);
  });
}

function duplicateCanonicalFor(article, user = null) {
  const canonical = archive.articleById.get(archive.duplicateCanonicalOf.get(article?.id));
  if (!canonical) return null;
  if (user && !canAccessAuthor(user, canonical.author)) return null;
  return canonical;
}

// Anker der Gruppe, zu der eine Infografik gehört – nur wenn der Nutzer ihn sehen
// darf. Sonst (z. B. Gast ohne Recht am Artikel) bleibt die Infografik einzeln.
function visibleGroupAnchor(article, user, { hideTelegram = false } = {}) {
  const anchor = archive.articleById.get(archive.groupAnchorOf.get(article?.id));
  if (!anchor || !canAccessAuthor(user, anchor.author)) return null;
  if (hideTelegram && anchor.author === TELEGRAM_AUTHOR) return null;
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
  const members = (archive.infographicGroups.get(anchor.id) || [])
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

// Reindex-Status für Voll- und Teil-Reindex: läuft (sofort, damit die Sperre
// greift), fertig mit der Artikelzahl des neuen Index oder fertig mit Fehler.
async function withReindexState(articleCount, task) {
  reindexState = { running: true, processed: 0, articles: articleCount, done: false };
  try {
    const result = await task();
    reindexState = { running: false, processed: archive.articles.length, articles: archive.articles.length, done: true };
    return result;
  } catch (error) {
    reindexState = { ...reindexState, running: false, done: true, error: error.message };
    throw error;
  }
}

function buildIndex() {
  return withReindexState(0, rebuildIndex);
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

  archive.sourceArticles = nextSourceArticles;
  archive.articles = nextArticles;
  archive.infographicGroups = groups;
  archive.groupAnchorOf = anchorOf;
  archive.articleById = nextById;
  archive.meta = nextMeta;
  archive.fuseIndex = nextFuseIndex;
  refreshDuplicateState();
}

// Vom Scraper gemeldete Markdown-Dateien einzeln einlesen und anschließend
// gemeinsam veröffentlichen. Ein gültiges leeres Manifest bedeutet, dass der
// Scraper nichts geändert hat und gar kein Neuindex nötig ist.
async function refreshScrapedMarkdownFiles(filenames) {
  const uniqueFiles = [...new Set((filenames || []).map(filename => path.resolve(String(filename))))];
  if (!uniqueFiles.length) return;
  if (!archive.sourceArticles.length) return buildIndex();

  const t0 = Date.now();
  await withReindexState(archive.articles.length, async () => {
    const replacements = [];
    for (const filename of uniqueFiles) {
      if (path.extname(filename).toLowerCase() !== '.md' || !isPathInside(WWW_DIR, filename)) {
        throw new Error('Der Scraper hat einen ungültigen Artikelpfad gemeldet.');
      }
      const relative = path.relative(WWW_DIR, filename);
      const segments = relative.split(path.sep);
      const author = segments.shift();
      if (!author || !segments.length) throw new Error('Der Scraper-Artikel hat keinen gültigen Autorpfad.');
      const year = yearFromRelativeDir(path.dirname(segments.join(path.sep)));
      const scanned = [];
      await scanDir(path.dirname(filename), author, year, scanned, { strict: true, targetFile: filename });
      const replacement = scanned.find(article => path.resolve(article.filePath) === filename);
      if (!replacement) throw new Error(`Scraper-Artikel „${relative}“ konnte nicht eingelesen werden.`);
      replacements.push(replacement);
    }
    publishArticleIndex(upsertArticleIndexEntries(archive.sourceArticles, replacements));
    console.log(`[OK] ${replacements.length} Scraper-Artikel gezielt neu eingelesen (${Date.now() - t0}ms)`);
  });
}

async function republishArticleIndex() {
  if (!archive.sourceArticles.length) return buildIndex();
  const t0 = Date.now();
  publishArticleIndex(archive.sourceArticles);
  console.log(`[OK] Artikelverknuepfungen aus dem Speicher aktualisiert (${Date.now() - t0}ms)`);
}

// Nach einer Editor-Änderung nur die betroffene Markdown-Datei erneut von der
// Platte lesen. Verknüpfungen, Metadaten, Suche und Duplikatstatus werden danach
// aus dem vorhandenen Rohindex im Speicher neu abgeleitet; andere Dateien und
// die Hörbuchbibliothek werden nicht erneut gescannt.
async function refreshMarkdownIndex({ id, filename } = {}) {
  if (!id || !filename) return buildIndex();

  const t0 = Date.now();
  await withReindexState(archive.articles.length, async () => {
    if (isPathInside(AUDIO_DIR, filename)) {
      await audiobooks.refresh(id);
      console.log(`[OK] Hoerbuch "${id}" gezielt aktualisiert (${Date.now() - t0}ms)`);
      return;
    }
    if (!isPathInside(WWW_DIR, filename)) throw new Error('Der bearbeitete Artikel liegt außerhalb des Archivs.');
    if (!archive.sourceArticles.length) return buildIndex();

    const current = archive.sourceArticles.find(article => article.id === id);
    if (!current) return buildIndex();
    if (path.resolve(current.filePath) !== path.resolve(filename)) {
      throw new Error(`Artikel „${id}“ verweist auf einen unerwarteten Dateipfad.`);
    }

    const year = yearFromRelativeDir(path.relative(path.join(WWW_DIR, current.author), path.dirname(filename)));
    const scanned = [];
    await scanDir(path.dirname(filename), current.author, year, scanned, { strict: true, targetFile: filename });
    const replacement = scanned.find(article => article.id === id);
    publishArticleIndex(replaceArticleIndexEntry(archive.sourceArticles, id, replacement));
    console.log(`[OK] Artikel "${id}" gezielt neu eingelesen (${Date.now() - t0}ms)`);
  });
}

async function refreshInfographicsForYears(years) {
  const uniqueYears = [...new Set(years)];
  if (!uniqueYears.length) return;
  if (uniqueYears.some(year => !/^\d{4}$/.test(year))) throw new Error('Ungültiges Infografik-Jahr.');
  if (!archive.sourceArticles.length) return buildIndex();
  const t0 = Date.now();
  await withReindexState(0, async () => {
    let nextSourceArticles = archive.sourceArticles;
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
    console.log(`[OK] Infografiken ${uniqueYears.join(', ')} neu eingelesen (${scannedCount} Eintraege, ${Date.now() - t0}ms)`);
  });
}

async function refreshInfographicsForYear(year) {
  return refreshInfographicsForYears([year]);
}

async function rebuildIndex() {
  console.log('Building article index...');
  const t0 = Date.now();
  const collector = [];

  let authorDirs;
  try {
    authorDirs = (await fs.promises.readdir(WWW_DIR, { withFileTypes: true })).filter(d => d.isDirectory());
  } catch (err) {
    console.error('Cannot read www directory:', err.message);
    throw err;
  }

  // Ein gemeinsamer Verzeichnis-Cache für den ganzen Scan (frisch je Reindex).
  const directories = createDirectoryCache();
  for (const dir of authorDirs) {
    await scanDir(path.join(WWW_DIR, dir.name), dir.name, null, collector, { directories });
  }

  // Deduplicate by id (orig/ subdirs may duplicate files).
  // Hörbücher werden nur beim vollständigen Neuindex erneut eingelesen.
  await audiobooks.rebuild();
  publishArticleIndex(uniqueArticles(collector));
  console.log(`[OK] ${archive.articles.length} articles, ${audiobooks.books.length} audiobooks indexed in ${Date.now() - t0}ms`);
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
    (article.author !== INFOGRAPHICS_AUTHOR || !archive.groupAnchorOf.has(article.id)) &&
    !conflictingInfographicBase(article)
  );
}

function conflictingInfographicBase(article, byId = archive.articleById, anchorOf = archive.groupAnchorOf) {
  if (article.author === INFOGRAPHICS_AUTHOR) return false;
  const year = article.year || article.date?.slice(0, 4) || '';
  const stem = path.basename(article.filePath, '.md');
  const base = byId.get([INFOGRAPHICS_AUTHOR, year, stem].join('/'));
  return !!base && anchorOf.get(base.id) !== article.id;
}

function firstAvailableInfographicOrdinal(article, byId = archive.articleById, anchorOf = archive.groupAnchorOf) {
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

const DUPLICATE_MEDIA_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.mp3', '.mp4', '.pdf']);

function duplicateInfographicViews(article) {
  return (archive.infographicGroups.get(article.id) || [])
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
  const blog = archive.articleById.get(blogId);
  const facebook = archive.articleById.get(facebookId);
  if (!blog || !facebook) throw httpError(404, 'Einer der Artikel wurde nicht gefunden.');
  if (blog.author !== duplicateConfig.blogAuthor || !duplicateConfig.facebookAuthors.includes(facebook.author)) {
    throw httpError(400, 'Diese Autoren können nicht als Blog-/Quellen-Dublette verknüpft werden.');
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
  const requested = archive.articleById.get(id);
  if (!requested) throw httpError(404, 'Artikel nicht gefunden.');
  const article = duplicateCanonicalFor(requested, user) || requested;
  if (!canUploadInfographic(user, article)) throw httpError(403, 'Keine Berechtigung für diese Infografiken.');
  const year = article.year || article.date?.slice(0, 4) || '';
  if (!/^\d{4}$/.test(year)) throw httpError(400, 'Der Artikel hat kein gültiges Jahr.');
  const dir = resolveUnder(WWW_DIR, INFOGRAPHICS_AUTHOR, year);
  const baseStem = path.basename(article.filePath, '.md');
  if (!dir || !baseStem) throw httpError(400, 'Kein gültiges Infografik-Ziel gefunden.');
  const members = (archive.infographicGroups.get(article.id) || []).filter(item => item.ownImage);
  const bundles = members.map(item => {
    if (item.author !== INFOGRAPHICS_AUTHOR || path.resolve(path.dirname(item.filePath)) !== dir
      || item.infographicBase !== baseStem) {
      throw httpError(409, 'Eine Grafik gehört nicht zu den verwaltbaren Artikel-Infografiken.');
    }
    const files = filesForInfographic(item);
    const imageFiles = files.filter(file => ['.png', '.jpg', '.jpeg'].includes(path.extname(file).toLowerCase()));
    if (files.length !== 2 || imageFiles.length !== 1 || !files.includes(item.filePath)) {
      throw httpError(409, 'Eine Infografik hat zusätzliche oder unvollständige Dateien und kann nicht automatisch verwaltet werden.');
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

async function setManagedInfographicInstagramPoster(item, enabled) {
  if (typeof enabled !== 'boolean') throw httpError(400, 'Der Instagram-Poster-Wert ist ungültig.');
  const original = await fs.promises.readFile(item.mdPath, 'utf8');
  const updated = setInstagramPosterMetadata(original, enabled);
  if (updated === original) return async () => {};
  return moveInfographicFiles([{ source: item.mdPath, target: item.mdPath, content: updated }]);
}

async function prepareInfographicPosterBatch(changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 2000) {
    throw httpError(400, 'Bitte mindestens eine und höchstens 2000 Änderungen senden.');
  }
  const seen = new Set();
  const mappings = [];
  const years = new Set();
  const updated = [];
  const root = path.join(WWW_DIR, INFOGRAPHICS_AUTHOR);

  for (const change of changes) {
    const id = typeof change?.id === 'string' ? change.id : '';
    if (!id || seen.has(id) || typeof change.enabled !== 'boolean'
        || (change.expected !== undefined && typeof change.expected !== 'boolean')) {
      throw httpError(400, 'Eine Poster-Änderung ist ungültig oder doppelt enthalten.');
    }
    seen.add(id);
    const article = archive.articleById.get(id);
    const mdPath = article?.filePath ? path.resolve(article.filePath) : '';
    if (!article || article.author !== INFOGRAPHICS_AUTHOR || !article.ownImage
        || !isPathInside(root, mdPath) || path.extname(mdPath).toLowerCase() !== '.md') {
      throw httpError(404, 'Infografik nicht gefunden: ' + id);
    }
    const current = article.instagramPoster === true;
    if (change.expected !== undefined && change.expected !== current) {
      throw httpError(409, 'Die Poster-Markierung wurde zwischenzeitlich geändert. Bitte die Ansicht neu laden.');
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

async function reorderManagedInfographics(context, orderedIds) {
  const { bundles, baseStem, dir } = context;
  if (!Array.isArray(orderedIds) || orderedIds.length !== bundles.length
    || new Set(orderedIds).size !== bundles.length
    || orderedIds.some(id => !bundles.some(item => item.id === id))) {
    throw httpError(400, 'Die Reihenfolge enthält nicht genau die vorhandenen Infografiken.');
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
    if (nextOrdinal >= 1000) throw httpError(409, 'Keine freien Infografik-Dateinamen gefunden.');
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
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw httpError(409, 'Der Infografik-Papierkorb ist kein sicherer Ordner.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.promises.mkdir(dir);
    }
    const real = await fs.promises.realpath(dir);
    if (!isPathInside(root, real)) throw httpError(403, 'Der Papierkorb liegt außerhalb des Infografik-Ordners.');
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
  throw httpError(409, 'Kein freier Platz im Infografik-Papierkorb gefunden.');
}

function nextDuplicateInfographicTarget(blog, reserved) {
  if (conflictingInfographicBase(blog)) {
    throw httpError(409, 'Unter diesem Dateistamm existiert eine eigenständige oder anders zugeordnete Infografik.');
  }
  const year = blog.year || blog.date?.slice(0, 4) || '';
  if (!/^\d{4}$/.test(year)) throw httpError(400, 'Der Blogartikel hat kein gültiges Jahr.');
  const dir = resolveUnder(WWW_DIR, INFOGRAPHICS_AUTHOR, year);
  if (!dir) throw httpError(400, 'Kein gültiges Infografik-Ziel gefunden.');
  const baseStem = path.basename(blog.filePath, '.md');
  for (let ordinal = firstAvailableInfographicOrdinal(blog); ordinal < 1000; ordinal++) {
    const stem = infographicAttachmentStem(baseStem, ordinal);
    if (!reserved.has(stem.toLowerCase()) && !infographicStemExists(dir, stem)) {
      reserved.add(stem.toLowerCase());
      return { dir, stem, ordinal };
    }
  }
  throw httpError(409, 'Es konnte kein freier Infografik-Dateiname gefunden werden.');
}

function planDuplicateMigration(blog, facebook) {
  const bundles = [];
  for (const info of archive.infographicGroups.get(facebook.id) || []) {
    if (!info.ownImage) continue;
    if (info.hasBody) throw httpError(409, `„${info.title}“ enthält eigenen Text und wird nicht automatisch migriert.`);
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
  if (!header.hasTitle || !header.date) throw httpError(400, 'Der Blogartikel hat keinen gültigen Titel- und Datumskopf.');

  const moved = [];
  const created = [];
  const overwrittenMarkdown = [];
  const archiveRoot = await fs.promises.realpath(WWW_DIR);
  const isInsideArchive = file => isPathInside(archiveRoot, file);
  // Jeder Schritt läuft auch, wenn ein früherer scheitert; Fehler stehen im Log.
  const logFailure = label => error => console.error(`Dubletten-Migration zurückrollen (${label}):`, error);
  const rollback = async () => {
    for (const file of [...created].reverse()) await fs.promises.unlink(file).catch(logFailure(file));
    for (const item of [...overwrittenMarkdown].reverse()) {
      await writeFileAtomic(item.path, item.content).catch(logFailure(item.path));
    }
    for (const mapping of [...moved].reverse()) {
      await fs.promises.rename(mapping.target, mapping.source).catch(logFailure(mapping.target));
    }
  };
  try {
    for (const bundle of plan) {
      await fs.promises.mkdir(bundle.dir, { recursive: true });
      const realTargetDir = await fs.promises.realpath(bundle.dir);
      if (!isInsideArchive(realTargetDir)) throw httpError(403, 'Das Infografik-Ziel liegt außerhalb des Archivs.');
      for (const mapping of bundle.mappings) {
        const source = path.resolve(mapping.source);
        const target = path.resolve(mapping.target);
        if (!isPathInside(WWW_DIR, source) || !isPathInside(WWW_DIR, target)) {
          throw httpError(403, 'Ein Medienpfad liegt außerhalb des Archivs.');
        }
        const stat = await fs.promises.lstat(source);
        if (stat.isSymbolicLink() || !stat.isFile()) throw httpError(409, 'Symbolische Links können nicht migriert werden.');
        const realSource = await fs.promises.realpath(source);
        if (!isInsideArchive(realSource)) throw httpError(403, 'Eine Quelldatei liegt außerhalb des Archivs.');
        try { await fs.promises.access(target); throw httpError(409, `Zieldatei existiert bereits: ${path.basename(target)}`); }
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
        await writeFileAtomic(mdTarget, buildInfographicMarkdown(blogContent, bundle.ordinal));
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
  sendApiError(res, 'not_authenticated');
}

function requireAdmin(req, res, next) {
  if (req.session?.user?.role === 'admin') return next();
  sendApiError(res, 'admin_required');
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
    if (isCrossSite(req)) return sendApiError(res, 'cross_site');
    const origin = req.get('origin');
    const expectedOrigin = `${req.protocol}://${req.get('host')}`;
    if (origin && origin !== expectedOrigin) return sendApiError(res, 'invalid_origin');
    // Veraltetes Token (z. B. Seite aus einer früheren Sitzung): die Oberfläche lädt neu.
    if (!sameStringSecret(req.get('x-csrf-token'), req.session.adminCsrfToken)) {
      return sendApiError(res, 'csrf_invalid');
    }
    next();
  });
}

// Beide Shell-Varianten werden nur neu gebaut, wenn sich index.html oder ein darin
// geladenes Skript/Stylesheet ändert; die ?v=-Cache-Buster setzt createVersionedIndex
// automatisch. Pro Anfrage kommt lediglich das sitzungsgebundene CSRF-Token hinzu.
const indexShells = createVersionedIndex(INDEX_FILE, html => ({
  admin: html.split(/\r?\n/)
    .filter(line => !line.includes('data-non-admin-asset'))
    .join('\n'),
  standard: html.replace(/<!-- ADMIN_ONLY_START -->[\s\S]*?<!-- ADMIN_ONLY_END -->/g, '')
    .split(/\r?\n/)
    .filter(line => !line.includes('data-admin-only') && !line.includes('data-admin-asset'))
    .join('\n')
    .replace('<!-- ADMIN_CSRF_META -->', ''),
}));

function renderIndexForSession(req) {
  const shells = indexShells();
  if (!isAdminUiSession(req)) return shells.standard;
  return shells.admin.replace('<!-- ADMIN_CSRF_META -->',
    `<meta name="admin-csrf-token" content="${adminCsrfToken(req)}">`);
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
    return sendApiError(res, 'not_authenticated');
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
// Im Dienst überstehen Sitzungen einen Neustart (sessions.json); Tests und
// Messskripte, die server.js nur laden, bleiben beim flüchtigen Speicher.
const sessionStore = require.main === module
  ? new FileSessionStore({ file: process.env.SESSIONS_FILE || path.join(__dirname, 'sessions.json') })
  : undefined;
app.use(session({
  secret: resolveSessionSecret({ strict: require.main === module }),
  store: sessionStore,
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
    return sendApiError(res, 'password_change_required', { mustChangePassword: true });
  }
  next();
});
installCspReportRoute(app, express);

// Der Worker cached selbst keine Dateien. Sein automatisch berechneter Inhalt ändert
// sich aber bei jeder Änderung der App-Shell und löst damit den Update-Hinweis aus.
const appShellVersion = createAppShellVersion();
app.get('/service-worker.js', (_req, res) => {
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Service-Worker-Allowed': '/',
  });
  res.type('application/javascript').send(serviceWorkerSource(appShellVersion()));
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
  // Dieselbe Prüfung wie /files/* und /audio-files/* (keine Punktsegmente).
  return resolveMediaRequest(root, rel)?.absPath || null;
}

function ogDescription(article) {
  const raw = (article.summary || article.excerpt || '').replace(/\s+/g, ' ').trim();
  return raw.length > 200 ? raw.slice(0, 197).trimEnd() + '…' : raw;
}

function publicShareItem(id) {
  const article = archive.articleById.get(id);
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
    ? archive.meta.authors
    : archive.meta.authors.filter(a => user.allowedAuthors.includes(a));
  res.json({ authors, years: archive.meta.years, categories: archive.meta.categories });
});

// Nur die Admin-Oberfläche fragt den Status ab (admin-tasks.js).
app.get('/api/reindex/status', requireAdminAccess, (_req, res) => res.json(reindexState));

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
  const absPath = path.resolve(PROMPTS_DIR, file);
  if (!isPathInside(PROMPTS_DIR, absPath)) return res.status(400).end();
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
  // Ein laufender Reindex ist bei der Sperre registriert; die 409-Antwort nennt ihn.
  if (archiveLock.busy) return sendArchiveBusy(res, archiveLock, { started: false });
  // withReindexState setzt reindexState.running synchron und belegt damit die Sperre.
  buildIndex().catch(console.error);
  res.json({ started: true });
});

app.get('/api/infographic-manager/*', requireAdminAccess, (req, res) => {
  // Nur während exklusiver Dateiänderungen (z. B. Umbenennen) nicht lesen;
  // ein laufender Scrape oder eine Audio-Erzeugung stört das Öffnen nicht.
  if (archiveLock.holder) {
    return res.status(409).json({ error: `Es läuft gerade: ${archiveLock.holder}. Bitte gleich erneut öffnen.` });
  }
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
    sendRouteError(res, error, { label: 'Infografik-Verwaltung', fallback: 'Infografiken konnten nicht geladen werden.' });
  }
});

app.post('/api/infographic-manager/*', requireAdminAccess, async (req, res) => {
  const release = archiveLock.tryAcquire('Infografiken ändern');
  if (!release) return sendArchiveBusy(res, archiveLock);
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
      if (!item) throw httpError(404, 'Infografik nicht gefunden.');
      undoInstagramPoster = await setManagedInfographicInstagramPoster(item, req.body.enabled);
    } else if (req.body?.action === 'trash') {
      const item = context.bundles.find(bundle => bundle.id === req.body.id);
      if (!item) throw httpError(404, 'Infografik nicht gefunden.');
      trashFolder = await infographicTrashFolder(context.year);
      undoTrash = await moveInfographicFiles(item.files.map(source => ({
        source, target: path.join(trashFolder, path.basename(source)),
      })));
      const remaining = context.bundles.filter(bundle => bundle.id !== item.id);
      undoOrder = await reorderManagedInfographics(
        { ...context, bundles: remaining }, remaining.map(bundle => bundle.id));
    } else {
      throw httpError(400, 'Unbekannte Infografik-Aktion.');
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
    sendRouteError(res, error, {
      label: 'Infografik-Verwaltung', fallback: 'Infografiken konnten nicht geändert werden.', rollbackError,
    });
  } finally {
    release();
  }
});

// Admin-Prüfmodus: Änderungen über beliebig viele Ergebnisseiten sammeln und
// in einem atomaren Dateivorgang speichern. Anschließend werden ausschließlich
// die tatsächlich betroffenen Infografik-Jahrgänge neu eingelesen.
app.post('/api/infographic-review', requireAdminAccess, async (req, res) => {
  const release = archiveLock.tryAcquire('Infografik-Prüfung speichern');
  if (!release) return sendArchiveBusy(res, archiveLock);
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
    return sendRouteError(res, error, {
      label: 'Infografik-Prüfung', fallback: 'Poster-Markierungen konnten nicht gespeichert werden.', rollbackError,
    });
  } finally {
    release();
  }
});

app.post(
  '/api/infographics/*',
  requireAdminAccess,
  express.raw({ type: ['image/png', 'image/jpeg'], limit: INFOGRAPHIC_MAX_BYTES }),
  async (req, res) => {
    if (archiveLock.busy) return sendArchiveBusy(res, archiveLock);
    const id = req.params[0];
    const requested = archive.articleById.get(id);
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

    // Zwischen Prüfung oben und hier liegt nur synchroner Code; die Sperre ist frei.
    const release = archiveLock.tryAcquire('Infografik hochladen');
    if (!release) return sendArchiveBusy(res, archiveLock);
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
      sendRouteError(res, err, { label: 'Infografik hochladen', fallback: 'Infografik konnte nicht gespeichert werden.' });
    }
    } finally { release(); }
  }
);

// ─── Neue eigenständige Infografik (Admin, Aktionen-Menü) ───────────────────
//
// Markdown + Bild in einer Anfrage (Bild base64 in JSON, keine Zusatz-Abhängigkeit).
// Dateiname: <Datum>_<Slug aus dem Titel>; Konflikt → -2, -3 … (nicht _2, das
// bedeutet „Variante“). Unveränderte Platzhalter der Vorlage werden entfernt.

app.post('/api/new-infographic', requireAdminAccess, async (req, res) => {
  if (archiveLock.busy) return sendArchiveBusy(res, archiveLock);
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

  // Zwischen Prüfung oben und hier liegt nur synchroner Code; die Sperre ist frei.
  const release = archiveLock.tryAcquire('Neue Infografik speichern');
  if (!release) return sendArchiveBusy(res, archiveLock);
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
    sendRouteError(res, err, { label: 'Neue Infografik', fallback: 'Infografik konnte nicht gespeichert werden.' });
  } finally { release(); }
});

function duplicateDecisionView(decision) {
  const blog = archive.articleById.get(decision.blogId);
  const facebook = archive.articleById.get(decision.facebookId);
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

// Nach gespeicherten Verknüpfungen: Lesezeichen umziehen, dann nur die betroffenen
// Infografik-Jahrgänge (oder bloß den Dublettenstatus) neu ableiten. Liefert einen
// Hinweis, falls die Lesezeichen nicht umgezogen werden konnten.
function finishLinkedDuplicates(linked) {
  return finishDuplicateLinks({
    replacements: linked.map(item => ({ oldId: item.facebookId, newId: item.blogId })),
    migrations: linked.flatMap(item => item.migrations),
    bookmarks,
    refreshMigrations: migrations => refreshInfographicsForYears(infographicYearsFromMigrations(migrations)),
    refreshState: refreshDuplicateState,
  });
}

app.get('/api/duplicates', requireAdminAccess, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const decisions = duplicateStore.all();
  const pending = archive.duplicateCandidates.map(candidate => ({
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

app.get('/api/duplicates/compare', requireAdminAccess, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { blog, facebook } = duplicatePair(String(req.query.blogId || ''), String(req.query.facebookId || ''));
    const read = async article => ({ ...duplicateArticleView(article), ...await articleBodies.get(article.filePath) });
    let migration = [];
    let migrationUnavailable = '';
    try { migration = publicMigrationPlan(planDuplicateMigration(blog, facebook)); }
    catch (error) { migrationUnavailable = error.message; }
    const [blogView, facebookView] = await Promise.all([read(blog), read(facebook)]);
    res.json({ blog: blogView, facebook: facebookView, migration, migrationUnavailable });
  } catch (error) {
    sendRouteError(res, error, { label: 'Dublettenvergleich', fallback: 'Der Vergleich konnte nicht geladen werden.' });
  }
});

app.post('/api/duplicates/batch', requireAdminAccess, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (archiveLock.busy) return sendArchiveBusy(res, archiveLock);
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
        throw httpError(400, 'Ein Quellartikel darf nur einmal in einer Sammelaktion vorkommen.');
      }
      facebookIds.add(item.facebookId);
    }
  } catch (error) {
    return sendRouteError(res, error, { label: 'Dubletten-Sammelaktion', fallback: 'Die Auswahl konnte nicht geprüft werden.' });
  }

  // Zwischen Prüfung oben und hier liegt nur synchroner Code; die Sperre ist frei.
  const release = archiveLock.tryAcquire('Dubletten-Sammelaktion');
  if (!release) return sendArchiveBusy(res, archiveLock);
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
    const warning = await finishLinkedDuplicates(prepared);
    const migrations = prepared.flatMap(item => item.migrations);
    return res.json({ ok: failed.length === 0, linked: prepared.length, failed, migrations, ...(warning ? { warning } : {}) });
  } catch (error) {
    return sendRouteError(res, error, { label: 'Dubletten-Sammelaktion', fallback: 'Die Sammelaktion ist fehlgeschlagen.' });
  } finally {
    release();
  }
});

app.post('/api/duplicates', requireAdminAccess, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const release = archiveLock.tryAcquire('Dublettenaktion');
  if (!release) return sendArchiveBusy(res, archiveLock);
  const action = String(req.body?.action || '');
  const blogId = String(req.body?.blogId || '');
  const facebookId = String(req.body?.facebookId || '');
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
    if (!['link', 'migrate'].includes(action)) throw httpError(400, 'Unbekannte Dublettenaktion.');
    const existing = duplicateStore.find(blogId, facebookId);
    if (action === 'migrate' && existing?.status !== 'linked') {
      throw httpError(409, 'Grafiken können erst nach dem Verknüpfen migriert werden.');
    }
    const result = await linkDuplicatePair({
      blogId, facebookId,
      userEmail: req.session.user.email,
      migrateImages: !!req.body?.migrateImages || action === 'migrate',
    });
    const warning = await finishLinkedDuplicates([result]);
    return res.json({ ok: true, migrations: result.migrations, ...(warning ? { warning } : {}) });
  } catch (error) {
    return sendRouteError(res, error, { label: 'Dublettenverwaltung', fallback: 'Die Dublettenaktion ist fehlgeschlagen.' });
  } finally {
    release();
  }
});

// Ungültige Werte (z. B. page=abc) ergaben früher NaN und damit eine leere Seite.
function paginationParams(page, limit) {
  return {
    page: Math.max(1, parseInt(page, 10) || 1),
    limit: Math.min(100, Math.max(1, parseInt(limit, 10) || 24)),
  };
}

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
  let filtered = archive.articles;

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
  const hideTelegram = telegram !== '1' && author !== TELEGRAM_AUTHOR && !onlyBookmarks;
  if (hideTelegram) {
    filtered = filtered.filter(a => a.author !== TELEGRAM_AUTHOR);
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
    const { dateConstraints, text } = parseArticleSearchQuery(q, archive.meta.years);
    // Datums-Tokens als Filter anwenden (AND)
    for (const dq of dateConstraints) {
      filtered = dq.kind === 'exact'
        ? filtered.filter(a => a.date === dq.value)
        : filtered.filter(a => a.date && a.date.startsWith(dq.value));
    }
    // Restlicher Text über Fuse, auf die gefilterte Teilmenge eingeschränkt. Ohne
    // Trefferlimit: Ein Limit vor dem Filtern ließ bei allgemeinen Begriffen
    // Treffer des gewählten Autors wegfallen; schneller war es nicht.
    if (text && archive.fuseIndex) {
      const filteredIds = new Set(filtered.map(a => a.id));
      const results = archive.fuseIndex.search(text);
      filtered = results.filter(r => filteredIds.has(r.item.id)).map(r => r.item);
    }
  }

  const { page: p, limit: lim } = paginationParams(page, limit);

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

app.get('/api/articles/*', attachUser, async (req, res) => {
  const id = req.params[0];
  const requested = archive.articleById.get(id);
  if (!requested) return sendApiError(res, 'not_found');

  const canonical = duplicateCanonicalFor(requested, req.user);
  const visibleRequested = canonical || requested;
  if (!canAccessAuthor(req.user, visibleRequested.author)) {
    return sendApiError(res, 'forbidden');
  }
  // Eine gruppierte Infografik öffnet ihre Gruppe; requestedId sagt, welches Bild gemeint war.
  const anchor = visibleGroupAnchor(visibleRequested, req.user);
  const article = anchor || visibleRequested;

  try {
    const { bodyHtml } = await articleBodies.get(article.filePath);
    const rest = exposeGroupForUser(article, req.user);
    res.json({
      ...rest, bodyHtml, canUploadInfographic: canUploadInfographic(req.user, article),
      bookmarked: bookmarks.has(req.user.email, article.id),
      ...((anchor || canonical) ? { requestedId: id } : {}),
    });
  } catch (err) {
    // Datei inzwischen entfernt: bis zum nächsten Reindex wie „nicht gefunden“ behandeln.
    if (err.code === 'ENOENT') return sendApiError(res, 'not_found');
    console.error(`Artikel ${id}:`, err);
    res.status(500).json({ error: 'Der Artikel konnte nicht geladen werden.' });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────

installTtsRoutes(app, requireAdminAccess, ttsJobs, undefined, ttsVoiceSettings);
installMarkdownRoutes(app, requireAdminAccess, markdownEditor);
installScrapeRoutes(app, { requireAdmin: requireAdminAccess, job: scrapeJob, lock: archiveLock });
installUserRoutes(app, {
  store: userStore, requireAuth, requireAdmin: requireAdminAccess, getAuthors: () => archive.meta.authors,
  passwordLimiter: loginLimiter,
  onUserDeleted: email => Promise.all([audiobookProgress.removeUser(email), bookmarks.removeUser(email)]),
  onAuthorPriorityChanged: republishArticleIndex,
});
installBookmarkRoutes(app, {
  store: bookmarks, requireAuth, getArticle: id => archive.articleById.get(id), canAccessAuthor,
});
installAudiobookRoutes(app, {
  library: audiobooks, progress: audiobookProgress, config: audiobookConfig,
  requireAuth, requireAdmin: requireAdminAccess, canAccessAuthor,
  exclusive: (label, task) => archiveLock.run(label, task),
});

function handleRequestError(err, req, res, next) {
  if (req.path.startsWith('/api/audiobook-extra-upload/') && err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Die Datei ist größer als 20 MB.' });
  }
  const isArticle = req.path.startsWith('/api/article-markdown/');
  const isExtra = req.path.startsWith('/api/audiobook-extra-source/') || req.path.startsWith('/api/audiobook-extra-create/');
  if (isArticle || isExtra) {
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: `Die Anfrage ist zu groß. ${isArticle ? 'Artikel' : 'Markdown-Extras'} dürfen höchstens 1 MB enthalten.` });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ungültige Speicheranfrage.' });
  }
  if (err?.type === 'entity.too.large') {
    const message = req.path.startsWith('/api/infographics/') || req.path.startsWith('/api/new-infographic')
      ? 'Die Bilddatei ist größer als 10 MB.'
      : req.path.startsWith('/api/tts/voices')
        ? 'Die Aufnahme ist größer als 10 MB.'
        : 'Die Anfrage ist zu groß.';
    return res.status(413).json({ error: message });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ungültige Anfrage.' });
  // Alle übrigen Fehler: API-Aufrufe erhalten JSON ohne interne Details (Stacktrace,
  // Pfade); die Ursache steht im Dienst-Log. Andere Pfade behandelt Express selbst.
  if (!req.path.startsWith('/api/') || res.headersSent) return next(err);
  if (err?.status >= 400 && err.status < 500) return res.status(err.status).json({ error: 'Ungültige Anfrage.' });
  console.error(`${req.method} ${req.path}:`, err);
  sendApiError(res, 'internal');
}
app.use(handleRequestError);

if (require.main === module) {
  // Reindex ohne Neustart: SIGHUP löst einen Index-Neuaufbau aus – der Prozess
  // läuft weiter, bestehende Sessions bleiben erhalten. Aus Cron als derselbe
  // User (ralf) ohne sudo aufrufbar:
  //   kill -HUP "$(systemctl show -p MainPID --value nodeapp)"
  // Läuft beim Signal noch ein Auftrag (z. B. Audio-Erzeugung), wird der Reindex
  // nachgeholt, sobald das Archiv frei ist; früher entfiel er dann bis zum nächsten Tag.
  process.on('SIGHUP', () => {
    console.log('SIGHUP empfangen -> Reindex');
    const scheduled = archiveLock.whenIdle(() => buildIndex().catch(console.error), {
      onWait: current => console.warn(`SIGHUP-Reindex wartet auf: ${current} (neuer Versuch alle 30 s)`),
    });
    if (!scheduled) console.log('SIGHUP-Reindex ist bereits vorgemerkt.');
  });

  buildIndex().catch(console.error);
  const server = app.listen(PORT, () => {
    console.log(`WebArchiv -> http://localhost:${PORT}`);
  });

  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    await ttsJobs.shutdown();
    await sessionStore?.close().catch(() => {});
    process.exit(0);
  });
}

module.exports = {
  app, resolveSessionSecret, parseTrustProxy, extractSourceUrl,
  // Für Tests und Messskripte: vollständiger Scan und der unverknüpfte Rohindex.
  buildIndex, indexedSourceArticles: () => archive.sourceArticles,
  createDirectoryCache, findSibling, paginationParams,
  parseArticle, linkInfographics, buildArticleSearchIndex, parseArticleSearchQuery,
  articleDisplayAuthor,
  replaceInfographicYearArticles, replaceArticleIndexEntry, upsertArticleIndexEntries,
  infographicYearsFromMigrations, parseScraperChangedFiles, prepareLinkedArticles,
  buildInfographicMarkdown, removeCategoryLines, slugify,
  normalizeNewInfographicMarkdown, mergeCategories, parsePromptDefinition,
  computeAppShellVersion, serviceWorkerSource,
  renderIndexForSession, requireAdminAccess, handleRequestError,
  infographicAttachmentStem, firstAvailableInfographicOrdinal,
  canUploadInfographic, conflictingInfographicBase, retitleInfographicMarkdown,
  moveInfographicFiles, reorderManagedInfographics,
  setInstagramPosterMetadata, setManagedInfographicInstagramPoster,
};
