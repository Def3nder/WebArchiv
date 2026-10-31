# Code-Review WebArchiv (Nachprüfung)

Stand: Commit `91bb2ed` („app.js aufgeteilt …“), Arbeitsbaum sauber. Ich habe **nichts am Code geändert**.

## Prüfgrundlage

- **Gelesen:** `server.js` vollständig. Dazu alle Module unter `lib/`, die Sicherheitsmodule (`html-sanitizer`, `security-headers`, `login-limiter`, `media-files`, `archive-lock`), `user-store`, `bookmarks`, `article-editor`, `tts/jobs` und die Routen von `audiobooks`.
- **Frontend:** `apiFetch`, Detailansicht, Tastatursteuerung, `admin-tasks`, `infographic-manager`. Die übrigen Skripte habe ich über Skeletons und gezielte Suchen geprüft (innerHTML, Escape-Handler, eigene Menüs, rohe `fetch`-Aufrufe).
- **Tests:** `npm test` läuft grün: **423/423 Node-Tests** und **14/14 Python-Tests**.
- **Bundles:** `article-editor.bundle.js` und `duplicate-diff.bundle.js` habe ich neu gebaut. Sie sind **identisch** mit den eingecheckten Dateien.
- **Bestand:** Kein Artikel unter `www/` oder `audio/` bindet externe Bilder ein (0 Treffer). Das ist wichtig für die CSP, siehe 2.8.
- **Nicht geprüft:** Ich habe nichts im Browser getestet. Die Befunde in Abschnitt 2 stammen aus dem Lesen des Codes und sind jeweils mit Datei und Zeile belegt.

**Gesamteindruck:** Der Großteil des alten Reviews ist sauber umgesetzt. Die Sicherheitspunkte sind vollständig erledigt und mit Tests abgesichert. Zentrale Sperre, JSON-Speicher, `lib/`-Module, Cache-Busting, Sitzungsdatei und Aufteilung der CSS-Dateien sind ebenfalls erledigt. Offen sind vor allem **Reste der Vereinheitlichung**: Einige Stellen folgen den neuen Regeln aus `CLAUDE.md` noch nicht. Dazu kommt **ein echter Bedienfehler** bei der Tastatursteuerung (2.1).

---

## 1. Wurden die Änderungen aus dem Review vom 27.01. korrekt umgesetzt?

Legende: ✅ umgesetzt · ⚠️ teilweise · ❌ offen

### Sicherheit

| Punkt | Stand | Befund |
|---|---|---|
| HTML-Bereinigung (`renderSafeMarkdown`) | ✅ | Alle Render-Stellen laufen über `html-sanitizer.cjs`: Artikel, Dublettenvergleich, Hörbuch-Abstract, eBook, Extras und `duplicates-tool`. Pseudo-Tags wie `<kontext>` werden als Text sichtbar (`disallowedTagsMode: 'escape'`). Skript- und Einbettungs-Elemente werden samt Inhalt entfernt. |
| `sourceUrl` nur http(s) | ✅ | `extractSourceUrl` → `safeHttpUrl` ([lib/article-parser.cjs:91](lib/article-parser.cjs:91)) |
| Login-Begrenzung | ✅ | `login-limiter.cjs` zählt pro Konto und pro IP und sperrt vor bcrypt. Gilt auch für `/api/me/password` ([user-store.cjs:299](user-store.cjs:299)). |
| `trust proxy` konfigurierbar | ✅ | `TRUST_PROXY`, Standard `loopback, 192.168.1.14`; „true“ wird abgelehnt ([server.js:47](server.js:47)) |
| `SESSION_SECRET` Pflicht, `secure: 'auto'` | ✅ | [server.js:62](server.js:62), [server.js:1054](server.js:1054) |
| CSP und weitere Header | ✅ | Technisch umgesetzt, mit eigener Richtlinie für PDF.js, Nonce für `/a/*` und ohne Inline-Handler. Seit 30.10.2026 in Produktion mit `CSP_MODE=enforce` (siehe 2.8). |
| TTS-Routen ohne interne Fehlertexte | ✅ | Unerwartete Fehler gehen ins Log, der Client bekommt eine allgemeine Meldung ([tts/jobs.cjs:210](tts/jobs.cjs:210)). Das **gleiche Problem steckt jetzt in den Infografik-Routen** (siehe 2.2). |

### Fehler und Randfälle

