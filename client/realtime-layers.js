/**
 * realtime-layers.js — mini framework per livelli in tempo reale in Lizmap Web Client 3.11+
 *
 * Cosa fa
 *   - legge la configurazione dal modulo Lizmap "realtime", che la prende dal JSON
 *     del repository (media/realtime/<progetto>.json, altrimenti default.json) e
 *     toglie i livelli che l'utente non può vedere (permessi e gruppi di Lizmap);
 *   - aggiunge i livelli nel pannello Layer, IN CIMA agli altri, raggruppati come
 *     indicato nel JSON (gruppi -> livelli), con casella, icona e metadati (icona "i");
 *   - li aggiorna con UNA richiesta per ciclo all'endpoint del server, solo per i
 *     livelli accesi e visibili alla scala corrente, in pausa se la scheda non è attiva;
 *   - gestisce il sistema di riferimento dichiarato per ogni livello (anche proj4);
 *   - stili dichiarativi (colore per valore, rotazione, etichette) o stili personalizzati;
 *   - popup al clic sugli elementi;
 *   - viste: un livello con "themes": [...] si accende/spegne quando si sceglie una vista.
 *
 * API per altri script (window.LizRealtime)
 *   LizRealtime.registerStyle(nome, function (feature, resolution, ol, layer) { return style; })
 *   LizRealtime.registerPlugin(nome, { setVisible: function (on, layer) {}, ... })
 *   LizRealtime.setVisible(id, true|false)   LizRealtime.applyTheme(nomeVista)
 *   LizRealtime.layers                       (stato dei livelli, per diagnostica)
 *
 * Installazione: <repository>/media/js/default/realtime-layers.js
 * Script autonomo, combinabile con search-overlay.js, mobile-ui.js, themes-switcher.js.
 */
