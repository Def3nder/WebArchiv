# Separater Qwen-TTS-Server

Dieses Verzeichnis ist das Deployment-Paket für das **separate Qwen-TTS-Gerät**.
Es wird nicht durch den Node.js-Prozess des WebArchivs gestartet oder lokal
ausgeführt.

Enthalten sind:

- `qwen_http_service.py` – HTTP-Dienst einschließlich Voice-Verwaltung
- `qwen_chunk_worker.py` – isolierter Prozess für die Audioerzeugung
- `start_qwen_tts_service.cmd` – Starthelfer auf dem Qwen-Gerät
- `Test-QwenServer.ps1` – HTTP-Smoke-Test
- `test/` – Python-Tests des separaten Dienstes
- `QWEN-ANBINDUNG.md` – Installation, Konfiguration und Betrieb

Die erzeugten Voice-Dateien werden ausschließlich im `voices`-Verzeichnis der
auf diesem Gerät installierten `faster-qwen3-tts`-Instanz gespeichert. Das
WebArchiv speichert die ausgewählte Voice-ID und lokal erzeugte Hörproben,
jedoch keine `.pt`-Datei. Es kommuniziert mit diesem Dienst über dessen
konfigurierte Basis-URL.

Die WebArchiv-seitigen Node.js-Module und Tests bleiben unter
[`../tts/`](../tts/README.md).
