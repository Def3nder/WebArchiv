# WebArchiv

Ressourcenschonender **Artikel-Archiv-Viewer** (Node.js/Express + Vanilla-JS-SPA).
Liest Markdown-Artikel samt Bildern/Audio/Video/PDF aus einem `www/`-Verzeichnis,
indexiert sie im Speicher (Volltextsuche, Auto-Kategorisierung) und stellt sie
über eine schlanke Single-Page-App mit Login/Rechteverwaltung bereit. Optional
lassen sich neue Artikel per integriertem Scraper (Blog/Facebook/Telegram)
direkt aus dem Web-UI nachladen.

Deployment-Ziel ist ein kleiner Proxmox-**LXC-Container (Debian)** hinter einem
Reverse Proxy — die Details dazu stehen in `LXC-container node.js Setup.txt`.

---

## Architektur

```
Browser (SPA: public/index.html + app.js + styles.css)
    │  fetch /api/*
    ▼
Express-Server (server.js, CommonJS)
    ├── In-Memory-Index (articles[], Fuse.js)   ← buildIndex() scannt www/
    ├── Auth (express-session + bcryptjs, users.json)
    ├── /files/*  geschützte Datei-Auslieferung (ACL pro Autor)
    ├── /a/*, /og-image/*  Link-Vorschau (Open Graph)
    └── /api/scrape  → spawnt scraper/scrape_all.js (eigener Prozess)
    ▼
Datenablage: www/<Autor>/<Jahr>/<Artikel>.md (+ Bild/Audio/Video/PDF)
```

- **Backend**: ein einzelnes `server.js` (Express 4). CommonJS (`require`), kein Build-Schritt.
- **Frontend**: statische SPA unter `public/` (kein Framework), Hash-Routing (`#/article/<id>`), Cache-Busting per `?v=N`.
- **Daten**: reine Dateien unter `www/` — keine Datenbank. Der Index wird beim Start und auf Anforderung neu aufgebaut.

---

## Inhaltsmodell (`www/`)

Jeder **Top-Level-Ordner in `www/` ist ein „Autor"** (z. B. `Joe Turan`,
`Telegram`, `Facebook`, `Infografiken`, `PDF`, `Stefan Hiene`, `Videos`).
Darunter liegen **Jahresordner** (`2024`, `2025`, …) mit je einer `.md`-Datei
pro Artikel.

```
www/
├── Joe Turan/
│   ├── standard.jpg              ← Fallback-Bild für Artikel ohne eigenes Bild
│   └── 2026/
│       ├── 2026-01-25_titel-slug.md
│       └── 2026-01-25_titel-slug.jpg   ← gleicher Dateiname-Stamm = Artikelbild
├── Telegram/…
└── Facebook/…
```

**Begleitdateien** (gleicher Stamm wie die `.md`): `.jpg`/`.jpeg`/`.png` (Bild),
`.mp3` (Audioquickie), `.mp4` (Video), `.pdf`. Fehlt ein Bild, greift
`www/<Autor>/standard.<ext>`.

**Artikel-ID**: `Autor/<Unterpfad>/<Dateiname-ohne-.md>` (z. B.
`Joe Turan/2026/2026-01-25_titel-slug`).

### Markdown-Format (was der Parser `parseArticle` liest)

```markdown
# Titel des Artikels

*Quelle: https://…*            ← optional, wird als sourceUrl extrahiert

**Datum: 2026-01-25**          ← Datum (ISO oder dd.mm.yyyy), auch ohne ** erkannt

AudioQuickie: 12               ← optional (Episoden-Nummer)
Kategorien: Beziehungen, Trauma & Heilung   ← optional (Anzeige-Tags)
Zusammenfassung: kurzer Teaser …            ← optional (bis zum Trenner)

****                           ← Trenner (>= 4 * oder -), danach beginnt der Body

<Artikeltext in Markdown>
```

- Datum notfalls aus dem Dateinamen-Präfix `YYYY-MM-DD_…`.
- Titel = Zeilen vor „Datum:", ohne die „Quelle:"-Zeile.
- Body = alles nach dem letzten Trenner (bzw. nach der letzten Metazeile) und wird
  mit `marked` zu HTML gerendert.
- **Auto-Kategorien**: `autoCategorize()` ordnet aus Titel+Zusammenfassung+Body
  über eine feste Stichwort-Taxonomie bis zu 5 Kategorien zu (für Filter/Facetten).
  Das Feld `Kategorien:` bleibt davon getrennt als reine Anzeige-Tags.

---

## Suche, Filter, Facetten

