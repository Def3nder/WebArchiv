const test = require('node:test');
const assert = require('node:assert/strict');
const { renderPair, renderAlignedRows } = require('../public/duplicate-diff.js');

test('identische Texte bleiben vollständig unmarkiert', () => {
  assert.deepEqual(renderPair('Gleicher Text.', 'Gleicher Text.'), {
    blog: 'Gleicher Text.', facebook: 'Gleicher Text.',
  });
});

test('ein vorangestellter wiederholter Titel wird vollständig als Unterschied markiert', () => {
  const title = 'Wie ein Mann bei einer Frau bleibt, deren Körper Gewalt überlebt hat';
  const body = 'Wenn du eine Frau liebst, deren Körper Gewalt überlebt hat, hilft Geduld.';
  const html = renderPair(body, `${title}\n\n${body}`);
  assert.match(html.facebook, /^<mark>Wie ein Mann bei einer Frau bleibt, deren Körper Gewalt überlebt hat<br><br><\/mark>/);
  assert.doesNotMatch(html.facebook.slice(html.facebook.indexOf('Wenn du')), /<mark>/);
  assert.equal(html.blog, body);
});

test('Einfügungen, Löschungen und Satzzeichen bleiben positionsbezogen sichtbar', () => {
  assert.deepEqual(renderPair('Alpha neuer ganzer Satz. Omega', 'Alpha Omega'), {
    blog: 'Alpha <mark>neuer ganzer Satz. </mark>Omega', facebook: 'Alpha Omega',
  });
  assert.deepEqual(renderPair('Alpha! Omega', 'Alpha? Omega'), {
    blog: 'Alpha<mark>!</mark> Omega', facebook: 'Alpha<mark>?</mark> Omega',
  });
});

test('HTML aus Artikeltexten wird auch innerhalb markierter Passagen escaped', () => {
  assert.equal(renderPair('<script>alert(1)</script>', '').blog, '<mark>&lt;script&gt;alert(1)&lt;/script&gt;</mark>');
});

test('Kurzansicht behält je eine Kontextzeile und blendet lange gleiche Passagen aus', () => {
  const prefix = `Weit davor\n${'Vorlauf '.repeat(20)}Direkt davor `;
  const suffix = ` Direkt danach${' Nachlauf'.repeat(20)}\nWeit danach`;
  const html = renderPair(`${prefix}Blog-Wort${suffix}`, `${prefix}Facebook-Wort${suffix}`, {
    onlyDifferences: true, contextChars: 34,
  });
  assert.match(html.blog, /\[…\]/);
  assert.match(html.blog, /<mark>Blog<\/mark>/);
  assert.match(html.facebook, /<mark>Facebook<\/mark>/);
  assert.doesNotMatch(html.blog, /Weit davor|Weit danach/);
  const contexts = [...html.blog.matchAll(/class="duplicate-diff-context">([^<]*)/g)].map(match => match[1]);
  assert.equal(contexts.length, 2);
  assert.ok(contexts.every(line => line.length <= 34));
  assert.match(contexts[0], /^Vorlauf/);
  assert.match(contexts[0], /Direkt davor/);
  assert.match(contexts[1], /Direkt danach/);
});

test('getrennte Änderungen bleiben beide sichtbar und zeigen ausgelassene Mitte', () => {
  const middle = ' Gleicher Mittelteil.'.repeat(30);
  const html = renderPair(`Blog eins.${middle} Blog zwei.`, `Facebook eins.${middle} Facebook zwei.`, {
    onlyDifferences: true, contextChars: 32,
  });
  assert.equal((html.blog.match(/class="duplicate-diff-hunk"/g) || []).length, 2);
  assert.equal((html.blog.match(/<mark>Blog<\/mark>/g) || []).length, 2);
  assert.equal((html.facebook.match(/<mark>Facebook<\/mark>/g) || []).length, 2);
  assert.doesNotMatch(html.blog, /Gleicher Mittelteil\. Gleicher Mittelteil\. Gleicher Mittelteil\./);
});

