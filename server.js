const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { renderSafeMarkdown } = require('./lib/html-sanitizer.cjs');
const session = require('express-session');
const { createTtsJobs, installTtsRoutes } = require('./tts/jobs.cjs');
const { createTtsVoiceSettings, MAX_AUDIO_BYTES: TTS_VOICE_MAX_BYTES } = require('./tts/voice-settings.cjs');
const { createMarkdownEditor, installMarkdownRoutes } = require('./modules/article-editor.cjs');
const { createUserStore, installUserRoutes } = require('./modules/user-store.cjs');
const {
  AUDIOBOOK_AUTHOR, createAudiobookLibrary, createProgressStore, loadAudiobookConfig, installAudiobookRoutes,
} = require('./modules/audiobooks.cjs');
const { createBookmarkStore, installBookmarkRoutes } = require('./modules/bookmarks.cjs');
const { createScrapeJob, installScrapeRoutes } = require('./modules/scrape.cjs');
const { installDuplicateRoutes } = require('./modules/duplicate-admin.cjs');
const {
  INFOGRAPHIC_MAX_BYTES, createInfographicAdmin, installInfographicRoutes,
} = require('./modules/infographic-admin.cjs');
const { installArticleRoutes } = require('./modules/articles.cjs');
const { installLinkPreviewRoutes, installPromptRoutes } = require('./modules/link-preview.cjs');
const { installMediaRoutes } = require('./modules/media-files.cjs');
const { createLoginLimiter, tooManyAttemptsError } = require('./lib/login-limiter.cjs');
const { createSecurityHeaders, installCspReportRoute, REPORT_PATH: CSP_REPORT_PATH } = require('./lib/security-headers.cjs');
const { createArchiveLock, sendArchiveBusy } = require('./lib/archive-lock.cjs');
// Reine Logik ohne Serverzustand (auch für Skripte nutzbar, ohne server.js zu laden).
const { isCrossSite, sendApiError } = require('./lib/http-errors.cjs');
const { computeAppShellVersion, createAppShellVersion, createVersionedIndex, serviceWorkerSource } = require('./lib/app-shell.cjs');
const { createArticleBodyCache } = require('./lib/article-body-cache.cjs');
const { FileSessionStore } = require('./lib/session-file-store.cjs');
const {
  parseArticleSearchQuery, bodyExcerpt, mergeCategories, autoCategorize,
  extractSourceUrl, parseArticle,
} = require('./lib/article-parser.cjs');
const {
  createDirectoryCache, findSibling, fileUrl, audioFileUrl, isPathInside, resolveUnder, yearFromRelativeDir,
} = require('./lib/archive-files.cjs');
const {
  INFOGRAPHICS_AUTHOR, linkInfographics, infographicYearsFromMigrations, infographicAttachmentStem,
  removeCategoryLines, buildInfographicMarkdown, retitleInfographicMarkdown, setInstagramPosterMetadata,
  moveInfographicFiles, slugify, normalizeNewInfographicMarkdown,
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
  createDuplicateStore, decisionStillApplies,
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
const INFOGRAPHIC_TRASH_DIR = path.join(WWW_DIR, INFOGRAPHICS_AUTHOR, 'trash');
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
// Infografik-Verwaltung; canUploadInfographic nutzt auch die Detailansicht, die
// Dateistamm-Helfer der Dubletten-Umzug.
const infographicAdmin = createInfographicAdmin({
  archive, wwwDir: WWW_DIR, trashDir: INFOGRAPHIC_TRASH_DIR, canAccessAuthor, duplicateCanonicalFor,
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

// ─── Link-Vorschau (öffentlich), Artikel und Prompts ───────────────────────

installLinkPreviewRoutes(app, { archive, duplicateCanonicalFor, audiobooks, wwwDir: WWW_DIR, audioDir: AUDIO_DIR });
installArticleRoutes(app, {
  attachUser, archive, bookmarks, articleBodies, canAccessAuthor, duplicateCanonicalFor,
  canUploadInfographic: infographicAdmin.canUploadInfographic,
});
installPromptRoutes(app, { attachUser, promptsDir: path.join(__dirname, 'prompts') });

// ─── Protected API routes ──────────────────────────────────────────────────

// Nur die Admin-Oberfläche fragt den Status ab (admin-tasks.js).
app.get('/api/reindex/status', requireAdminAccess, (_req, res) => res.json(reindexState));

app.post('/api/reindex', requireAdminAccess, (req, res) => {
  // Ein laufender Reindex ist bei der Sperre registriert; die 409-Antwort nennt ihn.
  if (archiveLock.busy) return sendArchiveBusy(res, archiveLock, { started: false });
  // withReindexState setzt reindexState.running synchron und belegt damit die Sperre.
  buildIndex().catch(console.error);
  res.json({ started: true });
});

// ─── Start ─────────────────────────────────────────────────────────────────

installTtsRoutes(app, requireAdminAccess, ttsJobs, undefined, ttsVoiceSettings);
installMarkdownRoutes(app, requireAdminAccess, markdownEditor);
installScrapeRoutes(app, { requireAdmin: requireAdminAccess, job: scrapeJob, lock: archiveLock });
installDuplicateRoutes(app, {
  requireAdmin: requireAdminAccess, lock: archiveLock, archive, wwwDir: WWW_DIR,
  store: duplicateStore, config: duplicateConfig, bookmarks, articleBodies,
  infographics: infographicAdmin,
  refreshInfographicsForYears, refreshState: refreshDuplicateState,
});
installInfographicRoutes(app, {
  requireAdmin: requireAdminAccess, lock: archiveLock, admin: infographicAdmin, archive, wwwDir: WWW_DIR,
  duplicateCanonicalFor, refreshInfographicsForYear, refreshInfographicsForYears,
});
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
  createDirectoryCache, findSibling,
  parseArticle, linkInfographics, buildArticleSearchIndex, parseArticleSearchQuery,
  articleDisplayAuthor,
  replaceInfographicYearArticles, replaceArticleIndexEntry, upsertArticleIndexEntries,
  infographicYearsFromMigrations, parseScraperChangedFiles, prepareLinkedArticles,
  buildInfographicMarkdown, removeCategoryLines, slugify,
  normalizeNewInfographicMarkdown, mergeCategories,
  computeAppShellVersion, serviceWorkerSource,
  renderIndexForSession, requireAdminAccess, handleRequestError,
  infographicAttachmentStem, retitleInfographicMarkdown, moveInfographicFiles, setInstagramPosterMetadata,
  canUploadInfographic: infographicAdmin.canUploadInfographic,
};
