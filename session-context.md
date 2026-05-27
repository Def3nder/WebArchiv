# WebArchiv — Session-Kontext & Bearbeitungsstand

_Stand: 2026-05-27 (3. Aktualisierung)_

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
    └── app.js          ← Frontend: Routing, Suche, Rendering
```

**Tech-Stack:** Node.js 18+ · Express 4 · `marked` (Markdown→HTML) · Vanilla HTML/CSS/JS

---

## Autoren & Verzeichnisstruktur

| Autor-Ordner | Format | Besonderheiten |
|---|---|---|
| `Joe_Turan_Archiv/` | `.md` pro Artikel | Artikel-Bild: gleichnamige `.jpg/.jpeg`, Fallback: `standard.jpg` im Root |
| `Stefan_Hiene/` | `.md` pro Artikel | Audio: gleichnamige `.mp3`, Bild: gleichnamige `.jpg/.jpeg`, Fallback: `standard.jpg` |

Neue Autoren werden automatisch erkannt — einfach neuen Ordner unter `www/` anlegen.

---

## Architektur-Entscheidungen

### Backend

**1. In-Memory-Index** — kein Datenbank-Layer. Beim Start (und auf `/api/reindex`) werden alle `.md`-Dateien rekursiv gescannt und in einem Array `articles[]` gehalten. ~6.500 Dateien indexieren in ca. 1–2 s.

**2. Einheitlicher Parser `parseArticle(content, filePath)`** — ersetzt die früheren `parseJoeTuran()` und `parseStefanHiene()`. Verarbeitet beliebige Autoren nach einem gemeinsamen MD-Format:

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
- `**`, `_`, `#`-Dekorationen werden beim Keyword-Matching ignoriert (wichtig für Joe-Turan-Format)
- Separator `****` oder `----` wird gegen `raw.trim()` geprüft (nicht gegen `clean`, da `'****'.replace(/\*\*/g,'')` → `''`)
- Kein `****`: Body beginnt nach der letzten Metadaten-Zeile (Stefan-Hiene-Muster)

**3. Getrennte Felder für Kategorien und Tags:**

- `categories[]` = einheitliche Taxonomie-Labels (12 Buckets, keyword-basiert, alle Autoren) → für Filterung
- `tags[]` = rohe `Kategorien:`-Keywords aus der MD-Datei (bis 10, nur für Anzeige im Detail-Overlay)
- `summary` = Zusammenfassungs-Prosa (alle Autoren, `null` wenn nicht vorhanden)
- `excerpt` = für Volltextsuche (bevorzugt `summary`, Fallback: Body-Anfang)
- `preview` = erste ~200 Zeichen des Body (für Kachel-Vorschau)

**4. Auto-Kategorisierung** (`autoCategorize(text)`) — 12 deutsche Themen-Buckets mit Schlüsselwörtern, gibt top-5 Matches zurück. Keine externe Library, ~0 ms Overhead.

**5. Standard-Bild-Fallback** — `findSibling()` sucht erst nach artikel-spezifischem Bild, dann nach `standard.jpg` im Autor-Root.

**6. Detail-Route rendert nur den Body** — `GET /api/articles/*` re-parst die Datei und rendert nur `parsed.body` via `marked.parse()`.

**7. `POST /api/reindex`** — löst `buildIndex()` erneut aus (synchron), antwortet mit `{ ok, articles: N }`.

---

### Frontend

**8. Hash-basiertes SPA-Routing** — `#/` (Liste), `#/article/:id` (Detail-Overlay). Back-Button via `popstate`.

**9. State-Objekt** — zentrales `state`-Objekt:
```js
{ q, author, year, category, page, limit, total, pages, loading,
  currentItems,       // Artikel-Objekte der aktuellen Seite
  currentArticleIdx   // Index des offenen Artikels in currentItems
}
```

**10. Layout-Modus** — CSS-Klasse `body.layout-tall` steuert Kachel-Form. Standard: länglich. Per Dropdown umschaltbar.

**11. Schriftart-Auswahl** — Dropdown in der Filter-Leiste mit 4 Presets, gespeichert in `localStorage`. Standard: **System**. Reset-Button ändert die Schriftwahl **nicht**.

| Preset | Heading | Body |
|---|---|---|
| Editorial | Playfair Display | Lora |
| Klassisch | Georgia | Georgia |
| Modern | Inter | Inter |
| System (Standard) | system-ui | system-ui |

Implementiert via `body[data-font="…"]` CSS-Overrides auf `--font-head` / `--font-body`.

