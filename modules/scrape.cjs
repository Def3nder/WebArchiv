'use strict';

// Scrape (Admin): externen Scraper starten, danach automatisch reindexen.
//
// Startet scraper/scrape_all.js als eigenen Node-Prozess (self-contained mit
// eigenen node_modules; playwright bleibt aus den App-Abhängigkeiten heraus).
// Läuft im Hintergrund; der Fortschritt wird über /api/scrape/status gepollt.
// Der Lauf ist bei der Archiv-Sperre registriert (running, siehe server.js).

const fs = require('fs');
const path = require('path');
const { spawn: spawnProcess } = require('child_process');
const { jsonRoute } = require('../lib/http-errors.cjs');
const { parseScraperChangedFiles, SCRAPER_CHANGED_FILES_MARKER } = require('../lib/article-index.cjs');

const SCRAPE_SOURCES = ['blog', 'facebook', 'telegram'];
// Ausgabe des Kindprozesses für die Live-Anzeige im Web-UI (gekappt auf die letzten
// ~20 000 Zeichen, damit ein großer Erstlauf den Speicher nicht sprengt).
const OUTPUT_LIMIT = 20000;

// reindex: vollständiger Neuaufbau; refreshFiles: gezieltes Einlesen der vom
// Scraper gemeldeten Dateien; reindexRunning: läuft gerade ein Index-Neuaufbau?
function createScrapeJob({ scraperDir, reindex, refreshFiles, reindexRunning, spawn = spawnProcess }) {
  let state = { running: false, sources: null, exitCode: null, startedAt: null, done: true, error: null };

  function finish(code) {
    const changedFiles = parseScraperChangedFiles(state.output);
    if (state.output.includes(SCRAPER_CHANGED_FILES_MARKER)) {
      state.output = state.output.split(/\r?\n/)
        .filter(line => !line.startsWith(SCRAPER_CHANGED_FILES_MARKER)).join('\n');
    }
    console.log(`Scrape beendet (exit ${code}) — ${changedFiles === null ? 'vollständiger Sicherheits-Reindex' : `${changedFiles.length} geänderte Artikel`} …`);
    state = { ...state, running: false, done: true, exitCode: code };
    // Auch bei Teil-Fehler (exit 1) bereits gespeicherte Artikel aufnehmen. Bei
    // älteren Scraper-Versionen ohne Manifest bleibt der Voll-Reindex erhalten.
    if (reindexRunning()) return;
    const refresh = changedFiles === null ? reindex() : refreshFiles(changedFiles);
    refresh.catch(error => {
      console.error('Gezielter Scraper-Reindex fehlgeschlagen:', error);
      if (changedFiles !== null && !reindexRunning()) reindex().catch(console.error);
    });
  }

  return {
    get running() { return state.running; },
    // Enthält Quellen, Pfade und Fehlermeldungen des Scrapers: nur für Admins.
    get state() { return state; },

    // Optionale Quellenauswahl: ["blog","facebook","telegram"]. Ohne Angabe laufen
    // alle drei (Reihenfolge bestimmt der Scraper selbst). Der Aufrufer prüft vorher
    // die Archiv-Sperre; running wird hier synchron gesetzt und belegt sie damit.
    start(requestedSources) {
      const sources = Array.isArray(requestedSources)
        ? requestedSources.filter(source => SCRAPE_SOURCES.includes(source))
        : [];
      const args = [path.join(scraperDir, 'scrape_all.js'), ...sources.map(source => `--${source}`)];
      state = {
        running: true,
        sources: sources.length ? sources : SCRAPE_SOURCES,
        exitCode: null,
        startedAt: Date.now(),
        done: false,
        error: null,
        output: '',
      };
      console.log(`Scrape gestartet: ${state.sources.join(', ')}`);

      const captureOutput = chunk => {
        state.output += chunk.toString();
        if (state.output.length > OUTPUT_LIMIT) state.output = state.output.slice(-OUTPUT_LIMIT);
      };
      const child = spawn(process.execPath, args, { cwd: scraperDir });
      child.stdout.on('data', d => { process.stdout.write(`[scrape] ${d}`); captureOutput(d); });
      child.stderr.on('data', d => { process.stderr.write(`[scrape] ${d}`); captureOutput(d); });
      child.on('error', err => {
        console.error('Scrape konnte nicht gestartet werden:', err.message);
        state = { ...state, running: false, done: true, exitCode: -1, error: err.message };
      });
      child.on('close', finish);
      return { started: true, sources: state.sources };
    },

    // Letzte 100 Zeilen des Scraper-Logs (für die "Scrape-Log anzeigen"-Ansicht).
    readLog() {
      const logPath = path.join(scraperDir, 'scrape_all.log');
      try {
        const stat = fs.statSync(logPath);
        const start = Math.max(0, stat.size - 256 * 1024);  // nur den Tail lesen (Log rotiert nicht)
        const buf = Buffer.alloc(stat.size - start);
        const fd = fs.openSync(logPath, 'r');
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        return { text: buf.toString('utf8').split(/\r?\n/).slice(-100).join('\n') };
      } catch {
        return { text: '(keine Logdatei gefunden)' };
      }
    },
  };
}

function installScrapeRoutes(app, { requireAdmin, job, lock }) {
  const route = handler => jsonRoute(handler, { label: 'Scrape', fallback: 'Der Scraper konnte nicht gestartet werden.' });
  app.get('/api/scrape/status', requireAdmin, route(() => job.state));
  app.post('/api/scrape', requireAdmin, route(req => {
    // Scrape und Reindex sind bei der Sperre registriert; die 409-Antwort nennt den Auftrag.
    if (lock.busy) throw lock.conflictError({ started: false });
    return job.start(req.body?.sources);
  }));
  app.get('/api/scrape/log', requireAdmin, route(() => job.readLog()));
}

module.exports = { createScrapeJob, installScrapeRoutes, SCRAPE_SOURCES };
