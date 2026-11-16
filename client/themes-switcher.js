/**
 * themes-switcher.js — Lizmap Web Client 3.9
 * Per i progetti con "viste" (Temi della mappa di QGIS), sostituisce la legenda
 * tradizionale con una scelta semplice di vista e sfondo.
 *
 * Desktop:
 *   - bottone "Tematismi" in alto al centro, sotto l'header: al clic apre
 *     verso il basso l'elenco delle viste e, sotto, gli sfondi (layer di base);
 *   - il pannello "Layer" nativo resta, ma la legenda è di sola consultazione:
 *     niente caselle per accendere/spegnere layer, niente filtro dei layer,
 *     solo i layer accesi nella vista attiva.
 * Mobile (fino a MOBILE_MAX px):
 *   - il pannello "Layer" mostra tasselli con i nomi delle viste e degli sfondi
 *     al posto della legenda.
 * Nei progetti senza viste lo script non cambia nulla.
 *
 * Script autonomo. Installazione: <cartella_repository>/media/js/default/themes-switcher.js
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Configurazione                                                      */
  /* ------------------------------------------------------------------ */

  var MOBILE_MAX = 767;                 // uguale a mobile-ui.js
  var BUTTON_LABEL = 'Tematismi';
  var THEMES_TITLE = 'Viste';
  var BASE_TITLE = 'Sfondo';
  var SHOW_BASE_LAYERS = true;          // mostra anche gli sfondi
  var WAIT_MS = 20000;                  // attesa massima del caricamento di Lizmap
  var LEGEND_ONLY_VISIBLE = true;       // legenda desktop: solo i layer accesi

  var SEL = {
    themeItems: '#theme-selector .theme, #switcher-layers-actions .theme',
    legend: '#switcher-layers-container',
    tree: '#switcher lizmap-treeview',
    // elementi del pannello Layer da togliere su desktop (filtro layer, menu Temi nativo)
    deskHide: '#layer-filter-bar, #layerActionUnfilter, #theme-selector',
    // nella legenda: elementi che servono solo a espandere/chiudere (restano cliccabili)
    expanders: '.expandable, .expanded, .collapsed, .toggle, [class*="expand"], [class*="collapse"]',
    // nella legenda: sempre cliccabili (metadati del layer e il loro pannello, azioni)
    allowInTree: '.layer-actions, [class*="icon-info"], [class*="info"], [class*="metadata"], button, a',
    baseBlock: '#switcher-baselayer',
    baseSelect: 'lizmap-base-layers select',
    switcherPane: '#switcher',
    layerMenuItem: '#mapmenu li.switcher',
    layerLink: '#button-switcher'
  };

  /* ------------------------------------------------------------------ */
  /* Stili (Bootstrap Italia)                                            */
  /* ------------------------------------------------------------------ */

  var CSS = [
    ':root{--lzth-primary:#0066CC;--lzth-primary-dark:#004D99;--lzth-light:#F0F6FC;',
    '  --lzth-text:#1A1A1A;--lzth-muted:#5D7083;--lzth-border:#E6E9F2;--lzth-focus:#FF9900;',
    '  --lzth-font:"Titillium Web",Geneva,Tahoma,sans-serif;}',

    /* mobile: legenda nascosta (al suo posto i tasselli) */
    'body.lzth-mob ' + SEL.legend + '{display:none !important;}',
    /* sfondi nativi nascosti ovunque: si scelgono da Tematismi / tasselli */
    'body.lzth ' + SEL.baseBlock + '{display:none !important;}',

    /* desktop: legenda di sola consultazione */
    'body.lzth-desk ' + SEL.deskHide.split(',').join(',body.lzth-desk ') + '{display:none !important;}',
    'body.lzth-desk ' + SEL.tree + ' input[type="checkbox"]{display:none !important;}',
    'body.lzth-desk ' + SEL.tree + ' label{cursor:default !important;}',
    LEGEND_ONLY_VISIBLE ? 'body.lzth-desk ' + SEL.tree + ' li.not-visible{display:none !important;}' : '',
    /* livelli esterni (es. tempo reale): nascosti se spenti; gruppo nascosto se tutti spenti */
    LEGEND_ONLY_VISIBLE ? 'body.lzth-desk ' + SEL.tree + ' li[data-testid^="ol-"]:has(> div:not(.checked)),' +
      'body.lzth-desk ' + SEL.tree + ' li[data-testid^="ext-"]:not(:has(li[data-testid^="ol-"] > div.checked))' +
      '{display:none !important;}' : '',

    /* --- desktop: bottone in alto al centro, sotto l'header ------- */
    '.lzth-dock{display:none;position:fixed;left:50%;top:88px;transform:translateX(-50%);',
    '  z-index:1040;font-family:var(--lzth-font);}',
    'body.lzth-desk .lzth-dock{display:block;}',
    '.lzth-btn{display:inline-flex;align-items:center;gap:8px;height:44px;padding:0 20px;',
    '  border:none;border-radius:22px;background:#fff;color:var(--lzth-primary);',
    '  font-family:inherit;font-size:16px;font-weight:600;cursor:pointer;',
    '  box-shadow:0 2px 6px rgba(0,0,0,.15),0 4px 16px rgba(0,0,0,.12);}',
    '.lzth-btn:hover{background:var(--lzth-light);color:var(--lzth-primary-dark);}',
    '.lzth-btn:focus{outline:none;}',
    '.lzth-btn:focus-visible{box-shadow:0 0 0 3px var(--lzth-focus);}',
    '.lzth-btn .lzth-cur{max-width:220px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;',
    '  font-weight:400;color:var(--lzth-muted);}',
    '.lzth-btn svg{flex:none;transition:transform .15s ease;}',
    '.lzth-btn[aria-expanded="true"] .lzth-caret{transform:rotate(180deg);}',

    '.lzth-pop{position:absolute;left:50%;top:calc(100% + 10px);transform:translateX(-50%);',
    '  width:min(340px,90vw);max-height:60vh;overflow:auto;padding:8px 0;background:#fff;',
    '  border-radius:8px;box-shadow:0 2px 20px rgba(0,0,0,.1),0 20px 40px rgba(0,0,0,.2);',
    '  animation:lzth-down .15s ease-out;}',
    '.lzth-pop[hidden]{display:none;}',
    '@keyframes lzth-down{from{opacity:0;transform:translate(-50%,-8px)}to{opacity:1;transform:translate(-50%,0)}}',
    '@media (prefers-reduced-motion:reduce){.lzth-pop{animation:none;}}',
    '.lzth-sec{margin:8px 0 4px;padding:0 20px;font-size:13px;font-weight:600;letter-spacing:.06em;',
    '  text-transform:uppercase;color:var(--lzth-muted);}',
    '.lzth-opt{display:flex;align-items:center;gap:10px;width:100%;margin:0;padding:10px 20px;',
    '  border:none;border-left:4px solid transparent;background:none;color:var(--lzth-text);',
    '  font-family:inherit;font-size:16px;text-align:left;cursor:pointer;}',
    '.lzth-opt:hover,.lzth-opt:focus-visible{background:var(--lzth-light);outline:none;}',
    '.lzth-opt:focus-visible{box-shadow:inset 0 0 0 2px var(--lzth-focus);}',
    '.lzth-opt.lzth-on{border-left-color:var(--lzth-primary);color:var(--lzth-primary);font-weight:600;}',
    '.lzth-opt .lzth-check{margin-left:auto;visibility:hidden;}',
    '.lzth-opt.lzth-on .lzth-check{visibility:visible;}',
    '.lzth-pop hr{margin:8px 0;border:none;border-top:1px solid var(--lzth-border);}',

    /* --- mobile: tasselli nel pannello Layer --------------------- */
    '.lzth-tiles{display:none;padding:8px 12px 16px;font-family:var(--lzth-font);}',
    'body.lzth-mob .lzth-tiles{display:block;}',
    '.lzth-tiles .lzth-sec{padding:0 4px;}',
    '.lzth-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:12px;}',
    '.lzth-tile{display:flex;align-items:center;justify-content:center;min-height:64px;margin:0;',
    '  padding:10px 12px;border:2px solid var(--lzth-border);border-radius:10px;background:#fff;',
    '  color:var(--lzth-text);font-family:inherit;font-size:15px;font-weight:600;line-height:1.25;',
    '  text-align:center;word-break:break-word;cursor:pointer;-webkit-tap-highlight-color:transparent;}',
    '.lzth-tile:active{background:var(--lzth-light);}',
    '.lzth-tile.lzth-on{border-color:var(--lzth-primary);background:var(--lzth-light);color:var(--lzth-primary);}',
    '.lzth-tile:focus{outline:none;}',
    '.lzth-tile:focus-visible{box-shadow:0 0 0 3px var(--lzth-focus);}'
  ].join('\n');

  var CARET = '<svg class="lzth-caret" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
  var ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>';
  var CHECK = '<svg class="lzth-check" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 12 10 17 19 7"/></svg>';

  /* ------------------------------------------------------------------ */
  /* Utilità                                                             */
  /* ------------------------------------------------------------------ */

  function $(s, r) { return (r || document).querySelector(s); }
  function $all(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function textOf(n) { return (n.textContent || '').replace(/\s+/g, ' ').trim(); }

  /* --- Viste (temi) ---------------------------------------------- */

  function themeItems() {
    return $all(SEL.themeItems).filter(function (n) {
      // tengo il <li class="theme">, non eventuali .theme annidati
      return !(n.parentElement && n.parentElement.closest('.theme'));
    });
  }

  function themeNames() {
    return themeItems().map(textOf).filter(Boolean);
  }

  var currentTheme = null;

  function applyTheme(name) {
    var item = themeItems().filter(function (n) { return textOf(n) === name; })[0];
    if (!item) return;
    var clickable = item.querySelector('a, button') || item;
    clickable.click();
    currentTheme = name;
    // avvisa gli altri script (es. realtime-layers.js) che la vista è cambiata
    document.dispatchEvent(new CustomEvent('lzth:theme-applied', { detail: { name: name } }));
    refresh();
  }

  function activeTheme() {
    var sel = themeItems().filter(function (n) {
      return n.classList.contains('selected') || n.classList.contains('active');
    })[0];
    return sel ? textOf(sel) : currentTheme;
  }

  /* --- Sfondi (layer di base) ------------------------------------ */

  function baseSelect() { return $(SEL.baseSelect); }

  function baseOptions() {
    var s = baseSelect();
    if (!s) return [];
    return Array.prototype.map.call(s.options, function (o) {
      return { value: o.value, label: (o.text || o.value).trim() };
    });
  }

  function activeBase() {
    var s = baseSelect();
    return s ? s.value : null;
  }

  function applyBase(value) {
    var s = baseSelect();
    if (s && s.value !== value) {
      s.value = value;
      s.dispatchEvent(new Event('change', { bubbles: true }));
      s.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // se il componente non ha reagito, uso il comando di Lizmap
    setTimeout(function () {
      try {
        var bl = window.lizMap && lizMap.mainLizmap && lizMap.mainLizmap.state.baseLayers;
        if (bl && bl.selectedBaseLayerName !== value) bl.selectedBaseLayerName = value;
      } catch (e) { /* comando non disponibile */ }
      refresh();
    }, 50);
  }

  /* ------------------------------------------------------------------ */
  /* Interfaccia                                                         */
  /* ------------------------------------------------------------------ */

  var mq, dock, btn, pop, tiles, cur;

  function buildDesktop() {
    dock = document.createElement('div');
    dock.className = 'lzth-dock';
    dock.innerHTML =
      '<div class="lzth-pop" role="menu" hidden></div>' +
      '<button type="button" class="lzth-btn" aria-haspopup="true" aria-expanded="false">' +
      ICON + '<span>' + esc(BUTTON_LABEL) + '</span><span class="lzth-cur"></span>' + CARET + '</button>';
    document.body.appendChild(dock);
    btn = dock.querySelector('.lzth-btn');
    pop = dock.querySelector('.lzth-pop');
    cur = dock.querySelector('.lzth-cur');

    btn.addEventListener('click', function () { setPop(pop.hidden); });
    document.addEventListener('click', function (e) {
      if (!pop.hidden && !dock.contains(e.target)) setPop(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !pop.hidden) { setPop(false); btn.focus(); }
    });
  }

  // Tiene il bottone subito sotto l'header (l'altezza dell'header può variare)
  var HEADER_GAP = 12;
  function placeDock() {
    if (!dock) return;
    var h = document.querySelector('#header');
    // (offsetParent è null per gli elementi "position:fixed": uso dimensioni e display)
    var r = h ? h.getBoundingClientRect() : null;
    var bottom = r && r.height > 0 && getComputedStyle(h).display !== 'none' ? r.bottom : 0;
    dock.style.top = Math.round(bottom + HEADER_GAP) + 'px';
  }

  function setPop(open) {
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      renderPop();
      var on = pop.querySelector('.lzth-on') || pop.querySelector('.lzth-opt');
      if (on) on.focus();
    }
  }

  function renderPop() {
    var html = '<p class="lzth-sec">' + esc(THEMES_TITLE) + '</p>';
    var at = activeTheme();
    themeNames().forEach(function (n) {
      html += '<button type="button" role="menuitemradio" class="lzth-opt' + (n === at ? ' lzth-on' : '') +
        '" data-theme="' + esc(n) + '" aria-checked="' + (n === at) + '">' + esc(n) + CHECK + '</button>';
    });
    var bases = SHOW_BASE_LAYERS ? baseOptions() : [];
    if (bases.length) {
      var ab = activeBase();
      html += '<hr><p class="lzth-sec">' + esc(BASE_TITLE) + '</p>';
      bases.forEach(function (b) {
        html += '<button type="button" role="menuitemradio" class="lzth-opt' + (b.value === ab ? ' lzth-on' : '') +
          '" data-base="' + esc(b.value) + '" aria-checked="' + (b.value === ab) + '">' + esc(b.label) + CHECK + '</button>';
      });
    }
    pop.innerHTML = html;
    $all('.lzth-opt', pop).forEach(function (o) {
      o.addEventListener('click', function () {
        if (o.hasAttribute('data-theme')) { applyTheme(o.getAttribute('data-theme')); setPop(false); }
        else { applyBase(o.getAttribute('data-base')); setPop(false); }
      });
    });
  }

  function buildMobile() {
    tiles = document.createElement('div');
    tiles.className = 'lzth-tiles';
    var pane = $(SEL.switcherPane);
    if (pane) pane.insertBefore(tiles, pane.firstChild);
  }

  function renderTiles() {
    if (!tiles) return;
    var at = activeTheme();
    var html = '<p class="lzth-sec">' + esc(THEMES_TITLE) + '</p><div class="lzth-grid">';
    themeNames().forEach(function (n) {
      html += '<button type="button" class="lzth-tile' + (n === at ? ' lzth-on' : '') +
        '" data-theme="' + esc(n) + '" aria-pressed="' + (n === at) + '">' + esc(n) + '</button>';
    });
    html += '</div>';
    var bases = SHOW_BASE_LAYERS ? baseOptions() : [];
    if (bases.length) {
      var ab = activeBase();
      html += '<p class="lzth-sec">' + esc(BASE_TITLE) + '</p><div class="lzth-grid">';
      bases.forEach(function (b) {
        html += '<button type="button" class="lzth-tile' + (b.value === ab ? ' lzth-on' : '') +
          '" data-base="' + esc(b.value) + '" aria-pressed="' + (b.value === ab) + '">' + esc(b.label) + '</button>';
      });
      html += '</div>';
    }
    tiles.innerHTML = html;
    $all('.lzth-tile', tiles).forEach(function (t) {
      t.addEventListener('click', function () {
        if (t.hasAttribute('data-theme')) applyTheme(t.getAttribute('data-theme'));
        else applyBase(t.getAttribute('data-base'));
      });
    });
  }

  function refresh() {
    if (cur) {
      var at = activeTheme();
      cur.textContent = at ? '· ' + at : '';
    }
    if (pop && !pop.hidden) renderPop();
    renderTiles();
  }

  /* ------------------------------------------------------------------ */
  /* Attivazione                                                         */
  /* ------------------------------------------------------------------ */

  function apply() {
    var mobile = mq.matches;
    document.body.classList.add('lzth');
    document.body.classList.toggle('lzth-desk', !mobile);
    document.body.classList.toggle('lzth-mob', mobile);
    if (mobile && pop) setPop(false);
    refresh();
  }

  // Legenda di sola consultazione (desktop): blocca i clic che accendono o
  // spengono layer e categorie; lascia passare solo le frecce per espandere.
  function guardLegend() {
    function blocked(e) {
      if (!e.isTrusted) return false; // solo azioni dell'utente, mai quelle di Lizmap
      if (!document.body.classList.contains('lzth-desk')) return false;
      var t = e.target;
      if (!t.closest || !t.closest(SEL.tree)) return false;
      if (t.closest(SEL.expanders)) return false;
      if (t.closest(SEL.allowInTree)) return false; // metadati e azioni del layer
      return !!(t.closest('input, label') ||
        (t.tagName === 'INPUT') ||
        t.closest('[role="checkbox"]'));
    }
    ['click', 'mousedown', 'pointerdown', 'change', 'input'].forEach(function (type) {
      document.addEventListener(type, function (e) {
        if (blocked(e)) {
          e.preventDefault();
          e.stopPropagation();
          if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        }
      }, true);
    });
    // tastiera: spazio/Invio su una casella non deve cambiarla
    document.addEventListener('keydown', function (e) {
      if ((e.key === ' ' || e.key === 'Enter') && blocked(e)) { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }

  function init() {
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    mq = window.matchMedia('(max-width: ' + MOBILE_MAX + 'px)');
    guardLegend();
    buildDesktop();
    buildMobile();

    // aggiorna lo stato se vista o sfondo cambiano da altre parti di Lizmap
    var s = baseSelect();
    if (s) s.addEventListener('change', function () { setTimeout(refresh, 0); });
    $all(SEL.themeItems).forEach(function (n) {
      n.addEventListener('click', function () { currentTheme = textOf(n); setTimeout(refresh, 0); });
    });

    placeDock();
    window.addEventListener('resize', placeDock);
    setTimeout(placeDock, 500); // dopo il caricamento dei font

    apply();
    if (mq.addEventListener) mq.addEventListener('change', apply);
    else if (mq.addListener) mq.addListener(apply);
  }

  // Attende che Lizmap costruisca il pannello Layer; si attiva solo se ci sono viste
  function wait() {
    var start = Date.now();
    (function poll() {
      if (themeNames().length) { init(); return; }
      if (Date.now() - start > WAIT_MS) return; // progetto senza viste: nessuna modifica
      setTimeout(poll, 300);
    })();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wait);
  } else {
    wait();
  }
})();
