# Plugin bus (esempio)

`bus-realtime.js` disegna i bus del trasporto pubblico (GTFS-RT) con movimento animato, colore
di linea, direzione e, al clic, l'itinerario della corsa.

Richiede un servizio **`bus.php`** (non incluso) che restituisce:

```json
{ "vehicles": [ { "vehicle_id": "…", "lon": 10.99, "lat": 43.72, "linea": "47", "colore": "#c0392b",
                  "destinazione": "…", "direzione": 180, "timestamp": 1731590000, "trip_id": "…",
                  "trip_noto": true } ],
  "feed_timestamp": 1731590000, "server_time": 1731590005 }
```

e, con `?trip=<id>`, l'itinerario della corsa. Perché serve e quando no: [docs/plugin.md](../../docs/plugin.md#il-caso-bus-e-busphp).

## Installazione

1. adattare in testa al file `BUS_API` (indirizzo di `bus.php`), area e testi;
2. copiarlo in `<repository>/media/js/default/` accanto a `realtime-layers.js`;
3. nel JSON dei livelli: `{ "id": "bus", "title": "Bus TPL", "plugin": "bus", "visible": true }`.

Funziona anche senza il framework (con la sua barra propria in basso); con il framework si
accende e si spegne dal pannello Layer e usa la barra di stato comune.
