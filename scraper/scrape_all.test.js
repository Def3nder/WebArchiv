import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFilename,
  cleanFacebookText,
  loadScraperConfig,
  postAuthorName,
  stripLeadingDuplicateTitle,
  stripLeadingIntro,
} from "./scrape_all.js";

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
  assert.deepEqual(config.facebook.map((source) => source.name), ["Facebook", "Nawal Boussi"]);
  assert.deepEqual(config.telegram.map((source) => source.name), ["Telegram"]);
  assert.match(config.facebook[1].outputDir, /www[\\/]Nawal Boussi$/);
});

test("verwendet den konfigurierten Autor im neuen Facebook-Dateinamen", () => {
  assert.equal(
    buildFilename("2026-07-26", "Ein_Beispiel", "Nawal Boussi"),
    "2026-07-26_Nawal Boussi - Ein_Beispiel.md"
  );
});

test("bewahrt die bisherigen Dateinamen für Facebook und Telegram", () => {
  assert.equal(postAuthorName("facebook", "Facebook"), "Joe Turan");
  assert.equal(postAuthorName("telegram", "Telegram"), "Joe Turan");
  assert.equal(postAuthorName("facebook", "Nawal Boussi"), "Nawal Boussi");
});

test("wendet Joe-spezifische Facebook-Bereinigung nicht auf Nawal an", () => {
  const text = "Beitrag von Nawal\n\nJoe Turan\njoeturan.com";
  assert.equal(
    cleanFacebookText(text, "Nawal Boussi"),
    text
  );
});
