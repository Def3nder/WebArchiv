# WebArchiv – gesammeltes Projektwissen und Sitzungsprotokoll

Stand: **25.09.2026**. Zusammengeführt aus den zugänglichen Projektgesprächen und den vorhandenen Projektdokumenten; wichtige spätere Entscheidungen mit dem lokalen Code abgeglichen.

## Umfang und Leseregel

Ausgewertet wurden **14 frühere fachliche Codex-Gespräche mit insgesamt 99 Gesprächsrunden**, einschließlich abgebrochener Runden. Die Gespräche wurden über Projektpfad bzw. Repository-Zuordnung im lokalen Sitzungsindex ermittelt und über alle verfügbaren Gesprächsseiten gelesen. Auch das lokale Archivverzeichnis wurde auf zusätzliche WebArchiv-Sitzungen geprüft; dort wurden keine weiteren gefunden. Technische Prüfgespräche, leere Sitzungen und doppelte Sitzungsdateien zählen nicht als zusätzliche fachliche Gespräche.

Die direkt verfügbaren Gesprächsinhalte reichen vom **10.07. bis 18.09.2026**. Die frühere Aufbauphase ist ergänzend durch `session-context.md` und die LXC-Setup-Dokumentation belegt. Nicht mehr vorhandene oder andernorts gespeicherte Gesprächsverläufe sind damit nicht vollständig rekonstruierbar. Das Quellenverzeichnis am Ende nennt jedes ausgewertete Gespräch.

Diese Datei ist eine thematische Zusammenfassung, kein wortgetreues Transkript. Spätere ausdrückliche Benutzerentscheidungen ersetzen frühere Vorschläge. „Historisch geprüft“ bedeutet: im damaligen Gespräch als durchgeführt dokumentiert. Es ist keine erneute Prüfung am heutigen Datum und keine Bestätigung des derzeitigen Produktionszustands.

## 1. Die wichtigsten geltenden Entscheidungen

| Thema | Zuletzt festgelegtes Verhalten |
| --- | --- |
| Datenhaltung | Markdown und Medien bleiben Dateien; kein Datenbankumbau, kein Frontend-Build. |
| Audioablage | Vorhandene MP3 neben der Markdown-Datei hat Vorrang; anschließend Suche im parallelen `audio/`-Baum. Neue TTS-Ausgabe geht nach `audio/`. |
| Stefan Hiene | Bestehende MP3s unter `www/Stefan Hiene/...` bleiben unterstützt; keine pauschale Migration. |
| Infografik-Audio | Varianten können Audio erben. Zugriff bleibt an den Autor der Audioquelle gebunden, auch bei öffentlicher Infografik. |
| Blogformat | Joe-Turan-Blogartikel benötigen keine Trennlinie. Der Server erkennt den Body nach Datum und unmittelbar folgenden Metadaten. |
| Infografik-Upload | Originalen Markdown-Kopf einschließlich Formatierung erhalten; Body und abschließenden Body-Trenner weglassen. Titel und Datum Pflicht, Quelle optional. |
| Artikel bearbeiten | Admin bearbeitet die vollständige Original-Markdown-Datei; Versionskonflikte dürfen keine fremden Änderungen überschreiben. |
| TTS-Menü | „Audio erzeugen“ gehört in die Detailansicht eines Artikels, nicht in das globale Admin-Menü der Kachelansicht. |
| TTS-Auswahl | Radio-Buttons; verfügbares Qwen vorausgewählt. OpenAI wird bei Qwen-Ausfall nicht automatisch ausgewählt. Start erst durch Bestätigung. |
| Qwen-Verarbeitung | Protokoll `webarchiv-qwen-v4`: vollständiges Original-Markdown hinein, fertige MP3 heraus; Originalscript entscheidet über Verarbeitung und Seed. |
| Providerwechsel | Kein automatischer Wechsel eines laufenden Auftrags zu OpenAI und keine erneute Synthese wegen eines Reindex-Fehlers. |
| PDF.js | Lokal unter `public/vendor/pdfjs`; der zuvor erwogene CDN-Umbau wurde nicht umgesetzt. |
| Inhaltsaktualisierung | Reindex statt Dienstneustart. Beim Cron-Wrapper besteht noch eine Abweichung vom dokumentierten Soll, siehe Abschnitt 10. |
| Benutzerverwaltung (25.09.) | Admin pflegt Nutzer, Rechte, Kennwörter und öffentliche Autoren über Aktionen → *Benutzerverwaltung*; jeder Nutzer kann sein Kennwort ändern. Siehe Abschnitt 4a. |
| Öffentliche Autoren (25.09.) | Angemeldete Nutzer mit Autorenliste sehen öffentliche Autoren immer zusätzlich. |
| „Neue Grafik“ (25.09.) | Für alle Autoren außer `Infografiken` selbst, auch für öffentliche Autoren. |

## 2. Projekt, Architektur und Datenmodell

WebArchiv ist ein selbst gehostetes Archiv für überwiegend deutschsprachige Artikel. Oberfläche, neue Kommentare und Dokumentation sollen zum deutschen Projektkontext passen.

- `server.js` ist die zentrale Express-Anwendung in CommonJS. Ergänzende Module übernehmen inzwischen Editor und TTS-Aufträge; „alles in einer einzigen Backend-Datei“ beschreibt nur den früheren Stand.
- `public/index.html`, `public/app.js` und `public/styles.css` bilden eine Vanilla-JavaScript-SPA. Der Editor besitzt zusätzlich `public/article-editor.js`.
- Hash-Routen wie `#/article/<id>` öffnen Artikel direkt im Detail-Overlay.
- `buildIndex()`/`rebuildIndex()` lesen `www/` rekursiv ein, parsen die Dateien, ordnen Medien zu und erstellen Artikel-, Metadaten- und Fuse-Suchindex im RAM. Der Index ist nach einem Neustart neu aufzubauen.
- Jeder unmittelbare Unterordner von `www/` ist ein Autor. Vierstellige Jahresordner bestimmen das Jahr; weitere Unterordner bleiben Teil des relativen Artikelpfads.
- Eine Artikel-ID beruht auf Autor und relativem Dateipfad ohne `.md`. Eine Änderung des angezeigten Titels benennt die Datei nicht um.
- Bilder, Videos und PDFs werden über denselben Dateinamenstamm zugeordnet. Für Bilder gibt es autorbezogene `standard`-Fallbacks. Die Geschwisterdateisuche wurde für unterschiedliche Groß-/Kleinschreibung auf Linux robuster gemacht.
- `categories` sind automatisch ermittelte Taxonomie-Kategorien, höchstens fünf pro Artikel. `tags` stammen aus `Kategorien:` und sind Anzeige-Metadaten. Beide Begriffe nicht gleichsetzen.
- Die Suche verwendet gewichtete Fuse-Felder: Titel, Autor, Kategorien und Auszug. Die historische Bezeichnung „Volltextsuche“ bedeutet nicht, dass der gesamte Body als eigener Suchschlüssel indexiert wird.
- Text und Datum sind kombinierbar, etwa `Achtsamkeit 2025`. Datumsbestandteile filtern, der übrige Text wird unscharf gesucht.
- Neue Autoren werden durch Ordner erkannt; ihre Sichtbarkeit ergibt sich anschließend aus den Zugriffsrechten.
- Telegram ist in normalen Listen ausgeblendet, bis es per Toggle, `telegram=1` oder ausdrücklichem Autorenfilter einbezogen wird.

### Verzeichnisse und Verantwortlichkeiten

| Pfad | Zweck |
| --- | --- |
| `www/<Autor>/<Jahr>/...` | Markdown und zugehörige Originalmedien |
| `audio/<Autor>/<Jahr>/...` | Parallele Ablage zusätzlicher bzw. erzeugter MP3s |
| `public/` | Browseroberfläche; Änderungen werden durch Neuladen aktiv |
| `public/vendor/pdfjs/` | Lokaler PDF.js-Viewer und seine Ressourcen |
| `prompts/*.txt` | Vorlagen für das Kopiermenü; numerischer Präfix bestimmt Reihenfolge |
| `scraper/` | Eigenständiges ESM-Unterpaket mit Playwright und eigenen Abhängigkeiten |
| `tts/` | Eigenständiges ESM-TTS-Paket mit CommonJS-Anbindungsmodulen |
| `article-editor.cjs` | Sicheres Lesen und Schreiben der Markdown-Dateien |
| `scripts/hash-passwords.js` | Passwortpflege über bcrypt |
| `migrate-audio.js` | Bewusste Migration der MP3s eines ausgewählten Autors |
| `graft/` | Kontextgraph für Entwicklung; keine Laufzeitvoraussetzung |

Artikel und Medien werden getrennt vom Code synchronisiert. `users.json`, Audioablage, Cookies, Logs und Abhängigkeiten sollen nicht versehentlich veröffentlicht werden. Die tatsächlichen Ignore-Muster prüfen: Ein neuer Autorenordner oder eine neue Dateistruktur ist nicht allein deshalb sicher ignoriert, weil andere Archivdateien ignoriert werden.

Quellen: [D1], [D2], [D3], [G2], [G4], [G7], [G10].

## 3. Markdown-Format und Parser: endgültige Korrektur

Es gibt **kein YAML-Frontmatter**. Der Parser erkennt Titel, `Datum:`, optional `Quelle:`, `Audioquickie:`, `Kategorien:` und `Zusammenfassung:` anhand des Textes. Datumswerte werden aus ISO-, deutschen und Slash-Formaten normalisiert; für ältere Dateien existieren Fallbacks über Inhalt und Dateiname. Markdown-Markierungen um Metadaten werden an den jeweiligen Erkennungsstellen berücksichtigt.

Zwei praktisch verwendete Formen müssen unterstützt bleiben:

```markdown
# Titel eines Blogartikels

*Quelle: https://example.org/artikel*

**Datum: 2026-09-17**

Hier beginnt der Artikeltext ohne zusätzliche Trennlinie.

Quelle: Eine Literaturangabe innerhalb des Artikels bleibt Artikeltext.
```

```markdown
# Titel eines aufbereiteten Artikels

Datum: 2026-09-17
Audioquickie: 123
Kategorien: Beziehung, Entwicklung
Zusammenfassung: Ein kurzer Überblick.

****

Hier beginnt der Artikeltext.
```

### Fehler vom 18.09.2026 und Entscheidung

Beim Artikel `2026-09-17_kann-beruehrung-wirklich-medizin-sein.md` erschienen zunächst nur Titel, Datum und „Joe Turan“. Der damalige Parser suchte ohne Trenner auch weiter unten nach Metadaten. Eine Literaturzeile `Quelle: Cox, D. …` im Body verschob deshalb den vermeintlichen Artikelbeginn fast ans Ende.

Die erste Reparatur ergänzte `****` in der betroffenen Datei, anschließend im Scraper und in fünf weiteren Altdateien. **Auf Benutzerwunsch wurde dieser Ansatz vollständig zurückgenommen.** Die sechs Dateien wurden wieder vom zusätzlich eingefügten Trenner befreit; `renderBlogMarkdown()` erzeugt weiterhin das bisherige Blogformat ohne Trennlinie.

Die endgültige Lösung liegt in `parseArticle()`:

1. Nach `Datum:` dürfen unmittelbar folgende bekannte Metadaten gelesen werden.
2. Ohne expliziten Trenner beginnt der Body mit der ersten normalen, nicht leeren Textzeile.
3. Ab diesem Punkt bleiben spätere `Quelle:`-Zeilen Teil des Inhalts.
4. Bereits verwendete Formen mit Zusammenfassung und Trenner bleiben unterstützt.
5. Ein führender Markdown-Trenner aus Facebook-/Telegram-Ausgaben wird aus dem Body-Anfang entfernt, damit er nicht zusätzlich als Text oder horizontale Linie erscheint.

Der historische Gegencheck erkannte wieder 2.347 Zeichen Body einschließlich der Literaturquelle. Damals wurden zehn Tests als bestanden protokolliert. Bei Änderungen am Artikelvertrag Parser, Scraper und betroffene Prompt-Vorlagen gemeinsam betrachten; alte Dateien nicht allein zur Anpassung an einen neuen Parser umformatieren.

Aktuell abgeglichen: `server.js:166–299` (`parseArticle`) und `scraper/scrape_all.js:687–694` (`renderBlogMarkdown`). Quellen: [G12], [G13].

## 4. Anmeldung, Rechte und öffentliche Vorschauen

- Benutzer stehen in `users.json`; Vorlage ist `example-users.json`. Rollen: `admin` und `user`.
- `allowedAuthors: null` erlaubt alle Autoren; ein Array bildet eine Whitelist.
- Gäste erhalten nur die in `public-directories.txt` unter `public-directories` aufgeführten Autoren. Ohne öffentliche Autoren wird eine Anmeldung verlangt.
- Autorenrechte werden in Listen, Metadaten, Detailabruf und Datei-Auslieferung berücksichtigt. Neue Funktionen dürfen nicht ausschließlich durch ausgeblendete UI-Elemente geschützt werden.
- Dateipfade werden serverseitig bestimmt und gegen die jeweilige Wurzel geprüft. Editor und TTS prüfen zusätzlich auf unzulässige Symlink-/Junction-Pfade.
- `express-session` verwendet derzeit den Arbeitsspeicher. Ein Dienstneustart verliert die Sessions; ein Reindex nicht. `SESSION_SECRET` muss im produktiven Dienst gesetzt sein.
- Passwörter werden mit `node scripts/hash-passwords.js` von `password` nach `passwordHash` überführt (Liste oder Objekt mit `users`). Im laufenden Betrieb erfolgt die Pflege über die Benutzerverwaltung, siehe Abschnitt 4a.

### Gewollte Ausnahme: Link-Vorschau

`GET /a/<id>` und `GET /og-image/<id>` sind absichtlich ohne Anmeldung erreichbar. Wer den Link kennt, kann Titel, Beschreibung und Vorschaubild erhalten, auch bei geschütztem Artikel. Das ist eine dokumentierte Produktentscheidung und keine Freigabe des Artikelbodys oder der Audiodateien.

Social-Crawler ignorieren Hash-Routen und führen kein JavaScript aus. Deshalb liefert `/a/` serverseitige Open-Graph-Metadaten; Menschen werden zur SPA weitergeleitet. Die absoluten URLs müssen hinter dem Reverse Proxy das tatsächliche Protokoll und den Host verwenden. `sharp` verkleinert die Vorschaubilder und cached nach Dateizeitstempel.

### Korrigierte Ausnahme bei geerbtem Audio

Im August wurde kurzzeitig erlaubt, ein geschütztes Audio über eine sichtbare Infografik abzurufen. Der Benutzer bemerkte dadurch Audiozugriff ohne Anmeldung und verlangte die Rücknahme. **Diese Freigabe gilt ausdrücklich nicht mehr.**

Eine öffentliche Infografik darf intern auf Audio eines geschützten Autors verweisen. Die API entfernt diese Audio-URL für Nutzer ohne Rechte am Basisautor; der Datei-Endpunkt prüft ebenfalls den tatsächlichen Autor. Die Open-Graph-Ausnahme darf nicht auf Audio übertragen werden.

Aktuell abgeglichen: `server.js:486–492` (`exposeArticleForUser`) und `/audio-files/*` ab `server.js:842`. Quellen: [G4], [D1], [D2], Projektregeln.

## 4a. Benutzerverwaltung und eigene Kennwortänderung (25.09.2026)

Entscheidungen des Benutzers in dieser Sitzung:

- Aufruf über den Aktionen-Button im Header. Admin behält das ↺-Icon und erhält die Einträge *Benutzerverwaltung* und *Kennwort ändern*. Rolle `user` sieht den Button ebenfalls, aber mit **Personen-Icon** und nur „Angemeldet als …“ plus *Kennwort ändern*. Gäste sehen ihn nicht.
- Benutzerverwaltung: Nutzer anzeigen (Rolle, Autoren-Kurzfassung, „Kennwortänderung ausstehend“), anlegen, bearbeiten (Rolle, Autoren), **Kennwort neu vergeben**, **löschen** (mit Bestätigung).
- Beim Anlegen und Neuvergeben wählt der Admin per Radio-Buttons: *Nutzer muss das Kennwort ändern* (**vorausgewählt**) oder *Nutzer behält dieses Kennwort*. Kennwort eintippen oder erzeugen lassen (Anzeigen/Kopieren).
- Mindestlänge **8 Zeichen** (bcrypt: höchstens 72 Byte).
- Autorenauswahl: Schalter *Alle Autoren, auch künftige* (`null`) oder *Nur ausgewählte*; dann durchsuchbare Checkliste mit *Alle*/*Keine* und Zähler. Öffentliche Autoren erscheinen angehakt und gesperrt („durch öffentlichen Zugang“) und werden beim Speichern **nicht** in die Nutzerliste geschrieben; bereits vorhandene Alteinträge entfallen beim nächsten Speichern des Nutzers (Entscheidung b vom 25.09.). Telegram erscheint mit Hinweis „standardmäßig ausgeblendet“, verwaiste Einträge als „nicht mehr vorhanden“. Die Kurzfassung in der Nutzerliste zählt öffentliche Autoren nie als eigene.
- Reiter **Öffentlicher Zugang** pflegt `public-directories.txt` mit derselben Checkliste; leere Auswahl zeigt die Warnung, dass das Archiv dann nur mit Anmeldung nutzbar ist. Wirkt sofort ohne Neustart.
- **Angemeldete Nutzer mit Autorenliste sehen die öffentlichen Autoren automatisch zusätzlich.**

Technik:

- `user-store.cjs` liest/schreibt `users.json` und `public-directories.txt`: temporäre Datei im selben Ordner, atomares Ersetzen, Rechte/Eigentümer erhalten, Schreibvorgänge nacheinander, vor jeder Änderung frisch einlesen (Handänderungen gehen nicht verloren). Format (Liste bzw. Objekt mit `_comment`) und unbekannte Felder bleiben erhalten.
- Session speichert nur E-Mail und `sessionVersion`; eine Middleware in `server.js` löst Rolle/Rechte bei jeder Anfrage neu auf. Rechteänderungen wirken sofort; gelöschte Nutzer verlieren die Sitzung; neues Kennwort erhöht `sessionVersion` und beendet die übrigen Sitzungen (die eigene bleibt). Alte Sitzungen ohne `sessionVersion` bleiben gültig.
- `mustChangePassword` wird **serverseitig** durchgesetzt: bis zur Änderung antworten `/api/*`, `/files/*`, `/audio-files/*` mit 403 (`mustChangePassword: true`); erlaubt bleiben `/api/me`, `/api/me/password`, `/api/login`, `/api/logout`. Die Oberfläche zeigt einen nicht schließbaren Dialog mit „Abmelden“ als einziger Alternative.
- Schutzregeln: eigene Rolle nicht änderbar, eigener Zugang nicht löschbar, letzter Admin nicht herabstufbar/löschbar, E-Mail eindeutig (ohne Groß-/Kleinschreibung) und nachträglich nicht änderbar, Cross-Site-Schreibanfragen abgewiesen, Session-ID wird nach dem Login neu vergeben, unbekannte E-Mails werden gegen einen Dummy-Hash geprüft.
- Deployment: Der Dienstbenutzer `ralf` braucht Schreibrecht auf `users.json`, `public-directories.txt` und `/opt/nodeapp` (für die temporäre Datei); `users.json` sinnvollerweise `600`. Nach dem Einspielen Dienst neu starten. Hinweis: `public-directories.txt` ist im Git eingecheckt; beim Code-Deployment die produktive Fassung nicht versehentlich überschreiben.
- Für Tests lassen sich die Dateipfade über `USERS_FILE` und `PUBLIC_DIRS_FILE` umlenken.
- Geprüft am 25.09.2026: 10 neue Tests in `user-store.test.cjs` (zusammen mit Parser- und Editortests 21/21 bestanden) sowie Browserprüfung mit Testdateien: Menü je Rolle, Nutzer bearbeiten/anlegen/löschen, Kennwort neu vergeben, Pflichtdialog (Escape gesperrt, Fehlermeldungen, Serversperre 403, Freigabe nach Änderung), Öffentlicher Zugang inklusive sofortiger Wirkung für Gäste. Die echte `users.json` wurde dabei nicht verwendet.

## 5. Infografiken erstellen und verknüpfen

### Upload

Der Upload wurde für Administratoren in der Artikel-Detailansicht eingeführt. Der Server entscheidet, ob die Aktion zulässig ist. **Seit 25.09.2026 gilt:** Der Button steht bei allen Autoren zur Verfügung, auch bei öffentlichen; ausgenommen bleibt nur der Autor `Infografiken` selbst (ausdrücklich bestätigt). Die frühere Einschränkung auf Autoren außerhalb der Public-Liste ist historisch.

Vorgaben aus der Umsetzung und den anschließenden Korrekturen:

- Bildformate PNG und JPEG; `.jpeg` wird zu `.jpg` normalisiert. Größenlimit: 10 MB gemäß Upload-Konfiguration.
- Ziel: `www/Infografiken/<Jahr>/`, zusammengehörige `.md`- und Bilddatei mit demselben Stamm.
- Erste Grafik: ursprünglicher Dateistamm. Weitere Grafiken: `_2`, `_3`, `_4` usw.; vorhandene Dateien nicht überschreiben.
- Titel der Varianten: Zusatz ` (2)`, ` (3)`, ` (4)` usw. an der Titelzeile, innerhalb vorhandener Markdown-Formatierung.
- Quelle, Datum, Überschriftenmarker, Hervorhebungen und der vorhandene Kopf werden aus dem Original übernommen. Der Body und der zugehörige abschließende Body-Trenner werden abgeschnitten; keinen unformatierten Ersatzkopf erzeugen.
- **Titel und gültige `Datum:`-Zeile sind Pflicht. `Quelle:` ist optional.** Eine fehlende Quelle darf insbesondere Stefan-Hiene-Artikel nicht blockieren.
- Eine vorhandene Quelle bleibt unverändert; sie darf beim Nummerieren nicht versehentlich den Titelzusatz erhalten. Die Erkennung wurde für einfache/doppelte Sternchen und Unterstriche korrigiert.
- Nach Erfolg reindexieren und eine Erfolgsmeldung zeigen; kein automatischer Wechsel zur neu erzeugten Grafik.
- Der Button soll zum Stil von Kopieren und Teilen passen.

Historisch wurden zwölf Titel-/Quellenvarianten geprüft, zusätzlich ein tatsächlicher Stefan-Hiene-Artikel ohne Quelle. Quelle: [G1].

### Audiovererbung

Die Zuordnung erfolgt nach dem Einlesen der Artikel anhand von **Jahr und Dateistamm**. Infografiken können eigenständig sein oder einen vorhandenen Artikel illustrieren.

Reihenfolge und Grenzen:

1. Eine bereits direkt zugeordnete MP3 der jeweiligen Infografik bleibt erhalten.
2. Varianten wie `artikel_2.md` können Audio der Basis-Infografik `artikel.md` übernehmen, auch aus `audio/Infografiken/...`.
3. Sonst wird ein passender Basisartikel bei anderen Autoren gesucht.
4. Bei mehreren gleichnamigen Basisartikeln gewinnt der einzige Kandidat mit Audio. Das löste den Fall gleichnamiger Artikel in `Coaching` und `Telegram`, bei dem nur `Coaching` eine MP3 hatte.
5. Haben mehrere Kandidaten Audio, wird nicht willkürlich gewählt. Ohne eindeutige Zuordnung bleibt die Infografik ohne geerbtes Audio.
6. Es wird eine URL vererbt, keine MP3 kopiert. Herkunft und Kennzeichen für externes Audio werden intern mitgeführt.
7. Vor der Ausgabe greifen die Rechte am Audio-Ursprungsautor, siehe Abschnitt 4.

Aktuell abgeglichen: `server.js:439–484` (`inheritAudioForInfographics`). Quelle: [G4].

## 6. Audioablage, Player und Migration

### Dateisystem und URLs auseinanderhalten

| Physischer Pfad | HTTP-Route |
| --- | --- |
| `www/Stefan Hiene/2026/artikel.mp3` | `/files/Stefan Hiene/2026/artikel.mp3` |
| `audio/Joe Turan/2026/artikel.mp3` | `/audio-files/Joe Turan/2026/artikel.mp3` |

`files` und `audio-files` sind Express-Routen, keine zusätzlich anzulegenden Verzeichnisse. Es wurde weder `www/audio/` noch ein physisches `files/audio/` eingeführt.

Für jeden Artikel gilt unabhängig vom Autor:

1. Suche eine gleichnamige MP3 neben der `.md` unter `www/`.
2. Fehlt sie, suche unter `audio/` mit demselben relativen Autor-/Unterordnerpfad.
3. Fehlt beides, gibt es keinen Player.

Die alte Ablage von Stefan Hiene bleibt dadurch unverändert verwendbar. Die ursprüngliche Analyse erwog ein per Umgebungsvariable konfigurierbares `AUDIO_DIR`; umgesetzt wurde die parallele Projektablage. Einen solchen Konfigurationsschalter nicht allein aus dem damaligen Vorschlag voraussetzen.

### Darstellung und Filter

- `audioUrl` steuert Kachel-Badge und Detail-Player für alle Autoren.
- Die sichtbare Player-Beschriftung wurde von „Audioquickie“ auf **„Audio“** geändert; das Metadatenfeld `Audioquickie:` bleibt für Episodennummern verwendbar.
- `preload = 'metadata'`, `load()`, `loadedmetadata` und `durationchange` sorgen dafür, dass die Dauer bereits vor Play erscheint, sobald der Browser die Metadaten geliefert hat.
- Ein gemeinsames Audioelement verhindert parallele Wiedergaben; Artikelwechsel stoppt Audio/Video.
- Der zweite Eintrag im Autorenmenü lautet **„mit Audio“**. Er verwendet `externalAudio=1` und meint Audio aus dem separaten `audio/`-Baum, nicht jede beliebige MP3.
- Stefan-Hiene-MP3s unter `www/` fallen damit bewusst aus diesem Filter heraus. Das ist eine Eigenschaft des Speicherorts, keine feste Sperre dieses Autornamens. Geerbte externe Audios zählen unter Beachtung der Rechte mit.
- Medien-URLs enthalten einen mtime-Cachebuster. Nach Austausch oder Verschieben müssen Index und gegebenenfalls Ansicht aktualisiert werden.

### Migration eines ausgewählten Autors

```powershell
node migrate-audio.js "Joe Turan" --dry-run
node migrate-audio.js "Joe Turan"
```

Das Skript im Projektroot sucht rekursiv nach `.mp3` einschließlich abweichender Groß-/Kleinschreibung. Es spiegelt den relativen Pfad unter `audio/<Autor>/`, behandelt Autorennamen mit Leerzeichen, überschreibt vorhandene Ziele nicht und protokolliert nach `migrate-audio.log`. Markdown und Bilder werden nicht verschoben.

Ein tatsächlicher Debian-Fehler war `EXDEV: cross-device link not permitted`: `www/` und `audio/` lagen auf verschiedenen Dateisystemen. Deshalb gibt es nach einem fehlgeschlagenen `rename` wegen `EXDEV` einen Fallback: kopieren, Dateigröße vergleichen, erst danach die Quelle entfernen. Ein Größenvergleich ist kein kryptografischer Inhaltsvergleich.

Vorgehen: Dry-Run prüfen, Migration gezielt ausführen, Log auf Konflikte/Fehler kontrollieren, anschließend reindexieren. Das Skript wurde erstellt und der Dry-Run damals mit zwei Joe-Turan-MP3s geprüft; daraus folgt keine heute bestätigte vollständige Produktionsmigration.

Quellen: [G2], [G3], [G4].

## 7. Scraper, Bereinigung und verwandtes Projekt

Der Scraper bleibt ein eigener Node-Prozess mit eigenem `package.json` und `node_modules`. Playwright/Chromium sollen nicht in die schlanken Root-Abhängigkeiten der Website wandern.

### Konfiguration und Aufruf

`scraper/scraper-config.json` enthält Arrays `Blog`, `Facebook` und `Telegram`. Jeder Eintrag besitzt `Name`, `URL` und `OutputPath`. Mehrere Einträge eines Quellentyps werden nacheinander verarbeitet; Platzhalter gehören nicht in die aktive Datei.

```json
{
  "Blog": [
    {
      "Name": "Joe Turan",
      "URL": "https://www.joeturan.com/blog",
      "OutputPath": "../www/Joe Turan"
    }
  ],
  "Facebook": [],
  "Telegram": []
}
```

`OutputPath` wird relativ zum Skript aufgelöst und muss im zugelassenen Ausgabebereich bleiben. Die Quell-URLs kommen aus der JSON-Konfiguration. `Abonenten-URL.txt` ist eine historische Eingabe; die pauschale Behauptung in älteren Dokumenten, sie sei weiterhin für die URLs erforderlich, ist überholt.

```powershell
node scraper/scrape_all.js
node scraper/scrape_all.js --blog --telegram
node scraper/scrape_all.js --facebook
node scraper/scrape_all.js --visible
node scraper/scrape_all.js --config ./meine-scraper-config.json
```

Facebook verwendet die lokale Cookie-Datei im Netscape-Format. Zugangsdaten und Cookies werden nicht in diese Dokumentation übernommen. Der dokumentierte `SKIP_LIMIT` beträgt drei bereits vorhandene Artikel pro Quelle; vorhandene Dateien werden übersprungen.

### Titel und Morgenimpuls

Beim Blog konnte ein identischer Titel sowohl als `<h1>` als auch nochmals als fettgedruckter Absatz vorkommen. Die bisherige Bereinigung entfernte nur Überschriftenelemente. Dadurch stand vor „Ein Morgenimpuls für dich ☀️“ noch ein Titel, und die Intro-Erkennung am Textanfang griff nicht.

Die beschlossene Reihenfolge ist:

1. Führenden Titel nach Normalisierung der Markdown-Markierungen mit dem eigentlichen Titel vergleichen.
2. Nur bei tatsächlicher Übereinstimmung entfernen; ähnliche normale Textanfänge erhalten.
3. Danach den führenden Morgenimpuls entfernen.

Historisch wurden 121 bestehende Joe-Turan-Dateien nach Backup bereinigt; der abschließende damalige Scan meldete null doppelte Titel und null führende Morgenimpulse. Das Backup lag in einem temporären Windows-Verzeichnis. Seine heutige Existenz ist nicht bestätigt. Ein Scraper-Codefix allein repariert Altdateien nicht, weil diese übersprungen werden.

Joe-spezifische Signatur- und Ausschlussregeln dürfen nicht ungeprüft auf andere Autoren angewandt werden.

### Synchronität mit BlogDownloader

Auf Benutzerwunsch wurden die Konfiguration und Bereinigungen auch in `../BlogDownloader` übernommen:

| Variante | Relativer Ausgabegrundpfad |
| --- | --- |
| `WebArchiv/scraper/` – Node | `../www/<Autor>` |
| `BlogDownloader/node/` – Node | `www/<Autor>` |
| `BlogDownloader/` – Python | `<Autor>` |

Die Node-Versionen sollten funktional gleich bleiben; die beabsichtigte Abweichung war der Ausgabepfad. Die Python-Version sollte dasselbe Verhalten abbilden. Der damalige Stand wurde mit jeweils acht Tests in drei Varianten geprüft. Eine fortlaufende Synchronisierung seitdem ist nicht nachgewiesen; bei künftigen Scraper-Änderungen die Parallelversionen bewusst vergleichen.

Nawal Boussi wurde zunächst als Facebook-Quelle ergänzt. Später erklärte der Benutzer den Autor und das zugehörige `standard.jpg` ausdrücklich für gelöscht. Diese historische Löschung nicht ungefragt rückgängig machen oder aus alten Config-Beispielen auf den heutigen Quellenbestand schließen.

### Wer löst den Reindex aus?

- `scrape_all.js` schreibt Dateien und beendet sich. Es löst selbst keinen Reindex aus.
- Beim Start aus der Admin-Oberfläche spawnt `server.js` den Scraper, zeigt dessen Live-Ausgabe und stößt nach Prozessende den Reindex an.
- Bei CLI/Cron muss der Aufrufer anschließend den laufenden WebArchiv-Prozess zum Reindex auffordern.
- Der dokumentierte Sollweg ist `SIGHUP`; der tatsächliche Wrapper weicht noch ab, siehe Abschnitt 10.

Quellen: [G2], [G4], [G13], [D2], [D3], [D4].

## 8. Oberfläche und Markdown-Editor

### Grundbedienung

Aus der frühen Aufbauphase stammen Dark-/Light-Modus, persistierte Schriftwahl, quadratische/längliche Kacheln, Filter und Seitennavigation. Der Stil ist „Warm Editorial“ mit dunklem Standard und warmen Akzentfarben. Artikel lassen sich per Pfeiltasten, Buttons und Touch-Swipe wechseln. Pinch-Zoom, Panning und Textmarkierung dürfen dabei keinen unbeabsichtigten Artikelwechsel auslösen. Deep-Links werden auch nach einer erforderlichen Anmeldung wieder aufgelöst.

### Kopieren und Aktionen

- Der frühere zweiteilige Copy-Button wurde ersetzt: **nur das Kopiersymbol**, kein sichtbares „copy“ und keine Trennlinie.
- Ein Klick öffnet immer das Kopiermenü. „Artikel“ kopiert ohne Prompt; die weiteren Einträge kommen aus `prompts/`.
- Dateinamen wie `1_...txt` bestimmen Reihenfolge und bereinigte Menübezeichnung. Der ausgewählte Prompt wird dem Artikeltext vorangestellt.
- Tooltip für das Kopiersymbol: „Kopieroptionen“. Tooltip für Aktionen: „Artikel bearbeiten und Audio erzeugen“.
- Die Aktionsleisten-Buttons wurden auf einheitlich 22 px Höhe und 20 px Radius gebracht; regulärer Abstand 8 px.
- Ein leeres Upload-Statusfeld darf zwischen „neue Grafik“ und Kopieren keinen zusätzlichen Abstand erzeugen.
- Das Aktionen-Dropdown beginnt unter dem Button. Nur bei Randüberschreitung wird es verschoben; 8 px Randabstand und begrenzte Breite halten es im Viewport.
- Erneuter Buttonklick und Außenklick schließen das Menü.
- „Audio erzeugen“ bleibt in der Artikel-Detailansicht. Die erste Entfernung traf versehentlich diese Stelle und wurde korrigiert; entfernt werden sollte der globale Menüeintrag der Übersicht. Die Anzeige bestehender Audio-Aufträge bleibt verfügbar.

### Bildvollansicht

Die endgültige Bedienung nach mehreren Korrekturen:

- Kein „Verkleinern“-Icon und keine Prozent-/Statusanzeige.
- Desktop: Mausrad zoomt um die **Bildmitte**; die ursprüngliche Idee des Zooms am Cursor wurde ersetzt.
- Doppelklick wechselt zwischen eingepasster Größe und 200 Prozent.
- Ein vergrößertes Bild lässt sich mit der Maus verschieben.
- Desktop-Einfachklick auf das Bild ist neutral; Hintergrundklick und Escape schließen.
- Touch-Geräte: Ein einfacher Tap auf das Bild schließt die Vollansicht wieder. Diese Ausnahme wurde nach einem iPhone-Problem ergänzt. Pinch-Zoom bleibt zu berücksichtigen.

### PDF.js

Ein CDN-Laden wurde besprochen, dann ausdrücklich ein anderer Weg gewählt: Der vollständige Viewer wurde nach `public/vendor/pdfjs/` verschoben und die iframe-URL angepasst. Dadurch wird die Drittanbieterbibliothek nicht mehr vom Graft-Kontextgraphen indexiert. Alte Hinweise auf `public/pdfjs/` sind überholt. Die PDF-Dateien selbst werden weiterhin über die geschützte Medienroute geladen.

### Vollständigen Artikel editieren

**Aktionen → Artikel editieren** öffnet für einen berechtigten Admin einen Dialog mit der kompletten Originaldatei. Kein Rückübersetzen des angezeigten HTML und kein Formular, das unbekannte Metadaten wegwirft.

- Endpunkte: `GET` und `PUT /api/article-markdown/*`; Dateipfad aus der indexierten Artikel-ID bestimmen.
- Admin- und Autorenrechte, Pfadgrenzen, Symlink-Prüfung, Größenlimit von 1 MB und Cross-Site-Prüfung beim Schreiben.
- SHA-256-Version des geladenen Inhalts; bei zwischenzeitlicher Änderung einen Konflikt melden und Entwurf erhalten.
- Temporäre Datei im selben Verzeichnis, Dateirechte/Eigentümer berücksichtigen, vor dem atomaren Ersetzen erneut auf Änderungen prüfen. Ursprüngliche BOM-/Zeilenendenkonventionen berücksichtigen.
- Mit Scrape, Reindex, Infografik-Schreiben und TTS koordinieren; unvollständige Dateien oder konkurrierende Schreibvorgänge vermeiden.
- Ungespeicherte Änderungen beim Schließen/Verlassen schützen. Pfeiltasten im Editor dürfen keine Artikelnavigation auslösen; veraltete asynchrone Antworten dürfen keinen neueren Dialogzustand überschreiben.
- Nach Speichern Index, Detailansicht, Liste und Filter aktualisieren. Dateiname/Artikel-ID bleiben stabil; Jahresordner werden nicht durch Datumsänderung umbenannt.
- „Datei gespeichert, Aktualisierung fehlgeschlagen“ muss von einem gescheiterten Schreibvorgang unterschieden werden.

Zur Einführung mussten sechs Laufzeitdateien auf den Server: `server.js`, `article-editor.cjs`, `public/app.js`, `public/article-editor.js`, `public/index.html`, `public/styles.css`. Keine neuen npm-Abhängigkeiten. `article-editor.test.cjs` und `graft/` sind Entwicklungsbestandteile. Damals wurden neun automatisierte Tests sowie Browserprüfungen für Speichern, Abbrechen, Konflikte und mobiles Layout als erfolgreich protokolliert.

Quellen: [G5], [G6], [G7], [G8], [G9], [G10], [D1].

## 9. TTS: gemeinsame Auftragssteuerung und aktueller Providervertrag

### Herkunft und gemeinsame Garantien

Die erste Integration übernahm das vorbereitete Node-Paket aus `E:\Code\GPT-4o-Mini-TTS-helper\src\markdown_tts_compact\node` nach `tts/`. Die dortige `INTEGRATION.md` war die Ausgangsbasis, nicht automatisch der Vertrag nach allen späteren Änderungen.

Gemeinsam für OpenAI und Qwen:

1. Ein berechtigter Admin wählt einen konkreten Artikel ohne bereits vorhandene MP3.
2. Vor jedem Start wird angezeigt, welcher Provider welche Daten verarbeitet und ob OpenAI-Kosten entstehen.
3. Erst eine ausdrückliche Startbestätigung erzeugt einen Backend-Auftrag. Abbrechen/Escape erzeugt keinen.
4. Der Browser übergibt Artikel-ID und Provider, keine frei wählbaren Dateisystempfade, Programme oder Schlüssel.
5. Eingabe: vollständiger lokaler Artikelpfad. Ausgabe: `audio/<relativer www-Pfad>.mp3`. Vorhandene MP3s sowohl am alten als auch am neuen Ort werden berücksichtigt und nicht überschrieben.
6. Der Worker läuft serverseitig per Child-Spawn ohne Shell. Eingabe und `--output` werden als getrennte Argumente übergeben.
7. Ein aktiver WebArchiv-TTS-Auftrag; der Startplatz wird vor asynchronen Dateizugriffen reserviert. Andere Schreib-/Indexaufgaben werden koordiniert.
8. Der Worker reserviert zusätzlich `<output>.tts-lock`; Veröffentlichung erfolgt atomar ohne Überschreiben. Der Zielbereich muss die dafür verwendeten Hardlinks unterstützen.
9. Erfolg erfordert Prozessabschluss mit Exit-Code 0, gültiges Ergebnis und eine nicht leere reguläre Ausgabedatei. Eine einzelne `complete`-Meldung genügt nicht.
10. Erst danach reindexieren. Ein Indexfehler lässt die fertige MP3 bestehen und erlaubt erneuten Reindex, **keine erneute Synthese**.

### Popup, Status und Abbruch

Das Popup orientiert sich am Scrape-Dialog und zeigt Titel, Status, neue CLI-Meldungen, Fehler und Ergebnislink. Schließen, Escape oder Backdrop beenden nur die Anzeige und ihr Polling. „Auftrag abbrechen“ ist eine getrennte Serveraktion. Wiederöffnen und Browser-Reload sollen einen vorhandenen Auftrag anzeigen, ohne ihn nochmals zu starten.

Unveränderte Logs werden nicht ständig neu angehängt; die Scrollposition bleibt erhalten. Polling läuft für Status und beim Qwen-Dienst zusätzlich für die Lease weiter. Die UI wartet zwischen Abfragen, vermeidet überlappende Requests und bietet nach Verbindungsfehlern eine Wiederaufnahme der Anzeige.

Der Spawn-Adapter liest stdout/stderr zeilenweise, verarbeitet NDJSON-Fortschritt und sendet einen kooperativen IPC-Abbruch; nach zehn Sekunden gibt es einen harten Rückfall. Jobs liegen nur im RAM. Ein Serverneustart stellt den Verlauf nicht wieder her. Fertige Jobs werden begrenzt aufbewahrt; Fehlerarbeitsverzeichnisse können zur Diagnose verbleiben. Verwaiste `.tts-lock`-Dateien erst nach Prüfung laufender Prozesse behandeln.

### WebArchiv-Endpunkte

| Route | Aufgabe |
| --- | --- |
| `GET /api/tts/provider` | Verfügbarkeit und Hinweise beider Provider |
| `POST /api/tts` | `{ "articleId": "…", "provider": "qwen" }`, alternativ Provider `openai`; 202 mit `jobId` |
| `GET /api/tts/latest` | Letzter für den Admin zugänglicher Auftrag |
| `GET /api/tts/:jobId/status` | Zustand, begrenztes Log, Fehler und Ergebnis |
| `POST /api/tts/:jobId/cancel` | Abbruch anfordern |

Alle TTS-Routen sind Admin-geschützt; artikelbezogene Aufträge prüfen zusätzlich Autorenrechte. Schlüssel bleiben serverseitig.

### Providerwahl: letzter Stand vom 18.09.2026

- Bei jedem Öffnen wird Qwen über den authentifizierten `/v1/health`-Endpunkt geprüft. Zeitbudget: drei Sekunden einschließlich Antwortkörper.
- Nur eine passende v4-Antwort mit vollständigem Markdown und MP3-Unterstützung gilt als verfügbar. Das beweist noch keine erfolgreiche GPU-Synthese.
- Für OpenAI wird nur geprüft, ob der konfigurierte API-Schlüssel vorhanden ist. Es erfolgt dabei keine Guthaben-, Gültigkeits- oder kostenpflichtige Syntheseprüfung.
- Beide Provider erscheinen als **Radio-Buttons**, nicht als Dropdown. Nicht verfügbare Provider sind gesperrt.
- **Qwen ist vorausgewählt, wenn verfügbar; der Fokus liegt auf dieser Auswahl.**
- Ist Qwen nicht verfügbar, bleibt OpenAI zunächst unausgewählt und muss bewusst gewählt werden. Ohne verfügbare Auswahl bleibt Start gesperrt.
- Der Start-POST prüft die Verfügbarkeit nochmals. Ein inzwischen ausgefallener Provider wird abgewiesen; den Dialog erneut öffnen. Keine heimliche Ersatzwahl.
- `tts.provider` bleibt der Standard für direkte CLI-Aufrufe; er ersetzt nicht die browserseitige Auswahl.

Ältere TTS-Dokumente behaupten noch „keine Vorauswahl“. Das ist seit [G14] überholt. Aktuell abgeglichen: `public/app.js:1157–1201`, `tts/provider-config.cjs:18–46`, `tts/jobs.cjs:150–170`.

### OpenAI-Pipeline

OpenAI verwendet die übernommene Markdown-zu-Sprechtext-Verarbeitung. Kurze Texte werden direkt als MP3 erzeugt. Lange Texte werden nach dem Zeichenbudget aufgeteilt; Kalibrierung/Pre-Fill, WAV-Verarbeitung, Vorspannschnitt und MP3-Zusammenführung erfolgen auf dem WebArchiv-Server. Strukturierte Fortschrittsmeldungen zeigen die tatsächlich verarbeiteten Chunks.

Am 25.09. lokal abgelesene Einstellungen: Modell `gpt-4o-mini-tts-2025-12-15`, Stimme `cedar`, Geschwindigkeit `1.0`, FFmpeg-Bitrate `64k`, Gesamtzeitlimit 1800 Sekunden, Cache `.cache`, Fehlerartefakte behalten. Die OpenAI-Aufteilung wurde mit einem Budget von 3800 Unicode-Codepoints dokumentiert. Diese Konfigurationswerte sind ein Projektstand, keine Vorgabe für jede zukünftige Installation.

Die FFmpeg-Bitrate betrifft den lokalen Export langer OpenAI-Texte; sie steuert weder zwingend die direkte kurze MP3 des Anbieters noch den Qwen-Export. Vor längerer Verarbeitung werden FFmpeg/FFprobe geprüft. Ein `spawn ffmpeg ENOENT` allein belegt deshalb keinen bereits erfolgten kostenpflichtigen API-Aufruf.

### Qwen v4: vollständiger Artikel auf dem Modellserver

Auf ausdrücklichen Benutzerwunsch verarbeitet `generate_mp3_with_embedding.py` den gesamten Artikel selbst:

- WebArchiv sendet vollständiges UTF-8-Markdown einschließlich Titel, Metadaten, Links, BOM und Zeilenumbrüchen. Limit: 1.000.000 UTF-8-Bytes.
- WebArchiv wendet auf diesen Qwen-Eingang kein eigenes Markdown-Clearing, Chunking, Pre-Fill oder Kalibrieren an.
- `qwen_http_service.py` und `qwen_chunk_worker.py` bilden die HTTP-Brücke. Der Worker ruft den regulären CLI-Einstieg des unveränderten Originalscripts auf, mit dessen Konfiguration, Eingabe und Ausgabe.
- Sprache, Sprecher, Bereinigung, Chunkgrößen, Warmup, Kalibrierung, Pausen, Seed und MP3-Export werden ausschließlich vom Originalscript bestimmt; keine verdeckten Overrides.
- Ein Artikel entspricht einem Scriptlauf. Das Modell wird innerhalb dieses Laufs für dessen Chunks wiederverwendet und danach freigegeben.
- Die v3-Zusage „gleicher Seed für alle Chunks“ ist aufgehoben. `seed` und `seed_strategy` des Originalscripts gelten; bei `increment` können sich die Chunk-Seeds unterscheiden.
- Qwen liefert immer eine fertige MP3. WebArchiv prüft Codec und positive Dauer mit FFprobe und dekodiert vollständig mit FFmpeg zur Validierung; es kodiert nicht erneut.
- Die validierten MP3-Bytes werden unverändert unter dem parallelen `audio/`-Pfad veröffentlicht.
- Der derzeitige HTTP-Vertrag überträgt keine interne Chunkanzahl. Die UI zeigt einen laufenden Artikelauftrag; `chunks: 1` im Worker-Ergebnis bedeutet einen Remote-Auftrag, nicht einen internen Qwen-Chunk.

### Qwen-HTTP-Vertrag

Alle Requests verwenden ein gemeinsames Bearer-Token. Keine direkte Browserverbindung zum Modellserver; nur WebArchiv kommuniziert serverseitig mit ihm.

| Request | Bedeutung |
| --- | --- |
| `GET /v1/health` | `protocol: webarchiv-qwen-v4`, `full_markdown: true`, `audio_format: mp3`, Byte-Limit und Lease |
| `PUT /v1/jobs/<UUIDv4>` | JSON mit vollständigem `markdown`; 202 nach Annahme |
| `GET /v1/jobs/<id>` | Zustand `running`, `succeeded`, `failed` oder `cancelled`; erneuert Lease |
| `GET /v1/jobs/<id>/audio` | Fertige MP3 mit `audio/mpeg` und definierter Länge |
| `DELETE /v1/jobs/<id>` | Abbruch/Aufräumen; unbekannte IDs werden gegen verspäteten Start markiert |

Ein aktiver Artikel, keine Queue. Dieselbe ID mit demselben Inhalt startet nicht doppelt; abweichender Inhalt unter derselben ID wird abgewiesen. Eine verlorene Startantwort löst keinen blinden erneuten Synthesestart aus. Statuskontakt hält die 90-Sekunden-Lease aktiv. Abbruch beendet Prozessgruppe bzw. Prozessbaum; Downloadreste und fertige Jobdaten werden aufgeräumt.

HTTP-Zeitlimits wurden mit 15 Sekunden, Abbruch mit fünf Sekunden dokumentiert; darüber liegt das WebArchiv-Gesamtlimit. Der Transport nutzt `node:http`/`node:https` statt Undici, nachdem bei einem großen Download `assert(!this.paused)` in Node.js 24.18.0 auftrat. Redirects und unvollständige Downloads werden nicht still akzeptiert.

### Historische Qwen-Stufen – nicht wieder als aktuellen Vertrag verwenden

| Stufe | Damaliger Ansatz | Heutige Einordnung |
| --- | --- | --- |
| Entwurf | Lokaler Server mit möglichem OpenAI-Ersatzweg | Keine Freigabe für automatischen kostenpflichtigen Fallback |
| v1 | Erste HTTP-Brücke mit Verarbeitung auf dem Modellserver | Durch spätere Vertragsversionen ersetzt |
| v2 | WebArchiv zerlegt; Modellserver liefert je Aufruf WAV | Auf späteren Benutzerwunsch verworfen |
| v3 | Gemeinsame GPU-Sitzung, Warmup einmal, gleicher Seed für Chunks/Kalibrierung | Durch Originalscript-Verarbeitung und dessen Seed-Strategie ersetzt |
| v4 | Original-Markdown → Originalscript → fertige MP3 | Geltender Vertrag |
| Providerdialog | Erst automatische Vorentscheidung, dann freie Auswahl ohne Vorauswahl | Radio-Auswahl mit Qwen-Vorauswahl ist der letzte Stand |

Quellen: [G10], [G11], [G14], [D5], [D6], [D7], [D8].

## 10. Betrieb, Installation und Deployment

### Zielumgebung

Dokumentiertes Ziel ist ein Proxmox-/Debian-LXC mit App unter `/opt/nodeapp`, Dienst `nodeapp`, unprivilegiertem Benutzer `ralf` und extern eingebundenem `www/`. Die komplette Anwendung einschließlich TTS benötigt **Node.js ab 22**; die ältere Angabe „Node 18 reicht“ gilt nicht für das inzwischen integrierte TTS-Paket.

Der dokumentierte Dienst verwendet unter anderem:

```ini
[Service]
Type=simple
User=ralf
Group=ralf
WorkingDirectory=/opt/nodeapp
ExecStart=/usr/bin/node /opt/nodeapp/server.js
Environment=NODE_ENV=production
EnvironmentFile=/etc/nodeapp/tts.env
Environment=PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
Restart=on-failure
RestartSec=3
```

Dies ist die im Gespräch gezeigte Konfiguration, keine heute neu ausgelesene Produktions-Unit. `SESSION_SECRET` zusätzlich produktiv im Dienst setzen.

### Pakete und Werkzeuge

Vom jeweiligen Projektstand aus installieren, keine Windows-`node_modules` auf Debian kopieren:

```bash
cd /opt/nodeapp
npm ci --omit=dev
npm ci --prefix scraper --omit=dev
npm ci --prefix tts --omit=dev
node --version
ffmpeg -version
ffprobe -version
```

Für Audio bei Bedarf das Debian-Paket `ffmpeg` installieren; es liefert auch FFprobe. Der Dienstbenutzer braucht Leserechte auf das Archiv und Schreibrechte auf die Audioablage und Arbeits-/Cacheverzeichnisse.

Für den Scraper Chromium einschließlich Systembibliotheken installieren und denselben Browserpfad in Installation, systemd und Cron verwenden. Ein unter Root installierter Browser im persönlichen Root-Cache ist für einen Dienst unter `ralf` nicht automatisch auffindbar. `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright` wurde als gemeinsamer Pfad festgelegt. Ein Shell-Export bzw. `/etc/environment` ersetzt nicht die systemd-Konfiguration; Cron braucht seine Variablen ebenfalls ausdrücklich.

### TTS-Umgebung

Die bestehende geschützte Datei `/etc/nodeapp/tts.env` bearbeiten, nicht beim Update leeren:

```ini
QWEN_TTS_BASE_URL=http://192.168.1.65:8765
QWEN_TTS_TOKEN=<gemeinsames Token>
OPENAI_API_KEY=<nur falls OpenAI angeboten werden soll>
```

Platzhalter nicht wörtlich übernehmen. Das Token muss auf beiden Rechnern übereinstimmen und für die Brücke mindestens 32 Zeichen lang sein. Die Qwen-Basis-URL enthält keinen zusätzlichen Pfad, Query oder eingebettete Zugangsdaten. Der dokumentierte Server war unter `192.168.1.65` erreichbar; seine heutige Verfügbarkeit ist nicht geprüft.

Die Environment-Datei wird mit `root:root` und Modus `600` geschützt. Keine Schlüssel im Frontend, in CLI-Argumenten, Logs oder Git. Der ursprünglich verwendete Variablenname `GPT-4o-Mini-TTS-Key` wurde durch `OPENAI_API_KEY` ersetzt.

### Was wohin kopieren?

- WebArchiv-Server: geänderte Backend-Module, Frontenddateien und TTS-JavaScript samt `config.json`, `package.json` und Lockfile. Bei vollständiger Installation auch `server.js` sowie Editor-Backend/-Frontend berücksichtigen.
- Qwen-Rechner: `qwen_http_service.py` und `qwen_chunk_worker.py` nebeneinander; funktionierende Python-Modellumgebung, unverändertes `generate_mp3_with_embedding.py` und dessen eigene Konfiguration.
- Nur Entwicklung: Testdateien, Graft-Graph und Prüfartefakte. Windows-Abhängigkeiten, Caches und temporäre Audios werden nicht deployt.
- Lokale individuelle `tts/config.json`-Werte vor Überschreiben abgleichen.
- Die Kopierliste in `tts/DEPLOYMENT-NODE-SERVER.md` beschreibt ein Update auf einer bereits integrierten Installation. Sie ist keine vollständige Neuinstallationsliste.

Bei älterem Qwen-Protokoll beide Python-Dateien gemeinsam aktualisieren und beide betroffenen Dienste neu starten. Für eine reine Änderung der Radio-Buttons oder Vorauswahl braucht ein bereits funktionierender v4-Modellserver kein Update.

### Neustart oder Reindex?

| Änderung | Notwendiger Schritt |
| --- | --- |
| Nur `public/` geändert | `?v=` in `index.html` erhöhen, Browser neu laden; kein Backend-Neustart |
| Backend, Worker oder Dienst-Umgebung geändert | Wenn kein wichtiger Auftrag läuft: Dienst neu starten |
| systemd-Unit geändert | Zuerst `daemon-reload`, dann Neustart |
| Nur Artikel/Medien hinzugefügt oder migriert | Reindex über Admin-UI oder `SIGHUP` |

```bash
sudo systemctl restart nodeapp
sudo systemctl status nodeapp --no-pager
journalctl -u nodeapp -n 100 --no-pager
```

Für reinen Reindex auf Debian als Dienstbenutzer:

```bash
PID=$(systemctl show -p MainPID --value nodeapp)
[ "${PID:-0}" -gt 0 ] && kill -HUP "$PID"
```

**Offene Abweichung, am 25.09.2026 lokal bestätigt:** `scraper/run-scrape.sh` enthält weiterhin `sudo /usr/bin/systemctl restart nodeapp`. README und LXC-Dokumentation empfehlen dagegen `SIGHUP`. Die Dokumentation allein hat den tatsächlichen Wrapper nicht umgestellt. Der harte Restart kann laufende Requests, Sessions, Reindex oder TTS unterbrechen. In dieser Dokumentationssitzung wurde das Skript nicht geändert; der Produktionsstand des Wrappers ist unbekannt.

Als historischer Cron-Zeitpunkt ist `30 4 * * *` mit UTC-Serverzeit dokumentiert. Das ist nicht automatisch 04:30 Uhr deutscher Ortszeit. Teilfehler einer Scraperquelle sollen den anschließenden Reindex bereits gespeicherter anderer Quellen nicht verhindern.

### Lokaler Qwen-Test

```powershell
.\tts\Test-QwenServer.ps1
.\tts\Start-WebArchivQwen.ps1
```

Der erste Helfer prüft Verbindung/Vertrag ohne Audioerzeugung. Erwartet wird v4 mit `full_markdown: true` und `audio_format: mp3`. Der zweite prüft Qwen und startet WebArchiv lokal. Beide fragen das Token verdeckt ab und konfigurieren keinen laufenden Debian-Dienst.

Danach als Admin einen Artikel ohne MP3 öffnen und den Providerdialog prüfen. Ein Healthcheck ersetzt keinen tatsächlichen Modell- und Hörtest. Einen solchen Test bewusst starten und anschließend MP3, Anzeige und Aussprache prüfen.

Quellen: [G4], [G7], [G10], [G11], [G14], [D2], [D3], [D7].

## 11. Bekannte Fehlerursachen und daraus gelernte Vorgehensweisen

| Symptom | Erkenntnis und Vorgehen |
| --- | --- |
| Artikel endet scheinbar bei „Joe Turan“ | Ohne Trenner wurde eine Body-Quelle als Metadatum gelesen. Endgültige Lösung ist der Parserbeginn nach Datum/Metadaten, nicht ein obligatorischer Blog-Trenner. |
| `(2)` landet in der Quellenzeile | Markdown-formatierte `Quelle:` wurde beim Rückwärtssuchen nicht erkannt. Normalisieren, Quelle überspringen, Titelzusatz in der Titelzeile setzen. |
| Infografik `_2` ohne Audio | Sowohl den Nicht-Infografik-Basisartikel als auch eine Basis-Infografik mit direkter MP3 berücksichtigen. |
| Gleichnamige Artikel in Coaching und Telegram | Eindeutigen Audio-Kandidaten auswählen; mehrere vorhandene Audios bleiben mehrdeutig. |
| Audio eines privaten Autors ist für Gäste sichtbar | Keine Freigabe allein über eine öffentliche Infografik. Herkunfts-ACL in API und Datei-Endpunkt erhalten. |
| Audio-Länge erst nach Play | Metadaten vorladen und Anzeige bei Metadaten-/Dauerereignissen aktualisieren. |
| `EXDEV` beim Migrieren | Unterschiedliche Mounts: Kopie mit Größenprüfung vor Löschen der Quelle. |
| `spawn ffmpeg ENOENT` | FFmpeg fehlt oder ist im Dienst-PATH nicht auffindbar; auch FFprobe prüfen, gegebenenfalls absolute Pfade konfigurieren. Kein Beweis für fehlerhaften API-Key. |
| Undici `assert(!this.paused)` | Qwen-Downloadtransport wurde auf `node:http`/`node:https` umgestellt; große/unvollständige Downloads gezielt testen. |
| Qwen gestoppt, UI versucht ihn trotzdem | Verfügbarkeit beim Öffnen und vor Start prüfen; keine kostenpflichtige Ersatzwahl ohne Bestätigung. |
| Log springt sekündlich | Polling beibehalten, nur Änderungen rendern und Scrollposition erhalten. |
| Aktionen-Menü abgeschnitten oder am falschen Rand | Am Button verankern; nur Randüberschreitung korrigieren und Breite begrenzen. |
| iPhone verlässt Bildvollansicht nicht mehr | Desktop-Klickneutralität darf den einfachen Touch-Tap zum Schließen nicht verhindern. |
| `Cannot find module 'express'` | Abhängigkeiten im richtigen Projektverzeichnis installieren. Das alte Setup-Beispiel `npm init -y` nicht auf das fertige Projekt übertragen. |
| Chromium „Executable doesn't exist“ | Installation und Dienst laufen unter verschiedenen Benutzern; gemeinsamen Browserpfad verwenden. |
| Chromium meldet fehlende `libnspr4.so`/Systembibliotheken | Playwright mit benötigten Linux-Systembibliotheken installieren. |
| Shell-Skript meldet `bash\r` nicht gefunden | Windows-CRLF in `.sh` zu LF konvertieren. Node-JavaScript benötigt diese Shebang-Korrektur nicht in gleicher Weise. |
| WinSCP lehnt SSH-Key ab | Historisch lag `authorized_keys` im SSH2/RFC4716-Format vor. OpenSSH-Zeilenformat verwenden und Rechte für `.ssh`/`authorized_keys` prüfen. |
| `chown` scheitert auf `lost+found` im LXC | Host-Mount und UID/GID-Mapping untersuchen; Container-Root ist bei unprivilegiertem LXC nicht Host-Root. `lost+found` nicht für die App verändern oder löschen. |

Die alte Idee, Nutzdaten unter `www/data` abzulegen, war ein Mount-Vorschlag. Sie darf nicht ungeprüft umgesetzt werden: Der aktuelle Scanner behandelt unmittelbare Unterordner von `www` als Autoren. Eine solche zusätzliche Ebene benötigt eine passende Wurzelkonfiguration bzw. Anpassung und ist kein belegter aktueller Zustand.

## 12. Prüfstand und sinnvolle Prüfkommandos

Die frühere Projektbeschreibung „keine Tests“ ist überholt. Es existieren inzwischen Parser-, Editor-, Scraper-, TTS- und Qwen-Brückentests. Im Root gibt es weiterhin keinen allgemeinen `npm test`-Eintrag und keinen Build-/Lint-Schritt.

### Historisch protokollierte Nachweise

| Bereich | Nachweis aus dem jeweiligen Gespräch |
| --- | --- |
| Infografik-Kopf | Zwölf Quellen-/Titelvarianten und Syntaxprüfung; realer Artikel ohne Quelle |
| Audioerkennung | Joe-Turan-Artikel in Liste/Detail erkannt; MP3 mit `200 audio/mpeg` abrufbar. Visuelle Browserprüfung damals nicht verfügbar. |
| Scraper/Bereinigung | Zunächst vier, später acht Tests; drei synchronisierte Varianten zusammen 24 Tests. Bestandsbereinigung von 121 Dateien gesondert protokolliert. |
| Audio-Migration | Syntaxprüfung und Dry-Run mit zwei Dateien; EXDEV-Fallback ergänzt. Kein daraus abzuleitender vollständiger produktiver Migrationstest. |
| Editor | Neun automatisierte Tests sowie protokollierte Browserprüfung einschließlich mobilem Layout |
| Copy/Aktionen | Syntax und Menülogik geprüft; visuelle Admin-Prüfung bei der ersten Stiländerung mangels Anmeldung nicht möglich |
| PDF.js-Umzug | JavaScript-Syntax und Viewer-Dateiverweise geprüft |
| OpenAI-Integration | 13 Worker-/Adaptertests und später ein gezielter Audio-Pfadtest dokumentiert; simulierte API, echte lokale Audiowerkzeuge/Child-Prozesse |
| Qwen-Entwicklung | Mehrere Zwischenstände mit unterschiedlichen Testsätzen: 26, 31, 38 und 35 Offline-Tests gemeldet; Zahlen nicht als eine gemeinsame Suite addieren |
| Qwen-Auswahldialog | Dokumentation meldet 32 Node-Tests; sieben Python-Tests beim vorherigen v4-Update. Für die spätere Vorauswahl wurden 26 TTS-Tests im Gespräch gemeldet. Unterschiedliche Auswahl/Version der Tests beachten. |
| Parserkorrektur ohne Trenner | Zehn Tests und vollständiger Body des konkreten Fehlerartikels protokolliert |

Keine dieser Angaben bedeutet, dass heute erneut alle Tests liefen. In dieser Sitzung wurde Dokumentation erstellt und gegen Gesprächsverläufe sowie gezielte Code-/Dateistellen geprüft; Anwendung, Scraper, Migration und Synthese wurden nicht gestartet.

### Für spätere Änderungen passend auswählen

Vom Projektroot, mit installierten jeweiligen Abhängigkeiten:

```powershell
node --check server.js
node --check public/app.js
node --check public/article-editor.js
node --test server.test.cjs article-editor.test.cjs user-store.test.cjs
npm test --prefix scraper
npm test --prefix tts
python -B -m unittest discover -s tts -p test_qwen_http_service.py -v
git diff --check
```

TTS-Tests verwenden simulierte Syntheseantworten, teilweise aber echte HTTP-Verbindungen, FFmpeg/FFprobe und Kindprozesse. Windows-Sandboxfehler wie `EPERM` bei Child-Spawn sind von einem fachlichen Testfehler zu unterscheiden. Blockierte Prüfungen als blockiert benennen, nicht als bestanden.

Für eine echte Abnahme gezielt Rechte, vorhandene MP3, parallele Starts, Abbruch, Popup-Wiederöffnung, Browser-Reload, Provider-Ausfall, Reindex-Fehler nach erfolgreicher MP3 und kurze/lange Hörproben prüfen. Das Öffnen des Providerdialogs allein darf keine Synthese auslösen.

## 13. Offene Punkte und überholte Dokumentation

### Konkret offen bzw. heute als Abweichung festgestellt

1. **Cron-Wrapper:** `scraper/run-scrape.sh` enthält noch den harten Neustart. Soll und tatsächlichen lokalen sowie produktiven Stand abgleichen und bei einem entsprechenden Änderungsauftrag auf Reindex umstellen.
2. **Qwen-v4-Liveabnahme:** Der Benutzer bestätigte, dass eine frühere Fassung den Modellserver aufrief und nach der Transport-/Chunkänderung funktionierte. Ein vollständiger Hörtest der endgültigen v4-Verarbeitung mit der jüngsten Providerwahl ist in den ausgewerteten Gesprächen nicht abschließend bestätigt.
3. **Produktionsstand:** In dieser Sitzung kein SSH-Zugriff, keine Prüfung der installierten Dateiversionen, Mountrechte, Dienstvariablen oder tatsächlichen Cron-Konfiguration.
4. **Dokumentationswidersprüche:** `tts/QWEN-ANBINDUNG.md`, `tts/UEBERGABE-TTS.md` und `tts/DEPLOYMENT-NODE-SERVER.md` enthalten noch „keine Vorauswahl“. Geltend ist Qwen-Vorauswahl bei Verfügbarkeit. Die Übergabedatei enthält zusätzlich ausdrücklich historische v2-/v3-Abschnitte.
5. **Frühe Projektnotizen:** Aussagen über ausschließlich `server.js`, fehlende Tests, `public/pdfjs`, zweigeteiltes Copy und offene kombinierte Datums-/Textsuche sind teilweise überholt. README und Setup-Datei enthalten noch alte Facebook-URL-Eingaben und ältere Strukturangaben.
6. **BlogDownloader:** Spätere Übereinstimmung der Node- und Python-Scraper ist nicht erneut nachgewiesen. Die historisch beschlossene Synchronität bei künftigen Änderungen berücksichtigen.
7. **Vorhandene lokale Änderungen:** Bereits zu Beginn dieser Dokumentationsarbeit waren `scraper/scrape_all.js` und `scraper/scraper-config.json` verändert; `www/Joe Turan Facebook/` war unversioniert. Diese Änderungen wurden nicht als eigene Arbeit übernommen oder zurückgesetzt. Ihre Aufnahme in Git bedarf einer gesonderten inhaltlichen Sichtung, besonders bei Archivdaten.

### Frühere Ideen, keine zugesagten nächsten Implementierungen

Die frühen Notizen nannten Benutzerverwaltung in der UI (seit 25.09.2026 umgesetzt, Abschnitt 4a), persistente Sessions, Datumsbereich-Picker, Lesezeichen, Bildergalerie, Zusammenfassung als Kachelvorschau, PDF.js-Setuphilfe, Video-Poster, PDF-/EPUB-/CSV-Export und Offline-Modus. Diese Punkte sind ein historischer Ideenspeicher; ihr vollständiger aktueller Umsetzungsstand wurde nicht geprüft.

Die ebenfalls dort als offen bezeichnete kombinierte Text-/Datumssuche ist bereits umgesetzt. Teilen/Link-Vorschau und die überarbeitete Bildvollansicht wurden ebenfalls später bearbeitet. Alte Aufgabenlisten nicht ungeprüft als aktuellen Backlog übernehmen.

## 14. Bewährte Arbeitsweise für weitere Sitzungen

1. Diese Datei und die geltenden Projektregeln lesen. Für Spezialthemen die verlinkten Fachnotizen hinzunehmen, dabei die hier dokumentierten späteren Korrekturen beachten.
2. Vor Quelltextsuche den Graft-Graphen nutzen: `graft map`, dann `graft ask "<konkrete Frage oder Symbol>" --source`; für vollständige Vorkommen `graft grep`, für Abhängigkeiten `graft callers`, für Dateistruktur `graft skeleton`.
3. Graphzusammenfassungen sind Orientierung. Bei Widersprüchen konkrete Codebereiche lesen; die Qwen-Konzepte können beispielsweise noch Teile der historischen OpenAI-/Chunkpipeline beschreiben.
4. Den Git-Zustand zuerst ansehen. Nutzeränderungen und gelöschte Dateien nicht ungefragt zurücksetzen; Archivdaten sind keine automatisch zu commitenden Quellen.
5. Der Benutzer hat mehrfach ausdrücklich „plane zuerst“ verlangt. In solchen Fällen erst Verständnis, betroffene Dateien, Verhalten und Prüfschritte erläutern, dann die gewünschte Umsetzung abwarten. Daraus keine zusätzliche pauschale Freigabepflicht für bereits beauftragte Arbeit ableiten.
6. Dateisystempfade, Browser-URLs und unterschiedliche Rechner klar unterscheiden. Insbesondere `www`/`audio`, `/files`/`/audio-files`, Debian-Webserver und Qwen-Modellserver nicht vermischen.
7. Originalformatierungen erhalten und Fehler mit einem konkreten betroffenen Artikel reproduzieren. Bei Bestandsänderungen erst Umfang/Dry-Run und Backup, anschließend Ergebnis kontrollieren.
8. Änderungen mit den passenden Prüfungen absichern. Syntaxprüfung, Datenpfadprüfung, Browserprüfung und tatsächlicher Hörtest sind unterschiedliche Nachweise.
9. Bei Frontendänderungen Cacheversionen erhöhen; bei Backend-/Workeränderungen auf den nötigen Neustart hinweisen. Für reine Inhaltsänderungen Reindex verwenden.
10. Keine kostenpflichtigen OpenAI-Synthesen durch den Assistenten ohne ausdrückliche Freigabe. Die Anwendungsbestätigung und die serverseitige Providerbindung müssen erhalten bleiben.
11. Serverstarts/-stopps gezielt am WebArchiv-Prozess vornehmen. Eine frühere Aufforderung „Server gestoppt lassen“ bezog sich auf die damalige Sitzung und ist kein Nachweis seines heutigen Zustands.
12. Nach großen Codeänderungen `graft build`; reine Dokumentation benötigt keinen Anwendungsbuild. Ergebnis, tatsächlich ausgeführte Tests und verbleibende Grenzen getrennt berichten.
13. Dieses Dokument bei neuen Entscheidungen mit Datum ergänzen und ersetzte Regeln ausdrücklich als historisch markieren. Nicht mehrere widersprüchliche „aktuelle“ Abschnitte nebeneinander stehen lassen.

## 15. Quellenverzeichnis der Gespräche

Datumsbereiche beziehen sich auf verfügbare Gesprächsereignisse in Europe/Berlin. Ein späteres technisches Änderungsdatum des Threads kann davon abweichen. Titel sind die von der Gesprächsansicht gelieferten Titel.

| Ref. | Zeitraum 2026 | Gespräch | Runden |
| --- | --- | --- | ---: |
| G1 | 10.–17.07. | Neue Grafik hochladen | 12 |
| G2 | 26.07. | Audio-Erkennung für alle Autoren | 11 |
| G3 | 16.08. | Prüfe zentralen Audioordner | 5 |
| G4 | 16.–29.08. | Prüfe zentrale Audioablage | 22 |
| G5 | 29.08. | Entferne Verkleinern Icon | 6 |
| G6 | 11.09. | Entferne Audio-Menüeintrag | 2 |
| G7 | 11.09. | Artikel editieren und speichern | 3 |
| G8 | 11.09. | Copy- und Aktionen-Buttons anpassen | 5 |
| G9 | 11.09. | PDF.js dynamisch von CDN laden | 2 |
| G10 | 10.–16.09. | Integriere TTS in WebArchiv | 10 |
| G11 | 16.–17.09. | Integration von faster-qwen3-tts | 12 |
| G12 | 18.09. | Behebe Artikelanzeige für Joe Turan | 1 |
| G13 | 18.09. | Fix article rendering issue | 6 |
| G14 | 18.09. | Qwen-TTS Server vorauswählen | 2 |

Thread-IDs für die eindeutige Wiederauffindbarkeit:

```text
G1   019f4d69-3b9d-73e1-9fa2-81c936ac0260
G2   019f9e1e-6eaa-7d51-92fb-73b37eedb6c7
G3   01a00980-bf0b-7c12-9f74-df0e3e5cac5b
G4   01a009a2-d5ea-7633-8a6c-a29c742a713b
G5   01a04cec-a391-70f3-b11e-0f1f98bfd786
G6   01a08f73-5c0e-7a31-89e3-168046db3b04
G7   01a08f78-7387-7612-990f-ef4fa06db34a
G8   01a08f9d-3fac-72a1-a83f-559669eb6944
G9   01a09118-3faa-7171-90e6-74d8d7892d19
G10  01a08bf1-8c51-7f72-831f-eee4344a47b1
G11  01a0ab65-5a9e-7a23-903c-00477c681721
G12  01a0b358-76cd-7f13-8b07-65e9ec59fa04
G13  01a0b359-a93d-7e83-ad42-db754c1bacda
G14  01a0b36e-d4a7-7021-9d91-ec35c5cc5fae
```

G3 enthält nach der Analyse mehrere abgebrochene Runden; die Umsetzung ist in G4 dokumentiert. G12 endet ohne abgeschlossene Reparatur; maßgeblich ist die Fortsetzung G13. Einige Arbeiten in G10 haben keinen regulären Abschluss im jeweiligen Turn; ihre Ergebnisse sind zusätzlich in den TTS-Fachnotizen dokumentiert.

### Ergänzende lokale Dokumente

- **D1:** [session-context.md](session-context.md) – Aufbauphase bis 04.06.2026, Architektur, frühe Features und Ideen. Historische Commitverweise: `26f12fb` (Prompt-Menü/Bildansicht), `aafb032` (Text-/Datumssuche), `b61fb25` (Medien-Cachebuster).
- **D2:** [README.md](README.md) – Betrieb, API, Scraper und Reindex; einzelne Strukturangaben sind älter.
- **D3:** [LXC-container node.js Setup.txt](<LXC-container node.js Setup.txt>) – Infrastruktur, SSH, Mountprobleme, systemd, Playwright, Cron und CRLF-Erfahrungen; enthält Vorschläge neben umgesetzten Schritten.
- **D4:** [scraper/README.md](scraper/README.md) – Scraperkonfiguration, CLI und gewünschte Synchronität mit BlogDownloader.
- **D5:** [tts/UEBERGABE-TTS.md](tts/UEBERGABE-TTS.md) – ursprüngliche Integration und spätere Nachträge; historische Abschnitte beachten.
- **D6:** [tts/QWEN-ANBINDUNG.md](tts/QWEN-ANBINDUNG.md) – v4-Protokoll, Originalscript und Prüfungen; Aussage zur fehlenden Vorauswahl durch G14 ersetzt.
- **D7:** [tts/DEPLOYMENT-NODE-SERVER.md](tts/DEPLOYMENT-NODE-SERVER.md) – Update einer bestehenden TTS-Installation; Vorauswahl inzwischen geändert.
- **D8:** [tts/INTEGRATION.md](tts/INTEGRATION.md) – ursprünglicher Liefervertrag des Node-Pakets; insbesondere Ausgabe neben der `.md` ist für WebArchiv überholt.

Zusätzlich berücksichtigt: die geltenden [AGENTS.md](AGENTS.md)-Regeln, `session-context-commands.txt` als historischer Übergabehinweis, Paketdefinitionen und die im Text genannten gezielt geprüften Codebereiche. Die Dokumentation enthält keine echten API-Schlüssel, Tokens oder Cookie-Inhalte.
