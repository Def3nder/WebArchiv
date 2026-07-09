# WebArchiv — Scraper

Eigenständiger Scraper (Blog + Facebook + Telegram) für WebArchiv. Node.js-Port
von `BlogDownloader/node/scrape_all.js`; **einziger Unterschied**: die Ausgabe
geht ins `www/` des WebArchiv-Projekt-Roots (eine Ebene höher), das der Server
rendert.

| Quelle | Zielordner (im Projekt-Root) |
|---|---|
| Blog (`joeturan.com/blog`) | `../www/Joe Turan/<Jahr>/` |
| Telegram (`t.me/s/<channel>`) | `../www/Telegram/<Jahr>/` |
| Facebook (login-pflichtig) | `../www/Facebook/<Jahr>/` |

Pro Beitrag entsteht eine Markdown-Datei (Blog/Facebook zusätzlich das Bild mit
gleichem Dateinamen-Stamm). Jede Quelle bricht nach **5** bereits vorhandenen
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
```

Bequem aus dem Projekt-Root: `npm run scrape` (falls in der Wurzel-`package.json`
eingetragen).

### Facebook-Eingaben

Für die Facebook-Quelle in `scraper/` ablegen (oder per CLI überschreiben):

- `cookies.txt` — Login-Cookies im **Netscape-Format**
- `Abonenten-URL.txt` — die zu scrapende Facebook-URL

## Nach dem Lauf: Reindex

Der WebArchiv-Server baut seinen Index beim Start und über `POST /api/reindex`
(Admin). Damit neu gescrapte Artikel erscheinen, nach dem Lauf **reindexen**
(Admin-UI „Reindex" oder Serverneustart). Ein neuer FB-Lauf legt den Autor
`Facebook` an — ggf. ACL (`users.json` / `public-directories.txt`) anpassen.

## Sync-Hinweis

Diese Datei ist eine Kopie von `BlogDownloader/node/scrape_all.js` und
unterscheidet sich nur in den drei Zielpfaden. Bei Änderungen an der
Scraping-Logik beide Kopien synchron halten.
