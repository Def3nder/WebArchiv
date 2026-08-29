/* WebArchiv — SPA frontend */

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  q: '',
  author: '',
  externalAudio: false,
  year: '',
  category: '',
  telegram: false,
  page: 1,
  limit: 24,
  total: 0,
  pages: 0,
  loading: false,
  currentItems: [],
  currentArticleIdx: -1,
};

let authorHueMap = {};  // author name → hue (0..359), gesetzt in loadMeta()
let audioEl = null;     // shared audio element
let currentAudioBtn = null;
let currentUser = null; // { email, role, allowedAuthors }
const INFOGRAPHIC_MAX_BYTES = 10 * 1024 * 1024;

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
const $filterFont     = document.getElementById('filter-font');
const $reindexBtn     = document.getElementById('reindex-btn');
const $adminMenu      = document.getElementById('admin-menu');
const $scrapeOverlay  = document.getElementById('scrape-overlay');
const $scrapeBackdrop = document.getElementById('scrape-backdrop');
const $scrapeClose    = document.getElementById('scrape-close');
const $scrapeTitle    = document.getElementById('scrape-title');
const $scrapeStatus   = document.getElementById('scrape-status');
const $scrapeOutput   = document.getElementById('scrape-output');
const $themeBtn       = document.getElementById('theme-btn');
const $telegramBtn    = document.getElementById('telegram-btn');
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

function openImageFullscreen(src) {
  document.getElementById('img-fullscreen-img').src = src;
  resetImageZoom();
  document.getElementById('img-fullscreen').hidden = false;
}
function closeImageFullscreen() {
  document.getElementById('img-fullscreen').hidden = true;
  resetImageZoom();
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
    openArticle(state.currentItems[newIdx].id);
  } else if (dir > 0 && state.page < state.pages) {
    state.page++;
    await loadArticles();
    if (state.currentItems.length) openArticle(state.currentItems[0].id);
  } else if (dir < 0 && state.page > 1) {
    state.page--;
    await loadArticles();
    if (state.currentItems.length) openArticle(state.currentItems[state.currentItems.length - 1].id);
  }
}

function applyFont(value) {
  document.body.dataset.font = value;
  localStorage.setItem('wa-font', value);
}

const SVG_SUN  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`;
const SVG_MOON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

function applyTheme(value) {
  document.body.dataset.theme = value;
  localStorage.setItem('wa-theme', value);
  if (value === 'light') {
    $themeBtn.innerHTML = SVG_MOON;
    $themeBtn.title = 'Dunkel-Modus';
  } else {
    $themeBtn.innerHTML = SVG_SUN;
    $themeBtn.title = 'Hell-Modus';
  }
}

function setTelegram(on) {
  state.telegram = on;
  $telegramBtn.classList.toggle('active', on);
  $telegramBtn.setAttribute('aria-pressed', String(on));
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

function applyUserUI(user) {
  const isGuest = !user || user.role === 'guest';
  $reindexBtn.hidden = !(user && user.role === 'admin');
  $logoutBtn.hidden  = isGuest;
  $loginBtn.hidden   = !isGuest;
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
    await loadMeta();
    await loadArticles();
    const deepId = location.hash.startsWith('#/article/')
      ? decodeURIComponent(location.hash.slice('#/article/'.length))
      : null;
    if (deepId) openArticle(deepId);
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
  state.page = 1;
  state.author = '';
  state.year = '';
  state.category = '';
  $filterAuthor.value = '';
  $filterYear.value = '';
  $filterCategory.value = '';
  if (currentUser) {
    await loadMeta();
    await loadArticles();
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
  qs.set('page',  params.page  || 1);
  qs.set('limit', params.limit || 24);
  const r = await apiFetch(`/api/articles?${qs}`);
  return r.json();
}

async function fetchArticle(id) {
  const r = await apiFetch(`/api/articles/${id}`);
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

  const imageHtml = article.imageUrl
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
      <div class="card-image">
        ${imageHtml}
        ${audioBadge || videoBadge || pdfBadge
          ? `<div class="card-badges">${audioBadge}${videoBadge}${pdfBadge}</div>`
          : ''}
      </div>
      <div class="card-body">
        <div class="card-meta">
          <span class="author-badge" style="--author-hue:${hue}">${esc(article.author.replace(/_/g,' '))}</span>
          <span class="card-date">${esc(formatDate(article.date))}</span>
          ${epNum}
        </div>
        <h2 class="card-title">${esc(article.title)}</h2>
        ${catPills ? `<div class="card-categories">${catPills}</div>` : ''}
        <p class="card-preview">${esc(article.preview || article.excerpt)}</p>
      </div>
    </article>`;
}

