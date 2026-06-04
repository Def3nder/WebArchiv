# WebArchiv — Session-Kontext & Bearbeitungsstand

_Stand: 2026-06-04 (7. Aktualisierung — vier neue Features: Prompt-Menü, Fullscreen-Bilder, kombinierte Suche, Cache-Busting)_

---

## Projektübersicht

**WebArchiv** ist ein lokaler, authentifizierter Artikel-Archiv-Viewer für
Markdown-Dateien aus dem `www/`-Verzeichnis.

```
WebArchiv/
├── server.js                ← Express-Server: Datei-Scan, Parser, Auth, API
├── package.json
├── users.json               ← Benutzer (bcrypt-Hashes, Rollen, ACL)
├── example-users.json       ← Vorlage für users.json
├── public-directories.txt   ← JSON: öffentliche Autoren für Gastzugriff
├── prompts/                 ← Prompt-Vorlagen (Zahlen-Präfix steuert Reihenfolge)
│   ├── 1_Infografik-Prompt-ChatGPT.txt
│   └── 2_Infografik-Prompt-Gemini.txt
├── session-context.md
├── scripts/
│   └── hash-passwords.js    ← bcrypt-Hashing der Klartext-Passwörter in users.json
└── public/
    ├── index.html           ← SPA-Shell
    ├── styles.css           ← Design-System (CSS-Variablen, Dark/Light, Layout)
    ├── app.js               ← Frontend: Routing, Suche, Auth, Rendering
    └── pdfjs/               ← PDF.js Viewer (manuell von GitHub herunterladen)
        ├── web/viewer.html
        └── build/pdf.mjs …
```

**Tech-Stack:** Node.js 18+ · Express 4 · `express-session` · `bcryptjs` ·
`fuse.js` (Fuzzy-Suche) · `marked` (Markdown→HTML) · Vanilla HTML/CSS/JS ·
PDF.js (PDF-Viewer)

---

## Autoren & Verzeichnisstruktur

Aktuelle Autor-Ordner unter `www/` (Ordnername = Autorname, mit Leerzeichen):

| Autor-Ordner | Medien | Besonderheiten |
|---|---|---|
| `Joe Turan/` | Bild | optionale `Quelle:`-Zeile (URL), Bild gleichnamige `.jpg/.jpeg/.png`, Fallback `standard.jpg` |
| `Stefan Hiene/` | Audio | Audio: gleichnamige `.mp3` |
| `Videos/` | Video | Video: gleichnamige `.mp4` |
| `PDF/` | PDF | PDF: gleichnamige `.pdf`, PDF.js-Viewer |
| `Infografiken/` | Bild | Datumsformat oft deutsch `DD.MM.YYYY` |

- Jahres-Unterordner (`/2025/`, `/2026/`) werden erkannt und als `year` gesetzt.
- Neue Autoren werden automatisch erkannt — neuen Ordner unter `www/` anlegen,
  dann **Re-Index-Button** (nur Admin) klicken.
- `www/bilder-zu-md.ps1` ist ein Hilfsskript (kein App-Bestandteil).

---

## Architektur-Entscheidungen

### Backend (`server.js`)

**1. In-Memory-Index** — kein DB-Layer. Beim Start und auf `POST /api/reindex`
werden alle `.md`-Dateien rekursiv gescannt (`buildIndex()` → `scanDir()`) und
im Array `articles[]` gehalten. Deduplizierung per `id`. Sortierung absteigend
nach `date`.

**2. Einheitlicher Parser `parseArticle(content, filePath)`** — gemeinsames
MD-Format für alle Autoren:

```
Titel-Zeile(n)               ← alles vor "Datum:" (Markdown-Marker entfernt)
*Quelle: [text](url)*        ← optional; URL wird extrahiert, nicht im Titel
Datum: YYYY-MM-DD            ← auch **Datum:**, ## _Datum:_, *Datum:* erkannt
Audioquickie: ###            ← optional (→ episodeNum)
Kategorien: A, B, C         ← optional, komma-getrennt (→ tags)
Zusammenfassung:             ← optional; Text bis zur nächsten ****-Trennlinie
Text der Zusammenfassung
****                         ← oder ----
Artikeltext (Body)
```

