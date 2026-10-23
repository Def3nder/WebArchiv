#!/usr/bin/env python3
"""Entfernt die Schluss-Floskeln (Joe-Turan-Footer) am Ende von Markdown-Dateien.

Aus
    ...Text.

    Have a nice day

    Joe Turan
     [www.joeturan.com](https://www.joeturan.com)

    Wenn dir mein Content gefällt, unterstütze mich, indem du mir auf Instagram folgst:
    IG: @joeturan1
    Hier geht’s zu meinem Profil:
    [www.instagram.com/joeturan1](https://www.instagram.com/joeturan1)
    Danke

wird
    ...Text.

    Joe Turan

Die Reihenfolge der Footer-Zeilen ist egal. Es wird nur der zusammenhängende Block
bekannter Footer-Zeilen am Dateiende entfernt, und nur, wenn darin "Joe Turan"
vorkommt. Endet eine Datei auf etwas anderes (Hashtags, Quellen, "Photo credit" ...),
bleibt sie unverändert und wird gemeldet. Kodierung und Zeilenenden bleiben erhalten.

Aufruf:
  python scripts/strip_footer.py datei.md
  python scripts/strip_footer.py -d "www/Joe Turan Facebook/2026" [-r] [--glob "*.md"] [--dry-run]
"""
import argparse
import re
import sys
from pathlib import Path

MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")

FOOTER_PATTERNS = [
    r"",                                       # Leerzeile
    r"have a nice day\W*",
    r"joe turan",
    r"(https?://)?(www\.)?joeturan\.com/?",
    r"wenn dir mein content gef.*",
    r"ig:\s*@joeturan1\W*",
    r"hier geht.s zu meinem profil\W*",
    r"(https?://)?(www\.)?instagram\.com/joeturan1/?",
    r"danke\W*",
]
FOOTER_RE = [re.compile(p) for p in FOOTER_PATTERNS]


def normalize(line: str) -> str:
    line = MD_LINK.sub(r"\1", line)
    return line.strip().strip("*_ \t ").strip().lower()


def is_footer(line: str) -> bool:
    n = normalize(line)
    return any(r.fullmatch(n) for r in FOOTER_RE)


def decode(raw: bytes):
    for enc in ("utf-8-sig", "utf-8"):
        try:
            return raw.decode(enc), enc
        except UnicodeDecodeError:
            pass
    return raw.decode("cp1252", errors="replace"), "cp1252"


def process(path: Path, dry_run: bool) -> str:
    """Gibt 'geändert', 'unverändert' oder 'übersprungen' zurück."""
    raw = path.read_bytes()
    text, enc = decode(raw)
    eol = "\r\n" if "\r\n" in text else "\n"
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")

    i = len(lines) - 1
    while i >= 0 and is_footer(lines[i]):
        i -= 1
    block = lines[i + 1:]
    if not any(normalize(l) == "joe turan" for l in block):
        return "übersprungen"

    body = lines[: i + 1]
    while body and not body[-1].strip():
        body.pop()
    new_text = eol.join(body + ["Joe Turan"]) + eol
    if new_text == text:
        return "unverändert"
    if not dry_run:
        path.write_bytes(new_text.encode(enc))
    return "geändert"


def main():
    ap = argparse.ArgumentParser(description="Entfernt Schluss-Floskeln, lässt 'Joe Turan' stehen.")
    ap.add_argument("input", nargs="?", help="Einzelne Datei")
    ap.add_argument("-d", "--dir", help="Verzeichnis: alle passenden Dateien darin bearbeiten")
    ap.add_argument("-r", "--recursive", action="store_true", help="mit --dir: auch Unterverzeichnisse")
    ap.add_argument("--glob", default="*.md", help='mit --dir: Dateimuster (Standard: "*.md")')
    ap.add_argument("-n", "--dry-run", action="store_true", help="nur anzeigen, nichts schreiben")
    args = ap.parse_args()

    if bool(args.input) == bool(args.dir):
        ap.error("Entweder eine Eingabedatei ODER --dir angeben.")

    if args.dir:
        root = Path(args.dir)
        if not root.is_dir():
            ap.error(f"Kein Verzeichnis: {root}")
        files = sorted(p for p in (root.rglob if args.recursive else root.glob)(args.glob) if p.is_file())
    else:
        files = [Path(args.input)]

    counts = {"geändert": 0, "unverändert": 0, "übersprungen": 0}
    for p in files:
        res = process(p, args.dry_run)
        counts[res] += 1
        if res == "übersprungen":
            print(f"übersprungen (Ende ohne bekannten Footer): {p.name}")
    prefix = "[Testlauf] " if args.dry_run else ""
    print(f"{prefix}{len(files)} Dateien: {counts['geändert']} geändert, "
          f"{counts['unverändert']} schon sauber, {counts['übersprungen']} übersprungen.",
          file=sys.stderr)


if __name__ == "__main__":
    main()
