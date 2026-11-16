# Installazione

Ci sono due varianti, che differiscono solo per **come resta acceso il raccoglitore**:

- **A. senza sudo**: tutto con il proprio utente, raccoglitore tenuto attivo da cron;
- **B. con sudo**: raccoglitore come servizio systemd di sistema, utente `www-data`.

I passi 2 (modulo) e 3 (browser) sono uguali.

Esempi con Lizmap in `/var/www/lizmap-web-client-3.9.12`, repository Lizmap in `/srv/data/<repo>`,
Apache con php-fpm che gira come `www-data`.

---

## 1A. Raccoglitore senza sudo (cron)

```bash
mkdir -p ~/lizmap-realtime
cp -r collector/* ~/lizmap-realtime/
cd ~/lizmap-realtime
cp sources.example.json sources.json
```

### Cartella di cache

Il raccoglitore (il vostro utente) scrive i file; Lizmap (`www-data`) li legge. La cartella deve
quindi essere **scrivibile da voi** e **leggibile da www-data**, comprese tutte le cartelle
sopra di essa (permesso `x`). Due possibilità:

```bash
# a) fuori dalla home, se avete una cartella scrivibile (consigliato)
mkdir -p /srv/data/realtime-cache && chmod 755 /srv/data/realtime-cache

# b) dentro la home: la home deve essere attraversabile (non leggibile) dagli altri
mkdir -p ~/lizmap-realtime/cache && chmod 755 ~/lizmap-realtime ~/lizmap-realtime/cache
chmod o+x ~          # solo "attraversare", non elencare il contenuto
```

Scrivere il percorso in `sources.json`:

```json
"cache_dir": "/srv/data/realtime-cache",
"timezone": "Europe/Rome",
```

### Prova

```bash
php collector.php --once=demo --config=sources.json    # deve scrivere demo.geojson
php collector.php --list --config=sources.json         # fonti, età dei file, stato del servizio
```

### Avvio automatico con cron

```bash
sh cron/installa-cron.sh
```

Lo script aggiunge al **vostro** crontab (una sola volta) questa riga:

```cron
* * * * * /usr/bin/php /home/<voi>/lizmap-realtime/collector.php --loop --config=/home/<voi>/lizmap-realtime/sources.json --log=/home/<voi>/lizmap-realtime/collector.log >/dev/null 2>&1 # lizmap-realtime collector
```

In alternativa si aggiunge a mano con `crontab -e`, usando il percorso completo di php (`command -v php`),
perché cron ha un PATH ridotto.

Verifica dopo un minuto:

```bash
php collector.php --status --config=sources.json       # "in esecuzione (pid …)"
tail -f collector.log
```

Comandi utili:

| Comando | Effetto |
|---|---|
| `php collector.php --status --config=sources.json` | in esecuzione o fermo |
| `php collector.php --stop --config=sources.json` | lo ferma; cron lo riavvia entro un minuto (da usare dopo aver aggiornato `collector.php`) |
| `sh cron/installa-cron.sh --rimuovi` | toglie la riga di cron e ferma il raccoglitore |

Il log ruota da solo oltre 1 MB (`collector.log.1`). Modificare `sources.json` **non** richiede
riavvio.

> Se in passato è stato attivato il servizio systemd utente, disattivarlo prima:
> `systemctl --user disable --now lizmap-realtime-collector`. Anche se restassero attivi
> entrambi non ci sarebbero doppioni (il lucchetto lo impedisce), ma è meglio averne uno solo.

## 1B. Raccoglitore con sudo (systemd)

```bash
sudo mkdir -p /opt/lizmap-realtime /var/lib/lizmap-realtime/cache
sudo cp -r collector/* /opt/lizmap-realtime/
sudo cp /opt/lizmap-realtime/sources.example.json /opt/lizmap-realtime/sources.json
sudo chown -R www-data:www-data /var/lib/lizmap-realtime
sudo -u www-data php /opt/lizmap-realtime/collector.php --once=demo --config=/opt/lizmap-realtime/sources.json

sudo cp collector/systemd/lizmap-realtime-collector.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now lizmap-realtime-collector
journalctl -u lizmap-realtime-collector -f
```

---

## 2. Modulo Lizmap (una volta per tutta l'installazione di Lizmap)

```bash
cd /var/www/lizmap-web-client-3.9.12
cp -r <questo repo>/lizmap-module/realtime lizmap/lizmap-modules/
php lizmap/install/configurator.php realtime     # chiede la cartella di cache: la stessa di sources.json
php lizmap/install/installer.php
./lizmap/install/clean_vartmp.sh                 # se i permessi lo consentono
```

(con sudo: anteporre `sudo` e lanciare anche `./lizmap/install/set_rights.sh`).

La cartella di cache si può anche scrivere a mano in `lizmap/var/config/localconfig.ini.php`:

```ini
[realtime]
cacheDir=/srv/data/realtime-cache
```

Verifica, da browser **collegati a Lizmap**:

```
http://<server>/lizmap/index.php/realtime/default/config?repository=<repo>&project=<progetto>
```

Deve restituire il JSON dei livelli (dopo il passo 3). `{"error":"forbidden"}` = utente senza
accesso al progetto; 404 = repository o progetto inesistente.

## 3. Browser (per ogni repository Lizmap)

```bash
cp client/realtime-layers.js /srv/data/<repo>/media/js/default/
mkdir -p /srv/data/<repo>/media/realtime
cp examples/realtime/default.json /srv/data/<repo>/media/realtime/
```

- `media/js/default/` = script caricato in **tutti** i progetti del repository
  (per un solo progetto: `media/js/<progetto>/`).
- Nella configurazione del repository (amministrazione Lizmap) deve essere attiva
  l'opzione per i JavaScript personalizzati.
- Facoltativi nella stessa cartella: `client/themes-switcher.js` (selettore delle viste)
  e i plugin (es. `plugins/bus/bus-realtime.js`).

Ricaricare la mappa: in cima al pannello Layer compaiono i gruppi del JSON. In console del browser:
`[realtime] v1.3.0 - N livelli`.

## Aggiornare

| Pezzo | Come |
|---|---|
| `realtime-layers.js`, plugin | sostituire il file e ricaricare la pagina (svuotare la cache del browser) |
| JSON dei livelli | modificare il file: vale al prossimo caricamento della mappa |
| `sources.json` | modificare il file: il raccoglitore lo rilegge da solo |
| `collector.php` | sostituire il file, poi `php collector.php --stop …` (cron lo riavvia) |
| modulo | sostituire la cartella in `lizmap/lizmap-modules/realtime` e svuotare la cache di Lizmap |
