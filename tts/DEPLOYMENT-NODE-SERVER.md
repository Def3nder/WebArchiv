# TTS-Update auf dem WebArchiv-Node.js-Server (Gerät A)

Stand: 23.10.2026

Diese Anleitung gilt **nur für das Gerät, auf dem WebArchiv läuft**: den
Debian-/LXC-Server mit dem Node.js-Prozess `server.js`. Projektverzeichnis:
`/opt/nodeapp`; systemd-Dienst: `nodeapp`.
Sie umfasst die Qwen-v5-Anbindung, die Auswahl verfügbarer Anbieter und die
globale Stimmenverwaltung. Die bestehende TTS-Integration in `server.js` wird
vorausgesetzt.

Der Qwen-TTS-Server ist ein **zweites, physisch getrenntes Gerät**. Dort laufen
Python, CUDA/GPU, `qwen_http_service.py`, `generate_mp3_with_embedding.py`,
`extract_speaker.py` und der Ordner `voices`. Befehle mit `/opt/nodeapp`, `npm`
oder `systemctl ... nodeapp` gehören auf Gerät A. Modell-, CUDA-, `voices`- und
Qwen-Python-Befehle gehören auf Gerät B. Die Einrichtung von Gerät B steht in
[Qwen-Anbindung](../tts-server/QWEN-ANBINDUNG.md).

| Gerät | Aufgabe | Speichert dauerhaft |
| --- | --- | --- |
| **A: WebArchiv-Node.js-Server** | Weboberfläche, Authentifizierung, Artikelverwaltung, Weiterleitung an Qwen, MP3-Prüfung | `www/`, `audio/`, `tts-settings.json` mit der globalen Stimmen-ID und `tts-voice-previews/` mit Hörproben |
| **B: Qwen-TTS-Modellserver** | GPU-Synthese, Stimmenkatalog und Stimmerzeugung | Modelle und `voices/*.pt` einschließlich `voices/trash` |

Der Browser erreicht nur Gerät A. Gerät A erreicht Gerät B über
`QWEN_TTS_BASE_URL`; Gerät B benötigt keinen Zugriff auf `users.json`, `www/`
oder die WebArchiv-Sitzungen.

## 1. Dateien kopieren

Vorher laufende Audio-Aufträge beenden lassen und die zu ersetzenden Dateien
sichern. Eigene Einstellungen in `tts/config.json` beim Update erhalten bzw.
mit der neuen Datei abgleichen.

Aus `C:\Users\ralfb\Documents\Code\WebArchiv` die folgenden Dateien nach
`/opt/nodeapp` kopieren, jeweils unter Beibehaltung der Ordnerstruktur:

```text
server.js
public/app.js
public/index.html
public/styles.css
public/tts-settings.js

tts/config.json
tts/jobs.cjs
tts/markdown_tts.js
tts/spawn_tts.cjs
tts/provider-config.cjs
tts/qwen-http.js
tts/qwen-provider.js
tts/voice-settings.cjs
tts/package.json
tts/package-lock.json
```

Windows-`node_modules`, Cache und temporäre Audiodateien nicht mitkopieren.
Artikel, vorhandene Audiodateien und `users.json` bleiben erhalten.
Der komplette Repository-Ordner `tts-server/` ist das Deployment-Paket für
Gerät B und gehört nicht zur WebArchiv-Installation unter `/opt/nodeapp`.

Die Python-Dateien `tts-server/qwen_http_service.py` und
`tts-server/qwen_chunk_worker.py` dürfen
**nicht** als Dienst unter `/opt/nodeapp` gestartet werden. Sie gehören auf den
separaten Qwen-TTS-Modellserver. Für Katalog, Aufnahme und globale Stimmwahl müssen
beide Dateien gemeinsam auf diesen Stand aktualisiert und der Qwen-Dienst mit
`--voices-dir` sowie `--extract-script` neu gestartet werden. Auf dem
WebArchiv-Rechner wird keine `.pt`-Datei abgelegt. Details und die vollständige
Startzeile: [Qwen-Anbindung](../tts-server/QWEN-ANBINDUNG.md).

