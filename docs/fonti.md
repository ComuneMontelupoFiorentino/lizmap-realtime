# Fonti di dati (`sources.json`)

Il file sta accanto a `collector.php`, **fuori dalla cartella web**: può contenere URL interni,
chiavi e token, che non arrivano mai al browser. Non va pubblicato su GitHub (è in `.gitignore`;
nel repository c'è solo `sources.example.json`).

```jsonc
{
  "cache_dir": "/srv/data/realtime-cache",    // la stessa indicata al modulo Lizmap
  "timezone": "Europe/Rome",                  // per gli orari nel log
  "user_agent": "lizmap-realtime-collector/1.0 (Comune di …)",
  "verbose": false,                           // true = una riga di log per ogni aggiornamento
  "sources": {
    "<id>": { "type": "…", "interval": 60, … }
  }
}
```

Una fonte è **condivisa** da tutti i progetti e repository: si dichiara una volta sola e la usano
i livelli (anche di progetti diversi) che hanno `"source": "<id>"`.

## Campi comuni

| Campo | Significato |
|---|---|
| `type` | `geojson`, `custom`, `demo` |
| `interval` | secondi tra un aggiornamento e l'altro (minimo 2). Non scendere sotto la frequenza reale della fonte: non porta dati nuovi |
| `disabled` | `true` = fonte ignorata |
| `bbox` | `[lonMin, latMin, lonMax, latMax]`: tiene solo gli elementi nell'area |
| `properties` | elenco dei campi da tenere (gli altri vengono tolti: dati più leggeri e niente campi riservati nel browser) |
| `max_features` | limite di elementi |
| `timeout` | secondi di attesa della risposta (default 15) |

## Tipo `geojson`: nessun codice da scrivere

Per fonti che rispondono già in GeoJSON:

```json
"traffico": {
  "type": "geojson",
  "url": "https://api.esempio.it/traffico.geojson",
  "headers": { "Authorization": "Bearer XXXXX" },
  "interval": 120,
  "bbox": [10.95, 43.68, 11.06, 43.76],
  "properties": ["nome", "velocita", "stato"]
}
```

Va bene anche un servizio interno (una vista PostGIS esposta come GeoJSON, un WFS con
`outputFormat=application/json`, un endpoint di una piattaforma IoT…).

## Tipo `custom`: piccolo trasformatore PHP

Per API che non restituiscono GeoJSON (JSON con altra struttura, CSV, XML, protobuf…):

1. copiare [`collector/sources/_modello.php`](../collector/sources/_modello.php) in `sources/<nome>.php`;
2. adattare il ciclo che costruisce le feature;
3. dichiarare la fonte:

```json
"aria": {
  "type": "custom",
  "script": "sources/aria.php",
  "interval": 300,
  "url": "https://api.esempio.it/stazioni",
  "token": "XXXXX"
}
```

Lo script restituisce una funzione `function (array $source, callable $http): array`: riceve la voce di
`sources.json` (con tutti i campi, anche quelli personalizzati come `token` o `points`) e una funzione
`$http($url, $headers, $timeout)` già configurata; restituisce una FeatureCollection. Esempio completo:
[`sources/meteo_openmeteo.php`](../collector/sources/meteo_openmeteo.php).

## Tipo `demo`

Veicoli finti che girano attorno a `center`: serve per provare l'installazione senza fonti reali.

```json
"demo": { "type": "demo", "interval": 10, "center": [10.9963, 43.7225], "count": 8, "radius_m": 1500 }
```

## Provare una fonte

```bash
php collector.php --once=aria --config=sources.json     # esegue una volta e scrive aria.geojson
php collector.php --list  --config=sources.json         # età dei file di ogni fonte
```

Una modifica a `sources.json` vale senza riavvio: il raccoglitore lo rilegge da solo
(se il file nuovo ha un errore resta la configurazione precedente e il log lo segnala).

## Serve un PHP come `bus.php` per ogni fonte IoT?

**No.** Le fonti IoT passano dal raccoglitore: serve solo una voce in `sources.json`, più un piccolo
trasformatore in `sources/` se l'API non parla GeoJSON. Nessun file PHP pubblico, nessun endpoint nuovo.

`bus.php` è un caso particolare, legato al plugin bus (vedi [plugin.md](plugin.md#il-caso-bus-e-busphp)).
