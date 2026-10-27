Mein Vorgehen:

1. **Bestandsaufnahme:** Dateien, Größen und Struktur erfassen (graft map, Zeilenzahlen).
2. **Backend:** `server.js` und die `*.cjs`-Module über die Skeletons prüfen, auffällige Stellen gezielt lesen.
3. **Frontend:** `public/*.js`, also app.js, Dialoge, Menüs und Fetch-Logik.
4. **Querschnitt:** wiederkehrende Muster per grep vergleichen (Atomic Write, Pfadprüfung, Rechte, Dialoge, Fetch).
5. **Unterpakete:** Scraper, tts und epub-tool überfliegen, dazu Tests und Skripte.
6. **Bericht:** die Ergebnisse strukturiert zusammenfassen. Ich ändere dabei nichts.

Ich bin mitten im Backend-Review und lese jetzt den Routen-Teil von `server.js`.

Ich bin bei der Querschnittsanalyse und suche gerade nach Code, der mehrfach kopiert wurde.

Ich bin im Frontend-Teil und prüfe jetzt Cache-Busting, Script-Reihenfolge und globale Variablen.

Ich prüfe jetzt Unterpakete und das Repo selbst, also Ignore-Regeln und Datendateien.

# Code-Review WebArchiv

Ich habe Backend, Frontend, Unterpakete, Tests und Skripte durchgesehen und **nichts geändert**. Die Kernbereiche habe ich direkt gelesen, die übrigen über Skeletons und gezielte Suchen.

**Gesamteindruck:** Das Projekt ist solide. Die Leitideen sind klar (Dateien als Datenbank, Rechte pro Autor, atomares Schreiben, Teil-Reindex, sauberer Rückbau bei Fehlern), die Kommentare sind gut und es gibt viele Tests. Das Hauptproblem ist Wachstum ohne Aufräumen: Dieselben Muster sind oft mehrfach von Hand umgesetzt, und `server.js` und `app.js` sind zu großen Sammeldateien geworden.

---

## 1. Werden die Konzepte durchgängig verwendet?

| Konzept | Stand |
|---|---|
| **Gemeinsames ARIA-Menü** (laut README „zentral pflegen“) | ❌ Es gibt mindestens fünf eigene Umsetzungen: Filtermenüs in `app.js`, Kopiermenü in `renderDetail`, Admin-Menü (`closeAdminMenu`/`onAdminOutside`), eigene Filtermenüs in `duplicates.js` und ein eigenes Stimmenmenü in `tts-settings.js`. Dazu kommt eigene Positionierungslogik in [audiobooks.js:211](public/audiobooks.js:211) und [app.js:1913](public/app.js:1913). |
| **Admin-Code nur für Admins ausliefern** | ⚠️ Gilt nur teilweise. Die TTS-Dialoge, `runReindex`, `runScrape` und der Prüfmodus für Infografiken liegen in `app.js` und werden damit auch an Gäste ausgeliefert ([app.js:3095–3540](public/app.js:3095)). Das ist kein Sicherheitsloch, weil der Server prüft, verfehlt aber das Ziel aus der To-do-Liste. |
| **Zentraler Schutz der Admin-Routen** (`requireAdminAccess`) | ⚠️ Er ist eingeführt, aber in sieben Routen wird `sec-fetch-site` zusätzlich noch einmal von Hand geprüft. Auch die `.cjs`-Module prüfen das jeweils selbst. |
| **Pfadschutz** | ⚠️ Drei Varianten: `isPathInside`, `resolveUnder` und mehrfach direkt `startsWith(ROOT + sep)` ([server.js:1922](server.js:1922), [:1945](server.js:1945), [:2155](server.js:2155)). Außerdem ist `canAccessMedia` mit doppeltem `decodeURIComponent` riskant, weil Express die Pfade bereits dekodiert. |
| **Fehlerbehandlung in den Routen** | ⚠️ Fünf fast gleiche `route()`-Hüllen. Die TTS-Hülle schickt bei Status 500 die interne Fehlermeldung an den Client, die anderen zeigen eine allgemeine Meldung. |
| **Ein Format für API-Fehler** | ⚠️ Deutsch und Englisch gemischt (`'Not authenticated'`, `'Admin only'`). `apiFetch` erkennt den Ablauf einer Admin-Sitzung am **Text** `'Admin only'` ([app.js:1004](public/app.js:1004)). Ein stabiler Fehlercode wäre robuster. |
| **Aufbau der Browser-Skripte** | ⚠️ Drei Arten nebeneinander: klassische Skripte mit vielen globalen Variablen (`app.js` hat über 300 Top-Level-Deklarationen, die `audiobooks.js` und andere mitbenutzen), gekapselte Module (`grid-density`, `page-swipe`, `session-state`) und ES-Module nur im Editor-Bundle. |
| **Vorrang von Audio** | ⚠️ README und Session.MD widersprechen sich: Abschnitt 1 der Session.MD sagt „MP3 neben der .md hat Vorrang“, ein anderer Absatz nennt eine andere Suchreihenfolge. Der Code macht „lokal zuerst“, das passt zu Abschnitt 1. |

