// Eigenständiges Dubletten-Werkzeug: vergleicht .md-Dateien aus Ordner A (Original)
// und Ordner B (Kandidat) und verschiebt bestätigte Dubletten aus B in einen Ziel-Ordner.
'use strict';

const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const { renderSafeMarkdown } = require('../html-sanitizer.cjs');
const {
  DEFAULT_THRESHOLDS,
  normalizeThresholds,
  detectDuplicateCandidates,
  createDecisionStore,
  decisionStillApplies,
} = require('./lib/duplicates.cjs');
const { IMAGE_EXTENSIONS, splitName, isInside, scanFolder } = require('./lib/scan.cjs');
const { moveArticle, createMoveLog } = require('./lib/mover.cjs');
const { writeJsonAtomic } = require('./lib/json-file.cjs');

const CONFIG_FILE = process.env.DUPLICATES_TOOL_CONFIG || path.join(__dirname, 'config.json');
const DATA_DIR = process.env.DUPLICATES_TOOL_DATA || path.join(__dirname, 'data');

// ─── Konfiguration ─────────────────────────────────────────────────────────

function readConfigFile() {
  try { return JSON.parse(fsSync.readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, '')); }
  catch (error) {
    if (error.code !== 'ENOENT') console.warn('config.json nicht lesbar —', error.message);
    return {};
  }
}

// Stand der Schnittstelle; die Oberfläche warnt, wenn ein älterer Server noch läuft.
const API_VERSION = 4;
const RECENT_LIMIT = 5;

const folder = item => (typeof item === 'string' && item.trim() ? path.resolve(item.trim()) : '');

function normalizeRecent(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).map(folder).filter(item => {
    const key = item.toLowerCase();
    if (!item || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, RECENT_LIMIT);
}

// Zuletzt verwendeter Ordner kommt nach vorn, höchstens fünf Einträge.
function rememberRecent(list, value) {
  return value ? normalizeRecent([value, ...list]) : normalizeRecent(list);
}

function normalizeConfig(value = {}) {
  // Mehrere Original-Ordner; ältere Konfigurationen mit nur „folderA“ werden übernommen.
  const originals = Array.isArray(value.originals) ? value.originals : [value.folderA];
  return {
    originals: originals.map(folder).filter(Boolean),
    folderB: folder(value.folderB),
    target: folder(value.target),
    // Ohne gespeicherte Liste wenigstens den aktuellen Ordner anbieten.
    recentFolderB: normalizeRecent(value.recentFolderB?.length ? value.recentFolderB : [value.folderB]),
    recentTargets: normalizeRecent(value.recentTargets?.length ? value.recentTargets : [value.target]),
    host: String(value.host || '127.0.0.1'),
    port: Number(value.port) || 3100,
    ...normalizeThresholds(value),
  };
}

let config = normalizeConfig(readConfigFile());
const LISTEN_HOST = process.env.HOST || config.host;
const LISTEN_PORT = Number(process.env.PORT) || config.port;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

async function isDirectory(dir) {
  try { return (await fs.stat(dir)).isDirectory(); }
  catch { return false; }
}

async function validateFolders(next) {
  for (const [index, folder] of next.originals.entries()) {
    if (!(await isDirectory(folder))) throw fail(400, `Ordner ${originalLabel(index)} existiert nicht.`);
  }
  if (next.folderB && !(await isDirectory(next.folderB))) throw fail(400, 'Ordner B existiert nicht.');
  const named = [
    ...next.originals.map((folder, index) => [originalLabel(index), folder]),
    ...(next.folderB ? [['B', next.folderB]] : []),
  ];
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      if (isInside(named[i][1], named[j][1]) || isInside(named[j][1], named[i][1])) {
        throw fail(400, `Ordner ${named[i][0]} und ${named[j][0]} dürfen nicht gleich sein oder ineinander liegen.`);
      }
    }
  }
  if (next.target) {
    for (const [label, folder] of named) {
      if (isInside(folder, next.target)) {
        throw fail(400, `Der Ziel-Ordner darf nicht Ordner ${label} sein oder ihn enthalten.`);
      }
    }
    for (const [index, folder] of next.originals.entries()) {
      if (isInside(next.target, folder)) {
        throw fail(400, `Der Ziel-Ordner darf nicht innerhalb von Ordner ${originalLabel(index)} liegen.`);
      }
    }
  }
}

