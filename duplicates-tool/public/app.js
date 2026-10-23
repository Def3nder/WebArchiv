// Oberfläche des Dubletten-Werkzeugs – Darstellung übernommen aus
// WebArchiv/public/duplicates.js (Karten, Vergleichsansicht, Bildbetrachter).
'use strict';

const DUPLICATE_SELECTION_KEY = 'duplicates-tool-selection-v1';
const DUPLICATE_PAIR_SEPARATOR = '\u001f';

const duplicateUi = {
  data: { pending: [], ignored: [], moved: [], scan: null, config: null },
  tab: 'pending',
  detail: null,
  busy: false,
  filters: { score: 'all', method: 'all', query: '' },
  selection: new Set(),
  mobileSide: 'blog',
  onlyDifferences: true,
  viewerItems: [],
  viewerIndex: 0,
};

const setupForm = document.getElementById('setup');
const scanButton = document.getElementById('scan-button');
const scanInfo = document.getElementById('scan-info');
const duplicateContent = document.getElementById('duplicate-content');
const duplicateDetailDialog = document.getElementById('duplicate-detail-dialog');
const duplicateDetailContent = document.getElementById('duplicate-detail-content');
const duplicateStatus = document.getElementById('duplicate-status');
const duplicateTools = document.getElementById('duplicate-tools');
const duplicateScoreFilter = document.getElementById('duplicate-score-filter');
const duplicateSearch = document.getElementById('duplicate-search');
const duplicateSelectionCount = document.getElementById('duplicate-selection-count');
const duplicateSelectAll = document.getElementById('duplicate-select-all');
const duplicateSelectNone = document.getElementById('duplicate-select-none');
const duplicateBatchMove = document.getElementById('duplicate-batch-move');
const duplicateImageViewer = document.getElementById('duplicate-image-viewer');
const duplicateImageViewerImage = document.getElementById('duplicate-image-viewer-image');
const duplicateImageViewerSide = document.getElementById('duplicate-image-viewer-side');
const duplicateImageViewerTitle = document.getElementById('duplicate-image-viewer-title');
const duplicateImageViewerCounter = document.getElementById('duplicate-image-viewer-counter');
const duplicateImageViewerPrev = document.getElementById('duplicate-image-viewer-prev');
const duplicateImageViewerNext = document.getElementById('duplicate-image-viewer-next');
const folderDialog = document.getElementById('folder-dialog');
const folderRoots = document.getElementById('folder-roots');
const folderList = document.getElementById('folder-list');
const folderPathInput = document.getElementById('folder-path-input');
const folderUp = document.getElementById('folder-up');
const folderInfo = document.getElementById('folder-info');

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg']);

function duplicateEsc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function duplicateDate(value) {
  if (!value) return 'ohne Datum';
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('de-DE');
}

function duplicateRequest(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers,
  }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  });
}

function duplicateScoreText(item) {
  const similarity = Number(item.score);
  if (item.score == null) return '';
  if (item.exact) return '100 %';
  if (similarity >= 1) return '< 100 %';
  return similarity >= 0.995 ? `${(similarity * 100).toFixed(1).replace('.', ',')} %` : `${Math.round(similarity * 100)} %`;
}

// ─── Auswahl ─────────────────────────────────────────────────────────────

function duplicatePairIds(item) {
  return {
    originalId: String(item.original?.id || item.originalId || ''),
    candidateId: String(item.candidate?.id || item.candidateId || ''),
  };
}

function duplicatePairKey(item) {
  const { originalId, candidateId } = duplicatePairIds(item);
  return `${originalId}${DUPLICATE_PAIR_SEPARATOR}${candidateId}`;
}

function duplicatePairAttrs(item) {
  const { originalId, candidateId } = duplicatePairIds(item);
  return `data-original-id="${duplicateEsc(originalId)}" data-candidate-id="${duplicateEsc(candidateId)}"`;
}

function loadDuplicateSelection() {
  try {
    const saved = JSON.parse(localStorage.getItem(DUPLICATE_SELECTION_KEY) || '[]');
    duplicateUi.selection = new Set(Array.isArray(saved) ? saved.filter(item => typeof item === 'string') : []);
  } catch {
    duplicateUi.selection = new Set();
  }
}

function saveDuplicateSelection() {
  try { localStorage.setItem(DUPLICATE_SELECTION_KEY, JSON.stringify([...duplicateUi.selection])); }
  catch { /* Auswahl gilt dann nur bis zum Neuladen */ }
}

function duplicatePendingByKey(key) {
  return duplicateUi.data.pending.find(item => duplicatePairKey(item) === key) || null;
}

function selectedDuplicateItems() {
  return [...duplicateUi.selection].map(duplicatePendingByKey).filter(Boolean);
}

// Ein Kandidat kann nur einmal verschoben werden: pro Kandidat höchstens ein ausgewähltes Paar.
function setDuplicateSelected(item, selected) {
  const key = duplicatePairKey(item);
  const { candidateId } = duplicatePairIds(item);
  if (selected) {
    for (const selectedKey of [...duplicateUi.selection]) {
      const other = duplicatePendingByKey(selectedKey);
      if (other && duplicatePairIds(other).candidateId === candidateId) duplicateUi.selection.delete(selectedKey);
    }
    duplicateUi.selection.add(key);
  } else {
    duplicateUi.selection.delete(key);
  }
  saveDuplicateSelection();
}

function pruneDuplicateSelection() {
  const pending = new Set(duplicateUi.data.pending.map(duplicatePairKey));
  duplicateUi.selection = new Set([...duplicateUi.selection].filter(key => pending.has(key)));
  saveDuplicateSelection();
}

// ─── Karten ──────────────────────────────────────────────────────────────

// Bei mehreren Original-Ordnern zeigt das Etikett, aus welchem (A1, A2 …) der Treffer stammt.
function duplicateSideLabel(side, article = null) {
  if (side !== 'blog') return 'B · KANDIDAT';
  const multiple = (duplicateUi.data.scan?.originalFolders?.length || 0) > 1;
  return multiple && article?.rootIndex ? `A${article.rootIndex} · ORIGINAL` : 'A · ORIGINAL';
}

