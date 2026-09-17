# TTS in WebArchiv – Umsetzung, Betrieb und spätere Qwen3-TTS-Anbindung

**Aktuell: freie Auswahl verfügbarer Anbieter.** WebArchiv prüft vor jeder
Generierung den authentifizierten Qwen-v4-Healthcheck (3 s) und das Vorhandensein
des OpenAI-Schlüssels, unabhängig vom CLI-Standard. Ein Dialog zeigt beide
Anbieter mit Status; nicht verfügbare Einträge sind gesperrt. Ohne Vorauswahl
wählt der Benutzer den Anbieter, liest dessen Übertragungs-/Kostenhinweis und
bestätigt mit „Audio-Generierung starten“. Der Start prüft die Verfügbarkeit
erneut. Der Worker bleibt an die Auswahl gebunden, ohne späteren Fallback.
32 Node-Tests mit simulierten Antworten; keine echten API-Aufrufe.
Ältere Aussagen zur automatischen oder statischen Providerwahl sind überholt.

**Aktueller Nachtrag: vollständige Qwen-Verarbeitung (v4).** Auf ausdrücklichen
Benutzerwunsch erhält Qwen wieder die unveränderte Markdown-Datei und liefert
immer die fertige MP3. Der Worker führt den regulären CLI-Einstieg von
`generate_mp3_with_embedding.py` mit dessen eigener Konfiguration aus. Sämtliche
Markdown-Bereinigung, Chunking-, Kalibrierungs-, Seed- und Exportlogik kommt aus
diesem Script; die folgenden v2-/v3-Notizen sind historische Zwischenstände.
WebArchiv prüft die MP3 und veröffentlicht sie bytegleich, ohne erneute Kodierung.
Aktueller Vertrag und Update: [QWEN-ANBINDUNG.md](QWEN-ANBINDUNG.md).

**Weiterer Nachtrag vom 17.09.2026:** `webarchiv-qwen-v3` hält Modell und Sprecher
für alle Chunks eines Artikels in einem GPU-Worker. Gesamtanzahl und Sitzungs-ID
werden im ersten Aufruf angekündigt. Seed und Konfiguration bleiben pro Sitzung
identisch; Warmup erfolgt einmal. Polling erzeugt keine wiederholten Logzeilen,
und die Anzeige erhält ihre Scrollposition. Beide Python-Dateien auf dem
Modellrechner und die WebArchiv-Dateien müssen gemeinsam aktualisiert werden.
Details: [QWEN-ANBINDUNG.md](QWEN-ANBINDUNG.md).

**Nachtrag vom 17.09.2026:** Qwen-HTTP nutzt jetzt `node:http`/`node:https`
statt des von einem Parser-Absturz betroffenen Undici. Chunking, Kalibrierung,
Vorspann-Schnitt und Zusammenfügen erfolgen auf Wunsch des Benutzers in WebArchiv.
Die neue HTTP-Brücke benötigt zusätzlich `qwen_chunk_worker.py` und liefert pro
Anfrage einen PCM-WAV-Chunk (`webarchiv-qwen-v2`). Update-Anleitung und Prüfungen:
[QWEN-ANBINDUNG.md](QWEN-ANBINDUNG.md).

**Nachtrag vom 16.09.2026:** Die Qwen-Anbindung ist inzwischen im lokalen Code
implementiert, einschließlich einer auf Benutzerwunsch mitgelieferten HTTP-Brücke
für das geprüfte CLI-Script. Aktueller Vertrag, Konfiguration, Tests und offene
Inbetriebnahme stehen in [QWEN-ANBINDUNG.md](QWEN-ANBINDUNG.md).
`tts.provider` ist jetzt `qwen`; Serveradresse und Token müssen vor dem Betrieb
gesetzt werden. Die folgenden Abschnitte dokumentieren den Stand **vor** dieser
Erweiterung. Insbesondere Abschnitt 10 ist ein historischer Entwurf.

