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
  assert.match(HTML, /vendor\/article-editor\.bundle\.js\?v=3/);
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
  assert.match(HTML, /styles\.css\?v=114/);
  assert.match(CSS, /\.markdown-live-editor \.cm-md-markup/);
  assert.match(PREVIEW, /replaceSelection\(value\)/);
  assert.match(PREVIEW, /reflectReadOnly\(readOnly\)/);
});

test('Tabellenzeilen werden mit maskierten Pipes korrekt zerlegt', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'markdown-live-preview.js'), 'utf8');
  assert.match(source, /char === '\\\\'/);
  assert.match(source, /char === '\|' && !ticks/);
});