function duplicateArticlePath(article) {
  const multiple = article?.side === 'A' && (duplicateUi.data.scan?.originalFolders?.length || 0) > 1;
  return multiple ? `${article.rootName}/${article.relPath}` : article?.relPath || '';
}

function duplicateFileNote(article) {
  const count = article?.companions?.length || 0;
  if (!count) return 'nur .md';
  return `+ ${count} Begleitdatei${count === 1 ? '' : 'en'}`;
}

function duplicateArticleMini(article, side) {
  if (!article) return `<article class="duplicate-side is-missing"><p>Artikel fehlt</p></article>`;
  return `<article class="duplicate-side duplicate-side-${side}">
    <div class="duplicate-side-copy">
      <div class="duplicate-side-kicker"><span class="duplicate-source">${duplicateSideLabel(side, article)}</span><span class="duplicate-infographic-count">${duplicateEsc(duplicateFileNote(article))}</span></div>
      <h3 title="${duplicateEsc(article.title)}">${duplicateEsc(article.title)}</h3>
      <p class="duplicate-meta">${duplicateDate(article.date)} · <span class="duplicate-path" title="${duplicateEsc(duplicateArticlePath(article))}">${duplicateEsc(duplicateArticlePath(article))}</span></p>
      <p class="duplicate-excerpt">${duplicateEsc(article.excerpt || '')}</p>
    </div>
  </article>`;
}

function duplicateActions(item, status, { detail = false } = {}) {
  const attrs = duplicatePairAttrs(item);
  if (status === 'pending') {
    const selected = duplicateUi.selection.has(duplicatePairKey(item));
    return `<div class="duplicate-actions" ${attrs}>
      ${detail ? `<button type="button" class="duplicate-btn${selected ? ' is-selected' : ''}" data-duplicate-action="toggle-selection">${selected ? 'Ausgewählt ✓' : 'Auswählen'}</button>` : ''}
      ${detail ? '' : '<button type="button" class="duplicate-btn" data-duplicate-action="inspect">Prüfen</button>'}
      <button type="button" class="duplicate-btn is-quiet" data-duplicate-action="ignore">Ignorieren</button>
      ${detail ? '<button type="button" class="duplicate-btn is-primary" data-duplicate-action="move">B verschieben</button>' : ''}
    </div>`;
  }
  return `<div class="duplicate-actions" ${attrs}>
    ${detail ? '' : '<button type="button" class="duplicate-btn" data-duplicate-action="inspect">Prüfen</button>'}
    <button type="button" class="duplicate-btn" data-duplicate-action="reset">Erneut prüfen</button>
  </div>`;
}

function duplicateCard(item, status) {
  const key = duplicatePairKey(item);
  const selected = duplicateUi.selection.has(key);
  const score = duplicateScoreText(item);
  const notes = status === 'pending' ? item.reasons || [] : [
    'Bewusst ignoriert',
    item.updatedAt ? `am ${new Date(item.updatedAt).toLocaleDateString('de-DE')}` : '',
  ].filter(Boolean);
  return `<article class="duplicate-card${selected ? ' is-selected' : ''}" ${duplicatePairAttrs(item)}>
    <header class="duplicate-card-head">
      ${status === 'pending' ? `<label class="duplicate-select"><input type="checkbox" data-duplicate-select ${selected ? 'checked' : ''}><span>Auswählen</span></label>` : ''}
      <div class="duplicate-score" ${item.exact ? 'title="Gleiche normalisierte Wortfolge; Absätze und Satzzeichen können abweichen"' : ''}><strong>${duplicateEsc(score || '–')}</strong><span>${item.exact ? 'Wortfolge gleich' : item.method === 'content' ? 'inhaltlich ähnlich' : 'Übereinstimmung'}</span></div>
      <div class="duplicate-reasons">${notes.map(note => `<span>${duplicateEsc(note)}</span>`).join('')}</div>
      ${status === 'pending' ? duplicateActions(item, status) : ''}
    </header>
    <div class="duplicate-pair">
      ${duplicateArticleMini(item.original, 'blog')}
      <div class="duplicate-link-mark" aria-hidden="true">↔</div>
      ${duplicateArticleMini(item.candidate, 'facebook')}
    </div>
    ${status === 'pending' ? '' : duplicateActions(item, status)}
  </article>`;
}

function movedCard(entry) {
  const files = entry.files || [];
  const score = duplicateScoreText(entry);
  return `<article class="duplicate-card moved-card" data-move-id="${duplicateEsc(entry.id)}">
    <header class="duplicate-card-head">
      <div class="duplicate-score"><strong>${duplicateEsc(score || '✓')}</strong><span>verschoben</span></div>
      <div class="duplicate-reasons"><span>am ${duplicateEsc(new Date(entry.movedAt).toLocaleString('de-DE'))}</span><span>${files.length} Datei${files.length === 1 ? '' : 'en'}</span></div>
      <div class="duplicate-actions"><button type="button" class="duplicate-btn" data-duplicate-action="undo">Rückgängig</button></div>
    </header>
    <div class="moved-body">
      <p><span class="duplicate-source">B · KANDIDAT</span> <strong>${duplicateEsc(entry.candidate?.title)}</strong> <span class="duplicate-meta">${duplicateDate(entry.candidate?.date)}</span></p>
      <p class="duplicate-meta">Original: ${duplicateEsc(entry.original?.title)} · ${duplicateEsc(entry.original?.relPath)}</p>
      <details class="moved-files"><summary>Dateien</summary><ul>${files.map(item => `<li><span>${duplicateEsc(item.from)}</span><span aria-hidden="true">→</span><span>${duplicateEsc(item.to)}</span></li>`).join('')}</ul></details>
    </div>
  </article>`;
}

// ─── Liste ───────────────────────────────────────────────────────────────

