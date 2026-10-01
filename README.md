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

### Infografiken und Gruppen

Infografiken liegen unter `www/Infografiken/<Jahr>/` mit demselben Dateistamm wie
ihr Artikel (`<Stamm>.png`, Varianten `<Stamm>_2`, `_3` …). Die Endung `_N` gilt nur
als Variante, wenn es den verkürzten Stamm gibt (Stefan Hiene: `…_Audioquickie_2961`
ist ein Name, `…_2961_2` die Variante). Eine Infografik-`.md` ohne Text unter den
Metadaten ist ein **Platzhalter**: Sie wird in den Kachelansichten mit ihrem Artikel
zu **einer Kachel** zusammengefasst (Bilder per Maus/Wischen, Striche ●○○), erbt
dessen Kategorien und Audio. Ohne Artikel ist die Basis-Infografik der Anker; eine
Infografik mit eigenem Text ist selbst ein Original und nimmt ihre Varianten auf.
Die Liste und der Autorenfilter „Infografiken“ zeigen weiter jede Grafik einzeln;
wer den Artikel nicht sehen darf (Gäste), bekommt die Grafik einzeln ohne Text/Audio.
Im Artikel zeigt eine Bildleiste alle Bilder (drei 9:16 nebeneinander, ab vier
wischbar); die Vollansicht blättert durch die Bilder und danach zum Nachbarartikel.
Link auf ein Bild: `#/article/<Artikel-ID>?bild=3`.

**Neue eigenständige Infografik** (Admin, Aktionen → *Neue Infografik*): Dialog mit
Markdown-Vorlage (`# [Titel]`, `Datum: <heute>`, `----`, `[Inhalt]`), Häkchen für die
Filter-Kategorien und Grafikauswahl (PNG/JPG, max. 10 MB); alles wird in einem Schritt
gespeichert als `www/Infografiken/<Jahr>/<Datum>_<titel-slug>.md` + Bild
(Namenskonflikt → `-2`, `-3` …). Angehakte Kategorien fügt der Server beim Speichern
als `Kategorien:`-Zeile nach dem Datum ein; ein unverändertes `[Inhalt]` wird entfernt.
Danach Reindex, die neue Infografik öffnet sich.

**Kategorien-Zeile und Filter:** Steht in `Kategorien:` ein Name der festen
Filter-Kategorien (z. B. „Achtsamkeit“), zählt er für Filter und Suche immer – vor den
automatisch erkannten, höchstens fünf. Andere Einträge bleiben reine Anzeige-Tags.

### Hörbücher (`audio/Hoerbuecher/`)

Je Buch ein Ordner unter `audio/Hoerbuecher/` mit `cover.jpg`/`.png`, nummerierten
Tracks (`.mp3`/`.m4b`/`.m4a`) und optional `abstract.md`
(`Titel:`, `Autor:`, `Datum:`, `Inhalt:` + Markdown). Fallback-Cover:
`audio/Hoerbuecher/standard.png`. Der Ordner heißt bewusst ohne Umlaute, angezeigt
wird „Hörbücher“ (Alternativen: Ordner `Hörbücher` oder `audiobooks.directory` in
`config.json`). Hörbücher sind keine Artikel: Sie erscheinen nur
beim Autorenfilter „Hörbücher“ (Sortierung zuletzt gehört / Name / Datum), sind nie
für Gäste sichtbar und werden über `allowedAuthors` freigegeben. Der Player spielt
das ganze Buch, springt über Dateigrenzen (Weiten in `config.json`) und merkt sich
Position und Tempo pro Nutzer und Buch in `audiobook-progress.json`.

