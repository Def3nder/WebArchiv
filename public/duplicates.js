// Admin-Arbeitsbereich zum Sichten und gebündelten Verknüpfen von Blog-/Quellen-Dubletten.
'use strict';

const DUPLICATE_SELECTION_KEY = 'webarchiv-duplicate-selection-v1';
const DUPLICATE_PAIR_SEPARATOR = '\u001f';

const duplicateUi = {
  data: { pending: [], linked: [], ignored: [] },
  tab: 'pending',
  detail: null,
  busy: false,
  filters: { score: 'all', infographics: 'all', authors: null },
  authorOptionsKey: '',
  selection: new Set(),
  listScrollTop: 0,
  mobileSide: 'blog',
  onlyDifferences: true,
  infographicsOpen: false,
  viewerIndex: 0,
};

const duplicateDialog = document.getElementById('duplicate-review');
const duplicateChrome = document.getElementById('duplicate-chrome');
const duplicateContent = document.getElementById('duplicate-content');
const duplicateDetailDialog = document.getElementById('duplicate-detail-dialog');
const duplicateDetailContent = document.getElementById('duplicate-detail-content');
const duplicateStatus = document.getElementById('duplicate-status');
const duplicateMenuCount = document.getElementById('duplicate-menu-count');
const duplicateTools = document.getElementById('duplicate-tools');
const duplicateSelectionTools = document.getElementById('duplicate-selection-tools');
const duplicateAuthorNative = document.getElementById('duplicate-author-native');
const duplicateScoreNative = document.getElementById('duplicate-score-native');
const duplicateInfographicNative = document.getElementById('duplicate-infographic-native');
const duplicateAuthorFilterLabel = document.getElementById('duplicate-author-filter-label');
const duplicateAuthorOptions = document.getElementById('duplicate-author-options');
const duplicateFilterMenus = [...document.querySelectorAll('[data-duplicate-filter-menu]')];
const duplicateSelectionCount = document.getElementById('duplicate-selection-count');
const duplicateSelectAll = document.getElementById('duplicate-select-all');
const duplicateSelectNone = document.getElementById('duplicate-select-none');
const duplicateBatchLink = document.getElementById('duplicate-batch-link');
const duplicateBatchMigrate = document.getElementById('duplicate-batch-migrate');
const duplicateImageViewer = document.getElementById('duplicate-image-viewer');
const duplicateImageViewerImage = document.getElementById('duplicate-image-viewer-image');
const duplicateImageViewerSide = document.getElementById('duplicate-image-viewer-side');
const duplicateImageViewerTitle = document.getElementById('duplicate-image-viewer-title');
const duplicateImageViewerCounter = document.getElementById('duplicate-image-viewer-counter');
const duplicateImageViewerPrev = document.getElementById('duplicate-image-viewer-prev');
const duplicateImageViewerNext = document.getElementById('duplicate-image-viewer-next');
const duplicateDialogs = [duplicateDialog, duplicateDetailDialog, duplicateImageViewer];

function syncDuplicatePageScroll() {
  document.documentElement.classList.toggle('duplicate-modal-open',
    duplicateDialogs.some(dialog => dialog.open));
}

// Wie die Navigation der Kachelansicht: beim Abwärtsscrollen mitlaufen,
// nach 24 px Aufwärtsbewegung wieder vollständig einblenden.
const DUPLICATE_CHROME_SCROLL_THRESHOLD = 24;
let duplicateChromeOffset = 0;
let duplicateLastScrollTop = 0;
let duplicateChromeDirection = 0;
let duplicateChromeTravel = 0;
let duplicateChromeFrame = 0;
let duplicateChromeScrollPaused = false;

function setDuplicateChromeOffset(offset, returning = false) {
  const height = Math.max(1, duplicateChrome.offsetHeight);
  duplicateChromeOffset = Math.max(0, Math.min(height, offset));
  duplicateChrome.classList.toggle('is-returning', returning);
  duplicateChrome.style.setProperty('--duplicate-chrome-translate', `${-duplicateChromeOffset}px`);
}

function showDuplicateChrome(returning = false) {
  setDuplicateChromeOffset(0, returning && duplicateChromeOffset > 0);
  duplicateChromeDirection = 0;
  duplicateChromeTravel = 0;
}

function updateDuplicateChromeHeight() {
  const previousHeight = parseFloat(duplicateDialog.style.getPropertyValue('--duplicate-chrome-height')) || 0;
  const height = duplicateChrome.offsetHeight;
  if (!height) return;
  duplicateDialog.style.setProperty('--duplicate-chrome-height', `${height}px`);
  if (duplicateChromeOffset > height
      || (previousHeight > 0 && duplicateChromeOffset >= previousHeight - 1)) setDuplicateChromeOffset(height);
}

function updateDuplicateChromeOnScroll() {
  duplicateChromeFrame = 0;
  const current = duplicateContent.scrollTop;
  const delta = current - duplicateLastScrollTop;
  duplicateLastScrollTop = current;
  if (!duplicateDialog.open || duplicateChromeScrollPaused) return;
  if (current <= 8 || duplicateFilterMenus.some(root => !root.querySelector('[role="menu"]').hidden)) {
    showDuplicateChrome(duplicateChromeOffset > 0);
    return;
  }
  if (Math.abs(delta) < 1) return;
  const direction = Math.sign(delta);
  if (direction !== duplicateChromeDirection) {
    duplicateChromeDirection = direction;
    duplicateChromeTravel = 0;
  }
  if (direction > 0) {
    duplicateChromeTravel = 0;
    setDuplicateChromeOffset(duplicateChromeOffset + delta);
    return;
  }
  duplicateChromeTravel += Math.abs(delta);
  if (duplicateChromeTravel >= DUPLICATE_CHROME_SCROLL_THRESHOLD) showDuplicateChrome(true);
}