function duplicateSearchTerms() {
  return duplicateUi.filters.query.toLocaleLowerCase('de-DE').split(/\s+/).filter(Boolean);
}

// Suche gilt in allen Tabs: jedes Suchwort muss in Titel, Pfad, Ordnername oder Textanfang
// einer der beiden Seiten vorkommen (bei „Verschoben“ in den protokollierten Angaben).
function duplicateMatchesSearch(item) {
  const terms = duplicateSearchTerms();
  if (!terms.length) return true;
  const fields = [item.original, item.candidate].flatMap(article => [
    article?.title, article?.relPath, article?.rootName, article?.excerpt,
  ]);
  if (item.files) fields.push(...item.files.flatMap(file => [file.from, file.to]));
  const haystack = fields.filter(Boolean).join('\n').toLocaleLowerCase('de-DE');
  return terms.every(term => haystack.includes(term));
}

function duplicateMatchesFilters(item) {
  const minimum = duplicateUi.filters.score;
  if (minimum === '100' && !item.exact) return false;
  if (minimum !== 'all' && minimum !== '100' && Number(item.score) * 100 < Number(minimum)) return false;
  if (duplicateUi.filters.method !== 'all' && (item.method || 'text') !== duplicateUi.filters.method) return false;
  return duplicateMatchesSearch(item);
}

function duplicateVisibleItems(tab) {
  const items = duplicateUi.data[tab] || [];
  return items.filter(tab === 'moved' ? duplicateMatchesSearch : duplicateMatchesFilters);
}

function duplicateEmpty(tab, filtered = false) {
  if (!duplicateUi.data.scan) {
    return `<div class="duplicate-empty"><div><span>⌕</span><h3>Noch kein Scan</h3><p>Ordner A und B wählen und „Speichern &amp; scannen“ klicken.</p></div></div>`;
  }
  const text = filtered ? ['Keine Treffer für diese Filter', 'Filter lockern, um weitere Treffer zu sehen.']
    : {
      pending: ['Keine offenen Dubletten', 'Für die aktuellen Ordner gibt es keine ungeprüften Treffer.'],
      ignored: ['Nichts ignoriert', 'Ignorierte Treffer erscheinen hier, solange sich keiner der Texte ändert.'],
      moved: ['Noch nichts verschoben', 'Verschobene Dubletten werden hier protokolliert und können zurückgelegt werden.'],
    }[tab];
  return `<div class="duplicate-empty"><div><span>✓</span><h3>${text[0]}</h3><p>${text[1]}</p></div></div>`;
}

// Bei aktiver Suche zeigen die Tabs „Treffer / gesamt“, damit man sieht, wo etwas gefunden wurde.
function updateDuplicateCounts() {
  const searching = duplicateSearchTerms().length > 0;
  for (const tab of ['pending', 'ignored', 'moved']) {
    const element = document.querySelector(`[data-duplicate-count="${tab}"]`);
    if (!element) continue;
    const total = duplicateUi.data[tab]?.length || 0;
    element.textContent = searching ? `${(duplicateUi.data[tab] || []).filter(duplicateMatchesSearch).length} / ${total}` : String(total);
  }
}

function updateDuplicateTools() {
  const pending = duplicateUi.tab === 'pending';
  const moved = duplicateUi.tab === 'moved';
  duplicateTools.hidden = !duplicateUi.data.scan && !duplicateUi.data.moved?.length;
  duplicateTools.dataset.tab = duplicateUi.tab;
  for (const filter of duplicateTools.querySelectorAll('.duplicate-pending-filter')) filter.hidden = moved;
  document.getElementById('duplicate-selection-tools').hidden = !pending;
  const selected = selectedDuplicateItems().length;
  duplicateSelectionCount.textContent = `${selected} ausgewählt`;
  duplicateSelectNone.disabled = duplicateUi.busy || !selected;
  duplicateSelectAll.disabled = duplicateUi.busy || !duplicateVisibleItems('pending').length;
  duplicateBatchMove.disabled = duplicateUi.busy || !selected || !duplicateUi.data.config?.target;
  duplicateBatchMove.title = duplicateUi.data.config?.target ? '' : 'Zuerst einen Ziel-Ordner wählen';
  scanButton.disabled = duplicateUi.busy;
}

function renderDuplicateList() {
  const tab = duplicateUi.tab;
  const items = duplicateVisibleItems(tab);
  const filtered = items.length !== (duplicateUi.data[tab]?.length || 0);
  updateDuplicateCounts();
  duplicateContent.innerHTML = items.length
    ? `<div class="duplicate-stack">${items.map(item => tab === 'moved' ? movedCard(item) : duplicateCard(item, tab)).join('')}</div>`
    : duplicateEmpty(tab, filtered);
  for (const button of document.querySelectorAll('[data-duplicate-tab]')) {
    button.setAttribute('aria-selected', String(button.dataset.duplicateTab === tab));
  }
  updateDuplicateTools();
}

// ─── Vergleichsansicht ───────────────────────────────────────────────────

function duplicateImageNames(article) {
  return (article?.companions || []).filter(name => IMAGE_EXTENSIONS.has(name.split('.').pop().toLowerCase()));
}

function duplicateImageUrl(article, name) {
  return `/api/file?id=${encodeURIComponent(article.id)}&name=${encodeURIComponent(name)}`;
}

function duplicateCompanionGallery(article, side) {
  const companions = article.companions || [];
  const images = duplicateImageNames(article);
  const others = companions.filter(name => !images.includes(name));
  const label = companions.length ? `${companions.length} Begleitdatei${companions.length === 1 ? '' : 'en'}` : 'Keine Begleitdateien';
  if (!companions.length) {
    return `<div class="duplicate-infographic-gallery"><span class="duplicate-infographic-empty">${label}</span></div>`;
  }
  return `<details class="duplicate-infographic-gallery">
    <summary class="duplicate-infographic-heading"><strong>Begleitdateien</strong><span>${label}</span></summary>
    <div class="duplicate-infographic-thumbs">
      ${images.map((name, index) => `<button type="button" class="duplicate-infographic-thumb" data-duplicate-action="view-image" data-side="${side}" data-index="${index}" title="${duplicateEsc(name)}"><img src="${duplicateImageUrl(article, name)}" alt="" loading="lazy"><span>${index + 1}</span></button>`).join('')}
      ${others.map(name => `<span class="companion-file" title="${duplicateEsc(name)}">${duplicateEsc(name)}</span>`).join('')}
    </div>
  </details>`;
}

