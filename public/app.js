/* WebArchiv — SPA frontend */

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  q: '',
  author: '',
  externalAudio: false,
  year: '',
  category: '',
  telegram: false,
  infographicFilter: 'all',
  bookmarks: false,
  page: 1,
  limit: 24,
  total: 0,
  pages: 0,
  loading: false,
  currentItems: [],
  currentArticleIdx: -1,
  bookSort: 'recent',
  gridCardWidths: { square: null, tall: null },
};

// Hörbücher sind kein Artikel-Autor: eigene Liste, eigene Detailansicht (audiobooks.js).
const AUDIOBOOK_AUTHOR = 'Hörbücher';
const INFOGRAPHICS_AUTHOR = 'Infografiken';
const isAudiobookId = id => String(id || '').startsWith(AUDIOBOOK_AUTHOR + '/');
const isBookMode = () => state.author === AUDIOBOOK_AUTHOR;
const isInstagramPosterMode = () => state.author === INFOGRAPHICS_AUTHOR
  && state.infographicFilter === 'posters';
const isClassicInfographicMode = () => state.author === INFOGRAPHICS_AUTHOR
  && state.infographicFilter === 'classic';
// Prüfmodus „Infografiken prüfen“: infographic-review.js (nur in der Admin-Shell)
// ersetzt diese Platzhalter; für Gäste und Nutzer bleibt der Modus aus.
const infographicReview = {
  active: false,
  hasChanges: () => false,
  value: (id, fallback = false) => fallback === true,
  mark() {},
  remember() {},
  reset() {},
  renderCard: () => '',
};
const isInfographicReviewMode = () => infographicReview.active;

let authorHueMap = {};  // author name → hue (0..359), gesetzt in loadMeta()
let audioEl = null;     // shared audio element
let articleSessionActive = false;   // Media Session gehört dem Artikel-Audio (nicht dem Hörbuch)
let currentAudioBtn = null;
let currentUser = null; // { email, role, allowedAuthors }
const INFOGRAPHIC_MAX_BYTES = 10 * 1024 * 1024;
const sessionViewStore = window.WebArchivSessionState;
const gridDensityMath = window.WebArchivGridDensity;
const pageSwipeMath = window.WebArchivPageSwipe;
let currentViewItemId = '';
let lastListPosition = null;
let lastDetailPosition = null;
let restoringSessionView = false;
let sessionViewSaveTimer = null;
let pendingLoginDeepLink = null;
const APP_VIEW_HISTORY_STATE = { webarchivView: true };
let layoutChangeGeneration = 0;
let cardPreviewObserver = null;
let cardPreviewFrame = 0;
let responsiveDateObserver = null;
let responsiveDateFrame = 0;

// ── DOM refs ───────────────────────────────────────────────────────────────
const $app            = document.getElementById('app');
const $count          = document.getElementById('article-count');
const $searchInput    = document.getElementById('search-input');
const $searchClear    = document.getElementById('search-clear');
const $filterAuthor   = document.getElementById('filter-author');
const $filterYear     = document.getElementById('filter-year');
const $filterCategory = document.getElementById('filter-category');
const $filterLayout   = document.getElementById('filter-layout');
const $filterLimit    = document.getElementById('filter-limit');
const $resetFilters   = document.getElementById('reset-filters');
const $filterBarInner = document.querySelector('.filter-bar-inner');
const $navigationChrome = document.getElementById('navigation-chrome');
const $gridDensityStatus = document.getElementById('grid-density-status');
const $reindexBtn    = document.getElementById('reindex-btn');
const $adminMenu      = document.getElementById('admin-menu');
const $scrapeOverlay  = document.getElementById('scrape-overlay');
const $telegramBtn    = document.getElementById('telegram-btn');
const $bookmarkBtn    = document.getElementById('bookmark-btn');
const $logoutBtn      = document.getElementById('logout-btn');
const $loginBtn       = document.getElementById('login-btn');
const $loginClose     = document.getElementById('login-close');
const $overlay        = document.getElementById('article-overlay');
const $overlayClose   = document.getElementById('overlay-close');
const $overlayBdrop   = document.getElementById('overlay-backdrop');
const $detail         = document.getElementById('article-detail');
const $loading        = document.getElementById('loading');
const $loginOverlay   = document.getElementById('login-overlay');
const $loginForm      = document.getElementById('login-form');
const $loginEmail     = document.getElementById('login-email');
const $loginPassword  = document.getElementById('login-password');
const $loginError     = document.getElementById('login-error');
const $loginSubmit    = document.getElementById('login-submit');
const $loginBtnText   = document.getElementById('login-btn-text');
const $loginSpinner   = document.getElementById('login-spinner');
const $fullscreenPosterToggle = document.getElementById('img-fullscreen-poster-toggle');
const $fullscreenPosterCheckbox = document.getElementById('img-fullscreen-poster-checkbox');

// ── Helpers ────────────────────────────────────────────────────────────────
function deviceStorage() {
  try { return window.localStorage; } catch { return null; }
}

function nextPaint() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

// ── ARIA-Menüs der Desktop-Filter ─────────────────────────────────────────
// Bedienung (Tastatur, Escape, Klick außerhalb, Viewport) liegt zentral in
// aria-menu.js; hier nur die Kopplung an die nativen Selects (Touch-Variante).
function filterAriaRoot(select) {
  return document.querySelector(`[data-filter-aria-menu="${select.id}"]`);
}

function syncFilterAriaMenu(select) {
  WebArchivAriaMenu.syncSelect(select);
}

function closeFilterAriaMenu(root, restoreFocus = false) {
  const select = root && document.getElementById(root.dataset.filterAriaMenu);
  if (select) WebArchivAriaMenu.selectController(select)?.close({ restoreFocus });
}

function wireFilterAriaMenus() {
  document.querySelectorAll('[data-filter-aria-menu]').forEach(root => {
    WebArchivAriaMenu.bindSelect(document.getElementById(root.dataset.filterAriaMenu), root);
  });
  document.body.classList.add('filter-aria-menus-ready');
}

function updateFilterLabelLayout() {
  if (!$filterBarInner) return;

  // Immer zuerst mit Beschriftungen messen. Dadurch erscheinen sie nach einem
  // Wechsel ins Querformat automatisch wieder, sobald Kategorie noch in Zeile 1 passt.
  $filterBarInner.classList.remove('filter-labels-compact');
  if (document.body.dataset.filterLabels === 'hidden'
      || window.matchMedia('(max-width: 600px)').matches || isBookMode()) return;

  const authorGroup = $filterAuthor.closest('.filter-group');
  const categoryGroup = $filterCategory.closest('.filter-group');
  if (!authorGroup || !categoryGroup || categoryGroup.getClientRects().length === 0) return;

  const categoryWrapped = categoryGroup.offsetTop > authorGroup.offsetTop + 1;
  $filterBarInner.classList.toggle('filter-labels-compact', categoryWrapped);
}

function hasActiveListFilter() {
  return Boolean(
    state.q
    || state.author
    || state.externalAudio
    || state.year
    || state.category
    || state.telegram
    || state.infographicFilter !== 'all'
    || state.bookmarks
  );
}

function updateResetFiltersVisibility() {
  const hidden = !hasActiveListFilter();
  if ($resetFilters.hidden === hidden) return;
  $resetFilters.hidden = hidden;
  requestAnimationFrame(updateFilterLabelLayout);
}

function listViewportTop() {
  const bar = document.getElementById('filter-bar');
  return bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
}

// ── Platzsparende Navigation beim Scrollen ────────────────────────────────
const NAV_SCROLL_THRESHOLD = 24;
let navigationLastScrollY = Math.max(0, window.scrollY);
let navigationDirection = 0;
let navigationTravel = 0;
let navigationScrollFrame = 0;
let navigationVisibleUntil = 0;
let navigationOffset = 0;

function navigationChromeMustStayVisible() {
  if (!$navigationChrome) return false;
  const active = document.activeElement;
  return Date.now() < navigationVisibleUntil
    || active === $searchInput
    || !$adminMenu.hidden
    || !!document.querySelector('dialog[open]');
}

function setNavigationChromeOffset(offset, returning = false) {
  if (!$navigationChrome) return;
  const height = Math.max(1, $navigationChrome.offsetHeight);
  navigationOffset = Math.max(0, Math.min(height, offset));
  $navigationChrome.classList.toggle('is-returning', returning);
  $navigationChrome.classList.toggle('is-hidden', navigationOffset >= height - 1);
  $navigationChrome.style.setProperty('--navigation-translate', `${-navigationOffset}px`);
}

function showNavigationChrome(returning = false) {
  setNavigationChromeOffset(0, returning && navigationOffset > 0);
  navigationDirection = 0;
  navigationTravel = 0;
}

function updateNavigationChrome() {
  navigationScrollFrame = 0;
  if (!$navigationChrome) return;
  const currentY = Math.max(0, window.scrollY);
  const delta = currentY - navigationLastScrollY;
  navigationLastScrollY = currentY;

  if (currentY <= 8 || navigationChromeMustStayVisible()) {
    showNavigationChrome(navigationOffset > 0);
    return;
  }
  if (Math.abs(delta) < 1) return;

  const direction = Math.sign(delta);
  if (direction !== navigationDirection) {
    navigationDirection = direction;
    navigationTravel = 0;
  }
  if (direction > 0) {
    // Ohne eigene Animation exakt mit dem Inhalt nach oben schieben.
    navigationTravel = 0;
    setNavigationChromeOffset(navigationOffset + delta);
    return;
  }

  navigationTravel += Math.abs(delta);
  if (navigationTravel >= NAV_SCROLL_THRESHOLD) showNavigationChrome(true);
}

function scheduleNavigationChromeUpdate() {
  if (!navigationScrollFrame) navigationScrollFrame = requestAnimationFrame(updateNavigationChrome);
}

function activeAuthorScope() {
  return state.externalAudio ? '__external_audio__' : state.author;
}

function captureListPosition() {
  const cards = [...$app.querySelectorAll('.card[data-id]')];
  const viewportTop = listViewportTop();
  let anchorIndex = cards.findIndex(card => card.getBoundingClientRect().bottom > viewportTop);
  if (anchorIndex < 0) anchorIndex = Math.max(0, cards.length - 1);
  const anchor = cards[anchorIndex] || null;
  return {
    authorScope: activeAuthorScope(),
    anchorId: anchor?.dataset.id || '',
    anchorIndex,
    offset: anchor ? anchor.getBoundingClientRect().top - viewportTop : 0,
    top: Math.max(0, window.scrollY),
    ratio: 0,
  };
}

async function restoreListPosition(position) {
  if (!position) return;
  if (position.authorScope !== activeAuthorScope()) {
    scrollToResults('auto');
    return;
  }
  await nextPaint();
  // Ganz oben bleibt ganz oben: Raster und Liste haben unterschiedliche Abstände
  // über der ersten Karte. Deren Ausgleich würde die Seite samt Kopfbereich um
  // ein paar Pixel verschieben (sichtbar beim Wechsel quadratisch/länglich ↔ Liste).
  if ((position.top || 0) <= 1) {
    window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }
  const cards = [...$app.querySelectorAll('.card[data-id]')];
  const anchor = cards.find(card => card.dataset.id === position.anchorId)
    || cards[Math.min(position.anchorIndex || 0, Math.max(0, cards.length - 1))];
  if (!anchor) {
    window.scrollTo({ top: position.top || 0, behavior: 'auto' });
    return;
  }
  const viewportTop = listViewportTop();
  const wantedTop = viewportTop + (position.offset || 0);
  window.scrollBy({ top: anchor.getBoundingClientRect().top - wantedTop, behavior: 'auto' });
}

function captureDetailPosition() {
  const panel = $overlay.querySelector('.overlay-panel');
  if (!panel) return null;
  const max = Math.max(0, panel.scrollHeight - panel.clientHeight);
  return {
    anchorId: '', anchorIndex: 0, offset: 0,
    top: Math.max(0, panel.scrollTop),
    ratio: max > 0 ? panel.scrollTop / max : 0,
  };
}

