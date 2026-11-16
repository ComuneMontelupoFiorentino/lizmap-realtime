# Risoluzione dei problemi

Prima di tutto: console del browser (F12), filtro `realtime`.

| Sintomo | Causa probabile | Cosa fare |
|---|---|---|
| Nessun gruppo in legenda, nessun messaggio `[realtime]` | script non caricato | file in `<repo>/media/js/default/`? Opzione JavaScript personalizzati attiva nel repository? Cache del browser svuotata? |
| `[realtime] modulo realtime non raggiungibile (HTTP 404)` | modulo non installato o URL non riconosciuto | rifare `configurator.php realtime` e `installer.php`, svuotare la cache di Lizmap |
| `config` risponde `{"error":"forbidden"}` | l'utente non ha accesso al progetto | normale per utenti non autorizzati; verificare i diritti del repository |
| `config` risponde con `groups: []` | nessun JSON in `media/realtime/` o livelli tutti riservati a gruppi | controllare il nome del file (`<progetto>.json` o `default.json`) e `groups` |
| Pallino rosso, stato `server: not_found` | nessun file `<fonte>.geojson` nella cache **vista da Lizmap** | `php collector.php --list --config=…`; il raccoglitore è attivo? (`--status`); stessa cartella in `sources.json` e in `localconfig.ini.php`; `www-data` può attraversare le cartelle (vedi sotto) |
| Pallino rosso, stato `server: read_error` | file presente ma non leggibile da `www-data` | file 644, cartella 755 |
| Pallino rosso, stato `server: forbidden` | l'utente non è in nessuno dei `groups` del livello | normale per gli utenti non autorizzati |
| Pallino arancione "dato non aggiornato" | la fonte non risponde, o raccoglitore fermo | `tail collector.log`; `--status`; provare `--once=<id>` |
| Pallino rosso, altro testo | errore della richiesta o del plugin | il testo completo è nella riga "Stato" del pannello Information (icona "i") |
| Dati in cache ma il livello resta vuoto | `www-data` non legge la cartella di cache | permessi: cartella 755, file 644, e `x` su tutte le cartelle sopra; stessa cartella in `sources.json` e in `localconfig.ini.php` `[realtime] cacheDir` |
| Funziona da riga di comando ma non dal web, cartella corretta | `open_basedir` di php-fpm | mettere la cache in una cartella permessa (es. sotto `/srv/data`) |
| Il livello compare solo a certe scale | `maxScaleDenominator` / `minScaleDenominator` | il pannello Information dice "fuori scala" con la scala attuale |
| Elementi nel posto sbagliato (mare, Africa…) | `crs` errato | indicare il sistema dei dati, non quello del progetto; per CRS sconosciuti aggiungere `proj4` |
| `plugin "bus" non caricato` | script del plugin assente o vecchio | copiare `bus-realtime.js` aggiornato nella stessa cartella del motore |
| Il raccoglitore si ferma quando esco dal terminale | lanciato a mano o con systemd `--user` senza linger | usare cron: `sh cron/installa-cron.sh` |
| Due raccoglitori attivi? | — | impossibile: il secondo trova il lucchetto ed esce. `--status` mostra il pid di quello attivo |
| Ho aggiornato `collector.php` ma non cambia nulla | gira ancora la versione vecchia | `php collector.php --stop --config=…`: cron lo riavvia entro un minuto |
| Ho modificato `sources.json` ma non cambia nulla | errore di sintassi nel file | il log dice "configurazione NON ricaricata"; verificare il JSON |

## Controlli rapidi

```bash
cd ~/lizmap-realtime
php collector.php --status --config=sources.json
php collector.php --list   --config=sources.json
tail -n 50 collector.log
crontab -l | grep lizmap-realtime
```

Da browser, collegati a Lizmap:

```
…/index.php/realtime/default/config?repository=<repo>&project=<progetto>
…/index.php/realtime/default/data?repository=<repo>&project=<progetto>&layers=<id>:0
```

## Sicurezza

- `sources.json` contiene URL e chiavi: tenerlo fuori dalla cartella web e fuori da Git.
- I dati passano sempre dal modulo, che applica i diritti di Lizmap. Fa eccezione solo il campo
  `url` di un livello (file statico pubblico): usarlo solo per dati aperti.
- Il campo `properties` delle fonti toglie i campi che non devono arrivare al browser.
