const express = require('express');
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const Fuse = require('fuse.js');

const app = express();
const PORT = process.env.PORT || 3000;
const WWW_DIR = path.join(__dirname, 'www');

let articles = [];
let meta = { authors: [], years: [], categories: [] };
let fuseIndex = null;
let reindexState = { running: false, processed: 0, articles: 0, done: true };

// ─── Parsers ───────────────────────────────────────────────────────────────

function extractDate(lines, filename) {
  for (const line of lines.slice(0, 12)) {
    const m = line.match(/(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
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

function parseArticle(content, filePath) {
  const lines = content.split('\n');

  // Find Datum line (case-insensitive, ignore ** wrappers)
  let datumIdx = -1;
  let date = '';
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const clean = lines[i].replace(/\*\*/g, '').replace(/^#+\s*/, '').trim().replace(/^_+|_+$/g, '').trim();
    if (/^datum:/i.test(clean)) {
      datumIdx = i;
      date = clean.replace(/^datum:\s*/i, '').trim();
      if (!date) {
        const m = lines[i].match(/(\d{4}-\d{2}-\d{2})/);
        if (m) date = m[1];
      }
      break;
    }
  }
  if (!date) date = extractDate(lines, filePath);

  // Title: non-empty lines before Datum, strip markdown markers
  const titleLines = [];
  const limitIdx = datumIdx >= 0 ? datumIdx : Math.min(lines.length, 5);
  for (let i = 0; i < limitIdx; i++) {
    const s = lines[i]
      .replace(/^#+\s*/, '')
      .replace(/\*\*/g, '')
      .replace(/^_+|_+$/g, '')
      .replace(/[»«]/g, '')
      .trim();
    if (s) titleLines.push(s);
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

  return { title, date, summary, tags, episodeNum, categories: [], body };
}

// ─── File scanner ──────────────────────────────────────────────────────────

function findSibling(dir, basename, exts) {
  for (const ext of exts) {
    const p = path.join(dir, basename + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
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
        preview: bodyExcerpt(parsed.body).slice(0, 200),
        imageUrl: relImg   ? `/files/${relImg}`   : null,
        audioUrl: relAudio ? `/files/${relAudio}` : null,
        videoUrl: relVideo ? `/files/${relVideo}` : null,
        pdfUrl:   relPdf   ? `/files/${relPdf}`   : null,
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

  articles.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

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

// ─── API ───────────────────────────────────────────────────────────────────

app.use(express.json());
app.use('/files', express.static(WWW_DIR));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/meta', (_req, res) => res.json(meta));

app.get('/api/reindex/status', (_req, res) => res.json(reindexState));

app.post('/api/reindex', (_req, res) => {
  if (reindexState.running) return res.json({ started: false, reason: 'already running' });
  buildIndex().catch(console.error);
  res.json({ started: true });
});

app.get('/api/articles', (req, res) => {
  const { q, author, year, category, page = '1', limit = '24' } = req.query;
  let filtered = articles;

  if (author) filtered = filtered.filter(a => a.author === author);
  if (year) filtered = filtered.filter(a => a.year === year);
  if (category) filtered = filtered.filter(a => a.categories.includes(category));

  if (q && fuseIndex) {
    const filteredIds = new Set(filtered.map(a => a.id));
    const results = fuseIndex.search(q, { limit: 2000 });
    filtered = results.filter(r => filteredIds.has(r.item.id)).map(r => r.item);
  }

  const total = filtered.length;
  const p = Math.max(1, parseInt(page));
  const lim = Math.min(100, Math.max(1, parseInt(limit)));
  const items = filtered.slice((p - 1) * lim, p * lim).map(({ filePath, ...rest }) => rest);

  res.json({ total, page: p, limit: lim, pages: Math.ceil(total / lim), items });
});

app.get('/api/articles/*', (req, res) => {
  const id = req.params[0];
  const article = articles.find(a => a.id === id);
  if (!article) return res.status(404).json({ error: 'Not found' });

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