**eBook-Text zum Hörbuch:** Liegt im Buchordner eine Datei mit dem Namen des Ordners und der
Endung `.md`, `.txt` oder `.pdf` (Vorrang in dieser Reihenfolge; z. B. `Autor - Titel/Autor - Titel.md`),
zeigt das Detail den Button *Text lesen*. Er öffnet einen Vollbild-Reiter (Schriftgröße A−/A+ bei
Markdown/Text, PDF im eingebauten Viewer); der Miniplayer bleibt unten sichtbar und führt zurück zum
Detail. Die Leseposition (Scrollanteil bzw. PDF-Seite) wird pro Nutzer und Buch in
`audiobook-progress.json` gemerkt, getrennt vom Hörstand. Text läuft nicht mit dem Audio mit. Interne Verweise (`[…](#kürzel)`) springen zur
passenden Überschrift (Kürzel wie bei GitHub); „↩ Zurück“ kehrt zur Ausgangsstelle zurück. Bilder im Markdown (`![](images/x.jpg)`)
werden angezeigt, wenn sie im Buchordner (auch in Unterordnern) liegen.

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
  [{ "email": "a@b.de", "passwordHash": "<bcrypt>", "role": "admin", "allowedAuthors": null, "mustChangePassword": false }]
  ```
  - `passwordHash`: bcrypt. Erstanlage per `scripts/hash-passwords.js`, danach
    über die **Benutzerverwaltung** in der Oberfläche.
  - `role`: `admin` sieht das Aktions-Menü hinter dem **↺-Button** (Archiv neu
    einlesen, Neue Beiträge scrapen, Scrape-Log, Benutzerverwaltung, Kennwort
    ändern). `user` sieht denselben Button mit **Personen-Icon** und nur
    „Kennwort ändern“.
  - `allowedAuthors`: `null` = alle Autoren; sonst Whitelist von Autor-Ordnern (ACL).
    Öffentliche Autoren kommen für angemeldete Nutzer immer hinzu.
  - `mustChangePassword`: `true` = nach der nächsten Anmeldung muss ein eigenes
    Kennwort gesetzt werden; bis dahin sperrt der Server alle Daten-/Datei-Routen.
  - `sessionVersion` (automatisch): wird bei neuem Kennwort erhöht und beendet
    damit die übrigen Sitzungen des Nutzers.
- **Benutzerverwaltung** (Admin, Aktionen → *Benutzerverwaltung*): Nutzer anzeigen,
  anlegen, Rolle/Autoren ändern, Kennwort neu vergeben (wahlweise mit Pflicht zur
  Änderung), löschen; Reiter *Öffentlicher Zugang* pflegt `public-directories.txt`.
  Rechteänderungen wirken sofort, weil die Session nur E-Mail und `sessionVersion`
  trägt und Rolle/Autoren bei jeder Anfrage frisch aufgelöst werden. Schutzregeln:
  eigene Rolle nicht änderbar, eigener Zugang nicht löschbar, letzter Admin bleibt.
  Kennwörter mindestens 8 Zeichen.
- **Gäste** (ohne Login) bekommen die Rolle `guest` mit den in
  **`public-directories.txt`** gelisteten öffentlichen Autoren:
  ```json
  { "public-directories": ["Videos", "PDF", "Infografiken"] }
  ```
  Sind keine öffentlichen Autoren konfiguriert, ist die App vollständig
  login-pflichtig (401).
- **Schreiben der Dateien** (`user-store.cjs`): temporäre Datei im selben Ordner,
  dann atomar ersetzen; Rechte/Eigentümer bleiben erhalten. Jede Änderung liest die
  Datei vorher frisch ein, Handänderungen gehen also nicht verloren. Wird
  `users.json` bei laufendem Server von Hand bearbeitet (z. B. `hash-passwords.js`),
  gilt der neue Stand für Anmeldungen erst nach der nächsten Änderung über die
  Oberfläche oder einem Neustart. Der Dienstbenutzer braucht Schreibrecht auf
  `users.json`, `public-directories.txt` **und** das App-Verzeichnis.
- **Sessions** via `express-session` (Cookie 7 Tage, `httpOnly`, `sameSite=lax`);
  Secret über `SESSION_SECRET` (Env) setzen. Nach dem Login wird die Session-ID
  neu vergeben.
- Datei-Auslieferung `/files/*` prüft die Autor-ACL (kein Zugriff auf fremde Autoren,
  Path-Traversal-Schutz).

---

## HTTP-API

| Methode & Pfad | Auth | Zweck |
|---|---|---|
| `GET /api/me` | – | Aktueller (oder Gast-)Nutzer |
| `POST /api/login` | – | Anmeldung `{email,password}` |
| `POST /api/logout` | – | Abmeldung |
| `POST /api/me/password` | Auth | Eigenes Kennwort ändern `{currentPassword,newPassword}` |
| `GET /api/users` | Admin | Nutzer (ohne Hashes), alle Autoren, öffentliche Autoren |
| `POST /api/users` | Admin | Nutzer anlegen `{email,role,allowedAuthors,password,mustChangePassword}` |
| `PATCH /api/users/:email` | Admin | Rolle/Autoren/Änderungspflicht ändern |
| `POST /api/users/:email/password` | Admin | Kennwort neu vergeben `{password,mustChangePassword}` |
| `DELETE /api/users/:email` | Admin | Nutzer löschen |
| `PUT /api/public-authors` | Admin | Öffentliche Autoren setzen `{authors:[…]}` |
| `GET /api/meta` | Soft | Autoren/Jahre/Kategorien (ACL-gefiltert) |
| `GET /api/articles` | Soft | Liste mit `q,author,year,category,page,limit,telegram`; `group=1` fasst Artikel + Infografiken zu Kacheln mit `images` zusammen |
| `GET /api/articles/*` | Soft | Einzelartikel inkl. gerendertem `bodyHtml` und `images`; eine gruppierte Infografik liefert ihre Gruppe (`requestedId`) |
| `GET /files/*` | Soft | Geschützte Datei (Bild/Audio/…), ACL pro Autor |
| `GET /a/*` | – | Link-Vorschau: liefert OG-Meta-Tags + Weiterleitung in die SPA |
| `GET /og-image/*` | – | Auf 1200px/JPEG q80 verkleinertes Vorschaubild (gecacht); `?sq=256|512` liefert einen quadratischen Ausschnitt vom oberen Bildteil (Sperrbildschirm) |
| `POST /api/new-infographic` | Admin | Neue Infografik `{markdown, image(base64)}` → `{id}` |
| `GET /api/prompts` · `GET /api/prompts/:file` | Soft | Prompt-Textbausteine aus `prompts/` (Copy-Menü) |
| `GET /api/audiobooks` | Auth + Autor | Hörbücher mit `q,sort(recent/title/date),page,limit` |
| `GET /api/audiobooks/*` | Auth + Autor | Hörbuch mit Tracks, Beschreibung, eigenem Fortschritt |
| `PUT /api/audiobook-progress/*` | Auth + Autor | Hörposition speichern `{trackIndex,position,speed}` |
| `GET /api/audiobook-text/*` | Auth + Autor | eBook-Text (`md`/`txt` als HTML, `pdf` als URL) mit Leseposition |
| `PUT /api/audiobook-text-progress/*` | Auth + Autor | Leseposition speichern `{position}` (Anteil 0–1, bei PDF Seitenzahl) |
| `GET /api/reindex/status` | Auth | Status des Index-Neuaufbaus |
| `POST /api/reindex` | Admin | Index neu aufbauen (`buildIndex()`) |
| `GET /api/scrape/status` | Auth | Status + Live-Ausgabe des Scrape-Laufs |
| `POST /api/scrape` | Admin | Scraper starten (`{sources?}`), danach Auto-Reindex |
| `GET /api/scrape/log` | Admin | Letzte 100 Zeilen von `scraper/scrape_all.log` |

„Soft" = `attachUser`: eingeloggt oder Gast mit Public-Autoren; sonst 401.

**Link-Vorschau**: Crawler (WhatsApp/Signal/Telegram) führen kein JS aus und
ignorieren den `#`-Teil. Daher liefert `/a/<id>` serverseitig OG-Tags und leitet
echte Besucher per Meta-Refresh/JS in die SPA (`#/article/<id>`). Der Server
respektiert `X-Forwarded-Proto/Host` (`trust proxy`) für korrekte absolute URLs
hinter dem Reverse Proxy.

---

## Index (Reindex)

`buildIndex()` scannt `www/` rekursiv, parst alle `.md`, ermittelt Begleitdateien,
Kategorien und baut den Fuse-Index. Läuft **beim Serverstart**, auf
`POST /api/reindex` (Admin) und bei **`SIGHUP`** (für Cron/Automation ohne
Neustart — offene Sessions bleiben erhalten). Da der Index im Speicher liegt,
werden **neu hinzugefügte Dateien erst nach einem Reindex sichtbar**.

Wichtig: `scraper/scrape_all.js` triggert selbst **keinen** Reindex. Es schreibt
nur neue Dateien. Den Reindex stößt entweder `server.js` nach einem Web-UI-Scrape
an, oder ein CLI/Cron-Aufruf muss danach den laufenden Server per `SIGHUP`
signalisieren.

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
2. **Web-UI (Admin)**: Aktions-Menü hinter dem **↺-Button** im Header mit drei
   Einträgen — *Archiv neu einlesen* (`POST /api/reindex`), *Neue Beiträge scrapen*
   (`POST /api/scrape`) und *Scrape-Log anzeigen* (`GET /api/scrape/log`). Beim
   Scrapen startet der Server `scrape_all.js` als Kindprozess, sammelt dessen
   Ausgabe in `scrapeState.output` und zeigt sie **live in einem Modal** an (endet
   mit der Zusammenfassung `gespeichert=… bereits vorhanden=…`); danach wird
   automatisch `buildIndex()` (Reindex) angestoßen. *Scrape-Log anzeigen* öffnet
   dasselbe Modal mit den letzten 100 Log-Zeilen, bereits ans untere Ende gescrollt.

Beim CLI-/Cron-Aufruf führt `scrape_all.js` dagegen nur den Scrape aus; der
Reindex muss anschließend außerhalb des Scrapers ausgelöst werden. Dafür **kein
`systemctl restart nodeapp` verwenden**, weil ein harter Neustart laufende
Requests, Sessions und einen eventuell gerade laufenden Reindex unterbrechen
kann. Stattdessen den vorhandenen `SIGHUP`-Handler nutzen (siehe Cron-Beispiel
unten).

Voraussetzungen für den Scrape: installierte Playwright-Browser + System-Libs und
gesetztes `PLAYWRIGHT_BROWSERS_PATH` (siehe `LXC-container node.js Setup.txt`).
Facebook benötigt `scraper/cookies.txt` (Netscape-Format) und `scraper/Abonenten-URL.txt`.

---

## Projektstruktur

```
server.js                     Express-App (Routen, Index, Auth-Anbindung)
user-store.cjs                Nutzer & öffentliche Autoren: Lesen/Schreiben, Regeln, Routen
audiobooks.cjs                Hörbücher: Index, abstract.md, Hörfortschritt, Routen
config.json                   Einstellungen (Hörbuch-Sprungweiten)
package.json                  Deps: express, express-session, bcryptjs, fuse.js, marked, sharp
public/
├── index.html                SPA-Markup (Header, Overlays: Artikel, Login, Scrape)
├── app.js                    SPA-Logik (Suche, Filter, Detail, Auth, Aktionen-Menü: Reindex/Scrape/Log)
├── user-admin.js             Kennwort ändern, Benutzerverwaltung, Öffentlicher Zugang
├── audiobooks.js             Hörbuch-Liste, -Detail, Player und Miniplayer
├── book-reader.js            eBook-Text zum Hörbuch (Vollbild-Reiter, Leseposition)
├── favicon.svg               Favicon (Bücherregal, Gold auf Dunkel) – Vorlage für die beiden folgenden
├── favicon.ico               16/32/48 px (PNG-Einträge), aus favicon.svg erzeugt
├── apple-touch-icon.png      180 px ohne Eckenradius für den iOS-Homescreen
├── styles.css                Styles (Light/Dark, Layouts)
└── pdfjs/                    PDF-Anzeige
scripts/hash-passwords.js     bcrypt-Hashes für users.json erzeugen
scripts/make-favicons.js      favicon.ico + apple-touch-icon.png aus public/favicon.svg erzeugen
scripts/strip-infographic-categories.js  „Kategorien:“ aus Infografik-.md entfernen (--dry-run, Sicherung)
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
| `USERS_FILE` | `./users.json` | Abweichender Pfad der Nutzerdatei (z. B. für Tests) |
| `PUBLIC_DIRS_FILE` | `./public-directories.txt` | Abweichender Pfad der Liste öffentlicher Autoren |
| `AUDIOBOOK_PROGRESS_FILE` | `./audiobook-progress.json` | Abweichender Pfad des Hörfortschritts |
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
- **Serverdienst steuern**:
  ```bash
  sudo systemctl restart nodeapp          # nach Codeänderungen neu starten
  sudo systemctl status nodeapp           # Dienststatus prüfen
  journalctl -u nodeapp -n 100 --no-pager # letzte Logzeilen anzeigen
  ```
- **Reindex ohne Neustart**: der Server hat einen `SIGHUP`-Handler, der
  `buildIndex()` auslöst, ohne den Prozess zu beenden — offene Sessions bleiben
  erhalten. Auslösen (als `ralf`, ohne sudo):
  `kill -HUP "$(systemctl show -p MainPID --value nodeapp)"`.
- Täglicher Scrape **und** Reindex per **cron** (als `ralf`) — siehe unten.

### Täglicher Scrape per Cron

Wrapper `/opt/nodeapp/scraper/run-scrape.sh` (als `ralf`, danach `chmod +x`):

```bash
#!/usr/bin/env bash
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
cd /opt/nodeapp/scraper
/usr/bin/node scrape_all.js >> /opt/nodeapp/scraper/cron-scrape.log 2>&1
echo "$(date '+%F %T') Scraper exit $?" >> /opt/nodeapp/scraper/cron-scrape.log

# Reindex OHNE Neustart (Sessions bleiben erhalten): SIGHUP an den Node-Prozess.
# Nicht "systemctl restart nodeapp" verwenden; der Restart kann laufende Requests
# oder einen parallel gestarteten Reindex abbrechen.
PID=$(systemctl show -p MainPID --value nodeapp)
[ "${PID:-0}" -gt 0 ] && kill -HUP "$PID"
```

Crontab von `ralf` (`crontab -e`), täglich 04:30 (Server läuft auf **UTC**):

```cron
30 4 * * * /opt/nodeapp/scraper/run-scrape.sh
```

Kein `sudo`/Passwort nötig: Dienst und Cron laufen beide als `ralf`,
`systemctl show -p MainPID` ist eine reine Leseabfrage, und `ralf` darf den
eigenen Prozess signalisieren. Kein `set -e` im Wrapper — bei Teil-Fehlern (z. B.
abgelaufene FB-Cookies) endet der Scraper mit Exit 1, die übrigen Quellen sind
trotzdem gespeichert und werden indexiert. Nur bestimmte Quellen: Flags anhängen
(`--blog --telegram`).

Alle Schritte, Fehlerbilder und Befehle (systemd, Rechte, Playwright-Systemlibs,
`SIGHUP`-Reindex, cron, CRLF-Stolperfalle) stehen ausführlich in
**`LXC-container node.js Setup.txt`**.
