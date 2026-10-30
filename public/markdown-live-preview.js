import { Compartment, EditorSelection, EditorState, Prec, StateField } from '@codemirror/state';
import { forceParsing, syntaxTree } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { Decoration, EditorView, keymap, WidgetType } from '@codemirror/view';
import { undo, redo, undoDepth, redoDepth } from '@codemirror/commands';
import { minimalSetup } from 'codemirror';
import {
  clearMarkdownFormatting, indentMarkdown, insertRuleMarkdown, insertTableMarkdown,
  markdownLinkTarget, setHeadingMarkdown, setLinkMarkdown, setListMarkdown,
  toggleBlockquoteMarkdown, toggleCodeMarkdown, toggleInlineMarkdown,
} from './markdown-commands.mjs';

const INLINE_CLASS = {
  StrongEmphasis: 'cm-md-strong',
  Emphasis: 'cm-md-emphasis',
  Strikethrough: 'cm-md-strikethrough',
  Link: 'cm-md-link',
  Autolink: 'cm-md-link',
  InlineCode: 'cm-md-inline-code',
};

const MARKER_NODES = new Set([
  'CodeMark', 'EmphasisMark', 'EscapeMark', 'HeaderMark', 'LinkMark', 'QuoteMark',
  'StrikethroughMark',
]);

const REVEAL_NODES = new Set([
  'Autolink', 'Blockquote', 'CodeBlock', 'Emphasis', 'FencedCode', 'Image', 'InlineCode',
  'Link', 'ListItem', 'SetextHeading1', 'SetextHeading2', 'Strikethrough',
  'StrongEmphasis', 'Table',
]);

const HEADING_RE = /^(?:ATXHeading|SetextHeading)([1-6])$/;
const CODE_BLOCK_NODES = new Set(['CodeBlock', 'FencedCode']);

const INLINE_MARKER_NODE = {
  StrongEmphasis: 'EmphasisMark',
  Emphasis: 'EmphasisMark',
  Strikethrough: 'StrikethroughMark',
  InlineCode: 'CodeMark',
};

function selectionTouches(state, from, to) {
  return state.selection.ranges.some(range => range.empty
    ? range.head >= from && range.head <= to
    : range.from < to && range.to > from);
}

function revealContainer(node) {
  for (let current = node; current; current = current.parent) {
    if (REVEAL_NODES.has(current.name) || HEADING_RE.test(current.name)) return current;
  }
  return node;
}

function nodeActive(state, node) {
  const container = revealContainer(node);
  return selectionTouches(state, container.from, container.to);
}

function inlineContentRange(node) {
  if (node.name === 'Link') {
    const markers = node.getChildren('LinkMark');
    if (markers.length >= 2) return { from: markers[0].to, to: markers[1].from };
  }
  const markerName = INLINE_MARKER_NODE[node.name];
  if (markerName) {
    const markers = node.getChildren(markerName);
    if (markers.length >= 2) return { from: markers[0].to, to: markers[markers.length - 1].from };
  }
  return { from: node.from, to: node.to };
}

function lineRanges(state, from, to) {
  const ranges = [];
  let line = state.doc.lineAt(from);
  const last = state.doc.lineAt(Math.max(from, to - 1)).number;
  while (line.number <= last) {
    ranges.push(line.from);
    if (line.number === last) break;
    line = state.doc.line(line.number + 1);
  }
  return ranges;
}

function positionOnLine(line, position, head = line.to) {
  return Number.isInteger(position) && position >= line.from && position <= Math.min(line.to, head)
    ? position : line.from;
}

function positionOnLineEnd(line, position, head = line.from) {
  return Number.isInteger(position) && position >= Math.max(line.from, head) && position <= line.to
    ? position : line.to;
}

function visualHomeTarget(view, range) {
  const line = view.state.doc.lineAt(range.head);
  const moved = view.moveToLineBoundary(range, false).head;
  if (moved >= line.from && moved <= line.to && moved <= range.head) return moved;

  // Bei Replacement-Widgets kann CodeMirror die linke Bildschirmkante einer
  // umbrochenen Zeile gelegentlich der nächsten Dokumentzeile zuordnen. Mit
  // der tatsächlichen Textkante der aktuellen .cm-line lässt sich das Ziel
  // noch einmal bestimmen, ohne den aktuellen Markdown-Absatz zu verlassen.
  const coords = view.coordsAtPos(range.head, range.assoc || -1);
  const dom = view.domAtPos(range.head, range.assoc < 0 ? -1 : 1);
  const element = dom.node.nodeType === 1 ? dom.node : dom.node.parentElement;
  const lineElement = element?.closest?.('.cm-line');
  if (!coords || !lineElement) return line.from;
  const style = (view.dom.ownerDocument.defaultView || window).getComputedStyle(lineElement);
  const x = lineElement.getBoundingClientRect().left + (parseFloat(style.paddingLeft) || 0) + 1;
  const y = (coords.top + coords.bottom) / 2;
  return positionOnLine(line, view.posAtCoords({ x, y }, false), range.head);
}

function moveHome(view, extend) {
  const { selection } = view.state;
  const ranges = selection.ranges.map(range => {
    const target = visualHomeTarget(view, range);
    return extend
      ? EditorSelection.range(range.anchor, target)
      : EditorSelection.cursor(target);
  });
  view.dispatch({
    selection: EditorSelection.create(ranges, selection.mainIndex),
    scrollIntoView: true,
  });
  return true;
}

