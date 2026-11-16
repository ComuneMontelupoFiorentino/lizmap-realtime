#!/bin/sh
# Aggiunge al crontab dell'utente corrente (una sola volta) la riga che tiene
# attivo il raccoglitore. Non richiede sudo né l'amministratore di sistema.
#
#   sh installa-cron.sh            aggiunge la riga
#   sh installa-cron.sh --rimuovi  la toglie
#
# Come funziona: cron lancia il raccoglitore ogni minuto; il raccoglitore prende un
# lucchetto e, se un'altra copia è già attiva, esce subito senza fare nulla.
# Risultato: un solo processo sempre attivo, riavviato entro un minuto se si ferma
# (riavvio del server, errore, aggiornamento di collector.php).

set -e
DIR=$(cd "$(dirname "$0")/.." && pwd)          # cartella con collector.php e sources.json
PHP=$(command -v php || true)
[ -n "$PHP" ] || { echo "php non trovato nel PATH"; exit 1; }
[ -f "$DIR/collector.php" ] || { echo "collector.php non trovato in $DIR"; exit 1; }
[ -f "$DIR/sources.json" ] || { echo "manca $DIR/sources.json (copiare sources.example.json)"; exit 1; }

MARK="lizmap-realtime collector"
LINE="* * * * * $PHP $DIR/collector.php --loop --config=$DIR/sources.json --log=$DIR/collector.log >/dev/null 2>&1 # $MARK"

CURRENT=$(crontab -l 2>/dev/null || true)

if [ "$1" = "--rimuovi" ]; then
  printf '%s\n' "$CURRENT" | grep -vF "# $MARK" | crontab -
  "$PHP" "$DIR/collector.php" --stop --config="$DIR/sources.json" || true
  echo "riga di cron rimossa e raccoglitore fermato"
  exit 0
fi

if printf '%s\n' "$CURRENT" | grep -qF "# $MARK"; then
  echo "la riga di cron è già presente:"
  printf '%s\n' "$CURRENT" | grep -F "# $MARK"
  exit 0
fi

{ [ -n "$CURRENT" ] && printf '%s\n' "$CURRENT"; printf '%s\n' "$LINE"; } | crontab -
echo "aggiunta al crontab:"
echo "  $LINE"
echo "il raccoglitore partirà entro un minuto; verifica con:"
echo "  php $DIR/collector.php --status --config=$DIR/sources.json"