**12. Artikel-Navigation im Overlay** — Wechsel zwischen Artikeln (gefilterte Menge):
- `←` / `→` Pfeiltasten
- Swipe links/rechts auf Touch-Displays (Schwelle: 60 px)
- `‹` / `›` Buttons an den Seiten des Overlays
- Seitenübergang automatisch: am Seitenende wird die nächste Seite geladen

**13. `loadMeta()` ist idempotent** — vor dem Befüllen der Dropdowns werden alle dynamischen Optionen entfernt.

**14. Bild-Vollbild-Ansicht** — Klick auf das Hero-Bild oder den Expand-Button (links oben im Bild) öffnet ein Vollbild-Overlay:
- `#img-fullscreen` (z-index 500, über dem Artikel-Overlay mit z-index 200)
- Expand-Icon (SVG, 4 Pfeile nach außen) absolut positioniert, links oben auf dem Hero-Bild
- Compress-Icon (SVG, 4 Pfeile nach innen) links oben im Vollbild-Overlay; Klick schließt Vollbild
- Klick auf das Bild selbst oder den dunklen Hintergrund schließt ebenfalls das Vollbild
- ESC-Prioritätskette: zuerst Vollbild schließen, dann (zweites ESC) Artikel-Overlay
- Artikel-Navigation (Tastatur ← / →, Swipe) funktioniert auch im Vollbild-Modus
- `openArticle()` aktualisiert das Vollbild-Bild wenn es offen ist; kein Bild → Vollbild wird automatisch geschlossen

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
| Audio-Player | ✅ |
| Responsive Filter-Leiste (flex-wrap) | ✅ |
| ↺ Re-Index-Button mit Bestätigungsdialog | ✅ |
| Schriftart-Auswahl (4 Presets, localStorage) | ✅ |
| Artikel-Navigation per Tastatur & Swipe | ✅ |
| Bild-Vollbild (Expand/Compress, Klick, ESC) | ✅ |
| Navigation (Tastatur/Swipe) im Vollbild-Modus | ✅ |

---

## API-Endpunkte

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/meta` | `{ authors, years, categories }` für Dropdowns |
| `GET` | `/api/articles` | Paginierte Liste; Query: `page`, `limit`, `author`, `year`, `category`, `q` |
| `GET` | `/api/articles/:id` | Einzelartikel mit `bodyHtml` (nur Body, kein Header) |
| `POST` | `/api/reindex` | Neu-Indizierung; antwortet mit `{ ok, articles: N }` |
| `GET` | `/files/*` | Statische Dateien aus `www/` (Bilder, Audio) |

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
- **Keine Persistenz** — der Index lebt nur im RAM. Nach Server-Neustart wird automatisch neu indiziert.
- **Volltextsuche** ist einfaches `Array.filter` + `includes` — ausreichend für ~6.500 Artikel, aber keine Fuzzy-Suche oder Relevanz-Ranking.
- **Parser-Robustheit:** Metadaten-Zeilen werden mit `**`, `_`, `#`-Dekorationen korrekt erkannt; Separator `****` wird gegen `raw.trim()` geprüft (kritisch — `clean` würde `****` zu `''` reduzieren). `_Keyword:_`-Muster erfordern `.trim()` vor dem `_`-Stripping (Reihenfolge: `replace(**) → replace(#) → trim() → replace(_) → trim()`).
- **Vollbild-Navigation:** Swipe-Listener sind sowohl auf `.overlay-panel` als auch auf `#img-fullscreen` registriert, damit Touch-Gesten auch dann erkannt werden, wenn sie auf dem Vollbild-Layer beginnen.

---

## Nächste mögliche Aufgaben

1. **Suche verbessern** — Fuzzy-Matching oder Relevanz-Sortierung (Titel-Treffer höher gewichten)
2. **Async Re-Index** — `buildIndex()` non-blocking mit Fortschritts-Feedback im UI
3. **Dark/Light-Mode-Toggle** — CSS-Variablen sind bereits strukturiert, nur ein `prefers-color-scheme`-Override fehlt
4. **Artikel-Direktlink teilen** — Hash-Routing existiert bereits; ein „Link kopieren"-Button im Detail-Overlay wäre trivial
5. **Mobile Detail-Overlay** — Overlay-Panel auf kleinen Screens als Full-Screen statt schmalem Panel
6. **Zusammenfassung in Kachel-Vorschau** — `summary` statt `preview` anzeigen, wenn vorhanden
7. **Lesezeichen / Favoriten** — clientseitig in localStorage, kein Server-Eingriff nötig
8. **Vollbild-Bildergalerie** — mehrere Bilder pro Artikel (sofern vorhanden) im Vollbild-Modus durchblättern