duplicateContent.addEventListener('scroll', () => {
  if (!duplicateChromeFrame) duplicateChromeFrame = requestAnimationFrame(updateDuplicateChromeOnScroll);
}, { passive: true });
duplicateChrome.addEventListener('focusin', () => showDuplicateChrome(true));
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(updateDuplicateChromeHeight).observe(duplicateChrome);
window.addEventListener('resize', updateDuplicateChromeHeight);

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

function duplicateSourceLabel(article) {
  return String(article?.author || 'Quelle').trim() || 'Quelle';
}

function duplicateSourceAuthors() {
  return Array.isArray(duplicateUi.data.config?.facebookAuthors)
    ? duplicateUi.data.config.facebookAuthors : [];
}

function duplicateRequest(url, options = {}) {
  return apiFetch(url, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers,
  }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  });
}

function duplicatePairIds(item) {
  return {
    blogId: String(item.blog?.id || item.blogId || ''),
    facebookId: String(item.facebook?.id || item.facebookId || ''),
  };
}

function duplicatePairKey(item) {
  const { blogId, facebookId } = duplicatePairIds(item);
  return `${blogId}${DUPLICATE_PAIR_SEPARATOR}${facebookId}`;
}

function duplicatePairAttrs(item) {
  const { blogId, facebookId } = duplicatePairIds(item);
  return `data-blog-id="${duplicateEsc(blogId)}" data-facebook-id="${duplicateEsc(facebookId)}"`;
}

function loadDuplicateSelection() {
  try {
    const saved = JSON.parse(localStorage.getItem(DUPLICATE_SELECTION_KEY) || '[]');
    duplicateUi.selection = new Set(Array.isArray(saved) ? saved.filter(value => typeof value === 'string') : []);
  } catch {
    duplicateUi.selection = new Set();
  }
}

function saveDuplicateSelection() {
  try { localStorage.setItem(DUPLICATE_SELECTION_KEY, JSON.stringify([...duplicateUi.selection])); }
  catch { /* Auswahl funktioniert für diese Sitzung weiter. */ }
}

function duplicateInfographicLabel(article) {
  const count = Number(article?.infographicCount) || 0;
  return `${count} Infografik${count === 1 ? '' : 'en'}`;
}

function duplicateInfographics(article) {
  return Array.isArray(article?.infographics) ? article.infographics : [];
}

function duplicateInfographicGallery(article, side) {
  const items = duplicateInfographics(article);
  const sideLabel = side === 'blog' ? 'Blog' : duplicateEsc(duplicateSourceLabel(article));
  return `<details class="duplicate-infographic-gallery" data-duplicate-infographic-side="${side}" aria-label="${sideLabel}-Infografiken"${duplicateUi.infographicsOpen ? ' open' : ''}>
    <summary class="duplicate-infographic-heading"><strong>Infografiken</strong><span>${duplicateInfographicLabel(article)}</span></summary>
    <div class="duplicate-infographic-thumbs">
      ${items.length ? items.map((item, index) => `<button type="button" class="duplicate-infographic-thumb" data-duplicate-action="open-infographic" data-side="${side}" data-index="${index}" aria-label="${sideLabel}-Infografik ${index + 1} in Vollansicht öffnen">
        <img src="${duplicateEsc(item.imageUrl)}" alt="${sideLabel}-Infografik ${index + 1}" loading="lazy" decoding="async">
        <span>${index + 1}</span>
      </button>`).join('') : '<span class="duplicate-infographic-empty">Keine Infografik vorhanden</span>'}
    </div>
  </details>`;
}

function duplicateViewerItems() {
  if (!duplicateUi.detail) return [];
  return ['blog', 'facebook'].flatMap(side => duplicateInfographics(duplicateUi.detail[side]).map((item, index) => ({
    ...item,
    side,
    sideIndex: index,
    sideCount: duplicateInfographics(duplicateUi.detail[side]).length,
  })));
}

function renderDuplicateImageViewer() {
  const items = duplicateViewerItems();
  if (!items.length) return duplicateImageViewer.close();
  duplicateUi.viewerIndex = Math.max(0, Math.min(duplicateUi.viewerIndex, items.length - 1));
  const item = items[duplicateUi.viewerIndex];
  const sideLabel = item.side === 'blog' ? 'Blog' : duplicateSourceLabel(duplicateUi.detail.facebook);
  duplicateImageViewerImage.src = item.imageUrl;
  duplicateImageViewerImage.alt = `${sideLabel}-Infografik ${item.sideIndex + 1} von ${item.sideCount}`;
  duplicateImageViewerSide.textContent = `${sideLabel.toUpperCase()} · INFOGRAFIK ${item.sideIndex + 1} VON ${item.sideCount}`;
  duplicateImageViewerTitle.textContent = item.title || `${sideLabel}-Infografik`;
  duplicateImageViewerCounter.textContent = `${duplicateUi.viewerIndex + 1} von ${items.length} insgesamt`;
  duplicateImageViewerPrev.disabled = items.length < 2;
  duplicateImageViewerNext.disabled = items.length < 2;
}

function openDuplicateImageViewer(side, sideIndex) {
  const items = duplicateViewerItems();
  const index = items.findIndex(item => item.side === side && item.sideIndex === sideIndex);
  if (index < 0) return;
  duplicateUi.viewerIndex = index;
  renderDuplicateImageViewer();
  if (!duplicateImageViewer.open) duplicateImageViewer.showModal();
  syncDuplicatePageScroll();
}

function stepDuplicateImageViewer(offset) {
  const items = duplicateViewerItems();
  if (items.length < 2) return;
  duplicateUi.viewerIndex = (duplicateUi.viewerIndex + offset + items.length) % items.length;
  renderDuplicateImageViewer();
}

