<?php
/**
 * collector.php — raccoglitore dei livelli in tempo reale.
 *
 * È l'UNICO componente che interroga le fonti esterne. Per ogni fonte dichiarata in
 * sources.json scarica i dati con il suo intervallo, li normalizza in GeoJSON e li
 * scrive in modo atomico nella cartella di cache, da cui li legge il modulo Lizmap "realtime".
 *
 * Uso:
 *   php collector.php --loop                 servizio continuo (cron o systemd)
 *   php collector.php --once=demo            esegue una volta una fonte (prova)
 *   php collector.php --list                 elenca fonti e stato dei file
 *   opzione --config=/percorso/sources.json  (default: sources.json accanto a questo file)
 *   php collector.php --status               dice se il servizio è in esecuzione (e il pid)
 *   php collector.php --stop                 ferma il servizio (con cron ripartirà entro un minuto,
 *                                            utile dopo aver aggiornato questo file)
 *   opzione --log=/percorso/collector.log    scrive i messaggi su file (ruotato a 1 MB)
 *
 * Con --loop il raccoglitore prende un lucchetto (<cache_dir>/.collector.lock): se un'altra
 * copia è già in esecuzione esce subito, in silenzio. Per questo basta una riga di cron
 * "ogni minuto": la prima volta lo avvia, le volte successive non fa nulla, e se il
 * processo si ferma (riavvio del server, errore) cron lo riavvia entro un minuto.
 *
 * Tipi di fonte:
 *   geojson  scarica un GeoJSON da "url" (con "headers" opzionali), filtra per "bbox",
 *            tiene solo i campi in "properties", limita a "max_features"
 *   demo     genera "count" veicoli in movimento attorno a "center" (per provare)
 *   custom   esegue lo script PHP "script", che restituisce una funzione
 *            function (array $source, callable $http): array  (FeatureCollection)
 *
 * Requisiti: PHP 7.4+ (CLI), estensione curl consigliata.
 */
declare(strict_types=1);

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

$opts = getopt('', ['loop', 'once:', 'list', 'config:', 'log:', 'status', 'stop']);
$GLOBALS['RT_LOG'] = isset($opts['log']) ? (string)$opts['log'] : null;
$configPath = $opts['config'] ?? __DIR__ . '/sources.json';
$config = loadConfig($configPath);

if (isset($opts['list']))     { listSources($config); printStatus($config['cache_dir']); exit(0); }
if (isset($opts['status']))   { exit(printStatus($config['cache_dir']) ? 0 : 1); }
if (isset($opts['stop']))     { exit(stopRunning($config['cache_dir']) ? 0 : 1); }
if (isset($opts['once']))     { exit(runSource($config, (string)$opts['once']) ? 0 : 1); }
if (isset($opts['loop'])) {
    $lock = acquireLock($config['cache_dir']);
    if ($lock === null) exit(0);          // già in esecuzione: niente da fare
    loop($config, $configPath);
    exit(0);
}

fwrite(STDERR, "Uso: php collector.php --loop | --once=ID | --list | --status | --stop [--config=sources.json] [--log=file]\n");
exit(2);

/* ------------------------------------------------------------------ */

function logmsg(string $msg): void
{
    $line = '[' . date('Y-m-d H:i:s') . '] ' . $msg . "\n";
    $file = $GLOBALS['RT_LOG'] ?? null;
    if (!$file) { fwrite(STDERR, $line); return; }
    // rotazione semplice, senza logrotate: oltre 1 MB il file diventa .1 (uno solo di scorta)
    clearstatcache(true, $file);
    if (is_file($file) && filesize($file) > 1048576) @rename($file, $file . '.1');
    if (@file_put_contents($file, $line, FILE_APPEND | LOCK_EX) === false) fwrite(STDERR, $line);
}

/**
 * Lucchetto esclusivo non bloccante: restituisce l'handle (da tenere aperto finché il
 * processo vive) oppure null se un'altra copia lo possiede già. Il sistema operativo lo
 * rilascia da solo quando il processo termina, anche se viene ucciso.
 */
function acquireLock(string $dir)
{
    $fh = @fopen($dir . '/.collector.lock', 'c');
    if (!$fh) { logmsg("impossibile aprire il lucchetto in $dir"); exit(2); }
    if (!flock($fh, LOCK_EX | LOCK_NB)) { fclose($fh); return null; }
    ftruncate($fh, 0);
    fwrite($fh, (string)getmypid());
    fflush($fh);
    return $fh;
}