function originalLabel(index) {
  return `A${index + 1}`;
}

// ─── Scan-Zustand (nur im Speicher) ────────────────────────────────────────

const decisions = createDecisionStore({ file: path.join(DATA_DIR, 'decisions.json') });
const moveLog = createMoveLog({ file: path.join(DATA_DIR, 'moves.json') });
decisions.load();
moveLog.load();

let scan = null;
let scanning = null;

async function runScan() {
  if (!config.originals.length || !config.folderB) throw fail(400, 'Bitte zuerst mindestens einen Original-Ordner und Ordner B wählen.');
  await validateFolders(config);
  const started = Date.now();
  const exclude = config.target ? [config.target] : [];
  const [candidates, ...originalLists] = await Promise.all([
    scanFolder(config.folderB, { side: 'B', exclude }),
    ...config.originals.map((folder, index) => scanFolder(folder, {
      side: 'A', idPrefix: originalLabel(index), rootIndex: index + 1, exclude,
    })),
  ]);
  const originals = originalLists.flat();
  scan = {
    originalFolders: [...config.originals],
    folderB: config.folderB,
    thresholds: normalizeThresholds(config),
    originals,
    candidates,
    byId: new Map([...originals, ...candidates].map(article => [article.id, article])),
    matches: detectDuplicateCandidates(originals, candidates, config),
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
  return scan;
}

function scanOnce() {
  if (!scanning) scanning = runScan().finally(() => { scanning = null; });
  return scanning;
}

function articleView(article) {
  if (!article) return null;
  return {
    id: article.id,
    side: article.side,
    title: article.title,
    date: article.date,
    relPath: article.relPath,
    rootIndex: article.rootIndex,
    rootName: path.basename(article.root),
    excerpt: article.excerpt,
    companions: article.companions,
    imageCount: article.companions.filter(name => IMAGE_EXTENSIONS.has(splitName(name).ext)).length,
    tokenCount: article.duplicateProfile.tokenCount,
  };
}

function matchView(match) {
  const { original, candidate, ...similarity } = match;
  return { ...similarity, original: articleView(original), candidate: articleView(candidate) };
}

function pairFromRequest(originalId, candidateId) {
  if (!scan) throw fail(409, 'Noch kein Scan vorhanden.');
  const original = scan.byId.get(String(originalId || ''));
  const candidate = scan.byId.get(String(candidateId || ''));
  if (!original || !candidate || original.side !== 'A' || candidate.side !== 'B') {
    throw fail(404, 'Einer der Artikel wurde nicht gefunden – bitte neu scannen.');
  }
  return { original, candidate };
}

function isIgnored(match) {
  return decisionStillApplies(decisions.find(match.original.absPath, match.candidate.absPath), match.original, match.candidate);
}

function scanSummary() {
  if (!scan) return null;
  return {
    originalFolders: scan.originalFolders,
    folderB: scan.folderB,
    thresholds: scan.thresholds,
    originals: scan.originals.length,
    candidates: scan.candidates.length,
    scannedAt: scan.scannedAt,
    durationMs: scan.durationMs,
    stale: JSON.stringify(scan.originalFolders) !== JSON.stringify(config.originals) || scan.folderB !== config.folderB
      || scan.thresholds.minimumTokens !== config.minimumTokens
      || scan.thresholds.maxDateDistanceDays !== config.maxDateDistanceDays
      || scan.thresholds.minContentSimilarity !== config.minContentSimilarity,
  };
}

// ─── Server ────────────────────────────────────────────────────────────────

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Nur für den lokalen Gebrauch: fremde Origins (DNS-Rebinding, andere Seiten) abweisen.
app.use('/api', (req, res, next) => {
  const hostname = String(req.hostname || '').replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTS.has(LISTEN_HOST) && !LOOPBACK_HOSTS.has(hostname)) {
    return res.status(403).json({ error: 'Nur lokaler Zugriff erlaubt.' });
  }
  const origin = req.get('origin');
  if (origin && req.method !== 'GET') {
    try {
      if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Fremde Herkunft.' });
    } catch { return res.status(403).json({ error: 'Fremde Herkunft.' }); }
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
// Browser-Build des diff-Pakets (über „exports“ nicht auflösbar, daher direkter Pfad).
// Textvergleich aus dem WebArchiv (npm run build:duplicate-diff im Projektordner).
app.get('/vendor/duplicate-diff.bundle.js', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'vendor', 'duplicate-diff.bundle.js')));

const route = handler => (req, res) => Promise.resolve(handler(req, res)).catch(error => {
  if (!error.status) console.error(error);
  res.status(error.status || 500).json({ error: error.status ? error.message : `Interner Fehler: ${error.message}` });
});

app.get('/api/config', route((req, res) => {
  res.json({ apiVersion: API_VERSION, config, defaults: DEFAULT_THRESHOLDS, scan: scanSummary() });
}));

app.put('/api/config', route(async (req, res) => {
  const body = req.body || {};
  const next = normalizeConfig({
    ...config,
    originals: Array.isArray(body.originals) ? body.originals : config.originals,
    folderB: body.folderB ?? config.folderB,
    target: body.target ?? config.target,
    minimumTokens: body.minimumTokens ?? config.minimumTokens,
    maxDateDistanceDays: body.maxDateDistanceDays ?? config.maxDateDistanceDays,
    minContentSimilarity: body.minContentSimilarity ?? config.minContentSimilarity,
  });
  await validateFolders(next);
  next.recentFolderB = rememberRecent(config.recentFolderB, next.folderB);
  next.recentTargets = rememberRecent(config.recentTargets, next.target);
  const { folderA, ...previous } = readConfigFile();
  const stored = { ...previous, ...next };
  await writeJsonAtomic(CONFIG_FILE, stored);
  config = next;
  res.json({ apiVersion: API_VERSION, config, scan: scanSummary() });
}));

// Ordner-Browser: nur Verzeichnisse, für die Auswahl in der Oberfläche.
app.get('/api/fs', route(async (req, res) => {
  const requested = String(req.query.path || '').trim();
  const roots = [];
  if (process.platform === 'win32') {
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const drive = `${letter}:\\`;
      if (fsSync.existsSync(drive)) roots.push(drive);
    }
  } else {
    roots.push('/');
  }
  if (!requested) return res.json({ path: '', parent: null, roots, dirs: [] });
  // Noch nicht vorhandener Ziel-Ordner: beim nächsten existierenden Elternordner beginnen.
  let dir = path.resolve(requested);
  while (!(await isDirectory(dir)) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) { throw fail(400, `Ordner nicht lesbar: ${error.code || error.message}`); }
  const dirs = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('$'))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, 'de', { numeric: true, sensitivity: 'base' }));
  const mdCount = entries.filter(entry => entry.isFile() && splitName(entry.name).ext === '.md').length;
  const parent = path.dirname(dir);
  res.json({ path: dir, parent: parent === dir ? null : parent, roots, dirs, mdCount });
}));