- **Volltextsuche** über `Fuse.js` (Felder: Titel×3, Autor×1.5, Kategorien, Auszug).
- **Datums-Tokens** in der Suche werden erkannt und als Filter angewandt
  (`2026`, `2026-03`, `03.2026`, `25.01.2026`) — kombinierbar mit Textsuche
  (z. B. „Achtsamkeit 2025").
- **Filter**: Autor, Jahr, Kategorie, Seitengröße, Ansicht (quadratisch/länglich),
  Schriftart. Paginierung server-seitig.
- **Telegram-Sonderregel**: Artikel des Autors „Telegram" sind standardmäßig
  ausgeblendet (Toggle im Header oder `telegram=1` bzw. Autor-Filter „Telegram").

---

## Authentifizierung & Rechte

- **`users.json`** (nicht eingecheckt): Liste von Nutzern
  ```json
  [{ "email": "a@b.de", "passwordHash": "<bcrypt>", "role": "admin", "allowedAuthors": null }]
  ```
  - `passwordHash`: bcrypt (siehe `scripts/hash-passwords.js`).
  - `role`: `admin` sieht die Admin-Buttons (Reindex ↺, Scrape ⬇) und darf
    `/api/reindex` + `/api/scrape` auslösen.
  - `allowedAuthors`: `null` = alle Autoren; sonst Whitelist von Autor-Ordnern (ACL).
- **Gäste** (ohne Login) bekommen die Rolle `guest` mit den in
  **`public-directories.txt`** gelisteten öffentlichen Autoren:
  ```json
  { "public-directories": ["Videos", "PDF", "Infografiken"] }
  ```
  Sind keine öffentlichen Autoren konfiguriert, ist die App vollständig
  login-pflichtig (401).
- **Sessions** via `express-session` (Cookie 7 Tage, `httpOnly`, `sameSite=lax`);
  Secret über `SESSION_SECRET` (Env) setzen.
- Datei-Auslieferung `/files/*` prüft die Autor-ACL (kein Zugriff auf fremde Autoren,
  Path-Traversal-Schutz).

---

## HTTP-API

| Methode & Pfad | Auth | Zweck |
|---|---|---|
| `GET /api/me` | – | Aktueller (oder Gast-)Nutzer |
| `POST /api/login` | – | Anmeldung `{email,password}` |
| `POST /api/logout` | – | Abmeldung |
| `GET /api/meta` | Soft | Autoren/Jahre/Kategorien (ACL-gefiltert) |
| `GET /api/articles` | Soft | Liste mit `q,author,year,category,page,limit,telegram` |
| `GET /api/articles/*` | Soft | Einzelartikel inkl. gerendertem `bodyHtml` |
| `GET /files/*` | Soft | Geschützte Datei (Bild/Audio/…), ACL pro Autor |
| `GET /a/*` | – | Link-Vorschau: liefert OG-Meta-Tags + Weiterleitung in die SPA |
| `GET /og-image/*` | – | Auf 1200px/JPEG q80 verkleinertes Vorschaubild (gecacht) |
| `GET /api/prompts` · `GET /api/prompts/:file` | Soft | Prompt-Textbausteine aus `prompts/` (Copy-Menü) |
| `GET /api/reindex/status` | Auth | Status des Index-Neuaufbaus |
| `POST /api/reindex` | Admin | Index neu aufbauen (`buildIndex()`) |
| `GET /api/scrape/status` | Auth | Status + Live-Ausgabe des Scrape-Laufs |
| `POST /api/scrape` | Admin | Scraper starten (`{sources?}`), danach Auto-Reindex |

„Soft" = `attachUser`: eingeloggt oder Gast mit Public-Autoren; sonst 401.

**Link-Vorschau**: Crawler (WhatsApp/Signal/Telegram) führen kein JS aus und
ignorieren den `#`-Teil. Daher liefert `/a/<id>` serverseitig OG-Tags und leitet
echte Besucher per Meta-Refresh/JS in die SPA (`#/article/<id>`). Der Server
respektiert `X-Forwarded-Proto/Host` (`trust proxy`) für korrekte absolute URLs
hinter dem Reverse Proxy.

---

## Index (Reindex)

`buildIndex()` scannt `www/` rekursiv, parst alle `.md`, ermittelt Begleitdateien,
Kategorien und baut den Fuse-Index. Läuft **beim Serverstart** und auf
`POST /api/reindex` (Admin). Da der Index im Speicher liegt, werden **neu
hinzugefügte Dateien erst nach einem Reindex sichtbar** (oder nach Neustart).

---

## Scraper-Integration (`scraper/`)

Eigenständiger Node-Scraper (Blog + Facebook + Telegram) in `scraper/` — **eigenes
`package.json` (`type:module`) und eigene `node_modules`**, damit die schweren
Abhängigkeiten (playwright/Chromium) **nicht** in die App-`package.json` wandern.
Er schreibt direkt in die Autoren-Ordner des Archivs:

```
scraper/scrape_all.js  →  ../www/Joe Turan | ../www/Telegram | ../www/Facebook
```

Details/CLI: siehe `scraper/README.md`. Zwei Auslöse-Wege:

1. **CLI**: `cd scraper && node scrape_all.js [--blog|--facebook|--telegram] [--visible]`
2. **Web-UI (Admin)**: Button **⬇** im Header → `POST /api/scrape`. Der Server
   startet `scrape_all.js` als Kindprozess, sammelt dessen Ausgabe in
   `scrapeState.output` und zeigt sie **live in einem Modal** an (endet mit der
   Zusammenfassung `gespeichert=… bereits vorhanden=…`). Nach dem Lauf wird
   automatisch `buildIndex()` (Reindex) angestoßen.

Voraussetzungen für den Scrape: installierte Playwright-Browser + System-Libs und
gesetztes `PLAYWRIGHT_BROWSERS_PATH` (siehe `LXC-container node.js Setup.txt`).
Facebook benötigt `scraper/cookies.txt` (Netscape-Format) und `scraper/Abonenten-URL.txt`.

---

## Projektstruktur

```
server.js                     Express-App (gesamter Backend-Code)
package.json                  Deps: express, express-session, bcryptjs, fuse.js, marked, sharp
public/
├── index.html                SPA-Markup (Header, Overlays: Artikel, Login, Scrape)
├── app.js                    SPA-Logik (Suche, Filter, Detail, Auth, Reindex, Scrape)
├── styles.css                Styles (Light/Dark, Layouts)
└── pdfjs/                    PDF-Anzeige
scripts/hash-passwords.js     bcrypt-Hashes für users.json erzeugen
prompts/*.txt                 Prompt-Bausteine fürs Copy-Menü (Zahl-Präfix = Reihenfolge)
scraper/                      Eigenständiger Scraper (schreibt nach ../www)
www/<Autor>/<Jahr>/           Inhalte (per .gitignore ausgenommen)
download/                     Arbeitsordner (ignored)
users.json                    Nutzer/Rechte (ignored)
public-directories.txt        Öffentliche Autoren für Gäste
LXC-container node.js Setup.txt   Server-/Deployment-Doku
```

Nicht eingecheckt (`.gitignore`): `node_modules/`, `scraper/node_modules/`,
`www/<Autor>/2*` (Jahresinhalte), `download/`, `users.json`,
`scraper/cookies.txt`, `scraper/Abonenten-URL.txt`, Logs.

---

## Setup & Start (lokal)

```bash
npm install

# Nutzer anlegen: Passwort-Hash erzeugen und in users.json eintragen
node scripts/hash-passwords.js

# optional öffentliche Autoren für Gäste festlegen (public-directories.txt)

node server.js            # bzw. npm start  →  http://localhost:3000
```

**Konfiguration (Env):**

| Variable | Default | Zweck |
|---|---|---|
| `PORT` | `3000` | HTTP-Port |
| `SESSION_SECRET` | Dev-Fallback | Signatur der Session-Cookies (in Prod setzen!) |
| `PLAYWRIGHT_BROWSERS_PATH` | – | Chromium-Ablage für den Scraper (siehe Setup-Doku) |

Scraper zusätzlich einrichten:

```bash
cd scraper
npm install
npx playwright install --with-deps chromium
```

---

## Deployment (Debian-LXC, Kurzfassung)

- App unter `/opt/nodeapp`, Start via **systemd** (`nodeapp.service`), betrieben
  als unprivilegierter User `ralf` (`User=ralf`/`Group=ralf`), damit erzeugte
  Dateien `ralf:ralf` gehören. Steuern nur mit `sudo systemctl …`.
- `www/` liegt auf einer eingebundenen externen Disk.
- Reverse Proxy (Caddy/Nginx) für HTTPS ist vorgesehen; der Server ist mit
  `trust proxy` darauf vorbereitet.
- Täglicher Scrape per **cron** möglich (Wrapper-Skript + `PLAYWRIGHT_BROWSERS_PATH`),
  danach Service-Restart für den Reindex.

Alle Schritte, Fehlerbilder und Befehle (systemd, Rechte, Playwright-Systemlibs,
cron, CRLF-Stolperfalle) stehen ausführlich in **`LXC-container node.js Setup.txt`**.