- Alle Metadaten-Schlüsselwörter **case-insensitive**; `**`, `*`, `_`, `#`
  werden beim Keyword-Matching ignoriert.
- Separator `****`/`----` wird gegen `raw.trim()` geprüft (nicht gegen `clean`).
- Ohne Separator: Body beginnt nach der letzten Metadaten-Zeile.

**3. Datumsformat-Normalisierung `normalizeDate(raw)`** — erkennt und
konvertiert zu ISO `YYYY-MM-DD`:
- ISO `2024-01-15`, deutsch `15.01.2024`, Slash `15/01/2024`
- `extractDate()` fällt auf die ersten 12 Zeilen oder das Dateinamen-Präfix
  zurück; einzelne `*`-Italic-Marker um die `Datum:`-Zeile werden gestrippt.

**4. Getrennte Felder Kategorien / Tags:**
- `categories[]` = einheitliche Taxonomie-Labels (12 Buckets, keyword-basiert,
  `autoCategorize()`, top-5) → für Filterung & Fuse-Index
- `tags[]` = rohe `Kategorien:`-Keywords (bis 10, nur Anzeige im Detail)
- `summary` = Zusammenfassungs-Prosa (`null` wenn fehlt)
- `excerpt` = für Suche (bevorzugt `summary`, sonst Body-Anfang, 320 Zeichen)
- `preview` = erste ~200 Zeichen des Body (Kachel-Vorschau)
- `sourceUrl` = optionale Quelle-URL (`null` wenn fehlt)

**5. `findSibling(dir, basename, exts)`** — sucht Geschwisterdateien:
```js
findSibling(dirPath, basename, ['.jpg', '.jpeg', '.png'])  // Bild (+ standard.jpg Fallback)
findSibling(dirPath, basename, ['.mp3'])                   // Audio
findSibling(dirPath, basename, ['.mp4'])                   // Video
findSibling(dirPath, basename, ['.pdf'])                   // PDF
```

**6. Artikel-Objekt** — Felder nach `scanDir()`:
```js
{
  id, author, year, title, date,
  categories[], tags[], excerpt, summary, sourceUrl, preview,
  imageUrl, audioUrl, videoUrl, pdfUrl,   // /files/…?v=<mtime> oder null
  episodeNum,
  filePath    // wird vor jeder API-Response entfernt
}
```
Medien-URLs tragen mtime-basierte Versionierung (`?v=<mtimeMs>`), damit
ausgetauschte Dateien (gleicher Name, neuer Inhalt) nach Server-Neustart/Re-Index
vom Browser neu geladen werden statt aus dem Cache serviert.

**7. Fuzzy-Suche mit Fuse.js** — `fuseIndex` wird in `buildIndex()` aufgebaut,
gewichtete Keys: `title` (3), `author` (1.5), `categories` (1), `excerpt` (0.8);
`threshold: 0.35`, `ignoreLocation: true`, `minMatchCharLength: 2`.

**8. Kombinierte Text- + Datums-Suche** — Query wird in Whitespace-Tokens
zerlegt; pro Token `parseDateQuery()`:
- Datums-Tokens (`2024-01-15`, `15.01.2024`, `2024-01`, `01.2024`, `2024`)
  → `date`-Filter anwenden (AND)
- Restliche Text-Tokens → Fuse-Fuzzy-Suche auf der gefilterten Teilmenge
- Bsp. `Achtsamkeit 2025` → all Fuzzy-Treffer nur aus 2025; reine Datums- oder
  Text-Eingaben funktionieren wie bisher (Rückwärtskompatibilität)

**9. Asynchrones Re-Indexing** — `POST /api/reindex` startet `buildIndex()`
non-blocking und antwortet sofort mit `{ started: true }`. Fortschritt über
`reindexState = { running, processed, articles, done }`, abrufbar via
`GET /api/reindex/status`. Frontend pollt alle 600 ms.

**10. Detail-Route** — `GET /api/articles/*` re-parst die Datei, rendert
`parsed.body` via `marked.parse()`, merged mit gecachtem Objekt
(`{ ...rest, bodyHtml }`). Liefert auch `sourceUrl`, `videoUrl`, `pdfUrl`.