Stand: 16.09.2026. Dieses Dokument fasst die Arbeit und Erkenntnisse aus der
Integrationssitzung zusammen und gleicht sie mit dem aktuellen lokalen Code ab.
Es beschreibt den heutigen Zustand; der Qwen3-TTS-Teil ist ein noch nicht
implementierter Entwurf. Es wurden durch den Assistenten keine kostenpflichtigen
TTS-Aufrufe gestartet.

## 1. Herkunft und Ziel

Ausgangspunkt war das eigenständige, bereits vorbereitete Node-Paket unter:

```text
E:\Code\GPT-4o-Mini-TTS-helper\src\markdown_tts_compact\node
```

Der zunächst genannte Pfad mit `markdown\_tts\_compact` existierte nicht.
Vor der Umsetzung wurde die dortige `INTEGRATION.md` gelesen, anschließend die
Projektregeln, Server, Frontend und Scraper-Anbindung geprüft.

Übernommen wurden `markdown_tts.js`, `spawn_tts.cjs`, `config.json`,
`package.json`, `package-lock.json`, `markdown_tts.test.js` und `INTEGRATION.md`
nach `WebArchiv/tts/`. Die Root-Anwendung bleibt CommonJS; das Unterpaket ist
über seine eigene `package.json` ein ES-Modul-Paket. Kein Python zur Laufzeit.

Das Ziel: Ein Admin kann einen ausgewählten Markdown-Artikel vertonen, den
Fortschritt verfolgen und das Ergebnis im bestehenden Audio-Player anhören.
Der Auftrag läuft unabhängig von der Lebensdauer eines HTTP-Requests und des
Popups. Vor jedem neuen Start muss der Benutzer ausdrücklich bestätigen.

## 2. Dateien und Verantwortlichkeiten

| Datei | Aufgabe |
| --- | --- |
| `server.js` | Verdrahtet TTS mit Artikelindex, Autorenrechten, Audio-URLs und Sperren anderer Schreibvorgänge; Shutdown-Behandlung |
| `tts/jobs.cjs` | Aufträge, Endpunkte, Pfadprüfung, Startreservierung, Status, Abbruch, Ergebnisprüfung und Reindex |
| `tts/spawn_tts.cjs` | Getesteter CommonJS-Adapter: Child-Spawn, stdout/stderr zeilenweise lesen, Exit abwarten, IPC-Abbruch |
| `tts/markdown_tts.js` | Markdown-Sprechtext, Chunking, OpenAI-Anfragen, Audioverarbeitung, CLI und atomare Veröffentlichung |
| `tts/config.json` | Modell, Stimme, Sprechstil, Parser, Chunking, FFmpeg, Cache und Zeitlimits; keine Schlüsselwerte |
| `tts/markdown_tts.test.js` | Offline-Tests des Workers, der Audioverarbeitung und des Spawn-Adapters |
| `tts/jobs.test.cjs` | Test der neuen Audio-Spiegelstruktur und des Schutzes bereits vorhandener MP3s |
| `public/app.js` | Artikelaktionen, native Bestätigung, TTS-Popup-Steuerung, Polling und Aktualisierung der Artikelansicht |
| `public/index.html` | TTS-Overlay mit Status, Log, Abbruch, Statusaktualisierung, Reindex und MP3-Link |
| `public/styles.css` | Vorhandenen Scrape-Popup-Stil wiederverwenden; Artikel-Aktionsmenü und TTS-Bedienelemente |
| `.gitignore` | TTS-Abhängigkeiten, Cache, Testverzeichnisse, Sperrdateien und temporäre Audiodateien ausschließen |

Orientierung im zum Dokumentationszeitpunkt vorhandenen Graphen:
`createTtsJobs`: `tts/jobs.cjs:7–148`, `startTts`: `tts/spawn_tts.cjs:6–53`,
`synthesize`: `tts/markdown_tts.js:190–232`, `watchTts`: `public/app.js:1222–1275`.
Zeilen können sich verschieben; vor weiteren Änderungen `graft ask ... --source`
oder `graft callers <Symbol>` verwenden.

