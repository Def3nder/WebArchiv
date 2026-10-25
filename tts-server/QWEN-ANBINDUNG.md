# Qwen3-TTS: vollständiges Markdown → fertige MP3

Aktueller Vertrag: **webarchiv-qwen-v5**. Auf Benutzerwunsch übernimmt
`generate_mp3_with_embedding.py` die gesamte Artikelverarbeitung. Die frühere
Aufteilung und Kalibrierung durch WebArchiv (v2/v3) gilt für Qwen nicht mehr.

## Topologie: zwei getrennte Geräte

Diese Anbindung setzt ausdrücklich **zwei verschiedene Rechner** voraus:

| Gerät | Laufender Dienst | Zuständigkeit |
| --- | --- | --- |
| **A: WebArchiv-Server** | Node.js/Express `server.js`, üblicherweise Debian/LXC unter `/opt/nodeapp` | Browser/API, Benutzer und Rechte, Artikel, globale Stimmen-ID, fertige MP3 unter `audio/` und lokale Hörproben |
| **B: Qwen-TTS-Server** | Python `qwen_http_service.py` auf dem Modell-/GPU-Rechner | Qwen-Modell, Artikelsynthese, `extract_speaker.py`, temporäre Aufnahmen und dauerhafte `.pt`-Dateien unter `voices/` |

Der Qwen-TTS-Server auf Gerät B ist in dieser Integration kein zweiter
WebArchiv-Node.js-Prozess, sondern ein eigenständiger Python-HTTP-Dienst. Der
Browser verbindet sich ausschließlich mit Gerät A. Gerät A ruft Gerät B über
`QWEN_TTS_BASE_URL` und ein gemeinsames Bearer-Token auf; der Browser kennt
weder diese Adresse noch das Token.

Die Daten bleiben klar getrennt:

- `tts-settings.json` mit der global ausgewählten Stimmen-ID liegt nur auf Gerät A.
- Erzeugte Hörproben liegen als MP3 ausschließlich auf Gerät A im konfigurierten
  `TTS_VOICE_PREVIEW_DIR`.
- `voices/*.pt`, `voices/trash`, Modelle und temporäre Referenzaufnahmen liegen
  nur auf Gerät B.
- Das fertige MP3 wird von Gerät B per HTTP an Gerät A zurückgegeben und erst
  dort unter `audio/` veröffentlicht.
- `users.json`, Sitzungen und der Artikelbaum `www/` werden nicht auf Gerät B
  synchronisiert.

Diese Datei beschreibt Gerät B. Die getrennte Update-Anleitung für Gerät A
steht unter [`tts/DEPLOYMENT-NODE-SERVER.md`](../tts/DEPLOYMENT-NODE-SERVER.md).

## Was verarbeitet wird

### Providerwahl vor der Bestätigung

WebArchiv prüft bei jedem Klick auf „Audio erzeugen“ unabhängig vom CLI-Standard
`tts.provider` serverseitig den authentifizierten Qwen-Endpunkt `/v1/health`
und das Vorhandensein des konfigurierten OpenAI-Schlüssels.
Das Zeitlimit beträgt drei Sekunden einschließlich Antwortkörper. Nur eine
gültige v5-Antwort mit Markdown-/MP3- und Chunk-Fortschrittsunterstützung gilt
als erreichbar.
Der Dialog zeigt beide Anbieter mit Status. Nur verfügbare Anbieter sind
auswählbar; es gibt keine Vorauswahl. Für OpenAI werden Gültigkeit/Guthaben
nicht abgefragt, sondern nur das Vorhandensein des Schlüssels geprüft.
Nach der Auswahl erscheint der passende Übertragungs-/Kostenhinweis.
„Audio-Generierung starten“ bestätigt die Auswahl und startet den Auftrag.
Abbrechen oder Escape startet nichts. Ohne verfügbaren Anbieter bleibt der
Start gesperrt. `tts.provider` bleibt der Standard für direkte CLI-Aufrufe.

Beim Start-POST wird die Verfügbarkeit erneut geprüft. Ist der gewählte Provider
nicht mehr verfügbar, wird der Start abgelehnt; „Audio erzeugen“ erneut aufrufen.
Die Verfügbarkeit des anderen Providers ändert die Auswahl nicht.
Der Worker verwendet ausschließlich den bestätigten Provider. Nach Beginn eines
Auftrags gibt es keinen automatischen Wechsel zu OpenAI. Der Healthcheck prüft
den HTTP-Dienst und seinen Vertrag, nicht die spätere GPU-Synthese.
Reine Änderungen am Providerdialog erfordern nur ein Update von Gerät A und ein
Neuladen der Browserseite. Für die Stimmenverwaltung müssen zusätzlich die
beiden Python-Dateien und der Qwen-Dienst auf Gerät B auf den hier beschriebenen
v5-Stand aktualisiert werden.

