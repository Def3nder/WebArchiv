// Textvergleich für die Dublettenprüfung – übernommen aus WebArchiv/public/duplicate-diff.js.
// Läuft im Browser (globales „Diff“ aus /vendor/diff.min.js) und in Node (require('diff')).
// Intern heißt Seite A „blog“ und Seite B „facebook“, wie im Original.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('diff'));
  else root.duplicateTextDiff = factory(root.Diff);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (diffLibrary) {
'use strict';
const { diffArrays, diffWordsWithSpace } = diffLibrary;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function renderSide(changes, side) {
  return changes.filter(change => side === 'blog' ? !change.added : !change.removed)
    .map(change => {
      const value = escapeHtml(change.value).replace(/\n/g, '<br>');
      const differs = side === 'blog' ? change.removed : change.added;
      return differs ? `<mark>${value}</mark>` : value;
    }).join('');
}

function commonText(changes, start, end) {
  return changes.slice(start, end).filter(change => !change.added && !change.removed)
    .map(change => change.value).join('');
}

function contextLine(value, edge, maxChars) {
  const lines = String(value).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const line = edge === 'before' ? lines.at(-1) : lines[0];
  if (!line) return { text: '', omitted: Boolean(value.trim()) };
  let text = edge === 'before' ? line.slice(-maxChars) : line.slice(0, maxChars);
  if (line.length > maxChars && edge === 'before'
      && /\S/.test(line[line.length - maxChars - 1]) && /\S/.test(text[0])) {
    const boundary = text.search(/\s/);
    if (boundary > 0 && boundary < text.length - 8) text = text.slice(boundary + 1);
  } else if (line.length > maxChars && edge !== 'before'
      && /\S/.test(text.at(-1)) && /\S/.test(line[maxChars])) {
    const boundary = text.lastIndexOf(' ');
    if (boundary > 8) text = text.slice(0, boundary);
  }
  return { text: text.trim(), omitted: value.trim().length > text.length };
}

function groupChanges(changes, maxChars) {
  const changed = changes.flatMap((change, index) => change.added || change.removed ? [index] : []);
  const groups = [];
  for (const index of changed) {
    const previous = groups.at(-1);
    const gap = previous ? commonText(changes, previous.last + 1, index) : '';
    if (!previous || gap.length > maxChars * 2 || (gap.match(/\n/g) || []).length > 1) {
      groups.push({ first: index, last: index });
    } else {
      previous.last = index;
    }
  }
  return groups;
}

function renderCompactSide(changes, groups, side, maxChars) {
  if (!groups.length) return '<p class="duplicate-diff-identical">Keine Textunterschiede.</p>';
  return groups.map((group, index) => {
    const previousEnd = index ? groups[index - 1].last + 1 : 0;
    const nextStart = index + 1 < groups.length ? groups[index + 1].first : changes.length;
    const before = contextLine(commonText(changes, previousEnd, group.first), 'before', maxChars);
    const afterText = commonText(changes, group.last + 1, nextStart);
    const attachedPunctuation = afterText.match(/^[^\s\p{L}\p{N}][^\s]*/u)?.[0] || '';
    const after = contextLine(afterText.slice(attachedPunctuation.length), 'after', maxChars);
    const core = changes.slice(group.first, group.last + 1);
    const hasOwnChange = core.some(change => side === 'blog' ? change.removed : change.added);
    let gapShown = false;
    const center = core.map(change => {
      const belongs = side === 'blog' ? !change.added : !change.removed;
      if (!belongs) {
        if (hasOwnChange || gapShown) return '';
        gapShown = true;
        return '<span class="duplicate-diff-gap">Keine Entsprechung auf dieser Seite</span>';
      }
      const value = escapeHtml(change.value).replace(/\n/g, '<br>');
      return change.added || change.removed ? `<mark>${value}</mark>` : value;
    }).join('');
    const leading = index || before.omitted ? '<div class="duplicate-diff-ellipsis" aria-label="Ausgelassener Text">[…]</div>' : '';
    const trailing = index === groups.length - 1 && after.omitted ? '<div class="duplicate-diff-ellipsis" aria-label="Ausgelassener Text">[…]</div>' : '';
    return `${leading}<section class="duplicate-diff-hunk" aria-label="Unterschied ${index + 1} von ${groups.length}">
      ${before.text ? `<div class="duplicate-diff-context">${escapeHtml(before.text)}</div>` : ''}
      <div class="duplicate-diff-core">${center}${escapeHtml(attachedPunctuation)}</div>
      ${after.text ? `<div class="duplicate-diff-context">${escapeHtml(after.text)}</div>` : ''}
    </section>${trailing}`;
  }).join('');
}

function renderPair(blogText, facebookText, { onlyDifferences = false, contextChars = 68 } = {}) {
  const changes = diffWordsWithSpace(String(blogText || ''), String(facebookText || ''), { ignoreCase: false });
  if (onlyDifferences) {
    const maxChars = Math.min(120, Math.max(24, Math.floor(Number(contextChars) || 68)));
    const groups = groupChanges(changes, maxChars);
    return {
      blog: renderCompactSide(changes, groups, 'blog', maxChars),
      facebook: renderCompactSide(changes, groups, 'facebook', maxChars),
    };
  }
  return {
    blog: renderSide(changes, 'blog'),
    facebook: renderSide(changes, 'facebook'),
  };
}

// Der Artikeldetailbereich zeigt bodyHtml. Dessen sichtbare Blocktexte sind die Diff-Eingabe.
function normalizeRenderedBlock(value) {
  return String(value ?? '').normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, character => /\s/u.test(character) ? ' ' : '')
    .replace(/\s+/gu, ' ').trim();
}

