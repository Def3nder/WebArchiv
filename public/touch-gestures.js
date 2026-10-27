/* WebArchiv — gemeinsame Touch-Gesten für app.js, audiobooks.js und book-reader.js:
 * Pinch-Zoom-Erkennung, aktive Textauswahl, bedienbare Fortschrittslinie
 * (enableScrubBar) und Nach-unten-Wischen zum Schließen (enablePullToClose).
 * Klassisches Skript vor app.js: Die Funktionen sind bewusst global, damit die
 * übrigen Skripte sie wie bisher aufrufen. Keine Abhängigkeit von app.js. */

// Grundvergrößerung der Seite: Safari meldet bei Seitenzoom (Aa, z. B. 115 %)
// dauerhaft eine Skalierung über 1. Als Pinch-Zoom zählt nur, was darüber hinausgeht.
let baseViewportScale = window.visualViewport?.scale ?? 1;
window.visualViewport?.addEventListener('resize', () => {
  baseViewportScale = Math.min(baseViewportScale, window.visualViewport.scale);
});
function pinchZoomed() {
  return (window.visualViewport?.scale ?? 1) > baseViewportScale + 0.05;
}

function hasActiveSelection() {
  const sel = window.getSelection();
  return !!(sel && !sel.isCollapsed && sel.toString().trim());
}

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
    moving.style.pointerEvents = '';
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
    // Während die weggezogene Ebene noch ausblendet, darf sie keine darunterliegenden
    // Bedienelemente abfangen. Das verhindert insbesondere veraltete iOS-Hit-Flächen
    // nach einem Wechsel zwischen Hoch- und Querformat.
    moving.style.pointerEvents = 'none';
    moving.style.transform = `translateY(${window.innerHeight}px)`;
    state = 'idle';
    setTimeout(() => { reset(false); onClose(); }, 200);
  };
  scroller.addEventListener('touchend', end, { passive: true });
  // iOS bricht eine Geste teils mit touchcancel ab – dann wie Loslassen behandeln.
  scroller.addEventListener('touchcancel', end, { passive: true });
}
