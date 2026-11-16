# Plugin e API JavaScript

## Quando serve un plugin

Quasi mai. Un livello normale (`"source": …`) è disegnato dal framework con lo stile del JSON e
copre sensori, mezzi, stazioni, segnalazioni… Un plugin serve quando il disegno è davvero
particolare: animazioni fluide tra due posizioni, elementi HTML sulla mappa, interazioni proprie
(esempio: i bus con l'itinerario della corsa al clic).

Nel plugin il framework continua a gestire **casella in legenda, viste, pannello Information
(zoom, opacità, export), barra di stato**; il plugin si occupa solo di prendere i dati e disegnarli.

## Dichiarazione nel JSON

```json
{ "id": "bus", "title": "Bus TPL", "plugin": "bus", "visible": true, "themes": ["Mobilità"],
  "metadata": { "abstract": "…", "source": "Regione Toscana – GTFS-RT" } }
```

Niente `source`: i dati li prende il plugin.

## Contratto del plugin

```js
LizRealtime.registerPlugin('bus', {
  // OBBLIGATORIO: casella accesa/spenta (anche da una vista). Da spento: nascondere tutto
  // e NON fare richieste.
  setVisible: function (on, layer) { … },

  // facoltativo: abilita "Opacità" nel pannello Information (v da 0 a 1)
  setOpacity: function (v) { … },

  // facoltativo: abilita "Zoom sull'estensione" ed "Esporta". Restituisce una FeatureCollection
  // in EPSG:4326 (o nel "crs" dichiarato nel JSON)
  getGeoJSON: function () { return { type: 'FeatureCollection', features: [ … ] }; }
});

// dopo ogni aggiornamento (riuscito o no): alimenta barra di stato e pannello Information
LizRealtime.reportStatus('bus', {
  count: 12,                       // numero di elementi
  updated: 1731590000,             // istante del dato (secondi epoch)
  error: null,                     // testo dell'errore, oppure null
  interval: 10,                    // secondi tra un aggiornamento e l'altro
  text: '12 bus nell\'area'        // facoltativo: sostituisce "12 elementi"
});
```

Lo script del plugin può caricarsi prima o dopo `realtime-layers.js`: conviene cercare
`window.LizRealtime` per qualche secondo (vedi `plugins/bus/bus-realtime.js`, funzione `registerPlugin`).
Se nel JSON c'è un livello plugin ma lo script non è caricato, il pannello Information mostra
`plugin "bus" non caricato`.

## Altre API (`window.LizRealtime`)

```js
// stile scritto in JS, usato con "style": { "custom": "aerei" }
LizRealtime.registerStyle('aerei', function (feature, resolution, ol, layer) {
  return new ol.style.Style({ /* … */ });
});

LizRealtime.setVisible('meteo', true);   // accende/spegne un livello
LizRealtime.applyTheme('Ambiente');      // applica una vista ai livelli con "themes"
LizRealtime.layers;                      // stato dei livelli (diagnostica in console)
LizRealtime.version;                     // versione del motore
```

## Il caso bus e `bus.php`

Il plugin di esempio `plugins/bus/bus-realtime.js` disegna i bus del trasporto pubblico e prende i
dati da **`bus.php`**, un servizio PHP separato (non incluso qui: va scritto per il proprio feed).

`bus.php` è indispensabile **solo per i bus**, perché fa tre cose che il raccoglitore generico non fa:

1. legge il feed **GTFS-RT** regionale, che è in formato *protobuf* binario, non GeoJSON;
2. arricchisce ogni veicolo unendolo ai dati GTFS statici in PostgreSQL (linea, colore,
   destinazione, ritardo);
3. risponde **al clic** con l'itinerario della corsa scelta (`?trip=…`), un dato che dipende
   dall'utente e non si può preparare in anticipo.

Per altre fonti IoT **non** serve un PHP dedicato: basta una voce in `sources.json`
(più un trasformatore in `sources/` se l'API non è GeoJSON). Vedi [fonti.md](fonti.md).

Se in futuro si vuole togliere `bus.php` dalla cartella web, la parte "posizioni" può diventare
una fonte `custom` del raccoglitore (decodifica protobuf + join PostgreSQL); resterebbe da
servire solo l'itinerario su richiesta.

Nel file del plugin vanno adattate in testa: `BUS_API` (indirizzo di `bus.php`), l'area e i testi.
