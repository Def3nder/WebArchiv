// Statusdatei je Quelle (scrape-status.json), Pausieren über "Aktiv" und Einzelquelle per --source.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadScraperConfig,
  logger,
  readStatus,
  relativeNewFiles,
  runAll,
  selectSources,
  upsertRun,
  warningKind,
} from "../scrape_all.js";

const WWW = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "www");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrape-status-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeConfig(dir, sections) {
  const file = path.join(dir, "scraper-config.json");
  fs.writeFileSync(file, JSON.stringify({ Blog: [], Facebook: [], Telegram: [], ...sections }));
  return file;
}

const source = (name, extra = {}) => ({ Name: name, URL: "https://example.org/" + encodeURIComponent(name), OutputPath: `../www/${name}`, ...extra });

test("Aktiv: false pausiert eine Quelle, andere Werte als true/false sind ein Fehler", (t) => {
  const dir = tempDir(t);
  const config = loadScraperConfig(writeConfig(dir, { Facebook: [source("A"), source("B", { Aktiv: false })] }));
  assert.deepEqual(config.facebook.map((item) => [item.name, item.active]), [["A", true], ["B", false]]);
  assert.throws(() => loadScraperConfig(writeConfig(dir, { Blog: [source("C", { Aktiv: "nein" })] })), /"Aktiv" muss true oder false sein/);
});

test("--source wählt genau eine Quelle (auch pausiert), unbekannte Namen nennen die vorhandenen", (t) => {
  const dir = tempDir(t);
  const config = loadScraperConfig(writeConfig(dir, {
    Blog: [source("Joe Turan")],
    Facebook: [source("Gruppe", { Aktiv: false }), source("Seite")],
  }));
  const all = selectSources(config, ["blog", "facebook", "telegram"]);
  assert.deepEqual(all.phases, ["blog", "facebook", "telegram"]);
  const one = selectSources(config, ["blog", "facebook", "telegram"], "  gruppe ");
  assert.deepEqual(one.phases, ["facebook"]);
  assert.deepEqual(one.config.facebook.map((item) => [item.name, item.active]), [["Gruppe", true]]);
  assert.deepEqual([one.config.blog, one.config.telegram], [[], []]);
  assert.throws(() => selectSources(config, ["blog"], "Unbekannt"), /Vorhanden: Joe Turan, Gruppe, Seite/);
});

test("Warnungen werden nach Art gezählt", () => {
  assert.equal(warningKind("[WARN] Cookie-Datei nicht gefunden: /x/cookies.txt"), "cookies-missing");
  assert.equal(warningKind("[WARN] Keine Beiträge gefunden – Login/Cookies prüfen."), "no-posts");
  assert.equal(warningKind("[WARN] kein HTML/GraphQL-Treffer – DOM-Fallback"), "dom-fallback");
  assert.equal(warningKind("Bild konnte nicht geladen werden: x"), "image");
  assert.equal(warningKind("[WARN] Post 12: kein Datum gefunden"), "no-date");
  assert.equal(warningKind("[WARN] kein Titel ableitbar"), "other");
});

test("Statusdatei: neueste zuerst, gleicher Lauf wird ersetzt, höchstens 30 Läufe, kaputte Datei beginnt neu", (t) => {
  let status = { version: 1, runs: [] };
  for (let i = 0; i < 32; i++) status = upsertRun(status, { id: `run-${i}`, sources: [] });
  assert.equal(status.runs.length, 30);
  assert.equal(status.runs[0].id, "run-31");
  status = upsertRun(status, { id: "run-31", sources: [{ name: "A" }] });
  assert.deepEqual([status.runs.length, status.runs[0].sources.length], [30, 1]);
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "kaputt.json"), "{ nicht json");
  assert.deepEqual(readStatus(path.join(dir, "kaputt.json")), { version: 1, runs: [] });
  assert.deepEqual(readStatus(path.join(dir, "fehlt.json")), { version: 1, runs: [] });
});

test("neue Dateien relativ zu www/ wie die Artikel-IDs, nur Markdown", () => {
  const files = [path.join(WWW, "Facebook", "2026", "b.md"), path.join(WWW, "Facebook", "2026", "b.jpg"), path.join(WWW, "Facebook", "a.md")];
  assert.deepEqual(relativeNewFiles(files, WWW), ["Facebook/2026/b.md", "Facebook/a.md"]);
});

test("Lauf schreibt je Quelle Ergebnis, Warnungen, Fehler und neue Dateien in die Statusdatei", async (t) => {
  const dir = tempDir(t);
  t.mock.method(console, "log", () => {});
  process.env.SCRAPE_LOG_FILE = path.join(dir, "scrape.log");
  t.after(() => { delete process.env.SCRAPE_LOG_FILE; });
  const statusFile = path.join(dir, "scrape-status.json");
  const config = loadScraperConfig(writeConfig(dir, {
    Blog: [source("Blog")],
    Facebook: [source("Seite"), source("Pause", { Aktiv: false }), source("Kaputt")],
  }));
  let closed = false;
  const fakeBrowser = { close: async () => { closed = true; } };
  const scrapers = {
    blog: async (browser, src, opts, files) => {
      files.add(path.join(WWW, "Blog", "2026", "neu.md"));
      files.add(path.join(WWW, "Blog", "2026", "neu.jpg"));
      return [1, 3];
    },
    facebook: async (_browser, src) => {
      if (src.name === "Kaputt") throw new Error("Seite nicht erreichbar");
      // Warnungen gehen über den Logger und werden der laufenden Quelle zugeordnet.
      logger.warn("[WARN] kein HTML/GraphQL-Treffer – DOM-Fallback");
      logger.warn("[WARN] kein HTML/GraphQL-Treffer – DOM-Fallback");
      return [0, 3];
    },
  };
  const result = await runAll(["blog", "facebook"], {
    config, headless: true, trigger: "web", statusFile, wwwDir: WWW, scrapers, launch: async () => fakeBrowser,
  });
  assert.equal(closed, true);
  assert.equal(result.code, 1, "eine Quelle ist abgebrochen");
  assert.deepEqual(result.changedFiles.map((file) => path.basename(file)).sort(), ["neu.jpg", "neu.md"]);

  const [run] = readStatus(statusFile).runs;
  assert.deepEqual([run.trigger, run.exitCode, run.phases], ["web", 1, ["blog", "facebook"]]);
  assert.ok(run.finishedAt && run.startedAt <= run.finishedAt);
  const byName = Object.fromEntries(run.sources.map((item) => [item.name, item]));
  assert.deepEqual(Object.keys(byName), ["Blog", "Seite", "Pause", "Kaputt"]);
  assert.deepEqual([byName.Blog.status, byName.Blog.saved, byName.Blog.skipped, byName.Blog.newFiles],
    ["ok", 1, 3, ["Blog/2026/neu.md"]]);
  assert.equal(typeof byName.Blog.durationMs, "number");
  assert.deepEqual([byName.Seite.status, byName.Seite.warnings], ["ok", { "dom-fallback": 2 }]);
  assert.deepEqual(byName.Blog.warnings, {}, "Warnungen gehören nur zur Quelle, die sie ausgelöst hat");
  assert.deepEqual(byName.Pause, { type: "facebook", name: "Pause", status: "paused" });
  assert.deepEqual([byName.Kaputt.status, byName.Kaputt.error], ["failed", "Seite nicht erreichbar"]);
  assert.match(fs.readFileSync(process.env.SCRAPE_LOG_FILE, "utf8"), /\[FEHLER\] facebook "Kaputt" abgebrochen/);
});