async function restoreDetailPosition(position) {
  const panel = $overlay.querySelector('.overlay-panel');
  if (!panel || !position) return;
  const apply = () => {
    const max = Math.max(0, panel.scrollHeight - panel.clientHeight);
    panel.scrollTop = Math.min(max, position.top || (position.ratio || 0) * max);
  };
  await nextPaint();
  apply();

  // Hero- und Artikelbilder verändern die Dialoghöhe oft erst nach dem Rendern.
  // Erst danach ist die gespeicherte absolute Position wieder erreichbar.
  const pendingImages = [...$detail.querySelectorAll('img')].filter(image => !image.complete);
  if (pendingImages.length) {
    await Promise.race([
      Promise.all(pendingImages.map(image => new Promise(resolve => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
      }))),
      new Promise(resolve => setTimeout(resolve, 1200)),
    ]);
    await nextPaint();
    apply();
  }
  // Auch bereits gecachte Bilder und Webfonts können ihre endgültigen Maße erst
  // einige Frames später liefern (besonders beim Wiederaufbau einer mobilen PWA).
  await new Promise(resolve => setTimeout(resolve, 250));
  await nextPaint();
  apply();
  lastDetailPosition = captureDetailPosition();
}

function activeViewKind() {
  if (typeof bookReader !== 'undefined' && bookReader.el) return 'reader';
  return !$overlay.hidden && currentViewItemId ? 'detail' : 'list';
}

function snapshotSessionView() {
  const kind = activeViewKind();
  if (kind === 'list') lastListPosition = captureListPosition();
  const readerId = typeof bookReader !== 'undefined' && bookReader.book?.id ? bookReader.book.id : '';
  const readerExtraFile = typeof bookReader !== 'undefined' && bookReader.extra?.file
    ? bookReader.extra.file
    : '';
  return {
    list: {
      q: state.q,
      author: state.author,
      externalAudio: state.externalAudio,
      year: state.year,
      category: state.category,
      telegram: state.telegram,
      bookmarks: state.bookmarks,
      page: state.page,
      limit: state.limit,
      layout: currentLayout(),
      gridCardWidths: { ...state.gridCardWidths },
      bookSort: state.bookSort,
    },
    view: {
      kind,
      itemId: kind === 'reader' ? readerId : (kind === 'detail' ? currentViewItemId : ''),
      readerExtraFile: kind === 'reader' ? readerExtraFile : '',
      listPosition: lastListPosition || captureListPosition(),
      detailPosition: kind === 'detail' || kind === 'reader'
        ? (lastDetailPosition || captureDetailPosition())
        : null,
    },
  };
}

function saveCurrentViewState() {
  clearTimeout(sessionViewSaveTimer);
  sessionViewSaveTimer = null;
  if (!sessionViewStore || !currentUser || restoringSessionView || isInfographicReviewMode()) return;
  const snapshot = snapshotSessionView();
  sessionViewStore.save(deviceStorage(), currentUser, snapshot);
}

function scheduleCurrentViewSave() {
  clearTimeout(sessionViewSaveTimer);
  sessionViewSaveTimer = setTimeout(saveCurrentViewState, 180);
}

function clearCurrentViewState(user = currentUser) {
  clearTimeout(sessionViewSaveTimer);
  sessionViewSaveTimer = null;
  sessionViewStore?.clear(deviceStorage(), user);
}

// „#/article/<id>?bild=3“ → { id, image: 3 }
function parseArticleHash(hash) {
  if (!hash.startsWith('#/article/')) return null;
  const [rawId, query = ''] = hash.slice('#/article/'.length).split('?');
  const image = parseInt(new URLSearchParams(query).get('bild'), 10);
  return { id: decodeURIComponent(rawId), image: image > 0 ? image : null };
}

function startupArticleLink() {
  // Ein vom Archiv selbst gesetzter Hash ist die alte Browseradresse, kein neu
  // aufgerufener Artikellink. Nur ein externer Link überstimmt den Speicherstand.
  return history.state?.webarchivView ? null : parseArticleHash(location.hash);
}

function updateNavButtons() {
  const atFirst = state.currentArticleIdx <= 0 && state.page === 1;
  const atLast  = state.currentArticleIdx >= state.currentItems.length - 1 && state.page >= state.pages;
  document.getElementById('overlay-prev').disabled = atFirst;
  document.getElementById('overlay-next').disabled = atLast;
}

async function navigateArticle(dir) {
  const newIdx = state.currentArticleIdx + dir;
  if (newIdx >= 0 && newIdx < state.currentItems.length) {
    openArticle(state.currentItems[newIdx].id, { dir });
  } else if (dir > 0 && state.page < state.pages) {
    state.page++;
    await loadArticles();
    if (state.currentItems.length) openArticle(state.currentItems[0].id, { dir });
  } else if (dir < 0 && state.page > 1) {
    state.page--;
    await loadArticles();
    if (state.currentItems.length) openArticle(state.currentItems[state.currentItems.length - 1].id, { dir });
  }
}

function setTelegram(on) {
  state.telegram = on;
  syncTelegramInstagramButton();
}

function setInfographicFilter(mode = 'all') {
  state.infographicFilter = ['posters', 'classic'].includes(mode) ? mode : 'all';
  syncTelegramInstagramButton();
}

function nextInfographicFilter() {
  const order = ['all', 'posters', 'classic'];
  return order[(order.indexOf(state.infographicFilter) + 1) % order.length];
}

function syncTelegramInstagramButton() {
  const infographicMode = state.author === INFOGRAPHICS_AUTHOR;
  const classicMode = infographicMode && state.infographicFilter === 'classic';
  const active = infographicMode ? state.infographicFilter !== 'all' : state.telegram;
  const disabled = infographicMode && currentLayout() === 'list';
  // SVGElement.hidden wird nicht von allen Browsern als reflektiertes HTML-Attribut
  // unterstützt. Das Attribut direkt schalten, damit die CSS-Regel svg[hidden]
  // zuverlässig zwischen Telegram- und Instagram-Symbol wechselt.
  $telegramBtn.querySelector('[data-telegram-icon]')?.toggleAttribute('hidden', infographicMode);
  $telegramBtn.querySelector('[data-instagram-icon]')?.toggleAttribute('hidden', !infographicMode || classicMode);
  $telegramBtn.querySelector('[data-infographic-icon]')?.toggleAttribute('hidden', !classicMode);
  $telegramBtn.classList.toggle('is-instagram', infographicMode);
  $telegramBtn.classList.toggle('active', active);
  $telegramBtn.disabled = disabled;
  $telegramBtn.setAttribute('aria-pressed', String(active));
  $telegramBtn.title = disabled
    ? 'Infografikfilter ist nur in der Kachelansicht verfügbar'
    : infographicMode
    ? ({
      all: 'Nur Instagram-Poster anzeigen',
      posters: 'Nur klassische Infografiken anzeigen',
      classic: 'Alle Infografiken anzeigen',
    }[state.infographicFilter] || 'Alle Infografiken anzeigen')
    : (active ? 'Telegram-Artikel ausblenden' : 'Telegram-Artikel anzeigen');
  $telegramBtn.setAttribute('aria-label', $telegramBtn.title);
  document.body.classList.toggle('mode-instagram-posters', isInstagramPosterMode());
  document.body.classList.toggle('mode-classic-infographics', isClassicInfographicMode());
  document.body.classList.toggle('mode-infographic-review', isInfographicReviewMode());
}

// Lesezeichen-Filter im Header: nur Artikel mit Lesezeichen (Autor/Jahr/Kategorie/Suche gelten weiter).
function setBookmarkFilter(on) {
  state.bookmarks = on;
  $bookmarkBtn.classList.toggle('active', on);
  $bookmarkBtn.setAttribute('aria-pressed', String(on));
  $bookmarkBtn.title = on ? 'Alle Artikel anzeigen' : 'Nur Artikel mit Lesezeichen anzeigen';
}

function authorHue(author) {
  // Bevorzugt der in loadMeta() gleichmäßig über den Farbkreis verteilte Wert
  // (maximal unterscheidbar). Fallback (Meta noch nicht geladen / unbekannter
  // Autor): stabiler Namens-Hash, damit trotzdem ein Farb-Badge entsteht.
  if (author in authorHueMap) return authorHueMap[author];
  let h = 0;
  for (let i = 0; i < author.length; i++) h = (h * 31 + author.charCodeAt(i)) >>> 0;
  return h % 360;
}

function formatDate(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  const months = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
  return `${parseInt(day)}. ${months[parseInt(m) - 1]} ${y}`;
}

function formatMonthYear(d) {
  if (!d) return '';
  const [y, m] = d.split('-');
  const months = ['Januar','Feb.','März','April','Mai','Juni','Juli','Aug.','Sept.','Okt.','Nov.','Dez.'];
  return m && months[parseInt(m) - 1] ? `${months[parseInt(m) - 1]} ${y}` : d;
}

// Kurzform TT.MM.JJJJ für schmale Kacheln auf dem Handy.
function formatDateShort(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return day && m ? `${day}.${m}.${y}` : d;
}

function responsiveDateFormats(d) {
  if (!d) return [''];
  const [y, m] = d.split('-');
  return [
    formatDate(d),
    formatDateShort(d),
    m && y ? `${m}.${y}` : d,
    y || d,
  ].filter((value, index, values) => value && values.indexOf(value) === index);
}

function responsiveDateMarkup(d, className) {
  const formats = responsiveDateFormats(d);
  const full = formats[0] || '';
  return `<span class="${esc(className)} responsive-date" data-date-formats="${esc(JSON.stringify(formats))}" aria-label="${esc(full)}">${esc(full)}</span>`;
}

function sanitizeForId(id) {
  return encodeURIComponent(id);
}

// HTML-Escape für Text und Attributwerte in Templates; auch von den Admin-Skripten
// (z. B. duplicates.js) genutzt. Zahlen bleiben erhalten, null/undefined werden leer.
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

// ── Auth ───────────────────────────────────────────────────────────────────
function showLogin(errorMsg) {
  $loginOverlay.hidden = false;
  document.body.style.overflow = 'hidden';
  $loginEmail.value = '';
  $loginPassword.value = '';
  $loginError.hidden = !errorMsg;
  if (errorMsg) $loginError.textContent = errorMsg;
  requestAnimationFrame(() => $loginEmail.focus());
}

function hideLogin() {
  $loginOverlay.hidden = true;
  document.body.style.overflow = '';
  $loginError.hidden = true;
}

const SVG_ACCOUNT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>';

function applyUserUI(user) {
  adminHooks.userChanged(user);
  const isGuest = !user || user.role === 'guest';
  const isAdmin = user?.role === 'admin';
  if (!isAdmin && isInfographicReviewMode()) infographicReview.reset();
  if (typeof syncBookPrivateAccess === 'function') syncBookPrivateAccess(isAdmin);
  // Gäste bekommen immer die Vorgaben; die Filter-Beschriftungen sind für
  // angemeldete Nutzer lokal pro Nutzer und Gerät gespeichert (settings.js).
  setDisplayUser(user);
  // Aktionen-Button: Admin mit ↺, normaler Nutzer mit Personen-Icon (nur Konto-Einträge).
  $reindexBtn.hidden = isGuest;
  if (isGuest) closeAdminMenu();
  if (isAdmin) {
    if (!$reindexBtn.disabled) $reindexBtn.textContent = '↺';
  } else {
    $reindexBtn.innerHTML = SVG_ACCOUNT;
  }
  $reindexBtn.classList.toggle('is-account', !isGuest && !isAdmin);
  // Lesezeichen gibt es nur für angemeldete Nutzer.
  $bookmarkBtn.hidden = isGuest;
  if (isGuest && state.bookmarks) setBookmarkFilter(false);
  $adminMenu.querySelectorAll('[data-admin-only]').forEach(el => { el.hidden = !isAdmin; });
  if (isAdmin && typeof refreshDuplicateMenuCount === 'function') refreshDuplicateMenuCount();
  document.getElementById('header-menu-account').textContent = isGuest ? '' : `Angemeldet als ${user.email}`;
  $logoutBtn.hidden  = isGuest;
  $loginBtn.hidden   = !isGuest;
}

// Vom Admin verlangte Kennwortänderung: ohne neues Kennwort bleibt nur Abmelden.
async function ensurePasswordChanged() {
  if (!currentUser?.mustChangePassword) return true;
  if (await openPasswordDialog({ forced: true })) return true;
  await logout();
  return false;
}