## 2. Abhängigkeiten auf dem WebArchiv-Debian-Server prüfen

Die folgenden Befehle im SSH-Terminal des Debian-Servers ausführen. Es sind
Linux-Shell-Befehle, keine PowerShell-Scripte. Die npm-Installation als Benutzer
mit Schreibrechten auf das Projekt ausführen (laut bisherigem Setup `ralf`).

```bash
cd /opt/nodeapp
npm ci --prefix tts --omit=dev
node --version
ffmpeg -version
ffprobe -version
```

Auf Gerät A sind Node.js **ab Version 22** sowie FFmpeg und FFprobe erforderlich.
Diese Werkzeuge prüfen die vom Qwen-Gerät zurückgelieferte MP3. Wenn
FFmpeg fehlt, installiert folgendes Paket beide Audiowerkzeuge:

```bash
sudo apt update
sudo apt install ffmpeg
```

Der Dienstbenutzer benötigt Leserechte auf die Artikel und Schreibrechte auf
die Audioausgabe unter `audio/`, das konfigurierte TTS-Cacheverzeichnis, das
Hörprobenverzeichnis und die Datei `tts-settings.json` bzw. deren
Elternverzeichnis.
Ein Frontend-Build ist nicht erforderlich.

## 3. Umgebungsvariablen für WebArchiv auf Gerät A einrichten

Die Datei `/etc/nodeapp/tts.env` bearbeiten. Falls sie noch nicht existiert:

```bash
sudo install -d -m 755 /etc/nodeapp
sudo touch /etc/nodeapp/tts.env
sudo chown root:root /etc/nodeapp/tts.env
sudo chmod 600 /etc/nodeapp/tts.env
sudo nano /etc/nodeapp/tts.env
```

Folgende Werte eintragen; Platzhalter durch die echten Werte ersetzen:

```ini
QWEN_TTS_BASE_URL=http://192.168.1.65:8765
QWEN_TTS_TOKEN=DEIN_TOKEN_VOM_QWEN_SERVER
TTS_SETTINGS_FILE=/opt/nodeapp/tts-settings.json
TTS_VOICE_PREVIEW_DIR=/opt/nodeapp/tts-voice-previews
OPENAI_API_KEY=DEIN_OPENAI_SCHLUESSEL
```

- Das Qwen-Token muss mit dem Token des Qwen-Dienstes übereinstimmen.
- `TTS_SETTINGS_FILE` liegt auf Gerät A und enthält nur die global ausgewählte
  Stimmen-ID, niemals eine `.pt`-Datei oder Aufnahme.
- `TTS_VOICE_PREVIEW_DIR` liegt ebenfalls auf Gerät A. Dort speichert WebArchiv
  eine erzeugte MP3 unter dem SHA-256-Hash der zugehörigen `.pt`-Datei. Eine
  Probe wird nur angeboten, solange Gerät B für die Stimme denselben Hash meldet.
- Die Qwen-Adresse ist die Netzwerkadresse von Gerät B und muss von Gerät A aus
  erreichbar sein. `localhost` wäre hier falsch, solange beide Dienste nicht
  ausnahmsweise auf demselben Gerät laufen.
- OpenAI ist nur mit vorhandenem Schlüssel auswählbar. Die Variable weglassen,
  wenn OpenAI nicht genutzt werden soll.
- Bereits im Dienst konfigurierte Schlüssel müssen nicht doppelt eingetragen
  werden. Bestehende Einstellungen vor dem Ändern abgleichen.
- Ein `export` in einer SSH-Sitzung konfiguriert keinen bereits laufenden
  systemd-Dienst. Die lokalen PS1-Helfer konfigurieren ihn ebenfalls nicht.

Falls die Datei noch nicht vom Dienst geladen wird:

```bash
sudo systemctl edit nodeapp
```

Folgendes zum Dienst-Override hinzufügen; bestehende Einstellungen erhalten:

```ini
[Service]
EnvironmentFile=/etc/nodeapp/tts.env
```