/** pid del raccoglitore in esecuzione, oppure null */
function runningPid(string $dir): ?int
{
    $file = $dir . '/.collector.lock';
    $fh = @fopen($file, 'c+');
    if (!$fh) return null;
    if (flock($fh, LOCK_EX | LOCK_NB)) { flock($fh, LOCK_UN); fclose($fh); return null; }
    $pid = (int)trim((string)stream_get_contents($fh));
    fclose($fh);
    return $pid > 0 ? $pid : -1;
}

function printStatus(string $dir): bool
{
    $pid = runningPid($dir);
    echo $pid === null ? "raccoglitore: FERMO\n" : 'raccoglitore: in esecuzione' . ($pid > 0 ? " (pid $pid)" : '') . "\n";
    return $pid !== null;
}

function stopRunning(string $dir): bool
{
    $pid = runningPid($dir);
    if ($pid === null) { echo "raccoglitore già fermo\n"; return true; }
    if ($pid < 0) { echo "pid sconosciuto\n"; return false; }
    $ok = function_exists('posix_kill') ? posix_kill($pid, 15) : (exec('kill ' . (int)$pid, $o, $rc) !== false && $rc === 0);
    echo $ok ? "segnale di arresto inviato al pid $pid\n" : "impossibile fermare il pid $pid (processo di un altro utente?)\n";
    return $ok;
}

function loadConfig(string $path, bool $fatal = true): ?array
{
    $fail = function (string $m) use ($fatal) { logmsg($m); if ($fatal) exit(2); return null; };
    if (!is_file($path)) return $fail("configurazione non trovata: $path");
    $cfg = json_decode((string)file_get_contents($path), true);
    if (!is_array($cfg) || !isset($cfg['sources']) || !is_array($cfg['sources'])) {
        return $fail("configurazione non valida: $path (" . json_last_error_msg() . ')');
    }
    date_default_timezone_set(in_array($cfg['timezone'] ?? '', timezone_identifiers_list(), true)
        ? $cfg['timezone'] : 'Europe/Rome');
    $cfg['_dir'] = dirname(realpath($path));
    $cfg['cache_dir'] = rtrim($cfg['cache_dir'] ?? '/var/lib/lizmap-realtime/cache', '/');
    if (!is_dir($cfg['cache_dir']) && !@mkdir($cfg['cache_dir'], 0755, true)) {
        return $fail('impossibile creare la cartella di cache ' . $cfg['cache_dir']);
    }
    foreach (array_keys($cfg['sources']) as $id) {
        if (!preg_match('/^[a-z0-9_-]{1,64}$/', (string)$id)) {
            return $fail("id di fonte non valido (usare a-z 0-9 _ -): $id");
        }
    }
    return $cfg;
}

function listSources(array $cfg): void
{
    foreach ($cfg['sources'] as $id => $src) {
        $file = $cfg['cache_dir'] . "/$id.geojson";
        $age = is_file($file) ? (time() - filemtime($file)) . ' s fa' : 'nessun file';
        printf("%-20s %-8s ogni %4d s   ultimo dato: %s\n", $id, $src['type'] ?? '?', (int)($src['interval'] ?? 60), $age);
    }
}

/* ------------------------------------------------------------------ */
/* Ciclo continuo                                                      */
/* ------------------------------------------------------------------ */

function loop(array $config, string $configPath): void
{
    $running = true;
    if (function_exists('pcntl_async_signals')) {
        pcntl_async_signals(true);
        $stop = function () use (&$running) { $running = false; };
        pcntl_signal(SIGTERM, $stop);
        pcntl_signal(SIGINT, $stop);
    }
    $state = [];                 // id => ['next' => ts, 'fails' => n]
    $configMtime = filemtime($configPath);
    logmsg('avviato (pid ' . getmypid() . ') con ' . count($config['sources']) . ' fonti');

    while ($running) {
        // ricarica la configurazione se il file cambia (senza riavviare il servizio)
        clearstatcache(true, $configPath);
        if (filemtime($configPath) !== $configMtime) {
            $configMtime = filemtime($configPath);
            // un errore nel file modificato non ferma il servizio: resta la configurazione precedente
            $new = loadConfig($configPath, false);
            if ($new !== null) {
                if ($new['cache_dir'] !== $config['cache_dir']) {
                    logmsg('cache_dir cambiata: vale dal prossimo riavvio del raccoglitore');
                    $new['cache_dir'] = $config['cache_dir'];
                }
                $config = $new;
                logmsg('configurazione ricaricata');
            } else {
                logmsg('configurazione NON ricaricata: resta quella precedente');
            }
        }
        $now = microtime(true);
        foreach ($config['sources'] as $id => $src) {
            if (!empty($src['disabled'])) continue;
            $st = $state[$id] ?? ['next' => 0, 'fails' => 0];
            if ($now < $st['next']) continue;
            $interval = max(2, (int)($src['interval'] ?? 60));
            if (runSource($config, (string)$id)) {
                $st = ['next' => $now + $interval, 'fails' => 0];
            } else {
                $st['fails']++;
                // dopo errori ripetuti rallenta: 2x, 4x… fino a 10 minuti
                $st['next'] = $now + min($interval * (2 ** $st['fails']), 600);
            }
            $state[$id] = $st;
            if (!$running) break;
        }
        usleep(500000);
    }
    logmsg('arrestato');
}