### Authentifizierung & Zugriffskontrolle

**11. Session-basierte Auth** — `express-session` mit HttpOnly-Cookie
(`maxAge: 7 Tage`, `sameSite: 'lax'`). Secret aus `process.env.SESSION_SECRET`
oder Dev-Default. Passwörter via `bcryptjs` verifiziert.

**12. `users.json`** — Array oder `{ users: [...] }`. Pro User:
```js
{ email, passwordHash, role, allowedAuthors }
```
- `role`: `'admin'` (darf Re-Index) oder `'user'`
- `allowedAuthors`: `null` = alle Autoren, `[...]` = Whitelist
- `example-users.json` als Vorlage vorhanden.

**12a. Passwort-Hashing-Skript `scripts/hash-passwords.js`** — bcrypt-Workflow
(Cost-Faktor 12) für die Passwortpflege:
- In `users.json` ein Klartext-Feld `"password"` eintragen, dann
  `node scripts/hash-passwords.js` ausführen.
- Das Skript ersetzt jedes `"password"` durch `"passwordHash"` (Klartext wird
  gelöscht) und schreibt `users.json` zurück. Bereits gehashte Einträge bleiben
  unverändert.
- **Passwort ändern:** `"passwordHash"`-Zeile löschen, `"password": "Neu"`
  eintragen, Skript erneut laufen lassen.

**13. Anonymer Gastzugriff via `public-directories.txt`** (JSON):
```json
{ "public-directories": ["Videos", "PDF", "Infografiken"] }
```
- Autoren in dieser Liste sind **ohne Login** sichtbar.
- Fehlt die Datei / leere Liste → Pflicht-Login (Fallback).

**14. `canAccessAuthor(user, author)`** — ACL-Check: `allowedAuthors === null`
→ alle erlaubt, sonst Whitelist-Membership.

**15. `getEffectiveUser(req)`** — liefert Session-User **oder** synthetischen
Guest `{ email: null, role: 'guest', allowedAuthors: publicAuthors }`.

**16. Middleware-Schichten:**
- `attachUser` (Soft-Auth) — setzt `req.user` (Session oder Guest); `401` nur
  wenn Guest **und** Public-Liste leer. Auf allen Datenrouten.
- `requireAuth` — `401` ohne Session. Nur noch `/api/reindex/status`.
- `requireAdmin` — `403` ohne Admin-Rolle. Nur `POST /api/reindex`.

### Frontend (`public/app.js`, `index.html`)

**17. Hash-basiertes SPA-Routing** — `#/` (Liste), `#/article/:id`
(Detail-Overlay). Back-Button via `popstate`. **Deep-Links** werden beim Init
und nach Login aufgelöst (Artikel öffnet direkt).

**18. Zentrales `state`-Objekt:**
```js
{ q, author, year, category, page, limit, total, pages, loading,
  currentItems, currentArticleIdx }
```
`currentUser` hält `{ email, role, allowedAuthors }` (oder Guest/null).

**19. Auth-UI** — Logon/Logout-Button-Toggle in `applyUserUI(user)`:
- `$reindexBtn` nur für `role === 'admin'`
- `$logoutBtn` nur für eingeloggte (Nicht-Guest) User
- `$loginBtn` (Logon) für Guests / nicht eingeloggt
- Login-Dialog mit `×`-Button und ESC schließbar (ESC nur wenn `currentUser`
  existiert — nicht beim initialen Pflicht-Login)
- Logout → zurück in Guest-Mode (lädt `/api/me` neu) statt Login-Dialog
- `apiFetch()` fängt `401` → zeigt Login-Dialog ("Sitzung abgelaufen")

**20. Dark/Light-Mode-Toggle** — `$themeBtn` schaltet
`document.body.dataset.theme` zwischen `dark`/`light`, persistiert in
`localStorage['wa-theme']` (Default `dark`). Sonne/Mond-Icon passt sich an.

**21. Schriftart-Auswahl** — 4 Presets, `localStorage['wa-font']`.

