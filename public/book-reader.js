/* WebArchiv — Hörbücher: eBook-Text (md/txt/pdf) im Vollbild-Reiter, Leseposition pro Nutzer */

const BOOK_TEXT_SIZES = [0.9, 1, 1.1, 1.25, 1.45, 1.7];   // rem
const BOOK_TEXT_SAVE_DELAY_MS = 1500;
const BOOK_PDF_POLL_MS = 3000;
const BOOK_BACK_LIMIT = 20;

// Liegt im body außerhalb des Artikel-Overlays; der Miniplayer bleibt darüber sichtbar.
const bookReader = {
  el: null,
  book: null,
  format: null,
  loaded: false,        // Text fertig geladen und Position gesetzt
  position: null,       // zuletzt gespeichert bzw. bekannt (Anteil 0–1 oder PDF-Seite)
  saveTimer: null,
  pollTimer: null,
  token: 0,             // verwirft Antworten geschlossener Reiter
  backStack: [],        // Scrollpositionen vor internen Sprüngen (für „Zurück“)
  stepProgress: null,   // Tastatur auf der Fortschrittslinie (±Anteil)
};

function bookTextApiPath(book, kind) {
  return '/api/audiobook-' + kind + '/' + book.id.split('/').map(encodeURIComponent).join('/');
}

function bookTextSizeIndex() {
  try {
    const saved = Number(localStorage.getItem('wa-book-text-size'));
    if (Number.isInteger(saved) && saved >= 0 && saved < BOOK_TEXT_SIZES.length) return saved;
  } catch { /* Speicher nicht verfügbar */ }
  return 2;
}

function svgBookClose() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
}

async function openBookReader(book) {
  if (bookReader.el || !book.ebook) return;
  const token = ++bookReader.token;
  Object.assign(bookReader, { book, format: book.ebook.format, loaded: false, position: book.ebookPosition ?? null, backStack: [] });
  // Der Miniplayer zeigt dieses Hörbuch (mit gespeichertem Hörstand), sofern nicht gerade
  // ein anderes läuft.
  if (!bookPlayer.book || (bookPlayer.audio?.paused && bookPlayer.book.id !== book.id)) bookEnsureLoaded(book);

  const sizeButtons = book.ebook.format === 'pdf' ? '' : `
      <span class="book-reader-size">
        <button type="button" class="book-btn" data-reader="smaller" aria-label="Schrift kleiner" title="Schrift kleiner">A−</button>
        <button type="button" class="book-btn" data-reader="larger" aria-label="Schrift größer" title="Schrift größer">A+</button>
      </span>`;
  const el = document.createElement('div');
  el.id = 'book-reader';
  el.className = 'book-reader';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Text: ' + book.title);
  el.innerHTML = `
    <header class="book-reader-head">
      <button type="button" class="book-btn book-reader-close" data-reader="close" aria-label="Text schließen" title="Schließen">${svgBookClose()}</button>
      <span class="book-reader-heading">
        <span class="book-reader-title">${esc(book.title)}</span>
        <span class="book-reader-where"></span>
      </span>${sizeButtons}
    </header>
    <div class="book-reader-body"><p class="book-reader-status">Text wird geladen …</p></div>`;
  document.body.appendChild(el);
  document.body.classList.add('book-reader-open');
  bookReader.el = el;
  el.addEventListener('click', onBookReaderClick);
  bookUpdateUi();
  el.querySelector('[data-reader="close"]').focus();

  const body = el.querySelector('.book-reader-body');
  try {
    const r = await apiFetch(bookTextApiPath(book, 'text'));
    const data = await r.json().catch(() => ({}));
    if (token !== bookReader.token) return;
    if (!r.ok) throw new Error(data.error || 'Der Text konnte nicht geladen werden.');
    if (data.position != null) bookReader.position = data.position;
    if (data.format === 'pdf') {
      showBookPdf(body, data.url);   // gilt erst als geladen, wenn der Viewer zur Stelle gesprungen ist
    } else {
      showBookText(body, data.html);
      bookReader.loaded = true;
    }
  } catch (err) {
    if (token !== bookReader.token || err.message === 'Session expired') return;
    body.innerHTML = '<p class="book-reader-status">' + esc(err.message) + '</p>';
  }
}

