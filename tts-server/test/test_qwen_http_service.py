"""Offline-Vertragstests mit simuliertem CLI-Generator; kein Modellimport."""
import base64
import hashlib
import json
import io
import os
import sys
import wave
from pathlib import Path
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import uuid
TTS_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TTS_ROOT))
from qwen_chunk_worker import ChunkProgressRelay, generate_article
from http.server import ThreadingHTTPServer
from qwen_http_service import (GpuCoordinator, Jobs, Log, ServerSettings, VoiceCatalog, VoiceJobs,
                               handler, LEASE)


class ServiceFixture(unittest.TestCase):
    log_level = None

    def setUp(self):
        self.output = io.StringIO()
        self.log = None if self.log_level is None else Log(self.log_level, stream=self.output)
        self.temp = tempfile.TemporaryDirectory(prefix="qwen-offline-")
        script = Path(self.temp.name) / "fake.py"
        script.write_text('''import sys, time, json
from pathlib import Path
print(json.dumps({"type": "ready", "seed": 123}), flush=True)
for line in sys.stdin:
    command = json.loads(line)
    text = Path(command["input"]).read_text(encoding="utf-8")
    if text == "wait": time.sleep(60)
    if text == "fail":
        print("RuntimeError: CUDA out of memory", file=sys.stderr, flush=True)
        sys.exit(1)
    if text == "progress":
        print(json.dumps({"type": "progress", "id": command["id"], "message": "Chunk 1/2: 338/520 characters (boundary: sentence)"}), flush=True)
        print(json.dumps({"type": "progress", "id": command["id"], "message": "Chunk 2/2: 346/520 characters (boundary: paragraph)"}), flush=True)
    Path(command["output"]).write_bytes(b"simulated-mp3")
    print(json.dumps({"type": "result", "id": command["id"], "seed": 124 if text == "drift" else 123}), flush=True)
''')
        self.config = Path(self.temp.name) / "qwen_http_service_config.json"
        self.config.write_text("{}", encoding="utf-8")
        self.settings = ServerSettings(self.config)
        self.jobs = Jobs(script, self.config, worker=script, log=self.log)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler(self.jobs, "test-token", settings=self.settings))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/v1/"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.jobs.close()
        self.temp.cleanup()

    def request(self, route, method="GET", data=None, token="test-token"):
        if data is not None and set(data) == {"text"}:
            data = {"markdown": data["text"]}
        req = urllib.request.Request(self.url + route, method=method,
            data=None if data is None else json.dumps(data).encode(),
            headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=10) as response:
            return response.read()

    def wait(self, job_id):
        for _ in range(100):
            state = json.loads(self.request("jobs/" + job_id))
            if state["status"] != "running":
                return state
            time.sleep(.02)
        self.fail("Generator läuft zu lange")

    def wait_for_log(self, needle):
        # Der Server protokolliert eine Anfrage erst, nachdem der Client die Antwort hat.
        for _ in range(100):
            if needle in self.output.getvalue():
                break
            time.sleep(.02)
        return self.output.getvalue()