function renderedBlocksFromHtml(html, documentRef = globalThis.document) {
  const template = documentRef.createElement('template');
  template.innerHTML = String(html ?? '');
  template.content.querySelectorAll('script,style,noscript,template,svg,math,iframe,object,embed,canvas,video,audio,img,picture,link,meta,[hidden],[aria-hidden="true"]')
    .forEach(node => node.remove());
  template.content.querySelectorAll('[style]').forEach(node => {
    if (node.style.display === 'none' || node.style.visibility === 'hidden') node.remove();
  });
  template.content.querySelectorAll('br').forEach(node => node.replaceWith(documentRef.createTextNode(' ')));

  const blockTags = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'LI', 'TR',
    'BLOCKQUOTE', 'DIV', 'SECTION', 'ARTICLE', 'UL', 'OL', 'TABLE', 'THEAD', 'TBODY', 'TFOOT',
    'DL', 'DT', 'DD', 'HR']);
  const leafTags = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'DT', 'DD']);
  const blocks = [];
  const add = value => {
    const text = normalizeRenderedBlock(value);
    if (text) blocks.push(text);
  };
  function walkChildren(parent) {
    let inline = '';
    for (const child of parent.childNodes) {
      if (child.nodeType === 3) inline += child.nodeValue;
      else if (child.nodeType === 1) {
        if (blockTags.has(child.tagName)) {
          add(inline);
          inline = '';
          walk(child);
        } else {
          inline += child.textContent;
        }
      }
    }
    add(inline);
  }
  function walk(node) {
    if (node.nodeType === 11) return walkChildren(node);
    if (node.tagName === 'TR') {
      add([...node.children].filter(cell => cell.matches('th,td')).map(cell => cell.textContent).join(' | '));
    } else if (leafTags.has(node.tagName)) {
      add(node.textContent);
    } else {
      walkChildren(node);
    }
  }
  walk(template.content);
  return blocks;
}

function comparisonBlocks(value) {
  return (Array.isArray(value) ? value : [value]).map(normalizeRenderedBlock).filter(Boolean);
}

function blockSimilarity(left, right) {
  const words = value => new Set(value.toLocaleLowerCase('de-DE').match(/[\p{L}\p{N}]+/gu) || []);
  const a = words(left);
  const b = words(right);
  let common = 0;
  for (const word of a) if (b.has(word)) common++;
  return common / (a.size + b.size - common || 1);
}

function comparisonRow(blog, facebook) {
  if (blog == null) return {
    kind: 'facebook-only', blog: '<span class="duplicate-diff-gap">Kein Text in A</span>', facebook: escapeHtml(facebook),
  };
  if (facebook == null) return {
    kind: 'blog-only', blog: escapeHtml(blog), facebook: '<span class="duplicate-diff-gap">Kein Text in B</span>',
  };
  if (blog === facebook) return { kind: 'equal', blog: escapeHtml(blog), facebook: escapeHtml(facebook) };
  const difference = renderPair(blog, facebook);
  return { kind: 'changed', blog: difference.blog, facebook: difference.facebook };
}