function clearActiveViewForAccountSwitch() {
  if (typeof closeBookReader === 'function') closeBookReader();
  if (typeof closeBookExtras === 'function') closeBookExtras(false);
  if (!document.getElementById('img-fullscreen').hidden) closeImageFullscreen();
  $overlay.hidden = true;
  $detail.replaceChildren();
  document.body.style.overflow = '';
  currentViewItemId = '';
  lastDetailPosition = null;
  stopAudio();
  stopVideo();
}

async function login(email, password) {
  $loginSubmit.disabled = true;
  $loginBtnText.textContent = '…';
  $loginSpinner.hidden = false;
  $loginError.hidden = true;
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await r.json();
    if (!r.ok) {
      $loginError.textContent = data.error || 'Anmeldung fehlgeschlagen.';
      $loginError.hidden = false;
      $loginEmail.focus();
      return;
    }
    // Die Admin-Shell wird ausschließlich serverseitig erzeugt. Eine neue
    // Navigation ist daher Bestandteil der Anmeldung; der vorhandene Hash
    // bleibt erhalten und wird anschließend wie gewohnt wiederhergestellt.
    if (data.role === 'admin') {
      location.reload();
      return;
    }
    // Die Gastansicht darf weder sichtbar bleiben noch ihren Hash als neuen
    // Deep-Link in die persönliche Sitzungsansicht hinübertragen.
    clearActiveViewForAccountSwitch();
    currentUser = data;
    hideLogin();
    applyUserUI(currentUser);
    if (!(await ensurePasswordChanged())) return;
    await restoreSessionView({ explicitDeepLink: pendingLoginDeepLink });
    pendingLoginDeepLink = null;
  } catch {
    $loginError.textContent = 'Netzwerkfehler. Bitte erneut versuchen.';
    $loginError.hidden = false;
  } finally {
    $loginSubmit.disabled = false;
    $loginBtnText.textContent = 'Anmelden';
    $loginSpinner.hidden = true;
  }
}

async function logout() {
  const wasAdmin = currentUser?.role === 'admin';
  // Hörposition vor dem Abmelden sichern und Wiedergabe beenden.
  if (typeof bookPlayerClose === 'function') await bookPlayerClose();
  clearActiveViewForAccountSwitch();
  infographicReview.reset();
  clearCurrentViewState(currentUser);
  pendingLoginDeepLink = null;
  history.replaceState(APP_VIEW_HISTORY_STATE, '', '#/');
  try { await fetch('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
  if (wasAdmin) {
    location.reload();
    return;
  }
  // Auf Guest-User umstellen (oder null, falls keine Public-Autoren konfiguriert)
  try {
    const r = await fetch('/api/me');
    currentUser = r.ok ? await r.json() : null;
  } catch { currentUser = null; }
  applyUserUI(currentUser);
  $app.innerHTML = '';
  [$filterAuthor, $filterYear, $filterCategory].forEach(sel => {
    while (sel.options.length > 1) sel.remove(1);
  });
  Object.assign(state, {
    q: '', author: '', externalAudio: false, year: '', category: '', telegram: false,
    infographicFilter: 'all', bookmarks: false, page: 1, limit: 24, bookSort: 'recent',
    gridCardWidths: { square: null, tall: null },
  });
  currentViewItemId = '';
  lastListPosition = null;
  lastDetailPosition = null;
  $searchInput.value = '';
  $searchClear.classList.remove('visible');
  setTelegram(false);
  setInfographicFilter('all');
  setBookmarkFilter(false);
  setLayout('tall');
  $filterLimit.value = '24';
  const bookSort = document.getElementById('filter-book-sort');
  if (bookSort) bookSort.value = 'recent';
  applyBookMode();
  $filterAuthor.value = '';
  $filterYear.value = '';
  $filterCategory.value = '';
  [$filterAuthor, $filterYear, $filterCategory, $filterLimit, bookSort]
    .forEach(select => select && syncFilterAriaMenu(select));
  if (currentUser) {
    await loadMeta();
    await loadArticles();
    saveCurrentViewState();
  } else {
    showLogin();
  }
}

// ── API calls ──────────────────────────────────────────────────────────────
async function apiFetch(url, options) {
  const init = { ...(options || {}) };
  const method = String(init.method || 'GET').toUpperCase();
  const requestUrl = new URL(url, location.href);
  const csrf = document.querySelector('meta[name="admin-csrf-token"]')?.content;
  if (csrf && requestUrl.origin === location.origin && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    init.headers = { ...(init.headers || {}), 'X-CSRF-Token': csrf };
  }
  const r = await fetch(url, init);
  if (r.status === 401) {
    currentUser = null;
    location.reload();
    throw Object.assign(new Error('Die Sitzung ist abgelaufen.'), { code: 'session_expired' });
  }
  if (r.status === 403 && currentUser && currentUser.role !== 'guest') {
    const data = await r.clone().json().catch(() => null);
    // Abgelaufene Admin-Rechte erkennt der feste Code, nicht der Meldungstext.
    if (data?.code === 'admin_required') {
      location.reload();
      throw Object.assign(new Error('Die Admin-Sitzung ist abgelaufen.'), { code: 'session_expired' });
    }
    // Das Sicherheitstoken der geladenen Seite passt nicht mehr zur Sitzung (z. B.
    // nach erneuter Anmeldung in einem anderen Tab): neu laden holt ein frisches.
    if (data?.code === 'csrf_invalid') {
      location.reload();
      throw Object.assign(new Error('Die Seite war veraltet und wird neu geladen. Bitte die Aktion wiederholen.'),
        { code: 'session_expired' });
    }
    if (data?.code === 'password_change_required') {
      currentUser = { ...currentUser, mustChangePassword: true };
      ensurePasswordChanged().then(ok => { if (ok) { loadMeta(); loadArticles(); } });
      throw Object.assign(new Error('Bitte zuerst ein neues Kennwort festlegen.'), { code: 'password_change_required' });
    }
  }
  return r;
}

async function fetchMeta() {
  const r = await apiFetch('/api/meta');
  return r.json();
}

async function fetchArticles(params = {}) {
  const qs = new URLSearchParams();
  if (params.q)        qs.set('q', params.q);
  if (params.author)   qs.set('author', params.author);
  if (params.externalAudio) qs.set('externalAudio', '1');
  if (params.year)     qs.set('year', params.year);
  if (params.category) qs.set('category', params.category);
  if (params.telegram) qs.set('telegram', '1');
  if (params.infographicFilter === 'posters') qs.set('infographic', 'poster');
  else if (params.infographicFilter === 'classic') qs.set('infographic', 'classic');
  if (params.infographicReview) qs.set('infographicReview', '1');
  if (params.bookmarks) qs.set('bookmarks', '1');
  if (params.group)    qs.set('group', '1');
  qs.set('page',  params.page  || 1);
  qs.set('limit', params.limit || 24);
  const r = await apiFetch(`/api/articles?${qs}`);
  return r.json();
}

async function fetchArticle(id) {
  const base = isAudiobookId(id) ? '/api/audiobooks/' : '/api/articles/';
  const r = await apiFetch(base + String(id).split('/').map(encodeURIComponent).join('/'));
  if (!r.ok) {
    const err = new Error('Nicht gefunden.');
    err.status = r.status;
    throw err;
  }
  return r.json();
}

async function uploadInfographic(article, file) {
  const lowerName = file.name.toLowerCase();
  const isPng = file.type === 'image/png' || lowerName.endsWith('.png');
  const isJpeg = file.type === 'image/jpeg' || lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg');
  const contentType = isPng ? 'image/png' : (isJpeg ? 'image/jpeg' : '');

  if (!contentType) throw new Error('Bitte eine PNG- oder JPG-Datei auswählen.');
  if (file.size > INFOGRAPHIC_MAX_BYTES) throw new Error('Die Bilddatei ist größer als 10 MB.');

  const r = await apiFetch(`/api/infographics/${sanitizeForId(article.id)}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: file,
  });
  let data = {};
  try { data = await r.json(); } catch { /* ignore */ }
  if (!r.ok) throw new Error(data.error || 'Infografik konnte nicht gespeichert werden.');
  return data;
}

// ── Rendering ──────────────────────────────────────────────────────────────
function renderCard(article, idx) {
  const author = article.displayAuthor || article.author;
  const hue = authorHue(author);
  const cats = (article.categories || []).slice(0, 5);
  const delay = Math.min(idx * 30, 300);

  const gallery = article.images?.length > 1;
  const imageHtml = gallery
    ? renderCardGallery(article.images)
    : article.imageUrl
    ? `<img src="${esc(article.imageUrl)}" alt="" loading="lazy" data-fallback />`
    : `<div class="card-image-placeholder">${svgImage()}</div>`;

  const audioBadge = article.audioUrl
    ? `<div class="card-audio-badge">${svgHeadphones()}<span>Audio</span></div>`
    : '';
  const videoBadge = article.videoUrl
    ? `<div class="card-video-badge">&#9654; Video</div>`
    : '';
  const pdfBadge = article.pdfUrl
    ? `<div class="card-pdf-badge">&#9993; PDF</div>`
    : '';

  const catPills = cats.map(c =>
    `<span class="cat-pill">${esc(c)}</span>`
  ).join('');

  const epNum = article.episodeNum ? `<span class="episode-num">#${article.episodeNum}</span>` : '';

  return `
    <article class="card" data-id="${esc(article.id)}" data-author="${esc(article.author)}" style="animation-delay:${delay}ms" tabindex="0" role="button" aria-label="${esc(article.title)}">
      <div class="card-image${gallery ? ' card-gallery' : ''}${!gallery && article.images?.[0]?.kind === 'infographic' ? ' is-infographic' : ''}">
        ${imageHtml}
        <span class="card-bookmark" title="Lesezeichen" aria-label="Lesezeichen"${article.bookmarked ? '' : ' hidden'}>${svgBookmark()}</span>
        ${audioBadge || videoBadge || pdfBadge
          ? `<div class="card-badges">${audioBadge}${videoBadge}${pdfBadge}</div>`
          : ''}
      </div>
      <div class="card-body">
        <div class="card-meta">
          <span class="author-badge" style="--author-hue:${hue}">${esc(author.replace(/_/g,' '))}</span>
          ${responsiveDateMarkup(article.date, 'card-date')}
          ${epNum}
        </div>
        <h2 class="card-title">${esc(article.title)}</h2>
        ${catPills ? `<div class="card-categories">${catPills}</div>` : ''}
        <p class="card-preview">${esc(article.preview || article.excerpt)}</p>
      </div>
    </article>`;
}

function renderInstagramPosterCard(poster, idx) {
  const author = poster.displayAuthor || INFOGRAPHICS_AUTHOR;
  const hue = authorHue(author);
  const delay = Math.min(idx * 30, 300);
  const date = formatDate(poster.date);
  const classic = isClassicInfographicMode();
  const label = [classic ? 'Infografik' : 'Instagram-Poster', 'von ' + author, date].filter(Boolean).join(' ');
  return `
    <article class="card instagram-poster-card${classic ? ' classic-infographic-card' : ''}" data-id="${esc(poster.id)}" data-poster-index="${idx}"
      style="animation-delay:${delay}ms" tabindex="0" role="button" aria-label="${esc(label)}">
      <div class="instagram-poster-image">
        <img src="${esc(poster.imageUrl)}" alt="" loading="lazy" data-fallback />
        <span class="instagram-poster-badge instagram-poster-author" style="--author-hue:${hue}">${esc(author.replace(/_/g, ' '))}</span>
        ${responsiveDateMarkup(poster.date, 'instagram-poster-badge instagram-poster-date')}
      </div>
    </article>`;
}

// WebKit zeichnet das Auslassungszeichen von line-clamp nicht zuverlässig,
// wenn die Vorschau zusätzlich durch die feste Kachelhöhe verkleinert wird.
// Deshalb erkennen wir den tatsächlichen Überlauf und blenden einen eigenen,
// immer sichtbaren Abschluss ein.
function updateCardPreviewTruncation() {
  if (cardPreviewFrame) cancelAnimationFrame(cardPreviewFrame);
  cardPreviewFrame = requestAnimationFrame(() => {
    cardPreviewFrame = 0;
    $app.querySelectorAll('.card-preview').forEach(preview => {
      preview.classList.remove('is-truncated');
      if (!preview.getClientRects().length || !preview.clientHeight) return;
      preview.classList.toggle('is-truncated', preview.scrollHeight > preview.clientHeight + 1);
    });
  });
}

function watchCardPreviews() {
  cardPreviewObserver?.disconnect();
  const previews = [...$app.querySelectorAll('.card-preview')];
  if (typeof ResizeObserver !== 'undefined') {
    if (!cardPreviewObserver) cardPreviewObserver = new ResizeObserver(updateCardPreviewTruncation);
    previews.forEach(preview => cardPreviewObserver.observe(preview));
  }
  updateCardPreviewTruncation();
}

function responsiveDateFits(date) {
  if (date.classList.contains('instagram-poster-date')) {
    return date.scrollWidth <= date.clientWidth + 1;
  }
  const meta = date.closest('.card-meta');
  if (!meta) return date.scrollWidth <= date.clientWidth + 1;
  const siblings = [...meta.children].filter(element => element !== date
    && element.getClientRects().length && getComputedStyle(element).display !== 'none');
  const style = getComputedStyle(meta);
  const gap = parseFloat(style.columnGap || style.gap) || 0;
  const available = meta.clientWidth
    - siblings.reduce((sum, element) => sum + element.getBoundingClientRect().width, 0)
    - gap * siblings.length;
  return date.scrollWidth <= available + 1;
}

function updateResponsiveDates() {
  if (responsiveDateFrame) cancelAnimationFrame(responsiveDateFrame);
  responsiveDateFrame = requestAnimationFrame(() => {
    responsiveDateFrame = 0;
    $app.querySelectorAll('.responsive-date').forEach(date => {
      let formats;
      try { formats = JSON.parse(date.dataset.dateFormats || '[]'); }
      catch { formats = []; }
      for (const [index, format] of formats.entries()) {
        date.textContent = format;
        if (responsiveDateFits(date) || index === formats.length - 1) break;
      }
    });
  });
}

function watchResponsiveDates() {
  responsiveDateObserver?.disconnect();
  const containers = [...$app.querySelectorAll('.card-meta, .instagram-poster-image')];
  if (typeof ResizeObserver !== 'undefined') {
    if (!responsiveDateObserver) responsiveDateObserver = new ResizeObserver(updateResponsiveDates);
    containers.forEach(container => responsiveDateObserver.observe(container));
  }
  updateResponsiveDates();
}

// Bildbereich einer Kachel mit mehreren Bildern (Artikel + Infografiken):
// Desktop wählt das Bild über die Mausposition, Touch per Wischen; Striche zeigen
// Anzahl und aktuelles Bild. Weitere Bilder werden erst bei Bedarf geladen.
function renderCardGallery(images) {
  const slides = images.map((image, i) => {
    const src = i === 0 ? `src="${esc(image.url)}"` : `data-src="${esc(image.url)}"`;
    return `<div class="card-gallery-slide${image.kind === 'infographic' ? ' is-infographic' : ''}"><img ${src} alt="" loading="lazy" data-fallback /></div>`;
  }).join('');
  const dots = images.map((_, i) => `<span${i === 0 ? ' class="active"' : ''}></span>`).join('');
  return `<div class="card-gallery-track">${slides}</div><div class="card-gallery-dots" aria-hidden="true">${dots}</div>`;
}

function wireCardGallery(card) {
  const gallery = card.querySelector('.card-gallery');
  if (!gallery) return;
  const track = gallery.querySelector('.card-gallery-track');
  const dots = [...gallery.querySelectorAll('.card-gallery-dots span')];
  let index = 0;
  const loadAll = () => gallery.querySelectorAll('img[data-src]').forEach(img => {
    img.src = img.dataset.src;
    img.removeAttribute('data-src');
  });
  const show = next => {
    index = Math.max(0, Math.min(dots.length - 1, next));
    track.style.transform = `translateX(${-100 * index}%)`;
    dots.forEach((dot, i) => dot.classList.toggle('active', i === index));
  };
  gallery.addEventListener('mousemove', e => {
    if (!isDesktopPointer()) return;
    loadAll();
    const box = gallery.getBoundingClientRect();
    show(Math.floor((e.clientX - box.left) / box.width * dots.length));
  });
  gallery.addEventListener('mouseleave', () => show(0));
  let startX = 0, startY = 0, multi = false;
  gallery.addEventListener('touchstart', e => {
    loadAll();
    multi = e.touches.length > 1;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });
  gallery.addEventListener('touchend', e => {
    if (multi || gridInteractionSuppressed()) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) < 30 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    // Reicht die Bewegung bis an den gegenüberliegenden Fensterrand, gehört
    // sie der Ergebnisseite. Kürzere Bewegungen blättern weiterhin die Galerie.
    if (pageSwipeMath?.pageDirection({
      startX,
      startY,
      endX: e.changedTouches[0].clientX,
      endY: e.changedTouches[0].clientY,
      viewportWidth: pageSwipeViewportWidth(),
    })) return;
    // Über das Ende hinaus geht es beim ersten Bild weiter (und umgekehrt).
    show((index + (dx < 0 ? 1 : -1) + dots.length) % dots.length);
    card.dataset.swipedAt = String(Date.now());
  }, { passive: true });
}

function renderGrid(items) {
  if (isInfographicReviewMode()) {
    if (!items.length) {
      return `<div class="empty-state">
        ${svgSearch()}
        <h2>Keine Infografiken gefunden</h2>
        <p>Zu den gewählten Filtern sind keine Grafiken vorhanden.</p>
      </div>`;
    }
    return `<div class="article-grid instagram-poster-grid infographic-review-grid">${items.map(infographicReview.renderCard).join('')}</div>`;
  }
  if (isInstagramPosterMode() || isClassicInfographicMode()) {
    const classic = isClassicInfographicMode();
    if (!items.length) {
      return `<div class="empty-state">
        ${svgSearch()}
        <h2>${classic ? 'Keine klassischen Infografiken' : 'Keine Instagram-Poster'} gefunden</h2>
        <p>${classic
          ? 'Zu den gewählten Filtern sind keine klassischen Infografiken vorhanden.'
          : 'Zu den gewählten Filtern sind keine markierten Poster vorhanden.'}</p>
      </div>`;
    }
    return `<div class="article-grid instagram-poster-grid${classic ? ' classic-infographic-grid' : ''}">${items.map(renderInstagramPosterCard).join('')}</div>`;
  }
  if (!items.length && state.bookmarks) {
    const filtered = state.q || state.author || state.externalAudio || state.year || state.category;
    return `<div class="empty-state">
      ${svgBookmark()}
      <h2>${filtered ? 'Keine Lesezeichen gefunden' : 'Noch keine Lesezeichen'}</h2>
      <p>${filtered
        ? 'Zu diesen Filtern gibt es keine Artikel mit Lesezeichen.'
        : 'Im Artikel setzt das Lesezeichen-Symbol neben „Teilen“ ein Lesezeichen.'}</p>
    </div>`;
  }
  if (!items.length) {
    return `<div class="empty-state">
      ${svgSearch()}
      <h2>Keine Artikel gefunden</h2>
      <p>Versuche andere Suchbegriffe oder Filter.</p>
    </div>`;
  }
  return `<div class="article-grid">${items.map((a, i) => renderCard(a, i)).join('')}</div>`;
}

function renderPagination(page, pages) {
  if (pages <= 1) return '';

  const btns = [];
  btns.push(`<button class="page-btn page-btn-nav" data-page="${page - 1}" aria-label="Vorherige Seite" title="Vorherige Seite" ${page === 1 ? 'disabled' : ''}>‹<span class="page-btn-label"> Zurück</span></button>`);

  const range = new Set([1, pages, page - 1, page, page + 1].filter(p => p >= 1 && p <= pages));
  const sorted = [...range].sort((a,b) => a-b);
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) btns.push('<span class="page-btn page-ellipsis" aria-hidden="true">…</span>');
    btns.push(`<button class="page-btn${p === page ? ' active' : ''}" data-page="${p}">${p}</button>`);
    prev = p;
  }

  btns.push(`<button class="page-btn page-btn-nav" data-page="${page + 1}" aria-label="Nächste Seite" title="Nächste Seite" ${page === pages ? 'disabled' : ''}><span class="page-btn-label">Weiter </span>›</button>`);
  return `<div class="pagination">${btns.join('')}</div>`;
}

