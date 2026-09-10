# Markdown-TTS für WebArchiv: Übergabe an die nächste Session

## 1. Was bereits implementiert ist

Dieses Verzeichnis enthält eine eigenständige Node.js-Fassung der getesteten
Python-Compact-Pipeline. Die Website wurde **nicht verändert**.

| Datei | Zweck |
|---|---|
| `markdown_tts.js` | ES-Modul, CLI und gesamte TTS-/Audioverarbeitung |
| `config.json` | Sprechprofil, Chunking, Schnitt, FFmpeg, Cache und Zeitlimit |
| `package.json`, `package-lock.json` | Eigenes npm-Paket mit fixierten Abhängigkeiten |
| `spawn_tts.cjs` | Optionaler, getesteter CommonJS-Adapter für `server.js` |
| `markdown_tts.test.js` | Offline-Tests, einschließlich FFmpeg und Prozessanbindung |
| `INTEGRATION.md` | Diese Anleitung und Umsetzungsvorgaben für WebArchiv |

Nur `markdown-it` und `markdown-it-footnote` sind npm-Abhängigkeiten. Die API wird
über das eingebaute `fetch` angesprochen. Python und das ursprüngliche
`markdown_tts`-Paket werden zur Laufzeit nicht benötigt.

## 2. Geprüfte Ausgangslage in WebArchiv

Am 10.09.2026 wurden diese Dateien ausschließlich gelesen:

- `C:\Users\ralfb\Documents\Code\WebArchiv\scraper\scrape_all.js`
- `scraper/package.json`: `"type": "module"`, also `.js` mit `import`/`export`.
- `server.js`: CommonJS, Express 4, `require('child_process').spawn`.
- `server.js`, Bereich `/api/scrape`: `requireAdmin`, Hintergrundprozess,
  `scrapeState.output` auf 20.000 Zeichen begrenzt, Status-Polling.
- `public/app.js`: `openScrapeModal`, `closeScrapeModal`, `runScrape`, `apiFetch`.
- `public/index.html`: `scrape-overlay`, Dialogpanel, Status und `<pre>` für Logs.

Der Index in `server.js` besitzt bereits `article.id`, `article.filePath`,
`article.audioUrl`. Er findet gleichnamige MP3-Dateien neben der Markdown-Datei
unter `www/` sowie alternativ unter `audio/<Autor>/<relativer Ordner>/`.
Nach einer erfolgreichen Vertonung muss der Index aktualisiert werden, damit
der vorhandene Audio-Player die neue Datei erkennt.

Diese Einbaupunkte in der nächsten Session erneut prüfen: Zeilennummern und
Implementierung können sich inzwischen geändert haben. Bestehende Artikel- und
Autorenberechtigungen beibehalten.

## 3. Installation und Dateistruktur

Den Inhalt dieses Verzeichnisses später nach **`WebArchiv/tts/`** kopieren.
Nicht nur die `.js`-Datei kopieren: Die eigene `package.json` stellt sicher, dass
sie wie der Scraper als ES-Modul läuft, obwohl `server.js` CommonJS verwendet.
Die Root-`package.json` der Website muss nicht auf `"type": "module"` umgestellt werden.

```text
WebArchiv/
  server.js
  scraper/...
  tts/
    markdown_tts.js
    spawn_tts.cjs
    config.json
    package.json
    package-lock.json
    markdown_tts.test.js
  public/...
  www/...
```

Voraussetzungen: Node.js 22 oder neuer; getestet mit Node.js 24.18.0.
Für lange Texte müssen `ffmpeg` und `ffprobe` im PATH liegen oder in
`config.json` als absolute ausführbare Dateipfade eingetragen sein. Kurze Texte
benötigen diese Programme nicht. Ziel-Dateisystem muss Hardlinks unterstützen
(z. B. NTFS/ext4); diese veröffentlichen die fertige Datei atomar ohne Überschreiben.

```sh
cd /pfad/zu/WebArchiv/tts
npm ci --omit=dev --ignore-scripts
node markdown_tts.js --help
```

