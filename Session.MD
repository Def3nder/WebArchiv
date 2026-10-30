# WebArchiv – gesammeltes Projektwissen und Sitzungsprotokoll

Stand: **26.10.2026**. Zusammengeführt aus den zugänglichen Projektgesprächen und den vorhandenen Projektdokumenten; wichtige spätere Entscheidungen mit dem lokalen Code abgeglichen.

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
| Qwen-Verarbeitung | Protokoll `webarchiv-qwen-v5`: vollständiges Original-Markdown hinein, fertige MP3 heraus; Originalscript entscheidet über Verarbeitung und Seed. |
| Sitzungsansicht (05.10.) | Pro Benutzer und Gerät werden Suche, Filter, Seite, Layout, Listen-/Detailposition sowie geöffneter Artikel, Hörbuch oder eBook-Reader lokal wiederhergestellt. Abmelden löscht diesen lokalen Benutzerstand. |
| Providerwechsel | Kein automatischer Wechsel eines laufenden Auftrags zu OpenAI und keine erneute Synthese wegen eines Reindex-Fehlers. |
| PDF.js | Lokal unter `public/vendor/pdfjs`; der zuvor erwogene CDN-Umbau wurde nicht umgesetzt. |
| Inhaltsaktualisierung | Reindex statt Dienstneustart. Der Cron-Wrapper `scraper/run-scrape.sh` sendet nach dem Scrape `kill -HUP` an die MainPID, ohne sudo (seit 29.10.2026, siehe Abschnitt 40). |
| Benutzerverwaltung (25.09.) | Admin pflegt Nutzer, Rechte, Kennwörter und öffentliche Autoren über Aktionen → *Benutzerverwaltung*; jeder Nutzer kann sein Kennwort ändern. Siehe Abschnitt 4a. |
| Öffentliche Autoren (25.09.) | Angemeldete Nutzer mit Autorenliste sehen öffentliche Autoren immer zusätzlich. |
| „Neue Grafik“ (25.09.) | Für alle Autoren außer `Infografiken` selbst, auch für öffentliche Autoren. |
| Infografik-Gruppen (29.09.) | Artikel + Platzhalter-Infografiken = eine Kachel (quadratisch/länglich); Liste und Autor „Infografiken“ einzeln. Siehe Abschnitt 5a. |
| Hörbücher (27.09.) | Eigener Autor `Hörbücher`; Ablage `audio/Hoerbuecher/<Buch>/` (ohne Umlaute, lokal und auf dem Server), nicht unter `www/`. Kein Artikel; erscheint nur bei Autorenfilter „Hörbücher“. Nie öffentlich. Siehe Abschnitt 6a. |
| Einstellungen (02.10.) | Schrift, Hell/Dunkel/Automatisch, Textgröße und Filter-Beschriftungen über Aktionen → *Einstellungen*. Anzeige grundsätzlich pro Gerät; Filter-Beschriftungen zusätzlich pro Nutzer. Gäste: immer Vorgaben. Siehe Abschnitt 8a. |
| Lesezeichen (02.10.) | Pro Nutzer auf dem Server; Header-Button filtert (blau), Detail-Button zwischen Kopieren und Teilen, kleines Symbol auf Kacheln. Siehe Abschnitt 8a. |
| eBook aus EPUB (01.10.) | Kein EPUB im Reader: `epub-tool/` wandelt EPUB offline in die Reader-`.md` um (Verweise, Inhaltsverzeichnis, Fuß-/Endnoten als Sprunglinks, Bilder). Siehe Abschnitt 6d. |

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
| `audiobooks.cjs`, `public/audiobooks.js`, `public/book-reader.js` | Hörbücher: Index, Fortschritt, Player, eBook-Text (Abschnitte 6a, 6b) |
| `config.json` | Einstellungen (derzeit Hörbuch-Sprungweiten) |
| `bookmarks.cjs`, `public/settings.js` | Lesezeichen pro Nutzer; Anzeige-Einstellungen pro Gerät (Abschnitt 8a) |
| `epub-tool/` | Eigenes ESM-Paket: EPUB → Markdown für Hörbuch-eBooks (Abschnitt 6d); nicht Teil der Laufzeit |

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
- Deployment: Der Dienstbenutzer `ralf` braucht Schreibrecht auf `users.json`, `public-directories.txt` und `/opt/nodeapp` (für die temporäre Datei); `users.json` sinnvollerweise `600`. Nach dem Einspielen Dienst neu starten. Hinweis (historisch): `public-directories.txt` war damals eingecheckt; seit 26.10.2026 sind sie und `config.json` nicht mehr in Git (siehe Abschnitt 21).
- Für Tests lassen sich die Dateipfade über `USERS_FILE` und `PUBLIC_DIRS_FILE` umlenken.
- Geprüft am 25.09.2026: 10 neue Tests in `test/user-store.test.cjs` (zusammen mit Parser- und Editortests 21/21 bestanden) sowie Browserprüfung mit Testdateien: Menü je Rolle, Nutzer bearbeiten/anlegen/löschen, Kennwort neu vergeben, Pflichtdialog (Escape gesperrt, Fehlermeldungen, Serversperre 403, Freigabe nach Änderung), Öffentlicher Zugang inklusive sofortiger Wirkung für Gäste. Die echte `users.json` wurde dabei nicht verwendet.

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

## 5a. Infografik-Gruppen (29.09.2026)

Entscheidungen des Benutzers:

- **Zuordnung** über Jahr + Dateistamm. `_N` ist nur dann eine Variante, wenn es den verkürzten Stamm gibt. Vorher schnitt `infographicBaseStem` jede Zahlenendung ab, dadurch fanden die Stefan-Hiene-Infografiken (`…_Audioquickie_2961`) ihren Artikel nicht und erbten kein Audio (behoben; 290 statt 270 Zuordnungen).
- **Platzhalter** = Infografik-`.md` ohne Text unter Datum/Metadaten. Platzhalter und Artikel bilden eine Gruppe (Anker = Artikel; ohne Artikel die Basis-Infografik). Eine Infografik **mit eigenem Text** ist ein Original (eigene Kachel, „Artikel editieren“ bearbeitet sie); ihre Varianten `_2`, `_3` gehören als Bilder zu ihr, deren doppelter Text wird nicht gezeigt.
- **Bilder der Gruppe:** eigenes Artikelfoto (nicht `standard.jpg`), dann Basis-Grafik, `_2`, `_3` …
- Mitglieder **erben Kategorien/Tags** des Ankers (Suche, Filter) und wie bisher Audio (Zugriff bleibt beim Audio-Ursprung).
- **Wo gruppiert:** nur Kachelansichten quadratisch/länglich (`/api/articles?group=1`). Liste und Autorenfilter „Infografiken“ einzeln. Gruppierung pro Anfrage nach dem Rechtefilter: Wer den Artikel nicht sehen darf (Gast), bekommt die Grafik einzeln ohne Text und Audio.
- **Trefferzahl** = Artikel + Grafiken (wie vorher); Seiten zählen Kacheln.
- **Kachel:** keine Animation. Desktop: Mausposition (Breite ÷ Anzahl) wählt das Bild, beim Verlassen zurück zu Bild 1. Touch: waagerecht wischen, über das Ende hinaus wieder zum ersten Bild (und umgekehrt). Striche ●○○ unten links auf dunklem Grund (neben den Badges unten rechts). Weitere Bilder erst bei Hover/Berührung geladen.
- **Artikelansicht:** Bildleiste mit Höhe für drei 9:16-Bilder nebeneinander (27:16); bei zwei Bildern je halbe Breite, unten beschnitten; Artikelfoto mittig beschnitten; ab vier Bildern waagerecht scrollbar (Wischen dort wechselt nicht den Artikel). Klick öffnet die Vollansicht.
- **Wischen/Pfeiltasten** wechseln in der Artikelansicht die Artikel; nur in der **Vollansicht** die Bilder, nach dem letzten Bild weiter zum nächsten Artikel (Bild 1), vor dem ersten zum vorigen (letztes Bild). Vollansicht zeigt „2 / 4“ und einen Download-Knopf.
- **Deep-Link:** `#/article/<Anker-ID>?bild=N`. Alte Links auf eine gruppierte Infografik öffnen die Gruppe mit diesem Bild. `/a/<id>` unverändert.
- „Neue Grafik“ übernimmt keine `Kategorien:`-Zeile mehr. Bestehende Zeilen entfernt `scripts/strip-infographic-categories.js` (erst `--dry-run`; Sicherung nach `download/backup-<Datum>/`; danach Reindex). Lokal am 29.09. nur als Probelauf ausgeführt (23 Dateien).
- Grafik löschen/ersetzen: bewusst nicht umgesetzt.
- Das Bereinigungsskript wurde vom Benutzer am 29.09. ausgeführt (Sicherung `download/backup-2026-09-29`). Es fasst seitdem nur noch Infografiken **ohne** eigenen Text an.

**Neue eigenständige Infografik (29.09.2026):** Aktionen-Menü (Admin) → *Neue Infografik*. Entscheidungen: Grafik wird **im selben Dialog vor dem Speichern** gewählt (Dateidialog nach einem Serveraufruf wird auf iPhones blockiert; keine `.md` ohne Bild). Vorlage `# [Titel]` / Leerzeile / `Datum: <heute, Browserdatum ISO>` / `Kategorien: []` / Leerzeile / `----` / Leerzeile / `[Inhalt]`. Dateiname `<Datum>_<Slug des Titels>` (ä→ae, ß→ss, max. 80 Zeichen), Konflikt → `-2`, `-3` (nicht `_2` = Variante). Beim Speichern: `Kategorien: [a, b]` → `a, b`, leere Kategorien und unverändertes `[Inhalt]` entfernt, `[Titel]` wird abgewiesen. Danach Reindex und Öffnen der Infografik. **Nachtrag 29.09.:** Die Vorlage enthält keine `Kategorien:`-Zeile mehr; stattdessen zeigt der Dialog die Filter-Kategorien als Häkchen, der Server fügt die angehakten beim Speichern nach `Datum:` ein (bzw. ergänzt eine selbst getippte Zeile). Außerdem gilt jetzt allgemein (`mergeCategories`): Taxonomie-Namen in einer `Kategorien:`-Zeile zählen für Filter und Suche immer, vor den automatisch erkannten, höchstens fünf; andere Einträge bleiben Anzeige-Tags. Betrifft auch 27 bestehende Dateien, deren Zeile solche Namen enthält. Neue Infografiken sind sofort öffentlich, wenn `Infografiken` öffentlich ist. Technik: `POST /api/new-infographic` (JSON mit base64-Bild, Bildtyp am Inhalt erkannt, atomar mit Rückbau), `public/infographic-new.js`.

**Nachtrag 02.10.:** Eine Gruppe mit genau einem Bild (Artikel ohne eigenes Foto, z. B. Telegram, plus eine Infografik) ist keine Galerie; ihre Kachel bekam deshalb die mittige Bildausrichtung. Jetzt erhält `.card-image` die Klasse `is-infographic`, wenn das einzige Bild eine Infografik ist, und zeigt sie wie alle Infografiken ab dem oberen Rand.