| Punkt | Stand | Befund |
|---|---|---|
| `page=abc` / `limit=abc` | ✅ | `paginationParams` ([server.js:1887](server.js:1887)) |
| Fuse-Limit vor dem Filtern | ✅ | Das Limit ist entfernt ([server.js:1963](server.js:1963)). |
| SIGHUP bei laufendem Auftrag | ✅ | Wird jetzt mit Auftragsname ins Log geschrieben ([server.js:2079](server.js:2079)). |
| Erst Speicher, dann Datei | ⚠️ | Lesezeichen, Hörfortschritt und Dubletten nutzen `createJsonState` und sind damit korrekt. **`user-store.cjs` hat das Problem noch** (siehe 2.4). |
| Fehler-Handler meldet „Bilddatei > 10 MB“ | ✅ | Die Meldung hängt jetzt vom Pfad ab ([server.js:2059](server.js:2059)). |

### Betrieb

| Punkt | Stand | Befund |
|---|---|---|
| Sitzungen überstehen Neustart | ✅ | `lib/session-file-store.cjs` (0600, gebündelt, atomar, stündliches Aufräumen) |
| `config.json` / `public-directories.txt` aus Git | ✅ | Nicht mehr getrackt, stehen in `.gitignore`; Vorlagen `example-*` |
| `duplicates-tool`-Tests in `npm test` | ✅ | [package.json:12](package.json:12) |

### Zentralisierung und Aufbau

| Punkt | Stand | Befund |
|---|---|---|
| Gemeinsames ARIA-Menü | ✅ | `aria-menu.js` wird überall verwendet; es gibt keine `<details>`-Menüs mehr. Die verbliebenen `<details>` sind echte Aufklapper (Trackliste, Diff). |
| Admin-Code nur für Admins | ✅ | `ADMIN_ASSET_PATHS` und Markierungen in `index.html`. TTS, Reindex und Scrape stehen in `admin-tasks.js`, der Prüfmodus in `infographic-review.js`. |
| Einheitlicher Admin-Schutz | ✅ | `requireAdminAccess` mit CSRF-Token; keine zusätzlichen `sec-fetch-site`-Prüfungen in den Routen mehr |
| Ein Pfadschutz (`isPathInside`/`resolveUnder`) | ⚠️ | Die Medienrouten sind korrekt umgestellt, `canAccessMedia` dekodiert nicht mehr doppelt. **Noch fünf Stellen mit eigenem `startsWith`** (siehe 2.6). |
| Einheitliche `route()`-Hülle | ⚠️ | `jsonRoute` gibt es und die Module nutzen es. Die Infografik- und Dublettenrouten in `server.js` sowie `tts/jobs.cjs` haben aber weiter eigene `try/catch`-Hüllen. |
| API-Fehler mit festem Code | ✅ | `sendApiError` mit `code`. `apiFetch` reagiert auf `admin_required` bzw. `password_change_required` und nicht mehr auf den Meldungstext ([public/app.js:724](public/app.js:724)). |
| `server.js` aufteilen | ⚠️ | Die reine Logik liegt jetzt in `lib/`, Skripte laden `server.js` nicht mehr. `server.js` hat aber noch rund 2.100 Zeilen mit allen Infografik-, Dubletten-, Artikel- und Scrape-Routen. |
| Kopierte Logik zusammenführen | ⚠️ | `duplicates-tool` nutzt jetzt die Module des Archivs, Atomic Write ist zentral. Weiter doppelt: `normalizeDate` in [audiobooks.cjs:30](audiobooks.cjs:30) (mit anderer Semantik) und drei HTML-Escape-Funktionen im Frontend (siehe 2.11). |
| Gemeinsamer JSON-Speicher | ✅ | `createJsonState` in `lib/atomic-file.cjs`. Ausnahmen: `user-store` (siehe 2.4) und `tts/voice-settings.cjs` mit eigenem `atomicJson` (laut `CLAUDE.md` bewusst so). |
| Zentrale Schreibsperre | ✅ | `archive-lock.cjs`. Ein Rest: die doppelte Prüfung `reindexState.running` (siehe 2.9). |
| Hilfe für den Reindex-Status, Jahr aus Pfad | ✅ | `withReindexState`, `yearFromRelativeDir` |
| `app.js` aufteilen | ✅ | 4.150 → rund 2.150 Zeilen; `app-gallery`, `app-media`, `app-detail`, `admin-tasks`, `infographic-review` |
| `createAudiobookLibrary` aufteilen | ✅ | `audiobook-extras.cjs` |

### Leistung