function renderGrid(items) {
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
async function loadArticles() {
  if (state.loading) return;
  state.loading = true;

  try {
    const data = await fetchArticles({
      q:        state.q,
      author:   state.author,
      externalAudio: state.externalAudio,
      year:     state.year,
      category: state.category,
      telegram: state.telegram,
      page:     state.page,
      limit:    state.limit,
    });

    state.total = data.total;
    state.pages = data.pages;
    state.currentItems = data.items;

    $count.textContent = `${data.total.toLocaleString('de-DE')} Artikel`;
    $app.innerHTML = renderGrid(data.items) + renderPagination(state.page, state.pages);

    // Attach card click handlers
    $app.querySelectorAll('.card').forEach(card => {
      const handler = () => openArticle(card.dataset.id);
      card.addEventListener('click', handler);
      card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') handler(); });
    });

    // Attach pagination handlers
    $app.querySelectorAll('.page-btn[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = parseInt(btn.dataset.page);
        if (p !== state.page) {
          state.page = p;
          window.scrollTo({ top: 116, behavior: 'smooth' });
          loadArticles();
        }
      });
    });

  } catch (err) {
    $app.innerHTML = `<div class="empty-state"><p>Fehler beim Laden: ${esc(err.message)}</p></div>`;
  } finally {
    state.loading = false;
  }
}

// ── Article detail overlay ─────────────────────────────────────────────────
async function openArticle(id) {
  $overlay.hidden = false;
  document.body.style.overflow = 'hidden';
  // Beim Artikel-Wechsel laufende Medien stoppen
  stopAudio();
  stopVideo();
  $detail.innerHTML = `<div style="padding:80px 40px;text-align:center;color:var(--text-muted)"><div class="spinner" style="margin:0 auto"></div></div>`;

  // Update hash without triggering popstate
  history.pushState(null, '', `#/article/${sanitizeForId(id)}`);

  try {
    const article = await fetchArticle(id);
    state.currentArticleIdx = state.currentItems.findIndex(a => a.id === id);
    updateNavButtons();
    renderDetail(article);

    // If fullscreen image is open, update it to the new article's image
    const $fs = document.getElementById('img-fullscreen');
    if (!$fs.hidden) {
      if (article.imageUrl) {
        document.getElementById('img-fullscreen-img').src = article.imageUrl;
      } else {
        closeImageFullscreen();
      }
    }
  } catch (err) {
    // Geschützter Artikel + Gast (403) → Anmeldung anbieten statt "nicht gefunden".
    // Overlay ausblenden, aber Deep-Link im Hash lassen, damit die Anmeldung den
    // Artikel danach automatisch öffnet (siehe login()).
    if (err && err.status === 403 && (!currentUser || currentUser.role === 'guest')) {
      $overlay.hidden = true;
      stopAudio();
      stopVideo();
      showLogin('Dieser Artikel ist geschützt. Bitte melden Sie sich an.');
      return;
    }
    $detail.innerHTML = `<div style="padding:40px"><p>Artikel nicht gefunden.</p></div>`;
  }
}

function closeOverlay() {
  $overlay.hidden = true;
  document.body.style.overflow = '';
  stopAudio();
  stopVideo();
  history.pushState(null, '', '#/');
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
  if (currentAudioBtn) {
    currentAudioBtn.classList.remove('playing');
    currentAudioBtn = null;
  }
}