Die Datei mit den Schlüsseln nicht in das Repository aufnehmen oder weitergeben.

## 4. WebArchiv-Dienst auf Gerät A neu starten

Vorher sicherstellen, dass kein Audio-Auftrag mehr läuft. Ein Neustart beendet
laufende Verarbeitung.

```bash
sudo systemctl daemon-reload
sudo systemctl restart nodeapp
sudo systemctl status nodeapp --no-pager
```

Bei Startfehlern die letzten Dienstmeldungen ansehen:

```bash
sudo journalctl -u nodeapp -n 50 --no-pager
```

## 5. Zusammenspiel beider Geräte im Browser prüfen

1. WebArchiv mit **Strg+F5** neu laden.
   Vorher müssen WebArchiv auf Gerät A und der Qwen-HTTP-Dienst auf Gerät B laufen.
2. Als Admin einen zugänglichen Artikel ohne vorhandene MP3 öffnen.
3. **Aktionen → Audio erzeugen** wählen.
4. Die Radio-Buttons und Statusmeldungen prüfen:
   - **Qwen:** auswählbar nach erfolgreichem authentifiziertem v5-Healthcheck.
     Die Prüfung hat ein Zeitlimit von drei Sekunden.
   - **OpenAI:** auswählbar, wenn der konfigurierte Schlüssel vorhanden ist.
     Gültigkeit und Guthaben werden dabei nicht geprüft.
   - Nicht verfügbare Anbieter sind gesperrt. Es gibt keine Vorauswahl.
5. Einen Anbieter auswählen. Der Dialog zeigt dessen Übertragungs- und
   gegebenenfalls Kostenhinweis.
6. Erst **Audio-Generierung starten** bestätigt und startet den Auftrag.
   **Abbrechen** oder **Escape** startet nichts.
7. Im Kopfmenü **TTS-Einstellungen** öffnen, den Katalog neu laden und eine
   Stimme global speichern. Danach Aufnahme und Datei-Upload mit einem kurzen
   Testclip sowie Stimmprobe, Umbenennen und Verschieben in den Papierkorb prüfen.
   Nach erneutem Öffnen muss die Hörprobe ohne Neuberechnung von Gerät A
   angeboten werden. Wird die `.pt`-Datei auf Gerät B ersetzt, darf die alte
   Probe wegen des geänderten SHA-256-Werts nicht mehr erscheinen.
   Die erzeugte Datei muss auf Gerät B unter `voices`, nicht unter
   `/opt/nodeapp`, erscheinen.

Das reine Öffnen des Dialogs erzeugt keine Audio-Datei und verursacht keinen
kostenpflichtigen OpenAI-Aufruf. Zum Prüfen der Ausfallerkennung den Qwen-Dienst
stoppen und den Auswahldialog erneut öffnen; Qwen muss dann gesperrt erscheinen.
Anschließend den Qwen-Dienst wieder starten.

Beim Start wird die Verfügbarkeit erneut geprüft. Ist der gewählte Anbieter
inzwischen ausgefallen, startet kein Auftrag; den Dialog erneut öffnen.
Es gibt keinen automatischen Wechsel zu einem anderen Anbieter.

Bei einer tatsächlich gestarteten Qwen-Generierung verarbeitet das Originalscript
das vollständige Markdown und liefert die fertige MP3. WebArchiv prüft und
veröffentlicht sie atomar unter `audio/<relativer www-Pfad>.mp3`. Vorhandene MP3s
werden nicht überschrieben. Die Aktualisierung des Artikelindex bleibt ein
separater Schritt nach erfolgreicher Synthese.

## Nur spätere Frontend-Änderungen übernehmen

Wenn die vollständige TTS-Aktualisierung bereits installiert ist und lediglich
die Umstellung vom Dropdown auf Radio-Buttons fehlt, reichen:

```text
public/app.js
public/index.html
public/styles.css
```

Danach die Browserseite neu laden. Für diese reine Frontend-Änderung ist kein
Neustart des WebArchiv-Node.js-Dienstes auf Gerät A nötig. Gerät B bleibt dabei
unverändert.