| Punkt | Stand | Befund |
|---|---|---|
| Verzeichnis-Cache beim Scan | ✅ | `createDirectoryCache` |
| `index.html` und SW-Version | ✅ | Werden nur nach Änderung von Größe oder Änderungszeit neu berechnet ([lib/app-shell.cjs](lib/app-shell.cjs)). |
| Artikel-Body bei jedem Öffnen | ✅ | `lib/article-body-cache.cjs` (LRU 300, Größe/Änderungszeit) |
| Automatisches `?v=` | ✅ | `createVersionedIndex`; keine festen Versionen mehr in den Tests |

### Doku und Sonstiges

| Punkt | Stand | Befund |
|---|---|---|
| Session.MD-Widersprüche | ⚠️ | Abschnitt 13, Qwen v5 und Audio-Reihenfolge sind bereinigt. **[Session.MD:30](Session.MD:30) sagt aber noch**: „Beim Cron-Wrapper besteht noch eine Abweichung vom dokumentierten Soll“. Das widerspricht [Session.MD:861](Session.MD:861) („Erledigt“). |
| Private Hörbücher, Sortierungen dokumentiert | ✅ | Eigene Datei `audiobook-private.json` mit Migrationsskript |
| Commit `bfc6641` (Web Worker) | ✅ | In Session.MD klargestellt |
| Scraper fest auf „Joe Turan“ | ✅ | Keine fest eingetragenen Namen mehr in `scrape_all.js` |
| `'Telegram'` als Konstante | ⚠️ | Backend ✅ (`TELEGRAM_AUTHOR`). Im Frontend steht der Text noch in [public/app.js:1350](public/app.js:1350), dazu eine eigene Konstante in `user-admin.js`. |
| `styles.css` aufteilen | ✅ | `public/css/*.css`, Reihenfolge = Kaskade |

---

## 2. Bestehende Fehler und Probleme

Sortiert nach Wichtigkeit.

> **Nachtrag:** 2.1 bis 2.5 sind behoben und mit Tests abgesichert (Details in Session.MD, Abschnitt 39). 2.6, 2.7, 2.9 und 2.11 folgen in Abschnitt 42, 2.10 in Abschnitt 43. 2.8 ist seit 30.10.2026 im Betrieb umgesetzt (Abschnitt 53). Damit sind alle Punkte aus Teil 2 erledigt.

### 2.1 Tastatur: Detailansicht reagiert auf Pfeiltasten und Escape, obwohl ein Dialog darüber offen ist (Fehler) – ✅ behoben

**Wo:** [public/app.js:2044–2069](public/app.js:2044)

Der globale `keydown`-Handler prüft offene Dialoge (`dialog[open]`, TTS-Overlay) und Bedienelemente **nur im Zweig für die Kachelansicht** ([app.js:2079](public/app.js:2079)). Ist die Artikelansicht offen, schließt Escape immer den Artikel ([app.js:2047](public/app.js:2047)), und ←/→ wechseln immer den Artikel ([app.js:2065](public/app.js:2065)).

Die meisten Dialoge fangen das mit eigenen Capture-Handlern und `stopImmediatePropagation` ab (Infografik-Manager, Editor, TTS-Overlay, Extras). **Für `#tts-provider-dialog` gibt es keinen solchen Handler.**

- **Ablauf 1:** Ein Admin öffnet einen Artikel und wählt „Audio erzeugen“. Im Anbieterdialog drückt er Escape. Der Dialog schließt sich, und dazu wird der Artikel geschlossen.
- **Ablauf 2:** Im Anbieterdialog wechselt der Admin mit ←/→ zwischen den Radiobuttons. Dabei springt der Artikel im Hintergrund zum nächsten. `runTts` bricht danach still ab, weil `selectedTtsArticle?.id !== article.id` ([admin-tasks.js:129](public/admin-tasks.js:129)).
- **Ablauf 3:** Hat das native `<audio>`- oder `<video>`-Element der Detailansicht den Fokus, spulen ←/→ und wechseln gleichzeitig den Artikel.

**Lösung:** Im Detail-Zweig dieselben Ausnahmen wie im Kachel-Zweig anwenden: kein Wechsel bei `dialog[open]`, offenem TTS- oder Scrape-Overlay oder fokussiertem Bedienelement. Die bessere Lösung steht in 3.2.

### 2.2 Infografik-Routen geben interne Fehlertexte an den Client – ✅ behoben