function visualEndTarget(view, range) {
  const line = view.state.doc.lineAt(range.head);
  const moved = view.moveToLineBoundary(range, true).head;
  if (moved >= line.from && moved <= line.to && moved >= range.head) return moved;

  // Das Gegenstück zu visualHomeTarget: Am rechten Rand einer dekorierten
  // Tabellenzeile darf die Geometrie nicht auf die folgende Markdown-Zeile
  // zeigen. Bestimme das Ziel erneut an der Textkante der aktuellen .cm-line.
  const coords = view.coordsAtPos(range.head, range.assoc || 1);
  const dom = view.domAtPos(range.head, range.assoc < 0 ? -1 : 1);
  const element = dom.node.nodeType === 1 ? dom.node : dom.node.parentElement;
  const lineElement = element?.closest?.('.cm-line');
  if (!coords || !lineElement) return line.to;
  const style = (view.dom.ownerDocument.defaultView || window).getComputedStyle(lineElement);
  const x = lineElement.getBoundingClientRect().right - (parseFloat(style.paddingRight) || 0) - 1;
  const y = (coords.top + coords.bottom) / 2;
  return positionOnLineEnd(line, view.posAtCoords({ x, y }, false), range.head);
}

function moveEnd(view, extend) {
  const { selection } = view.state;
  const ranges = selection.ranges.map(range => {
    const target = visualEndTarget(view, range);
    return extend
      ? EditorSelection.range(range.anchor, target)
      : EditorSelection.cursor(target);
  });
  view.dispatch({
    selection: EditorSelection.create(ranges, selection.mainIndex),
    scrollIntoView: true,
  });
  return true;
}

const lineBoundaryKeymap = Prec.high(keymap.of([
  {
    key: 'Home',
    run: view => moveHome(view, false),
    shift: view => moveHome(view, true),
    preventDefault: true,
  },
  {
    key: 'End',
    run: view => moveEnd(view, false),
    shift: view => moveEnd(view, true),
    preventDefault: true,
  },
]));

function previousSourceLineTarget(state, range, moved) {
  if (!range.empty) return null;
  const line = state.doc.lineAt(range.head);
  if (line.number === 1) return null;
  const movedLine = state.doc.lineAt(moved.head);
  if (movedLine.number >= line.number - 1) return null;
  const previous = state.doc.line(line.number - 1);
  return previous.from + Math.min(range.head - line.from, previous.length);
}

function moveUpWithoutSkippingSourceLines(view, extend) {
  const { selection } = view.state;
  const moved = selection.ranges.map(range => range.empty
    ? view.moveVertically(range, false) : null);
  const targets = selection.ranges.map((range, index) => moved[index]
    ? previousSourceLineTarget(view.state, range, moved[index]) : null);
  if (targets.every(target => target === null)) return false;
  const ranges = selection.ranges.map((range, index) => {
    const vertical = moved[index];
    if (!vertical) return range;
    const target = targets[index] ?? vertical.head;
    return extend
      ? EditorSelection.range(range.anchor, target, vertical.goalColumn)
      : EditorSelection.cursor(target, vertical.assoc, undefined, vertical.goalColumn);
  });
  view.dispatch({
    selection: EditorSelection.create(ranges, selection.mainIndex),
    scrollIntoView: true,
  });
  return true;
}

const sourceLineNavigationKeymap = Prec.high(keymap.of([{
  key: 'ArrowUp',
  run: view => moveUpWithoutSkippingSourceLines(view, false),
  shift: view => moveUpWithoutSkippingSourceLines(view, true),
  preventDefault: true,
}]));

function articleFileBase(articleId) {
  const parts = String(articleId || '').split('/').filter(Boolean);
  parts.pop();
  const directory = parts.map(encodeURIComponent).join('/');
  return new URL(`/files/${directory ? `${directory}/` : ''}`, location.origin);
}

