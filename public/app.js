/* WebArchiv — SPA frontend */

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  q: '',
  author: '',
  externalAudio: false,
  year: '',
  category: '',
  telegram: false,
  bookmarks: false,
  page: 1,
  limit: 24,
  total: 0,
  pages: 0,
  loading: false,
  currentItems: [],
  currentArticleIdx: -1,
  bookSort: 'recent',
};

// Hörbücher sind kein Artikel-Autor: eigene Liste, eigene Detailansicht (audiobooks.js).
const AUDIOBOOK_AUTHOR = 'Hörbücher';
const isAudiobookId = id => String(id || '').startsWith(AUDIOBOOK_AUTHOR + '/');
const isBookMode = () => state.author === AUDIOBOOK_AUTHOR;

let authorHueMap = {};  // author name → hue (0..359), gesetzt in loadMeta()
let audioEl = null;     // shared audio element
let articleSessionActive = false;   // Media Session gehört dem Artikel-Audio (nicht dem Hörbuch)
let currentAudioBtn = null;
let currentUser = null; // { email, role, allowedAuthors }
const INFOGRAPHIC_MAX_BYTES = 10 * 1024 * 1024;
const sessionViewStore = window.WebArchivSessionState;
let currentViewItemId = '';
let lastListPosition = null;
let lastDetailPosition = null;
let restoringSessionView = false;
let sessionViewSaveTimer = null;
let layoutChangeGeneration = 0;

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
const $reindexBtn    = document.getElementById('reindex-btn');
const $adminMenu      = document.getElementById('admin-menu');
const $scrapeOverlay  = document.getElementById('scrape-overlay');
const $scrapeBackdrop = document.getElementById('scrape-backdrop');
const $scrapeClose    = document.getElementById('scrape-close');
const $scrapeTitle    = document.getElementById('scrape-title');
const $scrapeStatus   = document.getElementById('scrape-status');
const $scrapeOutput   = document.getElementById('scrape-output');
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

// ── Helpers ────────────────────────────────────────────────────────────────
function deviceStorage() {
  try { return window.localStorage; } catch { return null; }
}

