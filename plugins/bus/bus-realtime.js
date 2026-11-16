/**
 * bus-realtime.js - Bus Autolinee Toscane in tempo reale sul Digital Twin (Lizmap 3.8+ / 3.11,
 * compatibile anche con Lizmap <= 3.5).
 *
 * Cosa fa:
 *  - disegna i bus con il numero e il colore della linea e una freccia nella direzione di marcia;
 *  - li fa scorrere in modo fluido tra un aggiornamento e l'altro;
 *  - al clic su un bus mostra destinazione, ritardo stimato e prossime fermate, e disegna
 *    sulla mappa l'itinerario della corsa (tratto gia' percorso in grigio, fermate, prossima fermata).
 *
 * Installazione:
 *   1. bus.php (versione con PostgreSQL) raggiungibile dal web, con bus_db.ini configurato.
 *   2. Questo file in:  <repository>/media/js/<nome_progetto>/bus-realtime.js
 *      (l'amministratore Lizmap deve consentire JavaScript per il repository).
 *   3. Impostare BUS_API qui sotto.
 * Disattivazione temporanea: aggiungere &no_user_defined_js=1 all'URL della mappa.
 *
 * Con realtime-layers.js (framework livelli in tempo reale) il file si registra come
 * plugin "bus": la casella "Bus TPL" del pannello Layer, le viste e i metadati sono
 * gestiti dal framework (livello con "plugin": "bus" nel JSON del progetto).
 * Casella spenta = bus nascosti e nessuna richiesta a bus.php. Senza il framework
 * funziona come prima, sempre acceso.
 * File volutamente solo ASCII (le lettere accentate sono scritte come \u00e0 ecc.).
 */