**Wo:** [server.js:1409](server.js:1409), [:1454](server.js:1454), [:1482](server.js:1482), [:1558](server.js:1558), [:1612](server.js:1612)

Muster: `res.status(error.status || 500).json({ error: error.message || '…' })`. Damit landen bei unerwarteten Fehlern Texte wie `ENOENT: no such file or directory, rename 'C:\…\www\Infografiken\…'` im Browser. Das sind Pfade und Interna, und es fehlt der Log-Eintrag.

Die Dublettenrouten derselben Datei machen es richtig: `error.status ? error.message : '…'` plus `console.error`. Weil die Routen nur Admins offenstehen, ist das Risiko gering. Es widerspricht aber der Regel aus `CLAUDE.md`.

**Lösung:** Auf `jsonRoute` umstellen oder dasselbe Muster wie bei den Dublettenrouten verwenden.

### 2.3 Dubletten verknüpfen: Ein Fehler beim Lesezeichen-Schreiben lässt den Index veralten – ✅ behoben

**Wo:** [server.js:1826](server.js:1826) (Sammelaktion), [server.js:1874](server.js:1874) (Einzelaktion)

Die Reihenfolge ist: Infografiken verschieben → Entscheidung speichern → `bookmarks.replaceArticleId(s)` → `refreshInfographicsForYears`. Wirft das Lesezeichen-Schreiben einen Fehler (zum Beispiel `EACCES` auf `bookmarks.json`), dann gilt:

- Die Dateien sind bereits verschoben und die Entscheidung ist gespeichert.
- Es gibt **keinen Teil-Reindex** und kein `refreshDuplicateState`.
- Die Oberfläche meldet 500, „Die Dublettenaktion ist fehlgeschlagen.“

Der Index zeigt danach auf nicht mehr vorhandene Infografik-Pfade, bis jemand neu indiziert.

**Lösung:** Den Lesezeichen-Umzug als Warnung behandeln, nicht als Fehler, oder ihn erst nach dem Reindex ausführen. Den Reindex in jedem Fall ausführen.

### 2.4 `user-store.cjs` ändert den Speicher vor der Datei – ✅ behoben

**Wo:** [user-store.cjs:98–105](user-store.cjs:98)

`mutateUsers` lädt die Datei in die modulweite Variable `users` und lässt `change(users)` **direkt diese Liste** verändern. Erst danach wird geschrieben. Scheitert `writeJsonAtomic`, bleibt die Änderung im Speicher wirksam. Beispiele:

- Ein neues Kennwort (`setPassword`) gilt bis zum Neustart, obwohl es nie gespeichert wurde.
- Die erhöhte `sessionVersion` meldet den Nutzer ab.

Die nächste Änderung lädt die Datei neu und heilt den Zustand. Bis dahin weichen Speicher und Datei voneinander ab, also genau der Punkt 8 aus dem alten Review.

**Lösung:** Mit einer Kopie arbeiten (`structuredClone`) und erst nach dem Schreiben übernehmen, so wie `createJsonState`.

### 2.5 Scraper- und Reindex-Status für jeden angemeldeten Nutzer lesbar – ✅ behoben

**Wo:** [server.js:1309](server.js:1309), [server.js:1622](server.js:1622) (`requireAuth`)

`GET /api/scrape/status` liefert `scrapeState.output`, also die letzten 20.000 Zeichen der Scraper-Ausgabe mit Pfaden, Quellen und Fehlermeldungen. Abrufen kann das jeder normale Nutzer, nicht nur Admins. Während des Laufs ist darin auch die Manifestzeile mit absoluten Dateipfaden enthalten. Sie wird erst bei `close` entfernt.

**Lösung:** `requireAdminAccess` verwenden. Das Frontend fragt den Status ohnehin nur im Admin-Skript ab.

### 2.6 Pfadprüfung per `startsWith` an fünf Stellen (Regelverstoß) – ✅ behoben

`CLAUDE.md` legt fest: „never write `startsWith(root + path.sep)`“. Noch vorhanden sind:

- [article-editor.cjs:21](article-editor.cjs:21)
- [tts/jobs.cjs:51–59](tts/jobs.cjs:51) und [:123](tts/jobs.cjs:123)
- [server.js:738/750](server.js:738) (`root = … + path.sep; mdPath.startsWith(root)`)
- [scripts/migrate-audio.js:50](scripts/migrate-audio.js:50)
- [scripts/migrate-infographic-names.js:24](scripts/migrate-infographic-names.js:24), eine eigene Kopie von `isPathInside`