function alignChangedBlocks(blog, facebook) {
  const m = blog.length;
  const n = facebook.length;
  if (!m || !n) return [...blog.map(line => comparisonRow(line, null)), ...facebook.map(line => comparisonRow(null, line))];
  // Große Blöcke bleiben linear; gewöhnliche Änderungsblöcke erhalten eine Ähnlichkeits-Zuordnung.
  if (m * n > 2500) {
    return Array.from({ length: Math.max(m, n) }, (_, index) => comparisonRow(blog[index] ?? null, facebook[index] ?? null));
  }
  const gapCost = 0.65;
  const cost = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = m; i >= 0; i--) {
    for (let j = n; j >= 0; j--) {
      if (i === m) cost[i][j] = (n - j) * gapCost;
      else if (j === n) cost[i][j] = (m - i) * gapCost;
      else cost[i][j] = Math.min(
        1 - blockSimilarity(blog[i], facebook[j]) + cost[i + 1][j + 1],
        gapCost + cost[i + 1][j],
        gapCost + cost[i][j + 1],
      );
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && 1 - blockSimilarity(blog[i], facebook[j]) + cost[i + 1][j + 1] <= cost[i][j] + 0.000001) {
      rows.push(comparisonRow(blog[i++], facebook[j++]));
    } else if (i < m && (j === n || gapCost + cost[i + 1][j] <= gapCost + cost[i][j + 1])) {
      rows.push(comparisonRow(blog[i++], null));
    } else {
      rows.push(comparisonRow(null, facebook[j++]));
    }
  }
  return rows;
}

function compactComparisonRows(rows) {
  const keep = new Set();
  for (let index = 0; index < rows.length; index++) {
    if (rows[index].kind === 'equal') continue;
    for (let context = Math.max(0, index - 1); context <= Math.min(rows.length - 1, index + 1); context++) keep.add(context);
  }
  if (!keep.size) return [{ kind: 'identical', blog: 'Keine sichtbaren Textunterschiede.', facebook: 'Keine sichtbaren Textunterschiede.' }];
  const visible = [];
  let omitted = false;
  for (let index = 0; index < rows.length; index++) {
    if (!keep.has(index)) {
      if (!omitted) visible.push({ kind: 'ellipsis', blog: '[…]', facebook: '[…]' });
      omitted = true;
      continue;
    }
    visible.push(rows[index].kind === 'equal' ? { ...rows[index], kind: 'context' } : rows[index]);
    omitted = false;
  }
  return visible;
}

function renderAlignedRows(blogBlocks, facebookBlocks, { onlyDifferences = false } = {}) {
  const blog = comparisonBlocks(blogBlocks);
  const facebook = comparisonBlocks(facebookBlocks);
  const changes = diffArrays(blog, facebook);
  const rows = [];
  for (let index = 0; index < changes.length;) {
    const change = changes[index];
    if (!change.added && !change.removed) {
      rows.push(...change.value.map(line => comparisonRow(line, line)));
      index++;
      continue;
    }
    const removed = [];
    const added = [];
    while (index < changes.length && (changes[index].added || changes[index].removed)) {
      if (changes[index].removed) removed.push(...changes[index].value);
      else added.push(...changes[index].value);
      index++;
    }
    rows.push(...alignChangedBlocks(removed, added));
  }
  return onlyDifferences ? compactComparisonRows(rows) : rows;
}

function unifiedLines(row, blogNumber, facebookNumber) {
  if (row.kind === 'equal') return [{ kind: 'equal', html: row.blog, blogNumber, facebookNumber }];
  const lines = [];
  if (row.kind === 'facebook-only' || row.kind === 'changed') {
    lines.push({ kind: 'removed', html: row.facebook, blogNumber: null, facebookNumber });
  }
  if (row.kind === 'blog-only' || row.kind === 'changed') {
    lines.push({ kind: 'added', html: row.blog, blogNumber, facebookNumber: null });
  }
  return lines;
}

