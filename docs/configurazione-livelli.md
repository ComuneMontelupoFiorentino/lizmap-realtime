# Configurazione dei livelli

File: `<repository>/media/realtime/<progetto>.json`, oppure `default.json` per tutti i progetti
del repository che non hanno un file proprio. Il file è letto **dal modulo, lato server**: un
utente riceve solo i livelli che può vedere.

Esempi completi: [`examples/realtime/`](../examples/realtime/).

## Struttura

```jsonc
{
  "version": 1,
  "statusBar": true,                                        // barra di stato in basso (default: true)
  "defaults": { "interval": 30, "crs": "EPSG:4326", "visible": false },  // valori comuni a tutti i livelli
  "projections": { "EPSG:3003": "+proj=tmerc …" },          // CRS che Lizmap non conosce
  "groups": [                                               // ordine = ordine in legenda (in cima)
    { "id": "mobilita", "title": "Mobilità", "expanded": true,
      "groups": ["uffici"],                                 // facoltativo: tutto il gruppo solo per questi gruppi Lizmap
      "layers": [ { … }, { … } ] }
  ]
}
```

Un solo livello di annidamento (gruppi → livelli): Lizmap non permette sottogruppi dentro
un gruppo esterno.

## Campi di un livello

| Campo | Significato |
|---|---|
| `id` | identificatore univoco (a-z 0-9 _ -) |
| `title` | nome in legenda |
| `source` | id della fonte in `sources.json` (dati dal raccoglitore, tramite il modulo) |
| `plugin` | in alternativa: livello disegnato da uno script dedicato (es. `"bus"`, vedi [plugin.md](plugin.md)) |
| `url` | in alternativa: GeoJSON statico servito dal web server (ETag/304). **Non passa dal modulo, quindi è pubblico**: solo per dati aperti |
| `groups` | gruppi Lizmap autorizzati. Senza: tutti gli utenti con accesso al progetto. Gli amministratori vedono tutto |
| `crs` | sistema di riferimento dei dati, es. `EPSG:4326`, `EPSG:3003`, `EPSG:6707` |
| `proj4` | definizione proj4 del `crs`, se Lizmap non lo conosce (oppure in `projections`) |
| `interval` | secondi tra un aggiornamento e l'altro nel browser (di solito uguale a quello della fonte) |
| `visible` | acceso all'apertura della mappa |
| `maxScaleDenominator` | visibile e richiesto solo da questa scala in giù: `50000` = da 1:50.000 verso scale più dettagliate (come in QGIS) |
| `minScaleDenominator` | nascosto a scale più dettagliate di questa, es. `500` |
| `themes` | viste in cui il livello è acceso, es. `["Mobilità"]`. Se presente, scegliere una vista lo accende o lo spegne |
| `staleAfter` | secondi oltre i quali il dato è "vecchio": livello attenuato, pallino arancione (default 4 × `interval`) |
| `maxFeatures` | limite di elementi disegnati (default 5000) |
| `opacity` | opacità iniziale 0–1 (modificabile dal pannello Information) |
| `geometry` | `point` (default), `line`, `polygon`: solo per l'icona di legenda generata |
| `legendIcon` | icona di legenda come data URL (`data:image/svg+xml;base64,…` o `data:image/png;base64,…`) |
| `statusBar` | `false` per non mostrare questo livello nella barra di stato |
| `style` | vedi sotto |
| `popup` | vedi sotto, oppure `false` per nessun popup |
| `metadata` | `{ "abstract", "source", "license", "url", "contact" }`, mostrati nel pannello Information |

## Stile

```jsonc
"style": {
  "radius": 7, "fill": "#0066CC", "stroke": "#ffffff", "strokeWidth": 2,
  "rotateBy": "heading",                         // freccia orientata secondo il campo (gradi da nord)
  "icon": "https://…/icona.svg", "iconScale": 1, // in alternativa a cerchio/freccia
  "colorBy": { "field": "stato", "values": { "ok": "#008055", "guasto": "#CC334D" }, "default": "#5D7083" },
  // oppure per intervalli numerici:
  "colorBy": { "field": "pm10", "ranges": [ { "max": 25, "color": "#008055" },
                                            { "min": 25, "max": 50, "color": "#E5A00D" },
                                            { "min": 50, "color": "#CC334D" } ] },
  "label": { "field": "nome", "maxScaleDenominator": 10000 },   // etichette solo da 1:10.000 in giù
  "width": 4, "lineDash": [6, 4], "fillOpacity": 0.35,           // linee e poligoni
  "custom": "nomeStile"                                          // stile scritto in JS (vedi plugin.md)
}
```

## Popup

```jsonc
"popup": {
  "title": "{nome} – {comune}",                 // segnaposto {campo}
  "fields": [
    { "field": "pm10", "label": "PM10", "suffix": " µg/m³", "decimals": 0 },
    { "field": "stato", "label": "Stato", "map": { "0": "spento", "1": "attivo" } }
  ]
}
```

Senza `fields` il popup mostra fino a 12 campi semplici così come arrivano.

## Pannello Information e barra di stato

Sono automatici, per tutti i livelli (anche i plugin):

- **Information** (icona "i" in legenda): nome, tipo, zoom sull'estensione, opacità, export
  GeoJSON, descrizione, stato, ultimo dato, frequenza, sistema di riferimento, fonte, licenza.
- **Barra di stato** in basso al centro, una riga per ogni livello acceso e visibile alla scala:
  `● Titolo · N elementi · aggiornato hh:mm:ss (dati di X min fa)`.
  Pallino verde lampeggiante = aggiornato; arancione = dato vecchio (`staleAfter`); rosso = errore;
  grigio = in attesa del primo dato. Disattivabile con `"statusBar": false` (tutta o per livello).

## Viste (temi)

Con `themes-switcher.js` o con il menu "Temi" nativo di Lizmap: quando si sceglie una vista,
i livelli che hanno `themes` si accendono se il nome della vista è nell'elenco, altrimenti si
spengono. I livelli senza `themes` non vengono toccati.

## Esempio minimo

```json
{
  "groups": [
    { "id": "sensori", "title": "Sensori", "layers": [
      { "id": "aria", "title": "Qualità dell'aria", "source": "aria", "interval": 300,
        "crs": "EPSG:4326", "visible": true,
        "style": { "radius": 8, "colorBy": { "field": "pm10",
          "ranges": [ { "max": 25, "color": "#008055" }, { "min": 25, "color": "#CC334D" } ] } },
        "popup": { "title": "{nome}", "fields": [ { "field": "pm10", "label": "PM10", "suffix": " µg/m³" } ] },
        "metadata": { "abstract": "Centraline di misura", "source": "ARPA", "license": "CC BY 4.0" } }
    ] }
  ]
}
```
