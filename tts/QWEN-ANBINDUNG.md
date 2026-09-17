# Qwen3-TTS: vollständiges Markdown → fertige MP3

Aktueller Vertrag: **webarchiv-qwen-v4**. Auf Benutzerwunsch übernimmt
`generate_mp3_with_embedding.py` die gesamte Artikelverarbeitung. Die frühere
Aufteilung und Kalibrierung durch WebArchiv (v2/v3) gilt für Qwen nicht mehr.

## Was verarbeitet wird

### Providerwahl vor der Bestätigung

WebArchiv prüft bei jedem Klick auf „Audio erzeugen“ unabhängig vom CLI-Standard
`tts.provider` serverseitig den authentifizierten Qwen-Endpunkt `/v1/health`
und das Vorhandensein des konfigurierten OpenAI-Schlüssels.
Das Zeitlimit beträgt drei Sekunden einschließlich Antwortkörper. Nur eine
gültige v4-Antwort mit Markdown-/MP3-Unterstützung gilt als erreichbar.
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
Für diese Änderung nur WebArchiv aktualisieren/neustarten und die Browserseite
neu laden; am bereits auf v4 laufenden Qwen-Dienst ist kein Update nötig.

WebArchiv überträgt die vollständige UTF-8-Markdown-Datei, einschließlich Titel,
Metadaten, Formatierungen, Links, BOM und Zeilenumbrüchen. Es wendet weder seinen
Markdown-Parser noch Chunking, Pre-Fill, Kalibrierung oder Audioschnitt darauf an.
Das Limit beträgt 1.000.000 UTF-8-Bytes pro Artikel.

Die HTTP-Brücke legt eine temporäre `input.md` an und startet den mitgelieferten
Worker. Dieser führt den regulären `__main__`-Einstieg des Originalscripts aus,
entsprechend diesem CLI-Aufruf:

```text
python generate_mp3_with_embedding.py --config <Originalkonfiguration> --input <input.md> --output <output.mp3>
```

Es werden keine weiteren Optionen oder Konfigurationswerte überschrieben. Damit
bestimmt ausschließlich die Originalkonfiguration Markdown-Bereinigung
(`clear_markdown`), Sprache, Sprecher, Chunking-Modus/-Größen, Preroll,
Kalibrierung, Warmup, Seed-Strategie, Pausen und MP3-Export/Bitrate.
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

## Update beider Rechner

1. Wenn kein Auftrag läuft: Auf dem Qwen-Rechner `qwen_http_service.py` ersetzen
   und `qwen_chunk_worker.py` daneben ersetzen. Der Worker behält seinen bisherigen
   Dateinamen, verarbeitet jetzt aber vollständige Artikel.
2. HTTP-Dienst mit denselben Argumenten (`--script`, `--config`, `--host`, `--port`)
   und demselben Token neu starten. `--script` muss auf dein unverändertes
   `generate_mp3_with_embedding.py` zeigen; `--config` auf dessen Konfiguration.
3. WebArchiv-TTS-Dateien aktualisieren und WebArchiv neu starten.
   `qwen.max_characters` wird nicht mehr verwendet und kann entfernt werden.
   Die OpenAI-Einstellungen bleiben erhalten und gelten nur für OpenAI.
4. Das aktualisierte PowerShell-Script ausführen:

```powershell
.\tts\Test-QwenServer.ps1
```

Erwartet: `protocol: webarchiv-qwen-v4`, `full_markdown: true`, `audio_format: mp3`.
Alte Brücken werden vor einer Synthese abgewiesen. Danach einen kurzen und langen
Artikel über die normale Bestätigung im Archiv testen.

## Start und Konfiguration

Beide Python-Dateien liegen auf dem Modellrechner im selben Verzeichnis.
Den Python-Interpreter der funktionierenden Qwen-Umgebung verwenden.
Die HTTP-Brücke und der Launcher selbst benötigen nur die Standardbibliothek;
das Originalscript verwendet seine bereits installierten Modell-/Audiopakete.

```sh
export QWEN_TTS_TOKEN='<gemeinsames Geheimnis, mindestens 32 Zeichen>'
/pfad/qwen-venv/bin/python /pfad/qwen_http_service.py \
  --script /pfad/faster-qwen3-tts/generate/generate_mp3_with_embedding.py \
  --config /pfad/faster-qwen3-tts/generate/config.json \
  --host 0.0.0.0 --port 8765
```

