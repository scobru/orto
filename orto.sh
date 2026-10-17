#!/bin/sh
cd "$(dirname "$0")"
if [ -x "./node" ]; then
  exec ./node --no-warnings desktop.js
elif command -v node >/dev/null 2>&1; then
  exec node --no-warnings desktop.js
else
  echo "Errore: Node.js non trovato. Installa Node.js per avviare Orto."
  exit 1
fi