// ── Load & display articles ────────────────────────────────────────────────
// Zum Anfang der Ergebnisliste scrollen: erste Kachel direkt unter der
// (klebenden) Filterleiste, unabhängig von deren Höhe auf Desktop oder Handy.
function scrollToResults(behavior = 'smooth') {
  navigationVisibleUntil = Date.now() + (behavior === 'smooth' ? 700 : 100);
  showNavigationChrome(true);
  const bar = document.querySelector('.filter-bar');
  const covered = $navigationChrome?.offsetHeight || bar?.offsetHeight || 0;
  const top = window.scrollY + $app.getBoundingClientRect().top - covered;
  window.scrollTo({ top: Math.max(0, top), behavior });
}

// Seitenbuttons, Wischgesten und Pfeiltasten verwenden denselben Weg, damit Seite,
// Scrollposition und gespeicherter Sitzungszustand nicht auseinanderlaufen.
async function changeResultsPage(page, behavior = 'smooth') {
  const target = Math.max(1, Math.min(state.pages, Number(page)));
  if (!Number.isInteger(target) || target === state.page || state.loading) return false;
  state.page = target;
  await loadArticles();
  scrollToResults(behavior);
  await nextPaint();
  lastListPosition = captureListPosition();
  saveCurrentViewState();
  return true;
}

async function loadArticles() {
  updateResetFiltersVisibility();
  if (state.loading) return;
  state.loading = true;

  try {
    const bookMode = isBookMode();
    const data = bookMode ? await fetchAudiobooks() : await fetchArticles({
      q:        state.q,
      author:   state.author,
      externalAudio: state.externalAudio,
      year:     state.year,
      category: state.category,
      telegram: state.telegram,
      infographicFilter: state.author === INFOGRAPHICS_AUTHOR ? state.infographicFilter : 'all',
      infographicReview: isInfographicReviewMode(),
      bookmarks: state.bookmarks,
      group:    groupMode(),
      page:     state.page,
      limit:    state.limit,
    });

    state.total = data.total;
    state.pages = data.pages;
    state.currentItems = data.items;
    if (isInfographicReviewMode()) infographicReview.remember(data.items);

    const resultLabel = bookMode
      ? (data.total === 1 ? 'Hörbuch' : 'Hörbücher')
      : (isInfographicReviewMode()
        ? (data.total === 1 ? 'Grafik' : 'Grafiken')
        : (isInstagramPosterMode()
          ? 'Poster'
          : (isClassicInfographicMode() ? (data.total === 1 ? 'Infografik' : 'Infografiken') : 'Artikel')));
    $count.textContent = `${data.total.toLocaleString('de-DE')} ${resultLabel}`;
    $app.innerHTML = (bookMode ? renderBookGrid(data.items) : renderGrid(data.items)) + renderPagination(state.page, state.pages);
    applyGridColumns();
    watchCardPreviews();
    watchResponsiveDates();

    // Attach card click handlers
    $app.querySelectorAll('.card').forEach(card => {
      const posterIndex = card.dataset.posterIndex;
      if (card.classList.contains('infographic-review-card')) {
        const openButton = card.querySelector('.infographic-review-image');
        openButton?.addEventListener('click', () => openGalleryFullscreen(
          state.currentItems.map(item => item.imageUrl),
          Number(posterIndex), null, true, openButton,
          state.currentItems.map(item => item.id),
        ));
        card.querySelector('[data-review-poster-id]')?.addEventListener('change', event => {
          infographicReview.mark(event.currentTarget.dataset.reviewPosterId, event.currentTarget.checked);
        });
        return;
      }
      const handler = posterIndex === undefined
        ? () => openArticle(card.dataset.id)
        : () => openGalleryFullscreen(
          state.currentItems.map(item => item.imageUrl).filter(Boolean),
          Number(posterIndex), null, true, card,
        );
      wireCardGallery(card);
      card.addEventListener('click', () => {
        // Ein Wischen durch die Bilder der Kachel öffnet den Artikel nicht.
        if (gridInteractionSuppressed() || Date.now() - (Number(card.dataset.swipedAt) || 0) < 500) return;
        handler();
      });
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
      });
    });

    // Attach pagination handlers
    $app.querySelectorAll('.page-btn[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = parseInt(btn.dataset.page);
        if (p !== state.page) void changeResultsPage(p);
      });
    });

    if (!restoringSessionView && !isInfographicReviewMode()) scheduleCurrentViewSave();

  } catch (err) {
    $app.innerHTML = `<div class="empty-state"><p>Fehler beim Laden: ${esc(err.message)}</p></div>`;
  } finally {
    state.loading = false;
  }
}

