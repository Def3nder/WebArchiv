'use strict';

// Health-Check: Zustand von Index, Speicher, Diensten und Server samt gesammelten
// Meldungen (lib/event-log.cjs).
//  - GET  /api/health                 öffentlich, nur { status } (200 ok, 503 starting/degraded)
//                                     für externes Monitoring; bewusst ohne Zahlen und Pfade.
//  - GET  /api/health/details         Admin: alles für den Health-Check-Dialog.
//  - GET  /api/health/events?after=N  Admin: neue Fehler seit id N (für den Hinweis).
//  - POST /api/health/events/clear    Admin: Meldungsliste leeren.

const fs = require('fs');
const { jsonRoute } = require('../lib/http-errors.cjs');

const LEVEL_ORDER = ['ok', 'warning', 'error'];
const worst = levels => levels.reduce((a, b) => (LEVEL_ORDER.indexOf(b) > LEVEL_ORDER.indexOf(a) ? b : a), 'ok');
const DAY_MS = 24 * 60 * 60 * 1000;
const GB = 1024 ** 3;
const QWEN_CACHE_MS = 60 * 1000;

// Freier Platz: Fehler unter 2 GB oder 2 %, Warnung unter 10 GB oder 5 %. Ausgelegt für die
// beiden 100-GB-Volumes www und audio (Warnung ab 10 GB, Fehler ab 2 GB frei); der Prozentanteil
// greift erst bei großen Disks (z. B. lokal 1,8 TB: Warnung unter 93 GB).
function diskLevel(free, total) {
  if (!total) return 'warning';
  const share = free / total;
  if (share < 0.02 || free < 2 * GB) return 'error';
  if (share < 0.05 || free < 10 * GB) return 'warning';
  return 'ok';
}

// Letzter Cron-Scrape aus scraper/cron-scrape.log („2026-11-01 04:10:00 Scraper exit 0“).
// Gelesen wird nur das Dateiende.
async function lastCronRun(file, io = fs.promises) {
  let handle;
  try { handle = await io.open(file, 'r'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 16 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split(/\r?\n/).reverse();
    for (const line of lines) {
      const match = line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) Scraper exit (\d+)$/);
      if (match) return { at: new Date(`${match[1]}T${match[2]}`).getTime(), exitCode: Number(match[3]) };
    }
    return null;
  } finally {
    await handle.close();
  }
}