app.post('/api/scan', route(async (req, res) => {
  await scanOnce();
  res.json({ scan: scanSummary() });
}));

app.get('/api/duplicates', route(async (req, res) => {
  if (scanning) await scanning.catch(() => {});
  const pending = [];
  const ignored = [];
  for (const match of scan?.matches || []) {
    if (isIgnored(match)) {
      const decision = decisions.find(match.original.absPath, match.candidate.absPath);
      ignored.push({ ...matchView(match), updatedAt: decision.updatedAt });
    } else {
      pending.push(matchView(match));
    }
  }
  // „Verschoben“ gilt pro Kandidaten-Ordner: nur Einträge, deren Quelle im aktuellen B liegt.
  const moved = config.folderB
    ? moveLog.all().filter(entry => entry.candidate?.path && isInside(entry.candidate.path, config.folderB))
    : [];
  res.json({ pending, ignored, moved, scan: scanSummary(), config });
}));

app.get('/api/duplicates/compare', route((req, res) => {
  const { original, candidate } = pairFromRequest(req.query.originalId, req.query.candidateId);
  const match = scan.matches.find(item => item.original === original && item.candidate === candidate);
  // Dieselbe HTML-Bereinigung wie im WebArchiv: Die Texte stammen auch aus Facebook und Telegram.
  const view = article => ({ ...articleView(article), bodyHtml: renderSafeMarkdown(article.body) });
  res.json({
    ...(match ? matchView(match) : {}),
    original: view(original),
    candidate: view(candidate),
    status: match && isIgnored(match) ? 'ignored' : 'pending',
    target: config.target,
  });
}));

