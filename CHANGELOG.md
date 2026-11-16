# Changelog

## 1.3.0 – 2026-11-16

- Barra di stato in basso con pallino lampeggiante per **tutti** i livelli accesi
  (verde aggiornato, arancione dato vecchio, rosso errore); `statusBar: false` per disattivarla.
- Pannello Information uguale per tutti i livelli, anche plugin: zoom, opacità ed export GeoJSON
  funzionano anche per i plugin che espongono `setOpacity` e `getGeoJSON`.
- Nuova API `LizRealtime.reportStatus()` per i plugin.
- Plugin bus: opacità, export, zoom e stato tramite il framework; la sua barra propria si nasconde
  quando il framework è presente.
- Raccoglitore: lucchetto (una sola copia attiva), adatto a una riga di cron ogni minuto;
  `--log` con rotazione a 1 MB; `--status`, `--stop`; fuso orario da `timezone`;
  un errore in `sources.json` non ferma il servizio.
- Script `collector/cron/installa-cron.sh` per l'installazione senza sudo.

## 1.2.0

- Visibilità per scala (`maxScaleDenominator`, `minScaleDenominator`), anche per le etichette.
- Pannello Information nativo di Lizmap (`#sub-dock`), con alternanza con i layer del progetto.

## 1.1.0

- Modulo Lizmap `realtime`: configurazione e dati con i permessi di Lizmap, gruppi per livello.

## 1.0.0

- Prima versione: raccoglitore, motore nel browser, gruppi in cima al pannello Layer, viste.
