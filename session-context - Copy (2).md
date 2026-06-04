# WebArchiv — Session-Kontext & Bearbeitungsstand

_Stand: 2026-06-02 (5. Aktualisierung)_

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

**9. Anonymer Gastzugriff via `public-directories.txt`** — Neue Datei im Projekt-Root (JSON-Format):
```json
{
  "public-directories": ["Videos", "PDF", "Infografiken"]
}
```
- Autoren aus dieser Liste sind **ohne Login** sichtbar
- Sperrt alle anderen Autoren für unauthentifizierte Nutzer
- Fehlt die Datei oder ist leer → Pflicht-Login (bisheriges Verhalten)

**10. Soft-Auth-Middleware `attachUser(req, res, next)`** — ersetzt `requireAuth` auf Datenrouten:
- Setzt `req.user` zu Session-User **oder** synthetischem Guest mit `role: 'guest'`
- Guest hat `allowedAuthors = publicAuthors` (Whitelist-Filter)
- Blockt nur, wenn weder Session noch Public-Liste vorhanden (`401`)
- `canAccessAuthor()` ACL-Check funktioniert unverändert für beide Fälle

**11. Helper `getEffectiveUser(req)`** — vereinheitlicht User-Auflösung:
```js
function getEffectiveUser(req) {
  if (req.session?.user) return req.session.user;
  return { email: null, role: 'guest', allowedAuthors: publicAuthors };
}
```
Genutzt von `/api/me`, Soft-Auth-Middleware, und Datenrouten.

**12. Datums-Format-Normalisierung** — Parser erkennt und konvertiert mehrere Datumsformate zu ISO `YYYY-MM-DD`:
- ISO: `2024-01-15` → `2024-01-15`
- Deutsch: `15.01.2024` → `2024-01-15`
- Slash: `15/01/2024` → `2024-01-15`
- Helper `normalizeDate(raw)` nutzen auch die Datum-Finder
- Einzelne `*`-Marker (Italic) werden vor dem Parsing gestrippt

**13. Datums-Such-Filter im Suchfeld** — `parseDateQuery(q)` erkennt datumsähnliche Eingaben:
- `2024-01-15` oder `15.01.2024` → exakten Tag filtern (Fuse.js umgehen)
- `2024-01` oder `01.2024` → gesamten Monat filtern (`date.startsWith()`)
- `2024` → gesamtes Jahr filtern (`date.startsWith()`)
- Andere Eingaben → normale Fuse.js Fuzzy-Suche
- Kombinierbar mit Autor-, Jahr-, Kategorie-Filtern (werden vorher angewendet)

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

**18. Authentication UI** — Logon/Logout-Button Toggle:
- `$loginBtn` (Anmelden) sichtbar wenn `currentUser.role === 'guest'` oder kein User
- `$logoutBtn` (Abmelden) sichtbar nur für authentifizierte User
- `applyUserUI(user)` steuert beide Buttons über `isGuest`-Flag
- Login-Dialog kann mit `×`-Button oder `ESC` geschlossen werden (nur wenn nicht initialer Pflicht-Login)
- Logout führt zurück zu Guest-Mode (neu lädt `/api/me` statt Anmelde-Dialog zu zeigen)
- Init-Flow: `/api/me` liefert immer einen User → kein automatischer Login-Dialog

**19. Zoom-aware Swipe-Navigation** — `swipeAllowed(delta)` — neu:
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
| Anonymer Gastzugriff (public-directories.txt) | ✅ neu |
| Soft-Auth-Middleware + getEffectiveUser() | ✅ neu |
| Logon/Logout-Button-Toggle | ✅ neu |
| Login-Dialog mit Schließen-Button | ✅ neu |
| Datumsformat-Normalisierung (DD.MM.YYYY, ISO) | ✅ neu |
| Datums-Suche im Suchfeld (YYYY, YYYY-MM, Tag) | ✅ neu |
| Performance: ETag + 304 Not Modified (Cache enabled) | ✅ neu |

---

## API-Endpunkte

| Methode | Pfad | Auth | Beschreibung |
|---|---|---|---|
| `GET` | `/api/me` | — | Gibt aktuellen User zurück: Session-User oder Guest mit `role: 'guest'` |
| `POST` | `/api/login` | — | Login mit `email`, `password`; setzt Session |
| `POST` | `/api/logout` | — | Zerstört Session; Frontend zeigt Guest-Mode |
| `GET` | `/api/meta` | Soft-Auth | `{ authors, years, categories }` (gefiltert nach ACL) |
| `GET` | `/api/articles` | Soft-Auth | Paginierte Liste; Query: `page`, `limit`, `author`, `year`, `category`, `q` (Datums-Suche erkannt) |
| `GET` | `/api/articles/:id` | Soft-Auth | Einzelartikel mit `bodyHtml`, inkl. `sourceUrl`, `videoUrl`, `pdfUrl` |
| `GET` | `/api/infografik-prompt` | Soft-Auth | Dateiinhalt von `infografik-prompt.txt` (für Copy-Button mit Prefix) |
| `POST` | `/api/reindex` | Admin-only | Neu-Indizierung; antwortet mit `{ ok, articles: N }` |
| `GET` | `/files/*` | Soft-Auth | Statische Dateien aus `www/` (Bilder, Audio, Video, PDF); ACL-Check pro Autor |

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
- **Session-basierte Auth:** Express `session`-Middleware mit HttpOnly Cookies. `maxAge: 7 Tage`. Secret über `process.env.SESSION_SECRET` oder Dev-Default.
- **Public-Verzeichnis-Whitelist:** Namen in `public-directories.txt` müssen **exakt** den Verzeichnisnamen unter `www/` entsprechen (Case-sensitive auf Linux, insensitive auf Windows).
- **Guest-Mode ist persistent:** Nach Logout bleibt `currentUser` auf dem Guest-Objekt; Reload ruft `/api/me` auf und holt den aktuellen Status. Kein Zwang zum Login, wenn Public-Autoren konfiguriert.
- **Datums-Such-Normalisierung:** Suche nach `2024-01` / `01.2024` / `2024` nutzt `date.startsWith()` — alle Artikel mit Datum beginnend mit diesem Prefix werden angezeigt. Fuzzy-Suche wird umgangen.