Auf WebArchiv bleiben diese Dienst-Umgebungsvariablen erforderlich:

```ini
QWEN_TTS_BASE_URL=http://192.168.1.65:8765
QWEN_TTS_TOKEN=<dasselbe Geheimnis>
```

Die Basis-URL darf keinen Pfad, Query oder eingebettete Zugangsdaten enthalten.
Auf Windows startet `tts/Start-WebArchivQwen.ps1` WebArchiv lokal nach einem
Health-Test. Beide PS1-Scripts fragen das Token verdeckt ab; sie konfigurieren
keinen bereits laufenden Debian-Dienst. Für diesen die bestehende geschützte
`/etc/nodeapp/tts.env` bearbeiten und den Dienst anschließend neu starten.

Das Arbeitsverzeichnis des Workers ist das Verzeichnis des Originalscripts.
Absolute Pfade für Modell-/Referenzdateien sind empfehlenswert. Bei systemd
`KillMode=control-group` beibehalten. Netzwerkzugriff auf WebArchiv beschränken;
außerhalb eines vertrauenswürdigen privaten Netzes TLS verwenden.

## HTTP-Vertrag

Alle Requests benötigen `Authorization: Bearer <Token>`. Kein Browserzugriff
auf den Modellserver, kein CORS. Job-IDs sind clientseitig erzeugte UUIDv4.

| Request | Vertrag |
| --- | --- |
| `GET /v1/health` | `protocol: webarchiv-qwen-v4`, `full_markdown: true`, `audio_format: mp3`, `max_markdown_bytes: 1000000`, `lease_seconds: 90` |
| `PUT /v1/jobs/<id>` | JSON `{ "markdown": "vollständiger Originalinhalt" }`; 202 mit ID und Status |
| `GET /v1/jobs/<id>` | ID und `running`, `succeeded`, `failed` oder `cancelled`; erneuert die Lease |
| `GET /v1/jobs/<id>/audio` | Erst nach Erfolg: `audio/mpeg`, exakte `Content-Length`, fertige MP3 |
| `DELETE /v1/jobs/<id>` | Abbruch/Aufräumen; unbekannte IDs erhalten eine Abbruchmarkierung |

Ein aktiver Artikel gleichzeitig, keine Queue. Gleiche ID mit gleichem Inhalt
startet nie doppelt; anderer Inhalt unter derselben ID wird abgewiesen.
Bei verlorener Startantwort kennt der Adapter die ID und fordert den Abbruch an.
Keine automatischen Synthesewiederholungen und kein OpenAI-Fallback im laufenden
Worker. Die Providerwahl vor der Bestätigung ist oben beschrieben.

Polling läuft zur Statuskontrolle und Lease-Erneuerung weiter, schreibt aber
keine unveränderten Logmeldungen. Das Log behält seine Scrollposition.
Die interne Chunkanzahl des Originalscripts wird derzeit nicht über HTTP
übertragen: WebArchiv zeigt den laufenden Artikelauftrag ohne erfundene Chunkzahl.
Der Worker-Ergebnisvertrag enthält `chunks: 1` als einen Remote-Auftrag,
nicht als Behauptung über die internen Qwen-Chunks.

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

32 Node-Tests bestanden nach Ergänzung des Auswahldialogs. Die 7
Python-Tests bestanden beim vorherigen v4-Update; der Python-Code blieb seitdem
unverändert. Geprüft sind unter anderem:

- Providerwahl bei gültiger Antwort, gestopptem Server, ausbleibenden Headern
  oder Antwortkörpern, HTTP-Fehlern und inkompatiblem Vertrag; fehlender API-Key.
- Bestätigung/Ablehnung beider Provider und Verfügbarkeitswechsel vor dem Start.
unverändertes langes Markdown einschließlich BOM/CRLF/Unicode, regulärer
Original-CLI-Einstieg ohne Overrides, bytegleiche MP3-Ausgabe, Fehler/Abbruch,
ruhiges Polling, Rechte, Reindex-Trennung und große HTTP/1.0-Downloads.
Die Synthese wurde simuliert; FFmpeg und HTTP-Verbindungen waren lokal echt.

```sh
npm test --prefix tts
python -B -m unittest discover -s tts -p test_qwen_http_service.py -v
```

Kein echter Modell-/OpenAI-Aufruf durch den Assistenten. Die vorherige Version
funktionierte laut Benutzer auf `192.168.1.65`; der Live-/Hörtest von v4 nach
Aktualisierung beider Rechner steht noch aus.
