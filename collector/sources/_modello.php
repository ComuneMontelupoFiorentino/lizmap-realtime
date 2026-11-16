<?php
/**
 * MODELLO per una nuova fonte "custom".
 *
 * Serve solo se l'API della fonte NON restituisce già GeoJSON (per un GeoJSON basta
 * "type": "geojson" in sources.json, senza scrivere codice).
 *
 * 1. copiare questo file, es. sources/sensori_aria.php
 * 2. in sources.json:
 *      "aria": { "type": "custom", "script": "sources/sensori_aria.php", "interval": 300,
 *                "url": "https://api.esempio.it/stazioni", "token": "..." }
 * 3. provare:  php collector.php --once=aria --config=sources.json
 *
 * La funzione riceve:
 *   $source  la voce di sources.json (tutti i campi, anche quelli inventati da voi)
 *   $http    function (string $url, array $headers = [], int $timeout = 15): string
 *            $headers associativo, es. ['Authorization' => 'Bearer …']
 *            (usa curl, user agent e proxy del raccoglitore; lancia un'eccezione se HTTP >= 400)
 * e restituisce una FeatureCollection GeoJSON (array PHP). Coordinate in EPSG:4326
 * (lon, lat), oppure nel sistema dichiarato con "crs" nel JSON dei livelli.
 *
 * In caso di errore: lanciare un'eccezione. Il file precedente resta in cache, il
 * browser mostra il livello come "dato non aggiornato" e il raccoglitore riprova
 * con attese crescenti.
 */
declare(strict_types=1);

return function (array $source, callable $http): array {
    $headers = [];
    if (!empty($source['token'])) $headers['Authorization'] = 'Bearer ' . $source['token'];

    $data = json_decode($http($source['url'], $headers, 15), true);
    if (!is_array($data)) throw new RuntimeException('risposta non JSON');

    $features = [];
    foreach ($data['stazioni'] ?? [] as $s) {            // <-- adattare alla struttura della fonte
        if (!isset($s['lon'], $s['lat'])) continue;
        $features[] = [
            'type' => 'Feature',
            'geometry' => ['type' => 'Point', 'coordinates' => [(float)$s['lon'], (float)$s['lat']]],
            'properties' => [
                'nome'   => $s['nome'] ?? null,
                'valore' => $s['valore'] ?? null,
                'ora'    => $s['timestamp'] ?? null,
            ],
        ];
    }
    return ['type' => 'FeatureCollection', 'features' => $features];
};
