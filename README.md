# WebArchiv

Ressourcenschonender **Artikel-Archiv-Viewer** (Node.js/Express + Vanilla-JS-SPA).
Liest Markdown-Artikel samt Bildern, Videos und PDFs aus `www/`; Artikel-MP3s sowie
Hörbücher mit ihren Extras liegen im parallelen `audio/`-Baum. Die Inhalte werden
im Speicher indexiert (gewichtete Suche über Titel, Episodennummer, Autor,
Kategorien und Auszug; keine Suche über den gesamten Artikeltext) und
über eine schlanke Single-Page-App mit Login/Rechteverwaltung bereit. Optional
lassen sich neue Artikel per integriertem Scraper (Blog/Facebook/Telegram)
direkt aus dem Web-UI nachladen.

Deployment-Ziel ist ein kleiner Proxmox-**LXC-Container (Debian)** hinter einem
Reverse Proxy — die Details dazu stehen in `LXC-container node.js Setup.txt`.

---

## Architektur

```
Browser (SPA: public/index.html + app.js + styles.css)
    │  fetch /api/*
    ▼
Express-Server (server.js, CommonJS)
    ├── In-Memory-Index (articles[], Fuse.js)   ← buildIndex() scannt www/
    ├── Auth (express-session + bcryptjs, users.json)
    ├── /files/*, /audio-files/*  geschützte Medien (ACL pro Autor)
    ├── /a/*, /og-image/*  Link-Vorschau (Open Graph)
    └── /api/scrape  → spawnt scraper/scrape_all.js (eigener Prozess)
    ▼
Datenablage: www/<Autor>/<Jahr>/<Artikel>.md (+ Bild/Video/PDF)
             audio/<Autor>/<Jahr>/<Artikel>.mp3
             audio/Hoerbuecher/<Buch>/… (Tracks, eBook, Extras)
```

- **Backend**: `server.js` ist die zentrale Express-4-Anwendung; ergänzende
  CommonJS-Module übernehmen u. a. Editor, Hörbücher, Dubletten und TTS-Aufträge.
  Für den normalen Serverstart gibt es keinen Build-Schritt. Geänderte Quellen des
  Markdown-Editors bzw. der Dubletten-Diff-Anzeige müssen jedoch mit
  `npm run build:editor` bzw. `npm run build:duplicate-diff` gebündelt werden.
- **Frontend**: statische SPA unter `public/` (kein Framework), Hash-Routing (`#/article/<id>`), Cache-Busting per `?v=N`.
  Die aktuelle Ansicht wird pro Benutzer auf dem Gerät gespeichert: Suche, Filter, Seite, Layout,
  Listenposition sowie geöffneter Artikel bzw. Hörbuch-/eBook-Reader werden nach einem vollständigen
  Browser- oder PWA-Neustart wiederhergestellt. Ein neu aufgerufener Artikel-Link hat Vorrang;
  ein von der App selbst hinterlassener Artikel-Hash dagegen nicht. Nach der Anmeldung ersetzt
  der persönliche Speicherstand eine zuvor geöffnete Gastansicht; ein geschützter, ausdrücklich
  aufgerufener Artikellink bleibt bis zur Anmeldung vorgemerkt.
  Beim Abmelden wird der lokale Sitzungsstand des Benutzers gelöscht.
- **PWA-Aktualisierung**: Änderungen an den Frontend-Dateien werden automatisch erkannt. Eine
  installierte Web-App zeigt „Neue Version verfügbar“ und übernimmt sie über „Jetzt aktualisieren“
  ohne Löschen oder erneutes Anlegen des Home-Screen-Symbols. Der Update-Worker cached selbst keine
  App-Dateien; reguläres Cache-Busting per `?v=N` bleibt maßgeblich.
- **Bedienmenüs (verbindliche UI-Regel)**: Auswahlfilter verwenden auf Touch-Geräten immer
  native `<select>`-Systemmenüs. Auf Desktopgeräten mit Maus/präzisem Zeiger verwenden sie den
  vorhandenen Menü-Typ: `.header-menu` mit `.filter-menu-trigger`, `.header-menu-dropdown` und
  `.header-menu-item`. Beide Varianten halten denselben Filterzustand synchron. Für andere
  Aktionsmenüs bleibt dieser vorhandene ARIA-Menü-Typ maßgeblich; keine eigenen `<details>`-Menüs,
  abweichenden Popup-Stile oder neuen Menükomponenten einführen. Auswahlmenüs verwenden
  `role="menu"` und je nach Verhalten `menuitemradio` oder `menuitemcheckbox` mit `aria-checked`;
  Tastatursteuerung, Escape, Außenklick und Fokus-Rückgabe gehören dazu.
- **Modale Dialoge (verbindliches Muster)**: Neue Dialoge grundsätzlich als natives `<dialog>`
  in `public/index.html` anlegen, mit eindeutiger ID, `aria-labelledby` und sichtbarer
  Überschrift/Schließen-Schaltfläche. Für normale Formulare `.account-dialog`, für breite
  Ansichten zusätzlich `.account-dialog-wide` verwenden; nur den *Inhalt im Dialog* scrollbar
  machen. In der zuständigen Frontend-Datei mit `dialog.showModal()` öffnen und mit
  `dialog.close()` schließen, nicht das `open`-Attribut selbst setzen. Den zuvor aktiven
  Auslöser merken und nach `close` wieder fokussieren; beim Öffnen einen sinnvollen Fokus setzen
  (bei mobilen Auswahlfeldern ggf. den Dialog selbst mit `focus({ preventScroll: true })`,
  siehe `public/settings.js`). Schließen-Schaltfläche, `cancel`/`Esc`, Außenklick und
  Pull-to-Close sollen denselben Schließweg nutzen, damit z. B. eine Rückfrage bei
  ungespeicherten Änderungen immer greift. Beim Außenklick nur schließen, wenn der Klick
  wirklich auf dem `<dialog>`-Hintergrund **außerhalb seiner Begrenzung** liegt; ein Klick
  in den Dialoginhalt darf ihn nicht schließen. Gestapelte Dialoge schließen von oben nach
  unten. Native Dialoge werden durch `syncModalPageScroll()` in `public/app.js` automatisch
  erkannt: `html.modal-open` sperrt die Seite dahinter, bis der letzte Dialog zu ist; innere
  Scrollbereiche bleiben nutzbar. Keine eigene `body.style.overflow`-Sperre pro neuem Dialog
  ergänzen. Nur für besondere bildschirmfüllende Ansichten ein bestehendes Overlay-Muster
  statt `<dialog>` übernehmen; neue solche Overlays zusätzlich in `modalOverlays` registrieren
  und per `hidden` öffnen/schließen. Neue Touch-Dialoge in `PULL_DIALOGS` in `public/app.js`
  eintragen oder bei Sonderfällen `enablePullToClose()` direkt aufrufen. Bei geänderten
  Frontend-Dateien die `?v=`-Kennung in `public/index.html` erhöhen.
- **Pull-to-Close (Touch-Dialoge und Overlays)**: Neue Ansichten verwenden die gemeinsame
  Funktion `enablePullToClose({ scroller, moving, fading, canStart, onClose })` aus `public/app.js`;
  keine eigene Wisch-Erkennung pro Dialog einführen. `moving` ist der gesamte sichtbare Dialog
  bzw. das Panel, damit es dem Finger beim Ziehen nach unten unmittelbar folgt; `fading` kann
  zusätzlich den Hintergrund ausblenden. Die Geste beginnt nur mit einem Finger,
  bei vertikaler Bewegung und wenn der betreffende Scrollbereich ganz oben steht. Eine aktive
  Textauswahl, ein verschobener Zoom-Ausschnitt oder ein noch gescrollter innerer Bereich dürfen
  nicht zum Schließen führen; weitere Ausschlüsse (z. B. Eingabefelder) gehören in `canStart`.
  Beim Loslassen unter 120 px federt die Ansicht zurück. Ab 120 px gleitet sie aus dem Bild;
  danach ruft die Funktion `onClose` auf. Auch ein von iOS ausgelöstes `touchcancel` behandelt
  sie wie das Loslassen. `Esc` und die sichtbare Schließen-Schaltfläche bleiben unabhängig davon
  bedienbar; bei gestapelten Dialogen schließt nur die oberste Ebene.
- **Markdown-Editor**: Artikel, Hörbuch-Abstracts und Markdown-Extras verwenden denselben lokalen
  CodeMirror-basierten Live-Editor. Formatierter Text wird direkt dargestellt; die Markdown-Zeichen
  erscheinen an der aktiven Cursorposition in einer zurückgenommenen Farbe.
- **Daten**: reine Dateien unter `www/` und `audio/` — keine Datenbank. Der Index wird beim Start und auf Anforderung neu aufgebaut.

---

## Inhaltsmodell (`www/` und `audio/`)

Jeder **Top-Level-Ordner in `www/` ist ein „Autor"** (z. B. `Joe Turan`,
`Telegram`, `Facebook`, `Infografiken`, `PDF`, `Stefan Hiene`, `Videos`).
Darunter liegen **Jahresordner** (`2024`, `2025`, …) mit je einer `.md`-Datei
pro Artikel.