## 2. Was sich zentralisieren oder modularisieren lässt

1. **`server.js` aufteilen (rund 2.900 Zeilen).** `scripts/migrate-infographic-names.js` lädt `require('../server.js')` und löst damit alle Nebenwirkungen aus: `users.json` laden, Stores anlegen, Konsolenausgaben. Vorschlag:
   - `lib/article-parser.cjs`: `parseArticle`, `normalizeDate`, `extractDate`, Taxonomie
   - `lib/infographics.cjs`: Stamm-Auflösung, `linkInfographics`, Benennung und Umbenennen
   - `lib/article-index.cjs`: Scan, Veröffentlichen, Teil-Refresh
   - `lib/http.cjs`: `fail`, `route()`, Pfadschutz, Same-Origin-Prüfung
   - Routen nach Bereich, so wie es `user-store.cjs` und `bookmarks.cjs` schon vormachen
2. **Kopierte Logik zusammenführen:**
   - `normalizeDate`/`extractDate` stehen in `server.js`, `audiobooks.cjs` und `duplicates-tool/lib/article.cjs`.
   - `duplicates-tool/` enthält Kopien von `duplicate-diff.js` (nur 28 abweichende Zeilen), der Dublettenerkennung und des Parsers. Beides kann aus einem gemeinsamen Ordner `lib/` kommen.
   - `escapeHtml` gibt es dreimal, `slugify` zweimal, und es gibt sieben eigene Umsetzungen für atomares Schreiben (`article-editor`, `audiobooks.atomicWrite`, `user-store.writeJsonAtomic`, `voice-settings.atomicJson`, zwei Skripte, `moveInfographicFiles`).
3. **Ein gemeinsamer JSON-Speicher.** Hörfortschritt, Lesezeichen, Dubletten-Entscheidungen und TTS-Einstellungen folgen alle dem Muster „load → Warteschlange → `writeJsonAtomic`“. Eine Funktion `createJsonStore({ file, mode })` würde das vereinheitlichen. Nebenbei: `bookmarks.cjs` holt `writeJsonAtomic` ausgerechnet aus `user-store.cjs`.
4. **Eine zentrale Sperre für Schreibvorgänge.** Die Prüfung `reindexState.running || scrapeState.running || infographicWrites || markdownEditor.running || ttsJobs.running` steht etwa 16-mal in leicht unterschiedlicher Form im Code. `infographicWrites` dient inzwischen als allgemeine Sperre, auch für Dubletten. Besser wäre ein `archiveLock.tryAcquire(name)` mit einer Meldung, *was* gerade läuft.
5. **Gemeinsame Hilfe für den Reindex-Status.** Das `try { reindexState = running… } catch { reindexState = error… }` steht viermal im Code, eine Funktion `withReindexState(label, fn)` würde reichen. Auch das Ermitteln des Jahres aus dem Pfad ist doppelt.
6. **`app.js` aufteilen (rund 4.150 Zeilen).** Kandidaten: ARIA-Menü als eigene Komponente, Detailansicht samt Kopiermenü (`renderDetail` allein hat etwa 300 Zeilen), Vollbild-Galerie, Audio/Media Session, Kachel-Layout und Gesten, Admin-Teil (TTS, Scrape, Reindex, Prüfmodus) als Admin-Skript. Vorbild sind `grid-density.js` und `page-swipe.js`: reine, testbare Logik.
7. **`createAudiobookLibrary` aufteilen (eine Closure mit rund 670 Zeilen).** Die Extras-Verwaltung als eigenes Modul auslagern.