test('einseitige Einfügung und identische Texte sind in der Kurzansicht eindeutig', () => {
  const addition = renderPair('Anfang Ende', 'Anfang zusätzlich Ende', { onlyDifferences: true });
  assert.match(addition.blog, /Keine Entsprechung auf dieser Seite/);
  assert.match(addition.facebook, /<mark>zusätzlich <\/mark>/);
  const identical = renderPair('Identisch', 'Identisch', { onlyDifferences: true });
  assert.match(identical.blog, /Keine Textunterschiede/);
  assert.match(identical.facebook, /Keine Textunterschiede/);
});

test('gemeinsame Satzzeichen bleiben direkt an der Änderung', () => {
  const html = renderPair('Ich will Geduld. Weiter.', 'Ich will Zeit. Weiter.', { onlyDifferences: true });
  assert.match(html.blog, /<mark>Geduld<\/mark>\./);
  assert.match(html.facebook, /<mark>Zeit<\/mark>\./);
});

test('Kurzansicht escaped auch Kontext und Änderungen', () => {
  const html = renderPair('Vorher <b>Blog</b> Danach', 'Vorher <i>Facebook</i> Danach', { onlyDifferences: true });
  assert.doesNotMatch(html.blog, /<b>/);
  assert.doesNotMatch(html.facebook, /<i>/);
  assert.match(html.blog, /&lt;/);
});

test('zusätzlicher Facebook-Einstieg belegt eine eigene Zeile, danach sind gleiche Sätze ausgerichtet', () => {
  const blog = 'Sie kann eine Ehe verlassen. Danach beginnt etwas Neues.';
  const facebook = 'Eine Frau kann frei aussehen. Sie kann eine Ehe verlassen. Danach beginnt etwas Neues.';
  const rows = renderAlignedRows(blog, facebook);
  assert.deepEqual(rows.map(row => row.kind), ['facebook-only', 'equal', 'equal']);
  assert.match(rows[0].blog, /Kein Text im Blog/);
  assert.equal(rows[1].blog, rows[1].facebook);
  assert.equal(rows[2].blog, rows[2].facebook);
});

test('Leerzeichen, Zeilenumbrüche und unsichtbare Unicode-Zeichen erzeugen keine Unterschiede', () => {
  const rows = renderAlignedRows('Sie kann gehen.\nDas bleibt.', 'Sie\u200B kann  gehen.\r\nDas bleibt.');
  assert.deepEqual(rows.map(row => row.kind), ['equal', 'equal']);
  assert.deepEqual(renderAlignedRows('Sie kann gehen.', 'Sie\u00a0kann gehen.', { onlyDifferences: true })
    .map(row => row.kind), ['identical']);
});

test('geänderte Sätze stehen paarweise und markieren nur ihre sichtbaren Wörter', () => {
  const rows = renderAlignedRows('Wir brauchen Vertrauen. Danach reden wir.', 'Wir brauchen Geduld. Danach reden wir.');
  assert.deepEqual(rows.map(row => row.kind), ['changed', 'equal']);
  assert.match(rows[0].blog, /<mark>Vertrauen<\/mark>/);
  assert.match(rows[0].facebook, /<mark>Geduld<\/mark>/);
});

test('Kurzansicht behält genau einen gemeinsamen Satz vor und nach einem Änderungsblock', () => {
  const blog = 'Weit davor. Direkt davor. Im Blog anders. Direkt danach. Weit danach.';
  const facebook = 'Weit davor. Direkt davor. Auf Facebook anders. Direkt danach. Weit danach.';
  const rows = renderAlignedRows(blog, facebook, { onlyDifferences: true });
  assert.deepEqual(rows.map(row => row.kind), ['ellipsis', 'context', 'changed', 'context', 'ellipsis']);
  assert.equal(rows[1].blog, rows[1].facebook);
  assert.equal(rows[3].blog, rows[3].facebook);
});
