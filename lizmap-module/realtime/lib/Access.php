<?php
/**
 * Logica del modulo "realtime", indipendente da Jelix (testabile da sola).
 *
 * - legge la configurazione dei livelli di un progetto dalla cartella media del repository;
 * - la filtra secondo i gruppi dell'utente;
 * - compone la risposta con i dati preparati dal raccoglitore, solo per le fonti consentite.
 *
 * @license Mozilla Public License : http://www.mozilla.org/MPL/
 */

namespace Realtime;

class Access
{
    public const MAX_LAYERS = 30;
    public const MAX_FILE_BYTES = 20971520;     // 20 MB

    /**
     * Configurazione del progetto: media/realtime/<progetto>.json, altrimenti default.json.
     *
     * @return null|array null se non esiste una configurazione valida
     */
    public static function loadProjectConfig(string $repositoryPath, string $project): ?array
    {
        $dir = rtrim($repositoryPath, '/').'/media/realtime/';
        $candidates = array();
        if (preg_match('/^[A-Za-z0-9_.\- ]{1,200}$/', $project)) {
            $candidates[] = $dir.$project.'.json';
        }
        $candidates[] = $dir.'default.json';

        foreach ($candidates as $file) {
            if (!is_file($file)) {
                continue;
            }
            $cfg = json_decode((string) file_get_contents($file), true);
            if (is_array($cfg)) {
                $cfg['_file'] = basename($file);

                return $cfg;
            }
        }

        return null;
    }

    /**
     * Toglie i livelli che l'utente non può vedere (campo "groups" del livello)
     * e i gruppi rimasti vuoti. Il campo "groups" non viene inviato al browser.
     */
    public static function filterForUser(array $cfg, array $userGroups, bool $isAdmin): array
    {
        $groups = array();
        foreach ($cfg['groups'] ?? array() as $g) {
            if (!is_array($g)) {
                continue;
            }
            $layers = array();
            foreach ($g['layers'] ?? array() as $l) {
                if (!is_array($l) || empty($l['id'])) {
                    continue;
                }
                if (!self::canSee($l, $userGroups, $isAdmin)) {
                    continue;
                }
                unset($l['groups']);
                $layers[] = $l;
            }
            if (!$layers) {
                continue;
            }
            // un gruppo di livelli può essere riservato a sua volta
            if (!self::canSee($g, $userGroups, $isAdmin)) {
                continue;
            }
            unset($g['groups']);
            $g['layers'] = $layers;
            $groups[] = $g;
        }
        $cfg['groups'] = $groups;
        unset($cfg['_file']);

        return $cfg;
    }

    private static function canSee(array $item, array $userGroups, bool $isAdmin): bool
    {
        $required = $item['groups'] ?? null;
        if (!is_array($required) || !$required || $isAdmin) {
            return true;
        }

        return (bool) array_intersect($required, $userGroups);
    }

    /**
     * Fonti che l'utente può interrogare: quelle dei livelli rimasti dopo il filtro.
     *
     * @return string[]
     */
    public static function allowedSources(array $filteredCfg): array
    {
        $ids = array();
        foreach ($filteredCfg['groups'] ?? array() as $g) {
            foreach ($g['layers'] ?? array() as $l) {
                if (!empty($l['source']) && is_string($l['source'])) {
                    $ids[strtolower($l['source'])] = true;
                }
            }
        }

        return array_keys($ids);
    }

    /**
     * "demo:1731590000,meteo:0" -> ['demo' => 1731590000, 'meteo' => 0].
     */
    public static function parseLayersParam(string $param): array
    {
        $out = array();
        foreach (array_slice(explode(',', $param), 0, self::MAX_LAYERS) as $part) {
            $bits = explode(':', trim($part), 2);
            $id = strtolower($bits[0]);
            $since = isset($bits[1]) && ctype_digit($bits[1]) ? (int) $bits[1] : 0;
            if (preg_match('/^[a-z0-9_-]{1,64}$/', $id)) {
                $out[$id] = $since;
            }
        }

        return $out;
    }

    /**
     * Compone la risposta dei dati.
     *
     * @return array [codice HTTP, corpo JSON] — 204 con corpo vuoto se nulla è cambiato
     */
    public static function buildData(string $cacheDir, array $requested, array $allowed, ?int $now = null): array
    {
        $out = array('now' => $now ?? time(), 'layers' => array());
        $raw = array();
        $changed = false;
        $allowedSet = array_flip($allowed);

        foreach ($requested as $id => $since) {
            if (!isset($allowedSet[$id])) {
                $out['layers'][$id] = array('error' => 'forbidden');
                $changed = true;

                continue;
            }
            $file = rtrim($cacheDir, '/').'/'.$id.'.geojson';
            clearstatcache(true, $file);
            if (!is_file($file)) {
                $out['layers'][$id] = array('error' => 'not_found');
                $changed = true;

                continue;
            }
            $mtime = (int) filemtime($file);
            if ($mtime <= $since) {
                $out['layers'][$id] = array('updated' => $mtime, 'unchanged' => true);

                continue;
            }
            if (filesize($file) > self::MAX_FILE_BYTES) {
                $out['layers'][$id] = array('error' => 'too_large');
                $changed = true;

                continue;
            }
            $content = file_get_contents($file);
            if ($content === false || $content === '') {
                $out['layers'][$id] = array('error' => 'read_error');
                $changed = true;

                continue;
            }
            $marker = '__LZRT_RAW_'.$id.'__';
            $out['layers'][$id] = array('updated' => $mtime, 'data' => $marker);
            $raw[$marker] = $content;
            $changed = true;
        }

        if (!$changed) {
            return array(204, '');
        }

        // il GeoJSON (già validato dal raccoglitore) viene inserito senza ridecodificarlo
        $json = json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        foreach ($raw as $marker => $content) {
            $json = str_replace('"'.$marker.'"', $content, $json);
        }

        return array(200, $json);
    }
}