## 3. Ablauf und Schnittstellen

1. Admin wählt im Artikel unter „Aktionen“ den Eintrag „Audio erzeugen“.
2. Ein nativer `confirm()`-Dialog nennt den Titel, die kostenpflichtige
   Sprachgenerierung und die Übertragung des Markdown-Textes an OpenAI.
   Das ist derselbe Dialogmechanismus wie „Archiv neu einlesen“.
3. Bei Ablehnung erfolgt kein Start-POST. Bei Zustimmung wird der Startbutton
   während der Anfrage gesperrt.
4. Der Server löst ausschließlich die Artikel-ID auf, prüft Rechte und reserviert
   synchron den einzigen TTS-Startplatz vor dem ersten `await`.
5. Eingabe- und Zielpfade werden serverseitig bestimmt. Der Worker startet über
   `process.execPath`, ohne Shell, mit getrennten Argumenten.
6. Der Start-Endpunkt antwortet mit HTTP 202 und Job-ID. Der Worker läuft weiter.
7. Das Popup pollt den Status, zeigt CLI-Meldungen und Chunk-Nummern an.
8. Erst nach Prozessende und gültigem Ergebnis wird reindexiert. Die
   Artikelansicht wird nach erfolgreicher Synthese neu geladen.

| Route | Vertrag |
| --- | --- |
| `POST /api/tts` | JSON `{ "articleId": "…" }`; Antwort 202 `{ "jobId": "…" }` |
| `GET /api/tts/latest` | Neuester für den Admin zugänglicher Auftrag, auch nach Browser-Reload; kann bereits beendet sein |
| `GET /api/tts/:jobId/status` | Status einschließlich begrenztem Log und Ergebnis-URL |
| `POST /api/tts/:jobId/cancel` | Kooperativen Abbruch anfordern; Antwort 202 |

Alle Routen sind Admin-geschützt. Start, Status und Abbruch prüfen zusätzlich
die Autorenrechte; `latest` filtert nach zugänglichen Artikeln. Browserparameter
bestimmen keine Dateisystempfade, API-Schlüssel oder ausführbaren Programme.
Die vorhandene Session-Authentifizierung wird verwendet.

Statusfelder: `id`, `articleId`, `title`, `status`, `done`, `startedAt`,
`finishedAt`, `current`, `total`, `output`, `error`, `indexError`, `exitCode`,
`audioUrl`. Prozessobjekte werden nicht serialisiert. Zustände:
`starting`, `running`, `cancelling`, `indexing`, `succeeded`, `failed`, `cancelled`.
Logs sind auf die letzten 20.000 Zeichen begrenzt und werden als Text gerendert.

## 4. Speicherort – wichtige Änderung gegenüber der ursprünglichen Anleitung

Anfangs wurde wie beauftragt neben der Markdown-Datei geschrieben. Danach hat
der Benutzer die parallele Ablage unter `audio/` vorgegeben. Die lokale Struktur
wurde geprüft; beispielsweise existieren MP3s unter `audio/Coaching/2026/`.

**Der aktuelle Zielpfad ist:**

```text
Eingabe: www/<Autor>/<weitere Unterordner>/<Dateiname>.md
Ausgabe: audio/<Autor>/<weitere Unterordner>/<Dateiname>.mp3
```

`createTtsJobs` erhält `root: WWW_DIR` und `audioRoot: AUDIO_DIR`. Der relative
Pfad zur Markdown-Datei wird gespiegelt; fehlende Zielordner werden angelegt.
Die Quelle wird per `realpath` gegen Archiv und Autor geprüft. Die Unterordner
des Audioziels werden einzeln geprüft; Symlinks/Junctions dort werden abgelehnt.
Das aufgelöste Audio-Wurzelverzeichnis kann auf einem eigenen Datenträger liegen.

