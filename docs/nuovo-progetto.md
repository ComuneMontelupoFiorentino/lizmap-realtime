# Aggiungere un livello in tempo reale a un altro progetto

Esempio: un livello "Qualità dell'aria" nel progetto `ambiente` del repository `cons`.

Il modulo Lizmap è già installato (una volta per tutto Lizmap) e il raccoglitore è attivo.

## 1. La fonte (solo se nuova)

In `~/lizmap-realtime/sources.json` aggiungere la fonte (vedi [fonti.md](fonti.md)):

```json
"aria": { "type": "geojson", "url": "https://…/stazioni.geojson", "interval": 300,
          "properties": ["nome", "pm10", "no2"] }
```

Prova:

```bash
cd ~/lizmap-realtime && php collector.php --once=aria --config=sources.json
```

Non serve riavviare nulla: il raccoglitore attivo rilegge il file da solo. Se la fonte è già
usata da un altro progetto, saltare questo passo: si riusa la stessa.

## 2. Il motore nel repository (una volta per repository)

```bash
ls /srv/data/cons/media/js/default/realtime-layers.js  ||  \
  cp realtime-layers.js /srv/data/cons/media/js/default/
```

Verificare nell'amministrazione di Lizmap che il repository `cons` abbia attiva l'opzione per i
JavaScript personalizzati.

Per caricare il motore **solo** in quel progetto invece che in tutti: `media/js/ambiente/`.

## 3. Il JSON dei livelli

```bash
mkdir -p /srv/data/cons/media/realtime
```

- `/srv/data/cons/media/realtime/ambiente.json` → solo per il progetto `ambiente`;
- oppure `/srv/data/cons/media/realtime/default.json` → per tutti i progetti di `cons` senza un file proprio.

```json
{
  "groups": [
    { "id": "ambiente_rt", "title": "Ambiente in tempo reale", "expanded": true, "layers": [
      { "id": "aria", "title": "Qualità dell'aria", "source": "aria", "interval": 300,
        "crs": "EPSG:4326", "visible": true, "maxScaleDenominator": 100000,
        "style": { "radius": 8, "colorBy": { "field": "pm10",
          "ranges": [ { "max": 25, "color": "#008055" }, { "min": 25, "max": 50, "color": "#E5A00D" },
                      { "min": 50, "color": "#CC334D" } ] },
          "label": { "field": "pm10", "maxScaleDenominator": 25000 } },
        "popup": { "title": "{nome}", "fields": [
          { "field": "pm10", "label": "PM10", "suffix": " µg/m³", "decimals": 0 },
          { "field": "no2",  "label": "NO₂",  "suffix": " µg/m³", "decimals": 0 } ] },
        "metadata": { "abstract": "Centraline di misura della qualità dell'aria.",
                      "source": "ARPA", "license": "CC BY 4.0" } }
    ] }
  ]
}
```

Controllare la sintassi: `php -r 'json_decode(file_get_contents("ambiente.json"),false,512,JSON_THROW_ON_ERROR);echo "ok\n";'`

Per limitarlo a un gruppo di utenti: `"groups": ["ambiente"]` nel livello o nel gruppo.

## 4. Ricaricare la mappa

Il gruppo compare in cima al pannello Layer; la barra di stato in basso mostra
`● Qualità dell'aria · N elementi · aggiornato …`.

Verifica diretta, da browser collegati a Lizmap:

```
http://<server>/lizmap/index.php/realtime/default/config?repository=cons&project=ambiente
```

## Riepilogo

| Cosa | Quante volte |
|---|---|
| modulo Lizmap | una volta per tutta l'installazione |
| raccoglitore + cron | una volta per tutta l'installazione |
| fonte in `sources.json` | una volta per fonte (condivisa tra tutti i progetti) |
| `realtime-layers.js` | una volta per repository (o per progetto) |
| JSON dei livelli | uno per progetto, o un `default.json` per repository |