Funktional ist das hier überwiegend korrekt, weil beide Seiten über `realpath` normalisiert sind. Es ist aber genau die Fehlerklasse, die die Regel verhindern soll: Unter Windows unterscheiden sich Groß- und Kleinschreibung, unter Linux fehlt der Sonderfall „root selbst“.

**Lösung:** Überall `isPathInside` bzw. `resolveUnder` aus `lib/archive-files.cjs` verwenden.

### 2.7 Infografik-Dateien: zwei nicht atomare Stellen – ✅ behoben

- **[server.js:922](server.js:922):** `migrateDuplicateInfographics` überschreibt die bereits verschobene `.md` per `fs.promises.writeFile`. Auch der Rollback in [:892](server.js:892) schreibt so. Ein Absturz mitten im Schreiben hinterlässt eine halbe Datei. Dafür passt `writeFileAtomic`.
- **[lib/infographics.cjs:391–400](lib/infographics.cjs:391):** Schlägt im Rollback von `moveInfographicFiles` ein `rename` fehl, bricht die Schleife ab. Die übrigen Dateien bleiben dann unter `.infographic-<token>-N.tmp` liegen und sind für Index und Nutzer unsichtbar. Der ursprüngliche Fehler wird geworfen, der Rollback-Fehler verschluckt. Besser: Den Rollback pro Datei in `try/catch` fassen, alle Fehler sammeln und die liegengebliebenen Temp-Namen in der Meldung nennen.

### 2.8 CSP läuft in Produktion weiter nur im Report-Modus – ✅ umgestellt

> **Nachtrag 30.10.2026:** Im Journal stand keine einzige Meldung „CSP-Verstoß“. Der LXC läuft jetzt mit `CSP_MODE=enforce`; der Header heißt `Content-Security-Policy` (ohne `-Report-Only`). Nach Tests mit PDF, Video, Audio, Hörbuch und Editor gab es weiterhin keine Meldungen (Session.MD, Abschnitt 53).

**Wo:** [LXC-container node.js Setup.md:379](LXC-container%20node.js%20Setup.md:379) (`CSP_MODE=report`), [Session.MD:1312](Session.MD:1312) („`enforce` wurde nur in Tests geprüft“)

Der eigentliche XSS-Schutz der CSP greift erst mit `enforce`. Der Bestand spricht nicht dagegen: Es gibt keine externen Bilder in `www/` und `audio/`, keine Inline-Handler, und das einzige Inline-Skript hat eine Nonce.

**Empfehlung:** Das Dienstprotokoll auf `CSP-Verstoß` prüfen (`journalctl -u nodeapp | grep CSP`). Gibt es keine Meldungen, `enforce` setzen.

### 2.9 Doppelte Prüfungen neben der Archiv-Sperre – ✅ behoben

**Wo:** [server.js:1383](server.js:1383), [server.js:1626](server.js:1626)

`if (reindexState.running) …` bzw. `if (scrapeState.running) …` stehen jeweils vor `archiveLock.busy`. Die Antwort ist dadurch leicht unterschiedlich (`reason: 'already running'` statt 409), funktional ist das harmlos. `CLAUDE.md` verbietet solche Prüfungen aber ausdrücklich.

### 2.10 Doku passt nicht ganz zum Code – ✅ behoben

- **Sitzungsinhalt:** `CLAUDE.md` sagt „The session stores only `{email, sessionVersion}`“. Tatsächlich speichern [server.js:1061](server.js:1061) und [:1157](server.js:1157) das vollständig aufgelöste Nutzerobjekt (Rolle, `allowedAuthors`, …), und es landet so in `sessions.json`. Das ist unschädlich, weil die Daten bei jeder Anfrage neu aufgelöst werden. Entweder die Doku anpassen oder nur `{ email, sessionVersion }` speichern und `req.user` getrennt setzen.
- **Journal-Meldungen:** In der To-Do-Liste ist der Punkt „Journal-Meldungen ohne Sonderzeichen“ abgehakt. Weiterhin Nicht-ASCII enthalten zum Beispiel [server.js:1674](server.js:1674) (`—`, `…`), [:2079](server.js:2079) (`übersprungen`, `läuft`), [:1352](server.js:1352) (`„…“`), [:126](server.js:126) und [lib/atomic-file.cjs:70](lib/atomic-file.cjs:70). Ursache ist eher eine fehlende UTF-8-Locale im Journal als der Text. Beides angleichen oder die Locale setzen.
- **[Session.MD:30](Session.MD:30):** Cron-Wrapper (siehe Abschnitt 1).
- **[tts/UEBERGABE-TTS.md:4](tts/UEBERGABE-TTS.md:4):** nennt den „Qwen-v4-Healthcheck“, der Code verlangt v5. Falls die Datei als historisch gilt, sollte das oben vermerkt sein.