Gerät A überträgt die vollständige UTF-8-Markdown-Datei, einschließlich Titel,
Metadaten, Formatierungen, Links, BOM und Zeilenumbrüchen. Es wendet weder seinen
Markdown-Parser noch Chunking, Pre-Fill, Kalibrierung oder Audioschnitt darauf an.
Das Limit beträgt 1.000.000 UTF-8-Bytes pro Artikel.

Die HTTP-Brücke auf Gerät B legt eine temporäre `input.md` an und startet den mitgelieferten
Worker. Dieser startet den regulären `__main__`-Einstieg des Originalscripts in
einem frischen, isolierten Python-Prozess, entsprechend diesem CLI-Aufruf. Damit
teilt der Generator keinen Modell-, CUDA- oder Audiozustand mit dem
HTTP-Protokoll-Worker:

```text
python generate_mp3_with_embedding.py --config <qwen_http_service_config.json> --input <input.md> --output <output.mp3> [--speaker <voices/name-1.7B.pt>]
```

Nur bei einer in WebArchiv gewählten Stimme wird `--speaker` ergänzt. Der Pfad
wird ausschließlich aus dem serverseitigen Stimmenkatalog aufgelöst und nie
vom Browser oder WebArchiv vorgegeben. Alle übrigen Optionen bleiben
unverändert. Damit bestimmt die getrennte Servicekonfiguration Markdown-Bereinigung
(`clear_markdown`), Sprache, Sprecher, Chunking-Modus/-Größen, Preroll,
Kalibrierung, Warmup, Seed-Strategie, Pausen und MP3-Export/Bitrate.
`qwen_http_service.py` legt diese Datei nicht an. Vor dem ersten Start muss die
bereits vorhandene 1:1-Kopie von `config.json` als `qwen_http_service_config.json`
neben der Originalkonfiguration liegen; die WebArchiv-UI liest und ändert nur diese Kopie.
Auch die normalen Fehler- und Exit-Codes des Scripts werden berücksichtigt.
Das Originalscript wird nicht verändert und es werden keine internen
Synthesefunktionen mehr direkt aufgerufen.

**Seed:** Die bisherige v3-Zusage eines festgehaltenen Seeds ist damit aufgehoben.
`seed` und `seed_strategy` des Originalscripts gelten. Bei `increment` addiert
es den Chunkindex; für identische Seeds ist dessen feste Seed-Strategie zu wählen.
Es wird nicht heimlich auf einen festen Seed umgestellt.

**GPU:** Ein Artikel entspricht einem Scriptlauf. Das Originalscript lädt sein
Modell einmal und verwendet es innerhalb dieses Laufs für seine Chunks erneut.
Es gibt keine separaten HTTP-Aufrufe für Kalibrierung oder Einzelchunks.
Zwischen Artikeln wird der Worker beendet und der GPU-Speicher freigegeben.

## Update beider Geräte

1. **Gerät B – Qwen-TTS-Server:** Wenn kein Auftrag läuft, die Repository-Dateien
   `tts-server/qwen_http_service.py` und `tts-server/qwen_chunk_worker.py` auf
   Gerät B kopieren und dort nebeneinander ablegen. Der Worker behält seinen bisherigen
   Dateinamen, verarbeitet jetzt aber vollständige Artikel.
2. **Weiter auf Gerät B:** Den Python-HTTP-Dienst mit den Argumenten
   `--script`, `--config`, `--voices-dir`,
   `--extract-script`, `--host`, `--port` und demselben Token neu starten.
   `--script` muss auf dein unverändertes `generate_mp3_with_embedding.py`,
   `--extract-script` auf `examples/extract_speaker.py` und `--voices-dir` auf
   das `voices`-Verzeichnis des Qwen-Projekts zeigen.
3. **Gerät A – WebArchiv-Server:** WebArchiv-TTS-Dateien aktualisieren und nur
   den WebArchiv-Node.js-Dienst neu starten.
   `qwen.max_characters` wird nicht mehr verwendet und kann entfernt werden.
   Die OpenAI-Einstellungen bleiben erhalten und gelten nur für OpenAI.
