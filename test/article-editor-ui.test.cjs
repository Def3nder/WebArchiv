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
  assert.match(HTML, /vendor\/article-editor\.bundle\.js\?v=8/);
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
  assert.match(HTML, /styles\.css\?v=118/);
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

test('Toolbar-Auswahl folgt Cursor, Überschrift und Inline-Formatierung', () => {
  assert.match(PREVIEW, /update\.docChanged \|\| update\.selectionSet/);
  assert.doesNotMatch(PREVIEW, /update\.docChanged \|\| update\.selection\)/);
  assert.match(PREVIEW, /matchesAt\(head, -1\) \|\| matchesAt\(head, 1\)/);
  assert.match(PREVIEW, /tree\.iterate\(\{/);
  assert.match(PREVIEW, /button\.setAttribute\('aria-current', String\(Number\(button\.dataset\.mdHeading\) === heading\)\)/);
  assert.match(PREVIEW, /button\.setAttribute\('aria-pressed', String\(pressed\)\)/);
  assert.match(CSS, /\.md-toolbar-button\[aria-pressed="true"\]/);
  assert.match(CSS, /\.md-toolbar-menu button\[aria-current="true"\]/);
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