app.post('/api/duplicates', route(async (req, res) => {
  const { action, originalId, candidateId } = req.body || {};
  const { original, candidate } = pairFromRequest(originalId, candidateId);
  if (action === 'ignore') {
    await decisions.ignore({
      originalPath: original.absPath,
      candidatePath: candidate.absPath,
      originalHash: original.duplicateProfile.hash,
      candidateHash: candidate.duplicateProfile.hash,
    });
  } else if (action === 'reset') {
    await decisions.remove(original.absPath, candidate.absPath);
  } else {
    throw fail(400, 'Unbekannte Aktion.');
  }
  res.json({ ok: true });
}));

// Kandidaten aus B samt Begleitdateien in den Ziel-Ordner verschieben.
app.post('/api/move', route(async (req, res) => {
  if (!config.target) throw fail(400, 'Bitte zuerst einen Ziel-Ordner wählen.');
  await validateFolders(config);
  if (!scan || scan.folderB !== config.folderB) throw fail(409, 'Der Scan passt nicht zu Ordner B – bitte neu scannen.');
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) throw fail(400, 'Keine Treffer ausgewählt.');
  const moved = [];
  const failed = [];
  const seen = new Set();
  for (const item of items) {
    try {
      const { original, candidate } = pairFromRequest(item.originalId, item.candidateId);
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      const stat = await fs.stat(candidate.absPath).catch(() => null);
      if (!stat || stat.size !== candidate.size || stat.mtimeMs !== candidate.mtimeMs) {
        throw fail(409, 'Datei wurde seit dem Scan geändert – bitte neu scannen.');
      }
      const match = scan.matches.find(entry => entry.original === original && entry.candidate === candidate);
      const files = await moveArticle(candidate, config.target);
      const entry = await moveLog.add({
        target: config.target,
        score: match?.score ?? null,
        exact: Boolean(match?.exact),
        method: match?.method || 'text',
        original: { path: original.absPath, relPath: original.relPath, title: original.title, date: original.date },
        candidate: { path: candidate.absPath, relPath: candidate.relPath, title: candidate.title, date: candidate.date },
        files,
      });
      scan.candidates = scan.candidates.filter(article => article !== candidate);
      scan.byId.delete(candidate.id);
      scan.matches = scan.matches.filter(entry => entry.candidate !== candidate);
      moved.push(entry);
    } catch (error) {
      if (!error.status) console.error(error);
      failed.push({ originalId: item.originalId, candidateId: item.candidateId, error: error.message });
    }
  }
  res.json({ moved, failed });
}));

app.post('/api/moves/:id/undo', route(async (req, res) => {
  const entry = await moveLog.undo(String(req.params.id));
  // Zurückgelegte Dateien wieder einlesen, damit der Treffer erneut erscheint.
  if (scan && config.originals.length && config.folderB) await scanOnce().catch(error => console.warn('Neu-Scan fehlgeschlagen:', error.message));
  res.json({ ok: true, entry });
}));

// Bild-Begleitdateien für die Vorschau; nur Dateien, die beim Scan zugeordnet wurden.
app.get('/api/file', route(async (req, res) => {
  const article = scan?.byId.get(String(req.query.id || ''));
  const name = String(req.query.name || '');
  if (!article || !article.companions.includes(name) || path.basename(name) !== name) throw fail(404, 'Datei nicht gefunden.');
  const dir = path.dirname(article.absPath);
  const file = path.resolve(dir, name);
  if (!isInside(file, article.root) || path.dirname(file) !== dir) throw fail(404, 'Datei nicht gefunden.');
  if (!IMAGE_EXTENSIONS.has(splitName(name).ext)) throw fail(415, 'Keine Bilddatei.');
  res.sendFile(file, { headers: { 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" } });
}));

if (require.main === module) {
  app.listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.log(`Dubletten-Werkzeug läuft auf http://${LOOPBACK_HOSTS.has(LISTEN_HOST) ? 'localhost' : LISTEN_HOST}:${LISTEN_PORT}`);
    if (config.originals.length && config.folderB) {
      scanOnce().then(() => console.log(`Scan: ${scan.originals.length} Originale, ${scan.candidates.length} Kandidaten, ${scan.matches.length} Treffer`))
        .catch(error => console.warn('Start-Scan fehlgeschlagen:', error.message));
    }
  });
}

module.exports = { app };
