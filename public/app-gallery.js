/* WebArchiv — Vollbild-Galerie
 * Bildvollansicht mit Blättern, Zoom/Verschieben (Desktop) und Herunterladen/Teilen.
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
  prepareImageFile(url);
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