| Preset | Heading | Body |
|---|---|---|
| Editorial | Playfair Display | Lora |
| Klassisch | Georgia | Georgia |
| Modern (HTML-Default) | Inter | Inter |
| System | system-ui | system-ui |

**22. Layout-Modus** — `body.layout-tall` steuert Kachelform; Dropdown
(Default „Länglich").

**23. Artikel-Navigation im Overlay:**
- `←`/`→` Pfeiltasten, `‹`/`›` Buttons, Touch-Swipe links/rechts
- Seitenübergang automatisch am Seitenende (lädt nächste/vorige Seite)
- Audio/Video werden bei jedem Artikelwechsel gestoppt

**24. Zoom-aware & richtungs-sensitive Swipe-Navigation:**
- `swipeAllowed(delta)` verhindert Artikelwechsel beim Panning im gezoomten
  Viewport (via `visualViewport.scale` + Kanten-Erkennung)
- Schwellen: `SWIPE_MIN_X = 80px`, X muss Y um Faktor 1.5 dominieren,
  `SWIPE_MAX_DURATION = 500ms` (länger = Long-Press/Selektion)
- `hasActiveSelection()` bricht Navigation bei aktiver Textmarkierung ab
- Multi-Touch-Start (`touchStartMulti`) unterdrückt Navigation nach Pinch-Zoom
- Gilt für `.overlay-panel` UND `#img-fullscreen`

**25. Bild-Vollbild-Ansicht** (`#img-fullscreen`):
- Layout: volle Bildschirmbreite, von oben startend, vertikal scrollbar
  (`display: block`, `overflow-y: auto`, `-webkit-overflow-scrolling: touch`)
- Bild: `width: 100%; height: auto` (responsive, nicht zentriert)
- Schließen-Button: `position: fixed` (bleibt beim Scrollen sichtbar)
- Klick/ESC/Hintergrund schließt; Swipe-Navigation wechselt Artikel
- `openArticle()` aktualisiert das Vollbild-Bild bei Navigation

**26. Copy-Button mit dynamischem Prompt-Menü** (`detail-copy-btn`, nur wenn Body):
- Text-Zone „copy" (`data-copy-zone="plain"`) → sofort nur `Titel\n\n---\n\nBody`
- Icon-Zone (`data-copy-zone="prompt"`, aria-haspopup) → öffnet Menü:
  - Erster Eintrag: „Artikel" (= Text ohne Prompt)
  - Pro Prompt-Datei aus `prompts/` ein Eintrag (Label = Dateiname ohne Präfix/Endung)
  - Reihenfolge per Zahlen-Präfix (`1_`, `2_`, …)
  - Klick → `GET /api/prompts/<file>`, Inhalt vorangestellt + Artikel kopiert
- Menü schließt via Auswahl, ESC, Außenklick; Fuse-Fehler → Fallback Artikel ohne Prompt
- `copied`-Highlight für 1 s; iOS-tauglich (kein Doppeltap/Long-Press)

**27. Quelle-Anzeige** — `sourceUrl` als kursiver, klickbarer Link unter dem
Datum (`.detail-source`, neuer Tab).

**28. Audio-Player** (`renderAudioPlayer` / `wireAudioPlayer`) — custom styled,
Progress-Bar, Seek per Klick. **Video** = nativer HTML5-Player.
**PDF** = PDF.js-iframe + Fallback-Link.

**29. Detail-Overlay Aufbau (DOM-Reihenfolge):**
```
detail-hero            ← Bild + Expand + Download
detail-content
  meta (Autor, Episode)
  <h1> Titel
  categories / tags
  date-row (Datum + Copy-Button)
  source (Quelle-Link)
  summary (Zusammenfassung)
  divider
  Audio-Player / Video-Player
  detail-body (bodyHtml)
  PDF-Viewer
```

---

## API-Endpunkte

| Methode | Pfad | Auth | Beschreibung |
|---|---|---|---|
| `GET` | `/api/me` | — | Aktueller User: Session-User oder Guest |
| `POST` | `/api/login` | — | Login (`email`, `password`); setzt Session |
| `POST` | `/api/logout` | — | Zerstört Session |
| `GET` | `/api/meta` | Soft-Auth | `{ authors, years, categories }` (ACL-gefiltert) |
| `GET` | `/api/articles` | Soft-Auth | Paginierte Liste; Query `q`, `author`, `year`, `category`, `page`, `limit` (kombinierte Text+Datums-Suche) |
| `GET` | `/api/articles/:id` | Soft-Auth | Einzelartikel mit `bodyHtml`, `sourceUrl`, `videoUrl`, `pdfUrl`, Medien-URLs mit mtime-Versionierung |
| `GET` | `/api/prompts` | Soft-Auth | Liste verfügbarer Prompts: `[{ file, label }]` (aus `prompts/` mit Zahlen-Präfix sortiert) |
| `GET` | `/api/prompts/:file` | Soft-Auth | Inhalt einer Prompt-Datei (Path-Traversal-Schutz) |
| `GET` | `/api/reindex/status` | requireAuth | `{ running, processed, articles, done }` |
| `POST` | `/api/reindex` | requireAdmin | Startet Re-Index async, `{ started: true }` |
| `GET` | `/files/*` | Soft-Auth | Statische Medien aus `www/` (ACL pro Autor, Path-Traversal-Schutz) |

---

## Implementierte Features

| Feature | Status |
|---|---|
| Artikel-Kacheln (Grid), Quadratisch/Länglich | ✅ |
| Fuzzy-Volltextsuche (Fuse.js, gewichtet, 300 ms Debounce) | ✅ |
| Kombinierte Text- + Datums-Suche ("Achtsamkeit 2025") | ✅ |
| Filter: Autor, Jahr, Kategorie; Seitengröße; Paginierung | ✅ |
| Auto-Kategorisierung (12 Buckets) | ✅ |
| Datumsformat-Normalisierung (DD.MM.YYYY, Slash, ISO) | ✅ |
| Optionale Quelle-URL (Joe Turan) | ✅ |
| Standard.jpg-Fallback, fault-tolerantes Parsing | ✅ |
| Detail-Overlay (Bild, Titel, Kategorien, Tags, Datum, Summary, Body) | ✅ |
| Audio-Player (custom) / Video (HTML5) / PDF (PDF.js) | ✅ |
| Kachel-Badges: Audio / Video / PDF | ✅ |
| Copy-Button mit dynamischem Prompt-Menü (Text-Zone = sofort kopieren) | ✅ |
| Bild-Vollbild: volle Breite, von oben, scrollbar (iPad-fix) | ✅ |
| Artikel-Navigation: Tastatur, Buttons, Swipe (zoom-/selektions-aware) | ✅ |
| Hash-Routing + Deep-Links (`#/article/:id`) | ✅ |
| Session-Auth (bcrypt), Rollen (admin/user) + ACL | ✅ |
| Anonymer Gastzugriff (public-directories.txt) | ✅ |
| Soft-Auth-Middleware + getEffectiveUser() | ✅ |
| Logon/Logout-Toggle, schließbarer Login-Dialog | ✅ |
| Async Re-Index mit Fortschritts-Polling | ✅ |
| Cache-Busting für ausgetauschte Medien (mtime-basiert) | ✅ |
| Dark/Light-Mode-Toggle (localStorage) | ✅ |
| Schriftart-Auswahl (4 Presets, localStorage) | ✅ |

---

## Design

**Stil:** Warm Editorial — Dark Mode (Default) + Light Mode (Toggle)

| Token (Dark) | Wert |
|---|---|
| Hintergrund | `#0f0e0b` (warmes Fast-Schwarz) |
| Surface | `#191714` |
| Text | `#ede6d2` (warmes Creme) |
| Text muted | `#7a7266` |
| Accent | `#c9a84c` (Bernstein-Gold) |
| Grid | 4 Spalten → 3 (<1100 px) → 2 (<720 px) |

Light-Mode über `body[data-theme="light"]`-Overrides der CSS-Variablen.

---

## Bekannte Eigenheiten / Constraints

- **Keine Persistenz** — Index lebt im RAM; nach Neustart automatischer Build.
  Neue Dateien erfordern Re-Index (Admin).
- **Sessions im RAM** — `express-session` MemoryStore (Default). Nach
  Server-Neustart sind alle Sessions weg → erneuter Login. Für Produktion
  Store (SQLite/Redis) erwägen.
- **Parser-Robustheit:** Separator `****` gegen `raw.trim()` geprüft (kritisch).
- **PDF.js nicht im Repo** — `public/pdfjs/` manuell von
  `github.com/mozilla/pdf.js/releases` (`pdfjs-X.X.X-dist.zip`) bereitstellen.
- **Medien-Erkennung:** `findSibling()` nur exakt gleichnamige Dateien;
  case-sensitiv auf Linux, case-insensitiv auf Windows.
- **Public-Whitelist:** Namen in `public-directories.txt` müssen exakt den
  Ordnernamen unter `www/` entsprechen.
- **Statische Assets** nutzen Express-Default-Caching (ETag/304) — Performance.
  Bei Frontend-Updates ggf. einmal hart neu laden. `index.html` referenziert
  `styles.css?v=2` (manuelle Cache-Bust-Query).
- **Datums-Suche** umgeht Fuse vollständig — rein `date`-Feld-basiert.

---

## Letzte Änderungen (Session 7: 2026-06-04)

**Feature-Branch:** `search` (von `main` abgezweigt). Neue Commits:

1. **`26f12fb`** — Copy-Button für mehrere Prompts + Fullscreen in Seitenbreite
   - Dynamisches Prompt-Menü im Copy-Button (Unterordner `prompts/` mit Zahlen-Präfix)
   - Neue APIs: `GET /api/prompts`, `GET /api/prompts/:file`
   - Vollbild-Bilder: volle Bildschirmbreite, von oben, scrollbar (iPad-Fix)
   - `styles.css`: `.img-fullscreen` → `block + overflow-y:auto`

2. **`aafb032`** — Kombinierte Text- und Datums-Suche im Suchfeld
   - Query-Tokens zerlegen: Datums-Tokens → `date`-Filter, Text → Fuse-Suche
   - z.B. "Achtsamkeit 2025" kombiniert Fuzzy mit Jahr-Filter
   - Rückwärtskompatibel: reine Datumseingabe/Text-Eingabe funktioniert wie bisher

3. **`b61fb25`** — Cache-Busting für ausgetauschte Bilder/Medien
   - Medien-URLs tragen mtime als `?v=<mtimeMs>`
   - Ausgetauschtes Bild (gleicher Name, neue mtime) wird nach Neustart neu geladen
   - Helper `fileUrl(relPath, absPath)` stellt Versionsnummern bereit

---

## Nächste mögliche Aufgaben

### Hoch-Priorität
1. **User-Management UI** — Admin-Panel zum Anlegen/Bearbeiten von Benutzern
   (aktuell nur manuelle `users.json`).
2. **Session-Persistenz** — Store (SQLite/Redis) statt MemoryStore, damit
   Logins Neustarts überleben.
3. **Artikel-„Link kopieren"-Button** — Deep-Link-Mechanik existiert bereits;
   nur ein Button im Detail-Overlay fehlt.

### Mittel-Priorität
4. **Such-Relevanz / kombinierte Datums+Text-Suche** — aktuell schließen sich
   Datums- und Fuzzy-Suche gegenseitig aus; ggf. zusammenführen.
5. **Datums-Picker im Filter** — Kalender-Widget für Datumsbereich statt
   reiner Texteingabe.
6. **Mobile Detail-Overlay** — Panel auf kleinen Screens als Full-Screen.
7. **Zusammenfassung in Kachel-Vorschau** — `summary` statt `preview`, wenn da.

### Niedrig-Priorität / Nice-to-Have
8. **Lesezeichen / Favoriten** — clientseitig in localStorage.
9. **Vollbild-Bildergalerie** — mehrere Bilder pro Artikel durchblättern.
10. **PDF.js per Setup-Script** automatisch bereitstellen (`npm run setup`).
11. **Video-Poster** — Artikel-Bild als `poster`-Attribut nutzen.
12. **Export** — Artikel als PDF/EPUB; Suchresultate als CSV.
13. **Offline-Modus** — Service-Worker + IndexedDB.
