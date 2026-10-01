# epub-tool – EPUB → Markdown für Hörbuch-eBooks

Wandelt ein EPUB einmalig (offline, auf dem eigenen Rechner) in die `.md` um, die der Hörbuch-Reader
(`public/book-reader.js`) als „Text lesen“ anzeigt. Eigenes Paket mit eigenen Abhängigkeiten
(`adm-zip`, `htmlparser2`); die App und der Server brauchen davon nichts und bleiben unverändert.

```bash
cd epub-tool && npm install                       # einmalig
node epub-tool/epub-to-md.js "Autor - Titel.epub" --out "audio/Hoerbuecher/Autor - Titel"
node epub-tool/epub-to-md.js "Autor - Titel.epub" --dry-run      # nur prüfen, nichts schreiben
npm test --prefix epub-tool
```

Ergebnis: `<Ordner>/<Name>.md` plus `<Ordner>/images/*`. Name = Name des Zielordners (so findet der Reader die
Datei: `<Buchordner>/<Buchordner>.md`); ohne `--out` entsteht ein Ordner neben dem EPUB. Vorhandene Dateien
werden nur mit `--force` überschrieben. Danach im Admin-Menü neu einlesen (Reindex). `cover.*` wird nicht
angelegt; das Hörbuch-Cover bleibt, wie es ist.

## Was umgewandelt wird

| EPUB | Markdown |
|---|---|
| Lesereihenfolge (Spine) | alle Kapitel nacheinander |
| Inhaltsverzeichnis (nav oder ncx) | Liste `- [Titel](#a-12)`, eingerückt nach Ebene; das veröffentlichte Verzeichnis-Kapitel entfällt, Platzhalter wie `[Cover]` und Einträge ohne Ziel auch |
| Interne Verweise | `[Text](#a-12)`; das Ziel bekommt `<a id="a-12"></a>` (Überschriften tragen ihn selbst). Verweis ohne Ziel → einfacher Text, Hinweis in der Ausgabe |
| Fuß-/Endnoten | im Text `<a id="ref-3"></a><sup>[3](#anm-3)</sup>`, am Ende „Anmerkungen“ mit `<a id="anm-3"></a>**3.** … [↩](#ref-3)` (Format der vorhandenen Bücher). Erkannt über `epub:type`/`role` (noteref, footnote, endnote) oder – ohne Auszeichnung – über kurze Marke in `<sup>` mit Rücksprung in der Note |
| Bilder | nach `images/` (flach, Namen bereinigt), `![alt](images/x.jpg)` |
| Überschriften, Absätze, Listen, Zitate, Tabellen, Code | Markdown; Hervorhebungen mit `*`/`**`, wo CommonMark sie versteht, sonst `<em>`/`<strong>` |
| Fett/Kursiv aus CSS-Klassen (Calibre `span.bold`) | werden ausgelesen; ein fetter Absatz, auf den das Inhaltsverzeichnis zeigt, wird zur Überschrift |

Nicht übernommen: Schriften, Farben, Seitenlayout, Audio/Video, eingebettete Bilder (`data:`), mathematische
Formeln als Bild/MathML.

## Prüfung

Die Ausgabe nennt Kapitel, Inhaltsverzeichnis-Einträge, Anmerkungen, Bilder und die Zahl der Verweise ohne
Ziel (soll 0 sein) sowie Warnungen (fehlende Bilder/Kapitel). Die Tests bauen kleine EPUBs selbst
(Inhaltsverzeichnis, Verweise, Endnoten, Fußnoten ohne Auszeichnung, Calibre-Stil, Randfälle der Hervorhebung).
Mit sieben echten Büchern geprüft (Verlags-EPUB mit Endnoten, Calibre-Konvertierungen): alle Verweise und
Bilder lösen sich auf; „Komm, wie du willst“ stimmt bis auf zwei von Hand geänderte Stellen wortgleich mit der
bisherigen Datei überein (171 Verweise, 203 Anmerkungen).