Bereits vorhandene gleichnamige MP3s werden sowohl im alten `www/`-Verzeichnis
als auch am neuen Audioziel erkannt, auch bei abweichender Groß-/Kleinschreibung.
Es findet keine automatische Überschreibung oder Migration statt.

Der Index konnte die externe Audioablage bereits vor dieser Anpassung lesen.
Er bevorzugt weiterhin eine vorhandene lokale MP3 unter `www/`, andernfalls
die passende Datei unter `audio/`. Externe Dateien werden über die bestehende
Route `/audio-files/...` bereitgestellt. Die TTS-Ergebnis-URL nutzt diese Route
mit mtime-Cachebuster; das Popup akzeptiert sie zusätzlich zu alten `/files/`-URLs.

Die ursprüngliche `tts/INTEGRATION.md` ist als Übergabe des Lieferpakets erhalten.
Ihre Aussagen „neben der Markdown-Datei“ sind für die heutige WebArchiv-Anbindung
überholt. Maßgeblich sind dieses Dokument und der aktuelle Code.

## 5. Worker-Vertrag und Erfolgskriterien

```text
node markdown_tts.js <absoluter Markdown-Pfad> --output <absoluter MP3-Pfad> --json-progress
```

Optional: `--config <absoluter Konfigurationspfad>`. Standardmäßig wird die
Konfiguration neben dem Worker verwendet.

stdout liefert genau ein Ergebnisobjekt, zum Beispiel:

```json
{"outputPath":"/opt/nodeapp/audio/Autor/2026/Artikel.mp3","chunks":2,"characters":4930}
```

stderr liefert NDJSON-Fortschritt mit `type`, `message`, optional `time`,
`current`, `total` und weiteren Feldern. Typen umfassen `start`, `calibration`,
`synthesis`, `trim`, `encoding`, `retry`, `warning`, `diagnostic`, `complete`, `error`.
Der Adapter verwendet `readline`, weil Pipe-Datenpakete keine Zeilengrenzen garantieren.

`complete` allein bedeutet noch keinen Erfolg. Der Adapter wartet auf `close`,
Exit-Code 0 und ein gültiges Ergebnis mit passendem Ausgabepfad und mindestens
einem Chunk. Der Jobmanager prüft zusätzlich, dass das Ziel eine reguläre,
nicht leere Datei ist. Das ist keine allgemeine Codecprüfung: Im langen
Workerpfad prüft FFprobe Codec und Dauer; der kurze Pfad prüft die vollständige
API-Antwort und nicht leere Ausgabe.

Exit-Codes: 0 Erfolg, 1 Verarbeitungsfehler, 2 Argument-/Konfigurationsfehler,
130 kooperativer Abbruch. Startfehler und Signale können ohne numerischen
Exit-Code enden.

Ein Reindex-Fehler setzt `indexError`, lässt aber `status: succeeded` und die
fertige MP3 bestehen. Die UI bietet „Archiv neu einlesen“ an. **Niemals wegen
eines Index- oder Anzeigeproblems erneut synthetisieren.**

## 6. Parallelität, Abbruch und Lebensdauer

- Ein aktiver WebArchiv-TTS-Auftrag insgesamt. Parallele Startanfragen werden
  durch die Reservierung vor dem ersten asynchronen Dateizugriff abgefangen.
- TTS berücksichtigt Scrape, Reindex, Infografik-Schreibvorgänge und inzwischen
  auch den Markdown-Editor. Die Serveranbindung berücksichtigt die TTS-Sperre
  ebenfalls bei konkurrierenden Vorgängen.
- Zusätzlich reserviert der Worker `<output>.tts-lock`, bevor er synthetisiert.
  Veröffentlichung per Hardlink erfolgt atomar ohne Überschreiben. Das
  Ziel-Dateisystem muss Hardlinks unterstützen.
