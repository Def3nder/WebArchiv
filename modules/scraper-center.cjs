'use strict';

// Scraper-Zentrale (Admin): alle Scraper-Quellen mit letztem Lauf, Ergebnis, neuen Artikeln, Fehlern und notwendigen
// Aktionen; Quellen hinzufügen, bearbeiten, pausieren und entfernen; eine einzelne Quelle starten.
// Daten: scraper-config.json (Laufzeitdatei; fehlt sie, gilt die Vorlage example-scraper-config.json),
// scrape-status.json (schreibt scrape_all.js), cookies.txt (nur Ablaufdaten) und cron-scrape.log.

const fs = require('fs');
const { httpError, jsonRoute } = require('../lib/http-errors.cjs');
const { writeJsonAtomic } = require('../lib/atomic-file.cjs');
const {
  emptyConfig, listSources, findSource, sourceEntry, cookieExpiry, summarizeSource, sourceActions, cronState, worstLevel,
  facebookLoginState,
} = require('../lib/scraper-sources.cjs');
const { lastCronRun } = require('./health.cjs');

// archive: Indexzustand aus server.js (für Titel und Existenz neuer Artikel; Felder erst beim Aufruf lesen).
function createScraperCenter({
  configFile, exampleFile, statusFile, cookiesFile, cronLogFile, archive, now = Date.now, io = fs.promises,
}) {
  const readJson = async file => JSON.parse(await io.readFile(file, 'utf8'));
  const readText = file => io.readFile(file, 'utf8').catch(error => (error.code === 'ENOENT' ? null : Promise.reject(error)));

  async function readConfig() {
    for (const file of [configFile, exampleFile]) {
      try { return { ...emptyConfig(), ...(await readJson(file)) }; }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        throw httpError(500, `${file === configFile ? 'scraper-config.json' : 'Die Vorlage'} ist kein gültiges JSON.`);
      }
    }
    return emptyConfig();
  }

  async function readRuns() {
    try {
      const data = await readJson(statusFile);
      return Array.isArray(data?.runs) ? data.runs : [];
    } catch { return []; }
  }

  const articleView = id => {
    const article = archive.articleById.get(id.replace(/\.md$/i, ''));
    return { id: id.replace(/\.md$/i, ''), title: article?.title || null, exists: !!article };
  };

  async function overview() {
    const [doc, runs, cookiesText, lastCron] = await Promise.all([
      readConfig(), readRuns(), readText(cookiesFile), lastCronRun(cronLogFile, io).catch(() => null),
    ]);
    const at = now();
    const cookies = cookieExpiry(cookiesText);
    const sources = listSources(doc).map(source => {
      const summary = summarizeSource(source, runs, at);
      const { actions, level } = sourceActions(source, summary, { cookies, now: at });
      const last = summary.last && {
        runId: summary.last.runId, trigger: summary.last.trigger, running: summary.last.running,
        status: summary.last.status, startedAt: summary.last.startedAt, finishedAt: summary.last.finishedAt,
        durationMs: summary.last.durationMs, saved: summary.last.saved, skipped: summary.last.skipped,
        error: summary.last.error, warnings: summary.last.warnings || {},
        newArticles: (summary.last.newFiles || []).map(articleView),
      };
      return { ...source, last, lastNewAt: summary.lastNewAt, newLast30Days: summary.newLast30Days, actions, level };
    });
    const cron = cronState(lastCron, at);
    return {
      sources,
      cron,
      // Nur Ablaufdaten der Facebook-Anmeldung; Namen und Werte der Cookies verlassen den Server nie.
      cookies: { exists: cookies.exists, sessionExpiresAt: cookies.sessionExpiresAt },
      level: worstLevel([...sources, cron]),
      lastRun: runs[0] ? { id: runs[0].id, trigger: runs[0].trigger, startedAt: runs[0].startedAt, finishedAt: runs[0].finishedAt, exitCode: runs[0].exitCode } : null,
      usesExample: !(await io.access(configFile).then(() => true, () => false)),
    };
  }

  // Änderung an der Config: aktuell lesen, ändern, atomar schreiben (legt die Datei beim ersten Mal aus der Vorlage an).
  async function update(change) {
    const doc = await readConfig();
    const result = change(doc);
    await writeJsonAtomic(configFile, doc);
    return result;
  }

  // Facebook-Anmeldung für Health-Check und Erinnerung (nur Stufe, Text und Ablaufdatum).
  async function loginState() {
    const [doc, cookiesText] = await Promise.all([readConfig(), readText(cookiesFile)]);
    const needed = listSources(doc).some(source => source.type === 'facebook' && source.active);
    return facebookLoginState(cookieExpiry(cookiesText), { needed, now: now() });
  }

  return {
    overview,
    readConfig,
    loginState,
    addSource: input => update(doc => {
      const { section, entry } = sourceEntry(input, { doc });
      doc[section] = [...(doc[section] || []), entry];
      return { name: entry.Name };
    }),
    editSource: (name, input) => update(doc => {
      const existing = findSource(doc, name);
      if (!existing) throw httpError(404, `Quelle „${name}“ nicht gefunden.`);
      doc[existing.section][existing.index] = sourceEntry(input, { doc, existing }).entry;
      return { name: existing.entry.Name };
    }),
    setActive: (name, active) => update(doc => {
      const existing = findSource(doc, name);
      if (!existing) throw httpError(404, `Quelle „${name}“ nicht gefunden.`);
      if (typeof active !== 'boolean') throw httpError(400, 'active muss true oder false sein.');
      const entry = { ...existing.entry };
      if (active) delete entry.Aktiv; else entry.Aktiv = false;
      doc[existing.section][existing.index] = entry;
      return { name: entry.Name, active };
    }),
    // Entfernt nur den Eintrag; Artikel und Autorenordner bleiben im Archiv.
    removeSource: name => update(doc => {
      const existing = findSource(doc, name);
      if (!existing) throw httpError(404, `Quelle „${name}“ nicht gefunden.`);
      doc[existing.section].splice(existing.index, 1);
      return { name: existing.entry.Name, removed: true };
    }),
  };
}

