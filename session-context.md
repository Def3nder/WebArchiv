# WebArchiv — Session-Kontext & Bearbeitungsstand

_Stand: 2026-05-29 (4. Aktualisierung)_

---

## Projektübersicht

**WebArchiv** ist ein lokaler Artikel-Archiv-Viewer für Markdown-Dateien aus dem `www/`-Verzeichnis.

```
WebArchiv/
├── server.js           ← Express-Server: Datei-Scan, Parser, API
├── package.json
├── session-context.md
└── public/
    ├── index.html      ← SPA-Shell
    ├── styles.css      ← Design-System (CSS-Variablen, Layout, Komponenten)
    ├── app.js          ← Frontend: Routing, Suche, Rendering
    └── pdfjs/          ← PDF.js Viewer (manuell von GitHub herunterladen)
        ├── web/viewer.html
        └── build/pdf.mjs …
```

**Tech-Stack:** Node.js 18+ · Express 4 · `marked` (Markdown→HTML) · Vanilla HTML/CSS/JS · PDF.js (PDF-Viewer)

---

## Autoren & Verzeichnisstruktur

| Autor-Ordner | Format | Besonderheiten |
|---|---|---|
| `Joe_Turan_Archiv/` | `.md` pro Artikel | Bild: gleichnamige `.jpg/.jpeg`, Fallback: `standard.jpg` im Root |
| `Stefan_Hiene/` | `.md` pro Artikel | Audio: gleichnamige `.mp3`, Bild: gleichnamige `.jpg/.jpeg`, Fallback: `standard.jpg` |
| `Videos/` | `.md` pro Artikel | Video: gleichnamige `.mp4`, Bild: gleichnamige `.jpg/.jpeg`, Fallback: `standard.jpg` |
| `PDF/` | `.md` pro Artikel | PDF: gleichnamige `.pdf`, Bild: gleichnamige `.jpg/.jpeg`, Fallback: `standard.jpg` |

Neue Autoren werden automatisch erkannt — einfach neuen Ordner unter `www/` anlegen. Nach dem Anlegen neuer Autoren/Dateien: **Re-Index-Button** im UI klicken.

---

## Architektur-Entscheidungen

### Backend

**1. In-Memory-Index** — kein Datenbank-Layer. Beim Start (und auf `/api/reindex`) werden alle `.md`-Dateien rekursiv gescannt und in einem Array `articles[]` gehalten. ~6.500 Dateien indexieren in ca. 1–2 s.

**2. Einheitlicher Parser `parseArticle(content, filePath)`** — Verarbeitet beliebige Autoren nach einem gemeinsamen MD-Format:

```
Titel-Zeile(n)               ← alles vor "Datum:" (Markdown-Marker werden entfernt)
Datum: YYYY-MM-DD            ← auch als ## _Datum:_ oder **Datum:** erkannt
Audioquickie: ###            ← optional
Kategorien: A, B, C         ← optional, komma-getrennt
Zusammenfassung:             ← optional; Text bis zur nächsten ****-Trennlinie
Text der Zusammenfassung
****
Artikeltext (Body)
```

- Alle Metadaten-Schlüsselwörter werden **case-insensitive** erkannt
- `**`, `_`, `#`-Dekorationen werden beim Keyword-Matching ignoriert
- Separator `****` oder `----` wird gegen `raw.trim()` geprüft (nicht gegen `clean`)
- Kein `****`: Body beginnt nach der letzten Metadaten-Zeile (Stefan-Hiene-Muster)

**3. Getrennte Felder für Kategorien und Tags:**

- `categories[]` = einheitliche Taxonomie-Labels (12 Buckets, keyword-basiert) → für Filterung
- `tags[]` = rohe `Kategorien:`-Keywords (bis 10, nur für Anzeige im Detail-Overlay)
- `summary` = Zusammenfassungs-Prosa (`null` wenn nicht vorhanden)
- `excerpt` = für Volltextsuche (bevorzugt `summary`, Fallback: Body-Anfang)
- `preview` = erste ~200 Zeichen des Body (für Kachel-Vorschau)