class Contract(ServiceFixture):

    def test_success_auth_idempotence_and_download(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request("health", token="wrong")
        self.assertEqual(error.exception.code, 401)
        health = json.loads(self.request("health"))
        self.assertEqual(health["protocol"], "webarchiv-qwen-v5")
        self.assertTrue(health["full_markdown"])
        self.assertEqual(health["audio_format"], "mp3")
        self.assertTrue(health["chunk_progress"])
        self.assertTrue(health["server_settings"])
        job_id = str(uuid.uuid4())
        for _ in range(2):
            self.request("jobs/" + job_id, "PUT", {"text": "Hallo"})
        self.assertEqual(self.wait(job_id)["status"], "succeeded")
        self.assertEqual(self.request(f"jobs/{job_id}/audio"), b"simulated-mp3")
        self.request("jobs/" + job_id, "DELETE")
        self.assertFalse(self.jobs.jobs[job_id]["directory"].exists())

    def test_server_settings_endpoint_updates_only_managed_values(self):
        current = json.loads(self.request("settings"))
        self.assertEqual(current["settings"]["target_chunk_chars"], 340)
        changed = dict(current["settings"])
        changed["target_chunk_chars"] = 360
        changed["silence_threshold_db"] = -47.5
        result = json.loads(self.request("settings", "PUT", changed))
        self.assertEqual(result["settings"], changed)
        self.assertEqual(json.loads(self.config.read_text(encoding="utf-8"))["target_chunk_chars"], 360)

        changed["min_chunk_chars"] = 400
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request("settings", "PUT", changed)
        self.assertEqual(error.exception.code, 400)

    def test_cancel_busy_and_late_start(self):
        job_id = str(uuid.uuid4())
        self.request("jobs/" + job_id, "PUT", {"text": "wait"})
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request("jobs/" + str(uuid.uuid4()), "PUT", {"text": "Hallo"})
        self.assertEqual(error.exception.code, 409)
        self.request("jobs/" + job_id, "DELETE")
        self.assertIsNotNone(self.jobs.jobs[job_id]["process"].poll())
        other = str(uuid.uuid4())
        self.request("jobs/" + other, "DELETE")
        with self.assertRaises(urllib.error.HTTPError):
            self.request("jobs/" + other, "PUT", {"text": "Hallo"})

    def test_lease_and_failed_generator(self):
        job_id = str(uuid.uuid4())
        self.request("jobs/" + job_id, "PUT", {"text": "wait"})
        self.jobs.jobs[job_id]["touched"] -= LEASE + 1
        self.jobs.sweep()
        self.assertEqual(self.jobs.status(job_id)["status"], "cancelled")
        failed = str(uuid.uuid4())
        self.request("jobs/" + failed, "PUT", {"text": "fail"})
        self.assertEqual(self.wait(failed)["status"], "failed")
        with self.assertRaises(urllib.error.HTTPError):
            self.request(f"jobs/{failed}/audio")

    def test_article_limit_rejected_before_process(self):
        with self.assertRaises(urllib.error.HTTPError):
            self.request("jobs/" + str(uuid.uuid4()), "PUT", {"text": "x" * 1_000_001})
        self.assertEqual(len(self.jobs.jobs), 0)

    def test_original_markdown_bytes_preserved(self):
        job_id = str(uuid.uuid4())
        markdown = "\ufeff# Titel\r\nDatum: 2026-09-17\r\n**Text** 😀\r\n" * 200
        self.request("jobs/" + job_id, "PUT", {"markdown": markdown})
        self.assertEqual(self.wait(job_id)["status"], "succeeded")
        source = self.jobs.jobs[job_id]["directory"] / "input.md"
        self.assertEqual(source.read_bytes(), markdown.encode("utf-8"))
        self.assertEqual(self.jobs.jobs[job_id]["output"].suffix, ".mp3")

    def test_chunk_progress_is_numbered_and_returned_unchanged(self):
        job_id = str(uuid.uuid4())
        self.request("jobs/" + job_id, "PUT", {"text": "progress"})
        state = self.wait(job_id)
        self.assertEqual(state["status"], "succeeded")
        self.assertEqual(state["progress"], [
            {"sequence": 1, "message": "Chunk 1/2: 338/520 characters (boundary: sentence)"},
            {"sequence": 2, "message": "Chunk 2/2: 346/520 characters (boundary: paragraph)"},
        ])


class ConsoleLogDefault(ServiceFixture):
    """Ohne --debug: nur neuer Auftrag, fertige MP3 (bzw. Abbruch/Fehler/Ablehnung) und Leerzeile."""
    log_level = 0

    def lines(self):
        return [line.split("] ", 1)[-1] for line in self.output.getvalue().splitlines()]

    def test_only_received_and_created_followed_by_blank_line(self):
        self.request("health")
        job_id = str(uuid.uuid4())
        self.request("jobs/" + job_id, "PUT", {"markdown": "# Mein Titel\nDatum: 2026-11-06\nText"})
        self.assertEqual(self.wait(job_id)["status"], "succeeded")
        self.request(f"jobs/{job_id}/audio")
        self.request("jobs/" + job_id, "DELETE")
        text = self.output.getvalue()
        self.assertEqual(self.lines(), [
            f'Neuer Auftrag erhalten [{job_id[:8]}]: "Mein Titel" (35 Zeichen, Standardstimme)',
            self.lines()[1], "",
        ], text)
        self.assertRegex(self.lines()[1], r'^MP3 erstellt \[\w{8}\]: "Mein Titel" \(13 Bytes, Dauer \d+ s\)$')
        self.assertTrue(text.endswith("\n\n"))
        self.assertNotIn("test-token", text)

    def test_rejected_job_with_reason(self):
        running = str(uuid.uuid4())
        self.request("jobs/" + running, "PUT", {"text": "wait"})
        with self.assertRaises(urllib.error.HTTPError):
            self.request("jobs/" + str(uuid.uuid4()), "PUT", {"text": "Hallo"})
        with self.assertRaises(urllib.error.HTTPError):
            self.request("jobs/" + str(uuid.uuid4()), "PUT", {"text": "Hallo"}, token="falsch")
        text = self.output.getvalue()
        self.assertIn("ABGELEHNT", text)
        self.assertIn(f"Dienst belegt: Auftrag [{running[:8]}]", text)
        self.assertIn("-> 401", text)
        self.assertIn("Token stimmt nicht", text)
        self.assertNotIn("falsch", text)

    def test_failure_shows_last_worker_message(self):
        job_id = str(uuid.uuid4())
        self.request("jobs/" + job_id, "PUT", {"text": "fail"})
        self.assertEqual(self.wait(job_id)["status"], "failed")
        text = self.wait_for_log("FEHLER")
        self.assertIn("FEHLER: Auftrag fehlgeschlagen", text)
        self.assertIn("Exit 1", text)
        self.assertIn("Letzte Meldung: RuntimeError: CUDA out of memory", text)

    def test_lease_expiry_is_reported_as_cancel(self):
        job_id = str(uuid.uuid4())
        self.request("jobs/" + job_id, "PUT", {"text": "wait"})
        self.jobs.jobs[job_id]["touched"] -= LEASE + 1
        self.jobs.sessions[job_id]["touched"] -= LEASE + 1
        self.jobs.sweep()
        self.assertIn("Auftrag abgebrochen", self.output.getvalue())
        self.assertIn("keine Statusabfrage", self.output.getvalue())


class ConsoleLogDebug1(ServiceFixture):
    log_level = 1

    def test_requests_and_steps_without_status_polls(self):
        self.request("health")
        job_id = str(uuid.uuid4())
        self.request("jobs/" + job_id, "PUT", {"text": "progress"})
        self.wait(job_id)
        self.request(f"jobs/{job_id}/audio")
        text = self.wait_for_log("ausgeliefert")
        self.assertIn("HTTP GET /v1/health von 127.0.0.1 -> 200", text)
        self.assertIn(f"HTTP PUT /v1/jobs/{job_id} von 127.0.0.1 -> 202", text)
        self.assertIn("MP3 13 Bytes ausgeliefert", text)
        self.assertIn("2 Chunks", text)
        self.assertNotIn(f"HTTP GET /v1/jobs/{job_id} ", text)  # Statusabfragen erst ab Level 2
        self.assertNotIn("Fortschritt [", text)


class ConsoleLogDebug3(ServiceFixture):
    log_level = 3

    def test_polls_progress_headers_and_commands_without_token(self):
        job_id = str(uuid.uuid4())
        self.request("jobs/" + job_id, "PUT", {"text": "progress"})
        self.wait(job_id)
        text = self.output.getvalue()
        self.assertIn(f"HTTP GET /v1/jobs/{job_id} ", text)
        self.assertIn("Fortschritt [", text)
        self.assertIn("Authorization: Bearer ***", text)
        self.assertIn("Worker-Befehl:", text)
        self.assertNotIn("test-token", text)


class OriginalScript(unittest.TestCase):
    def test_progress_relay_passes_model_messages_only_to_stderr(self):
        protocol, passthrough = io.StringIO(), io.StringIO()
        relay = ChunkProgressRelay(protocol, "job-id", passthrough=passthrough)
        relay.write("Prefill length: 115 tokens\nChunk 1/2: 300/520 characters (boundary: sentence)\n")
        relay.finish()
        self.assertEqual(passthrough.getvalue(), "Prefill length: 115 tokens\n")
        self.assertEqual(len(protocol.getvalue().splitlines()), 1)

    def test_progress_relay_discards_everything_except_chunk_starts(self):
        protocol = io.StringIO()
        relay = ChunkProgressRelay(protocol, "job-id")
        relay.write("Prefill length: 115 tokens\n")
        relay.write("Chunk 3/26: 346/520 characters ")
        relay.write("(boundary: paragraph)\nSaved C:/teil-003.wav\n")
        relay.finish()
        self.assertEqual([json.loads(line) for line in protocol.getvalue().splitlines()], [{
            "type": "progress", "id": "job-id",
            "message": "Chunk 3/26: 346/520 characters (boundary: paragraph)",
        }])

    def test_exact_cli_arguments_and_original_main(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            script, config, source, output = [root / name for name in ["original.py", "config.json", "input.md", "output.mp3"]]
            config.write_text('{"clear_markdown": true, "seed_strategy": "increment", "mode": "semantic"}')
            markdown = "\ufeff# Original\r\n**Text**\r\n".encode("utf-8")
            source.write_bytes(markdown)
            script.write_text('''import argparse, json
from pathlib import Path
parser = argparse.ArgumentParser()
for key in ["config", "input", "output"]: parser.add_argument("--"+key, required=True)
args = parser.parse_args()
config = json.loads(Path(args.config).read_text())
assert config["clear_markdown"] is True
assert config["seed_strategy"] == "increment"
assert config["mode"] == "semantic"
assert __name__ == "__main__"
Path(args.output).write_bytes(Path(args.input).read_bytes())
raise SystemExit(0)
''')
            generate_article(script, config, source, output)
            self.assertEqual(output.read_bytes(), markdown)

    def test_original_failure_is_not_success(self):
        with tempfile.TemporaryDirectory() as temp:
            script = Path(temp) / "fail.py"
            script.write_text("raise SystemExit(2)")
            with self.assertRaisesRegex(RuntimeError, "Exit 2"):
                generate_article(script, Path(temp)/"config", Path(temp)/"input", Path(temp)/"output")

    def test_original_runs_in_fresh_cli_process(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            script = root / "original.py"
            config, source, output = [root / name for name in ["config.json", "input.md", "output.txt"]]
            config.write_text("{}")
            source.write_text("Hallo")
            script.write_text('''import argparse, os
from pathlib import Path
p = argparse.ArgumentParser()
for key in ["config", "input", "output"]: p.add_argument("--" + key, required=True)
a = p.parse_args()
Path(a.output).write_text(str(os.getpid()))
''')
            generate_article(script, config, source, output)
            self.assertNotEqual(int(output.read_text()), os.getpid())

    def test_selected_speaker_is_the_only_generator_override(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            script = root / "original.py"
            config, source, output, speaker = [root / name for name in ["config.json", "input.md", "output.mp3", "Voice-1.7B.pt"]]
            config.write_text("{}")
            source.write_text("Hallo")
            speaker.write_bytes(b"speaker")
            script.write_text('''import argparse
from pathlib import Path
p=argparse.ArgumentParser()
for key in ["config","input","output","speaker"]: p.add_argument("--"+key, required=True)
a=p.parse_args()
assert Path(a.speaker).name == "Voice-1.7B.pt"
Path(a.output).write_bytes(b"ok")
''')
            generate_article(script, config, source, output, speaker)
            self.assertEqual(output.read_bytes(), b"ok")


class VoiceCatalogTests(unittest.TestCase):
    def test_catalog_lists_only_active_17b_files_and_trashes_instead_of_deleting(self):
        with tempfile.TemporaryDirectory(prefix=".test-voices-", dir=TTS_ROOT / "test") as temp:
            root = Path(temp)
            (root / "Mandy-1.7B.pt").write_bytes(b"voice")
            (root / "Mandy-0.6B.pt").write_bytes(b"old")
            (root / "Mandy.pt").write_bytes(b"fallback")
            catalog = VoiceCatalog(root)
            listed = catalog.list()
            self.assertEqual([voice["id"] for voice in listed], ["Mandy"])
            self.assertEqual(listed[0]["sha256"], hashlib.sha256(b"voice").hexdigest())
            renamed = catalog.rename("Mandy", "Meine Stimme")
            self.assertEqual(renamed["id"], "Meine-Stimme")
            self.assertTrue((root / "Meine-Stimme-1.7B.pt").is_file())
            catalog.trash("Meine-Stimme")
            self.assertFalse((root / "Meine-Stimme-1.7B.pt").exists())
            self.assertEqual(len(list((root / "trash").glob("*/Meine-Stimme-1.7B.pt"))), 1)

    def test_voice_job_adds_17b_suffix_and_publishes_only_finished_embedding(self):
        with tempfile.TemporaryDirectory(prefix=".test-voices-", dir=TTS_ROOT / "test") as temp:
            root = Path(temp)
            extract = root / "examples" / "extract_speaker.py"
            extract.parent.mkdir()
            extract.write_text("# simulated")
            jobs = VoiceJobs(VoiceCatalog(root / "voices"), extract, GpuCoordinator())

            def simulate_process(job, args, _timeout):
                if args[0] == jobs.ffmpeg:
                    with wave.open(str(args[-1]), "wb") as target:
                        target.setnchannels(1)
                        target.setsampwidth(2)
                        target.setframerate(24000)
                        target.writeframes((1000).to_bytes(2, "little", signed=True) * (4 * 24000))
                else:
                    Path(args[-1]).write_bytes(b"embedding" * 700)

            jobs._process = simulate_process
            job_id = str(uuid.uuid4())
            started = jobs.start(job_id, "Meine Stimme", "audio/wav", base64.b64encode(b"input").decode())
            self.assertEqual(started["name"], "Meine-Stimme")
            for _ in range(100):
                result = jobs.status(job_id)
                if result["status"] != "running":
                    break
                time.sleep(0.01)
            self.assertEqual(result["status"], "succeeded")
            self.assertEqual(result["voice"]["id"], "Meine-Stimme")
            self.assertTrue((root / "voices" / "Meine-Stimme-1.7B.pt").is_file())
            for _ in range(100):
                if not list((root / "voices").glob(".webarchiv-voice-*")):
                    break
                time.sleep(0.01)
            self.assertEqual(list((root / "voices").glob(".webarchiv-voice-*")), [])


if __name__ == "__main__":
    unittest.main()
