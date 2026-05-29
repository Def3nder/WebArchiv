/* WebArchiv — SPA frontend */

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  q: '',
  author: '',
  year: '',
  category: '',
  page: 1,
  limit: 24,
  total: 0,
  pages: 0,
  loading: false,
  currentItems: [],
  currentArticleIdx: -1,
};

let authorIndex = {};   // author name → index for CSS class
let audioEl = null;     // shared audio element
let currentAudioBtn = null;

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
const $themeBtn       = document.getElementById('theme-btn');
const $overlay        = document.getElementById('article-overlay');
const $overlayClose   = document.getElementById('overlay-close');
const $overlayBdrop   = document.getElementById('overlay-backdrop');
const $detail         = document.getElementById('article-detail');
const $loading        = document.getElementById('loading');

// ── Helpers ────────────────────────────────────────────────────────────────
function openImageFullscreen(src) {
  document.getElementById('img-fullscreen-img').src = src;
  document.getElementById('img-fullscreen').hidden = false;
}
function closeImageFullscreen() {
  document.getElementById('img-fullscreen').hidden = true;
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

function authorClass(author) {
  if (!(author in authorIndex)) {
    authorIndex[author] = Object.keys(authorIndex).length;
  }
  return `author-${authorIndex[author] % 4}`;
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

// ── API calls ──────────────────────────────────────────────────────────────
async function fetchMeta() {
  const r = await fetch('/api/meta');
  return r.json();
}

async function fetchArticles(params = {}) {
  const qs = new URLSearchParams();
  if (params.q)        qs.set('q', params.q);
  if (params.author)   qs.set('author', params.author);
  if (params.year)     qs.set('year', params.year);
  if (params.category) qs.set('category', params.category);
  qs.set('page',  params.page  || 1);
  qs.set('limit', params.limit || 24);
  const r = await fetch(`/api/articles?${qs}`);
  return r.json();
}

async function fetchArticle(id) {
  const r = await fetch(`/api/articles/${id}`);
  if (!r.ok) throw new Error('Not found');
  return r.json();
}

// ── Rendering ──────────────────────────────────────────────────────────────
function renderCard(article, idx) {
  const ac = authorClass(article.author);
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
    ? `<div class="card-pdf-badge">&#8659; PDF</div>`
    : '';

  const catPills = cats.map(c =>
    `<span class="cat-pill">${esc(c)}</span>`
  ).join('');

  const epNum = article.episodeNum ? `<span class="episode-num">#${article.episodeNum}</span>` : '';

  return `
    <article class="card" data-id="${esc(article.id)}" style="animation-delay:${delay}ms" tabindex="0" role="button" aria-label="${esc(article.title)}">
      <div class="card-image">
        ${imageHtml}
        ${audioBadge}${videoBadge}${pdfBadge}
      </div>
      <div class="card-body">
        <div class="card-meta">
          <span class="author-badge ${ac}">${esc(article.author.replace(/_/g,' '))}</span>
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
      year:     state.year,
      category: state.category,
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
  const ac = authorClass(article.author);

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

  const dateHtml = article.date
    ? `<div class="detail-date-block">${esc(formatDate(article.date))}</div>`
    : '';
  const summaryHtml = article.summary
    ? `<div class="detail-summary"><span class="detail-summary-label">Zusammenfassung:</span> ${esc(article.summary)}</div>`
    : '';

  $detail.innerHTML = `
    ${heroHtml}
    <div class="detail-content">
      <div class="detail-meta">
        <span class="author-badge ${ac}">${esc(article.author.replace(/_/g,' '))}</span>
        ${article.episodeNum ? `<span class="detail-episode">#${article.episodeNum}</span>` : ''}
      </div>
      <h1 class="detail-title">${esc(article.title)}</h1>
      ${(cats || tagPills) ? `<div class="detail-categories">${cats}${tagPills ? `<span style="color:var(--text-dim);font-size:.7rem;align-self:center;margin-left:4px">|</span>${tagPills}` : ''}</div>` : ''}
      ${dateHtml}
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

  // Category pill → filter
  $detail.querySelectorAll('.detail-cat-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const cat = pill.dataset.cat;
      closeOverlay();
      $filterCategory.value = cat;
      state.category = cat;
      state.page = 1;
      loadArticles();
    });
  });

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
        <span class="audio-label">Audioquickie</span>
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
  const viewerUrl = '/pdfjs/web/viewer.html?file=' + encodeURIComponent(pdfUrl);
  return `<div class="pdf-player">
    <iframe src="${viewerUrl}" class="detail-pdf" title="PDF-Dokument"></iframe>
    <a class="pdf-hint" href="${esc(pdfUrl)}" target="_blank" rel="noopener">
      PDF in neuem Tab öffnen ↗
    </a>
  </div>`;
}