// Einspaltige Code-Diff-Daten: Absatzgrenzen beeinflussen nur die Anzeige, nicht den Textabgleich.
function renderUnifiedRows(blogBlocks, facebookBlocks, { onlyDifferences = false } = {}) {
  const blog = comparisonBlocks(blogBlocks);
  const facebook = comparisonBlocks(facebookBlocks);
  const stream = blocks => {
    const words = [];
    const boundaries = new Set();
    for (const block of blocks) {
      words.push(...block.split(' '));
      boundaries.add(words.length);
    }
    return { words, boundaries };
  };
  const blogStream = stream(blog);
  const facebookStream = stream(facebook);
  const changes = diffArrays(blogStream.words, facebookStream.words);
  const aligned = [];
  let blogOffset = 0;
  let facebookOffset = 0;
  let blogRow = [];
  let facebookRow = [];
  const flushRow = () => {
    if (!blogRow.length && !facebookRow.length) return;
    aligned.push(comparisonRow(blogRow.length ? blogRow.join(' ') : null,
      facebookRow.length ? facebookRow.join(' ') : null));
    blogRow = [];
    facebookRow = [];
  };
  const atBoundary = () => blogStream.boundaries.has(blogOffset)
    || facebookStream.boundaries.has(facebookOffset);
  for (let index = 0; index < changes.length;) {
    const change = changes[index];
    if (!change.added && !change.removed) {
      // Gemeinsame Wörter an den ursprünglichen Blockgrenzen oder nach 32 Wörtern umbrechen.
      for (const word of change.value) {
        blogRow.push(word);
        facebookRow.push(word);
        blogOffset++;
        facebookOffset++;
        if (atBoundary() || Math.max(blogRow.length, facebookRow.length) >= 32) flushRow();
      }
      index++;
      continue;
    }
    const blogOnly = [];
    const facebookOnly = [];
    while (index < changes.length && (changes[index].added || changes[index].removed)) {
      if (changes[index].removed) blogOnly.push(...changes[index].value);
      else facebookOnly.push(...changes[index].value);
      index++;
    }
    blogRow.push(...blogOnly);
    facebookRow.push(...facebookOnly);
    blogOffset += blogOnly.length;
    facebookOffset += facebookOnly.length;
    if (atBoundary()) flushRow();
  }
  flushRow();
  let blogNumber = 0;
  let facebookNumber = 0;
  const numbered = aligned.map(row => {
    if (row.kind !== 'facebook-only') blogNumber++;
    if (row.kind !== 'blog-only') facebookNumber++;
    return { ...row, blogNumber: row.kind === 'facebook-only' ? null : blogNumber,
      facebookNumber: row.kind === 'blog-only' ? null : facebookNumber };
  });
  if (!onlyDifferences) return numbered.flatMap(row => unifiedLines(row, row.blogNumber, row.facebookNumber));

  const keep = new Set();
  for (let index = 0; index < numbered.length; index++) {
    if (numbered[index].kind === 'equal') continue;
    for (let context = Math.max(0, index - 1); context <= Math.min(numbered.length - 1, index + 1); context++) keep.add(context);
  }
  const visible = [];
  if (!keep.size && numbered.length) {
    const sameBlocks = blog.length === facebook.length && blog.every((block, index) => block === facebook[index]);
    visible.push({ kind: 'identical', text: sameBlocks
      ? 'Keine sichtbaren Textunterschiede.'
      : 'Gleicher sichtbarer Text – nur die Absatzstruktur weicht ab.' });
  }
  let hidden = [];
  const flushHidden = () => {
    if (!hidden.length) return;
    visible.push({ kind: 'fold', count: hidden.length, lines: hidden.flatMap(row => unifiedLines(row, row.blogNumber, row.facebookNumber)) });
    hidden = [];
  };
  for (let index = 0; index < numbered.length; index++) {
    const row = numbered[index];
    if (!keep.has(index)) {
      hidden.push(row);
    } else {
      flushHidden();
      visible.push(...unifiedLines(row, row.blogNumber, row.facebookNumber));
    }
  }
  flushHidden();
  return visible;
}

return { renderPair, renderedBlocksFromHtml, renderAlignedRows, renderUnifiedRows };
});