function duplicateArticleMini(article, side) {
  if (!article) return `<article class="duplicate-side is-missing"><p>Artikel fehlt</p></article>`;
  return `<article class="duplicate-side duplicate-side-${side}">
    <div class="duplicate-side-copy">
      <div class="duplicate-side-kicker"><span class="duplicate-source">${side === 'blog' ? 'BLOG · ORIGINAL' : `${duplicateEsc(duplicateSourceLabel(article).toLocaleUpperCase('de-DE'))} · QUELLE`}</span><span class="duplicate-infographic-count">${duplicateInfographicLabel(article)}</span></div>
      <h3>${duplicateEsc(article.title)}</h3>
      <p class="duplicate-meta">${duplicateDate(article.date)}${article.hasOwnImage ? ' · mit Artikelbild' : ''}</p>
      <p class="duplicate-excerpt">${duplicateEsc(article.excerpt || '')}</p>
    </div>
  </article>`;
}

function duplicatePendingByKey(key) {
  return duplicateUi.data.pending.find(item => duplicatePairKey(item) === key) || null;
}

function selectedDuplicateItems() {
  return [...duplicateUi.selection].map(duplicatePendingByKey).filter(Boolean);
}

function setDuplicateSelected(item, selected) {
  const key = duplicatePairKey(item);
  const { facebookId } = duplicatePairIds(item);
  if (selected) {
    for (const selectedKey of [...duplicateUi.selection]) {
      const other = duplicatePendingByKey(selectedKey);
      if (other && duplicatePairIds(other).facebookId === facebookId) duplicateUi.selection.delete(selectedKey);
    }
    duplicateUi.selection.add(key);
  } else {
    duplicateUi.selection.delete(key);
  }
  saveDuplicateSelection();
  updateDuplicateTools();
}

