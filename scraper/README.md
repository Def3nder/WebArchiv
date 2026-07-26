# WebArchiv — Scraper

Eigenständiger Scraper (Blog + Facebook + Telegram) für WebArchiv. Node.js-Port
von `BlogDownloader/node/scrape_all.js`; **einziger Unterschied**: die Ausgabe
geht ins `www/` des WebArchiv-Projekt-Roots (eine Ebene höher), das der Server
rendert.

Alle Quellen werden in `scraper-config.json` konfiguriert. `OutputPath` ist
relativ zu `scraper/scrape_all.js` und muss innerhalb von `../www/` liegen:

```json
{
  "Blog": [
    {
      "Name": "Joe Turan",
      "URL": "https://www.joeturan.com/blog",
      "OutputPath": "../www/Joe Turan"
    }
  ],
  "Facebook": [
    {
      "Name": "Facebook",
      "URL": "https://www.facebook.com/61551902387350/supporters/",
      "OutputPath": "../www/Facebook"
    },
    {
      "Name": "Nawal Boussi",
      "URL": "https://facebook.com/nawal.boussi",
      "OutputPath": "../www/Nawal Boussi"
    }
  ],
  "Telegram": [
    {
      "Name": "Telegram",
      "URL": "https://t.me/s/joeturan",
      "OutputPath": "../www/Telegram"
    }
  ]
}
```

Weitere Autoren oder Kanäle werden als zusätzliche
Objekte mit `Name`, `URL` und `OutputPath` im passenden Array ergänzt. Leere
Platzhalter gehören nicht in die aktive Config, da jeder Eintrag aufgerufen wird.

Pro Beitrag entsteht eine Markdown-Datei (Blog/Facebook zusätzlich das Bild mit
gleichem Dateinamen-Stamm). Jede Quelle bricht nach **3** bereits vorhandenen
Artikeln ab (`SKIP_LIMIT`). Der Scraper ist self-contained (eigene
`node_modules`), damit die WebArchiv-App-Abhängigkeiten schlank bleiben.

## Voraussetzungen

- Node.js **>= 18**

```bash
cd scraper
npm install
npx playwright install chromium
```

## Ausführung

```bash
# Alle drei Quellen (Blog -> Facebook -> Telegram)
node scrape_all.js

# Einzelne Quellen (kombinierbar)
node scrape_all.js --telegram
node scrape_all.js --blog --facebook

# Browser sichtbar (Debugging)
node scrape_all.js --visible

# Hilfe / alle Optionen
node scrape_all.js --help

# Alternative Config-Datei
node scrape_all.js --config ./meine-scraper-config.json
```

Bequem aus dem Projekt-Root: `npm run scrape` (falls in der Wurzel-`package.json`
eingetragen).

### Facebook-Eingaben

Für die Facebook-Quellen in `scraper/` ablegen:

- `cookies.txt` — Login-Cookies im **Netscape-Format**

Die URLs kommen ausschließlich aus `scraper-config.json`. Alle konfigurierten
Facebook-Quellen verwenden dieselbe Cookie-Datei.

## Nach dem Lauf: Reindex

Der WebArchiv-Server baut seinen Index beim Start und über `POST /api/reindex`
(Admin). Damit neu gescrapte Artikel erscheinen, nach dem Lauf **reindexen**
(Admin-UI „Reindex" oder Serverneustart). Neue Namen aus der Config werden
automatisch als Autorenverzeichnisse angelegt (z. B. `Nawal Boussi`). Ggf. ACL
(`users.json` / `public-directories.txt`) anpassen.

## Sync-Hinweis

Diese Datei ist eine Kopie von `BlogDownloader/node/scrape_all.js`. Der
WebArchiv-Scraper erlaubt als Ausgabe-Stamm `../www/`, der eigenständige
Node-Port sein lokales `www/`. Bei Änderungen an der Scraping-Logik beide
Kopien synchron halten.