- Popup schließen, Escape oder Backdrop beenden nur die Anzeige und deren
  Polling. „Auftrag abbrechen“ ist eine getrennte Serveraktion.
- Der Adapter sendet IPC `{ "type": "cancel" }`; nach zehn Sekunden folgt ein
  harter Kill als Rückfall. Worker und FFmpeg sollen kooperativ aufräumen.
- Bei Server-Shutdown wird der aktive Worker zum Abbruch aufgefordert und auf
  dessen Abschluss gewartet. Ein bereits veröffentlichter Erfolg wird nicht
  nachträglich gelöscht.
- Jobs liegen nur im Arbeitsspeicher. Browser-Reload ist abgedeckt, ein
  Serverneustart stellt den Jobverlauf nicht wieder her. Alte abgeschlossene
  Jobs werden nach 24 Stunden bzw. bei Überschreitung der Größenbegrenzung bereinigt.
- `.markdown-tts-*` liegt neben dem Ausgabeziel. Fehlerartefakte bleiben bei
  `keep_failed_work: true` zur Diagnose erhalten. Harte Abbrüche können auch
  Sperrdateien zurücklassen: laufende Prozesse prüfen, keine aktive Sperre löschen.

## 7. Oberfläche und nachträgliche Korrekturen

Das TTS-Popup verwendet den Stil des Scrape-Popups, aber eigene IDs und Zustände.
Es zeigt Artikeltitel, Aktivität, Logs, Chunk-Stand, Fehler und MP3-Link. Die
Polling-Schleife wartet zwischen Anfragen eine Sekunde, überlappt Anfragen nicht
und stoppt nach drei aufeinanderfolgenden Verbindungsfehlern. Statusaktualisierung
oder Wiederöffnen nimmt die Abfrage wieder auf, ohne eine Synthese zu starten.
Fokuswechsel, Tab-Begrenzung und Escape-Behandlung wurden ergänzt.

Die Job-ID wird in `sessionStorage` gespeichert; die Wiederanzeige fragt aktuell
`/api/tts/latest` ab. Das ist keine persistente serverseitige Auftragsablage.

Benutzerfeedback während der Integration:

1. Dropdown ragte links aus dem Bildschirm: Breitenbegrenzung und Positionsprüfung ergänzt.
2. Dropdown erschien danach zu weit rechts: Basisposition auf `left: 0` unter
   dem Aktionsbutton geändert; nur bei Randüberschreitung verschieben.
3. Dropdown ließ sich nur per Button schließen: Dokument-Klickhandler ergänzt,
   der offene Artikel-Aktionsmenüs bei Klick außerhalb schließt.

Diese Menüänderungen wurden damals syntaktisch geprüft. Eine vollständige
Browser-Abnahme wurde in der Sitzung nicht protokolliert. Insbesondere
Wiederöffnen nach Größenänderung und Randpositionen sollten erneut visuell
geprüft werden; der damalige Korrekturcode setzt Inline-Offsets.
Bei Frontendänderungen die Versionsparameter in `public/index.html` erhöhen.

## 8. Debian-Betrieb und tatsächlich aufgetretene Fehler

Die vom Benutzer gezeigte systemd-Unit verwendet:

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

In `/etc/nodeapp/tts.env` steht ausschließlich serverseitig beispielsweise:

```ini
OPENAI_API_KEY=<geheimer Schlüssel ohne Platzhalter übernehmen>
```

Die Datei mit Root-Eigentümer und Modus 600 schützen; systemd liest sie für den
Dienst ein. Vorhandene Schlüsseldateien bearbeiten, nicht mit `install /dev/null`
erneut überschreiben. Der aktuelle lokale Konfigurationswert ist bereits
`tts.api_key_environment_variable: OPENAI_API_KEY`. Ursprünglich verwendete das
Lieferpaket `GPT-4o-Mini-TTS-Key`; dieser Name wurde für systemd ersetzt.
Ein Shell-Export allein verändert keinen bereits gestarteten Dienst.

