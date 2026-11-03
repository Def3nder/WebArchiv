/* WebArchiv — Vollbild-Galerie
 * Bildvollansicht mit Blättern, Zoom/Verschieben (Maus und Touch) und Herunterladen/Teilen
 * (auch der fertigen MP3 im Audio-Dialog).
 * Klassisches Skript vor app.js: Es enthält nur Deklarationen; die Funktionen greifen
 * zur Laufzeit auf den Zustand und die DOM-Referenzen aus app.js zu (gemeinsamer
 * globaler Gültigkeitsbereich der klassischen Skripte). Kein Code, der beim Laden läuft
 * und dabei app.js braucht. */

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
  // Kein Nachziehen (z. B. vom Nach-unten-Ziehen übrig): Zoom und Verschieben folgen dem Finger direkt.
  img.style.transition = 'none';
  img.style.transform = `translate(${imageZoom.x}px, ${imageZoom.y}px) scale(${imageZoom.scale})`;
  img.classList.toggle('is-zoomed', imageZoom.scale > 1);
  document.getElementById('img-fullscreen').classList.toggle('is-zoomed', imageZoom.scale > 1);
}

// Lage des Bilds ohne Zoom (Bildschirmkoordinaten). Auf dem Handy steht es oben in der
// scrollbaren Vollansicht, auf dem Desktop mittig – deshalb gemessen statt angenommen.
function imageBaseRect() {
  const img = document.getElementById('img-fullscreen-img');
  const prevTransform = img.style.transform;
  img.style.transform = '';
  const baseRect = img.getBoundingClientRect();
  img.style.transform = prevTransform;
  return baseRect;
}

// Größer als der Bildschirm: kein leerer Rand neben dem Bild. Kleiner: Auf dem Desktop
// bleibt es mittig, auf dem Handy innerhalb des Bildschirms.
function clampImageAxis(offset, start, size, viewport, center) {
  const scaled = size * imageZoom.scale;
  const middle = start + size / 2;
  if (scaled <= viewport && center) return viewport / 2 - middle;
  const a = scaled / 2 - middle;
  const b = viewport - scaled / 2 - middle;
  return Math.min(Math.max(a, b), Math.max(Math.min(a, b), offset));
}

function clampImagePan() {
  const baseRect = imageBaseRect();
  const center = isDesktopPointer();
  imageZoom.x = clampImageAxis(imageZoom.x, baseRect.left, baseRect.width, window.innerWidth, center);
  imageZoom.y = clampImageAxis(imageZoom.y, baseRect.top, baseRect.height, window.innerHeight, center);
}

// Zoomen um einen Bildschirmpunkt: Die Bildstelle unter (clientX, clientY) bleibt dort.
// from = Zustand bei Gestenbeginn (Pinch: Ausgangsmaßstab und -punkt), sonst der aktuelle.
function zoomImageAt(nextScale, clientX, clientY, from = { ...imageZoom, clientX, clientY }) {
  const scale = Math.min(IMAGE_ZOOM_MAX, Math.max(IMAGE_ZOOM_MIN, nextScale));
  if (scale <= IMAGE_ZOOM_MIN) {
    resetImageZoom();
    return;
  }
  const baseRect = imageBaseRect();
  const middleX = baseRect.left + baseRect.width / 2;
  const middleY = baseRect.top + baseRect.height / 2;
  const ratio = scale / from.scale;
  imageZoom.scale = scale;
  imageZoom.x = clientX - middleX - (from.clientX - middleX - from.x) * ratio;
  imageZoom.y = clientY - middleY - (from.clientY - middleY - from.y) * ratio;
  clampImagePan();
  applyImageZoom();
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
const fsGallery = {
  urls: [], index: 0, articleId: null, bounded: false, returnFocus: null, previousBodyOverflow: '',
  reviewIds: [],
};

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
  const reviewId = fsGallery.reviewIds[index] || '';
  const reviewVisible = isInfographicReviewMode() && !!reviewId;
  if ($fullscreenPosterToggle) $fullscreenPosterToggle.hidden = !reviewVisible;
  $fs.classList.toggle('has-poster-review', reviewVisible);
  if (reviewVisible && $fullscreenPosterCheckbox) {
    $fullscreenPosterCheckbox.dataset.reviewId = reviewId;
    $fullscreenPosterCheckbox.checked = infographicReview.value(reviewId);
    $fullscreenPosterCheckbox.setAttribute('aria-label', $fullscreenPosterCheckbox.checked
      ? 'Poster-Markierung entfernen'
      : 'Als Poster markieren');
  } else if ($fullscreenPosterCheckbox) {
    delete $fullscreenPosterCheckbox.dataset.reviewId;
  }
  prepareShareFile(url);
  if (fsGallery.articleId && count > 1) {
    history.replaceState(articleHistoryState(articleHistoryDepth()), '', `#/article/${sanitizeForId(fsGallery.articleId)}?bild=${index + 1}`);
  }
}

