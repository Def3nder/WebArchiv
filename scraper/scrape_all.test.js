import test from "node:test";
import assert from "node:assert/strict";

import {
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