// ── Meta / filter population ───────────────────────────────────────────────
async function loadMeta() {
  const { authors, years, categories } = await fetchMeta();

  // Keep only the first "Alle…" option, remove any previously added dynamic entries
  [$filterAuthor, $filterYear, $filterCategory].forEach(sel => {
    while (sel.options.length > 1) sel.remove(1);
  });

  // Badge-Farbton je Autor gleichmäßig über den Farbkreis verteilen (Reihenfolge
  // = alphabetische Serverliste) -> jeder Autor gut sichtbar und unterscheidbar.
  authorHueMap = {};
  const hueStep = 360 / (authors.length || 1);
  const audioOpt = document.createElement('option');
  audioOpt.value = '__external_audio__';
  audioOpt.textContent = 'mit Audio';
  $filterAuthor.appendChild(audioOpt);

  authors.forEach((a, i) => { authorHueMap[a] = Math.round(i * hueStep); });
  // „Hörbücher“ direkt unter „mit Audio“, danach die übrigen Autoren alphabetisch.
  const ordered = [...authors.filter(a => a === AUDIOBOOK_AUTHOR), ...authors.filter(a => a !== AUDIOBOOK_AUTHOR)];
  ordered.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a;
    opt.textContent = a.replace(/_/g, ' ');
    $filterAuthor.appendChild(opt);
  });

  years.forEach(y => {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    $filterYear.appendChild(opt);
  });

  categories.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    $filterCategory.appendChild(opt);
  });
  // Beim Neuaufbau der Metadaten (z. B. nach einem Reindex) setzt der Browser
  // die Selects zunächst auf den ersten Eintrag zurück. Den weiterhin gültigen
  // Anwendungszustand erneut anwenden, bevor daraus die ARIA-Menüs entstehen.
  applySavedFilterControls();
  requestAnimationFrame(updateFilterLabelLayout);
}

function applySavedListState(saved) {
  if (!saved) return;
  Object.assign(state, saved.list);
  // Der Infografik-Filter ist bewusst nur temporär und wird nie wiederhergestellt.
  state.infographicFilter = 'all';
  $searchInput.value = state.q;
  $searchClear.classList.toggle('visible', !!state.q);
  setTelegram(state.telegram);
  setBookmarkFilter(state.bookmarks);
  setLayout(state.layout);
  if ([...$filterLimit.options].some(option => Number(option.value) === state.limit)) {
    $filterLimit.value = String(state.limit);
  } else {
    state.limit = 24;
    $filterLimit.value = '24';
  }
  const bookSort = document.getElementById('filter-book-sort');
  if (bookSort) bookSort.value = state.bookSort;
  [$filterLimit, bookSort].forEach(select => select && syncFilterAriaMenu(select));
}

function applySavedFilterControls() {
  const authorValue = state.externalAudio ? '__external_audio__' : state.author;
  if ([...$filterAuthor.options].some(option => option.value === authorValue)) {
    $filterAuthor.value = authorValue;
  } else {
    state.author = '';
    state.externalAudio = false;
    $filterAuthor.value = '';
  }
  for (const [select, key] of [[$filterYear, 'year'], [$filterCategory, 'category']]) {
    if ([...select.options].some(option => option.value === state[key])) select.value = state[key];
    else { state[key] = ''; select.value = ''; }
  }
  [$filterAuthor, $filterYear, $filterCategory].forEach(syncFilterAriaMenu);
  applyBookMode();
}

async function restoreSessionView({ explicitDeepLink = null } = {}) {
  // Ein neues Konto ohne Speicherstand startet mit Standardfiltern, nicht mit
  // den gerade sichtbaren Gastfiltern.
  const saved = sessionViewStore?.load(deviceStorage(), currentUser)
    || sessionViewStore?.normalize({ version: sessionViewStore.VERSION });
  restoringSessionView = true;
  try {
    applySavedListState(saved);
    await loadMeta();
    applySavedFilterControls();
    await loadArticles();

    // Eine inzwischen kürzere Ergebnismenge darf nicht auf einer leeren alten Seite landen.
    if (state.pages > 0 && state.page > state.pages) {
      state.page = state.pages;
      await loadArticles();
    }

    lastListPosition = saved?.view.listPosition || null;
    await restoreListPosition(lastListPosition);

    const target = explicitDeepLink || (saved?.view.kind !== 'list' && saved?.view.itemId
      ? { id: saved.view.itemId, image: null }
      : null);
    if (target) {
      const restoresSavedView = !!saved?.view.itemId && saved.view.itemId === target.id;
      const restored = await openArticle(target.id, {
        image: target.image,
        deepLink: !!explicitDeepLink,
        historyMode: 'replace',
        detailPosition: restoresSavedView ? saved?.view.detailPosition : null,
        restoring: true,
      });
      if (restored && restoresSavedView && saved?.view.kind === 'reader'
          && typeof currentBookDetail !== 'undefined' && currentBookDetail
          && typeof openBookReader === 'function') {
        const extraFile = saved.view.readerExtraFile || '';
        const extras = extraFile && typeof fetchBookExtras === 'function'
          ? await fetchBookExtras(currentBookDetail).catch(() => [])
          : [];
        const readerExtra = extras.find(extra => extra.type === 'markdown' && extra.file === extraFile);
        if (readerExtra) {
          // Beim Schließen des Texts soll wieder die Extras-Auswahl sichtbar sein,
          // genau wie vor dem Neuladen.
          if (typeof openBookExtras === 'function') await openBookExtras(currentBookDetail, extras);
          await openBookReader(currentBookDetail, readerExtra);
        } else if (!extraFile && currentBookDetail.ebook) {
          await openBookReader(currentBookDetail);
        }
      }
    } else if (!explicitDeepLink) {
      history.replaceState(APP_VIEW_HISTORY_STATE, '', '#/');
    }
  } finally {
    restoringSessionView = false;
    saveCurrentViewState();
  }
}

// ── Event wiring ───────────────────────────────────────────────────────────
let searchTimer = null;
$searchInput.addEventListener('input', () => {
  const val = $searchInput.value.trim();
  $searchClear.classList.toggle('visible', val.length > 0);
  state.q = val;
  updateResetFiltersVisibility();
  state.page = 1;
  scheduleCurrentViewSave();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    loadArticles();
  }, 300);
});

$searchClear.addEventListener('click', () => {
  $searchInput.value = '';
  $searchClear.classList.remove('visible');
  state.q = '';
  state.page = 1;
  loadArticles();
});

// Hörbuch-Ansicht: Jahr/Kategorie ausblenden, Sortierung einblenden.
function applyBookMode() {
  document.body.classList.toggle('mode-audiobooks', isBookMode());
  syncTelegramInstagramButton();
  requestAnimationFrame(updateFilterLabelLayout);
}

$filterAuthor.addEventListener('change', async () => {
  restoringSessionView = true;
  const previousAuthor = state.author;
  state.externalAudio = $filterAuthor.value === '__external_audio__';
  state.author = state.externalAudio ? '' : $filterAuthor.value;
  if (previousAuthor !== state.author) setInfographicFilter('all');
  if (state.author === 'Telegram') setTelegram(true);
  applyBookMode();
  state.page = 1;
  lastListPosition = null;
  try {
    await loadArticles();
    scrollToResults('auto');
    await nextPaint();
    lastListPosition = captureListPosition();
  } finally {
    restoringSessionView = false;
    saveCurrentViewState();
  }
});

$filterYear.addEventListener('change', () => {
  state.year = $filterYear.value;
  state.page = 1;
  loadArticles();
});

$filterCategory.addEventListener('change', () => {
  state.category = $filterCategory.value;
  state.page = 1;
  loadArticles();
});

// Ansicht quadratisch/länglich/Liste als Piktogramm-Umschalter (Radio-Gruppe).
const LAYOUTS = ['square', 'tall', 'list'];
const GRID_MIN_COLUMNS = 1;
const GRID_MAX_COLUMNS = 8;
const GRID_MIN_CARD_WIDTH = 110;
const GRID_MAX_CARD_WIDTH = 1920;
const GRID_PINCH_THRESHOLD = 0.12;
const GRID_CLICK_SUPPRESS_MS = 500;
// Deutlich getrennte Stufen: Auf einem typischen Handy passen bei normaler
// Höhe etwa 7–8, danach ungefähr 5 beziehungsweise 3 Zeilen ins Hochformat.
const LIST_ROW_SCALES = [0.7, 1, 1.55, 2.4];
const LIST_ROW_SCALE_LABELS = ['Kompakt', 'Normal', 'Groß', 'Sehr groß'];
// Einmal beim Laden festlegen, nicht bei resize/orientationchange neu bestimmen.
// So bleibt dieselbe Größenstufe beim Drehen pixelgenau gleich hoch.
const LIST_ROW_BASE_HEIGHT = window.matchMedia('(max-width: 600px)').matches ? 64 : 120;
let listRowScale = (() => {
  try {
    const stored = Number(localStorage.getItem('wa-list-row-scale'));
    if (Number.isFinite(stored)) {
      return LIST_ROW_SCALES.reduce((nearest, scale) => (
        Math.abs(scale - stored) < Math.abs(nearest - stored) ? scale : nearest
      ), LIST_ROW_SCALES[0]);
    }
  } catch { /* Speicher gesperrt */ }
  return 1;
})();
function applyListRowHeight() {
  // Fertige Längen statt calc(px * Faktor): Diese Multiplikation wird von
  // mehreren mobilen Browsern verworfen und ließ die Zeile praktisch unverändert.
  document.body.style.setProperty(
    '--list-row-height',
    `${Math.round(LIST_ROW_BASE_HEIGHT * listRowScale)}px`,
  );
}
applyListRowHeight();
let gridClickSuppressedUntil = 0;
let gridTouchGesture = null;
let pageSwipeGesture = null;
let gridDensityStatusTimer = null;
let gridWheelTotal = 0;
let gridWheelResetTimer = null;
let gridWheelLastStep = 0;

function gridInteractionSuppressed() {
  return !!gridTouchGesture || Date.now() < gridClickSuppressedUntil;
}

function gridForTouch(touch) {
  const target = touch?.target?.nodeType === Node.ELEMENT_NODE
    ? touch.target
    : touch?.target?.parentElement;
  return target?.closest?.('.article-grid') || null;
}

function touchInsideGrid(touch, grid) {
  if (!touch || !grid) return false;
  const rect = grid.getBoundingClientRect();
  return touch.clientX >= rect.left && touch.clientX <= rect.right
    && touch.clientY >= rect.top && touch.clientY <= rect.bottom;
}

function touchDistance(first, second) {
  return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
}

function pageSwipeViewportWidth() {
  return window.visualViewport?.width || document.documentElement.clientWidth || window.innerWidth;
}

function pageSwipeBlockedTarget(target) {
  return !!target?.closest?.('a, button, input, select, textarea, [contenteditable="true"]');
}

function maxGridColumns(grid) {
  if (!grid) return GRID_MAX_COLUMNS;
  return gridDensityMath.maxColumns(grid.clientWidth, gridGap(grid), {
    minColumns: GRID_MIN_COLUMNS,
    maxColumns: GRID_MAX_COLUMNS,
    minCardWidth: GRID_MIN_CARD_WIDTH,
  });
}

function gridGap(grid) {
  return parseFloat(getComputedStyle(grid).columnGap) || 0;
}

function cardWidthForColumns(grid, columns) {
  return gridDensityMath.cardWidthForColumns(grid.clientWidth, gridGap(grid), columns);
}

function columnsForCardWidth(grid, preferredWidth) {
  return gridDensityMath.columnsForCardWidth(grid.clientWidth, gridGap(grid), preferredWidth, {
    minColumns: GRID_MIN_COLUMNS,
    maxColumns: GRID_MAX_COLUMNS,
    minCardWidth: GRID_MIN_CARD_WIDTH,
  });
}