// Schreibzugriffe laufen unter der Archiv-Sperre: Während eines Scraper-Laufs ändert sich die Config nicht (409).
function installScraperCenterRoutes(app, { requireAdmin, center, job, lock }) {
  const route = (handler, label = 'Scraper-Zentrale') => jsonRoute(handler, { label, fallback: 'Die Scraper-Zentrale ist fehlgeschlagen.' });
  const write = task => lock.run('Scraper-Quellen ändern', task);
  app.get('/api/scraper/sources', requireAdmin, route(() => center.overview()));
  app.post('/api/scraper/sources', requireAdmin, route(req => write(() => center.addSource(req.body || {}))));
  app.put('/api/scraper/sources/:name', requireAdmin, route(req => write(() => center.editSource(req.params.name, req.body || {}))));
  app.put('/api/scraper/sources/:name/active', requireAdmin, route(req => write(() => center.setActive(req.params.name, req.body?.active))));
  app.delete('/api/scraper/sources/:name', requireAdmin, route(req => write(() => center.removeSource(req.params.name))));
  app.post('/api/scraper/run', requireAdmin, route(async req => {
    if (lock.busy) throw lock.conflictError({ started: false });
    const found = findSource(await center.readConfig(), req.body?.source);
    if (!found) throw httpError(404, 'Diese Quelle gibt es nicht (mehr).');
    return job.start([], { source: found.entry.Name });
  }, 'Scrape'));
}

// Erinnerung an die Facebook-Anmeldung über das Meldungsprotokoll: abgelaufen = Fehler (Sprechblase im Health-Check),
// bald ablaufend = Warnung (nur im Dialog). Höchstens einmal je Stufe und Tag; ist alles wieder gut, beginnt es neu.
function createLoginReminder({ loginState, eventLog, now = Date.now, repeatMs = 24 * 3600 * 1000 }) {
  let last = { level: null, at: 0 };
  return {
    async check() {
      const state = await loginState();
      if (state.level !== 'error' && state.level !== 'warning') {
        last = { level: null, at: 0 };
        return null;
      }
      if (state.level === last.level && now() - last.at < repeatMs) return null;
      last = { level: state.level, at: now() };
      eventLog.record(state.level, `Scraper: ${state.text}`, { source: 'scraper' });
      return state;
    },
  };
}

module.exports = { createScraperCenter, installScraperCenterRoutes, createLoginReminder };
