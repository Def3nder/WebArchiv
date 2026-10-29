#!/usr/bin/env bash
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
LOG=/opt/nodeapp/scraper/cron-scrape.log
cd /opt/nodeapp/scraper || exit 1

# Scrapen (alle drei Quellen; für nur Telegram: --telegram usw.)
/usr/bin/node scrape_all.js >> "$LOG" 2>&1
echo "$(date '+%F %T') Scraper exit $?" >> "$LOG"

# Laufenden Server neu einlesen lassen, ohne Prozess, Sessions oder laufende
# Verbindungen zu verwerfen: SIGHUP direkt an den Hauptprozess. Dienst und Cron
# laufen beide als ralf, deshalb ohne sudo. (sudo fragt im Cron ohne passende
# sudoers-Regel nach einem Kennwort und scheitert dort still; bis 28.10.2026 kam
# das Signal deshalb nie an.) Der externe Lauf löst einen Voll-Reindex aus, weil
# sein Änderungsmanifest nicht über die Web-UI übertragen wird.
PID=$(/usr/bin/systemctl show -p MainPID --value nodeapp)
if [ "${PID:-0}" -gt 0 ] 2>/dev/null && kill -HUP "$PID" 2>> "$LOG"; then
  echo "$(date '+%F %T') SIGHUP an nodeapp (PID $PID) gesendet" >> "$LOG"
else
  echo "$(date '+%F %T') FEHLER: SIGHUP an nodeapp nicht gesendet (MainPID '${PID}')" >> "$LOG"
  exit 1
fi