Der API-Key steht ausschließlich in der Prozessumgebung. Der konfigurierte Name
ist wie bisher `GPT-4o-Mini-TTS-Key`. Für Linux/systemd kann man in `config.json`
`tts.api_key_environment_variable` auf `OPENAI_API_KEY` ändern und diese Variable
im Serverdienst setzen. Die Website muss den Key bereits beim Start in ihrer
Umgebung haben; eine im interaktiven Terminal gesetzte Variable erreicht einen
bereits laufenden Dienst nicht. Keine Schlüssel in Browser, Git, CLI-Argumente
oder Statusantworten schreiben.

Bei Deployment in ein schreibgeschütztes Code-Verzeichnis
`runtime.cache_directory` auf ein beschreibbares Datenverzeichnis ändern.
Relative Cache-Pfade werden relativ zur **gewählten Konfigurationsdatei** aufgelöst.

## 4. CLI-Vertrag

```sh
node markdown_tts.js "/daten/Artikel mit Leerzeichen.md" --output "/audio/Artikel mit Leerzeichen.mp3"
node markdown_tts.js input.md --output output.mp3 --json-progress
node markdown_tts.js input.md --output output.mp3 --config /etc/webarchiv/tts.json
```

- Genau eine Eingabedatei und verpflichtend `--output <vollständiger MP3-Pfad>`.
- `--output` ist eine Datei, kein Verzeichnis. Fehlende Elternordner werden angelegt.
- Relative Eingabe-, Ausgabe- und explizite Config-Pfade beziehen sich auf `cwd`.
  Für `spawn` immer absolute Pfade übergeben.
- Standardkonfiguration: `config.json` neben `markdown_tts.js`, unabhängig von `cwd`.
- Existierende Ausgabedateien werden nie überschrieben. Kein `--overwrite`.
- Ein kompletter Auftrag darf standardmäßig höchstens 1.800 Sekunden dauern;
  API-Zeitlimit 120 Sekunden je Anfrage, FFmpeg-Zeitlimit 300 Sekunden.
- Bei HTTP 408/409/429/500/502/503/504 maximal `max_retries` Wiederholungen.
  Netzabbrüche und bereits begonnene Streams werden nicht automatisch erneut
  synthetisiert, damit kein unbemerkter kostenpflichtiger Doppelaufruf entsteht.

### stdout: maschinenlesbares Ergebnis

Bei erfolgreicher Verarbeitung genau eine JSON-Zeile:

```json
{"outputPath":"/audio/Artikel.mp3","chunks":2,"characters":4930}
```

Bei Fehler kein Ergebnisobjekt. `--help` ist die einzige Textausnahme auf stdout.
Keine Audiodaten auf stdout. `chunks` zählt Nutztext-Chunks, nicht Kalibrierungsaufrufe.

### stderr: Live-Ausgabe für CLI und Popup

Standard: lesbare Zeilen mit Zeitstempel und Meldungstyp. Mit `--json-progress`
genau ein JSON-Objekt je Zeile (NDJSON):

```json
{"version":1,"time":"2026-09-10T12:00:00.000Z","type":"start","message":"4930 Zeichen; 2 Chunk(s), mit Pre-Fill.","total":2,"characters":4930}
{"version":1,"time":"2026-09-10T12:00:03.000Z","type":"synthesis","message":"Chunk 1/2 mit Pre-Fill.","current":1,"total":2}
{"version":1,"time":"2026-09-10T12:00:40.000Z","type":"trim","message":"Pre-Fill aus Chunk 1 bei 3.200 s entfernt.","current":1,"total":2}
```

Typen: `start`, `calibration`, `synthesis`, `trim`, `encoding`, `retry`, `warning`,
`diagnostic`, `complete`, `error`. Fehler haben zusätzlich `code`.
Nicht jedes Event enthält `current`/`total`. Keine errechneten Prozentwerte als
Zeitprognose anzeigen: Chunk-Längen und API-Laufzeiten unterscheiden sich.

`complete` ist eine Fortschrittsmeldung. Für den Website-Erfolg sind **Exit 0
und gültiges stdout-Ergebnis** maßgeblich. Ein `stderr`-Eintrag ist nicht automatisch
ein Fehler. Beide Pipes kontinuierlich lesen. Ein `data`-Paket ist nicht zwingend
eine vollständige Zeile; der Adapter verwendet deshalb `readline`.