```
www/
├── Joe Turan/
│   ├── standard.jpg              ← Fallback-Bild für Artikel ohne eigenes Bild
│   └── 2026/
│       ├── 2026-01-25_titel-slug.md
│       └── 2026-01-25_titel-slug.jpg   ← gleicher Dateiname-Stamm = Artikelbild
├── Telegram/…
└── Facebook/…
```

**Begleitdateien unter `www/`** (gleicher Stamm wie die `.md`):
`.jpg`/`.jpeg`/`.png` (Artikelbild), `.mp4` (Video), `.pdf`. Fehlt ein Bild,
greift `www/<Autor>/standard.<ext>`.

**Artikel-Audio** liegt regulär als gleichnamige `.mp3` unter
`audio/<Autor>/<Unterpfad>/<Artikel>.mp3`, also bei Jahresordnern z. B.
`audio/Joe Turan/2026/2026-01-25_titel-slug.mp3` zur Markdown-Datei unter
`www/Joe Turan/2026/2026-01-25_titel-slug.md`. Auch neu erzeugtes TTS-Audio
wird dort abgelegt. Für ältere Bestände unterstützt der Server weiterhin
gleichnamige MP3s direkt neben der Markdown-Datei unter `www/` (insbesondere
Stefan Hiene); falls beide Orte belegt sind, hat diese alte Datei Vorrang.
Das ist eine Kompatibilitätsregel, **keine Empfehlung für neue MP3s**.
Reguläres Artikel-Audio wird über `/audio-files/*` ausgeliefert, Altdateien
unter `www/` über `/files/*`. Der Filter „mit Audio“ meint ausschließlich
Audio aus dem separaten `audio/`-Baum.

**Artikel-ID**: `Autor/<Unterpfad>/<Dateiname-ohne-.md>` (z. B.
`Joe Turan/2026/2026-01-25_titel-slug`).

### Markdown-Format (was der Parser `parseArticle` liest)

```markdown
# Titel des Artikels

*Quelle: https://…*            ← optional, wird als sourceUrl extrahiert

**Datum: 2026-01-25**          ← Datum (ISO oder dd.mm.yyyy), auch ohne ** erkannt

AudioQuickie: 12               ← optional (Episoden-Nummer)
Kategorien: Beziehungen, Trauma & Heilung   ← optional (Anzeige-Tags)
Zusammenfassung: kurzer Teaser …            ← optional (bis zum Trenner)

****                           ← Trenner (>= 4 * oder -), danach beginnt der Body

<Artikeltext in Markdown>
```

- Datum notfalls aus dem Dateinamen-Präfix `YYYY-MM-DD_…`.
- Titel = Zeilen vor „Datum:", ohne die „Quelle:"-Zeile.
- Body = alles nach dem Trenner; ohne Trenner beginnt er nach Datum und den
  unmittelbar folgenden Metadaten mit der ersten normalen Textzeile. Spätere
  `Quelle:`-Zeilen im Artikeltext bleiben Inhalt. Der Body wird mit `marked`
  zu HTML gerendert; Blogartikel benötigen keinen künstlichen Trenner.
- **Auto-Kategorien**: `autoCategorize()` ordnet aus Titel+Zusammenfassung+Body
  über eine feste Stichwort-Taxonomie bis zu 5 Kategorien zu (für Filter/Facetten).
  Das Feld `Kategorien:` bleibt davon getrennt als reine Anzeige-Tags.

### Infografiken und Gruppen

Infografiken liegen unter `www/Infografiken/<Jahr>/`. Der Dateistamm ohne Suffix
(`<Stamm>.md` + gleichnamiges Bild) ist einer **eigenständigen Infografik** als
Artikel und Hauptbild vorbehalten. Anhänge eines normalen Artikels oder einer
eigenständigen Infografik beginnen mit `<Stamm>_1.md` + Bild; weitere heißen
`<Stamm>_2`, `_3` usw. Die Endung `_N` gilt nur
als Variante, wenn es den verkürzten Stamm gibt (Stefan Hiene: `…_Audioquickie_2961`
ist ein Name, `…_2961_1` der erste Anhang). Eine nummerierte Infografik-`.md`
ohne Text unter den Metadaten ist ein **Platzhalter**: Sie wird in den Kachelansichten mit ihrem Artikel
zu **einer Kachel** zusammengefasst (Bilder per Maus/Wischen, Striche ●○○), erbt
dessen Kategorien und Audio. Ohne Artikel ist die Basis-Infografik der Anker; eine
Infografik mit eigenem Text ist selbst ein Original und nimmt ihre Varianten auf.
Eine Infografik mit eigener Audiodatei bleibt ebenfalls eigenständig und wird
nicht als Artikelanhang gruppiert.
Alte, noch nicht migrierte Anhänge ohne Suffix werden bis zur Umstellung weiterhin erkannt.
Bis dahin beginnt ein weiterer Upload für solche Altgruppen weiterhin bei `_2`,
damit die bisherige Zuordnung nicht kippt; nach der Migration gilt `_1`.
Existiert unter demselben Stamm bereits eine eigenständige Infografik, kann der
gleichnamige Artikel dort keine weiteren Anhänge anlegen; die App meldet den
Namenskonflikt statt Grafiken dem falschen Anker zuzuordnen.
Die Liste und der Autorenfilter „Infografiken“ zeigen weiter jede Grafik einzeln;
wer den Artikel nicht sehen darf (Gäste), bekommt die Grafik einzeln ohne Text/Audio.
Im Artikel zeigt eine Bildleiste alle Bilder (drei 9:16 nebeneinander, ab vier
wischbar); die Vollansicht blättert durch die Bilder und danach zum Nachbarartikel.
Link auf ein Bild: `#/article/<Artikel-ID>?bild=3`.

**Artikel-Infografiken verwalten** (Admin, Artikel-Detailansicht →
*Infografiken*): Der Dialog zeigt nur die eigenen Grafiken dieses Artikels;
bei verknüpften Blog-/Facebook-Beiträgen also die des bevorzugten Blogartikels,
nicht zusätzlich die Facebook-Grafiken. PNG/JPG (max. 10 MB) wird einzeln
hinzugefügt. Die Reihenfolge lässt sich am Desktop ziehen oder mit ↑/↓ ändern,
mobil über ⋯ und ↑/↓. Jede Änderung wird sofort gespeichert: Bild und
zugehörige `.md` werden gemeinsam auf `<Stamm>_1`, `<Stamm>_2`, `_3` usw.
umbenannt; die Titelnummer in der `.md` folgt der neuen Position. Entfernen
verschiebt beide Dateien nach `www/Infografiken/trash/<Jahr>/<Vorgang>/`.
Dieser Papierkorb wird nicht indexiert und nicht über `/files/*` ausgeliefert;
eine Wiederherstellung erfolgt bei Bedarf manuell über die Dateien. Die
eigenständige Basis-Infografik samt Hauptbild bleibt beim Verwalten ihrer
Anhänge unberührt. Ein nummerierter Anhang kann auch kopierten Text in seiner
`.md` enthalten; dieser Inhalt bleibt beim Umbenennen erhalten. Grafiken mit
eigenem Audio werden nicht als Anhang verwaltet. Da die
Reihenfolge Teil des Dateinamens und der Infografik-ID ist, können sich direkte
Links auf einzelne Grafiken beim Umordnen ändern; der Artikellink bleibt gleich.
Nach Hinzufügen, Umordnen oder Entfernen liest der Server nur die Infografiken
des betroffenen Jahres erneut von der Festplatte. Artikel anderer Autoren und
andere Infografik-Jahre bleiben im Speicher; Zuordnungen und Suche werden aus
diesen Daten neu berechnet. Ein manueller Reindex bleibt ein vollständiger Scan.

**Bestehende Dateinamen umstellen:** Vorher ein Backup von `www/Infografiken/`
anlegen und zunächst `node scripts/migrate-infographic-names.js` als Vorschau
ausführen. Die Ausgabe listet zuerst noch nicht migrierte, zugeordnete Grafiken: 1.1 mit
leerem/reinem `.md`-Kopf und 1.2 mit eigenem Textkörper, jeweils bei einem
normalen Artikel; 1.3 umfasst Anhänge, deren zugeordneter Artikel selbst eine
Infografik ist. Danach folgen Grafiken ohne zugewiesenen Artikel (2) und
bereits migrierte Grafiken (3), ohne Dopplungen mit 1.1–1.3. Zwischen den
Bereichen stehen mindestens zwei Leerzeilen. Geplante neue Namen und
übersprungene Konflikte stehen jeweils am Eintrag. Mit
`node scripts/migrate-infographic-names.js --apply` werden nur
eindeutig zugeordnete Bild/`.md`-Paare umbenannt: bisherige Artikelgrafiken
`<Stamm>` werden `_1`, weitere Anhänge lückenlos nummeriert. Eigenständige
Basis-Infografiken behalten ihren Namen; ihre bisherigen Zusatzgrafiken können
von `_2` auf `_1` aufrücken. Bei fehlenden Zusatzdateien, Mehrdeutigkeiten oder
belegten Zielnamen wird nichts geändert und der Konflikt gemeldet. Nach der
Migration den Server neu starten oder den Index über die Admin-Funktion neu
einlesen. Für Testarchive kann `--root <Pfad-zu-www>` angegeben werden.
Hat eine Basis-Infografik keinen normalen Artikel, ist sie selbst der
Stammartikel und bleibt als `<Stamm>.md` mit Hauptbild unverändert. Ihre
Zusatzgrafiken aus `<Stamm>_2`, `_3` usw. gehören zu Bereich 1.3 und rücken
auf `_1`, `_2` usw. vor. Das Skript erkennt solche Zusätze auch dann, wenn die
Basis-`.md` leer ist und eine Zusatz-`.md` eigenen Text enthält; nach der
Migration verknüpft die App sie anhand von `_1`. Ein isoliertes `_2` ohne
vorhandene Basis wird dagegen nicht auf Verdacht umbenannt.