function showBookText(body, html) {
  body.innerHTML = '<div class="book-reader-scroll" tabindex="0"><div class="book-reader-text detail-body"></div></div>';
  const scroller = body.firstElementChild;
  const text = scroller.firstElementChild;
  text.innerHTML = html;
  prepareBookLinks(text, scroller);
  prepareBookBack(body, scroller);
  const updateProgress = prepareBookProgress(body, scroller, text);
  applyBookTextSize();
  // Zur gespeicherten Stelle springen (das Auslesen der Höhe erzwingt das Layout); nach
  // dem nächsten Frame nochmals, falls Schrift oder Bilder die Höhe noch verändern.
  const restore = () => {
    const max = scroller.scrollHeight - scroller.clientHeight;
    if (bookReader.position > 0 && max > 0) scroller.scrollTop = bookReader.position * max;
  };
  restore();
  requestAnimationFrame(restore);
  // Nachladende Bilder verschieben den Text; solange nicht gescrollt wurde, die Stelle nachführen.
  let touched = false;
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) scroller.addEventListener(type, () => { touched = true; }, { once: true, passive: true });
  text.addEventListener('load', event => { if (!touched && event.target.tagName === 'IMG') restore(); }, true);
  scroller.focus({ preventScroll: true });
  let progressFrame = 0;
  scroller.addEventListener('scroll', () => {
    clearTimeout(bookReader.saveTimer);
    bookReader.saveTimer = setTimeout(() => bookReaderSave(), BOOK_TEXT_SAVE_DELAY_MS);
    if (!progressFrame) progressFrame = requestAnimationFrame(() => { progressFrame = 0; updateProgress(); });
  }, { passive: true });
  updateProgress();
}

// Lesefortschritt: dünne Linie unter dem Kopf und „Kapitel · %“ im Kopf. Bedienung wie bei
// den Audio-Playern (enableScrubBar in app.js): kurz tippen springt, halten und ziehen scrollt
// live und relativ ab der aktuellen Stelle (mit Sprechblase). Ein weiter Sprung merkt sich die
// vorige Stelle für „↩ Zurück“. Liefert die Funktion, die Linie und Anzeige an die aktuelle
// Scrollposition anpasst.
function prepareBookProgress(body, scroller, text) {
  const bar = document.createElement('div');
  bar.className = 'book-reader-progress';
  bar.tabIndex = 0;
  bar.setAttribute('role', 'slider');
  bar.setAttribute('aria-label', 'Leseposition');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.title = 'Tippen springt an die Stelle, Halten und Ziehen blättert durch das Buch';
  bar.innerHTML = '<div class="book-reader-progress-fill"></div>';
  const fill = bar.firstElementChild;
  bookReader.el.insertBefore(bar, body);
  const where = bookReader.el.querySelector('.book-reader-where');

  // Kapitel = letzte Überschrift (h1/h2), die das obere Drittel des Bildschirms erreicht hat;
  // offsetTop bezieht sich auf den Scrollbereich (position: relative) und folgt
  // Schriftgröße und Bildern.
  const headings = [...text.querySelectorAll('h1, h2')];
  const maxScroll = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const chapterAt = top => {
    const limit = top + scroller.clientHeight / 3;
    let lo = 0, hi = headings.length - 1, found = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (headings[mid].offsetTop <= limit) { found = headings[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return found ? found.textContent.replace(/\s+/g, ' ').trim() : '';
  };
  const label = fraction => {
    const percent = Math.round(fraction * 100) + ' %';
    const chapter = chapterAt(fraction * maxScroll());
    return chapter ? chapter + ' · ' + percent : percent;
  };
  // Nur das Kapitel wird bei Platzmangel gekürzt, die Prozentzahl bleibt immer sichtbar.
  const labelHtml = fraction => {
    const chapter = chapterAt(fraction * maxScroll());
    return (chapter ? '<span class="book-reader-chapter">' + esc(chapter) + '</span>' : '')
      + '<span class="book-reader-percent">' + (chapter ? ' · ' : '') + Math.round(fraction * 100) + ' %</span>';
  };
  const current = () => { const max = maxScroll(); return max > 0 ? Math.min(1, scroller.scrollTop / max) : 0; };

  function update() {
    const fraction = current();
    fill.style.width = (fraction * 100) + '%';
    bar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    bar.setAttribute('aria-valuetext', label(fraction));
    where.innerHTML = labelHtml(fraction);
  }

  const remember = startTop => {
    if (Math.abs(scroller.scrollTop - startTop) <= scroller.clientHeight) return;
    bookReader.backStack.push(startTop);
    if (bookReader.backStack.length > BOOK_BACK_LIMIT) bookReader.backStack.shift();
    updateBookBack();
  };
  let startTop = 0;
  enableScrubBar(bar, {
    live: true,
    get: current,
    set: fraction => { scroller.scrollTop = fraction * maxScroll(); },
    label: labelHtml,
    onStart: () => { startTop = scroller.scrollTop; },
    onEnd: () => { remember(startTop); update(); },
  });

  // Tastatur (Pfeile auf der fokussierten Linie): 1 % je Schritt.
  bookReader.stepProgress = step => {
    const before = scroller.scrollTop;
    scroller.scrollTop = Math.min(1, Math.max(0, current() + step)) * maxScroll();
    remember(before);
  };
  return update;
}

// Überschriften-Kürzel exakt wie bei GitHub: klein, Satzzeichen entfallen, jedes Leerzeichen → "-"
// (aus „A – B“ wird „a--b“, ein Leerzeichen am Ende bleibt als „-“ stehen).
function bookHeadingSlug(text) {
  return text.toLowerCase().trim().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-');
}

// Interne Verweise (#kürzel) springen im Text, statt die Adresse der App zu ändern;
// externe Links öffnen in neuem Tab.
function prepareBookLinks(text, scroller) {
  const used = new Map();
  text.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(heading => {
    if (heading.id) return;
    const base = bookHeadingSlug(heading.textContent);
    if (!base) return;
    const count = used.get(base) || 0;
    used.set(base, count + 1);
    heading.id = count ? base + '-' + count : base;
  });
  text.querySelectorAll('a[href]').forEach(link => {
    if (/^https?:/i.test(link.getAttribute('href'))) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  });
  text.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#"]');
    if (!link) return;
    event.preventDefault();
    let id = link.getAttribute('href').slice(1);
    try { id = decodeURIComponent(id); } catch { /* unverändert verwenden */ }
    const target = id && [...text.querySelectorAll('[id]')].find(el => el.id === id);
    if (!target) return;
    bookReader.backStack.push(scroller.scrollTop);
    if (bookReader.backStack.length > BOOK_BACK_LIMIT) bookReader.backStack.shift();
    scroller.scrollTo({ top: scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top, behavior: 'auto' });
    updateBookBack();
  });
}