function duplicateDiffLine(row) {
  const sign = row.kind === 'removed' ? '−' : row.kind === 'added' ? '+' : ' ';
  return `<div class="duplicate-diff-line is-${row.kind}">
    <span class="duplicate-diff-number" title="Abschnitt in B">${row.facebookNumber ?? ''}</span>
    <span class="duplicate-diff-number" title="Abschnitt in A">${row.blogNumber ?? ''}</span>
    <span class="duplicate-diff-sign" aria-hidden="true">${sign}</span>
    <span class="duplicate-diff-text">${row.html}</span>
  </div>`;
}

function duplicateComparisonRows(pair) {
  const rows = duplicateTextDiff.renderUnifiedRows(
    duplicateTextDiff.renderedBlocksFromHtml(pair.original.bodyHtml),
    duplicateTextDiff.renderedBlocksFromHtml(pair.candidate.bodyHtml), {
      onlyDifferences: duplicateUi.onlyDifferences,
    });
  if (!rows.length) return '<div class="duplicate-comparison-message">Keine Artikeltexte vorhanden.</div>';
  return rows.map(row => {
    if (row.kind === 'identical') return `<div class="duplicate-comparison-message is-identical">${duplicateEsc(row.text)}</div>`;
    if (row.kind === 'fold') {
      return `<details class="duplicate-diff-fold">
        <summary><span class="duplicate-diff-fold-arrow" aria-hidden="true">▸</span><strong>${row.count} unveränderte${row.count === 1 ? 'r Abschnitt' : ' Abschnitte'}</strong><span class="duplicate-diff-fold-label">Aufklappen</span><span class="duplicate-diff-fold-label is-open">Zuklappen</span></summary>
        <div class="duplicate-diff-fold-lines">${row.lines.map(duplicateDiffLine).join('')}</div>
      </details>`;
    }
    return duplicateDiffLine(row);
  }).join('');
}

function duplicateMoveNote(pair) {
  const names = [pair.candidate.relPath.split(/[\\/]/).pop(), ...(pair.candidate.companions || [])];
  if (!pair.target) return '<aside class="duplicate-migration-note">Kein Ziel-Ordner gewählt – Verschieben ist erst danach möglich.</aside>';
  return `<details class="duplicate-migration-note">
    <summary>${names.length} Datei${names.length === 1 ? ' wird' : 'en werden'} nach „${duplicateEsc(pair.target)}“ verschoben</summary>
    <ul>${names.map(name => `<li>${duplicateEsc(name)}</li>`).join('')}</ul>
  </details>`;
}

function renderDuplicateDetail(pair) {
  duplicateUi.detail = pair;
  const status = pair.status || 'pending';
  duplicateDetailContent.innerHTML = `<div class="duplicate-detail" data-mobile-side="${duplicateUi.mobileSide}">
    <div class="duplicate-detail-nav">
      <button type="button" class="duplicate-back" data-duplicate-action="back">← Zur Trefferliste</button>
      ${pair.score != null ? `<span class="duplicate-detail-score">${duplicateEsc(duplicateScoreText(pair))} ${pair.method === 'content' ? 'inhaltlich ähnlich' : 'Übereinstimmung'}</span>` : ''}
      <button type="button" class="duplicate-diff-toggle" data-duplicate-action="toggle-differences" aria-pressed="${duplicateUi.onlyDifferences}" title="Unveränderte Textabschnitte bis auf je einen Kontextabschnitt einklappen">Nur Unterschiede</button>
      <div class="duplicate-detail-switch" role="tablist" aria-label="Artikelkopf">
        <button type="button" role="tab" data-duplicate-action="mobile-side" data-side="blog" aria-selected="${duplicateUi.mobileSide === 'blog'}">A</button>
        <button type="button" role="tab" data-duplicate-action="mobile-side" data-side="facebook" aria-selected="${duplicateUi.mobileSide === 'facebook'}">B</button>
      </div>
    </div>
    <div class="duplicate-detail-header-grid">
      <article data-duplicate-side="blog"><span class="duplicate-source">${duplicateSideLabel('blog', pair.original)}</span><h3 title="${duplicateEsc(pair.original.title)}">${duplicateEsc(pair.original.title)}</h3><p class="duplicate-meta">${duplicateDate(pair.original.date)} · ${duplicateEsc(duplicateArticlePath(pair.original))}</p>${duplicateCompanionGallery(pair.original, 'blog')}</article>
      <article data-duplicate-side="facebook"><span class="duplicate-source">B · KANDIDAT</span><h3 title="${duplicateEsc(pair.candidate.title)}">${duplicateEsc(pair.candidate.title)}</h3><p class="duplicate-meta">${duplicateDate(pair.candidate.date)} · ${duplicateEsc(pair.candidate.relPath)}</p>${duplicateCompanionGallery(pair.candidate, 'facebook')}</article>
    </div>
    <div class="duplicate-comparison-scroll" tabindex="0" aria-label="Änderungen zwischen B und A">
      <div class="duplicate-diff-legend"><span class="is-removed">− Nur B (Kandidat)</span><span class="is-added">+ Nur A (Original)</span><small>Abschnitte: B · A</small></div>
      <div class="duplicate-comparison-rows">${duplicateComparisonRows(pair)}</div>
    </div>
    ${status === 'pending' ? duplicateMoveNote(pair) : ''}
    ${duplicateActions(pair, status, { detail: true })}
  </div>`;
  if (!duplicateDetailDialog.open) duplicateDetailDialog.showModal();
}