4. **Von einem Rechner mit WebArchiv-Checkout und Netzwerkzugriff auf Gerät B:**
   Das aktualisierte PowerShell-Testscript ausführen:

```powershell
.\tts-server\Test-QwenServer.ps1
```

Erwartet: `protocol: webarchiv-qwen-v5`, `full_markdown: true`, `audio_format: mp3`.
Alte Brücken werden vor einer Synthese abgewiesen. Danach einen kurzen und langen
Artikel über die normale Bestätigung im Archiv testen.

## Gerät B: Qwen-TTS-Dienst starten und konfigurieren

Die folgenden Schritte werden ausschließlich auf Gerät B ausgeführt. Beide
Python-Dateien liegen dort im selben Verzeichnis.
Den Python-Interpreter der funktionierenden Qwen-Umgebung verwenden.
Die HTTP-Brücke und der Launcher selbst benötigen nur die Standardbibliothek;
das Originalscript verwendet seine bereits installierten Modell-/Audiopakete.

```sh
export QWEN_TTS_TOKEN='<gemeinsames Geheimnis, mindestens 32 Zeichen>'
/pfad/qwen-venv/bin/python /pfad/qwen_http_service.py \
  --script /pfad/faster-qwen3-tts/generate/generate_mp3_with_embedding.py \
  --config /pfad/faster-qwen3-tts/generate/qwen_http_service_config.json \
  --voices-dir /pfad/faster-qwen3-tts/voices \
  --extract-script /pfad/faster-qwen3-tts/examples/extract_speaker.py \
  --voice-model Qwen/Qwen3-TTS-12Hz-1.7B-Base \
  --host 0.0.0.0 --port 8765
```

Auf dem Windows-Modellrechner entsprechen die drei neuen Pfade beispielsweise
`E:\Code\faster-qwen3-tts\voices`,
`E:\Code\faster-qwen3-tts\examples\extract_speaker.py` und dem oben genannten
Hugging-Face-Modell. `--ffmpeg` und `--voice-device` können bei Bedarf explizit
gesetzt werden; die Defaults sind `ffmpeg` und `cuda:0`.
Das Repository-Script `tts-server/start_qwen_tts_service.cmd` enthält die
passende Windows-Startzeile für diese Pfade und wird ausschließlich auf Gerät B
verwendet.

## Gerät A: Verbindung zum Qwen-Gerät konfigurieren

Die folgenden Variablen gehören ausschließlich in die geschützte
Dienstumgebung des WebArchiv-Node.js-Servers auf Gerät A:

```ini
QWEN_TTS_BASE_URL=http://192.168.1.65:8765
QWEN_TTS_TOKEN=<dasselbe Geheimnis>
```

Die Basis-URL darf keinen Pfad, Query oder eingebettete Zugangsdaten enthalten.
Sie muss auf die IP-Adresse bzw. den Hostnamen von Gerät B zeigen; `localhost`
ist bei getrennten Geräten falsch. Auf Windows startet
`tts/Start-WebArchivQwen.ps1` nur für lokale Entwicklung eine WebArchiv-Instanz
nach einem Health-Test gegen Gerät B. Das Script ändert weder den Qwen-Dienst
auf Gerät B noch den produktiven Debian-Dienst auf Gerät A. Für Gerät A die
geschützte `/etc/nodeapp/tts.env` bearbeiten und anschließend ausschließlich
den Dienst `nodeapp` neu starten.

`QWEN_TTS_TOKEN` ist die einzige Konfiguration, die auf beiden Geräten mit
identischem Wert vorhanden sein muss: auf Gerät A als Client-Zugang und auf
Gerät B zur Prüfung eingehender Requests. `QWEN_TTS_BASE_URL` wird nur auf
Gerät A benötigt. `--voices-dir`, `--extract-script`, `--voice-model` und
`--voice-device` werden nur auf Gerät B verwendet.

Das Arbeitsverzeichnis des Workers auf Gerät B ist das Verzeichnis des Originalscripts.
Absolute Pfade für Modell-/Referenzdateien sind empfehlenswert. Bei systemd
auf Gerät B `KillMode=control-group` beibehalten. Den Qwen-Port per Firewall auf
Gerät A als erlaubten Client beschränken; außerhalb eines vertrauenswürdigen
privaten Netzes TLS verwenden.

## HTTP-Vertrag