**4. Auto-Kategorisierung** (`autoCategorize(text)`) — 12 deutsche Themen-Buckets, top-5 Matches.

**5. `findSibling(dir, basename, exts)`** — sucht Geschwisterdateien nach Basename + Extension-Liste. Wird für alle Medientypen genutzt:

```js
findSibling(dirPath, basename, ['.jpg', '.jpeg', '.png'])  // Bild (+ standard.jpg Fallback)
findSibling(dirPath, basename, ['.mp3'])                   // Audio
findSibling(dirPath, basename, ['.mp4'])                   // Video  ← neu
findSibling(dirPath, basename, ['.pdf'])                   // PDF    ← neu
```

**6. Artikel-Objekt** — vollständige Felder nach `scanDir()`:

```js
{
  id, author, year, title, date,
  categories[], tags[], excerpt, summary, preview,
  imageUrl,   // /files/… oder null
  audioUrl,   // /files/… oder null
  videoUrl,   // /files/… oder null  ← neu
  pdfUrl,     // /files/… oder null  ← neu
  episodeNum,
  filePath    // wird vor API-Response entfernt
}
```

**7. Detail-Route** — `GET /api/articles/*` re-parst die Datei, rendert nur `parsed.body` via `marked.parse()`, merged mit dem gecachten Artikel-Objekt (`{ ...rest, bodyHtml }`). Alle Felder inkl. `videoUrl`/`pdfUrl` werden zurückgegeben.

**8. `POST /api/reindex`** — löst `buildIndex()` erneut aus (synchron), antwortet mit `{ ok, articles: N }`.

---

### Frontend

**9. Hash-basiertes SPA-Routing** — `#/` (Liste), `#/article/:id` (Detail-Overlay). Back-Button via `popstate`.

**10. State-Objekt** — zentrales `state`-Objekt:
```js
{ q, author, year, category, page, limit, total, pages, loading,
  currentItems,       // Artikel-Objekte der aktuellen Seite
  currentArticleIdx   // Index des offenen Artikels in currentItems
}
```

**11. Layout-Modus** — CSS-Klasse `body.layout-tall` steuert Kachel-Form. Per Dropdown umschaltbar.

**12. Schriftart-Auswahl** — 4 Presets in `localStorage`. Standard: **System**. Reset-Button ändert Schriftwahl **nicht**.

| Preset | Heading | Body |
|---|---|---|
| Editorial | Playfair Display | Lora |
| Klassisch | Georgia | Georgia |
| Modern | Inter | Inter |
| System (Standard) | system-ui | system-ui |

**13. Artikel-Navigation im Overlay** — Wechsel zwischen Artikeln (gefilterte Menge):
- `←` / `→` Pfeiltasten
- Swipe links/rechts (Schwelle: 60 px) — zoom-aware (siehe Punkt 18)
- `‹` / `›` Buttons an den Seiten
- Seitenübergang automatisch: am Seitenende wird die nächste Seite geladen

**14. Bild-Vollbild-Ansicht** (`#img-fullscreen`, z-index 500):
- Expand-Button (SVG, 4 Pfeile außen) + **Download-Button** ← neu, beide links oben auf dem Hero-Bild
- `.detail-hero-expand` bei `left: 12px`, `.detail-hero-download` bei `left: 56px`
- Compress-Icon links oben im Vollbild-Overlay; Klick/ESC/Hintergrund schließt Vollbild
- `openArticle()` aktualisiert das Vollbild-Bild wenn es offen ist

**15. Video-Player** (`renderVideoPlayer(videoUrl)`) — nativer HTML5 `<video>`-Player:
- `<video controls preload="metadata" class="detail-video">` innerhalb `.detail-content`, nach Audio-Player
- `stopVideo()` pausiert und leert `src` beim Artikel-Wechsel
- Kachel zeigt `.card-video-badge` wenn `article.videoUrl` vorhanden