## 3. Was umständlich gelöst ist

- **Medien-Suche beim Scannen ([server.js:531–535](server.js:531)).** Für jeden Artikel ohne lokale MP3 läuft `findSibling(externalAudioDir, …)` **ohne** Verzeichnis-Cache. Das heißt `existsSync` plus `readdirSync` des Audio-Ordners pro Artikel, bei über 5.600 Artikeln tausende synchrone Verzeichnis-Lesungen. Ein Cache pro Ordner und Scan würde das beheben. Dasselbe gilt für den Fallback auf `standard.jpg`.
- **Synchrone Dateizugriffe in Anfragen.** `renderIndexForSession` liest `index.html` bei jedem Aufruf. `computeAppShellVersion` liest bei **jedem** Abruf von `/service-worker.js` alle Dateien in `public/` (über 300 KB) synchron und hasht sie. Die Detailansicht liest, parst und rendert die Markdown-Datei bei jedem Öffnen. Ein Cache nach Änderungszeit wäre billig.
- **Fehlerbehandlung über Namen hinweg.** `duplicateFail` wird auch für Infografik-Fehler benutzt (41-mal).
- **Allgemeiner Fehler-Handler ([server.js:2899](server.js:2899)).** Jedes `entity.too.large` außerhalb der Sonderpfade meldet „Bilddatei größer als 10 MB“, auch bei normalem JSON.
- **`/files/*`** prüft den Papierkorb zweimal, einmal über Pfadsegmente und einmal über den normalisierten Pfad.
- **Manuelle `?v=`-Versionen** an etwa 15 Tags in `index.html`. Der Server rendert `index.html` ohnehin als Vorlage und berechnet bereits Hashes für den Service Worker. Er könnte `?v=<hash>` automatisch einsetzen, dann entfällt eine ganze Fehlerklasse.

## 4. Konkrete Verbesserungen, nach Wichtigkeit

**Sicherheit**
1. **Gerendertes HTML wird nicht bereinigt.** `marked.parse` bereinigt nicht, und `bodyHtml` landet per `innerHTML` in der Seite ([app.js:1876](public/app.js:1876)). Die Inhalte stammen auch von Facebook und Telegram über Turndown. Dagegen helfen `sanitize-html` oder DOMPurify auf dem Server (auch für eBook- und Extras-HTML) und zusätzlich eine Content-Security-Policy. Dafür müssten aber die Inline-Handler wie `onerror="handleImgError(this)"` weg.
2. **Kein Schutz gegen Brute-Force-Logins.** Ein einfacher Zähler pro IP und E-Mail im Speicher genügt schon.
3. **`SESSION_SECRET` fällt still auf den Entwicklungswert zurück.** Bei `NODE_ENV=production` sollte der Server ohne gesetztes Secret nicht starten. Außerdem wäre ein Cookie mit `secure` hinter HTTPS sinnvoll.
4. **Interne Fehlermeldungen in TTS-Routen.** Die TTS-Routen geben interne Fehlertexte bei Status 500 an den Client weiter.

**Fehler und Randfälle**
5. **`/api/articles?page=abc` bzw. `limit=abc`** ergeben `NaN` und damit eine leere Seite, weil `Math.max(1, NaN)` wieder `NaN` ist ([server.js:2811](server.js:2811)). `audiobooks.cjs` macht es richtig mit `|| 1`.
6. **Fuse-Suche mit `limit: 2000`, erst danach greift der Filter.** Bei sehr allgemeinen Begriffen kann ein Treffer des gewählten Autors herausfallen.
7. **`SIGHUP` wird bei laufendem Auftrag still ignoriert.** Es fehlt sogar ein Log-Eintrag.
8. **Stores ändern zuerst den Speicher, dann die Datei.** Scheitert das Schreiben, weichen Speicher und Datei voneinander ab, ohne dass etwas zurückgerollt wird.