Nach Änderungen an der Unit `sudo systemctl daemon-reload`, nach Änderungen an
Schlüssel, Backend oder Worker `sudo systemctl restart nodeapp` ausführen,
wenn kein wichtiger Auftrag läuft. Status: `sudo systemctl status nodeapp`.
Keinen Schlüssel in Logs, Git, Browser, CLI-Argumenten oder Chat ausgeben.

Gemeldeter Betriebsfehler:

```text
ffmpeg fehlgeschlagen: spawn ffmpeg ENOENT
```

Ursache: FFmpeg war für den Dienst nicht auffindbar. Empfohlen wurden
`sudo apt-get update`, `sudo apt-get install ffmpeg` und die Prüfung beider
Programme mit `command -v ffmpeg`, `command -v ffprobe` und `-version`.
Optional absolute Pfade `/usr/bin/ffmpeg` und `/usr/bin/ffprobe` konfigurieren.
Bei diesem Preflight-Fehler prüft der Worker die Werkzeuge vor der Synthese;
aus dem Fehler allein folgt also kein bereits getätigter API-Aufruf.
Die erfolgreiche Behebung auf Debian wurde in diesem Verlauf nicht nachgewiesen.

Weitere Voraussetzungen: Node.js ab 22, eigene TTS-Abhängigkeiten mit
`npm ci --prefix tts --omit=dev --ignore-scripts`, Schreibrechte für `ralf` auf
`audio/` und dem Cache. Relative Cachepfade beziehen sich auf die Konfigurationsdatei.

Aktuelle lokale Konfiguration am 16.09.2026:

| Einstellung | Wert |
| --- | --- |
| Modell | `gpt-4o-mini-tts-2025-12-15` |
| Stimme / Geschwindigkeit | `cedar` / `1.0` |
| Zeichenbudget | 3800 Unicode-Codepoints |
| API-Zeitlimit / Wiederholungen | 120 Sekunden / maximal 2 |
| FFmpeg-Zeitlimit / Gesamtzeitlimit | 300 / 1800 Sekunden |
| FFmpeg-Bitrate | `64k` (Lieferpaket ursprünglich `128k`) |
| Cache / Fehlerartefakte | `.cache` / behalten |

Die Bitrate steuert den FFmpeg-Export langer Texte, nicht automatisch die
direkt vom Anbieter gelieferte MP3 kurzer Texte.

## 9. Testnachweise und offene Abnahme

Tatsächlich im Verlauf ausgeführt:

- Syntaxprüfungen mit `node --check` für Server, Frontend und Auftragsmodul.
- `npm test --prefix tts`: damals **13 Worker-/Adaptertests bestanden**.
  Simulierte API-Antworten, aber echte lokale FFmpeg-/FFprobe- und Child-Prozesse.
  Abgedeckt: CLI, Markdown, Unicode, SSE-Paketgrenzen und `[DONE]`, WAV-Schnitt,
  kurzer und langer Pfad, Pre-Fill/Cache, belegtes Ziel, konkurrierender Zugriff,
  Abbruch, Tool-Zeitlimit, fehlendes Programm und Spawn-Abschluss.
- `node --test --test-isolation=none tts/jobs.test.cjs`: **ein zusätzlicher
  Test bestanden** nach Umstellung auf `audio/`. Er prüft verschachtelte
  Spiegelpfade, MP3-Link, keine Ausgabe unter `www/` und Startverweigerung bei
  vorhandener MP3 an beiden Ablageorten. Der Worker ist dabei simuliert;
  die Testdatei enthält Platzhalterdaten und ist kein Audio-Qualitätstest.
- Abhängigkeiten wurden installiert. Offline-Installation scheiterte zuerst
  an fehlenden Cachepaketen; Installation gelang anschließend. Windows-Sandbox
  blockierte zunächst Child-Spawn (`EPERM`); Worker-Tests liefen mit freigegebener
  Ausführung außerhalb der Sandbox.