| Exit-Code | Bedeutung |
|---|---|
| 0 | MP3 vollständig veröffentlicht |
| 1 | Verarbeitung fehlgeschlagen, einschließlich Zeitlimit |
| 2 | Argumente/Konfiguration ungültig, API-Key fehlt |
| 130 | Kooperativer Abbruch |

Signalbeendigung oder Startfehler können zusätzlich einen `null`-Exit-Code erzeugen.
Kein `process.exit()` im Worker: Ausgabepuffer dürfen vor dem Ende auslaufen.

## 5. Verarbeitung und Unterschiede zur Python-Fassung

- Derselbe bereinigte Sprechtext entscheidet bei 3.800 Unicode-Codepoints über
  direkten MP3-Aufruf oder mehrere WAV-Chunks. Genau 3.800 bleibt direkt.
- Listen, Überschriften, Linktexte und Inline-Code wie im Compact-Standard.
  Tabellen, Codeblöcke, HTML, Bilder und Fußnoten bleiben stumm.
- Python-Regex `(?i)` wurde in der JSON-Datei durch JavaScript-Flags `giu` ersetzt.
- Jeder lange Chunk erhält Pre-Fill einschließlich des ersten Chunks. Dessen
  Länge und Trennzeichen werden vom Nutztextbudget abgezogen.
- Kalibrierung wird anhand der TTS-/Pre-Fill-Einstellungen gecacht. Der Node-Cache
  ist bewusst getrennt vom Python-Cache. Beim ersten langen Node-Aufruf fällt
  ein zusätzlicher Kalibrierungsaufruf an.
- PCM-Schnitt mit derselben Ruhefensterlogik und ties-to-even-Rundung wie Python.
- `[DONE]` wird nicht als JSON interpretiert und ersetzt nicht `speech.audio.done`.
- Audio wird pro Chunk verarbeitet; die gesamte lange WAV wird nicht im RAM
  zusammengesetzt. WAV-Dateien sind auf das klassische RIFF-Limit begrenzt.
- Cache-Dateien werden über eindeutige temporäre Dateien veröffentlicht.
  Parallele Cache-Misses dürfen separat kalibrieren; Cache-Korruption wird vermieden,
  aber ein doppelter Kalibrierungsaufruf zwischen Prozessen ist möglich.

Pro Ausgabe existiert während des Auftrags `<output>.tts-lock`. Gleiche Ziele
werden schon vor dem API-Aufruf gesperrt. Bei hartem Kill/Stromausfall kann die
Sperre zurückbleiben: PID und Startzeit in der Datei prüfen und nur nach Prüfung
eines nicht mehr laufenden Auftrags manuell entfernen. Kein automatisches Löschen
einer fremden aktiven Sperre. Verschiedene Ziele dürfen parallel laufen; für die
Website zunächst einen aktiven TTS-Auftrag insgesamt vorsehen.

Arbeitsdateien liegen in `.markdown-tts-*` neben dem MP3-Ziel. Bei Erfolg und
kooperativem Abbruch werden sie entfernt. Bei Fehler bleiben sie standardmäßig
zur Diagnose erhalten (`keep_failed_work`). Auf dem Server Aufbewahrungsfrist
und Speicherbereinigung festlegen; diese Dateien enthalten Sprachinhalte.

## 6. Einbindung in server.js: getesteten Adapter verwenden

Der mitgelieferte `spawn_tts.cjs` lässt sich direkt aus dem CommonJS-Server laden:

```js
const { startTts } = require('./tts/spawn_tts.cjs');

const job = startTts({
  inputPath: absoluteMarkdownPath,
  outputPath: absoluteMp3Path,
  onEvent(event) {
    // Statusobjekt aktualisieren; nicht res.write() auf dem POST-Request.
    console.log('[tts]', event.message);
  },
});

job.completion.then(result => {
  console.log('Fertig:', result.outputPath);
}).catch(error => {
  console.error(error.message, error.exitCode);
});

// Abbrechen-Button -> autorisierter Backend-Endpunkt ->
// job.cancel();
```