Die Bereiche lassen sich auch getrennt ausführen: `--section 1.1` wählt nur
Anhänge normaler Artikel mit leerer beziehungsweise reiner Kopf-`.md`,
`--section 1.2` nur deren Anhänge mit eigenem Textkörper und `--section 1.3`
alle Anhänge eigenständiger Infografik-Artikel, unabhängig vom eigenen Textkörper.
`--section 1` wählt alle drei Teilbereiche;
ohne Angabe gilt `all` mit demselben Migrationsergebnis. Zuerst jeweils die
Vorschau ohne `--apply` prüfen, dann zum Beispiel
`node scripts/migrate-infographic-names.js --section 1.1 --apply` ausführen.
Ein noch belegter Zielname wird nicht überschrieben, sondern als Konflikt
gemeldet; bei einem Konflikt startet die gewählte Teilmigration nicht.
Eine vorhandene `<Stamm>_1.md` oder gleichnamige PNG-/JPG-Datei irgendwo im
aktiven `www/Infografiken/`-Baum kennzeichnet den gesamten Artikelstamm als
**bereits migriert**: Die Vorschau weist ihn einzeln und in der Gruppensumme aus,
und spätere Läufe benennen keine weiteren Dateien dieses Stamms um. Dateien im
`trash/` zählen nicht als Marker. Stehen noch eine alte Basisgrafik und `_1`
nebeneinander, wird die widersprüchliche Zuordnung stattdessen als Konflikt
gemeldet. Bereits migrierte Grafiken erscheinen unabhängig vom gewählten
Migrationsbereich ausschließlich in Abschnitt 3. `--section 2` zeigt die
eigenständigen Infografiken, `--section 3` die bereits migrierten Anhänge;
beide Bereiche sind nur zur Anzeige da. Jeder Lauf prüft die Dateien neu;
nach einer Teilmigration vor dem nächsten Lauf die neue Vorschau ansehen.
Die Umstellung wurde nicht automatisch auf das Archiv angewendet.

**Neue eigenständige Infografik** (Admin, Aktionen → *Neue Infografik*): Dialog mit
Markdown-Vorlage (`# [Titel]`, `Datum: <heute>`, `----`, `[Inhalt]`), Häkchen für die
Filter-Kategorien und Grafikauswahl (PNG/JPG, max. 10 MB); alles wird in einem Schritt
gespeichert als `www/Infografiken/<Jahr>/<Datum>_<titel-slug>.md` + Bild
(Namenskonflikt → `-2`, `-3` …). Angehakte Kategorien fügt der Server beim Speichern
als `Kategorien:`-Zeile nach dem Datum ein; ein unverändertes `[Inhalt]` wird entfernt.
Danach Reindex, die neue Infografik öffnet sich.

**Kategorien-Zeile und Filter:** Steht in `Kategorien:` ein Name der festen
Filter-Kategorien (z. B. „Achtsamkeit“), zählt er für Filter und Suche immer – vor den
automatisch erkannten, höchstens fünf. Andere Einträge bleiben reine Anzeige-Tags.

### Hörbücher (`audio/Hoerbuecher/`)

Je Buch ein Ordner unter `audio/Hoerbuecher/` mit `cover.jpg`/`.jpeg`/`.png`, nummerierten
Tracks (`.mp3`/`.m4b`/`.m4a`) und optional `abstract.md`
(`Titel:`, `Autor:`, `Datum:`, `Inhalt:` + Markdown). (EPUB-Bücher als eBook-Text: siehe `epub-tool/`
unten.) Fallback-Cover:
`audio/Hoerbuecher/standard.jpg`/`.jpeg`/`.png`. Der Ordner heißt bewusst ohne Umlaute, angezeigt
wird „Hörbücher“ (Alternativen: Ordner `Hörbücher` oder `audiobooks.directory` in
`config.json`). Hörbücher sind keine Artikel: Sie erscheinen nur
beim Autorenfilter „Hörbücher“ (Sortierung zuletzt gehört / Name / Datum), sind nie
für Gäste sichtbar und werden über `allowedAuthors` freigegeben. Der Player spielt
das ganze Buch, springt über Dateigrenzen (Weiten in `config.json`) und merkt sich
Position und Tempo pro Nutzer und Buch in `audiobook-progress.json`. Fortschrittsbalken (Hörbuch und
Artikel-Audio): kurz tippen springt an die Stelle; halten und ziehen verschiebt relativ ab der aktuellen
Stelle, eine Sprechblase zeigt die Zielzeit, gesprungen wird beim Loslassen.

**Reine eBooks (ohne Audio):** Ein Buchordner ohne Audiodateien, aber mit eBook-Text
(`<Ordnername>.md`/`.txt`/`.pdf`), ist ebenfalls ein Buch. Die Kachel zeigt das Badge „eBook“ statt der
Teile-Zahl; das Detail hat keinen Player, nur „Text lesen“ (mit Leseposition). Ein Ordner ohne Audio **und**
ohne eBook-Datei bleibt unsichtbar. „Zuletzt gehört/gelesen“ berücksichtigt auch die Leseposition. Ein EPUB
selbst wird nicht gelesen, sondern vorher mit `epub-tool/` in eine `.md` umgewandelt.

**eBook-Text zum Hörbuch:** Liegt im Buchordner eine Datei mit dem Namen des Ordners und der
Endung `.md`, `.txt` oder `.pdf` (Vorrang in dieser Reihenfolge; z. B. `Autor - Titel/Autor - Titel.md`),
zeigt das Detail den Button *Text lesen*. Er öffnet einen Vollbild-Reiter (Schriftgröße A−/A+ bei
Markdown/Text, PDF im eingebauten Viewer); der Miniplayer bleibt unten sichtbar und führt zurück zum
Detail. Die Leseposition (Scrollanteil bzw. PDF-Seite) wird pro Nutzer und Buch in
`audiobook-progress.json` gemerkt, getrennt vom Hörstand. Text läuft nicht mit dem Audio mit. Bei Markdown/Text zeigt der Kopf
„Kapitel · %“; die dünne Linie darunter ist bedienbar (kurz tippen = an die Stelle springen, halten und ziehen =
relativ ab der aktuellen Stelle scrollen, mit Sprechblase). Interne Verweise (`[…](#kürzel)`) springen zur
passenden Überschrift (Kürzel wie bei GitHub); „↩ Zurück“ kehrt zur Ausgangsstelle zurück. Bilder im Markdown (`![](images/x.jpg)`)
werden angezeigt, wenn sie im Buchordner (auch in Unterordnern) liegen.

**EPUB als eBook-Text:** Der Reader liest kein EPUB direkt. Das Werkzeug `epub-tool/` (eigene
Abhängigkeiten, nur lokal nötig) wandelt ein EPUB einmalig in diese `.md` um – Bilder nach `images/`, Verweise
und Inhaltsverzeichnis als `#`-Sprunglinks, Fuß-/Endnoten als Sprungmarke im Text und „Anmerkungen“ mit
Rücksprung:
`node epub-tool/epub-to-md.js "Autor - Titel.epub" --out "audio/Hoerbuecher/Autor - Titel"`
(Details: `epub-tool/README.md`; danach Reindex).

**Extras anzeigen und verwalten:** Sichtbare Extras liegen ohne Manifest direkt unter
`audio/Hoerbuecher/<Buch>/extras/`; eingebettete Textbilder unter
`audio/Hoerbuecher/<Buch>/extras/images/`. Administratoren erreichen
*Extras verwalten …* sowohl im Aktionen-Menü des Hörbuchs als auch über *Verwalten* in der
Extras-Anzeige. Der Dialog kann Texte und Bilder anlegen, hochladen, ersetzen, umbenennen, löschen,
vorab anzeigen und die sichtbaren Extras per Ziehen oder Pfeiltasten sortieren. Die Reihenfolge wird
durch Präfixe wie `01 -` in den Dateinamen persistiert. Bei Textbildern wird ein früherer zufälliger
Zahlenpräfix beim Umbenennen bewusst **nicht** beibehalten; Markdown-Bildverweise werden gleichzeitig
in normaler und URL-kodierter Schreibweise aktualisiert.