// Alle Angaben kommen als Funktionen, weil sich der Zustand des Servers ständig ändert.
function createHealthService({
  archive, audiobooks, reindexState, lastIndexRun, archiveLock, watcher, eventLog, scrapeJob,
  cronLogFile, qwenAvailable, volumes, cspMode, startedAt = Date.now(),
  statfs = path => fs.promises.statfs(path), now = () => Date.now(), io = fs.promises,
}) {
  let qwenCache = null;

  async function qwen() {
    if (qwenCache && now() - qwenCache.checkedAt < QWEN_CACHE_MS) return qwenCache;
    let reachable = false;
    try { reachable = !!(await qwenAvailable()); } catch { reachable = false; }
    qwenCache = { reachable, checkedAt: now() };
    return qwenCache;
  }

  async function disk({ name, dir }) {
    try {
      const stat = await statfs(dir);
      const unit = stat.frsize || stat.bsize;
      const total = stat.blocks * unit;
      const free = stat.bavail * unit;
      return { name, total, free, level: diskLevel(free, total) };
    } catch (error) {
      return { name, total: null, free: null, level: 'warning', error: error.code || error.message };
    }
  }

  // Für das öffentliche /api/health: kein Index = startet; Fehler beim Index oder voller
  // Datenträger = beeinträchtigt. Ein ausgeschaltetes Qwen-Gerät ist kein Ausfall.
  async function status() {
    const state = reindexState();
    if (!lastIndexRun()) return state.error ? 'degraded' : 'starting';
    if (state.error) return 'degraded';
    const disks = await Promise.all(volumes.map(disk));
    return disks.some(entry => entry.level === 'error') ? 'degraded' : 'ok';
  }

  async function details() {
    const state = reindexState();
    const run = lastIndexRun();
    const scanIssues = archive.scanIssues || [];
    const index = {
      articles: archive.articles.length,
      audiobooks: audiobooks.books.length,
      // Verknüpfte Quellbeiträge (durch den Blogartikel ersetzt) und noch offene Treffer der Dublettenprüfung.
      duplicates: {
        linked: archive.duplicateCanonicalOf?.size || 0,
        open: archive.duplicateCandidates?.length || 0,
      },
      lastRun: run,
      running: !!state.running,
      error: state.error || null,
      scanIssues,
      busy: archiveLock.current,
      watcher: watcher(),
    };
    // Ein bewusst abgeschalteter Watcher (WATCH_ARCHIVE=0) ist keine Warnung, ein ausgefallener schon.
    const watcherDown = index.watcher.enabled && !index.watcher.active;
    index.level = state.error ? 'error' : (!run || scanIssues.length || watcherDown) ? 'warning' : 'ok';

    const disks = await Promise.all(volumes.map(disk));

    const qwenState = await qwen();
    const scrape = scrapeJob.state;
    const web = scrape.startedAt
      ? { startedAt: scrape.startedAt, running: !!scrape.running, exitCode: scrape.exitCode ?? null, error: scrape.error || null }
      : null;
    let cron = null;
    try { cron = await lastCronRun(cronLogFile, io); } catch { cron = null; }
    const scrapeFailed = (web && !web.running && (web.error || (web.exitCode !== null && web.exitCode !== 0)))
      || (cron && cron.exitCode !== 0);
    const services = {
      qwen: { reachable: qwenState.reachable, checkedAt: qwenState.checkedAt, level: qwenState.reachable ? 'ok' : 'warning' },
      scrape: { web, cron, level: scrapeFailed ? 'error' : 'ok' },
    };

    const memory = process.memoryUsage();
    const server = {
      startedAt, uptimeSeconds: Math.round((now() - startedAt) / 1000), node: process.version,
      rss: memory.rss, heapUsed: memory.heapUsed, cspMode, level: 'ok',
    };

    const events = eventLog.list();
    const recent = events.filter(entry => now() - entry.lastAt < DAY_MS);
    const eventsLevel = recent.some(entry => entry.level === 'error') ? 'error'
      : recent.some(entry => entry.level === 'warning') ? 'warning' : 'ok';

    return {
      checkedAt: now(),
      level: worst([index.level, ...disks.map(entry => entry.level), services.qwen.level, services.scrape.level, eventsLevel]),
      index,
      disks,
      services,
      server,
      events: { level: eventsLevel, lastId: eventLog.lastId, entries: events },
    };
  }

  return { status, details, qwen };
}

function installHealthRoutes(app, { requireAdmin, service, eventLog }) {
  app.get('/api/health', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const value = await service.status();
      res.status(value === 'ok' ? 200 : 503).json({ status: value });
    } catch (error) {
      console.error('Health-Status:', error);
      res.status(503).json({ status: 'degraded' });
    }
  });
  app.get('/api/health/details', requireAdmin,
    jsonRoute(() => service.details(), { label: 'Health-Check', fallback: 'Der Health-Check ist fehlgeschlagen.' }));
  app.get('/api/health/events', requireAdmin, jsonRoute(req => {
    const after = Math.max(0, Number.parseInt(req.query.after, 10) || 0);
    return eventLog.summary(after);
  }, { label: 'Meldungen' }));
  app.post('/api/health/events/clear', requireAdmin, jsonRoute(() => {
    eventLog.clear();
    return { ok: true, lastId: eventLog.lastId };
  }, { label: 'Meldungen' }));
}

module.exports = { createHealthService, installHealthRoutes, diskLevel, lastCronRun };
