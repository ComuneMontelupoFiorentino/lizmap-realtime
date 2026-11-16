<?php
/**
 * Configuratore del modulo "realtime".
 *
 *   php lizmap/install/configurator.php realtime
 *
 * Chiede la cartella di cache scritta dal raccoglitore e la salva in
 * lizmap/var/config/localconfig.ini.php, sezione [realtime]:
 *
 *   [realtime]
 *   cacheDir=/var/lib/lizmap-realtime/cache
 *
 * Gli URL del modulo (index.php/realtime/...) sono dichiarati in automatico.
 *
 * @license Mozilla Public License : http://www.mozilla.org/MPL/
 */

use Jelix\Installer\Module\API\LocalConfigurationHelpers;

class realtimeModuleConfigurator extends \Jelix\Installer\Module\Configurator
{
    public function getDefaultParameters()
    {
        return array(
            'cacheDir' => '/var/lib/lizmap-realtime/cache',
        );
    }

    public function localConfigure(LocalConfigurationHelpers $helpers)
    {
        $ini = $helpers->getSingleConfigIni();
        $current = $ini->getValue('cacheDir', 'realtime');
        $cacheDir = $helpers->cli()->askInformation(
            'Cartella di cache dei livelli in tempo reale (cache_dir di sources.json)?',
            $current ?: $this->parameters['cacheDir']
        );
        $ini->setValue('cacheDir', rtrim($cacheDir, '/'), 'realtime');
    }
}