Der Adapter startet `process.execPath` ohne Shell, übergibt Argumente getrennt,
liest stdout/stderr zeilenweise und wartet auf `close`. `completion` muss sofort
mit einem Fehlerhandler verbunden werden. `cancel()` sendet zunächst eine
IPC-Nachricht, damit der Worker API und FFmpeg auch unter Windows aufräumen kann.
Nach zehn Sekunden folgt ein harter Kill als Rückfall. Ein harter Kill garantiert
keine Bereinigung von temporären Dateien; bei eingefrorenem Worker ggf. auch den
Prozessbaum durch den Dienstmanager beenden. `SIGINT`/`SIGTERM` funktionieren
zusätzlich beim normalen CLI-Betrieb. Bei IPC-Verbindungsverlust bricht der Worker ab.

## 7. Backend-Auftragsmodell und Endpunkte (in der Folgesession implementieren)

**Start nicht an die Lebensdauer einer HTTP-Anfrage binden.** Der POST antwortet
nach dem Start mit HTTP 202 und einer Job-ID. Das Popup fragt den Status ab.
Weder ein geschlossenes Popup noch ein Browser-Reload beendet die Synthese.

Für den ersten Ausbau dieselben Admin-Rechte wie beim Scraper verwenden, und
zwar für **Start, Status und Abbruch**. Wenn später mehrere Benutzer TTS nutzen,
den Job zusätzlich dem Benutzer zuordnen und Zugriffe auf fremde Jobs sperren.
Bestehende Session-/CSRF-Regeln der Website übernehmen. Keine absoluten Serverpfade
als vom Browser frei wählbare Parameter akzeptieren.

| Route | Funktion |
|---|---|
| `POST /api/tts` | Body `{ "articleId": "..." }`; Artikel auflösen und Job starten |
| `GET /api/tts/:jobId/status` | Zustand, begrenztes Log, aktueller Chunk, Fehler/Ergebnis |
| `POST /api/tts/:jobId/cancel` | Kooperativen Abbruch anfordern, HTTP 202 |

`articleId` aus dem vorhandenen `articles`-Index auflösen. Daraus `article.filePath`
ermitteln und Dateizugriff prüfen. Für den ersten Ausbau das MP3-Ziel neben die
Markdown-Datei legen: `filePath.slice(0, -3) + '.mp3'`. Alternativ später die bereits
unterstützte Struktur unter `AUDIO_DIR` verwenden. Die CLI kann jeden erlaubten
Ausgabepfad annehmen; die Website legt die zulässigen Ziele serverseitig fest.
Quellpfad mit `realpath` gegen den tatsächlichen Archivroot prüfen, um Symlinks
außerhalb des Archivs nicht durchzulassen. Bei externem Audio-Ziel vorhandene
Elternpfade ebenso prüfen. Das Ausgabeverzeichnis darf kein frei beschreibbarer
Bereich anderer Benutzer sein.

Ein Statusobjekt sollte mindestens enthalten:

```js
{
  id: 'server-generated-uuid',
  articleId: 'Autor/2026/Artikel',
  status: 'running', // starting|running|cancelling|indexing|succeeded|failed|cancelled
  done: false,
  startedAt: Date.now(), finishedAt: null,
  current: null, total: null,
  output: '',       // begrenzt auf letzte 20.000 Zeichen
  error: null, exitCode: null,
  audioUrl: null    // Website-URL nach dem Reindex, kein Dateisystempfad
}
```

Die `child`-/`completion`-Referenzen separat speichern und niemals serialisieren.
Ein `Map` mit maximal z. B. 50 abgeschlossenen Jobs reicht bei einem Serverprozess;
abgeschlossene Jobs nach 24 Stunden entfernen. Aktive Jobs nicht durch TTL löschen.
Bei mehreren App-Instanzen oder benötigter Neustartfestigkeit eine gemeinsame
Jobablage/Queue verwenden. Die erste Version soll ausdrücklich nur einen aktiven
WebArchiv-TTS-Job zulassen; die Reservierung muss **vor dem ersten await** erfolgen,
sonst können zwei Startanfragen gleichzeitig den Leerlauf sehen.

Erforderlicher Ablauf im Start-Handler:

1. Authentifizieren, `articleId` validieren, Artikel und Berechtigung auflösen.
2. Aktiven TTS-/Reindex-/Scrape-Zustand prüfen; bei Konflikt HTTP 409.
3. Startplatz synchron reservieren. Dann Eingabepfad, Ausgabe, existierende MP3,
   benötigte Tools und Konfiguration prüfen. Scheitert dies, Platz freigeben.
4. Status anlegen, `startTts(...)` aufrufen und sofort `completion` behandeln.
5. `onEvent`: Log anhängen/auf 20.000 Zeichen kappen; `current`/`total` aktualisieren;
   `error`-Event merken. `complete` noch nicht als Website-Endzustand behandeln.
6. HTTP 202 mit `{jobId}` zurückgeben.
7. Bei erfolgreich aufgelöstem `completion`: Status `indexing`; vorhandenes
   `buildIndex()` koordiniert ausführen; Artikel neu aus dem Index lesen und
   dessen `audioUrl` übernehmen; anschließend `succeeded`, `done: true`.
8. Bei Ablehnung: `cancelled` für Exit 130, sonst `failed`; Fehlertext und Exit-Code
   speichern. `done: true`, Startplatz freigeben. Keine automatische neue Synthese.
9. Fehler beim Reindex getrennt ausweisen: MP3 bleibt erfolgreich erzeugt;
   Fehlermeldung soll eine Indexaktualisierung anbieten, keine erneute Vertonung.

Die vorhandenen Scrape-/Reindex-Start-Handler müssen die neue TTS-Reservierung
ebenfalls beachten, damit die Sperre in beide Richtungen gilt. Beim Server-Shutdown
aktive Jobs kooperativ abbrechen und vor Ende auf `completion` warten.

### Log-Aufbereitung für das Popup

```js
function captureTtsEvent(state, event) {
  const line = `${event.time || new Date().toISOString()} [${event.type.toUpperCase()}] ${event.message}`;
  state.output = (state.output + line + '\n').slice(-20000);
  if (Number.isInteger(event.current)) state.current = event.current;
  if (Number.isInteger(event.total)) state.total = event.total;
  if (event.type === 'error') state.error = event.message;
}
```

`stderr`-Logs können interne Diagnosepfade enthalten. Sie deshalb nur den
berechtigten Admins liefern. Die API nie den API-Key oder komplette Environment-
Variablen ausgeben lassen. Keine Roh-HTML-Ausgabe von Logtext.

## 8. Popup in public/index.html und public/app.js

Das vorhandene Scrape-Popup ist die Vorlage. Für TTS ein eigenes Overlay mit
eindeutigen IDs verwenden, damit die Zustände nicht durcheinandergeraten:

```html
<div id="tts-overlay" class="scrape-overlay" hidden>
  <div id="tts-backdrop" class="scrape-backdrop"></div>
  <div class="scrape-panel" role="dialog" aria-modal="true" aria-labelledby="tts-title">
    <button type="button" id="tts-close" aria-label="Schließen">Schließen</button>
    <h2 id="tts-title">Audio erzeugen</h2>
    <p id="tts-status" role="status" aria-live="polite"></p>
    <pre id="tts-output" class="scrape-output" tabindex="0"></pre>
    <button type="button" id="tts-cancel">Auftrag abbrechen</button>
    <a id="tts-audio" hidden>MP3 anhören</a>
  </div>
</div>
```

In der Folgesession an das tatsächliche CSS anpassen. Fokus beim Öffnen in den
Dialog setzen, Tab-Fokus im offenen Dialog halten und beim Schließen zum Auslöser
zurückgeben. Escape/Backdrop/Schließen schließen nur das Popup. Der getrennte
Abbrechen-Button beendet den Auftrag. Startbutton während aktivem Auftrag sperren;
eine Aktion „Laufenden Audio-Auftrag anzeigen“ ermöglicht Wiederöffnen.

Das Popup soll anzeigen:

- Artikelname, Zustand und „Chunk X von Y“ während der Synthese.
- Laufende Meldungen einschließlich Kalibrierung, Schnitt, Kodierung und Fehler.
- Eine unbestimmte Aktivitätsanzeige während langer API-Aufrufe, keine falsche
  Aussage „hängt“, wenn mehrere Sekunden keine Logzeile kommt.