function toggleDuplicateDiffMode() {
  duplicateUi.onlyDifferences = !duplicateUi.onlyDifferences;
  const pair = duplicateUi.detail;
  if (!pair) return;
  duplicateDetailContent.querySelector('.duplicate-diff-toggle').setAttribute('aria-pressed', String(duplicateUi.onlyDifferences));
  duplicateDetailContent.querySelector('.duplicate-comparison-rows').innerHTML = duplicateComparisonRows(pair);
  duplicateDetailContent.querySelector('.duplicate-comparison-scroll').scrollTop = 0;
}

function closeDuplicateDetail() {
  if (duplicateDetailDialog.open) duplicateDetailDialog.close();
}

// ─── Bildbetrachter ──────────────────────────────────────────────────────

function renderDuplicateImageViewer() {
  const item = duplicateUi.viewerItems[duplicateUi.viewerIndex];
  if (!item) return;
  duplicateImageViewerImage.src = item.url;
  duplicateImageViewerImage.alt = item.name;
  duplicateImageViewerSide.textContent = duplicateSideLabel(item.side, item.article);
  duplicateImageViewerTitle.textContent = item.name;
  duplicateImageViewerCounter.textContent = `${duplicateUi.viewerIndex + 1} / ${duplicateUi.viewerItems.length}`;
  duplicateImageViewerPrev.disabled = duplicateUi.viewerIndex === 0;
  duplicateImageViewerNext.disabled = duplicateUi.viewerIndex >= duplicateUi.viewerItems.length - 1;
}

function openDuplicateImageViewer(side, sideIndex) {
  const pair = duplicateUi.detail;
  if (!pair) return;
  const entries = [['blog', pair.original], ['facebook', pair.candidate]];
  duplicateUi.viewerItems = entries.flatMap(([itemSide, article]) => duplicateImageNames(article)
    .map(name => ({ side: itemSide, article, name, url: duplicateImageUrl(article, name) })));
  const offset = side === 'facebook' ? duplicateImageNames(pair.original).length : 0;
  duplicateUi.viewerIndex = offset + sideIndex;
  renderDuplicateImageViewer();
  duplicateImageViewer.showModal();
}

function stepDuplicateImageViewer(offset) {
  const next = duplicateUi.viewerIndex + offset;
  if (next < 0 || next >= duplicateUi.viewerItems.length) return;
  duplicateUi.viewerIndex = next;
  renderDuplicateImageViewer();
}

// ─── Server-Aktionen ─────────────────────────────────────────────────────

function describeScan(scan) {
  if (!scan) return 'Noch nicht gescannt.';
  const when = new Date(scan.scannedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const folders = scan.originalFolders?.length || 1;
  const text = `${scan.originals} Originale in ${folders === 1 ? 'A' : `${folders} Ordnern`} · ${scan.candidates} Kandidaten in B · Scan um ${when} (${(scan.durationMs / 1000).toFixed(1).replace('.', ',')} s)`;
  return scan.stale ? `${text} – Einstellungen geändert, bitte neu scannen.` : text;
}

// ─── Original-Ordner (beliebig viele Zeilen) ─────────────────────────────

const originalsList = document.getElementById('originals-list');

function originalInputs() {
  return [...originalsList.querySelectorAll('input[name="original"]')];
}

function renumberOriginals() {
  const rows = [...originalsList.querySelectorAll('.setup-field')];
  rows.forEach((row, index) => {
    row.querySelector('.side-badge').textContent = rows.length > 1 ? `A${index + 1}` : 'A';
    row.querySelector('[data-remove-original]').hidden = rows.length === 1;
  });
}

function addOriginalRow(value = '', { focus = false } = {}) {
  const row = document.createElement('label');
  row.className = 'setup-field';
  row.innerHTML = `<span class="setup-caption"><b class="side-badge side-a">A</b> Original</span>
    <span class="setup-input"><input type="text" name="original" spellcheck="false" placeholder="Ordner mit Originalen"><button type="button" class="duplicate-btn" data-browse="original">Durchsuchen …</button><button type="button" class="duplicate-btn is-quiet" data-remove-original aria-label="Original-Ordner entfernen" title="Entfernen">✕</button></span>`;
  row.querySelector('input').value = value;
  originalsList.append(row);
  renumberOriginals();
  if (focus) row.querySelector('input').focus();
}

document.getElementById('add-original').addEventListener('click', () => addOriginalRow('', { focus: true }));

originalsList.addEventListener('click', event => {
  const remove = event.target.closest('[data-remove-original]');
  if (!remove) return;
  event.preventDefault();
  remove.closest('.setup-field').remove();
  renumberOriginals();
});

// Ältere Server liefern nur „folderA“; dann wenigstens diesen einen Ordner zeigen.
function configOriginals(config) {
  if (Array.isArray(config.originals)) return config.originals;
  return config.folderA ? [config.folderA] : [];
}

// ─── Server-Stand ────────────────────────────────────────────────────────
// Server-Code wird erst beim Neustart geladen, die Oberfläche bei jedem Neuladen der Seite.
// Ein älterer Server würde neue Einstellungen stillschweigend verwerfen.
const EXPECTED_API_VERSION = 4;
const SERVER_OUTDATED_MESSAGE = 'Der laufende Server ist älter als diese Oberfläche und würde Einstellungen verwerfen – bitte den Server neu starten (npm start).';

function serverOutdated() {
  return (Number(duplicateUi.apiVersion) || 0) < EXPECTED_API_VERSION;
}

function updateServerWarning() {
  document.getElementById('server-warning').hidden = !serverOutdated();
}

// ─── Zuletzt verwendete Ordner (B und Ziel) ──────────────────────────────

const recentInputs = [...setupForm.querySelectorAll('input[data-recent]')];

function recentMenuOf(input) {
  return document.getElementById(input.getAttribute('aria-controls'));
}

function recentEntries(input) {
  const list = duplicateUi.recent?.[input.dataset.recent] || [];
  const typed = input.value.trim().toLocaleLowerCase('de-DE');
  // Solange das Feld einen Eintrag der Liste enthält, alle zeigen; sonst nach Eingabe filtern.
  if (!typed || list.some(item => item.toLocaleLowerCase('de-DE') === typed)) return list;
  return list.filter(item => item.toLocaleLowerCase('de-DE').includes(typed));
}

function closeRecentMenu(input) {
  const menu = recentMenuOf(input);
  menu.hidden = true;
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}

function openRecentMenu(input) {
  const menu = recentMenuOf(input);
  const entries = recentEntries(input);
  if (!entries.length) return closeRecentMenu(input);
  const current = input.value.trim().toLocaleLowerCase('de-DE');
  menu.innerHTML = `<span class="recent-caption">Zuletzt verwendet</span>${entries.map((item, index) => `<button type="button" role="option" id="${menu.id}-${index}" class="recent-option" data-recent-value="${duplicateEsc(item)}" aria-selected="${item.toLocaleLowerCase('de-DE') === current}" tabindex="-1" title="${duplicateEsc(item)}">${duplicateEsc(item)}</button>`).join('')}`;
  menu.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function moveRecentFocus(input, direction) {
  const menu = recentMenuOf(input);
  if (menu.hidden) openRecentMenu(input);
  const options = [...menu.querySelectorAll('.recent-option')];
  if (!options.length) return;
  const active = options.findIndex(option => option.classList.contains('is-active'));
  const next = active < 0 ? (direction > 0 ? 0 : options.length - 1) : (active + direction + options.length) % options.length;
  options.forEach((option, index) => option.classList.toggle('is-active', index === next));
  options[next].scrollIntoView({ block: 'nearest' });
  input.setAttribute('aria-activedescendant', options[next].id);
}

function chooseRecent(input, value) {
  input.value = value;
  closeRecentMenu(input);
  input.focus();
}

for (const input of recentInputs) {
  const menu = recentMenuOf(input);
  input.addEventListener('focus', () => openRecentMenu(input));
  input.addEventListener('click', () => openRecentMenu(input));
  input.addEventListener('input', () => openRecentMenu(input));
  input.addEventListener('blur', () => setTimeout(() => closeRecentMenu(input), 120));
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveRecentFocus(input, event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter' && !menu.hidden) {
      const active = menu.querySelector('.recent-option.is-active');
      if (!active) return;
      event.preventDefault();
      chooseRecent(input, active.dataset.recentValue);
    } else if (event.key === 'Escape' && !menu.hidden) {
      event.preventDefault();
      closeRecentMenu(input);
    }
  });
  // mousedown statt click, damit das Feld den Fokus nicht vorher verliert.
  menu.addEventListener('mousedown', event => {
    const option = event.target.closest('.recent-option');
    event.preventDefault();
    if (option) chooseRecent(input, option.dataset.recentValue);
  });
}