// „Zurück“-Knopf: springt zur Stelle vor dem letzten internen Verweis (mehrere Sprünge nacheinander möglich).
function prepareBookBack(body, scroller) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'book-reader-back';
  btn.hidden = true;
  btn.title = 'Zurück zur Stelle vor dem Sprung';
  btn.textContent = '↩ Zurück';
  btn.addEventListener('click', () => {
    const top = bookReader.backStack.pop();
    if (top != null) scroller.scrollTo({ top, behavior: 'auto' });
    updateBookBack();
    scroller.focus({ preventScroll: true });
  });
  body.appendChild(btn);
}

function updateBookBack() {
  const btn = bookReader.el?.querySelector('.book-reader-back');
  if (btn) btn.hidden = !bookReader.backStack.length;
}

function applyBookTextSize() {
  const el = bookReader.el;
  const text = el?.querySelector('.book-reader-text');
  if (!text) return;
  const index = bookTextSizeIndex();
  text.style.fontSize = BOOK_TEXT_SIZES[index] + 'rem';
  el.querySelectorAll('[data-reader="smaller"], [data-reader="larger"]').forEach(btn => {
    btn.disabled = btn.dataset.reader === 'smaller' ? index === 0 : index === BOOK_TEXT_SIZES.length - 1;
  });
}

function showBookPdf(body, url) {
  // pdf.js kommt mit dem ?v=-Cache-Buster nicht zurecht (siehe renderPdfEmbed) und
  // kodiert den Pfad selbst; bereits kodierte Zeichen (%20) würden doppelt kodiert.
  const file = encodeURIComponent(decodeURI(url.split('?')[0]));
  const target = bookReader.position > 1 ? bookReader.position : 0;
  body.innerHTML = '<iframe class="book-reader-pdf" title="Buch als PDF"></iframe>';
  const frame = body.firstElementChild;
  const token = bookReader.token;
  // Der Viewer meldet anfangs Seite 1. Gespeichert wird erst, nachdem er initialisiert und
  // (falls nötig) zur gespeicherten Seite gesprungen ist; sonst würde Seite 1 die Stelle überschreiben.
  frame.addEventListener('load', async () => {
    try {
      const app = frame.contentWindow.PDFViewerApplication;
      await app.initializedPromise;
      const start = () => {
        if (token !== bookReader.token) return;
        if (target) app.pdfViewer.currentPageNumber = Math.min(target, app.pagesCount || target);
        setTimeout(() => {
          if (token !== bookReader.token) return;
          bookReader.loaded = true;
          bookReader.pollTimer = setInterval(() => bookReaderSave(), BOOK_PDF_POLL_MS);
        }, 1500);
      };
      if (app.pdfViewer?.pagesCount) start(); else app.eventBus.on('pagesinit', start, { once: true });
    } catch { /* Viewer nicht erreichbar: Leseposition wird dann nicht gespeichert */ }
  }, { once: true });
  frame.src = '/vendor/pdfjs/web/viewer.html?file=' + file + (target ? '#page=' + target : '');
}

