// EPUB → Markdown für die eBook-Ansicht der Hörbücher (public/book-reader.js).
// Reine Funktion ohne Dateischreiben: convertEpub(pfad) liefert Markdown + Bilder + Meldungen.
//
// Zielformat (wie der Reader es versteht):
//  - Sprungziele sind immer ausdrückliche Anker  <a id="a-12"></a>  (keine Überschriften-Kürzel),
//    Verweise  [Text](#a-12). Der Reader findet Ziele über id="…".
//  - Fußnoten/Endnoten: im Text  <a id="ref-3"></a><sup>[3](#anm-3)</sup>,
//    am Ende unter „Anmerkungen“:  <a id="anm-3"></a>**3.** Text [↩](#ref-3)
//  - Bilder:  ![alt](images/datei.jpg)  (flacher Ordner images/ neben der .md)
import AdmZip from 'adm-zip';
import { parseDocument } from 'htmlparser2';
import path from 'node:path';

const posix = path.posix;

// Unsichtbare Zeichen als benannte Konstanten (nicht als Literale im Quelltext).
const ch = code => String.fromCharCode(code);
const NBSP = ch(0xa0);
const SHY = ch(0xad);
const B_OPEN = ch(0xe010); // Platzhalter für Fett/Kursiv, werden erst im fertigen Absatz aufgelöst
const B_CLOSE = ch(0xe011);
const I_OPEN = ch(0xe012);
const I_CLOSE = ch(0xe013);
const RE_SHY = new RegExp(SHY, 'g');
const RE_NBSP = new RegExp(NBSP, 'g');
const EDGE_WS = `[ ${NBSP}${ch(0x2000)}-${ch(0x200b)}${ch(0x3000)}]`;
const RE_EDGE = new RegExp(`^${EDGE_WS}+|${EDGE_WS}+$`, 'g');
const RE_SPACE_RUN = new RegExp(`[ \\t\\r\\f${NBSP}]{2,}|[\\t\\r\\f]`, 'g');
const RE_BLANK = new RegExp(`^[\\s${NBSP}]*$`);
const RE_ANY_MARK = new RegExp(`[${B_OPEN}-${I_CLOSE}]`);

// ---------- DOM-Helfer ----------

const BLOCK = new Set(['p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'figure',
  'figcaption', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'hr',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'body', 'html', 'address', 'details', 'summary',
  'fieldset', 'form', 'center']);
const SKIP = new Set(['head', 'script', 'style', 'title', 'meta', 'link', 'template', 'noscript', 'audio', 'video',
  'object', 'canvas', 'iframe', 'button', 'input', 'select', 'textarea']);
const UNIT = new Set(['li', 'p', 'div', 'aside', 'dd', 'dt', 'td', 'th', 'section', 'blockquote', 'figure']);

// Benannte Entitäten, die in XHTML eigentlich nicht erlaubt sind, aber in der Praxis vorkommen.
const NAMED = {
  nbsp: 160, shy: 173, hellip: 8230, mdash: 8212, ndash: 8211, lsquo: 8216, rsquo: 8217, ldquo: 8220, rdquo: 8221,
  laquo: 171, raquo: 187, bdquo: 8222, sbquo: 8218, copy: 169, reg: 174, trade: 8482, euro: 8364, middot: 183,
  bull: 8226, auml: 228, ouml: 246, uuml: 252, Auml: 196, Ouml: 214, Uuml: 220, szlig: 223, eacute: 233,
  egrave: 232, agrave: 224, acirc: 226, ecirc: 234, ccedil: 231, deg: 176, sect: 167, para: 182, times: 215,
  frac12: 189, larr: 8592, rarr: 8594, thinsp: 8201, ensp: 8194, emsp: 8195, dagger: 8224,
};
const XML_ENT = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

const lname = el => (el.name || '').toLowerCase().replace(/^.*:/, '');
const attr = (el, name) => el.attribs?.[name];
const isTag = n => n.type === 'tag';
const types = el => (attr(el, 'epub:type') || '').split(/\s+/).filter(Boolean);
const role = el => (attr(el, 'role') || '').trim();

function textContent(n) {
  if (n.type === 'text') return n.data;
  return n.children ? n.children.map(textContent).join('') : '';
}

function findAll(node, test, out = []) {
  for (const child of node.children || []) {
    if (isTag(child)) {
      if (test(child)) out.push(child);
      findAll(child, test, out);
    } else if (child.children) findAll(child, test, out);
  }
  return out;
}

function parseXml(str) {
  const text = str.replace(/^﻿/, '').replace(/&([A-Za-z][A-Za-z0-9]*);/g, (m, name) =>
    XML_ENT.has(name) ? m : (NAMED[name] ? `&#${NAMED[name]};` : m));
  return parseDocument(text, { xmlMode: true, decodeEntities: true });
}

const collapseWs = s => s.replace(/[ \t\r\n\f]+/g, ' ');
const trimWs = s => s.replace(/^[ \t\r\n\f]+|[ \t\r\n\f]+$/g, '');
const cleanTitle = s => trimWs(collapseWs(s.replace(RE_SHY, '').replace(RE_NBSP, ' ')));
const isAlnum = ch => !!ch && /[\p{L}\p{N}]/u.test(ch);

function decode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// ---------- Markdown-Escaping ----------

