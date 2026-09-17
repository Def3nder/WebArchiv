# TTS-Update auf dem Node.js-Server

Stand: 17.09.2026

Diese Anleitung aktualisiert die bestehende WebArchiv-TTS-Installation auf dem
Debian-Server. Projektverzeichnis: `/opt/nodeapp`; systemd-Dienst: `nodeapp`.
Sie umfasst die Qwen-v4-Anbindung und die Auswahl verfügbarer Anbieter per
Radio-Buttons. Die bestehende TTS-Integration in `server.js` wird vorausgesetzt.

## 1. Dateien kopieren

Vorher laufende Audio-Aufträge beenden lassen und die zu ersetzenden Dateien
sichern. Eigene Einstellungen in `tts/config.json` beim Update erhalten bzw.
mit der neuen Datei abgleichen.

Aus `C:\Users\ralfb\Documents\Code\WebArchiv` die folgenden Dateien nach
`/opt/nodeapp` kopieren, jeweils unter Beibehaltung der Ordnerstruktur:

```text
public/app.js
public/index.html
public/styles.css

tts/config.json
tts/jobs.cjs
tts/markdown_tts.js
tts/spawn_tts.cjs
tts/provider-config.cjs
tts/qwen-http.js
tts/qwen-provider.js
tts/package.json
tts/package-lock.json
```

Windows-`node_modules`, Cache und temporäre Audiodateien nicht mitkopieren.
Artikel, vorhandene Audiodateien und `users.json` bleiben erhalten.

Die Python-Dateien `qwen_http_service.py` und `qwen_chunk_worker.py` gehören auf
den separaten Qwen-Rechner. Für die neue Anbieterauswahl brauchen sie kein
Update, sofern dort bereits **webarchiv-qwen-v4** läuft. Bei älteren Versionen
beide Python-Dateien gemeinsam aktualisieren und den Qwen-Dienst neu starten.
Details: [Qwen-Anbindung](QWEN-ANBINDUNG.md).

## 2. Abhängigkeiten auf Debian prüfen

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

Erforderlich sind Node.js **ab Version 22** sowie FFmpeg und FFprobe. Wenn
FFmpeg fehlt, installiert folgendes Paket beide Audiowerkzeuge:

```bash
sudo apt update
sudo apt install ffmpeg
```

Der Dienstbenutzer benötigt Leserechte auf die Artikel und Schreibrechte auf
die Audioausgabe unter `audio/` sowie das konfigurierte TTS-Cacheverzeichnis.
Ein Frontend-Build ist nicht erforderlich.

## 3. Umgebungsvariablen für den Dienst einrichten

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
OPENAI_API_KEY=DEIN_OPENAI_SCHLUESSEL
```

- Das Qwen-Token muss mit dem Token des Qwen-Dienstes übereinstimmen.
- Die Qwen-Adresse muss vom Debian-Server aus erreichbar sein.
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

## 4. Dienst neu starten

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

## 5. Auswahl im Browser prüfen

1. WebArchiv mit **Strg+F5** neu laden.
2. Als Admin einen zugänglichen Artikel ohne vorhandene MP3 öffnen.
3. **Aktionen → Audio erzeugen** wählen.
4. Die Radio-Buttons und Statusmeldungen prüfen:
   - **Qwen:** auswählbar nach erfolgreichem authentifiziertem v4-Healthcheck.
     Die Prüfung hat ein Zeitlimit von drei Sekunden.
   - **OpenAI:** auswählbar, wenn der konfigurierte Schlüssel vorhanden ist.
     Gültigkeit und Guthaben werden dabei nicht geprüft.
   - Nicht verfügbare Anbieter sind gesperrt. Es gibt keine Vorauswahl.
5. Einen Anbieter auswählen. Der Dialog zeigt dessen Übertragungs- und
   gegebenenfalls Kostenhinweis.
6. Erst **Audio-Generierung starten** bestätigt und startet den Auftrag.
   **Abbrechen** oder **Escape** startet nichts.

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
Neustart des Node.js-Dienstes nötig.