// ←/→ blättern durch die Bilder (am Rand zum Nachbarartikel, siehe stepFullscreen).
function fullscreenLayerKey(event) {
  // Prüfmodus: Leertaste markiert das gezeigte Bild als Poster (infographic-review.js).
  if (infographicReview.fullscreenKey(event)) return true;
  const dir = pageSwipeMath?.keyDirection(event) || 0;
  if (!dir) return false;
  event.preventDefault();
  stepFullscreen(dir);
  return true;
}
function openGalleryFullscreen(urls, index = 0, articleId = null, bounded = false, returnFocus = null, reviewIds = []) {
  if (!urls.length) return;
  const fullscreen = document.getElementById('img-fullscreen');
  if (!fullscreen.open) fsGallery.previousBodyOverflow = document.body.style.overflow;
  fsGallery.urls = urls;
  fsGallery.articleId = articleId;
  fsGallery.bounded = bounded;
  fsGallery.returnFocus = returnFocus;
  fsGallery.reviewIds = reviewIds;
  showFullscreenImage(Math.max(0, Math.min(urls.length - 1, index)));
  document.body.style.overflow = 'hidden';
  // Eigene Fokus-Rückgabe über fsGallery.returnFocus (closeImageFullscreen).
  if (!fullscreen.open) {
    WebArchivLayers.open(fullscreen, {
      name: 'image', onEscape: closeImageFullscreen, onKey: fullscreenLayerKey, returnFocus: false,
    });
  }
  fullscreen.focus({ preventScroll: true });
}
function openImageFullscreen(src) {
  openGalleryFullscreen([src]);
}
function closeImageFullscreen() {
  const returnFocus = fsGallery.returnFocus;
  const fullscreen = document.getElementById('img-fullscreen');
  if (fullscreen.open) WebArchivLayers.close(fullscreen, { restoreFocus: false });
  resetImageZoom();
  if (fsGallery.articleId && location.hash.includes('?bild=')) {
    history.replaceState(articleHistoryState(articleHistoryDepth()), '', `#/article/${sanitizeForId(fsGallery.articleId)}`);
  }
  fsGallery.articleId = null;
  fsGallery.bounded = false;
  fsGallery.returnFocus = null;
  fsGallery.reviewIds = [];
  if ($fullscreenPosterToggle) $fullscreenPosterToggle.hidden = true;
  document.getElementById('img-fullscreen').classList.remove('has-poster-review');
  document.body.style.overflow = fsGallery.previousBodyOverflow;
  fsGallery.previousBodyOverflow = '';
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  // Nach dem Blättern über Artikelgrenzen gibt es das Ausgangsbild nicht mehr: Fokus in den
  // Textbereich, damit die Tasten den Artikel wieder scrollen (app-detail.js).
  focusArticlePanel();
}
// Nach dem letzten Bild weiter zum nächsten Artikel, vor dem ersten zum vorigen.
function stepFullscreen(dir) {
  const next = fsGallery.index + dir;
  if (next >= 0 && next < fsGallery.urls.length) showFullscreenImage(next);
  else if (!fsGallery.bounded) navigateArticle(dir);
}
function detailImageUrls(article) {
  if (article.images?.length) return article.images.map(image => image.url);
  return article.imageUrl ? [article.imageUrl] : [];
}