function escapeText(s) {
  return s
    .replace(RE_SHY, '')
    .replace(/[\\`*[\]<]/g, '\\$&')
    .replace(/_/g, (m, off, str) => (isAlnum(str[off - 1]) && isAlnum(str[off + 1]) ? m : '\\_'))
    .replace(/~~/g, '\\~\\~')
    .replace(/&(?=#?\w+;)/g, '&amp;');
}

function escapeLineStart(line) {
  return line
    .replace(/^(#{1,6})(\s|$)/, '\\$1$2')
    .replace(/^>/, '\\>')
    .replace(/^([-+])(\s|$)/, '\\$1$2')
    .replace(/^(\d{1,9})([.)])(\s|$)/, '$1\\$2$3')
    .replace(/^(-{3,}|={3,})$/, '\\$1');
}

// Rohen Inline-Text (mit \n für <br>) zu einem fertigen Absatz machen.
function finishInline(str) {
  const lines = resolveEmphasis(str).split('\n')
    .map(l => l.replace(RE_SPACE_RUN, ' ').replace(RE_EDGE, ''))
    .filter(Boolean)
    .map(escapeLineStart);
  return lines.join('  \n');
}

// Hervorhebung: '**' (fett), '*' (kursiv) als Platzhalter, '~~' (durchgestrichen) direkt.
// Reine Satzzeichen werden nicht hervorgehoben (wären in Markdown ohnehin ungültig).
function wrapMark(marker, inner) {
  if (RE_BLANK.test(inner)) return inner;
  const lead = inner.match(/^[ \t\r\n\f]*/)[0];
  const trail = inner.match(/[ \t\r\n\f]*$/)[0];
  const core = inner.slice(lead.length, inner.length - trail.length);
  if (!/[\p{L}\p{N}]/u.test(core.replace(/<[^>]*>/g, ''))) return inner;
  if (marker === '**') return lead + B_OPEN + core + B_CLOSE + trail;
  if (marker === '*') return lead + I_OPEN + core + I_CLOSE + trail;
  return lead + marker + core + marker + trail;
}

// Platzhalter → '**'/'*', wenn CommonMark die Hervorhebung dort versteht (Flankierungsregeln),
// sonst <strong>/<em>, damit z. B. *Wort-*Modus oder 2025**.** nicht als Sternchen erscheinen.
function resolveEmphasis(str) {
  if (!RE_ANY_MARK.test(str)) return str;
  const isMark = c => c >= B_OPEN && c <= I_CLOSE;
  const stack = { b: [], i: [] };
  const pairs = [];
  for (let k = 0; k < str.length; k++) {
    const c = str[k];
    if (c === B_OPEN) stack.b.push(k);
    else if (c === I_OPEN) stack.i.push(k);
    else if (c === B_CLOSE || c === I_CLOSE) {
      const kind = c === B_CLOSE ? 'b' : 'i';
      const open = stack[kind].pop();
      if (open !== undefined) pairs.push({ open, close: k, kind });
    }
  }
  const before = idx => { for (let k = idx - 1; k >= 0; k--) if (!isMark(str[k])) return str[k]; return ''; };
  const after = idx => { for (let k = idx + 1; k < str.length; k++) if (!isMark(str[k])) return str[k]; return ''; };
  const space = c => !c || /\s/.test(c);
  const punct = c => !!c && (/[\p{P}\p{S}]/u.test(c) || c === L_OPEN || c === L_CLOSE || c === L_MID);
  const out = new Map();
  for (const p of pairs) {
    const first = after(p.open);
    const last = before(p.close);
    const left = !space(first) && (!punct(first) || space(before(p.open)) || punct(before(p.open)));
    const right = !space(last) && (!punct(last) || space(after(p.close)) || punct(after(p.close)));
    const md = left && right;
    const tag = p.kind === 'b' ? 'strong' : 'em';
    out.set(p.open, md ? (p.kind === 'b' ? '**' : '*') : `<${tag}>`);
    out.set(p.close, md ? (p.kind === 'b' ? '**' : '*') : `</${tag}>`);
  }
  let result = '';
  for (let k = 0; k < str.length; k++) result += isMark(str[k]) ? (out.get(k) ?? '') : str[k];
  return result;
}

function mdUrl(url) {
  return url.replace(/[ ()<>]/g, c => ({ ' ': '%20', '(': '%28', ')': '%29', '<': '%3C', '>': '%3E' }[c]));
}

const indentLines = (s, pad) => s.split('\n').map((l, i) => (i === 0 || !l ? l : pad + l)).join('\n');

// Marker für Verweise, die erst nach der Konvertierung aufgelöst werden (Ziel muss existieren).
const L_OPEN = ch(0xe000);
const L_MID = ch(0xe001);
const L_CLOSE = ch(0xe002);
const linkMarker = (key, text) => `${L_OPEN}${key}${L_MID}${text}${L_CLOSE}`;

export const TOC_ANCHOR = 'inhaltsverzeichnis';
export const NOTES_ANCHOR = 'anmerkungen';

// ---------- Hauptfunktion ----------

export function convertEpub(epubPath) {
  const zip = new AdmZip(epubPath);
  const warnings = [];
  const warn = msg => { if (warnings.length < 300) warnings.push(msg); };

  // --- ZIP-Zugriff ---
  const entries = new Map();
  const lowerEntries = new Map();
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const name = e.entryName.replace(/\\/g, '/');
    entries.set(name, e);
    lowerEntries.set(name.toLowerCase(), name);
  }
  const findEntry = file => {
    const name = entries.has(file) ? file : lowerEntries.get(file.toLowerCase());
    return name ? { name, entry: entries.get(name) } : null;
  };
  const readText = file => {
    const hit = findEntry(file);
    return hit ? hit.entry.getData().toString('utf8') : null;
  };

  // --- container.xml → OPF ---
  const containerXml = readText('META-INF/container.xml');
  if (containerXml == null) throw new Error('Kein EPUB: META-INF/container.xml fehlt.');
  const rootfile = findAll(parseXml(containerXml), e => lname(e) === 'rootfile')[0];
  const opfPath = rootfile && attr(rootfile, 'full-path');
  if (!opfPath || readText(opfPath) == null) throw new Error('Kein EPUB: Paketdatei (OPF) nicht gefunden.');
  const opf = parseXml(readText(opfPath));
  const opfDir = posix.dirname(opfPath);
  const fromOpf = href => posix.normalize(posix.join(opfDir, decode(href.split('#')[0])));

  const meta = {
    title: cleanTitle(textContent(findAll(opf, e => lname(e) === 'title' && /^dc:/i.test(e.name))[0] || { children: [] })),
    author: cleanTitle(textContent(findAll(opf, e => lname(e) === 'creator')[0] || { children: [] })),
    language: cleanTitle(textContent(findAll(opf, e => lname(e) === 'language')[0] || { children: [] })),
  };

  const manifest = new Map();
  for (const item of findAll(opf, e => lname(e) === 'item')) {
    manifest.set(attr(item, 'id'), {
      file: fromOpf(attr(item, 'href') || ''),
      type: attr(item, 'media-type') || '',
      props: (attr(item, 'properties') || '').split(/\s+/),
    });
  }
  const spineFiles = [];
  for (const ref of findAll(opf, e => lname(e) === 'itemref')) {
    const item = manifest.get(attr(ref, 'idref'));
    if (!item) continue;
    if (!/html/i.test(item.type) && !/\.(x?html?)$/i.test(item.file)) continue;
    if (!findEntry(item.file)) { warn(`Kapitel fehlt im Archiv: ${item.file}`); continue; }
    spineFiles.push(findEntry(item.file).name);
  }
  if (!spineFiles.length) throw new Error('Das EPUB enthält keine lesbaren Kapitel.');

  // --- Dokumente parsen, Id-Indizes ---
  const docs = new Map();
  const ids = new Map();
  for (const file of spineFiles) {
    const dom = parseXml(readText(file));
    docs.set(file, dom);
    const idx = new Map();
    for (const el of findAll(dom, () => true)) {
      const id = attr(el, 'id');
      if (id && !idx.has(id)) idx.set(id, el);
      if (lname(el) === 'a' && attr(el, 'name') && !idx.has(attr(el, 'name'))) idx.set(attr(el, 'name'), el);
    }
    ids.set(file, idx);
  }

  const resolveHref = (fromFile, href) => {
    if (!href) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { external: true, url: href };
    if (href.startsWith('#')) return { file: fromFile, frag: decode(href.slice(1)) };
    const [p, ...rest] = href.split('#');
    const file = posix.normalize(posix.join(posix.dirname(fromFile), decode(p.split('?')[0])));
    const hit = findEntry(file);
    return { file: hit ? hit.name : file, frag: decode(rest.join('#')) };
  };

  // --- Inhaltsverzeichnis (nav oder ncx) ---
  const tocEntries = [];
  let navFile = null;
  const navItem = [...manifest.values()].find(i => i.props.includes('nav'));
  if (navItem && findEntry(navItem.file)) navFile = findEntry(navItem.file).name;
  const ncxItem = [...manifest.values()].find(i => /dtbncx/i.test(i.type)) || null;

  const addTocEntry = (fromFile, title, href, level) => {
    const t = cleanTitle(title);
    const r = resolveHref(fromFile, href);
    if (!t || !r || r.external) return;
    if (/^\[.*\]$/.test(t)) return; // Platzhalter wie „[Cover]“
    tocEntries.push({ title: t, file: r.file, frag: r.frag, level });
  };

  if (navFile) {
    const navDom = docs.get(navFile) || parseXml(readText(navFile));
    const nav = findAll(navDom, e => lname(e) === 'nav' && types(e).includes('toc'))[0]
      || findAll(navDom, e => lname(e) === 'nav')[0];
    const walk = (list, level) => {
      for (const li of (list.children || []).filter(c => isTag(c) && lname(c) === 'li')) {
        const link = (li.children || []).find(c => isTag(c) && lname(c) === 'a');
        const label = link || (li.children || []).find(c => isTag(c) && lname(c) === 'span');
        if (label) addTocEntry(navFile, textContent(label), link ? attr(link, 'href') : '', level);
        for (const sub of (li.children || []).filter(c => isTag(c) && /^(ol|ul)$/.test(lname(c)))) walk(sub, level + 1);
      }
    };
    if (nav) for (const list of (nav.children || []).filter(c => isTag(c) && /^(ol|ul)$/.test(lname(c)))) walk(list, 0);
  }
  if (!tocEntries.length && ncxItem && findEntry(ncxItem.file)) {
    const ncxFile = findEntry(ncxItem.file).name;
    const ncx = parseXml(readText(ncxFile));
    const walk = (parent, level) => {
      for (const p of (parent.children || []).filter(c => isTag(c) && lname(c) === 'navpoint')) {
        const label = (p.children || []).find(c => isTag(c) && lname(c) === 'navlabel');
        const content = (p.children || []).find(c => isTag(c) && lname(c) === 'content');
        if (label && content) addTocEntry(ncxFile, textContent(label), attr(content, 'src'), level);
        walk(p, level + 1);
      }
    };
    const map = findAll(ncx, e => lname(e) === 'navmap')[0];
    if (map) walk(map, 0);
  }

  // Dokumente, die nur das (veröffentlichte) Inhaltsverzeichnis enthalten, ersetzt das erzeugte.
  const guideToc = new Set(findAll(opf, e => lname(e) === 'reference' && /toc/i.test(attr(e, 'type') || ''))
    .map(e => fromOpf(attr(e, 'href') || '')).map(f => (findEntry(f) || { name: f }).name));
  const tocDocs = new Set();
  if (tocEntries.length) {
    for (const file of spineFiles) {
      const dom = docs.get(file);
      if (file === navFile || guideToc.has(file)
        || findAll(dom, e => (lname(e) === 'nav' && types(e).includes('toc')) || role(e) === 'doc-toc'
          || (types(e).includes('toc') && lname(e) !== 'a')).length) {
        tocDocs.add(file);
        continue;
      }
      const links = findAll(dom, e => lname(e) === 'a' && attr(e, 'href'));
      const internal = links.map(a => resolveHref(file, attr(a, 'href'))).filter(r => r && !r.external && r.file !== file && docs.has(r.file));
      const linkLen = links.reduce((n, a) => n + cleanTitle(textContent(a)).length, 0);
      const bodyLen = cleanTitle(textContent(dom)).length;
      if (internal.length >= 8 && internal.length >= links.length * 0.6 && bodyLen && linkLen / bodyLen >= 0.7) tocDocs.add(file);
    }
  }

  // --- Linkziele und Fußnoten (Phase 1) ---
  const S = {
    targets: new Set(),     // Schlüssel „Datei#Id“, auf die verwiesen wird
    emitted: new Set(),     // davon tatsächlich als Anker ausgegeben
    names: new Map(),       // Schlüssel → Ankername
    noterefs: new Map(),    // <a>-Element → Note
    notes: new Map(),       // Definitionselement → Note
    noteList: [],           // Notes in Reihenfolge des ersten Auftretens
    notesTitle: '',
    notesFiles: new Set(),  // Kapitel, die nur aus Anmerkungen bestanden und im Text entfallen
    images: new Map(),      // Zip-Pfad → Dateiname
    imageData: [],
    stats: { chapters: 0, links: 0, unresolved: 0, tocEntries: 0, notes: 0, notesUnreferenced: 0, images: 0 },
  };
  let nameCounter = 0;
  const nameFor = key => {
    if (!S.names.has(key)) S.names.set(key, `a-${++nameCounter}`);
    return S.names.get(key);
  };
  const targetKey = (file, frag) => `${file}#${frag}`;

  const blockOf = el => {
    for (let n = el; n; n = n.parent) {
      if (isTag(n) && UNIT.has(lname(n))) return n;
      if (isTag(n) && /^(body|html)$/.test(lname(n))) return null;
    }
    return null;
  };
  const contains = (root, el) => { for (let n = el; n; n = n.parent) if (n === root) return true; return false; };
  const inSup = el => { for (let n = el.parent, i = 0; n && i < 3; n = n.parent, i++) if (isTag(n) && /^(sup|small)$/.test(lname(n))) return true; return false; };

  function noteUnitFor(a, file, r) {
    const target = ids.get(r.file)?.get(r.frag);
    if (!target || !r.frag) return null;
    const semantic = types(a).includes('noteref') || role(a) === 'doc-noteref';
    const unit = UNIT.has(lname(target)) ? target : blockOf(target);
    if (!unit || contains(unit, a)) return null;
    if (semantic) return unit;
    const label = cleanTitle(textContent(a));
    if (!/^[[(]?(\d{1,4}|[*†‡§¹²³])[\])]?$/.test(label)) return null;
    if (!inSup(a) && !/note|fn|ref/i.test(attr(a, 'class') || '')) return null;
    // Rücksprung in der Note auf diese Datei?
    const back = findAll(unit, e => lname(e) === 'a' && attr(e, 'href'))
      .some(x => { const rr = resolveHref(r.file, attr(x, 'href')); return rr && !rr.external && rr.file === file; });
    return back ? unit : null;
  }

  const internalLinks = [];
  for (const file of spineFiles) {
    if (tocDocs.has(file)) continue;
    for (const a of findAll(docs.get(file), e => lname(e) === 'a' && attr(e, 'href'))) {
      const r = resolveHref(file, attr(a, 'href'));
      if (!r || r.external) continue;
      internalLinks.push({ a, r });
      const unit = noteUnitFor(a, file, r);
      if (!unit) continue;
      let note = S.notes.get(unit);
      if (!note) {
        note = { unit, file: r.file, refFiles: new Set(), number: 0, label: '', refs: 0 };
        S.notes.set(unit, note);
      }
      note.refFiles.add(file);
      S.noterefs.set(a, note);
    }
  }
  // Ziele nur für gewöhnliche Verweise; Anmerkungsverweise und Rücksprünge aus Anmerkungen brauchen keine eigenen Anker.
  const inNote = el => { for (let n = el; n; n = n.parent) if (S.notes.has(n)) return true; return false; };
  for (const { a, r } of internalLinks) if (!S.noterefs.has(a) && !inNote(a)) S.targets.add(targetKey(r.file, r.frag));
  const keptToc = tocEntries.filter(e => tocDocs.size === 0 || !tocDocs.has(e.file)).filter(e =>
    docs.has(e.file) && (!e.frag || ids.get(e.file).has(e.frag)));
  for (const e of keptToc) S.targets.add(targetKey(e.file, e.frag));
  const tocLevel = new Map(); // Ziel → Ebene im Inhaltsverzeichnis (0 = oberste)
  if (keptToc.length) {
    const minLevel = Math.min(...keptToc.map(e => e.level));
    for (const e of keptToc) if (!tocLevel.has(targetKey(e.file, e.frag))) tocLevel.set(targetKey(e.file, e.frag), e.level - minLevel);
  }

  // --- CSS: Klassen mit Fett/Kursiv ---
  const cssClasses = new Map();
  for (const item of manifest.values()) {
    if (!/css/i.test(item.type) || !findEntry(item.file)) continue;
    const css = readText(item.file).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const bold = /font-weight\s*:\s*(bold|bolder|[6-9]00)\b/i.test(body);
      const italic = /font-style\s*:\s*(italic|oblique)\b/i.test(body);
      if (!bold && !italic) continue;
      for (const sel of selectors.split(',')) {
        const m = sel.trim().match(/^(?:[a-z][a-z0-9]*)?\.([\w-]+)$/i);
        if (!m) continue;
        const prev = cssClasses.get(m[1]) || {};
        cssClasses.set(m[1], { bold: prev.bold || bold, italic: prev.italic || italic });
      }
    }
  }
  const classMarks = el => {
    const out = { bold: false, italic: false };
    if (/^(b|strong|i|em|cite|dfn|var)$/.test(lname(el))) return out;
    for (const c of (attr(el, 'class') || '').split(/\s+/)) {
      const m = cssClasses.get(c);
      if (m) { out.bold ||= m.bold; out.italic ||= m.italic; }
    }
    return out;
  };

  // --- Konvertierung (Phase 2) ---
  let cur = null; // aktueller Kontext {file, note, pending, hadNoteDefs}

  const anchorHtml = key => { S.emitted.add(key); return `<a id="${nameFor(key)}"></a>`; };
  function anchorsFor(el) {
    let html = '';
    const seen = new Set();
    for (const id of [attr(el, 'id'), lname(el) === 'a' ? attr(el, 'name') : null]) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const key = targetKey(cur.file, id);
      if (!S.targets.has(key)) continue;
      if (lname(el) === 'a' && tocLevel.has(key) && !cleanTitle(textContent(el))) {
        // Leerer Anker am Ende eines Absatzes, auf den das Inhaltsverzeichnis zeigt (Calibre): der Anker
        // wandert an den Anfang des nächsten Absatzes, dort beginnt das Kapitel.
        if (S.deferred) html += anchorHtml(S.deferred.key);
        S.deferred = { key, level: tocLevel.get(key) };
      } else html += anchorHtml(key);
    }
    return html;
  }

  function imageName(zipPath) {
    if (S.images.has(zipPath)) return S.images.get(zipPath);
    const base = posix.basename(zipPath).replace(/[^\p{L}\p{N}._-]+/gu, '_') || 'bild';
    const used = new Set(S.images.values());
    let name = base;
    for (let i = 2; used.has(name); i++) name = base.replace(/(\.[^.]*)?$/, `-${i}$1`);
    S.images.set(zipPath, name);
    S.imageData.push({ name, data: findEntry(zipPath).entry.getData() });
    S.stats.images++;
    return name;
  }

  function imageMd(src, alt) {
    if (!src) return '';
    if (/^data:/i.test(src)) { warn('Eingebettetes Bild (data:) übersprungen.'); return ''; }
    if (/^https?:/i.test(src)) return `![${alt}](${mdUrl(src)})`;
    const r = resolveHref(cur.file, src);
    if (!r || !findEntry(r.file)) { warn(`Bild fehlt im Archiv: ${src} (in ${cur.file})`); return ''; }
    return `![${alt.replace(/[\][\n]+/g, ' ')}](images/${mdUrl(imageName(findEntry(r.file).name))})`;
  }

  const isHidden = el => attr(el, 'hidden') !== undefined || /^(none)$/.test((attr(el, 'style') || '').match(/display\s*:\s*(\w+)/)?.[1] || '');
  const isBacklink = el => {
    if (!cur.note || lname(el) !== 'a') return false;
    if (types(el).includes('referrer') || role(el) === 'doc-backlink') return true;
    const r = resolveHref(cur.file, attr(el, 'href'));
    return !!r && !r.external && cur.note.refFiles.has(r.file);
  };

  function hasBlockDescendant(el) {
    return findAll(el, e => BLOCK.has(lname(e))).length > 0;
  }

  function renderInlineChildren(node) {
    let out = '';
    for (const child of node.children || []) {
      if (child.type === 'text') out += escapeText(collapseWs(child.data));
      else if (child.type === 'cdata') out += renderInlineChildren(child);
      else if (isTag(child)) out += renderInline(child);
    }
    return out;
  }

  function svgImage(el) {
    const img = findAll(el, e => lname(e) === 'image')[0];
    const href = img && (attr(img, 'xlink:href') || attr(img, 'href'));
    return href ? imageMd(href, '') : '';
  }

  function renderInline(el) {
    const tag = lname(el);
    const anchors = anchorsFor(el);
    if (SKIP.has(tag) || isHidden(el)) return anchors;
    if (BLOCK.has(tag)) return anchors + renderInlineChildren(el) + ' ';
    switch (tag) {
      case 'br': return '\n';
      case 'img': {
        const alt = cleanTitle(attr(el, 'alt') || '');
        return anchors + imageMd(attr(el, 'src'), alt);
      }
      case 'svg': return anchors + svgImage(el);
      case 'em': case 'i': case 'cite': case 'dfn': case 'var':
        return anchors + wrapMark('*', renderInlineChildren(el));
      case 'strong': case 'b':
        return anchors + wrapMark('**', renderInlineChildren(el));
      case 's': case 'del': case 'strike':
        return anchors + wrapMark('~~', renderInlineChildren(el));
      case 'code': case 'kbd': case 'samp': case 'tt': {
        const raw = collapseWs(textContent(el));
        if (!trimWs(raw)) return anchors + raw;
        const fence = '`'.repeat((raw.match(/`+/g) || ['']).reduce((m, s) => Math.max(m, s.length), 0) + 1);
        return `${anchors}${fence}${raw.startsWith('`') || raw.endsWith('`') ? ` ${raw} ` : raw}${fence}`;
      }
      case 'sup': case 'sub': {
        const inner = renderInlineChildren(el);
        if (findAll(el, e => S.noterefs.has(e)).length) return anchors + inner;
        return trimWs(inner) ? `${anchors}<${tag}>${inner}</${tag}>` : anchors + inner;
      }
      case 'a': return anchors + renderLink(el);
      default: return anchors + applyClassMarks(el, renderInlineChildren(el));
    }
  }

  // Fett/Kursiv aus CSS-Klassen (z. B. Calibre: <span class="bold">).
  function applyClassMarks(el, inner) {
    const m = classMarks(el);
    const wrapped = (open, close) => inner.trim().startsWith(open) && inner.trim().endsWith(close);
    if (m.bold && !wrapped(B_OPEN, B_CLOSE)) inner = wrapMark('**', inner);
    if (m.italic && !wrapped(I_OPEN, I_CLOSE)) inner = wrapMark('*', inner);
    return inner;
  }

  function renderLink(el) {
    const note = S.noterefs.get(el);
    if (note) return renderNoteref(el, note);
    const href = attr(el, 'href');
    const inner = renderInlineChildren(el);
    if (!href || isBacklink(el)) return isBacklink(el) ? '' : inner;
    if (!trimWs(inner)) return inner;
    const lead = inner.match(/^[ \t\r\n\f]*/)[0];
    const trail = inner.match(/[ \t\r\n\f]*$/)[0];
    const core = inner.slice(lead.length, inner.length - trail.length);
    const r = resolveHref(cur.file, href);
    if (!r) return inner;
    if (r.external) {
      if (/^(javascript|data):/i.test(r.url)) return inner;
      return `${lead}[${core}](${mdUrl(r.url)})${trail}`;
    }
    S.stats.links++;
    return lead + linkMarker(targetKey(r.file, r.frag), core) + trail;
  }

  function renderNoteref(el, note) {
    if (!note.number) {
      note.number = S.noteList.length + 1;
      note.label = cleanTitle(textContent(el)).replace(/[\][()]/g, '') || String(note.number);
      S.noteList.push(note);
    }
    note.refs++;
    const id = note.refs === 1 ? `ref-${note.number}` : `ref-${note.number}-${note.refs}`;
    return `<a id="${id}"></a><sup>[${escapeText(note.label)}](#anm-${note.number})</sup>`;
  }

  // --- Blöcke ---

  function convertBlockChildren(node) {
    const blocks = [];
    let inline = '';
    const flush = () => {
      const text = finishInline(inline);
      inline = '';
      if (text) { blocks.push(cur.pending + text); cur.pending = ''; }
    };
    for (const child of node.children || []) {
      if (child.type === 'text') inline += escapeText(collapseWs(child.data));
      else if (child.type === 'cdata') blocks.push(...convertBlockChildren(child));
      else if (isTag(child)) {
        const tag = lname(child);
        const block = BLOCK.has(tag) || ((tag === 'a' || tag === 'span' || tag === 'font') && hasBlockDescendant(child));
        if (block) {
          flush();
          blocks.push(...renderBlock(child));
        } else inline += renderInline(child);
      }
    }
    flush();
    return blocks;
  }

  function renderBlock(el) {
    const tag = lname(el);
    if (S.notes.has(el)) { cur.hadNoteDefs = true; return []; }
    const types_ = types(el);
    if (SKIP.has(tag) || isHidden(el)) return [];
    const anchors = anchorsFor(el);
    if (types_.includes('pagebreak') || role(el) === 'doc-pagebreak') { cur.pending += anchors; return []; }
    if (/^h[1-6]$/.test(tag)) {
      const deferredHtml = S.deferred ? anchorHtml(S.deferred.key) : '';
      S.deferred = undefined;
      cur.pending += deferredHtml;
      const text = finishInline(renderInlineChildren(el).split(B_OPEN).join('').split(B_CLOSE).join('')).replace(/ {2}\n/g, ' ');
      if (!text) { cur.pending += anchors; return []; }
      const out = `${'#'.repeat(Number(tag[1]))} ${cur.pending}${anchors}${text}`;
      cur.pending = '';
      return [out];
    }
    cur.pending += anchors;
    switch (tag) {
      case 'hr': return ['---'];
      case 'pre': {
        const raw = textContent(el).replace(/\r\n?/g, '\n').replace(/^\n|\n$/g, '');
        const fence = '`'.repeat(Math.max(3, (raw.match(/`+/g) || ['']).reduce((m, s) => Math.max(m, s.length + 1), 0)));
        return [`${fence}\n${raw}\n${fence}`];
      }
      case 'blockquote': {
        const inner = convertBlockChildren(el).join('\n\n');
        return inner ? [inner.split('\n').map(l => (l ? `> ${l}` : '>')).join('\n')] : [];
      }
      case 'p': {
        if (hasBlockDescendant(el)) return convertBlockChildren(el);
        const deferred = S.deferred; // Ziel am Ende eines früheren Absatzes → dieser Absatz ist die Überschrift
        S.deferred = undefined;
        const raw = applyClassMarks(el, renderInlineChildren(el));
        const text = finishInline(raw);
        if (!text) {
          if (deferred) { if (S.deferred) cur.pending += anchorHtml(deferred.key); else S.deferred = deferred; }
          return [];
        }
        if (deferred) cur.pending = anchorHtml(deferred.key) + cur.pending;
        // Reiner Fettabsatz, auf den das Inhaltsverzeichnis zeigt → Überschrift (Calibre-Bücher ohne <h1>).
        const idKey = targetKey(cur.file, attr(el, 'id') || '');
        const level = tocLevel.has(idKey) && attr(el, 'id') ? tocLevel.get(idKey)
          : (deferred?.level ?? (cur.firstBlock ? tocLevel.get(targetKey(cur.file, '')) : undefined));
        cur.firstBlock = false;
        const trimmed = raw.trim();
        if (level !== undefined && trimmed.startsWith(B_OPEN) && trimmed.endsWith(B_CLOSE) && trimmed.split(B_OPEN).length === 2) {
          const plain = finishInline(trimmed.split(B_OPEN).join('').split(B_CLOSE).join('')).replace(/ {2}\n/g, ' ');
          const out = `${'#'.repeat(Math.min(6, level + 1))} ${cur.pending}${plain}`;
          cur.pending = '';
          return [out];
        }
        const out = cur.pending + text;
        cur.pending = '';
        return [out];
      }
      case 'ul': case 'ol': return renderList(el);
      case 'dl': {
        const out = [];
        for (const c of (el.children || []).filter(isTag)) {
          const inner = renderInlineChildren(c);
          const t = finishInline(lname(c) === 'dt' ? wrapMark('**', inner.split(B_OPEN).join('').split(B_CLOSE).join('')) : inner);
          if (t) out.push(t);
        }
        return out;
      }
      case 'table': return renderTable(el);
      default: return convertBlockChildren(el);
    }
  }

  function renderList(el) {
    const ordered = lname(el) === 'ol';
    let n = Number.parseInt(attr(el, 'start'), 10);
    if (!Number.isFinite(n)) n = 1;
    const items = [];
    let loose = false;
    for (const li of (el.children || []).filter(c => isTag(c) && lname(c) === 'li')) {
      if (S.notes.has(li)) { cur.hadNoteDefs = true; continue; }
      const parts = convertBlockChildren(li);
      if (!parts.length) continue;
      const marker = ordered ? `${n++}. ` : '- ';
      const pad = ' '.repeat(marker.length);
      let text = '';
      parts.forEach((p, i) => {
        const nested = /^(\s*)([-*+]|\d+\.) /.test(p) && i > 0;
        text += i === 0 ? p : (nested ? '\n' : '\n\n') + p;
        if (i > 0 && !nested) loose = true;
      });
      items.push(marker + indentLines(text, pad));
    }
    if (!items.length) return [];
    return [items.join(loose ? '\n\n' : '\n')];
  }

  function renderTable(el) {
    const rows = findAll(el, e => lname(e) === 'tr' && e.parent && ['table', 'thead', 'tbody', 'tfoot'].includes(lname(e.parent)));
    const cellsOf = tr => (tr.children || []).filter(c => isTag(c) && /^(td|th)$/.test(lname(c)));
    if (!rows.length) return [];
    if (rows.length === 1 && cellsOf(rows[0]).length === 1) return convertBlockChildren(cellsOf(rows[0])[0]);
    const matrix = rows.map(tr => cellsOf(tr).map(c => convertBlockChildren(c).join(' ').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|')));
    const width = Math.max(...matrix.map(r => r.length));
    if (!width) return [];
    const pad = r => [...r, ...Array(width - r.length).fill('')];
    const line = r => `| ${pad(r).join(' | ')} |`;
    return [[line(matrix[0]), line(Array(width).fill('---')), ...matrix.slice(1).map(line)].join('\n')];
  }

  // --- Fußnoten rendern ---

  function renderNoteContent(note) {
    const saved = cur;
    cur = { file: note.file, note, pending: '', hadNoteDefs: false };
    const blocks = convertBlockChildren(note.unit);
    cur = saved;
    return blocks.join(' ').replace(/\s*\n\s*/g, ' ').replace(/ {2,}/g, ' ').trim();
  }

  // --- Spine durchlaufen ---
  const parts = [];
  const tocTitleFromDoc = () => {
    for (const file of tocDocs) {
      const h = findAll(docs.get(file), e => /^h[1-6]$/.test(lname(e)))[0];
      if (h && cleanTitle(textContent(h))) return cleanTitle(textContent(h));
    }
    return 'Inhaltsverzeichnis';
  };
  const firstTocTarget = new Set(keptToc.map(e => e.file));
  let tocBlock = '';
  if (keptToc.length) {
    const minLevel = Math.min(...keptToc.map(e => e.level));
    let prev = -1;
    const lines = keptToc.map(e => {
      const level = Math.min(Math.max(0, e.level - minLevel), prev + 1);
      prev = level;
      return `${'  '.repeat(level)}- ${linkMarker(targetKey(e.file, e.frag), escapeText(e.title))}`;
    });
    tocBlock = `# <a id="${TOC_ANCHOR}"></a>${escapeText(tocTitleFromDoc())}\n\n${lines.join('\n')}`;
    S.stats.tocEntries = keptToc.length;
  }
  let tocPlaced = false;

  for (const file of spineFiles) {
    if (tocDocs.has(file)) {
      if (!tocPlaced && tocBlock) { parts.push(tocBlock); tocPlaced = true; }
      continue;
    }
    if (!tocPlaced && tocBlock && firstTocTarget.has(file)) { parts.push(tocBlock); tocPlaced = true; }
    cur = { file, note: null, pending: '', hadNoteDefs: false, firstBlock: true };
    const startKey = targetKey(file, '');
    if (S.targets.has(startKey)) cur.pending += anchorHtml(startKey);
    const dom = docs.get(file);
    const body = findAll(dom, e => lname(e) === 'body')[0] || dom;
    let blocks = convertBlockChildren(body);
    if (cur.pending) { blocks.push(cur.pending); cur.pending = ''; }
    // Dokument bestand nur aus Noten (und deren Überschrift) → die Überschrift wird zum Titel der Anmerkungen.
    if (cur.hadNoteDefs && blocks.length && blocks.every(b => /^#{1,6} /.test(b.replace(/<a id="[^"]*"><\/a>/g, '')))) {
      S.notesTitle ||= cleanTitle(blocks[0].replace(/<a id="[^"]*"><\/a>/g, '').replace(/^#+\s*/, '').replace(/\\([\\`*_[\]<~])/g, '$1'));
      blocks = [];
    }
    if (cur.hadNoteDefs && !blocks.length) {
      S.notesFiles.add(file);
      for (const key of [...S.emitted]) if (key.startsWith(`${file}#`)) S.emitted.delete(key);
    }
    if (blocks.length) { parts.push(blocks.join('\n\n')); S.stats.chapters++; }
  }
  if (S.deferred && parts.length) { parts[parts.length - 1] += anchorHtml(S.deferred.key); S.deferred = undefined; }
  if (!tocPlaced && tocBlock) parts.unshift(tocBlock);

  // Anmerkungen am Ende
  if (S.noteList.length) {
    const entries_ = S.noteList.map(note => {
      const label = /^\d+$/.test(note.label) ? `${note.label}.` : escapeText(note.label);
      return `<a id="anm-${note.number}"></a>**${label}** ${renderNoteContent(note)} [↩](#ref-${note.number})`;
    });
    parts.push(`# <a id="${NOTES_ANCHOR}"></a>${escapeText(S.notesTitle || 'Anmerkungen')}\n\n${entries_.join('\n\n')}`);
    S.stats.notes = S.noteList.length;
  }
  S.stats.notesUnreferenced = [...S.notes.values()].filter(n => !n.number).length;

  // --- Verweise auflösen ---
  const tocFiles = tocDocs;
  let markdown = parts.join('\n\n');
  markdown = markdown.replace(new RegExp(`${L_OPEN}([^${L_MID}]*)${L_MID}([\\s\\S]*?)${L_CLOSE}`, 'g'), (m, key, text) => {
    if (S.emitted.has(key)) return `[${text}](#${nameFor(key)})`;
    const keyFile = key.slice(0, key.indexOf('#'));
    if (tocFiles.has(keyFile)) return `[${text}](#${TOC_ANCHOR})`;
    if (S.notesFiles.has(keyFile) && S.noteList.length) return `[${text}](#${NOTES_ANCHOR})`;
    S.stats.unresolved++;
    if (S.stats.unresolved <= 20) warn(`Verweis ohne Ziel: ${key}`);
    return text;
  });
  markdown = markdown.replace(RE_SHY, '').replace(/\n{3,}/g, '\n\n').trim() + '\n';

  return { markdown, images: S.imageData, meta, stats: S.stats, warnings, check: checkMarkdown(markdown) };
}

// Prüft, ob alle Verweise (#…) im Markdown ein Ziel (id="…") haben.
export function checkMarkdown(markdown) {
  const ids = new Set([...markdown.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const links = [...markdown.matchAll(/\]\(#([^)\s]+)\)/g)].map(m => m[1]);
  const missing = [...new Set(links.filter(l => !ids.has(l)))];
  return { links: links.length, missing };
}