Diese Nachweise stammen aus der Integrationsarbeit, nicht aus einer erneuten
Testausführung am Dokumentationsdatum. Kein vom Assistenten ausgeführter Live-Test
gegen OpenAI, kein Hörtest und keine bestätigte vollständige Browser-Abnahme.
Angekündigte Tests dürfen nicht mit tatsächlich ausgeführten Tests verwechselt werden.

Vor einer weiteren Migration gezielt nachholen:

- Bestätigung und Ablehnung im Browser; Ablehnung muss null Startrequests ergeben.
- Live-Log, Popup schließen/wiederöffnen, Browser-Reload und Netzunterbrechung.
- Admin-/Autorenrechte aller Endpunkte; parallele HTTP-Starts und Konflikte mit
  Scrape, Reindex und Editor.
- Reindex-Fehler nach fertiger MP3 ohne erneute Synthese; Fehler beim Aktualisieren
  der Artikelansicht; vorhandene MP3 und verwaiste Sperre.
- Abbruch während Anfrage, Audioverarbeitung und kurz vor Veröffentlichung.
- Symlink-/Pfadgrenzen und fehlende Schreibrechte auf dem Audioziel.
- Bestehenden Player, Scraper und „Archiv neu einlesen“ praktisch prüfen.

## 10. Späteres Ziel: Qwen3-TTS auf einem anderen lokalen Server

Noch nicht implementiert. Adresse, Port, Modellvariante, Serving-Software,
Authentifizierung, Stimmen und API-Vertrag wurden nicht festgelegt oder geprüft.
Es wird insbesondere **keine OpenAI-kompatible API vorausgesetzt**.

### Was unverändert bleiben sollte

WebArchiv behält Artikel-ID, Rechteprüfung, Bestätigungsdialog, Job-Endpunkte,
Spawn-Adapter, Fortschrittsvertrag, Abbruchbedienung, Audio-Spiegelpfad und
Erfolg/Reindex-Trennung bei. Ein Node-Worker auf dem WebArchiv-Server kontaktiert
den anderen Server per HTTP und speichert zurückgeliefertes Audio selbst.
Der Modellserver braucht dadurch keinen Zugriff auf das Archiv-Dateisystem.

### Geeignete Umbaupunkte

`synthesize(text, file, config, signal, emit, fetchImpl)` in
`markdown_tts.js:190–232` enthält die OpenAI-spezifische Kopplung:

- Fest eingebaute URL `https://api.openai.com/v1/audio/speech`.
- Bearer-Schlüssel aus der konfigurierten Umgebungsvariable.
- Payload `model`, `voice`, `instructions`, `speed`, `input`, `response_format`,
  `stream_format: sse`.
- SSE-Ereignisse `speech.audio.delta` mit Base64 und verpflichtendes
  `speech.audio.done` als Abschluss.

Die Funktion `convert` lässt bereits eine Synthesefunktion `synth` injizieren
(bisher für Offline-Tests). Das ist ein geeigneter Ansatz für einen
Provider-Adapter. Ein bloßer Austausch der URL reicht nicht: Konfigurationsprüfung,
API-Key-Preflight in `convert`, Antwortformat und Audioannahmen müssen mitgeändert werden.

Vorgeschlagene neue, noch nicht vorhandene Konfiguration: `provider`,
`base_url`, anbieterspezifische Modell-/Stimmeneinstellungen und optionaler
Name einer Authentifizierungsvariable. Alle Werte serverseitig festlegen.
OpenAI zunächst als explizite Alternative behalten, aber **kein automatischer
kostenpflichtiger Fallback**, wenn der lokale Server ausfällt.

### Vor der Implementierung am Modellserver klären