- Bei Erfolg einen Link oder den vorhandenen Player für die MP3.
- Bei Fehler den Fehlertext; bereits angefallene API-Kosten verschwinden durch
  Abbruch/Fehler nicht. Keine automatische kostenpflichtige Wiederholung.

### Polling-Muster statt überlappendem setInterval

Das folgende Muster ist ein Einbaubeispiel, kein bereits integrierter Website-Code.
Die DOM-Referenzen und `apiFetch` an den tatsächlichen App-Code anschließen.

```js
let ttsPollGeneration = 0;
let currentTtsJobId = null;

async function watchTts(jobId) {
  currentTtsJobId = jobId;
  const generation = ++ttsPollGeneration;
  let failures = 0;
  while (generation === ttsPollGeneration) {
    try {
      const response = await apiFetch(`/api/tts/${encodeURIComponent(jobId)}/status`);
      if (generation !== ttsPollGeneration) return;
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) {
          $ttsStatus.textContent = 'Auftrag nicht verfügbar oder keine Berechtigung.';
          return;
        }
        throw new Error(`Status HTTP ${response.status}`);
      }
      const s = await response.json();
      if (generation !== ttsPollGeneration) return;
      failures = 0;
      const atBottom = $ttsOutput.scrollTop + $ttsOutput.clientHeight >= $ttsOutput.scrollHeight - 24;
      $ttsOutput.textContent = s.output || ''; // niemals innerHTML
      if (atBottom) $ttsOutput.scrollTop = $ttsOutput.scrollHeight;
      $ttsStatus.textContent = s.error || (
        s.status === 'indexing' ? 'MP3 fertig – Artikelindex wird aktualisiert …' :
        `${s.status}${s.current ? ` · Chunk ${s.current}/${s.total}` : ''}`
      );
      $ttsCancel.disabled = s.done || s.status === 'cancelling' || s.status === 'indexing';
      if (s.done) {
        if (s.status === 'succeeded' && s.audioUrl) {
          $ttsAudio.href = s.audioUrl; // nur vertrauenswürdige eigene Medien-URL vom Server
          $ttsAudio.hidden = false;
          // Vorhandene Artikelansicht neu laden, damit ihr Player aktualisiert wird.
        }
        return;
      }
    } catch (error) {
      if (generation !== ttsPollGeneration) return;
      failures++;
      $ttsStatus.textContent = 'Verbindung unterbrochen; der Auftrag kann weiterlaufen.';
      if (failures >= 3) return; // Wiederöffnen startet watchTts erneut
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
```

Beim Start `POST /api/tts` mit `{articleId}` senden, HTTP-Fehler prüfen, Overlay
öffnen und `watchTts(jobId)` starten. Während der POST-Anfrage den Startbutton
deaktivieren, um Doppelklicks zu vermeiden. Popup beim Wiederöffnen leeren,
Status neu laden und vollständigen aktuellen Logausschnitt anzeigen.

Beim Schließen `ttsPollGeneration++`, Overlay ausblenden und Fokus wiederherstellen;
den Child-Prozess **nicht** beenden. Bei erneutem Öffnen dieselbe Job-ID verwenden.
Für Reload-Wiederaufnahme Job-ID z. B. in `sessionStorage` speichern und bei
401/403/404 verwerfen; Statuszugriff bleibt serverseitig geschützt.

Abbrechen: `POST /api/tts/:jobId/cancel`, danach „Abbruch angefordert …“ anzeigen
und weiter pollen, bis ein Endzustand kommt. Ein Abbruch kurz nach der Veröffentlichung
kann bereits zu spät sein; den bestätigten Endzustand anzeigen und eine fertige MP3
nicht nachträglich löschen. Popup-Schließen und Abbrechen sind verschiedene Aktionen.

Polling entspricht der vorhandenen WebArchiv-Architektur. SSE/WebSocket sind für
diese Anforderung nicht erforderlich. Falls später SSE gewünscht ist, können
dieselben Ereignisse weitergereicht werden; dafür wären Authentifizierung,
Replay/Last-Event-ID, Keepalive und Proxy-Buffering zusätzlich umzusetzen.

## 9. Prüfungen und Abnahme

```sh
cd WebArchiv/tts
npm test
```

