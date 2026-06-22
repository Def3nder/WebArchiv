const express = require('express');
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const Fuse = require('fuse.js');
const session = require('express-session');
const bcrypt  = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;
const WWW_DIR = path.join(__dirname, 'www');

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

  const body = bodyLines.join('\n').trim();
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

app.get('/api/articles', attachUser, (req, res) => {
  const { q, author, year, category, page = '1', limit = '24' } = req.query;
  const user = req.user;
  let filtered = articles;

  // ACL pre-filter: restrict to allowed authors
  if (user.allowedAuthors !== null) {
    filtered = filtered.filter(a => user.allowedAuthors.includes(a.author));
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
    res.json({ ...rest, bodyHtml });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────

buildIndex().catch(console.error);
app.listen(PORT, () => {
  console.log(`WebArchiv → http://localhost:${PORT}`);
});