**Betrieb**
9. **Sessions liegen im RAM (`MemoryStore`).** Jeder Neustart meldet alle ab. Ein Datei-Store (z. B. `session-file-store`) würde das beheben, ganz ohne Datenbank.
10. **`config.json` und `public-directories.txt` sind eingecheckt, werden aber zur Laufzeit beschrieben.** Ein Deployment kann sie überschreiben. Besser wäre eine `*.example`-Datei im Git und die echte Datei in `.gitignore`.
11. **`duplicates-tool/`-Tests laufen nicht in `npm test`** mit.

## 5. Was mir sonst auffällt

- **Commit-Nachricht und Code passen nicht zusammen.** `bfc6641` spricht von „Re-Indexierung in einem Web Worker“, im Code gibt es aber weder `worker_threads` noch `new Worker`. Entweder ist die Nachricht ungenau oder ein Teil der Arbeit fehlt.
- **Session.MD ist widersprüchlich:**
  - Abschnitt 13, Punkt 1 (Cron-Wrapper) ist laut Abschnitt 10 erledigt.
  - Mehrfach steht „Qwen v4“, der Code verlangt `webarchiv-qwen-v5`.
  - Der Abschnitt zur Audio-Reihenfolge widerspricht sich (siehe Punkt 1).
- **Private Hörbücher und die Sortierung „added“** sind umgesetzt, aber weder im README noch in Session.MD dokumentiert. Die Privat-Markierung liegt fachlich unpassend in `audiobook-progress.json`, gemischt mit Nutzerdaten.
- **Der Scraper ist auf eine Quelle zugeschnitten.** Er ist aus Python portiert (`splitlines`, `stripChars`, `_emit`), `CHANNEL_DISPLAY_NAME = "Joe Turan"` und `joeturan.com` sind fest eingetragen, obwohl die Konfiguration mehrere Quellen erlaubt. `scrapeFacebook` hat etwa 200 Zeilen.
- **Fester Autorname.** `'Telegram'` steht als Text an mehreren Stellen, statt als Konstante wie `INFOGRAPHICS_AUTHOR`.
- **`styles.css` hat rund 3.800 Zeilen in einer Datei.** Eine Aufteilung nach Bereichen oder zumindest eine konsequente Gliederung würde helfen.

## 6. Ideen

- **Automatisches Cache-Busting** über den Inhalts-Hash beim Rendern von `index.html` (siehe Punkt 3).
- **Qualitäts-Dashboard** (steht schon auf der To-do-Liste). Viele Daten fallen beim Scannen ohnehin an: fehlendes Datum, Fallback auf `standard.jpg`, unlesbare Dateien (werden derzeit **still verworfen**, [server.js:589](server.js:589)), verwaiste Medien, mehrdeutige Infografik-Zuordnungen, unaufgelöste eBook-Bilder.
- **Datei-Watcher** (`fs.watch` mit Debounce) für `www/` könnte den Teil-Reindex automatisch auslösen, statt `SIGHUP`/Cron.
- **Persistenter Index-Cache** (JSON mit Änderungszeit pro Datei) für schnellere Starts: Nur geänderte Dateien neu parsen.
- **Volltextsuche über den Body** mit einem leichten Index wie MiniSearch, optional zuschaltbar, weil der Body bewusst nicht in Fuse liegt.
- **Health-Endpunkt** `/api/health` für den Betrieb: Indexstatus, Anzahl der Artikel, Erreichbarkeit von Qwen, freier Speicher.
- **Linter einführen** (ESLint mit wenigen Regeln, z. B. `no-undef`, `no-unused-vars`). Bei den vielen globalen Skripten würde das echte Fehler finden.
- **Hörbuch-Ideen** aus der To-do-Liste: Einschlaf-Timer, Gesamtdauer per ffprobe beim Scan.

## Vorschlag für die Reihenfolge

