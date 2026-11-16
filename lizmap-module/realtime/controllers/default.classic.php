<?php
/**
 * Modulo Lizmap "realtime": configurazione e dati dei livelli in tempo reale.
 *
 *   index.php/realtime/default/config?repository=…&project=…
 *       configurazione dei livelli del progetto, filtrata secondo i gruppi dell'utente
 *   index.php/realtime/default/data?repository=…&project=…&layers=demo:0,meteo:1731590000
 *       dati dei livelli richiesti (solo fonti consentite); 204 se nulla è cambiato
 *
 * Accesso: l'utente deve avere accesso al progetto (stessa verifica di Lizmap per
 * la mappa e la ricerca). Un livello con "groups" è visibile solo ai membri di
 * quei gruppi Lizmap; gli amministratori vedono tutto.
 *
 * @license Mozilla Public License : http://www.mozilla.org/MPL/
 */

use Lizmap\Project\UnknownLizmapProjectException;
use Realtime\Access;

class defaultCtrl extends jController
{
    /** Configurazione dei livelli per l'utente corrente. */
    public function config()
    {
        $rep = $this->jsonResponse();
        $ctx = $this->context($rep);
        if (!$ctx) {
            return $rep;
        }
        [$lrep, $lproj, $appContext] = $ctx;

        $cfg = Access::loadProjectConfig((string) $lrep->getPath(), $lproj->getKey());
        if (!$cfg) {
            // nessun livello in tempo reale per questo progetto: risposta vuota, non un errore
            $rep->content = '{"groups":[]}';

            return $rep;
        }

        $filtered = Access::filterForUser($cfg, $this->userGroups($appContext), $this->isAdmin($appContext));
        $filtered['endpoint'] = jUrl::get('realtime~default:data');
        $rep->content = json_encode($filtered, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        return $rep;
    }

    /** Dati dei livelli richiesti. */
    public function data()
    {
        $rep = $this->jsonResponse();
        $ctx = $this->context($rep);
        if (!$ctx) {
            return $rep;
        }
        [$lrep, $lproj, $appContext] = $ctx;

        $requested = Access::parseLayersParam((string) $this->param('layers', ''));
        if (!$requested) {
            $rep->setHttpStatus(400, 'Bad Request');
            $rep->content = '{"error":"no_layers"}';

            return $rep;
        }

        $cfg = Access::loadProjectConfig((string) $lrep->getPath(), $lproj->getKey());
        $allowed = $cfg ? Access::allowedSources(
            Access::filterForUser($cfg, $this->userGroups($appContext), $this->isAdmin($appContext))
        ) : array();

        [$status, $body] = Access::buildData($this->cacheDir(), $requested, $allowed);
        if ($status === 204) {
            $rep->setHttpStatus(204, 'No Content');
        }
        $rep->content = $body;

        return $rep;
    }

    /** Senza azione: come config. */
    public function index()
    {
        return $this->config();
    }

    /* ------------------------------------------------------------------ */

    private function jsonResponse()
    {
        /** @var jResponseText $rep */
        $rep = $this->getResponse('text');
        $rep->mimeType = 'application/json';
        $rep->addHttpHeader('Cache-Control', 'no-store');
        $rep->addHttpHeader('X-Content-Type-Options', 'nosniff');

        return $rep;
    }

    /**
     * Verifica repository, progetto e diritto di accesso al progetto.
     *
     * @return null|array [repository, progetto, contesto applicativo]
     */
    private function context($rep)
    {
        $repository = (string) $this->param('repository', '');
        $project = (string) $this->param('project', '');
        if ($repository === '' || $project === '') {
            $rep->setHttpStatus(400, 'Bad Request');
            $rep->content = '{"error":"missing_repository_or_project"}';

            return null;
        }

        $lrep = lizmap::getRepository($repository);
        if (!$lrep) {
            $rep->setHttpStatus(404, 'Not Found');
            $rep->content = '{"error":"unknown_repository"}';

            return null;
        }

        try {
            $lproj = lizmap::getProject($repository.'~'.$project);
        } catch (UnknownLizmapProjectException $e) {
            $lproj = null;
        }
        if (!$lproj) {
            $rep->setHttpStatus(404, 'Not Found');
            $rep->content = '{"error":"unknown_project"}';

            return null;
        }

        if (!$lproj->checkAcl()) {
            $rep->setHttpStatus(403, 'Forbidden');
            $rep->content = '{"error":"forbidden"}';

            return null;
        }

        return array($lrep, $lproj, lizmap::getAppContext());
    }

    private function userGroups($appContext)
    {
        return $appContext->userIsConnected() ? (array) $appContext->aclUserPublicGroupsId() : array();
    }

    private function isAdmin($appContext)
    {
        return $appContext->userIsConnected() && $appContext->aclCheck('lizmap.admin.access');
    }

    private function cacheDir()
    {
        $conf = jApp::config()->realtime ?? array();

        return $conf['cacheDir'] ?? '/var/lib/lizmap-realtime/cache';
    }
}