function currentGridColumns(grid = $app.querySelector('.article-grid')) {
  if (!grid) return null;
  const tracks = getComputedStyle(grid).gridTemplateColumns
    .split(' ')
    .filter(Boolean);
  return tracks.length || null;
}

function applyGridColumns() {
  const layout = currentLayout();
  if (layout === 'list') {
    document.body.style.removeProperty('--grid-columns');
    return;
  }
  const grid = $app.querySelector('.article-grid');
  if (!grid) {
    document.body.style.removeProperty('--grid-columns');
    return;
  }
  let preferredWidth = state.gridCardWidths?.[layout];
  if (!Number.isFinite(preferredWidth)) {
    // Schon die vom responsiven CSS vorgegebene Ausgangsbreite merken. Sonst
    // kann erst eine manuelle Pinch-/Mausradänderung die Breite beim ersten
    // Wechsel zwischen Hoch- und Querformat stabilisieren.
    const current = currentGridColumns(grid);
    if (!current) {
      document.body.style.removeProperty('--grid-columns');
      return;
    }
    preferredWidth = Math.max(GRID_MIN_CARD_WIDTH, Math.min(
      GRID_MAX_CARD_WIDTH,
      cardWidthForColumns(grid, current),
    ));
    preferredWidth = Math.round(preferredWidth * 10) / 10;
    state.gridCardWidths = { ...state.gridCardWidths, [layout]: preferredWidth };
    scheduleCurrentViewSave();
  }
  const effective = columnsForCardWidth(grid, preferredWidth);
  document.body.style.setProperty('--grid-columns', String(effective));
}

function showGridDensityStatus(columns) {
  if (!$gridDensityStatus || !columns) return;
  $gridDensityStatus.textContent = columns === 1 ? '1 Spalte' : `${columns} Spalten`;
  $gridDensityStatus.classList.add('is-visible');
  clearTimeout(gridDensityStatusTimer);
  gridDensityStatusTimer = setTimeout(() => {
    $gridDensityStatus.classList.remove('is-visible');
  }, 900);
}

function showListRowHeightStatus() {
  if (!$gridDensityStatus) return;
  const index = LIST_ROW_SCALES.indexOf(listRowScale);
  $gridDensityStatus.textContent = `Zeilenhöhe: ${LIST_ROW_SCALE_LABELS[index]}`;
  $gridDensityStatus.classList.add('is-visible');
  clearTimeout(gridDensityStatusTimer);
  gridDensityStatusTimer = setTimeout(() => {
    $gridDensityStatus.classList.remove('is-visible');
  }, 900);
}

function captureListScaleAnchor(clientX, clientY) {
  const target = document.elementFromPoint?.(clientX, clientY);
  const card = target?.closest?.('.card[data-id]');
  if (!card) return null;
  const rect = card.getBoundingClientRect();
  if (rect.height <= 0) return null;
  return {
    id: card.dataset.id,
    viewportY: clientY,
    ratio: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
  };
}

function restoreListScaleAnchor(anchor) {
  if (!anchor) return false;
  const card = [...$app.querySelectorAll('.card[data-id]')]
    .find(candidate => candidate.dataset.id === anchor.id);
  if (!card) return false;
  // Dieser Layout-Lesezugriff erzwingt die Neuberechnung direkt nach dem Setzen
  // der Höhe. Das anschließende Scrollen geschieht noch im selben JS-Task und
  // damit vor dem nächsten sichtbaren Browser-Paint.
  const rect = card.getBoundingClientRect();
  const anchoredY = rect.top + rect.height * anchor.ratio;
  // `html` verwendet absichtlich smooth scrolling. Bei `behavior: auto` würde
  // deshalb erst die Zeile wachsen und die Ankerkorrektur anschließend sichtbar
  // animieren. `instant` hält beides im selben Paint zusammen.
  window.scrollBy({ top: anchoredY - anchor.viewportY, behavior: 'instant' });
  return true;
}

async function changeListRowHeight(step, scaleAnchor = null) {
  if (currentLayout() !== 'list' || !step) return;
  const currentIndex = LIST_ROW_SCALES.indexOf(listRowScale);
  const nextIndex = Math.max(0, Math.min(LIST_ROW_SCALES.length - 1, currentIndex + Math.sign(step)));
  const next = LIST_ROW_SCALES[nextIndex];
  if (next === listRowScale) return;
  const position = scaleAnchor ? null : captureListPosition();
  listRowScale = next;
  applyListRowHeight();
  try { localStorage.setItem('wa-list-row-scale', String(listRowScale)); } catch { /* Speicher gesperrt */ }
  showListRowHeightStatus();
  if (!restoreListScaleAnchor(scaleAnchor)) await restoreListPosition(position);
  lastListPosition = captureListPosition();
}

async function changeGridColumns(step, scaleAnchor = null) {
  const layout = currentLayout();
  const grid = $app.querySelector('.article-grid');
  if (!grid || layout === 'list' || !step) return;
  const current = currentGridColumns(grid);
  if (!current) return;
  const next = Math.max(GRID_MIN_COLUMNS, Math.min(maxGridColumns(grid), current + step));
  showGridDensityStatus(next);
  if (next === current) return;

  const position = scaleAnchor ? null : captureListPosition();
  const preferredWidth = Math.max(GRID_MIN_CARD_WIDTH, Math.min(
    GRID_MAX_CARD_WIDTH,
    cardWidthForColumns(grid, next)
  ));
  state.gridCardWidths = { ...state.gridCardWidths, [layout]: Math.round(preferredWidth * 10) / 10 };
  document.body.style.setProperty('--grid-columns', String(next));
  scheduleCurrentViewSave();
  if (!restoreListScaleAnchor(scaleAnchor)) await restoreListPosition(position);
  lastListPosition = captureListPosition();
}

function setLayout(layout) {
  document.body.classList.toggle('layout-tall', layout === 'tall');
  document.body.classList.toggle('layout-list', layout === 'list');
  $filterLayout.querySelectorAll('[data-layout]').forEach(button => {
    const active = button.dataset.layout === layout;
    button.setAttribute('aria-checked', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  applyGridColumns();
  syncTelegramInstagramButton();
}
function currentLayout() {
  if (document.body.classList.contains('layout-list')) return 'list';
  return document.body.classList.contains('layout-tall') ? 'tall' : 'square';
}
// Kachelansichten fassen Artikel und ihre Infografiken zusammen; die Liste und
// der Autorenfilter „Infografiken“ zeigen jede Grafik einzeln.
function groupMode() {
  return currentLayout() !== 'list' && state.author !== 'Infografiken';
}
// Die Darstellung wechselt am aktuellen Ort. Liste und Kacheln verwenden zwar
// unterschiedliche Gruppierung, setzen aber weder Seite noch sichtbaren Anker zurück.
async function changeLayout(layout) {
  if (!LAYOUTS.includes(layout) || layout === currentLayout()) return;
  const generation = ++layoutChangeGeneration;
  const position = captureListPosition();
  const wasGrouped = groupMode();
  const resetInfographicFilter = layout === 'list'
    && state.author === INFOGRAPHICS_AUTHOR && state.infographicFilter !== 'all';
  if (resetInfographicFilter) {
    setInfographicFilter('all');
    state.page = 1;
  }
  setLayout(layout);
  restoringSessionView = true;
  try {
    // Ein bereits laufender Filter-/Seitenabruf darf nicht anschließend Daten
    // der alten Gruppierung in das gerade gewählte Layout schreiben.
    while (state.loading && generation === layoutChangeGeneration) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (generation !== layoutChangeGeneration) return;
    if (groupMode() !== wasGrouped || resetInfographicFilter) {
      await loadArticles();
      if (state.pages > 0 && state.page > state.pages) {
        state.page = state.pages;
        await loadArticles();
      }
    }
    await restoreListPosition(position);
    lastListPosition = captureListPosition();
  } finally {
    if (generation === layoutChangeGeneration) {
      restoringSessionView = false;
      saveCurrentViewState();
    }
  }
}
$filterLayout.addEventListener('click', event => {
  const button = event.target.closest('[data-layout]');
  if (button) changeLayout(button.dataset.layout);
});
$filterLayout.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  const step = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
  const next = LAYOUTS[(LAYOUTS.indexOf(currentLayout()) + step + LAYOUTS.length) % LAYOUTS.length];
  changeLayout(next);
  $filterLayout.querySelector(`[data-layout="${next}"]`).focus();
});

// Einfinger-Wischen aus dem Ergebnisraster bis in die gegenüberliegende äußere
// 30-px-Zone blättert eine Seite. Die äußersten 30 px bleiben als Startbereich
// ausdrücklich dem Browser für Zurück/Vorwärts vorbehalten. In Bildergalerien
// blättern kürzere Wischer nur das Bild; vertikales Scrollen bleibt nativ.
$app.addEventListener('touchstart', event => {
  if (!pageSwipeMath || event.touches.length !== 1 || state.loading) {
    pageSwipeGesture = null;
    return;
  }
  const touch = event.touches[0];
  const grid = gridForTouch(touch);
  const target = event.target?.nodeType === Node.ELEMENT_NODE
    ? event.target
    : event.target?.parentElement;
  if (!grid || pageSwipeBlockedTarget(target)) {
    pageSwipeGesture = null;
    return;
  }
  pageSwipeGesture = {
    startX: touch.clientX,
    startY: touch.clientY,
    viewportWidth: pageSwipeViewportWidth(),
    intent: 'pending',
    multiple: false,
    blocked: false,
  };
}, { passive: true });

$app.addEventListener('touchmove', event => {
  if (!pageSwipeGesture) return;
  if (event.touches.length !== 1 || gridTouchGesture || pinchZoomed() || hasActiveSelection()) {
    pageSwipeGesture = null;
    return;
  }
  const touch = event.touches[0];
  if (pageSwipeGesture.intent === 'pending') {
    const intent = pageSwipeMath.movementIntent({
      ...pageSwipeGesture,
      currentX: touch.clientX,
      currentY: touch.clientY,
    });
    if (intent === 'pending') return;
    if (intent === 'vertical') {
      pageSwipeGesture = null;
      return;
    }
    pageSwipeGesture.intent = 'horizontal';
  }
  // Auf iOS muss bereits die erste klar horizontale Bewegung übernommen werden;
  // ein späteres preventDefault() käme nach Beginn des Seitenscrollens zu spät.
  if (event.cancelable) event.preventDefault();
}, { passive: false });

function finishPageSwipe(event) {
  const gesture = pageSwipeGesture;
  pageSwipeGesture = null;
  if (!gesture || gesture.intent !== 'horizontal' || !event.changedTouches.length
      || gridTouchGesture || pinchZoomed()) return;
  const touch = event.changedTouches[0];
  const direction = pageSwipeMath.pageDirection({
    ...gesture,
    endX: touch.clientX,
    endY: touch.clientY,
  });
  if (!direction) return;

  // Auch an der ersten/letzten Seite darf aus der beabsichtigten Wischgeste
  // kein nachfolgender Klick entstehen.
  gridClickSuppressedUntil = Date.now() + GRID_CLICK_SUPPRESS_MS;
  const targetPage = state.page + direction;
  if (targetPage < 1 || targetPage > state.pages) return;
  void changeResultsPage(targetPage);
}

$app.addEventListener('touchend', finishPageSwipe, { passive: true });
// Safari beendet langsame Gesten gelegentlich mit touchcancel. Wenn die Bewegung
// bereits klar horizontal war, wird sie wie ein normales Loslassen ausgewertet.
$app.addEventListener('touchcancel', finishPageSwipe, { passive: true });

// Zwei Finger dürfen auf unterschiedlichen Kacheln/Zeilen oder in den
// Zwischenräumen liegen. Die Geste steuert die Spaltenzahl beziehungsweise in
// der Listenansicht die Zeilenhöhe und darf keine Karte öffnen.
$app.addEventListener('touchstart', event => {
  if (event.touches.length > 1) pageSwipeGesture = null;
  if (event.touches.length !== 2) return;
  const first = event.touches[0];
  const second = event.touches[1];
  const grid = gridForTouch(first);
  if (!grid || gridForTouch(second) !== grid
      || !touchInsideGrid(first, grid) || !touchInsideGrid(second, grid)) return;
  const distance = touchDistance(first, second);
  if (distance <= 0) return;
  event.preventDefault();
  gridTouchGesture = { grid, startDistance: distance, committed: false, layout: currentLayout() };
  gridClickSuppressedUntil = Date.now() + 10000;
}, { passive: false });

$app.addEventListener('touchmove', event => {
  if (!gridTouchGesture || event.touches.length < 2) return;
  event.preventDefault();
  if (gridTouchGesture.committed) return;
  const distance = touchDistance(event.touches[0], event.touches[1]);
  const ratio = distance / gridTouchGesture.startDistance;
  if (Math.abs(ratio - 1) < GRID_PINCH_THRESHOLD) return;
  gridTouchGesture.committed = true;
  const midpointX = (event.touches[0].clientX + event.touches[1].clientX) / 2;
  const midpointY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
  const scaleAnchor = captureListScaleAnchor(midpointX, midpointY);
  if (gridTouchGesture.layout === 'list') {
    // Zusammenziehen macht die Zeilen kompakter, Spreizen vergrößert sie.
    changeListRowHeight(
      ratio < 1 ? -1 : 1,
      scaleAnchor,
    );
  } else {
    // Zusammenziehen entspricht Herauszoomen: mehr, Spreizen: weniger Spalten.
    changeGridColumns(ratio < 1 ? 1 : -1, scaleAnchor);
  }
}, { passive: false });

function finishGridTouchGesture() {
  if (!gridTouchGesture) return;
  gridTouchGesture = null;
  gridClickSuppressedUntil = Date.now() + GRID_CLICK_SUPPRESS_MS;
}

$app.addEventListener('touchend', event => {
  if (gridTouchGesture && event.touches.length < 2) finishGridTouchGesture();
}, { passive: true });
$app.addEventListener('touchcancel', finishGridTouchGesture, { passive: true });

// Strg+Mausrad wirkt nur über dem Ergebnisraster. In der Liste ändert es die
// Zeilenhöhe, in Kachelansichten die Spaltenzahl. Normales Scrollen und der
// bestehende Mausrad-Zoom in der Bildvollansicht bleiben unberührt.
$app.addEventListener('wheel', event => {
  if (!event.ctrlKey || !isDesktopPointer() || !event.target.closest?.('.article-grid')) return;
  event.preventDefault();
  gridWheelTotal += event.deltaY;
  clearTimeout(gridWheelResetTimer);
  gridWheelResetTimer = setTimeout(() => { gridWheelTotal = 0; }, 240);
  if (Math.abs(gridWheelTotal) < 30 || Date.now() - gridWheelLastStep < 150) return;
  const step = gridWheelTotal > 0 ? 1 : -1;
  gridWheelTotal = 0;
  gridWheelLastStep = Date.now();
  if (currentLayout() === 'list') {
    changeListRowHeight(step > 0 ? -1 : 1, captureListScaleAnchor(event.clientX, event.clientY));
  }
  else changeGridColumns(step, captureListScaleAnchor(event.clientX, event.clientY));
}, { passive: false });

let gridResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(gridResizeTimer);
  gridResizeTimer = setTimeout(() => {
    if ($navigationChrome?.classList.contains('is-hidden')) {
      setNavigationChromeOffset($navigationChrome.offsetHeight);
    }
    applyGridColumns();
    updateResponsiveDates();
    updateFilterLabelLayout();
  }, 120);
});