(function () {
  'use strict';

  // ---------------- CONFIGURAZIONE ----------------
  var BUS_API     = '/lizmap/prosit/tpl_realtime/bus.php'; // <-- MODIFICARE se diverso
  var REFRESH_MS  = 10000;  // ogni quanto chiedere le posizioni (il feed regionale cambia ogni 10-30 s)
  var SHOW_ALL    = false;  // true = tutta la Toscana, false = solo area Montelupo
  var DEFAULT_COL = '#0066CC';
  var STALE_S     = 300;    // posizione piu' vecchia di N secondi: bus sbiadito e senza anelli
                            // (il feed regionale arriva gia' con 2-3 minuti di ritardo)
  var NEXT_STOPS  = 6;      // quante prossime fermate mostrare nel popup
  var LIZMAP_POPUP = true;
  var RINGS       = true;   // anelli animati attorno ai bus (dato in tempo reale)
  var RINGS_MAX   = 150;    // oltre questo numero di bus gli anelli si spengono (es. SHOW_ALL)  // true = info del bus nel popup di Lizmap (pannello o finestra, come da progetto)
  // ------------------------------------------------

  var map = null, mode = null, container = null, svg = null, info = null, popup = null;
  var buses = {};            // chiave veicolo -> stato (dati, posizione animata, elemento DOM)
  var selected = null;       // chiave del bus selezionato
  var itin = null;           // itinerario del bus selezionato
  var lastFeed = null, lastError = null, animating = false;
  var clockOffset = 0;
  var rtLinked = false;      // collegato al framework realtime-layers.js
  var opacity = 1;           // trasparenza (pannello Information del framework)       // differenza orologio server - browser (secondi)
  var VERSION = '2026-11-16b';
  var lizPopup = false;      // popup nativo di Lizmap disponibile e in uso
  var popupLoc = 'map';      // posizione popup del progetto: map, dock, minidock, right-dock, bottom-dock
  var ownGfi = false;        // true mentre siamo noi a chiamare displayGetFeatureInfo
  var lastPopupPx = null;
  var panned = false;        // la finestra Lizmap e' gia' stata portata in vista per questo bus
  var enabled = true;        // false = livello spento dalla casella del framework realtime-layers.js

  // ================= PROIEZIONI (senza librerie esterne) =================
  var D2R = Math.PI / 180, AS2R = Math.PI / 648000;
  var ELL = {
    wgs84: { a: 6378137, f: 1 / 298.257223563 },
    intl:  { a: 6378388, f: 1 / 297 }
  };
  // Monte Mario (Roma40) -> WGS84, parametri EPSG / proj (position vector, arcsec, ppm)
  var ROMA40 = [-104.1, -49.1, -9.9, 0.971, -2.917, 0.714, -11.68];

  var CRS = {
    '25832': { lon0: 9,  fe: 500000,  ell: 'wgs84' }, '6707': { lon0: 9,  fe: 500000,  ell: 'wgs84' },
    '7791':  { lon0: 9,  fe: 500000,  ell: 'wgs84' }, '32632': { lon0: 9, fe: 500000,  ell: 'wgs84' },
    '3044':  { lon0: 9,  fe: 500000,  ell: 'wgs84', swap: true },
    '25833': { lon0: 15, fe: 500000,  ell: 'wgs84' }, '6708': { lon0: 15, fe: 500000,  ell: 'wgs84' },
    '7792':  { lon0: 15, fe: 500000,  ell: 'wgs84' }, '32633': { lon0: 15, fe: 500000, ell: 'wgs84' },
    '3003':  { lon0: 9,  fe: 1500000, ell: 'intl', datum: ROMA40 },
    '3004':  { lon0: 15, fe: 2520000, ell: 'intl', datum: ROMA40 }
  };

  function geoToEcef(lat, lon, e) {
    var a = e.a, e2 = e.f * (2 - e.f), s = Math.sin(lat), N = a / Math.sqrt(1 - e2 * s * s);
    return [N * Math.cos(lat) * Math.cos(lon), N * Math.cos(lat) * Math.sin(lon), N * (1 - e2) * s];
  }
  function ecefToGeo(p, e) {
    var a = e.a, e2 = e.f * (2 - e.f), x = p[0], y = p[1], z = p[2];
    var lon = Math.atan2(y, x), r = Math.sqrt(x * x + y * y), lat = Math.atan2(z, r * (1 - e2));
    for (var i = 0; i < 6; i++) {
      var s = Math.sin(lat), N = a / Math.sqrt(1 - e2 * s * s);
      lat = Math.atan2(z + e2 * N * s, r);
    }
    return [lat, lon];
  }
  function wgs84ToLocal(lat, lon, t, ell) {
    var P = geoToEcef(lat, lon, ELL.wgs84);
    var dx = P[0] - t[0], dy = P[1] - t[1], dz = P[2] - t[2];
    var rx = t[3] * AS2R, ry = t[4] * AS2R, rz = t[5] * AS2R, k = 1 - t[6] * 1e-6;
    var X = k * (dx + rz * dy - ry * dz);
    var Y = k * (-rz * dx + dy + rx * dz);
    var Z = k * (ry * dx - rx * dy + dz);
    return ecefToGeo([X, Y, Z], ell);
  }
  function tmerc(lat, lon, lon0, fe, e) {
    var k0 = 0.9996, a = e.a, e2 = e.f * (2 - e.f), ep2 = e2 / (1 - e2);
    var s = Math.sin(lat), c = Math.cos(lat), tn = Math.tan(lat);
    var N = a / Math.sqrt(1 - e2 * s * s), T = tn * tn, C = ep2 * c * c, A = (lon - lon0 * D2R) * c;
    var e4 = e2 * e2, e6 = e4 * e2;
    var M = a * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * lat
      - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * lat)
      + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * lat)
      - (35 * e6 / 3072) * Math.sin(6 * lat));
    var x = fe + k0 * N * (A + (1 - T + C) * Math.pow(A, 3) / 6
      + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * Math.pow(A, 5) / 120);
    var y = k0 * (M + N * tn * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * Math.pow(A, 4) / 24
      + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * Math.pow(A, 6) / 720));
    return [x, y];
  }

  var projCode = null;
  function mapProjection() {
    try {
      if (mode === 'ol') return String(map.getView().getProjection().getCode());
      if (mode === 'ol2') return String(map.getProjection());
    } catch (e) {}
    return 'EPSG:3857';
  }
  function epsgNumber(code) { var m = String(code).match(/(\d+)\s*$/); return m ? m[1] : ''; }

  function toMapCoords(lon, lat) {
    var n = epsgNumber(projCode || (projCode = mapProjection()));
    if (n === '4326') return [lon, lat];
    if (n === '3857' || n === '900913' || n === '102100') {
      var R = 6378137;
      return [R * lon * D2R, R * Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2))];
    }
    var d = CRS[n];
    if (d) {
      var ll = [lat * D2R, lon * D2R];
      if (d.datum) ll = wgs84ToLocal(ll[0], ll[1], d.datum, ELL[d.ell]);
      return tmerc(ll[0], ll[1], d.lon0, d.fe, ELL[d.ell]);
    }
    var p4 = window.proj4 || (window.lizMap && (lizMap.proj4 || (lizMap.mainLizmap && lizMap.mainLizmap.proj4)));
    if (p4) { try { return p4('EPSG:4326', projCode, [lon, lat]); } catch (e) {} }
    return null;
  }
  function toPixel(coord) {
    if (!coord) return null;
    if (mode === 'ol') return map.getPixelFromCoordinate(coord);
    var px = map.getViewPortPxFromLonLat({ lon: coord[0], lat: coord[1] });
    return px ? [px.x, px.y] : null;
  }
  function lonLatToPixel(lon, lat) { return toPixel(toMapCoords(lon, lat)); }

  // ================= UTILITA' =================
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function keyOf(v) { return v.vehicle_id || v.entity_id; }
  function titleCase(s) {
    return String(s || '').toLowerCase().replace(/(^|[\s.(\/'-])([a-z\u00e0-\u00fc])/g, function (m, p, c) { return p + c.toUpperCase(); });
  }
  function hhmmss(ts) { return ts ? new Date(ts * 1000).toLocaleTimeString('it-IT') : '-'; }
  function stopEvents(el) {
    // impedisce che il clic su bus/popup arrivi alla mappa (interrogazione Lizmap, pan)
    ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click', 'dblclick', 'wheel']
      .forEach(function (t) { el.addEventListener(t, function (ev) { ev.stopPropagation(); }, { passive: t !== 'click' }); });
  }

  // ================= STILE =================
  function injectCss() {
    if (document.getElementById('bus-rt-style')) return;
    var css = document.createElement('style');
    css.id = 'bus-rt-style';
    css.textContent =
      '.bus-rt-layer{position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:900;overflow:hidden}' +
      '.bus-rt-svg{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none}' +
      '.bus-rt{position:absolute;width:0;height:0;pointer-events:none}' +
      '.bus-rt-arrow{position:absolute;left:-26px;top:-26px;width:52px;height:52px;pointer-events:none;transition:transform .6s}' +
      '.bus-rt-arrow:before{content:"";position:absolute;left:50%;top:0;margin-left:-8px;border-left:8px solid transparent;' +
        'border-right:8px solid transparent;border-bottom:11px solid var(--bus-col,#0066CC);' +
        'filter:drop-shadow(0 0 1px #fff) drop-shadow(0 0 1px #fff) drop-shadow(0 1px 1px rgba(0,0,0,.4))}' +
      '.bus-rt-badge{position:absolute;transform:translate(-50%,-50%);pointer-events:auto;cursor:pointer;min-width:24px;height:24px;' +
        'padding:0 5px;border-radius:12px;border:2px solid #fff;background:var(--bus-col,#0066CC);color:var(--bus-txt,#fff);' +
        'font:700 12px/20px "Titillium Web",Geneva,Tahoma,sans-serif;text-align:center;white-space:nowrap;' +
        'box-shadow:0 1px 4px rgba(0,0,0,.45);box-sizing:border-box}' +
      '.bus-rt-ring,.bus-rt-ping{position:absolute;left:-15px;top:-15px;width:30px;height:30px;border-radius:50%;' +
        'box-sizing:border-box;pointer-events:none;opacity:0}' +
      '.bus-rt-ring{border:2px solid var(--bus-col,#0066CC);animation:busrtring 2.4s ease-out infinite}' +
      '.bus-rt-ring.r2{animation-delay:1.2s}' +
      '.bus-rt-ping{background:var(--bus-col,#0066CC)}' +
      '.bus-rt-ping.go{animation:busrtping .9s ease-out 1}' +
      '@keyframes busrtring{0%{transform:scale(.75);opacity:.75}100%{transform:scale(2.3);opacity:0}}' +
      '@keyframes busrtping{0%{transform:scale(.8);opacity:.45}100%{transform:scale(2.8);opacity:0}}' +
      '.bus-rt.stale .bus-rt-ring,.bus-rt.dim .bus-rt-ring,.bus-rt-layer.norings .bus-rt-ring{animation:none;display:none}' +
      '.bus-rt.sel .bus-rt-ring{border-width:3px}' +
      '@media (prefers-reduced-motion:reduce){.bus-rt-ring{animation:none;opacity:.35;transform:scale(1.4)}.bus-rt-ping.go{animation:none}}' +
      '.bus-rt.unknown .bus-rt-badge{border-style:dashed}' +
      '.bus-rt.stale{opacity:.45}' +
      '.bus-rt.sel .bus-rt-badge{box-shadow:0 0 0 3px rgba(0,102,204,.35),0 1px 4px rgba(0,0,0,.45);transform:translate(-50%,-50%) scale(1.15)}' +
      '.bus-rt.dim{opacity:.35}' +
      '.bus-rt-pop{position:absolute;pointer-events:auto;width:300px;max-width:calc(100% - 20px);background:#fff;border-radius:4px;' +
        'box-shadow:0 6px 24px rgba(23,50,77,.25);z-index:902}' +
      '.bus-rt-card{font:14px/1.4 "Titillium Web",Geneva,Tahoma,sans-serif;color:#191919;min-width:240px;text-align:left}' +
      '.bus-rt-card ol,.bus-rt-card li{margin:0}' +
      '.bus-rt-pop .bus-rt-card .h{padding-right:34px}' +
      '.bus-rt-pop .x{position:absolute;right:6px;top:6px;width:24px;height:24px;border:0;background:none;font-size:20px;line-height:20px;' +
        'color:#5D7083;cursor:pointer;z-index:1}' +
      '.bus-rt-card .h{display:flex;gap:10px;align-items:center;padding:10px 12px;border-bottom:2px solid var(--bus-col,#0066CC)}' +
      '.bus-rt-card .b{display:inline-block;min-width:34px;padding:2px 7px;border-radius:4px;font-weight:700;font-size:15px;text-align:center;' +
        'background:var(--bus-col,#0066CC);color:var(--bus-txt,#fff)}' +
      '.bus-rt-card .t{font-weight:700;font-size:16px;color:#17324D;line-height:1.2}' +
      '.bus-rt-card .s{font-size:12px;color:#5D7083}' +
      '.bus-rt-card .chips{display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px 2px}' +
      '.bus-rt-card .chip{font-size:12px;font-weight:600;padding:1px 8px;border-radius:12px;background:#E6E9F2;color:#17324D}' +
      '.bus-rt-card .chip.ok{background:#E3F4EA;color:#00804D}.bus-rt-card .chip.late{background:#FDECEF;color:#CC334D}' +
      '.bus-rt-card .chip.warn{background:#FFF4E0;color:#A66300}' +
      '.bus-rt-card .sec{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#5D7083;font-weight:600;padding:8px 12px 4px}' +
      '.bus-rt-card ol{list-style:none;margin:0;padding:0 12px 8px;max-height:220px;overflow:auto}' +
      '.bus-rt-card.compact ol{max-height:none;overflow:visible}.bus-rt-card.compact .h{padding-right:28px}' +
      '.bus-rt-card li{display:flex;gap:8px;align-items:baseline;padding:4px 0 4px 14px;border-left:2px solid var(--bus-col,#0066CC);position:relative}' +
      '.bus-rt-card li:before{content:"";position:absolute;left:-6px;top:9px;width:8px;height:8px;border-radius:50%;background:#fff;' +
        'border:2px solid var(--bus-col,#0066CC)}' +
      '.bus-rt-card li.next{background:#E6F0FA;font-weight:600}.bus-rt-card li.next:before{background:var(--bus-col,#0066CC)}' +
      '.bus-rt-card li.end:before{border-radius:2px}' +
      '.bus-rt-card li .o{flex:0 0 40px;font-variant-numeric:tabular-nums;font-weight:700;color:#17324D}' +
      '.bus-rt-card li .n{flex:1 1 auto}.bus-rt-card li .p{font-size:12px;color:#CC334D;white-space:nowrap}' +
      '.bus-rt-card li .ml{font-size:10px;color:#0066CC;border:1px solid #0066CC;border-radius:3px;padding:0 3px;margin-left:4px}' +
      '.bus-rt-card .f{font-size:11px;color:#5D7083;padding:6px 12px 10px;border-top:1px solid #E6E9F2}' +
      '.bus-rt-card .msg{padding:10px 12px;color:#5D7083;font-style:italic}' +
      '.bus-rt-info{position:absolute;left:50%;bottom:8px;transform:translateX(-50%);background:rgba(255,255,255,.92);' +
        'padding:3px 10px;border-radius:12px;font:12px "Titillium Web",Geneva,Tahoma,sans-serif;color:#17324D;' +
        'box-shadow:0 1px 3px rgba(0,0,0,.2);pointer-events:none;white-space:nowrap}' +
      '.bus-rt-info .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#00804D;margin-right:6px;' +
        'animation:busrtp 2s infinite}' +
      '.bus-rt-info.err .dot{background:#CC334D;animation:none}' +
      '@keyframes busrtp{0%{opacity:1}50%{opacity:.3}100%{opacity:1}}';
    document.head.appendChild(css);
  }

  function ensureContainer() {
    if (container) return;
    injectCss();
    var host = (mode === 'ol') ? map.getViewport() : (map.viewPortDiv || map.div);
    container = document.createElement('div');
    container.className = 'bus-rt-layer';
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'bus-rt-svg');
    container.appendChild(svg);
    info = document.createElement('div');
    info.className = 'bus-rt-info';
    container.appendChild(info);
    host.appendChild(container);
    if (!enabled) container.style.display = 'none';
    container.style.opacity = String(opacity);
    if (rtLinked) info.style.display = 'none';
  }

  // ================= BUS =================
  function busElement(b) {
    var el = document.createElement('div');
    el.className = 'bus-rt';
    el.innerHTML = '<div class="bus-rt-ring"></div><div class="bus-rt-ring r2"></div><div class="bus-rt-ping"></div>' +
      '<div class="bus-rt-arrow"></div><div class="bus-rt-badge"></div>';
    var badge = el.lastChild;
    // fasi diverse per ogni bus: gli anelli non pulsano tutti all'unisono
    var phase = -(Math.random() * 2.4).toFixed(2);
    el.querySelectorAll('.bus-rt-ring').forEach(function (r, i) { r.style.animationDelay = (phase + i * 1.2) + 's'; });
    stopEvents(badge);
    badge.addEventListener('click', function () { select(b.key); });
    container.insertBefore(el, info);
    return el;
  }

  function updateBusLook(b) {
    var v = b.v, el = b.el;
    el.style.setProperty('--bus-col', v.colore || DEFAULT_COL);
    el.style.setProperty('--bus-txt', v.colore_testo || '#FFFFFF');
    el.lastChild.textContent = v.linea || v.route_id || '\u2022';
    el.lastChild.title = 'Linea ' + (v.linea || v.route_id || '?') + (v.destinazione ? ' \u2192 ' + titleCase(v.destinazione) : '');
    var arrow = el.querySelector('.bus-rt-arrow');
    if (v.direzione != null) {
      arrow.style.display = '';
      // rotazione sul percorso piu' breve (evita giri completi passando da 359 a 1 grado)
      var prev = b.rot == null ? v.direzione : b.rot;
      var delta = ((v.direzione - prev) % 360 + 540) % 360 - 180;
      b.rot = prev + delta;
      arrow.style.transform = 'rotate(' + b.rot + 'deg)';
    } else {
      arrow.style.display = 'none';
    }
    // eta' del dato misurata con l'orologio del server, non con quello del PC
    var nowS = Date.now() / 1000 + clockOffset;
    el.classList.toggle('stale', !!(v.timestamp && nowS - v.timestamp > STALE_S));
    el.classList.toggle('unknown', !v.trip_noto);
    el.classList.toggle('sel', selected === b.key);
    el.classList.toggle('dim', !!selected && selected !== b.key);
  }

  function ingest(list) {
    var now = performance.now(), seen = {};
    list.forEach(function (v) {
      var k = keyOf(v); if (!k) return;
      seen[k] = true;
      var b = buses[k];
      if (!b) {
        b = buses[k] = { key: k, lon: v.lon, lat: v.lat, from: [v.lon, v.lat], to: [v.lon, v.lat], t0: now };
        b.el = busElement(b);
      } else {
        var moved = Math.abs(b.to[0] - v.lon) > 1e-7 || Math.abs(b.to[1] - v.lat) > 1e-7;
        if (moved) {
          // salti grandi (bus riapparso, errore GPS): niente animazione
          var far = Math.abs(b.lon - v.lon) > 0.01 || Math.abs(b.lat - v.lat) > 0.01;
          b.from = far ? [v.lon, v.lat] : [b.lon, b.lat];
          b.to = [v.lon, v.lat];
          b.t0 = now;
          ping(b);
        }
      }
      b.v = v;
      updateBusLook(b);
    });
    if (container) container.classList.toggle('norings', !RINGS || Object.keys(buses).length > RINGS_MAX);
    Object.keys(buses).forEach(function (k) {
      if (!seen[k]) {
        buses[k].el.remove(); delete buses[k];
        if (selected === k) deselect();
      }
    });
    startAnimation();
  }

  // impulso singolo quando arriva una nuova posizione del bus
  function ping(b) {
    if (!RINGS) return;
    var el = b.el.querySelector('.bus-rt-ping');
    el.classList.remove('go');
    void el.offsetWidth;            // riavvia l'animazione CSS
    el.classList.add('go');
  }

  // ================= ANIMAZIONE E DISEGNO =================
  function startAnimation() {
    if (animating) return;
    animating = true;
    requestAnimationFrame(frame);
  }
  function frame() {
    var now = performance.now(), moving = false;
    Object.keys(buses).forEach(function (k) {
      var b = buses[k], t = Math.min(1, (now - b.t0) / REFRESH_MS);
      b.lon = b.from[0] + (b.to[0] - b.from[0]) * t;
      b.lat = b.from[1] + (b.to[1] - b.from[1]) * t;
      if (t < 1) moving = true;
    });
    draw();
    if (moving) requestAnimationFrame(frame); else animating = false;
  }

  function draw() {
    if (!container) return;
    projCode = mapProjection();
    var drawn = 0;
    Object.keys(buses).forEach(function (k) {
      var b = buses[k], p = lonLatToPixel(b.lon, b.lat);
      if (!p) { b.el.style.display = 'none'; return; }
      drawn++;
      b.el.style.display = '';
      b.el.style.transform = 'translate(' + Math.round(p[0]) + 'px,' + Math.round(p[1]) + 'px)';
    });
    drawItinerary();
    placePopup();
    updateInfo(drawn);
  }

  function svgEl(name, attrs) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (var a in attrs) e.setAttribute(a, attrs[a]);
    return e;
  }
  function pathFrom(coords) {
    var d = '';
    for (var i = 0; i < coords.length; i++) {
      var p = lonLatToPixel(coords[i][0], coords[i][1]);
      if (!p) continue;
      d += (d ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
    }
    return d;
  }
  // divide il percorso nel punto in cui si trova il bus (frazione 0..1 della lunghezza)
  function splitLine(coords, f) {
    if (f == null || coords.length < 2) return [[], coords];
    var len = [0], tot = 0, i;
    for (i = 1; i < coords.length; i++) {
      var dx = (coords[i][0] - coords[i - 1][0]) * Math.cos(coords[i][1] * D2R), dy = coords[i][1] - coords[i - 1][1];
      tot += Math.sqrt(dx * dx + dy * dy); len.push(tot);
    }
    var target = f * tot;
    for (i = 1; i < coords.length; i++) {
      if (len[i] >= target) {
        var r = (target - len[i - 1]) / ((len[i] - len[i - 1]) || 1);
        var mid = [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * r, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * r];
        return [coords.slice(0, i).concat([mid]), [mid].concat(coords.slice(i))];
      }
    }
    return [coords, []];
  }

  function drawItinerary() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!itin || !selected || !buses[selected]) return;
    var col = itin.colore || DEFAULT_COL;
    if (itin.percorso && itin.percorso.length > 1) {
      var parts = splitLine(itin.percorso, itin.posizione_percorso);
      var dDone = pathFrom(parts[0]), dTodo = pathFrom(parts[1]);
      if (dDone) svg.appendChild(svgEl('path', { d: dDone, fill: 'none', stroke: '#9AA7B4', 'stroke-width': 4,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-dasharray': '1 7' }));
      if (dTodo) {
        svg.appendChild(svgEl('path', { d: dTodo, fill: 'none', stroke: '#fff', 'stroke-width': 8, 'stroke-linecap': 'round',
          'stroke-linejoin': 'round', opacity: 0.9 }));
        svg.appendChild(svgEl('path', { d: dTodo, fill: 'none', stroke: col, 'stroke-width': 5, 'stroke-linecap': 'round',
          'stroke-linejoin': 'round' }));
      }
    }
    (itin.fermate || []).forEach(function (s) {
      var p = lonLatToPixel(s.lon, s.lat); if (!p) return;
      var passed = s.stato === 'passata', next = s.stato === 'prossima';
      var c = svgEl('circle', { cx: p[0].toFixed(1), cy: p[1].toFixed(1), r: next ? 7 : 4.5,
        fill: next ? col : '#fff', stroke: passed ? '#9AA7B4' : col, 'stroke-width': next ? 3 : 2.5 });
      if (next) c.setAttribute('stroke', '#fff');
      svg.appendChild(c);
    });
  }

  // ================= SELEZIONE, ITINERARIO, POPUP =================
  function select(k) {
    if (selected === k) return;
    selected = k; itin = null;
    Object.keys(buses).forEach(function (kk) { updateBusLook(buses[kk]); });
    showPopup();
    loadItinerary();
    draw();
  }
  // silent = il popup e' gia' stato chiuso o sostituito da Lizmap: non toccarlo
  function deselect(silent) {
    selected = null; itin = null; lastPopupPx = null; panned = false;
    if (popup) popup.style.display = 'none';
    if (lizPopup && silent !== true) {
      var card = document.getElementById('bus-rt-card');
      if (card) {
        if (popupLoc === 'map') {
          try { lizMap.mainLizmap.popup.mapPopup.setPosition(undefined); } catch (e) {}
        } else {
          card.innerHTML = '<div class="msg">Clicca un bus sulla mappa per vederne destinazione e itinerario.</div>';
        }
      }
    }
    Object.keys(buses).forEach(function (k) { updateBusLook(buses[k]); });
    draw();
  }

  function loadItinerary() {
    var b = buses[selected];
    if (!b || !b.v.trip_id || !b.v.trip_noto) { renderPopup(); return; }
    var v = b.v, k = selected;
    var q = '?trip=' + encodeURIComponent(v.trip_id) + '&lon=' + v.lon + '&lat=' + v.lat +
      (v.stop_seq != null ? '&seq=' + v.stop_seq : '') + (v.start_date ? '&date=' + v.start_date : '') +
      (v.timestamp ? '&ts=' + v.timestamp : '');
    fetch(BUS_API + q, { cache: 'no-store' })
      .then(readJson)
      .then(function (d) {
        if (selected !== k) return;
        itin = d && !d.error ? d : null;
        renderPopup(d && d.error);
        draw();
      })
      .catch(function () { if (selected === k) renderPopup('Itinerario non disponibile'); });
  }

  function showPopup() {
    if (lizPopup) {
      var b = buses[selected], c = toMapCoords(b.lon, b.lat), p = toPixel(c);
      ownGfi = true;
      try {
        // stesso meccanismo dei popup dei layer: pannello o finestra secondo il progetto
        lizMap.displayGetFeatureInfo('<div id="bus-rt-card" class="bus-rt-card"></div>',
          { x: p ? p[0] : 0, y: p ? p[1] : 0 }, c);
      } catch (e) {
        console.warn('[bus-realtime] popup Lizmap non utilizzabile, uso il popup proprio', e);
        lizPopup = false;
      }
      ownGfi = false;
      lastPopupPx = null; panned = false;
      if (lizPopup) { renderPopup(); return; }
    }
    if (!popup) {
      popup = document.createElement('div');
      popup.className = 'bus-rt-pop';
      stopEvents(popup);
      container.appendChild(popup);
    }
    popup.style.display = 'block';
    renderPopup();
  }

  function delayChip(min) {
    if (min == null) return '';
    if (min <= 1 && min >= -1) return '<span class="chip ok">In orario</span>';
    if (min < 0) return '<span class="chip warn">In anticipo di ' + (-min) + ' min</span>';
    return '<span class="chip late">Ritardo ~' + min + ' min</span>';
  }

  function renderPopup(errMsg) {
    var b = buses[selected];
    if (!b) return;
    var target;
    if (lizPopup) {
      target = document.getElementById('bus-rt-card');
      if (!target) { deselect(true); return; }       // Lizmap ha mostrato un altro popup
    } else {
      if (!popup) return;
      popup.innerHTML = '<button class="x" title="Chiudi" aria-label="Chiudi">\u00d7</button><div class="bus-rt-card"></div>';
      popup.querySelector('.x').addEventListener('click', function () { deselect(); });
      target = popup.lastChild;
    }
    var v = b.v, d = itin;
    var compact = lizPopup && popupLoc === 'map';
    var maxStops = compact ? 3 : NEXT_STOPS;
    target.classList.toggle('compact', compact);
    target.style.setProperty('--bus-col', v.colore || DEFAULT_COL);
    target.style.setProperty('--bus-txt', v.colore_testo || '#FFFFFF');
    var dest = d && d.destinazione || v.destinazione;
    var h = '<div class="h"><span class="b">' + esc(v.linea || v.route_id || '?') + '</span><div>' +
      '<div class="t">' + (dest ? '\u2192 ' + esc(titleCase(dest)) : 'Linea ' + esc(v.linea || v.route_id || '?')) + '</div>' +
      '<div class="s">' + esc(titleCase(d && d.descrizione || v.descrizione || '')) + '</div></div></div>';

    h += '<div class="chips">' + delayChip(d && d.ritardo_min) +
      (v.speed_kmh != null ? '<span class="chip">' + Math.round(v.speed_kmh) + ' km/h</span>' : '') +
      (v.status === 'STOPPED_AT' ? '<span class="chip">Fermo in fermata</span>' : '') +
      (v.label || v.vehicle_id ? '<span class="chip">Mezzo ' + esc(v.label || v.vehicle_id) + '</span>' : '') +
      '</div>';

    if (d && d.fermate) {
      var future = d.fermate.filter(function (s) { return s.stato !== 'passata'; });
      var shown = future.slice(0, maxStops), last = d.fermate[d.fermate.length - 1];
      h += '<div class="sec">Prossime fermate</div><ol>';
      shown.forEach(function (s) {
        h += '<li class="' + (s.stato === 'prossima' ? 'next' : '') + (s === last ? ' end' : '') + '">' +
          '<span class="o">' + esc(s.ora) + '</span><span class="n">' + esc(titleCase(s.nome)) +
          (s.montelupo ? '<span class="ml">Montelupo</span>' : '') + '</span>' +
          (s.prevista && s.prevista !== s.ora ? '<span class="p">prev. ' + esc(s.prevista) + '</span>' : '') + '</li>';
      });
      if (future.length > shown.length) {
        h += '<li class="end"><span class="o">' + esc(last.ora) + '</span><span class="n">\u2026 ' +
          esc(titleCase(last.nome)) + ' (capolinea, ' + (future.length - shown.length) + ' fermate dopo)</span></li>';
      }
      if (!future.length) h += '<li class="end"><span class="n">Corsa al capolinea</span></li>';
      h += '</ol>';
    } else if (errMsg) {
      h += '<div class="msg">' + esc(errMsg) + '</div>';
    } else if (!v.trip_noto) {
      h += '<div class="msg">Corsa non presente negli orari caricati: itinerario non disponibile.</div>';
    } else {
      h += '<div class="msg">Caricamento itinerario\u2026</div>';
    }
    var foot = [];
    if (v.timestamp) foot.push('Posizione delle ' + hhmmss(v.timestamp));
    if (d && d.ritardo_min != null) foot.push(compact ? 'ritardo stimato' : 'ritardo stimato confrontando posizione e orario programmato');
    if (foot.length) h += '<div class="f">' + foot.join(' \u00b7 ') + '</div>';
    target.innerHTML = h;
    placePopup();
    // finestra Lizmap sulla mappa: una sola volta, a contenuto caricato, la porta in vista
    if (compact && !panned && d) {
      panned = true;
      try {
        var ov = lizMap.mainLizmap.popup.mapPopup;
        if (typeof ov.panIntoView === 'function') ov.panIntoView({ animation: { duration: 250 }, margin: 20 });
      } catch (e) {}
    }
  }

  function placePopup() {
    if (lizPopup) {
      // popup Lizmap sulla mappa: la finestra segue il bus (solo se mostra ancora il nostro bus)
      if (popupLoc !== 'map' || !selected || !buses[selected] || !document.getElementById('bus-rt-card')) return;
      var bb = buses[selected], c = toMapCoords(bb.lon, bb.lat), px = toPixel(c);
      if (!c || !px) return;
      if (lastPopupPx && Math.abs(px[0] - lastPopupPx[0]) < 1 && Math.abs(px[1] - lastPopupPx[1]) < 1) return;
      lastPopupPx = px;
      try {
        // spostare la finestra insieme al bus senza far ripartire ogni volta lo spostamento automatico della mappa
        var ov = lizMap.mainLizmap.popup.mapPopup, ap = ov.autoPan;
        ov.autoPan = undefined;
        ov.setPosition(c);
        ov.autoPan = ap;
      } catch (e) {}
      return;
    }
    if (!popup || popup.style.display === 'none' || !selected || !buses[selected]) return;
    var b = buses[selected], p = lonLatToPixel(b.lon, b.lat);
    if (!p) return;
    var W = container.clientWidth, H = container.clientHeight, w = popup.offsetWidth, h = popup.offsetHeight;
    var G = 22, M = 10, x, y;
    var clampX = function (v) { return Math.min(Math.max(v, M), W - w - M); };
    var clampY = function (v) { return Math.min(Math.max(v, M), H - h - M); };
    // il popup non deve coprire il bus: sopra, sotto, a destra o a sinistra
    if (p[1] - h - G >= M)            { x = clampX(p[0] - w / 2); y = p[1] - h - G; }
    else if (p[1] + G + h <= H - M)   { x = clampX(p[0] - w / 2); y = p[1] + G; }
    else if (p[0] + G + w <= W - M)   { x = p[0] + G;             y = clampY(p[1] - h / 2); }
    else if (p[0] - G - w >= M)       { x = p[0] - G - w;         y = clampY(p[1] - h / 2); }
    else                              { x = clampX(p[0] - w / 2); y = M; }
    popup.style.left = Math.round(x) + 'px';
    popup.style.top = Math.round(y) + 'px';
  }

  function updateInfo(drawn) {
    if (!info) return;
    var n = Object.keys(buses).length;
    reportToFramework(n);
    // con il framework la barra in basso e' quella comune a tutti i livelli
    info.style.display = rtLinked ? 'none' : '';
    info.classList.toggle('err', !!lastError);
    if (lastError) {
      info.innerHTML = '<span class="dot"></span>Bus in tempo reale: ' + esc(lastError);
      return;
    }
    var txt = '<span class="dot"></span>' + n + ' bus ' + (SHOW_ALL ? 'in Toscana' : 'nell\'area di Montelupo') +
      ' \u00b7 aggiornato ' + hhmmss(lastFeed) +
      (lastFeed ? ' (dati di ' + Math.max(0, Math.round((Date.now() / 1000 + clockOffset - lastFeed) / 60)) + ' min fa)' : '');
    if (n && !drawn) txt += ' \u00b7 sistema di riferimento ' + esc(projCode) + ' non gestito';
    info.innerHTML = txt;
  }

  // ================= DATI =================
  // legge la risposta di bus.php con messaggi chiari se l'indirizzo e' sbagliato o il PHP stampa errori
  function readJson(r) {
    return r.text().then(function (t) {
      if (r.status === 404) throw new Error('bus.php non trovato (404): controllare BUS_API = ' + BUS_API);
      try { return JSON.parse(t); } catch (e) {
        var start = t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
        throw new Error('risposta non JSON da ' + BUS_API + ' (HTTP ' + r.status + '): ' + start);
      }
    });
  }

  function load() {
    if (!enabled || document.hidden) return;
    fetch(BUS_API + (SHOW_ALL ? '?all=1' : ''), { cache: 'no-store' })
      .then(readJson)
      .then(function (d) {
        if (d.error) throw new Error(d.error);
        lastError = null;
        lastFeed = d.feed_timestamp || null;
        if (d.server_time) clockOffset = d.server_time - Date.now() / 1000;
        ingest(d.vehicles || []);
        if (selected && buses[selected]) {
          if (buses[selected].v.trip_noto) loadItinerary(); else renderPopup();
        }
      })
      .catch(function (e) {
        console.error('[bus-realtime]', e);
        lastError = /404|JSON/.test(String(e && e.message)) ? String(e.message).slice(0, 110) : 'errore di caricamento';
        updateInfo(0);
        reportToFramework(Object.keys(buses).length);
      });
  }

  // ================= PLUGIN DEL FRAMEWORK realtime-layers.js =================
  // Accende o spegne i bus secondo la casella "Bus TPL" del pannello Layer.
  function setEnabled(on) {
    on = !!on;
    if (on === enabled && container) return;
    enabled = on;
    if (container) container.style.display = enabled ? '' : 'none';
    if (!enabled) {
      if (selected) deselect();
    } else if (map) {
      load();          // posizioni aggiornate subito, senza aspettare il ciclo
      draw();
    }
  }

  // Trasparenza scelta nel pannello Information
  function setOpacity(v) {
    opacity = Math.max(0, Math.min(1, Number(v)));
    if (container) container.style.opacity = String(opacity);
  }

  // Bus correnti come GeoJSON (EPSG:4326): servono al framework per Zoom ed Esporta
  function getGeoJSON() {
    return {
      type: 'FeatureCollection',
      features: Object.keys(buses).map(function (k) {
        var b = buses[k], v = b.v || {};
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [b.to ? b.to[0] : b.lon, b.to ? b.to[1] : b.lat] },
          properties: {
            linea: v.linea || null, destinazione: v.destinazione || null, direzione: v.direzione != null ? v.direzione : null,
            mezzo: v.label || v.vehicle_id || null, vehicle_id: v.vehicle_id || null, trip_id: v.trip_id || null,
            route_id: v.route_id || null, velocita_kmh: v.speed_kmh != null ? v.speed_kmh : null,
            timestamp: v.timestamp || null
          }
        };
      })
    };
  }

  // Stato per la barra comune e il pannello Information del framework
  function reportToFramework(n) {
    if (!rtLinked || typeof LizRealtime.reportStatus !== 'function') return;
    LizRealtime.reportStatus('bus', {
      count: n,
      updated: lastFeed,
      error: lastError,
      interval: REFRESH_MS / 1000,
      text: n + ' bus ' + (SHOW_ALL ? 'in Toscana' : 'nell\'area di Montelupo')
    });
  }

  function registerPlugin() {
    if (!window.LizRealtime || typeof LizRealtime.registerPlugin !== 'function') return false;
    LizRealtime.registerPlugin('bus', {
      setVisible: function (on) { setEnabled(on); },
      setOpacity: setOpacity,
      getGeoJSON: getGeoJSON
    });
    rtLinked = true;
    if (info) info.style.display = 'none';
    reportToFramework(Object.keys(buses).length);
    console.info('[bus-realtime] collegato al framework realtime-layers.js come plugin "bus"');
    return true;
  }
  // il framework puo' caricarsi prima o dopo questo file: lo cerco per 30 s
  if (!registerPlugin()) {
    var rtTries = 0;
    var rtPoll = setInterval(function () {
      if (registerPlugin() || ++rtTries > 60) clearInterval(rtPoll);
    }, 500);
  }
  // scheda di nuovo in primo piano: aggiornamento immediato
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && map && enabled) load();
  });

  // ================= AVVIO =================
  function start() {
    if (map) return;
    if (window.lizMap && lizMap.mainLizmap && lizMap.mainLizmap.map &&
        typeof lizMap.mainLizmap.map.getPixelFromCoordinate === 'function') {
      map = lizMap.mainLizmap.map; mode = 'ol';                       // Lizmap 3.6+
      map.on('postrender', draw);
      map.on('singleclick', function () { if (selected) deselect(); });
    } else if (window.lizMap && lizMap.map && typeof lizMap.map.getViewPortPxFromLonLat === 'function') {
      map = lizMap.map; mode = 'ol2';                                  // Lizmap <= 3.5
      map.events.register('move', null, draw);
      map.events.register('click', null, function () { if (selected) deselect(); });
    } else {
      return;
    }
    projCode = mapProjection();
    setupLizmapPopup();
    console.info('[bus-realtime] versione', VERSION, 'avviato, modalita', mode, 'proiezione', projCode,
      'popup', lizPopup ? 'Lizmap (' + popupLoc + ')' : 'proprio');
    ensureContainer();
    load();
    setInterval(load, REFRESH_MS);
  }

  function setupLizmapPopup() {
    if (!LIZMAP_POPUP || mode !== 'ol' || typeof lizMap.displayGetFeatureInfo !== 'function') return;
    var opts = (lizMap.config && lizMap.config.options) || {};
    popupLoc = ('popupLocation' in opts) ? opts.popupLocation : 'map';   // stessa regola di Lizmap
    var ok = popupLoc === 'map'
      ? !!(lizMap.mainLizmap.popup && lizMap.mainLizmap.popup.mapPopup && document.getElementById('liz_layer_popup_contentDiv'))
      : !!document.querySelector('#popupcontent div.menu-content');
    if (!ok) return;
    lizPopup = true;
    var onDockClosed = function (e) { if (selected && e && e.id === 'popupcontent') deselect(true); };
    if (lizMap.events && typeof lizMap.events.on === 'function') {
      lizMap.events.on({
        // un altro popup (es. una palina) ha preso il posto di quello del bus
        lizmappopupdisplayed: function () {
          if (!ownGfi && selected && !document.getElementById('bus-rt-card')) deselect(true);
        },
        dockclosed: onDockClosed, minidockclosed: onDockClosed,
        rightdockclosed: onDockClosed, bottomdockclosed: onDockClosed
      });
    }
    var closer = document.getElementById('liz_layer_popup_closer');
    if (closer) closer.addEventListener('click', function () { if (selected) deselect(true); });
  }

  function mapReady() {
    return window.lizMap && ((lizMap.mainLizmap && lizMap.mainLizmap.map &&
      typeof lizMap.mainLizmap.map.getPixelFromCoordinate === 'function') ||
      (lizMap.map && typeof lizMap.map.getViewPortPxFromLonLat === 'function'));
  }

  // Lizmap 3.8+ carica gli script utente in modo differito: l'evento "uicreated"
  // puo' essere gia' passato. Quindi: evento se arriva, altrimenti attesa attiva (max 60 s).
  if (window.lizMap && lizMap.events && typeof lizMap.events.on === 'function') {
    lizMap.events.on({ uicreated: function () { setTimeout(start, 500); } });
  }
  var tries = 0;
  var poll = setInterval(function () {
    if (map) { clearInterval(poll); return; }
    if (mapReady()) { clearInterval(poll); start(); return; }
    if (++tries > 120) { clearInterval(poll); console.error('[bus-realtime] Mappa Lizmap non disponibile'); }
  }, 500);
})();