/* ------------------------------------------------------------------ */
/* Esecuzione di una fonte                                             */
/* ------------------------------------------------------------------ */

function runSource(array $cfg, string $id): bool
{
    $src = $cfg['sources'][$id] ?? null;
    if (!$src) { logmsg("fonte sconosciuta: $id"); return false; }
    $t0 = microtime(true);
    try {
        switch ($src['type'] ?? '') {
            case 'geojson': $fc = sourceGeojson($src, $cfg); break;
            case 'demo':    $fc = sourceDemo($src, $cfg, $id); break;
            case 'custom':  $fc = sourceCustom($src, $cfg); break;
            default: throw new RuntimeException('tipo non supportato: ' . ($src['type'] ?? '(vuoto)'));
        }
        $fc = normalize($fc, $src);
        writeAtomic($cfg['cache_dir'] . "/$id.geojson", $fc);
        if (!empty($cfg['verbose'])) {
            logmsg(sprintf('%s: %d elementi in %.2f s', $id, count($fc['features']), microtime(true) - $t0));
        }
        return true;
    } catch (Throwable $e) {
        // in caso di errore il file precedente resta: il browser vede il dato "vecchio" attenuato
        logmsg("$id: ERRORE " . $e->getMessage());
        return false;
    }
}

function sourceGeojson(array $src, array $cfg): array
{
    if (empty($src['url'])) throw new RuntimeException('manca "url"');
    $body = http($src['url'], $src['headers'] ?? [], (int)($src['timeout'] ?? 15), $cfg);
    $data = json_decode($body, true);
    if (!is_array($data)) throw new RuntimeException('risposta non JSON: ' . substr(trim($body), 0, 80));
    return $data;
}

function sourceCustom(array $src, array $cfg): array
{
    $script = $src['script'] ?? '';
    $path = $script !== '' && $script[0] === '/' ? $script : $cfg['_dir'] . '/' . $script;
    if (!is_file($path)) throw new RuntimeException("script non trovato: $path");
    $fn = require $path;
    if (!is_callable($fn)) throw new RuntimeException("lo script deve restituire una funzione: $path");
    $http = function (string $url, array $headers = [], int $timeout = 15) use ($cfg): string {
        return http($url, $headers, $timeout, $cfg);
    };
    $out = $fn($src, $http);
    if (!is_array($out)) throw new RuntimeException('lo script non ha restituito un array');
    return $out;
}

// Veicoli simulati che si muovono in cerchio (per provare senza fonti esterne)
function sourceDemo(array $src, array $cfg, string $id): array
{
    [$lon0, $lat0] = $src['center'] ?? [10.9963, 43.7225];
    $n = max(1, min(500, (int)($src['count'] ?? 8)));
    $r = (float)($src['radius_m'] ?? 1500);
    $t = time();
    $features = [];
    for ($i = 0; $i < $n; $i++) {
        $phase = $i * 2 * M_PI / $n;
        $speed = 0.004 + 0.002 * ($i % 3);                 // rad/s
        $a = $phase + $t * $speed * ($i % 2 ? 1 : -1);
        $rr = $r * (0.5 + 0.5 * (($i * 37) % 100) / 100);
        $dx = $rr * cos($a); $dy = $rr * sin($a);
        $lat = $lat0 + $dy / 111320;
        $lon = $lon0 + $dx / (111320 * cos(deg2rad($lat0)));
        // direzione di marcia: tangente al cerchio
        $dir = $i % 2 ? $a + M_PI / 2 : $a - M_PI / 2;
        $heading = fmod(rad2deg(atan2(cos($dir), sin($dir))) + 360, 360);
        $fermo = ($t / 30 + $i) % 7 === 0;
        $features[] = [
            'type' => 'Feature',
            'geometry' => ['type' => 'Point', 'coordinates' => [round($lon, 6), round($lat, 6)]],
            'properties' => [
                'id' => "$id-" . ($i + 1),
                'nome' => 'Veicolo ' . ($i + 1),
                'stato' => $fermo ? 'fermo' : 'in servizio',
                'velocita' => $fermo ? 0 : round($speed * $rr * 3.6, 1),
                'heading' => round($heading),
            ],
        ];
    }
    return ['type' => 'FeatureCollection', 'features' => $features];
}

