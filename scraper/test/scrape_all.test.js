import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildFilename,
  cleanFacebookText,
  loadScraperConfig,
  blogTitleSuffixRe,
  stripLeadingDuplicateTitle,
  stripLeadingIntro,
} from "../scrape_all.js";

const TITLE =
  "Warum du dich selbst verlierst, wenn du kontrollieren willst, wie andere dich sehen";

test("entfernt einen fett formatierten, wiederholten Titel", () => {
  const text = `**${TITLE}**\n\nErster Absatz`;
  assert.equal(stripLeadingDuplicateTitle(text, TITLE), "Erster Absatz");
});

test("entfernt wiederholte Markdown-Überschriften", () => {
  const text = `## ${TITLE}\n\nErster Absatz`;
  assert.equal(stripLeadingDuplicateTitle(text, TITLE), "Erster Absatz");
});

test("ermöglicht danach die Entfernung des Morgenimpuls-Intros", () => {
  const text = `**${TITLE}**\n\nEin Morgenimpuls für dich ☀️\n\nErster Absatz`;
  const withoutTitle = stripLeadingDuplicateTitle(text, TITLE);
  assert.equal(stripLeadingIntro(withoutTitle), "Erster Absatz");
});

test("behält einen nur ähnlichen ersten Absatz bei", () => {
  const text = `${TITLE} – eine Erklärung\n\nErster Absatz`;
  assert.equal(stripLeadingDuplicateTitle(text, TITLE), text);
});

test("lädt alle konfigurierten Quellen aus scraper-config.json", () => {
  const config = loadScraperConfig();
  assert.deepEqual(config.blog.map((source) => source.name), ["Joe Turan"]);
  assert.deepEqual(config.facebook.map((source) => source.name), [
    "Facebook", "Joe Turan Facebook", "Joe Turan Gruppe",
  ]);
  assert.deepEqual(config.telegram.map((source) => source.name), ["Telegram"]);
  assert.match(config.facebook[1].outputDir, /www[\\/]Joe Turan Facebook$/);
});

test("verwendet den konfigurierten Autor im neuen Facebook-Dateinamen", () => {
  assert.equal(
    buildFilename("2026-07-26", "Ein_Beispiel", "Nawal Boussi"),
    "2026-07-26_Nawal Boussi - Ein_Beispiel.md"
  );
});

test("bewahrt die bisherigen Dateinamen für Facebook und Telegram über FileAuthor", () => {
  const config = loadScraperConfig();
  assert.equal(config.facebook[0].fileAuthor, "Joe Turan");
  assert.equal(config.telegram[0].fileAuthor, "Joe Turan");
  assert.equal(config.facebook[2].fileAuthor, "Joe Turan Gruppe", "ohne FileAuthor gilt der Name");
});

test("Signatur und Ausschlussfilter kommen aus der Konfiguration", () => {
  const config = loadScraperConfig();
  assert.deepEqual(config.blog[0].signature, { name: "Joe Turan", website: "joeturan.com" });
  assert.ok(config.telegram[0].exclude.test("Kuschel-Workshop am Samstag"));
  assert.equal(config.facebook[1].signature, null);
  assert.equal(config.facebook[1].exclude, null);
});

test("Blog-Titelendung wird aus der Domain der Quelle abgeleitet", () => {
  const re = blogTitleSuffixRe("https://www.example.org/blog");
  assert.equal("Ein Titel / Blog | www.example.org".replace(re, ""), "Ein Titel");
  assert.equal("Ein Titel / Blog | example.org".replace(re, ""), "Ein Titel");
  assert.equal("Ein Titel / Blog | www.anderes.de".replace(re, ""), "Ein Titel / Blog | www.anderes.de");
});

test("ungültige Quellenoptionen werden beim Laden abgelehnt", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scraper-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = entry => {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ Blog: [], Facebook: [{ Name: "X", URL: "https://example.org", OutputPath: "../www/X", ...entry }], Telegram: [] }));
    return file;
  };
  assert.throws(() => loadScraperConfig(write({ Exclude: "(" })), /Exclude/);
  assert.throws(() => loadScraperConfig(write({ Signature: {} })), /Signature/);
  assert.throws(() => loadScraperConfig(write({ FileAuthor: "a/b" })), /FileAuthor/);
});

test("wendet Joe-spezifische Facebook-Bereinigung nicht auf Nawal an", () => {
  const text = "Beitrag von Nawal\n\nJoe Turan\njoeturan.com";
  assert.equal(
    cleanFacebookText(text, null),
    text
  );
});