function fillSetup(config, defaults) {
  duplicateUi.recent = { recentFolderB: config.recentFolderB || [], recentTargets: config.recentTargets || [] };
  originalsList.replaceChildren();
  const originals = configOriginals(config);
  for (const folder of originals.length ? originals : ['']) addOriginalRow(folder);
  for (const name of ['folderB', 'target']) setupForm.elements[name].value = config[name] || '';
  setupForm.elements.minimumTokens.value = config.minimumTokens ?? defaults?.minimumTokens ?? '';
  setupForm.elements.maxDateDistanceDays.value = config.maxDateDistanceDays ?? defaults?.maxDateDistanceDays ?? '';
  setupForm.elements.minContentSimilarity.value = config.minContentSimilarity ?? defaults?.minContentSimilarity ?? '';
}

async function loadDuplicates({ quiet = false } = {}) {
  if (!quiet) duplicateStatus.textContent = 'Treffer werden geladen …';
  const data = await duplicateRequest('/api/duplicates');
  duplicateUi.data = data;
  pruneDuplicateSelection();
  updateDuplicateCounts();
  scanInfo.textContent = describeScan(data.scan);
  if (!quiet) duplicateStatus.textContent = '';
  renderDuplicateList();
}

async function saveAndScan() {
  if (duplicateUi.busy) return;
  duplicateUi.busy = true;
  updateDuplicateTools();
  scanInfo.textContent = 'Einstellungen werden gespeichert …';
  try {
    if (serverOutdated()) throw new Error(SERVER_OUTDATED_MESSAGE);
    const form = setupForm.elements;
    const originals = originalInputs().map(input => input.value.trim()).filter(Boolean);
    await duplicateRequest('/api/config', {
      method: 'PUT',
      body: JSON.stringify({
        originals,
        folderB: form.folderB.value,
        target: form.target.value,
        minimumTokens: form.minimumTokens.value,
        maxDateDistanceDays: form.maxDateDistanceDays.value,
        minContentSimilarity: form.minContentSimilarity.value,
      }),
    }).then(result => fillSetup(result.config));
    scanInfo.textContent = 'Ordner werden gescannt …';
    duplicateContent.innerHTML = '<div class="duplicate-loading"><span class="spinner"></span></div>';
    await duplicateRequest('/api/scan', { method: 'POST' });
    await loadDuplicates({ quiet: true });
    duplicateStatus.textContent = `${duplicateUi.data.pending.length} offene Treffer gefunden.`;
  } catch (error) {
    // Erst die Liste neu laden, dann die Fehlermeldung setzen, damit sie sichtbar bleibt.
    await loadDuplicates({ quiet: true }).catch(() => {});
    scanInfo.textContent = `Fehler: ${error.message}`;
  } finally {
    duplicateUi.busy = false;
    updateDuplicateTools();
  }
}

async function inspectDuplicate(originalId, candidateId) {
  duplicateStatus.textContent = 'Artikelvergleich wird geladen …';
  const pair = await duplicateRequest(`/api/duplicates/compare?originalId=${encodeURIComponent(originalId)}&candidateId=${encodeURIComponent(candidateId)}`);
  duplicateStatus.textContent = 'Abweichende Wörter sind markiert.';
  duplicateUi.mobileSide = 'blog';
  renderDuplicateDetail(pair);
}