1. Tatsächlicher Request-/Response-Vertrag: direkter Audiostream, Binärdatei,
   Base64, SSE oder asynchroner Auftrag mit Ergebnisabruf?
2. Ausgabeformate: MP3 oder WAV/PCM? Sample-Rate, Kanäle, Bittiefe und WAV-Header?
3. Deutsch, Stimme, Stilsteuerung, eventuelle Referenzaudios und deren Berechtigungen.
4. Textlimits, Parallelität, Warteschlange, Kaltstart- und Generierungszeiten.
5. Authentifizierung und Netzfreigaben; nur WebArchiv soll den Dienst erreichen müssen.
6. Stoppt ein abgebrochener HTTP-Request auch die GPU-Arbeit? Falls nicht, wird
   ein expliziter Abbruch-Endpunkt mit Remote-Job-ID benötigt.
7. Wiederholungen und Idempotenz: Bei unklarem Verbindungsabbruch nicht blind einen
   zweiten Auftrag starten. Auch lokale GPU-Arbeit sollte nicht doppelt laufen.

### Audioverarbeitung bewusst neu bewerten

Das derzeitige 3800-Zeichenbudget sowie Pre-Fill und dessen Kalibrierung stammen
aus der übernommenen OpenAI-Pipeline. Für Qwen3-TTS müssen passende Werte und die
Notwendigkeit des Vorspanns erst getestet werden. Kalibrierungsdaten verschiedener
Provider, Modelle oder Stimmen nicht vermischen; Cache entsprechend trennen.

Wenn der lokale Server ausschließlich WAV liefert, auch kurze Texte vor der
Veröffentlichung mit FFmpeg in MP3 umwandeln. Eine WAV-Datei darf nicht nur eine
`.mp3`-Endung erhalten. Für lange Texte Formatparameter vereinheitlichen,
Chunk-Übergänge prüfen und die fertige MP3 mit FFprobe validieren.

### Empfohlene Reihenfolge der Migration

1. Serververtrag dokumentieren und einen minimalen ausdrücklich freigegebenen
   lokalen Test durchführen; kein OpenAI-Aufruf als Nebenwirkung.
2. Provider-Konfiguration und Adapter mit simulierten lokalen Serverantworten
   implementieren; CLI- und Job-Verträge erhalten.
3. Chunking, Cache, Audio-Normalisierung, Abbruch und Zeitlimits anpassen.
4. Bestätigungstext providerabhängig gestalten: Beim lokalen Modell keine
   fälschliche Behauptung einer OpenAI-Übertragung oder OpenAI-API-Kosten anzeigen.
   Die Pflicht zur Bestätigung vor jeder Ausführung bleibt bestehen.
5. Obige Abnahmefälle wiederholen; zusätzlich Serverausfall, Remote-Queue,
   unvollständiges Audio, inkompatibles WAV und Remote-Abbruch testen.
6. Deutsche kurze/lange Artikel anhören: Aussprache, Pausen, ausgelassener oder
   doppelter Text, Chunk-Grenzen und Lautstärke. Erst danach Standardprovider wechseln.

## 11. Auftrag für eine spätere Sitzung

> Lies zuerst `tts/UEBERGABE-TTS.md` und die aktuellen Projektregeln. Ermittle
> über Graft die TTS-Schnittstellen und prüfe den aktuellen Code. Binde den vom
> Benutzer benannten Qwen3-TTS-Server über einen serverseitigen Provider-Adapter
> an; kläre dessen realen API-Vertrag, bevor du Kompatibilität annimmst. Erhalte
> Bestätigung, Admin-/Autorenrechte, Job-Polling, Abbruch, atomare Ausgabe nach
> `audio/<relativer www-Pfad>.mp3` und die Trennung von Synthese und Reindex.
> Teste zunächst mit simulierten Antworten. Keine kostenpflichtigen OpenAI-Aufrufe
> und kein automatischer OpenAI-Fallback ohne ausdrückliche Freigabe.
