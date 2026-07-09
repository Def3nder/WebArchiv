#!/usr/bin/env bash
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
cd /opt/nodeapp/scraper

# Scrapen (alle drei Quellen; für nur Telegram: --telegram usw.)
/usr/bin/node scrape_all.js >> /opt/nodeapp/scraper/cron-scrape.log 2>&1
echo "$(date '+%F %T') Scraper exit $?" >> /opt/nodeapp/scraper/cron-scrape.log

# Laufenden Server neu einlesen lassen, damit neue Artikel sofort erscheinen:
sudo /usr/bin/systemctl restart nodeapp