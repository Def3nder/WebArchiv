const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const commandsPromise = import(pathToFileURL(path.join(__dirname, '..', 'public', 'markdown-commands.mjs')).href);

test('Inline-Formatierung erfasst ohne Auswahl das Wort unter dem Cursor', async () => {
  const { applyMarkdownEdit, toggleInlineMarkdown } = await commandsPromise;
  const source = 'Das ist ein Über-WORT im Satz.';
  const position = source.indexOf('WORT') + 2;
  const added = toggleInlineMarkdown(source, position, position, '**');
  assert.equal(applyMarkdownEdit(source, added), 'Das ist ein **Über-WORT** im Satz.');

  const formatted = applyMarkdownEdit(source, added);
  const removed = toggleInlineMarkdown(formatted, added.selection.anchor, added.selection.head, '**');
  assert.equal(applyMarkdownEdit(formatted, removed), source);
});

test('Inline-Formatierung setzt auf freier Stelle ein leeres Markierungspaar', async () => {
  const { applyMarkdownEdit, toggleInlineMarkdown } = await commandsPromise;
  const source = 'ein  zwei';
  const change = toggleInlineMarkdown(source, 4, 4, '~~');
  assert.equal(applyMarkdownEdit(source, change), 'ein ~~~~ zwei');
  assert.equal(change.selection.anchor, 6);
});

test('Überschriften, Listen und Einzüge werden zeilenweise umgeschaltet', async () => {
  const { applyMarkdownEdit, indentMarkdown, setHeadingMarkdown, setListMarkdown, toggleCodeMarkdown } = await commandsPromise;
  assert.equal(applyMarkdownEdit('Titel', setHeadingMarkdown('Titel', 2, 2, 2)), '## Titel');
  assert.equal(applyMarkdownEdit('## Titel', setHeadingMarkdown('## Titel', 4, 4, 0)), 'Titel');
  const list = applyMarkdownEdit('Eins\nZwei', setListMarkdown('Eins\nZwei', 0, 9, 'task'));
  assert.equal(list, '- [ ] Eins\n- [ ] Zwei');
  assert.equal(applyMarkdownEdit(list, indentMarkdown(list, 0, list.length, 1)), '  - [ ] Eins\n  - [ ] Zwei');

  const code = toggleCodeMarkdown('eins\nzwei', 0, 10);
  assert.equal(applyMarkdownEdit('eins\nzwei', code), '```\neins\nzwei\n```');
  assert.equal(applyMarkdownEdit('eins\nzwei', code).slice(code.selection.anchor, code.selection.head), 'eins\nzwei');
});

test('Link und Tabelle erzeugen gültiges Markdown und behalten eine sinnvolle Auswahl', async () => {
  const { applyMarkdownEdit, insertTableMarkdown, markdownLinkTarget, setLinkMarkdown } = await commandsPromise;
  const source = 'Mehr Informationen';
  const target = markdownLinkTarget(source, 7, 7);
  const linked = setLinkMarkdown(source, target, '', 'https://example.org');
  assert.equal(applyMarkdownEdit(source, linked), 'Mehr [Informationen](https://example.org)');

  const table = insertTableMarkdown('', 0, 0, 4, 3);
  const rendered = applyMarkdownEdit('', table);
  assert.match(rendered, /^\| Spalte 1 \| Spalte 2 \| Spalte 3 \|/);
  assert.equal(rendered.split('\n').length, 5);
  assert.deepEqual(rendered.slice(table.selection.anchor, table.selection.head), 'Spalte 1');
});

test('Trennlinie lässt sich an der Cursorzeile einfügen und wieder entfernen', async () => {
  const { applyMarkdownEdit, insertRuleMarkdown } = await commandsPromise;
  const inserted = insertRuleMarkdown('Text', 4, 4);
  assert.equal(applyMarkdownEdit('Text', inserted), 'Text\n\n---');

  const source = 'Davor\n---\nDanach';
  const cursor = source.indexOf('---') + 1;
  const removed = insertRuleMarkdown(source, cursor, cursor);
  assert.equal(applyMarkdownEdit(source, removed), 'Davor\nDanach');
});
