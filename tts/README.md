# TTS-Module des WebArchivs

Dieses Verzeichnis gehört zum **WebArchiv-Gerät**. Es enthält die Node.js-Module,
die TTS-Aufträge verwalten und den separaten Qwen-TTS-Server über HTTP aufrufen.

Hierzu gehören insbesondere:

- Auftragsverwaltung und Worker (`jobs.cjs`, `worker.cjs`)
- Qwen-HTTP-Client und Provider (`qwen-http.js`, `qwen-provider.js`)
- Verwaltung der globalen TTS-Einstellungen (`voice-settings.cjs`)
- lokal gespeicherte, per Voice-SHA-256 geprüfte Hörproben unter
  `../tts-voice-previews/` (oder `TTS_VOICE_PREVIEW_DIR`)
- WebArchiv-seitige Tests unter `test/`

Der Python-Dienst, sein Startskript, seine Server-Tests und die Verwaltung der
Voice-Dateien gehören nicht auf dieses Gerät. Sie liegen im Repository unter
[`../tts-server/`](../tts-server/README.md) und werden auf dem separaten
Qwen-TTS-Gerät bereitgestellt.