---

## Letzte Änderungen (Session 5: 2026-06-02)

**Feature-Branch:** `feature/default-user-und-logon-dialog` → in `main` gemergt (Commit f60bae4)

### Implementierte Verbesserungen

1. **Anonymer Gastzugriff**
   - Neue Datei `public-directories.txt` (JSON) definiert öffentliche Autoren
   - Unauthentifizierte Nutzer sehen nur diese Autoren (Soft-Auth-Middleware)
   - Fallback: leere Liste → Pflicht-Login (sicheres Verhalten)

2. **Benutzeroberflächen-Verbesserungen**
   - Logon/Logout-Button Toggle: Zeigt je nach User-Rolle unterschiedliche Button
   - Login-Dialog mit `×`-Schließen-Button und ESC-Shortcut
   - Logout führt zu Guest-Mode statt Login-Dialog (wenn Public-Autoren aktiv)

3. **Backend-Architektur**
   - `getEffectiveUser(req)`: Vereinheitlichte User-Auflösung (Session oder Guest)
   - `attachUser()` Soft-Auth-Middleware ersetzt `requireAuth` auf Datenrouten
   - `/api/me` liefert immer einen User (nie 401), ermöglicht direkt Laden ohne Dialog

4. **Datumsformat-Handling**
   - Parser erkennt DD.MM.YYYY, DD/MM/YYYY und ISO-Format
   - Alle Formate werden zu YYYY-MM-DD normalisiert (einzelne `*`-Marker werden gestrippt)
   - Infografiken-Dateien mit deutschem Datumsformat funktionieren jetzt korrekt

5. **Datums-Suche**
   - Suchfeld erkennt datumsähnliche Eingaben: `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, `DD.MM.YYYY`
   - Filtert direkt über `date`-Feld statt Fuzzy-Suche (schneller, präziser)
   - Kombinierbar mit Autor-/Kategorie-Filtern

6. **Performance**
   - No-Cache-Header entfernt → Browser nutzt ETag + 304 Not Modified
   - Seitenladezeit auf iPhone/LAN merklich verbessert

### Commits in diesem Feature-Branch

- `3c4c12e` — Add anonymous guest mode with public-directories whitelist + Logon button
- `9579d90` — remove no-cache setting again (Performance)
- `f60bae4` — correct date search (Datums-Such-Feature implementiert)

---

## Nächste mögliche Aufgaben

### Hoch-Priorität

1. **Rollen-basierte Zugriffsrechte verfeinern** — aktuell nur `guest` vs. `admin` + allowlist. Evtl. `moderator`, `editor`, oder Autor-spezifische Beschränkungen (z.B. nur eigene Artikel bearbeiten) hinzufügen.
2. **User-Management UI** — Admin-Panel zum Hinzufügen/Bearbeiten von Benutzern (derzeit nur `users.json` manuell).
3. **Session-Persistenz über Neustart** — aktuell nur RAM-basiert. Für längerfristige Server-Instanzen Store in SQLite/Redis erwägen.
4. **Datums-Picker im Filter** — statt Text-Eingabe ein Kalender-Widget für Datumsbereich.

### Mittel-Priorität

5. **Suche verbessern** — Fuzzy-Matching oder Relevanz-Sortierung (Titel-Treffer höher gewichten als Body-Text).
6. **Async Re-Index** — `buildIndex()` non-blocking mit Fortschritts-Feedback im UI; verhindert UI-Freeze bei großen Archiven.
7. **Dark/Light-Mode-Toggle** — CSS-Variablen sind bereits strukturiert, nur ein `prefers-color-scheme`-Override fehlt.
8. **Artikel-Direktlink teilen** — Hash-Routing existiert bereits; ein „Link kopieren"-Button im Detail-Overlay wäre trivial.
9. **Mobile Detail-Overlay** — Overlay-Panel auf kleinen Screens als Full-Screen statt schmalem Panel.
10. **Zusammenfassung in Kachel-Vorschau** — `summary` statt `preview` anzeigen, wenn vorhanden.

### Niedrig-Priorität / Nice-to-Have

11. **Lesezeichen / Favoriten** — clientseitig in localStorage, kein Server-Eingriff nötig.
12. **Vollbild-Bildergalerie** — mehrere Bilder pro Artikel im Vollbild-Modus durchblättern.
13. **PDF.js in Repo integrieren** — `pdfjs/` per npm-Script oder Download-Script automatisch bereitstellen (z.B. via `npm run setup`).
14. **Video-Thumbnail / Poster** — Artikel-Bild als `poster`-Attribut beim `<video>`-Element nutzen, falls vorhanden.
15. **Export-Funktionen** — Artikel als PDF/EPUB exportieren; Suchresultate als CSV.
16. **Offline-Modus** — Service-Worker + IndexedDB für Offline-Browsing des gecachten Index.