Technik: `linkInfographics` (Index), `visibleGroupAnchor`/`groupImagesFor` (API) in `server.js`; Frontend `renderCardGallery`/`wireCardGallery`, Bildleiste in `renderDetail`, `fsGallery`/`stepFullscreen`, `parseArticleHash` in `public/app.js`. Geprüft am 29.09.: 36/36 Tests (6 neue Gruppentests), API gegen den echten Bestand (5.614 Einträge → 5.327 Kacheln, 184 Gruppen; Gast: 22 reine Infografik-Gruppen), Browserprüfung Desktop und Handy-Ansicht (Hover, Wischen, Leiste mit 2 und 5 Bildern, Vollansicht über Bild- und Artikelgrenzen, Deep-Link, Liste einzeln). Nicht auf einem echten iPhone geprüft.

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
node scripts/migrate-audio.js "Joe Turan" --dry-run
node scripts/migrate-audio.js "Joe Turan"
```

Das Skript (`scripts/migrate-audio.js`, arbeitet auf `www/` und `audio/` im Projektroot) sucht rekursiv nach `.mp3` einschließlich abweichender Groß-/Kleinschreibung. Es spiegelt den relativen Pfad unter `audio/<Autor>/`, behandelt Autorennamen mit Leerzeichen, überschreibt vorhandene Ziele nicht und protokolliert nach `migrate-audio.log`. Markdown und Bilder werden nicht verschoben.

Ein tatsächlicher Debian-Fehler war `EXDEV: cross-device link not permitted`: `www/` und `audio/` lagen auf verschiedenen Dateisystemen. Deshalb gibt es nach einem fehlgeschlagenen `rename` wegen `EXDEV` einen Fallback: kopieren, Dateigröße vergleichen, erst danach die Quelle entfernen. Ein Größenvergleich ist kein kryptografischer Inhaltsvergleich.

Vorgehen: Dry-Run prüfen, Migration gezielt ausführen, Log auf Konflikte/Fehler kontrollieren, anschließend reindexieren. Das Skript wurde erstellt und der Dry-Run damals mit zwei Joe-Turan-MP3s geprüft; daraus folgt keine heute bestätigte vollständige Produktionsmigration.

Quellen: [G2], [G3], [G4].

## 6a. Hörbücher (27.09.2026)

Entscheidungen des Benutzers:

- Ablage: `audio/Hoerbuecher/<Ordner je Buch>/` mit `cover.jpg`/`.jpeg`/`.png`, nummerierten Tracks (`.mp3`, `.m4b`, auch `.m4a`) direkt im Ordner (keine Unterordner) und optional `abstract.md`. Fehlt das Cover, gilt `audio/Hoerbuecher/standard.*`. Ordnername und Anzeige sind getrennt (Entscheidung vom 27.09.): Angezeigt, in Rechten und Buch-IDs wird immer „Hörbücher“ verwendet; auf der Platte wird `Hoerbuecher` gesucht, ersatzweise `Hörbücher`, oder der Name aus `config.json` → `audiobooks.directory`. `/audio-files/Hoerbuecher/...` wird für die Rechteprüfung dem Autor „Hörbücher“ zugeordnet. Bewusst unter `audio/`, damit der Artikel-Scan von `www/` die `abstract.md` nicht als Artikel einliest.
- `abstract.md` hat feste Felder `Titel:`, `Autor:`, `Datum:`, `Inhalt:`; alles ab `Inhalt:` ist Markdown und wird gerendert. Ohne Datei werden Autor und Titel aus dem Ordnernamen „Autor - Titel“ gelesen.
- Hörbücher sind **keine Artikel**: nicht unter „Alle Autoren“, nicht in der globalen Suche, nicht im Filter „mit Audio“. Nur bei Autor = „Hörbücher“; dort Sortierung *Zuletzt gehört* (Standard, danach ungehörte nach Name), *Nach Name*, *Nach Datum*. Jahr/Kategorie sind in dieser Ansicht ausgeblendet; die Suche durchsucht Titel, Buchautor und Kurzbeschreibung.
- **Autorenmenü (03.10.):** „Hörbücher“ steht direkt unter „mit Audio“, danach die übrigen Autoren alphabetisch (`loadMeta` in `public/app.js`; Badge-Farben unverändert nach der alphabetischen Liste). `app.js?v=56`.
- Rechte: wie ein normaler Autor über `allowedAuthors` (Haken in der Benutzerverwaltung). **Gäste nie**, auch nicht per `public-directories.txt`; der Eintrag wird beim Laden ignoriert, beim Speichern abgewiesen und im Reiter „Öffentlicher Zugang“ nicht angeboten.
- Player: ein Play-Button für das ganze Buch; Teil zurück/vor, große und kleine Sprünge **über Dateigrenzen hinweg**, Tempo 0,75×–2×, Trackliste, automatischer Übergang zum nächsten Teil. Sprungweiten in `config.json` (`audiobooks.skipLongSeconds` = 600, `skipShortSeconds` = 30), Neustart nötig.
- Anzeige einfach: „Teil x von y · Titel“ und Zeit im aktuellen Teil; keine Gesamtdauer des Buches.
- Hörposition **pro Nutzer und Buch**, einschließlich Tempo (pro Buch). Gespeichert alle 15 s beim Hören, bei Pause, Teilwechsel, Sprung, Schließen der Seite und Abmelden.
- Miniplayer: Wiedergabe läuft beim Schließen des Details weiter (Leiste unten). Startet ein Artikel-Audio, pausiert das Hörbuch, und umgekehrt.
- Aktionen-Menü (Admin): nur „Abstract editieren“ (vorhandener Editor mit Versionsschutz), sofern `abstract.md` existiert.

Technik:

- `audiobooks.cjs`: Scan/Index (beim Reindex mit aufgebaut), `abstract.md`-Parser, natürliche Tracksortierung (`2` vor `10`), Tracktitel ohne Nummer und ohne gemeinsamen Anhang wie „ - Buchtitel - Autor“, Fortschrittsspeicher und Routen `GET /api/audiobooks`, `GET /api/audiobooks/*`, `PUT /api/audiobook-progress/*` (angemeldet, Autorenrecht, Cross-Site-Schutz).
- Fortschritt in `audiobook-progress.json` (gitignored, atomar geschrieben, Modus 600), Schlüssel E-Mail (klein) → Buch-ID → `{file, trackIndex, position, speed, updatedAt}`. Der Track wird bevorzugt über den Dateinamen wiedergefunden. Beim Löschen eines Nutzers werden seine Einträge entfernt. Pfad per `AUDIOBOOK_PROGRESS_FILE` umlenkbar.
- Medien über `/audio-files/*` (ACL, Range-Requests); `.m4b`/`.m4a` werden als `audio/mp4` ausgeliefert. Media-Session-API für Sperrbildschirm/Kopfhörertasten.
- Editor (`article-editor.cjs`) akzeptiert mehrere Wurzeln (`www/` und `audio/`).
- Frontend: `public/audiobooks.js` (Liste, Detail, Player, Miniplayer).
- Deployment: `audio/Hoerbuecher` auf dem Server anlegen (Leserecht für `ralf`), `config.json` mitkopieren; Schreibrecht im App-Verzeichnis für `audiobook-progress.json` besteht bereits (wie `users.json`). Danach Dienst neu starten.
- Geprüft am 27.09.2026: 29/29 Tests (neu `test/audiobooks.test.cjs`, erweiterte Editor-/Nutzer-Tests) sowie Browserprüfung mit Testnutzern und Testdateien (Gastsperre, Rechte je Nutzer, Wiedergabe, ±10 Min über Dateigrenzen, Buchende, Tempo, Wiederaufnahme nach Reload, Miniplayer, Artikel-Audio-Wechsel, Abstract-Editor lesend, Handy-Layout). Echte `users.json` und echte `abstract.md` wurden nicht verändert; ein Hörtest auf iPhone/Sperrbildschirm steht aus.

### ToDo für später (Ideen, noch nicht beauftragt)

1. „Weiterhören“-Leiste auf der Startseite mit angefangenen Büchern.
2. Einschlaf-Timer (15/30/60 Min, „Ende des Teils“) mit sanftem Ausblenden.
3. Lesezeichen/Notizen an einer Stelle im Buch.
4. „Als gehört markieren“ und „Von vorn beginnen“.
5. Gesamtdauer und Restzeit des Buches (Dauer aller Tracks per ffprobe beim Reindex, gecacht).
6. Nächsten Teil vorladen für lückenlose Übergänge.

## 6b. eBook-Text zum Hörbuch (30.09.2026)

Entscheidungen des Benutzers:

- **Ablage:** Die eBook-Datei liegt im Buchordner und heißt **wie der Ordner**; erlaubte Endungen `.pdf`, `.md`, `.txt` (Vorrang `.md`, `.txt`, `.pdf`; Groß-/Kleinschreibung egal). Eine Datei pro Buch. `abstract.md` und andere Dateien zählen nie als eBook.
- **Umfang: nur Stufe 1.** Text auf Wunsch einblenden, **kein Mitlaufen** und keine Zuordnung Kapitel ↔ Teil. Kein EPUB, keine Suche im Text, keine Lesezeichen.
- **Bedienung:** Button *Text lesen* im Hörbuch-Detail (nur wenn ein eBook vorhanden ist) öffnet einen **Vollbild-Reiter** über dem Artikel-Overlay. Der **Miniplayer bleibt sichtbar** (über dem Reiter); ein Tipp auf die Leiste schließt den Reiter und führt zum Detail. Escape schließt nur den Reiter; Pfeiltasten wechseln im Hintergrund keinen Artikel. Markdown/Text: Schriftgröße A−/A+ (sechs Stufen, pro Gerät in `localStorage`). PDF: eingebauter PDF.js-Viewer.
- **Leseposition pro Nutzer und Buch**, serverseitig in `audiobook-progress.json` unter dem Schlüssel `__text` je Nutzer (`{ format, position, updatedAt }`), **getrennt vom Hörstand** (`progress.set` lässt sie stehen). Text: Scrollanteil 0–1, gespeichert 1,5 s nach dem Scrollen, beim Schließen und bei `pagehide`; PDF: Seitenzahl, alle 3 s geprüft. Wechselt das Format einer Datei, wird die alte Position ignoriert. Beim Löschen eines Nutzers entfällt sie mit.

Technik:

- `audiobooks.cjs`: `scanBook` sucht `<Ordnername>.{md,txt,pdf}`; `ebookText(book)` liefert `md` (über `marked`, wie Artikel ohne HTML-Bereinigung) bzw. `txt` (escaped, Absätze; fest umbrochene Zeilen werden zusammengezogen, ohne Leerzeilen gilt jede Zeile als Absatz) als HTML, Cache je Änderungszeit, Limit 5 MB; `pdf` als `/audio-files/…`-URL (ACL und Traversal-Schutz der bestehenden Route). Routen `GET /api/audiobook-text/*` und `PUT /api/audiobook-text-progress/*` (angemeldet, Autorenrecht `Hörbücher`, Cross-Site-Schutz, wie die übrigen Hörbuch-Routen). Das Detail enthält `ebook: { format, file }` und `ebookPosition`.
- Frontend: `public/book-reader.js` (nach `audiobooks.js` geladen); `bookUpdateUi` zeigt den Miniplayer auch bei aktivem Detail, solange der Reiter offen ist. Öffnen lädt das Hörbuch in den Player (mit gespeichertem Hörstand), sofern nicht gerade ein anderes Buch läuft.
- **Interne Verweise (30.09.):** Markdown-Links der Form `[Text](#kürzel)` springen im Text zur Überschrift. `book-reader.js` vergibt den Überschriften IDs im GitHub-Stil (exakt wie GitHub: klein, Satzzeichen entfallen, **jedes** Leerzeichen → `-`, also `a – b` → `a--b`; doppelte Überschriften `-1`, `-2`); vorhandene `id="…"` im Markdown (z. B. Fußnoten `ref-12`) gelten ebenfalls. Am Buch „Komm, wie du willst“ geprüft: alle 523 Verweise und 13 Bilder (Unterordner `images/`) funktionieren; bei `.md` **und** `.pdf` im Ordner gewinnt `.md` und fängt Klicks auf `#…`-Links ab (die Adresse der App bleibt unverändert). Externe Links öffnen in neuem Tab. Am Buch „50 Fragen“ geprüft: alle 101 Verweise (77 verschiedene) treffen eine Überschrift. **Zurück-Knopf (30.09.):** Nach einem internen Sprung erscheint unten rechts „↩ Zurück“ (über dem Miniplayer); er springt zur Stelle vor dem Sprung, bei mehreren Sprüngen schrittweise (Stapel, höchstens 20), und verschwindet, wenn keine Stelle mehr gemerkt ist. Eine Änderung der Schriftgröße leert den Stapel, weil die Positionen dann nicht mehr passen. **Bilder im Markdown (30.09.):** Relative Bildpfade (`![](images/x.jpg)`) werden vom Server beim Rendern auf `/audio-files/…` umgeschrieben (`rewriteEbookImages` in `audiobooks.cjs`): nur innerhalb des Buchordners, Unterordner erlaubt, Groß-/Kleinschreibung egal (`Images` = `images`), mit `?v=<mtime>`. Pfade, die den Buchordner verlassen (`../Images/…`), und fehlende Dateien entfallen (Bild wird entfernt); externe Bilder (`http…`) bleiben unverändert. Zugriff über die bestehende `/audio-files`-Rechteprüfung. Linux/Debian: Dateien werden per `stat` gesucht (folgt Symlinks/Mounts), bei Nichtfinden folgt ein Abgleich ohne Beachtung der Groß-/Kleinschreibung; jedes nicht auflösbare Bild wird im Dienstprotokoll gemeldet (`Hörbuch-Text „<ID>“: n Bild(er) nicht gefunden, z. B. <Pfad> – <Grund>`, etwa `EACCES` bei fehlenden Leserechten). Der Textcache wird beim Reindex geleert. Im Reader max. Textbreite, Seitenposition wird nachgeführt, solange noch nicht gescrollt wurde und Bilder nachladen. Nicht umgesetzt: eigene Anker-IDs (`<a id>`), Bild-Vollansicht.
- **Fallstricke (beim Test gefunden):** (1) pdf.js kodiert den `file`-Parameter selbst; der schon kodierte Medienpfad (`%20`) führte zu 404 → vor der Übergabe `decodeURI`. (2) Der Viewer meldet anfangs Seite 1; würde sofort gespeichert, überschriebe das die gespeicherte Seite → bei PDF wird erst gespeichert, nachdem der Viewer initialisiert und zur Seite gesprungen ist. (3) Ohne scrollbare Höhe (Layout nicht fertig) wird keine Position gespeichert.
- Geprüft am 30.09.2026: 43/43 Tests (neu: eBook-Erkennung, Inhalt, Leseposition), Browserprüfung mit Testkopie und Testnutzer (Text öffnen, Scrollen/Speichern, Wiederherstellen, A+ behält die Stelle, Escape, Miniplayer-Tipp, PDF mit Seitensprung, Handy-Breite ohne seitliches Scrollen). **Nicht geprüft:** echtes iPhone/Safari, Hörtest mit echten Büchern, Serverrouten-Rechte (Gast/ohne Autorenrecht) nur über die gemeinsame `route()`-Hülle, kein eigener Test.
- Deployment: Backend geändert → Dienst neu starten; `public/book-reader.js` neu, `audiobooks.js?v=2`, `styles.css?v=61`. eBook-Dateien in `audio/Hoerbuecher/<Buch>/` ablegen, danach Reindex. Leserecht für `ralf` genügt.

### Lesefortschritt im eBook-Reader (03.10.2026)

Entscheidungen des Benutzers: dünne Fortschrittslinie unter dem Kopf, **immer sichtbar** und bedienbar: **kurz tippen springt** an die entsprechende Stelle, **halten und ziehen scrollt live** durch das Buch. Im Kopf dauerhaft **„Kapitel · %“**, beim Ziehen zusätzlich eine Sprechblase mit Kapitel und Prozent. Nur für `.md`/`.txt` (der PDF-Viewer zeigt die Seite selbst).

- Linie optisch 3 px (Akzentfarbe auf `--border`), Tippzone per `::before` rund 27 px hoch; beim Halten bzw. mit Tastaturfokus dicker (`scaleY`). Pointer-Events mit `setPointerCapture` (abgesichert), `touch-action: none`, damit waagerechtes Ziehen nicht scrollt.
- Kapitel = letzte `h1`/`h2`, deren Überschrift das obere Drittel des Bildschirms erreicht hat (binäre Suche über `offsetTop`; `.book-reader-scroll` ist dafür `position: relative`). Vor der ersten Überschrift nur „x %“. Bei Platzmangel wird nur der Kapitelname gekürzt, die Prozentzahl bleibt sichtbar.
- **Tippen vs. Halten (03.10., ersetzt „Ziehen = absolute Position“):** Nur ein **kurzes Tippen** (unter 250 ms und höchstens 6 px Bewegung) springt an die angetippte Stelle. **Drücken und Halten** oder sofortiges Ziehen schaltet in den **Scrollmodus ohne Sprung**: Der Text bewegt sich **relativ** zur Fingerbewegung ab der aktuellen Stelle (ganze Linienbreite = ganzes Buch); Halten ohne Bewegung ändert nichts. Ein Abbruch (`pointercancel`) springt nie. Konstanten `BOOK_HOLD_MS`, `BOOK_TAP_MOVE_PX`. Geprüft: Tippen 80 % → 80 %; Halten → bleibt; Halten + 10 % ziehen → +10 %; sofort −30 % ziehen → −30 % (kein Sprung zum Startpunkt); echtes Ziehen mit der Maus 60 % → 80 %.
- Die Sprechblase steht **über** der Linie im Kopfbereich (Entscheidung 03.10.), damit der Finger sie nicht verdeckt; sie hängt am Reiter und wird per Skript über der Linie und über dem Finger ausgerichtet.
- Ein Sprung oder Ziehen über mehr als eine Bildschirmhöhe legt die vorige Stelle auf den Stapel von „↩ Zurück“. Leseposition wird wie bisher 1,5 s nach dem Scrollen gespeichert.
- Barrierefreiheit: `role="slider"` mit `aria-valuenow`/`aria-valuetext`; Pfeil links/rechts auf der fokussierten Linie verschiebt um 1 %.
- Technik: `prepareBookProgress` in `public/book-reader.js`; Aktualisierung pro Frame beim Scrollen (`requestAnimationFrame`).
- Geprüft am 03.10.2026 im Testserver mit „Komm, wie du willst“: Tippen auf die Mitte → 50 % mit Kapitel, Ziehen 10 → 90 % („Quellen“), Sprechblase, Zurück-Stapel, Wiederherstellen der gespeicherten Stelle, Pfeiltasten, A+ behält Stelle und Anzeige, Handy-Breite ohne seitliches Scrollen. **Nicht geprüft:** echtes iPhone (Fingerbedienung).
- **Auch in den Audio-Playern (03.10.):** Auf Benutzerwunsch bedienen sich der Fortschrittsbalken des Artikel-Audios und der des Hörbuch-Players (Position im Teil) genauso: kurz tippen = springen, halten/ziehen = relativ verschieben, Sprechblase über dem Balken (Artikel „1:41 / 1:52“, Hörbuch „Teil 1 · 27:36 / 30:40“). Unterschied zum Text: Beim Audio zeigen Balken, Zeit und Sprechblase während des Ziehens nur die Zielstelle; gesprungen wird erst beim Loslassen (kein Nachladen bei jeder Bewegung), Abbruch übernimmt nichts. Waagerechtes Ziehen auf dem Balken wechselt nicht den Artikel (vom Wischen ausgenommen). Der Miniplayer-Balken bleibt reine Anzeige. Technik: gemeinsame Funktion `enableScrubBar` (+ `SCRUB_HOLD_MS`, `SCRUB_TAP_MOVE_PX`, Sprechblase `.scrub-bubble`, fest positioniert) in `public/app.js`; Reader, `wireAudioPlayer` und das Hörbuch-Detail verwenden sie, die alten Klick-Handler entfallen. Geprüft im Testserver für alle drei Balken (Tippen, Halten, Halten+Ziehen, sofort Ziehen, Abbruch, kein Artikelwechsel), nicht auf einem echten iPhone.
- Deployment: `app.js?v=55`, `audiobooks.js?v=6`, `book-reader.js?v=9`, `styles.css?v=72`; kein Neustart nötig.

## 6c. Sperrbildschirm: Artikel-Audio mit Bild (01.10.2026)

- Artikel-Audio setzte keine Media Session; iOS zeigte deshalb das Favicon. Jetzt (`setArticleMediaSession` in `public/app.js`, gesetzt beim Abspielen): Titel, Autor (ohne Unterstriche), Album „WebArchiv“ und als Bild der **obere Teil des Artikelbilds, quadratisch**; gibt es mehrere Bilder (Artikel + Infografiken, `article.images`), gilt **immer das zweite** (Entscheidung 01.10.). Die Anzeige wird schon beim Klick auf Abspielen gesetzt (vor `play()`), damit iOS das Bild sofort übernimmt. Ohne Artikelbild: `apple-touch-icon.png`.
- Bild über die vorhandene Vorschau-Route: `GET /og-image/<id>?sq=256|512` (sharp `fit: cover, position: top`, JPEG q80, gecacht je mtime und Größe; andere Werte liefern das normale Vorschaubild). **Bewusst ohne Anmeldung**, weil iOS das Lock-Screen-Bild außerhalb der Seite lädt; es zeigt dasselbe Bild wie die schon öffentliche Link-Vorschau (Abschnitt 4), nur kleiner.
- Steuerung vom Sperrbildschirm/Kopfhörer: Play, Pause, ±15 s, Position setzen; der Wiedergabeknopf in der Artikelansicht zieht bei Pause/Play von außen mit. Artikelwechsel oder Stopp gibt die Session frei bzw. überlässt sie dem geladenen Hörbuch; beim Abspielen holt sich das Hörbuch die Session zurück.
- **Leeres Feld statt Favicon (01.10., iPhone):** Lädt iOS die Bild-URL nicht, bleibt das Bildfeld leer. Deshalb wird das Bild zusätzlich als **Data-URL eingebettet** (Abruf per `fetch`, danach Metadaten neu setzen; Zwischenspeicher je URL; Fallback bleibt die URL). Auf dem iPhone bestätigt (01.10.): mit dem eingebetteten Bild erscheint das Artikelbild; die vorübergehende Diagnose (`?mediadebug=1`) wurde danach wieder entfernt.
- **Hörbücher unverändert:** ihr Sperrbildschirm-Bild bleibt das Cover aus `/audio-files/…`; ein quadratischer Ausschnitt ohne Anmeldung kam nicht in Frage, weil Hörbücher nie öffentlich sind.
- Geprüft am 01.10.2026: Testserver, Route liefert 512×512 mit dem oberen Bildteil (Hochformat-Testbild), ungültige Größe liefert das normale Bild; Browser: Metadaten, Artwork-URLs, Knopfzustand, Freigabe. **Nicht geprüft:** echtes iPhone (Sperrbildschirm), ob iOS das Bild ohne Cookie lädt (dafür ist die Route offen).
- Deployment: `server.js` geändert → Dienst neu starten; `app.js?v=51`, `audiobooks.js?v=4`. Das Artikel-Bild kommt nur mit dem neuen `server.js` (`?sq=`); ohne diesen Stand bleibt das Favicon, weil die Route das Bild dann nicht quadratisch liefert bzw. unbekannt ist.

## 6d. EPUB → Markdown für Hörbuch-eBooks (01.10.2026)

Entscheidungen des Benutzers: EPUB als eBook-Format der Hörbücher **nicht** im Server oder Reader unterstützen, sondern ein **Umwandlungsskript** (einmalig, offline), das Bilder, Verweise, Inhaltsverzeichnis, Fußnoten und Endnoten korrekt in Markdown überführt; **Variante 1 für Fußnoten** (Sprunglinks, App/Reader unverändert); eigenes **Unterverzeichnis mit eigenen Abhängigkeiten**, damit nichts anderes beeinflusst wird. Die Test-EPUBs liegen in `download/epub/`.

- **Ablage/Aufruf:** `epub-tool/` (eigenes `package.json`, `type: module`, `adm-zip` + `htmlparser2`; `node_modules` ignoriert). `node epub-tool/epub-to-md.js "Buch.epub" [--out <Buchordner>] [--name <Name>] [--force] [--dry-run]` schreibt `<Buchordner>/<Name>.md` + `images/`. Ohne `--out` entsteht ein Ordner neben dem EPUB; Name = Ordnername (Reader-Regel). `convert.js` ist die reine Bibliothek (`convertEpub`, `checkMarkdown`), `epub-to-md.js` das CLI. Tests: `npm test --prefix epub-tool` (5 Tests mit selbst gebauten EPUBs).
- **Format (wie die vorhandene Datei „Komm, wie du willst“):** Sprungziele immer als ausdrücklicher Anker `<a id="a-N"></a>` (keine Überschriften-Kürzel, keine Zählung nötig; Überschriften tragen ihren Anker selbst); Verweise `[Text](#a-N)`; Noten `<a id="ref-N"></a><sup>[Marke](#anm-N)</sup>` im Text und `<a id="anm-N"></a>**N.** Text [↩](#ref-N)` unter „Anmerkungen“ am Ende; Bilder flach nach `images/`. Verweis ohne Ziel wird zu Text (und gemeldet), Rücksprünge aus Noten erzeugen keine Anker.
- **Inhaltsverzeichnis:** aus nav (EPUB 3) oder ncx; ersetzt das im EPUB mitgelieferte Verzeichnis-Kapitel (Erkennung über `epub:type`/`doc-toc`, nav-Datei, `guide`, sonst „fast nur Verweise auf andere Kapitel“); Platzhaltereinträge `[…]` und Einträge ohne Ziel entfallen; Verweise auf das alte Verzeichnis oder das Notenkapitel zeigen auf die erzeugten Abschnitte (`#inhaltsverzeichnis`, `#anmerkungen`). Zeigt das Verzeichnis nur auf den Dateianfang bzw. einen leeren Anker am Ende des Vorabsatzes (Calibre), wird der folgende **fette** Absatz zur Überschrift (Ebene = Verzeichnisebene + 1) und trägt den Anker.
- **Hervorhebungen:** Platzhalter, die erst im fertigen Absatz zu `*`/`**` werden, wenn CommonMark sie dort versteht, sonst `<em>`/`<strong>` (z. B. `*Wort-*Modus`); reine Satzzeichen werden nicht hervorgehoben. Fett/Kursiv aus CSS-Klassen (Calibre `span.bold`) wird ausgelesen. NBSP-Absätze und Leerabsätze entfallen. Unsichtbare Zeichen stehen im Quelltext als Konstanten (`String.fromCharCode`), nicht als Literale.
- **Noten-Erkennung:** `epub:type`/`role` (noteref, footnote, endnote) oder, ohne Auszeichnung, kurze Marke in `<sup>` mit Rücksprung in der Note. Ein Kapitel, das nur aus Noten (und deren Überschrift) besteht, entfällt im Text; seine Überschrift wird der Titel der Anmerkungen.
- **Geprüft am 01.10.2026:** 5/5 Tests; alle sieben Bücher aus `download/epub/` (50 Fragen, fünf Kerstin-Werner-Bücher, Komm wie du willst) laufen durch, mit `marked` gerendert lösen sich alle Verweise auf vorhandene Anker auf, alle Bilder existieren. „Komm, wie du willst“: 171 Verweise/203 Anmerkungen/520 interne Verweise, im Wortvergleich mit der bisherigen `.md` nur zwei Abweichungen („Knaur eBooks“ und von Hand ergänzte „(Nr. 1)“). **Nicht geprüft:** Anzeige der neuen Dateien im laufenden Reader auf dem Handy; EPUBs anderer Verlage/Generatoren (EPUB 2 mit ungewöhnlichen Strukturen) – Warnungen der Ausgabe beachten.
- **Deployment:** keine Serveränderung. `epub-tool/` ist Entwicklungswerkzeug (nicht auf den Server nötig); das Ergebnis (`.md` + `images/`) in den Buchordner legen, danach Reindex. Eine vorhandene `.md` des Buchs nur mit `--force` ersetzen (Sicherung vorher).

## 6e. Reine eBooks bei den Hörbüchern (01.10.2026)

Entscheidungen des Benutzers: Reine eBooks ohne Audio sollen unter „Hörbücher“ erscheinen; ein **kleines Badge „eBook“** ersetzt in der Kachel die Teile-Zahl. **Reine EPUB-Dateien** werden dabei nicht unterstützt (vorher mit `epub-tool/` in `.md` umwandeln, Abschnitt 6d).

- **Regel (`audiobooks.cjs`, `scanBook`):** Ein Ordner ohne Audio zählt als Buch, wenn er eine eBook-Datei hat (`<Ordnername>.md|.txt|.pdf`, Abschnitt 6b); sonst bleibt er unsichtbar (auch mit `abstract.md`). Reine eBooks haben `trackCount: 0`, `tracks: []`, `ebookOnly: true`, nie `progress`. Hörstand speichern wird für sie abgewiesen (400, kein Track); die Leseposition (`audiobook-text-progress`) geht wie bisher.
- **Sortierung:** „Zuletzt gehört/gelesen“ (vorher „Zuletzt gehört“) nutzt `progress.lastActivity(email, bookId)` = jüngster Zeitpunkt aus Hörstand **und** Leseposition; dadurch rutschen auch gelesene Bücher mit Audio nach vorn.
- **Oberfläche (`public/audiobooks.js`):** Kachel mit Buch-Symbol und „eBook“, ohne Fortschrittsbalken; Detail ohne Player (`#book-player` fehlt), mit „Text lesen“ und (Admin) „Aktionen“ bei vorhandener `abstract.md`. `bookEnsureLoaded` ignoriert Bücher ohne Tracks (der Reader lädt dadurch keinen Player und zeigt keinen Miniplayer; läuft gerade ein anderes Hörbuch, bleibt sein Miniplayer). Der Beobachter, der `currentBookDetail` leert, prüft jetzt `[data-book-detail]` statt `#book-player`, sonst ginge „Abstract editieren“ bei reinen eBooks verloren.
- **Geprüft am 01.10.2026:** 45/45 Tests (neu: reines eBook – erscheint, kein Audio, Ordner ohne Text bleibt draußen, Hörstand abgewiesen, Sortierung mit Leseposition); Browserprüfung mit Testkopie und Testnutzer (Badges „Hörbuch · 2 Teile“/„eBook“, Detail ohne Player, Reader mit Sprunglink und „Zurück“, Leseposition 0,5 gespeichert und nach Wiederöffnen wiederhergestellt, Sortierung, Buch mit Audio unverändert inkl. Miniplayer, PDF-eBook-Detail, keine Konsolenfehler). **Nicht geprüft:** Handy/iPhone, PDF-Anzeige eines reinen PDF-eBooks im Viewer (nur Detail), Kachel in Listen- und Länglich-Ansicht.
- **Deployment:** `audiobooks.cjs` geändert → Dienst neu starten; `public/audiobooks.js?v=5`, `index.html` (Sortierlabel). Reine eBooks als Ordner `audio/Hoerbuecher/<Name>/` mit `<Name>.md` (+ `images/`, optional `cover.jpg`, `abstract.md`) anlegen, dann Reindex.

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
- Der Weg ist `SIGHUP`: `scraper/run-scrape.sh` sendet `kill -HUP` an die MainPID, ohne sudo (Abschnitt 40).

Quellen: [G2], [G4], [G13], [D2], [D3], [D4].

## 8. Oberfläche und Markdown-Editor

### Grundbedienung

Aus der frühen Aufbauphase stammen Dark-/Light-Modus, persistierte Schriftwahl, quadratische/längliche Kacheln, Filter und Seitennavigation. Der Stil ist „Warm Editorial“ mit dunklem Standard und warmen Akzentfarben. Artikel lassen sich per Pfeiltasten, Buttons und Touch-Swipe wechseln. Pinch-Zoom, Panning und Textmarkierung dürfen dabei keinen unbeabsichtigten Artikelwechsel auslösen. Deep-Links werden auch nach einer erforderlichen Anmeldung wieder aufgelöst.

### Logo (03.10.2026)

Kein Abstand mehr zwischen dem goldenen „W“ und „ebArchiv“ (`.site-logo { gap: 0 }`). Ein Klick auf das Logo führt zur Startseite: Bild-Vollansicht und Artikel schließen (bei ungespeicherten Editor-Änderungen mit Rückfrage, Abbruch hält an), danach dasselbe wie „Reset“ (Suche, Filter, Telegram, Lesezeichen-Filter, Ansicht länglich, 24 pro Seite, Seite 1) und nach oben scrollen. Der Hover-Effekt (Akzentfarbe) gilt nur noch für Geräte mit Maus (`@media (hover: hover)`), sonst blieb „ebArchiv“ nach dem Tippen auf dem iPhone eingefärbt; das Logo verliert nach dem Klick den Fokus. Geprüft im Testserver. `app.js?v=58`, `styles.css?v=74`.

### Sitzungsansicht und Layoutwechsel (05.10.2026)

- Mobile Browser und PWA-Fenster dürfen im Hintergrund vollständig verworfen werden. `public/session-state.js` speichert deshalb einen versionierten Zustand in `localStorage`, getrennt nach Benutzer bzw. Gast; keine Zugangsdaten, Tokens oder Artikeltexte.
- Wiederhergestellt werden Suche, Autor-/Audio-/Jahr-/Kategorie-/Telegram-/Lesezeichenfilter, Seite, Seitengröße, Kachel-/Listenlayout, Hörbuchsortierung, Listenanker, geöffneter Artikel oder Hörbuch, dessen Dialogposition und ein geöffneter eBook-Reader. Der eBook-Lesestand und Hörbuch-Hörstand bleiben wie zuvor serverseitig pro Nutzer gespeichert.
- Ein anderer expliziter `#/article/...`-Link hat Vorrang. Entspricht der Hash jedoch der gespeicherten Ansicht, gilt er als wiederaufgebautes PWA-Fenster und erhält auch Dialogposition bzw. eBook-Reader. Nicht mehr zugängliche Einträge fallen auf die gespeicherte Liste zurück.
- Das Umschalten zwischen quadratisch, länglich und Liste setzt weder Filter noch Seite zurück. Weil Liste und Kacheln unterschiedliche Gruppierung verwenden, wird erforderlichenfalls neu geladen; sichtbarer Kartenanker und Offset werden danach wiederhergestellt. Ist die alte Seite nicht mehr vorhanden, wird nur bis zur letzten gültigen Seite begrenzt.
- Die Listenposition ist an den aktuell ausgewählten Autor bzw. „mit Audio“ gebunden, nicht an das Layout. Beim Layoutwechsel desselben Autors bleibt sie erhalten; nach einem Autorenwechsel beginnt die neue Ergebnisliste oben und übernimmt nicht die Scrollposition des vorherigen Autors.
- Gespeichert wird nach relevanten Zustandsänderungen und gedrosselt beim Scrollen, zusätzlich bei `visibilitychange` und `pagehide`. Der zuletzt beobachtete Dialogstand bleibt im Speicher, damit ein Browser ihn beim Entladen nicht mit `0` überschreibt. Bild- und Fontlayout wird vor der endgültigen Scrollwiederherstellung abgewartet.
- Bewusst nicht automatisch fortgesetzt werden Audio-/Videowiedergabe sowie Login-, Einstellungen-, Admin-, Editor- und TTS-Dialoge. Beim ausdrücklichen Abmelden wird der lokale Zustand dieses Benutzers gelöscht.
- Dateien/Cache: `public/session-state.js?v=2`, `public/app.js?v=66`, `public/book-reader.js?v=10`. Automatisiert geprüft: Normalisierung, Benutzertrennung, Löschen, beschädigte Daten und Zuordnung der Listenposition zum Autor. Im Browser geprüft: Filter, Seitengröße, Seite 2, Layoutwechsel ohne Seitenreset, Artikeldetail und dessen Scrollposition über vollständigen Reload; keine Konsolenfehler. eBook-Reader-Wiederöffnung wurde mangels angemeldetem Testnutzer nicht im Browser ausgeführt.

### Kacheldichte per Geste (07.10.2026)

- Quadratische und längliche Ansicht besitzen getrennt gespeicherte bevorzugte Kachelbreiten. Zwei Finger dürfen auf unterschiedlichen Kacheln oder Zwischenräumen desselben Rasters starten: Zusammenziehen verkleinert, Spreizen vergrößert die Kacheln. `touch-action: pan-y` auf dem gesamten Raster hält die Zwei-Finger-Geste bei der Anwendung, erlaubt aber weiterhin normales vertikales Scrollen; zuvor galt diese Regel nur für Bildergalerien, sodass der Browser Gesten auf Textflächen übernehmen konnte. Nach jeder Zwei-Finger-Geste werden Kartenklicks kurz unterdrückt. In der Listenansicht bleibt die Geste wirkungslos.
- Am Desktop steuert `Strg`+Mausrad über dem Raster dieselbe Funktion (nach unten = mehr, nach oben = weniger Spalten). Normales Scrollen, Bildvollansicht und Seitenzoom außerhalb des Rasters bleiben unverändert.
- Möglich sind eine bis acht Spalten; auf schmalen Geräten begrenzt eine Mindestbreite von 110 px die effektive Zahl. Bei Drehung oder Fenstergrößenänderung wird aus der bevorzugten Breite eine neue Spaltenzahl berechnet, sodass die Kachelgröße ungefähr erhalten bleibt. Ein kurzer Statushinweis zeigt nach einer Geste die neue Anzahl. Der sichtbare Kartenanker wird nach dem Umfluss wiederhergestellt.
- `#app` nutzt nun bis zu 1920 px statt 1400 px. Responsive Vorgaben: zwei Spalten bis 720 px, drei bis 1100 px, vier bis 1450 px, fünf bis 1750 px, darüber sechs. Sie gelten, solange noch keine bevorzugte Kachelbreite gewählt wurde; Reset stellt sie wieder her. Die Größenberechnung liegt testbar in `public/grid-density.js`; der Hoch-/Querformatfall und getrennte Breiten je Ansicht sind automatisiert geprüft. Cache: `styles.css?v=80`, `session-state.js?v=4`, `grid-density.js?v=1`, `app.js?v=69`.

### Ergebnisseiten per Wischgeste (07.10.2026)

- In quadratischer, länglicher und Listenansicht wechselt eine deutliche horizontale Einfinger-Geste innerhalb des Artikelbereichs zur nächsten bzw. vorherigen Ergebnisseite. Dadurch springt sie abhängig von der gewählten Seitengröße um 12, 24, 48 oder 96 Artikel; Filter und Seitengröße bleiben erhalten, anschließend steht die Ansicht wieder am Anfang des Artikelbereichs.
- Ein Wisch muss mindestens 80 px horizontal sein und die horizontale Bewegung gegenüber der vertikalen überwiegen. Es gibt bewusst kein Zeitlimit, damit auch langsame Bewegungen gelten. Nur die äußersten 30 px bleiben als Startbereich für die Browsergesten Zurück/Vorwärts frei; dadurch kann die gesamte rechte und linke Kachel bis auf diesen schmalen Rand als Startfläche dienen. Der Finger muss beim Loslassen die äußerste 30-px-Zone der Zielseite erreicht haben (links hinaus = nächste, rechts hinaus = vorherige Seite). Auf iOS wird die Richtung bei der ersten Bewegung festgelegt: horizontal übernimmt WebArchiv die Geste sofort mit `preventDefault()`, vertikal bleibt sie beim nativen Scrollen. Ein `touchcancel` nach bereits eindeutig horizontaler Bewegung wird wie Loslassen ausgewertet.
- Bildergalerien in Kacheln behalten ihre eigene kurze Wischgeste. Erreicht ein langer Wisch aus einer Galerie den gegenüberliegenden Fensterrand, hat der Ergebnisseitenwechsel Vorrang. Mehrfinger-Gesten, Pinch-Zoom, überwiegend vertikales Scrollen und interaktive Bedienelemente lösen keinen Seitenwechsel aus. Ein erkannter Wisch unterdrückt den nachfolgenden Kachelklick; an erster und letzter Seite bleibt die nicht mögliche Richtung ohne Seitenwechsel.
- Seitenbuttons und Wischgesten verwenden denselben Seitenwechselweg. Seite, Seitengröße und die neue Listenposition werden im vorhandenen Sitzungszustand gespeichert. Technik: `public/page-swipe.js`, Integration in `public/app.js`, Cache `page-swipe.js?v=5`, `app.js?v=75`.
- **Praxistest auf dem iPhone am 07.10.2026 bestätigt:** langsames Wischen funktioniert in der installierten PWA. Der zunächst verwendete Startschutz von 80 px war auf der rechten Kachel zu breit und wurde nach dem Praxistest auf die äußersten 30 px reduziert. Seitdem funktioniert auch ein Start auf der rechten Kachel zuverlässig; die Browser-Randgesten bleiben in der 30-px-Zone verfügbar.

### PWA-Aktualisierung (07.10.2026)

- `GET /service-worker.js` wird dynamisch mit einer aus den obersten Dateien unter `public/` berechneten Versionssignatur ausgeliefert (`no-cache`, Gültigkeitsbereich `/`). Der Worker besitzt bewusst keinen Fetch-Handler und keinen Offline-Cache; er dient nur als zuverlässiges Änderungssignal und kann deshalb keine alte App-Shell festhalten.
- `public/pwa-update.js` registriert den Worker mit `updateViaCache: none` und prüft beim Laden, beim Wiederanzeigen der App, nach Rückkehr der Verbindung und alle 15 Minuten. Eine neue Worker-Version wartet auf die ausdrückliche Zustimmung des Benutzers.
- Der feststehende Hinweis „Neue Version verfügbar“ bietet „Jetzt aktualisieren“ und „Später“. Beim Aktualisieren aktiviert `SKIP_WAITING` den neuen Worker; anschließend wird dieselbe URL einschließlich Artikel-Hash mit einem einmaligen Cache-Buster geladen. Gespeicherte Sitzungsansicht und Login bleiben erhalten. Solange ein Dialog geöffnet ist, fordert der Hinweis zuerst zum Schließen auf, damit keine Eingabe verloren geht.
- Diese Version muss einmal regulär geladen werden, um den Update-Worker in einer bereits angelegten iPhone-Web-App zu registrieren. Danach benötigen normale HTML-/CSS-/JavaScript-Aktualisierungen keine Neuinstallation. Vom Betriebssystem verwaltete Eigenschaften des Home-Screen-Eintrags wie Name oder Icon können von iOS weiterhin separat gecacht werden. Cache: `styles.css?v=82`, `pwa-update.js?v=1`.
- **Praxistest auf dem iPhone am 07.10.2026 bestätigt:** Der Hinweis „Neue Version verfügbar“ erscheint in der bestehenden installierten PWA und aktualisiert sie erfolgreich. Ein Löschen oder erneutes Anlegen der PWA ist nicht erforderlich.

### Filterleiste auf Tablets (07.10.2026)

- Die Filterleiste nutzt nun dieselbe maximale Breite und dieselben responsiven Seitenränder wie der Kachelbereich (`max-width: 1920px`, `clamp(16px, 2vw, 32px)`). Dadurch stehen im iPad-Hochformat 16 px mehr Nutzbreite zur Verfügung.
- Nach dem Laden der Filter und bei jeder Größen- oder Orientierungsänderung wird mit sichtbaren Beschriftungen gemessen, ob „Kategorie“ noch in der ersten Zeile liegt. Nur wenn es umbricht, werden die Beschriftungen ausgeblendet; sobald wieder genug Platz besteht, erscheinen sie erneut. Unter *Einstellungen → Filter-Beschriftungen* kann diese Automatik auf „Ausblenden“ gestellt werden, damit etwa das iPad mini im Querformat nur eine Filterzeile benötigt. Die Auswahl wirkt sofort und wird im lokalen Browser pro Nutzer gespeichert (`wa-filter-labels:<E-Mail>`), ist also zugleich nutzer- und gerätebezogen. Im Browser bei 768 und 1024 CSS-Pixel Breite sowie mit Neuladen geprüft. Cache: `styles.css?v=82`, `settings.js?v=2`, `app.js?v=71`.

### Kopieren und Aktionen

- Der frühere zweiteilige Copy-Button wurde ersetzt: **nur das Kopiersymbol**, kein sichtbares „copy“ und keine Trennlinie.
- Ein Klick öffnet immer das Kopiermenü. „Artikel“ kopiert ohne Prompt; die weiteren Einträge kommen aus `prompts/`.
- Dateinamen wie `1_...txt` bestimmen Reihenfolge und bereinigte Menübezeichnung. Der ausgewählte Prompt wird dem Artikeltext vorangestellt.
- **Nachtrag 06.10.2026:** Prompt-Dateien enthalten nun getrennte Abschnitte `URL:` und `PROMPT:`. Bei allen Menüeinträgen außer „Artikel“ wird weiterhin nur der Prompt vor den Artikeltext in die Zwischenablage kopiert; zusätzlich öffnet sich die validierte HTTP(S)-URL in einem neuen Tab. Ungültig formatierte Prompt-Dateien werden nicht im Menü angeboten.
- Tooltip für das Kopiersymbol: „Kopieroptionen“. Tooltip für Aktionen: „Artikel bearbeiten und Audio erzeugen“.
- Die Aktionsleisten-Buttons wurden auf einheitlich 22 px Höhe und 20 px Radius gebracht; regulärer Abstand 8 px.
- Ein leeres Upload-Statusfeld darf zwischen „neue Grafik“ und Kopieren keinen zusätzlichen Abstand erzeugen.
- Das Aktionen-Dropdown beginnt unter dem Button. Nur bei Randüberschreitung wird es verschoben; 8 px Randabstand und begrenzte Breite halten es im Viewport.
- Erneuter Buttonklick und Außenklick schließen das Menü.
- „Audio erzeugen“ bleibt in der Artikel-Detailansicht. Die erste Entfernung traf versehentlich diese Stelle und wurde korrigiert; entfernt werden sollte der globale Menüeintrag der Übersicht. Die Anzeige bestehender Audio-Aufträge bleibt verfügbar.

### Nach unten wegziehen (30.09.2026)

Auf Touch-Geräten schließt Herunterziehen die Artikel- bzw. Hörbuch-Detailansicht, wenn sie beim Aufsetzen ganz oben steht, und ebenso die Bild-Vollansicht (zusätzlich zum Tippen; nicht bei Zoom). Die Ansicht folgt dem Finger, der Hintergrund hellt auf; ab 120 px schließt sie beim Loslassen, sonst federt sie zurück. Nur bei deutlich senkrechter Bewegung; waagerechtes Wischen wechselt weiter den Artikel. Nicht aus der wischbaren Bildleiste, bei markiertem Text, Pinch-Zoom oder offenen Dialogen. `overscroll-behavior-y: contain` verhindert „Pull to refresh“. Technik: `enablePullToClose` in `public/app.js`. Vom Benutzer am 30.09. in Safari und Chrome auf dem iPhone bestätigt.

Safari-Erkenntnisse (Chrome auf dem iPhone verhielt sich jeweils anders, trotz gleicher Engine):
- Die Richtung muss bei der **ersten** `touchmove` festgelegt und `preventDefault` sofort gerufen werden, sonst übernimmt iOS das Scrollen; `touchcancel` wie Loslassen behandeln.
- Safari (Adressleiste unten) ließ die **Seite hinter dem Overlay** federn. Lösung: `html.overlay-open` (per MutationObserver auf `$overlay[hidden]`) mit `overflow: hidden; overscroll-behavior: none`, Panel `overscroll-behavior-y: none`.
- Safari meldete `visualViewport.scale = 1.15` (Auto-Zoom nach Antippen von Suchfeld/Filtern < 16 px oder Seitenzoom „Aa“). Deshalb zählt als Zoom nur, was über der Grundvergrößerung beim Laden liegt (`pinchZoomed`), und bei Vergrößerung ist die Geste erlaubt, wenn der sichtbare Ausschnitt oben steht (`visualViewport.offsetTop`). Gilt auch für `swipeAllowed`.
- `index.html` wird mit `Cache-Control: no-cache` ausgeliefert (server.js), damit Safari keine alte Seite mit alten `?v=`-Verweisen hält.
- Diagnose-Hilfe (`?pulldebug`) wurde nach erfolgreichem Test wieder entfernt.
- **Weitere Dialoge (03.10.):** Auf Benutzerwunsch lassen sich alle Dialoge mit Schließen-Möglichkeit ebenfalls nach unten wegziehen: Audio-Auftrag, Anbieterwahl, Scrape-Log, Anmeldung, Einstellungen, Kennwort, Benutzerverwaltung, Artikel-Editor, Neue Infografik (`PULL_DIALOGS` in `public/app.js`). Ziehen löst denselben Knopf aus wie ✕/Abbrechen, also auch die Rückfrage bei ungespeicherten Änderungen. Nicht beim Pflicht-Kennwortdialog (Knopf ausgeblendet), nicht aus Eingabefeldern und nicht aus bereits gescrollten Bereichen (Log, Listen). Ein Dialog über dem Artikel schließt nur sich selbst. Der eBook-Reader ist bewusst nicht dabei. Geprüft mit simulierten Touch-Gesten in Handy-Breite, nicht auf einem echten iPhone.
- Offen/Vorschlag: Suchfeld und Filter-Auswahl auf dem Handy auf 16 px, damit Safari beim Antippen nicht mehr hineinzoomt (nicht beauftragt).

### 8a. Einstellungen und Lesezeichen (02.10.2026)

Entscheidungen des Benutzers:

- **Einstellungen:** Das Auswahlfeld „Schrift“ (Filterleiste) und der Hell/Dunkel-Button (Header) entfallen. Neuer Eintrag *Einstellungen* im Aktionen-Menü vor „Benutzerverwaltung“ (Admin und Nutzer). Dialog: **Schriftart** (Editorial, Klassisch, Modern, System), **Darstellung** (Hell, Dunkel, **Automatisch** = folgt `prefers-color-scheme`, live), **Textgröße im Artikel** (Klein 0,9 / Normal 1 / Groß 1,15 / Sehr groß 1,3 rem; nur `.detail-body`, der eBook-Reader behält sein A−/A+ per Inline-Stil) und **Filter-Beschriftungen** (Automatisch/Ausblenden). Wirkt sofort, kein Speichern-Knopf; „Fertig“, Escape oder Klick daneben schließen.
- **Speicherort:** Schrift, Darstellung und Textgröße bleiben pro Gerät gespeichert (`localStorage`: `wa-font`, `wa-theme`, `wa-text-size`; vorhandene Werte bleiben gültig). Filter-Beschriftungen liegen ebenfalls lokal, aber zusätzlich pro Nutzer unter `wa-filter-labels:<normalisierte E-Mail>`; damit kann dasselbe Konto auf unterschiedlichen Geräten und jeder Nutzer auf demselben Gerät eine eigene Auswahl haben. Neue Geräte/Nutzer: Filter automatisch, Darstellung automatisch, Schrift System, Textgröße normal. **Gäste bekommen immer diese Vorgaben** (kein Aktionen-Button), gespeicherte Werte gelten wieder nach der Anmeldung.
- Ansicht und „Pro Seite“ bleiben wie bisher in der Filterleiste (nicht in den Dialog).
- **Lesezeichen nur für angemeldete Nutzer, pro Nutzer auf dem Server.** Header-Button an der Stelle des alten Hell/Dunkel-Buttons: aktiv blau (wie Telegram, Symbol gefüllt), zeigt nur Artikel mit Lesezeichen; Autor/Jahr/Kategorie/Suche filtern weiter; Sortierung nach Artikeldatum. Im Artikel ein Button zwischen Kopieren und Teilen: Klick setzt (blau), erneuter Klick löscht. Kacheln (auch Liste) mit Lesezeichen tragen ein kleines blaues Symbol (16 px wie das Header-Symbol, ohne Hintergrund, Entscheidung 02.10.) oben rechts (Liste: auf dem Vorschaubild links).
- Festgelegte Vorgaben: Bei aktivem Filter erscheinen Telegram-Lesezeichen auch ohne Telegram-Schalter; „Reset“ schaltet den Filter aus; Hörbücher haben keine Lesezeichen (Button dort gedimmt); leere Liste „Noch keine Lesezeichen“ bzw. „Keine Lesezeichen gefunden“; die Trefferzahl zählt im Filter jede Kachel einmal (sonst Artikel + Grafiken). Ein im Artikel entferntes Lesezeichen verschwindet erst beim Schließen aus der Lesezeichen-Liste (Blättern bleibt stabil).

Technik:

- `public/settings.js` (vor `app.js` geladen): `applyDisplaySettings`, `setDisplayUser` (aus `applyUserUI`), Dialog `#settings-dialog`. CSS-Variable `--article-text-size`; Überschriften in `.detail-body` jetzt in `em` (wachsen mit).
- `bookmarks.cjs`: `bookmarks.json` (gitignored, atomar, Modus 600, Pfad per `BOOKMARKS_FILE`), Schlüssel E-Mail (klein) → Artikel-ID → Zeitpunkt. `PUT /api/bookmarks/*` (Artikel muss im Index sein und der Autor erlaubt) und `DELETE /api/bookmarks/*` (auch verwaiste Einträge), angemeldet, Cross-Site-Schutz; `mustChangePassword` sperrt sie wie alle `/api/*`. Beim Löschen eines Nutzers entfallen seine Lesezeichen.
- `server.js`: `/api/articles?bookmarks=1` filtert nach dem Rechtefilter und vor der Gruppierung; alle Einträge und der Einzelartikel tragen `bookmarked`. Eine Gruppe erscheint, wenn ihr Anker ein Lesezeichen hat (der Artikel-Dialog setzt es immer auf den Anker).
- `public/app.js`: `setBookmarkFilter`, `toggleBookmark`, `.card-bookmark`; `handleImgError` ersetzt nur noch das Bild (Badges und Lesezeichen bleiben bei defektem Bild stehen).
- Geprüft am 02.10.2026: 49/49 Tests (neu `test/bookmarks.test.cjs`: Speicher, Neuladen, Gast, Nutzer löschen, Routen mit Rechten/404/Cross-Site/401). Browser mit Testserver, Testnutzern und eigener `bookmarks.json` (echte Dateien unberührt): Menüeintrag, Dialog (sofortige Wirkung, Speichern über Neuladen, Automatisch folgt dem Gerät live), Textgröße, Lesezeichen setzen/entfernen, Header-Filter mit Jahr/Kategorie, Telegram-Lesezeichen, Entfernen beim Schließen, Kachel- und Listensymbol, Handy-Breite ohne seitliches Scrollen, Gast (Vorgaben, kein Button, `PUT` → 401). **Nicht geprüft:** echtes iPhone/Safari.
- Deployment: `server.js` geändert und `bookmarks.cjs` neu → beide kopieren, Dienst neu starten. Frontend: `public/settings.js` neu, `app.js?v=54`, `styles.css?v=69`, `index.html`. `bookmarks.json` entsteht beim ersten Lesezeichen im App-Verzeichnis (Schreibrecht für `ralf` besteht wie bei `audiobook-progress.json`).

### Bildvollansicht

Die endgültige Bedienung nach mehreren Korrekturen:

- Kein „Verkleinern“-Icon und keine Prozent-/Statusanzeige.
- Desktop: Mausrad zoomt um die **Bildmitte**; die ursprüngliche Idee des Zooms am Cursor wurde ersetzt.
- Doppelklick wechselt zwischen eingepasster Größe und 200 Prozent.
- Ein vergrößertes Bild lässt sich mit der Maus verschieben.
- Desktop-Einfachklick auf das Bild ist neutral; Hintergrundklick und Escape schließen.
- Touch-Geräte: Ein einfacher Tap auf das Bild schließt die Vollansicht wieder. Diese Ausnahme wurde nach einem iPhone-Problem ergänzt. Pinch-Zoom bleibt zu berücksichtigen.
- **Bild herunterladen (03.10.):** Auf dem iPhone ließ sich Safaris Abfrage für `<a download>` nicht abbrechen. Auf Touch-Geräten mit `navigator.canShare` öffnen beide Download-Knöpfe (Artikelbild und Vollansicht) jetzt das System-Teilen-Menü mit der Bilddatei („Bild sichern“ → Fotos), jederzeit abbrechbar. Am PC bleibt der normale Download. Weil iOS das Teilen-Menü nur direkt nach dem Tippen öffnet, wird das Bild beim Anzeigen schon geladen (`prepareImageFile`, die letzten 3 Bilder im Speicher). Ist es noch nicht bereit, erscheint „Bitte noch einmal tippen“; ohne Teilen-Funktion öffnet sich das Bild in einem neuen Tab. Geprüft mit einem Stellvertreter für `navigator.share` (Datei, Name, Typ, Abbrechen), nicht auf einem echten iPhone.

### PDF.js

Ein CDN-Laden wurde besprochen, dann ausdrücklich ein anderer Weg gewählt: Der vollständige Viewer wurde nach `public/vendor/pdfjs/` verschoben und die iframe-URL angepasst. Dadurch wird die Drittanbieterbibliothek nicht mehr vom Graft-Kontextgraphen indexiert. Alte Hinweise auf einen direkten Ablageort unter `public/` sind überholt. Die PDF-Dateien selbst werden weiterhin über die geschützte Medienroute geladen.

### Vollständigen Artikel editieren

**Aktionen → Artikel editieren** öffnet für einen berechtigten Admin einen Dialog mit der kompletten Originaldatei. Kein Rückübersetzen des angezeigten HTML und kein Formular, das unbekannte Metadaten wegwirft.

- Endpunkte: `GET` und `PUT /api/article-markdown/*`; Dateipfad aus der indexierten Artikel-ID bestimmen.
- Admin- und Autorenrechte, Pfadgrenzen, Symlink-Prüfung, Größenlimit von 1 MB und Cross-Site-Prüfung beim Schreiben.
- SHA-256-Version des geladenen Inhalts; bei zwischenzeitlicher Änderung einen Konflikt melden und Entwurf erhalten.
- Temporäre Datei im selben Verzeichnis, Dateirechte/Eigentümer berücksichtigen, vor dem atomaren Ersetzen erneut auf Änderungen prüfen. Ursprüngliche BOM-/Zeilenendenkonventionen berücksichtigen.
- Mit Scrape, Reindex, Infografik-Schreiben und TTS koordinieren; unvollständige Dateien oder konkurrierende Schreibvorgänge vermeiden.
- Ungespeicherte Änderungen beim Schließen/Verlassen schützen. Pfeiltasten im Editor dürfen keine Artikelnavigation auslösen; veraltete asynchrone Antworten dürfen keinen neueren Dialogzustand überschreiben.
- Nach Speichern Index, Detailansicht, Liste und Filter aktualisieren. Dateiname/Artikel-ID bleiben stabil; Jahresordner werden nicht durch Datumsänderung umbenannt.
- **Teilaktualisierung (26.10.2026):** Nach dem Speichern wird nicht mehr das gesamte `www/` samt Hörbuchbibliothek gescannt. Der Server liest nur die bearbeitete Markdown-Datei neu ein, ersetzt genau diesen Eintrag im unverknüpften Rohindex und leitet Verknüpfungen, Metadaten, Suche und Duplikatstatus aus dem vorhandenen In-Memory-Bestand neu ab. Für `abstract.md` wird nur das betroffene Hörbuch aktualisiert. Dieselbe Grundlage nutzt nun TTS für den einen vertonten Artikel. Neue und verwaltete Infografiken sowie Dublettenmigrationen lesen nur die betroffenen Infografik-Jahre; eine Änderung der Autoren-Priorität veröffentlicht den vorhandenen Rohindex nur neu. Der Web-UI-Scraper übergibt ein Manifest der tatsächlich geänderten Markdown-Dateien und aktualisiert sie gesammelt; bei fehlendem/ungültigem Manifest oder Fehler dient der Vollscan als Fallback. Manueller Reindex, Serverstart und `SIGHUP` bleiben vollständige Scans.
- „Datei gespeichert, Aktualisierung fehlgeschlagen“ muss von einem gescheiterten Schreibvorgang unterschieden werden.

Zur Einführung mussten sechs Laufzeitdateien auf den Server: `server.js`, `article-editor.cjs`, `public/app.js`, `public/article-editor.js`, `public/index.html`, `public/styles.css`. Keine neuen npm-Abhängigkeiten. `test/article-editor.test.cjs` und `graft/` sind Entwicklungsbestandteile. Damals wurden neun automatisierte Tests sowie Browserprüfungen für Speichern, Abbrechen, Konflikte und mobiles Layout als erfolgreich protokolliert.

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

Unveränderte Logs werden nicht ständig neu angehängt; die Scrollposition bleibt erhalten. Polling läuft für Status und beim Qwen-Dienst zusätzlich für die Lease weiter. Die UI wartet zwischen Abfragen, vermeidet überlappende Requests und bietet nach Verbindungsfehlern eine Wiederaufnahme der Anzeige. **Nachtrag 04.10.:** Zeitstempel aller Audio-Logzeilen werden im Browser in dessen lokaler Zeit als `YYYY-MM-DD HH:MM:SS` angezeigt (keine Millisekunden und kein `Z`).

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
- Nur eine passende v5-Antwort (`webarchiv-qwen-v5`) mit vollständigem Markdown, MP3- und Chunk-Fortschrittsunterstützung gilt als verfügbar. Das beweist noch keine erfolgreiche GPU-Synthese.
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

### Qwen v5: vollständiger Artikel auf dem Modellserver (Verarbeitung aus v4, seit 04.10. mit Chunk-Fortschritt)

Auf ausdrücklichen Benutzerwunsch verarbeitet `generate_mp3_with_embedding.py` den gesamten Artikel selbst:

- WebArchiv sendet vollständiges UTF-8-Markdown einschließlich Titel, Metadaten, Links, BOM und Zeilenumbrüchen. Limit: 1.000.000 UTF-8-Bytes.
- WebArchiv wendet auf diesen Qwen-Eingang kein eigenes Markdown-Clearing, Chunking, Pre-Fill oder Kalibrieren an.
- `qwen_http_service.py` und `qwen_chunk_worker.py` bilden die HTTP-Brücke. Der Worker ruft den regulären CLI-Einstieg des unveränderten Originalscripts auf, mit dessen Konfiguration, Eingabe und Ausgabe.
- Sprache, Sprecher, Bereinigung, Chunkgrößen, Warmup, Kalibrierung, Pausen, Seed und MP3-Export werden ausschließlich vom Originalscript bestimmt; keine verdeckten Overrides.
- Ein Artikel entspricht einem Scriptlauf. Das Modell wird innerhalb dieses Laufs für dessen Chunks wiederverwendet und danach freigegeben.
- Die v3-Zusage „gleicher Seed für alle Chunks“ ist aufgehoben. `seed` und `seed_strategy` des Originalscripts gelten; bei `increment` können sich die Chunk-Seeds unterscheiden.
- Qwen liefert immer eine fertige MP3. WebArchiv prüft Codec und positive Dauer mit FFprobe und dekodiert vollständig mit FFmpeg zur Validierung; es kodiert nicht erneut.
- Die validierten MP3-Bytes werden unverändert unter dem parallelen `audio/`-Pfad veröffentlicht.
- **Chunk-Fortschritt (04.10.):** Der Worker filtert nur die unveränderten Startzeilen des Originalscripts (`Chunk 3/26: 346/520 characters (boundary: paragraph)`) und überträgt sie nummeriert. Alle anderen Qwen-Ausgaben werden verworfen. WebArchiv schreibt neue Einträge genau einmal als `[SYNTHESIS]` ins Log; `chunks: 1` im Worker-Ergebnis bedeutet weiterhin einen Remote-Auftrag.

### Qwen-HTTP-Vertrag

Alle Requests verwenden ein gemeinsames Bearer-Token. Keine direkte Browserverbindung zum Modellserver; nur WebArchiv kommuniziert serverseitig mit ihm.

| Request | Bedeutung |
| --- | --- |
| `GET /v1/health` | `protocol: webarchiv-qwen-v5`, `full_markdown: true`, `audio_format: mp3`, `chunk_progress: true`, Byte-Limit und Lease |
| `PUT /v1/jobs/<UUIDv4>` | JSON mit vollständigem `markdown`; 202 nach Annahme |
| `GET /v1/jobs/<id>` | Zustand und bis zu 100 nummerierte Chunk-Startmeldungen; erneuert Lease |
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
| v4 | Original-Markdown → Originalscript → fertige MP3 | Verarbeitung gilt weiter; Protokoll durch v5 abgelöst |
| v5 | Wie v4, zusätzlich nummerierter Chunk-Fortschritt (04.10.2026) | **Geltender Vertrag** (`webarchiv-qwen-v5`) |
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

Bei älterem Qwen-Protokoll beide Python-Dateien gemeinsam aktualisieren und beide betroffenen Dienste neu starten. Für eine reine Änderung der Radio-Buttons oder Vorauswahl braucht ein bereits funktionierender v5-Modellserver kein Update.

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

**Korrigiert am 29.10.2026 (siehe Abschnitt 40):** `run-scrape.sh` sendet `kill -HUP` an die MainPID, ohne sudo. Die Variante mit sudo kam im Cron nie an.

**Behoben am 26.10.2026 (überholt):** `scraper/run-scrape.sh` verwendet nun `sudo /usr/bin/systemctl kill -s HUP nodeapp` statt eines Dienstneustarts. Sessions und laufender Prozess bleiben dadurch erhalten. Dieser externe Cron-Weg benötigt weiterhin den vollständigen `SIGHUP`-Reindex; nur ein vom Server als Kindprozess gestarteter Web-UI-Scrape kann sein Änderungsmanifest direkt für den gezielten Teilindex übergeben. Der Produktionsstand des Wrappers muss beim Deployment weiterhin geprüft werden.

Als historischer Cron-Zeitpunkt ist `30 4 * * *` mit UTC-Serverzeit dokumentiert. Das ist nicht automatisch 04:30 Uhr deutscher Ortszeit. Teilfehler einer Scraperquelle sollen den anschließenden Reindex bereits gespeicherter anderer Quellen nicht verhindern.

### Lokaler Qwen-Test

```powershell
.\tts-server\Test-QwenServer.ps1
.\tts\Start-WebArchivQwen.ps1
```

Der erste Helfer prüft Verbindung/Vertrag ohne Audioerzeugung. Erwartet wird `webarchiv-qwen-v5` mit `full_markdown: true` und `audio_format: mp3`. Der zweite prüft Qwen und startet WebArchiv lokal. Beide fragen das Token verdeckt ab und konfigurieren keinen laufenden Debian-Dienst.

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

Die frühere Projektbeschreibung „keine Tests“ ist überholt. Tests der Hauptanwendung liegen gesammelt unter `test/`; eigenständige Pakete behalten eigene Unterordner `scraper/test/`, `epub-tool/test/` und `tts/test/`. `npm test` im Projektroot führt alle Node- und Python-Tests aus. Ein Build-/Lint-Schritt existiert weiterhin nicht.

**Aufräumen am 07.10.2026:** Alle 17 Testskripte wurden ohne Änderung der Paketgrenzen in diese vier `test`-Unterordner verschoben. Relative Modul- und Dateipfade, die Paket-Testbefehle sowie AGENTS-, README-, Claude- und TTS-Dokumentation wurden angepasst. Der neue gemeinsame Lauf bestand mit 123/123 Node-Tests und 9/9 Python-Tests; zusätzlich wurden die separaten Testbefehle für Scraper (8/8), EPUB-Werkzeug (5/5) und TTS (33/33) erfolgreich geprüft.

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
npm test
npm test --prefix scraper
npm test --prefix epub-tool
npm test --prefix tts
python -B -m unittest discover -s tts-server/test -p test_qwen_http_service.py -v
git diff --check
```

TTS-Tests verwenden simulierte Syntheseantworten, teilweise aber echte HTTP-Verbindungen, FFmpeg/FFprobe und Kindprozesse. Windows-Sandboxfehler wie `EPERM` bei Child-Spawn sind von einem fachlichen Testfehler zu unterscheiden. Blockierte Prüfungen als blockiert benennen, nicht als bestanden.

Für eine echte Abnahme gezielt Rechte, vorhandene MP3, parallele Starts, Abbruch, Popup-Wiederöffnung, Browser-Reload, Provider-Ausfall, Reindex-Fehler nach erfolgreicher MP3 und kurze/lange Hörproben prüfen. Das Öffnen des Providerdialogs allein darf keine Synthese auslösen.

## 13. Offene Punkte und überholte Dokumentation

### Konkret offen bzw. heute als Abweichung festgestellt

1. ~~**Cron-Wrapper**~~ **Erledigt:** `scraper/run-scrape.sh` löst nach dem Scrapen per `systemctl kill -s HUP nodeapp` einen Reindex aus (kein Neustart; Sitzungen bleiben). Auf dem Server war die Datei zwischenzeitlich mit CRLF eingecheckt; seit `.gitattributes` (`*.sh text eol=lf`) bleibt sie LF.
2. ~~**Qwen-v4-Liveabnahme**~~ **Erledigt (30.09.2026, vom Benutzer bestätigt):** Der Benutzer bestätigte, dass eine frühere Fassung den Modellserver aufrief und nach der Transport-/Chunkänderung funktionierte; die Liveabnahme der endgültigen v4-Verarbeitung mit der jüngsten Providerwahl wurde am 30.09.2026 vom Benutzer als durchgeführt gemeldet. Einzelheiten des Hörtests sind nicht protokolliert.
3. **Produktionsstand:** In dieser Sitzung kein SSH-Zugriff, keine Prüfung der installierten Dateiversionen, Mountrechte, Dienstvariablen oder tatsächlichen Cron-Konfiguration.
4. **Dokumentationswidersprüche:** `tts-server/QWEN-ANBINDUNG.md`, `tts/UEBERGABE-TTS.md` und `tts/DEPLOYMENT-NODE-SERVER.md` enthalten noch „keine Vorauswahl“. Geltend ist Qwen-Vorauswahl bei Verfügbarkeit. Die Übergabedatei enthält zusätzlich ausdrücklich historische v2-/v3-Abschnitte.
5. **Frühe Projektnotizen:** Aussagen über ausschließlich `server.js`, fehlende Tests, frühere PDF.js-Pfade, zweigeteiltes Copy und offene kombinierte Datums-/Textsuche sind teilweise überholt. README und Setup-Datei enthalten noch alte Facebook-URL-Eingaben und ältere Strukturangaben.
6. **BlogDownloader:** Spätere Übereinstimmung der Node- und Python-Scraper ist nicht erneut nachgewiesen. Die historisch beschlossene Synchronität bei künftigen Änderungen berücksichtigen.
7. **Audio-Reihenfolge (geprüft 28.10.2026):** Abschnitt 1, Abschnitt 6, README und Code stimmen überein: zuerst eine gleichnamige MP3 neben der `.md` unter `www/`, sonst der parallele `audio/`-Baum. Ein früher vermuteter Widerspruch besteht nicht mehr.
8. **Commit `bfc6641` („Re-Indexierung in einem Web Worker“):** Die Nachricht ist ungenau. Es gibt weder `worker_threads` noch `new Worker`; der Reindex läuft im Hauptprozess mit `async`-Dateizugriffen und Verzeichnis-Cache (Abschnitt 24). Commit-Nachrichten werden nachträglich nicht umgeschrieben.
9. **Vorhandene lokale Änderungen:** Bereits zu Beginn dieser Dokumentationsarbeit waren `scraper/scrape_all.js` und `scraper/scraper-config.json` verändert; `www/Joe Turan Facebook/` war unversioniert. Diese Änderungen wurden nicht als eigene Arbeit übernommen oder zurückgesetzt. Ihre Aufnahme in Git bedarf einer gesonderten inhaltlichen Sichtung, besonders bei Archivdaten.

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
- **D3:** [LXC-container node.js Setup.md](<LXC-container node.js Setup.md>) – Infrastruktur, SSH, Mountprobleme, systemd, Playwright, Cron und CRLF-Erfahrungen; enthält Vorschläge neben umgesetzten Schritten.
- **D4:** [scraper/README.md](scraper/README.md) – Scraperkonfiguration, CLI und gewünschte Synchronität mit BlogDownloader.
- **D5:** [tts/UEBERGABE-TTS.md](tts/UEBERGABE-TTS.md) – ursprüngliche Integration und spätere Nachträge; historische Abschnitte beachten.
- **D6:** [tts-server/QWEN-ANBINDUNG.md](tts-server/QWEN-ANBINDUNG.md) – v4-Protokoll, Originalscript und Prüfungen; Aussage zur fehlenden Vorauswahl durch G14 ersetzt.
- **D7:** [tts/DEPLOYMENT-NODE-SERVER.md](tts/DEPLOYMENT-NODE-SERVER.md) – Update einer bestehenden TTS-Installation; Vorauswahl inzwischen geändert.
- **D8:** [tts/INTEGRATION.md](tts/INTEGRATION.md) – ursprünglicher Liefervertrag des Node-Pakets; insbesondere Ausgabe neben der `.md` ist für WebArchiv überholt.

Zusätzlich berücksichtigt: die geltenden [AGENTS.md](AGENTS.md)-Regeln, `session-context-commands.txt` als historischer Übergabehinweis, Paketdefinitionen und die im Text genannten gezielt geprüften Codebereiche. Die Dokumentation enthält keine echten API-Schlüssel, Tokens oder Cookie-Inhalte.

## 16. Aktualisierung 16.10.2026 – Markdown-Editor, Hörbuch-Extras und gemeinsame ARIA-Menüs

Dieser Abschnitt ergänzt den bis 07.10.2026 festgehaltenen Stand. Er dokumentiert die anschließend
getroffenen UI- und Implementierungsentscheidungen, die bei künftigen Änderungen als geltender Stand
zu behandeln sind.

### Gemeinsame Leitentscheidungen

1. Artikel, Hörbuch-Abstracts und Markdown-Texte in den Hörbuch-Extras verwenden denselben
   CodeMirror-basierten Markdown-Live-Editor. Kontextabhängige Funktionen werden über Optionen
   zugeschaltet und nicht durch getrennte Editoren nachgebaut.
2. Für Dropdown- und Aktionsmenüs ist das bereits vorhandene ARIA-Aktionsmenü das gemeinsame
   Muster. Header-, Artikel-, Hörbuch- und Desktop-Filtermenüs sollen dessen Darstellung und
   Bedienverhalten wiederverwenden, statt parallele Menükomponenten zu entwickeln.
3. Der eingebettete PDF.js-Viewer bleibt ein eigenständiger Drittanbieterbereich. Seine Oberfläche
   und Menülogik werden nicht an die Anwendungsmenüs oder den Markdown-Editor gekoppelt.
4. Geschlossene Menüschaltfläche und geöffnetes Menü haben unabhängige Breiten. Ein kompakter
   Auslöser darf deshalb kein unnötig breites Popup erzwingen und umgekehrt. Popups werden am
   Auslöser verankert und innerhalb des sichtbaren Browserbereichs gehalten.

### Markdown-Live-Editor

Der Editor bleibt intern ein Markdown-Editor, zeigt den Inhalt aber formatiert an. Markdown-Zeichen
werden für **alle** unterstützten Inline- und Blockformate nur an der aktiven Stelle sichtbar und in
einer zurückgenommenen Farbe dargestellt. Dazu zählen insbesondere Fett, Kursiv,
Durchgestrichen, Überschriften, Aufzählungen, nummerierte Listen, Checkboxen, Zitate, Code,
Links, Bilder, Tabellen und Trennlinien. Die Quelldatei bleibt damit unmittelbar editierbar, ohne
dauerhaft als Plain Text angezeigt zu werden.

Die Werkzeugleiste enthält Rückgängig/Wiederholen, Absatz- und Überschriftenebenen, Listen und
Einzüge, Fett, Kursiv, Durchgestrichen, Blockzitat, Code, Link, Tabelle und Formatierung löschen.
Das Listenmenü verwendet kleine, zum jeweiligen Befehl passende Piktogramme, etwa `•`, `1.`,
Checkbox und Einzugspfeile. Das Überlaufmenü steht direkt neben den übrigen Werkzeugen und wird
bei knapper Breite so positioniert, dass es nicht über den linken oder rechten Fensterrand hinausragt.

Für Auswahl und Cursor gelten folgende Regeln:

- Eine vorhandene Auswahl ist der Zielbereich eines Formatierungsbefehls.
- Ohne Auswahl wird bei Inline-Formatierungen das Wort unter dem Cursor verwendet.
- Aktive Inline-Formatierungen werden an den Schaltflächen mit `aria-pressed` gespiegelt.
- Das Überschriftenmenü markiert mit `aria-current` die tatsächliche Ebene der Cursorzeile und
  darf nicht pauschal H1 vorauswählen.
- Befindet sich der Cursor auf einer Trennlinie, wird diese im Listenmenü als aktiv erkannt; ein
  erneuter Klick entfernt die vorhandene Linie.
- `Strg`/`Cmd`+`I` schaltet Kursiv für Auswahl oder Cursorwort und darf nicht die ganze Zeile
  markieren. `Strg`/`Cmd`+Enter speichert den jeweiligen Editor.
- Pos1 und Ende beziehen sich auf die sichtbare Markdown-Zeile. Mausauswahl und Cursorposition
  dürfen nach dem Ein- oder Ausblenden von Syntaxzeichen nicht um eine Zeile versetzt sein.
- Pfeil hoch bzw. herunter darf nach mehrzeiligem Einfügen oder am Rand einer Tabelle keine
  Quellzeilen beziehungsweise die gesamte Tabelle überspringen.

Bild-Upload und Bildeinfügen sind ausschließlich im Editor eines Hörbuch-Extras verfügbar. Beim
Bearbeiten eines Artikeltexts oder eines Hörbuch-Abstracts wird diese Funktion weder angezeigt noch
angeboten.

Die maßgeblichen Frontendquellen sind `public/markdown-live-preview.js`,
`public/markdown-commands.mjs`, `public/markdown-editors.js`, `public/article-editor.js` und
`public/audiobook-extras-manager.js`. Änderungen daran müssen in das eingecheckte Browser-Bundle
übernommen werden:

```bash
npm run build:editor
```

Anschließend ist die `?v=`-Version von `vendor/article-editor.bundle.js` in `public/index.html` zu
erhöhen. Das verhindert, dass Browser oder eine installierte PWA nach dem Deployment noch das alte
Editor-Bundle verwenden.

### Hörbuch-Extras und Dialoghierarchie

Sichtbare Extras liegen ohne separates Manifest direkt unter `<Hörbuch>/extras/`; eingebettete
Textbilder liegen unter `<Hörbuch>/extras/images/`. Administratoren erreichen die Verwaltung sowohl
über das Aktionen-Menü des Hörbuchs als auch über einen gleich gestalteten *Verwalten*-Button in der
Extras-Anzeige.

Die Verwaltung kann Extras und Textbilder anlegen, hochladen, ersetzen, umbenennen, löschen und
vorab anzeigen. Sichtbare Extras werden per Ziehen oder Tastatur/Pfeiltasten sortiert; die Reihenfolge
wird über numerische Dateinamenpräfixe wie `01 -` gespeichert. Für Textbilder gilt ausdrücklich eine
andere Regel: Ein früher automatisch oder zufällig erzeugter Zahlenpräfix wird beim Umbenennen nicht
beibehalten. Der eingegebene Zielname ist maßgeblich. Verweise aus Markdown-Dateien werden beim
Umbenennen sowohl in normaler als auch in URL-kodierter Schreibweise aktualisiert.

Die Dialoge bilden einen Stapel. Escape, die Zurück-Schaltfläche oder ein Klick neben den aktiven
Dialog schließen immer nur die innerste Ebene: zuerst Vorschau beziehungsweise Texteditor, danach
die Extras-Verwaltung und erst anschließend die Hörbuchansicht. Insbesondere darf Escape aus *Text
bearbeiten* nicht zusätzlich den darunterliegenden Hörbuchdialog schließen. Die Extras-Verwaltung
muss wie die anderen modalen Dialoge auch durch einen Klick auf ihren Hintergrund geschlossen
werden können.

Die drei Punkte der Extras-Dateiaktionen sind wie das Überlaufmenü des Markdown-Editors als
schlichter Icon-Auslöser ohne zusätzlichen Kreis darzustellen. Menübezeichnungen enthalten nur
tatsächlich ausführbare Aktionen; ein dekorativer Eintrag wie „Aktionen“ gehört nicht in die
Aktionsliste.

### ARIA-Menüs in Filtern und Aktionen

Auf Desktopgeräten verwenden Autor, Jahr, Kategorie, Hörbuch-Sortierung und *Pro Seite* dasselbe
ARIA-Menümuster wie die vorhandenen Aktionsschaltflächen. Dazu gehören `role="menu"`,
`menuitem` beziehungsweise `menuitemradio`, ein nachvollziehbarer Fokus, Pfeiltastennavigation,
Pos1/Ende, Escape, Außenklick sowie `aria-checked` für die Auswahl. Auf Touch-Geräten bleiben die
nativen Auswahlfelder erhalten.

Die geschlossenen Filter-Schaltflächen sind nur so breit wie Beschriftung und Pfeil. Das geöffnete
Menü richtet seine Breite dagegen kompakt nach seinen Einträgen aus; bei *Pro Seite* bleibt auch das
Popup so schmal wie der sichtbare Auslöser. Diese Regel verhindert sowohl Platzverschwendung in der
Filterzeile als auch unnötig breite Popupflächen. Unabhängig von der Inhaltsbreite darf kein Menü aus
dem Viewport herausragen.

Das Muster ist zentral zu pflegen: Änderungen an Styling, Fokus, Tastatur- oder Schließverhalten
sollen allen darauf aufbauenden Bereichen zugutekommen. Fachliche Inhalte und erlaubte Aktionen
bleiben trotzdem beim jeweiligen Dialog oder Filter.

### Kachelvorschau

Der Vorschautext einer Kachel wird anhand der tatsächlich verfügbaren Höhe begrenzt. Ob Text
überläuft, wird nach dem Layout gemessen und über einen eigenen Zustand markiert. Sichtbar ist genau
eine Ellipse unten rechts. Eine zusätzliche browserseitige `line-clamp`-Ellipse ist nicht zu
kombinieren, weil sonst mitten im Text und am Kachelende zwei Kürzungszeichen erscheinen.

### Speicherung, Sitzungen und Deployment

Artikel und Abstracts werden beim Speichern serverseitig versionsgeprüft und atomar ersetzt. Wurde
die Quelldatei zwischen Laden und Speichern extern geändert, ist `409 Conflict` zurückzugeben, statt
die fremde Änderung zu überschreiben. BOM, vorhandene CRLF-Zeilenenden und Dateirechte bleiben
erhalten. Nach erfolgreichem Speichern wird gezielt nur die bearbeitete Artikeldatei beziehungsweise
das betroffene Hörbuch neu eingelesen; die abhängigen In-Memory-Indizes werden daraus aktualisiert.
Schlägt diese Aktualisierung fehl, bleibt die gespeicherte Datei erhalten und die Oberfläche weist
auf den notwendigen vollständigen Reindex hin.

Die normale Web-Sitzung liegt weiterhin im Arbeitsspeicher des Node-Prozesses. Ein Serverneustart
macht deshalb bestehende Browser- beziehungsweise PWA-Sitzungen ungültig. Gemeinsame API-Aufrufe
müssen eine `401`-Antwort zentral behandeln: lokalen Benutzerzustand verwerfen, abhängige Aktionen
und Extras ausblenden und die erneute Anmeldung anbieten. Das erklärt Fälle, in denen eine länger
nicht verwendete PWA nur noch unvollständige Hörbuchaktionen zeigt und eine Ab- und Anmeldung den
Zustand repariert.

Für reine Änderungen unter `public/` ist auf Debian kein Neustart des Node-Dienstes erforderlich.
Die passende Cacheversion in `public/index.html` wird erhöht, die Dateien werden übertragen und der
Browser beziehungsweise die PWA wird neu geladen oder aktualisiert. Änderungen an `server.js`,
Backend-`*.cjs`, Abhängigkeiten oder Dienstvariablen benötigen dagegen einen Neustart; nach
Änderungen an `package.json` oder dem Lockfile ist zuvor `npm install` beziehungsweise bei sauberem
Deployment `npm ci` auszuführen.

### Regressionstests für diesen Stand

Die UI-Verträge dieser Bereiche werden insbesondere durch
`test/article-editor-ui.test.cjs`, `test/audiobook-extras-ui.test.cjs`,
`test/filter-aria-menu.test.cjs` und `test/card-preview.test.cjs` abgedeckt. Bei Änderungen sind
zusätzlich die reinen Markdown-Befehlstests und die vollständige Suite mit `npm test` relevant.
Dokumentationsänderungen allein erfordern keinen Bundle- oder Anwendungsbuild; sie werden mindestens
mit `git diff --check` geprüft.

## 17. Aktualisierung 26.10.2026 – Infografik-Poster, Prüfmodus und Qwen-Einstellungen

Dieser Abschnitt ergänzt den bisherigen Projektstand um die jüngsten Entscheidungen zu
Infografiken, dem administrativen Prüfablauf, der sichtbaren Autorableitung und der
Qwen-TTS-Konfiguration. Bei Widersprüchen zu älteren Infografik- oder TTS-Abschnitten gelten die
nachfolgenden Regeln.

### Poster-Klassifizierung pro Grafik

Jede Grafik besitzt weiterhin eine eigene `.md`-Datei. Nur im Ja-Fall wird die Klassifizierung als
eigener Markdown-Absatz direkt nach dem Datum gespeichert:

```text
Datum: 2026-10-25

Instagram-Poster: Ja
```

Fehlt diese Zeile, ist die Grafik eine klassische Infografik. Der Infografik-Manager in der
Artikeldetailansicht zeigt deshalb pro Grafikzeile eine eigene *Instagram-Poster*-Checkbox; ein
Artikel kann beliebige klassische Infografiken und Poster mischen. Eine Änderung aktualisiert nur
den betroffenen Infografik-Jahrgang im In-Memory-Index. Der Hauptartikel zeigt weiterhin
unverändert alle zugeordneten Grafiken.

Das Korrekturskript `scripts/fix-instagram-poster-spacing.js` fügt bei älteren Dateien die fehlende
Leerzeile zwischen Datum und Marker ein. Ohne Parameter läuft es als Vorschau. `--write` legt eine
Sicherung unter `download/` an und schreibt atomar; `--root` erlaubt einen abweichenden
Infografikpfad.

### Filter und bildbasierte Kacheln beim Autor Infografiken

Der frühere Telegram-Button schaltet beim Autor `Infografiken` in der Kachelansicht zyklisch durch
drei flüchtige Zustände:

1. alle Infografiken, dargestellt durch das entfärbte Instagram-Symbol;
2. nur Poster, dargestellt durch das originale farbige Instagram-SVG;
3. nur klassische Infografiken, dargestellt durch ein eigenständiges türkis-goldenes
   Infografik-SVG.

Beim Verlassen und erneuten Aufrufen wird der Filter auf *alle* zurückgesetzt. In der Listenansicht
ist der Symbolbutton ausgegraut, nicht bedienbar und ein aktiver Filter wird ebenfalls auf *alle*
zurückgesetzt. Die Ergebnisanzahl verwendet im Poster-Modus die Bezeichnung „Poster“.

Poster und klassische Infografiken verwenden identische bildbasierte 9:16-Kacheln mit
`object-fit: contain`. Titel, Vorschautext und Audio-/Video-/PDF-Badges werden nicht angezeigt.
Unten links steht der Autor, unten rechts das Datum aus der Grafik-`.md`. Reicht die Breite nicht,
wird das Datum stufenweise von der ausgeschriebenen Form auf `TT.MM.JJJJ`, `MM.JJJJ` und `JJJJ`
verkürzt.

Ein Klick auf eine gefilterte Kachel öffnet unmittelbar die Vollbildgrafik. Cursor-Tasten und
Wischgesten wechseln innerhalb der aktuell sichtbaren Grafikliste; sichtbare Pfeilbuttons gibt es
nicht. Die normale Hauptartikelansicht bleibt davon unberührt und zeigt weiterhin alle
zugeordneten Grafiken.

### Sichtbarer Autor von Infografiken

Der sichtbare Autor wird für jede Infografik und in allen Ansichten über die Gruppenverknüpfung vom
zugänglichen Hauptartikel abgeleitet. Die API liefert dafür `displayAuthor`. Nur eine eigenständige
Infografik ohne zugänglichen Hauptartikel zeigt als Autor „Infografiken“. Das interne
`article.author` bleibt weiterhin `Infografiken`, damit ACL-Prüfung, Filter, Routing und Dateipfade
unverändert funktionieren. **Korrektur vom 26.10.2026:** Die Ableitung erfolgt nun zentral in
`exposeArticleForUser` und gilt dadurch auch für eine einzeln dargestellte Infografik, deren
Telegram-Hauptartikel in der normalen Kachelliste ausgeblendet ist. Ihr Badge zeigt trotzdem
„Telegram“; beim Öffnen bleibt derselbe Hauptartikel maßgeblich.

### Admin-Prüfmodus „Infografiken prüfen“

Das Admin-Menü öffnet eine eigene Prüfansicht für alle Infografiken. Jede Grafik erscheint als
9:16-Kachel mit großer Checkbox-Touchfläche oben rechts. Ein Klick auf die Checkbox ändert die
Poster-Markierung; ein Klick auf das Bild öffnet die Vollbildansicht. Dort ist dieselbe Checkbox
verfügbar und kann mit der Leertaste umgeschaltet werden. Cursor-Navigation funktioniert auch
direkt, nachdem eine Checkbox den Fokus erhalten hat.

Änderungen bleiben über Ergebnisseiten und die Seitengrößen 12, 24, 48 und 96 erhalten. Solange
nichts geändert wurde, heißt der Aktionsbutton *Abbrechen*. Andernfalls lautet er *Speichern (N)*.
Erfolgreiches Speichern beendet den Prüfmodus.

`POST /api/infographic-review` prüft den erwarteten Ausgangswert, schreibt die betroffenen
`.md`-Dateien als gemeinsamen Dateivorgang und liest ausschließlich die tatsächlich betroffenen
Infografik-Jahrgänge neu ein. Ein vollständiger Archiv-Reindex findet nicht statt. Bei einem
Fehler wird der Dateivorgang zurückgerollt.

### TTS-Einstellungen und Qwen-Konfiguration

Der überflüssige Verfügbarkeitstext im oberen Bereich des TTS-Dialogs wurde entfernt. Die
Stimmenauswahl nutzt dasselbe ARIA-Aktionsmenü wie die übrigen Desktopfilter; auf Touch-Geräten
bleibt das native `<select>` erhalten.

Unter den vorhandenen Bereichen für Stimmenauswahl und Stimmerzeugung folgt der Bereich
*Qwen-TTS-Server-Einstellungen*. Beim Öffnen lädt WebArchiv die Werte live über
`GET /api/tts/server-settings`; Speichern erfolgt über `PUT /api/tts/server-settings` und den
Qwen-Endpunkt `/v1/settings`. Leere Felder zusammen mit HTTP 404 bedeuten, dass auf dem
Modellserver noch eine ältere Dienstversion ohne diesen Endpunkt läuft.

Konfigurierbar sind:

- `min_chunk_chars`, `target_chunk_chars` und `max_chunk_chars` über kleine Zahlenfelder sowie
  einen gemeinsamen Drei-Punkt-Slider;
- `text_preroll_enabled` und bei Aktivierung `text_preroll_sentence`;
- `append_chunk_end_padding` und bei Aktivierung `chunk_end_padding_text`;
- `text_preroll_min_pause_ms`, `text_preroll_lead_in_ms` und `silence_threshold_db`.

Der Qwen-Dienst verändert nicht die ursprüngliche `config.json`. Beim Start muss ihm die bereits
vorhandene `qwen_http_service_config.json` mit `--config` übergeben werden; er erzeugt sie nicht.
Lesen, atomisches Schreiben und jeder Aufruf von `generate_mp3_with_embedding.py --config ...`
verwenden denselben absoluten Pfad. Weil `start_qwen_tts_service.cmd` ausschließlich absolute
Pfade enthält, kann die Datei auch nach `C:\Tools\Scripts` kopiert und von dort gestartet werden.

### Weitere UI-Korrekturen und Betriebsstand

- Das Copy-Menü ist grundsätzlich rechts am Copy-Button ausgerichtet, bleibt bei ausreichender
  Breite einzeilig und wird an schmalen Viewports vollständig innerhalb des Fensters gehalten.
- Aktuelle Frontend-Cache-Buster: `styles.css?v=158`, `app.js?v=132`.
- Änderungen an `server.js` oder am Qwen-Python-Dienst benötigen einen Neustart des jeweiligen
  Dienstes. Frontendänderungen werden nach normalem Neuladen durch die Cache-Buster übernommen.
- Die gezielten Infografik-, Server- und angrenzenden UI-Tests liefen zuletzt mit 90/90 erfolgreich;
  `node --check` für `server.js` und `public/app.js` war fehlerfrei.
- Der vollständige `npm test`-Lauf ist in der eingeschränkten Windows-Sandbox weiterhin nicht
  grün: Lokale Socket-Verbindungen, Hardlinks und atomare Schreibtests werden dort teilweise mit
  `EACCES`/`EPERM` blockiert; daneben bestehen unabhängige Bestands-/Fixture-Abweichungen.

## 18. Aktualisierung 26.10.2026 – serverseitig geschützte Admin-Oberfläche

`public/index.html` dient jetzt als Servervorlage. `server.js` beantwortet `/` und `/index.html`
sitzungsabhängig und ohne Cache: Nur eine aktive Admin-Sitzung ohne ausstehenden
Pflicht-Kennwortwechsel erhält Admin-Menüpunkte, Redaktionsdialoge, das CSRF-Metafeld und die
Admin-Script-Tags. Gäste und normale Nutzer erhalten diese Elemente überhaupt nicht im DOM.
Direkte Aufrufe der Admin-Skripte werden vor der statischen Dateiauslieferung abgefangen und ohne
Admin-Sitzung mit `404` beantwortet. Das eigene Kennwort bleibt über das getrennte
`public/password.js` für normale Nutzer verfügbar.

Admin-Anmeldung und -Abmeldung laden die Seite neu, damit der Server die passende Shell liefert
beziehungsweise vorhandene Admin-Elemente sicher entfernt. Läuft eine Admin-Sitzung während eines
API-Aufrufs ab oder wird die Rolle entzogen, löst die zentrale Fetch-Behandlung ebenfalls einen
Neuaufbau der Shell aus.

Die frühere, über viele Routen verteilte Prüfung wurde durch `requireAdminAccess` ergänzt. Sie
prüft für alle administrativen Endpunkte die aktuelle Rolle. Bei `POST`, `PUT`, `PATCH` und
`DELETE` werden außerdem Cross-Site-Anfragen, eine abweichende `Origin` und ein fehlendes oder
falsches sitzungsgebundenes `X-CSRF-Token` abgewiesen. `apiFetch()` ergänzt dieses Token zentral;
auch Artikel-/Abstract-Editor, Infografikverwaltung, TTS, Benutzerverwaltung, Dubletten und die
administrative Hörbuch-/Extras-Verwaltung laufen darüber.

Der neue Vertrag ist in `test/admin-ui-security.test.cjs` abgedeckt. Zusätzlich liefen die 90
gezielten Sicherheits-, Admin-Dialog-, Editor-, Dubletten-, TTS-, Hörbuch-Extras-, Infografik-
und angrenzenden UI-Tests gemeinsam ohne Fehler. Ein vollständiger Lauf außerhalb der Sandbox
bestand 323 von 324 Node-Tests. Ausschließlich der sachfremde Qwen-E2E-Test „Echter HTTP-Dienst
und Original-CLI-Vertrag“ überschritt auch bei isolierter Wiederholung sein festes
15-Sekunden-Limit. Der dadurch nicht automatisch gestartete Python-Teil wurde separat ausgeführt
und bestand vollständig mit 14 von 14 Tests.

## 19. Aktualisierung 26.10.2026 – Pfad-Lücke in /files/* und /audio-files/* geschlossen

**Befund:** Beide Medienrouten prüften den Autor am ersten, noch nicht aufgelösten Pfadsegment
und lösten den Pfad erst danach auf. Express reicht `..` – auch kodiert als `%2e%2e`, `%2f` oder
`%5c` – dekodiert an die Route weiter. Dadurch lieferte z. B.
`/files/Videos/../Joe%20Turan/<Jahr>/<Datei>.jpg` einem Gast Dateien eines privaten Autors aus
(geprüft wurde der öffentliche Autor „Videos“). Über `/audio-files/<öffentlicher Autor>/../Hoerbuecher/…`
ließen sich ebenso Hörbücher einschließlich privater Bücher und die Papierkörbe erreichen. Der
Reverse Proxy NPMplus (192.168.1.14) läuft mit „Disable URI Sanitisation“; er reicht solche Pfade
unverändert durch. Die Lücke lag aber im Server und bestand unabhängig vom Proxy.

**Lösung:** Neues Modul `media-files.cjs` mit `resolveMediaRequest` und `installMediaRoutes`.
Segmente, die nur aus Punkten/Leerzeichen bestehen, leere Segmente, NUL und unter Windows `:`
werden mit `400` abgewiesen. Autor, Infografik-Papierkorb, TTS-Papierkorb und private Hörbücher
werden erst am geprüften Pfad bestimmt. `audiobooks.canAccessMedia(…, { decoded: true })`
dekodiert den bereits von Express dekodierten Pfad nicht ein zweites Mal. `isPathInside` liegt
jetzt ebenfalls in `media-files.cjs`.

**Geprüft:** neue Tests `test/media-files.test.cjs` (echte HTTP-Anfragen mit unveränderten Pfaden;
eine Gegenprobe mit der alten Semantik lieferte die geheime Datei mit 200 aus), gesamte Node-Suite
337/337, lokaler Server mit echtem Archiv als Gast (Umgehungsvarianten 400, direkter Zugriff 403,
öffentliche Bilder 200, Kachelansicht ohne Konsolenfehler). In Produktion nicht geprüft.

**Deployment:** `server.js`, `audiobooks.cjs`, `media-files.cjs` (neu) kopieren und
`sudo systemctl restart nodeapp`; keine neuen Abhängigkeiten, keine neuen Umgebungsvariablen.
Die übrigen Punkte des Sicherheitsplans (Secret-Pflicht, Login-Begrenzung, HTML-Bereinigung, CSP)
folgen getrennt.

## 20. Aktualisierung 26.10.2026 – Secret-Pflicht, Login-Begrenzung, HTML-Bereinigung, CSP

Umsetzung des Sicherheitsplans nach den Entscheidungen des Benutzers: Reverse Proxy ist
**NPMplus auf 192.168.1.14** (bereits produktiv, die frühere Angabe „Proxy später“ ist überholt),
unbekannte Tags sichtbar machen, Google Fonts extern belassen, `sanitize-html` verwenden.

- **Secret-Pflicht:** `resolveSessionSecret` in `server.js`. Mit `NODE_ENV=production` startet der
  Server nur mit `SESSION_SECRET` ≥ 32 Zeichen (der alte Entwicklungswert zählt als unsicher).
  Ohne Produktion bzw. beim bloßen Laden von `server.js` durch Tests/Skripte: zufälliges Secret mit
  Warnung. Cookie zusätzlich `secure: 'auto'`.
- **Proxy-Vertrauen:** `TRUST_PROXY` (Standard `loopback, 192.168.1.14`) statt `trust proxy = true`;
  `true` wird abgelehnt. Grund: Sonst ließe sich `req.ip` per `X-Forwarded-For` fälschen.
- **Login-Begrenzung:** `login-limiter.cjs`; 5 Fehlversuche pro Konto bzw. 30 pro IP in 15 Minuten →
  15 Minuten `429` mit `Retry-After`, geprüft vor bcrypt. Gilt für `/api/login` und die Prüfung des
  aktuellen Kennworts in `/api/me/password`. Nur im Arbeitsspeicher.
- **HTML-Bereinigung:** `html-sanitizer.cjs` (`renderSafeMarkdown`) für Artikel, Dublettenvergleich,
  Hörbuch-Abstract, eBook und Extras. Zwei Durchgänge, weil `exclusiveFilter` im Escape-Modus von
  `sanitize-html` den vorangehenden Text des Elternelements verwirft. `Quelle:`-Links nur http(s)
  (vorher war ein `javascript:`-Link möglich). Gegenprobe über alle 7.205 `.md` im lokalen Bestand:
  keine sichtbare Abweichung. Korrektur zur Planung: Die Pseudo-Tags im eBook „Claude AI für Profis
  2026“ sind im Markdown bereits maskiert und waren schon sichtbar.
- **CSP:** `security-headers.cjs`; `CSP_MODE=report` (Standard), `enforce`, `off`. Skripte nur
  `'self'` plus Nonce pro Antwort (Weiterleitung der Link-Vorschau `/a/*`), Inline-Styles erlaubt,
  Google Fonts erlaubt, PDF.js unter `/vendor/pdfjs/` mit `'wasm-unsafe-eval'`. Meldungen an
  `/api/csp-report` erscheinen begrenzt als „CSP-Verstoß: …“ im Dienstprotokoll. Zusätzlich
  `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`. Die fünf `onerror`-Attribute
  der Kachelbilder wurden durch `data-fallback` und einen Listener in der Capture-Phase ersetzt
  (`app.js?v=133`, `audiobooks.js?v=25`).

**Geprüft:** neue Tests `test/security.test.cjs` (17), gesamte Node-Suite 354/354; Browser lokal als
Gast im Report-Only-Modus: Startseite, Artikel, PDF-Viewer, Video, Vollbild und Bild-Fallback ohne
CSP-Meldung; ein absichtlich eingefügtes Inline-Skript wurde gemeldet. **Nicht geprüft:** Admin-
Bereiche (Editor/CodeMirror, TTS-Aufnahme, Dubletten, neue Infografik) und echte Geräte; dafür ist
die Report-Only-Phase in Produktion vorgesehen. `CSP_MODE=enforce` wurde nur in Tests geprüft.

**Offen:** `npm audit` meldet bereits vorhandene Schwachstellen in `proxy-addr` (u. a. IP-Spoofing
bei vertrauten Subnetzen), `body-parser`, `qs` und `sharp`; nicht Teil dieses Schritts.

**Deployment:** siehe „Sicherheits-Umgebung“ in `LXC-container node.js Setup.md`; Dateien
`server.js`, `user-store.cjs`, `login-limiter.cjs`, `html-sanitizer.cjs`, `security-headers.cjs`,
`package.json`, `package-lock.json`, `public/app.js`, `public/audiobooks.js`, `public/index.html`;
danach `npm ci --omit=dev` und Neustart.

## 21. Aktualisierung 26.10.2026 – config.json und public-directories.txt nicht mehr in Git

Beide Dateien werden zur Laufzeit von der Benutzer- bzw. Autorenverwaltung geschrieben. Sie waren
eingecheckt, sodass ein Code-Deployment die produktiven Fassungen überschreiben konnte. Jetzt:
Vorlagen `example-config.json` und `example-public-directories.txt` (Stand der lokalen Dateien vom
26.10.2026) im Repository, die echten Dateien in `.gitignore` (`/config.json`,
`/public-directories.txt`, nur im Projektroot). Fehlende Dateien sind unkritisch: `config.json` →
Standardwerte, `public-directories.txt` → keine öffentlichen Autoren (Archiv nur mit Anmeldung).
`test/duplicates.test.cjs` liest die Dubletten-Konfiguration aus der Vorlage.

**Deployment:** Die beiden Dateien beim Kopieren nach `/opt/nodeapp` grundsätzlich auslassen; die
Fassungen auf dem Server sind maßgeblich. Wer per `git pull` aktualisiert, sollte sie vorher sichern,
weil Git sie beim Entfernen aus dem Index im Arbeitsverzeichnis löscht.

## 22. Aktualisierung 26.10.2026 – Zentrale Sperre für Schreib- und Indexaufträge

Die rund 16 von Hand geschriebenen Busy-Prüfungen in `server.js`
(`reindexState.running || scrapeState.running || infographicWrites || …`) sind durch das Modul
`archive-lock.cjs` ersetzt. Der Zähler `infographicWrites`, der zuletzt auch für Dubletten als
allgemeine Sperre diente, entfällt.

- **Registrierte Aufträge** mit eigenem Zustand: Index-Neuaufbau, Scraper-Lauf, Artikel speichern,
  Audio-Erzeugung. Editor und TTS behalten ihre Schnittstelle (`busy`, `running`) und erhalten
  `busy: () => archiveLock.busy`.
- **Exklusive Halter** über `tryAcquire`: Infografiken ändern, Infografik-Prüfung speichern,
  Infografik hochladen, Neue Infografik speichern, Dubletten-Sammelaktion, Dublettenaktion;
  Hörbuch-Verwaltung über `exclusive` in `installAudiobookRoutes`. Die Hörbuch-Verwaltung war
  vorher nur geprüft, aber selbst nicht sichtbar für andere Aufträge.
- **Meldung** bei Konflikt: 409 „Es läuft bereits: <Auftrag>. Bitte später erneut versuchen.“
- **Verhalten bleibt sonst gleich:** `/api/reindex` und `/api/scrape` antworten bei bereits laufendem
  Reindex bzw. Scrape weiterhin mit `started: false` und `reason`. Das Öffnen der
  Infografik-Verwaltung wird nur während eines exklusiven Halters abgewiesen, nicht während Scrape
  oder Audio-Erzeugung. `SIGHUP` protokolliert jetzt, warum der Reindex übersprungen wird.

**Geprüft:** `test/archive-lock.test.cjs` (5 Tests, u. a. Hörbuch-Route mit belegter Sperre),
gesamte Node-Suite 359/359, lokaler Serverstart mit vollständigem Index. Gleichzeitige Aufträge im
echten Betrieb nicht manuell ausgelöst.

**Deployment:** `server.js`, `audiobooks.cjs`, `archive-lock.cjs` (neu) kopieren und den Dienst neu
starten; keine neuen Abhängigkeiten.

## 23. Aktualisierung 27.10.2026 – Gemeinsame ARIA-Menükomponente, Admin-Code aus app.js

**Menüs:** Neue Komponente `public/aria-menu.js` (`WebArchivAriaMenu`). Sie übernimmt Öffnen/Schließen,
`aria-expanded`, Pfeiltasten/Pos1/Ende/Tab, Escape in der Capture-Phase (schließt nur das Menü, nicht
den Dialog darunter), Klick außerhalb, Fokus-Rückgabe, Einpassen in den Viewport und „immer nur ein Menü
offen“. Die Aktion läuft erst nach dem Schließen, damit ein geöffneter Dialog den Fokus behält;
`keepOpen` hält Mehrfachauswahlen offen. Umgestellt: Desktop-Filter (inkl. TTS-Stimmenauswahl über
`bindSelect`), Kopiermenü, ↺-Admin-Menü, Dubletten-Filter (Autoren als Mehrfachauswahl) sowie die
bisherigen `<details>`-Menüs „Aktionen“ im Artikel und im Hörbuch, die gegen die README-Regel
verstießen. Rund 200 Zeilen doppelte Menülogik in `app.js`, `audiobooks.js` und `duplicates.js`
entfallen. Nicht umgestellt: Werkzeugleiste des Markdown-Editors und ⋯-Menü der Hörbuch-Extras
(eigene Zustandslogik im Editor-Bundle).

**Admin-Code:** TTS-Auftrag, Archiv neu einlesen, Scrapen und Scrape-Log (rund 440 Zeilen) liegen jetzt in
`public/admin-tasks.js`. Das Skript steht in `ADMIN_ASSET_PATHS` und wird Gästen und Nutzern nicht
ausgeliefert (404). `app.js` spricht es über `adminHooks` an (`articleChanged`, `userChanged`,
`ttsBusy`, `actions`). Der Prüfmodus „Infografiken prüfen“ ist mit Raster und Vollbild verflochten und
bleibt vorerst in `app.js`.

**Geprüft:** neuer Verhaltenstest `test/aria-menu.test.cjs` (11 Tests, eigener DOM-Nachbau), Test der
Admin-Trennung in `test/admin-ui-security.test.cjs`, gesamte Node-Suite 371/371; Browser lokal mit
Test-Admin (eigene Nutzerdatei im Scratchpad): Filter per Maus und Tastatur, Kopiermenü, Artikel-
Aktionen mit Editor und Fokus-Rückgabe, ↺-Menü mit Dialog, Dubletten-Filter inkl. Mehrfachauswahl und
zweistufigem Escape, Hörbuch-Aktionen inkl. Privat-Markierung, Audio-Auftrag- und Log-Anzeige; als Gast
`admin-tasks.js` 404 und keine Konsolenfehler; keine CSP-Meldungen. Nicht geprüft: echte Touch-Geräte,
TTS-Start und Scrape-Lauf (nur Anzeige).

**Deployment:** `server.js` (Neustart), `public/aria-menu.js` und `public/admin-tasks.js` (neu),
`public/app.js`, `public/audiobooks.js`, `public/duplicates.js`, `public/index.html`, `public/styles.css`,
`public/vendor/article-editor.bundle.js` (neu gebaut, enthält `article-editor.js`).

**Nachtrag 27.10.2026 (Rückmeldungen zu Punkt 4):**
- *Zeilenhöhe:* Alte und neue Fassung messen lokal identisch (≈ 38 px); die Regel `.header-menu-item`
  ist seit 10.07. unverändert, die Filtermenüs nutzen sie seit dem Menü-Redesign vom 16.10. (davor
  native Dropdowns). Auf Wunsch jetzt kompakte Zeilen am Desktop (≈ 30 px: `padding: 5px 12px`,
  Zeilenhöhe 1,45; nur `(hover: hover) and (pointer: fine)`); Touch behält ≈ 38 px.
- *Filtermenü blieb offen beim Öffnen des Admin-Menüs:* Fehler des alten Stands (der ↺-Button stoppte
  den Klick per `stopPropagation`); mit `aria-menu.js` behoben, im Browser mit echten Klicks bestätigt.
- *Einstellungen-Dialog:* Die sechs Auswahlfelder haben am Desktop ein ARIA-Menü als Spiegel
  (`bindSelect`), Touch behält das native Select. `openSettingsDialog` synchronisiert die Menüs, weil
  programmatisch gesetzte Werte kein `change` auslösen. (In der Benutzerverwaltung gibt es keine
  Dropdowns; gemeint war dieser Dialog.)
- *Header-Versatz beim Wechsel Raster ↔ Liste:* Ganz oben stand die erste Karte im Raster 12 px höher
  als in der Liste; `restoreListPosition` glich das per Scrollen aus und verschob so den nicht fixierten
  Kopfbereich. Jetzt bleibt eine Ansicht ganz oben ganz oben; gescrollt bleibt die Karte im Blick.
  Im Browserbereich der Entwicklungsumgebung ist das Scrollen nicht verlässlich messbar; geprüft
  über die Kartenpositionen und einen Test, nicht per Augenschein.

## 24. Aktualisierung 27.10.2026 – Verzeichnis-Cache beim Scan, Seitenparameter

- **Mediensuche beim Scan:** `findSibling` las für jeden Artikel ohne lokale MP3 den Ordner unter
  `audio/` neu ein und prüfte jede Endung per `existsSync`. Neu: `createDirectoryCache` liest jedes
  Verzeichnis pro Scan höchstens einmal (Artikelordner, Audio-Ordner, Autorenordner für
  `standard.*`); der vollständige Reindex teilt einen Cache über alle Autoren, Teil-Reindexe
  erhalten je Aufruf einen frischen. Reihenfolge unverändert: exakter Name vor abweichender
  Schreibweise, Endungen in der angegebenen Reihenfolge; Symlinks zählen weiter mit.
- **Messung am lokalen Bestand (7.080 Einträge, je 3 Läufe):** `readdirSync` 4.304 → 26,
  `existsSync` 39.384 → 0, Dauer ≈ 10,5 s → ≈ 8,6 s. Ein Snapshot aller Bild-, Audio-, Video- und
  PDF-Zuordnungen war vorher und nachher identisch (0 Abweichungen).
- **Seitenparameter:** `/api/articles?page=abc` bzw. `limit=xyz` ergaben `NaN` und eine leere Seite.
  `paginationParams` fällt jetzt auf Seite 1 bzw. 24 Einträge zurück (Limit weiterhin 1–100).
- **Tests:** `test/media-scan.test.cjs` (Cache, Namensauflösung, Symlinks/Ordner, Seitenparameter);
  Node-Suite 377/377.
- **Deployment:** nur `server.js`, danach Dienst neu starten.

## 25. Aktualisierung 27.10.2026 – Reine Logik aus server.js nach lib/

`server.js` enthält nur noch Zustand (Index, Stores, Sitzungen, Sperre) und Routen; reine Logik ohne
Serverzustand liegt in `lib/` (3.016 → 2.130 Zeilen in `server.js`):

- `lib/article-parser.cjs` – `parseArticle`, Datums-/Textsuche, Auszug, Taxonomie und Kategorien,
  `renderArticleBody` (bereinigt über `html-sanitizer.cjs`)
- `lib/infographics.cjs` – `INFOGRAPHICS_AUTHOR`, Stamm-Auflösung, `linkInfographics`, Benennung und
  Nummerierung, Kopf-/Titel-/Poster-Bearbeitung, `moveInfographicFiles`, `slugify`, Bildtyp
- `lib/archive-files.cjs` – Verzeichnis-Cache, `findSibling`, `fileUrl`/`audioFileUrl`, `resolveUnder`
- `lib/article-index.cjs` – Fuse-Suchindex, angezeigter Autor, Listen-Helfer der Teil-Reindexe,
  Scraper-Änderungsmanifest
- `lib/app-shell.cjs` – Versionssignatur und Update-Service-Worker
- `lib/http-errors.cjs` – `httpError` (ersetzt das irreführend benannte `duplicateFail`)

Die Funktionen wurden **unverändert** verschoben (41 Blöcke zeichengleich geprüft; einzige Änderung
`duplicateFail` → `httpError`). `scripts/migrate-infographic-names.js` lädt nicht mehr `server.js`
(vorher wurden dabei `users.json`, Stores und Sitzungen mit initialisiert), sondern nur `lib/`.
`server.js` exportiert die bisherigen Namen weiter, Tests bleiben kompatibel.

**Geprüft:** Node-Suite 377/377 (ein Test deckte einen vergessenen `duplicateFail`-Aufruf in
`lib/infographics.cjs` auf, korrigiert); Index-Snapshot aller 7.080 Einträge vor/nach identisch;
Vorschau von `migrate-infographic-names.js` vor/nach zeilengleich (545 Zeilen).

**Deployment:** `server.js`, `scripts/migrate-infographic-names.js` und den neuen Ordner `lib/`
(sechs Dateien) kopieren, danach Dienst neu starten. Keine neuen Abhängigkeiten.

## 26. Aktualisierung 27.10.2026 – Doppelten Code zusammengeführt

**Atomares Schreiben (`lib/atomic-file.cjs`):** Eine Umsetzung statt fünf.
- `writeFileAtomic(file, content, { io, defaultMode, prefix, strictOwner, beforeRename })`: temporäre
  Datei im selben Verzeichnis, Rechte und Eigentümer einer vorhandenen Datei bleiben erhalten.
  - Der Artikel-Editor nutzt `strictOwner`: ein fehlgeschlagenes `chown` bricht ab.
  - Pfad und Version werden in `beforeRename` erneut geprüft.
- `writeJsonAtomic` meldet EACCES/EPERM weiterhin als 500 mit Dateinamen. `user-store.cjs`
  exportiert es weiter.
- `writeFileAtomicSync` ersetzt die Kopien in `scripts/fix-instagram-poster-spacing.js` und
  `scripts/strip-infographic-categories.js`.
- `createJsonFile({ file, io, mode })` liefert `read(fallback)` (BOM, fehlende Datei, Warnung) und
  `write(data)` (Schreibvorgänge nacheinander). Genutzt von Lesezeichen, Dubletten-Entscheidungen
  und Hörfortschritt.
- Die Hörbuch-Extras übernehmen die Rechte jetzt selbst (neue Dateien 0644), statt sie bei jedem
  Aufruf mitzugeben.

**JSON-Routen (`lib/http-errors.cjs`):** `jsonRoute(handler, { label, fallback, crossSiteMessage, mapError })`
ersetzt die vier eigenen Routen-Wrapper in Benutzerverwaltung, Lesezeichen, Hörbüchern und
Artikel-Editor.
- Gemeinsam: no-store, Cross-Site-Sperre für schreibende Aufrufe, `Retry-After` und eine allgemeine
  Meldung statt Fehlerdetails.
- Der Editor bildet ENOENT über `mapError` auf 404 ab.
- Lokale `fail`-Funktionen sind durch `httpError` ersetzt.

**Entfernt:** sieben doppelte `sec-fetch-site`-Prüfungen in Admin-Routen von `server.js`. Diese
Routen laufen bereits durch `requireAdminAccess`, das Herkunft und CSRF-Token prüft.

**Kleinere Duplikate:**
- `escapeHtml` liegt einmal in `html-sanitizer.cjs`.
- `fileUrl`/`audioFileUrl` und das `withVersion` der Hörbücher nutzen `versionedUrl`.
- `TELEGRAM_AUTHOR` ersetzt die drei Telegram-Literale in `server.js`.

**Bewusst getrennt geblieben:**
- `normalizeDate` der Hörbücher (versteht reine Jahreszahlen, liefert `null`).
- Das eigenständige `tts/`-Paket.
- Die Kopien im Dubletten-Werkzeug und das `slugify` des Scrapers.

**Geprüft:** Node-Suite 384/384, davon 7 neue Tests in `test/shared-helpers.test.cjs`. Ein Serverstart
mit Abruf von Artikeln und Hörbüchern ist fehlerfrei.

**Deployment:**
- Kopieren: `lib/atomic-file.cjs`, `lib/http-errors.cjs`, `lib/archive-files.cjs`, `server.js`,
  `user-store.cjs`, `bookmarks.cjs`, `duplicates.cjs`, `audiobooks.cjs`, `article-editor.cjs`,
  `html-sanitizer.cjs` und die beiden Skripte.
- Danach den Dienst neu starten. Keine neuen Abhängigkeiten.

## 27. Aktualisierung 27.10.2026 – Restliche Menüs, Prüfmodus aus app.js

**Markdown-Editor-Werkzeugleiste:** Die vier `<details>`-Menüs sind jetzt Button + `role="menu"` und laufen
über `aria-menu.js`: Absatzformat, Listen, Tabelle und das Überlaufmenü am Handy.
- Damit gibt es Pfeiltasten, Escape (schließt nur das Menü, nicht den Editor), Klick außerhalb und
  „immer nur ein Menü offen“, auch zusammen mit anderen Menüs der App.
- Im Tabellenraster bewegen die Pfeiltasten den Fokus in zwei Richtungen.
- Eigene Schließlogik (`closeMenus`, Dokument-Klick, Escape-Handler) ist entfernt. Das Überlaufmenü bleibt
  innerhalb der Werkzeugleiste.
- Das Bundle ist neu gebaut (`npm run build:editor`, `article-editor.bundle.js?v=19`, `styles.css?v=163`).

**Hörbuch-Extras ⋯:** Dieses ⋯ ist kein Popup-Menü, sondern eine Aufklappzeile. Auf dem Desktop sind die
Aktionen immer sichtbar, am Handy klappt ⋯ sie inline auf, und nach ↑/↓ bleibt sie offen. Es gibt keine
eigene Escape- oder Außenklick-Logik. Deshalb bleibt es eine Aufklappzeile; neu ist nur `aria-controls`
auf die Aktionszeile.

**Prüfmodus „Infografiken prüfen“:** Die Logik liegt jetzt in `public/infographic-review.js` (Admin-Asset,
in `ADMIN_ASSET_PATHS`): Zustand, Betreten/Verlassen/Speichern, Prüfkachel, Speichern-Button,
Vollbild-Checkbox, Leertaste und `beforeunload`.
- `app.js` hält nur noch den Platzhalter `infographicReview` (`active`, `hasChanges`, `value`, `mark`,
  `remember`, `reset`, `renderCard`); das Admin-Skript füllt ihn.
- Der Menüeintrag läuft über `adminHooks.actions['review-infographics']`.
- `admin-tasks.js` übernimmt vorhandene Aktionen, statt sie zu überschreiben.
- Gäste und Nutzer laden den Code nicht mehr (`app.js?v=137`, `admin-tasks.js?v=2`).

**Geprüft:**
- Node-Suite 385/385. Ein neuer Test prüft, wo der Prüfmodus liegt; die Versions-Pins der Tests sind
  nachgezogen.
- Im Browser mit lokalem Test-Admin (1280 px und 375 px):
  - Prüfmodus betreten, markieren, Vollbild mit Leertaste, ohne Speichern verlassen.
  - Editor-Menüs: eines offen, Escape, Auswahl und Fokus, Tabellenraster per Tastatur.
  - Das Überlaufmenü am Handy bleibt im Bild.
  - Keine Konsolenfehler.

**Deployment:**
- Kopieren:
  - `public/`: `infographic-review.js` (neu), `app.js`, `admin-tasks.js`, `index.html`, `styles.css`,
    `markdown-live-preview.js`, `audiobook-extras-manager.js`
  - `public/vendor/article-editor.bundle.js`
  - `server.js`
- Danach den Dienst neu starten.

## 28. Aktualisierung 27.10.2026 – Neue automatische Kategorisierung

**Befund:** Die alte `autoCategorize` zählte Teilstrings. Ausgewertet wurden 2.736 Artikel von Joe Turan,
Facebook und Telegram:
- `ehe` traf 9.629-mal, davon nur 116-mal das Wort „Ehe“ (sonst gehen, sehen, geschehen …).
- `system` traf in 2.144 Fällen „Nervensystem“ (→ Gesellschaft), `würde` fast nur den Konjunktiv,
  `sucht` mindestens 815-mal versucht/Sehnsucht.
- Folge: „Beziehungen“ stand bei 92 % aller Artikel, 71 % hatten fünf Kategorien.

**Neu: `lib/taxonomy.cjs`** (`article-parser.cjs` reicht nur weiter):
- Gewichtete Suchwörter je Kategorie, verglichen mit ganzen Wörtern: `stamm` = Wortanfang, `=wort` =
  genau dieses Wort, `*stamm` = auch in Komposita, Wortfolgen mit Leerzeichen.
- Allgemeine und mehrdeutige Wörter sind gestrichen, Themenwörter aus den Texten ergänzt (Narzissmus,
  Bindungsstil, Perimenopause, Polarität, Propaganda …).
- Treffer im Titel zählen dreifach.
- Höchstens 3 Kategorien; jede braucht eine Mindestpunktzahl (wächst mit der Textlänge) und mindestens
  35 % der stärksten. Ohne deutliches Signal bleibt ein Artikel ohne Kategorie (Rückfall: die stärkste
  ab 1,5 Punkten).
- Die zwölf Kategorien selbst sind unverändert, ebenso `Kategorien:`-Zeilen (zählen zuerst).
- Doppelt so schnell wie vorher (0,5 statt 1,0 s für die 2.736 Artikel), Wort-Treffer werden zwischengespeichert.

**Geprüft gegen von Hand zugeordnete Stichproben:**

| | Präzision | Vollständigkeit | F1 | erste Kategorie richtig |
|---|---|---|---|---|
| alt (120 Artikel) | 30 % | 74 % | 43 | 54/120 |
| neu (120 Artikel) | 63 % | 65 % | 64 | 91/120 |
| alt, Kontrolle (30 neue Artikel) | 32 % | 72 % | 44 | 19/30 |
| neu, Kontrolle | 70 % | 54 % | 61 | 23/30 |

Verteilung neu (drei Autoren): Beziehungen 36 %, Psychologie 29 %, Persönlichkeit 27 % … Selbsterkenntnis
2 %; 47 Artikel ohne Kategorie, Ø 1,8 Kategorien. Node-Suite 391/391 (neu: `test/taxonomy.test.cjs`).

**Hinweis:** Andere Autoren profitieren mit, sind aber nicht gezielt abgestimmt. Bei Stefan Hiene (20 %)
und eigenständigen Infografiken bleiben mehr Einträge ohne Kategorie.

**Deployment:**
- Kopieren: `lib/taxonomy.cjs` (neu), `lib/article-parser.cjs`, `server.js`.
- Danach den Dienst neu starten. Der Index wird beim Start neu aufgebaut; Artikeldateien bleiben unverändert.

## 29. Aktualisierung 27.10.2026 – Zwischenspeicher für Shell, Service Worker und Artikeltext

Alle drei Caches erkennen Änderungen an Größe und Änderungszeit der Dateien. Frontend-Änderungen wirken
also weiterhin ohne Neustart, und gespeicherte Artikel erscheinen sofort.

- **`index.html`:** `renderIndexForSession` las und filterte die Datei bei jeder Anfrage synchron.
  Jetzt baut `cachedTextFile` (`lib/app-shell.cjs`) die Admin- und die Standard-Shell nur nach einer
  Änderung neu; pro Anfrage kommt nur das CSRF-Token hinzu. 0,19 → 0,01 ms.
- **`/service-worker.js`:** `createAppShellVersion` hasht die Shell-Dateien nur neu, wenn sich Name,
  Größe oder Änderungszeit einer Datei geändert haben; sonst genügt je Datei ein `stat`. 1,8 → 0,3 ms.
- **Artikel-Detail und Dubletten-Vergleich:** `lib/article-body-cache.cjs` hält den bereinigten
  HTML-Text der zuletzt geöffneten 300 Artikel vor (LRU). Neu gelesen und gerendert wird nur nach einer
  Dateiänderung, etwa durch Editor, Dublettenmigration oder Scraper. Für einen 31-KB-Artikel 2,9 → 0,03 ms.
  Die Route liest jetzt asynchron, blockiert also den Server nicht mehr.
- Nebenbei: Fehlt die Datei eines Artikels, antwortet das Detail mit 404 statt 500. Unerwartete Fehler
  gehen ins Log, die Antwort zeigt keinen Dateipfad mehr.

**Geprüft:**
- Node-Suite 395/395, neu: `test/response-caches.test.cjs` (Invalidierung, Verdrängung, Bereinigung).
- Serverstart mit Abruf von Shell, Service Worker und Detail sowie 404 bei unbekannter ID.
- Im Browser: Artikel öffnen, keine Konsolenfehler.

**Deployment:**
- Kopieren: `server.js`, `lib/app-shell.cjs`, `lib/article-body-cache.cjs` (neu).
- Danach den Dienst neu starten.

## 30. Aktualisierung 27.10.2026 – Robustheit und Sicherheit

- **TTS-Routen:** Ohne eigenen Status (z. B. wenn der TTS-Dienst nicht erreichbar ist) antworten sie mit
  einer allgemeinen Meldung; die Details stehen im Dienst-Log. Eigene Meldungen (409, 404, 502 …) bleiben.
- **JSON-Stores** (Lesezeichen, Hörfortschritt, Dubletten): `createJsonState` in `lib/atomic-file.cjs`
  ersetzt `createJsonFile`.
  - Eine Änderung läuft auf einer Kopie; der neue Stand gilt erst, wenn die Datei geschrieben ist.
  - Scheitert das Schreiben, bleiben Speicher und Datei auf dem alten Stand.
  - Änderungen laufen nacheinander, jede sieht die vorige; ohne Änderung wird nicht geschrieben.
- **Fehler-Handler:** Zu große Anfragen melden je nach Route „Bilddatei größer als 10 MB“ (Infografiken),
  „Aufnahme größer als 10 MB“ (Stimmen) oder allgemein „Die Anfrage ist zu groß.“. Kaputtes JSON ergibt
  400 „Ungültige Anfrage.“ statt der Express-Standardseite.
- **Volltextsuche:** Das Fuse-Limit von 2.000 Treffern vor dem Filtern ist entfallen. Gemessen: Bei „frau“
  mit Autor „Stefan Hiene“ fehlten 421 von 823 Treffern. Ohne Limit ist die Suche nicht langsamer, der
  Aufwand steckt im Durchsuchen selbst.
- **Sitzungen überstehen Neustarts:** `lib/session-file-store.cjs` speichert sie in `sessions.json`
  (`SESSIONS_FILE`, Rechte 0600, gitignored).
  - Änderungen werden nach einer Sekunde gebündelt und atomar geschrieben, beim Beenden sofort.
  - Abgelaufene Sitzungen werden beim Laden und stündlich entfernt.
  - Das funktioniert nur mit festem `SESSION_SECRET` (in Produktion Pflicht); ohne ihn passt die Signatur
    der Cookies nach dem Neustart nicht mehr.
  - Tests und Skripte, die `server.js` nur laden, nutzen weiter den flüchtigen Speicher.

**Geprüft:**
- Node-Suite 401/401, neu: `test/session-file-store.test.cjs` und `test/error-responses.test.cjs`, dazu
  der Schreibfehler-Test in `test/shared-helpers.test.cjs`.
- Echter Server mit Test-Admin: anmelden, Server beenden, neu starten – `/api/me` liefert weiter den
  angemeldeten Admin.

**Deployment:**
- Kopieren: `server.js`, `.gitignore`, `audiobooks.cjs`, `bookmarks.cjs`, `duplicates.cjs`,
  `tts/jobs.cjs`, `lib/atomic-file.cjs`, `lib/session-file-store.cjs` (neu).
- Der Dienstnutzer muss im App-Verzeichnis `sessions.json` anlegen dürfen (wie `users.json`).
- Danach den Dienst neu starten. Beim allerersten Neustart sind noch alle abgemeldet, ab dann nicht mehr.

## 31. Aktualisierung 27.10.2026 – Frontend und Pflege

- **Automatische Cache-Buster:** `createVersionedIndex` (`lib/app-shell.cjs`) hängt beim Ausliefern jeder
  lokalen JS-/CSS-Referenz in `index.html` `?v=<10 Zeichen SHA-256 des Inhalts>` an.
  - Neu berechnet wird nur nach einer Änderung an `index.html` oder einer referenzierten Datei; pro Abruf
    genügt ein `stat` je Datei.
  - Die 20 handgepflegten Nummern sind aus `index.html` entfernt; ein Test verhindert neue.
  - Tests prüfen keine festen Versionen mehr (28 Stellen in 17 Dateien).
- **Stylesheets aufgeteilt:** `styles.css` (3.824 Zeilen) liegt jetzt in neun Dateien unter `public/css/`,
  geschnitten an den bestehenden Abschnittsgrenzen.
  - Reihenfolge und Inhalt sind unverändert; zusammengesetzt ergeben die Teile exakt die alte Datei.
  - `css/duplicates.css` wird nur Admins ausgeliefert (`data-admin-asset`, `ADMIN_ASSET_PATHS`).
  - Die Service-Worker-Version beobachtet auch `public/css/`.
  - Tests lesen alle Teile über `test/support/read-styles.cjs`.
- **Scraper ohne feste Joe-Turan-Werte:** `CHANNEL_DISPLAY_NAME`, `LEGACY_POST_AUTHORS`, der Titel-Suffix
  mit `joeturan.com` und der Kuschel-Workshop-Filter sind aus `scrape_all.js` entfernt.
  - Neue optionale Felder je Quelle in `scraper-config.json`: `FileAuthor`, `Signature` (`Name`, `Website`)
    und `Exclude` (regulärer Ausdruck).
  - Die Blog-Titelendung „/ Blog | www.<Domain>“ wird aus der Quell-URL abgeleitet.
  - Die Config ist so ergänzt, dass sich das Verhalten der bestehenden Quellen nicht ändert.
- **Modulformen:** Bewusst nicht migriert. Die drei Formen haben jeweils einen Zweck; die Regeln, welche Form
  wann gilt, stehen jetzt in CLAUDE.md und AGENTS.md. Eine vollständige Umstellung von `app.js`
  (rund 3.500 Zeilen, geteilte globale Funktionen mit sechs anderen Skripten) wäre ein eigenes Vorhaben.

**Geprüft:**
- Node-Suite 405/405 und Scraper-Tests 11/11 (neu: Config-Felder, Titel-Suffix, ungültige Optionen).
- Im Browser: Alle Skripte und die neun Stylesheets laden mit Hash-Versionen, Kacheln und Gestaltung wie
  vorher, der Update-Hinweis erscheint nach der Änderung.

**Deployment:**
- Kopieren:
  - `public/index.html` und den neuen Ordner `public/css/`; `public/styles.css` auf dem Server löschen
  - `server.js`, `lib/app-shell.cjs`
  - `scraper/scrape_all.js`, `scraper/scraper-config.json`
- Danach den Dienst neu starten.

## 32. Aktualisierung 27.10.2026 – Kleinere Code-Punkte aus dem Review

- **Reindex-Status:** `withReindexState(anzahl, task)` in `server.js` ersetzt die fünf gleichartigen
  try/catch-Blöcke (Voll-Reindex, Scraper-Dateien, Editor-Datei, Infografik-Jahrgänge).
  - Der Status „läuft“ wird weiterhin sofort gesetzt, damit die Archivsperre greift.
  - Danach gilt „fertig“ mit der Artikelzahl des neuen Index oder „fertig mit Fehler“.
- **Jahr aus dem Pfad:** `yearFromRelativeDir` (`lib/archive-files.cjs`) ersetzt die zwei kopierten
  Ausdrücke.
- **Pfadschutz an einer Stelle:** `isPathInside` liegt jetzt in `lib/archive-files.cjs`;
  `media-files.cjs` und `resolveUnder` nutzen es.
  - Die fünf direkten `startsWith(root + path.sep)`-Prüfungen in `server.js` (Papierkorb, Dublettenmigration,
    Prompts) sind ersetzt.
  - Die Vorschaubilder (`/og-image`) prüfen ihren Pfad jetzt mit `resolveMediaRequest`, wie `/files/*`.
  - Die eigene Windows-Sonderbehandlung (Kleinschreibung) entfällt, weil `path.relative` sie schon beachtet.
- **Papierkorb in `/files/*`:** Wird nur noch einmal geprüft; das war schon mit der Pfad-Korrektur
  (`media-files.cjs`) erledigt.

**Geprüft:**
- Node-Suite 407/407, neu: Test für `isPathInside`, `resolveUnder` und `yearFromRelativeDir`.
- Echter Server mit Test-Admin: Reindex über `/api/reindex`, Status läuft durch bis „fertig“
  (7.096 Artikel); Vorschaubild und Prompts antworten wie vorher.

**Deployment:**
- Kopieren: `server.js`, `media-files.cjs`, `lib/archive-files.cjs`.
- Danach den Dienst neu starten.

## 33. Aktualisierung 27.10.2026 – Große Dateien aufgeteilt (Schritt 1)

- **Hörbuch-Extras:** Die Extras-Verwaltung (Auflisten, Markdown bearbeiten/anlegen, Hochladen,
  Umbenennen, Sortieren, Löschen) liegt jetzt in `audiobook-extras.cjs` (`createAudiobookExtras`).
  - `audiobooks.cjs` schrumpft von 1.087 auf 706 Zeilen.
  - Die Bibliothek reicht nur Wurzelordner, versionierte Medien-URLs und den Neuaufbau hinein.
  - Die Routen und die öffentliche API (`library.extras` usw.) bleiben unverändert.
- **Touch-Gesten:** Pinch-Erkennung, Textauswahl, bedienbare Fortschrittslinie (`enableScrubBar`) und
  Nach-unten-Wischen (`enablePullToClose`) liegen jetzt in `public/touch-gestures.js`.
  - Die Datei wird vor `app.js` geladen und hängt nicht von `app.js` ab.
  - `app.js`, `audiobooks.js` und `book-reader.js` rufen die Funktionen wie bisher auf.
  - `app.js`: 3.345 → 3.192 Zeilen.
- **Bewusst noch nicht ausgelagert:** Detailansicht, Vollbild-Galerie und Audio/Media Session in `app.js`.
  - Diese Teile greifen eng auf den Zustand und die DOM-Referenzen von `app.js` zu.
  - Rund 130 Testprüfungen lesen `app.js` als Quelltext.
  - Eine Auslagerung braucht zuerst klare Schnittstellen (wie bei `adminHooks`) und ist ein eigener Schritt.

**Geprüft:**
- Node-Suite 408/408, neu: `test/touch-gestures.test.cjs`.
- Im Browser: Gesten-Funktionen geladen, Artikel öffnet, keine Konsolenfehler.

**Deployment:**
- Kopieren: `audiobooks.cjs`, `audiobook-extras.cjs` (neu), `public/app.js`, `public/touch-gestures.js` (neu),
  `public/index.html`.
- Danach den Dienst neu starten.

## 34. Aktualisierung 27.10.2026 – Einheitliches API-Fehlerformat

- **Format:** Jeder API-Fehler ist `{ error: <deutsche Meldung>, code?: <fester Code> }`. Die TTS-Routen nutzten
  `code` schon (`audio_exists`).
- **`sendApiError(res, code)`** (`lib/http-errors.cjs`) ersetzt die englischen Texte:

  | Code | Status | Meldung | vorher |
  |---|---|---|---|
  | `not_authenticated` | 401 | „Nicht angemeldet.“ | `Not authenticated` |
  | `admin_required` | 403 | „Nur für Administratoren.“ | `Admin only` |
  | `password_change_required` | 403 | „Bitte zuerst ein neues Kennwort festlegen.“ | (deutsch, ohne Code) |
  | `forbidden` | 403 | „Kein Zugriff.“ | `Access denied` |
  | `not_found` | 404 | „Nicht gefunden.“ | `Not found` |

- **Frontend:**
  - `apiFetch` erkennt eine abgelaufene Admin-Sitzung und eine ausstehende Kennwortänderung jetzt am Code
    statt am Text `'Admin only'`.
  - Die vier Stellen, die `err.message === 'Session expired'` verglichen (`app.js`, `book-reader.js`,
    `password.js`, `user-admin.js`, Extras-Verwaltung), prüfen jetzt `err.code === 'session_expired'`.
  - Die geworfenen Meldungen sind deutsch. Das Editor-Bundle ist neu gebaut.
- Interne Kennungen wie `reason: 'already running'` bei Reindex/Scrape bleiben; sie werden nie angezeigt.

**Geprüft:**
- Node-Suite 410/410, neu: Codes für 401/403 und eine Quellprüfung gegen Textvergleiche im Frontend.
- Im Browser: Die Seite lädt normal; eine unbekannte Artikel-ID liefert `{ error: "Nicht gefunden.", code: "not_found" }`.

**Deployment:**
- Kopieren: `server.js`, `media-files.cjs`, `lib/http-errors.cjs`.
- Aus `public/`: `app.js`, `book-reader.js`, `password.js`, `user-admin.js`, `audiobook-extras-manager.js`,
  `vendor/article-editor.bundle.js`.
- Danach den Dienst neu starten.

## 35. Aktualisierung 27.10.2026 – Infografik-Verwaltung: Poster-Haken direkt nach dem Upload

**Fehler:** Direkt nach einem Upload (oder einer anderen Änderung) baute der Dialog die Liste neu auf, während er
noch als beschäftigt galt, solange im Hintergrund die Artikelansicht neu geladen wurde. Die neu gerenderten
Checkboxen waren dabei nicht gesperrt: Der Haken „Instagram-Poster“ ließ sich setzen, der Klick wurde aber
wegen `busy` still verworfen und nie gespeichert.

**Behoben in `public/infographic-manager.js`:**
- `igmRender` übernimmt den Sperrzustand für neu gerenderte Bedienelemente (außer dem Poster-Haken, siehe unten).
- Upload und Änderungen laufen über `igmRun`: Gesperrt ist nur, solange der Server schreibt und die Liste neu
  lädt. Die Artikelansicht wird danach im Hintergrund aktualisiert, der Poster-Haken ist sofort speicherbar.
- Ältere Rückmeldungen überschreiben die Statuszeile einer neueren Aktion nicht.
- **Poster-Haken auch während eines Vorgangs:** Der Haken bleibt beim Hochladen und Speichern bedienbar. Ein
  Klick wird vorgemerkt (`pendingPoster`), beim Neuaufbau der Liste zeigt die Checkbox den vorgemerkten Wert,
  und nach dem Vorgang wird er gespeichert, sofern er vom Stand auf dem Server abweicht (`igmFlushPoster`).

**Geprüft:** Node-Suite 410/410. Im Browser mit Test-Admin ohne Dateiänderungen (Speicheranfrage abgefangen):
Haken während eines nachgestellten Uploads umgeschaltet, Wert bleibt beim Neuaufbau erhalten, danach genau eine
Speicheranfrage mit dem gewünschten Wert.

**Deployment:** `public/infographic-manager.js` kopieren (Browser neu laden genügt, kein Neustart nötig).

## 36. Aktualisierung 28.10.2026 – Dokumentation bereinigt, Privat-Markierung in eigener Datei

- **Widersprüche in Session.MD behoben:**
  - Abschnitt 13: Der Cron-Wrapper ist erledigt (Reindex per SIGHUP statt Neustart).
  - Qwen-Abschnitte: Der geltende Vertrag heißt `webarchiv-qwen-v5`. Das ist die v4-Verarbeitung plus
    Chunk-Fortschritt; die Tabelle der Stufen hat eine eigene v5-Zeile.
  - Audio-Reihenfolge: geprüft, kein Widerspruch mehr (lokal neben der `.md` zuerst, dann `audio/`).
  - Commit `bfc6641`: In Abschnitt 13 steht jetzt, dass es keinen Web Worker gibt.
- **Dokumentiert:** private Hörbücher und alle Sortierungen (`recent`, `added`, `title`, `date`, Admin-only
  `private`) im README und in CLAUDE.md, dazu `AUDIOBOOK_PRIVATE_FILE`.
- **Privat-Markierung umgezogen:** von `audiobook-progress.json` (Nutzerdaten) nach `audiobook-private.json`
  (`{ version: 1, books: { <Buch-ID>: true } }`, gitignored). Die Schnittstelle `isPrivate`/`setPrivate` bleibt.
  - Der Server kennt nur noch die neue Datei; Altformat und Übernahmelogik sind entfernt.
  - Einmal-Übernahme mit `scripts/migrate-audiobook-private.js` (`--dry-run`, mehrfach ausführbar):
    erst `audiobook-private.json` schreiben (vorhandene Einträge bleiben), dann die alten Einträge
    (`__global.__private`, `<E-Mail>.__private`) aus dem Hörfortschritt entfernen.
  - Ein vorübergehender Hinweis im Log für nicht übernommene Einträge ist nach der erfolgreichen Migration
    auf dem Server (28.10.2026, vom Benutzer bestätigt) wieder entfernt; der Server kennt das alte Format nicht mehr.

**Geprüft:** Node-Suite 411/411. Skript-Test: Probelauf ändert nichts; Übernahme globaler und nutzerbezogener
Markierungen; bestehende Einträge bleiben; Hörfortschritt bleibt; zweiter Lauf tut nichts. Dazu ein Test für den
Hinweis im Log.

**Deployment – Reihenfolge wichtig, sonst sind private Bücher kurz für alle sichtbar:**
1. Dateien kopieren: `audiobooks.cjs`, `server.js`, `.gitignore`, `scripts/migrate-audiobook-private.js`.
2. `sudo systemctl stop nodeapp`
3. Im App-Verzeichnis als Dienstnutzer: `node scripts/migrate-audiobook-private.js --dry-run`, dann ohne
   `--dry-run`. (Abweichende Pfade über `AUDIOBOOK_PROGRESS_FILE`/`AUDIOBOOK_PRIVATE_FILE` oder
   `--progress`/`--private`.)
4. `sudo systemctl start nodeapp`; im Log darf kein Hinweis auf alte Privat-Markierungen stehen.

## 37. Aktualisierung 28.10.2026 – Dubletten-Werkzeug nutzt die Module des WebArchiv

Das Werkzeug `duplicates-tool/` läuft nur in der Entwicklung, nicht in Produktion. Es arbeitet mit
denselben Daten, hatte aber eigene Kopien der Logik.

- **HTML-Bereinigung:** Die Vergleichsansicht rendert mit `renderSafeMarkdown` statt mit ungefiltertem
  `marked.parse`.
- **Kopien entfernt:**
  - Parser: `lib/article.cjs` ruft jetzt `lib/article-parser.cjs` auf.
  - Wortgleiche Erkennung: `normalizeDuplicateText`, `wordShingles`, `overlap` und `dateDistanceDays` kommen
    aus `duplicates.cjs`, das sie dafür zusätzlich exportiert.
  - `buildDuplicateProfile` und `compareDuplicateProfiles` bauen auf denen des WebArchiv auf. Das Werkzeug
    ergänzt nur die Inhaltswörter bzw. das Feld `method`.
  - Diff-Modul: Die Kopie ist gelöscht; ausgeliefert wird `public/vendor/duplicate-diff.bundle.js`. Die
    abweichenden Beschriftungen betrafen nur die zweispaltige Ansicht, die das Werkzeug nicht nutzt.
  - JSON schreiben: `lib/atomic-file.cjs`.
  - Bewusst eigen bleiben die inhaltliche Ähnlichkeit (TF-IDF), `decisionStillApplies` (A/B, ohne
    „verknüpft“), Scan und Verschieben.
- **Keine eigenen Abhängigkeiten mehr:** `package.json` ohne `dependencies`, `package-lock.json` gelöscht.
  Das Werkzeug läuft mit den `node_modules` des Projektordners (geprüft mit umbenanntem
  `duplicates-tool/node_modules`). Der lokale Ordner `duplicates-tool/node_modules` kann gelöscht werden.
- **Tests:** `duplicates-tool/test/*.test.cjs` laufen in `npm test` mit; neu ist ein Test für die Bereinigung.

**Geprüft:**
- Node-Suite 420/420.
- Vorher/Nachher mit der alten Fassung aus git auf denselben Ordnern („Joe Turan“ gegen „Facebook“):
  identische 486 Treffer und Bewertungen; Titel, Datum und Text-Hash aller 1.360 Originale gleich.
- Im Browser (zweite Instanz auf Port 3101, nur lesend): Das Werkzeug lädt mit dem gemeinsamen
  Diff-Bundle, keine Konsolenfehler.

**Hinweis:** Die bereits laufende Werkzeug-Instanz auf Port 3100 nutzt bis zu ihrem Neustart noch den alten Code.

## 38. Aktualisierung 28.10.2026 – app.js aufgeteilt (Galerie, Medien, Detail)

`app.js` (3.192 Zeilen) ist in vier klassische Skripte aufgeteilt:

| Datei | Inhalt | Zeilen |
|---|---|---|
| `public/app-gallery.js` | Vollbild-Galerie mit Blättern, Zoom/Verschieben, Bild herunterladen/teilen | 220 |
| `public/app-media.js` | Audio-, Video- und PDF-Player, Media Session | 232 |
| `public/app-detail.js` | Artikel öffnen/schließen, Lesezeichen, `renderDetail` | 421 |
| `public/app.js` | Zustand, Liste, Filter, Anmeldung, Navigation, Ereignisse, Start | 2.338 |

- Die `app-*.js` werden vor `app.js` geladen und enthalten nur Deklarationen. Die Funktionen greifen zur
  Laufzeit über den gemeinsamen globalen Gültigkeitsbereich auf Zustand und DOM-Referenzen aus `app.js` zu.
- Verschoben wurde ohne inhaltliche Änderung. Ein Test (`test/app-split.test.cjs`) prüft Ladereihenfolge,
  Zuständigkeit und dass auf oberster Ebene nur Deklarationen stehen.
- Tests lesen alle Teile über `test/support/read-app.cjs`. Dafür war in 20 Testdateien nur die Einlesezeile
  zu ändern, keine Prüfung selbst.
- **Nebenbei behoben (bestehender Fehler):** Nach dem Stoppen eines Artikel-Audios konnte ein verspätetes
  `timeupdate` `audioEl.currentTime` auf `null` lesen (Konsolenfehler). `wireAudioPlayer` nutzt jetzt
  durchgehend das eigene Element statt des globalen `audioEl`; dazu gibt es einen Regressionstest.

**Geprüft:**
- Node-Suite 423/423.
- Im Browser als Gast und mit Test-Admin:
  - Detailansicht öffnen und schließen.
  - Bildgruppe per Klick im Vollbild öffnen, mit der Pfeiltaste blättern (Hash `?bild=2`), mit Escape
    schließen, Zoom.
  - Audio-Player, Aktionsmenü und Lesezeichen vorhanden.
  - Audio dreimal gestartet und gestoppt: Media-Session-Titel gesetzt, danach aufgeräumt, keine Konsolenfehler.

**Deployment:**
- Kopieren aus `public/`: `app.js`, `app-gallery.js`, `app-media.js`, `app-detail.js` (alle drei neu),
  `index.html`.
- Browser neu laden genügt; ein Neustart des Dienstes ist nicht nötig.

## 39. Aktualisierung 28.10.2026 – Befunde aus dem Review vom 28.10. (Tastatur, Fehlertexte, Dubletten, Nutzer, Status)

Grundlage: `code-review_2026-01-28.md`, Punkte 2.1 bis 2.5.

- **Tastatur bei offenem Dialog (2.1):** Liegt ein Dialog (`dialog[open]`) oder das TTS- bzw. Scrape-Fenster über
  dem Artikel, schließt Escape nur diese Ebene, und die Pfeiltasten wechseln den Artikel nicht mehr. Vorher schloss
  Escape im Anbieterdialog von „Audio erzeugen“ auch den Artikel, und die Pfeiltasten zwischen den Radiobuttons
  sprangen zum Nachbarartikel. Aus Bedienelementen, die Pfeile selbst nutzen (Eingaben, Audio/Video, Regler),
  blättern die Pfeile auch in der Artikelansicht nicht. Gemeinsame Hilfe `layerAboveContentOpen()` und
  `ARROW_KEY_CONTROLS` in `public/app.js`.
- **Keine internen Fehlertexte (2.2):** Neue Hilfe `sendRouteError` in `lib/http-errors.cjs`, die auch `jsonRoute`
  nutzt: Fehler mit `status` gehen mit ihrer Meldung an die Oberfläche, unerwartete nur ins Dienst-Log. Ist auch
  die Wiederherstellung fehlgeschlagen, steht deren Ursache nur im Log. Umgestellt sind die Infografik-Routen
  (Verwaltung, Prüfmodus, Upload, neue Infografik) und die Dublettenrouten.
- **Dubletten-Abschluss (2.3):** `finishDuplicateLinks` in `duplicates.cjs`. Scheitert das Umziehen der Lesezeichen,
  bleibt die Verknüpfung gültig, der Index wird trotzdem aktualisiert, und die Antwort enthält `warning`
  (Anzeige in der Statuszeile des Dublettendialogs). Vorher endete das mit 500 und einem veralteten Index.
- **Nutzerverwaltung (2.4):** `mutateUsers` ändert eine Kopie und übernimmt sie erst nach dem Schreiben von
  `users.json`. Ein nie gespeichertes Kennwort gilt dadurch nicht mehr bis zum Neustart.
- **Status nur für Admins (2.5):** `GET /api/scrape/status` und `GET /api/reindex/status` verlangen
  `requireAdminAccess`; die Scraper-Ausgabe ist für normale Nutzer nicht mehr lesbar. Die Oberfläche fragt den
  Status ohnehin nur in `admin-tasks.js` ab.

**Geprüft:**
- Node-Suite 431/431, Python 14/14. Neu: `test/keyboard-layers.test.cjs` (Tastatursteuerung im VM-Sandkasten),
  Tests für `sendRouteError`, `finishDuplicateLinks`, Schreibfehler im Nutzerspeicher und die Statusrouten.
- Im Browser als Gast: Artikel geöffnet, Dialog darüber, Pfeil rechts und Escape wirken nur im Dialog; ohne Dialog
  blättert der Pfeil weiter, und Escape schließt den Artikel. Statusrouten antworten mit 403 `admin_required`.
  Keine Konsolenfehler. Der Anbieterdialog selbst (nur Admin) wurde nicht im Browser geprüft.

**Deployment:**
- Kopieren: `server.js`, `duplicates.cjs`, `user-store.cjs`, `lib/http-errors.cjs`, `public/app.js`,
  `public/duplicates.js`.
- Dienst neu starten (Serverdateien geändert).

## 40. Aktualisierung 29.10.2026 – Cron-Scrape: Reindex kam nicht an

**Symptom:** Nach dem nächtlichen `run-scrape.sh` blieb der Artikelstand gleich, obwohl der Scraper neue Artikel
gespeichert hatte. Erst ein manueller Reindex zeigte sie.

**Ursache:** Seit 26.10.2026 sendete das Skript `sudo /usr/bin/systemctl kill -s HUP nodeapp`. Der Cron läuft
als `ralf` ohne Terminal; ohne sudoers-Regel genau für diesen Befehl fragt sudo nach einem Kennwort und bricht
ab. Die Fehlermeldung ging nicht ins Log (die Zeile hatte keine Umleitung). Vorher lief
`sudo systemctl restart nodeapp`, für das offenbar eine passende Regel existiert.

**Behoben:**
- `scraper/run-scrape.sh` sendet `kill -HUP` an die `MainPID` des Dienstes, ohne sudo (Dienst und Cron laufen
  beide als `ralf`). Erfolg oder Fehler stehen jetzt in `cron-scrape.log`; im Fehlerfall endet das Skript mit 1.
- **Zweiter Weg zum gleichen Symptom:** Lief beim Signal ein Auftrag (z. B. eine lange Audio-Erzeugung), wurde der
  Reindex bisher nur protokolliert und entfiel. Jetzt merkt der Server ihn vor und holt ihn nach, sobald das Archiv
  frei ist (`archiveLock.whenIdle`, Prüfung alle 30 s, mehrere Signale werden zusammengefasst).

**Geprüft:** Node-Suite grün, neue Tests für `whenIdle` und für das Skript (kein sudo, LF, Protokollzeilen);
`bash -n` und die PID-Bedingung mit Ersatzwerten. Auf dem LXC selbst nicht geprüft.

**Deployment:**
- `server.js`, `archive-lock.cjs` und `scraper/run-scrape.sh` kopieren; das Skript muss ausführbar bleiben
  (`chmod +x`) und LF-Zeilenenden haben.
- Dienst neu starten.
- Einmal von Hand als `ralf` (ohne sudo) prüfen: `/opt/nodeapp/scraper/run-scrape.sh`, danach
  `tail -n 5 /opt/nodeapp/scraper/cron-scrape.log` und
  `journalctl -u nodeapp --since '-10 min' | grep -E 'SIGHUP|articles'`.

## 41. Aktualisierung 29.10.2026 – Dialoge scrollen nicht mehr in die Seite dahinter

**Symptom:** Im Dialog „Scrape-Log anzeigen“ scrollte ein weiterer Touch-Wisch am Ende des Logs die Artikelliste im
Hintergrund. Dasselbe galt für andere Scrollbereiche ohne eigene Angabe (Audio-Auftrag, Benutzerverwaltung,
Hörbuch-Extras, Dubletten-Listen, Infografik-Manager u. a.).

**Ursache:** Scroll-Verkettung. Nur einzelne Bereiche (Artikel-Panel, eBook-Reader, Bildvollansicht) hatten
`overscroll-behavior`; `html.modal-open { overflow: hidden }` verhindert das Weiterreichen in Safari per Touch nicht.

**Behoben:** Eine gemeinsame Regel in `public/css/dialogs.css` setzt `overscroll-behavior: contain` für alle
`dialog`-Elemente, die Ebenen `.overlay`, `.scrape-overlay` (Scrape- und TTS-Fenster), `.login-overlay`,
`.img-fullscreen`, `.book-reader` (eBook und Extras) und alle ihre Nachfahren. Per `:where()` ohne Gewicht, damit
eigene Angaben wie `overscroll-behavior-y: none` am Artikel-Panel Vorrang behalten.

**Geprüft:** Test in `test/modal-scroll-lock.test.cjs`; im Browser die berechneten Werte (Dialoge und Ebenen
`contain`, Artikel-Panel weiter `none` in y, Seite selbst unverändert). Auf einem iPhone nicht geprüft.

**Deployment:** `public/css/dialogs.css` kopieren; Browser neu laden genügt.

## 42. Aktualisierung 29.10.2026 – Review-Punkte 2.6, 2.7, 2.9 und 2.11

Grundlage: `code-review_2026-01-28.md`.

- **Pfadprüfungen (2.6):** Alle handgeschriebenen `startsWith(... + path.sep)`- bzw. `'..'`-Prüfungen nutzen jetzt
  `isPathInside` aus `lib/archive-files.cjs`: `article-editor.cjs`, `tts/jobs.cjs`, `server.js` (Prüfmodus),
  `scripts/migrate-audio.js`, `scripts/migrate-infographic-names.js` (eigene Kopie entfernt),
  `duplicates-tool/lib/scan.cjs` und `scraper/scrape_all.js` (ESM-Import der CJS-Datei).
  Neuer Regeltest `test/code-rules.test.cjs` verbietet das Muster in allen Quellordnern.
  - **Nebenbei behoben:** `scripts/migrate-audio.js` suchte seit dem Umzug nach `scripts/` (07.10.2026) unter
    `scripts/www` und fand kein Autorenverzeichnis. Aufruf jetzt `node scripts/migrate-audio.js "<Autor>"`.
- **Infografik-Dateien (2.7):** Die Dubletten-Migration überschreibt die `.md` per `writeFileAtomic`; ihr
  Rollback führt jeden Schritt aus und protokolliert Fehler. `moveInfographicFiles` rollt pro Datei zurück, auch
  wenn ein Schritt scheitert, und meldet dann mit Status 500, welche Dateien unter welchem Temp-Namen
  liegengeblieben sind (Details im Log). Regeltest: `fs.promises.writeFile` in `server.js` nur mit `flag: 'wx'`.
- **Doppelte Busy-Prüfungen (2.9):** `POST /api/reindex` und `POST /api/scrape` prüfen nur noch `archiveLock.busy`;
  die 409-Antwort nennt den laufenden Auftrag. `admin-tasks.js` zeigt diese Meldung statt eigener Texte.
- **Kleinigkeiten (2.11):**
  - Admin-Schutz antwortet mit festen Codes `cross_site`, `invalid_origin`, `csrf_invalid`; bei `csrf_invalid`
    lädt `apiFetch` die Seite neu (frisches Token).
  - Letzter Fehler-Handler (`handleRequestError`): unbehandelte Fehler unter `/api/*` liefern JSON
    `{ error, code: 'internal' }` ohne Stacktrace, die Ursache steht im Log.
  - 413-Meldung nennt bei Hörbuch-Extras „Markdown-Extras“ statt „Artikel“.
  - Login-Begrenzung: 5 Fehlversuche sperren nur noch Konto **+ IP**; ein Konto insgesamt erst nach 50
    (verteilte Angriffe), eine IP weiter nach 30. Wer nur die E-Mail kennt, sperrt den Inhaber nicht mehr aus.
  - Ungenutzte Re-Exporte entfernt (`writeJsonAtomic` aus `user-store.cjs`, `isPathInside` aus `media-files.cjs`).
  - Editor und TTS finden Artikel über `articleById` statt linearer Suche.
  - `esc` in `app.js` behandelt Zahlen und `'` wie die bisherige Kopie `duplicateEsc`; `duplicates.js` nutzt `esc`.
  - `normalizeDate` in `audiobooks.cjs` heißt `normalizeAbstractDate` und erklärt die abweichende Regel.

**Geprüft:** Node-Suite 440/440, Python 14/14 (neu: Regeltests, Rollback mit fehlschlagender Datei,
Fehler-Handler, 413-Meldungen, CSRF-Codes, neue Login-Grenzen). `node --check` für die geänderten Skripte, ESM-Import
des Scrapers. Im Browser als Gast: Kacheln und Artikel laden, `esc` korrekt, keine neuen Konsolenfehler.

**Deployment:**
- Kopieren: `server.js`, `article-editor.cjs`, `audiobooks.cjs`, `login-limiter.cjs`, `media-files.cjs`,
  `user-store.cjs`, `lib/http-errors.cjs`, `lib/infographics.cjs`, `tts/jobs.cjs`, `scraper/scrape_all.js`,
  `scripts/migrate-audio.js`, `scripts/migrate-infographic-names.js`, `public/app.js`, `public/admin-tasks.js`,
  `public/duplicates.js`.
- Dienst neu starten.

## 43. Aktualisierung 29.10.2026 – Review-Punkt 2.10: Doku an den Code angeglichen

- **Sitzungsinhalt:** `CLAUDE.md` beschreibt jetzt, was tatsächlich in der Sitzung (und in `sessions.json`) steht:
  das aufgelöste Nutzerobjekt. Maßgeblich sind nur `email` und `sessionVersion`; Rolle und Rechte werden bei
  jeder Anfrage neu aus `users.json` aufgelöst. Am Code ändert sich nichts.
- **Umlaute im Journal:** Die `<E2>…`-Folgen erzeugt `journalctl` selbst, wenn die Locale der lesenden Shell nicht
  UTF-8 ist. Texte auf ASCII umzustellen hilft nicht vollständig, weil Buchtitel, Dateinamen und Auftragsnamen
  Umlaute mitbringen. Neuer Abschnitt „Stolperfalle: Umlaute im Journal“ in `LXC-container node.js Setup.md`
  (`LANG=C.UTF-8` in `/etc/default/locale`); Hinweis beim erledigten Punkt in `To-Do-Liste.md`.
- **Cron-Wrapper:** Die zwei veralteten Aussagen „weicht noch ab“ (Übersichtstabelle und Abschnitt 7) verweisen
  jetzt auf den `kill -HUP`-Weg aus Abschnitt 40.
- **`tts/UEBERGABE-TTS.md`:** als historisches Übergabedokument gekennzeichnet; der Healthcheck nennt den
  geltenden Vertrag `webarchiv-qwen-v5`.

**Geprüft:** reine Doku-Änderung, kein Code betroffen.

**Auf dem LXC (einmalig):** `echo 'LANG=C.UTF-8' | sudo tee /etc/default/locale`, neu anmelden, mit
`locale | head -1` prüfen.

## 44. Aktualisierung 29.10.2026 – Review-Idee 3.3: Teil-Reindex ohne erneute Dublettenerkennung

**Ausgangslage:** Jeder Teil-Reindex (Poster-Haken, Infografik-Upload oder -Umordnung, Dublettenentscheidung,
Autoren-Priorität, Editor, TTS) veröffentlicht den ganzen Index neu. Davon kostete die Dublettenerkennung beim
lokalen Bestand (7.113 Einträge) rund 620 ms, in denen der Server keine Anfrage beantwortet; Fuse rund 20 ms,
die Infografik-Verknüpfung rund 10 ms.

**Umsetzung:** `createDuplicateDetection()` in `duplicates.cjs`, genutzt von `refreshDuplicateState` in `server.js`.
Die Erkennung hängt nur von Reihenfolge, Autor, Datum und Profil der Blog- und Quellartikel ab. Ein Artikel behält
sein Profil-Objekt, solange er nicht neu eingelesen wird. Sind diese Eingaben unverändert, wird das letzte Ergebnis
wiederverwendet und auf die aktuellen Artikelobjekte umgestellt (die bei jeder Veröffentlichung als Kopien neu
entstehen). Entscheidungen (verknüpft, ignoriert) werden wie bisher danach angewendet.

**Gemessen:** erster Lauf 623 ms, danach 1 ms je Teil-Reindex; die Kandidatenliste (465 Paare) ist identisch mit
einer frischen Erkennung. Weiterhin vollständig gerechnet wird, wenn ein Blog- oder Quellartikel neu eingelesen wird
(Editor, TTS-Audio an einem solchen Artikel, Scraper, Voll-Reindex).

**Geprüft:** Node-Suite 441/441, Python 14/14; neuer Test für Wiederverwendung, Umstellung auf neue Objekte,
Gleichheit mit frischer Erkennung und alle Auslöser für eine Neuberechnung.

**Deployment:** `duplicates.cjs` und `server.js` kopieren, Dienst neu starten.

## 45. Aktualisierung 29.10.2026 – Ebenen-Stapel, Schritt 1 (Review-Idee 3.2)

**Plan (abgestimmt):** Alle Ebenen über der Seite werden modale `<dialog>` und melden sich bei einem zentralen
Stapel an. Der iPhone-Probelauf (Branch `spike/dialog-ebenen`, nur lokal) mit Artikelansicht, Bildvollansicht,
eBook-Reader und Extras als `<dialog>` war in allen sieben Prüfpunkten in Ordnung. Erkenntnis daraus: Wer Escape
behandelt, muss `preventDefault()` aufrufen, sonst schließt der Browser mit demselben Tastendruck zusätzlich den
nun obersten Dialog. Entscheidung A: Ebenen mit eigenem History-Eintrag (Artikel, Bild) schließen künftig per
`history.back()` (umgesetzt in Schritt 2).

**Schritt 1 (dieser Stand):** neues gekapseltes Skript `public/layer-stack.js` (`window.WebArchivLayers`), in
`index.html` direkt nach `aria-menu.js` geladen, noch ohne Nutzer und damit ohne Verhaltensänderung.
- `open(dialog, { name, onEscape, onKey, returnFocus })`, `close(dialog, { restoreFocus })`, `top()`, `isOpen()`, `count`.
- Tastatur in fester Reihenfolge: Element (wer behandelt, ruft `preventDefault`/`stopPropagation`) → oberste
  Ebene (`onKey`, dann Escape) → Grundansicht (`setBase`, nur ohne offene Ebene). Ein Listener am Dokument in
  der Bubble-Phase.
- `cancel` des Dialogs selbst (Escape, Android-Zurück-Geste) läuft über dieselbe Schließlogik; `cancel` aus
  Dateifeldern wird ignoriert. Direkt per `dialog.close()` geschlossene oder offen entfernte Dialoge fallen heraus.
- Fokus-Rückgabe an das beim Öffnen fokussierte Element.
- `float(element, { when })` hängt schwebende Elemente (Miniplayer, Sprechblase) in die oberste passende Ebene und
  zurück an ihren Platz; `host()` für kurz angezeigte Elemente; `onChange` für Seitensperre und Klassen.

**Geprüft:** neue Tests `test/layer-stack.test.cjs` (8 Fälle); Node-Suite 450/450, Python 14/14. Im Browser: Modul
geladen, keine Konsolenfehler, Artikelnavigation und Escape unverändert.

**Nächste Schritte:** 2 Artikel- und Bildvollansicht als `<dialog>` am Stapel (inkl. `history.back()`), 3 Reader und
Extras, 4 Login/Scrape/TTS, 5 vorhandene Dialoge, 6 Aufräumen und Regeltest.

**Deployment:** `public/layer-stack.js` und `public/index.html` kopieren; Browser neu laden genügt.

## 46. Aktualisierung 29.10.2026 – Ebenen-Stapel, Schritt 2: Artikel, Bild, Reader und Extras als Dialog

**Umfang:** Schritt 2 umfasst auch Reader und Extras (bisher Schritt 3). Sie öffnen sich über der Artikelansicht;
als div lägen sie unter einem modalen Dialog und wären nicht bedienbar.

- **Als modaler `<dialog>` am Stapel:** Artikelansicht (`#article-overlay`), Bildvollansicht (`#img-fullscreen`),
  eBook-Reader und Extras (Klasse `app-layer`). Zustand ist `.open` statt `.hidden` (rund 30 Stellen umgestellt).
  CSS setzt die Browser-Vorgaben für diese Dialoge zurück (`:where(...)`), der eigene Hintergrund bleibt im Dialog.
- **Tastatur:** Der globale keydown-Handler in `app.js` entfällt. Artikel (`articleLayerKey`: ←/→ blättern) und
  Bildvollansicht (`fullscreenLayerKey`) sind Ebenen mit eigener Taste, die Kachelansicht ist die Grundansicht
  (`baseViewKey`, `WebArchivLayers.setBase`). Reader (`bookReaderKey`: ←/→ auf der Fortschrittslinie) und Extras
  verlieren ihre eigenen Capture-Handler.
- **Neu im Stapel:** Tasten aus einem noch nicht angemeldeten Dialog (z. B. TTS-Anbieter, Einstellungen) erreichen
  weder die Ebene darunter noch die Grundansicht. Damit ist auch der frühere Fehler 2.1 dauerhaft abgesichert.
- **Entscheidung A umgesetzt:** Öffnen und Blättern im Artikel speichern die Tiefe in `history.state.articleDepth`.
  `closeOverlay` (X, Escape, Herunterziehen, Android-Zurück-Geste) schließt sofort und nimmt die Einträge per
  `history.go(-Tiefe)` zurück; Zurück führt danach in die Liste, nicht wieder in den Artikel. Browser-Zurück
  (z. B. Wischgeste in Safari) schließt über `finishCloseOverlay` dieselbe Logik.
- **Schwebende Elemente:** Der Miniplayer wandert in Reader und Extras (`float`), die Sprechblase in die oberste
  Ebene (`host()`). Login-, Scrape- und TTS-Fenster sind bis Schritt 4 noch divs und hängen solange per `float` in
  der obersten Ebene (sonst lägen sie unter dem Artikel).
- **Seitensperre:** `html.modal-open` aus offenen Dialogen und den drei div-Fenstern; `overlay-open` aus `$overlay.open`.

**Geprüft:** Node 453/453, Python 14/14 (Tests für Tastatur, Seitensperre und Verlauf an das neue Verhalten
angepasst; neuer Stapel-Test für nicht angemeldete Dialoge). Im Browser als Gast: Artikel per Klick, Blättern
(Tiefe 1 → 3), Vollansicht darüber, Escape schließt je eine Ebene, Schließen springt zur Liste (`#/`), Pfeil blättert
danach Kachelseiten, Browser-Zurück schließt, Vor öffnet wieder, simuliertes `cancel` schließt. Als Admin (Handy-
Format): Reader mit Miniplayer (Play per Klick), Escape schließt nur den Reader; TTS-Anbieterdialog über dem Artikel
(Pfeil und Escape erreichen den Artikel nicht); TTS-Fenster sichtbar über dem Artikel; Infografik-Manager per Escape;
Extras → Bild → Escape → Escape mit Fokus zurück auf „Extras“. Keine Konsolenfehler aus der App. Am iPhone nach
diesem Stand noch nicht geprüft (der Probelauf vom selben Tag deckte Artikel, Bild, Reader und Extras ab).

**Deployment:** aus `public/` kopieren: `index.html`, `layer-stack.js`, `app.js`, `app-detail.js`, `app-gallery.js`,
`admin-tasks.js`, `audiobooks.js`, `audiobook-extras-manager.js`, `book-reader.js`, `infographic-manager.js`,
`infographic-review.js`, `pwa-update.js`, `touch-gestures.js`, `css/detail.css`. Browser neu laden genügt.

## 47. Aktualisierung 29.10.2026 – Ebenen-Stapel, Schritt 4: Login-, Scrape- und TTS-Fenster als Dialog

- **Als modaler `<dialog>` am Stapel:** `#login-overlay`, `#scrape-overlay`, `#tts-overlay` (Klasse `app-layer`).
  Der eigene Hintergrund (Klick schließt) bleibt im Dialog; CSS setzt die Browser-Vorgaben zurück (`dialogs.css`).
- **Login:** `onEscape` schließt nur, wenn schon jemand angemeldet ist oder als Gast unterwegs ist; die
  Pflicht-Anmeldung ohne Sitzung bleibt offen. Der Escape-Zweig in der Grundansicht entfällt.
- **TTS:** eigener Capture-Handler samt selbst gebauter Fokusfalle entfällt; Tab bleibt nativ im modalen Dialog,
  Escape schließt nur die Anzeige, andere Tasten erreichen den Artikel darunter nicht. Fokus-Rückgabe wie bisher.
- **Scrape-Log:** eigener Escape-Handler entfällt; Fokus kehrt über den Stapel zum Auslöser zurück.
- **Aufgeräumt:** `float()` für die drei Fenster, die Liste `modalOverlays` und die Sonderfälle in
  `layerAboveContentOpen`/`dialogOpen` entfallen. Die Seitensperre folgt allein `dialog[open]`.

**Geprüft:** Node 453/453, Python 14/14 (Tests für Seitensperre, Tastatur und TTS angepasst). Im Browser als Gast:
Login öffnet modal mit Fokus im E-Mail-Feld, Pfeil im Feld blättert nicht, Escape schließt; Pflicht-Anmeldung ohne
Sitzung bleibt bei Escape offen. Als Admin: Scrape-Log über das Menü, Pfeil blättert nicht dahinter, Escape schließt
mit Fokus zurück aufs Konto-Menü; TTS-Fenster über dem Artikel sichtbar, Tab achtmal bleibt im Fenster, Pfeil wechselt
keinen Artikel, Escape schließt nur das Fenster. Keine Konsolenfehler aus der App. Am iPhone nicht geprüft.

**Deployment:** `public/index.html`, `public/app.js`, `public/admin-tasks.js`, `public/css/dialogs.css` kopieren;
Browser neu laden genügt.

## 48. Aktualisierung 30.10.2026 – Dublettendialog reagierte kaum auf Mausrad und Tastatur

**Symptom:** Im Dialog „Dubletten prüfen“ scrollte die Liste mit dem Mausrad nicht (auf dem iPhone fühlte sich
das Wischen ähnlich zäh an), und Bild-ab/Pfeiltasten taten nichts.

**Ursache 1 (Rad, Wischen) – Folge von Abschnitt 41:** Die Regel gegen Scroll-Verkettung setzte
`overscroll-behavior: contain` auf **alle** Nachfahren von Dialogen. Elemente mit `overflow: hidden` (z. B. die
Dublettenkarten) gelten für den Browser ebenfalls als Scrollbereich; über ihnen blieb das Rad hängen, statt an die
Liste weiterzugehen. Gemessen: Rad über einer Karte 0 px, mit Gegenregel 300 px.
**Behoben:** Die Regel gilt nur noch für die Ebenen selbst und die echten Scrollbereiche (`overflow: auto`) in
Dialogen, als Liste in `public/css/dialogs.css`. Ein Test prüft, dass jeder Scrollbereich in den Stylesheets in
dieser Liste steht (oder selbst ein Dialog ist), und dass es keine Regel für alle Nachfahren mehr gibt.

**Ursache 2 (Tastatur, schon vorher so):** Nach einem Klick in die Liste lag der Fokus auf dem Dialog selbst;
Bild-ab und Pfeile scrollten dann den (nicht scrollenden) Dialog. **Behoben:** `#duplicate-content` hat
`tabindex="-1"` (ohne Fokusrahmen); ein Klick gibt der Liste den Fokus.

**Geprüft:** Node 453/453, Python 14/14. Im Browser als Admin: Rad über einer Karte scrollt (0 → 500 px), Kopf fährt
aus und beim Hochscrollen wieder ein; nach Klick in die Liste scrollen Bild-ab und Pfeil (0 → 689 px), Escape
schließt. Artikelansicht scrollt per Rad weiterhin. Die Verkettung in die Seite (Abschnitt 41) ist am iPhone nach
dieser Änderung noch nicht erneut geprüft.

**Deployment:** `public/css/dialogs.css`, `public/css/duplicates.css`, `public/index.html` kopieren; Browser neu laden.

## 49. Aktualisierung 30.10.2026 – Ebenen-Stapel, Schritt 5: alle übrigen Dialoge am Stapel

Alle restlichen nativen Dialoge öffnen über `WebArchivLayers.open(...)` statt `showModal()`. Ihre eigenen
`cancel`-Listener und die Capture-Handler am `document` (mit `stopImmediatePropagation`) entfallen; Escape läuft über
`onEscape`, das bisherige Schließlogik samt Rückfrage aufruft.

- **Einstellungen, TTS-Einstellungen, Passwort, Benutzerverwaltung:** `onEscape` = bisherige Schließfunktion
  (Passwort: nicht bei Pflichtwechsel oder während des Speicherns). Benutzerverwaltung → Passwort: Escape schließt
  nur das Passwortfenster.
- **TTS-Anbieterwahl** (`admin-tasks.js`): ohne `onEscape`, der Stapel schließt; das `close`-Ereignis bricht ab.
- **Artikeleditor und Linkdialog** (gebündelt, `npm run build:editor`): Escape fragt bei ungespeicherten Änderungen
  nach; Strg/Cmd+Enter speichert über einen Capture-Listener am Editor-Dialog (vor CodeMirror). Der Linkdialog meldet
  sich am Stapel an, wenn es ihn gibt (sonst nativ, z. B. im Dubletten-Werkzeug).
- **Neue Infografik, Infografik-Manager, Extras-Verwaltung:** Escape schließt zuerst Vorschau bzw. Markdown-Editor
  im Dialog (`igmEscape`, `bemTryClose`), dann den Dialog. Strg+Enter in „Neue Infografik“ hängt am Dialog selbst.
- **Dubletten (Liste, Prüfansicht, Bildbetrachter):** `closeTopDuplicateDialog`, `topDuplicateDialog`, der
  Capture-Handler und die `cancel`-Sperre entfallen. Die Pfeiltasten im Bildbetrachter bleiben am Element.
- **Datei-Abbruch:** Das bubbelnde `cancel` eines Dateifelds schließt keinen Dialog; der Stapel wertet nur das
  `cancel` des Dialogs selbst aus (vorher je Dialog von Hand geprüft).
- Verbleibende `document`-Tastenhandler: `aria-menu.js` und die Leertaste in `infographic-review.js` (Schritt 6).

**Geprüft:** Node 453/453, Python 14/14 (Tests prüfen jetzt die Anmeldung am Stapel und das Fehlen eigener
`cancel`-/`keydown`-Handler). Im Browser als Admin, mit echter Escape-Taste: Einstellungen, TTS-Einstellungen,
Neue Infografik schließen; Benutzerverwaltung → Passwort → Benutzerverwaltung → zu; Artikel → Editor → Linkdialog:
Escape schließt Link, dann (geändert, Rückfrage abgelehnt) bleibt der Editor offen, mit Bestätigung zu, Fokus zurück
auf „Aktionen“, Artikel bleibt offen; Artikel → Infografik-Manager → Vorschau: je eine Ebene, zuletzt zurück zur Liste
(`#/`); Dubletten → Prüfansicht → Bild: Pfeil blättert, je eine Ebene, Seitensperre danach aufgehoben; Extras →
Neuer Text: erst Editor, dann Dialog. Keine Konsolenfehler. Am iPhone nicht geprüft.

**Deployment:** `public/settings.js`, `password.js`, `user-admin.js`, `tts-settings.js`, `admin-tasks.js`,
`infographic-new.js`, `infographic-manager.js`, `duplicates.js`, `vendor/article-editor.bundle.js` kopieren;
Browser neu laden.

**Nachtrag (iPhone-Rückmeldung):**
- **Kennwortfenster schob beim Wischen die Seite dahinter.** Das Fenster passt auf den Bildschirm, scrollt also
  nicht; `overscroll-behavior` wirkt nur an echten Scrollbereichen, und `html.modal-open` hält Safari nicht auf.
  **Behoben zentral in `layer-stack.js`:** Kann eine Wischgeste in der obersten Ebene nichts scrollen (kein Element
  vom Ziel bis zum Dialog mit `overflow: auto/scroll` und Überlauf), wird `touchmove` abgefangen. Einmal je Geste
  entschieden; frei bleiben zwei Finger (Zoomen), vergrößerte Ansicht (Ausschnitt verschieben) und Schieberegler.
  Gilt damit für alle kleinen Fenster (Einstellungen, Anbieterwahl, …), nicht nur für das Kennwortfenster.
- **Dublettenkopf erschien nach Schwung-Scrollen von selbst.** iOS meldet beim Nachfedern am Listenende
  `scrollTop`-Werte über das Ende hinaus; das Zurückfedern sah aus wie Hochscrollen. **Behoben:** Die Position wird
  vor dem Vergleich auf 0 … Maximum begrenzt (`updateDuplicateChromeOnScroll`).
- **Geprüft:** Node 455/455, Python 14/14 (neuer Verhaltenstest für die Wischsperre). Im Browser (Handy-Größe,
  künstliche Touch-Ereignisse): Wischen im Kennwort- und Einstellungsfenster wird abgefangen, im Artikel und in der
  Grundansicht nicht. Das Nachfedern selbst lässt sich nur am iPhone prüfen.
- **Infografik-Manager zeigte Grafiken in einer Vorschau im Dialog** (Kasten mit „← Zurück“), Wischen nach unten
  schloss den ganzen Manager. Die Extras der Hörbücher öffnen Bilder dagegen im gemeinsamen Vollbild. **Jetzt
  einheitlich:** Ein Tipp auf die Grafik öffnet `openGalleryFullscreen` mit allen Grafiken des Artikels (begrenzt,
  also ohne Sprung zum Nachbarartikel; blättern, zoomen, herunterladen). Escape oder Wischen nach unten führt zurück
  in den Manager, der Fokus auf die angetippte Grafik. Die Vorschau-Fläche (`data-igm-preview`), `igmOpenPreview`,
  `igmClosePreview` und `igmEscape` entfallen; Escape im Manager schließt ihn (`igmClose`).
  **Geprüft:** Node 456/456, Python 14/14. Im Browser als Admin (Handy-Größe): Vollbild liegt über dem Manager,
  ← blättert bis zur ersten Grafik und bleibt dort, Escape und Wischen nach unten (künstliche Touch-Ereignisse)
  führen in den Manager zurück, danach schließt „×“ den Manager, der Artikel bleibt offen. Keine Konsolenfehler.
  **Deployment zusätzlich:** `public/layer-stack.js`, `public/css/account.css`, `public/index.html`.

## 50. Aktualisierung 30.10.2026 – Dialog „Audio erzeugen“ kompakter

Auf dem iPhone musste man im Anbieterdialog scrollen. **Geändert:** Die Statuszeilen je Anbieter
(`#tts-provider-status`, z. B. „Qwen-TTS: …“, „OpenAI API: …“) entfallen; die Verfügbarkeit zeigen die
Auswahlfelder selbst („– nicht verfügbar“, gesperrt). Weniger Abstand zwischen „Audio erzeugen“ und dem Titel
(8 px statt 44 px), der Titel ist fett.

**Geprüft:** Node 457/457, Python 14/14 (neuer Test: keine Statuszeile, Abstand, Fettschrift). Im Browser in
iPhone-Größe (375 × 812) mit langem Titel und zwei Anbietern: Dialog 478 px hoch, kein Scrollen.

**Deployment:** `public/index.html`, `public/admin-tasks.js`, `public/css/dialogs.css` kopieren; Browser neu laden.

## 51. Aktualisierung 30.10.2026 – Kein Fokusrahmen auf der Kachel nach dem Schließen eines Artikels

**Symptom:** Nach dem Zurückkehren aus einem Artikel war die geöffnete Kachel blau umrandet, ohne Nutzen (die
Pfeiltasten blättern Seiten). **Ursache:** Seit die Artikelansicht ein modaler `<dialog>` ist, gibt der Browser beim
Schließen den Fokus an das Element zurück, das ihn beim Öffnen hatte – die Kachel (`tabindex="0"`); nach Escape
zeigt er dazu den Fokusrahmen. **Behoben:** `hideArticleLayer` nimmt den Fokus wieder weg, wenn er in der Übersicht
(`#app`) gelandet ist. Andere Ziele (Suchfeld, Menü-Knopf) behalten ihn; Tab geht von der Kachel aus weiter.

**Geprüft:** Node 458/458, Python 14/14 (neuer Test). Im Browser: Kachel per Tastatur geöffnet, mit Escape
geschlossen → Fokus auf `body`, kein Rahmen; → blättert die Seite, Tab springt wieder in die Kacheln.

**Deployment:** `public/app-detail.js` kopieren; Browser neu laden.

## 52. Aktualisierung 30.10.2026 – Ebenen-Stapel, Schritt 6: Aufräumen und Regeln (Abschluss von Review-Idee 3.2)

- **Leertaste im Prüfmodus „Infografiken prüfen“:** kein eigener `document`-Tastenhandler mehr. Die Funktion
  `infographicReviewFullscreenKey` hängt über den Platzhalter `infographicReview.fullscreenKey` in der Tastatur der
  Bildvollansicht (`fullscreenLayerKey`, onKey am Stapel) und wird dort zuerst gefragt.
- **DOM-Abfragen durch den Stapel ersetzt:** `layerAboveContentOpen` entfällt (der Stapel ruft die Grundansicht nur
  ohne offene Ebene auf), ebenso `dialogOpen` beim Herunterziehen des Artikels (liegt der Artikel oben, liegt nichts
  darüber). Die übrigen Pull-Dialoge (`PULL_DIALOGS`) starten nur, wenn ihr Dialog die oberste Ebene ist.
  Bewusst geblieben: `syncModalPageScroll` (Seitensperre, folgt `dialog[open]` samt MutationObserver),
  `navigationChromeMustStayVisible` und der Update-Hinweis in `pwa-update.js` (beide unterscheiden
  App-Ebenen von Fenstern per `:not(.app-layer)`).
- **Regeltest `test/layer-rules.test.cjs`:** In `public/*.js` gibt es Tastenhandler an `document`/`window` und
  `stopImmediatePropagation` nur in `aria-menu.js` (schließt offene Menüs zuerst), `showModal()` nur im Stapel und im
  Rückfall des Linkdialogs (Dubletten-Werkzeug ohne Stapel), `cancel`-Listener nur im Stapel.
- **Spike-Branch `spike/dialog-ebenen` gelöscht** (nur lokal; Spitze war `eec9436`, Spike-Commit `c025d72`). Sein
  Dubletten-Commit ist inhaltsgleich mit `8926ee3` auf main, der Spike ist durch die Schritte 1–5 ersetzt.
- CLAUDE.md: Abschnitt „Layers“ beschreibt den fertigen Stand samt Regeln.

**Geprüft:** Node 461/461, Python 14/14 (Leertaste jetzt als Verhaltenstest, neuer Regeltest). Im Browser als Admin
(Handy-Größe): Ziehen am Artikel unter den Einstellungen tut nichts, Ziehen an den Einstellungen schließt nur sie,
danach schließt Ziehen den Artikel (`#/`). Prüfmodus: Kachel antippen → Vollbild, Leertaste setzt und entfernt die
Poster-Markierung, Escape schließt das Vollbild. Keine Konsolenfehler.

**Deployment:** `public/app.js`, `public/app-gallery.js`, `public/infographic-review.js` kopieren; Browser neu laden.

## 53. Aktualisierung 30.10.2026 – CSP im Betrieb scharf geschaltet (Review-Punkt 2.8)

Auf dem LXC steht in `/etc/nodeapp/webarchiv.env` jetzt `CSP_MODE=enforce` (vorher `report`); Dienst neu gestartet.
Der Browser blockiert damit Verstöße, statt sie nur zu melden.

**Geprüft auf dem LXC:**
- `curl -sI http://localhost:3000/ | grep -i content-security-policy` zeigt `Content-Security-Policy:` (ohne
  `-Report-Only`) mit Nonce, `report-uri /api/csp-report`.
- Durchgeklickt: Artikel mit PDF, Video und Audio, Hörbuch, Editor als Admin. Danach enthält
  `journalctl -u nodeapp | grep -i csp` keine Meldung „CSP-Verstoß“ – auch keine aus der Zeit im `report`-Modus.

**Falls später etwas nicht lädt:** Grund steht im Journal („CSP-Verstoß: <Richtlinie> blockiert <Adresse> auf <Seite>“);
die Richtlinie liegt in `security-headers.cjs`. Rückweg: `CSP_MODE=report`, `sudo systemctl restart nodeapp`.

**Doku nachgezogen:** `LXC-container node.js Setup.md` (Env-Datei mit `enforce`, Prüf- und Rückweg), `README.md`,
`CLAUDE.md`/`AGENTS.md` (Produktion läuft mit `enforce`), `code-review_2026-01-28.md` (2.8 und 3.2 als erledigt).
Damit sind alle Punkte aus Teil 2 des Reviews umgesetzt.
