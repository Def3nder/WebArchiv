import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { convertEpub, checkMarkdown } from '../convert.js';

const XHTML = body => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>t</title></head><body>${body}</body></html>`;

// Baut ein EPUB im Temp-Ordner. files: Pfad (relativ zu OEBPS/) → Inhalt (String oder Buffer).
function makeEpub({ manifest, spine, files, extraOpf = '' }) {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from(`<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`));
  const items = manifest.map(([id, href, type, props]) =>
    `<item id="${id}" href="${href}" media-type="${type}"${props ? ` properties="${props}"` : ''}/>`).join('');
  zip.addFile('OEBPS/content.opf', Buffer.from(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>Testbuch</dc:title><dc:creator>Tester</dc:creator><dc:language>de</dc:language></metadata>
<manifest>${items}</manifest><spine>${spine.map(id => `<itemref idref="${id}"/>`).join('')}</spine>${extraOpf}</package>`));
  for (const [name, content] of Object.entries(files)) zip.addFile(`OEBPS/${name}`, Buffer.isBuffer(content) ? content : Buffer.from(content));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'epubtest-')), 'test.epub');
  zip.writeZip(file);
  return file;
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const X = 'application/xhtml+xml';

test('Inhaltsverzeichnis, Verweise, Bilder und Hervorhebungen', () => {
  const file = makeEpub({
    manifest: [['nav', 'nav.xhtml', X, 'nav'], ['c1', 'c1.xhtml', X], ['c2', 'c2.xhtml', X], ['img', 'bilder/Foto 1.png', 'image/png']],
    spine: ['nav', 'c1', 'c2'],
    files: {
      'nav.xhtml': XHTML('<nav epub:type="toc"><h1>Inhalt</h1><ol><li><a href="c1.xhtml">Eins</a><ol><li><a href="c1.xhtml#teil">Teil A</a></li></ol></li><li><a href="c2.xhtml">Zwei</a></li><li><a href="c9.xhtml">Weg</a></li></ol></nav>'),
      'c1.xhtml': XHTML(`<h1>Eins</h1><p>Siehe <a href="c2.xhtml#z">Zwei</a> und <a href="http://example.org/a_b">Web</a> sowie <a href="c2.xhtml#gibtsnicht">tot</a>.</p>
        <h2 id="teil">Teil A</h2><p><img src="bilder/Foto%201.png" alt="Ein Bild"/> <em>Hauptsache unterwegs-</em>Modus, 2025<strong>.</strong> a_b *x* #nein <b> fett </b>und</p>
        <p>1. keine Liste</p><ul><li>Punkt <i>eins</i></li><li>Punkt zwei<ul><li>innen</li></ul></li></ul>`),
      'c2.xhtml': XHTML('<h1>Zwei</h1><p id="z">Ziel</p><table><tr><th>A</th><th>B|C</th></tr><tr><td>1</td><td>2</td></tr></table>'),
      'bilder/Foto 1.png': PNG,
    },
  });
  const r = convertEpub(file);
  const md = r.markdown;
  assert.equal(r.meta.title, 'Testbuch');
  assert.equal(r.meta.author, 'Tester');
  // erzeugtes Inhaltsverzeichnis ersetzt das veröffentlichte, Eintrag „Weg“ (kein Ziel) entfällt
  assert.match(md, /^# <a id="inhaltsverzeichnis"><\/a>Inhalt\n\n- \[Eins\]\(#a-\d+\)\n {2}- \[Teil A\]\(#a-\d+\)\n- \[Zwei\]\(#a-\d+\)\n/);
  assert.doesNotMatch(md, /Weg/);
  // Verweise zwischen Kapiteln, externer Link, Verweis ohne Ziel → Text
  assert.match(md, /Siehe \[Zwei\]\(#a-\d+\) und \[Web\]\(http:\/\/example\.org\/a_b\) sowie tot\./);
  assert.match(md, /<a id="a-\d+"><\/a>Ziel/);
  // Bild kopiert, Name bereinigt, Pfad relativ
  assert.deepEqual(r.images.map(i => i.name), ['Foto_1.png']);
  assert.match(md, /!\[Ein Bild\]\(images\/Foto_1\.png\)/);
  // Hervorhebungen: Randfälle fallen auf HTML zurück, Satzzeichen-Fett entfällt, Sonderzeichen maskiert
  assert.match(md, /<em>Hauptsache unterwegs-<\/em>Modus, 2025\. a_b \\\*x\\\* #nein \*\*fett\*\* und/);
  assert.match(md, /^1\\\. keine Liste$/m);
  // Listen und Tabellen
  assert.match(md, /- Punkt \*eins\*\n- Punkt zwei\n {2}- innen/);
  assert.match(md, /\| A \| B\\\|C \|\n\| --- \| --- \|\n\| 1 \| 2 \|/);
  assert.deepEqual(checkMarkdown(md).missing, []);
  assert.equal(r.stats.unresolved, 1);
});

test('Endnoten (EPUB 3) werden zu Sprungmarken mit Rücksprung', () => {
  const file = makeEpub({
    manifest: [['c1', 'c1.xhtml', X], ['en', 'endnotes.xhtml', X]],
    spine: ['c1', 'en'],
    files: {
      'c1.xhtml': XHTML('<h1>Kapitel</h1><p>Satz<span id="r1"><a epub:type="noteref" href="endnotes.xhtml#n1">7</a></span> und mehr<a epub:type="noteref" href="endnotes.xhtml#n2">8</a>.</p>'),
      'endnotes.xhtml': XHTML('<section epub:type="endnotes"><h2>Anmerkungen</h2><ol><li id="n1" epub:type="endnote"><p><a href="c1.xhtml#r1" epub:type="backlink">7</a> Erste Quelle, <em>Titel</em>.</p></li><li id="n2" epub:type="endnote"><p>Zweite Quelle.</p></li></ol></section>'),
    },
  });
  const { markdown: md, stats, check } = convertEpub(file);
  assert.equal(stats.notes, 2);
  assert.match(md, /Satz<a id="ref-1"><\/a><sup>\[7\]\(#anm-1\)<\/sup> und mehr<a id="ref-2"><\/a><sup>\[8\]\(#anm-2\)<\/sup>\./);
  assert.match(md, /# <a id="anmerkungen"><\/a>Anmerkungen\n\n<a id="anm-1"><\/a>\*\*7\.\*\* Erste Quelle, \*Titel\*\. \[↩\]\(#ref-1\)\n\n<a id="anm-2"><\/a>\*\*8\.\*\* Zweite Quelle\. \[↩\]\(#ref-2\)\n$/);
  // das Notenkapitel kommt nicht zusätzlich im Fließtext vor
  assert.equal(md.match(/Erste Quelle/g).length, 1);
  assert.deepEqual(check.missing, []);
});

test('Fußnoten ohne epub:type werden über Rücksprung erkannt', () => {
  const file = makeEpub({
    manifest: [['c1', 'c1.xhtml', X]],
    spine: ['c1'],
    files: {
      'c1.xhtml': XHTML('<p>Text<sup><a id="back1" href="#fn1">1</a></sup> weiter, <a href="#ziel">Sprung</a>.</p><p id="ziel">Hier.</p><hr/><p id="fn1"><a href="#back1">1</a> Eine Fußnote.</p>'),
    },
  });
  const { markdown: md, stats } = convertEpub(file);
  assert.equal(stats.notes, 1);
  assert.match(md, /Text<a id="ref-1"><\/a><sup>\[1\]\(#anm-1\)<\/sup> weiter, \[Sprung\]\(#a-\d+\)\./);
  assert.match(md, /<a id="anm-1"><\/a>\*\*1\.\*\* Eine Fußnote\. \[↩\]\(#ref-1\)/);
  assert.equal(md.match(/Eine Fußnote/g).length, 1);
});

test('Calibre-Stil: ncx, Ziel am Ende des Vorabsatzes, Fett per CSS-Klasse → Überschrift', () => {
  const ncx = '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>'
    + '<navPoint><navLabel><text>Kapitel Eins</text></navLabel><content src="a.html#pos1"/></navPoint>'
    + '<navPoint><navLabel><text>Kapitel Zwei</text></navLabel><content src="b.html"/></navPoint></navMap></ncx>';
  const file = makeEpub({
    manifest: [['ncx', 'toc.ncx', 'application/x-dtbncx+xml'], ['css', 'style.css', 'text/css'], ['a', 'a.html', X], ['b', 'b.html', X]],
    spine: ['a', 'b'],
    files: {
      'toc.ncx': ncx,
      'style.css': '.bold { font-weight: bold; }\n.kursiv { font-style: italic }',
      'a.html': XHTML('<p>Vorspann<a id="pos1"/></p><div class="mbp_pagebreak"></div><p style="height:1em">&#160;</p><p><span class="bold">Kapitel Eins</span></p><p>Text mit <span class="kursiv">Schräg</span>.</p>'),
      'b.html': XHTML('<p>&nbsp; &nbsp;</p><p><span class="bold">Kapitel Zwei</span></p><p>Mehr Text.</p><p><span class="bold">Nur fett, kein Ziel</span></p>'),
    },
  });
  const { markdown: md, check } = convertEpub(file);
  assert.match(md, /^# <a id="inhaltsverzeichnis"><\/a>Inhaltsverzeichnis\n\n- \[Kapitel Eins\]\(#a-\d+\)\n- \[Kapitel Zwei\]\(#a-\d+\)/);
  assert.match(md, /^# <a id="a-\d+"><\/a>Kapitel Eins$/m);
  assert.match(md, /^# <a id="a-\d+"><\/a>Kapitel Zwei$/m);
  assert.match(md, /Text mit \*Schräg\*\./);
  assert.match(md, /^\*\*Nur fett, kein Ziel\*\*$/m);
  assert.doesNotMatch(md, /^\s*$\n\s* /m); // keine Absätze aus geschützten Leerzeichen
  assert.deepEqual(check.missing, []);
});

test('Fehler bei Nicht-EPUB', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'epubtest-')), 'kein.epub');
  const zip = new AdmZip();
  zip.addFile('hallo.txt', Buffer.from('x'));
  zip.writeZip(file);
  assert.throws(() => convertEpub(file), /container\.xml/);
});
