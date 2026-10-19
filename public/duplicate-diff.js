// Textvergleich für die Dublettenprüfung; Browser-Bundle: npm run build:duplicate-diff.
'use strict';

const { diffArrays, diffWordsWithSpace } = require('diff');

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

// Unsichtbare Zeichen und Umbrüche haben keinen Einfluss auf die Satz-Zuordnung.
function comparisonSentences(value) {
  const visible = String(value ?? '').normalize('NFC').replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim();
  if (!visible) return [];
  return [...new Intl.Segmenter('de', { granularity: 'sentence' }).segment(visible)]
    .map(part => part.segment.trim()).filter(Boolean);
}

function sentenceSimilarity(left, right) {
  const words = value => new Set(value.toLocaleLowerCase('de-DE').match(/[\p{L}\p{N}]+/gu) || []);
  const a = words(left);
  const b = words(right);
  let common = 0;
  for (const word of a) if (b.has(word)) common++;
  return common / (a.size + b.size - common || 1);
}

function comparisonRow(blog, facebook) {
  if (blog == null) return {
    kind: 'facebook-only', blog: '<span class="duplicate-diff-gap">Kein Text im Blog</span>', facebook: escapeHtml(facebook),
  };
  if (facebook == null) return {
    kind: 'blog-only', blog: escapeHtml(blog), facebook: '<span class="duplicate-diff-gap">Kein Text auf Facebook</span>',
  };
  if (blog === facebook) return { kind: 'equal', blog: escapeHtml(blog), facebook: escapeHtml(facebook) };
  const difference = renderPair(blog, facebook);
  return { kind: 'changed', blog: difference.blog, facebook: difference.facebook };
}

function alignChangedSentences(blog, facebook) {
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
        1 - sentenceSimilarity(blog[i], facebook[j]) + cost[i + 1][j + 1],
        gapCost + cost[i + 1][j],
        gapCost + cost[i][j + 1],
      );
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && 1 - sentenceSimilarity(blog[i], facebook[j]) + cost[i + 1][j + 1] <= cost[i][j] + 0.000001) {
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

function renderAlignedRows(blogText, facebookText, { onlyDifferences = false } = {}) {
  const blog = comparisonSentences(blogText);
  const facebook = comparisonSentences(facebookText);
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
    rows.push(...alignChangedSentences(removed, added));
  }
  return onlyDifferences ? compactComparisonRows(rows) : rows;
}

module.exports = { renderPair, renderAlignedRows };