**16. PDF-Viewer** (`renderPdfEmbed(pdfUrl)`) — **PDF.js Viewer** via iframe:
- `<iframe src="/pdfjs/web/viewer.html?file=<encoded_url>">` — mobile-kompatibel (iOS Safari)
- PDF.js liegt unter `public/pdfjs/` (manuell von GitHub herunterladen: `pdfjs-X.X.X-dist.zip`)
- Viewer bietet: Seiten-Navigation, Zoom, Thumbnails — auf allen Plattformen
- Fallback-Link "PDF in neuem Tab öffnen ↗" darunter
- Kachel zeigt `.card-pdf-badge` wenn `article.pdfUrl` vorhanden
- PDF erscheint nach dem Artikel-Body (innerhalb `.detail-content`)

**17. Detail-Overlay Aufbau** (Reihenfolge im DOM):
```
<div class="detail-hero">        ← Hero-Bild + Expand-Button + Download-Button
<div class="detail-content">
  meta (Autor, Episode)
  <h1> Titel
  categories / tags
  Datum
  Zusammenfassung
  <div class="detail-divider">
  Audio-Player (wenn audioUrl)   ← renderAudioPlayer()
  Video-Player (wenn videoUrl)   ← renderVideoPlayer()
  <div class="detail-body">      ← Artikel-Body (bodyHtml)
  PDF-Viewer (wenn pdfUrl)       ← renderPdfEmbed()
```

**18. Zoom-aware Swipe-Navigation** — `swipeAllowed(delta)` — neu:
```js
function swipeAllowed(delta) {
  const scale = window.visualViewport?.scale ?? 1;
  if (scale <= 1) return true;          // nicht gezoomt → immer erlaubt
  const vp = window.visualViewport;
  const atLeft  = vp.offsetLeft < 2;
  const atRight = (vp.offsetLeft + vp.width) >= (document.documentElement.clientWidth - 2);
  if (delta < 0) return atRight;        // wisch links → nur bei rechtem Bildrand
  if (delta > 0) return atLeft;         // wisch rechts → nur bei linkem Bildrand
  return false;
}
```
Zusätzlich: `touchStartMulti`-Flag verhindert Navigation nach Pinch-Zoom-Geste (Multi-Touch-Start).

---

## Implementierte Features

| Feature | Status |
|---|---|
| Artikel-Kacheln (Grid) | ✅ |
| Quadratisch / Länglich umschaltbar | ✅ |
| Volltext-Suche (300 ms Debounce) | ✅ |
| Filter: Autor, Jahr, Kategorie | ✅ |
| Seitengröße wählbar (12 / 24 / 48 / 96) | ✅ |
| Paginierung | ✅ |
| Standard.jpg-Fallback | ✅ |
| Fault-tolerantes Parsing (beliebige Autoren) | ✅ |
| Auto-Kategorisierung (12 Buckets) | ✅ |
| Detail-Overlay: Bild, Titel, Kategorien, Tags | ✅ |
| Detail-Overlay: Datum, Zusammenfassung (kursiv), Body | ✅ |
| Detail-Overlay: kein Header-Müll im Body | ✅ |
| Audio-Player (custom styled, Progress-Bar) | ✅ |
| Video-Player (nativer HTML5, `.mp4`) | ✅ neu |
| PDF-Viewer (PDF.js, mobile-kompatibel, `.pdf`) | ✅ neu |
| Kachel-Badges: Audio / Video / PDF | ✅ neu |
| Bild-Download-Button im Hero | ✅ neu |
| Responsive Filter-Leiste (flex-wrap) | ✅ |
| ↺ Re-Index-Button mit Bestätigungsdialog | ✅ |
| Schriftart-Auswahl (4 Presets, localStorage) | ✅ |
| Artikel-Navigation per Tastatur & Swipe | ✅ |
| Bild-Vollbild (Expand/Compress, Klick, ESC) | ✅ |
| Navigation (Tastatur/Swipe) im Vollbild-Modus | ✅ |
| Zoom-aware Swipe (kein Artikel-Wechsel beim Panning) | ✅ neu |

