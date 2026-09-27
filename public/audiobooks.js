/* WebArchiv — Hörbücher: Liste, Detailansicht, Player mit Hörposition pro Nutzer */

const BOOK_SPEEDS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const BOOK_SAVE_INTERVAL_MS = 15000;
const $miniPlayer = document.getElementById('mini-player');
const $bookSort = document.getElementById('filter-book-sort');

// Ein Player für das ganze Buch; läuft unabhängig von der Detailansicht weiter.
const bookPlayer = {
  book: null,          // Detaildaten inkl. tracks, config, progress
  index: 0,
  speed: 1,
  audio: null,
  pendingSeek: null,   // { fromStart } oder { fromEnd } für Sprünge über Dateigrenzen
  playAfterLoad: false,
  lastSavedAt: 0,
  saving: null,
};

// Aktuell angezeigtes Hörbuch (für „Abstract editieren“ im Aktionen-Menü).
let currentBookDetail = null;

// ── Liste ──────────────────────────────────────────────────────────────────
try {
  const saved = localStorage.getItem('wa-book-sort');
  if (['recent', 'title', 'date'].includes(saved)) state.bookSort = saved;
} catch { /* Speicher nicht verfügbar */ }
$bookSort.value = state.bookSort;
$bookSort.addEventListener('change', () => {
  state.bookSort = $bookSort.value;
  try { localStorage.setItem('wa-book-sort', state.bookSort); } catch { /* ignorieren */ }
  state.page = 1;
  loadArticles();
});

async function fetchAudiobooks() {
  const qs = new URLSearchParams();
  if (state.q) qs.set('q', state.q);
  qs.set('sort', state.bookSort);
  qs.set('page', state.page || 1);
  qs.set('limit', state.limit || 24);
  const r = await apiFetch(`/api/audiobooks?${qs}`);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Hörbücher konnten nicht geladen werden.');
  return data;
}

function bookProgressText(progress) {
  if (!progress) return '';
  return `Teil ${progress.trackIndex + 1} von ${progress.trackCount}`;
}

function renderBookCard(book, idx) {
  const delay = Math.min(idx * 30, 300);
  const imageHtml = book.imageUrl
    ? `<img src="${esc(book.imageUrl)}" alt="" loading="lazy" onerror="handleImgError(this)" />`
    : `<div class="card-image-placeholder">${svgImage()}</div>`;
  const parts = book.trackCount === 1 ? '1 Teil' : `${book.trackCount} Teile`;
  const progress = book.progress;
  const pct = progress ? Math.round(((progress.trackIndex + 1) / progress.trackCount) * 100) : 0;
  return `
    <article class="card card-book" data-id="${esc(book.id)}" data-author="${esc(book.author)}" style="animation-delay:${delay}ms" tabindex="0" role="button" aria-label="${esc(book.title)}">
      <div class="card-image">
        ${imageHtml}
        <div class="card-badges"><div class="card-audio-badge">${svgHeadphones()}<span>Hörbuch · ${parts}</span></div></div>
      </div>
      <div class="card-body">
        <div class="card-meta">
          ${book.bookAuthor ? `<span class="card-book-author">${esc(book.bookAuthor)}</span>` : ''}
          ${book.date ? `<span class="card-date"><span class="date-long">${esc(formatDate(book.date))}</span><span class="date-short">${esc(formatDateShort(book.date))}</span></span>` : ''}
        </div>
        <h2 class="card-title">${esc(book.title)}</h2>
        ${progress ? `<div class="card-book-progress" title="${esc(bookProgressText(progress))}">
            <div class="card-book-progress-bar"><div style="width:${pct}%"></div></div>
            <span>${esc(bookProgressText(progress))}</span>
          </div>` : ''}
        <p class="card-preview">${esc(book.excerpt)}</p>
      </div>
    </article>`;
}

function renderBookGrid(items) {
  if (!items.length) {
    return `<div class="empty-state">
      ${svgSearch()}
      <h2>Keine Hörbücher gefunden</h2>
      <p>Versuche andere Suchbegriffe.</p>
    </div>`;
  }
  return `<div class="article-grid">${items.map((b, i) => renderBookCard(b, i)).join('')}</div>`;
}