1. Sicherheit: Sanitizing, Login-Limit, Secret-Pflicht. Das ist klein und wirkt viel.
2. Fehler bei `page`/`limit` und die Medien-Suche mit Verzeichnis-Cache.
3. Reine Logik aus `server.js` nach `lib/` auslagern, gemeinsam genutzt von Skripten und `duplicates-tool`.
4. Gemeinsame ARIA-Menü-Komponente und Admin-Code aus `app.js` herauslösen.
5. Session.MD und README bereinigen.


----

Ich erfasse noch, was für eine CSP im Weg steht (PDF.js, CodeMirror, Inline-Teile) und schreibe danach den Plan.

# Plan: Sicherheitspunkte (noch nichts umgesetzt)

## Bestandsaufnahme

- **Markdown wird an fünf Stellen ungefiltert zu HTML.** Artikel-Detail ([server.js:2859](server.js:2859)), Dublettenvergleich ([server.js:2607](server.js:2607)), Hörbuch-Abstract, eBook-Text und Extras ([audiobooks.cjs:347](audiobooks.cjs:347), [:438](audiobooks.cjs:438), [:461](audiobooks.cjs:461)). Zusätzlich das separate `duplicates-tool`.
- **Welches HTML im Bestand tatsächlich vorkommt:** `<a id>` (4.836×, Sprungziele der eBooks), `<sup>`, `<sub>`, `<br>`, `<em>`, `<strong>`, `<p>` und vereinzelt `<div>`. Keine Skripte, Iframes oder Event-Attribute.
- **Pseudo-Tags im eBook „Claude AI für Profis 2026“:** Es enthält Tags wie `<kontext>`, `<rolle>` und `<task>`. Der Browser hält sie heute für HTML, sie sind deshalb **unsichtbar**.
- **Zusätzlicher Fund:** `extractSourceUrl` übernimmt bei `Quelle: [x](…)` jedes Schema. Ein `javascript:`-Link würde als anklickbare Quelle angezeigt ([server.js:285](server.js:285) → [app.js:1858](public/app.js:1858)).
- **Login:** Es gibt keine Begrenzung. Der Client zeigt `data.error` bereits an, eine 429-Meldung braucht also keine Änderung im Frontend.
- **Proxy:** `trust proxy` steht fest auf `true`. Laut LXC-Doku ist der Reverse Proxy „später“ geplant. Ohne Proxy können Clients ihre IP über `X-Forwarded-For` fälschen.
- **Was einer CSP heute im Weg steht:**
  - 5 Inline-Handler `onerror="handleImgError(this)"`
  - das Inline-Script der Seite `/a/*`
  - `style=`-Attribute in Templates
  - CodeMirror erzeugt `<style>`-Elemente
  - PDF.js lädt WASM (JBIG2/OpenJPEG)
  - Google Fonts
  - `blob:`- und `data:`-URLs (Vorschau neuer Infografiken, Sprachaufnahme, Sperrbildschirm-Bild)

---

## 1. `SESSION_SECRET` als Pflicht (kleinster Schritt, zuerst)

- **Neue Funktion `resolveSessionSecret()` in [server.js](server.js):**
  - Mit `NODE_ENV=production` und ohne oder mit zu kurzem Secret (unter 32 Zeichen) startet der Server nicht und nennt den Grund.
  - Ohne `production` gibt es ein zufälliges Secret pro Prozess und eine Warnung. Der feste Entwicklungswert entfällt.
  - Die Prüfung läuft nur beim echten Start, nicht beim `require` in Tests oder Skripten.
- **Cookie:** `secure: 'auto'` setzen, damit es hinter HTTPS automatisch sicher ist.
- **Deployment:** eigene Datei `/etc/nodeapp/webarchiv.env` (root, Modus 600) mit `SESSION_SECRET=$(openssl rand -hex 32)` und einem zusätzlichen `EnvironmentFile=` in der Unit. Folge: Alle Nutzer werden einmalig abgemeldet.
- **Tests:** Fall „production ohne Secret“ führt zum Abbruch, Fall „Entwicklung“ zu Zufallswert und Warnung.

## 2. Login-Begrenzung

