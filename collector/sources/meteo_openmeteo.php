<?php
/**
 * Fonte personalizzata di esempio: condizioni meteo correnti da Open-Meteo
 * (https://open-meteo.com) per un elenco di punti dichiarato in sources.json.
 *
 * Open-Meteo è gratuito per uso non commerciale e non richiede chiave; i valori
 * sono stime del modello meteorologico, non misure di stazioni. I dati si
 * aggiornano ogni 15 minuti: un intervallo più breve non porta dati nuovi.
 *
 * Modello per altre fonti: lo script restituisce una funzione che riceve la
 * configurazione della fonte e una funzione $http, e restituisce una FeatureCollection.
 */
declare(strict_types=1);

return function (array $source, callable $http): array {
    $points = $source['points'] ?? [];
    if (!$points) throw new RuntimeException('meteo: nessun punto in "points"');

    // Una sola richiesta per tutti i punti
    $url = 'https://api.open-meteo.com/v1/forecast?' . http_build_query([
        'latitude'  => implode(',', array_map(fn($p) => $p['lat'], $points)),
        'longitude' => implode(',', array_map(fn($p) => $p['lon'], $points)),
        'current'   => 'temperature_2m,relative_humidity_2m,wind_speed_10m',
        'timezone'  => 'Europe/Rome',
    ]);
    $data = json_decode($http($url, [], 15), true);
    if (!is_array($data)) throw new RuntimeException('meteo: risposta non valida');
    // con un solo punto Open-Meteo restituisce un oggetto, con più punti un array
    if (isset($data['current'])) $data = [$data];

    $features = [];
    foreach ($points as $i => $p) {
        $c = $data[$i]['current'] ?? null;
        if (!$c) continue;
        $features[] = [
            'type' => 'Feature',
            'geometry' => ['type' => 'Point', 'coordinates' => [(float)$p['lon'], (float)$p['lat']]],
            'properties' => [
                'nome'        => $p['nome'] ?? ('Punto ' . ($i + 1)),
                'temperatura' => $c['temperature_2m'] ?? null,
                'umidita'     => $c['relative_humidity_2m'] ?? null,
                'vento'       => $c['wind_speed_10m'] ?? null,
                'ora'         => $c['time'] ?? null,
            ],
        ];
    }
    return ['type' => 'FeatureCollection', 'features' => $features];
};