function safeImageUrl(raw, articleId) {
  try {
    const value = raw.trim().replace(/^<|>$/g, '');
    const url = new URL(value, articleFileBase(articleId));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function plainInlineMarkdown(value) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(`+)(.*?)\1/g, '$2')
    .replace(/(\*\*|__|~~)(.*?)\1/g, '$2')
    .replace(/([*_])(.*?)\1/g, '$2')
    .replace(/\\([\\`*{}\[\]()#+\-.!_|>~])/g, '$1')
    .trim();
}

export function splitTableLine(line) {
  const cells = [];
  let current = '';
  let escaped = false;
  let ticks = 0;
  const source = line.trim().replace(/^\||\|$/g, '');
  for (const char of source) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\') {
      current += char;
      escaped = true;
    } else if (char === '`') {
      ticks = ticks ? 0 : 1;
      current += char;
    } else if (char === '|' && !ticks) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function tableData(source) {
  const lines = source.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) return null;
  const headers = splitTableLine(lines[0]);
  const dividers = splitTableLine(lines[1]);
  const divider = /^:?-{3,}:?$/;
  if (!headers.length || dividers.length !== headers.length || !dividers.every(cell => divider.test(cell))) return null;
  const align = dividers.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
  return { headers, align, rows: lines.slice(2).map(splitTableLine) };
}

class SourceWidget extends WidgetType {
  constructor(from) {
    super();
    this.from = from;
  }

  sourceAttributes(element) {
    element.dataset.mdSourceFrom = String(this.from);
    element.title = 'Klicken, um das Markdown zu bearbeiten';
    return element;
  }

  ignoreEvent() { return false; }
}

class MarkerWidget extends SourceWidget {
  constructor(from, text, className = '') {
    super(from);
    this.text = text;
    this.className = className;
  }

  eq(other) { return other.from === this.from && other.text === this.text && other.className === this.className; }

  toDOM() {
    const span = this.sourceAttributes(document.createElement('span'));
    span.className = `cm-md-rendered-marker ${this.className}`.trim();
    span.textContent = this.text;
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
}

class TaskWidget extends SourceWidget {
  constructor(from, checked) {
    super(from);
    this.checked = checked;
  }

  eq(other) { return other.from === this.from && other.checked === this.checked; }

  toDOM() {
    const span = this.sourceAttributes(document.createElement('span'));
    span.className = 'cm-md-task-widget';
    const box = span.appendChild(document.createElement('input'));
    box.type = 'checkbox';
    box.checked = this.checked;
    box.tabIndex = -1;
    box.setAttribute('aria-label', this.checked ? 'Erledigt' : 'Nicht erledigt');
    return span;
  }
}

class RuleWidget extends SourceWidget {
  eq(other) { return other.from === this.from; }

  toDOM() {
    const rule = this.sourceAttributes(document.createElement('span'));
    rule.className = 'cm-md-rule-widget';
    rule.setAttribute('role', 'separator');
    return rule;
  }
}

class ImageWidget extends SourceWidget {
  constructor(from, src, alt) {
    super(from);
    this.src = src;
    this.alt = alt;
  }

  eq(other) { return other.from === this.from && other.src === this.src && other.alt === this.alt; }

  toDOM() {
    const figure = this.sourceAttributes(document.createElement('span'));
    figure.className = 'cm-md-image-widget';
    if (this.src) {
      const image = figure.appendChild(document.createElement('img'));
      image.src = this.src;
      image.alt = this.alt;
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
    } else {
      const placeholder = figure.appendChild(document.createElement('span'));
      placeholder.className = 'cm-md-image-placeholder';
      placeholder.textContent = 'Bild nicht verfügbar';
    }
    if (this.alt) {
      const caption = figure.appendChild(document.createElement('span'));
      caption.className = 'cm-md-image-caption';
      caption.textContent = this.alt;
    }
    return figure;
  }
}

class TableWidget extends SourceWidget {
  constructor(from, source) {
    super(from);
    this.source = source;
  }

  eq(other) { return other.from === this.from && other.source === this.source; }

  toDOM() {
    const wrapper = this.sourceAttributes(document.createElement('div'));
    wrapper.className = 'cm-md-table-widget';
    const data = tableData(this.source);
    if (!data) {
      wrapper.textContent = this.source;
      return wrapper;
    }
    const table = wrapper.appendChild(document.createElement('table'));
    const head = table.appendChild(document.createElement('thead')).appendChild(document.createElement('tr'));
    data.headers.forEach((value, index) => {
      const cell = head.appendChild(document.createElement('th'));
      cell.textContent = plainInlineMarkdown(value);
      cell.style.textAlign = data.align[index];
    });
    const body = table.appendChild(document.createElement('tbody'));
    for (const row of data.rows) {
      const tr = body.appendChild(document.createElement('tr'));
      data.headers.forEach((_, index) => {
        const cell = tr.appendChild(document.createElement('td'));
        cell.textContent = plainInlineMarkdown(row[index] || '');
        cell.style.textAlign = data.align[index];
      });
    }
    return wrapper;
  }
}

function isTaskListMark(state, node) {
  const item = revealContainer(node);
  if (item.name !== 'ListItem') return false;
  const after = state.doc.sliceString(node.to, Math.min(item.to, node.to + 6));
  return /^\s+\[[ xX]\]/.test(after);
}

function addLineDecorations(ranges, state, node, className) {
  for (const from of lineRanges(state, node.from, node.to)) {
    ranges.push(Decoration.line({ attributes: { class: className } }).range(from));
  }
}

function imageDetails(state, node, resolveImageUrl) {
  const source = state.doc.sliceString(node.from, node.to);
  const alt = source.match(/^!\[([^\]]*)\]/)?.[1] || '';
  const urlNode = node.node.getChild('URL');
  const rawUrl = urlNode ? state.doc.sliceString(urlNode.from, urlNode.to) : '';
  return { alt: plainInlineMarkdown(alt), src: resolveImageUrl(rawUrl) };
}

function buildDecorations(state, resolveImageUrl) {
  const ranges = [];
  const atomic = [];
  const replace = (from, to, widget = null, block = false, isAtomic = true) => {
    const decoration = Decoration.replace({ widget, block });
    const range = decoration.range(from, to);
    ranges.push(range);
    if (isAtomic) atomic.push(range);
  };

  syntaxTree(state).iterate({
    enter(ref) {
      const node = ref.node;
      const active = nodeActive(state, node);
      const heading = HEADING_RE.exec(node.name);

      if (node.name === 'Table') {
        if (!active) {
          const source = state.doc.sliceString(node.from, node.to);
          replace(node.from, node.to, new TableWidget(node.from, source), true);
          return false;
        }
        addLineDecorations(ranges, state, node, 'cm-md-table-source-line');
      }

      if (node.name === 'Image' && !active) {
        const details = imageDetails(state, ref, resolveImageUrl);
        replace(node.from, node.to, new ImageWidget(node.from, details.src, details.alt));
        return false;
      }

      if (node.name === 'HorizontalRule' && !active) {
        replace(node.from, node.to, new RuleWidget(node.from));
        return false;
      }
      if (node.name === 'HorizontalRule' && active) {
        ranges.push(Decoration.mark({ class: 'cm-md-markup' }).range(node.from, node.to));
      }

      if (heading) addLineDecorations(ranges, state, node, `cm-md-heading-${heading[1]}`);
      if (node.name === 'Blockquote') addLineDecorations(ranges, state, node, 'cm-md-quote-line');
      if (node.name === 'ListItem') addLineDecorations(ranges, state, node, 'cm-md-list-line');
      if (CODE_BLOCK_NODES.has(node.name)) addLineDecorations(ranges, state, node, 'cm-md-code-line');

      const inlineClass = INLINE_CLASS[node.name];
      if (inlineClass) {
        const content = inlineContentRange(node);
        if (content.from < content.to) ranges.push(Decoration.mark({ class: inlineClass }).range(content.from, content.to));
      }

      if (node.name === 'ListMark') {
        const raw = state.doc.sliceString(node.from, node.to);
        if (active) ranges.push(Decoration.mark({ class: 'cm-md-markup' }).range(node.from, node.to));
        else if (isTaskListMark(state, node)) replace(node.from, node.to);
        else replace(node.from, node.to, new MarkerWidget(node.from, /^\d/.test(raw) ? raw : '•', 'cm-md-list-marker'));
      } else if (node.name === 'TaskMarker') {
        const raw = state.doc.sliceString(node.from, node.to);
        if (active) ranges.push(Decoration.mark({ class: 'cm-md-markup' }).range(node.from, node.to));
        else replace(node.from, node.to, new TaskWidget(node.from, /[xX]/.test(raw)));
      } else if (node.name === 'TableDelimiter') {
        ranges.push(Decoration.mark({ class: 'cm-md-markup' }).range(node.from, node.to));
      } else if (node.name === 'CodeInfo') {
        if (active) ranges.push(Decoration.mark({ class: 'cm-md-markup' }).range(node.from, node.to));
        else replace(node.from, node.to, null, false, false);
      } else if (MARKER_NODES.has(node.name)) {
        if (active) ranges.push(Decoration.mark({ class: 'cm-md-markup' }).range(node.from, node.to));
        else replace(node.from, node.to, null, false, false);
      } else if (node.name === 'URL' && node.parent?.name === 'Link') {
        if (active) ranges.push(Decoration.mark({ class: 'cm-md-link-target cm-md-markup' }).range(node.from, node.to));
        else replace(node.from, node.to, null, false, false);
      }
      return undefined;
    },
  });

  return {
    decorations: Decoration.set(ranges, true),
    atomic: Decoration.set(atomic, true),
  };
}

function livePreview(resolveImageUrl) {
  const field = StateField.define({
    create(state) { return buildDecorations(state, resolveImageUrl); },
    update(value, transaction) {
      return transaction.docChanged || transaction.selection
        || syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
        ? buildDecorations(transaction.state, resolveImageUrl) : value;
    },
    provide: stateField => EditorView.decorations.from(stateField, value => value.decorations),
  });
  return [
    field,
    EditorView.atomicRanges.of(view => view.state.field(field).atomic),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        const target = event.target instanceof Element ? event.target.closest('[data-md-source-from]') : null;
        if (!target) return false;
        const from = Number(target.dataset.mdSourceFrom);
        if (!Number.isInteger(from)) return false;
        view.dispatch({ selection: { anchor: from }, scrollIntoView: true });
        view.focus();
        event.preventDefault();
        return true;
      },
    }),
  ];
}