(function () {
  'use strict';

  var VERSION = '1.3.0';
  var MODULE_CONFIG = 'index.php/realtime/default/config';   // modulo Lizmap "realtime"
  var TICK_MS = 1000;              // frequenza del controllo interno (non delle richieste)
  var MAX_BACKOFF_S = 300;         // ritardo massimo dopo errori ripetuti
  var GROUP_PREFIX = 'rt-';        // prefisso dei nomi interni (evita conflitti con i layer del progetto)

  var customStyles = {};
  var plugins = {};
  var api = window.LizRealtime = window.LizRealtime || {};
  api.version = VERSION;
  api.layers = {};
  api.registerStyle = function (name, fn) { customStyles[name] = fn; };
  api.registerPlugin = function (name, impl) {
    plugins[name] = impl;
    // se il livello è già stato creato, allinea subito lo stato del plugin
    Object.keys(api.layers).forEach(function (id) {
      var l = api.layers[id];
      if (l.cfg.plugin !== name || !l.state) return;
      callPlugin(l, l.state.visibility);
      if (l.cfg.opacity != null && typeof impl.setOpacity === 'function') impl.setOpacity(Number(l.cfg.opacity));
    });
  };
  // Un plugin comunica il proprio stato, mostrato nel pannello Information e nella barra:
  //   { count: n, updated: secondiEpoch, error: 'testo' | null, interval: s, text: 'testo per la barra' }
  api.reportStatus = function (name, st) {
    st = st || {};
    Object.keys(api.layers).forEach(function (id) {
      var l = api.layers[id];
      if (l.cfg.plugin !== name) return;
      l.pluginStatus = Object.assign({}, l.pluginStatus, st);
      if (st.count != null) l.count = st.count;
      if (st.updated != null) l.updated = st.updated;
      if ('error' in st) l.lastError = st.error || null;
      if (st.interval) l.interval = st.interval;
    });
  };

  /* ------------------------------------------------------------------ */
  /* Utilità                                                             */
  /* ------------------------------------------------------------------ */

  function log() {
    var a = Array.prototype.slice.call(arguments); a.unshift('[realtime]');
    console.info.apply(console, a);
  }
  function warn() {
    var a = Array.prototype.slice.call(arguments); a.unshift('[realtime]');
    console.warn.apply(console, a);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function svgDataUrl(svg) {
    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
  }
  // "{campo}" -> valore del campo (testo semplice, già escapato dove serve)
  function fill(tpl, props) {
    return String(tpl || '').replace(/\{([^}]+)\}/g, function (m, k) {
      var v = props[k.trim()];
      return v == null ? '' : v;
    });
  }
  function fmtAge(sec) {
    if (sec == null || !isFinite(sec)) return '—';
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return sec + ' s fa';
    if (sec < 3600) return Math.round(sec / 60) + ' min fa';
    return Math.round(sec / 3600) + ' h fa';
  }
  // Parametri repository/progetto richiesti dal modulo per verificare i diritti
  function projectQuery() {
    var p = (window.lizUrls && lizUrls.params) || {};
    return new URLSearchParams({ repository: p.repository || '', project: p.project || '' }).toString();
  }
  function withQuery(url, extra) {
    return url + (url.indexOf('?') === -1 ? '?' : '&') + projectQuery() + (extra ? '&' + extra : '');
  }

  /* ------------------------------------------------------------------ */
  /* Configurazione (dal modulo Lizmap "realtime", già filtrata per      */
  /* i gruppi dell'utente collegato)                                     */
  /* ------------------------------------------------------------------ */

  function loadConfig() {
    var base = (window.lizUrls && lizUrls.basepath) || '/';
    var url = withQuery(base + MODULE_CONFIG);
    return fetch(url, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        if (r.status === 403) { log('accesso al progetto negato: nessun livello'); return null; }
        if (!r.ok) {
          warn('modulo realtime non raggiungibile (HTTP ' + r.status + '): è installato e configurato?');
          return null;
        }
        return r.json();
      })
      .then(function (c) {
        if (!c || !Array.isArray(c.groups) || !c.groups.length) return null;
        return c;
      })
      .catch(function (e) { warn('configurazione non leggibile:', e.message); return null; });
  }

  function registerProjections(cfg, ol, proj4) {
    var defs = cfg.projections || {};
    var added = false;
    Object.keys(defs).forEach(function (code) {
      if (!proj4.defs(code)) { proj4.defs(code, defs[code]); added = true; }
    });
    // proj4 di ogni livello, se dichiarato lì
    (cfg.groups || []).forEach(function (g) {
      (g.layers || []).forEach(function (l) {
        if (l.crs && l.proj4 && !proj4.defs(l.crs)) { proj4.defs(l.crs, l.proj4); added = true; }
      });
    });
    if (added) ol.proj.proj4.register(proj4);
  }

  /* ------------------------------------------------------------------ */
  /* Stili                                                               */
  /* ------------------------------------------------------------------ */

  function colorFor(spec, props) {
    var by = spec.colorBy;
    if (by && by.field) {
      var v = props[by.field];
      if (by.values && v != null && by.values[String(v)] != null) return by.values[String(v)];
      if (by.ranges && v != null && isFinite(v)) {
        for (var i = 0; i < by.ranges.length; i++) {
          var r = by.ranges[i];
          if ((r.min == null || v >= r.min) && (r.max == null || v < r.max)) return r.color;
        }
      }
      if (by['default']) return by['default'];
    }
    return spec.fill || spec.color || '#0066CC';
  }

  function makeStyleFunction(layer, ol, view) {
    var spec = layer.cfg.style || {};
    if (spec.custom) {
      return function (f, res) {
        var fn = customStyles[spec.custom];
        return fn ? fn(f, res, ol, layer) : null;
      };
    }
    var cache = {};
    var stroke = spec.stroke || '#ffffff';
    var strokeWidth = spec.strokeWidth != null ? spec.strokeWidth : 2;
    var radius = spec.radius || 7;
    var label = spec.label || null;

    return function (f, res) {
      var props = f.getProperties();
      var color = colorFor(spec, props);
      var rot = 0;
      if (spec.rotateBy && props[spec.rotateBy] != null && isFinite(props[spec.rotateBy])) {
        rot = Number(props[spec.rotateBy]) * Math.PI / 180;
      }
      var text = '';
      if (label && label.field) {
        var showLabel = true;
        if (label.maxScaleDenominator != null) showLabel = scaleFor(res) < Number(label.maxScaleDenominator);
        else if (label.minZoom != null) showLabel = view.getZoomForResolution(res) >= label.minZoom;
        if (showLabel) text = String(props[label.field] == null ? '' : props[label.field]);
      }
      var geomType = f.getGeometry() ? f.getGeometry().getType() : 'Point';
      var key = geomType + '|' + color + '|' + rot.toFixed(2) + '|' + text;
      if (cache[key]) return cache[key];

      var st;
      if (/Point/.test(geomType)) {
        var image;
        if (spec.icon) {
          image = new ol.style.Icon({
            src: spec.icon, scale: spec.iconScale || 1, rotation: rot, rotateWithView: true,
            color: spec.iconTint ? color : undefined
          });
        } else if (spec.rotateBy) {
          // freccia (triangolo) orientata secondo il campo
          image = new ol.style.RegularShape({
            points: 3, radius: radius + 2, rotation: rot, rotateWithView: true,
            fill: new ol.style.Fill({ color: color }),
            stroke: new ol.style.Stroke({ color: stroke, width: strokeWidth })
          });
        } else {
          image = new ol.style.Circle({
            radius: radius,
            fill: new ol.style.Fill({ color: color }),
            stroke: new ol.style.Stroke({ color: stroke, width: strokeWidth })
          });
        }
        st = new ol.style.Style({ image: image });
      } else if (/LineString/.test(geomType)) {
        st = new ol.style.Style({
          stroke: new ol.style.Stroke({ color: color, width: spec.width || 4, lineDash: spec.lineDash })
        });
      } else {
        st = new ol.style.Style({
          fill: new ol.style.Fill({ color: spec.fillOpacity != null ? hexA(color, spec.fillOpacity) : hexA(color, 0.35) }),
          stroke: new ol.style.Stroke({ color: color, width: spec.width || 2 })
        });
      }
      if (text) {
        st.setText(new ol.style.Text({
          text: text,
          font: '600 12px "Titillium Web",Geneva,Tahoma,sans-serif',
          offsetY: /Point/.test(geomType) ? -(radius + 12) : 0,
          fill: new ol.style.Fill({ color: '#1A1A1A' }),
          stroke: new ol.style.Stroke({ color: '#ffffff', width: 3 }),
          overflow: true
        }));
      }
      cache[key] = st;
      return st;
    };
  }

  function hexA(hex, a) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!m) return hex;
    return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + a + ')';
  }

  // Icona per la legenda (deve essere un data URL svg o png)
  function legendIcon(cfg) {
    if (cfg.legendIcon && /^data:image\/(svg\+xml|png);base64,/.test(cfg.legendIcon)) {
      return cfg.legendIcon.replace(/^data:image\/png;base64,(?! )/, 'data:image/png;base64, ');
    }
    var s = cfg.style || {};
    var c = s.fill || s.color || (s.colorBy && s.colorBy['default']) || '#0066CC';
    var svg;
    if (s.rotateBy) {
      svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
        '<path d="M8 1.5 L14 14 L8 11 L2 14 Z" fill="' + esc(c) + '" stroke="#fff" stroke-width="1.2"/></svg>';
    } else if (cfg.geometry === 'line') {
      svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
        '<path d="M1 12 L6 6 L10 10 L15 4" fill="none" stroke="' + esc(c) + '" stroke-width="3" stroke-linecap="round"/></svg>';
    } else if (cfg.geometry === 'polygon') {
      svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
        '<rect x="2" y="2" width="12" height="12" rx="2" fill="' + esc(hexA(c, 0.4)) + '" stroke="' + esc(c) + '" stroke-width="2"/></svg>';
    } else {
      svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
        '<circle cx="8" cy="8" r="5.5" fill="' + esc(c) + '" stroke="#fff" stroke-width="2"/></svg>';
    }
    return svgDataUrl(svg);
  }

  /* ------------------------------------------------------------------ */
  /* Stili dell'interfaccia (popup e metadati, Bootstrap Italia)         */
  /* ------------------------------------------------------------------ */

  var CSS = [
    '.lzrt-pop{position:relative;min-width:220px;max-width:320px;max-height:320px;overflow:auto;',
    '  padding:12px 14px 10px;background:#fff;border-radius:6px;font-family:"Titillium Web",Geneva,Tahoma,sans-serif;',
    '  font-size:14px;color:#1A1A1A;box-shadow:0 2px 6px rgba(0,0,0,.15),0 8px 24px rgba(0,0,0,.18);}',
    '.lzrt-pop:after{content:"";position:absolute;left:50%;bottom:-8px;margin-left:-8px;border:8px solid transparent;',
    '  border-bottom:0;border-top-color:#fff;}',
    '.lzrt-pop-x{position:absolute;top:4px;right:4px;width:28px;height:28px;padding:0;border:none;border-radius:4px;',
    '  background:none;color:#5D7083;font-size:20px;line-height:1;cursor:pointer;}',
    '.lzrt-pop-x:hover{background:#F0F6FC;color:#0066CC;}',
    '.lzrt-item+.lzrt-item{margin-top:10px;padding-top:10px;border-top:1px solid #E6E9F2;}',
    '.lzrt-layer{margin:0 24px 2px 0;font-size:12px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#5D7083;}',
    '.lzrt-title{margin:0 24px 6px 0;font-size:16px;font-weight:700;color:#0066CC;}',
    '.lzrt-fields{margin:0;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;}',
    '.lzrt-fields dt{color:#5D7083;font-weight:600;}',
    '.lzrt-fields dd{margin:0;}',
    '.lzrt-upd{margin:6px 0 0;font-size:12px;color:#5D7083;}',

    '.lzrt-meta{position:fixed;z-index:10040;width:min(360px,calc(100vw - 32px));max-height:70vh;overflow:auto;',
    '  padding:16px 18px;background:#fff;border-radius:6px;font-family:"Titillium Web",Geneva,Tahoma,sans-serif;',
    '  font-size:15px;color:#1A1A1A;box-shadow:0 2px 20px rgba(0,0,0,.1),0 20px 40px rgba(0,0,0,.2);}',
    '.lzrt-meta[hidden]{display:none;}',
    '.lzrt-meta h3{margin:0 32px 8px 0;font-size:18px;font-weight:700;color:#1A1A1A;}',
    '.lzrt-meta p{margin:0 0 10px;}',
    '.lzrt-meta dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:14px;}',
    '.lzrt-meta dt{color:#5D7083;font-weight:600;}',
    '.lzrt-meta dd{margin:0;word-break:break-word;}',
    '.lzrt-meta a{color:#0066CC;}',
    '.lzrt-ok{color:#008055;font-weight:600;}',
    '.lzrt-err{color:#CC334D;font-weight:600;}',
    '.lzrt-info{cursor:pointer;}',
    // barra di stato in basso (stesso aspetto della barra dei bus)
    '.lzrt-bar{position:absolute;left:50%;bottom:8px;transform:translateX(-50%);z-index:5;display:flex;',
    '  flex-direction:column;align-items:center;gap:4px;pointer-events:none;max-width:calc(100% - 16px);}',
    '.lzrt-bar[hidden]{display:none;}',
    '.lzrt-chip{background:rgba(255,255,255,.92);padding:3px 10px;border-radius:12px;',
    '  font:12px "Titillium Web",Geneva,Tahoma,sans-serif;color:#17324D;box-shadow:0 1px 3px rgba(0,0,0,.2);',
    '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}',
    '.lzrt-chip .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#00804D;',
    '  margin-right:6px;vertical-align:0;animation:lzrtp 2s infinite;}',
    '.lzrt-chip.wait .dot{background:#5D7083;}',
    '.lzrt-chip.stale .dot{background:#E5A00D;animation:none;}',
    '.lzrt-chip.err .dot{background:#CC334D;animation:none;}',
    '.lzrt-chip b{font-weight:600;}',
    '@keyframes lzrtp{0%{opacity:1}50%{opacity:.3}100%{opacity:1}}',
    '@media (prefers-reduced-motion:reduce){.lzrt-chip .dot{animation:none;}}',
    '@media (max-width:767px){.lzrt-chip{font-size:11px;}}',
    '@media (max-width:767px){.lzrt-meta{left:16px !important;right:16px;top:auto !important;bottom:80px;width:auto;}}'
  ].join('\n');

  /* ------------------------------------------------------------------ */
  /* Motore                                                              */
  /* ------------------------------------------------------------------ */

  var ol, proj4, map, view, cfg, endpoint, format;
  var layers = [];                 // in ordine di configurazione
  var olLayerSet = new Set();
  var popupOverlay, popupEl, metaEl, currentMeta = null;

  function callPlugin(l, on) {
    var p = plugins[l.cfg.plugin];
    if (p && typeof p.setVisible === 'function') {
      try { p.setVisible(on, l); } catch (e) { warn('plugin', l.cfg.plugin, e); }
    }
  }

  function buildLayers() {
    var defaults = cfg.defaults || {};
    var root = lizMap.mainLizmap.state.rootMapGroup;
    var groups = cfg.groups || [];

    // Lizmap inserisce ogni nuovo gruppo/livello in cima: creo in ordine inverso
    // perché il risultato rispetti l'ordine del JSON. Gruppo e livelli vanno creati
    // in sequenza, senza attese (la mappa collega l'ultimo gruppo/livello aggiunto).
    groups.slice().reverse().forEach(function (g) {
      var list = (g.layers || []).filter(function (l) { return l && l.id && /^[a-z0-9_-]+$/i.test(l.id); });
      if (!list.length) return;
      var groupName = GROUP_PREFIX + (g.id || g.title || 'gruppo');
      var ext;
      try { ext = root.createExternalGroup(groupName); }
      catch (e) { warn('gruppo non creato', groupName, e.message); return; }
      ext.wmsTitle = g.title || g.id;

      list.slice().reverse().forEach(function (lc) {
        var l = {
          id: lc.id,
          cfg: Object.assign({}, defaults, lc),
          group: g,
          updated: 0,            // orario dell'ultimo dato (secondi, dal server)
          fetchedAt: 0,          // quando l'abbiamo ricevuto (ms, client)
          nextAt: 0,
          fails: 0,
          inflight: false,
          lastError: null,
          count: 0,
          wasVisible: null       // null: il primo controllo comunica sempre lo stato al plugin
        };
        l.interval = Math.max(2, Number(l.cfg.interval) || 30);
        l.crs = l.cfg.crs || 'EPSG:4326';

        var olLayer;
        if (l.cfg.plugin) {
          // livello gestito da un plugin (es. bus): in mappa resta un layer vuoto,
          // serve solo per casella, legenda, metadati e viste
          olLayer = new ol.layer.Vector({ source: new ol.source.Vector() });
        } else {
          if (!ol.proj.get(l.crs)) warn('sistema di riferimento sconosciuto per', l.id, l.crs, '(aggiungere la definizione proj4)');
          olLayer = new ol.layer.Vector({
            source: new ol.source.Vector(),
            declutter: !!(l.cfg.style && l.cfg.style.declutter)
          });
          olLayer.setStyle(makeStyleFunction(l, ol, view));
          if (l.cfg.opacity != null) olLayer.setOpacity(Number(l.cfg.opacity));
        }
        olLayer.set('wmsTitle', l.cfg.title || l.id);
        olLayer.set('lzrtId', l.id);
        l.olLayer = olLayer;
        olLayerSet.add(olLayer);

        try {
          l.state = ext.addOlLayer(GROUP_PREFIX + l.id, olLayer);
        } catch (e) { warn('livello non aggiunto', l.id, e.message); return; }
        try { l.state.icon = legendIcon(l.cfg); } catch (e) { /* icona di default */ }
        l.state.checked = !!l.cfg.visible;
        layers.unshift(l);
        api.layers[l.id] = l;
      });

      // gruppo chiuso nella legenda, se richiesto
      if (g.expanded === false) {
        try {
          var treeGroup = lizMap.mainLizmap.state.layerTree.children.filter(function (i) {
            return i.type === 'ext-group' && i.name === groupName;
          })[0];
          if (treeGroup) treeGroup.expanded = false;
        } catch (e) { /* non critico */ }
      }
    });
  }

  // Scala della mappa, calcolata come Lizmap (Utils.getScaleFromResolution: 96 dpi)
  function scaleFor(res) {
    var mpu = view.getProjection().getMetersPerUnit() || 1;
    return res * (1000 / 25.4) * 96 * mpu;
  }
  function fmtScale(n) { return '1:' + Math.round(n).toLocaleString('it-IT'); }

  // Visibilità per scala, con gli stessi campi di QGIS/Lizmap:
  //   maxScaleDenominator: 50000 -> visibile solo da 1:50.000 in giù (più dettagliato)
  //   minScaleDenominator: 500   -> nascosto oltre 1:500
  // minZoom/maxZoom restano per compatibilità (dipendono dal sistema di riferimento).
  function zoomOk(l) {
    var c = l.cfg, sc = scaleFor(view.getResolution());
    if (c.maxScaleDenominator != null && sc >= Number(c.maxScaleDenominator)) return false;
    if (c.minScaleDenominator != null && sc <= Number(c.minScaleDenominator)) return false;
    var z = view.getZoom();
    if (c.minZoom != null && z < c.minZoom) return false;
    if (c.maxZoom != null && z > c.maxZoom) return false;
    return true;
  }

  function setData(l, geojson) {
    var feats;
    try {
      feats = format.readFeatures(geojson, {
        dataProjection: l.crs,
        featureProjection: view.getProjection()
      });
    } catch (e) {
      l.lastError = 'dati non leggibili: ' + e.message;
      warn(l.id, l.lastError);
      return;
    }
    var max = Number(l.cfg.maxFeatures) || 5000;
    if (feats.length > max) {
      warn(l.id, 'troppi elementi (' + feats.length + '), mostrati i primi', max);
      feats = feats.slice(0, max);
    }
    var src = l.olLayer.getSource();
    src.clear(true);
    src.addFeatures(feats);
    l.count = feats.length;
    l.lastError = null;
  }

  // Dato vecchio: livello attenuato
  function markStale(l, nowS) {
    var staleAfter = Number(l.cfg.staleAfter) || l.interval * 4;
    var stale = l.updated && (nowS - l.updated) > staleAfter;
    var base = l.cfg.opacity != null ? Number(l.cfg.opacity) : 1;
    var want = stale ? base * 0.45 : base;
    if (l.olLayer.getOpacity() !== want) l.olLayer.setOpacity(want);
    l.stale = !!stale;
  }

  function schedule(l, ok) {
    if (ok) { l.fails = 0; l.nextAt = Date.now() + l.interval * 1000; return; }
    l.fails++;
    var wait = Math.min(l.interval * Math.pow(2, l.fails), MAX_BACKOFF_S);
    l.nextAt = Date.now() + wait * 1000;
  }

  // Richiesta unica all'endpoint per tutti i livelli "source" in scadenza
  function fetchBatch(batch) {
    batch.forEach(function (l) { l.inflight = true; });
    var param = batch.map(function (l) { return l.cfg.source + ':' + (l.updated || 0); }).join(',');
    var url = withQuery(endpoint, 'layers=' + encodeURIComponent(param));
    return fetch(url, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        if (r.status === 204) return { layers: {} };      // nessun livello cambiato
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        var res = (data && data.layers) || {};
        if (data && data.now) api.serverOffset = data.now - Date.now() / 1000;
        batch.forEach(function (l) {
          var item = res[l.cfg.source];
          if (item && item.error) {
            l.lastError = 'server: ' + item.error;
            schedule(l, false);
          } else {
            if (item && item.data) {
              setData(l, item.data);
              l.updated = item.updated || 0;
              l.fetchedAt = Date.now();
            } else if (item && item.updated) {
              l.updated = item.updated;
            }
            schedule(l, true);
          }
        });
      })
      .catch(function (e) {
        batch.forEach(function (l) { l.lastError = e.message; schedule(l, false); });
        warn('richiesta fallita:', e.message);
      })
      .then(function () { batch.forEach(function (l) { l.inflight = false; }); });
  }

  // Livello con URL proprio (es. file GeoJSON statico): ETag/304
  function fetchUrl(l) {
    l.inflight = true;
    var headers = {};
    if (l.etag) headers['If-None-Match'] = l.etag;
    return fetch(l.cfg.url, { credentials: 'same-origin', cache: 'no-cache', headers: headers })
      .then(function (r) {
        if (r.status === 304) { schedule(l, true); return; }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        l.etag = r.headers.get('ETag');
        return r.json().then(function (gj) {
          setData(l, gj);
          var lm = Date.parse(r.headers.get('Last-Modified') || '');
          l.updated = isFinite(lm) ? Math.round(lm / 1000) : Math.round(Date.now() / 1000);
          l.fetchedAt = Date.now();
          schedule(l, true);
        });
      })
      .catch(function (e) { l.lastError = e.message; schedule(l, false); })
      .then(function () { l.inflight = false; });
  }

  function tick() {
    var now = Date.now();
    var nowS = now / 1000 + (api.serverOffset || 0);
    var batch = [];
    layers.forEach(function (l) {
      var vis = !!(l.state && l.state.visibility);
      if (vis !== l.wasVisible) {
        l.wasVisible = vis;
        if (l.cfg.plugin) callPlugin(l, vis);
        if (vis) l.nextAt = 0;               // appena acceso: aggiorna subito
        if (currentMeta === l && ourMetaShown()) renderMeta(l);
      }
      if (l.cfg.plugin) {
        var staleAfter = Number(l.cfg.staleAfter) || l.interval * 4;
        l.stale = !!(l.updated && nowS - l.updated > staleAfter);
        return;
      }
      if (l.updated) markStale(l, nowS);
      if (!vis || l.inflight || now < l.nextAt) return;
      if (document.hidden) return;           // scheda in background: niente richieste
      if (!zoomOk(l)) return;
      if (l.cfg.url) fetchUrl(l);
      else if (l.cfg.source && endpoint) batch.push(l);
    });
    if (batch.length) fetchBatch(batch);
    renderStatusBar(nowS);
    if (currentMeta) {
      // se Lizmap ha mostrato i metadati di un suo layer, il nostro pannello non c'è più
      if (ourMetaShown()) renderMeta(currentMeta, true);
      else currentMeta = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Popup                                                               */
  /* ------------------------------------------------------------------ */

  function buildPopup() {
    popupEl = document.createElement('div');
    popupEl.className = 'lzrt-pop';
    popupEl.setAttribute('role', 'dialog');
    popupOverlay = new ol.Overlay({
      element: popupEl, positioning: 'bottom-center', offset: [0, -14],
      autoPan: { animation: { duration: 200 } }, stopEvent: true
    });
    map.addOverlay(popupOverlay);
    popupEl.addEventListener('click', function (e) {
      if (e.target.classList.contains('lzrt-pop-x')) popupOverlay.setPosition(undefined);
    });

    map.on('singleclick', function (evt) {
      var hits = [];
      map.forEachFeatureAtPixel(evt.pixel, function (f, lyr) {
        if (hits.length < 6) hits.push({ f: f, l: api.layers[lyr.get('lzrtId')] });
      }, { layerFilter: function (lyr) { return olLayerSet.has(lyr); }, hitTolerance: 6 });
      hits = hits.filter(function (h) { return h.l && h.l.cfg.popup !== false; });
      if (!hits.length) { popupOverlay.setPosition(undefined); return; }
      popupEl.innerHTML = '<button type="button" class="lzrt-pop-x" aria-label="Chiudi">×</button>' +
        hits.map(function (h) { return popupItem(h.l, h.f); }).join('');
      popupOverlay.setPosition(evt.coordinate);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') popupOverlay.setPosition(undefined);
    });
  }

  function popupItem(l, f) {
    var p = l.cfg.popup || {};
    var props = f.getProperties();
    var html = '<div class="lzrt-item"><p class="lzrt-layer">' + esc(l.cfg.title || l.id) + '</p>';
    var title = p.title ? fill(p.title, props) : (props.name || props.nome || '');
    if (title) html += '<p class="lzrt-title">' + esc(title) + '</p>';
    var fields = p.fields;
    if (!fields) {
      // senza configurazione: tutti i campi semplici
      fields = Object.keys(props).filter(function (k) {
        return k !== 'geometry' && typeof props[k] !== 'object';
      }).slice(0, 12).map(function (k) { return { field: k, label: k }; });
    }
    var rows = fields.map(function (fd) {
      var v = props[fd.field];
      if (v == null || v === '') return '';
      if (fd.decimals != null && isFinite(v)) v = Number(v).toFixed(fd.decimals);
      if (fd.map && fd.map[String(v)] != null) v = fd.map[String(v)];
      return '<dt>' + esc(fd.label || fd.field) + '</dt><dd>' + esc(v) + esc(fd.suffix || '') + '</dd>';
    }).join('');
    if (rows) html += '<dl class="lzrt-fields">' + rows + '</dl>';
    if (l.updated) {
      var nowS = Date.now() / 1000 + (api.serverOffset || 0);
      html += '<p class="lzrt-upd">Aggiornato ' + esc(fmtAge(nowS - l.updated)) + '</p>';
    }
    return html + '</div>';
  }

  /* ------------------------------------------------------------------ */
  /* Metadati (icona "i" nella legenda)                                  */
  /* ------------------------------------------------------------------ */

  // Il pannello è lo stesso "Information" di Lizmap (#sub-dock), con la stessa
  // struttura HTML: stesso aspetto e alternanza automatica con i metadati dei
  // layer del progetto. Le classi dei bottoni sono proprie (lzrt-…) perché
  // Lizmap aggancia le sue (layerActionZoom, btn-opacity-layer, exportLayer)
  // ai layer del progetto QGIS.
  var OPACITIES = [0.2, 0.4, 0.6, 0.8, 1];

  function T(key, fallback) {
    return (window.lizDict && lizDict[key]) || fallback;
  }
  function subDock() { return document.getElementById('sub-dock'); }
  function metaBox() { return subDock() || metaEl; }
  function ourMetaShown() {
    var box = metaBox();
    return !!(box && box.querySelector('.lzrt-sub') &&
      (box === metaEl ? !metaEl.hidden : getComputedStyle(box).display !== 'none'));
  }

  function buildMeta() {
    // ripiego: pannello proprio solo se manca il pannello di Lizmap
    if (!subDock()) {
      metaEl = document.createElement('div');
      metaEl.className = 'lzrt-meta';
      metaEl.hidden = true;
      document.body.appendChild(metaEl);
    }
    var box = metaBox();
    box.addEventListener('click', onMetaClick);
    box.addEventListener('change', function (e) {
      if (e.target.classList.contains('lzrt-export-fmt')) e.stopPropagation();
    });
  }

  function onMetaClick(e) {
    var t = e.target.closest ? e.target.closest('button, a') : null;
    if (!t || !currentMeta || !t.closest('.lzrt-sub, #hide-sub-dock')) return;
    var l = currentMeta;
    if (t.id === 'hide-sub-dock') { e.preventDefault(); closeMeta(); return; }
    if (t.classList.contains('lzrt-zoom')) { e.preventDefault(); zoomToLayer(l); return; }
    if (t.classList.contains('lzrt-export')) { e.preventDefault(); exportLayer(l); return; }
    if (t.classList.contains('lzrt-link')) { e.preventDefault(); window.open(t.value, '_blank', 'noopener'); return; }
    if (t.classList.contains('lzrt-op')) {
      e.preventDefault();
      l.cfg.opacity = Number(t.getAttribute('data-v'));
      var p = pluginOf(l);
      if (p) {
        if (typeof p.setOpacity === 'function') p.setOpacity(l.cfg.opacity);
      } else {
        markStale(l, Date.now() / 1000 + (api.serverOffset || 0));
        if (!l.updated) l.olLayer.setOpacity(l.cfg.opacity);
      }
      renderMeta(l);
    }
  }

  function pluginOf(l) { return l.cfg.plugin ? plugins[l.cfg.plugin] || null : null; }

  // Elementi del livello come feature OpenLayers (nella proiezione della mappa).
  // Per i plugin: dal loro getGeoJSON() (EPSG:4326, salvo "crs" diverso nel JSON).
  function layerFeatures(l) {
    var p = pluginOf(l);
    if (!p) return l.olLayer.getSource().getFeatures();
    if (typeof p.getGeoJSON !== 'function') return [];
    try {
      return format.readFeatures(p.getGeoJSON(), {
        dataProjection: l.cfg.crs || 'EPSG:4326', featureProjection: view.getProjection()
      });
    } catch (err) { warn('plugin', l.cfg.plugin, 'getGeoJSON:', err.message); return []; }
  }

  function canZoomExport(l) {
    var p = pluginOf(l);
    return !l.cfg.plugin || !!(p && typeof p.getGeoJSON === 'function');
  }
  function canOpacity(l) {
    var p = pluginOf(l);
    return !l.cfg.plugin || !!(p && typeof p.setOpacity === 'function');
  }

  // Stato del livello (testo HTML), uguale per livelli normali e plugin
  function statusHtml(l, nowS) {
    if (l.cfg.plugin && !pluginOf(l)) {
      return '<span class="lzrt-err">plugin “' + esc(l.cfg.plugin) + '” non caricato</span>';
    }
    if (!l.state.visibility) return 'livello spento';
    if (!l.cfg.plugin && !zoomOk(l)) {
      return 'fuori scala: ' + (l.cfg.maxScaleDenominator != null ?
        'visibile da ' + fmtScale(l.cfg.maxScaleDenominator) + ' in giù' : 'limite di zoom') +
        ' (ora ' + fmtScale(scaleFor(view.getResolution())) + ')';
    }
    if (l.lastError) return '<span class="lzrt-err">' + esc(l.lastError) + '</span>';
    if (l.updated) {
      return '<span class="' + (l.stale ? 'lzrt-err' : 'lzrt-ok') + '">' +
        (l.stale ? 'dato non aggiornato · ' : 'attivo · ') + esc(countText(l)) + '</span>';
    }
    return 'in attesa del primo dato…';
  }

  function countText(l) {
    var ps = l.pluginStatus;
    if (ps && ps.text) return ps.text;
    return (l.count == null ? 0 : l.count) + ' elementi';
  }

  function hhmmss(epochS) {
    var d = new Date(epochS * 1000);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /* ------------------------------------------------------------------ */
  /* Barra di stato in basso (pallino lampeggiante), una riga per livello */
  /* ------------------------------------------------------------------ */

  var barEl = null, barHtml = '';

  function barEnabled(l) {
    if (cfg && cfg.statusBar === false) return false;
    return l.cfg.statusBar !== false;
  }

  function renderStatusBar(nowS) {
    if (!map) return;
    if (!barEl) {
      barEl = document.createElement('div');
      barEl.className = 'lzrt-bar';
      barEl.setAttribute('aria-live', 'off');
      barEl.hidden = true;
      map.getViewport().appendChild(barEl);
    }
    var chips = [];
    layers.forEach(function (l) {
      if (!l.state || !l.state.visibility || !barEnabled(l)) return;
      if (l.cfg.plugin) { if (!pluginOf(l)) return; }
      else if (!zoomOk(l)) return;
      var cls = l.lastError ? 'err' : l.stale ? 'stale' : l.updated ? 'ok' : 'wait';
      var txt = '<b>' + esc(l.cfg.title || l.id) + '</b>';
      if (l.lastError && !l.updated) {
        txt += ' · non disponibile (' + esc(l.lastError) + ')';
      } else if (!l.updated) {
        txt += ' · in attesa del primo dato…';
      } else {
        txt += ' · ' + esc(countText(l)) + ' · aggiornato ' + hhmmss(l.updated - (api.serverOffset || 0));
        var age = nowS - l.updated;
        if (l.stale || age > Math.max(60, l.interval * 2)) txt += ' (dati di ' + esc(fmtAge(age)) + ')';
        if (l.lastError) txt += ' · errore';
      }
      chips.push('<div class="lzrt-chip ' + cls + '" title="' + esc(l.lastError || '') + '">' +
        '<span class="dot"></span>' + txt + '</div>');
    });
    var html = chips.join('');
    if (html !== barHtml) { barEl.innerHTML = html; barHtml = html; }
    barEl.hidden = !chips.length;
  }

  function closeMeta() {
    var sd = subDock();
    if (sd && sd.querySelector('.lzrt-sub')) { sd.style.display = 'none'; sd.innerHTML = ''; }
    if (metaEl) metaEl.hidden = true;
    currentMeta = null;
  }

  function openMeta(l) {
    // secondo clic sulla stessa "i": chiude, come per i layer di Lizmap
    if (currentMeta === l && ourMetaShown()) { closeMeta(); return; }
    // toglie la selezione dell'eventuale layer di Lizmap mostrato prima
    var tv = document.querySelector('lizmap-treeview');
    try { if (tv && tv.itemNameSelected !== undefined) tv.itemNameSelected = undefined; } catch (err) { /* non critico */ }
    currentMeta = l;
    renderMeta(l);
    var sd = subDock();
    if (sd) {
      sd.style.display = 'block';
    } else {
      metaEl.hidden = false;
    }
  }

  function zoomToLayer(l) {
    var feats = layerFeatures(l);
    if (!feats.length) return;
    var ext = [Infinity, Infinity, -Infinity, -Infinity];
    feats.forEach(function (f) {
      var g = f.getGeometry(); if (!g) return;
      var e = g.getExtent();
      ext = [Math.min(ext[0], e[0]), Math.min(ext[1], e[1]), Math.max(ext[2], e[2]), Math.max(ext[3], e[3])];
    });
    if (!isFinite(ext[0])) return;
    view.fit(ext, { padding: [60, 60, 60, 60], maxZoom: 17, duration: 300 });
  }

  // Esporta i dati correnti in GeoJSON (EPSG:4326)
  function exportLayer(l) {
    var feats = layerFeatures(l);
    var gj = format.writeFeaturesObject(feats, {
      dataProjection: 'EPSG:4326', featureProjection: view.getProjection(), decimals: 7
    });
    var blob = new Blob([JSON.stringify(gj)], { type: 'application/geo+json' });
    var a = document.createElement('a');
    var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = URL.createObjectURL(blob);
    a.download = l.id + '_' + stamp + '.geojson';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // Stessi colori dei bottoni opacità di Lizmap
  function opacityButtonStyle(v) {
    var pct = Math.round(v * 100);
    return 'background-color:rgba(0,0,0,' + (pct / 100 - 0.3) + ');background-image:none;text-shadow:none;' +
      (pct > 60 ? 'color:lightgrey;' : '');
  }

  function renderMeta(l, onlyStatus) {
    var box = metaBox();
    if (!box) return;
    var m = l.cfg.metadata || {};
    var nowS = Date.now() / 1000 + (api.serverOffset || 0);
    var status = statusHtml(l, nowS);
    if (onlyStatus) {
      var s = box.querySelector('.lzrt-sub [data-k="status"]');
      var u = box.querySelector('.lzrt-sub [data-k="upd"]');
      if (s && s.innerHTML !== status) s.innerHTML = status;
      if (u) u.textContent = l.updated ? fmtAge(nowS - l.updated) : '—';
      return;
    }

    var rows = [];
    function row(label, value, raw, key) {
      if (value == null || value === '') return;
      rows.push('<dt>' + esc(label) + '</dt><dd' + (key ? ' data-k="' + key + '"' : '') + '>' +
        (raw ? value : esc(value)) + '</dd>');
    }

    // stesse voci, nello stesso ordine, del pannello di Lizmap
    row(T('layer.metadata.layer.name', 'Nome'), l.cfg.title || l.id);
    row(T('layer.metadata.layer.type', 'Tipo'), T('layer.metadata.layer.type.layer', 'Layer') + ' · tempo reale');
    if (canZoomExport(l)) {
      var zt = T('layer.metadata.zoomToExtent.title', 'Zoom sull\'estensione');
      row(zt, '<button class="btn btn-mini lzrt-zoom" title="' + esc(zt) + '"><i class="icon-zoom-in"></i></button>', true);
    }
    if (canOpacity(l)) {
      var cur = l.cfg.opacity != null ? Number(l.cfg.opacity) : 1;
      row(T('layer.metadata.opacity.title', 'Opacità'), OPACITIES.map(function (v) {
        return '<a href="#" class="btn btn-mini lzrt-op' + (Math.abs(cur - v) < 0.01 ? ' active' : '') +
          '" data-v="' + v + '" style="' + opacityButtonStyle(v) + '">' + Math.round(v * 100) + '</a>';
      }).join(''), true);
    }
    if (canZoomExport(l)) {
      var et = T('layer.metadata.export.title', 'Esporta');
      row(et, '<select class="lzrt-export-fmt"><option value="GeoJSON">GeoJSON</option></select>' +
        '<button class="btn btn-mini lzrt-export" title="' + esc(et) + '"><i class="icon-download"></i></button>', true);
    }
    row(T('layer.metadata.layer.abstract', 'Descrizione'), m.abstract);
    // voci specifiche dei livelli in tempo reale (uguali per livelli normali e plugin)
    row('Stato', status, true, 'status');
    row('Ultimo dato', l.updated ? fmtAge(nowS - l.updated) : '—', false, 'upd');
    row('Aggiornamento', 'ogni ' + l.interval + ' s');
    row('Sistema di riferimento', l.cfg.plugin ? (l.cfg.crs || 'EPSG:4326') : l.crs);
    row('Fonte', m.source);
    row('Licenza', m.license);
    row('Contatto', m.contact);

    var see = T('layer.metadata.layer.info.see', 'Maggiori informazioni');
    var close = T('generic.btn.close.title', 'Chiudi');
    box.innerHTML =
      '<div class="sub-metadata lzrt-sub" data-lzrt="' + esc(l.id) + '">' +
      '<h3><span class="title"><span class="icon"></span><span class="text">' +
      esc(T('layer.metadata.title', 'Informazioni')) + '</span></span></h3>' +
      '<div class="menu-content">' +
      '<dl class="dl-vertical" style="font-size:0.8em;">' + rows.join('') + '</dl>' +
      (m.url ? '<button class="btn link layer-info lzrt-link" title="' + esc(see) + '" value="' + esc(m.url) + '">' + esc(see) + '</button>' : '') +
      '</div></div>' +
      '<button id="hide-sub-dock" class="btn btn-mini pull-right" name="close" title="' + esc(close) + '">' + esc(close) + '</button>';
  }

  // Inserisce l'icona "i" nelle righe dei livelli in legenda; la legenda viene
  // ridisegnata da Lizmap, quindi l'inserimento viene ripetuto quando serve.
  function decorateTree() {
    layers.forEach(function (l) {
      var li = document.querySelector('li[data-testid="ol-' + GROUP_PREFIX + l.id + '"]');
      if (!li) return;
      var actions = li.querySelector('.layer-actions');
      if (!actions || actions.querySelector('.lzrt-info')) return;
      var i = document.createElement('i');
      i.className = 'icon-info-sign lzrt-info';
      i.title = 'Informazioni sul livello';
      i.setAttribute('role', 'button');
      i.setAttribute('tabindex', '0');
      i.addEventListener('click', function (e) { e.stopPropagation(); openMeta(l); });
      i.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMeta(l); }
      });
      actions.appendChild(i);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Viste (temi della mappa)                                            */
  /* ------------------------------------------------------------------ */

  function applyTheme(name) {
    if (!name) return;
    layers.forEach(function (l) {
      if (!Array.isArray(l.cfg.themes)) return;     // livello non legato alle viste
      l.state.checked = l.cfg.themes.indexOf(name) !== -1;
    });
    log('vista applicata:', name);
  }
  api.applyTheme = applyTheme;
  api.setVisible = function (id, on) {
    var l = api.layers[id];
    if (l && l.state) l.state.checked = !!on;
  };

  function bindThemes() {
    // da themes-switcher.js
    document.addEventListener('lzth:theme-applied', function (e) {
      applyTheme(e.detail && e.detail.name);
    });
    // dal menu "Temi" nativo di Lizmap
    document.addEventListener('click', function (e) {
      var t = e.target.closest && e.target.closest('#theme-selector .theme');
      if (t) setTimeout(function () { applyTheme(t.textContent.replace(/\s+/g, ' ').trim()); }, 0);
    }, true);
  }

  /* ------------------------------------------------------------------ */
  /* Avvio                                                               */
  /* ------------------------------------------------------------------ */

  var started = false;
  function start() {
    if (started) return;
    if (!(window.lizMap && lizMap.ol && lizMap.proj4 && lizMap.mainLizmap &&
          lizMap.mainLizmap.map && lizMap.mainLizmap.state && lizMap.mainLizmap.state.rootMapGroup)) return;
    started = true;
    ol = lizMap.ol; proj4 = lizMap.proj4; map = lizMap.mainLizmap.map; view = map.getView();
    format = new ol.format.GeoJSON();

    loadConfig().then(function (c) {
      if (!c) { log('nessun livello in tempo reale per questo progetto/utente'); return; }
      cfg = c;
      endpoint = cfg.endpoint || '';
      var style = document.createElement('style');
      style.textContent = CSS;
      document.head.appendChild(style);
      registerProjections(cfg, ol, proj4);
      buildLayers();
      buildPopup();
      buildMeta();
      bindThemes();
      decorateTree();
      var tree = document.querySelector('lizmap-treeview') || document.body;
      new MutationObserver(decorateTree).observe(tree, { childList: true, subtree: true });
      setInterval(tick, TICK_MS);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
      tick();
      log('v' + VERSION, '-', layers.length, 'livelli');
    }).catch(function (e) { warn('avvio non riuscito:', e); });
  }

  // Aggancio ufficiale per gli script esterni (Lizmap 3.8+), con ripiego a polling
  if (window.lizMap && typeof lizMap.subscribe === 'function') {
    lizMap.subscribe(function () { setTimeout(start, 0); }, 'lizmap.uicreated');
  }
  var tries = 0;
  var poll = setInterval(function () {
    if (started || ++tries > 120) { clearInterval(poll); return; }
    start();
  }, 500);
})();