Die Tests brauchen FFmpeg/FFprobe, aber **keinen API-Key und kein Netzwerk**.
Sie simulieren TTS-Antworten, nutzen echten FFmpeg-Export und prüfen CLI,
SSE-Paketgrenzen/`[DONE]`, Unicode, WAV-Schnitt, Zielpfade, Sperren, Abbruch und
den Spawn-Adapter. Zusätzlich wurde in der Erstellungs-Session der Sprechtext
und das Chunking mit Python verglichen, einschließlich der Datei
`2026-04-19_wie-ziehst-du-zuerst-grenzen-mit-dir-selbst.md`.

Die Node-Version wurde in dieser Session nicht kostenpflichtig gegen OpenAI
ausgeführt. Der erfolgreiche frühere Live-Test bezog sich auf Python. Ein echter
Node-Live-Test benötigt eine gesonderte Freigabe; Audio danach auch anhören,
insbesondere an den Chunk-Übergängen.

Abnahmekriterien für die Website-Session:

1. Kurzer und langer Artikel erzeugen die MP3 am vom Backend bestimmten Ziel.
2. Browser bekommt keine Dateisystempfade als frei editierbare Jobparameter.
3. Logs erscheinen spätestens beim nächsten Poll im Popup; Unicode bleibt intakt.
4. Schließen/Wiederöffnen und Browser-Reload starten keine zweite Synthese.
5. Fehler beim Start, API-Fehler, fehlendes FFmpeg und vorhandene MP3 werden angezeigt.
6. Abbrechen stoppt Worker/FFmpeg, erzeugt keine halbfertige finale MP3 und entsperrt das Ziel.
7. Nicht-Admins können Start, Status und Abbruch nicht verwenden.
8. Doppelklick/parallele Requests erzeugen keinen zweiten bezahlten Auftrag.
9. Nach Erfolg erscheint die MP3 im bestehenden Artikel-Player; Reindex-Fehler
   sind von Synthesefehlern unterscheidbar.
10. Änderungen am Scraper und seinem Popup sind nur gemeinsame, getestete
    Hilfsfunktionen; Scrapen funktioniert weiterhin unverändert.

## 10. Kopierbarer Auftrag für die nächste Session

> Integriere den fertigen Node-TTS-Worker aus
> `E:\Code\GPT-4o-Mini-TTS-helper\src\markdown_tts_compact\node` in
> `C:\Users\ralfb\Documents\Code\WebArchiv` unter `tts/`.
> Lies zuerst diese INTEGRATION.md und die dort genannten aktuellen Website-Dateien.
> Der Worker soll wie `scraper/scrape_all.js` per Child-Spawn laufen. Verwende
> den getesteten Adapter `spawn_tts.cjs`, einen serverseitig festgelegten MP3-Ausgabepfad
> und Admin-geschützte Start-/Status-/Abbruch-Endpunkte. Ergänze am Artikel eine
> Aktion „Audio erzeugen“ und ein eigenes Popup nach dem bestehenden Scrape-Popup:
> laufende CLI-Meldungen, Chunk-Status, Schließen ohne Abbruch, separater Abbruch,
> Wiederöffnen und MP3-Link nach koordiniertem Reindex. Übernimm Autorenzugriffsrechte
> und Session-Schutz. Prüfe zunächst mit simulierten TTS-Antworten und echten
> Child-Prozessen; führe keine kostenpflichtigen OpenAI-Aufrufe ohne meine Freigabe aus.
> Halte Python-Worker und bestehende Scrape-Funktion funktionsfähig.

## Quellen für die Prozess- und Parserverträge

- [Node.js Child Process](https://nodejs.org/api/child_process.html): `spawn`, Pipes,
  `close`, `error`, IPC und Prozessbeendigung.
- [markdown-it](https://github.com/markdown-it/markdown-it): CommonMark-Preset und Tokens.
- [markdown-it-footnote](https://github.com/markdown-it/markdown-it-footnote): Fußnoten-Erkennung.

Das API-Payload und der SSE-Vertrag wurden aus der lokal bereits funktionierenden
Python-Compact-Fassung übernommen. Die vorhandenen WebArchiv-Dateien sind die
maßgebliche Referenz für Authentifizierung, Indexaktualisierung und Popup-Stil.