function renderDetail(article) {
  const hue = authorHue(article.author);

  const heroHtml = article.imageUrl
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
        <button class="detail-cat-pill detail-copy-btn" id="detail-copy-btn" aria-label="Titel und Text kopieren">
          <span class="detail-copy-icon" data-copy-zone="prompt" title="Prompt auswählen" aria-haspopup="menu" aria-expanded="false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="11" height="11" rx="2"/>
              <path d="M5 15V5a2 2 0 0 1 2-2h10"/>
            </svg>
          </span><span class="detail-copy-text" data-copy-zone="plain" title="Titel + Text kopieren">copy</span>
        </button>
        <div class="copy-prompt-menu" id="copy-prompt-menu" role="menu" hidden></div>
      </div>`
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
          ${infographicBtnHtml}
          ${copyBtnHtml}
          ${shareBtnHtml}
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
  if (article.imageUrl) {
    const openFs = () => openImageFullscreen(article.imageUrl);
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
  const $copyIcon = $copyBtn?.querySelector('.detail-copy-icon');

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
      $copyIcon?.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onOutside, true);
      document.removeEventListener('keydown', onEsc, true);
    };
    const onOutside = ev => { if (!$copyMenu.contains(ev.target) && ev.target !== $copyIcon && !$copyIcon.contains(ev.target)) closeMenu(); };
    const onEsc = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); closeMenu(); } };

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
      const zone = e.target.closest('[data-copy-zone]');
      const wantsMenu = zone?.dataset.copyZone === 'prompt'
                     || (!zone && !!e.target.closest('svg'));
      if (wantsMenu) {
        if (!$copyMenu.hidden) { closeMenu(); return; }
        await buildMenu();
        $copyMenu.hidden = false;
        $copyIcon?.setAttribute('aria-expanded', 'true');
        document.addEventListener('click', onOutside, true);
        document.addEventListener('keydown', onEsc, true);
      } else {
        copyArticle('');
      }
    });
  }

  // Wire up audio player
  if (article.audioUrl) {
    wireAudioPlayer(article.audioUrl);
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
  const viewerUrl = '/pdfjs/web/viewer.html?file=' + encodeURIComponent(fileParam);
  return `<div class="pdf-player">
    <iframe src="${viewerUrl}" class="detail-pdf" title="PDF-Dokument"></iframe>
    <a class="pdf-hint" href="${esc(pdfUrl)}" target="_blank" rel="noopener">
      PDF in neuem Tab öffnen ↗
    </a>
  </div>`;
}

function wireAudioPlayer(audioUrl) {
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

  function updateAudioTime() {
    const pct = audioEl.duration ? (audioEl.currentTime / audioEl.duration * 100) : 0;
    fill.style.width = `${pct}%`;
    time.textContent = `${fmt(audioEl.currentTime)} / ${fmt(audioEl.duration)}`;
  }

  audioEl.addEventListener('loadedmetadata', updateAudioTime);
  audioEl.addEventListener('durationchange', updateAudioTime);
  audioEl.addEventListener('timeupdate', updateAudioTime);
  audioEl.load();

  audioEl.addEventListener('ended', () => {
    btn.classList.remove('playing');
    fill.style.width = '0%';
  });

  btn.addEventListener('click', () => {
    if (audioEl.paused) {
      audioEl.play();
      btn.classList.add('playing');
    } else {
      audioEl.pause();
      btn.classList.remove('playing');
    }
  });

  bar.addEventListener('click', e => {
    const rect = bar.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    if (audioEl.duration) {
      audioEl.currentTime = pct * audioEl.duration;
    }
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

  authors.forEach((a, i) => {
    authorHueMap[a] = Math.round(i * hueStep);
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

// ── Event wiring ───────────────────────────────────────────────────────────
let searchTimer = null;
$searchInput.addEventListener('input', () => {
  const val = $searchInput.value.trim();
  $searchClear.classList.toggle('visible', val.length > 0);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = val;
    state.page = 1;
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

$filterAuthor.addEventListener('change', () => {
  state.externalAudio = $filterAuthor.value === '__external_audio__';
  state.author = state.externalAudio ? '' : $filterAuthor.value;
  if (state.author === 'Telegram') setTelegram(true);
  state.page = 1;
  loadArticles();
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

$filterLayout.addEventListener('change', () => {
  document.body.classList.toggle('layout-tall', $filterLayout.value === 'tall');
});

$filterLimit.addEventListener('change', () => {
  state.limit = parseInt($filterLimit.value);
  state.page = 1;
  loadArticles();
});

$filterFont.addEventListener('change', () => applyFont($filterFont.value));

$themeBtn.addEventListener('click', () => {
  applyTheme(document.body.dataset.theme === 'light' ? 'dark' : 'light');
});

$telegramBtn.addEventListener('click', () => {
  setTelegram(!state.telegram);
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
  $filterLayout.value = 'tall';
  document.body.classList.add('layout-tall');
  $filterLimit.value = '24';
  setTelegram(false);
  Object.assign(state, { q:'', author:'', externalAudio:false, year:'', category:'', telegram:false, page:1, limit:24 });
  loadArticles();
});

async function runReindex() {
  if (!confirm('Archiv neu indizieren?')) return;
  $reindexBtn.disabled = true;
  $reindexBtn.textContent = '…';
  try {
    const r = await apiFetch('/api/reindex', { method: 'POST' });
    const data = await r.json();
    if (!data.started) {
      alert('Re-Index läuft bereits.');
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
      $scrapeStatus.textContent = data.reason === 'reindex running'
        ? 'Re-Index läuft gerade – bitte kurz warten.'
        : 'Ein Scrape-Lauf läuft bereits.';
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
$imgFullscreenImg.addEventListener('click', e => e.stopPropagation());
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
  if (e.key === 'ArrowRight') navigateArticle(+1);
  if (e.key === 'ArrowLeft')  navigateArticle(-1);
});

// Returns false when the user is panning within a zoomed viewport and hasn't reached the edge yet.
function swipeAllowed(delta) {
  const scale = window.visualViewport?.scale ?? 1;
  if (scale <= 1) return true;
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
const $overlayPanel = $overlay.querySelector('.overlay-panel');
$overlayPanel.addEventListener('touchstart', e => {
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
  touchStartTime = Date.now();
  touchStartMulti = e.touches.length > 1;
}, { passive: true });
$overlayPanel.addEventListener('touchend', e => {
  if (touchStartMulti) return;
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
    navigateArticle(dx < 0 ? +1 : -1);
  }
}, { passive: true });

// Handle back button
window.addEventListener('popstate', () => {
  const hash = location.hash;
  if (!hash || hash === '#/' || hash === '#') {
    if (!$overlay.hidden) {
      $overlay.hidden = true;
      document.body.style.overflow = '';
      stopAudio();
      stopVideo();
    }
  } else if (hash.startsWith('#/article/')) {
    const id = decodeURIComponent(hash.slice('#/article/'.length));
    openArticle(id);
  }
});

// ── Global img error handler (avoids quote-nesting in onerror attr) ────────
function handleImgError(el) {
  el.onerror = null;
  el.parentElement.innerHTML = `<div class="card-image-placeholder">${svgImage()}</div>`;
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
function svgShare() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 3.9M15.4 6.6 8.6 10.5"/></svg>`;
}

// ── Boot ───────────────────────────────────────────────────────────────────
async function init() {
  $loading.hidden = false;
  document.body.classList.toggle('layout-tall', $filterLayout.value === 'tall');

  const savedTheme = localStorage.getItem('wa-theme') || 'light';
  applyTheme(savedTheme);

  const savedFont = localStorage.getItem('wa-font') || 'system';
  $filterFont.value = savedFont;
  applyFont(savedFont);

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

  // Check for article deep-link in hash
  const deepId = location.hash.startsWith('#/article/')
    ? decodeURIComponent(location.hash.slice('#/article/'.length))
    : null;

  await loadMeta();
  await loadArticles();

  if (deepId) openArticle(deepId);
}

init();