// Aktuelle Leseposition: Anteil der Scrollhöhe (Text) bzw. Seitenzahl (PDF).
function bookReaderPosition() {
  const el = bookReader.el;
  if (!el || !bookReader.loaded) return null;
  if (bookReader.format === 'pdf') {
    try {
      const page = el.querySelector('iframe').contentWindow.PDFViewerApplication?.page;
      return Number.isInteger(page) && page >= 1 ? page : null;
    } catch { return null; }
  }
  const scroller = el.querySelector('.book-reader-scroll');
  const max = scroller ? scroller.scrollHeight - scroller.clientHeight : 0;
  // Ohne scrollbare Höhe (Layout noch nicht fertig) nichts speichern, sonst geht die Stelle verloren.
  return max > 0 ? Math.min(1, Math.max(0, scroller.scrollTop / max)) : null;
}

function bookReaderSave({ keepalive = false } = {}) {
  const position = bookReaderPosition();
  if (position == null || position === bookReader.position) return Promise.resolve();
  bookReader.position = position;
  if (currentBookDetail?.id === bookReader.book.id) currentBookDetail.ebookPosition = position;
  return fetch(bookTextApiPath(bookReader.book, 'text-progress'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ position }),
    keepalive,
  }).catch(() => { /* nächster Versuch beim nächsten Speichern */ });
}

function closeBookReader() {
  if (!bookReader.el) return;
  clearTimeout(bookReader.saveTimer);
  clearInterval(bookReader.pollTimer);
  bookReaderSave({ keepalive: true });   // Position lesen, bevor der Reiter entfernt wird
  bookReader.token++;
  bookReader.el.remove();
  bookReader.el = null;
  bookReader.loaded = false;
  bookReader.stepProgress = null;
  document.body.classList.remove('book-reader-open');
  bookUpdateUi();
}

function onBookReaderClick(event) {
  const btn = event.target.closest('[data-reader]');
  if (!btn) return;
  if (btn.dataset.reader === 'close') return closeBookReader();
  const step = btn.dataset.reader === 'larger' ? 1 : -1;
  const next = Math.min(BOOK_TEXT_SIZES.length - 1, Math.max(0, bookTextSizeIndex() + step));
  try { localStorage.setItem('wa-book-text-size', String(next)); } catch { /* ignorieren */ }
  const scroller = bookReader.el.querySelector('.book-reader-scroll');
  const fraction = bookReaderPosition() || 0;
  applyBookTextSize();
  bookReader.backStack = [];   // gemerkte Stellen passen nach einer Größenänderung nicht mehr
  updateBookBack();
  // Anteil beibehalten, damit die Stelle bei anderer Schriftgröße nicht wegspringt.
  if (scroller) scroller.scrollTop = fraction * (scroller.scrollHeight - scroller.clientHeight);
}

// Escape schließt nur den Text; Pfeiltasten dürfen im Hintergrund keinen Artikel wechseln.
document.addEventListener('keydown', event => {
  if (!bookReader.el) return;
  if (event.key === 'Escape') { event.stopImmediatePropagation(); closeBookReader(); }
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.stopImmediatePropagation();
    if (event.target.classList?.contains('book-reader-progress') && bookReader.stepProgress) {
      event.preventDefault();
      bookReader.stepProgress(event.key === 'ArrowRight' ? 0.01 : -0.01);
    }
  }
}, true);

window.addEventListener('pagehide', () => bookReaderSave({ keepalive: true }));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') bookReaderSave({ keepalive: true });
});
// Wird das Artikel-Overlay geschlossen (Zurück-Taste, Abmelden), endet auch der Text-Reiter.
new MutationObserver(() => { if ($overlay.hidden) closeBookReader(); }).observe($overlay, { attributes: true, attributeFilter: ['hidden'] });