*Text bearbeiten* öffnet den gemeinsamen Markdown-Live-Editor. Nur dieser Extras-Editor bietet das
Einfügen bzw. Hochladen von Bildern an; beim Bearbeiten eines Artikeltexts oder Hörbuch-Abstracts ist
die Bildfunktion ausgeblendet. Escape, die Zurück-Schaltfläche und ein Klick neben den Dialog schließen
immer zuerst die innerste Ebene (Vorschau oder Editor), anschließend die Extras-Verwaltung und erst
danach die Hörbuchansicht.

### Artikel-Audio erzeugen (TTS)

Ein Admin kann in der **Artikeldetailansicht** für einen Artikel ohne vorhandene MP3
*Audio erzeugen* wählen. Vor dem Start zeigt ein Dialog die verfügbaren Anbieter
und deren Hinweise als Radio-Auswahl. Qwen ist vorausgewählt, wenn sein
authentifizierter Dienst den erforderlichen Vertrag meldet. Fällt Qwen aus, wird
OpenAI **nicht** automatisch gewählt; eine möglicherweise kostenpflichtige
OpenAI-Erzeugung erfordert eine bewusste Auswahl und Startbestätigung. Ein
Healthcheck allein garantiert keine erfolgreiche Synthese.

Die TTS-Anbindung läuft auf **zwei verschiedenen Geräten**:

- Der **WebArchiv-Node.js-Server** betreibt `server.js`, Weboberfläche, Anmeldung,
  Artikel- und Audioablage. Nur dieses Gerät wird vom Browser angesprochen.
- Der davon getrennte **Qwen-TTS-Modellserver** betreibt den Python-HTTP-Dienst,
  `generate_mp3_with_embedding.py`, `extract_speaker.py`, GPU, Modelle und den
  Ordner `voices`. Auf ihm läuft nicht die WebArchiv-Anwendung.

Nur der WebArchiv-Node.js-Server kontaktiert den gewählten Anbieter. Er sendet
das vollständige Original-Markdown über das interne Netz an den Qwen-TTS-
Modellserver. Dieser liefert über den `webarchiv-qwen-v5`-Vertrag eine fertige
MP3 zurück; Bereinigung, Aufteilung und Stimme bestimmt das dortige
Qwen-Originalskript.
OpenAI verwendet die separate lokale Aufbereitung. Das Ergebnis wird ohne
Überschreiben vorhandener Dateien unter `audio/<relativer www-Pfad>.mp3`
veröffentlicht und danach indexiert. Ein fehlgeschlagener Reindex löscht die
fertige MP3 nicht und startet keine zweite Synthese. Es gibt nur einen aktiven
WebArchiv-TTS-Auftrag; Schließen des Statusdialogs bricht ihn nicht ab. Aufträge
liegen nur im Arbeitsspeicher und überstehen keinen Serverneustart.

Admins öffnen über das Kopfmenü **TTS-Einstellungen** die Stimmenverwaltung.
Die dort ausgewählte Qwen-Stimme gilt global für alle danach gestarteten
Qwen-TTS-Aufträge; laufende Aufträge behalten ihren beim Start übernommenen
Stimmen-Snapshot. Der WebArchiv-Node.js-Server speichert nur die Stimmen-ID in
`tts-settings.json`. Erzeugte Stimmproben speichert er als MP3 unter
`tts-voice-previews/`, benannt nach dem SHA-256 der zugehörigen Voice-Datei.
Die Probe wird nur angezeigt, solange der Qwen-Server denselben Datei-Hash
meldet. Die `.pt`-Dateien und temporären Aufnahmen werden
ausschließlich auf dem separaten Qwen-TTS-Modellserver im dort konfigurierten
`voices`-Verzeichnis verarbeitet.

Eine neue Stimme kann direkt im Browser aufgenommen oder als Audiodatei
hochgeladen werden. Der Admin gibt nur den Namen ein; der Qwen-Dienst
normalisiert ihn und ergänzt `-1.7B.pt`. Er wandelt die Aufnahme vorübergehend
in Mono-WAV um, prüft Größe, Dauer und Signalpegel und ruft anschließend
`examples/extract_speaker.py` für das 1.7B-Base-Modell auf. Temporäre
Aufnahmen werden danach gelöscht. Zusätzlich stehen eine kurze Stimmprobe,
Umbenennen und Verschieben nach `voices/trash` zur Verfügung. Die aktive
Stimme kann nicht gelöscht werden. Aufnahmezugriff im Browser erfordert einen
sicheren Kontext (HTTPS oder localhost).

Die WebArchiv-Anbindung liegt in `tts/` (eigenes Node-Paket). Auf dem
WebArchiv-Gerät sind **Node.js 22 oder neuer**, FFmpeg und FFprobe erforderlich.
Der getrennte Qwen-TTS-Modellserver verwendet seine eigene Python-/CUDA-
Umgebung und benötigt ebenfalls FFmpeg für neue Stimmen. `QWEN_TTS_BASE_URL`,
`QWEN_TTS_TOKEN` und optional `OPENAI_API_KEY` gehören in die geschützte
Dienstumgebung des WebArchiv-Servers; nur dasselbe Qwen-Token wird zusätzlich
auf dem Modellserver gesetzt. Zugangsdaten gehören weder ins Frontend noch ins
Repository.

---

## Suche, Filter, Facetten

- **Gewichtete Suche** über `Fuse.js` (Titel×3, Episodennummer×2,
  Autor×1,5, Kategorien×1, Auszug×0,8). Der vollständige Body ist kein
  eigener Suchschlüssel.