const TOOLBAR_ICONS = {
  undo: '<svg viewBox="0 0 24 24"><path d="M9 7 4 12l5 5M5 12h8a6 6 0 0 1 6 6"/></svg>',
  redo: '<svg viewBox="0 0 24 24"><path d="m15 7 5 5-5 5m4-5h-8a6 6 0 0 0-6 6"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>',
  quote: '<svg viewBox="0 0 24 24"><path d="M7 10h4v5H6v-4c0-3 1.5-5 4-6M16 10h4v5h-5v-4c0-3 1.5-5 4-6"/></svg>',
  code: '<svg viewBox="0 0 24 24"><path d="m8 5-6 7 6 7m8-14 6 7-6 7M14 3l-4 18"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2"/></svg>',
  table: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 10h18M9 4v16M15 4v16"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m4 17 5-5 4 4 2-2 5 5"/></svg>',
  clear: '<svg viewBox="0 0 24 24"><path d="m4 17 7-12h2l4 7M7 13h8M14 18l4-4 3 3-4 4h-3z"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg>',
};

function toolbarIcon(name) {
  return TOOLBAR_ICONS[name] || '';
}

function toolbarButton(command, label, content, className = '') {
  return `<button type="button" class="md-toolbar-button ${className}" data-md-command="${command}" aria-label="${label}" title="${label}">${content}</button>`;
}