async function mutateDuplicate(action, originalId, candidateId) {
  if (duplicateUi.busy) return;
  duplicateUi.busy = true;
  updateDuplicateTools();
  duplicateStatus.textContent = 'Änderung wird gespeichert …';
  try {
    await duplicateRequest('/api/duplicates', {
      method: 'POST',
      body: JSON.stringify({ action, originalId, candidateId }),
    });
    closeDuplicateDetail();
    await loadDuplicates({ quiet: true });
    duplicateStatus.textContent = action === 'ignore' ? 'Treffer ignoriert.' : 'Treffer ist wieder offen.';
  } finally {
    duplicateUi.busy = false;
    updateDuplicateTools();
  }
}

async function moveDuplicates(items) {
  if (duplicateUi.busy || !items.length) return;
  const target = duplicateUi.data.config?.target;
  if (!target) {
    duplicateStatus.textContent = 'Bitte zuerst einen Ziel-Ordner wählen und speichern.';
    return;
  }
  const message = items.length === 1
    ? `Die Datei aus B samt Begleitdateien nach „${target}“ verschieben?`
    : `${items.length} Dateien aus B samt Begleitdateien nach „${target}“ verschieben?`;
  if (!window.confirm(message)) return;
  duplicateUi.busy = true;
  updateDuplicateTools();
  duplicateStatus.textContent = `${items.length} Datei${items.length === 1 ? ' wird' : 'en werden'} verschoben …`;
  try {
    const result = await duplicateRequest('/api/move', {
      method: 'POST',
      body: JSON.stringify({ items: items.map(duplicatePairIds) }),
    });
    closeDuplicateDetail();
    const failed = new Set((result.failed || []).map(duplicatePairKey));
    duplicateUi.selection = new Set([...duplicateUi.selection].filter(key => failed.has(key)));
    saveDuplicateSelection();
    await loadDuplicates({ quiet: true });
    duplicateStatus.textContent = result.failed?.length
      ? `${result.moved.length} verschoben, ${result.failed.length} fehlgeschlagen: ${result.failed[0].error}`
      : `${result.moved.length} Dublette${result.moved.length === 1 ? '' : 'n'} verschoben.`;
  } finally {
    duplicateUi.busy = false;
    updateDuplicateTools();
  }
}

async function undoMove(id) {
  if (duplicateUi.busy) return;
  if (!window.confirm('Die Dateien an ihren ursprünglichen Ort zurücklegen?')) return;
  duplicateUi.busy = true;
  updateDuplicateTools();
  duplicateStatus.textContent = 'Dateien werden zurückgelegt und neu gescannt …';
  try {
    await duplicateRequest(`/api/moves/${encodeURIComponent(id)}/undo`, { method: 'POST' });
    await loadDuplicates({ quiet: true });
    duplicateStatus.textContent = 'Verschiebung rückgängig gemacht.';
  } finally {
    duplicateUi.busy = false;
    updateDuplicateTools();
  }
}

function reportError(error) {
  duplicateStatus.textContent = `Fehler: ${error.message}`;
}

// ─── Ordner-Browser ──────────────────────────────────────────────────────

const folderPicker = { input: null, path: '', parent: null };

async function openFolder(dir) {
  folderInfo.textContent = 'Wird geladen …';
  try {
    const data = await duplicateRequest(`/api/fs?path=${encodeURIComponent(dir || '')}`);
    folderPicker.path = data.path;
    folderPicker.parent = data.parent;
    folderPathInput.value = data.path;
    folderUp.disabled = !data.parent;
    folderRoots.innerHTML = data.roots.map(root => `<button type="button" class="duplicate-btn" data-folder-open="${duplicateEsc(root)}">${duplicateEsc(root)}</button>`).join('');
    folderList.innerHTML = data.path
      ? (data.dirs.length
        ? data.dirs.map(name => `<li><button type="button" data-folder-child="${duplicateEsc(name)}">📁 ${duplicateEsc(name)}</button></li>`).join('')
        : '<li class="folder-empty">Keine Unterordner</li>')
      : '<li class="folder-empty">Laufwerk wählen</li>';
    folderInfo.textContent = data.path ? `${data.mdCount} .md-Datei${data.mdCount === 1 ? '' : 'en'} direkt in diesem Ordner` : '';
    if (dir && data.path && dir.replace(/[\\/]+$/, '').toLowerCase() !== data.path.replace(/[\\/]+$/, '').toLowerCase()) {
      folderInfo.textContent = 'Ordner existiert noch nicht – nächster vorhandener Elternordner geöffnet.';
    }
  } catch (error) {
    folderInfo.textContent = error.message;
  }
}

function joinFolder(parent, child) {
  const separator = parent.includes('\\') ? '\\' : '/';
  return parent.endsWith(separator) ? parent + child : parent + separator + child;
}

function openFolderPicker(button) {
  const input = button.closest('.setup-input').querySelector('input');
  folderPicker.input = input;
  const badge = button.closest('.setup-field').querySelector('.side-badge')?.textContent;
  const labels = { original: `Ordner ${badge} (Original) wählen`, folderB: 'Ordner B (Kandidaten) wählen', target: 'Ziel-Ordner wählen' };
  document.getElementById('folder-dialog-title').textContent = labels[button.dataset.browse];
  folderDialog.showModal();
  openFolder(input.value.trim());
}

// ─── Ereignisse ──────────────────────────────────────────────────────────

setupForm.addEventListener('submit', event => {
  event.preventDefault();
  saveAndScan();
});

setupForm.addEventListener('click', event => {
  const button = event.target.closest('[data-browse]');
  if (!button) return;
  event.preventDefault();
  openFolderPicker(button);
});