Alle Requests benötigen `Authorization: Bearer <Token>`. Kein Browserzugriff
auf den Modellserver, kein CORS. Job-IDs sind clientseitig erzeugte UUIDv4.

| Request | Vertrag |
| --- | --- |
| `GET /v1/health` | `protocol: webarchiv-qwen-v5`, vollständiges Markdown/MP3/Chunk-Fortschritt sowie `voice_catalog`, `voice_creation`, `voice_model`, `max_voice_upload_bytes` |
| `GET /v1/voices` | Verfügbare `*-1.7B.pt` mit ID, Anzeigename, Modell, Erstellungsdatum und SHA-256 des vollständigen Dateiinhalts |
| `PATCH /v1/voices/<id>` | Anzeigenamen ändern; der Dienst normalisiert den Namen und behält `-1.7B.pt` bei |
| `DELETE /v1/voices/<id>` | Stimme verlustfrei unter `voices/trash/<Zeitstempel>/` verschieben |
| `PUT /v1/voice-jobs/<id>` | JSON mit `name`, `mimeType`, `audioBase64`; 202 mit ID und Status |
| `GET`/`DELETE /v1/voice-jobs/<id>` | Stimmerzeugung abfragen bzw. abbrechen |
| `PUT /v1/jobs/<id>` | JSON `{ "markdown": "...", "voiceId": "name" }`; `voiceId` ist die vom Katalog gelieferte ID und optional |
| `GET /v1/jobs/<id>` | ID, Zustand und bis zu 100 nummerierte `progress`-Einträge; erneuert die Lease |
| `GET /v1/jobs/<id>/audio` | Erst nach Erfolg: `audio/mpeg`, exakte `Content-Length`, fertige MP3 |
| `DELETE /v1/jobs/<id>` | Abbruch/Aufräumen; unbekannte IDs erhalten eine Abbruchmarkierung |

## Stimmenverwaltung

Der Browser spricht nie direkt mit Gerät B. Sämtliche Routen auf Gerät A sind
admin-geschützt; WebArchiv leitet Aufnahme und Verwaltungsbefehl
mit dem bestehenden Bearer-Token an den Qwen-Dienst weiter. Der Admin gibt nur
einen Namen ein. Der Dienst bildet daraus einen sicheren Dateistamm und ergänzt
immer `-1.7B.pt`. Fertige Dateien liegen ausschließlich im mit
`--voices-dir` angegebenen Verzeichnis auf dem Modellrechner.

Aufnahmen müssen 3 bis 60 Sekunden lang sein und dürfen 10 MiB nicht
überschreiten. Der Dienst akzeptiert die vom Browser üblichen Formate WebM,
MP4/M4A, Ogg und WAV, konvertiert sie mit FFmpeg in Mono-PCM mit 24 kHz und
weist leere bzw. praktisch stumme Aufnahmen zurück. Danach läuft genau
`extract_speaker.py` mit dem konfigurierten 1.7B-Base-Modell. Eingangsdatei,
konvertierte WAV-Datei und unvollständige Ausgabe werden auch bei Fehler oder
Abbruch entfernt. Artikel- und Stimmerzeugung teilen sich dieselbe GPU-Sperre,
damit nie zwei Modellprozesse gleichzeitig laufen.

WebArchiv speichert global nur die ausgewählte Stimmen-ID. Jeder neue
Qwen-Auftrag erhält diese ID als unveränderlichen Snapshot; eine spätere
Auswahländerung beeinflusst ihn nicht. Eine gelöschte Stimme wird nicht
vernichtet, sondern nach `voices/trash/<Zeitstempel>/` verschoben; die aktive
Stimme ist über WebArchiv vor dem Löschen geschützt. Das gesamte `voices`-
Verzeichnis einschließlich `trash` sollte in die reguläre Sicherung des
Modellrechners aufgenommen werden. Vor dem ersten Einsatz empfiehlt sich eine
einmalige Kopie der vorhandenen `.pt`-Dateien. Die Katalog-Metadaten Modell und
Erstellungszeit werden ohne separate Datenbank aus Modellkonfiguration und
Datei-Mtime gebildet. Zusätzlich berechnet Gerät B beim Katalogabruf den
SHA-256-Hash jeder aktiven Voice-Datei. Gerät A speichert eine erzeugte
Stimmprobe content-adressiert unter diesem Hash und zeigt sie nur an, wenn der
aktuelle Katalog weiterhin denselben Hash liefert. Eine unter gleichem Namen
ersetzte `.pt`-Datei kann daher nie versehentlich mit einer alten Hörprobe
abgespielt werden.

