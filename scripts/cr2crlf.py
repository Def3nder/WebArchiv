#!/usr/bin/env python3
"""Ersetzt alle einzelnen CR (\\r) in Textdateien durch CRLF (\\r\\n).

Bereits vorhandene CRLF bleiben unverändert (kein \\r\\r\\n). Reine LF bleiben LF.
Die Dateien werden binär verarbeitet, die Kodierung bleibt also unangetastet.

Aufruf:
  python scripts/cr2crlf.py eingabe.txt             # überschreibt eingabe.txt
  python scripts/cr2crlf.py eingabe.txt -o aus.txt  # schreibt in aus.txt
  python scripts/cr2crlf.py -d ordner               # alle *.md in ordner (überschreibt)
  python scripts/cr2crlf.py -d ordner -r --glob "*.txt"  # rekursiv, nur *.txt
"""
import argparse
import re
import sys
from pathlib import Path

CR_RE = re.compile(rb"\r(?!\n)")


def convert(src: Path, dst: Path) -> int:
    data = src.read_bytes()
    result, count = CR_RE.subn(b"\r\n", data)
    # Unveränderte Dateien nicht neu schreiben (außer bei separater Ausgabedatei).
    if count or dst != src:
        dst.write_bytes(result)
    return count


def main():
    ap = argparse.ArgumentParser(description="Ersetzt alle CR durch CRLF.")
    ap.add_argument("input", nargs="?", help="Eingabedatei")
    ap.add_argument("-o", "--out", help="Ausgabedatei (nur mit Einzeldatei; Standard: überschreiben)")
    ap.add_argument("-d", "--dir", help="Verzeichnis: alle passenden Dateien darin bearbeiten")
    ap.add_argument("-r", "--recursive", action="store_true", help="mit --dir: auch Unterverzeichnisse")
    ap.add_argument("--glob", default="*.md", help='mit --dir: Dateimuster (Standard: "*.md")')
    args = ap.parse_args()

    if bool(args.input) == bool(args.dir):
        ap.error("Entweder eine Eingabedatei ODER --dir angeben.")

    if args.dir:
        if args.out:
            ap.error("--out ist mit --dir nicht möglich.")
        root = Path(args.dir)
        if not root.is_dir():
            ap.error(f"Kein Verzeichnis: {root}")
        files = sorted(p for p in (root.rglob if args.recursive else root.glob)(args.glob) if p.is_file())
        total = changed = 0
        for p in files:
            n = convert(p, p)
            total += n
            if n:
                changed += 1
                print(f"{n:6d}  {p}")
        print(f"{len(files)} Dateien geprüft, {changed} geändert, {total} CR ersetzt.", file=sys.stderr)
    else:
        src = Path(args.input)
        dst = Path(args.out) if args.out else src
        n = convert(src, dst)
        print(f"{n} CR durch CRLF ersetzt -> {dst}", file=sys.stderr)


if __name__ == "__main__":
    main()