- **Datums-Tokens** in der Suche werden erkannt und als Filter angewandt
  (`2026`, `2026-03`, `03.2026`, `25.01.2026`) — kombinierbar mit Textsuche
  (z. B. „Achtsamkeit 2025").
- **Filter**: Autor, Jahr, Kategorie, Seitengröße, Ansicht (quadratisch/länglich/Liste).
  Auf Desktopgeräten verwenden Autor, Jahr, Kategorie, Hörbuch-Sortierung und Seitengröße das
  vorhandene ARIA-Aktionsmenü. Die geschlossenen Schaltflächen und die geöffneten Menüs bestimmen
  ihre Breite getrennt nach Inhalt; das Menü ragt nicht über den Fensterrand. Pfeiltasten,
  Pos1/Ende, Escape und Außenklick werden unterstützt. Auf Touch-Geräten bleiben die nativen
  `<select>`-Elemente aktiv.
  Paginierung server-seitig. Auf Touch-Geräten wechselt eine horizontale Einfinger-Geste
  in allen drei Ansichten zur nächsten oder vorherigen Seite: Sie beginnt außerhalb
  der äußersten 30 px und wirft die aktuelle Seite bis in die 30-px-Zone links bzw.
  rechts aus dem Bildschirm. Kurzes Wischen auf einer Bildergalerie blättert deren
  Bilder; eine bis zum Fensterrand geführte Geste blättert die Ergebnisseite. Auch
  langsame Bewegungen gelten, sofern sie mindestens 80 px weit und überwiegend
  horizontal sind. Auf iOS wird die Richtung bei der ersten Bewegung festgelegt,
  bevor Safari das vertikale Scrollen übernehmen kann. Das Verhalten einschließlich
  Start auf der rechten Kachel ist in der installierten iPhone-PWA bestätigt.
- **Kacheldichte**: In der quadratischen und länglichen Ansicht verändert Zusammenziehen
  bzw. Spreizen mit zwei Fingern die Kachelgröße; am Desktop dient dazu `Strg`+Mausrad.
  Die beiden Ansichten merken sich ihre bevorzugte Kachelbreite getrennt pro Benutzer und
  Gerät. Bei Drehung oder Größenänderung berechnet das Raster daraus automatisch mehr oder
  weniger Spalten, sodass die Kacheln ungefähr gleich groß bleiben. Das Raster nutzt auf
  normalen Desktopbildschirmen nahezu die volle Breite und bleibt auf Ultrawide bei 1920 px
  begrenzt. Reset stellt die responsive Vorgabe wieder her.
- **Kachelvorschau**: Der Vorschautext wird anhand der tatsächlich verfügbaren Höhe gekürzt.
  Überlauf wird nach dem Layout gemessen und mit genau einem eigenen `…` unten rechts markiert;
  eine zusätzliche browserseitige `line-clamp`-Ellipse wird absichtlich nicht verwendet.
- **Lesezeichen** (nur angemeldet): Button zwischen Kopieren und Teilen im Artikel setzt/löscht
  ein Lesezeichen (blau = gesetzt); Kacheln mit Lesezeichen tragen ein kleines blaues Symbol. Der
  Lesezeichen-Button im Header (blau = aktiv) zeigt nur Artikel mit Lesezeichen, kombinierbar mit
  Autor/Jahr/Kategorie/Suche, sortiert nach Artikeldatum; Telegram-Lesezeichen erscheinen auch ohne
  Telegram-Schalter. Gespeichert pro Nutzer in `bookmarks.json`. Hörbücher haben keine Lesezeichen.
- **Blog–Quellen-Dubletten** (Admin, Aktionen → *Dubletten prüfen*): Inhaltlich gleiche oder
  stark überlappende Beiträge aus „Joe Turan“ und den in `config.json` unter
  `duplicates.facebookAuthors` konfigurierten Quellen (derzeit „Facebook“ und „Coaching“) prüfen,
  vormerken, gesammelt verknüpfen oder ignorieren. Der Autorfilter erlaubt Mehrfachauswahl und gilt
  für alle drei Tabs. Bei offenen Treffern lassen sich zusätzlich Übereinstimmungsgrad und vorhandene
  Quell-Infografiken kombinieren; „Alle sichtbaren auswählen“ übernimmt die
  gefilterte Teilmenge. Die Auswahl bleibt lokal im Browser gespeichert. Reine Verknüpfungen
  aktualisieren den In-Memory-Index sofort, eine Sammelmigration liest das Archiv nur einmal neu ein.
  Filterbeschriftungen folgen der Anzeige-Einstellung; auf Touch-Geräten öffnen die Filter native
  Systemmenüs, auf Desktopgeräten die vorhandenen ARIA-Menüs. Die Felder passen sich ihrem aktuellen
  Text an. Beim Scrollen der Trefferliste gleitet der Dialogkopf nach oben aus dem Bild und
  erscheint nach kurzer Bewegung nach unten wieder, wie die Navigation in der Kachelansicht.
  Im Artikelvergleich werden die Überschriften auf drei Zeilen begrenzt. Die zugeordneten
  Blog- und Quell-Infografiken klappen gemeinsam auf und zu und belegen gleich viel Platz;
  jede Vorschau lässt sich bildschirmfüllend öffnen und über beide Seiten hinweg durchblättern.
  Der Volltextvergleich öffnet einen eigenen Dialog und zeigt einen einspaltigen Code-Diff:
  rote Minus-Zeilen stammen nur aus dem Quellartikel, grüne Plus-Zeilen stehen neu im Blog. Geänderte
  Wörter sind zusätzlich markiert. Verglichen wird die sichtbare Wortfolge aus derselben
  gerenderten HTML-Ausgabe wie in der Artikeldetailansicht. Absatz- und Überschriftengrenzen
  bestimmen nur die Anzeigeabschnitte, nicht die Textgleichheit; Markdown-Auszeichnung,
  Steuer- und Formatzeichen sowie Leerraum zählen nicht als Unterschiede. „Nur Unterschiede“
  ist anfangs aktiv und zeigt je einen gemeinsamen Textabschnitt vor und nach einer Änderung;
  übrige unveränderte Abschnitte sind mit Anzahl eingeklappt und lassen sich aufklappen.
  „100 %“ in der Übersicht bezeichnet eine gleiche normalisierte Wortfolge, nicht gleiche
  Absatzstruktur. Nicht exakte Treffer werden auch bei gerundetem Wert nicht als 100 %
  angezeigt oder vom Filter „genau 100 %“ erfasst.
  Die geplanten neuen Infografik-Dateinamen sind bei Bedarf
  aufklappbar. Auswählen, Ignorieren und `Esc` führen aus der Prüfung zurück zur Trefferübersicht;
  `Esc` schließt jeweils den obersten Dublettendialog; beim Ziehen nach unten folgt der gesamte
  Dialog sichtbar dem Finger und schließt erst nach Überschreiten der Ziehschwelle, sonst federt er zurück.
  Wie bei allen modalen Dialogen bleibt die Webseite dahinter gegen Scrollen gesperrt;
  Trefferliste und Textvergleich bleiben innerhalb der Dialoge scrollbar.
  Verknüpfte Quellbeiträge bleiben als Dateien erhalten, werden
  in normalen Ansichten aber durch den Blogartikel ersetzt. Zugeordnete Dateien aus
  `www/Infografiken/` können bestätigt für den Blogartikel umbenannt werden; das eigentliche
  Quell-Artikelbild bleibt unverändert. Entscheidungen
  liegen in `duplicate-decisions.json`; Telegram und „Joe Turan Facebook“ werden nicht verglichen.
- **Einstellungen** (Aktionen → *Einstellungen*, angemeldet): Schriftart (Editorial/Klassisch/
  Modern/System), Darstellung (Hell/Dunkel/Automatisch = folgt dem Gerät), Textgröße des
  Artikeltexts (Klein/Normal/Groß/Sehr groß) und Filter-Beschriftungen (Automatisch/Ausblenden).
  Alles wirkt sofort und liegt im Browser-Speicher; die Filter-Beschriftungen sind darin zusätzlich
  nach Nutzer getrennt. Gäste bekommen immer die Vorgaben (Automatisch, System, Normal).
- **Telegram-Sonderregel**: Artikel des Autors „Telegram" sind standardmäßig
  ausgeblendet (Toggle im Header oder `telegram=1` bzw. Autor-Filter „Telegram").

### Kopiermenü und Prompt-Dateien

Der erste Eintrag des Kopiermenüs kopiert nur den Artikeltext. Die weiteren Einträge
stammen aus `prompts/*.txt`, kopieren den jeweiligen Prompt gefolgt vom Artikeltext
und öffnen zusätzlich die hinterlegte HTTP(S)-URL in einem neuen Browser-Tab. Das
Dateiformat lautet:

```text
URL:
https://example.com/

PROMPT:
Anweisung, die vor den Artikeltext gesetzt wird.
```

---

## Markdown-Editor (Admin)

Der Editor ist ein „What you see is what you mean“-Editor: Das Dokument bleibt Markdown, wird im
Eingabefeld aber formatiert dargestellt. Für Inline- und Blockelemente – Fett, Kursiv,
Durchgestrichen, Überschriften, Listen, Checkboxen, Zitate, Code, Links, Bilder, Tabellen und
Trennlinien – werden die Syntaxzeichen nur an der aktiven Stelle eingeblendet. Die Zeichen sind
heller bzw. zurückhaltender als der eigentliche Inhalt; dadurch bleibt die Quelldatei editierbar,
ohne dauerhaft wie Plain Text auszusehen.

Die Werkzeugleiste bietet Rückgängig/Wiederholen, Überschriften, Listen und Einzüge, Fett, Kursiv,
Durchgestrichen, Zitat, Code, Link, Tabelle und Formatierung löschen. Ohne Auswahl wirkt eine
Inline-Formatierung auf das Wort unter dem Cursor; mit Auswahl auf den markierten Bereich. Aktive
Formatierungen sowie die aktuelle Überschriftenebene werden über `aria-pressed` bzw.
`aria-current` gespiegelt. Das Überlaufmenü grenzt direkt an die übrigen Werkzeuge an und wird bei
schmalen Fenstern innerhalb des Viewports verschoben.

Tastaturregeln sind Teil des Editors, nicht Browser-Zufall: `Strg`/`Cmd`+`I` formatiert kursiv;
Pos1/Ende arbeiten auf der sichtbaren Markdown-Zeile; Pfeil hoch überspringt nach mehrzeiligem
Einfügen oder an Tabellen keine Quellzeile. Speichern ist mit `Strg`/`Cmd`+Enter möglich.

Artikel und Abstracts werden serverseitig versionsgeprüft und atomar ersetzt; externe Änderungen
führen zu `409`, statt überschrieben zu werden. BOM, CRLF und Dateirechte bleiben erhalten. Nach
Änderungen an `public/markdown-live-preview.js`, `public/markdown-commands.mjs`,
`public/markdown-editors.js`, `public/article-editor.js` oder
`public/audiobook-extras-manager.js` muss das eingecheckte Browser-Bundle neu gebaut werden:

```bash
npm run build:editor
```

Danach die `?v=`-Version von `vendor/article-editor.bundle.js` in `public/index.html` erhöhen.
Der eingebettete PDF.js-Viewer bleibt ein eigenständiger Drittanbieterbereich und wird nicht in
Editor- oder Menülogik einbezogen.

---

## Authentifizierung & Rechte

- **`users.json`** (nicht eingecheckt): Liste von Nutzern
  ```json
  [{ "email": "a@b.de", "passwordHash": "<bcrypt>", "role": "admin", "allowedAuthors": null, "mustChangePassword": false }]
  ```
  - `passwordHash`: bcrypt. Erstanlage per `scripts/hash-passwords.js`, danach
    über die **Benutzerverwaltung** in der Oberfläche.
  - `role`: `admin` sieht das Aktions-Menü hinter dem **↺-Button** (Archiv neu
    einlesen, Neue Beiträge scrapen, Scrape-Log, Einstellungen, Benutzerverwaltung,
    Kennwort ändern). `user` sieht denselben Button mit **Personen-Icon** und nur
    „Einstellungen“ und „Kennwort ändern“.
  - `allowedAuthors`: `null` = alle Autoren; sonst Whitelist von Autor-Ordnern (ACL).
    Öffentliche Autoren kommen für angemeldete Nutzer immer hinzu.
  - `mustChangePassword`: `true` = nach der nächsten Anmeldung muss ein eigenes
    Kennwort gesetzt werden; bis dahin sperrt der Server alle Daten-/Datei-Routen.
  - `sessionVersion` (automatisch): wird bei neuem Kennwort erhöht und beendet
    damit die übrigen Sitzungen des Nutzers.
- **Benutzerverwaltung** (Admin, Aktionen → *Benutzerverwaltung*): Nutzer anzeigen,
  anlegen, Rolle/Autoren ändern, Kennwort neu vergeben (wahlweise mit Pflicht zur
  Änderung), löschen. Der Reiter *Autorenverwaltung* pflegt die öffentliche Freigabe
  in `public-directories.txt` und getrennt davon die Autoren-Priorität in `config.json`.
  Die Priorität entscheidet bei gleichnamigen Artikeln mehrerer Autoren, welchem
  Artikel eine Infografik zugeordnet wird.
  Rechteänderungen wirken sofort, weil die Session nur E-Mail und `sessionVersion`
  trägt und Rolle/Autoren bei jeder Anfrage frisch aufgelöst werden. Schutzregeln:
  eigene Rolle nicht änderbar, eigener Zugang nicht löschbar, letzter Admin bleibt.
  Kennwörter mindestens 8 Zeichen.
- **Gäste** (ohne Login) bekommen die Rolle `guest` mit den in
  **`public-directories.txt`** gelisteten öffentlichen Autoren:
  ```json
  { "public-directories": ["Videos", "PDF", "Infografiken"] }
  ```
  Sind keine öffentlichen Autoren konfiguriert, ist die App vollständig
  login-pflichtig (401).
- **Schreiben der Dateien** (`user-store.cjs`): temporäre Datei im selben Ordner,
  dann atomar ersetzen; Rechte/Eigentümer bleiben erhalten. Jede Änderung liest die
  Datei vorher frisch ein, Handänderungen gehen also nicht verloren. Wird
  `users.json` bei laufendem Server von Hand bearbeitet (z. B. `hash-passwords.js`),
  gilt der neue Stand für Anmeldungen erst nach der nächsten Änderung über die
  Oberfläche oder einem Neustart. Der Dienstbenutzer braucht Schreibrecht auf
  `users.json`, `public-directories.txt`, `config.json` **und** das App-Verzeichnis.
- **Sessions** via `express-session` (Cookie 7 Tage, `httpOnly`, `sameSite=lax`);
  Secret über `SESSION_SECRET` (Env) setzen. Nach dem Login wird die Session-ID
  neu vergeben. Die Server-Sessions liegen im RAM: Ein Dienstneustart macht
  bestehende Logins ungültig, auch wenn die lokal gespeicherte Ansicht nach
  erneuter Anmeldung wiederhergestellt werden kann.
- Datei-Auslieferung `/files/*` prüft die Autor-ACL (kein Zugriff auf fremde Autoren,
  Path-Traversal-Schutz).

---

## HTTP-API

| Methode & Pfad | Auth | Zweck |
|---|---|---|
| `GET /api/me` | – | Aktueller (oder Gast-)Nutzer |
| `POST /api/login` | – | Anmeldung `{email,password}` |
| `POST /api/logout` | – | Abmeldung |
| `POST /api/me/password` | Auth | Eigenes Kennwort ändern `{currentPassword,newPassword}` |
| `GET /api/users` | Admin | Nutzer (ohne Hashes), alle Autoren, öffentliche Autoren |
| `POST /api/users` | Admin | Nutzer anlegen `{email,role,allowedAuthors,password,mustChangePassword}` |
| `PATCH /api/users/:email` | Admin | Rolle/Autoren/Änderungspflicht ändern |
| `POST /api/users/:email/password` | Admin | Kennwort neu vergeben `{password,mustChangePassword}` |
| `DELETE /api/users/:email` | Admin | Nutzer löschen |
| `PUT /api/public-authors` | Admin | Öffentliche Autoren setzen `{authors:[…]}` |
| `GET /api/meta` | Soft | Autoren/Jahre/Kategorien (ACL-gefiltert) |
| `GET /api/articles` | Soft | Liste mit `q,author,year,category,page,limit,telegram`; `group=1` fasst Artikel + Infografiken zu Kacheln mit `images` zusammen; `bookmarks=1` nur Artikel mit Lesezeichen; jeder Eintrag trägt `bookmarked` |
| `GET /api/articles/*` | Soft | Einzelartikel inkl. gerendertem `bodyHtml`, `images` und `bookmarked`; eine gruppierte Infografik liefert ihre Gruppe (`requestedId`) |
| `GET /api/infographic-manager/*` | Admin + Artikelrecht | Verwaltbare, eigene Artikel-Infografiken in Reihenfolge |
| `POST /api/infographic-manager/*` | Admin + Artikelrecht | `{action:"order",ids:[…]}` benennt Bild/Markdown um; `{action:"trash",id}` verschiebt ein Paar in den Papierkorb und nummeriert übrige Grafiken neu |
| `POST /api/infographics/*` | Admin + Artikelrecht | Einzelne PNG-/JPG-Infografik zum Artikel hochladen |
| `PUT /api/bookmarks/*` · `DELETE /api/bookmarks/*` | Auth | Lesezeichen setzen (Artikel muss existieren, Autorenrecht) bzw. löschen |
| `GET /api/duplicates` | Admin | Offene, verknüpfte und ignorierte Blog–Quellen-Paare samt konfigurierter Quellautoren |
| `GET /api/duplicates/compare` | Admin | Volltextvergleich und Vorschau möglicher Infografikmigrationen |
| `POST /api/duplicates` | Admin | Paar verknüpfen/ignorieren/lösen oder Infografiken migrieren |
| `POST /api/duplicates/batch` | Admin | 1–500 ausgewählte Paare gesammelt verknüpfen, optional mit einer gemeinsamen Infografikmigration |
| `GET /files/*` | Soft | Dateien aus `www/` (Bilder, Videos, PDFs und alte MP3s), ACL pro Autor |
| `GET /audio-files/*` | Soft | Artikel-MP3s und Hörbuchmedien aus `audio/`, ACL pro Autor |
| `GET /a/*` | – | Link-Vorschau: liefert OG-Meta-Tags + Weiterleitung in die SPA |
| `GET /og-image/*` | – | Auf 1200px/JPEG q80 verkleinertes Vorschaubild (gecacht); `?sq=256|512` liefert einen quadratischen Ausschnitt vom oberen Bildteil (Sperrbildschirm) |
| `POST /api/new-infographic` | Admin | Neue Infografik `{markdown, image(base64)}` → `{id}` |
| `GET /api/prompts` · `GET /api/prompts/:file` | Soft | Prompt-Textbausteine aus `prompts/` (Copy-Menü) |
| `GET /api/audiobooks` | Auth + Autor | Hörbücher mit `q,sort(recent/title/date),page,limit` |
| `GET /api/audiobooks/*` | Auth + Autor | Hörbuch mit Tracks, Beschreibung, eigenem Fortschritt |
| `GET /api/tts/provider` | Admin | Verfügbarkeit und Hinweise zu Qwen und OpenAI |
| `GET`/`PUT /api/tts/settings` | Admin | Qwen-Stimmenkatalog lesen bzw. globale Stimme für neue Aufträge festlegen |
| `POST /api/tts/voices` | Admin | Aufnahme/Upload zur Erzeugung einer 1.7B-Stimme an den Qwen-Dienst senden |
| `GET`/`DELETE /api/tts/voices/jobs/*` | Admin | Erzeugungsstatus lesen bzw. laufende Stimmerzeugung abbrechen |
| `PATCH`/`DELETE /api/tts/voices/*` | Admin | Stimme auf dem Qwen-Dienst umbenennen bzw. nach `voices/trash` verschieben |
| `POST`/`GET`/`DELETE /api/tts/voices-preview*` | Admin | Kurze Stimmprobe erzeugen, auf dem WebArchiv speichern und Remote-Auftrag aufräumen |
| `GET /api/tts/voices/:voiceId/preview-audio` | Admin | Bereits gespeicherte Stimmprobe nur bei weiterhin identischem Voice-SHA-256 ausliefern |
| `POST /api/tts` | Admin + Artikelrecht | Bestätigten Auftrag mit `{articleId,provider}` starten |
| `GET /api/tts/latest` · `GET /api/tts/:jobId/status` | Admin | Letzten Auftrag bzw. Status und Log lesen |
| `POST /api/tts/:jobId/cancel` | Admin | Laufenden Auftrag ausdrücklich abbrechen |
| `GET`/`PUT /api/article-markdown/*` | Admin | Vollständige Markdown-Datei mit Versionsprüfung lesen bzw. atomar speichern |
| `GET /api/audiobook-extra-manage/*` | Admin + Autor | Extras und Textbilder für den Verwaltungsdialog auflisten |
| `GET`/`PUT /api/audiobook-extra-source/*` | Admin + Autor | Markdown-Extra mit Versionsprüfung lesen bzw. speichern |
| `POST /api/audiobook-extra-create/*` | Admin + Autor | Neues Markdown-Extra anlegen |
| `POST /api/audiobook-extra-upload/*` | Admin + Autor | Extra oder Textbild hochladen/ersetzen |
| `PATCH`/`DELETE /api/audiobook-extra-entry/*` | Admin + Autor | Extra oder Textbild umbenennen bzw. löschen |
| `POST /api/audiobook-extra-order/*` | Admin + Autor | Reihenfolge sichtbarer Extras speichern |
| `PUT /api/audiobook-progress/*` | Auth + Autor | Hörposition speichern `{trackIndex,position,speed}` |
| `GET /api/audiobook-text/*` | Auth + Autor | eBook-Text (`md`/`txt` als HTML, `pdf` als URL) mit Leseposition |
| `PUT /api/audiobook-text-progress/*` | Auth + Autor | Leseposition speichern `{position}` (Anteil 0–1, bei PDF Seitenzahl) |
| `GET /api/reindex/status` | Auth | Status des Index-Neuaufbaus |
| `POST /api/reindex` | Admin | Index neu aufbauen (`buildIndex()`) |
| `GET /api/scrape/status` | Auth | Status + Live-Ausgabe des Scrape-Laufs |
| `POST /api/scrape` | Admin | Scraper starten (`{sources?}`), danach Auto-Reindex |
| `GET /api/scrape/log` | Admin | Letzte 100 Zeilen von `scraper/scrape_all.log` |

„Soft" = `attachUser`: eingeloggt oder Gast mit Public-Autoren; sonst 401.

**Link-Vorschau**: Crawler (WhatsApp/Signal/Telegram) führen kein JS aus und
ignorieren den `#`-Teil. Daher liefert `/a/<id>` serverseitig OG-Tags und leitet
echte Besucher per Meta-Refresh/JS in die SPA (`#/article/<id>`). Der Server
respektiert `X-Forwarded-Proto/Host` (`trust proxy`) für korrekte absolute URLs
hinter dem Reverse Proxy.

---

## Index (Reindex)

`buildIndex()` scannt `www/` rekursiv, parst alle Artikel-`.md`, ordnet Bilder,
Videos, PDFs und MP3s nach der oben beschriebenen Suchreihenfolge in `www/` und
`audio/` zu, ermittelt Kategorien und baut den Fuse-Index. Läuft **beim Serverstart**, auf
`POST /api/reindex` (Admin) und bei **`SIGHUP`** (für Cron/Automation ohne
Neustart — offene Sessions bleiben erhalten). Da der Index im Speicher liegt,
werden **neu hinzugefügte Dateien erst nach einem Reindex sichtbar**.

Wichtig: `scraper/scrape_all.js` triggert selbst **keinen** Reindex. Es schreibt
nur neue Dateien. Den Reindex stößt entweder `server.js` nach einem Web-UI-Scrape
an, oder ein CLI/Cron-Aufruf muss danach den laufenden Server per `SIGHUP`
signalisieren.

---

## Scraper-Integration (`scraper/`)

Eigenständiger Node-Scraper (Blog + Facebook + Telegram) in `scraper/` — **eigenes
`package.json` (`type:module`) und eigene `node_modules`**, damit die schweren
Abhängigkeiten (playwright/Chromium) **nicht** in die App-`package.json` wandern.
Er schreibt direkt in die Autoren-Ordner des Archivs:

```
scraper/scrape_all.js  →  ../www/Joe Turan | ../www/Telegram | ../www/Facebook
```

Details/CLI: siehe `scraper/README.md`. Zwei Auslöse-Wege:

1. **CLI**: `cd scraper && node scrape_all.js [--blog|--facebook|--telegram] [--visible]`
2. **Web-UI (Admin)**: Aktions-Menü hinter dem **↺-Button** im Header mit drei
   Einträgen — *Archiv neu einlesen* (`POST /api/reindex`), *Neue Beiträge scrapen*
   (`POST /api/scrape`) und *Scrape-Log anzeigen* (`GET /api/scrape/log`). Beim
   Scrapen startet der Server `scrape_all.js` als Kindprozess, sammelt dessen
   Ausgabe in `scrapeState.output` und zeigt sie **live in einem Modal** an (endet
   mit der Zusammenfassung `gespeichert=… bereits vorhanden=…`); danach wird
   automatisch `buildIndex()` (Reindex) angestoßen. *Scrape-Log anzeigen* öffnet
   dasselbe Modal mit den letzten 100 Log-Zeilen, bereits ans untere Ende gescrollt.

Beim CLI-/Cron-Aufruf führt `scrape_all.js` dagegen nur den Scrape aus; der
Reindex muss anschließend außerhalb des Scrapers ausgelöst werden. Dafür **kein
`systemctl restart nodeapp` verwenden**, weil ein harter Neustart laufende
Requests, Sessions und einen eventuell gerade laufenden Reindex unterbrechen
kann. Stattdessen den vorhandenen `SIGHUP`-Handler nutzen (siehe Cron-Beispiel
unten).

Voraussetzungen für den Scrape: installierte Playwright-Browser + System-Libs und
gesetztes `PLAYWRIGHT_BROWSERS_PATH` (siehe `LXC-container node.js Setup.txt`).
Die aktiven Quellen stehen in den Arrays `Blog`, `Facebook` und `Telegram` von
`scraper/scraper-config.json` (jeweils `Name`, `URL`, `OutputPath`); mehrere
Einträge je Quellentyp werden nacheinander verarbeitet. Facebook benötigt
zusätzlich `scraper/cookies.txt` im Netscape-Format. Die frühere
`scraper/Abonenten-URL.txt` ist **keine** aktive URL-Quelle mehr. Nach drei
bereits vorhandenen Artikeln pro Quelle stoppt der Scraper diese Quelle.

---

## Projektstruktur

```
server.js                     Express-App (Routen, Index, Auth-Anbindung)
user-store.cjs                Nutzer, öffentliche Autoren & Autoren-Priorität: Speicher/Routen
audiobooks.cjs                Hörbücher: Index, abstract.md, Hörfortschritt, Routen
article-editor.cjs            Sicheres Lesen/Speichern von Artikel- und Abstract-Markdown
bookmarks.cjs                 Lesezeichen pro Nutzer (bookmarks.json) und Routen
duplicates.cjs                Dublettenerkennung und persistente Entscheidungen
config.json                   Einstellungen (Autoren-Priorität, Dubletten, Hörbuch-Sprungweiten)
package.json                  Deps: express, express-session, bcryptjs, fuse.js, marked, sharp, diff
test/                         Tests der Hauptanwendung
public/
├── index.html                SPA-Markup (Header, Overlays: Artikel, Login, Scrape)
├── app.js                    SPA-Logik (Suche, Filter, Detail, Auth, Aktionen-Menü: Reindex/Scrape/Log)
├── duplicates.js             Admin-Prüfung und Verknüpfung von Blog-/Quellen-Dubletten
├── article-editor.js         Dialoglogik für Artikel- und Abstract-Markdown
├── markdown-live-preview.js  CodeMirror-Live-Darstellung, Toolbar und Cursor-Navigation
├── markdown-commands.mjs     Reine Markdown-Transformationen der Toolbar
├── markdown-editors.js       Einstiegspunkt des gebündelten Editors
├── audiobook-extras-manager.js  Extras-/Textbildverwaltung und Extras-Markdown-Editor
├── user-admin.js             Kennwort ändern, Benutzer- und Autorenverwaltung
├── settings.js               Anzeige-Einstellungen (inkl. Filter-Beschriftungen pro Nutzer/Gerät)
├── session-state.js          Lokaler Sitzungsstand pro Benutzer (Ansicht, Navigation, Scrollposition)
├── pwa-update.js             Erkennt neue App-Versionen und bietet kontrolliertes Aktualisieren an
├── audiobooks.js             Hörbuch-Liste, -Detail, Player und Miniplayer
├── book-reader.js            eBook-Text zum Hörbuch (Vollbild-Reiter, Leseposition)
├── favicon.svg               Favicon (Bücherregal, Gold auf Dunkel) – Vorlage für die beiden folgenden
├── favicon.ico               16/32/48 px (PNG-Einträge), aus favicon.svg erzeugt
├── apple-touch-icon.png      180 px ohne Eckenradius für den iOS-Homescreen
├── styles.css                Styles (Light/Dark, Layouts)
└── vendor/
    └── pdfjs/                PDF.js-Anzeige (Drittanbieterbibliothek)
epub-tool/                    Eigenständiges Werkzeug: EPUB → Markdown; Tests unter epub-tool/test/
scripts/hash-passwords.js     bcrypt-Hashes für users.json erzeugen
scripts/make-favicons.js      favicon.ico + apple-touch-icon.png aus public/favicon.svg erzeugen
scripts/strip-infographic-categories.js  „Kategorien:“ aus Infografik-.md entfernen (--dry-run, Sicherung)
prompts/*.txt                 Prompt-Bausteine fürs Copy-Menü (Zahl-Präfix = Reihenfolge)
scraper/                      Eigenständiger Scraper; Tests unter scraper/test/
tts/                          WebArchiv-seitige TTS-Module (Node.js); Tests unter tts/test/
tts-server/                   Separater Qwen-TTS-Server (Python), Starthelfer, Doku und Tests
www/<Autor>/<Jahr>/           Artikel-Markdown, Bilder, Videos, PDFs (Inhalte ignoriert)
audio/<Autor>/<Jahr>/         Artikel-MP3s mit entsprechendem Dateistamm (ignoriert)
audio/Hoerbuecher/<Buch>/     Tracks, Cover, eBook, abstract.md, extras/ (ignoriert)
download/                     Arbeitsordner (ignored)
users.json                    Nutzer/Rechte (ignored)
tts-settings.json             Gewählte globale Qwen-Stimmen-ID (ignored)
tts-voice-previews/           Hash-geprüfte lokale Stimmproben (ignored)
public-directories.txt        Öffentliche Autoren für Gäste
LXC-container node.js Setup.txt   Server-/Deployment-Doku
```

Nicht eingecheckt (`.gitignore`): `node_modules/`, `scraper/node_modules/`,
`www/<Autor>/2*` (Jahresinhalte), `audio/`, `download/`, `users.json`, `audiobook-progress.json`, `bookmarks.json`, `duplicate-decisions.json`, `tts-settings.json`, `tts-voice-previews/`,
`scraper/cookies.txt`, `scraper/Abonenten-URL.txt`, Logs.

---

## Setup & Start (lokal)

```bash
npm install
npm install --prefix tts  # nur für die lokale TTS-Anbindung; Node.js >= 22
# Der separate Python-Dienst unter tts-server/ wird auf dem Qwen-Gerät eingerichtet.

# Nutzer anlegen: Passwort-Hash erzeugen und in users.json eintragen
node scripts/hash-passwords.js

# optional öffentliche Autoren für Gäste festlegen (public-directories.txt)

node server.js            # bzw. npm start  →  http://localhost:3000
```

### Tests

Alle Testskripte liegen in `test/`-Unterordnern. Der gemeinsame Einstieg im
Projektroot führt die Node-Tests aus `test/`, `scraper/test/`, `epub-tool/test/`
und `tts/test/` sowie die Python-Tests des separaten Qwen-Dienstes unter
`tts-server/test/` aus:

```bash
npm test
```

Gezielte UI-Vertragstests für die hier beschriebenen Bereiche liegen insbesondere in
`test/article-editor-ui.test.cjs`, `test/audiobook-extras-ui.test.cjs`,
`test/filter-aria-menu.test.cjs` und `test/card-preview.test.cjs`.

Die eigenständigen Node-Pakete lassen sich weiterhin getrennt prüfen:

```bash
npm test --prefix scraper
npm test --prefix epub-tool
npm test --prefix tts
```

**Konfiguration (Env):**

| Variable | Default | Zweck |
|---|---|---|
| `PORT` | `3000` | HTTP-Port |
| `SESSION_SECRET` | Dev-Fallback | Signatur der Session-Cookies (in Prod setzen!) |
| `USERS_FILE` | `./users.json` | Abweichender Pfad der Nutzerdatei (z. B. für Tests) |
| `PUBLIC_DIRS_FILE` | `./public-directories.txt` | Abweichender Pfad der Liste öffentlicher Autoren |
| `AUDIOBOOK_PROGRESS_FILE` | `./audiobook-progress.json` | Abweichender Pfad des Hörfortschritts |
| `BOOKMARKS_FILE` | `./bookmarks.json` | Abweichender Pfad der Lesezeichen |
| `DUPLICATES_FILE` | `./duplicate-decisions.json` | Abweichender Pfad der Dubletten-Entscheidungen |
| `TTS_SETTINGS_FILE` | `./tts-settings.json` | Abweichender Pfad der globalen Qwen-Stimmenauswahl |
| `TTS_VOICE_PREVIEW_DIR` | `./tts-voice-previews` | Ablage der lokalen, per Voice-SHA-256 validierten Stimmproben |
| `PLAYWRIGHT_BROWSERS_PATH` | – | Chromium-Ablage für den Scraper (siehe Setup-Doku) |

Scraper zusätzlich einrichten:

```bash
cd scraper
npm install
npx playwright install --with-deps chromium
```

---

## Deployment (Debian-LXC, Kurzfassung)

- Dieser Abschnitt beschreibt **Gerät A, den WebArchiv-Server**. Der separate
  Qwen-TTS-Modellserver ist Gerät B und wird nach
  [`tts-server/QWEN-ANBINDUNG.md`](tts-server/QWEN-ANBINDUNG.md) eingerichtet.
- WebArchiv-App unter `/opt/nodeapp`, Start via **systemd** (`nodeapp.service`), betrieben
  als unprivilegierter User `ralf` (`User=ralf`/`Group=ralf`), damit erzeugte
  Dateien `ralf:ralf` gehören. Steuern nur mit `sudo systemctl …`.
- `www/` liegt auf einer eingebundenen externen Disk.
- Reverse Proxy (Caddy/Nginx) für HTTPS ist vorgesehen; der Server ist mit
  `trust proxy` darauf vorbereitet.
- **Serverdienst steuern**:
  ```bash
  sudo systemctl restart nodeapp          # nach Codeänderungen neu starten
  sudo systemctl status nodeapp           # Dienststatus prüfen
  journalctl -u nodeapp -n 100 --no-pager # letzte Logzeilen anzeigen
  ```
- Reine Änderungen unter `public/` benötigen keinen Serverneustart. Die passende `?v=`-Query in
  `public/index.html` erhöhen, Dateien übertragen und Browser/PWA neu laden bzw. das angebotene
  PWA-Update anwenden. Änderungen an Editor-Quellen vorher mit `npm run build:editor`,
  Änderungen an der Dubletten-Diff-Quelle mit `npm run build:duplicate-diff` bündeln.
- Änderungen an `server.js`, `*.cjs`, Abhängigkeiten oder Umgebungsvariablen benötigen einen
  Neustart des Dienstes. Bei geänderter `package.json`/`package-lock.json` vorher in `/opt/nodeapp`
  `npm ci` ausführen; die eigenständigen Pakete `scraper/` und `tts/` benötigen
  ihre eigenen Installationen (`npm ci --prefix scraper`, `npm ci --prefix tts`).
- **Reindex ohne Neustart**: der Server hat einen `SIGHUP`-Handler, der
  `buildIndex()` auslöst, ohne den Prozess zu beenden — offene Sessions bleiben
  erhalten. Auslösen (als `ralf`, ohne sudo):
  `kill -HUP "$(systemctl show -p MainPID --value nodeapp)"`.
- Täglicher Scrape **und** Reindex per **cron** (als `ralf`) — siehe unten.

### Täglicher Scrape per Cron

Empfohlener Wrapper für `/opt/nodeapp/scraper/run-scrape.sh` (als `ralf`, danach
`chmod +x`):

**Ist-Zustand des eingecheckten Skripts:** `scraper/run-scrape.sh` führt nach dem
Scrape derzeit noch `sudo /usr/bin/systemctl restart nodeapp` aus. Das folgende
Beispiel zeigt die schonendere, aber in dieser Datei noch **nicht umgesetzte**
Umstellung auf `SIGHUP`. Vor dem Einsatz die tatsächlich installierte
Produktionsdatei prüfen; ihr Stand ist hier nicht bestätigt.

```bash
#!/usr/bin/env bash
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
cd /opt/nodeapp/scraper
/usr/bin/node scrape_all.js >> /opt/nodeapp/scraper/cron-scrape.log 2>&1
echo "$(date '+%F %T') Scraper exit $?" >> /opt/nodeapp/scraper/cron-scrape.log

# Reindex OHNE Neustart (Sessions bleiben erhalten): SIGHUP an den Node-Prozess.
# Nicht "systemctl restart nodeapp" verwenden; der Restart kann laufende Requests
# oder einen parallel gestarteten Reindex abbrechen.
PID=$(systemctl show -p MainPID --value nodeapp)
[ "${PID:-0}" -gt 0 ] && kill -HUP "$PID"
```

Crontab von `ralf` (`crontab -e`), täglich 04:30 **UTC** (nicht durchgehend
04:30 Uhr deutscher Ortszeit):

```cron
30 4 * * * /opt/nodeapp/scraper/run-scrape.sh
```

Kein `sudo`/Passwort nötig: Dienst und Cron laufen beide als `ralf`,
`systemctl show -p MainPID` ist eine reine Leseabfrage, und `ralf` darf den
eigenen Prozess signalisieren. Kein `set -e` im Wrapper — bei Teil-Fehlern (z. B.
abgelaufene FB-Cookies) endet der Scraper mit Exit 1, die übrigen Quellen sind
trotzdem gespeichert und werden indexiert. Nur bestimmte Quellen: Flags anhängen
(`--blog --telegram`).

Alle Schritte, Fehlerbilder und Befehle (systemd, Rechte, Playwright-Systemlibs,
`SIGHUP`-Reindex, cron, CRLF-Stolperfalle) stehen ausführlich in
**`LXC-container node.js Setup.txt`**.