### 2.11 Kleinigkeiten – ✅ behoben

- **CSRF-Fehler ohne `code`:** Die 403-Antworten von `requireAdminAccess` ([server.js:980–988](server.js:980)) haben kein `code`. Ein veraltetes CSRF-Token zeigt deshalb nur „Ungültiges oder fehlendes Sicherheitstoken.“, und die Seite lädt nicht neu. Ein Code wie `csrf_invalid` plus Behandlung in `apiFetch` wäre robuster.
- **Kein JSON-Fehler-Handler am Ende:** [server.js:2068](server.js:2068) reicht unbehandelte Fehler mit `next(err)` an Express weiter. Ohne `NODE_ENV=production` liefert das HTML mit Stacktrace. Ein letzter Handler für `/api/*` mit `{ error, code }` wäre konsistent.
- **Unpassende Meldung bei Extras:** Die 413-Meldung „Artikel dürfen höchstens 1 MB enthalten“ gilt auch für die Hörbuch-Extras ([server.js:2053–2056](server.js:2053)).
- **Kontosperre missbrauchbar:** Fünf falsche Versuche sperren ein Konto für 15 Minuten. Jeder, der die Admin-E-Mail kennt, kann den Admin also aussperren. Das ist ein üblicher Kompromiss; eine sanftere Stufe (Verzögerung statt Sperre) oder die Sperre nur pro IP+Konto wäre eine Option.
- **Ungenutzte Re-Exporte:** `user-store.cjs` exportiert `writeJsonAtomic` noch weiter ([:314](user-store.cjs:314)), genutzt wird das nirgends. `media-files.cjs` exportiert `isPathInside` erneut ([:82](media-files.cjs:82)).
- **Lineare Suche:** `getArticle: id => articles.find(…)` in [server.js:176](server.js:176) und [:184](server.js:184), obwohl `articleById` existiert.
- **Escape-Funktionen im Frontend dreifach:** `esc` ([app.js:534](public/app.js:534)), `duplicateEsc` ([duplicates.js:123](public/duplicates.js:123)) und `escapeHtml` ([duplicate-diff.js:6](public/duplicate-diff.js:6), wegen des Bundles verständlich). `duplicates.js` könnte `esc` mitbenutzen.
- **`normalizeDate` doppelt:** [audiobooks.cjs:30](audiobooks.cjs:30) hat eine zweite Fassung mit anderer Semantik (Jahr allein → `JJJJ-01-01`, nur am Zeilenanfang). Entweder als eigene Funktion `normalizeAbstractDate` benennen oder mit Option in `lib/article-parser.cjs` vereinen.
- **Einrückung:** falsch in [server.js:2077](server.js:2077).

---

## 3. Verbesserungsideen

### 3.1 Modulstruktur: Root oder `lib/` (offene Frage aus der To-Do-Liste) – ✅ umgesetzt

> **Nachtrag 31.10.2026:** In acht Schritten umgesetzt (Commits `37f8da8` bis `a23eca2`, Abschluss in Session.MD,
> Abschnitt 54). Im Root liegt kein `.cjs` mehr. Unter `lib/` liegen die reinen Hilfen, dazu `html-sanitizer`,
> `login-limiter`, `archive-lock`, `security-headers` und `duplicates`. Unter `modules/` liegen die sechs bisherigen
> Routenmodule und neu `scrape`, `duplicate-admin`, `infographic-admin`, `articles` und `link-preview`.
> `server.js` schrumpfte von 2.139 auf **rund 900 Zeilen**: Zustand (Objekt `archive`), Index-Aufbau, Anmeldung,
> Reindex und Verdrahtung. Die Schätzung „unter 700“ war zu knapp: Middleware, Anmeldung und Index-Aufbau
> bleiben bewusst dort. Alle Routen der Module laufen über `jsonRoute`; Schreibaufträge nutzen `lock.run`.
> Regeltests in `test/code-rules.test.cjs` sichern das ab: kein Root-Modul, `lib/` lädt weder `modules/` noch
> `server.js`, niemand lädt `server.js`, kein `sendRouteError`/`tryAcquire` in Routen, atomares Schreiben und keine
> rohen Fehlertexte auch in `modules/`.

