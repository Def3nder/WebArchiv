# Dubletten-Werkzeug

Eigenständige kleine Website, die Markdown-Artikel aus zwei Ordnern vergleicht und
Dubletten aus Ordner B in einen Ziel-Ordner verschiebt. Erkennung und Vergleichsansicht
stammen aus dem WebArchiv (`duplicates.cjs`, `public/duplicates.js`,
`public/duplicate-diff.js`), das Werkzeug hat aber eigene `node_modules` und läuft
unabhängig vom WebArchiv-Server.

## Start

```bash
cd duplicates-tool
npm install
npm start          # http://localhost:3100
npm test
```

## Bedienung

- Einen oder mehrere **Original-Ordner** (A1, A2 … – „+ Weiterer Original-Ordner“, ✕ entfernt eine Zeile),
  **Ordner B (Kandidaten)** und **Ziel-Ordner** eintragen oder per „Durchsuchen …“ wählen, dann
  „Speichern & scannen“. Die Original-Ordner werden gemeinsam als Seite A behandelt. Alle Ordner werden rekursiv gelesen
  (versteckte Ordner, `node_modules` und ein Ziel-Ordner innerhalb von B werden übersprungen).
- Verglichen werden nur Paare A↔B. Pro Kandidat aus B werden höchstens drei Originale gezeigt.
  Der Text wird wie im WebArchiv geparst: Titel/Datum/Zusammenfassung aus dem Kopf, verglichen
  wird der Body nach dem `****`/`----`-Trenner; Titel und Datum fließen in den Score ein.
- Zwei Arten von Treffern: **wortgleich** (gemeinsame 5-Wort-Folgen, wie im WebArchiv) und
  **inhaltlich ähnlich** (TF-IDF-Kosinus über Inhaltswörter ohne Füllwörter, unabhängig von Titel
  und Wortreihenfolge). So werden auch umformulierte Texte mit anderem Titel gefunden. Die
  Schwelle „Inhaltl. Ähnlichkeit ab (%)“ steuert das: kleiner = mehr Treffer, 100 = aus.
- **Suche (alle Tabs)** grenzt Offen, Ignoriert und Verschoben gleichzeitig ein (alle Suchwörter
  müssen in Titel, Pfad, Ordnername oder Textanfang vorkommen); die Tabs zeigen dann „Treffer / gesamt“.
  „Übereinstimmung“ und „Trefferart“ filtern zusätzlich Offen und Ignoriert.
- **Prüfen** öffnet die Diff-Ansicht (Wortunterschiede, „Nur Unterschiede“ klappt Gleiches ein).
- **Ignorieren** speichert die Entscheidung in `data/decisions.json`; ändert sich einer der
  beiden Texte, ist der Treffer wieder offen.
- **B verschieben** / **Ausgewählte verschieben** bewegt die `.md` aus B samt Begleitdateien
  (`foo.*` und Infografik-Varianten `foo_1.*`, sofern es keine eigene `foo_1.md` gibt) in den
  Ziel-Ordner. Die Unterordner-Struktur von B wird nachgebildet; bei Namenskonflikten bekommt
  die ganze Gruppe ein Suffix (`foo (2).md`, `foo (2).jpg`, `foo (2)_1.jpg`). Jede Verschiebung
  steht im Tab „Verschoben“ (`data/moves.json`) und lässt sich rückgängig machen.

## Konfiguration

`config.json` (gitignored, wird von der Oberfläche geschrieben; Vorlage: `config.example.json`):

| Schlüssel | Bedeutung | Standard |
| --- | --- | --- |
| `originals` | Liste der Original-Ordner (alte Konfigs mit `folderA` werden übernommen) | leer |
| `folderB`, `target` | Kandidaten- und Ziel-Ordner | leer |
| `recentFolderB`, `recentTargets` | Die letzten fünf verwendeten B- bzw. Ziel-Ordner (Aufklappliste beim Eingeben) | wird automatisch gepflegt |
| `host` | Bind-Adresse | `127.0.0.1` |
| `port` | Port | `3100` |
| `minimumTokens` | Mindestwörter je Text | `35` |
| `maxDateDistanceDays` | Max. Datumsabstand für Teiltreffer | `730` |
| `minContentSimilarity` | Mindest-Ähnlichkeit (%) für inhaltliche Treffer, 100 = aus | `45` |

Umgebungsvariablen: `PORT`, `HOST`, `DUPLICATES_TOOL_CONFIG` (Pfad zur Konfig),
`DUPLICATES_TOOL_DATA` (Ordner für Entscheidungen und Protokoll).

Es gibt keinen Login. Der Server bindet standardmäßig nur an `127.0.0.1` und lehnt
API-Anfragen mit fremdem Host-Header oder fremder Origin ab.
