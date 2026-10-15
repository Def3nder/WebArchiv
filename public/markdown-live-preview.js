import { Compartment, EditorState, StateField } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { minimalSetup } from 'codemirror';

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
  const replace = (from, to, widget = null, block = false) => {
    const decoration = Decoration.replace({ widget, block });
    const range = decoration.range(from, to);
    ranges.push(range);
    atomic.push(range);
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
      if (inlineClass) ranges.push(Decoration.mark({ class: inlineClass }).range(node.from, node.to));

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
        else replace(node.from, node.to);
      } else if (MARKER_NODES.has(node.name)) {
        if (active) ranges.push(Decoration.mark({ class: 'cm-md-markup' }).range(node.from, node.to));
        else replace(node.from, node.to);
      } else if (node.name === 'URL' && node.parent?.name === 'Link') {
        if (active) ranges.push(Decoration.mark({ class: 'cm-md-link-target cm-md-markup' }).range(node.from, node.to));
        else replace(node.from, node.to);
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

export function createMarkdownInput({
  parent,
  onChange,
  getArticleId = () => '',
  resolveImageUrl = raw => safeImageUrl(raw, getArticleId()),
  labelledBy = '',
  describedBy = '',
}) {
  const mode = new Compartment();
  let replacingDocument = false;

  const modeExtensions = readOnly => [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
  ];

  const extensions = readOnly => [
    minimalSetup,
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
    }),
    mode.of(modeExtensions(readOnly)),
  ];

  const state = (value, readOnly) => EditorState.create({ doc: value, extensions: extensions(readOnly) });
  const view = new EditorView({ state: state('', true), parent });
  const reflectReadOnly = readOnly => {
    parent.classList.toggle('is-readonly', readOnly);
    parent.setAttribute('aria-disabled', String(readOnly));
  };
  reflectReadOnly(true);

  return {
    getValue() { return view.state.doc.toString(); },
    setValue(value, { readOnly = false } = {}) {
      replacingDocument = true;
      view.setState(state(value, readOnly));
      replacingDocument = false;
      reflectReadOnly(readOnly);
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
    destroy() { view.destroy(); },
  };
}