function tableGrid(className = '') {
  const cells = [];
  for (let row = 1; row <= 5; row++) {
    for (let column = 1; column <= 5; column++) {
      cells.push(`<button type="button" data-md-table="${row},${column}" aria-label="Tabelle mit ${column} Spalten und ${row} Zeilen"></button>`);
    }
  }
  return `<div class="md-table-picker ${className}" role="group" aria-label="Tabellengröße auswählen">${cells.join('')}</div>`;
}

function createLinkDialog(view, applyEdit) {
  const dialog = document.createElement('dialog');
  dialog.className = 'md-link-dialog';
  dialog.setAttribute('aria-label', 'Link einfügen oder bearbeiten');
  dialog.innerHTML = `
    <form method="dialog">
      <h3>Link</h3>
      <label>Text anzeigen<input type="text" data-md-link-text placeholder="Text für den Link (optional)" autocomplete="off"></label>
      <label>Adresse<input type="text" data-md-link-url placeholder="Link zu einer vorhandenen Webseite" inputmode="url" autocomplete="off"></label>
      <p class="md-link-error" data-md-link-error role="alert"></p>
      <div class="md-link-actions">
        <button type="submit" value="insert" class="md-link-primary" data-md-link-submit disabled>Einfügen</button>
        <button type="button" data-md-link-cancel>Abbrechen</button>
      </div>
    </form>`;
  document.body.appendChild(dialog);
  const textInput = dialog.querySelector('[data-md-link-text]');
  const urlInput = dialog.querySelector('[data-md-link-url]');
  const submit = dialog.querySelector('[data-md-link-submit]');
  const error = dialog.querySelector('[data-md-link-error]');
  let target = null;

  const validate = () => {
    submit.disabled = !urlInput.value.trim();
    error.textContent = '';
  };
  urlInput.addEventListener('input', validate);
  dialog.querySelector('[data-md-link-cancel]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) dialog.close();
  });
  dialog.addEventListener('close', () => view.focus());
  dialog.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    const address = urlInput.value.trim();
    if (!address || /[\u0000-\u001f]/.test(address)) {
      error.textContent = 'Bitte eine gültige Adresse eingeben.';
      urlInput.focus();
      return;
    }
    applyEdit(setLinkMarkdown(view.state.doc.toString(), target, textInput.value, address));
    dialog.close();
  });

  return {
    open() {
      const { from, to } = view.state.selection.main;
      target = markdownLinkTarget(view.state.doc.toString(), from, to);
      textInput.value = target.text;
      urlInput.value = target.url;
      submit.textContent = target.url ? 'Übernehmen' : 'Einfügen';
      validate();
      // Am Ebenen-Stapel der App (Escape schließt nur den Link-Dialog); ohne Stapel nativ.
      if (globalThis.WebArchivLayers) globalThis.WebArchivLayers.open(dialog, { name: 'md-link', returnFocus: false });
      else dialog.showModal();
      requestAnimationFrame(() => (target.text ? urlInput : textInput).focus());
    },
    destroy() { dialog.remove(); },
  };
}

