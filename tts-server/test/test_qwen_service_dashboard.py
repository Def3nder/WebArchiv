"""Status, Verlauf, Log-Datei und Dashboard-Bild des Qwen-Dienstes; ohne Konsole und Modell."""
import io
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

TTS_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TTS_ROOT))
from qwen_http_service import Log
from qwen_service_dashboard import (ServiceState, render, compose, PING_FLASH_SECONDS, listen_label,
                                    local_addresses)

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def plain(lines):
    return [ANSI.sub("", line) for line in lines]


class FakeClock:
    def __init__(self, start=1_800_000_000.0):
        self.value = start

    def __call__(self):
        return self.value


class StateAndHistory(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="qwen-dashboard-")
        self.history = Path(self.temp.name) / "qwen_http_service_history.json"
        self.clock = FakeClock()
        self.state = ServiceState(self.history, clock_source=self.clock)
        self.state.set_info(host="0.0.0.0", port=8765, protocol="webarchiv-qwen-v5", pid=42, debug=0,
                            addresses=["192.168.1.65", "192.168.67.1"],
                            log_file="E:/qwen/qwen_http_service.log", lease=90)

    def tearDown(self):
        self.temp.cleanup()

    def run_job(self, job_id="11111111-aaaa-4aaa-8aaa-111111111111", outcome="ok"):
        self.state.job_started(job_id, "Mein Artikel", "Mandy", 4210, pid=7)
        self.state.job_ready(job_id)
        self.clock.value += 10
        self.state.job_progress(job_id, "Chunk 1/3: 300/520 characters (boundary: sentence)")
        self.clock.value += 20
        self.state.job_progress(job_id, "Chunk 2/3: 310/520 characters (boundary: sentence)")
        self.state.worker_line("Prefill length: 115 tokens")
        return job_id

    def test_running_job_with_progress_ping_flash_and_frame_size(self):
        self.state.request("GET", "/v1/health", 200, "192.168.1.10", 1.0)
        job_id = self.run_job()
        self.state.request("GET", f"/v1/jobs/{job_id}", 200, "192.168.1.10", 0.5)
        lines = render(self.state.snapshot(), 120, 30)
        text = "\n".join(plain(lines))
        self.assertEqual(len(lines), 30)
        self.assertTrue(all(len(line) <= 120 for line in plain(lines)), text)
        self.assertIn("192.168.1.65:8765 (alle Schnittstellen)", text)  # statt 0.0.0.0
        self.assertNotIn("0.0.0.0", text)
        self.assertIn("BELEGT", text)
        self.assertIn('"Mein Artikel"', text)
        self.assertIn("Stimme Mandy", text)
        self.assertIn("4.210 Zeichen", text)
        self.assertIn("Chunk 2/3", text)
        # Chunk 1 dauerte 20 s (Modellladen vorher zählt nicht), 2 von 3 noch offen.
        self.assertIn("noch ca. 40 s", text)
        self.assertIn("Prefill length: 115 tokens", text)
        self.assertIn("Health-Check", text)

    def test_ping_flashes_only_shortly(self):
        self.state.request("GET", "/v1/health", 200, "192.168.1.10", 1.0)
        flashing = render(self.state.snapshot(), 120, 30)
        self.clock.value += PING_FLASH_SECONDS + 1
        calm = render(self.state.snapshot(), 120, 30)
        ping_line = next(i for i, line in enumerate(plain(flashing)) if "PING" in line)
        self.assertIn("\x1b[1;30;102m", flashing[ping_line])  # grün aufblitzen
        self.assertNotIn("\x1b[1;30;102m", calm[ping_line])
        self.state.request("GET", "/v1/health", 401, "192.168.1.20", 1.0, "Nicht autorisiert", "Token falsch")
        bad = render(self.state.snapshot(), 120, 30)
        self.assertIn("\x1b[1;97;41m", bad[ping_line])  # rot bei 401
        self.assertIn("1× nicht autorisiert", "\n".join(plain(bad)))

    def test_history_is_persisted_and_survives_restart(self):
        job_id = self.run_job()
        self.state.job_finished(job_id, "ok", size=3_500_000)
        self.state.job_fetched(job_id)
        self.state.job_rejected("22222222-bbbb-4bbb-8bbb-222222222222", "Zweiter", "HTTP 409: Dienst belegt",
                                "192.168.1.10")
        self.state.job_started("33333333-cccc-4ccc-8ccc-333333333333", "Dritter", None, 10)
        self.state.job_finished("33333333-cccc-4ccc-8ccc-333333333333", "failed", reason="CUDA out of memory")
        stored = json.loads(self.history.read_text(encoding="utf-8"))
        self.assertEqual([entry["outcome"] for entry in stored], ["ok", "rejected", "failed"])
        self.assertTrue(stored[0]["fetched"])
        self.assertEqual(stored[0]["chunks"], 3)

        restarted = ServiceState(self.history, clock_source=self.clock)
        restarted.set_info(host="0.0.0.0", port=8765)
        text = "\n".join(plain(render(restarted.snapshot(), 140, 30)))
        self.assertIn("heute 1 OK, 1 Fehler, 0 Abbruch, 1 abgelehnt", text)
        self.assertIn("Kein Auftrag", text)
        self.assertIn("FREI", text)
        self.assertIn("CUDA out of memory", text)
        self.assertIn("Dienst belegt", text)
        self.assertIn("3.3 MB", text)
        self.assertIn("abgeholt", text)
        # Neueste Einträge oben
        self.assertLess(text.index('"Dritter"'), text.index('"Mein Artikel"'))

    def test_broken_history_file_does_not_stop_the_service(self):
        self.history.write_text("{kaputt", encoding="utf-8")
        state = ServiceState(self.history)
        self.assertIn("Verlauf nicht lesbar", state.history_error)
        self.assertIn("Verlauf nicht lesbar", "\n".join(plain(render(state.snapshot(), 120, 20))))

    def test_small_terminal_still_renders_exact_height(self):
        for job in range(30):
            self.state.job_rejected(f"{job:08d}-bbbb-4bbb-8bbb-222222222222", f"Artikel {job}", "HTTP 401", "x")
        for index in range(50):
            self.state.add_event(1, self.clock(), f"Ereignis {index}")
        for height in (12, 24, 60):
            lines = render(self.state.snapshot(), 80, height)
            self.assertEqual(len(lines), height)
            self.assertTrue(all(len(line) <= 80 for line in plain(lines)))
        text = "\n".join(plain(render(self.state.snapshot(), 80, 40)))
        self.assertIn("Ereignis 49", text)
        self.assertIn("Artikel 29", text)

    def test_listen_address_instead_of_wildcard(self):
        self.assertEqual(listen_label("0.0.0.0", 8765, ["192.168.1.200", "172.17.144.1"]), "192.168.1.200:8765")
        self.assertEqual(listen_label("0.0.0.0", 8765, []), "0.0.0.0:8765")  # kein Netz: Bindung bleibt sichtbar
        self.assertEqual(listen_label("127.0.0.1", 8765, ["192.168.1.200"]), "127.0.0.1:8765")
        addresses = local_addresses()
        self.assertEqual(len(addresses), len(set(addresses)))
        self.assertFalse([a for a in addresses if a.startswith(("127.", "169.254.", "0."))], addresses)
        # Adresswechsel (WLAN -> Ethernet) erscheint im Kopf, sobald der Dienst ihn meldet.
        self.state.set_info(addresses=["192.168.1.200"])
        self.assertIn("192.168.1.200:8765", "\n".join(plain(render(self.state.snapshot(), 120, 30))))

    def test_compose_truncates_visible_text_only(self):
        line = compose([("abc", "\x1b[92m"), ("defghij", "")], 6)
        self.assertEqual(ANSI.sub("", line), "abcde…")