// ── Detailansicht ──────────────────────────────────────────────────────────
function renderBookDetail(book) {
  selectedTtsArticle = null;
  updateTtsActions();
  currentBookDetail = book;
  // Läuft dieses Buch bereits, gilt die aktuelle Wiedergabeposition.
  if (bookPlayer.book?.id === book.id) {
    bookPlayer.book = { ...book, progress: bookPlayer.book.progress };
  }
  const hue = authorHue(book.author);
  const heroHtml = book.imageUrl
    ? `<div class="detail-hero detail-hero-book">
        <img src="${esc(book.imageUrl)}" alt="" id="detail-hero-img" />
        <button class="detail-hero-expand" id="detail-hero-expand" aria-label="Vollbild">${svgExpand()}</button>
      </div>`
    : `<div class="detail-hero"><div class="detail-hero-placeholder">${svgImage(true)}</div></div>`;
  const editMenu = currentUser?.role === 'admin' && book.hasAbstract
    ? `<details class="detail-tts-menu"><summary class="detail-cat-pill" title="Kurzbeschreibung bearbeiten">Aktionen</summary><div class="copy-prompt-menu"><button type="button" class="header-menu-item" data-article-edit>Abstract editieren</button></div></details>`
    : '';
  const tracks = book.tracks.map((track, i) =>
    `<li><button type="button" class="book-track" data-track="${i}"><span class="book-track-num">${i + 1}</span><span class="book-track-title">${esc(track.title)}</span></button></li>`
  ).join('');

  $detail.innerHTML = `
    ${heroHtml}
    <div class="detail-content">
      <div class="detail-meta">
        <span class="author-badge" style="--author-hue:${hue}">${esc(book.author)}</span>
      </div>
      <h1 class="detail-title">${esc(book.title)}</h1>
      ${book.bookAuthor ? `<p class="detail-book-author">von ${esc(book.bookAuthor)}</p>` : ''}
      <div class="detail-date-row">
        <span class="detail-date-block">${book.date ? esc(formatDate(book.date)) : ''}</span>
        <div class="detail-action-row">${editMenu}</div>
      </div>
      <div class="detail-divider"></div>
      <div class="book-player" id="book-player">
        <div class="book-player-now">
          <span class="book-player-track" data-book-ui="track"></span>
          <span class="book-player-time" data-book-ui="time">0:00 / 0:00</span>
        </div>
        <div class="audio-progress book-progress" data-book-ui="bar" role="slider" aria-label="Position im Teil" tabindex="0">
          <div class="audio-progress-fill" data-book-ui="fill"></div>
        </div>
        <div class="book-player-buttons">
          <button type="button" class="book-btn" data-book="prev" aria-label="Vorheriger Teil" title="Vorheriger Teil">${svgBookPrev()}</button>
          <button type="button" class="book-btn" data-book="back-long"></button>
          <button type="button" class="book-btn" data-book="back-short"></button>
          <button type="button" class="book-btn book-btn-play" data-book="toggle" aria-label="Abspielen"></button>
          <button type="button" class="book-btn" data-book="forward-short"></button>
          <button type="button" class="book-btn" data-book="forward-long"></button>
          <button type="button" class="book-btn" data-book="next" aria-label="Nächster Teil" title="Nächster Teil">${svgBookNext()}</button>
        </div>
        <div class="book-player-extra">
          <label class="book-speed">Tempo
            <select class="filter-select" data-book="speed">
              ${BOOK_SPEEDS.map(s => `<option value="${s}">${String(s).replace('.', ',')}×</option>`).join('')}
            </select>
          </label>
          <details class="book-tracks">
            <summary>Alle Teile (${book.tracks.length})</summary>
            <ol class="book-track-list">${tracks}</ol>
          </details>
        </div>
      </div>
      <div class="detail-body">${book.descriptionHtml || ''}</div>
    </div>`;

  if (book.imageUrl) {
    const openFs = () => openImageFullscreen(book.imageUrl);
    document.getElementById('detail-hero-expand')?.addEventListener('click', e => { e.stopPropagation(); openFs(); });
    document.getElementById('detail-hero-img')?.addEventListener('click', openFs);
  }
  $detail.querySelectorAll('.detail-tts-menu').forEach(details => {
    details.addEventListener('toggle', () => {
      if (!details.open) return;
      const menu = details.querySelector('.copy-prompt-menu');
      requestAnimationFrame(() => {
        const box = menu.getBoundingClientRect();
        if (box.right > window.innerWidth - 8) { menu.style.left = `${window.innerWidth - 8 - box.right}px`; menu.style.right = 'auto'; }
      });
    });
  });
  $detail.querySelector('[data-book="speed"]').addEventListener('change', e => bookSetSpeed(Number(e.target.value)));
  $detail.querySelectorAll('.book-track').forEach(btn => {
    btn.addEventListener('click', () => {
      bookEnsureLoaded(book);
      bookGoTo(Number(btn.dataset.track), { fromStart: 0 }, true);
    });
  });
  const bar = $detail.querySelector('[data-book-ui="bar"]');
  bar.addEventListener('click', e => {
    bookEnsureLoaded(book);
    const audio = bookPlayer.audio;
    const rect = bar.getBoundingClientRect();
    if (audio?.duration) audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration;
  });
  bar.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    bookEnsureLoaded(book);
    bookSeekBy((e.key === 'ArrowRight' ? 1 : -1) * bookConfig(book).skipShortSeconds);
  });

  bookLabelButtons($detail, book);
  bookUpdateUi();
  $overlay.querySelector('.overlay-panel').scrollTop = 0;
}