$filterLimit.addEventListener('change', async () => {
  const nextLimit = parseInt($filterLimit.value);
  if (state.loading) {
    $filterLimit.value = String(state.limit);
    return;
  }

  const position = captureListPosition();
  const anchoredItemIndex = (state.page - 1) * state.limit + position.anchorIndex;
  const nextPage = sessionViewStore.pageForLimitChange(
    state.page,
    state.limit,
    nextLimit,
    position.anchorIndex,
  );
  position.anchorIndex = anchoredItemIndex % nextLimit;

  restoringSessionView = true;
  try {
    state.page = nextPage;
    state.limit = nextLimit;
    await loadArticles();
    await restoreListPosition(position);
    lastListPosition = captureListPosition();
  } finally {
    restoringSessionView = false;
    saveCurrentViewState();
  }
});

$telegramBtn.addEventListener('click', () => {
  if (state.author === INFOGRAPHICS_AUTHOR) setInfographicFilter(nextInfographicFilter());
  else setTelegram(!state.telegram);
  state.page = 1;
  loadArticles();
});

$bookmarkBtn.addEventListener('click', () => {
  setBookmarkFilter(!state.bookmarks);
  state.page = 1;
  loadArticles();
});

$loginForm.addEventListener('submit', e => {
  e.preventDefault();
  const email    = $loginEmail.value.trim();
  const password = $loginPassword.value;
  if (!email || !password) return;
  login(email, password);
});

$logoutBtn.addEventListener('click', () => {
  const message = isInfographicReviewMode() && infographicReview.hasChanges()
    ? 'Wirklich abmelden? Ungespeicherte Poster-Markierungen werden verworfen.'
    : 'Wirklich abmelden?';
  if (confirm(message)) logout();
});

$loginBtn.addEventListener('click', () => showLogin());
$loginClose?.addEventListener('click', () => hideLogin());

$resetFilters.addEventListener('click', () => {
  if (isInfographicReviewMode()) {
    $searchInput.value = '';
    $searchClear.classList.remove('visible');
    $filterYear.value = '';
    $filterCategory.value = '';
    Object.assign(state, { q: '', year: '', category: '', page: 1 });
    [$filterYear, $filterCategory].forEach(syncFilterAriaMenu);
    loadArticles();
    return;
  }
  $searchInput.value = '';
  $searchClear.classList.remove('visible');
  $filterAuthor.value = '';
  $filterYear.value = '';
  $filterCategory.value = '';
  state.gridCardWidths = { square: null, tall: null };
  setLayout('tall');
  $filterLimit.value = '24';
  setTelegram(false);
  setInfographicFilter('all');
  setBookmarkFilter(false);
  Object.assign(state, { q:'', author:'', externalAudio:false, year:'', category:'', telegram:false,
    infographicFilter:'all', bookmarks:false, page:1, limit:24 });
  [
    $filterAuthor,
    $filterYear,
    $filterCategory,
    $filterLimit,
    document.getElementById('filter-book-sort'),
  ].forEach(select => select && syncFilterAriaMenu(select));
  applyBookMode();
  loadArticles();
});

// Logo oben links: zurück zur Startseite – offene Ansichten schließen, dann wie „Reset“.
document.querySelector('.site-logo').addEventListener('click', event => {
  event.preventDefault();
  event.currentTarget.blur();
  if (!$imgFullscreen.hidden) closeImageFullscreen();
  if (!$overlay.hidden) {
    closeOverlay();
    if (!$overlay.hidden) return;   // Editor mit ungespeicherten Änderungen: abgebrochen
  }
  $resetFilters.click();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ── Admin-Funktionen (admin-tasks.js, nur in der Admin-Shell geladen) ──────────
// Artikel der offenen Detailansicht; Editor und Audio-Erzeugung beziehen sich darauf.
let selectedTtsArticle = null;
const $ttsOverlay = document.getElementById('tts-overlay');
// admin-tasks.js füllt diese Einhängepunkte. Für Gäste und Nutzer bleiben sie
// leer, weil der Server ihnen das Admin-Skript gar nicht ausliefert.
const adminHooks = {
  articleChanged() {},
  userChanged() {},
  ttsBusy: () => false,
  actions: {},
};

// ── Aktions-Menü hinter dem ↺-Button (gemeinsames ARIA-Menü) ────────────────
const adminMenu = WebArchivAriaMenu.create({
  trigger: $reindexBtn,
  menu: $adminMenu,
  onBeforeOpen: () => adminHooks.articleChanged(),
  onSelect: item => runAdminMenuAction(item.dataset.action),
});
function closeAdminMenu() {
  adminMenu?.close();
}
function runAdminMenuAction(action) {
  // Reindex, Scrape, Log und Audio-Aufträge stellt admin-tasks.js bereit, den
  // Prüfmodus „Infografiken prüfen“ infographic-review.js.
  if (adminHooks.actions[action]) adminHooks.actions[action]();
  else if (action === 'tts-settings') openTtsSettingsDialog();
  else if (action === 'new-infographic') openNewInfographic();
  else if (action === 'duplicates' && typeof openDuplicateReview === 'function') openDuplicateReview();
  else if (action === 'settings') openSettingsDialog();
  else if (action === 'users') openUserAdmin();
  else if (action === 'password') openPasswordDialog({ forced: false });
}

$overlayClose.addEventListener('click', closeOverlay);
$overlayBdrop.addEventListener('click', closeOverlay);
document.getElementById('overlay-prev').addEventListener('click', () => navigateArticle(-1));
document.getElementById('overlay-next').addEventListener('click', () => navigateArticle(+1));
const $imgFullscreen = document.getElementById('img-fullscreen');
const $imgFullscreenImg = document.getElementById('img-fullscreen-img');
$imgFullscreen.addEventListener('click', e => {
  if (e.target === $imgFullscreen) closeImageFullscreen();
});
$imgFullscreenImg.addEventListener('click', e => {
  if (isDesktopPointer()) {
    e.stopPropagation();
    return;
  }
  closeImageFullscreen();
});
$imgFullscreenImg.addEventListener('wheel', e => {
  if (!isDesktopPointer()) return;
  e.preventDefault();
  const direction = e.deltaY < 0 ? 1 : -1;
  const factor = direction > 0 ? IMAGE_ZOOM_STEP : 1 / IMAGE_ZOOM_STEP;
  zoomImageCentered(imageZoom.scale * factor);
}, { passive: false });
$imgFullscreenImg.addEventListener('dblclick', e => {
  if (!isDesktopPointer()) return;
  e.preventDefault();
  e.stopPropagation();
  if (imageZoom.scale > 1) {
    resetImageZoom();
  } else {
    zoomImageCentered(IMAGE_DBLCLICK_ZOOM);
  }
});
$imgFullscreenImg.addEventListener('mousedown', e => {
  if (!isDesktopPointer() || imageZoom.scale <= 1 || e.button !== 0) return;
  e.preventDefault();
  imageZoom.dragging = true;
  imageZoom.dragStartX = e.clientX;
  imageZoom.dragStartY = e.clientY;
  imageZoom.startX = imageZoom.x;
  imageZoom.startY = imageZoom.y;
  $imgFullscreenImg.classList.add('is-dragging');
});
window.addEventListener('mousemove', e => {
  if (!imageZoom.dragging) return;
  imageZoom.x = imageZoom.startX + e.clientX - imageZoom.dragStartX;
  imageZoom.y = imageZoom.startY + e.clientY - imageZoom.dragStartY;
  clampImagePan();
  applyImageZoom();
});
window.addEventListener('mouseup', () => {
  if (!imageZoom.dragging) return;
  imageZoom.dragging = false;
  $imgFullscreenImg.classList.remove('is-dragging');
});
window.addEventListener('resize', () => {
  if ($imgFullscreen.hidden || imageZoom.scale <= 1) return;
  clampImagePan();
  applyImageZoom();
});

// Ebenen über Artikel und Kacheln (Dialoge, TTS- und Scrape-Fenster) behalten ihre
// Tasten: Escape schließt dann nur die Ebene selbst, die Pfeile blättern nicht.
function layerAboveContentOpen() {
  return !!document.querySelector('dialog[open]')
    || !!($scrapeOverlay && !$scrapeOverlay.hidden) || !!($ttsOverlay && !$ttsOverlay.hidden);
}
// Bedienelemente, die Pfeiltasten selbst nutzen (Radiobuttons, Eingaben, Regler, Audio).
const ARROW_KEY_CONTROLS = 'input, textarea, select, audio, video, [contenteditable]:not([contenteditable="false"]), [role="slider"]';

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!document.getElementById('img-fullscreen').hidden) { closeImageFullscreen(); return; }
    if (layerAboveContentOpen()) return;
    if (!$overlay.hidden) { closeOverlay(); return; }
    // Login-Dialog nur per ESC schließen, wenn Guest oder eingeloggt — nicht bei
    // initialem Pflicht-Login (kein currentUser).
    if (!$loginOverlay.hidden && currentUser) { hideLogin(); return; }
    return;
  }

  const dir = pageSwipeMath?.keyDirection(e) || 0;
  if (!dir) return;

  // Poster können direkt aus der Kachelansicht vollflächig geöffnet werden.
  // Dort blättern die Pfeiltasten zuerst durch die begrenzte Poster-Liste.
  if (!$imgFullscreen.hidden) {
    e.preventDefault();
    stepFullscreen(dir);
    return;
  }

  if (layerAboveContentOpen()) return;
  const target = e.target?.nodeType === Node.ELEMENT_NODE ? e.target : e.target?.parentElement;

  if (!$overlay.hidden) {
    // In der Vollansicht erst durch die Bilder der Gruppe, danach zum Nachbarartikel.
    if (!target?.closest(ARROW_KEY_CONTROLS)) navigateArticle(dir);
    return;
  }

  // In der Kachelansicht blättern die Pfeiltasten wie eine Wischgeste um die
  // aktuell gewählte Anzahl Artikel. Bedienelemente und Dialoge behalten die Tasten.
  // Ein geschlossener Menü-Auslöser (Fokus nach Escape oder Menüauswahl) nutzt
  // links/rechts nicht und blättert deshalb mit.
  const interactive = target?.closest(`${ARROW_KEY_CONTROLS}, button, a`);
  const reviewCheckbox = isInfographicReviewMode()
    && interactive?.matches('[data-review-poster-id]');
  const closedMenuTrigger = interactive?.matches('[aria-haspopup="menu"]:not([aria-expanded="true"])');
  if (currentLayout() === 'list' || (interactive && !reviewCheckbox && !closedMenuTrigger)
      || !$loginOverlay.hidden) return;

  const targetPage = state.page + dir;
  if (targetPage < 1 || targetPage > state.pages) return;
  e.preventDefault();
  void changeResultsPage(targetPage);
});