Ein aktiver Artikel gleichzeitig, keine Queue. Gleiche ID mit gleichem Inhalt
startet nie doppelt; anderer Inhalt unter derselben ID wird abgewiesen.
Bei verlorener Startantwort kennt der Adapter die ID und fordert den Abbruch an.
Keine automatischen Synthesewiederholungen und kein OpenAI-Fallback im laufenden
Worker. Die Providerwahl vor der Bestätigung ist oben beschrieben.

Polling läuft zur Statuskontrolle und Lease-Erneuerung weiter, schreibt aber
keine unveränderten Logmeldungen. Das Log behält seine Scrollposition.
Der Worker filtert ausschließlich unveränderte Startmeldungen des Originalscripts
wie `Chunk 3/26: 346/520 characters (boundary: paragraph)` und überträgt sie
nummeriert an WebArchiv. Alle übrigen Modellmeldungen werden verworfen. WebArchiv
zeigt jeden neuen Chunk-Start einmal als `[SYNTHESIS]`-Logzeile; `chunks: 1` im
Worker-Ergebnis bezeichnet weiterhin einen Remote-Auftrag.

Abbruch beendet die Prozessgruppe (Linux) bzw. den Prozessbaum (Windows).
Nach 90 Sekunden ohne Kontakt wird ein laufender Auftrag ebenfalls beendet.
HTTP-Anfragen haben 15 Sekunden Zeitlimit, Abbruchanfragen 5 Sekunden; das
WebArchiv-Gesamtzeitlimit steht in `runtime.job_timeout_seconds` (1800 Sekunden).
Abgeschlossene Jobdaten werden spätestens nach einer Stunde bereinigt; der
Download wird sofort per DELETE aufgeräumt. Maximal 1000 gespeicherte Jobs.

## Ausgabe und Schutzmechanismen

WebArchiv prüft die fertige MP3 mit FFprobe auf Codec und positive Dauer und
führt mit FFmpeg einen vollständigen Dekodiertest aus. Es kodiert sie **nicht**
neu und ändert weder Bitrate noch Metadaten oder Pausen. Die heruntergeladenen
MP3-Bytes werden anschließend atomar und ohne Überschreiben unter
`audio/<relativer www-Pfad>.mp3` veröffentlicht.

Bestätigung, Admin-/Autorenrechte, Pfadschutz, Startreservierung und Abbruch
bleiben bestehen. Reindex erfolgt erst nach erfolgreicher Ausgabe. Ein
Reindex-Fehler löscht keine MP3 und startet keine neue Synthese.
OpenAI verwendet weiterhin seine bisherige eigene Verarbeitung.

Der Qwen-HTTP-Transport verwendet `node:http`/`node:https`, nicht Undici:
Das vermeidet den zuvor gemeldeten [Undici-Parserabsturz #5360](https://github.com/nodejs/undici/issues/5360).
Redirects werden nicht verfolgt; unvollständige Downloads werden abgewiesen.

## Prüfstand

Die automatisierten Node- und Python-Tests prüfen unter anderem:

- Providerwahl bei gültiger Antwort, gestopptem Server, ausbleibenden Headern
  oder Antwortkörpern, HTTP-Fehlern und inkompatiblem Vertrag; fehlender API-Key.
- Bestätigung/Ablehnung beider Provider und Verfügbarkeitswechsel vor dem Start.
- Stimmenkatalog, globale Auswahl, Browserdialog, Namensnormalisierung,
  1.7B-Suffix, Sprecherübergabe sowie Umbenennen und Papierkorb.
- Unverändertes langes Markdown einschließlich BOM/CRLF/Unicode, regulärer
Original-CLI-Einstieg ohne Overrides, bytegleiche MP3-Ausgabe, Fehler/Abbruch,
ruhiges Polling, Rechte, Reindex-Trennung und große HTTP/1.0-Downloads.
Die Synthese wurde simuliert; FFmpeg und HTTP-Verbindungen waren lokal echt.

```sh
npm test --prefix tts
python -B -m unittest discover -s tts-server/test -p test_qwen_http_service.py -v
```

Kein echter Modell-/OpenAI-Aufruf durch den Assistenten. Die vorherige Version
funktionierte laut Benutzer auf `192.168.1.65`; der Live-/Hörtest von v5 nach
Aktualisierung beider Geräte sowie die reale 1.7B-Stimmerzeugung stehen noch aus.