folderDialog.addEventListener('click', event => {
  const open = event.target.closest('[data-folder-open]');
  const child = event.target.closest('[data-folder-child]');
  const action = event.target.closest('[data-folder-action]')?.dataset.folderAction;
  if (open) openFolder(open.dataset.folderOpen);
  else if (child) openFolder(joinFolder(folderPicker.path, child.dataset.folderChild));
  else if (action === 'up' && folderPicker.parent) openFolder(folderPicker.parent);
  else if (action === 'go') openFolder(folderPathInput.value.trim());
  else if (action === 'close') folderDialog.close();
  else if (action === 'choose' && folderPicker.path) {
    folderPicker.input.value = folderPicker.path;
    folderDialog.close();
  }
});

folderPathInput.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  openFolder(folderPathInput.value.trim());
});

document.getElementById('duplicate-tabs').addEventListener('click', event => {
  const button = event.target.closest('[data-duplicate-tab]');
  if (!button) return;
  duplicateUi.tab = button.dataset.duplicateTab;
  renderDuplicateList();
  window.scrollTo({ top: 0 });
});

duplicateScoreFilter.addEventListener('change', () => {
  duplicateUi.filters.score = duplicateScoreFilter.value;
  renderDuplicateList();
});

document.getElementById('duplicate-method-filter').addEventListener('change', event => {
  duplicateUi.filters.method = event.target.value;
  renderDuplicateList();
});

duplicateSearch.addEventListener('input', () => {
  duplicateUi.filters.query = duplicateSearch.value;
  renderDuplicateList();
});

duplicateSelectAll.addEventListener('click', () => {
  for (const item of duplicateVisibleItems('pending')) {
    const candidateTaken = [...duplicateUi.selection].some(key => {
      const other = duplicatePendingByKey(key);
      return other && duplicatePairIds(other).candidateId === duplicatePairIds(item).candidateId;
    });
    if (!candidateTaken) duplicateUi.selection.add(duplicatePairKey(item));
  }
  saveDuplicateSelection();
  renderDuplicateList();
});

duplicateSelectNone.addEventListener('click', () => {
  duplicateUi.selection.clear();
  saveDuplicateSelection();
  renderDuplicateList();
});

duplicateBatchMove.addEventListener('click', () => {
  moveDuplicates(selectedDuplicateItems()).catch(reportError);
});

function pairFromElement(element) {
  const holder = element.closest('[data-original-id]');
  return holder ? { originalId: holder.dataset.originalId, candidateId: holder.dataset.candidateId } : null;
}

duplicateContent.addEventListener('change', event => {
  if (!event.target.matches('[data-duplicate-select]')) return;
  const ids = pairFromElement(event.target);
  if (!ids) return;
  setDuplicateSelected(ids, event.target.checked);
  renderDuplicateList();
});

duplicateContent.addEventListener('click', event => {
  const button = event.target.closest('[data-duplicate-action]');
  if (!button) return;
  const action = button.dataset.duplicateAction;
  if (action === 'undo') {
    undoMove(button.closest('[data-move-id]').dataset.moveId).catch(reportError);
    return;
  }
  const ids = pairFromElement(button);
  if (!ids) return;
  if (action === 'inspect') inspectDuplicate(ids.originalId, ids.candidateId).catch(reportError);
  else mutateDuplicate(action, ids.originalId, ids.candidateId).catch(reportError);
});

duplicateDetailContent.addEventListener('click', event => {
  const button = event.target.closest('[data-duplicate-action]');
  if (!button) return;
  const action = button.dataset.duplicateAction;
  const pair = duplicateUi.detail;
  if (action === 'back') return closeDuplicateDetail();
  if (action === 'toggle-differences') return toggleDuplicateDiffMode();
  if (action === 'mobile-side') {
    duplicateUi.mobileSide = button.dataset.side;
    duplicateDetailContent.querySelector('.duplicate-detail').dataset.mobileSide = duplicateUi.mobileSide;
    for (const tab of duplicateDetailContent.querySelectorAll('[data-duplicate-action="mobile-side"]')) {
      tab.setAttribute('aria-selected', String(tab.dataset.side === duplicateUi.mobileSide));
    }
    return;
  }
  if (action === 'view-image') return openDuplicateImageViewer(button.dataset.side, Number(button.dataset.index));
  if (!pair) return;
  if (action === 'toggle-selection') {
    setDuplicateSelected(pair, !duplicateUi.selection.has(duplicatePairKey(pair)));
    renderDuplicateDetail(pair);
    renderDuplicateList();
    return;
  }
  if (action === 'move') return moveDuplicates([pair]).catch(reportError);
  const ids = duplicatePairIds(pair);
  mutateDuplicate(action, ids.originalId, ids.candidateId).catch(reportError);
});

duplicateDetailDialog.addEventListener('click', event => {
  if (event.target === duplicateDetailDialog) closeDuplicateDetail();
});
duplicateDetailDialog.addEventListener('close', () => { duplicateUi.detail = null; });
duplicateImageViewer.addEventListener('click', event => {
  if (event.target === duplicateImageViewer) duplicateImageViewer.close();
});
duplicateImageViewer.addEventListener('close', () => duplicateImageViewerImage.removeAttribute('src'));
duplicateImageViewer.addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft') stepDuplicateImageViewer(-1);
  if (event.key === 'ArrowRight') stepDuplicateImageViewer(1);
});
document.getElementById('duplicate-image-viewer-close').addEventListener('click', () => duplicateImageViewer.close());
duplicateImageViewerPrev.addEventListener('click', () => stepDuplicateImageViewer(-1));
duplicateImageViewerNext.addEventListener('click', () => stepDuplicateImageViewer(1));

// ─── Start ───────────────────────────────────────────────────────────────

loadDuplicateSelection();
duplicateRequest('/api/config')
  .then(data => fillSetup(data.config, data.defaults))
  .then(() => loadDuplicates())
  .catch(error => {
    scanInfo.textContent = `Fehler: ${error.message}`;
    duplicateContent.innerHTML = duplicateEmpty('pending');
  });