function createMarkdownToolbar(view, { onInsertImage } = {}) {
  const imageDesktop = onInsertImage
    ? toolbarButton('image', 'Bild einfügen', toolbarIcon('image'), 'md-toolbar-secondary') : '';
  const imageMore = onInsertImage
    ? toolbarButton('image', 'Bild einfügen', `${toolbarIcon('image')}<span>Bild einfügen</span>`) : '';
  const headingItems = [
    [1, 'Titel'], [2, 'Untertitel'], [3, 'Überschrift'], [4, 'Unterüberschrift'],
    [5, 'Abschnitt'], [6, 'Unterabschnitt'], [0, 'Textkörper'],
  ].map(([level, label]) => `<button type="button" class="md-heading-option md-heading-${level || 'body'}" data-md-heading="${level}" role="menuitem">${label}</button>`).join('');
  const desktopTable = `<div class="md-toolbar-dropdown md-toolbar-secondary" data-md-dropdown>
    <button type="button" class="md-toolbar-button" aria-haspopup="menu" aria-label="Tabelle" title="Tabelle">${toolbarIcon('table')}<span class="md-chevron">⌄</span></button>
    <div class="md-toolbar-menu md-table-menu" role="menu" aria-label="Tabelle" hidden><strong data-md-table-label>Tabelle einfügen</strong>${tableGrid()}</div>
  </div>`;
  const moreTable = `<div class="md-more-table"><strong data-md-table-label>Tabelle einfügen</strong>${tableGrid('is-compact')}</div>`;
  const element = document.createElement('div');
  element.className = 'md-editor-toolbar';
  element.setAttribute('role', 'toolbar');
  element.setAttribute('aria-label', 'Markdown formatieren');
  element.innerHTML = `
    <div class="md-toolbar-group md-toolbar-history">
      ${toolbarButton('undo', 'Rückgängig', toolbarIcon('undo'))}
      ${toolbarButton('redo', 'Wiederholen', toolbarIcon('redo'))}
    </div>
    <div class="md-toolbar-dropdown" data-md-dropdown>
      <button type="button" class="md-toolbar-button md-heading-summary" aria-haspopup="menu" aria-label="Absatzformat" title="Absatzformat"><span data-md-heading-label>Text</span><span class="md-chevron">⌄</span></button>
      <div class="md-toolbar-menu md-heading-menu" role="menu" aria-label="Absatzformat" hidden>${headingItems}</div>
    </div>
    <div class="md-toolbar-dropdown" data-md-dropdown>
      <button type="button" class="md-toolbar-button" aria-haspopup="menu" aria-label="Listen und Einzüge" title="Listen und Einzüge">${toolbarIcon('list')}<span class="md-chevron">⌄</span></button>
      <div class="md-toolbar-menu md-list-menu" role="menu" aria-label="Listen und Einzüge" hidden>
        <button type="button" data-md-list="bullet" role="menuitem"><span class="md-list-icon md-list-icon-bullet" aria-hidden="true">•</span><span>Aufzählung</span></button>
        <button type="button" data-md-list="ordered" role="menuitem"><span class="md-list-icon md-list-icon-number" aria-hidden="true">1.</span><span>Nummerierte Liste</span></button>
        <button type="button" data-md-list="task" role="menuitem"><span class="md-list-icon md-list-icon-task" aria-hidden="true">☑</span><span>Checkboxen</span></button>
        <button type="button" data-md-command="indent" role="menuitem"><span class="md-list-icon" aria-hidden="true">→</span><span>Einzug vergrößern</span></button>
        <button type="button" data-md-command="outdent" role="menuitem"><span class="md-list-icon" aria-hidden="true">←</span><span>Einzug verkleinern</span></button>
        <button type="button" data-md-command="rule" role="menuitem"><span class="md-list-icon md-list-icon-rule" aria-hidden="true">―</span><span>Trennlinie</span></button>
      </div>
    </div>
    <span class="md-toolbar-divider"></span>
    <div class="md-toolbar-group">
      ${toolbarButton('bold', 'Fett', '<strong>B</strong>')}
      ${toolbarButton('italic', 'Kursiv', '<em>I</em>')}
      ${toolbarButton('strike', 'Durchgestrichen', '<span class="md-strike">S</span>')}
    </div>
    <span class="md-toolbar-divider md-toolbar-secondary"></span>
    <div class="md-toolbar-group md-toolbar-secondary">
      ${toolbarButton('quote', 'Blockzitat', toolbarIcon('quote'))}
      ${toolbarButton('code', 'Code', toolbarIcon('code'))}
    </div>
    <span class="md-toolbar-divider md-toolbar-secondary"></span>
    <div class="md-toolbar-group">
      ${toolbarButton('link', 'Link', toolbarIcon('link'))}
      ${desktopTable}
      ${imageDesktop}
      ${toolbarButton('clear', 'Formatierung löschen', toolbarIcon('clear'), 'md-toolbar-secondary')}
    </div>
    <div class="md-toolbar-dropdown md-toolbar-more" data-md-dropdown>
      <button type="button" class="md-toolbar-button" aria-haspopup="menu" aria-label="Weitere Formatierungen" title="Weitere Formatierungen">${toolbarIcon('more')}</button>
      <div class="md-toolbar-menu md-more-menu" role="menu" aria-label="Weitere Formatierungen" hidden>
        <div class="md-more-actions">
          ${toolbarButton('undo', 'Rückgängig', `${toolbarIcon('undo')}<span>Rückgängig</span>`)}
          ${toolbarButton('redo', 'Wiederholen', `${toolbarIcon('redo')}<span>Wiederholen</span>`)}
          ${toolbarButton('quote', 'Blockzitat', `${toolbarIcon('quote')}<span>Blockzitat</span>`)}
          ${toolbarButton('code', 'Code', `${toolbarIcon('code')}<span>Code</span>`)}
          ${imageMore}
          ${toolbarButton('clear', 'Formatierung löschen', `${toolbarIcon('clear')}<span>Formatierung löschen</span>`)}
        </div>
        ${moreTable}
      </div>
    </div>`;
  view.dom.parentNode.insertBefore(element, view.dom);

  let disabled = false;
  const applyEdit = change => {
    if (!change || disabled) return;
    view.dispatch({
      changes: { from: change.from, to: change.to, insert: change.insert },
      selection: change.selection,
      scrollIntoView: true,
    });
    forceParsing(view, Math.min(view.state.doc.length, change.from + change.insert.length + 1), 50);
    view.focus();
  };
  const run = fn => {
    const { from, to } = view.state.selection.main;
    applyEdit(fn(view.state.doc.toString(), from, to));
  };
  const linkDialog = createLinkDialog(view, applyEdit);
  const keepMoreMenuVisible = dropdown => {
    const menu = dropdown.querySelector('.md-more-menu');
    if (!menu) return;
    menu.style.removeProperty('--md-menu-shift');
    const rect = menu.getBoundingClientRect();
    const toolbarRect = element.getBoundingClientRect();
    const minLeft = Math.max(8, toolbarRect.left + 4);
    const maxRight = Math.min(window.innerWidth - 8, toolbarRect.right - 4);
    let shift = rect.left < minLeft ? minLeft - rect.left : 0;
    if (rect.right + shift > maxRight) shift += maxRight - rect.right - shift;
    menu.style.setProperty('--md-menu-shift', `${Math.round(shift)}px`);
  };
  // Öffnen, Schließen, Tastatur und Escape übernimmt aria-menu.js; die Befehle
  // laufen über den delegierten Klick-Handler der Leiste.
  element.querySelectorAll('[role="menu"] button').forEach(button => button.setAttribute('role', 'menuitem'));
  const menus = [...element.querySelectorAll('[data-md-dropdown]')].map(dropdown => window.WebArchivAriaMenu.create({
    trigger: dropdown.querySelector('[aria-haspopup="menu"]'),
    menu: dropdown.querySelector('[role="menu"]'),
    // Der Klick auf die Toolbar nimmt dem Editor den DOM-Fokus. Die
    // CodeMirror-Auswahl bleibt jedoch erhalten und wird hier unmittelbar
    // vor dem Anzeigen des Menüs erneut in die Bedienelemente gespiegelt.
    onBeforeOpen: update,
    onOpen: () => keepMoreMenuVisible(dropdown),
  }));
  const closeMenus = () => menus.forEach(menu => menu.close());
  const onViewportResize = () => element.querySelectorAll('.md-toolbar-more').forEach(keepMoreMenuVisible);
  window.addEventListener('resize', onViewportResize);
  // Tabellenraster: Pfeiltasten bewegen sich zweidimensional statt der Listenfolge des Menüs
  // (Listener am Raster, damit er vor dem des Menüs greift).
  element.querySelectorAll('.md-table-picker').forEach(picker => picker.addEventListener('keydown', event => {
    const cell = event.target.closest('[data-md-table]');
    if (!cell || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const [row, column] = cell.dataset.mdTable.split(',').map(Number);
    const next = event.key === 'ArrowUp' ? [row - 1, column] : event.key === 'ArrowDown' ? [row + 1, column]
      : event.key === 'ArrowLeft' ? [row, column - 1] : [row, column + 1];
    picker.querySelector(`[data-md-table="${next.join(',')}"]`)?.focus();
  }));
  element.addEventListener('mouseover', event => {
    const cell = event.target.closest('[data-md-table]');
    if (!cell) return;
    const [rows, columns] = cell.dataset.mdTable.split(',').map(Number);
    const picker = cell.closest('.md-toolbar-menu');
    picker.querySelector('[data-md-table-label]').textContent = `${columns} × ${rows}`;
    picker.querySelectorAll('[data-md-table]').forEach(button => {
      const [buttonRows, buttonColumns] = button.dataset.mdTable.split(',').map(Number);
      button.classList.toggle('is-selected', buttonRows <= rows && buttonColumns <= columns);
    });
  });
  element.addEventListener('focusin', event => {
    const cell = event.target.closest('[data-md-table]');
    if (cell) cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
  element.addEventListener('click', event => {
    const heading = event.target.closest('[data-md-heading]');
    if (heading) {
      run((source, from, to) => setHeadingMarkdown(source, from, to, Number(heading.dataset.mdHeading)));
      return;
    }
    const list = event.target.closest('[data-md-list]');
    if (list) {
      run((source, from, to) => setListMarkdown(source, from, to, list.dataset.mdList));
      return;
    }
    const table = event.target.closest('[data-md-table]');
    if (table) {
      const [rows, columns] = table.dataset.mdTable.split(',').map(Number);
      run((source, from, to) => insertTableMarkdown(source, from, to, rows, columns));
      return;
    }
    const button = event.target.closest('[data-md-command]');
    if (!button || button.disabled || disabled) return;
    const command = button.dataset.mdCommand;
    if (command === 'undo' || command === 'redo') {
      (command === 'undo' ? undo : redo)(view);
      view.focus();
    } else if (command === 'bold') run((source, from, to) => toggleInlineMarkdown(source, from, to, '**'));
    else if (command === 'italic') run((source, from, to) => toggleInlineMarkdown(source, from, to, '*'));
    else if (command === 'strike') run((source, from, to) => toggleInlineMarkdown(source, from, to, '~~'));
    else if (command === 'quote') run(toggleBlockquoteMarkdown);
    else if (command === 'code') run(toggleCodeMarkdown);
    else if (command === 'indent') run((source, from, to) => indentMarkdown(source, from, to, 1));
    else if (command === 'outdent') run((source, from, to) => indentMarkdown(source, from, to, -1));
    else if (command === 'rule') run(insertRuleMarkdown);
    else if (command === 'clear') run(clearMarkdownFormatting);
    else if (command === 'link') linkDialog.open();
    else if (command === 'image') onInsertImage?.();
  });

  function hasNode(names) {
    const tree = syntaxTree(view.state);
    const { from, to, head } = view.state.selection.main;
    const matchesAt = (position, bias) => {
      let node = tree.resolveInner(position, bias);
      while (node) {
        if (names.includes(node.name)) return true;
        node = node.parent;
      }
      return false;
    };
    if (from === to) return matchesAt(head, -1) || matchesAt(head, 1);

    let found = false;
    tree.iterate({
      from,
      to,
      enter(node) {
        if (names.includes(node.name) && node.from < to && node.to > from) {
          found = true;
          return false;
        }
        return !found;
      },
    });
    return found;
  }

  function update() {
    const state = view.state;
    const source = state.doc.toString();
    const { head } = state.selection.main;
    const line = state.doc.lineAt(head).text;
    const heading = /^\s{0,3}(#{1,6})\s+/.exec(line)?.[1].length || 0;
    element.querySelector('[data-md-heading-label]').textContent = heading ? `H${heading}` : 'Text';
    element.querySelectorAll('[data-md-heading]').forEach(button => {
      button.setAttribute('aria-current', String(Number(button.dataset.mdHeading) === heading));
    });
    const list = /^\s*[-+*]\s+\[[ xX]\]\s+/.test(line) ? 'task'
      : /^\s*\d+[.)]\s+/.test(line) ? 'ordered'
        : /^\s*[-+*]\s+/.test(line) ? 'bullet' : '';
    element.querySelectorAll('[data-md-list]').forEach(button => {
      button.setAttribute('aria-current', String(button.dataset.mdList === list));
    });
    const active = {
      bold: hasNode(['StrongEmphasis']), italic: hasNode(['Emphasis']),
      strike: hasNode(['Strikethrough']), quote: hasNode(['Blockquote']),
      code: hasNode(['InlineCode', 'CodeBlock', 'FencedCode']), link: hasNode(['Link', 'Autolink']),
    };
    for (const [command, pressed] of Object.entries(active)) {
      element.querySelectorAll(`[data-md-command="${command}"]`).forEach(button => button.setAttribute('aria-pressed', String(pressed)));
    }
    element.querySelectorAll('button').forEach(button => { button.disabled = disabled; });
    if (!disabled) {
      element.querySelectorAll('[data-md-command="undo"]').forEach(button => { button.disabled = undoDepth(state) === 0; });
      element.querySelectorAll('[data-md-command="redo"]').forEach(button => { button.disabled = redoDepth(state) === 0; });
      element.querySelectorAll('[data-md-command="indent"], [data-md-command="outdent"]').forEach(button => { button.disabled = !list; });
    }
    element.classList.toggle('is-disabled', disabled);
    element.dataset.sourceLength = String(source.length);
  }

  return {
    update,
    setDisabled(value) { disabled = value; if (disabled) closeMenus(); update(); },
    runShortcut(key) {
      if (disabled) return false;
      if (!['b', 'i', 'k'].includes(key)) return false;
      if (key === 'b') run((source, from, to) => toggleInlineMarkdown(source, from, to, '**'));
      else if (key === 'i') run((source, from, to) => toggleInlineMarkdown(source, from, to, '*'));
      else linkDialog.open();
      return true;
    },
    destroy() {
      menus.forEach(menu => menu.destroy());
      window.removeEventListener('resize', onViewportResize);
      linkDialog.destroy();
      element.remove();
    },
  };
}

export function createMarkdownInput({
  parent,
  onChange,
  getArticleId = () => '',
  resolveImageUrl = raw => safeImageUrl(raw, getArticleId()),
  onInsertImage = null,
  labelledBy = '',
  describedBy = '',
}) {
  const mode = new Compartment();
  let replacingDocument = false;
  let toolbar = null;
  const runFormattingShortcut = key => {
    toolbar?.runShortcut(key);
    return true;
  };
  const formattingShortcutKeymap = Prec.high(keymap.of([
    { key: 'Mod-b', run: () => runFormattingShortcut('b'), preventDefault: true },
    { key: 'Mod-i', run: () => runFormattingShortcut('i'), preventDefault: true },
    { key: 'Mod-k', run: () => runFormattingShortcut('k'), preventDefault: true },
  ]));

  const modeExtensions = readOnly => [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
  ];

  const extensions = readOnly => [
    formattingShortcutKeymap,
    minimalSetup,
    lineBoundaryKeymap,
    sourceLineNavigationKeymap,
    markdown({ extensions: GFM }),
    EditorView.lineWrapping,
    EditorState.tabSize.of(2),
    EditorView.contentAttributes.of({
      ...(labelledBy ? { 'aria-labelledby': labelledBy } : {}),
      ...(describedBy ? { 'aria-describedby': describedBy } : {}),
      'aria-multiline': 'true',
      spellcheck: 'false',
    }),
    livePreview(resolveImageUrl),
    EditorView.updateListener.of(update => {
      if (update.docChanged && !replacingDocument) onChange();
      if (update.docChanged || update.selectionSet) toolbar?.update();
    }),
    mode.of(modeExtensions(readOnly)),
  ];

  const state = (value, readOnly) => EditorState.create({ doc: value, extensions: extensions(readOnly) });
  const view = new EditorView({ state: state('', true), parent });
  parent.classList.add('has-toolbar');
  toolbar = createMarkdownToolbar(view, { onInsertImage });
  const reflectReadOnly = readOnly => {
    parent.classList.toggle('is-readonly', readOnly);
    parent.setAttribute('aria-disabled', String(readOnly));
    toolbar.setDisabled(readOnly);
  };
  reflectReadOnly(true);

  return {
    getValue() { return view.state.doc.toString(); },
    setValue(value, { readOnly = false } = {}) {
      replacingDocument = true;
      view.setState(state(value, readOnly));
      replacingDocument = false;
      reflectReadOnly(readOnly);
      toolbar.update();
    },
    setReadOnly(readOnly) {
      view.dispatch({ effects: mode.reconfigure(modeExtensions(readOnly)) });
      reflectReadOnly(readOnly);
    },
    setBusy(busy) {
      parent.classList.toggle('is-busy', busy);
      parent.setAttribute('aria-busy', String(busy));
    },
    replaceSelection(value) {
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: value },
        selection: { anchor: from + value.length },
        scrollIntoView: true,
      });
      view.focus();
    },
    focus() { view.requestMeasure(); view.focus(); },
    destroy() {
      toolbar.destroy();
      view.destroy();
      parent.classList.remove('has-toolbar', 'is-readonly', 'is-busy');
    },
  };
}