function wireAudioPlayer(audioUrl) {
  audioEl = new Audio(audioUrl);
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

  audioEl.addEventListener('timeupdate', () => {
    const pct = audioEl.duration ? (audioEl.currentTime / audioEl.duration * 100) : 0;
    fill.style.width = `${pct}%`;
    time.textContent = `${fmt(audioEl.currentTime)} / ${fmt(audioEl.duration)}`;
  });

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

  authors.forEach(a => {
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
  state.author = $filterAuthor.value;
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

$resetFilters.addEventListener('click', () => {
  $searchInput.value = '';
  $searchClear.classList.remove('visible');
  $filterAuthor.value = '';
  $filterYear.value = '';
  $filterCategory.value = '';
  $filterLayout.value = 'tall';
  document.body.classList.add('layout-tall');
  $filterLimit.value = '24';
  Object.assign(state, { q:'', author:'', year:'', category:'', page:1, limit:24 });
  loadArticles();
});

$reindexBtn.addEventListener('click', async () => {
  if (!confirm('Archiv neu indizieren?')) return;
  $reindexBtn.disabled = true;
  $reindexBtn.textContent = '…';
  try {
    const r = await fetch('/api/reindex', { method: 'POST' });
    const data = await r.json();
    if (!data.started) {
      alert('Re-Index läuft bereits.');
      return;
    }
    await new Promise(resolve => {
      const poll = setInterval(async () => {
        try {
          const sr = await fetch('/api/reindex/status');
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
});

$overlayClose.addEventListener('click', closeOverlay);
$overlayBdrop.addEventListener('click', closeOverlay);
document.getElementById('overlay-prev').addEventListener('click', () => navigateArticle(-1));
document.getElementById('overlay-next').addEventListener('click', () => navigateArticle(+1));
document.getElementById('img-fullscreen-close').addEventListener('click', closeImageFullscreen);
document.getElementById('img-fullscreen').addEventListener('click', closeImageFullscreen);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!document.getElementById('img-fullscreen').hidden) { closeImageFullscreen(); return; }
    if (!$overlay.hidden) closeOverlay();
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

// Touch swipe on overlay panel
let touchStartX = 0;
let touchStartMulti = false;
const $overlayPanel = $overlay.querySelector('.overlay-panel');
$overlayPanel.addEventListener('touchstart', e => {
  touchStartX = e.touches[0].clientX;
  touchStartMulti = e.touches.length > 1;
}, { passive: true });
$overlayPanel.addEventListener('touchend', e => {
  if (touchStartMulti) return;
  const delta = e.changedTouches[0].clientX - touchStartX;
  if (Math.abs(delta) > 60 && swipeAllowed(delta)) navigateArticle(delta < 0 ? +1 : -1);
}, { passive: true });

// Touch swipe on fullscreen image overlay
let fsTouchStartX = 0;
let fsTouchStartMulti = false;
const $imgFs = document.getElementById('img-fullscreen');
$imgFs.addEventListener('touchstart', e => {
  fsTouchStartX = e.touches[0].clientX;
  fsTouchStartMulti = e.touches.length > 1;
}, { passive: true });
$imgFs.addEventListener('touchend', e => {
  if (fsTouchStartMulti) return;
  const delta = e.changedTouches[0].clientX - fsTouchStartX;
  if (Math.abs(delta) > 60 && swipeAllowed(delta)) navigateArticle(delta < 0 ? +1 : -1);
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

// ── Boot ───────────────────────────────────────────────────────────────────
async function init() {
  $loading.hidden = false;
  document.body.classList.toggle('layout-tall', $filterLayout.value === 'tall');

  // Check for article deep-link in hash
  const hash = location.hash;
  const deepId = hash.startsWith('#/article/')
    ? decodeURIComponent(hash.slice('#/article/'.length))
    : null;

  const savedTheme = localStorage.getItem('wa-theme') || 'dark';
  applyTheme(savedTheme);

  const savedFont = localStorage.getItem('wa-font') || 'system';
  $filterFont.value = savedFont;
  applyFont(savedFont);

  await loadMeta();
  await loadArticles();

  $loading.hidden = true;

  if (deepId) {
    openArticle(deepId);
  }
}

init();
