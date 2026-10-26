'use strict';

// Markdown → bereinigtes HTML für alles, was per innerHTML in die Seite kommt
// (Artikel, Dublettenvergleich, Hörbuch-Abstract, eBook-Text, Extras).
// Inhalte stammen teils aus Facebook/Telegram und dürfen kein Skript ausführen.
//  - Erlaubt sind die von marked erzeugten Elemente sowie sup/sub/br/span/div
//    und Sprungziele (<a id>, z. B. eBook-Fußnoten).
//  - Unbekannte Tags (z. B. „<kontext>“ in Prompt-Texten) werden als Text
//    sichtbar gemacht statt still zu verschwinden.
//  - Skript- und Einbettungs-Elemente werden samt Inhalt entfernt.

const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

const REMOVED_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'noscript',
  'template', 'textarea', 'select', 'option', 'button', 'form', 'meta', 'link', 'base', 'svg', 'math',
]);
const ANCHOR_TARGETS = ['id'];

const OPTIONS = {
  allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'del', 'ins', 'input'],
  allowedAttributes: {
    a: ['href', 'name', 'title', ...ANCHOR_TARGETS],
    img: ['src', 'alt', 'title', 'width', 'height'],
    input: ['type', 'checked', 'disabled'],
    ol: ['start'],
    code: ['class'],
    th: ['align'],
    td: ['align'],
    ...Object.fromEntries(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'sup', 'sub', 'span', 'div', 'p', 'li']
      .map(tag => [tag, ANCHOR_TARGETS])),
  },
  allowedClasses: { code: [/^language-[\w-]+$/] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'escape',
};

// Erster Durchgang: gefährliche Elemente samt Inhalt entfernen, alles andere
// unverändert lassen. Getrennt vom zweiten Durchgang, weil exclusiveFilter im
// Escape-Modus den vorangehenden Text des Elternelements mit verwirft.
const REMOVE_OPTIONS = {
  allowedTags: false,
  allowedAttributes: false,
  allowVulnerableTags: true,
  disallowedTagsMode: 'discard',
  // marked erzeugt für Aufgabenlisten deaktivierte Checkboxen; andere Eingaben nicht.
  exclusiveFilter: frame => REMOVED_WITH_CONTENT.has(frame.tag)
    || (frame.tag === 'input' && frame.attribs.type !== 'checkbox'),
};

function sanitizeRenderedHtml(html) {
  return sanitizeHtml(sanitizeHtml(String(html || ''), REMOVE_OPTIONS), OPTIONS);
}

function renderSafeMarkdown(markdown) {
  return sanitizeRenderedHtml(marked.parse(String(markdown || '')));
}

// Quell-Links aus „Quelle:“-Zeilen nur als http(s) übernehmen.
function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

module.exports = { renderSafeMarkdown, sanitizeRenderedHtml, safeHttpUrl };