- **Neues Modul `login-limiter.cjs`** im Speicher, ohne neue Abhängigkeit:
  - **pro E-Mail:** 5 Fehlversuche in 15 Minuten, dann 15 Minuten Sperre
  - **pro IP:** 30 Fehlversuche in 15 Minuten
  - Erfolgreiche Anmeldung setzt den Zähler der E-Mail zurück.
  - Die Map wird regelmäßig bereinigt und ist in der Größe begrenzt.
- **Antwort bei Sperre:** `429` mit `Retry-After` und dem Text „Zu viele Anmeldeversuche. Bitte in X Minuten erneut versuchen.“ Die Sperre greift **vor** `bcrypt`, das spart Rechenzeit. Die Meldung verrät nicht, ob die E-Mail existiert.
- **Auch für `POST /api/me/password`:** Die Prüfung des aktuellen Kennworts bekommt dieselbe Sperre ([user-store.cjs](user-store.cjs)).
- **`trust proxy` konfigurierbar:** Über `TRUST_PROXY` statt fest `true`, Standard `loopback`. Das wirkt auch auf `req.protocol` (Open-Graph-URLs und Origin-Prüfung). Deshalb hängt es von Entscheidung A ab.
- **Tests:** 429 nach N Versuchen, Zurücksetzen bei Erfolg, getrennte Zähler, `Retry-After`, Kennwortänderung.

## 3. HTML-Bereinigung

- **Neue Abhängigkeit `sanitize-html`** (schlank, ohne jsdom) in einem gemeinsamen Modul `html-sanitizer.cjs` mit einer Funktion `renderSafeMarkdown(text)`. Sie ersetzt alle fünf Render-Stellen. `audiobooks.cjs` bekommt sie über das schon vorhandene `renderMarkdown` injiziert.
- **Erlaubt:** übliche Markdown-Tags (Überschriften, Absätze, Listen, Tabellen, Code, Zitat, `hr`, `img`, `a`) sowie `sup`, `sub`, `br`, `span` und `div`.
- **Erlaubte Attribute:**
  - `id` an `a`, Überschriften und `sup` (für die eBook-Sprunglinks)
  - `href` nur mit `http`, `https`, `mailto`, relativen Pfaden und `#…`
  - `src` nur mit `http`, `https` und relativen Pfaden
  - `alt`, `title`; Tabellen-`align`
- **Entfernt:** `script`, `style`, `iframe`, `object`, alle `on*`-Attribute, `javascript:` und `data:` in Links.
- **Reihenfolge beim eBook:** erst `rewriteEbookImages`, dann bereinigen. Der vorhandene Cache nach Änderungszeit bleibt, dadurch wird ein großes eBook nur einmal bereinigt.
- **`sourceUrl`:** Der Server lässt nur `http`/`https` zu, sonst `null`.
- **`duplicates-tool`:** dieselbe Bereinigung (lokales Werkzeug, daher zuletzt).
- **Tests:**
  - Schadcode wird entfernt: `<script>`, `<img onerror>`, `javascript:`-Link, `<iframe>`
  - Bestand bleibt erhalten: `<a id>`/`<sup>`-Sprünge, Tabellen, Bilder unter `/audio-files`
  - Pseudo-Tags werden behandelt, siehe Entscheidung B
- **Gegenprobe am echten Bestand:** Ein Skript rendert alle `.md` vor und nach der Änderung und meldet jede Abweichung.

## 4. Content-Security-Policy

- **Vorarbeit im Frontend:**
  - Die 5 `onerror`-Handler ersetze ich durch einen zentralen `error`-Listener in der Capture-Phase für `img[data-fallback]` ([app.js](public/app.js), [audiobooks.js](public/audiobooks.js)).
  - Die Seite `/a/*` bekommt eine Nonce für ihr Inline-Script, der Meta-Refresh bleibt als Rückfall.
- **Middleware ohne `helmet`**, mit dieser Richtlinie:
  ```
  default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:;
  connect-src 'self'; frame-src 'self'; worker-src 'self'; object-src 'none';
  base-uri 'self'; form-action 'self'; frame-ancestors 'self'
  ```
  `'unsafe-inline'` bleibt bewusst **nur bei Styles** (wegen `style=`-Attributen und CodeMirror). Skripte sind strikt, und genau dort liegt der eigentliche Schutz gegen XSS.