class LogFile(unittest.TestCase):
    def test_file_gets_details_console_only_default_and_rotates(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "qwen.log"
            console = io.StringIO()
            events = []
            log = Log(0, stream=console, file=path, sink=lambda *event: events.append(event), max_bytes=300)
            log(0, "Neuer Auftrag erhalten")
            log(1, "HTTP GET /v1/health -> 200")
            log(2, "Statusabfrage")
            log(0, "MP3 erstellt", blank=True)
            for index in range(20):
                log(1, f"Zeile {index} " + "x" * 40)
            log.close()
            self.assertNotIn("HTTP GET", console.getvalue())
            self.assertIn("MP3 erstellt", console.getvalue())
            self.assertTrue(path.exists())
            self.assertTrue(Path(f"{path}.1").exists())
            self.assertFalse(Path(f"{path}.4").exists())
            all_text = "".join(p.read_text(encoding="utf-8") for p in Path(temp).glob("qwen.log*"))
            self.assertIn("Zeile 19", all_text)
            self.assertNotIn("Statusabfrage", all_text)  # Level 2 nur mit --debug 2
            self.assertIn("HTTP GET /v1/health -> 200", [event[2] for event in events])
            self.assertEqual(log.details_hint(), f"(Details im Log: {path.resolve()})")

    def test_dashboard_mode_writes_nothing_to_console(self):
        console = io.StringIO()
        log = Log(1, stream=console, console=False, sink=lambda *_: None)
        log(0, "Neuer Auftrag erhalten", blank=True)
        self.assertEqual(console.getvalue(), "")
        self.assertTrue(log.wants(1))
        self.assertFalse(log.wants(2))


if __name__ == "__main__":
    unittest.main()
