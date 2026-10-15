const WORD_RE = /[\p{L}\p{N}\p{M}]+(?:[-'’][\p{L}\p{N}\p{M}]+)*/gu;

function lineBounds(source, from, to = from) {
  const start = source.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
  const newline = source.indexOf('\n', Math.max(from, to));
  return { from: start, to: newline < 0 ? source.length : newline };
}

export function markdownWordRange(source, position) {
  const line = lineBounds(source, position);
  const text = source.slice(line.from, line.to);
  for (const match of text.matchAll(WORD_RE)) {
    const from = line.from + match.index;
    const to = from + match[0].length;
    if (position >= from && position <= to) return { from, to };
  }
  return { from: position, to: position };
}

export function markdownTargetRange(source, from, to) {
  return from === to ? markdownWordRange(source, from) : { from, to };
}

export function applyMarkdownEdit(source, edit) {
  return source.slice(0, edit.from) + edit.insert + source.slice(edit.to);
}

function edit(from, to, insert, anchor, head = anchor) {
  return { from, to, insert, selection: { anchor, head } };
}

export function toggleInlineMarkdown(source, from, to, open, close = open) {
  const target = markdownTargetRange(source, from, to);
  const value = source.slice(target.from, target.to);
  if (!value) return edit(target.from, target.to, open + close, target.from + open.length);

  const outerFrom = target.from - open.length;
  const outerTo = target.to + close.length;
  if (outerFrom >= 0 && source.slice(outerFrom, target.from) === open
      && source.slice(target.to, outerTo) === close) {
    return edit(outerFrom, outerTo, value, outerFrom, outerFrom + value.length);
  }
  if (value.startsWith(open) && value.endsWith(close) && value.length >= open.length + close.length) {
    const plain = value.slice(open.length, value.length - close.length);
    return edit(target.from, target.to, plain, target.from, target.from + plain.length);
  }
  const wrapped = open + value + close;
  return edit(target.from, target.to, wrapped,
    target.from + open.length, target.from + open.length + value.length);
}

function blockEdit(source, from, to, transform) {
  const bounds = lineBounds(source, from, to);
  const original = source.slice(bounds.from, bounds.to);
  const insert = transform(original.split('\n')).join('\n');
  if (from === to) {
    const offset = Math.max(0, Math.min(insert.length, from - bounds.from + insert.length - original.length));
    return edit(bounds.from, bounds.to, insert, bounds.from + offset);
  }
  return edit(bounds.from, bounds.to, insert, bounds.from, bounds.from + insert.length);
}

export function setHeadingMarkdown(source, from, to, level) {
  return blockEdit(source, from, to, lines => lines.map(line => {
    if (!line.trim()) return line;
    const body = line.replace(/^\s{0,3}#{1,6}(?:\s+|$)/, '');
    return level ? `${'#'.repeat(level)} ${body}` : body;
  }));
}

const LIST_MARKER = /^(\s*)(?:[-+*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/;

function listMatcher(type) {
  if (type === 'ordered') return /^\s*\d+[.)]\s+/;
  if (type === 'task') return /^\s*[-+*]\s+\[[ xX]\]\s+/;
  return /^\s*[-+*]\s+(?!\[[ xX]\]\s+)/;
}

export function setListMarkdown(source, from, to, type) {
  return blockEdit(source, from, to, lines => {
    const matcher = listMatcher(type);
    const contentLines = lines.filter(line => line.trim());
    const remove = contentLines.length > 0 && contentLines.every(line => matcher.test(line));
    let number = 1;
    return lines.map(line => {
      if (!line.trim()) return line;
      const indent = line.match(/^\s*/)[0];
      const body = line.replace(LIST_MARKER, '$1').slice(indent.length);
      if (remove) return indent + body;
      const marker = type === 'ordered' ? `${number++}. ` : type === 'task' ? '- [ ] ' : '- ';
      return indent + marker + body;
    });
  });
}

export function indentMarkdown(source, from, to, direction) {
  return blockEdit(source, from, to, lines => lines.map(line => {
    if (!line.trim()) return line;
    if (direction > 0) return `  ${line}`;
    return line.startsWith('\t') ? line.slice(1) : line.replace(/^ {1,2}/, '');
  }));
}

export function toggleBlockquoteMarkdown(source, from, to) {
  return blockEdit(source, from, to, lines => {
    const nonEmpty = lines.filter(line => line.trim());
    const remove = nonEmpty.length > 0 && nonEmpty.every(line => /^\s*>\s?/.test(line));
    return lines.map(line => !line.trim() ? line
      : remove ? line.replace(/^(\s*)>\s?/, '$1') : line.replace(/^(\s*)/, '$1> '));
  });
}

export function toggleCodeMarkdown(source, from, to) {
  const selected = source.slice(from, to);
  const target = markdownTargetRange(source, from, to);
  if (!selected.includes('\n') && target.from !== target.to) {
    return toggleInlineMarkdown(source, from, to, '`');
  }
  const value = selected || '';
  const fenced = `\`\`\`\n${value}\n\`\`\``;
  return edit(from, to, fenced, from + 4, selected ? from + 4 + value.length : from + 4);
}

export function insertRuleMarkdown(source, from, to) {
  const before = from > 0 && source[from - 1] !== '\n' ? '\n\n' : '';
  const after = to < source.length && source[to] !== '\n' ? '\n\n' : '';
  const insert = `${before}---${after}`;
  return edit(from, to, insert, from + before.length + 3);
}

export function clearMarkdownFormatting(source, from, to) {
  const target = markdownTargetRange(source, from, to);
  if (target.from !== target.to) {
    const wrappers = [['**', '**'], ['__', '__'], ['~~', '~~'], ['*', '*'], ['_', '_'], ['`', '`']];
    for (const [open, close] of wrappers) {
      const outerFrom = target.from - open.length;
      const outerTo = target.to + close.length;
      if (outerFrom >= 0 && source.slice(outerFrom, target.from) === open
          && source.slice(target.to, outerTo) === close) {
        const value = source.slice(target.from, target.to);
        return edit(outerFrom, outerTo, value, outerFrom, outerFrom + value.length);
      }
    }
    const value = source.slice(target.from, target.to)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|~~|`)(.*?)\1/g, '$2')
      .replace(/([*_])(.*?)\1/g, '$2');
    return edit(target.from, target.to, value, target.from, target.from + value.length);
  }
  return blockEdit(source, from, to, lines => lines.map(line => line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^(\s*)>\s?/, '$1')
    .replace(LIST_MARKER, '$1')));
}

export function markdownLinkTarget(source, from, to) {
  const bounds = lineBounds(source, from, to);
  const line = source.slice(bounds.from, bounds.to);
  const selected = markdownTargetRange(source, from, to);
  const link = /\[([^\]]*)\]\(([^)]+)\)/g;
  for (const match of line.matchAll(link)) {
    const linkFrom = bounds.from + match.index;
    const linkTo = linkFrom + match[0].length;
    if (selected.from < linkTo && selected.to > linkFrom
        || from === to && from >= linkFrom && from <= linkTo) {
      return { from: linkFrom, to: linkTo, text: match[1], url: match[2] };
    }
  }
  return { ...selected, text: source.slice(selected.from, selected.to), url: '' };
}

export function setLinkMarkdown(source, target, text, url) {
  const label = String(text || target.text || url).trim();
  const address = String(url).trim();
  const insert = `[${label.replace(/[\[\]\n]/g, ' ')}](${address.replace(/[\s\n]+/g, '')})`;
  return edit(target.from, target.to, insert, target.from + 1, target.from + 1 + label.length);
}

export function insertTableMarkdown(source, from, to, rows, columns) {
  const rowCount = Math.max(2, Math.min(8, Number(rows) || 2));
  const columnCount = Math.max(1, Math.min(8, Number(columns) || 1));
  const header = `| ${Array.from({ length: columnCount }, (_, index) => `Spalte ${index + 1}`).join(' | ')} |`;
  const separator = `| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`;
  const empty = `| ${Array.from({ length: columnCount }, () => ' ').join(' | ')} |`;
  const table = [header, separator, ...Array.from({ length: rowCount - 1 }, () => empty)].join('\n');
  const before = from > 0 && source[from - 1] !== '\n' ? '\n\n' : '';
  const after = to < source.length && source[to] !== '\n' ? '\n\n' : '';
  const insert = before + table + after;
  const firstHeader = from + before.length + 2;
  return edit(from, to, insert, firstHeader, firstHeader + 'Spalte 1'.length);
}