// ── Bild oder MP3 herunterladen ────────────────────────────────────────────
// Auf Touch-Geräten mit Teilen-Funktion (iPhone/iPad) öffnet der Button das System-
// Teilen-Menü mit der Datei („Bild sichern“ → Fotos, „In Dateien sichern“), das sich
// jederzeit abbrechen lässt; Safaris Abfrage für <a download> hat dort keinen Abbrechen-
// Knopf und führt aus der Home-Bildschirm-App nicht zurück. Sonst bleibt es beim normalen
// Download. Die Datei wird beim Anzeigen schon vorbereitet, weil iOS das Teilen-Menü nur
// unmittelbar nach dem Tippen öffnet.
const shareFiles = () => typeof navigator.canShare === 'function' && matchMedia('(pointer: coarse)').matches;
const shareFileCache = new Map(); // URL → Promise<File|null>
const readyShareFiles = new Map(); // URL → File|null (fertig geladen)
const SHARE_FILE_CACHE = 3;
const SHARE_DOWNLOAD_LINKS = '.detail-hero-download, #img-fullscreen-download, #tts-download';

function prepareShareFile(url) {
  if (!shareFiles() || !url) return Promise.resolve(null);
  if (shareFileCache.has(url)) return shareFileCache.get(url);
  const name = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || 'bild.jpg');
  const fallbackType = /\.mp3$/i.test(name) ? 'audio/mpeg' : 'image/jpeg';
  const promise = fetch(url)
    .then(r => (r.ok ? r.blob() : null))
    .then(blob => (blob ? new File([blob], name, { type: blob.type || fallbackType }) : null))
    .catch(() => null)
    .then(file => { readyShareFiles.set(url, file); return file; });
  shareFileCache.set(url, promise);
  // Nur die letzten Dateien behalten.
  while (shareFileCache.size > SHARE_FILE_CACHE) {
    const oldest = shareFileCache.keys().next().value;
    shareFileCache.delete(oldest);
    readyShareFiles.delete(oldest);
  }
  return promise;
}

document.addEventListener('click', async e => {
  const link = e.target.closest?.(SHARE_DOWNLOAD_LINKS);
  if (!link || !shareFiles()) return;
  e.preventDefault();
  const url = link.getAttribute('href');
  const isImage = !/\.mp3(?:$|\?)/i.test(url);
  const ready = readyShareFiles.has(url);
  const file = ready ? readyShareFiles.get(url) : await prepareShareFile(url);
  if (!file || !navigator.canShare({ files: [file] })) {
    // Teilen mit Datei nicht möglich: Bild in neuem Tab öffnen (dort per langem Druck sichern).
    // Eine MP3 nicht: Das neue Fenster hätte in der Home-Bildschirm-App keinen Weg zurück.
    if (isImage) window.open(url, '_blank', 'noopener');
    else alert('Die MP3 lässt sich auf diesem Gerät nicht teilen. Bitte im Browser herunterladen.');
    return;
  }
  try {
    await navigator.share({ files: [file] });
  } catch (err) {
    // AbortError = abgebrochen. NotAllowedError: Datei war noch nicht geladen und iOS
    // verlangt ein neues Tippen – jetzt liegt sie bereit.
    if (err.name === 'NotAllowedError' && !ready) alert(`${isImage ? 'Das Bild' : 'Die MP3'} ist jetzt bereit. Bitte noch einmal tippen.`);
  }
});