Einen sachlichen Grund für die heutige Aufteilung gibt es nicht. Sie ist historisch gewachsen: `lib/` entstand beim Auslagern aus `server.js`, die Root-Module gab es schon vorher. Vorschlag:

- **`lib/`:** reine Hilfen ohne Routen, also `html-sanitizer`, `login-limiter`, `archive-lock`, `security-headers` und `duplicates` (Erkennung).
- **`modules/`** (oder `routes/`): Module mit `install…Routes`, also `user-store`, `bookmarks`, `audiobooks`, `audiobook-extras`, `article-editor` und `media-files`. Dazu neu die bisher in `server.js` verbliebenen Bereiche: **Infografiken** (Upload, Manager, Prüfmodus, neue Infografik), **Dubletten**, **Scrape** und **Artikel-Liste**. `server.js` bliebe dann bei Zustand, Index-Aufbau und Verdrahtung (geschätzt unter 700 Zeilen).
- Dabei die Routen gleich auf `jsonRoute` umstellen. Damit erledigen sich 2.2 und der Rest der „route()-Hüllen“ von selbst.
- `duplicates-tool` und Skripte importieren `html-sanitizer.cjs` und `duplicates.cjs` aus dem Root. Die Pfade müssten also mitwandern, die Tests decken das ab.

### 3.2 Zentrale Verwaltung für Tastatur und Ebenen – ✅ umgesetzt

> **Nachtrag 30.10.2026:** Umgesetzt als `public/layer-stack.js` (`WebArchivLayers`); alle Ebenen sind modale `<dialog>` am Stapel, eigene Tastenhandler am Dokument gibt es nur noch in `aria-menu.js` (abgesichert durch `test/layer-rules.test.cjs`). Details in Session.MD, Abschnitte 45–52.

Heute hängen **elf** `keydown`-Handler am Dokument, die meisten in der Capture-Phase mit `stopImmediatePropagation`. Ob sie richtig zusammenspielen, hängt von der Ladereihenfolge der Skripte ab, und 2.1 ist genau so entstanden. Ein kleiner Ebenen-Stapel als gekapseltes Skript würde das lösen, etwa `layerStack.push({ el, onEscape, trapsArrows })`:

- Escape geht nur an die oberste Ebene.
- Pfeiltasten gehen nur an die Artikel- oder Kachelnavigation, wenn keine Ebene darüber liegt.
- Fokusfalle und Rücksprung des Fokus sind zentral geregelt.

Die heute verteilte Logik in `syncModalPageScroll`, `dialogOpen()` und `PULL_DIALOGS` würde sich darin bündeln.

### 3.3 Teil-Reindex günstiger machen – ✅ umgesetzt (die ersten beiden Schritte)

> **Nachtrag 29.10.2026:** `createDuplicateDetection` in `duplicates.cjs` rechnet die Kandidaten nur neu, wenn
> sich Reihenfolge, Autor, Datum oder Profil eines Blog- oder Quellartikels geändert haben. Infografik-Änderungen,
> Poster-Haken, Autoren-Priorität und Dublettenentscheidungen nutzen das letzte Ergebnis: gemessen **ca. 1 ms statt
> ca. 620 ms**, Ergebnis identisch mit einer frischen Erkennung. Das Speichern eines Blog- oder Quellartikels und
> Scraper-Läufe rechnen weiter vollständig (ca. 0,6 s); die inkrementelle Variante (dritter Schritt) ist nicht umgesetzt.

Jede noch so kleine Änderung führt `publishArticleIndex` über den **gesamten** Bestand aus, etwa ein Poster-Haken, ein gespeicherter Artikel oder eine einzelne Dublettenentscheidung. Dabei laufen jedes Mal `linkInfographics`, ein neuer Fuse-Index und die komplette Dublettenerkennung. Das ist korrekt und einfach.

**Gemessen** am lokalen Bestand (7.113 Einträge, drei Durchläufe):

| Schritt | Dauer |
|---|---|
| Vollindex | ca. 5,1 s |
| `linkInfographics` | ca. 10 ms |
| Fuse-Index | ca. 20 ms |
| Dublettenerkennung | **ca. 600 ms** |

Jeder Teil-Reindex blockiert die Ereignisschleife damit rund **0,6 s**, und das fast nur wegen der Dublettenerkennung. Während dieser Zeit beantwortet der Server keine Anfrage. Mögliche Schritte, nach Nutzen sortiert:

- `refreshDuplicateState` nach einer reinen Dublettenentscheidung (Ignorieren, Zurücksetzen, Verknüpfen ohne Umzug) ohne `detectDuplicateCandidates` ausführen und nur die vorhandene Kandidatenliste filtern.
- Die Erkennung nur neu rechnen, wenn sich ein Blog- oder Quellartikel geändert hat. Ein Infografik-Jahrgang oder ein Poster-Haken betreffen sie nicht.
- Kandidaten inkrementell bestimmen, also nur die geänderten Artikel gegen den Bestand vergleichen.

Fuse und die Infografik-Verknüpfung sind dagegen unkritisch.

### 3.4 Betrieb

- **`/api/health`** für Monitoring und den Neustart-Check: Indexstatus und -zeitpunkt, Artikel- und Hörbuchzahl, Sperrstatus (`archiveLock.current`), Erreichbarkeit von Qwen, freier Platz auf dem `www`-Datenträger.
- **Unlesbare Dateien sichtbar machen:** `scanDir` verwirft sie weiterhin still ([server.js:304](server.js:304)). Gezählt und mit Pfad im Reindex-Status oder Log wären sie die erste Zeile des „Qualitäts-Dashboards“ aus der To-Do-Liste.
- **Geordnetes Beenden:** Beim Herunterfahren ([server.js:2091](server.js:2091)) wartet der Server auf TTS und Sitzungen, aber nicht auf einen laufenden exklusiven Schreibauftrag (`archiveLock.holder`). Ein kurzes Warten mit Zeitlimit verhindert halbe Infografik-Umbenennungen bei `systemctl restart`.

### 3.5 Qualitätssicherung

- **ESLint mit wenigen Regeln** (`no-undef`, `no-unused-vars`, `no-redeclare`) und einer `globals`-Liste für die gemeinsamen klassischen Skripte. Bei rund 300 global geteilten Bezeichnern findet das Tippfehler und tote Exporte (wie in 2.11), bevor sie im Browser auffallen.
- **Browser-Smoke-Test:** Playwright ist im Scraper schon vorhanden. Wenige Abläufe würden 2.1-artige Fehler abfangen: Artikel öffnen, Dialog öffnen, Escape und Pfeiltasten, Lesezeichen setzen, Hörbuch abspielen, alles im `CSP_MODE=enforce` ohne Konsolenfehler. Die heutigen Frontend-Tests prüfen überwiegend Quelltext-Muster.
- **Regeltests:** Ein Test, der `startsWith(… + path.sep)` und `res.status(500).json({ error: err.message })` per Regex im Quelltext verbietet, sichert die `CLAUDE.md`-Regeln dauerhaft ab.

### 3.6 Dokumentation

- **Session.MD aufteilen:** Die Datei hat rund 1.800 Zeilen und ist eine Mischung aus Soll-Beschreibung und Änderungsprotokoll mit über 35 Aktualisierungsabschnitten. Ein Vorschlag:
  - `ARCHITEKTUR.md`: geltender Stand ohne Historie
  - `CHANGELOG.md`: datierte Abschnitte
  
  So entstehen Widersprüche wie in 2.10 gar nicht erst.
- **`AGENTS.md` und `CLAUDE.md`** enthalten weitgehend denselben Text. Eine Datei könnte auf die andere verweisen.

### 3.7 Noch offene Ideen aus dem ersten Review

Datei-Watcher für `www/` statt SIGHUP/Cron, persistenter Index-Cache für schnellere Starts, optionale Volltextsuche über den Body (MiniSearch) sowie Einschlaf-Timer und Gesamtdauer für Hörbücher (stehen auch in der To-Do-Liste).

---

## Vorschlag für die Reihenfolge

1. **2.1 Tastaturfehler** (klein, für Nutzer spürbar)
2. **2.5 Scrape-Status nur für Admins**, **2.2 Fehlertexte**, **2.4 user-store** (je wenige Zeilen)
3. **2.3 Dubletten-Reindex** und **2.7 atomare Infografik-Schreibvorgänge**
4. **2.8 CSP auf `enforce`** nach Blick ins Journal
5. **3.1 Modulstruktur** zusammen mit 2.6 und 2.9 (ein Umbau, danach gelten die `CLAUDE.md`-Regeln ausnahmslos)
6. **3.2 Ebenen-Verwaltung** und **3.5 Linter und Smoke-Test**