// Returns false when the user is panning within a zoomed viewport and hasn't reached the edge yet.
function swipeAllowed(delta) {
  if (!pinchZoomed()) return true;
  const vp = window.visualViewport;
  const atLeft  = vp.offsetLeft < 2;
  const atRight = (vp.offsetLeft + vp.width) >= (document.documentElement.clientWidth - 2);
  if (delta < 0) return atRight;
  if (delta > 0) return atLeft;
  return false;
}

// Swipe threshold: horizontal delta must exceed this AND dominate over vertical movement
const SWIPE_MIN_X = 80;
const SWIPE_X_DOMINANCE = 1.5;
const SWIPE_MAX_DURATION = 500; // ms — länger zählt als Long-Press / Selektions-Geste

// Touch swipe on overlay panel
let touchStartX = 0;
let touchStartY = 0;
let touchStartTime = 0;
let touchStartMulti = false;
let touchInGallery = false;
const $overlayPanel = $overlay.querySelector('.overlay-panel');
$overlayPanel.addEventListener('touchstart', e => {
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
  touchStartTime = Date.now();
  touchStartMulti = e.touches.length > 1;
  // Wischen in einer scrollbaren Bildleiste blättert die Bilder, nicht den Artikel;
  // Ziehen auf einem Audio-Fortschrittsbalken verschiebt die Wiedergabe.
  touchInGallery = !!e.target.closest?.('.detail-gallery.is-scrollable, .audio-progress');
}, { passive: true });
$overlayPanel.addEventListener('touchend', e => {
  if (touchStartMulti || touchInGallery) return;
  if (hasActiveSelection()) return;
  if (Date.now() - touchStartTime > SWIPE_MAX_DURATION) return;
  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = e.changedTouches[0].clientY - touchStartY;
  if (Math.abs(dx) > SWIPE_MIN_X
      && Math.abs(dx) > Math.abs(dy) * SWIPE_X_DOMINANCE
      && swipeAllowed(dx)) {
    navigateArticle(dx < 0 ? +1 : -1);
  }
}, { passive: true });

// Touch swipe on fullscreen image overlay
let fsTouchStartX = 0;
let fsTouchStartY = 0;
let fsTouchStartTime = 0;
let fsTouchStartMulti = false;
const $imgFs = document.getElementById('img-fullscreen');
$imgFs.addEventListener('touchstart', e => {
  fsTouchStartX = e.touches[0].clientX;
  fsTouchStartY = e.touches[0].clientY;
  fsTouchStartTime = Date.now();
  fsTouchStartMulti = e.touches.length > 1;
}, { passive: true });
$imgFs.addEventListener('touchend', e => {
  if (fsTouchStartMulti) return;
  if (hasActiveSelection()) return;
  if (Date.now() - fsTouchStartTime > SWIPE_MAX_DURATION) return;
  const dx = e.changedTouches[0].clientX - fsTouchStartX;
  const dy = e.changedTouches[0].clientY - fsTouchStartY;
  if (Math.abs(dx) > SWIPE_MIN_X
      && Math.abs(dx) > Math.abs(dy) * SWIPE_X_DOMINANCE
      && swipeAllowed(dx)) {
    stepFullscreen(dx < 0 ? +1 : -1);
  }
}, { passive: true });

// Alle modalen Ebenen sperren die Seite dahinter. Offene Dialoge können gestapelt
// sein; erst nach dem Schließen der letzten Ebene darf die Seite wieder scrollen.
const modalOverlays = [$overlay, $loginOverlay, $scrapeOverlay, $ttsOverlay,
  document.getElementById('img-fullscreen')];
function syncModalPageScroll() {
  const modalOpen = !!document.querySelector('dialog[open]')
    || modalOverlays.some(overlay => overlay && !overlay.hidden);
  document.documentElement.classList.toggle('modal-open', modalOpen);
  document.documentElement.classList.toggle('overlay-open', !$overlay.hidden);
}
new MutationObserver(syncModalPageScroll).observe(document.body, {
  attributes: true, attributeFilter: ['hidden', 'open'], subtree: true,
});
syncModalPageScroll();

const dialogOpen = () => !!document.querySelector('dialog[open]') || ($ttsOverlay && !$ttsOverlay.hidden);
enablePullToClose({
  scroller: $overlayPanel,
  moving: $overlayPanel,
  fading: $overlayBdrop,
  // Nicht aus der wischbaren Bildleiste, nicht bei offener Vollansicht oder Dialogen.
  canStart: e => $imgFs.hidden && !dialogOpen() && !e.target.closest?.('.detail-gallery.is-scrollable, textarea, input'),
  onClose: closeOverlay,
});
enablePullToClose({
  scroller: $imgFs,
  moving: $imgFullscreenImg,
  fading: null,
  canStart: () => imageZoom.scale <= 1,
  onClose: closeImageFullscreen,
});

// Weitere Dialoge: Nach-unten-Ziehen löst dasselbe aus wie ihr Schließen-Knopf
// (also auch die Rückfrage bei ungespeicherten Änderungen). Nicht aus Eingabefeldern
// oder bereits gescrollten Bereichen (Log, Listen) und nicht, solange der Knopf
// ausgeblendet ist (Pflicht-Kennwortdialog).
function scrolledWithin(target, root) {
  for (let el = target; el && el !== root; el = el.parentElement) {
    if (el.scrollTop > 1) return true;
  }
  return false;
}
const PULL_DIALOGS = [
  // [Panel, Schließen-Knopf, abgedunkelter Hintergrund]
  ['#tts-overlay .scrape-panel', '#tts-close', '#tts-backdrop'],
  ['#scrape-overlay .scrape-panel', '#scrape-close', '#scrape-backdrop'],
  ['#login-overlay .login-panel', '#login-close', '#login-overlay .login-backdrop'],
  ['#tts-provider-dialog', '#tts-provider-dialog button[value="cancel"]'],
  ['#article-editor', '#article-editor-close'],
  ['#book-extras-manager', '#book-extras-manager [data-bem-close]'],
  ['#infographic-manager', '#infographic-manager [data-igm-close]'],
  ['#infographic-new', '#infographic-new-cancel'],
  ['#password-dialog', '#password-cancel'],
  ['#settings-dialog', '#settings-form button[type="submit"]'],
  ['#tts-settings-dialog', '#tts-settings-close'],
  ['#user-admin', '#user-admin-close'],
];
for (const [panelSel, closeSel, fadeSel] of PULL_DIALOGS) {
  const panel = document.querySelector(panelSel);
  const closeBtn = document.querySelector(closeSel);
  if (!panel || !closeBtn) continue;
  enablePullToClose({
    scroller: panel,
    moving: panel,
    fading: fadeSel ? document.querySelector(fadeSel) : null,
    canStart: e => !closeBtn.hidden && !closeBtn.disabled
      && !e.target.closest?.('textarea, input, select, [contenteditable]')
      && !scrolledWithin(e.target, panel),
    onClose: () => closeBtn.click(),
  });
}

// Handle back button
window.addEventListener('popstate', () => {
  if (typeof leaveArticleEditor === 'function' && !leaveArticleEditor()) {
    history.pushState(APP_VIEW_HISTORY_STATE, '', articleEditorState.url);
    return;
  }
  const hash = location.hash;
  if (!hash || hash === '#/' || hash === '#') {
    if (!$overlay.hidden) {
      $overlay.hidden = true;
      document.body.style.overflow = '';
      currentViewItemId = '';
      lastDetailPosition = null;
      stopAudio();
      stopVideo();
    }
    saveCurrentViewState();
  } else if (hash.startsWith('#/article/')) {
    const link = parseArticleHash(hash);
    openArticle(link.id, { image: link.image, deepLink: true, historyMode: 'none' });
  }
});

// Mobile Browser dürfen die App im Hintergrund vollständig verwerfen. Deshalb
// während der Bedienung speichern; pagehide/visibilitychange sind nur die letzte Sicherung.
window.addEventListener('scroll', () => {
  scheduleNavigationChromeUpdate();
  if ($overlay.hidden && (typeof bookReader === 'undefined' || !bookReader.el)) {
    lastListPosition = captureListPosition();
    scheduleCurrentViewSave();
  }
}, { passive: true });
document.addEventListener('focusin', event => {
  if (event.target === $searchInput || event.target.closest?.('.header-menu')) showNavigationChrome(true);
});
$overlay.querySelector('.overlay-panel')?.addEventListener('scroll', () => {
  lastDetailPosition = captureDetailPosition();
  scheduleCurrentViewSave();
}, { passive: true });
window.addEventListener('pagehide', saveCurrentViewState);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveCurrentViewState();
});

// ── Global img error handler ───────────────────────────────────────────────
// Kachelbilder tragen data-fallback statt eines onerror-Attributs, weil die
// Content-Security-Policy keine Inline-Handler zulässt. error-Ereignisse steigen
// nicht auf; daher fängt ein Listener in der Capture-Phase sie am Dokument ab.
function handleImgError(el) {
  el.removeAttribute('data-fallback');
  // Nur das Bild ersetzen; Badges und Lesezeichen der Kachel bleiben stehen.
  el.insertAdjacentHTML('afterend', `<div class="card-image-placeholder">${svgImage()}</div>`);
  el.remove();
}
document.addEventListener('error', event => {
  const img = event.target;
  if (img instanceof HTMLImageElement && img.hasAttribute('data-fallback')) handleImgError(img);
}, true);

// ── SVG icons ──────────────────────────────────────────────────────────────
function svgImage(large = false) {
  const s = large ? 60 : 36;
  return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>`;
}
function svgHeadphones() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"/><path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>`;
}
function svgExpand() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>`;
}
function svgSearch() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>`;
}
function svgBookmark() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>`;
}
function svgShare() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 3.9M15.4 6.6 8.6 10.5"/></svg>`;
}

// ── Boot ───────────────────────────────────────────────────────────────────
async function init() {
  wireFilterAriaMenus();
  $loading.hidden = false;
  setLayout('tall');

  // Check for existing session (or anonymous guest with public-authors whitelist)
  try {
    const r = await fetch('/api/me');
    if (r.ok) currentUser = await r.json();
  } catch { /* network error — treat as not logged in */ }

  $loading.hidden = true;
  applyUserUI(currentUser);

  // Wenn weder Session noch Public-Autoren konfiguriert → 401 fällt nicht mehr,
  // sondern /api/me liefert weiterhin guest. Wenn /api/me wirklich fehlschlug → Login.
  if (!currentUser) {
    pendingLoginDeepLink = startupArticleLink();
    showLogin();
    return;
  }
  if (!(await ensurePasswordChanged())) return;

  await restoreSessionView({ explicitDeepLink: startupArticleLink() });
}

init();
