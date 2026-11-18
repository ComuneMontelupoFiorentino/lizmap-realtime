# lizmap-realtime

Livelli **in tempo reale** per [Lizmap Web Client](https://github.com/3liz/lizmap-web-client)
(3.9 / 3.11 e successive 3.x): bus, sensori IoT, meteo, traffico, mezzi di servizio…
mostrati come livelli del pannello **Layer**, con metadati, opacità, export, viste (temi)
e permessi di Lizmap, **senza sovraccaricare il server né le fonti esterne**.

```
 Fonti esterne ──► collector.php ──► cache/*.geojson ──► modulo Lizmap ──► realtime-layers.js
 (API, sensori,    (unico processo     (file scritti      "realtime"         (motore nel browser:
  GTFS-RT…)         che le interroga,   in modo atomico)   permessi Lizmap,   legenda, stile, popup,
                    ognuna col suo                         1 richiesta/ciclo, barra di stato)
                    intervallo)                            204 se nulla cambia)
```

**Regola d'oro:** il numero di utenti collegati non cambia il numero di richieste verso le fonti.
Il browser chiede solo i livelli accesi e visibili alla scala corrente, e si ferma quando la
scheda non è in primo piano.

## Cosa si ottiene

- livelli in cima al pannello Layer, organizzati in gruppi dichiarati nel JSON;
- casella, icona di legenda, pannello **Information** nativo di Lizmap (zoom, opacità, export GeoJSON,
  descrizione, fonte, licenza, stato, ultimo dato, frequenza, sistema di riferimento);
- **barra di stato** in basso con il pallino lampeggiante, una riga per ogni livello acceso
  (verde = aggiornato, arancione = dato vecchio, rosso = errore);
- stile dichiarativo (colori per valore o per intervalli, frecce orientate, icone, etichette a scala);
- visibilità per scala (`maxScaleDenominator`, come in QGIS);
- livelli accesi e spenti dalle viste/temi del progetto;
- permessi: un utente vede i livelli solo se ha accesso al progetto e, se indicato, a uno dei gruppi Lizmap scelti;
- plugin per livelli disegnati da script dedicati (esempio: i bus con animazione e itinerario).

## Contenuto del repository

| Cartella | Contenuto | Dove va sul server |
|---|---|---|
| `client/realtime-layers.js` | motore nel browser | `<repository Lizmap>/media/js/default/` |
| `client/themes-switcher.js` | selettore delle viste (facoltativo) | `<repository Lizmap>/media/js/default/` |
| `examples/realtime/*.json` | configurazioni di esempio dei livelli | `<repository Lizmap>/media/realtime/` |
| `lizmap-module/realtime/` | modulo Lizmap (configurazione e dati con i permessi) | `lizmap/lizmap-modules/realtime/` |
| `collector/` | raccoglitore, fonti di esempio, cron, systemd | una cartella fuori dal web, es. `~/lizmap-realtime/` |
| `plugins/bus/` | plugin di esempio: bus TPL da GTFS-RT | `<repository Lizmap>/media/js/default/` |
| `docs/` | documentazione | — |

## Avvio rapido (senza sudo)

```bash
# 1. raccoglitore
mkdir -p ~/lizmap-realtime && cp -r collector/* ~/lizmap-realtime/
cd ~/lizmap-realtime && cp sources.example.json sources.json
#    in sources.json impostare "cache_dir" su una cartella leggibile da Apache/php-fpm
php collector.php --once=demo --config=sources.json     # prova
sh cron/installa-cron.sh                                 # avvio automatico con cron

# 2. modulo Lizmap (una volta per tutto Lizmap)
cd /var/www/lizmap-web-client-3.x
cp -r <questo repo>/lizmap-module/realtime lizmap/lizmap-modules/
php lizmap/install/configurator.php realtime    # indicare la stessa cache_dir
php lizmap/install/installer.php

# 3. per ogni repository Lizmap che usa i livelli
cp client/realtime-layers.js  /srv/data/<repo>/media/js/default/
mkdir -p /srv/data/<repo>/media/realtime
cp examples/realtime/default.json /srv/data/<repo>/media/realtime/
```

Dettagli, variante con systemd e verifiche: [docs/installazione.md](docs/installazione.md).

## Documentazione

1. [Come funziona](docs/come-funziona.md): architettura, flusso dei dati, carico, sicurezza
2. [Installazione](docs/installazione.md): senza sudo (cron) o con systemd
3. [Configurazione dei livelli](docs/configurazione-livelli.md): riferimento completo del JSON
4. [Fonti di dati](docs/fonti.md): `sources.json` e come aggiungere una nuova fonte IoT
5. [Aggiungere un livello a un altro progetto](docs/nuovo-progetto.md): la procedura passo per passo
6. [Plugin](docs/plugin.md): livelli disegnati da script dedicati (esempio bus) e API JavaScript
7. [Risoluzione dei problemi](docs/risoluzione-problemi.md)

## Requisiti

- Lizmap Web Client 3.9 o successive 3.x (motore verificato sul codice di 3.9.12 e 3.11);
- PHP 7.4+ da riga di comando per il raccoglitore (estensione curl consigliata);
- un crontab utente **oppure** systemd (per tenere attivo il raccoglitore);
- nel repository Lizmap, l'opzione per i JavaScript personalizzati attiva.

## Parte di Prosit

Questo componente fa parte di **[Prosit](https://github.com/ComuneMontelupoFiorentino/prosit)**,
il Sistema Informativo Territoriale del Comune di Montelupo Fiorentino. Nel repository
[prosit](https://github.com/ComuneMontelupoFiorentino/prosit) ci sono l'architettura, l'elenco
di tutti i componenti (topic [`prosit`](https://github.com/search?q=org%3AComuneMontelupoFiorentino+topic%3Aprosit&type=repositories))
e le versioni che funzionano insieme.

## Licenza

[Mozilla Public License 2.0](LICENSE), la stessa di Lizmap Web Client.