function bookConfig(book = bookPlayer.book) {
  return book?.config || { skipLongSeconds: 600, skipShortSeconds: 30 };
}

function formatSkip(seconds) {
  return seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} Min` : `${seconds} s`;
}

// Sprungtasten beschriften (Werte aus config.json).
function bookLabelButtons(root, book) {
  const { skipLongSeconds, skipShortSeconds } = bookConfig(book);
  const labels = {
    'back-long': [`−${formatSkip(skipLongSeconds)}`, `${formatSkip(skipLongSeconds)} zurück`],
    'back-short': [`−${formatSkip(skipShortSeconds)}`, `${formatSkip(skipShortSeconds)} zurück`],
    'forward-short': [`+${formatSkip(skipShortSeconds)}`, `${formatSkip(skipShortSeconds)} vor`],
    'forward-long': [`+${formatSkip(skipLongSeconds)}`, `${formatSkip(skipLongSeconds)} vor`],
  };
  root.querySelectorAll('[data-book]').forEach(btn => {
    const label = labels[btn.dataset.book];
    if (!label) return;
    btn.textContent = label[0];
    btn.title = label[1];
    btn.setAttribute('aria-label', label[1]);
  });
}

// ── Wiedergabe ─────────────────────────────────────────────────────────────
function bookApiPath(book) {
  return '/api/audiobook-progress/' + book.id.split('/').map(encodeURIComponent).join('/');
}

// Übernimmt ein Buch in den Player (ohne Start), falls noch ein anderes geladen ist.
function bookEnsureLoaded(book) {
  if (bookPlayer.book?.id === book.id) return;
  bookSave();
  if (bookPlayer.audio) { bookPlayer.audio.pause(); bookPlayer.audio.removeAttribute('src'); bookPlayer.audio.load(); }
  const progress = book.progress;
  bookPlayer.book = book;
  bookPlayer.speed = progress?.speed || 1;
  bookPlayer.lastSavedAt = Date.now();
  bookLoadTrack(progress ? progress.trackIndex : 0, { fromStart: progress?.position || 0 }, false);
  bookMediaSession();
}

function bookAudio() {
  if (bookPlayer.audio) return bookPlayer.audio;
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.addEventListener('loadedmetadata', bookApplyPendingSeek);
  audio.addEventListener('timeupdate', () => {
    bookUpdateUi();
    if (!audio.paused && Date.now() - bookPlayer.lastSavedAt > BOOK_SAVE_INTERVAL_MS) bookSave();
  });
  audio.addEventListener('durationchange', bookUpdateUi);
  audio.addEventListener('play', bookUpdateUi);
  audio.addEventListener('pause', () => { bookUpdateUi(); bookSave(); });
  audio.addEventListener('ended', () => {
    if (bookPlayer.index < bookPlayer.book.tracks.length - 1) {
      bookLoadTrack(bookPlayer.index + 1, { fromStart: 0 }, true);
    } else {
      bookUpdateUi();
      bookSave();
    }
  });
  bookPlayer.audio = audio;
  return audio;
}

function bookLoadTrack(index, seek, play) {
  const audio = bookAudio();
  const tracks = bookPlayer.book.tracks;
  bookPlayer.index = Math.min(Math.max(0, index), tracks.length - 1);
  bookPlayer.pendingSeek = seek || { fromStart: 0 };
  bookPlayer.playAfterLoad = play;
  audio.src = tracks[bookPlayer.index].url;
  audio.defaultPlaybackRate = bookPlayer.speed;
  audio.playbackRate = bookPlayer.speed;
  audio.load();
  bookMediaSession();
  bookUpdateUi();
}

// Nach dem Laden eines Teils die Zielposition setzen; reicht der Teil nicht aus,
// geht es in den nächsten bzw. vorherigen Teil weiter (Sprünge über Dateigrenzen).
function bookApplyPendingSeek() {
  const audio = bookPlayer.audio;
  const seek = bookPlayer.pendingSeek;
  const play = bookPlayer.playAfterLoad;
  bookPlayer.pendingSeek = null;
  audio.playbackRate = bookPlayer.speed;
  const duration = audio.duration;
  const last = bookPlayer.book.tracks.length - 1;
  if (seek && isFinite(duration)) {
    if ('fromStart' in seek) {
      if (seek.fromStart >= duration && bookPlayer.index < last) {
        return bookLoadTrack(bookPlayer.index + 1, { fromStart: seek.fromStart - duration }, play);
      }
      audio.currentTime = Math.min(seek.fromStart, Math.max(0, duration - 1));
    } else {
      if (seek.fromEnd > duration && bookPlayer.index > 0) {
        return bookLoadTrack(bookPlayer.index - 1, { fromEnd: seek.fromEnd - duration }, play);
      }
      audio.currentTime = Math.max(0, duration - seek.fromEnd);
    }
  }
  if (play) bookPlay();
  bookUpdateUi();
  bookSave();
}

function bookGoTo(index, seek, play) {
  if (!bookPlayer.book) return;
  bookLoadTrack(index, seek, play ?? !bookPlayer.audio?.paused);
}

function bookSeekBy(delta) {
  const audio = bookPlayer.audio;
  if (!bookPlayer.book || !audio) return;
  const playing = !audio.paused;
  if (bookPlayer.pendingSeek || !isFinite(audio.duration)) return; // Teil lädt noch
  const target = audio.currentTime + delta;
  const last = bookPlayer.book.tracks.length - 1;
  if (target >= audio.duration) {
    if (bookPlayer.index < last) return bookLoadTrack(bookPlayer.index + 1, { fromStart: target - audio.duration }, playing);
    audio.currentTime = Math.max(0, audio.duration - 1);
  } else if (target < 0) {
    if (bookPlayer.index > 0) return bookLoadTrack(bookPlayer.index - 1, { fromEnd: -target }, playing);
    audio.currentTime = 0;
  } else {
    audio.currentTime = target;
  }
  bookSave();
}

function bookPlay() {
  // Nur eine Wiedergabe gleichzeitig: Artikel-Audio anhalten.
  if (typeof audioEl !== 'undefined' && audioEl && !audioEl.paused) {
    audioEl.pause();
    currentAudioBtn?.classList.remove('playing');
  }
  bookPlayer.audio?.play().catch(() => bookUpdateUi());
}

function bookPlayerPause() {
  if (bookPlayer.audio && !bookPlayer.audio.paused) bookPlayer.audio.pause();
}

function bookToggle() {
  const audio = bookAudio();
  if (audio.paused) bookPlay(); else audio.pause();
}

function bookSetSpeed(speed) {
  if (!BOOK_SPEEDS.includes(speed)) return;
  if (currentBookDetail && bookPlayer.book?.id !== currentBookDetail.id) bookEnsureLoaded(currentBookDetail);
  bookPlayer.speed = speed;
  if (bookPlayer.audio) {
    bookPlayer.audio.defaultPlaybackRate = speed;
    bookPlayer.audio.playbackRate = speed;
  }
  bookSave();
  bookUpdateUi();
}

// Hörposition speichern (pro Nutzer und Buch auf dem Server).
function bookSave({ keepalive = false } = {}) {
  const book = bookPlayer.book;
  const audio = bookPlayer.audio;
  if (!book || !audio || bookPlayer.pendingSeek) return Promise.resolve();
  const body = {
    trackIndex: bookPlayer.index,
    position: isFinite(audio.currentTime) ? audio.currentTime : 0,
    speed: bookPlayer.speed,
  };
  bookPlayer.lastSavedAt = Date.now();
  book.progress = { ...body, updatedAt: new Date().toISOString() };
  if (currentBookDetail?.id === book.id) currentBookDetail.progress = book.progress;
  const request = fetch(bookApiPath(book), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive,
  }).catch(() => { /* nächster Versuch beim nächsten Speichern */ });
  bookPlayer.saving = request;
  return request;
}

// Wiedergabe beenden (Miniplayer schließen, Abmelden): Position sichern, Player leeren.
async function bookPlayerClose() {
  if (!bookPlayer.book) return;
  const audio = bookPlayer.audio;
  if (audio && !audio.paused) audio.pause();
  await bookSave();
  if (audio) { audio.removeAttribute('src'); audio.load(); }
  bookPlayer.book = null;
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  bookUpdateUi();
}

window.addEventListener('pagehide', () => bookSave({ keepalive: true }));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') bookSave({ keepalive: true });
});

// ── Bedienung (Detailansicht und Miniplayer) ───────────────────────────────
document.addEventListener('click', event => {
  const btn = event.target.closest('[data-book]');
  if (!btn || btn.tagName === 'SELECT') return;
  const action = btn.dataset.book;
  const inMini = !!btn.closest('#mini-player');
  if (!inMini && currentBookDetail) bookEnsureLoaded(currentBookDetail);
  if (!bookPlayer.book) return;
  const { skipLongSeconds, skipShortSeconds } = bookConfig();
  switch (action) {
    case 'toggle': bookToggle(); break;
    case 'back-long': bookSeekBy(-skipLongSeconds); break;
    case 'back-short': bookSeekBy(-skipShortSeconds); break;
    case 'forward-short': bookSeekBy(skipShortSeconds); break;
    case 'forward-long': bookSeekBy(skipLongSeconds); break;
    case 'prev':
      if ((bookPlayer.audio?.currentTime || 0) > 5 || bookPlayer.index === 0) bookGoTo(bookPlayer.index, { fromStart: 0 });
      else bookGoTo(bookPlayer.index - 1, { fromStart: 0 });
      break;
    case 'next':
      if (bookPlayer.index < bookPlayer.book.tracks.length - 1) bookGoTo(bookPlayer.index + 1, { fromStart: 0 });
      break;
    case 'close': bookPlayerClose(); break;
  }
});

document.getElementById('mini-player-open').addEventListener('click', () => {
  if (bookPlayer.book) openArticle(bookPlayer.book.id);
});

function bookFmt(s) {
  if (!isFinite(s)) return '0:00';
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function bookUpdateUi() {
  const book = bookPlayer.book;
  const audio = bookPlayer.audio;
  const detailBook = currentBookDetail && !$overlay.hidden && document.getElementById('book-player') ? currentBookDetail : null;
  const active = book && detailBook && book.id === detailBook.id;

  // Detailansicht: aktives Buch live, sonst gespeicherter Stand.
  if (detailBook) {
    const root = document.getElementById('book-player');
    const progress = active ? null : detailBook.progress;
    const index = active ? bookPlayer.index : (progress?.trackIndex || 0);
    const current = active ? audio.currentTime : (progress?.position || 0);
    const duration = active ? audio.duration : NaN;
    const playing = active && !audio.paused;
    const track = detailBook.tracks[index];
    root.querySelector('[data-book-ui="track"]').textContent =
      `Teil ${index + 1} von ${detailBook.tracks.length}${track ? ' · ' + track.title : ''}`;
    root.querySelector('[data-book-ui="time"]').textContent =
      isFinite(duration) ? `${bookFmt(current)} / ${bookFmt(duration)}` : bookFmt(current);
    root.querySelector('[data-book-ui="fill"]').style.width = isFinite(duration) && duration ? `${(current / duration) * 100}%` : '0%';
    root.querySelector('[data-book="speed"]').value = String(active ? bookPlayer.speed : (progress?.speed || 1));
    const play = root.querySelector('[data-book="toggle"]');
    play.classList.toggle('playing', playing);
    play.innerHTML = playing ? svgBookPause() : svgBookPlay();
    play.setAttribute('aria-label', playing ? 'Pause' : 'Abspielen');
    root.querySelectorAll('.book-track').forEach(btn => {
      const isCurrent = Number(btn.dataset.track) === index;
      btn.classList.toggle('is-current', isCurrent);
      if (isCurrent) btn.setAttribute('aria-current', 'true'); else btn.removeAttribute('aria-current');
    });
  }

  // Miniplayer, sobald ein Buch geladen ist und nicht bereits im Detail sichtbar ist.
  const showMini = !!book && !active;
  $miniPlayer.hidden = !showMini;
  document.body.classList.toggle('has-mini-player', showMini);
  if (!showMini) return;
  const playing = !audio.paused;
  document.getElementById('mini-player-cover').src = book.imageUrl || '';
  document.getElementById('mini-player-title').textContent = book.title;
  document.getElementById('mini-player-track').textContent =
    `Teil ${bookPlayer.index + 1}/${book.tracks.length} · ${bookFmt(audio.currentTime)}${isFinite(audio.duration) ? ' / ' + bookFmt(audio.duration) : ''}`;
  document.getElementById('mini-player-fill').style.width = audio.duration ? `${(audio.currentTime / audio.duration) * 100}%` : '0%';
  const play = $miniPlayer.querySelector('[data-book="toggle"]');
  play.innerHTML = playing ? svgBookPause() : svgBookPlay();
  play.setAttribute('aria-label', playing ? 'Pause' : 'Abspielen');
  bookLabelButtons($miniPlayer, book);
}

// Detail geschlossen/gewechselt → Miniplayer neu bewerten.
new MutationObserver(() => bookUpdateUi()).observe($overlay, { attributes: true, attributeFilter: ['hidden'] });
new MutationObserver(() => {
  if (!document.getElementById('book-player')) currentBookDetail = null;
  bookUpdateUi();
}).observe($detail, { childList: true });

// Sperrbildschirm / Kopfhörertasten (iOS, Android, Desktop).
function bookMediaSession() {
  if (!('mediaSession' in navigator) || !bookPlayer.book) return;
  const book = bookPlayer.book;
  const track = book.tracks[bookPlayer.index];
  const artwork = book.imageUrl ? [{ src: new URL(book.imageUrl, location.href).href }] : [];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track?.title || book.title,
    artist: book.bookAuthor || '',
    album: book.title,
    artwork,
  });
  const { skipShortSeconds } = bookConfig();
  const handlers = {
    play: () => bookPlay(),
    pause: () => bookPlayerPause(),
    seekbackward: d => bookSeekBy(-(d.seekOffset || skipShortSeconds)),
    seekforward: d => bookSeekBy(d.seekOffset || skipShortSeconds),
    previoustrack: () => bookGoTo(bookPlayer.index - 1, { fromStart: 0 }),
    nexttrack: () => bookGoTo(bookPlayer.index + 1, { fromStart: 0 }),
    seekto: d => { if (bookPlayer.audio && isFinite(d.seekTime)) bookPlayer.audio.currentTime = d.seekTime; },
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* nicht unterstützt */ }
  }
}

// ── Icons ──────────────────────────────────────────────────────────────────
function svgBookPlay() {
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
}
function svgBookPause() {
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
}
function svgBookPrev() {
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>`;
}
function svgBookNext() {
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>`;
}