/* ------------------------------------------------------------------ */
/* Normalizzazione e scrittura                                         */
/* ------------------------------------------------------------------ */

function normalize(array $fc, array $src): array
{
    if (($fc['type'] ?? '') !== 'FeatureCollection' || !isset($fc['features']) || !is_array($fc['features'])) {
        throw new RuntimeException('il risultato non è una FeatureCollection');
    }
    $bbox = $src['bbox'] ?? null;            // [minLon, minLat, maxLon, maxLat] nel CRS dei dati
    $keep = $src['properties'] ?? null;      // elenco dei campi da tenere
    $max  = (int)($src['max_features'] ?? 5000);
    $out = [];
    foreach ($fc['features'] as $f) {
        if (!is_array($f) || ($f['type'] ?? '') !== 'Feature' || empty($f['geometry'])) continue;
        if ($bbox && !intersectsBbox($f['geometry'], $bbox)) continue;
        $props = is_array($f['properties'] ?? null) ? $f['properties'] : [];
        if (is_array($keep)) $props = array_intersect_key($props, array_flip($keep));
        $out[] = ['type' => 'Feature', 'geometry' => $f['geometry'], 'properties' => $props]
               + (isset($f['id']) ? ['id' => $f['id']] : []);
        if (count($out) >= $max) break;
    }
    return ['type' => 'FeatureCollection', 'features' => $out];
}

function intersectsBbox(array $geom, array $bbox): bool
{
    $minX = INF; $minY = INF; $maxX = -INF; $maxY = -INF;
    $walk = function ($c) use (&$walk, &$minX, &$minY, &$maxX, &$maxY) {
        if (is_array($c) && isset($c[0]) && is_numeric($c[0]) && isset($c[1]) && is_numeric($c[1])) {
            $minX = min($minX, $c[0]); $maxX = max($maxX, $c[0]);
            $minY = min($minY, $c[1]); $maxY = max($maxY, $c[1]);
        } elseif (is_array($c)) {
            foreach ($c as $sub) $walk($sub);
        }
    };
    $walk($geom['coordinates'] ?? []);
    if ($minX === INF) return false;
    return !($maxX < $bbox[0] || $minX > $bbox[2] || $maxY < $bbox[1] || $minY > $bbox[3]);
}

// Scrittura atomica: il lettore non vede mai un file a metà
function writeAtomic(string $file, array $fc): void
{
    $json = json_encode($fc, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
        | JSON_PRESERVE_ZERO_FRACTION | JSON_INVALID_UTF8_SUBSTITUTE);
    if ($json === false) throw new RuntimeException('codifica JSON fallita: ' . json_last_error_msg());
    $tmp = $file . '.tmp' . getmypid();
    if (file_put_contents($tmp, $json) === false) throw new RuntimeException("scrittura fallita: $tmp");
    @chmod($tmp, 0644);
    if (!rename($tmp, $file)) { @unlink($tmp); throw new RuntimeException("rename fallito: $file"); }
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function http(string $url, array $headers, int $timeout, array $cfg): string
{
    if (!preg_match('#^https?://#i', $url)) throw new RuntimeException("URL non valido: $url");
    $ua = $cfg['user_agent'] ?? 'lizmap-realtime-collector/1.0';
    $hdr = [];
    foreach ($headers as $k => $v) $hdr[] = "$k: $v";

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 3,
            CURLOPT_CONNECTTIMEOUT => min(10, $timeout),
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_USERAGENT => $ua,
            CURLOPT_HTTPHEADER => $hdr,
            CURLOPT_ENCODING => '',             // accetta gzip/deflate
        ]);
        $body = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($body === false) throw new RuntimeException("rete: $err");
        if ($code >= 400) throw new RuntimeException("HTTP $code da $url");
        return (string)$body;
    }
    $ctx = stream_context_create(['http' => [
        'timeout' => $timeout, 'user_agent' => $ua, 'header' => implode("\r\n", $hdr), 'ignore_errors' => true,
    ]]);
    $body = @file_get_contents($url, false, $ctx);
    if ($body === false) throw new RuntimeException("rete: impossibile leggere $url");
    $status = $http_response_header[0] ?? '';
    if (preg_match('#\s(\d{3})\s#', $status, $m) && (int)$m[1] >= 400) throw new RuntimeException("HTTP {$m[1]} da $url");
    return $body;
}
