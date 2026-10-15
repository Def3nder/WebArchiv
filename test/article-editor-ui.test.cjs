const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const EDITOR = fs.readFileSync(path.join(ROOT, 'public', 'article-editor.js'), 'utf8');
const PREVIEW = fs.readFileSync(path.join(ROOT, 'public', 'markdown-live-preview.js'), 'utf8');

test('Artikeleditor verwendet die lokale Markdown-Live-Vorschau', () => {
  assert.doesNotMatch(HTML, /<textarea id="article-editor-text"/);
  assert.match(HTML, /<div id="article-editor-text"/);
  assert.match(HTML, /vendor\/article-editor\.bundle\.js\?v=16/);
  assert.match(EDITOR, /createMarkdownInput/);
  assert.match(EDITOR, /markdownInput\.getValue\(\)/);
  assert.match(EDITOR, /markdownInput\.setValue\(result\.markdown\)/);
  assert.match(EDITOR, /insideEditor && event\.key !== 'Escape'/);
  assert.match(EDITOR, /\$editorText\.addEventListener\('keydown'/);
});

test('Live-Vorschau deckt Inline-, Block- und GFM-Elemente ab', () => {
  for (const token of [
    'StrongEmphasis', 'Emphasis', 'Strikethrough', 'ATXHeading', 'ListItem', 'TaskMarker',
    'Blockquote', 'InlineCode', 'FencedCode', 'Link', 'Image', 'Table', 'HorizontalRule',
  ]) assert.match(PREVIEW, new RegExp(token));
  assert.match(PREVIEW, /markdown\(\{ extensions: GFM \}\)/);
  assert.match(PREVIEW, /Decoration\.replace/);
  assert.match(PREVIEW, /EditorView\.atomicRanges/);
});

test('aktive Markdown-Zeichen und gerenderte Strukturen besitzen eigene Stile', () => {
  assert.match(CSS, /\.cm-md-markup\s*\{/);
  assert.match(CSS, /\.cm-md-heading-1/);
  assert.match(CSS, /\.cm-md-table-widget/);
  assert.match(CSS, /\.cm-md-image-widget/);
  assert.match(CSS, /\.cm-md-task-widget/);
  assert.match(HTML, /styles\.css\?v=125/);
  assert.match(CSS, /\.markdown-live-editor \.cm-md-markup/);
  assert.match(PREVIEW, /replaceSelection\(value\)/);
  assert.match(PREVIEW, /reflectReadOnly\(readOnly\)/);
});

test('Toolbar-Formatierungen werden sofort geparst und Markierungen bleiben mit dem Cursor erreichbar', () => {
  assert.match(PREVIEW, /import \{ forceParsing, syntaxTree \}/);
  assert.match(PREVIEW, /forceParsing\(view, Math\.min\(view\.state\.doc\.length, change\.from \+ change\.insert\.length \+ 1\), 50\)/);
  assert.match(PREVIEW, /function inlineContentRange\(node\)/);
  assert.match(PREVIEW, /Decoration\.mark\(\{ class: inlineClass \}\)\.range\(content\.from, content\.to\)/);
  assert.match(PREVIEW, /else replace\(node\.from, node\.to, null, false, false\)/);
  const headingRule = CSS.match(/\.cm-md-heading-1,[\s\S]*?\.cm-md-heading-6\s*\{([^}]+)\}/)?.[1] || '';
  assert.doesNotMatch(headingRule, /padding-top/);
});

test('Strg beziehungsweise Cmd plus I formatiert kursiv vor CodeMirrors Syntaxauswahl', () => {
  assert.match(PREVIEW, /const formattingShortcutKeymap = Prec\.high\(keymap\.of\(\[[\s\S]*?key: 'Mod-i'[\s\S]*?runFormattingShortcut\('i'\)/);
  assert.match(PREVIEW, /formattingShortcutKeymap,[\s\S]*?minimalSetup,/);
  assert.match(PREVIEW, /runShortcut\(key\)[\s\S]*?key === 'i'[\s\S]*?toggleInlineMarkdown\(source, from, to, '\*'\)/);
  assert.doesNotMatch(PREVIEW, /keydown\(event\) \{ return toolbar\?\.handleShortcut/);
});

test('Pos1 bleibt auch bei umbrochenen und gerenderten Zeilen im aktuellen Markdown-Absatz', () => {
  assert.match(PREVIEW, /const lineBoundaryKeymap = Prec\.high\(keymap\.of\(\[/);
  assert.match(PREVIEW, /key: 'Home'[\s\S]*?run: view => moveHome\(view, false\)[\s\S]*?shift: view => moveHome\(view, true\)/);
  assert.match(PREVIEW, /function visualHomeTarget\(view, range\)[\s\S]*?moved >= line\.from && moved <= line\.to && moved <= range\.head/);
  assert.match(PREVIEW, /lineElement\.getBoundingClientRect\(\)\.left[\s\S]*?view\.posAtCoords\(\{ x, y \}, false\)/);
  assert.match(PREVIEW, /function positionOnLine\(line, position, head = line\.to\)[\s\S]*?position >= line\.from && position <= Math\.min\(line\.to, head\)[\s\S]*?line\.from/);
});

test('Ende bleibt bei einer aktiven Tabelle in derselben sichtbaren Markdown-Zeile', () => {
  assert.match(PREVIEW, /key: 'End'[\s\S]*?run: view => moveEnd\(view, false\)[\s\S]*?shift: view => moveEnd\(view, true\)/);
  assert.match(PREVIEW, /function visualEndTarget\(view, range\)[\s\S]*?moved >= line\.from && moved <= line\.to && moved >= range\.head/);
  assert.match(PREVIEW, /getBoundingClientRect\(\)\.right[\s\S]*?paddingRight[\s\S]*?view\.posAtCoords\(\{ x, y \}, false\)/);
  assert.match(PREVIEW, /function positionOnLineEnd\(line, position, head = line\.from\)[\s\S]*?position >= Math\.max\(line\.from, head\) && position <= line\.to[\s\S]*?line\.to/);
});

test('Pfeil hoch überspringt nach mehrzeiligem Einfügen keine Markdown-Quellzeilen', () => {
  assert.match(PREVIEW, /function previousSourceLineTarget\(state, range, moved\)[\s\S]*?movedLine\.number >= line\.number - 1[\s\S]*?state\.doc\.line\(line\.number - 1\)/);
  assert.match(PREVIEW, /previous\.from \+ Math\.min\(range\.head - line\.from, previous\.length\)/);
  assert.match(PREVIEW, /function moveUpWithoutSkippingSourceLines\(view, extend\)[\s\S]*?view\.moveVertically\(range, false\)[\s\S]*?previousSourceLineTarget/);
  assert.match(PREVIEW, /EditorSelection\.range\(range\.anchor, target, vertical\.goalColumn\)[\s\S]*?EditorSelection\.cursor\(target, vertical\.assoc, undefined, vertical\.goalColumn\)/);
  assert.match(PREVIEW, /const sourceLineNavigationKeymap = Prec\.high\(keymap\.of\(\[\{[\s\S]*?key: 'ArrowUp'[\s\S]*?moveUpWithoutSkippingSourceLines\(view, false\)/);
  assert.match(PREVIEW, /minimalSetup,[\s\S]*?lineBoundaryKeymap,[\s\S]*?sourceLineNavigationKeymap/);
});

test('Toolbar-Auswahl folgt Cursor, Überschrift und Inline-Formatierung', () => {
  assert.match(PREVIEW, /update\.docChanged \|\| update\.selectionSet/);
  assert.doesNotMatch(PREVIEW, /update\.docChanged \|\| update\.selection\)/);
  assert.match(PREVIEW, /matchesAt\(head, -1\) \|\| matchesAt\(head, 1\)/);
  assert.match(PREVIEW, /tree\.iterate\(\{/);
  assert.match(PREVIEW, /button\.setAttribute\('aria-current', String\(Number\(button\.dataset\.mdHeading\) === heading\)\)/);
  assert.match(PREVIEW, /button\.setAttribute\('aria-pressed', String\(pressed\)\)/);
  assert.match(CSS, /\.md-toolbar-button\[aria-pressed="true"\]/);
  assert.match(CSS, /\.md-toolbar-menu button\[aria-current="true"\]/);
  assert.match(PREVIEW, /if \(details\.open\) \{[\s\S]*?update\(\);[\s\S]*?closeMenus\(details\)/);
});

test('Markdown-Überlaufmenü grenzt an die übrigen Schaltflächen und bleibt vollständig sichtbar', () => {
  assert.match(CSS, /\.md-toolbar-more \{ display: none; margin-left: 0; \}/);
  assert.match(PREVIEW, /function keepMoreMenuVisible|const keepMoreMenuVisible/);
  assert.match(PREVIEW, /Math\.max\(8, toolbarRect\.left \+ 4\)[\s\S]*?Math\.min\(window\.innerWidth - 8, toolbarRect\.right - 4\)/);
  assert.match(CSS, /transform: translateX\(var\(--md-menu-shift, 0\)\)/);
});

test('Editorleiste bietet Formatbefehle, aber keine Bildfunktion im Artikeleditor', () => {
  for (const command of [
    'undo', 'redo', 'bold', 'italic', 'strike', 'quote', 'code', 'link', 'clear',
  ]) assert.match(PREVIEW, new RegExp(`toolbarButton\\('${command}'`));
  assert.match(PREVIEW, /data-md-table-label/);
  assert.match(PREVIEW, /\[1, 'Titel'\]/);
  assert.match(PREVIEW, /\[6, 'Unterabschnitt'\]/);
  assert.match(PREVIEW, /Nummerierte Liste/);
  assert.match(PREVIEW, /Checkboxen/);
  assert.match(PREVIEW, /md-list-icon md-list-icon-bullet[^>]*aria-hidden="true">•/);
  assert.match(PREVIEW, /md-list-icon md-list-icon-number[^>]*aria-hidden="true">1\./);
  assert.match(PREVIEW, /md-list-icon md-list-icon-task[^>]*aria-hidden="true">☑/);
  assert.match(CSS, /\.md-editor-toolbar\s*\{/);
  assert.match(CSS, /\.md-table-picker\s*\{/);
  assert.match(CSS, /\.md-toolbar-menu\.md-list-menu button:not\(\.md-toolbar-button\)/);
  assert.doesNotMatch(EDITOR, /onInsertImage/);
});

test('Tabellenzeilen werden mit maskierten Pipes korrekt zerlegt', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'markdown-live-preview.js'), 'utf8');
  assert.match(source, /char === '\\\\'/);
  assert.match(source, /char === '\|' && !ticks/);
});