- **PDF.js** (`/vendor/pdfjs/*`) bekommt eine eigene, gelockerte Richtlinie mit `'wasm-unsafe-eval'`.
- **Weitere Header:** `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: microphone=(self), camera=(), geolocation=()`.
- **Einführung in zwei Stufen:**
  1. Erst `Content-Security-Policy-Report-Only` mit `POST /api/csp-report`, das Verstöße ins Dienstprotokoll schreibt (begrenzt).
  2. Nach Prüfung auf echten Geräten scharf schalten, über eine Umgebungsvariable `CSP_MODE=report|enforce`.
- **Browserprüfung im Testserver, alle Bereiche ohne CSP-Meldungen in der Konsole:**
  - Kacheln, Artikel-Detail mit Audio, Video und PDF
  - eBook als Markdown und als PDF
  - Markdown-Editor und Extras
  - TTS-Dialog mit Aufnahme
  - Dublettenvergleich
  - neue Infografik mit Vorschau
  - Vollbild und Teilen
  - PWA-Update
  - Seite `/a/…`

---

## Reihenfolge, Dateien, Deployment

| Schritt | Dateien | Neustart / Deployment |
|---|---|---|
| 1. Secret | `server.js`, Test, README/LXC-Doku | Env-Datei anlegen, `daemon-reload`, Neustart |
| 2. Login-Begrenzung | `login-limiter.cjs` (neu), `server.js`, `user-store.cjs`, Tests | Neustart |
| 3. Bereinigung | `html-sanitizer.cjs` (neu), `server.js`, `audiobooks.cjs`, `package.json`, Tests | `npm ci`, Neustart |
| 4. CSP | `server.js`, `app.js`, `audiobooks.js`, `index.html` (`?v=`), Tests | Neustart; erst Report-Only, später scharf |

Danach README, Session.MD und `CLAUDE.md` mit Datum aktualisieren. Geprüft wird mit `npm test` und der Browserprüfung aus Schritt 4.

## Offene Entscheidungen (in Klammern mein Vorschlag)

- **A – Reverse Proxy:** Läuft vor dem Server bereits Caddy/Nginx, und wenn ja, im selben LXC oder auf einem anderen Rechner? Davon hängen `TRUST_PROXY` und das sichere Cookie ab. *(Standard: `loopback`. Läuft der Proxy woanders, trage ich dessen IP ein.)*
  - Reverse Proxy unter 192.168.1.14
- **B – Pseudo-Tags wie `<kontext>`:** als Text sichtbar machen oder weiter verbergen? *(Sichtbar machen. Heute fehlt dieser Text im eBook still.)*
  - ja: sichtbar machen
- **C – Google Fonts:** weiter extern laden oder lokal unter `public/fonts/` ablegen? *(Lokal ablegen. Das ist datenschutzfreundlicher und macht die CSP strenger; liefe aber als eigener kleiner Schritt.)*
  - weiterhin extern laden
- **D – Neue Abhängigkeit `sanitize-html`:** einverstanden? *(Ja. Selbst gebaut wäre fehleranfälliger.)*
  - ja: sanitize-html verwenden


----

# Weitere offene Punkte aus dem Review (Auswahl)
- Sessions liegen weiter im RAM (MemoryStore), ein Neustart meldet alle ab.
- config.json und public-directories.txt sind eingecheckt, werden aber zur Laufzeit beschrieben.
- Die Tests des duplicates-tool laufen nicht in npm test mit, und dort ist auch noch keine HTML-Bereinigung eingebaut.
- Die TTS-Routen geben interne Fehlermeldungen an den Client weiter.
- Die Busy-Prüfungen sind auf rund 16 Stellen verteilt statt in einer zentralen Sperre.
- Atomares Schreiben ist mehrfach umgesetzt, dazu kommen doppelte fail- und route()-Helfer.
- SIGHUP wird bei laufendem Auftrag ignoriert, ohne dass etwas im Log steht.
- Feste ?v=-Versionen stehen in vielen Tests. Das ist mir beim Hochzählen erneut aufgefallen und spricht für automatisches Cache-Busting.