function nextPaint() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function listViewportTop() {
  const bar = document.getElementById('filter-bar');
  return bar ? bar.getBoundingClientRect().bottom : 0;
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
      bookSort: state.bookSort,
    },
    view: {
      kind,
      itemId: kind === 'reader' ? readerId : (kind === 'detail' ? currentViewItemId : ''),
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
  if (!sessionViewStore || !currentUser || restoringSessionView) return;
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

const imageZoom = {
  scale: 1,
  x: 0,
  y: 0,
  dragging: false,
  dragStartX: 0,
  dragStartY: 0,
  startX: 0,
  startY: 0
};

const IMAGE_ZOOM_MIN = 1;
const IMAGE_ZOOM_MAX = 5;
const IMAGE_ZOOM_STEP = 1.16;
const IMAGE_DBLCLICK_ZOOM = 2;

function isDesktopPointer() {
  return matchMedia('(hover: hover) and (pointer: fine)').matches;
}

function resetImageZoom() {
  imageZoom.scale = 1;
  imageZoom.x = 0;
  imageZoom.y = 0;
  imageZoom.dragging = false;
  applyImageZoom();
}

function applyImageZoom() {
  const img = document.getElementById('img-fullscreen-img');
  img.style.transform = `translate(${imageZoom.x}px, ${imageZoom.y}px) scale(${imageZoom.scale})`;
  img.classList.toggle('is-zoomed', imageZoom.scale > 1);
}

function clampImagePan() {
  const img = document.getElementById('img-fullscreen-img');
  const prevTransform = img.style.transform;
  img.style.transform = '';
  const baseRect = img.getBoundingClientRect();
  img.style.transform = prevTransform;

  const scaledWidth = baseRect.width * imageZoom.scale;
  const scaledHeight = baseRect.height * imageZoom.scale;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const maxX = Math.max(0, (scaledWidth - viewportWidth) / 2);
  const maxY = Math.max(0, (scaledHeight - viewportHeight) / 2);

  if (scaledWidth <= viewportWidth) {
    imageZoom.x = 0;
  } else {
    imageZoom.x = Math.min(maxX, Math.max(-maxX, imageZoom.x));
  }

  if (scaledHeight <= viewportHeight) {
    imageZoom.y = 0;
  } else {
    imageZoom.y = Math.min(maxY, Math.max(-maxY, imageZoom.y));
  }
}

function zoomImageCentered(nextScale) {
  if (!isDesktopPointer()) return;

  const currentScale = imageZoom.scale;
  const clampedScale = Math.min(IMAGE_ZOOM_MAX, Math.max(IMAGE_ZOOM_MIN, nextScale));
  const scaleRatio = clampedScale / currentScale;

  imageZoom.scale = clampedScale;
  imageZoom.x *= scaleRatio;
  imageZoom.y *= scaleRatio;

  if (imageZoom.scale <= IMAGE_ZOOM_MIN) {
    resetImageZoom();
    return;
  }

  clampImagePan();
  applyImageZoom();
}

// Vollansicht: bei einer Gruppe alle Bilder (Wischen/Pfeiltasten), sonst eines.
// articleId gesetzt → Hash trägt „?bild=N“, damit der Link genau dieses Bild zeigt.
const fsGallery = { urls: [], index: 0, articleId: null };

function showFullscreenImage(index) {
  const count = fsGallery.urls.length;
  fsGallery.index = index;
  const url = fsGallery.urls[index];
  const $fs = document.getElementById('img-fullscreen');
  document.getElementById('img-fullscreen-img').src = url;
  resetImageZoom();
  $fs.scrollTop = 0;
  const $counter = document.getElementById('img-fullscreen-counter');
  $counter.hidden = count < 2;
  $counter.textContent = `${index + 1} / ${count}`;
  document.getElementById('img-fullscreen-download').href = url;
  prepareImageFile(url);
  if (fsGallery.articleId && count > 1) {
    history.replaceState(null, '', `#/article/${sanitizeForId(fsGallery.articleId)}?bild=${index + 1}`);
  }
}
function openGalleryFullscreen(urls, index = 0, articleId = null) {
  if (!urls.length) return;
  fsGallery.urls = urls;
  fsGallery.articleId = articleId;
  showFullscreenImage(Math.max(0, Math.min(urls.length - 1, index)));
  document.getElementById('img-fullscreen').hidden = false;
}
function openImageFullscreen(src) {
  openGalleryFullscreen([src]);
}
function closeImageFullscreen() {
  document.getElementById('img-fullscreen').hidden = true;
  resetImageZoom();
  if (fsGallery.articleId && location.hash.includes('?bild=')) {
    history.replaceState(null, '', `#/article/${sanitizeForId(fsGallery.articleId)}`);
  }
  fsGallery.articleId = null;
}
// Nach dem letzten Bild weiter zum nächsten Artikel, vor dem ersten zum vorigen.
function stepFullscreen(dir) {
  const next = fsGallery.index + dir;
  if (next >= 0 && next < fsGallery.urls.length) showFullscreenImage(next);
  else navigateArticle(dir);
}
function detailImageUrls(article) {
  if (article.images?.length) return article.images.map(image => image.url);
  return article.imageUrl ? [article.imageUrl] : [];
}

// „#/article/<id>?bild=3“ → { id, image: 3 }
function parseArticleHash(hash) {
  if (!hash.startsWith('#/article/')) return null;
  const [rawId, query = ''] = hash.slice('#/article/'.length).split('?');
  const image = parseInt(new URLSearchParams(query).get('bild'), 10);
  return { id: decodeURIComponent(rawId), image: image > 0 ? image : null };
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
  $telegramBtn.classList.toggle('active', on);
  $telegramBtn.setAttribute('aria-pressed', String(on));
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

// Kurzform TT.MM.JJJJ für schmale Kacheln auf dem Handy.
function formatDateShort(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return day && m ? `${day}.${m}.${y}` : d;
}

function sanitizeForId(id) {
  return encodeURIComponent(id);
}

function esc(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
  if (user?.role !== 'admin') clearTtsUI();
  const isGuest = !user || user.role === 'guest';
  const isAdmin = user?.role === 'admin';
  // Gäste bekommen immer die Vorgaben (settings.js).
  setDisplayGuest(isGuest);
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
    currentUser = data;
    hideLogin();
    applyUserUI(currentUser);
    if (!(await ensurePasswordChanged())) return;
    await restoreSessionView();
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
  // Hörposition vor dem Abmelden sichern und Wiedergabe beenden.
  if (typeof bookPlayerClose === 'function') await bookPlayerClose();
  clearCurrentViewState(currentUser);
  try { await fetch('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
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
    bookmarks: false, page: 1, limit: 24, bookSort: 'recent',
  });
  currentViewItemId = '';
  lastListPosition = null;
  lastDetailPosition = null;
  $searchInput.value = '';
  $searchClear.classList.remove('visible');
  setTelegram(false);
  setBookmarkFilter(false);
  setLayout('tall');
  $filterLimit.value = '24';
  const bookSort = document.getElementById('filter-book-sort');
  if (bookSort) bookSort.value = 'recent';
  applyBookMode();
  $filterAuthor.value = '';
  $filterYear.value = '';
  $filterCategory.value = '';
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
  const r = await fetch(url, options);
  if (r.status === 401) {
    currentUser = null;
    applyUserUI(null);
    showLogin('Ihre Sitzung ist abgelaufen. Bitte erneut anmelden.');
    throw new Error('Session expired');
  }
  if (r.status === 403 && currentUser && currentUser.role !== 'guest') {
    const data = await r.clone().json().catch(() => null);
    if (data?.mustChangePassword) {
      currentUser = { ...currentUser, mustChangePassword: true };
      ensurePasswordChanged().then(ok => { if (ok) { loadMeta(); loadArticles(); } });
      throw new Error('Password change required');
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
    const err = new Error('Not found');
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
  const hue = authorHue(article.author);
  const cats = (article.categories || []).slice(0, 5);
  const delay = Math.min(idx * 30, 300);

  const gallery = article.images?.length > 1;
  const imageHtml = gallery
    ? renderCardGallery(article.images)
    : article.imageUrl
    ? `<img src="${esc(article.imageUrl)}" alt="" loading="lazy" onerror="handleImgError(this)" />`
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
          <span class="author-badge" style="--author-hue:${hue}">${esc(article.author.replace(/_/g,' '))}</span>
          <span class="card-date"><span class="date-long">${esc(formatDate(article.date))}</span><span class="date-short">${esc(formatDateShort(article.date))}</span></span>
          ${epNum}
        </div>
        <h2 class="card-title">${esc(article.title)}</h2>
        ${catPills ? `<div class="card-categories">${catPills}</div>` : ''}
        <p class="card-preview">${esc(article.preview || article.excerpt)}</p>
      </div>
    </article>`;
}

// Bildbereich einer Kachel mit mehreren Bildern (Artikel + Infografiken):
// Desktop wählt das Bild über die Mausposition, Touch per Wischen; Striche zeigen
// Anzahl und aktuelles Bild. Weitere Bilder werden erst bei Bedarf geladen.
function renderCardGallery(images) {
  const slides = images.map((image, i) => {
    const src = i === 0 ? `src="${esc(image.url)}"` : `data-src="${esc(image.url)}"`;
    return `<div class="card-gallery-slide${image.kind === 'infographic' ? ' is-infographic' : ''}"><img ${src} alt="" loading="lazy" onerror="handleImgError(this)" /></div>`;
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
    if (multi) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) < 30 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    // Über das Ende hinaus geht es beim ersten Bild weiter (und umgekehrt).
    show((index + (dx < 0 ? 1 : -1) + dots.length) % dots.length);
    card.dataset.swipedAt = String(Date.now());
  }, { passive: true });
}

function renderGrid(items) {
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
  btns.push(`<button class="page-btn" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>‹ Zurück</button>`);

  const range = new Set([1, pages, page - 1, page, page + 1].filter(p => p >= 1 && p <= pages));
  const sorted = [...range].sort((a,b) => a-b);
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) btns.push('<span class="page-btn" style="opacity:.3;cursor:default">…</span>');
    btns.push(`<button class="page-btn${p === page ? ' active' : ''}" data-page="${p}">${p}</button>`);
    prev = p;
  }

  btns.push(`<button class="page-btn" data-page="${page + 1}" ${page === pages ? 'disabled' : ''}>Weiter ›</button>`);
  return `<div class="pagination">${btns.join('')}</div>`;
}

// ── Load & display articles ────────────────────────────────────────────────
// Zum Anfang der Ergebnisliste scrollen: erste Kachel direkt unter der
// (klebenden) Filterleiste, unabhängig von deren Höhe auf Desktop oder Handy.
function scrollToResults(behavior = 'smooth') {
  const bar = document.querySelector('.filter-bar');
  const covered = bar ? (parseFloat(getComputedStyle(bar).top) || 0) + bar.offsetHeight : 0;
  const top = window.scrollY + $app.getBoundingClientRect().top - covered;
  window.scrollTo({ top: Math.max(0, top), behavior });
}

async function loadArticles() {
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
      bookmarks: state.bookmarks,
      group:    groupMode(),
      page:     state.page,
      limit:    state.limit,
    });

    state.total = data.total;
    state.pages = data.pages;
    state.currentItems = data.items;

    $count.textContent = `${data.total.toLocaleString('de-DE')} ${bookMode ? (data.total === 1 ? 'Hörbuch' : 'Hörbücher') : 'Artikel'}`;
    $app.innerHTML = (bookMode ? renderBookGrid(data.items) : renderGrid(data.items)) + renderPagination(state.page, state.pages);

    // Attach card click handlers
    $app.querySelectorAll('.card').forEach(card => {
      const handler = () => openArticle(card.dataset.id);
      wireCardGallery(card);
      card.addEventListener('click', () => {
        // Ein Wischen durch die Bilder der Kachel öffnet den Artikel nicht.
        if (Date.now() - (Number(card.dataset.swipedAt) || 0) < 500) return;
        handler();
      });
      card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') handler(); });
    });

    // Attach pagination handlers
    $app.querySelectorAll('.page-btn[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = parseInt(btn.dataset.page);
        if (p !== state.page) {
          state.page = p;
          loadArticles().then(scrollToResults);
        }
      });
    });

    if (!restoringSessionView) scheduleCurrentViewSave();

  } catch (err) {
    $app.innerHTML = `<div class="empty-state"><p>Fehler beim Laden: ${esc(err.message)}</p></div>`;
  } finally {
    state.loading = false;
  }
}

// ── Article detail overlay ─────────────────────────────────────────────────
// dir: Richtung beim Blättern (für die Vollansicht: erstes/letztes Bild);
// image/deepLink: Link auf ein Bild der Gruppe → direkt in der Vollansicht öffnen.
async function openArticle(id, {
  dir = 0,
  image = null,
  deepLink = false,
  historyMode = 'push',
  detailPosition = null,
  restoring = false,
} = {}) {
  if (typeof leaveArticleEditor === 'function' && !leaveArticleEditor()) return;
  if ($overlay.hidden) lastListPosition = captureListPosition();
  if (!detailPosition) lastDetailPosition = null;
  selectedTtsArticle = null;
  updateTtsActions();
  $overlay.hidden = false;
  document.body.style.overflow = 'hidden';
  // Beim Artikel-Wechsel laufende Medien stoppen
  stopAudio();
  stopVideo();
  $detail.innerHTML = `<div style="padding:80px 40px;text-align:center;color:var(--text-muted)"><div class="spinner" style="margin:0 auto"></div></div>`;

  // Beim Wiederherstellen/Zurücknavigieren keinen zusätzlichen Verlaufseintrag erzeugen.
  const articleHash = `#/article/${sanitizeForId(id)}`;
  if (historyMode === 'replace') history.replaceState(null, '', articleHash);
  else if (historyMode === 'push') history.pushState(null, '', articleHash);

  try {
    const article = await fetchArticle(id);
    // Eine gruppierte Infografik liefert ihre Gruppe (requestedId = angefragtes Bild).
    state.currentArticleIdx = state.currentItems.findIndex(a => a.id === id);
    if (state.currentArticleIdx < 0) state.currentArticleIdx = state.currentItems.findIndex(a => a.id === article.id);
    if (article.id !== id) history.replaceState(null, '', `#/article/${sanitizeForId(article.id)}`);
    currentViewItemId = article.id;
    updateNavButtons();
    renderDetail(article);
    const panel = $overlay.querySelector('.overlay-panel');
    if (panel && !detailPosition) {
      panel.scrollTop = 0;
      lastDetailPosition = captureDetailPosition();
    }

    const urls = detailImageUrls(article);
    const $fs = document.getElementById('img-fullscreen');
    const requestedIdx = (article.images || []).findIndex(img => img.id === article.requestedId);
    if (image && urls.length > 1) {
      openGalleryFullscreen(urls, image - 1, article.id);
    } else if (deepLink && requestedIdx >= 0 && urls.length > 1) {
      openGalleryFullscreen(urls, requestedIdx, article.id);
    } else if (!$fs.hidden) {
      // Blättern in der Vollansicht: beim nächsten Artikel mit Bild 1, rückwärts mit dem letzten.
      if (urls.length) openGalleryFullscreen(urls, dir < 0 ? urls.length - 1 : 0, article.id);
      else closeImageFullscreen();
    }
    if (detailPosition) await restoreDetailPosition(detailPosition);
    if (!restoring) saveCurrentViewState();
    return true;
  } catch (err) {
    // Geschützter Artikel + Gast (403) → Anmeldung anbieten statt "nicht gefunden".
    // Overlay ausblenden, aber Deep-Link im Hash lassen, damit die Anmeldung den
    // Artikel danach automatisch öffnet (siehe login()).
    if (err && err.status === 403 && (!currentUser || currentUser.role === 'guest')) {
      $overlay.hidden = true;
      stopAudio();
      stopVideo();
      showLogin('Dieser Artikel ist geschützt. Bitte melden Sie sich an.');
      return false;
    }
    if (restoring) {
      $overlay.hidden = true;
      document.body.style.overflow = '';
      currentViewItemId = '';
      lastDetailPosition = null;
      history.replaceState(null, '', '#/');
      return false;
    }
    $detail.innerHTML = `<div style="padding:40px"><p>Artikel nicht gefunden.</p></div>`;
    return false;
  }
}

function closeOverlay() {
  if (typeof leaveArticleEditor === 'function' && !leaveArticleEditor()) return;
  selectedTtsArticle = null;
  updateTtsActions();
  $overlay.hidden = true;
  document.body.style.overflow = '';
  currentViewItemId = '';
  lastDetailPosition = null;
  stopAudio();
  stopVideo();
  history.pushState(null, '', '#/');
  // Hörfortschritt und „zuletzt gehört“ in der Liste auffrischen.
  if (isBookMode()) loadArticles();
  // Lesezeichen-Ansicht: entfernte Lesezeichen erst nach dem Schließen aus der Liste
  // nehmen (beim Blättern im Artikel bleibt die Reihenfolge stabil). Verzögert, damit
  // ein gleichzeitig gesetzter Filter (Kategorie-Klick) zuerst lädt.
  if (bookmarksChanged && state.bookmarks && !isBookMode()) setTimeout(loadArticles, 0);
  bookmarksChanged = false;
  saveCurrentViewState();
}

// ── Lesezeichen ───────────────────────────────────────────────────────────
let bookmarksChanged = false;

function bookmarkUrl(id) {
  return '/api/bookmarks/' + String(id).split('/').map(encodeURIComponent).join('/');
}

function showBookmarkState(button, on) {
  button.classList.toggle('active', on);
  button.setAttribute('aria-pressed', String(on));
  button.title = on ? 'Lesezeichen entfernen' : 'Lesezeichen setzen';
}

// Klick setzt bzw. löscht das Lesezeichen; Kachel und Listeneintrag ziehen mit.
async function toggleBookmark(article, button) {
  if (button.dataset.busy) return;
  const on = !article.bookmarked;
  button.dataset.busy = '1';
  showBookmarkState(button, on);
  try {
    const r = await apiFetch(bookmarkUrl(article.id), { method: on ? 'PUT' : 'DELETE' });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || 'Lesezeichen konnte nicht gespeichert werden.');
    }
    article.bookmarked = on;
    bookmarksChanged = true;
    const item = state.currentItems.find(a => a.id === article.id);
    if (item) item.bookmarked = on;
    $app.querySelectorAll('.card').forEach(card => {
      const mark = card.dataset.id === article.id && card.querySelector('.card-bookmark');
      if (mark) mark.hidden = !on;
    });
  } catch (err) {
    showBookmarkState(button, !on);
    if (err.message !== 'Session expired') alert(err.message);
  } finally {
    delete button.dataset.busy;
  }
}

function stopVideo() {
  const v = document.querySelector('.detail-video');
  if (v) { v.pause(); v.src = ''; }
}

function stopAudio() {
  if (audioEl) {
    audioEl.pause();
    audioEl = null;
  }
  releaseArticleMediaSession();
  if (currentAudioBtn) {
    currentAudioBtn.classList.remove('playing');
    currentAudioBtn = null;
  }
}

function renderDetail(article) {
  if (article.kind === 'audiobook') return renderBookDetail(article);
  selectedTtsArticle = article;
  updateTtsActions();
  const hue = authorHue(article.author);

  // Gruppe: Bildleiste (drei 9:16-Bilder nebeneinander, bei zwei je halbe Breite,
  // ab vier waagerecht wischbar). Klick öffnet das Bild in der Vollansicht.
  const images = article.images?.length > 1 ? article.images : null;
  const heroHtml = images
    ? `<div class="detail-gallery${images.length > 3 ? ' is-scrollable' : ''}" style="--gallery-cols:${images.length === 2 ? 2 : 3}">
        ${images.map((image, i) => `<button type="button" class="detail-gallery-item${image.kind === 'photo' ? ' is-photo' : ''}" data-index="${i}" aria-label="Bild ${i + 1} von ${images.length} vergrößern"><img src="${esc(image.url)}" alt="" loading="lazy" /></button>`).join('')}
      </div>`
    : article.imageUrl
    ? `<div class="detail-hero">
        <img src="${esc(article.imageUrl)}" alt="" id="detail-hero-img" />
        <button class="detail-hero-expand" id="detail-hero-expand" aria-label="Vollbild">${svgExpand()}</button>
        <a class="detail-hero-download" href="${esc(article.imageUrl)}" download aria-label="Bild herunterladen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 4v12m0 0l-4-4m4 4l4-4"/><rect x="4" y="18" width="16" height="2" rx="1"/>
          </svg>
        </a>
      </div>`
    : `<div class="detail-hero"><div class="detail-hero-placeholder">${svgImage(true)}</div></div>`;

  const cats = (article.categories || []).map(c =>
    `<span class="detail-cat-pill" data-cat="${esc(c)}">${esc(c)}</span>`
  ).join('');
  const tagPills = (article.tags || []).map(t =>
    `<span class="detail-cat-pill" style="opacity:.7">${esc(t)}</span>`
  ).join('');

  const audioHtml = article.audioUrl ? renderAudioPlayer(article) : '';
  const videoHtml = article.videoUrl ? renderVideoPlayer(article.videoUrl) : '';
  const pdfHtml   = article.pdfUrl   ? renderPdfEmbed(article.pdfUrl)     : '';

  const hasBody = !!(article.bodyHtml && article.bodyHtml.trim());
  const copyBtnHtml = hasBody
    ? `<div class="detail-copy-wrap">
        <button type="button" class="detail-cat-pill detail-copy-btn" id="detail-copy-btn" aria-label="Kopieroptionen" title="Kopieroptionen" aria-haspopup="menu" aria-controls="copy-prompt-menu" aria-expanded="false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="11" height="11" rx="2"/>
              <path d="M5 15V5a2 2 0 0 1 2-2h10"/>
            </svg>
        </button>
        <div class="copy-prompt-menu" id="copy-prompt-menu" role="menu" hidden></div>
      </div>`
    : '';
  const bookmarkBtnHtml = currentUser && currentUser.role !== 'guest'
    ? `<button type="button" class="detail-cat-pill detail-bookmark-btn${article.bookmarked ? ' active' : ''}" id="detail-bookmark-btn" aria-pressed="${article.bookmarked ? 'true' : 'false'}" aria-label="Lesezeichen" title="${article.bookmarked ? 'Lesezeichen entfernen' : 'Lesezeichen setzen'}">${svgBookmark()}</button>`
    : '';
  const shareBtnHtml = `<button class="detail-cat-pill detail-share-btn" id="detail-share-btn" aria-label="Link teilen" title="Link zum Artikel teilen">${svgShare()}<span class="detail-share-text">Teilen</span></button>`;
  const infographicBtnHtml = article.canUploadInfographic
    ? `<div class="detail-infographic-wrap">
        <button type="button" class="detail-cat-pill detail-infographic-btn" id="detail-infographic-btn" aria-label="Neue Infografik hochladen" title="Neue Infografik hochladen">neue Grafik</button>
        <input type="file" id="detail-infographic-file" accept=".png,.jpg,.jpeg,image/png,image/jpeg" hidden />
        <span class="detail-infographic-status" id="detail-infographic-status" aria-live="polite"></span>
      </div>`
    : '';
  const dateHtml = `<div class="detail-date-row">
        <span class="detail-date-block">${article.date ? esc(formatDate(article.date)) : ''}</span>
        <div class="detail-action-row">
          ${currentUser?.role === 'admin' ? `<details class="detail-tts-menu"><summary class="detail-cat-pill" title="Artikel bearbeiten und Audio erzeugen">Aktionen</summary><div class="copy-prompt-menu"><button type="button" class="header-menu-item" data-article-edit>Artikel editieren</button><button type="button" class="header-menu-item" data-tts-action="start" ${ttsStarting || ttsActive ? 'disabled' : ''}>Audio erzeugen</button><button type="button" class="header-menu-item" data-tts-action="show">Audio-Auftrag anzeigen</button></div></details>` : ''}
          ${infographicBtnHtml}
          ${copyBtnHtml}
          ${shareBtnHtml}
          ${bookmarkBtnHtml}
        </div>
      </div>`;
  const summaryHtml = article.summary
    ? `<div class="detail-summary"><span class="detail-summary-label">Zusammenfassung:</span> ${esc(article.summary)}</div>`
    : '';
  const sourceHtml = article.sourceUrl
    ? `<div class="detail-source"><em>Quelle: <a href="${esc(article.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(article.sourceUrl)}</a></em></div>`
    : '';

  $detail.innerHTML = `
    ${heroHtml}
    <div class="detail-content">
      <div class="detail-meta">
        <span class="author-badge" style="--author-hue:${hue}">${esc(article.author.replace(/_/g,' '))}</span>
        ${article.episodeNum ? `<span class="detail-episode">#${article.episodeNum}</span>` : ''}
      </div>
      <h1 class="detail-title">${esc(article.title)}</h1>
      ${(cats || tagPills) ? `<div class="detail-categories">${cats}${tagPills ? `<span style="color:var(--text-dim);font-size:.7rem;align-self:center;margin-left:4px">|</span>${tagPills}` : ''}</div>` : ''}
      ${dateHtml}
      ${sourceHtml}
      ${summaryHtml}
      <div class="detail-divider"></div>
      ${audioHtml}
      ${videoHtml}
      <div class="detail-body">${article.bodyHtml || ''}</div>
      ${pdfHtml}
    </div>`;

  // Fullscreen image handler
  if (images) {
    const urls = images.map(image => image.url);
    $detail.querySelectorAll('.detail-gallery-item').forEach(item => {
      item.addEventListener('click', () => openGalleryFullscreen(urls, Number(item.dataset.index), article.id));
    });
  } else if (article.imageUrl) {
    const openFs = () => openImageFullscreen(article.imageUrl);
    prepareImageFile(article.imageUrl); // für „Bild herunterladen“ (Teilen-Menü)
    document.getElementById('detail-hero-expand')?.addEventListener('click', e => { e.stopPropagation(); openFs(); });
    document.getElementById('detail-hero-img')?.addEventListener('click', openFs);
  }

  // Category pill → filter (Copy-Button ausschließen)
  $detail.querySelectorAll('.detail-cat-pill:not(.detail-copy-btn)').forEach(pill => {
    pill.addEventListener('click', () => {
      const cat = pill.dataset.cat;
      if (!cat) return;
      closeOverlay();
      $filterCategory.value = cat;
      state.category = cat;
      state.page = 1;
      loadArticles();
    });
  });

  // Das TTS-Dropdown bleibt auch bei schmalen Viewports vollständig sichtbar.
  $detail.querySelectorAll('.detail-tts-menu').forEach(details => {
    details.addEventListener('toggle', () => {
      if (!details.open) return;
      const menu = details.querySelector('.copy-prompt-menu');
      if (!menu) return;
      requestAnimationFrame(() => {
        const box = menu.getBoundingClientRect();
        const margin = 8;
        let left = 0;
        if (box.left < margin) left += margin - box.left;
        if (box.right > window.innerWidth - margin) left -= box.right - (window.innerWidth - margin);
        if (left) {
          menu.style.left = `${left}px`;
          menu.style.right = 'auto';
        }
      });
    });
  });

  const $bookmarkDetailBtn = document.getElementById('detail-bookmark-btn');
  $bookmarkDetailBtn?.addEventListener('click', () => toggleBookmark(article, $bookmarkDetailBtn));

  // Teilen-Button → Vorschau-fähigen Link (/a/<id>) teilen bzw. kopieren.
  // navigator.share (mobil) öffnet direkt das System-Teilen-Menü (z. B. WhatsApp),
  // sonst wird der Link in die Zwischenablage kopiert.
  const $shareBtn = document.getElementById('detail-share-btn');
  if ($shareBtn) {
    $shareBtn.addEventListener('click', async () => {
      const url = `${location.origin}/a/${sanitizeForId(article.id)}`;
      if (navigator.share) {
        try { await navigator.share({ title: article.title, url }); } catch { /* abgebrochen */ }
        return;
      }
      const $txt = $shareBtn.querySelector('.detail-share-text');
      try {
        await navigator.clipboard.writeText(url);
        if ($txt) { const orig = $txt.textContent; $txt.textContent = 'Kopiert!'; setTimeout(() => { $txt.textContent = orig; }, 1500); }
      } catch { /* Zwischenablage nicht verfügbar */ }
    });
  }

  // Copy-Button → zwei Klick-Zonen:
  //   Icon  → öffnet Menü mit Prompt-Varianten (vorangestellt)
  //   "copy" → nur Titel + Body
  const $infographicBtn = document.getElementById('detail-infographic-btn');
  const $infographicFile = document.getElementById('detail-infographic-file');
  const $infographicStatus = document.getElementById('detail-infographic-status');
  if ($infographicBtn && $infographicFile) {
    const setUploadStatus = (text, kind = '') => {
      if (!$infographicStatus) return;
      $infographicStatus.textContent = text;
      $infographicStatus.dataset.kind = kind;
    };

    $infographicBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      $infographicFile.value = '';
      $infographicFile.click();
    });

    $infographicFile.addEventListener('change', async () => {
      const file = $infographicFile.files?.[0];
      if (!file) return;
      $infographicBtn.disabled = true;
      $infographicBtn.setAttribute('aria-busy', 'true');
      setUploadStatus('Wird hochgeladen ...');
      try {
        await uploadInfographic(article, file);
        setUploadStatus('Gespeichert.', 'success');
        loadArticles().catch(err => console.warn('Artikel-Liste konnte nicht aktualisiert werden', err));
      } catch (err) {
        setUploadStatus(err.message || 'Upload fehlgeschlagen.', 'error');
      } finally {
        $infographicBtn.disabled = false;
        $infographicBtn.removeAttribute('aria-busy');
      }
    });
  }

  const $copyBtn  = document.getElementById('detail-copy-btn');
  const $copyMenu = document.getElementById('copy-prompt-menu');

  if ($copyBtn) {
    // Kopiert Artikel, optional mit vorangestelltem Prompt-Text
    // Eigene Text-Extraktion, weil innerText bei <ol> die Nummerierung verschluckt.
    const extractBodyText = (root) => {
      if (!root) return '';
      const blocks = [];
      for (const node of root.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          const t = node.textContent.replace(/\s+/g, ' ').trim();
          if (t) blocks.push(t);
          continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = node.tagName;
        if (tag === 'OL') {
          const start = parseInt(node.getAttribute('start') || '1', 10);
          let i = 0;
          for (const li of node.children) {
            if (li.tagName === 'LI') {
              const t = (li.innerText || li.textContent || '').trim();
              if (t) blocks.push(`${start + i}. ${t}`);
              i++;
            }
          }
        } else if (tag === 'UL') {
          for (const li of node.children) {
            if (li.tagName === 'LI') {
              const t = (li.innerText || li.textContent || '').trim();
              if (t) blocks.push(`- ${t}`);
            }
          }
        } else {
          const t = (node.innerText || node.textContent || '').trim();
          if (t) blocks.push(t);
        }
      }
      return blocks.join('\n\n');
    };

    const copyArticle = async (promptText = '') => {
      const bodyText = extractBodyText($detail.querySelector('.detail-body')).trim();
      const articleText = `${article.title}\n\n---\n\n${bodyText}`;
      const prefix = promptText.trim() ? promptText.trim() + '\n\n' : '';
      try {
        await navigator.clipboard.writeText(prefix + articleText);
        $copyBtn.classList.add('copied');
        setTimeout(() => $copyBtn.classList.remove('copied'), 1000);
      } catch (err) {
        console.warn('Clipboard write failed', err);
      }
    };

    let promptsLoaded = false;
    const closeMenu = () => {
      $copyMenu.hidden = true;
      $copyBtn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onOutside, true);
      document.removeEventListener('keydown', onEsc, true);
    };
    const onOutside = ev => { if (!$copyMenu.contains(ev.target) && !$copyBtn.contains(ev.target)) closeMenu(); };
    const onEsc = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); closeMenu(); $copyBtn.focus(); } };

    const buildMenu = async () => {
      if (promptsLoaded) return;
      promptsLoaded = true;
      // Erster Eintrag: nur Artikel
      const items = [{ file: null, label: 'Artikel' }];
      try {
        const r = await fetch('/api/prompts');
        if (r.ok) items.push(...await r.json());
      } catch { /* nur "Artikel" anbieten */ }
      $copyMenu.innerHTML = items.map((it, i) =>
        `<button type="button" role="menuitem" class="copy-prompt-item${i === 0 ? ' is-article' : ''}" data-prompt-file="${it.file ? esc(it.file) : ''}">${esc(it.label)}</button>`
      ).join('');
      $copyMenu.querySelectorAll('.copy-prompt-item').forEach(item => {
        item.addEventListener('click', async ev => {
          ev.stopPropagation();
          const file = item.dataset.promptFile;
          let promptText = '';
          if (file) {
            try {
              const r = await fetch(`/api/prompts/${encodeURIComponent(file)}`);
              if (r.ok) promptText = await r.text();
            } catch { /* Fallback: Artikel ohne Prompt */ }
          }
          closeMenu();
          copyArticle(promptText);
        });
      });
    };

    $copyBtn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!$copyMenu.hidden) { closeMenu(); return; }
      $copyMenu.hidden = false;
      $copyBtn.setAttribute('aria-expanded', 'true');
      document.addEventListener('click', onOutside, true);
      document.addEventListener('keydown', onEsc, true);
      await buildMenu();
      if (e.detail === 0 && !$copyMenu.hidden) $copyMenu.querySelector('button')?.focus();
    });
  }

  // Wire up audio player
  if (article.audioUrl) {
    wireAudioPlayer(article.audioUrl, article);
  }


  // Scroll overlay to top
  $overlay.querySelector('.overlay-panel').scrollTop = 0;
}

function renderAudioPlayer(article) {
  return `
    <div class="audio-player" id="audio-player">
      <button class="audio-play-btn" id="audio-play-btn" aria-label="Abspielen">
        <svg class="icon-play" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        <svg class="icon-pause" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
      </button>
      <div class="audio-controls">
        <span class="audio-label">Audio</span>
        <div class="audio-progress-wrap">
          <div class="audio-progress" id="audio-progress" role="slider" aria-label="Fortschritt">
            <div class="audio-progress-fill" id="audio-progress-fill"></div>
          </div>
          <span class="audio-time" id="audio-time">0:00 / 0:00</span>
        </div>
      </div>
    </div>`;
}

function renderVideoPlayer(videoUrl) {
  return `<div class="video-player">
    <video src="${esc(videoUrl)}" class="detail-video" controls preload="metadata"></video>
  </div>`;
}

function renderPdfEmbed(pdfUrl) {
  // pdf.js behandelt den ?v=-Cache-Buster fälschlich als Teil des Dateinamens
  // (kodiert "?" zu "%3F") → 404. Für den Viewer-Parameter daher die Query
  // entfernen; der "neuer Tab"-Link behält die volle URL inkl. Cache-Buster.
  const fileParam = pdfUrl.split('?')[0];
  const viewerUrl = '/vendor/pdfjs/web/viewer.html?file=' + encodeURIComponent(fileParam);
  return `<div class="pdf-player">
    <iframe src="${viewerUrl}" class="detail-pdf" title="PDF-Dokument"></iframe>
    <a class="pdf-hint" href="${esc(pdfUrl)}" target="_blank" rel="noopener">
      PDF in neuem Tab öffnen ↗
    </a>
  </div>`;
}

// Sperrbildschirm und Kopfhörertasten: Titel, Autor und quadratischer Bildausschnitt (oberer
// Teil des Bildes) statt des Favicons. Gibt es mehrere Bilder (Artikel + Infografiken), gilt das
// zweite. Die Vorschau-Route ist ohne Anmeldung erreichbar, weil iOS das Bild außerhalb der Seite
// lädt. Zusätzlich wird das Bild als Data-URL eingebettet: Das System muss dann nichts nachladen
// (kein Cookie, kein Mixed-Content, kein Netzwerkfehler) und zeigt nicht ein leeres Feld.
const articleArtworkCache = new Map();   // Bild-URL → Data-URL
let articleSessionId = null;
let articleArtworkToken = 0;

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Lesefehler'));
    reader.readAsDataURL(blob);
  });
}

async function articleArtworkDataUrl(src) {
  if (articleArtworkCache.has(src)) return articleArtworkCache.get(src);
  const response = await fetch(src, { credentials: 'same-origin' });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const dataUrl = await blobToDataUrl(await response.blob());
  articleArtworkCache.set(src, dataUrl);
  return dataUrl;
}

function setArticleMediaSession(article, audio) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  // Wird beim Klick und beim Play-Ereignis aufgerufen; ein Mal pro Artikel genügt.
  if (articleSessionActive && articleSessionId === article.id) return;
  articleSessionActive = true;
  articleSessionId = article.id;
  const token = ++articleArtworkToken;
  const origin = location.origin;
  const second = article.images?.length > 1 ? article.images[1] : null;
  const artId = second?.id || article.id;
  const hasImage = !!(second?.url || article.imageUrl);
  const urlArtwork = hasImage
    ? [256, 512].map(size => ({ src: `${origin}/og-image/${encodeURIComponent(artId)}?sq=${size}`, sizes: `${size}x${size}`, type: 'image/jpeg' }))
    : [{ src: origin + '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }];
  const makeMetadata = artwork => new MediaMetadata({
    title: article.title || '',
    artist: (article.author || '').replace(/_/g, ' '),
    album: 'WebArchiv',
    artwork,
  });
  const cached = hasImage ? articleArtworkCache.get(urlArtwork[1].src) : null;
  navigator.mediaSession.metadata = makeMetadata(cached ? [{ src: cached, sizes: '512x512', type: 'image/jpeg' }] : urlArtwork);

  if (hasImage && !cached) {
    articleArtworkDataUrl(urlArtwork[1].src).then(dataUrl => {
      if (token !== articleArtworkToken || !articleSessionActive) return;   // inzwischen anderer Artikel
      navigator.mediaSession.metadata = makeMetadata([{ src: dataUrl, sizes: '512x512', type: 'image/jpeg' }]);
    }).catch(() => { /* URL-Bild bleibt gemeldet */ });
  }

  const skip = 15;
  const handlers = {
    play: () => { if (typeof bookPlayerPause === 'function') bookPlayerPause(); audio.play().catch(() => {}); },
    pause: () => audio.pause(),
    seekbackward: d => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || skip)); },
    seekforward: d => { audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + (d.seekOffset || skip)); },
    seekto: d => { if (isFinite(d.seekTime)) audio.currentTime = d.seekTime; },
    previoustrack: null,
    nexttrack: null,
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* nicht unterstützt */ }
  }
}

// Artikel wechselt oder Audio endet: Sperrbildschirm freigeben bzw. wieder dem Hörbuch überlassen.
function releaseArticleMediaSession() {
  if (!articleSessionActive) return;
  articleSessionActive = false;
  articleSessionId = null;
  articleArtworkToken++;
  if (!('mediaSession' in navigator)) return;
  if (typeof bookMediaSession === 'function' && typeof bookPlayer !== 'undefined' && bookPlayer.book) {
    bookMediaSession();
    return;
  }
  navigator.mediaSession.metadata = null;
  for (const action of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto']) {
    try { navigator.mediaSession.setActionHandler(action, null); } catch { /* nicht unterstützt */ }
  }
}

function wireAudioPlayer(audioUrl, article) {
  audioEl = new Audio(audioUrl);
  audioEl.preload = 'metadata';
  const btn  = document.getElementById('audio-play-btn');
  const bar  = document.getElementById('audio-progress');
  const fill = document.getElementById('audio-progress-fill');
  const time = document.getElementById('audio-time');
  currentAudioBtn = btn;

  function fmt(s) {
    if (!isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2,'0');
    return `${m}:${sec}`;
  }

  function showAudioTime(seconds) {
    const pct = audioEl.duration ? (seconds / audioEl.duration * 100) : 0;
    fill.style.width = `${pct}%`;
    time.textContent = `${fmt(seconds)} / ${fmt(audioEl.duration)}`;
  }
  function updateAudioTime() {
    if (bar.classList.contains('is-active')) return;   // beim Ziehen zeigt der Balken die Zielzeit
    showAudioTime(audioEl.currentTime);
  }

  audioEl.addEventListener('loadedmetadata', updateAudioTime);
  audioEl.addEventListener('durationchange', updateAudioTime);
  audioEl.addEventListener('timeupdate', updateAudioTime);
  audioEl.load();

  audioEl.addEventListener('ended', () => {
    btn.classList.remove('playing');
    fill.style.width = '0%';
  });
  // Abspielen/Pause vom Sperrbildschirm aus: Knopf mitführen, Media Session übernehmen.
  const audio = audioEl;
  audio.addEventListener('play', () => {
    btn.classList.add('playing');
    if (article) setArticleMediaSession(article, audio);
  });
  audio.addEventListener('pause', () => btn.classList.remove('playing'));

  btn.addEventListener('click', () => {
    if (audioEl.paused) {
      if (typeof bookPlayerPause === 'function') bookPlayerPause();
      if (article) setArticleMediaSession(article, audioEl);   // vor play(), damit iOS das Bild sofort übernimmt
      audioEl.play();
      btn.classList.add('playing');
    } else {
      audioEl.pause();
      btn.classList.remove('playing');
    }
  });

  // Tippen springt, Halten/Ziehen verschiebt relativ; gesprungen wird beim Loslassen.
  const duration = () => (isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
  enableScrubBar(bar, {
    get: () => (duration() ? audio.currentTime / duration() : null),
    set: f => { if (duration()) audio.currentTime = f * duration(); updateAudioTime(); },
    preview: f => showAudioTime(f * duration()),
    label: f => esc(`${fmt(f * duration())} / ${fmt(duration())}`),
    onEnd: updateAudioTime,
  });
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
}

function applySavedListState(saved) {
  if (!saved) return;
  Object.assign(state, saved.list);
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
  applyBookMode();
}

async function restoreSessionView() {
  const explicitDeepLink = parseArticleHash(location.hash);
  const saved = sessionViewStore?.load(deviceStorage(), currentUser);
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
          && typeof currentBookDetail !== 'undefined' && currentBookDetail?.ebook
          && typeof openBookReader === 'function') {
        await openBookReader(currentBookDetail);
      }
    } else if (!explicitDeepLink) {
      history.replaceState(null, '', '#/');
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
}

$filterAuthor.addEventListener('change', async () => {
  restoringSessionView = true;
  state.externalAudio = $filterAuthor.value === '__external_audio__';
  state.author = state.externalAudio ? '' : $filterAuthor.value;
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
function setLayout(layout) {
  document.body.classList.toggle('layout-tall', layout === 'tall');
  document.body.classList.toggle('layout-list', layout === 'list');
  $filterLayout.querySelectorAll('[data-layout]').forEach(button => {
    const active = button.dataset.layout === layout;
    button.setAttribute('aria-checked', String(active));
    button.tabIndex = active ? 0 : -1;
  });
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
  setLayout(layout);
  restoringSessionView = true;
  try {
    // Ein bereits laufender Filter-/Seitenabruf darf nicht anschließend Daten
    // der alten Gruppierung in das gerade gewählte Layout schreiben.
    while (state.loading && generation === layoutChangeGeneration) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (generation !== layoutChangeGeneration) return;
    if (groupMode() !== wasGrouped) {
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

$filterLimit.addEventListener('change', () => {
  state.limit = parseInt($filterLimit.value);
  state.page = 1;
  loadArticles();
});

$telegramBtn.addEventListener('click', () => {
  setTelegram(!state.telegram);
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
  if (confirm('Wirklich abmelden?')) logout();
});

$loginBtn.addEventListener('click', () => showLogin());
$loginClose?.addEventListener('click', () => hideLogin());

$resetFilters.addEventListener('click', () => {
  $searchInput.value = '';
  $searchClear.classList.remove('visible');
  $filterAuthor.value = '';
  $filterYear.value = '';
  $filterCategory.value = '';
  setLayout('tall');
  $filterLimit.value = '24';
  setTelegram(false);
  setBookmarkFilter(false);
  Object.assign(state, { q:'', author:'', externalAudio:false, year:'', category:'', telegram:false, bookmarks:false, page:1, limit:24 });
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

// ── Audio erzeugen: bestätigter Start und wiederaufnehmbares Status-Polling ──
let selectedTtsArticle = null;
let ttsStarting = false;
let ttsActive = false;
let ttsJobId = null;
let ttsPollGeneration = 0;
let ttsReturnFocus = null;
const $ttsOverlay = document.getElementById('tts-overlay');
const $ttsStatus = document.getElementById('tts-status');
const $ttsOutput = document.getElementById('tts-output');
const $ttsCancel = document.getElementById('tts-cancel');
const $ttsAudio = document.getElementById('tts-audio');
const $ttsActivity = document.getElementById('tts-activity');
const $ttsReindex = document.getElementById('tts-reindex');

function updateTtsActions() {
  const disabled = !selectedTtsArticle || $overlay.hidden || ttsStarting || ttsActive;
  const startMenu = document.getElementById('tts-start-menu');
  if (startMenu) startMenu.disabled = disabled;
  document.querySelectorAll('[data-tts-action="start"]').forEach(button => { button.disabled = disabled; });
}
function rememberTtsJob(id) {
  ttsJobId = id;
  try {
    if (id) sessionStorage.setItem('wa-tts-job', id);
    else sessionStorage.removeItem('wa-tts-job');
  } catch { /* Status bleibt über den Server wiederauffindbar. */ }
}
function clearTtsUI() {
  ++ttsPollGeneration;
  rememberTtsJob(null);
  ttsActive = false;
  $ttsOverlay.hidden = true;
  $ttsOutput.textContent = '';
  $ttsStatus.textContent = '';
  $ttsAudio.hidden = true;
}
function openTtsModal() {
  ++ttsPollGeneration;
  if ($ttsOverlay.hidden) ttsReturnFocus = document.activeElement;
  $ttsOverlay.hidden = false;
  document.body.style.overflow = 'hidden';
  $ttsOutput.textContent = '';
  $ttsStatus.textContent = 'Auftrag wird geladen …';
  $ttsAudio.hidden = true;
  $ttsReindex.hidden = true;
  $ttsCancel.disabled = true;
  $ttsActivity.hidden = false;
  document.getElementById('tts-article').textContent = '';
  document.getElementById('tts-close').focus();
}
function closeTtsModal() {
  ++ttsPollGeneration;
  $ttsOverlay.hidden = true;
  document.body.style.overflow = $overlay.hidden ? '' : 'hidden';
  if (ttsReturnFocus?.isConnected) ttsReturnFocus.focus();
  else if (!$overlay.hidden) $overlayClose.focus();
  else $reindexBtn.focus();
}
function chooseTtsProvider(article, providers) {
  const dialog = document.getElementById('tts-provider-dialog');
  const options = document.getElementById('tts-provider-options');
  const start = document.getElementById('tts-provider-start');
  const description = document.getElementById('tts-provider-description');
  const status = document.getElementById('tts-provider-status');
  document.getElementById('tts-provider-article').textContent = article.title;
  options.replaceChildren();
  const radios = [];
  for (const provider of providers) {
    const label = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'tts-provider';
    radio.value = provider.provider;
    radio.disabled = !provider.available;
    radio.checked = provider.provider === 'qwen' && provider.available;
    const text = document.createElement('span');
    text.textContent = provider.label + (provider.available ? '' : ' – nicht verfügbar');
    label.append(radio); label.append(text);
    options.append(label);
    radios.push(radio);
  }
  const selectedProvider = () => providers.find(p => p.available
    && radios.some(radio => radio.checked && radio.value === p.provider));
  status.textContent = providers.map(p => `${p.label}: ${p.status}`).join('\n');
  const update = () => {
    const selected = selectedProvider();
    start.disabled = !selected;
    description.textContent = selected?.confirmation || (providers.some(p => p.available)
      ? 'Wählen Sie einen Anbieter. Erst der Startbutton bestätigt die Generierung.'
      : 'Kein Anbieter verfügbar. Bitte Server oder API-Schlüssel prüfen.');
  };
  for (const radio of radios) radio.onchange = update;
  update();
  dialog.returnValue = '';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => {
      const selected = selectedProvider();
      resolve(dialog.returnValue === 'start' ? selected || null : null);
    }, { once: true });
    dialog.showModal();
    (radios.find(radio => radio.checked) || radios.find(radio => !radio.disabled)
      || dialog.querySelector('button')).focus();
  });
}

async function runTts() {
  const article = selectedTtsArticle;
  if (!article || $overlay.hidden || currentUser?.role !== 'admin' || ttsStarting || ttsActive) return;
  ttsStarting = true;
  let startUncertain = false;
  updateTtsActions();
  try {
    const providerResponse = await apiFetch('/api/tts/provider');
    const info = await providerResponse.json();
    if (!providerResponse.ok) throw new Error(info.error || 'TTS-Provider nicht verfügbar.');
    if (currentUser?.role !== 'admin' || $overlay.hidden || selectedTtsArticle?.id !== article.id) return;
    const provider = await chooseTtsProvider(article, info.providers);
    if (!provider || currentUser?.role !== 'admin' || $overlay.hidden || selectedTtsArticle?.id !== article.id) return;
    openTtsModal();
    document.getElementById('tts-article').textContent = article.title;
    $ttsStatus.textContent = 'Audio-Auftrag wird gestartet …';
    startUncertain = true;
    const response = await apiFetch('/api/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articleId: article.id, provider: provider.provider }),
    });
    const data = await response.json();
    if (!response.ok) {
      startUncertain = false;
      throw new Error(data.error || 'Audio-Auftrag konnte nicht gestartet werden.');
    }
    if (currentUser?.role !== 'admin') return;
    rememberTtsJob(data.jobId);
    ttsActive = true;
    if (!$ttsOverlay.hidden) watchTts(data.jobId);
  } catch (error) {
    openTtsModal();
    $ttsActivity.hidden = true;
    $ttsStatus.textContent = error.message + (startUncertain
      ? ' Bei unklarer Verbindung „Status aktualisieren“ verwenden; der Auftrag könnte bereits laufen.' : '');
  } finally {
    ttsStarting = false;
    updateTtsActions();
  }
}
async function showTtsJob() {
  if (currentUser?.role !== 'admin') return;
  openTtsModal();
  const generation = ttsPollGeneration;
  try {
    // Funktioniert auch nach Reload oder in einem zweiten Browserfenster.
    const response = await apiFetch('/api/tts/latest');
    const data = await response.json();
    if (generation !== ttsPollGeneration) return;
    if (!response.ok) throw new Error(data.error || 'Auftrag nicht verfügbar.');
    rememberTtsJob(data.jobId);
    if (data.jobId) watchTts(data.jobId);
    else {
      ttsActive = false;
      updateTtsActions();
      $ttsActivity.hidden = true;
      $ttsStatus.textContent = 'Kein gespeicherter Audio-Auftrag vorhanden.';
    }
  } catch (error) {
    if (generation !== ttsPollGeneration) return;
    $ttsActivity.hidden = true;
    $ttsStatus.textContent = error.message;
  }
}
async function refreshTtsArticle(articleId) {
  await loadMeta();
  await loadArticles();
  if (!$overlay.hidden && selectedTtsArticle?.id === articleId) {
    const article = await fetchArticle(articleId);
    if (!$overlay.hidden && selectedTtsArticle?.id === articleId) {
      stopAudio();
      stopVideo();
      renderDetail(article);
    }
  }
}
function formatTtsOutput(output) {
  const pad = value => String(value).padStart(2, '0');
  return String(output || '').replace(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)(?= \[)/gm,
    (original, timestamp) => {
      const date = new Date(timestamp);
      if (!Number.isFinite(date.getTime())) return original;
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }
  );
}
async function watchTts(jobId) {
  const generation = ++ttsPollGeneration;
  let failures = 0;
  while (generation === ttsPollGeneration && !$ttsOverlay.hidden) {
    try {
      const response = await apiFetch(`/api/tts/${encodeURIComponent(jobId)}/status`);
      if (generation !== ttsPollGeneration) return;
      if ([401, 403, 404].includes(response.status)) {
        rememberTtsJob(null);
        ttsActive = false;
        updateTtsActions();
        $ttsOutput.textContent = '';
        $ttsCancel.disabled = true;
        $ttsActivity.hidden = true;
        $ttsStatus.textContent = 'Auftrag nicht verfügbar oder keine Berechtigung.';
        return;
      }
      if (!response.ok) throw new Error(`Status HTTP ${response.status}`);
      const s = await response.json();
      if (generation !== ttsPollGeneration) return;
      failures = 0;
      ttsActive = !s.done;
      updateTtsActions();
      document.getElementById('tts-article').textContent = s.title;
      const nextOutput = formatTtsOutput(s.output);
      if ($ttsOutput.textContent !== nextOutput) {
        const scrollTop = $ttsOutput.scrollTop;
        const atBottom = scrollTop + $ttsOutput.clientHeight >= $ttsOutput.scrollHeight - 24;
        $ttsOutput.textContent = nextOutput;
        $ttsOutput.scrollTop = atBottom ? $ttsOutput.scrollHeight : scrollTop;
      }
      const labels = { starting: 'Start wird vorbereitet …', running: 'Sprachgenerierung läuft …',
        cancelling: 'Abbruch angefordert …', indexing: 'MP3 fertig – Artikelindex wird aktualisiert …',
        succeeded: 'Fertig. Die MP3 wurde erzeugt.', failed: 'Sprachgenerierung fehlgeschlagen.', cancelled: 'Audio-Auftrag abgebrochen.' };
      $ttsStatus.textContent = s.indexError || s.error || ((labels[s.status] || s.status)
        + (!s.done && s.total ? ` · Chunk ${s.current || 0} von ${s.total}` : ''));
      $ttsCancel.disabled = s.done || ['cancelling', 'indexing'].includes(s.status);
      $ttsActivity.hidden = s.done;
      $ttsReindex.hidden = !s.indexError;
      if (s.done) {
        if (s.status === 'succeeded' && (s.audioUrl?.startsWith('/files/') || s.audioUrl?.startsWith('/audio-files/'))) {
          $ttsAudio.href = s.audioUrl;
          $ttsAudio.hidden = false;
          try { await refreshTtsArticle(s.articleId); }
          catch {
            if (generation === ttsPollGeneration) $ttsStatus.textContent += ' Die Artikelansicht konnte nicht aktualisiert werden. Bitte neu laden; die MP3 ist fertig.';
          }
        }
        return;
      }
    } catch {
      if (generation !== ttsPollGeneration) return;
      $ttsStatus.textContent = 'Verbindung unterbrochen; der Auftrag kann weiterlaufen. Status aktualisieren oder später wieder öffnen.';
      if (++failures >= 3) { $ttsActivity.hidden = true; return; }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
document.getElementById('tts-close').addEventListener('click', closeTtsModal);
document.getElementById('tts-backdrop').addEventListener('click', closeTtsModal);
document.getElementById('tts-refresh').addEventListener('click', showTtsJob);
$ttsReindex.addEventListener('click', async () => {
  await runReindex();
  if (ttsJobId && !$ttsOverlay.hidden) watchTts(ttsJobId);
});
$ttsCancel.addEventListener('click', async () => {
  if (!ttsJobId || $ttsCancel.disabled) return;
  $ttsCancel.disabled = true;
  const generation = ttsPollGeneration;
  try {
    const response = await apiFetch(`/api/tts/${encodeURIComponent(ttsJobId)}/cancel`, { method: 'POST' });
    if (!response.ok) throw new Error((await response.json()).error || 'Abbruch konnte nicht angefordert werden.');
    if (generation === ttsPollGeneration) watchTts(ttsJobId);
  } catch (error) {
    if (generation !== ttsPollGeneration) return;
    $ttsStatus.textContent = error.message;
    $ttsCancel.disabled = false;
  }
});
document.addEventListener('click', event => {
  const button = event.target.closest('[data-tts-action]');
  if (!button || button.disabled) return;
  if (button.dataset.ttsAction === 'start') runTts();
  else showTtsJob();
});
// Geöffnete Artikel-Aktionsmenüs schließen bei einem Klick außerhalb.
document.addEventListener('click', event => {
  document.querySelectorAll('.detail-tts-menu[open]').forEach(menu => {
    if (!menu.contains(event.target)) menu.removeAttribute('open');
  });
});
document.addEventListener('keydown', event => {
  if ($ttsOverlay.hidden) return;
  // Keine Navigation oder Schließen des darunterliegenden Artikels.
  event.stopImmediatePropagation();
  if (event.key === 'Escape') { event.preventDefault(); closeTtsModal(); }
  if (event.key === 'Tab') {
    const controls = [...$ttsOverlay.querySelectorAll('button, a[href], [tabindex="0"]')]
      .filter(element => !element.disabled && !element.hidden);
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
}, true);

async function runReindex() {
  if (!confirm('Archiv neu indizieren?')) return;
  $reindexBtn.disabled = true;
  $reindexBtn.textContent = '…';
  try {
    const r = await apiFetch('/api/reindex', { method: 'POST' });
    const data = await r.json();
    if (!data.started) {
      alert(data.error || 'Re-Index läuft bereits.');
      return;
    }
    await new Promise(resolve => {
      const poll = setInterval(async () => {
        try {
          const sr = await apiFetch('/api/reindex/status');
          const status = await sr.json();
          if (status.processed) {
            $count.textContent = `${status.processed.toLocaleString('de-DE')} Artikel verarbeitet…`;
          }
          if (status.done) { clearInterval(poll); resolve(); }
        } catch { clearInterval(poll); resolve(); }
      }, 600);
    });
    await loadMeta();
    state.page = 1;
    await loadArticles();
  } finally {
    $reindexBtn.disabled = false;
    $reindexBtn.textContent = '↺';
  }
}

function openScrapeModal(title) {
  $scrapeOverlay.hidden = false;
  document.body.style.overflow = 'hidden';
  if ($scrapeTitle) $scrapeTitle.textContent = title || 'Scrapen';
  $scrapeOutput.textContent = '';
  $scrapeStatus.textContent = '';
}
function closeScrapeModal() {
  $scrapeOverlay.hidden = true;
  document.body.style.overflow = '';
}
$scrapeClose.addEventListener('click', closeScrapeModal);
$scrapeBackdrop.addEventListener('click', closeScrapeModal);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$scrapeOverlay.hidden) closeScrapeModal();
});

async function runScrape() {
  if (!confirm('Neue Beiträge scrapen (Blog, Facebook, Telegram)? Das kann einige Minuten dauern.')) return;
  $reindexBtn.disabled = true;
  $reindexBtn.textContent = '…';
  openScrapeModal('Scrapen');
  $scrapeStatus.textContent = 'Scrape läuft …';
  try {
    const r = await apiFetch('/api/scrape', { method: 'POST' });
    const data = await r.json();
    if (!data.started) {
      $scrapeStatus.textContent = data.error || (data.reason === 'reindex running'
        ? 'Re-Index läuft gerade – bitte kurz warten.'
        : 'Ein Scrape-Lauf läuft bereits.');
      return;
    }
    // 1) Scrape-Lauf: Ausgabe live anzeigen, bis fertig.
    const result = await new Promise(resolve => {
      const poll = setInterval(async () => {
        try {
          const sr = await apiFetch('/api/scrape/status');
          const s = await sr.json();
          if (typeof s.output === 'string') {
            $scrapeOutput.textContent = s.output;
            $scrapeOutput.scrollTop = $scrapeOutput.scrollHeight;
          }
          if (s.done) { clearInterval(poll); resolve(s); }
        } catch { clearInterval(poll); resolve(null); }
      }, 1000);
    });
    if (result && result.exitCode === -1) {
      $scrapeStatus.textContent = 'Fehler: Scraper konnte nicht gestartet werden — ' + (result.error || 'unbekannt');
      return;
    }
    // 2) Anschließender, serverseitig angestoßener Reindex.
    $scrapeStatus.textContent = `Scrape fertig (Exit ${result ? result.exitCode : '?'}) — Index wird aktualisiert …`;
    await new Promise(resolve => {
      const poll = setInterval(async () => {
        try {
          const sr = await apiFetch('/api/reindex/status');
          const st = await sr.json();
          if (st.processed) {
            $count.textContent = `${st.processed.toLocaleString('de-DE')} Artikel verarbeitet…`;
          }
          if (st.done) { clearInterval(poll); resolve(); }
        } catch { clearInterval(poll); resolve(); }
      }, 600);
    });
    await loadMeta();
    state.page = 1;
    await loadArticles();
    $scrapeStatus.textContent = 'Fertig. Der Index wurde aktualisiert.';
  } catch (e) {
    $scrapeStatus.textContent = 'Abgebrochen: ' + ((e && e.message) || e);
  } finally {
    $reindexBtn.disabled = false;
    $reindexBtn.textContent = '↺';
  }
}

async function showScrapeLog() {
  openScrapeModal('Scrape-Log (letzte 100 Zeilen)');
  $scrapeStatus.textContent = 'Lade …';
  try {
    const r = await apiFetch('/api/scrape/log');
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !ct.includes('application/json')) {
      // Kein JSON -> vermutlich läuft eine ältere Server-Version ohne diese Route.
      $scrapeOutput.textContent =
        `Log-Endpoint nicht verfügbar (HTTP ${r.status}).\n` +
        `Vermutlich läuft eine ältere Server-Version — bitte die aktuelle server.js ` +
        `deployen und den Dienst neu starten (sudo systemctl restart nodeapp).`;
      $scrapeStatus.textContent = 'Fehler';
    } else {
      const data = await r.json();
      $scrapeOutput.textContent = data.text || '(leer)';
      $scrapeStatus.textContent = 'scraper/scrape_all.log';
    }
  } catch (e) {
    $scrapeOutput.textContent = 'Konnte das Log nicht laden: ' + ((e && e.message) || e);
    $scrapeStatus.textContent = 'Fehler';
  }
  // Beim Öffnen ans untere Ende scrollen (neueste Zeilen), nach oben scrollbar.
  requestAnimationFrame(() => { $scrapeOutput.scrollTop = $scrapeOutput.scrollHeight; });
}

// ── Aktions-Menü hinter dem ↺-Button ───────────────────────────────────────
function closeAdminMenu() {
  $adminMenu.hidden = true;
  $reindexBtn.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', onAdminOutside, true);
  document.removeEventListener('keydown', onAdminEsc, true);
}
function onAdminOutside(ev) {
  if (!$adminMenu.contains(ev.target) && ev.target !== $reindexBtn && !$reindexBtn.contains(ev.target)) {
    closeAdminMenu();
  }
}
function onAdminEsc(ev) {
  if (ev.key === 'Escape') { ev.stopPropagation(); closeAdminMenu(); }
}
$reindexBtn.addEventListener('click', e => {
  e.stopPropagation();
  if (!$adminMenu.hidden) { closeAdminMenu(); return; }
  updateTtsActions();
  $adminMenu.hidden = false;
  $reindexBtn.setAttribute('aria-expanded', 'true');
  document.addEventListener('click', onAdminOutside, true);
  document.addEventListener('keydown', onAdminEsc, true);
});
$adminMenu.addEventListener('click', ev => {
  const item = ev.target.closest('[data-action]');
  if (!item) return;
  closeAdminMenu();
  const action = item.dataset.action;
  if (action === 'reindex') runReindex();
  else if (action === 'scrape') runScrape();
  else if (action === 'log') showScrapeLog();
  else if (action === 'tts') runTts();
  else if (action === 'tts-job') showTtsJob();
  else if (action === 'new-infographic') openNewInfographic();
  else if (action === 'settings') openSettingsDialog();
  else if (action === 'users') openUserAdmin();
  else if (action === 'password') openPasswordDialog({ forced: false });
});

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

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!document.getElementById('img-fullscreen').hidden) { closeImageFullscreen(); return; }
    if (!$overlay.hidden) { closeOverlay(); return; }
    // Login-Dialog nur per ESC schließen, wenn Guest oder eingeloggt — nicht bei
    // initialem Pflicht-Login (kein currentUser).
    if (!$loginOverlay.hidden && currentUser) { hideLogin(); return; }
    return;
  }
  if ($overlay.hidden) return;
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const dir = e.key === 'ArrowRight' ? +1 : -1;
  // In der Vollansicht erst durch die Bilder der Gruppe, danach zum Nachbarartikel.
  if (!document.getElementById('img-fullscreen').hidden) stepFullscreen(dir);
  else navigateArticle(dir);
});

// Grundvergrößerung der Seite: Safari meldet bei Seitenzoom (Aa, z. B. 115 %)
// dauerhaft eine Skalierung über 1. Als Pinch-Zoom zählt nur, was darüber hinausgeht.
let baseViewportScale = window.visualViewport?.scale ?? 1;
window.visualViewport?.addEventListener('resize', () => {
  baseViewportScale = Math.min(baseViewportScale, window.visualViewport.scale);
});
function pinchZoomed() {
  return (window.visualViewport?.scale ?? 1) > baseViewportScale + 0.05;
}

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

function hasActiveSelection() {
  const sel = window.getSelection();
  return !!(sel && !sel.isCollapsed && sel.toString().trim());
}

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

// ── Bedienbare Fortschrittslinie (eBook-Reader, Audio-Player) ──────────────
// Kurz tippen = an die Stelle springen. Drücken und halten oder gleich ziehen = ohne
// Sprung relativ zur Fingerbewegung ab der aktuellen Stelle verschieben (ganze Breite =
// ganze Länge). Eine Sprechblase über der Linie zeigt die Stelle, damit der Finger sie
// nicht verdeckt. live: Position schon beim Ziehen setzen (Text); sonst erst beim
// Loslassen (Audio – kein Nachladen bei jeder Bewegung), dazwischen nur preview().
const SCRUB_HOLD_MS = 250;
const SCRUB_TAP_MOVE_PX = 6;
let $scrubBubble = null;

function showScrubBubble(bar, clientX, html) {
  if (!$scrubBubble) {
    $scrubBubble = document.createElement('div');
    $scrubBubble.className = 'scrub-bubble';
    document.body.appendChild($scrubBubble);
  }
  $scrubBubble.innerHTML = html;
  $scrubBubble.hidden = false;
  const r = bar.getBoundingClientRect();
  const half = $scrubBubble.offsetWidth / 2;
  $scrubBubble.style.left = Math.min(window.innerWidth - half - 8, Math.max(half + 8, clientX)) + 'px';
  $scrubBubble.style.top = Math.max(4, r.top - $scrubBubble.offsetHeight - 8) + 'px';
}

// get(): aktueller Anteil 0–1 oder null (z. B. Audiodauer noch unbekannt); set(f): Stelle
// setzen; label(f): HTML für die Sprechblase; onStart/onEnd: vor bzw. nach der Geste.
function enableScrubBar(bar, { get, set, label, live = false, preview, onStart, onEnd }) {
  let drag = null;   // { startX, lastX, startFraction, fraction, scrolling, timer }
  const fractionAt = clientX => {
    const r = bar.getBoundingClientRect();
    return r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;
  };
  const startScrolling = () => {
    if (!drag || drag.scrolling || drag.startFraction == null) return;
    drag.scrolling = true;
    bar.classList.add('is-active');
    showScrubBubble(bar, drag.lastX, label(drag.startFraction));
  };
  bar.addEventListener('pointerdown', event => {
    if (event.button > 0) return;
    event.preventDefault();
    try { bar.setPointerCapture(event.pointerId); } catch { /* ohne Capture: Ziehen endet am Rand der Tippzone */ }
    onStart?.();
    drag = { startX: event.clientX, lastX: event.clientX, startFraction: get(), fraction: null, scrolling: false, timer: setTimeout(startScrolling, SCRUB_HOLD_MS) };
  });
  bar.addEventListener('pointermove', event => {
    if (!drag) return;
    drag.lastX = event.clientX;
    if (drag.startFraction == null) drag.startFraction = get();   // Audiodauer inzwischen bekannt
    const dx = event.clientX - drag.startX;
    if (!drag.scrolling && Math.abs(dx) > SCRUB_TAP_MOVE_PX) startScrolling();
    if (!drag.scrolling) return;
    const width = bar.getBoundingClientRect().width || 1;
    const fraction = Math.min(1, Math.max(0, drag.startFraction + dx / width));
    drag.fraction = fraction;
    if (live) set(fraction); else preview?.(fraction);
    showScrubBubble(bar, event.clientX, label(fraction));
  });
  // Nur ein kurzes Tippen springt; Abbruch (pointercancel) übernimmt nichts.
  const end = (clientX, commit) => {
    if (!drag) return;
    const gesture = drag;
    drag = null;
    clearTimeout(gesture.timer);
    bar.classList.remove('is-active');
    if ($scrubBubble) $scrubBubble.hidden = true;
    if (commit && !gesture.scrolling) {
      if (get() != null) set(fractionAt(clientX));
    } else if (commit && !live && gesture.fraction != null) {
      set(gesture.fraction);
    }
    onEnd?.();
  };
  bar.addEventListener('pointerup', event => end(event.clientX, true));
  bar.addEventListener('pointercancel', () => end(null, false));
  bar.addEventListener('lostpointercapture', () => end(null, false));
}

// Nach unten wegziehen (Touch): Steht die Ansicht ganz oben, folgt sie dem Finger
// nach unten; ab PULL_CLOSE_DISTANCE schließt sie beim Loslassen, sonst federt sie
// zurück. Für Artikel/Hörbuch (Overlay) und die Bild-Vollansicht.
const PULL_CLOSE_DISTANCE = 120;
function enablePullToClose({ scroller, moving, fading, canStart, onClose }) {
  let startX = 0, startY = 0, dy = 0, state = 'idle'; // idle | pending | pulling
  const reset = animate => {
    moving.style.transition = animate ? 'transform .2s ease' : '';
    moving.style.transform = '';
    if (fading) { fading.style.transition = animate ? 'opacity .2s ease' : ''; fading.style.opacity = ''; }
    state = 'idle';
  };
  scroller.addEventListener('touchstart', e => {
    state = 'idle';
    if (e.touches.length !== 1 || scroller.scrollTop > 1 || hasActiveSelection()) return;
    // Vergrößert (Pinch oder Safaris Auto-Zoom nach einem Eingabefeld): nur, wenn der
    // sichtbare Ausschnitt schon ganz oben steht – sonst verschiebt Safari ihn.
    if ((pinchZoomed() && (window.visualViewport?.offsetTop ?? 0) > 1) || !canStart(e)) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    state = 'pending';
  }, { passive: true });
  scroller.addEventListener('touchmove', e => {
    if (state === 'idle') return;
    if (e.touches.length !== 1) { reset(true); return; }
    const x = e.touches[0].clientX - startX;
    dy = e.touches[0].clientY - startY;
    if (state === 'pending') {
      // Richtung gleich bei der ersten Bewegung festlegen: Sonst übernimmt iOS das
      // Scrollen (Gummiband) und ignoriert preventDefault danach.
      if (dy === 0 && x === 0) return;
      if (dy <= 0 || Math.abs(x) >= dy || scroller.scrollTop > 1) { state = 'idle'; return; }
      state = 'pulling';
      moving.style.transition = 'none';
      if (fading) fading.style.transition = 'none';
    }
    // Kein Scrollen/Neuladen der Seite, solange gezogen wird.
    e.preventDefault();
    const offset = Math.max(0, dy);
    moving.style.transform = `translateY(${offset}px)`;
    if (fading) fading.style.opacity = String(Math.max(0.25, 1 - offset / 400));
  }, { passive: false });
  const end = () => {
    if (state !== 'pulling') { state = 'idle'; return; }
    if (dy < PULL_CLOSE_DISTANCE) { reset(true); return; }
    moving.style.transition = 'transform .2s ease';
    moving.style.transform = `translateY(${window.innerHeight}px)`;
    state = 'idle';
    setTimeout(() => { reset(false); onClose(); }, 200);
  };
  scroller.addEventListener('touchend', end, { passive: true });
  // iOS bricht eine Geste teils mit touchcancel ab – dann wie Loslassen behandeln.
  scroller.addEventListener('touchcancel', end, { passive: true });
}

// Solange Artikel/Hörbuch offen sind, darf die Seite dahinter weder scrollen noch
// federn – sonst übernimmt Safari (Adressleiste unten) das Herunterziehen selbst.
new MutationObserver(() => {
  document.documentElement.classList.toggle('overlay-open', !$overlay.hidden);
}).observe($overlay, { attributes: true, attributeFilter: ['hidden'] });

const dialogOpen = () => !!document.querySelector('dialog[open]') || !$ttsOverlay.hidden;
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
  ['#infographic-new', '#infographic-new-cancel'],
  ['#password-dialog', '#password-cancel'],
  ['#settings-dialog', '#settings-form button[type="submit"]'],
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

// ── Bild herunterladen ─────────────────────────────────────────────────────
// Auf Touch-Geräten mit Teilen-Funktion (iPhone/iPad) öffnet der Button das System-
// Teilen-Menü mit dem Bild („Bild sichern“ → Fotos), das sich jederzeit abbrechen
// lässt; Safaris Abfrage für <a download> hat dort keinen Abbrechen-Knopf. Sonst
// bleibt es beim normalen Download. Das Bild wird beim Anzeigen schon vorbereitet,
// weil iOS das Teilen-Menü nur unmittelbar nach dem Tippen öffnet.
const shareImages = () => typeof navigator.canShare === 'function' && matchMedia('(pointer: coarse)').matches;
const imageFiles = new Map(); // URL → Promise<File|null>
const readyImageFiles = new Map(); // URL → File|null (fertig geladen)
const IMAGE_FILE_CACHE = 3;

function prepareImageFile(url) {
  if (!shareImages() || !url) return Promise.resolve(null);
  if (imageFiles.has(url)) return imageFiles.get(url);
  const name = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || 'bild.jpg');
  const promise = fetch(url)
    .then(r => (r.ok ? r.blob() : null))
    .then(blob => (blob ? new File([blob], name, { type: blob.type || 'image/jpeg' }) : null))
    .catch(() => null)
    .then(file => { readyImageFiles.set(url, file); return file; });
  imageFiles.set(url, promise);
  // Nur die letzten Bilder behalten.
  while (imageFiles.size > IMAGE_FILE_CACHE) {
    const oldest = imageFiles.keys().next().value;
    imageFiles.delete(oldest);
    readyImageFiles.delete(oldest);
  }
  return promise;
}

document.addEventListener('click', async e => {
  const link = e.target.closest?.('.detail-hero-download, #img-fullscreen-download');
  if (!link || !shareImages()) return;
  e.preventDefault();
  const url = link.getAttribute('href');
  const ready = readyImageFiles.has(url);
  const file = ready ? readyImageFiles.get(url) : await prepareImageFile(url);
  if (!file || !navigator.canShare({ files: [file] })) {
    // Teilen mit Datei nicht möglich: Bild in neuem Tab öffnen (dort per langem Druck sichern).
    window.open(url, '_blank', 'noopener');
    return;
  }
  try {
    await navigator.share({ files: [file] });
  } catch (err) {
    // AbortError = abgebrochen. NotAllowedError: Bild war noch nicht geladen und iOS
    // verlangt ein neues Tippen – jetzt liegt es bereit.
    if (err.name === 'NotAllowedError' && !ready) alert('Das Bild ist jetzt bereit. Bitte noch einmal tippen.');
  }
});

// Handle back button
window.addEventListener('popstate', () => {
  if (typeof leaveArticleEditor === 'function' && !leaveArticleEditor()) {
    history.pushState(null, '', articleEditorState.url);
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
  if ($overlay.hidden && (typeof bookReader === 'undefined' || !bookReader.el)) {
    lastListPosition = captureListPosition();
    scheduleCurrentViewSave();
  }
}, { passive: true });
$overlay.querySelector('.overlay-panel')?.addEventListener('scroll', () => {
  lastDetailPosition = captureDetailPosition();
  scheduleCurrentViewSave();
}, { passive: true });
window.addEventListener('pagehide', saveCurrentViewState);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveCurrentViewState();
});

// ── Global img error handler (avoids quote-nesting in onerror attr) ────────
function handleImgError(el) {
  el.onerror = null;
  // Nur das Bild ersetzen; Badges und Lesezeichen der Kachel bleiben stehen.
  el.insertAdjacentHTML('afterend', `<div class="card-image-placeholder">${svgImage()}</div>`);
  el.remove();
}

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
    showLogin();
    return;
  }
  if (!(await ensurePasswordChanged())) return;

  await restoreSessionView();
}

init();
