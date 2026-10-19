const test = require('node:test');
const assert = require('node:assert/strict');
const { renderPair, renderAlignedRows, renderUnifiedRows } = require('../public/duplicate-diff.js');

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

test('zusätzlicher Facebook-Absatz belegt eine eigene Zeile, danach sind gleiche Textblöcke ausgerichtet', () => {
  const blog = ['Sie kann eine Ehe verlassen.', 'Danach beginnt etwas Neues.'];
  const facebook = ['Eine Frau kann frei aussehen.', ...blog];
  const rows = renderAlignedRows(blog, facebook);
  assert.deepEqual(rows.map(row => row.kind), ['facebook-only', 'equal', 'equal']);
  assert.match(rows[0].blog, /Kein Text im Blog/);
  assert.equal(rows[1].blog, rows[1].facebook);
  assert.equal(rows[2].blog, rows[2].facebook);
});

test('Leerzeichen, Zeilenumbrüche und unsichtbare Unicode-Zeichen erzeugen keine Unterschiede', () => {
  const rows = renderAlignedRows(['Sie kann gehen.\nDas bleibt.'], ['Sie\u200B kann  gehen.\r\nDas bleibt.']);
  assert.deepEqual(rows.map(row => row.kind), ['equal']);
  assert.deepEqual(renderAlignedRows(['Sie kann gehen.'], ['Sie\u00a0kann gehen.'], { onlyDifferences: true })
    .map(row => row.kind), ['identical']);
});

test('geänderte Textblöcke stehen paarweise und markieren nur ihre sichtbaren Wörter', () => {
  const rows = renderAlignedRows(['Wir brauchen Vertrauen.', 'Danach reden wir.'], ['Wir brauchen Geduld.', 'Danach reden wir.']);
  assert.deepEqual(rows.map(row => row.kind), ['changed', 'equal']);
  assert.match(rows[0].blog, /<mark>Vertrauen<\/mark>/);
  assert.match(rows[0].facebook, /<mark>Geduld<\/mark>/);
});

test('Kurzansicht behält genau einen gemeinsamen Textblock vor und nach einem Änderungsblock', () => {
  const blog = ['Weit davor.', 'Direkt davor.', 'Im Blog anders.', 'Direkt danach.', 'Weit danach.'];
  const facebook = ['Weit davor.', 'Direkt davor.', 'Auf Facebook anders.', 'Direkt danach.', 'Weit danach.'];
  const rows = renderAlignedRows(blog, facebook, { onlyDifferences: true });
  assert.deepEqual(rows.map(row => row.kind), ['ellipsis', 'context', 'changed', 'context', 'ellipsis']);
  assert.equal(rows[1].blog, rows[1].facebook);
  assert.equal(rows[3].blog, rows[3].facebook);
});

test('einspaltiger Diff kennzeichnet nur Facebook rot und nur Blog grün samt Zeilennummern', () => {
  const rows = renderUnifiedRows(['Gemeinsam.', 'Im Blog neu.', 'Ende.'], ['Nur Facebook.', 'Gemeinsam.', 'Ende.']);
  assert.deepEqual(rows.map(row => row.kind), ['removed', 'equal', 'added', 'equal']);
  assert.deepEqual([rows[0].facebookNumber, rows[0].blogNumber], [1, null]);
  assert.deepEqual([rows[2].facebookNumber, rows[2].blogNumber], [null, 2]);
  assert.equal(rows[1].html, 'Gemeinsam.');
});

test('geänderte Wörter ergeben zuerst eine rote Facebook- und dann eine grüne Blog-Zeile', () => {
  const rows = renderUnifiedRows(['Wir brauchen Vertrauen.'], ['Wir brauchen Geduld.']);
  assert.deepEqual(rows.map(row => row.kind), ['removed', 'added']);
  assert.match(rows[0].html, /<mark>Geduld<\/mark>/);
  assert.match(rows[1].html, /<mark>Vertrauen<\/mark>/);
});

test('unveränderte Zeilen werden mit Anzahl faltbar und mit vollständigem Text angeboten', () => {
  const blog = ['Eins.', 'Zwei.', 'Drei.', 'Blog anders.', 'Vier.', 'Fünf.', 'Sechs.'];
  const facebook = ['Eins.', 'Zwei.', 'Drei.', 'Facebook anders.', 'Vier.', 'Fünf.', 'Sechs.'];
  const rows = renderUnifiedRows(blog, facebook, { onlyDifferences: true });
  assert.deepEqual(rows.map(row => row.kind), ['fold', 'equal', 'removed', 'added', 'equal', 'fold']);
  assert.equal(rows[0].count, 2);
  assert.deepEqual(rows[0].lines.map(line => line.html), ['Eins.', 'Zwei.']);
  assert.equal(rows.at(-1).count, 2);
  assert.deepEqual(rows.at(-1).lines.map(line => line.html), ['Fünf.', 'Sechs.']);
  assert.doesNotMatch(rows[0].lines[0].html, /\[…\]/);
});

test('identischer Text zeigt eine Meldung und lässt sämtliche Zeilen ausklappen', () => {
  const rows = renderUnifiedRows(['Eins.', 'Zwei.'], ['Eins.', 'Zwei.'], { onlyDifferences: true });
  assert.deepEqual(rows.map(row => row.kind), ['identical', 'fold']);
  assert.equal(rows[1].count, 2);
});

test('Steuerzeichen und unsichtbare Unicode-Zeichen erzeugen auch im Code-Diff keine Änderung', () => {
  const rows = renderUnifiedRows(['Gleicher\u0000 Text.', 'Noch einer.'], ['Gleicher\u200b Text.', 'Noch einer.']);
  assert.deepEqual(rows.map(row => row.kind), ['equal', 'equal']);
});

test('eingeschobener gerenderter Absatz bleibt vollständig vor dem nächsten gemeinsamen Absatz', () => {
  const sharedStart = 'Ein gemeinsamer Absatz.';
  const inserted = '„Ein Zitat“ Dr. C.G. Jung';
  const sharedEnd = 'Stell dir vor, du baust einen Turm. Du setzt weitere Stockwerke darauf.';
  const rows = renderUnifiedRows([sharedStart, inserted, sharedEnd], [sharedStart, sharedEnd]);
  assert.deepEqual(rows.map(row => row.kind), ['equal', 'added', 'equal']);
  assert.equal(rows[1].html, inserted);
  assert.equal(rows[2].html, sharedEnd);
});

test('abweichende Leerabsätze ohne Textänderung bleiben unsichtbar', () => {
  const rows = renderUnifiedRows(['Eine Zeile ohne Punkt  und weiter'], ['Eine Zeile ohne Punkt und weiter']);
  assert.deepEqual(rows.map(row => row.kind), ['equal']);
  assert.equal(rows[0].html, 'Eine Zeile ohne Punkt und weiter');
});