----

Aus dem ursprünglichen Review ist ohne die Ideen-Liste noch Folgendes offen.

## Aus dem Plan

| # | Punkt | Stand |
|---|---|---|
| 3 | Reine Logik aus `server.js` nach `lib/` auslagern (Parser, Infografik-Benennung/-Gruppen, Index-Aufbau, HTTP-Helfer) | **offen**. `server.js` hat noch rund 2.900 Zeilen; Skripte wie `migrate-infographic-names.js` laden weiter den ganzen Server mit allen Nebenwirkungen. |
| 4 | Restliche Menüs | Werkzeugleiste des Markdown-Editors und ⋯-Menü der Hörbuch-Extras laufen noch mit eigener Logik. Der Prüfmodus „Infografiken prüfen“ liegt noch in `app.js`. |
| 5 | Doku bereinigen | Session.MD widerspricht sich noch an drei Stellen: Abschnitt 13 nennt den Cron-Wrapper als offen, mehrfach steht „Qwen v4“ statt v5, und zur Reihenfolge der Audio-Suche gibt es zwei Aussagen. |

## Weitere Befunde aus dem Review

**Robustheit und Sicherheit**
- TTS-Routen geben bei Status 500 interne Fehlermeldungen an den Client weiter.
- Die JSON-Stores (Lesezeichen, Fortschritt, Dubletten) ändern zuerst den Speicher und dann die Datei; scheitert das Schreiben, weichen beide voneinander ab.
- Der allgemeine Fehler-Handler meldet bei jeder zu großen Anfrage „Bilddatei größer als 10 MB“.
- Die Volltextsuche nimmt die ersten 2.000 Fuse-Treffer und filtert erst danach. Bei sehr allgemeinen Begriffen können dadurch Treffer des gewählten Autors fehlen.
- Sessions liegen im RAM; jeder Neustart meldet alle ab.
- Das `duplicates-tool` bereinigt sein HTML nicht, und seine Tests laufen nicht in `npm test` mit.

**Doppelter oder umständlicher Code**
- `fail()`- und `route()`-Hüllen gibt es fünfmal, atomares Schreiben siebenmal, außerdem doppelt `escapeHtml`, `normalizeDate` und `slugify`. Dazu kommen gleichartige JSON-Stores ohne gemeinsame Basis.
- Die `sec-fetch-site`-Prüfung steht zusätzlich in sieben Routen, obwohl `requireAdminAccess` sie bereits übernimmt.
- `duplicateFail` wird auch für Infografik-Fehler verwendet.
- `fileUrl` und `audioFileUrl` sind fast identisch.
- `'Telegram'` steht als Text an mehreren Stellen statt als Konstante.
- `duplicates-tool/` enthält Kopien von Diff-Modul, Parser und Dublettenerkennung.

**Leistung**
- `renderIndexForSession` liest `index.html` bei jeder Anfrage synchron.
- `/service-worker.js` hasht bei jedem Abruf alle Dateien unter `public/`.
- Das Artikel-Detail liest, parst und rendert die Markdown-Datei bei jedem Öffnen neu.

**Frontend und Pflege**
- Die `?v=`-Versionen werden von Hand gepflegt und sind zusätzlich in vielen Tests fest eingetragen.
- Browser-Skripte nutzen drei Modulformen nebeneinander: globale Variablen, gekapselte Module und ES-Module nur im Bundle.
- `styles.css` hat rund 3.800 Zeilen in einer Datei.
- Im Scraper sind „Joe Turan“ und `joeturan.com` fest eingetragen, obwohl die Konfiguration mehrere Quellen erlaubt.

**Dokumentation**
- Private Hörbücher und die Sortierung „Zuletzt hinzugefügt“ sind nicht dokumentiert, und die Privat-Markierung liegt fachlich unpassend in `audiobook-progress.json`.
- Commit `bfc6641` spricht von einem „Web Worker“, den es im Code nicht gibt.