function duplicateActions(item, status, { detail = false } = {}) {
  const attrs = duplicatePairAttrs(item);
  if (status === 'pending') {
    const selected = duplicateUi.selection.has(duplicatePairKey(item));
    return `<div class="duplicate-actions" ${attrs}>
      ${detail ? `<button type="button" class="duplicate-btn${selected ? ' is-selected' : ''}" data-duplicate-action="toggle-selection">${selected ? 'Ausgewählt ✓' : 'Auswählen'}</button>` : ''}
      ${detail ? '' : '<button type="button" class="duplicate-btn" data-duplicate-action="inspect">Prüfen</button>'}
      <button type="button" class="duplicate-btn is-quiet" data-duplicate-action="ignore">Ignorieren</button>
    </div>`;
  }
  if (status === 'linked') {
    const hasInfographic = (Number(item.facebook?.infographicCount) || 0) > 0;
    return `<div class="duplicate-actions" ${attrs}>
      ${detail ? '' : '<button type="button" class="duplicate-btn" data-duplicate-action="inspect">Prüfen</button>'}
      <button type="button" class="duplicate-btn" data-duplicate-action="migrate"${hasInfographic ? '' : ' disabled title="Keine Quell-Infografik vorhanden"'}>Infografik migrieren</button>
      <button type="button" class="duplicate-btn is-danger" data-duplicate-action="reset">Verknüpfung lösen</button>
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
  const similarity = Number(item.score);
  const score = item.score == null ? '' : item.exact ? '100 %' : similarity >= 1 ? '< 100 %'
    : similarity >= 0.995 ? `${(similarity * 100).toFixed(1).replace('.', ',')} %`
      : `${Math.round(similarity * 100)} %`;
  const notes = status === 'pending' ? item.reasons || [] : [
    item.changed ? 'Seit der Entscheidung geändert' : (status === 'linked' ? 'Bestätigt verknüpft' : 'Bewusst ignoriert'),
    item.updatedAt ? `am ${new Date(item.updatedAt).toLocaleDateString('de-DE')}` : '',
  ].filter(Boolean);
  return `<article class="duplicate-card${item.changed ? ' is-changed' : ''}${selected ? ' is-selected' : ''}" ${duplicatePairAttrs(item)}>
    <header class="duplicate-card-head">
      ${status === 'pending' ? `<label class="duplicate-select"><input type="checkbox" data-duplicate-select ${selected ? 'checked' : ''}><span>Auswählen</span></label>` : ''}
      <div class="duplicate-score" ${item.exact ? 'title="Gleiche normalisierte Wortfolge; Absätze und Satzzeichen können abweichen"' : ''}><strong>${duplicateEsc(score || (status === 'linked' ? '✓' : '–'))}</strong><span>${score ? item.exact ? 'Wortfolge gleich' : 'Übereinstimmung' : status === 'linked' ? 'verknüpft' : 'Entscheidung'}</span></div>
      <div class="duplicate-reasons">${notes.map(note => `<span>${duplicateEsc(note)}</span>`).join('')}</div>
      ${status === 'pending' ? duplicateActions(item, status) : ''}
    </header>
    <div class="duplicate-pair">
      ${duplicateArticleMini(item.blog, 'blog')}
      <div class="duplicate-link-mark" aria-hidden="true">↔</div>
      ${duplicateArticleMini(item.facebook, 'facebook')}
    </div>
    ${status === 'pending' ? '' : duplicateActions(item, status)}
  </article>`;
}

function syncDuplicateAuthorFilter() {
  const authors = duplicateSourceAuthors();
  const selected = duplicateUi.filters.authors;
  const count = selected === null ? authors.length : authors.filter(author => selected.has(author)).length;
  duplicateAuthorFilterLabel.textContent = count === authors.length ? 'Alle Autoren'
    : count === 0 ? 'Keine Autoren'
      : count === 1 ? authors.find(author => selected.has(author)) : `${count} von ${authors.length}`;
  duplicateAuthorNative.options[0].textContent = duplicateAuthorFilterLabel.textContent;
  authors.forEach((author, index) => {
    duplicateAuthorNative.options[index + 3].textContent = `${selected === null || selected.has(author) ? '✓ ' : ''}${author}`;
  });
  duplicateAuthorNative.value = '';
  sizeDuplicateNativeFilter(duplicateAuthorNative);
  const all = duplicateAuthorOptions.querySelector('[data-duplicate-author-all]');
  if (all) all.setAttribute('aria-checked', count === authors.length ? 'true' : count === 0 ? 'false' : 'mixed');
  duplicateAuthorOptions.querySelectorAll('[data-duplicate-author]').forEach(item => {
    item.setAttribute('aria-checked', String(selected === null || selected.has(item.dataset.duplicateAuthor)));
  });
}

function renderDuplicateAuthorFilter() {
  const authors = duplicateSourceAuthors();
  const key = JSON.stringify(authors);
  if (key !== duplicateUi.authorOptionsKey) {
    duplicateUi.authorOptionsKey = key;
    duplicateUi.filters.authors = null;
    duplicateAuthorOptions.innerHTML = `<button type="button" class="header-menu-item duplicate-author-all" role="menuitemcheckbox" aria-checked="true" data-duplicate-author-all>Alle Autoren</button>
      ${authors.map(author => `<button type="button" class="header-menu-item" role="menuitemcheckbox" aria-checked="true" data-duplicate-author="${duplicateEsc(author)}">${duplicateEsc(author)}</button>`).join('')}`;
    const summary = new Option('Alle Autoren', '');
    summary.disabled = true;
    duplicateAuthorNative.replaceChildren(
      summary,
      new Option('Alle Autoren auswählen', 'all'),
      new Option('Keine Autoren auswählen', 'none'),
      ...authors.map((author, index) => new Option(author, `author:${index}`)),
    );
  }
  syncDuplicateAuthorFilter();
}

function syncDuplicateSingleFilters() {
  for (const root of duplicateFilterMenus) {
    const filter = root.dataset.duplicateFilterMenu;
    if (filter === 'authors') continue;
    const selected = root.querySelector(`[data-duplicate-filter-value="${duplicateUi.filters[filter]}"]`);
    const trigger = root.querySelector('.filter-menu-trigger');
    trigger.querySelector('span').textContent = selected?.textContent || '';
    trigger.title = selected?.textContent || '';
    root.querySelectorAll('[data-duplicate-filter-value]').forEach(item => {
      item.setAttribute('aria-checked', String(item === selected));
    });
    const native = filter === 'score' ? duplicateScoreNative : duplicateInfographicNative;
    native.value = duplicateUi.filters[filter];
    sizeDuplicateNativeFilter(native);
  }
}

// Anders als die Optionsliste soll das native Feld nur so breit wie sein
// aktuell angezeigter Wert sein; die System-Auswahl öffnet trotzdem alle Optionen.
function sizeDuplicateNativeFilter(select) {
  const style = getComputedStyle(select);
  const context = sizeDuplicateNativeFilter.context ||= document.createElement('canvas').getContext('2d');
  if (!context) return;
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const inset = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']
    .reduce((sum, key) => sum + (parseFloat(style[key]) || 0), 0);
  const label = select.selectedOptions[0]?.textContent || '';
  select.style.width = `${Math.ceil(context.measureText(label).width + inset + 4)}px`;
}

function chooseDuplicateAuthors(choice) {
  const authors = duplicateSourceAuthors();
  if (choice === 'all') duplicateUi.filters.authors = null;
  else if (choice === 'none') duplicateUi.filters.authors = new Set();
  else if (choice === 'toggle-all') duplicateUi.filters.authors = duplicateUi.filters.authors === null ? new Set() : null;
  else {
    if (!authors.includes(choice)) return;
    const selected = new Set(duplicateUi.filters.authors === null ? authors : duplicateUi.filters.authors);
    if (selected.has(choice)) selected.delete(choice);
    else selected.add(choice);
    duplicateUi.filters.authors = selected.size === authors.length ? null : selected;
  }
  syncDuplicateAuthorFilter();
  duplicateUi.listScrollTop = 0;
  renderDuplicateList();
}

function closeDuplicateFilterMenu(root, restoreFocus = false) {
  const trigger = root.querySelector('.filter-menu-trigger');
  root.querySelector('[role="menu"]').hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
  if (restoreFocus) trigger.focus();
}

function closeDuplicateFilterMenus(except = null) {
  duplicateFilterMenus.forEach(root => {
    if (root !== except) closeDuplicateFilterMenu(root);
  });
}

function openDuplicateFilterMenu(root, focusSelection = false) {
  closeDuplicateFilterMenus(root);
  const menu = root.querySelector('[role="menu"]');
  menu.hidden = false;
  root.querySelector('.filter-menu-trigger').setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => {
    if (menu.hidden) return;
    menu.style.transform = '';
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    const shift = rect.left < margin ? margin - rect.left
      : rect.right > window.innerWidth - margin ? window.innerWidth - margin - rect.right : 0;
    if (shift) menu.style.transform = `translateX(${Math.round(shift)}px)`;
    if (focusSelection) (menu.querySelector('[aria-checked="true"]') || menu.querySelector('.header-menu-item'))?.focus();
  });
}

function moveDuplicateFilterFocus(menu, direction) {
  const items = [...menu.querySelectorAll('.header-menu-item:not(:disabled)')];
  if (!items.length) return;
  const current = items.indexOf(document.activeElement);
  const next = direction === 'first' ? 0 : direction === 'last' ? items.length - 1
    : (current + direction + items.length) % items.length;
  items[next].focus();
}

function duplicateAuthorMatches(item) {
  return duplicateUi.filters.authors === null
    || duplicateUi.filters.authors.has(item.facebook?.author);
}

function duplicateVisiblePending() {
  const minimum = duplicateUi.filters.score === 'all' ? 0 : Number(duplicateUi.filters.score) / 100;
  return duplicateUi.data.pending.filter(item => {
    const scoreMatch = duplicateUi.filters.score === '100'
      ? !!item.exact
      : Number(item.score) >= minimum;
    const count = Number(item.facebook?.infographicCount) || 0;
    const infographicMatch = duplicateUi.filters.infographics === 'all'
      || (duplicateUi.filters.infographics === 'with' && count > 0)
      || (duplicateUi.filters.infographics === 'without' && count === 0);
    return duplicateAuthorMatches(item) && scoreMatch && infographicMatch;
  });
}

function duplicateVisibleItems(tab) {
  return tab === 'pending' ? duplicateVisiblePending()
    : (duplicateUi.data[tab] || []).filter(duplicateAuthorMatches);
}

function duplicateEmpty(tab, filtered = false) {
  const copy = filtered
    ? ['Keine Treffer für diese Filter', 'Passe den Autor oder die übrigen Filter an.']
    : {
      pending: ['Keine offenen Treffer', 'Nach dem nächsten Einlesen erscheinen hier neue, ausreichend ähnliche Artikelpaare.'],
      linked: ['Noch nichts verknüpft', 'Bestätigte Blog–Quellen-Paare werden hier dauerhaft dokumentiert.'],
      ignored: ['Keine ignorierten Treffer', 'Bewusst getrennte Artikel können hier wieder zur Prüfung freigegeben werden.'],
    }[tab];
  return `<div class="duplicate-empty"><span>◎</span><h3>${copy[0]}</h3><p>${copy[1]}</p></div>`;
}

function updateDuplicateStatus() {
  const visible = duplicateVisibleItems(duplicateUi.tab).length;
  const total = duplicateUi.data[duplicateUi.tab]?.length || 0;
  if (duplicateUi.tab === 'pending') {
    duplicateStatus.textContent = `${visible} von ${total} offenen Treffern sichtbar · Auswahl bleibt im Browser gespeichert`;
  } else {
    duplicateStatus.textContent = `${visible} von ${total} ${duplicateUi.tab === 'linked' ? 'verknüpften' : 'ignorierten'} Treffern sichtbar`;
  }
}

function updateDuplicateTools() {
  const pending = duplicateUi.tab === 'pending' && !duplicateUi.detail;
  duplicateTools.hidden = !!duplicateUi.detail;
  duplicateTools.dataset.tab = duplicateUi.tab;
  duplicateSelectionTools.hidden = !pending;
  duplicateTools.querySelectorAll('.duplicate-pending-filter').forEach(filter => { filter.hidden = !pending; });
  if (!pending) return;
  const selected = selectedDuplicateItems();
  const withInfographics = selected.filter(item => Number(item.facebook?.infographicCount) > 0).length;
  duplicateSelectionCount.textContent = `${selected.length} ausgewählt${withInfographics ? ` · ${withInfographics} mit Infografik` : ''}`;
  duplicateSelectNone.disabled = duplicateUi.busy || selected.length === 0;
  duplicateBatchLink.disabled = duplicateUi.busy || selected.length === 0;
  duplicateBatchMigrate.disabled = duplicateUi.busy || withInfographics === 0;
  duplicateSelectAll.disabled = duplicateUi.busy || duplicateVisiblePending().length === 0;
}

function renderDuplicateList({ restoreScroll = false } = {}) {
  duplicateChromeScrollPaused = true;
  duplicateUi.detail = null;
  const allItems = duplicateUi.data[duplicateUi.tab] || [];
  const items = duplicateVisibleItems(duplicateUi.tab);
  duplicateContent.innerHTML = items.length
    ? `<div class="duplicate-stack">${items.map(item => duplicateCard(item, duplicateUi.tab)).join('')}</div>`
    : duplicateEmpty(duplicateUi.tab, allItems.length > 0);
  updateDuplicateStatus();
  updateDuplicateTools();
  updateDuplicateChromeHeight();
  if (!restoreScroll) {
    duplicateContent.scrollTop = 0;
    duplicateLastScrollTop = 0;
    showDuplicateChrome(duplicateChromeOffset > 0);
  }
  requestAnimationFrame(() => {
    if (restoreScroll) duplicateContent.scrollTop = duplicateUi.listScrollTop;
    duplicateLastScrollTop = duplicateContent.scrollTop;
    duplicateChromeScrollPaused = false;
  });
}

function duplicateDiffLine(row) {
  const sign = row.kind === 'removed' ? '−' : row.kind === 'added' ? '+' : ' ';
  return `<div class="duplicate-diff-line is-${row.kind}">
    <span class="duplicate-diff-number" title="Quell-Abschnitt">${row.facebookNumber ?? ''}</span>
    <span class="duplicate-diff-number" title="Blog-Abschnitt">${row.blogNumber ?? ''}</span>
    <span class="duplicate-diff-sign" aria-hidden="true">${sign}</span>
    <span class="duplicate-diff-text">${row.html}</span>
  </div>`;
}

function duplicateComparisonRows(pair) {
  const rows = duplicateTextDiff.renderUnifiedRows(
    duplicateTextDiff.renderedBlocksFromHtml(pair.blog.bodyHtml),
    duplicateTextDiff.renderedBlocksFromHtml(pair.facebook.bodyHtml), {
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

function renderDuplicateDetail(pair) {
  duplicateUi.detail = pair;
  duplicateTools.hidden = true;
  const migration = pair.migration || [];
  const sourceLabel = duplicateEsc(duplicateSourceLabel(pair.facebook));
  const sourceKicker = duplicateEsc(duplicateSourceLabel(pair.facebook).toLocaleUpperCase('de-DE'));
  duplicateDetailContent.innerHTML = `<div class="duplicate-detail" data-mobile-side="${duplicateUi.mobileSide}">
    <div class="duplicate-detail-nav">
      <button type="button" class="duplicate-back" data-duplicate-action="back">← Zur Trefferliste</button>
      <button type="button" class="duplicate-diff-toggle" data-duplicate-action="toggle-differences" aria-pressed="${duplicateUi.onlyDifferences}" title="Unveränderte Textabschnitte bis auf je einen Kontextabschnitt einklappen">Nur Unterschiede</button>
      <div class="duplicate-detail-switch" role="tablist" aria-label="Artikelkopf und Infografiken">
        <button type="button" role="tab" data-duplicate-action="mobile-side" data-side="blog" aria-selected="${duplicateUi.mobileSide === 'blog'}">Blog</button>
        <button type="button" role="tab" data-duplicate-action="mobile-side" data-side="facebook" aria-selected="${duplicateUi.mobileSide === 'facebook'}">${sourceLabel}</button>
      </div>
    </div>
    <div class="duplicate-detail-header-grid">
      <article data-duplicate-side="blog"><span class="duplicate-source">BLOG · ORIGINAL</span><h3 title="${duplicateEsc(pair.blog.title)}">${duplicateEsc(pair.blog.title)}</h3><p class="duplicate-meta">${duplicateDate(pair.blog.date)}</p>${duplicateInfographicGallery(pair.blog, 'blog')}</article>
      <article data-duplicate-side="facebook"><span class="duplicate-source">${sourceKicker} · QUELLE</span><h3 title="${duplicateEsc(pair.facebook.title)}">${duplicateEsc(pair.facebook.title)}</h3><p class="duplicate-meta">${duplicateDate(pair.facebook.date)}</p>${duplicateInfographicGallery(pair.facebook, 'facebook')}</article>
    </div>
    <div class="duplicate-comparison-scroll" tabindex="0" aria-label="Änderungen zwischen ${sourceLabel} und Blog">
      <div class="duplicate-diff-legend"><span class="is-removed">− Nur ${sourceLabel}</span><span class="is-added">+ Nur Blog</span><small>Abschnitte: ${sourceLabel} · Blog</small></div>
      <div class="duplicate-comparison-rows">${duplicateComparisonRows(pair)}</div>
    </div>
    ${migration.length ? `<details class="duplicate-migration-note">
      <summary>${migration.length} Infografik${migration.length === 1 ? ' kann' : 'en können'} migriert werden · Dateinamen</summary>
      <ul>${migration.map(item => `<li>${duplicateEsc(item.target)} · ${item.files.map(duplicateEsc).join(', ')}</li>`).join('')}</ul>
    </details>` : `<aside class="duplicate-migration-note">${pair.migrationUnavailable ? duplicateEsc(pair.migrationUnavailable) : 'Keine migrierbare Infografik erkannt'}</aside>`}
    ${duplicateActions(pair, duplicateUi.tab, { detail: true })}
  </div>`;
  if (!duplicateDetailDialog.open) duplicateDetailDialog.showModal();
  syncDuplicatePageScroll();
  updateDuplicateTools();
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

function updateDuplicateCounts() {
  for (const key of ['pending', 'linked', 'ignored']) {
    document.querySelector(`[data-duplicate-count="${key}"]`).textContent = duplicateUi.data[key]?.length || 0;
  }
  const open = duplicateUi.data.pending?.length || 0;
  duplicateMenuCount.textContent = open;
  duplicateMenuCount.hidden = !open;
}

function pruneDuplicateSelection() {
  const valid = new Set(duplicateUi.data.pending.map(duplicatePairKey));
  let changed = false;
  for (const key of [...duplicateUi.selection]) {
    if (!valid.has(key)) {
      duplicateUi.selection.delete(key);
      changed = true;
    }
  }
  if (changed) saveDuplicateSelection();
}

async function loadDuplicates({ quiet = false, restoreScroll = false } = {}) {
  if (!quiet) duplicateStatus.textContent = 'Treffer werden geladen …';
  const data = await duplicateRequest('/api/duplicates');
  duplicateUi.data = data;
  renderDuplicateAuthorFilter();
  syncDuplicateSingleFilters();
  pruneDuplicateSelection();
  updateDuplicateCounts();
  if (!duplicateDetailDialog.open) renderDuplicateList({ restoreScroll });
}

async function inspectDuplicate(blogId, facebookId) {
  duplicateUi.listScrollTop = duplicateContent.scrollTop;
  duplicateStatus.textContent = 'Artikelvergleich wird geladen …';
  const pair = await duplicateRequest(`/api/duplicates/compare?blogId=${encodeURIComponent(blogId)}&facebookId=${encodeURIComponent(facebookId)}`);
  duplicateStatus.textContent = `Abweichende Wörter sind markiert. Auf dem Smartphone wechselst du zwischen Blog und ${duplicateSourceLabel(pair.facebook)}.`;
  duplicateUi.mobileSide = 'blog';
  renderDuplicateDetail(pair);
}

async function mutateDuplicate(action, blogId, facebookId) {
  if (duplicateUi.busy) return;
  if (action === 'migrate') {
    const okay = window.confirm('Die Infografikdateien im Ordner „Infografiken“ werden für den Blogartikel umbenannt. Das Artikelbild bleibt unverändert. Fortfahren?');
    if (!okay) return;
  }
  duplicateUi.busy = true;
  updateDuplicateTools();
  duplicateStatus.textContent = action === 'migrate' ? 'Infografiken werden migriert und das Archiv neu eingelesen …' : 'Änderung wird gespeichert …';
  try {
    await duplicateRequest('/api/duplicates', {
      method: 'POST',
      body: JSON.stringify({ action, blogId, facebookId }),
    });
    await loadDuplicates({ quiet: true, restoreScroll: true });
    closeDuplicateDetail();
    if (['reset', 'migrate'].includes(action) && typeof loadArticles === 'function') await loadArticles();
  } finally {
    duplicateUi.busy = false;
    updateDuplicateTools();
  }
}

async function linkSelectedDuplicates(migrateImages = false) {
  if (duplicateUi.busy) return;
  const items = selectedDuplicateItems().map(duplicatePairIds);
  if (!items.length) return;
  const infographicPairs = selectedDuplicateItems().filter(item => Number(item.facebook?.infographicCount) > 0).length;
  const message = migrateImages
    ? `${items.length} ausgewählte Paare verknüpfen und die Infografiken von ${infographicPairs} Quellbeiträgen umbenennen?`
    : `${items.length} ausgewählte Paare jetzt verknüpfen?`;
  if (!window.confirm(message)) return;

  duplicateUi.busy = true;
  updateDuplicateTools();
  duplicateStatus.textContent = migrateImages
    ? `${items.length} Paare werden verknüpft; anschließend wird das Archiv einmal neu eingelesen …`
    : `${items.length} Paare werden gemeinsam verknüpft …`;
  try {
    const result = await duplicateRequest('/api/duplicates/batch', {
      method: 'POST',
      body: JSON.stringify({ items, migrateImages }),
    });
    const failed = new Set((result.failed || []).map(duplicatePairKey));
    duplicateUi.selection = new Set([...duplicateUi.selection].filter(key => failed.has(key)));
    saveDuplicateSelection();
    duplicateUi.listScrollTop = 0;
    await loadDuplicates({ quiet: true });
    if (typeof loadArticles === 'function') await loadArticles();
    duplicateStatus.textContent = result.failed?.length
      ? `${result.linked} verknüpft, ${result.failed.length} fehlgeschlagen und weiter ausgewählt.`
      : `${result.linked} Paare wurden verknüpft.`;
  } finally {
    duplicateUi.busy = false;
    updateDuplicateTools();
  }
}

async function openDuplicateReview() {
  duplicateUi.tab = 'pending';
  duplicateUi.detail = null;
  duplicateDialog.showModal();
  syncDuplicatePageScroll();
  showDuplicateChrome();
  updateDuplicateChromeHeight();
  duplicateContent.scrollTop = 0;
  duplicateLastScrollTop = 0;
  duplicateContent.innerHTML = '<div class="duplicate-loading"><span class="spinner"></span></div>';
  try { await loadDuplicates(); }
  catch (error) {
    duplicateStatus.textContent = 'Fehler';
    duplicateContent.innerHTML = `<div class="duplicate-empty"><h3>Dubletten konnten nicht geladen werden</h3><p>${duplicateEsc(error.message)}</p></div>`;
  }
}

function refreshDuplicateMenuCount() {
  loadDuplicates({ quiet: true }).catch(() => {});
}

loadDuplicateSelection();

for (const dialog of duplicateDialogs) dialog.addEventListener('close', syncDuplicatePageScroll);

document.getElementById('duplicate-review-close').addEventListener('click', () => duplicateDialog.close());
duplicateDialog.addEventListener('click', event => {
  if (event.target === duplicateDialog) duplicateDialog.close();
});
duplicateDetailDialog.addEventListener('click', event => {
  if (event.target === duplicateDetailDialog) closeDuplicateDetail();
});
duplicateDetailDialog.addEventListener('close', () => {
  renderDuplicateList({ restoreScroll: true });
});
duplicateImageViewer.addEventListener('click', event => {
  if (event.target === duplicateImageViewer) duplicateImageViewer.close();
});
duplicateImageViewer.addEventListener('close', () => duplicateImageViewerImage.removeAttribute('src'));
function closeTopDuplicateDialog() {
  if (duplicateImageViewer.open) duplicateImageViewer.close();
  else if (duplicateDetailDialog.open) closeDuplicateDetail();
  else if (duplicateDialog.open) duplicateDialog.close();
}

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || ![duplicateDialog, duplicateDetailDialog, duplicateImageViewer].some(dialog => dialog.open)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const openMenu = duplicateFilterMenus.find(root => !root.querySelector('[role="menu"]').hidden);
  if (openMenu) closeDuplicateFilterMenu(openMenu, true);
  else closeTopDuplicateDialog();
}, true);
for (const dialog of [duplicateDialog, duplicateDetailDialog, duplicateImageViewer]) {
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    event.stopPropagation();
    closeTopDuplicateDialog();
  });
}
duplicateImageViewer.addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft') stepDuplicateImageViewer(-1);
  if (event.key === 'ArrowRight') stepDuplicateImageViewer(1);
});
document.getElementById('duplicate-image-viewer-close').addEventListener('click', () => duplicateImageViewer.close());
duplicateImageViewerPrev.addEventListener('click', () => stepDuplicateImageViewer(-1));
duplicateImageViewerNext.addEventListener('click', () => stepDuplicateImageViewer(1));

// Dieselbe sichtbare Zieh- und Rückfederbewegung wie bei Artikel- und
// Einstellungsdialogen; gescrollte Inhalte und System-Auswahllisten bleiben frei.
for (const dialog of [duplicateDialog, duplicateDetailDialog, duplicateImageViewer]) {
  enablePullToClose({
    scroller: dialog,
    moving: dialog,
    fading: null,
    canStart: event => !event.target.closest?.('textarea, input, select, [contenteditable]')
      && !scrolledWithin(event.target, dialog),
    onClose: () => dialog.close(),
  });
}
duplicateDetailContent.addEventListener('toggle', event => {
  const gallery = event.target;
  if (!gallery.matches?.('details.duplicate-infographic-gallery')) return;
  duplicateUi.infographicsOpen = gallery.open;
  for (const other of duplicateDetailContent.querySelectorAll('details.duplicate-infographic-gallery')) {
    if (other.open !== gallery.open) other.open = gallery.open;
  }
}, true);
document.getElementById('duplicate-tabs').addEventListener('click', event => {
  const button = event.target.closest('[data-duplicate-tab]');
  if (!button) return;
  closeDuplicateFilterMenus();
  duplicateUi.tab = button.dataset.duplicateTab;
  duplicateUi.listScrollTop = 0;
  document.querySelectorAll('[data-duplicate-tab]').forEach(tab => tab.setAttribute('aria-selected', String(tab === button)));
  renderDuplicateList();
});

for (const root of duplicateFilterMenus) {
  const trigger = root.querySelector('.filter-menu-trigger');
  const menu = root.querySelector('[role="menu"]');
  trigger.addEventListener('click', () => {
    if (menu.hidden) openDuplicateFilterMenu(root);
    else closeDuplicateFilterMenu(root);
  });
  trigger.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    openDuplicateFilterMenu(root, true);
  });
  menu.addEventListener('click', event => {
    const item = event.target.closest('.header-menu-item');
    if (!item) return;
    if (root.dataset.duplicateFilterMenu === 'authors') {
      chooseDuplicateAuthors(item.hasAttribute('data-duplicate-author-all') ? 'toggle-all' : item.dataset.duplicateAuthor);
      return;
    } else {
      duplicateUi.filters[root.dataset.duplicateFilterMenu] = item.dataset.duplicateFilterValue;
      syncDuplicateSingleFilters();
      closeDuplicateFilterMenu(root, true);
    }
    duplicateUi.listScrollTop = 0;
    renderDuplicateList();
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveDuplicateFilterFocus(menu, event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      moveDuplicateFilterFocus(menu, event.key === 'Home' ? 'first' : 'last');
    } else if (event.key === 'Tab') closeDuplicateFilterMenu(root);
  });
}
duplicateAuthorNative.addEventListener('change', () => {
  const choice = duplicateAuthorNative.value;
  if (choice === 'all' || choice === 'none') chooseDuplicateAuthors(choice);
  else if (choice.startsWith('author:')) {
    const author = duplicateSourceAuthors()[Number(choice.slice(7))];
    if (author !== undefined) chooseDuplicateAuthors(author);
  }
  duplicateAuthorNative.value = '';
});
for (const [select, filter] of [[duplicateScoreNative, 'score'], [duplicateInfographicNative, 'infographics']]) {
  select.addEventListener('change', () => {
    duplicateUi.filters[filter] = select.value;
    syncDuplicateSingleFilters();
    duplicateUi.listScrollTop = 0;
    renderDuplicateList();
  });
}
window.addEventListener('resize', () => {
  sizeDuplicateNativeFilter(duplicateAuthorNative);
  sizeDuplicateNativeFilter(duplicateScoreNative);
  sizeDuplicateNativeFilter(duplicateInfographicNative);
});
document.addEventListener('click', event => {
  if (!event.target.closest('[data-duplicate-filter-menu]')) closeDuplicateFilterMenus();
});
duplicateDialog.addEventListener('close', () => closeDuplicateFilterMenus());
duplicateSelectAll.addEventListener('click', () => {
  duplicateUi.listScrollTop = duplicateContent.scrollTop;
  const seenFacebook = new Set();
  for (const item of duplicateVisiblePending()) {
    const { facebookId } = duplicatePairIds(item);
    if (seenFacebook.has(facebookId)) continue;
    seenFacebook.add(facebookId);
    for (const selectedKey of [...duplicateUi.selection]) {
      const other = duplicatePendingByKey(selectedKey);
      if (other && duplicatePairIds(other).facebookId === facebookId) duplicateUi.selection.delete(selectedKey);
    }
    duplicateUi.selection.add(duplicatePairKey(item));
  }
  saveDuplicateSelection();
  renderDuplicateList({ restoreScroll: true });
});
duplicateSelectNone.addEventListener('click', () => {
  duplicateUi.listScrollTop = duplicateContent.scrollTop;
  duplicateUi.selection.clear();
  saveDuplicateSelection();
  renderDuplicateList({ restoreScroll: true });
});
duplicateBatchLink.addEventListener('click', () => linkSelectedDuplicates(false).catch(error => { duplicateStatus.textContent = error.message; }));
duplicateBatchMigrate.addEventListener('click', () => linkSelectedDuplicates(true).catch(error => { duplicateStatus.textContent = error.message; }));

duplicateContent.addEventListener('change', event => {
  const checkbox = event.target.closest('[data-duplicate-select]');
  if (!checkbox) return;
  const root = checkbox.closest('[data-blog-id]');
  const item = duplicatePendingByKey(`${root?.dataset.blogId || ''}${DUPLICATE_PAIR_SEPARATOR}${root?.dataset.facebookId || ''}`);
  if (!item) return;
  duplicateUi.listScrollTop = duplicateContent.scrollTop;
  setDuplicateSelected(item, checkbox.checked);
  renderDuplicateList({ restoreScroll: true });
});

async function handleDuplicateAction(event) {
  const button = event.target.closest('[data-duplicate-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.duplicateAction;
  if (action === 'back') return closeDuplicateDetail();
  if (action === 'toggle-differences') return toggleDuplicateDiffMode();
  if (action === 'mobile-side') {
    duplicateUi.mobileSide = button.dataset.side === 'facebook' ? 'facebook' : 'blog';
    duplicateDetailContent.querySelector('.duplicate-detail').dataset.mobileSide = duplicateUi.mobileSide;
    duplicateDetailContent.querySelectorAll('[data-duplicate-action="mobile-side"]').forEach(tab => {
      tab.setAttribute('aria-selected', String(tab.dataset.side === duplicateUi.mobileSide));
    });
    return;
  }
  if (action === 'open-infographic') {
    return openDuplicateImageViewer(button.dataset.side, Number(button.dataset.index));
  }
  const root = button.closest('[data-blog-id]');
  const blogId = root?.dataset.blogId;
  const facebookId = root?.dataset.facebookId;
  if (!blogId || !facebookId) return;
  try {
    if (action === 'inspect') await inspectDuplicate(blogId, facebookId);
    else if (action === 'toggle-selection') {
      const item = duplicatePendingByKey(`${blogId}${DUPLICATE_PAIR_SEPARATOR}${facebookId}`);
      if (item) {
        setDuplicateSelected(item, !duplicateUi.selection.has(duplicatePairKey(item)));
        closeDuplicateDetail();
      }
    } else if (action === 'ignore') {
      closeDuplicateDetail();
      await mutateDuplicate(action, blogId, facebookId);
    } else if (['reset', 'migrate'].includes(action)) await mutateDuplicate(action, blogId, facebookId);
  } catch (error) {
    duplicateStatus.textContent = error.message;
  }
}

duplicateContent.addEventListener('click', handleDuplicateAction);
duplicateDetailContent.addEventListener('click', handleDuplicateAction);

// Nach Anmeldung im Hintergrund nur den Zähler laden; Fehler (älterer Server,
// fehlende Adminrechte) bleiben im normalen Betrieb unsichtbar.
window.addEventListener('load', () => {
  setTimeout(() => {
    if (!document.querySelector('[data-action="duplicates"]')?.hidden) loadDuplicates({ quiet: true }).catch(() => {});
  }, 500);
});
