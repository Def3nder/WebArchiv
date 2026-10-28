/* WebArchiv — Artikel-Medien
 * Audio-, Video- und PDF-Player der Detailansicht, Media Session (Sperrbildschirm).
 * Klassisches Skript vor app.js: Es enthält nur Deklarationen; die Funktionen greifen
 * zur Laufzeit auf den Zustand und die DOM-Referenzen aus app.js zu (gemeinsamer
 * globaler Gültigkeitsbereich der klassischen Skripte). Kein Code, der beim Laden läuft
 * und dabei app.js braucht. */

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

// iOS verwendet ohne ausdrücklichen Typ für Webseiten teils eine kurzlebige Audio-Session.
// Nach einer Pause am Sperrbildschirm kann play() dann erfolgreich wirken, während die Ausgabe
// stumm/suspendiert bleibt. "playback" hält die Session für längere Medien aktiv.
function prepareAudioPlaybackSession() {
  if (!('audioSession' in navigator)) return;
  try { navigator.audioSession.type = 'playback'; } catch { /* API ist experimentell */ }
}

function playArticleAudio(audio) {
  prepareAudioPlaybackSession();
  const started = audio.play();
  if (started && typeof started.catch === 'function') {
    started.catch(() => {
      // Ein play-Ereignis bedeutet nur, dass Wiedergabe angefordert wurde. Erst "playing"
      // schaltet den Knopf um; bei einem Fehler bleibt er daher korrekt auf Abspielen.
      if (audio === audioEl) currentAudioBtn?.classList.remove('playing');
    });
  }
}

function setArticleMediaSession(article) {
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

  // Play/Pause absichtlich nicht selbst behandeln: WebKit kann das aktive HTMLMediaElement
  // direkt und zuverlässiger aus dem Sperrbildschirm fortsetzen. Ein eigener play()-Aufruf im
  // Hintergrund kann auf iOS erfolgreich erscheinen, obwohl die Audioausgabe stumm bleibt.
  for (const action of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack']) {
    try { navigator.mediaSession.setActionHandler(action, null); } catch { /* nicht unterstützt */ }
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
  // Alle Handler nutzen dieses Element, nicht das globale audioEl: stopAudio() setzt audioEl
  // auf null, ein bereits eingereihtes timeupdate des pausierten Elements kommt danach noch an.
  const audio = new Audio(audioUrl);
  audio.preload = 'metadata';
  audioEl = audio;
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
    const pct = audio.duration ? (seconds / audio.duration * 100) : 0;
    fill.style.width = `${pct}%`;
    time.textContent = `${fmt(seconds)} / ${fmt(audio.duration)}`;
  }
  function updateAudioTime() {
    if (bar.classList.contains('is-active')) return;   // beim Ziehen zeigt der Balken die Zielzeit
    showAudioTime(audio.currentTime);
  }

  audio.addEventListener('loadedmetadata', updateAudioTime);
  audio.addEventListener('durationchange', updateAudioTime);
  audio.addEventListener('timeupdate', updateAudioTime);
  audio.load();

  audio.addEventListener('ended', () => {
    btn.classList.remove('playing');
    fill.style.width = '0%';
  });
  // Abspielen/Pause vom Sperrbildschirm aus: Knopf mitführen, Media Session übernehmen.
  audio.addEventListener('play', () => {
    if (article) setArticleMediaSession(article);
  });
  audio.addEventListener('playing', () => {
    btn.classList.add('playing');
  });
  audio.addEventListener('pause', () => {
    btn.classList.remove('playing');
  });

  btn.addEventListener('click', () => {
    if (audio.paused || !btn.classList.contains('playing')) {
      if (typeof bookPlayerPause === 'function') bookPlayerPause();
      if (article) setArticleMediaSession(article);   // vor play(), damit iOS das Bild sofort übernimmt
      playArticleAudio(audio);
    } else {
      audio.pause();
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