---

## API-Endpunkte

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/meta` | `{ authors, years, categories }` für Dropdowns |
| `GET` | `/api/articles` | Paginierte Liste; Query: `page`, `limit`, `author`, `year`, `category`, `q` |
| `GET` | `/api/articles/:id` | Einzelartikel mit `bodyHtml`, inkl. `videoUrl`, `pdfUrl` |
| `POST` | `/api/reindex` | Neu-Indizierung; antwortet mit `{ ok, articles: N }` |
| `GET` | `/files/*` | Statische Dateien aus `www/` (Bilder, Audio, Video, PDF) |

---

## Design

**Stil:** Warm Editorial Dark Mode

| Token | Wert |
|---|---|
| Hintergrund | `#0f0e0b` (warmes Fast-Schwarz) |
| Surface | `#191714` |
| Text | `#ede6d2` (warmes Creme) |
| Text muted | `#7a7266` |
| Accent | `#c9a84c` (Bernstein-Gold) |
| Standard-Font | system-ui (per localStorage überschreibbar) |
| Grid | 4 Spalten → 3 (<1100 px) → 2 (<720 px) → 2 (<440 px) |

---

## Bekannte Eigenheiten / Constraints

- **Synchroner Index-Build** blockiert den Event-Loop kurz (~1–2 s). Für Admin-Funktion akzeptabel.
- **Keine Persistenz** — der Index lebt nur im RAM. Nach Server-Neustart wird automatisch neu indiziert. Neue Dateien erfordern Re-Index-Button-Klick.
- **Volltextsuche** ist einfaches `Array.filter` + `includes` — ausreichend für ~6.500 Artikel, aber keine Fuzzy-Suche oder Relevanz-Ranking.
- **Parser-Robustheit:** Separator `****` wird gegen `raw.trim()` geprüft (kritisch — `clean` würde `****` zu `''` reduzieren).
- **Vollbild-Navigation:** Swipe-Listener auf `.overlay-panel` UND `#img-fullscreen`. Zoom-Schutz via `visualViewport.scale` + Edge-Detection.
- **PDF.js muss manuell bereitgestellt werden** — `public/pdfjs/` ist nicht im Repo, da das Paket ~10 MB groß ist. Download von `https://github.com/mozilla/pdf.js/releases` → `pdfjs-X.X.X-dist.zip` entpacken nach `public/pdfjs/`.
- **Video/PDF-Erkennung:** `findSibling()` findet nur exakt gleichnamige Dateien (Basename identisch zur `.md`-Datei). Case-sensitiv auf Linux, case-insensitiv auf Windows.

---

## Nächste mögliche Aufgaben

1. **Suche verbessern** — Fuzzy-Matching oder Relevanz-Sortierung (Titel-Treffer höher gewichten)
2. **Async Re-Index** — `buildIndex()` non-blocking mit Fortschritts-Feedback im UI
3. **Dark/Light-Mode-Toggle** — CSS-Variablen sind bereits strukturiert, nur ein `prefers-color-scheme`-Override fehlt
4. **Artikel-Direktlink teilen** — Hash-Routing existiert bereits; ein „Link kopieren"-Button im Detail-Overlay wäre trivial
5. **Mobile Detail-Overlay** — Overlay-Panel auf kleinen Screens als Full-Screen statt schmalem Panel
6. **Zusammenfassung in Kachel-Vorschau** — `summary` statt `preview` anzeigen, wenn vorhanden
7. **Lesezeichen / Favoriten** — clientseitig in localStorage, kein Server-Eingriff nötig
8. **Vollbild-Bildergalerie** — mehrere Bilder pro Artikel im Vollbild-Modus durchblättern
9. **PDF.js in Repo integrieren** — `pdfjs/` per npm-Script oder Download-Script automatisch bereitstellen (z.B. via `npm run setup`)
10. **Video-Thumbnail / Poster** — Artikel-Bild als `poster`-Attribut beim `<video>`-Element nutzen, falls vorhanden
