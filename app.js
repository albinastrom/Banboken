/* Banboken – etapp 1. Offline-först: all data sparas lokalt efter varje ändring. */
(function () {
  'use strict';
  var C = window.Core;
  var KEY = 'banboken:v1';

  // ---------- Demo-data (tydligt märkt, räknas inte i statistik) ----------
  function demoCourse() {
    var pars = demoCourse.base.pars, sis = demoCourse.base.sis, yellow = demoCourse.base.yellow;
    function tee(id, name, cr, slope, factor) {
      return { id: id, name: name, cr: cr, slope: slope, holes: pars.map(function (p, i) {
        return { par: p, si: sis[i], length: Math.round(yellow[i] * factor) };
      }) };
    }
    return {
      id: 'demo', name: 'Demobanan', club: 'Exempelklubben', demo: true, verified: false, lat: null, lon: null,
      tees: [tee('demo-y', 'Gul 57', 70.4, 127, 1), tee('demo-r', 'Röd 48', 68.1, 121, 0.84)],
      geo: demoGeo()
    };
  }
  demoCourse.base = {
    pars: [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 4, 3, 5, 4, 4, 3, 4, 5],
    sis: [7, 3, 15, 11, 1, 9, 17, 5, 13, 8, 4, 16, 12, 2, 10, 18, 6, 14],
    yellow: [345, 372, 148, 468, 395, 330, 132, 360, 455, 340, 380, 155, 470, 402, 325, 140, 365, 480]
  };

  function defaultState() {
    return {
      version: 1,
      profile: { name: '', hi: null, homeClub: '', lang: 'sv', theme: 'auto', allowance: 100, gender: null },
      courses: [demoCourse()],
      rounds: [],
      weatherCache: {},
      friends: [],
      bag: [],
      ratingLib: [],
      admin: { pinHash: null },
      baseline: null,
      ui: { showDemo: false, statsN: 10, sat: true, gpsAuto: false, mapOpen: true, wakeLock: false, shotLog: false, trendMetric: 'points', sgBase: 'personal' }
    };
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var s = JSON.parse(raw);
        if (s && s.version === 1) {
          var d = defaultState();
          s.profile = Object.assign(d.profile, s.profile || {});
          s.ui = Object.assign(d.ui, s.ui || {});
          s.weatherCache = s.weatherCache || {};
          s.friends = s.friends || [];
          s.bag = s.bag || [];
          s.ratingLib = s.ratingLib || [];
          s.admin = s.admin || { pinHash: null };
          if (s.baseline === undefined) s.baseline = null;
          s.courses = s.courses || [];
          s.rounds = s.rounds || [];
          s.courses.forEach(function (c) { if (c.id === 'demo' && !c.geo) c.geo = demoGeo(); });
          return s;
        }
      }
    } catch (e) { /* tom eller trasig lagring – börja om */ }
    return defaultState();
  }

  // ======================= ETAPP 2: GPS, KARTA, OPENSTREETMAP =======================
  var G = window.Geo;
  var gps = { status: 'off', pos: null, watchId: null, target: null, sim: false, suggest: null, lastRender: 0, lastAuto: null };
  var mapCtx = null, satFailed = false;

  function demoGeo() {
    var c = demoCourse.base;
    return G.demoGeometry([56.95, 15.05], c.pars.map(function (p, i) { return { par: p, si: c.sis[i], length: c.yellow[i] }; }));
  }
  function teePoint(h) { return h.tees && h.tees[0] ? G.centroid(h.tees[0]) : h.line[0]; }
  function posLL() { return gps.pos ? [gps.pos.lat, gps.pos.lon] : null; }

  // ======================= LIVE-GPS =======================
  // En enda GPS-prenumeration per rond. Varje rå position passerar ett filter (tidsstämpel, noggrannhet,
  // orimliga hopp, försiktig stabilisering) innan den används. Testläget skickar simulerade positioner
  // genom samma filter men visas alltid tydligt som SIMULERAD.
  var gpsF = G.createGpsFilter();
  gps.test = false; gps.simOffset = 0; gps.lastFixAt = 0; gps.lastRestart = 0; gps.watchdog = null; gps.rejected = 0;
  gps.mv = { k: 1, tx: 0, ty: 0, follow: false, key: null };
  var wakeLock = null;

  function gpsNow() { return Date.now() + (gps.test ? gps.simOffset : 0); }
  // Signalen räknas som borta efter 15 s om telefonen rapporterat fel/tidsgräns, annars efter 45 s utan uppdatering
  // (vissa telefoner skickar inga nya positioner när man står helt still).
  function gpsQ() { return G.gpsQuality(gps.pos, gpsNow(), { lostMs: gps.errSinceFix ? 15000 : 45000 }); }
  function fixAge() { return gps.pos ? Math.round((gpsNow() - gps.pos.ts) / 1000) : null; }
  function gpsState() {
    if (gps.status === 'denied') return 'denied';
    if (gps.test && !gps.pos) return 'testIdle';
    if (!gps.test && gps.watchId === null) return gps.status === 'unavailable' ? 'unavailable' : 'off';
    var q = gpsQ();
    return q === 'none' ? 'searching' : q;
  }
  function ingest(fix) {
    var r = gpsF.push(fix, gpsNow());
    if (!r.ok) { gps.rejected++; gps.lastReject = r.reason; refreshGps(); return; }
    gps.pos = r.pos; gps.status = 'on'; gps.lastFixAt = Date.now(); gps.errSinceFix = false;
    afterPosition();
  }
  function onPos(p) {
    if (gps.test) return;
    var ts = p.timestamp && p.timestamp > 1e12 ? p.timestamp : Date.now();
    ingest({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, ts: ts, speed: p.coords.speed });
  }
  function onPosErr(e) {
    if (e.code === 1) { gpsStop(); gps.status = 'denied'; state.ui.gpsAuto = false; save(); refreshGps(true); return; }
    // Tidsgräns (3) och tillfälligt avbrott (2): prenumerationen fortsätter; vakten visar status och startar om vid behov.
    gps.errSinceFix = true;
    if (!gps.pos && e.code === 2) gps.status = 'unavailable';
    refreshGps();
  }
  function watchOpts() { return { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }; }
  function startWatch() {
    try { gps.watchId = navigator.geolocation.watchPosition(onPos, onPosErr, watchOpts()); gps.lastRestart = Date.now(); }
    catch (e) { gps.status = 'unavailable'; gps.watchId = null; }
  }
  function gpsStart() {
    if (gps.test) { startWatchdog(); return; }
    if (gps.watchId !== null) return;
    if (!navigator.geolocation) { gps.status = 'unavailable'; refreshGps(); return; }
    gps.status = 'asking'; gpsF.reset(); gps.pos = null;
    startWatch(); startWatchdog();
  }
  function gpsStop() {
    if (gps.watchId !== null) { try { navigator.geolocation.clearWatch(gps.watchId); } catch (e) {} gps.watchId = null; }
    if (gps.watchdog) { clearInterval(gps.watchdog); gps.watchdog = null; }
    // Visa aldrig en gammal position som aktuell: positionen nollställs när spårningen stoppas.
    if (!gps.test) { gps.pos = null; gpsF.reset(); }
    if (gps.status !== 'denied') gps.status = 'off';
    releaseWake();
  }
  function startWatchdog() {
    if (gps.watchdog) return;
    var lastQ = null;
    gps.watchdog = setInterval(function () {
      var q = gpsQ();
      // Återhämtning: ingen godkänd position på 30 s → starta om prenumerationen.
      if (!gps.test && gps.watchId !== null && Date.now() - Math.max(gps.lastFixAt, gps.lastRestart) > 30000) {
        try { navigator.geolocation.clearWatch(gps.watchId); } catch (e) {}
        startWatch();
      }
      if (q !== lastQ || q === 'lost') { lastQ = q; refreshGps(); }
    }, 2000);
  }
  function setTestMode(on) {
    gpsStop(); gps.test = !!on; gps.simOffset = 0; gps.pos = null; gpsF.reset(); gps.suggest = null; gps.status = 'off'; gps.errSinceFix = false;
    if (!on && state.ui.gpsAuto) gpsStart();
  }

  // Skärmen tänd under ronden (där webbläsaren stöder det). GPS i bakgrunden stöds inte för webbappar.
  function wakeSupported() { return 'wakeLock' in navigator; }
  function acquireWake() {
    if (!state.ui.wakeLock || !wakeSupported() || wakeLock || document.hidden) return;
    navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; l.addEventListener('release', function () { wakeLock = null; }); }).catch(function () {});
  }
  function releaseWake() { if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; } }

  // Automatisk hålidentifiering: byter hål när spelaren står på nästa tee och föregående hål har ett resultat.
  function afterPosition() {
    var r = activeRound(); if (!r || !gps.pos) { refreshGps(); return; }
    var c = courseById(r.courseId), g = c && c.geo; gps.suggest = null;
    if (g) {
      var me = posLL(), next = r.current + 1 < r.holes.length ? g.holes[String(holeNo(r, r.current + 1))] : null, cur = r.holes[r.current];
      var done = typeof cur.strokes === 'number' || cur.pickedUp;
      if (next && done && G.dist(me, teePoint(next)) < 25 && gps.lastAuto !== r.current + 1) {
        gps.lastAuto = r.current + 1; r.current++; gps.target = null; save();
        view.flash = t('autoHole') + ' ' + (r.current + 1); render(); return;
      }
      var nh = G.nearestHole(me, g.holes);
      if (nh && nh.d < 30) { var idx = +nh.ref - 1 - (r.holeOffset || 0); if (idx !== r.current && idx >= 0 && idx < r.holes.length) gps.suggest = idx; }
    }
    refreshGps();
  }

  // ---------- Avstånd ----------
  function userGreen(hole) { return hole.userGreen || {}; }
  function greenMid(hole) {
    var ug = userGreen(hole);
    if (ug.mid) return { pt: ug.mid, exact: true };
    if (hole.green) return { pt: G.centroid(hole.green), exact: true };
    if (ug.front && ug.back) return { pt: [(ug.front[0] + ug.back[0]) / 2, (ug.front[1] + ug.back[1]) / 2], exact: false };
    return { pt: hole.line[hole.line.length - 1], exact: false };
  }
  function greenCenter(hole) { return greenMid(hole).pt; }
  function greenInfo(hole, from) {
    var ug = userGreen(hole), gm = greenMid(hole), poly = hole.green ? G.greenDistances(from, hole.green, gm.pt) : null;
    return {
      front: ug.front ? G.dist(from, ug.front) : poly ? poly.front : null,
      mid: G.dist(from, gm.pt), back: ug.back ? G.dist(from, ug.back) : poly ? poly.back : null,
      exact: gm.exact, inside: poly ? poly.inside : false, center: gm.pt,
      frontPt: ug.front || (poly && poly.frontPt), backPt: ug.back || (poly && poly.backPt),
      user: !!(ug.front || ug.mid || ug.back), missingEdges: !ug.front && !ug.back && !hole.green
    };
  }
  function holeCtx(r) {
    var c = courseById(r.courseId), g = c && c.geo, hole = g && g.holes[String(holeNo(r, r.current))];
    if (!hole) return { c: c, g: g, hole: null };
    var gc = greenCenter(hole), me = posLL();
    var fromTee = !me || G.dist(me, gc) > 800;
    return { c: c, g: g, hole: hole, gc: gc, me: me, fromTee: fromTee, from: fromTee ? teePoint(hole) : me };
  }

  // ---------- Status ----------
  function gpsStatusHtml() {
    var st = gpsState(), acc = gps.pos ? Math.round(gps.pos.acc) : null, h = '';
    if (gps.test) h += '<span class="gps-st test"><i class="dot test"></i>' + esc(t('gpsTestBadge')) + (st === 'lost' ? ' · ' + esc(fmt(t('gpsLost'), { s: fixAge() })) : gps.pos ? ' · ±' + acc + ' m' : '') + '</span>';
    else if (st === 'good') h += '<span class="gps-st"><i class="dot"></i>' + esc(t('gpsActive')) + ' · ±' + acc + ' m' + (fixAge() > 15 ? ' · ' + esc(fmt(t('gpsAge'), { s: fixAge() })) : '') + '</span>';
    else if (st === 'weak') h += '<span class="gps-st weak"><i class="dot weak"></i>' + esc(t('gpsLow')) + ' · ±' + acc + ' m</span>';
    else if (st === 'lost') h += '<span class="gps-st bad"><i class="dot bad"></i>' + esc(fmt(t('gpsLost'), { s: Math.round((gpsNow() - gps.pos.ts) / 1000) })) + '</span>';
    else if (st === 'searching') h += '<span class="gps-st"><i class="dot wait"></i>' + esc(t('gpsSearching')) + '</span>';
    else if (st === 'denied') h += '<span class="gps-st bad">' + esc(t('gpsNoPermission')) + '</span>';
    else if (st === 'unavailable') h += '<span class="gps-st bad">' + esc(t('gpsUnavailable')) + '</span> <button class="chip" data-act="gps-start">' + esc(t('retry')) + '</button>';
    else if (st === 'off') h += '<button class="chip gps-go" data-act="gps-start">' + esc(t('gpsStart')) + '</button>';
    return h;
  }

  function d3(key, v, approx, big) {
    return '<div class="' + (big ? 'mid' : '') + '"><small>' + esc(t(key)) + (approx ? ' ≈' : '') + '</small><b>' + (v === null || v === undefined ? '–' : Math.round(v)) + '</b></div>';
  }
  function liveHtml(r, x) {
    var h = '', hole = x.hole, gi = greenInfo(hole, x.from), q = gpsQ(), stale = !x.fromTee && q === 'lost';
    var gst = gpsState();
    if (gst === 'off') h += '<p class="note">' + esc(t('gpsWhy')) + '</p>';
    if (gst === 'denied') h += '<p class="note">' + esc(t('gpsDenied')) + '</p>';
    if (stale) h += '<p class="warn">' + esc(t('distStale')) + '</p>';
    else if (!x.fromTee && q === 'weak') h += '<p class="note center">' + esc(fmt(t('distWeak'), { a: Math.round(gps.pos.acc) })) + '</p>';
    if (x.fromTee) h += '<p class="note center">' + esc(gps.pos ? t('fromTeeFar') : t('fromTee')) + '</p>';
    if (gi.user) h += '<p class="note center">' + esc(t('greenUserPts')) + '</p>';
    if (!gi.exact) h += '<p class="note center">' + esc(t('greenApprox')) + '</p>';
    if (gi.missingEdges) h += '<div class="regprompt"><p>' + esc(t('edgesMissing')) + '</p><button class="chip" data-act="greg-open">' + esc(t('regGreen')) + '</button></div>';
    if ((state.bag || []).length && gi.mid > 30 && !stale) {
      var sug = ST.suggestClub(state.bag, learnedClubs(), gi.mid);
      if (sug) h += '<p class="clubsug">' + esc(t('clubSug')) + ': <b>' + esc(sug.name) + '</b> (' + sug.len + ' m' + (sug.learned ? ', ' + esc(t('learnedShort')) : '') + ') ' + tagEst() + '</p>';
    }
    if (gps.target) {
      h += '<div class="target-row"><span>' + esc(t('target')) + ' <b>' + Math.round(G.dist(x.from, gps.target)) + ' m</b> · ' + esc(t('toGreen')) + ' <b>' + Math.round(G.dist(gps.target, gi.center)) + ' m</b></span><button class="chip" data-act="clear-target">' + esc(t('clearTarget')) + '</button></div>';
    }
    var c = x.c;
    if (c.lat !== null && c.lat !== undefined) {
      var wc = state.weatherCache[wKey(c.lat, c.lon)];
      if (wc && Date.now() - new Date(wc.fetchedAt).getTime() < 3 * 3600 * 1000 && wc.d.current) {
        var wr = G.windRelative(wc.d.current.wind_direction_10m, G.bearing(x.from, gi.center));
        h += '<p class="windrel"><svg viewBox="0 0 24 24" class="arrow sm" style="transform:rotate(' + (180 - wr.rel) + 'deg)" aria-hidden="true"><path d="M12 3l5 9h-3.5v9h-3v-9H7z"/></svg>' +
          esc(t('wind_' + wr.type)) + ' ' + dec(wc.d.current.wind_speed_10m, 0) + ' m/s <small>(' + esc(t('forecast')) + ')</small></p>';
      }
    }
    var hz = G.hazardsAhead(x.from, gi.center, hole.hazards).slice(0, 6), dl = G.doglegs(x.from, hole.line);
    if (hz.length || dl.length) {
      h += '<ul class="hazards' + (stale ? ' stale' : '') + '">';
      dl.slice(0, 1).forEach(function (d) {
        h += '<li><span class="hz dogleg"></span><span class="hz-name">' + esc(t('dogleg')) + ' ' + esc(t('side_' + d.dir)) + '</span><span class="hz-n"><b>' + Math.round(d.distance) + '</b><small>' + esc(t('toCorner')) + '</small></span></li>';
      });
      hz.forEach(function (z) {
        h += '<li><span class="hz ' + z.kind + '"></span><span class="hz-name">' + esc(t(z.kind === 'water' ? 'hzWater' : 'hzBunker')) + ' ' + esc(z.nearGreen && z.side !== 'center' ? t('nearGreen') + ' ' + t('side_' + z.side) : t('side_' + z.side)) + '</span>' +
          '<span class="hz-n"><b>' + Math.round(z.reach) + '</b><small>' + esc(t('reach')) + '</small></span><span class="hz-n"><b>' + Math.round(z.carry) + '</b><small>' + esc(t('carry')) + '</small></span></li>';
      });
      h += '</ul>';
    }
    return h;
  }

  function testPanel() {
    return '<div class="testbar" role="note">' + esc(t('simBanner')) + '</div><div class="testpad">' +
      '<button class="chip" data-act="tmove:20:0">↑ ' + esc(t('fwd20')) + '</button><button class="chip" data-act="tmove:-20:0">↓ ' + esc(t('back20')) + '</button>' +
      '<button class="chip" data-act="tmove:0:-20">← ' + esc(t('left20')) + '</button><button class="chip" data-act="tmove:0:20">→ ' + esc(t('right20')) + '</button>' +
      '<button class="chip" data-act="tnoise">' + esc(t('standStill')) + '</button><button class="chip" data-act="tlose">' + esc(t('loseSignal')) + '</button>' +
      '<button class="chip" data-act="ttee">' + esc(t('placeTee')) + '</button><button class="chip" data-act="test-off">' + esc(t('testOff')) + '</button></div>' +
      '<p class="note">' + esc(t('simTap')) + '</p>';
  }
  function gregPanel(x) {
    var ug = userGreen(x.hole), acc = gps.pos ? Math.round(gps.pos.acc) : null, okPos = gps.pos && gpsQ() === 'good' && gps.pos.acc <= 10;
    var h = '<div class="greg"><h4>' + esc(fmt(t('regTitle'), { n: r0hole() })) + '</h4><p class="note">' + esc(t('regHelp')) + '</p>';
    ['front', 'mid', 'back'].forEach(function (k) {
      h += '<div class="gregrow"><span><b>' + esc(t('reg_' + k)) + '</b><small>' + esc(ug[k] ? t('regSaved') : t('regMissing')) + '</small></span>' +
        '<button class="chip" data-act="greg-pos:' + k + '"' + (okPos ? '' : ' disabled') + '>' + esc(t('regHere')) + (acc !== null ? ' ±' + acc + ' m' : '') + '</button>' +
        '<button class="chip' + (view.gregTap === k ? ' on' : '') + '" data-act="greg-tap:' + k + '">' + esc(t('regOnMap')) + '</button>' +
        (ug[k] ? '<button class="chip" data-act="greg-del:' + k + '" aria-label="' + esc(t('delete')) + '">✕</button>' : '') + '</div>';
    });
    if (!okPos) h += '<p class="note">' + esc(t('regNeedAcc')) + '</p>';
    return h + '<button class="btn ghost wide" data-act="greg-close">' + esc(t('close')) + '</button></div>';
  }
  function r0hole() { var r = activeRound(); return r ? holeNo(r, r.current) : ''; }

  function mapButtons(x) {
    var canFollow = !!gps.pos && !x.fromTee, zoomGreen = (view.mapZoom || 'hole') === 'hole';
    return '<button class="mbtn' + (gps.mv.follow ? ' on' : '') + '" data-act="map-follow"' + (canFollow ? '' : ' disabled') + ' aria-label="' + esc(t('followMe')) + '" title="' + esc(t('followMe')) + '">' + ICON.follow + '</button>' +
      '<button class="mbtn" data-act="map-center"' + (canFollow ? '' : ' disabled') + ' aria-label="' + esc(t('centerMe')) + '" title="' + esc(t('centerMe')) + '">' + ICON.center + '</button>' +
      '<button class="mbtn' + (!zoomGreen ? ' on' : '') + '" data-act="zoom:' + (zoomGreen ? 'green' : 'hole') + '" aria-label="' + esc(zoomGreen ? t('zoomGreen') : t('zoomHole')) + '" title="' + esc(zoomGreen ? t('zoomGreen') : t('zoomHole')) + '">' + (zoomGreen ? ICON.green : ICON.hole) + '</button>' +
      '<button class="mbtn' + (state.ui.sat ? ' on' : '') + '" data-act="sat-toggle" aria-label="' + esc(t('satellite')) + '" title="' + esc(t('satellite')) + '">' + ICON.layers + '</button>' +
      (wakeSupported() ? '<button class="mbtn' + (state.ui.wakeLock ? ' on' : '') + '" data-act="wake" aria-label="' + esc(t('keepAwake')) + '" title="' + esc(t('keepAwake')) + '">' + ICON.sun + '</button>' : '');
  }
  function gpsInner(r) {
    var x = holeCtx(r), h = '';
    if (!x.g) {
      var gcourse = courseById(r.courseId);
      return '<div class="gps-under nogeo"><p class="note"><b>' + esc(t('gpsOffNoMap')) + '</b> ' + esc(t('scoreStillWorks')) + '</p>' +
        (gcourse && gcourse.osm ? '<button class="btn ghost" data-act="geo-retry"' + (view.geoBusy ? ' disabled' : '') + '>' + esc(view.geoBusy ? t('geoLoading') : t('fetchMapNow')) + '</button>' : '<p class="note">' + esc(t('noGeo')) + '</p>') + '</div>' + (gps.test ? testPanel() : '');
    }
    var showMap = state.ui.mapOpen && !!x.hole;
    h += '<div class="mapwrap' + (showMap ? '' : ' nomap') + '">';
    if (showMap) h += '<div id="gps-map">' + mapSvg(x.hole, x.gc) + '</div>';
    h += '<div class="map-top"><span id="gps-status">' + gpsStatusHtml() + '</span>' + (x.g.source === 'demo' ? '<em class="tag demo">' + esc(t('demoGeo')) + '</em>' : '<em class="tag">OSM</em>') + '</div>';
    if (showMap) h += '<div class="map-ctrl">' + mapButtons(x) + '</div>';
    if (x.hole) h += '<div class="map-dist" id="gps-dist">' + distHtml(r, x) + '</div>';
    h += '</div>';
    if (gps.test) h += testPanel();
    if (gps.suggest !== null && gps.suggest !== r.current) h += '<button class="suggest" data-act="go:' + gps.suggest + '">' + esc(t('seemsOnHole')) + ' ' + holeNo(r, gps.suggest) + ' – ' + esc(t('switch')) + '</button>';
    if (!x.hole) return h + '<div class="gps-under"><p class="warn">' + esc(t('holeNoCoords').replace('{n}', holeNo(r, r.current))) + '</p></div>';
    h += '<div id="gps-live">' + liveHtml(r, x) + '</div>';
    if (view.gregOpen) h += gregPanel(x);
    h += '<div class="maplinks"><button class="link" data-act="map-toggle">' + esc(state.ui.mapOpen ? t('hideMap') : t('showMap')) + '</button>' +
      (x.g.source === 'demo' && !gps.test ? '<button class="link" data-act="test-on">' + esc(t('simOn')) + '</button>' : '') + '</div>';
    if (showMap) h += '<p class="note gps-under">' + esc(view.gregTap ? t('regTapHint') : gps.test ? t('simTap') : t('tapHint')) + '</p>';
    return h;
  }

  // Delvis uppdatering vid ny position: status, avstånd och kartmarkörer – kartan ritas inte om.
  function refreshGps(full) {
    var el = document.getElementById('gps-box'), r = activeRound();
    if (!el || !r || view.tab !== 'round' || view.holeMode !== 'hole') return;
    var x = holeCtx(r), key = boxKeyFor(r, x);
    if (full || key !== gps.boxKey || !document.getElementById('gps-live')) {
      el.innerHTML = gpsInner(r); gps.boxKey = key; gps.lastRender = Date.now();
      updateMapDynamic(false); return;
    }
    var st = document.getElementById('gps-status'); if (st) st.innerHTML = gpsStatusHtml();
    var lv = document.getElementById('gps-live'); if (lv && x.hole) lv.innerHTML = liveHtml(r, x);
    var dp = document.getElementById('gps-dist');
    if (dp && x.hole) {
      var prev = dp.querySelector('.mid b'), before = prev ? prev.textContent : null;
      dp.innerHTML = distHtml(r, x);
      var now = dp.querySelector('.mid b'); if (now && before !== null && now.textContent !== before) dp.querySelectorAll('b').forEach(function (b) { b.classList.add('tick'); });
    }
    updateMapDynamic(true);
    gps.lastRender = Date.now();
  }

  function boxKeyFor(r, x) {
    x = x || holeCtx(r);
    return r.id + ':' + r.current + ':' + (view.mapZoom || 'hole') + ':' + state.ui.mapOpen + ':' + !!x.fromTee + ':' + !!view.gregOpen + ':' + view.gregTap + ':' + gps.test + ':' + (gps.suggest === null ? '' : gps.suggest) + ':' + gpsState().replace(/good|weak|lost/, 'on') + ':' + state.ui.wakeLock + ':' + gps.mv.follow + ':' + !!gps.pos;
  }
  // ---------- Karta ----------
  function mapSvg(hole, gc) {
    var W = 360, H = 470, padL = 22, padR = 62, padT = 48, padB = 122, P = G.proj(gc), mode = view.mapZoom || 'hole', pts = [];
    function add(poly) { poly.forEach(function (p) { pts.push(P.xy(p)); }); }
    var tee = teePoint(hole), cxy = P.xy(gc);
    if (mode === 'green') {
      if (hole.green) add(hole.green);
      [[-40, -40], [40, 40], [-40, 40], [40, -40]].forEach(function (o) { pts.push([cxy[0] + o[0], cxy[1] + o[1]]); });
    } else {
      add(hole.line); if (hole.green) add(hole.green);
      hole.hazards.forEach(function (z) { add(z.poly); }); (hole.tees || []).forEach(add);
    }
    var base = P.xy(tee), dv = [cxy[0] - base[0], cxy[1] - base[1]], dl = Math.sqrt(dv[0] * dv[0] + dv[1] * dv[1]);
    if (dl < 1) { base = P.xy(hole.line[0]); dv = [cxy[0] - base[0], cxy[1] - base[1]]; dl = Math.sqrt(dv[0] * dv[0] + dv[1] * dv[1]) || 1; }
    var u = [dv[0] / dl, dv[1] / dl];
    function rot(q) { return [q[0] * u[1] - q[1] * u[0], q[0] * u[0] + q[1] * u[1]]; }
    var rp = pts.map(rot), xs = rp.map(function (q) { return q[0]; }), ys = rp.map(function (q) { return q[1]; });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs), minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    var s = Math.min((W - padL - padR) / Math.max(20, maxX - minX), (H - padT - padB) / Math.max(20, maxY - minY), 8);
    var ox = (padL + W - padR) / 2 - s * (minX + maxX) / 2, oy = (padT + H - padB) / 2 + s * (minY + maxY) / 2;
    function toSvg(ll) { var r = rot(P.xy(ll)); return [s * r[0] + ox, -s * r[1] + oy]; }
    function fromSvg(sp) { var r0 = (sp[0] - ox) / s, r1 = -(sp[1] - oy) / s; return P.ll([u[1] * r0 + u[0] * r1, -u[0] * r0 + u[1] * r1]); }
    mapCtx = { toSvg: toSvg, fromSvg: fromSvg, W: W, H: H, s: s, hole: hole, gc: gc, gcSvg: toSvg(gc) };
    var mvKey = hole.ref + ':' + mode;
    if (gps.mv.key !== mvKey) { gps.mv.key = mvKey; if (!gps.mv.follow) { gps.mv.k = 1; gps.mv.tx = 0; gps.mv.ty = 0; } }
    function path(poly) { return 'M' + poly.map(function (p) { var q = toSvg(p); return q[0].toFixed(1) + ' ' + q[1].toFixed(1); }).join('L') + 'Z'; }
    function line(a, b, cls) { var p = toSvg(a), q = toSvg(b); return '<line x1="' + p[0].toFixed(1) + '" y1="' + p[1].toFixed(1) + '" x2="' + q[0].toFixed(1) + '" y2="' + q[1].toFixed(1) + '" class="' + cls + '"/>'; }
    var sat = state.ui.sat && !satFailed && navigator.onLine !== false;
    var out = '<svg class="holemap' + (sat ? ' sat' : '') + (gps.test ? ' testmode' : '') + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(t('hole')) + ' ' + hole.ref + '"><rect width="' + W + '" height="' + H + '" class="m-bg"/>';
    out += '<g id="m-view" style="transform-origin:0 0;transform:translate(' + gps.mv.tx + 'px,' + gps.mv.ty + 'px) scale(' + gps.mv.k + ')">';
    if (sat) {
      // Plattor täcker ett större område än hålet så att kartan kan följa och panoreras.
      var corners = [[-W, -H], [2 * W, -H], [-W, 2 * H], [2 * W, 2 * H]].map(fromSvg);
      var lats = corners.map(function (q) { return q[0]; }), lons = corners.map(function (q) { return q[1]; });
      var z = Math.max(14, Math.min(19, Math.round(Math.log(156543.03 * Math.cos(gc[0] * Math.PI / 180) * s * 2) / Math.LN2))), x0, x1, y0, y1;
      for (; z >= 14; z--) {
        x0 = Math.floor(G.lon2tile(Math.min.apply(null, lons), z)); x1 = Math.floor(G.lon2tile(Math.max.apply(null, lons), z));
        y0 = Math.floor(G.lat2tile(Math.max.apply(null, lats), z)); y1 = Math.floor(G.lat2tile(Math.min.apply(null, lats), z));
        if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 64) break;
      }
      for (var tx = x0; tx <= x1; tx++) for (var ty = y0; ty <= y1; ty++) {
        var nw = toSvg([G.tile2lat(ty, z), G.tile2lon(tx, z)]), ne = toSvg([G.tile2lat(ty, z), G.tile2lon(tx + 1, z)]), sw = toSvg([G.tile2lat(ty + 1, z), G.tile2lon(tx, z)]);
        out += '<image href="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/' + z + '/' + ty + '/' + tx + '" width="1.004" height="1.004" preserveAspectRatio="none" transform="matrix(' +
          [ne[0] - nw[0], ne[1] - nw[1], sw[0] - nw[0], sw[1] - nw[1], nw[0], nw[1]].map(function (v) { return v.toFixed(2); }).join(' ') + ')"/>';
      }
    }
    (hole.fairways || []).forEach(function (p) { out += '<path d="' + path(p) + '" class="m-fair"/>'; });
    (hole.tees || []).forEach(function (p) { out += '<path d="' + path(p) + '" class="m-tee"/>'; });
    hole.hazards.forEach(function (z2) { out += '<path d="' + path(z2.poly) + '" class="m-' + z2.kind + '"/>'; });
    if (hole.green) out += '<path d="' + path(hole.green) + '" class="m-green"/>';
    for (var i = 0; i < hole.line.length - 1; i++) out += line(hole.line[i], hole.line[i + 1], 'm-cl');
    var ug = userGreen(hole);
    ['front', 'mid', 'back'].forEach(function (k) {
      if (!ug[k]) return; var q = toSvg(ug[k]);
      out += '<g class="m-up" transform="translate(' + q[0].toFixed(1) + ' ' + q[1].toFixed(1) + ')"><circle r="7"/><text y="4">' + esc(t('regAbbr_' + k)) + '</text></g>';
    });
    var fp = toSvg(gc);
    out += '<g class="m-flag" transform="translate(' + fp[0].toFixed(1) + ' ' + fp[1].toFixed(1) + ')"><path d="M0 0V-22"/><path d="M0-22L12-17 0-12Z"/><circle r="2.5"/></g>';
    // Dynamiska element (uppdateras vid varje position utan att kartan ritas om)
    out += '<line id="m-l1" class="m-shot" style="display:none"/><line id="m-l2" class="m-shot" style="display:none"/>' +
      '<g id="m-c1" class="mchip" style="display:none"><rect height="26" rx="13"/><text></text></g><g id="m-c2" class="mchip" style="display:none"><rect height="26" rx="13"/><text></text></g>' +
      '<g id="m-tgt" class="m-target" style="display:none"><circle r="10"/><path d="M-15 0H15M0-15V15"/></g>' +
      '<circle id="m-acc" class="m-acc" style="display:none"/><circle id="m-me" class="m-me' + (gps.test ? ' sim' : '') + '" r="8" style="display:none"/>';
    out += '</g><text x="' + (W - 6) + '" y="' + (H - 7) + '" class="m-attr">© OpenStreetMap' + (sat ? ' · Esri, Maxar' : '') + '</text>' +
      (gps.test ? '<text x="8" y="20" class="m-simlbl">' + esc(t('gpsTestBadge')) + '</text>' : '') + '</svg>';
    return out;
  }
  function setAttrs(el, a) { Object.keys(a).forEach(function (k) { el.setAttribute(k, a[k]); }); }
  function show(el, on) { if (el) el.style.display = on ? '' : 'none'; }
  function followTransform(me) {
    var P = mapCtx.toSvg(me), G0 = mapCtx.gcSvg, d = Math.sqrt(Math.pow(P[0] - G0[0], 2) + Math.pow(P[1] - G0[1], 2));
    var k = Math.max(1, Math.min(5, (mapCtx.H * 0.4) / Math.max(1, d)));
    return { k: k, tx: (mapCtx.W - 40) / 2 - k * P[0], ty: mapCtx.H * 0.68 - k * P[1] };
  }
  function applyMapTransform(anim) {
    var g = document.getElementById('m-view'); if (!g) return;
    g.style.transition = anim ? 'transform .7s ease-out' : 'none';
    g.style.transform = 'translate(' + gps.mv.tx.toFixed(1) + 'px,' + gps.mv.ty.toFixed(1) + 'px) scale(' + gps.mv.k.toFixed(3) + ')';
  }
  function updateMapDynamic(anim) {
    if (!mapCtx || !document.getElementById('m-view')) return;
    var r = activeRound(); if (!r) return;
    var x = holeCtx(r); if (!x.hole) return;
    var k = gps.mv.k, inv = 1 / k, from = x.from, gc = greenInfo(x.hole, from).center, tgt = gps.target || gc;
    var me = document.getElementById('m-me'), acc = document.getElementById('m-acc');
    var showMe = !!gps.pos && !x.fromTee;
    if (showMe) {
      var P = mapCtx.toSvg(x.me);
      setAttrs(me, { cx: P[0].toFixed(1), cy: P[1].toFixed(1), r: (8 * inv).toFixed(2), 'stroke-width': (3 * inv).toFixed(2) });
      setAttrs(acc, { cx: P[0].toFixed(1), cy: P[1].toFixed(1), r: Math.max(4 * inv, gps.pos.acc * mapCtx.s).toFixed(1) });
      me.classList.toggle('stale', gpsQ() === 'lost');
    }
    show(me, showMe); show(acc, showMe);
    var a = mapCtx.toSvg(from), b = mapCtx.toSvg(tgt), c2 = mapCtx.toSvg(gc), l1 = document.getElementById('m-l1'), l2 = document.getElementById('m-l2');
    setAttrs(l1, { x1: a[0].toFixed(1), y1: a[1].toFixed(1), x2: b[0].toFixed(1), y2: b[1].toFixed(1), 'stroke-width': (2.5 * inv).toFixed(2) });
    show(l1, true);
    var hasT = !!gps.target;
    if (hasT) setAttrs(l2, { x1: b[0].toFixed(1), y1: b[1].toFixed(1), x2: c2[0].toFixed(1), y2: c2[1].toFixed(1), 'stroke-width': (2.5 * inv).toFixed(2) });
    show(l2, hasT);
    var tg = document.getElementById('m-tgt');
    if (hasT) tg.setAttribute('transform', 'translate(' + b[0].toFixed(1) + ' ' + b[1].toFixed(1) + ') scale(' + inv.toFixed(3) + ')');
    show(tg, hasT);
    function chip(id, p1, p2, txt) {
      var el = document.getElementById(id); if (!el) return;
      var w = 12 + txt.length * 9, cx = (p1[0] + p2[0]) / 2, cy = (p1[1] + p2[1]) / 2;
      el.setAttribute('transform', 'translate(' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ') scale(' + inv.toFixed(3) + ')');
      setAttrs(el.querySelector('rect'), { x: -w / 2, y: -13, width: w });
      setAttrs(el.querySelector('text'), { x: 0, y: 6 }); el.querySelector('text').textContent = txt;
      show(el, true);
    }
    chip('m-c1', a, b, Math.round(G.dist(from, tgt)) + ' m');
    if (hasT) chip('m-c2', b, c2, Math.round(G.dist(tgt, gc)) + ' m'); else show(document.getElementById('m-c2'), false);
    if (gps.mv.follow && showMe) { var ft = followTransform(x.me); gps.mv.k = ft.k; gps.mv.tx = ft.tx; gps.mv.ty = ft.ty; applyMapTransform(anim); }
  }

  // Panorering, nypzoom och tryck på kartan.
  var mapPtr = { pts: {}, start: null, moved: false };
  function svgUnits(svg) { var rc = svg.getBoundingClientRect(); return mapCtx ? mapCtx.W / rc.width : 1; }
  function onMapDown(e) {
    var svg = e.target.closest && e.target.closest('svg.holemap'); if (!svg || !mapCtx) return;
    try { svg.setPointerCapture(e.pointerId); } catch (er) {}
    mapPtr.pts[e.pointerId] = [e.clientX, e.clientY];
    var ids = Object.keys(mapPtr.pts);
    mapPtr.start = { k: gps.mv.k, tx: gps.mv.tx, ty: gps.mv.ty, pts: JSON.parse(JSON.stringify(mapPtr.pts)), svg: svg };
    if (ids.length === 1) mapPtr.moved = false;
  }
  function onMapMove(e) {
    if (!mapPtr.start || !mapPtr.pts[e.pointerId]) return;
    mapPtr.pts[e.pointerId] = [e.clientX, e.clientY];
    var st = mapPtr.start, f = svgUnits(st.svg), ids = Object.keys(mapPtr.pts);
    if (ids.length >= 2 && Object.keys(st.pts).length >= 2) {
      var a0 = st.pts[ids[0]], b0 = st.pts[ids[1]], a1 = mapPtr.pts[ids[0]], b1 = mapPtr.pts[ids[1]];
      if (!a0 || !b0) return;
      var d0 = Math.hypot(a0[0] - b0[0], a0[1] - b0[1]) || 1, d1 = Math.hypot(a1[0] - b1[0], a1[1] - b1[1]);
      var k = Math.max(0.6, Math.min(8, st.k * d1 / d0));
      var rc = st.svg.getBoundingClientRect(), mx = (((a0[0] + b0[0]) / 2) - rc.left) * f, my = (((a0[1] + b0[1]) / 2) - rc.top) * f;
      var nx = (((a1[0] + b1[0]) / 2) - rc.left) * f, ny = (((a1[1] + b1[1]) / 2) - rc.top) * f;
      var wx = (mx - st.tx) / st.k, wy = (my - st.ty) / st.k;
      gps.mv.k = k; gps.mv.tx = nx - k * wx; gps.mv.ty = ny - k * wy;
      mapPtr.moved = true;
    } else {
      var p0 = st.pts[e.pointerId]; if (!p0) return;
      var dx = e.clientX - p0[0], dy = e.clientY - p0[1];
      if (!mapPtr.moved && Math.hypot(dx, dy) < 7) return;
      mapPtr.moved = true;
      gps.mv.tx = st.tx + dx * f; gps.mv.ty = st.ty + dy * f;
    }
    if (gps.mv.follow) { gps.mv.follow = false; var fb = document.querySelector('[data-act="map-follow"]'); if (fb) fb.classList.remove('on'); }
    applyMapTransform(false); updateMapDynamic(false);
  }
  function onMapUp(e) {
    if (!mapPtr.start || !mapPtr.pts[e.pointerId]) return;
    var svg = mapPtr.start.svg, wasMoved = mapPtr.moved, single = Object.keys(mapPtr.pts).length === 1;
    delete mapPtr.pts[e.pointerId];
    if (Object.keys(mapPtr.pts).length) { mapPtr.start = { k: gps.mv.k, tx: gps.mv.tx, ty: gps.mv.ty, pts: JSON.parse(JSON.stringify(mapPtr.pts)), svg: svg }; return; }
    mapPtr.start = null;
    if (wasMoved || !single || e.type === 'pointercancel') return;
    var rc = svg.getBoundingClientRect(), f = mapCtx.W / rc.width;
    var vx = (e.clientX - rc.left) * f, vy = (e.clientY - rc.top) * f;
    var ll = mapCtx.fromSvg([(vx - gps.mv.tx) / gps.mv.k, (vy - gps.mv.ty) / gps.mv.k]);
    mapTap(ll);
  }
  function mapTap(ll) {
    var r = activeRound(); if (!r) return;
    if (view.gregTap) { saveGreenPoint(view.gregTap, ll, 'map'); view.gregTap = null; refreshGps(true); return; }
    if (gps.test) { gps.simOffset += 15000; ingest({ lat: ll[0], lon: ll[1], acc: 4, ts: gpsNow() }); return; }
    gps.target = ll; refreshGps();
  }
  function saveGreenPoint(k, ll, src) {
    var r = activeRound(), x = r && holeCtx(r); if (!x || !x.hole) return;
    x.hole.userGreen = x.hole.userGreen || {};
    x.hole.userGreen[k] = [Math.round(ll[0] * 1e7) / 1e7, Math.round(ll[1] * 1e7) / 1e7];
    x.hole.userGreen.src = src; x.hole.userGreen.at = new Date().toISOString();
    save(); view.flash = t('regDone');
  }
  // Testläge: förflyttning relativt hålets spelriktning.
  function testMove(fwd, right) {
    var r = activeRound(), x = r && holeCtx(r); if (!x || !x.hole) return;
    var startP = gps.pos ? [gps.pos.lat, gps.pos.lon] : teePoint(x.hole);
    var brg = G.bearing(teePoint(x.hole), greenCenter(x.hole));
    var np = G.offsetPoint(startP, brg, fwd, right);
    gps.simOffset += 15000;
    ingest({ lat: np[0], lon: np[1], acc: 4, ts: gpsNow(), speed: 1.4 });
  }

  // ---------- Hämta banor från OpenStreetMap ----------
  // Flera öppna Overpass-servrar: om en är upptagen provas nästa.
  var OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
  var NET = window.Net;
  // HTTP med tidsgräns. Fel får status, Retry-After och tydlig typ så att de kan klassas.
  function timedFetch(url, opts, ms) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, timedOut = false;
    var tm = setTimeout(function () { timedOut = true; if (ctl) ctl.abort(); }, ms);
    if (ctl) opts.signal = ctl.signal;
    return fetch(url, opts).then(function (r) {
      clearTimeout(tm);
      if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; var ra = parseFloat(r.headers.get('Retry-After')); if (isFinite(ra)) e.retryAfter = ra; throw e; }
      return r.json().then(function (j) {
        // Overpass kan svara 200 men med ett körfel (t.ex. tidsgräns) i "remark".
        if (j && typeof j.remark === 'string' && /runtime error|timed out|out of memory|too busy/i.test(j.remark)) { var se = new Error(j.remark); se.kind = 'server'; throw se; }
        return j;
      }, function () { var pe = new Error('Ogiltigt svar'); pe.kind = 'server'; throw pe; });
    }, function (e) { clearTimeout(tm); if (timedOut) { var te = new Error('timeout'); te.name = 'AbortError'; throw te; } throw e; });
  }
  var OP = NET.createOverpass({
    servers: OVERPASS,
    request: function (url, q, ms) { return timedFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) }, ms); },
    sleep: function (ms) { return new Promise(function (res) { setTimeout(res, ms); }); },
    online: function () { return navigator.onLine !== false; },
    rand: Math.random
  });
  function overpass(q, i, ms, opts) { return OP.query(q, Object.assign({ ms: ms || 25000 }, opts || {})); }
  var geoCache = NET.createGeoCache({ get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { localStorage.setItem(k, v); } }, 'banboken:geo-cache', 12);
  // Felmeddelanden som skiljer på nätverk, tidsgräns, serverfel och överbelastning.
  function errText(e) {
    var kind = NET.classify(e, navigator.onLine !== false);
    var m = kind === 'network' ? t('errNetwork') : kind === 'timeout' ? t('errTimeout') : kind === 'rate' ? t('errRate')
      : kind === 'server' ? fmt(t('errServer'), { s: e && e.status ? 'HTTP ' + e.status : t('serverErrShort') }) : kind === 'client' ? fmt(t('errClient'), { s: e && e.status ? e.status : '' }) : t('netError');
    return m + previewSuffix();
  }
  function netDetail(e) {
    var m = e && e.message ? String(e.message) : '';
    if (e && e.name === 'AbortError') m = t('timedOut');
    else if (/failed to fetch|load failed|networkerror/i.test(m)) m = t('noConnection');
    return m ? ' (' + m + ')' : '';
  }
  function previewSuffix() { return /github\.io$|^localhost$/.test(location.hostname) ? '' : ' ' + t('previewNote'); }
  function findError() {
    view.find.status = 'error';
    view.find.msg = t('netError') + (/github\.io$|^localhost$/.test(location.hostname) ? '' : ' ' + t('previewNote'));
    render();
  }
  function findNearby() {
    view.find = Object.assign(view.find, { status: 'loading', msg: t('findLoading'), results: [] }); render();
    getPos(function (lat, lon) {
      var q = '[out:json][timeout:25];(way[leisure=golf_course](around:30000,' + lat + ',' + lon + ');relation[leisure=golf_course](around:30000,' + lat + ',' + lon + '););out tags bb;';
      overpass(q).then(function (j) {
        view.find.results = (j.elements || []).map(function (e) {
          var b = e.bounds || {}, c = [(b.minlat + b.maxlat) / 2, (b.minlon + b.maxlon) / 2];
          return { name: (e.tags && e.tags.name) || t('noName'), osmType: e.type, osmId: e.id, lat: c[0], lon: c[1], bounds: [b.minlat, b.minlon, b.maxlat, b.maxlon], km: G.dist([lat, lon], c) / 1000 };
        }).filter(function (x) { return isFinite(x.lat); }).sort(function (a, b) { return a.km - b.km; }).slice(0, 25);
        view.find.status = 'done'; render();
      }).catch(findError);
    }, function () { view.find.status = 'idle'; render(); });
  }
  function searchCourses(q) {
    if (!q || q.trim().length < 2) return;
    view.find = Object.assign(view.find, { status: 'loading', msg: t('findLoading'), results: [] }); render();
    var qq = /golf/i.test(q) ? q : q + ' golf';
    timedFetch('https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=se&limit=15&q=' + encodeURIComponent(qq), { headers: { 'Accept-Language': state.profile.lang } }, 20000).then(function (list) {
      view.find.results = (list || []).filter(function (x) { return x.type === 'golf_course' && (x.osm_type === 'way' || x.osm_type === 'relation'); }).map(function (x) {
        var bb = x.boundingbox.map(parseFloat);
        return { name: x.name || x.display_name.split(',')[0], sub: x.display_name.split(',').slice(1, 3).join(','), osmType: x.osm_type, osmId: x.osm_id, lat: +x.lat, lon: +x.lon, bounds: [bb[0], bb[2], bb[1], bb[3]] };
      });
      view.find.status = 'done'; render();
    }).catch(findError);
  }
  // Hämtar banans kartdata: en liten, avgränsad fråga; cache i 14 dagar; sparad data används om servern inte svarar.
  function fetchCourseGeo(res, opts) {
    opts = opts || {};
    var ref = { type: res.osmType, id: res.osmId }, key = ref.type + '/' + ref.id;
    var meta = { osmRef: key, name: res.name, boundary: key }, cached = geoCache.get(key);
    if (cached && !opts.force && Date.now() - new Date(cached.at).getTime() < 14 * 86400000) {
      cached.geo.fromCache = true; cached.geo.cachedAt = cached.at; return Promise.resolve(cached.geo);
    }
    var bp = res.bounds && res.bounds.every(isFinite) ? Promise.resolve(res.bounds)
      : overpass(G.boundsQuery(ref), 0, 15000, { maxAttempts: 3 }).then(function (j) {
          var el = (j.elements || [])[0], b = el && el.bounds;
          if (!b) { var de = new Error(t('courseNotFound')); de.kind = 'data'; throw de; }
          return [b.minlat, b.minlon, b.maxlat, b.maxlon];
        });
    return bp.then(function (b) {
      return overpass(G.courseQuery(ref, b, 25), 0, 30000, { maxAttempts: 4, onAttempt: opts.onAttempt });
    }).then(function (j) {
      var geo = G.buildFromOsm(j, meta);
      geoCache.put(key, geo, new Date().toISOString());
      return geo;
    }, function (e) {
      if (cached) { cached.geo.fromCache = true; cached.geo.cachedAt = cached.at; cached.geo.staleCache = true; return cached.geo; }
      throw e;
    });
  }
  // Tee utan påhittade värden: par och index lämnas tomma tills de fylls i från scorekortet.
  function manualTee() {
    var te = blankTee(); te.unrated = true; te.name = t('defaultTee');
    te.holes.forEach(function (h) { h.par = null; h.si = null; });
    return te;
  }
  // Tee från kartdata: bara värden som finns i kartdatan; saknade par/index lämnas tomma (fylls i från scorekortet).
  function teeFromGeo(geo) {
    var n = Object.keys(geo.holes || {}).length === 9 ? 9 : 18, te = { id: uid(), name: t('defaultTee'), cr: null, slope: null, unrated: true, holes: [] }, want = [];
    for (var i = 1; i <= n; i++) {
      var h = geo.holes[String(i)];
      te.holes.push({ par: h && h.par >= 3 && h.par <= 6 ? h.par : null, si: null, length: null }); want.push(i);
    }
    var sis = te.holes.map(function (_, k) { var h = geo.holes[String(k + 1)]; return h && h.si; });
    if (sis.slice().sort(function (a, b) { return a - b; }).join() === want.join()) sis.forEach(function (s2, k) { te.holes[k].si = s2; });
    return te;
  }
  function pickOsm(i) {
    var res = view.find.results[i]; if (!res) return;
    view.find.status = 'loading'; view.find.msg = t('geoLoading'); render();
    fetchCourseGeo(res).then(function (geo) {
      if (geo.loops && geo.loops.length > 1) {
        view.loopPick = { geo: geo, clubName: res.clubName || res.name, clubKey: res.clubKey || null, lat: +res.lat.toFixed(5), lon: +res.lon.toFixed(5), osm: { type: res.osmType, id: res.osmId, bounds: res.bounds }, from: 'dir' };
        view.tab = 'courses'; view.sub = 'loops'; view.find = { status: 'idle', results: [] }; window.scrollTo(0, 0); render(); return;
      }
      if (view.find.link && view.draft) {
        view.draft.geo = geo; view.draft.osm = { type: res.osmType, id: res.osmId, bounds: res.bounds };
        if (view.draft.lat === null || view.draft.lat === undefined) { view.draft.lat = +res.lat.toFixed(5); view.draft.lon = +res.lon.toFixed(5); }
        if (view.draft.isNew && !view.draft.tees[0].cr) view.draft.tees[0] = teeFromGeo(geo);
      } else {
        var ex = state.courses.filter(function (c) { return c.geo && c.geo.osmRef === geo.osmRef && !c.loopIds; })[0];
        if (ex) { view.draft = JSON.parse(JSON.stringify(ex)); view.draft.geo = geo; }
        else view.draft = { isNew: true, id: uid(), name: res.fullName || res.name, club: res.clubName && res.fullName ? res.clubName : '', clubKey: res.clubKey || null, courseLabel: res.fullName ? res.label : null,
          lat: +res.lat.toFixed(5), lon: +res.lon.toFixed(5), verified: false, geo: geo, osm: { type: res.osmType, id: res.osmId, bounds: res.bounds }, tees: [teeFromGeo(geo)] };
      }
      view.sub = 'edit'; view.dirLink = false; view.errors = []; view.flash = t('geoLinked'); view.find = { status: 'idle', results: [] }; window.scrollTo(0, 0); render();
    }).catch(findError);
  }
  function boundsOfGeo(geo) {
    var la = [], lo = [];
    Object.keys(geo.holes).forEach(function (k) { geo.holes[k].line.forEach(function (p) { la.push(p[0]); lo.push(p[1]); }); });
    return la.length ? [Math.min.apply(null, la), Math.min.apply(null, lo), Math.max.apply(null, la), Math.max.apply(null, lo)] : null;
  }

  function viewFind() {
    var f = view.find, h = header(t('findCourses'), 'back-find') + '<main class="page">';
    h += '<button class="btn gold big" data-act="find-near">' + esc(t('nearMe')) + '</button>';
    h += '<div class="searchrow"><input data-field="find.q" value="' + esc(f.q || '') + '" placeholder="' + esc(t('searchPh')) + '" enterkeyhint="search"><button class="btn ghost" data-act="find-search">' + esc(t('search')) + '</button></div>';
    if (f.status === 'loading') h += '<p class="muted loading">' + esc(f.msg) + '</p>';
    if (f.status === 'error') h += '<p class="warn">' + esc(f.msg) + '</p>';
    if (f.status === 'done' && !f.results.length) h += '<p class="muted">' + esc(t('noResults')) + '</p>';
    if (f.results && f.results.length && f.status !== 'loading') {
      h += '<section class="block">' + f.results.map(function (x, i) {
        return '<button class="row" data-act="pick-osm:' + i + '"><span class="row-main"><strong>' + esc(x.name) + '</strong><small>' + esc(x.km !== undefined ? dec(x.km) + ' ' + t('kmAway') : (x.sub || '')) + '</small></span><span class="chev">›</span></button>';
      }).join('') + '</section>';
    }
    h += '<p class="note">' + esc(t('osmNote')) + '</p>';
    return h + '</main>';
  }

  function geoSection(c) {
    var h = '<section class="block geo-sec"><h3>' + esc(t('gpsData')) + '</h3>';
    if (!c.geo) {
      return h + '<p class="note">' + esc(t('noGeoEdit')) + '</p><button class="btn gold" data-act="link-geo">' + esc(t('fetchOsm')) + '</button></section>';
    }
    var cov = G.coverage(c.geo);
    h += '<p>' + esc(t('coverageTxt').replace('{h}', cov.holes).replace('{g}', cov.greens).replace('{z}', cov.hazards)) + '</p>';
    h += '<div class="covgrid">';
    for (var i = 1; i <= 18; i++) h += '<span class="cv ' + cov.list[i] + '">' + i + '</span>';
    h += '</div><p class="legend"><span class="cv full"></span>' + esc(t('legendFull')) + ' <span class="cv line"></span>' + esc(t('legendLine')) + ' <span class="cv none"></span>' + esc(t('legendNone')) + '</p>';
    if (c.geo.source === 'demo') return h + '<p class="warn">' + esc(t('demoWarning')) + '</p></section>';
    h += '<p class="note">' + esc(t('osmNote')) + (c.geo.fetchedAt ? ' ' + esc(t('fetched')) + ' ' + esc(fmtDate(c.geo.fetchedAt)) + '.' : '') + '</p>';
    if (c.geo.duplicates) h += '<p class="warn">' + esc(t('dupHoles')) + '</p>';
    h += '<div class="holenav"><button class="btn ghost" data-act="update-geo">' + esc(t('updateOsm')) + '</button><button class="btn ghost" data-act="remove-geo">' + esc(t('removeGeo')) + '</button></div>';
    return h + '</section>';
  }

  // ======================= ETAPP 3: SPELARE, LAG OCH MATCHER =======================
  var GM = window.Games;
  var TYPES_OWN = ['stroke', 'stableford', 'match', 'bestball', 'worstball', 'nassau', 'skins'];
  var TYPES_TEAM = ['teamStroke', 'teamMatch'];
  var TEAM_MODES = ['scramble2', 'scramble3', 'scramble4', 'texas', 'greensome', 'foursome'];
  var TEAM_IDS = ['A', 'B', 'C', 'D', 'E', 'F'];

  function meName(r) { return (r && r.meName) || state.profile.name || t('me'); }
  function playersOf(r) { return [{ id: 'me', name: meName(r), hi: r.hi, tee: r.tee, holes: r.holes }].concat(r.extra || []); }
  function gameCtx(r) { return { players: playersOf(r), teams: r.teams || [], teamHoles: r.teamHoles || {}, teamMode: r.teamMode }; }
  function isGroup(r) { return !!((r.extra && r.extra.length) || (r.games && r.games.length) || r.mode === 'team'); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function signed(v) { return C.formatSigned(v); }
  function phTxt(v) { return v < 0 ? '+' + (-v) : String(v); }

  // --- Uppsättning av spelare, lag och spel ---
  function setupTeams() {
    var s = view.setup, ids = ['me'].concat((s.extra || []).map(function (p) { return p.id; }));
    return TEAM_IDS.map(function (tid) {
      var m = ids.filter(function (pid) { return (s.teamOf || {})[pid] === tid; });
      return m.length ? { id: tid, name: t('team') + ' ' + tid, members: m } : null;
    }).filter(Boolean);
  }
  function setupPlayers(c, te) {
    var s = view.setup;
    return [{ id: 'me', name: state.profile.name || t('me'), hi: state.profile.hi, tee: resolvedTee(te, playerGender(), s.holesMode || '18'), holes: [] }].concat((s.extra || []).map(function (p) {
      var pt = c.tees.filter(function (x) { return x.id === p.teeId; })[0] || te;
      return { id: p.id, name: p.name, hi: p.hi, tee: resolvedTee(pt, p.gender || playerGender(), '18'), holes: [] };
    }));
  }
  function sideSize(id, teams) { var tm = teams.filter(function (x) { return x.id === id; })[0]; return tm ? tm.members.length : 1; }
  function resolveGame(type, cfg, teams) {
    var g = { id: uid(), type: type };
    if (type === 'match' || type === 'nassau') {
      g.sides = [cfg.sideA, cfg.sideB];
      var four = sideSize(cfg.sideA, teams) > 1 || sideSize(cfg.sideB, teams) > 1;
      g.allowance = cfg.allowance === 'auto' || cfg.allowance === undefined ? (four ? GM.DEFAULTS.matchFourball : GM.DEFAULTS.matchSingles) : +cfg.allowance;
    } else if (type === 'bestball' || type === 'worstball') {
      g.teams = teams.filter(function (x) { return x.members.length === 2; }).map(function (x) { return x.id; });
      if (!g.teams.length) g.teams = teams.map(function (x) { return x.id; });
      g.scoring = cfg.scoring || (type === 'worstball' ? 'stableford' : 'stroke');
      g.allowance = cfg.allowance === 'auto' || cfg.allowance === undefined ? GM.DEFAULTS[type] : +cfg.allowance;
    } else if (type === 'teamStroke' || type === 'teamMatch') {
      g.teams = teams.map(function (x) { return x.id; });
    } else {
      g.allowance = cfg.allowance === 'auto' || cfg.allowance === undefined ? GM.DEFAULTS[type] : +cfg.allowance;
      if (type === 'skins') g.carryover = cfg.carryover !== false;
    }
    return g;
  }
  function setupGames(teams) {
    var s = view.setup, list = s.mode === 'team' ? TYPES_TEAM : TYPES_OWN;
    return list.filter(function (ty) { return s.games[ty] && s.games[ty].on; }).map(function (ty) { return resolveGame(ty, s.games[ty], teams); });
  }
  function setupErrors(c, te) {
    var s = view.setup, teams = setupTeams(), players = setupPlayers(c, te), errs = [];
    var ctx = { players: players, teams: teams, teamMode: s.teamMode };
    var games = setupGames(teams);
    games.forEach(function (g) { var e = GM.validate(g, ctx); if (e) errs.push({ type: g.type, code: e }); });
    if (games.length && players.some(function (p) { return !C.teeRated(p.tee); })) errs.push({ type: null, code: 'unrated' });
    if ((s.holesMode || '18') !== '18' && (s.extra || []).length) errs.push({ type: null, code: 'nineSolo' });
    if (s.mode === 'team') {
      if (!games.length) errs.push({ type: null, code: 'needGame' });
      if (players.some(function (p) { return !(s.teamOf || {})[p.id]; })) errs.push({ type: null, code: 'allInTeam' });
    }
    return errs;
  }

  function setupGroupHtml(c, te) {
    var s = view.setup, h = '';
    s.extra = s.extra || []; s.games = s.games || {}; s.teamOf = s.teamOf || {}; s.add = s.add || {};
    h += '<section class="block"><h3>' + esc(t('players')) + '</h3>';
    h += '<div class="pl"><span class="pl-n"><b>' + esc(state.profile.name || t('me')) + '</b><small>' + esc(t('handicapIndex')) + ' ' + esc(C.formatHandicap(state.profile.hi)) + ' · ' + esc(te.name) + '</small></span></div>';
    s.extra.forEach(function (p, i) {
      h += '<div class="pl"><span class="pl-n"><b>' + esc(p.name) + '</b><small>' + esc(t('handicapIndex')) + ' ' + esc(C.formatHandicap(p.hi)) + '</small></span><button class="chip" data-act="xdel:' + i + '" aria-label="' + esc(t('remove')) + ' ' + esc(p.name) + '">✕</button></div>';
      if (c.tees.length > 1) h += '<div class="seg small">' + c.tees.map(function (x) { return '<button class="' + ((p.teeId || te.id) === x.id ? 'on' : '') + '" data-act="xtee:' + i + ':' + x.id + '">' + esc(x.name) + '</button>'; }).join('') + '</div>';
      h += '<div class="seg small">' + ['men', 'women'].map(function (g) { return '<button class="' + ((p.gender || playerGender() || 'men') === g ? 'on' : '') + '" data-act="xg:' + i + ':' + g + '">' + esc(genderName(g)) + '</button>'; }).join('') + '</div>';
    });
    if (s.extra.length < 7) {
      var fr = (state.friends || []).filter(function (f) { return !s.extra.some(function (p) { return p.name === f.name; }); });
      if (fr.length) h += '<p class="mini">' + esc(t('friends')) + '</p><div class="chips">' + fr.map(function (f) { return '<button class="chip" data-act="xfriend:' + f.id + '">+ ' + esc(f.name) + ' (' + esc(C.formatHandicap(f.hi)) + ')</button>'; }).join('') + '</div>';
      h += '<div class="addp"><input data-field="add.name" placeholder="' + esc(t('name')) + '" value="' + esc(s.add.name || '') + '"><input data-field="add.hi" inputmode="decimal" placeholder="' + esc(t('hcpShort')) + '" value="' + esc(s.add.hi || '') + '"><button class="btn ghost" data-act="xadd">' + esc(t('add')) + '</button></div>';
      if (s.addErr) h += '<p class="fail">' + esc(s.addErr) + '</p>';
      h += '<div class="addp bycode"><input data-field="add.code" placeholder="' + esc(t('codePh')) + '" value="' + esc(s.add.code || '') + '" autocapitalize="off" autocorrect="off"><button class="btn ghost" data-act="xcode">' + esc(t('addCode')) + '</button></div>';
    }
    h += '</section>';
    if (!s.extra.length) return h;

    // Spelsätt
    h += '<section class="block"><h3>' + esc(t('playMode')) + '</h3><div class="seg"><button class="' + (s.mode !== 'team' ? 'on' : '') + '" data-act="smode:own">' + esc(t('ownBall')) + '</button><button class="' + (s.mode === 'team' ? 'on' : '') + '" data-act="smode:team">' + esc(t('teamBall')) + '</button></div>';
    if (s.mode === 'team') {
      h += '<div class="choices two-col">' + TEAM_MODES.map(function (m) { return '<button class="choice' + (s.teamMode === m ? ' on' : '') + '" data-act="stmode:' + m + '"><strong>' + esc(t('tm_' + m)) + '</strong><small>' + GM.TEAM_PCT[m].join(' / ') + ' %</small></button>'; }).join('') + '</div>';
      h += '<p class="note">' + esc(t('rule_' + s.teamMode)) + '</p>';
    }
    h += '</section>';

    // Lag
    var n = s.extra.length + 1, ids = TEAM_IDS.slice(0, Math.min(6, Math.max(2, n)));
    h += '<section class="block"><h3>' + esc(t('teams')) + '</h3><p class="note">' + esc(t(s.mode === 'team' ? 'teamsHelpTeam' : 'teamsHelp')) + '</p>';
    [{ id: 'me', name: state.profile.name || t('me') }].concat(s.extra).forEach(function (p) {
      h += '<div class="tmrow"><span>' + esc(p.name) + '</span><div class="seg small">' + ['–'].concat(ids).map(function (x) {
        var cur = s.teamOf[p.id] || '–';
        return '<button class="' + (cur === x ? 'on' : '') + '" data-act="tm:' + p.id + ':' + x + '">' + x + '</button>';
      }).join('') + '</div></div>';
    });
    h += '</section>';

    // Spel
    ['match', 'nassau'].forEach(function (gt) {
      var gc = s.games[gt];
      if (gc && gc.on && !gc.sideA && s.extra.length) { var tms0 = setupTeams(); gc.sideA = tms0.length >= 2 ? tms0[0].id : 'me'; gc.sideB = tms0.length >= 2 ? tms0[1].id : s.extra[0].id; }
    });
    var teams = setupTeams(), errs = setupErrors(c, te), list = s.mode === 'team' ? TYPES_TEAM : TYPES_OWN;
    var sideOpts = [{ id: 'me', name: state.profile.name || t('me') }].concat(s.extra).map(function (p) { return { id: p.id, name: p.name }; })
      .concat(teams.filter(function (x) { return x.members.length <= 2; }).map(function (x) { return { id: x.id, name: x.name }; }));
    h += '<section class="block"><h3>' + esc(t('games')) + '</h3><p class="note">' + esc(t('gamesHelp')) + '</p>';
    list.forEach(function (ty) {
      var g = s.games[ty] || {}, on = !!g.on;
      h += '<div class="game' + (on ? ' on' : '') + '"><button class="game-t" data-act="gtog:' + ty + '" aria-pressed="' + on + '"><span class="box">' + (on ? '✓' : '') + '</span><span><b>' + esc(t('g_' + ty)) + '</b><small>' + esc(t('gd_' + ty)) + '</small></span></button>';
      if (on) {
        h += '<div class="game-c">';
        if (ty === 'match' || ty === 'nassau') {
          h += '<div class="two">' + ['sideA', 'sideB'].map(function (k, j) {
            return '<label class="field"><span>' + esc(t('side')) + ' ' + (j + 1) + '</span><select data-field="gside:' + ty + ':' + k + '">' + sideOpts.map(function (o) { return '<option value="' + esc(o.id) + '"' + (g[k] === o.id ? ' selected' : '') + '>' + esc(o.name) + '</option>'; }).join('') + '</select></label>';
          }).join('') + '</div>';
        }
        if (ty === 'bestball' || ty === 'worstball') {
          var sc = g.scoring || (ty === 'worstball' ? 'stableford' : 'stroke');
          h += '<div class="seg small"><button class="' + (sc === 'stroke' ? 'on' : '') + '" data-act="gsc:' + ty + ':stroke">' + esc(t('strokePlay')) + '</button><button class="' + (sc === 'stableford' ? 'on' : '') + '" data-act="gsc:' + ty + ':stableford">' + esc(t('stableford')) + '</button></div>';
        }
        if (ty === 'skins') h += '<label class="check"><input type="checkbox" data-field="gcarry:skins"' + (g.carryover !== false ? ' checked' : '') + '> <span>' + esc(t('carryover')) + '</span></label>';
        if (ty !== 'teamStroke' && ty !== 'teamMatch') {
          var al = g.allowance === undefined ? 'auto' : String(g.allowance);
          var autoV = String(resolveGame(ty, Object.assign({}, g, { allowance: 'auto' }), teams).allowance);
          h += '<p class="mini">' + esc(t('allowance')) + '</p><div class="seg small">' + ['auto', '100', '95', '90', '85'].filter(function (x) { return x !== autoV; }).map(function (x) {
            var lbl = x === 'auto' ? t('wfsStd') + ' ' + resolveGame(ty, Object.assign({}, g, { allowance: 'auto' }), teams).allowance + ' %' : x + ' %';
            return '<button class="' + (al === x ? 'on' : '') + '" data-act="gal:' + ty + ':' + x + '">' + esc(lbl) + '</button>';
          }).join('') + '</div>';
        } else if (s.teamMode) {
          h += '<p class="note">' + esc(t('teamHcpNote')) + ' ' + GM.TEAM_PCT[s.teamMode].join(' / ') + ' %</p>';
        }
        h += '<p class="note">' + esc(t('rule_' + ty)) + '</p>';
        errs.filter(function (e) { return e.type === ty; }).forEach(function (e) { h += '<p class="fail">' + esc(t('verr_' + e.code)) + '</p>'; });
        h += '</div>';
      }
      h += '</div>';
    });
    errs.filter(function (e) { return !e.type; }).forEach(function (e) { h += '<p class="fail">' + esc(t('verr_' + e.code)) + '</p>'; });
    h += '</section>';
    return h;
  }

  function beginGroup(r, c, te) {
    var s = view.setup;
    if (!s.extra || !s.extra.length) return;
    r.meName = state.profile.name || t('me');
    r.extra = s.extra.map(function (p) {
      var pt = c.tees.filter(function (x) { return x.id === p.teeId; })[0] || te;
      return { id: p.id, name: p.name, hi: p.hi, gender: p.gender || playerGender(), tee: resolvedTee(pt, p.gender || playerGender(), '18'), holes: pt.holes.map(function () { return {}; }) };
    });
    r.teams = setupTeams();
    r.mode = s.mode === 'team' ? 'team' : 'own';
    if (r.mode === 'team') {
      r.teamMode = s.teamMode; r.teamHoles = {};
      r.teams.forEach(function (tm) { r.teamHoles[tm.id] = te.holes.map(function () { return {}; }); });
    }
    r.games = setupGames(r.teams);
    state.friends = state.friends || [];
    s.extra.forEach(function (p) {
      var f = state.friends.filter(function (x) { return x.name.toLowerCase() === p.name.toLowerCase(); })[0];
      if (f) f.hi = p.hi; else state.friends.push({ id: uid(), name: p.name, hi: p.hi });
    });
  }

  // --- Inmatning för medspelare och lag ---
  function stepper(label, d, par, act, pickAct, sub) {
    var v = d.pickedUp ? '–' : typeof d.strokes === 'number' ? d.strokes : '';
    return '<div class="prow"><span class="pname">' + esc(label) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span>' +
      '<button class="pm" data-act="' + act + ':-1" aria-label="−1">−</button>' +
      '<button class="pv' + (v === '' ? ' empty' : '') + '" data-act="' + act + ':0" aria-label="' + esc(label) + '">' + (v === '' ? par : v) + '</button>' +
      '<button class="pm" data-act="' + act + ':1" aria-label="+1">+</button>' +
      '<button class="pk' + (d.pickedUp ? ' on' : '') + '" data-act="' + pickAct + '">' + esc(t('pickShort')) + '</button></div>';
  }
  function otherEntries(r) {
    var i = r.current, h = '<section class="entry others"><h3>' + esc(t('fellowPlayers')) + '</h3><p class="note">' + esc(t('stepHelp')) + '</p>';
    r.extra.forEach(function (p, k) { h += stepper(p.name, p.holes[i], p.tee.holes[i].par, 'ps:' + k, 'pp:' + k); });
    return h + '</section>';
  }
  function teamTee(r, tm) { var P = {}; playersOf(r).forEach(function (p) { P[p.id] = p; }); return (P[tm.members[0]] || { tee: r.tee }).tee; }
  function teamEntries(r) {
    var i = r.current, h = '<section class="entry others"><h3>' + esc(t('tm_' + r.teamMode)) + '</h3><p class="note">' + esc(t('stepHelp')) + '</p>';
    var names = {}; playersOf(r).forEach(function (p) { names[p.id] = p.name; });
    r.teams.forEach(function (tm) {
      h += stepper(tm.name, r.teamHoles[tm.id][i], teamTee(r, tm).holes[i].par, 'ts:' + tm.id, 'tp:' + tm.id, tm.members.map(function (m) { return names[m]; }).join(', '));
    });
    return h + '</section>';
  }
  function stepScore(d, par, delta) {
    if (d.pickedUp || typeof d.strokes !== 'number') { d.strokes = Math.max(1, par + delta); }
    else d.strokes = Math.max(1, Math.min(20, d.strokes + delta));
    d.pickedUp = false;
  }

  // --- Resultattexter ---
  function matchText(res) {
    if (res.error) return t('verr_' + res.error);
    var A = res.sides[0], B = res.sides[1];
    if (res.closed) {
      if (res.winner === 'halved') return t('halvedMatch');
      var w = res.winner === 'A' ? A : B;
      return w + ' ' + t('won') + ' ' + (res.result === Math.abs(res.up) + 'up' ? Math.abs(res.up) + ' ' + t('up') : res.result);
    }
    if (!res.thru) return t('notStarted');
    if (res.up === 0) return t('allSquare') + ' · ' + res.thru + ' ' + t('holesPlayed');
    return (res.up > 0 ? A : B) + ' ' + Math.abs(res.up) + ' ' + t('up') + (res.dormie ? ' (dormie)' : '') + ' · ' + res.remaining + ' ' + t('toPlay');
  }
  function part(res, k) { return Object.assign({ sides: res.sides }, res[k]); }
  function shortStatus(g, res) {
    if (res.error) return t('verr_' + res.error);
    if (g.type === 'match' || g.type === 'teamMatch') return matchText(res);
    if (g.type === 'nassau') return t('front9') + ': ' + matchText(part(res, 'front')) + ' · ' + t('back9') + ': ' + matchText(part(res, 'back'));
    if (g.type === 'skins') {
      var top = res.rows[0];
      return top && top.skins ? top.name + ' ' + top.skins + ' skins' + (res.carry ? ' · ' + res.carry + ' ' + t('inPot') : '') : res.carry ? res.carry + ' ' + t('inPot') : t('noSkinsYet');
    }
    var r0 = res.rows && res.rows[0];
    if (!r0 || !r0.thru) return t('notStarted');
    if (g.type === 'stableford' || ((g.type === 'bestball' || g.type === 'worstball') && res.scoring === 'stableford')) return r0.name + ' ' + r0.points + ' p';
    return r0.name + ' ' + signed(r0.netToPar) + ' ' + t('netShort');
  }
  function winnerText(g, res) {
    if (res.error) return null;
    if (g.type === 'match' || g.type === 'teamMatch') return res.closed ? matchText(res) : null;
    if (g.type === 'nassau') return res.total.closed && res.back.closed && res.front.closed ? [t('front9') + ': ' + matchText(part(res, 'front')), t('back9') + ': ' + matchText(part(res, 'back')), t('total') + ': ' + matchText(part(res, 'total'))].join(' · ') : null;
    if (!res.complete || !res.rows.length) return null;
    var a = res.rows[0], b = res.rows[1];
    var key = g.type === 'skins' ? 'skins' : (g.type === 'stableford' || res.scoring === 'stableford') ? 'points' : 'netToPar';
    if (key !== 'skins' && a.nr) return null;
    if (b && a[key] === b[key]) return t('tie') + ': ' + res.rows.filter(function (x) { return x[key] === a[key]; }).map(function (x) { return x.name; }).join(', ');
    return t('winner') + ': ' + a.name;
  }

  function gamesPanel(r) {
    var ctx = gameCtx(r), h = '<button class="gpanel" data-act="mode:board"><span class="gp-h">' + esc(t('competition')) + ' ›</span>';
    r.games.forEach(function (g) { h += '<span class="gp-l"><b>' + esc(t('g_' + g.type)) + '</b> ' + esc(shortStatus(g, GM.compute(g, ctx))) + '</span>'; });
    return h + '</button>';
  }

  function board(r, live) {
    var ctx = gameCtx(r), h = '';
    if (!r.games || !r.games.length) h += '<p class="muted">' + esc(t('noGames')) + '</p>';
    (r.games || []).forEach(function (g) {
      var res = GM.compute(g, ctx), win = winnerText(g, res);
      h += '<section class="block bd"><h3>' + esc(t('g_' + g.type)) + (g.allowance ? ' <small>' + g.allowance + ' %</small>' : '') + '</h3>';
      if (win) h += '<p class="winner">🏆 ' + esc(win) + '</p>';
      if (res.error) { h += '<p class="fail">' + esc(t('verr_' + res.error)) + '</p></section>'; return; }
      if (g.type === 'match' || g.type === 'teamMatch') h += matchBlock(res);
      else if (g.type === 'nassau') {
        h += '<dl class="nassau">' + [['front9', res.front], ['back9', res.back], ['total', res.total]].map(function (x) { return '<div><dt>' + esc(t(x[0])) + '</dt><dd>' + esc(matchText(Object.assign({ sides: res.sides }, x[1]))) + '</dd></div>'; }).join('') + '</dl>';
      } else if (g.type === 'skins') {
        h += table([t('player'), 'Skins'], res.rows.map(function (x) { return [x.name, x.skins]; }));
        if (res.carry) h += '<p class="note">' + res.carry + ' ' + esc(t('inPot')) + '</p>';
        if (res.holes.length) h += '<p class="note">' + res.holes.map(function (x) { return x.hole + ': ' + (x.winner ? playersOf(r).filter(function (p) { return p.id === x.winner; })[0].name + (x.pot > 1 ? ' (' + x.pot + ')' : '') : '–'); }).join(' · ') + '</p>';
      } else if (g.type === 'stableford' || ((g.type === 'bestball' || g.type === 'worstball') && res.scoring === 'stableford')) {
        h += table(['', g.type === 'stableford' ? t('player') : t('team'), t('thru'), t('points')], res.rows.map(function (x, k) { return [k + 1, x.name, x.thru, '<b>' + x.points + '</b>']; }), true);
      } else if (g.type === 'bestball' || g.type === 'worstball') {
        h += table(['', t('team'), t('thru'), t('net')], res.rows.map(function (x, k) { return [k + 1, x.name, x.thru, x.nr ? 'NR' : '<b>' + signed(x.netToPar) + '</b>']; }), true);
      } else {
        h += table(['', t('player'), t('thru'), t('gross'), t('net')], res.rows.map(function (x, k) {
          return [k + 1, x.name + ' <small>(' + phTxt(x.ph) + ')</small>', x.thru, x.nr ? 'NR' : signed(x.grossToPar) + ' <small>' + x.gross + '</small>', x.nr ? 'NR' : '<b>' + signed(x.netToPar) + '</b> <small>' + x.net + '</small>'];
        }), true);
      }
      h += '<details class="rule"><summary>' + esc(t('rules')) + '</summary><p>' + esc(t('rule_' + g.type)) + '</p></details></section>';
    });
    h += '<div class="holenav"><button class="btn ghost" data-act="share:' + r.id + '">' + esc(t('shareStanding')) + '</button></div><p class="note">' + esc(t('shareHelp')) + '</p>';
    if (live) h += '<button class="btn gold big" data-act="finish">' + esc(t('finishRound')) + '</button>';
    return h;
  }
  function table(head, rows, rawCells) {
    return '<div class="sc-wrap"><table class="lb"><thead><tr>' + head.map(function (x) { return '<th>' + esc(x) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr>' + r.map(function (c2, k) { return '<td>' + (rawCells && k > 0 && typeof c2 === 'string' && c2.indexOf('<') >= 0 ? c2 : esc(c2)) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
  }
  function matchBlock(res) {
    var h = '<p class="mstatus">' + esc(matchText(res)) + '</p>';
    h += '<div class="mstrip">';
    for (var i = 0; i < 18; i++) {
      var w = res.holes[i], c2 = w === undefined ? '' : w > 0 ? 'a' : w < 0 ? 'b' : 'h';
      h += '<span class="' + c2 + '">' + (i + 1) + '</span>';
    }
    h += '</div><p class="legend"><span class="ms a"></span>' + esc(res.sides[0]) + ' <span class="ms b"></span>' + esc(res.sides[1]) + ' <span class="ms h"></span>' + esc(t('halvedHole')) + '</p>';
    h += '<p class="note">' + esc(t('strokesRec')) + ': ' + res.strokes.map(function (x) { return x.name + ' ' + phTxt(x.ph); }).join(' · ') + '</p>';
    return h;
  }

  function groupCard(r) {
    var rows = r.mode === 'team'
      ? r.teams.map(function (tm) { return { name: tm.name, holes: r.teamHoles[tm.id], tee: teamTee(r, tm) }; })
      : playersOf(r).map(function (p) { return { name: p.name, holes: p.holes, tee: p.tee }; });
    function half(from, to, label) {
      var h = '<div class="sc-wrap"><table class="card"><tbody><tr class="hd"><th class="lbl">' + esc(t('hole')) + '</th>';
      for (var i = from; i < to; i++) h += '<th data-act="go-hole:' + i + '">' + (i + 1) + '</th>';
      h += '<th>' + esc(label) + '</th></tr><tr class="dim"><th class="lbl">' + esc(t('par')) + '</th>';
      var ps = 0; for (i = from; i < to; i++) { h += '<td>' + r.tee.holes[i].par + '</td>'; ps += r.tee.holes[i].par; }
      h += '<td>' + ps + '</td></tr>';
      rows.forEach(function (row) {
        var sum = 0; h += '<tr class="score"><th class="lbl">' + esc(row.name) + '</th>';
        for (var i = from; i < to; i++) {
          var d = row.holes[i] || {};
          if (d.pickedUp) { h += '<td class="sc pu">–</td>'; continue; }
          if (typeof d.strokes !== 'number') { h += '<td class="sc"></td>'; continue; }
          var diff = d.strokes - row.tee.holes[i].par; sum += d.strokes;
          h += '<td class="sc"><span class="' + (diff <= -2 ? 'eagle' : diff === -1 ? 'birdie' : diff === 1 ? 'bogey' : diff >= 2 ? 'dbl' : '') + '">' + d.strokes + '</span></td>';
        }
        h += '<td><b>' + sum + '</b></td></tr>';
      });
      return h + '</tbody></table></div>';
    }
    return '<h3 class="gc-h">' + esc(r.mode === 'team' ? t('teamCard') : t('groupCard')) + '</h3>' + half(0, 9, t('out')) + half(9, 18, t('in'));
  }

  function teamScorebar(r) {
    var ctx = gameCtx(r), my = (r.teams || []).filter(function (tm) { return tm.members.indexOf('me') >= 0; })[0] || r.teams[0];
    var res = GM.compute({ type: 'teamStroke', teams: [my.id] }, ctx), row = res.rows && res.rows[0];
    if (!row) return '';
    return '<div class="scorebar"><div><b>' + row.gross + '</b><small>' + esc(my.name) + '</small></div><div><b>' + (row.thru ? signed(row.grossToPar) : '–') + '</b><small>' + esc(t('toPar')) + '</small></div>' +
      '<div><b>' + (row.thru ? signed(row.netToPar) : '–') + '</b><small>' + esc(t('net')) + '</small></div><div><b>' + row.ph + '</b><small>' + esc(t('teamHcp')) + '</small></div></div>';
  }

  // --- Dela ställning (länk) och spelarkod ---
  function b64e(str) {
    var bytes = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64d(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
    var bin = atob(s), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function packHoles(hs) { return (hs || []).map(function (x) { return x.pickedUp ? -1 : typeof x.strokes === 'number' ? x.strokes : 0; }); }
  function unpackHoles(a) { return a.map(function (v) { return v === -1 ? { pickedUp: true } : v > 0 ? { strokes: v } : {}; }); }
  function packTee(te) { return { n: te.name, c: te.cr, s: te.slope, h: te.holes.map(function (x) { return [x.par, x.si]; }) }; }
  function unpackTee(o) { return { name: o.n, cr: o.c, slope: o.s, holes: o.h.map(function (x) { return { par: x[0], si: x[1], length: null }; }) }; }
  function packRound(r) {
    var mt = JSON.stringify(packTee(r.tee));
    var o = { v: 1, c: r.courseName, d: r.date, st: r.status, m: r.mode || 'own', a: r.allowance, me: { n: meName(r), h: r.hi, t: packTee(r.tee), s: packHoles(r.holes) },
      x: (r.extra || []).map(function (p) { var pt = packTee(p.tee); return { i: p.id, n: p.name, h: p.hi, t: JSON.stringify(pt) === mt ? 0 : pt, s: packHoles(p.holes) }; }),
      tg: r.teams || [], g: r.games || [] };
    if (r.mode === 'team') { o.tm = r.teamMode; o.th = {}; Object.keys(r.teamHoles).forEach(function (k) { o.th[k] = packHoles(r.teamHoles[k]); }); }
    return o;
  }
  function unpackRound(o) {
    if (!o || o.v !== 1 || !o.me) throw new Error('format');
    var tee = unpackTee(o.me.t), r = { id: uid(), shared: true, status: 'done', date: o.d, courseName: o.c, courseId: null, demo: false, mode: o.m, allowance: o.a || 100,
      meName: o.me.n, hi: o.me.h, tee: tee, holes: unpackHoles(o.me.s), current: 0, teams: o.tg || [], games: o.g || [], liveAtShare: o.st === 'active',
      extra: (o.x || []).map(function (p) { return { id: p.i, name: p.n, hi: p.h, tee: p.t ? unpackTee(p.t) : clone(tee), holes: unpackHoles(p.s) }; }) };
    if (o.m === 'team') { r.teamMode = o.tm; r.teamHoles = {}; Object.keys(o.th || {}).forEach(function (k) { r.teamHoles[k] = unpackHoles(o.th[k]); }); }
    return r;
  }
  function baseUrl() { return location.href.split('#')[0]; }
  function shareText(title, url) {
    if (navigator.share) { navigator.share({ title: title, url: url }).catch(function () {}); return; }
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { view.flash = t('linkCopied'); render(); }, function () { prompt(t('copyLink'), url); });
    else prompt(t('copyLink'), url);
  }
  function myCode() { return 'BB' + b64e(JSON.stringify({ n: state.profile.name, h: state.profile.hi, c: state.profile.homeClub || '' })); }
  function readCode(code) {
    code = String(code || '').replace(/\s+/g, '');
    if (code.indexOf('BB') !== 0) return null;
    try { var o = JSON.parse(b64d(code.slice(2))); if (!o.n || typeof o.h !== 'number') return null; return { name: String(o.n).slice(0, 40), hi: o.h }; } catch (e) { return null; }
  }
  function checkHash() {
    var hs = location.hash || '';
    if (hs.indexOf('#L') === 0) {
      try {
        var o = JSON.parse(b64d(hs.slice(2)));
        if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(o.u) || !SY.validCode(o.c) || typeof o.k !== 'string') throw new Error('bad');
        openViewer({ url: o.u, key: o.k }, o.c);
      } catch (e) { view.flash = t('badLink'); }
      return;
    }
    if (hs.indexOf('#m') !== 0 || hs.length < 10) return;
    try { view.shared = unpackRound(JSON.parse(b64d(hs.slice(2)))); view.tab = 'shared'; view.sub = null; }
    catch (e) { view.flash = t('badLink'); }
  }
  function clearHash() { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {} }
  function viewShared() {
    var r = view.shared, h = header(t('sharedTitle'), 'close-shared') + '<main class="page">';
    h += '<p class="meta">' + esc(r.courseName) + ' · ' + esc(fmtDate(r.date)) + (r.liveAtShare ? ' · ' + esc(t('sharedLive')) : '') + '</p>';
    h += board(r, false).replace(/<div class="holenav"><button class="btn ghost" data-act="share:[^"]*">[^<]*<\/button><\/div><p class="note">[^<]*<\/p>/, '');
    h += groupCard(r).replace(/ data-act="go-hole:\d+"/g, '');
    h += '<div class="holenav"><button class="btn ghost" data-act="close-shared">' + esc(t('close')) + '</button><button class="btn gold" data-act="save-shared">' + esc(t('saveHistory')) + '</button></div>';
    return h + '</main>';
  }

  function matchHistory(rounds) {
    var list = rounds.filter(function (r) { return r.games && r.games.length; });
    if (!list.length) return '';
    var h2h = {};
    list.forEach(function (r) {
      var ctx = gameCtx(r);
      r.games.forEach(function (g) {
        if (g.type !== 'match' || !g.sides) return;
        var teams = r.teams || [], ma = [g.sides[0]], mb = [g.sides[1]];
        teams.forEach(function (tm) { if (tm.id === g.sides[0]) ma = tm.members; if (tm.id === g.sides[1]) mb = tm.members; });
        var side = ma.indexOf('me') >= 0 ? 'A' : mb.indexOf('me') >= 0 ? 'B' : null;
        if (!side) return;
        var res = GM.compute(g, ctx); if (!res.closed) return;
        var opp = side === 'A' ? res.sides[1] : res.sides[0];
        h2h[opp] = h2h[opp] || { w: 0, l: 0, d: 0 };
        if (res.winner === 'halved') h2h[opp].d++; else if (res.winner === side) h2h[opp].w++; else h2h[opp].l++;
      });
    });
    var h = '<section class="block"><h3>' + esc(t('matchHistory')) + '</h3>';
    var keys = Object.keys(h2h);
    if (keys.length) h += table([t('opponent'), t('wins'), t('losses'), t('halvedShort')], keys.map(function (k) { return [k, h2h[k].w, h2h[k].l, h2h[k].d]; }));
    h += list.slice(0, 20).map(function (r) {
      var ctx = gameCtx(r);
      return '<button class="row" data-act="round:' + r.id + '"><span class="row-main"><strong>' + esc(r.courseName) + (r.shared ? ' <em class="tag">' + esc(t('sharedTag')) + '</em>' : '') + '</strong><small>' + esc(fmtDate(r.date)) + '</small>' +
        r.games.map(function (g) { var res = GM.compute(g, ctx); return '<small>' + esc(t('g_' + g.type)) + ': ' + esc(winnerText(g, res) || shortStatus(g, res)) + '</small>'; }).join('') + '</span><span class="chev">›</span></button>';
    }).join('');
    return h + '</section>';
  }

  // ======================= ETAPP 4: SLAGLOGG, STROKES GAINED, COACH, GOLFBAG =======================
  var ST = window.Stats;
  var SG_MIN_HOLES = 72;
  // Avslutade ronder ändras inte – deras beräkningar cachas per rondobjekt.
  var mCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function metricsOf(r) {
    if (!mCache || r.status !== 'done') return ST.roundMetrics(r);
    var m = mCache.get(r); if (!m) { m = ST.roundMetrics(r); mCache.set(r, m); }
    return m;
  }

  function fmtNum(k, v) {
    var abs = Math.abs(v), s2 = Number.isInteger(abs) ? String(abs) : dec(abs);
    if (k === 'd') return (v > 0 ? '+' : v < 0 ? '−' : '±') + s2;
    return (v < 0 ? '−' : '') + s2;
  }
  function fmt(str, p) { return String(str).replace(/\{(\w+)\}/g, function (_, k) { var v = p && p[k]; return v === undefined ? '' : typeof v === 'number' ? fmtNum(k, v) : v; }); }
  function tagData() { return '<em class="tag data">' + esc(t('tagData')) + '</em>'; }
  function tagEst() { return '<em class="tag est">' + esc(t('tagEst')) + '</em>'; }
  function ownDone(includeDemo) {
    return state.rounds.filter(function (r) { return r.status === 'done' && r.mode !== 'team' && !r.shared && (includeDemo || !r.demo); })
      .sort(function (a, b) { return b.date < a.date ? -1 : 1; });
  }
  function validHoleCount(rounds) { var n = 0; rounds.forEach(function (r) { r.holes.forEach(function (d) { if (ST.validShots(d)) n++; }); }); return n; }
  var baseCache = { key: null, base: null };
  function personalBaseline() {
    var rs = ownDone(false), key = rs.length + ':' + validHoleCount(rs) + ':' + (rs[0] ? rs[0].id : '');
    if (baseCache.key === key) return baseCache.base;
    var base = validHoleCount(rs) >= SG_MIN_HOLES ? ST.buildBaseline(ST.shotPoints(rs)) : null;
    baseCache = { key: key, base: base };
    return base;
  }
  function activeBaseline() {
    if (state.ui.sgBase === 'imported' && state.baseline) return state.baseline;
    return personalBaseline();
  }
  function learnedClubs() { return ST.clubStats(ownDone(true)); }

  // --- Slag för slag ---
  function shotDraft(r) {
    var d = r.holes[r.current], hole = r.tee.holes[r.current];
    if (!view.shot || view.shot.hole !== r.current || view.shot.round !== r.id) {
      var first = !d.shots || !d.shots.length;
      view.shot = { round: r.id, hole: r.current, lie: first ? 'tee' : 'fairway', dist: first && hole.length ? String(hole.length) : '', club: null, pen: 0 };
    }
    return view.shot;
  }
  function lieName(l) { return t('lie_' + l); }
  function shotLogger(r) {
    var d = r.holes[r.current], sd = shotDraft(r), shots = d.shots || [];
    var h = '<section class="entry shotlog"><h3>' + esc(t('shotByShot')) + '</h3>';
    if (shots.length) {
      h += '<ol class="shots">' + shots.map(function (s2, k) {
        var club = s2.club && (state.bag || []).filter(function (c) { return c.id === s2.club; })[0];
        return '<li><span>' + esc(lieName(s2.lie)) + ' · <b>' + esc(dec(s2.dist, s2.dist < 10 ? 1 : 0)) + ' m</b>' + (club ? ' · ' + esc(club.name) : '') + (s2.pen ? ' · <em class="pen">+' + s2.pen + ' ' + esc(t('penShort')) + '</em>' : '') + '</span>' +
          (k === shots.length - 1 && !d.holed ? '<button class="chip" data-act="shot-undo">' + esc(t('undo')) + '</button>' : '') + '</li>';
      }).join('') + '</ol>';
    }
    if (d.holed) {
      return h + '<p class="holed">' + esc(fmt(t('holedIn'), { n: ST.shotStrokes(d) })) + '</p><button class="chip" data-act="shot-undo">' + esc(t('undo')) + '</button></section>';
    }
    h += '<p class="mini">' + esc(fmt(t('shotN'), { n: shots.length + 1 })) + '</p><div class="pick lies">' + ST.LIES.map(function (l) {
      return '<button class="' + (sd.lie === l ? 'on' : '') + '" data-act="sl-lie:' + l + '">' + esc(lieName(l)) + '</button>';
    }).join('') + '</div>';
    var c = courseById(r.courseId), canGps = gps.pos && c && c.geo && c.geo.holes[String(holeNo(r, r.current))];
    h += '<div class="distrow"><label class="field"><span>' + esc(t('distLeft')) + '</span><input data-field="sd.dist" inputmode="decimal" value="' + esc(sd.dist) + '" placeholder="m"></label>' +
      '<button class="btn ghost" data-act="sl-gps"' + (canGps ? '' : ' disabled') + '>GPS</button></div>';
    if ((state.bag || []).length && sd.lie !== 'green') {
      h += '<div class="chips">' + state.bag.filter(function (cl) { return !cl.putter; }).map(function (cl) {
        return '<button class="chip' + (sd.club === cl.id ? ' on' : '') + '" data-act="sl-club:' + cl.id + '">' + esc(cl.name) + '</button>';
      }).join('') + '</div>';
    }
    h += '<div class="shotbtns"><button class="btn ghost" data-act="sl-pen">' + esc(t('addPen')) + (sd.pen ? ' (' + sd.pen + ')' : '') + '</button>' +
      '<button class="btn ghost" data-act="sl-add">' + esc(t('saveShot')) + '</button><button class="btn gold" data-act="sl-holed">' + esc(t('inHole')) + '</button></div>';
    if (view.shotErr) h += '<p class="fail">' + esc(view.shotErr) + '</p>';
    return h + '<p class="note">' + esc(t('shotHelp')) + '</p></section>';
  }
  function draftShot(sd) {
    var v = num(sd.dist);
    if (v === null || v < 0 || v > 700) return null;
    var s2 = { lie: sd.lie, dist: Math.round(v * 10) / 10 };
    if (sd.club && sd.lie !== 'green') s2.club = sd.club;
    if (sd.pen) s2.pen = sd.pen;
    return s2;
  }
  function syncFromShots(d) {
    d.strokes = ST.shotStrokes(d); d.pickedUp = false;
    d.putts = d.shots.filter(function (s2) { return s2.lie === 'green'; }).length;
  }

  // --- Coach ---
  var AREA = ['putting', 'shortgame', 'approach', 'driving', 'strategy'];
  function coachCard(r) {
    if (r.mode === 'team' || r.shared) return '';
    var hist = ownDone(!!r.demo).filter(function (x) { return x.id !== r.id && x.date < r.date && (!!x.demo === !!r.demo); });
    var m = metricsOf(r), base = activeBaseline(), sg = base ? ST.sgRound(r, base) : null;
    var c = ST.coach(m, hist.map(metricsOf), sg && sg.holes ? sg : null);
    var h = '<section class="block coach"><h3>' + esc(t('coachTitle')) + '</h3>';
    if (!c.enough) return h + '<p class="muted">' + esc(t('coachTooFew')) + '</p></section>';
    if (c.summary.area) {
      var parts = [];
      if (c.summary.gir !== null) parts.push(fmt(t('sumGir'), { v: c.summary.gir }));
      if (c.summary.putts !== null) parts.push(fmt(t('sumPutts'), { v: c.summary.putts }));
      h += '<p class="coach-sum">' + esc((parts.length ? parts.join(t('sumAnd')) + '. ' : '') + fmt(t('sumArea'), { a: t('area_' + c.summary.area) })) + ' ' + tagEst() + '</p>';
    }
    function list(title, items, tag) {
      if (!items.length) return '';
      return '<h4>' + esc(title) + '</h4><ul class="clist">' + items.map(function (it) { return '<li>' + esc(fmt(t('c_' + it.code), it.p)) + ' ' + tag + '</li>'; }).join('') + '</ul>';
    }
    h += list(t('coachGood'), c.strengths, tagData());
    h += list(t('coachLost'), c.losses.slice(0, 5), tagData());
    h += list(t('coachTrend'), c.trend, tagData());
    if (sg && sg.holes) h += sgBlock(sg, base);
    else h += '<p class="note">' + esc(t('sgNeedLog')) + '</p>';
    h += '<h4>' + esc(t('coachFocus')) + ' ' + tagEst() + '</h4><ol class="focus">' + c.focus.filter(function (f) { return f.score > 0; }).slice(0, 3).map(function (f) { return '<li>' + esc(t('area_' + f.area)) + '</li>'; }).join('') + '</ol>';
    h += '<h4>' + esc(t('coachRecs')) + '</h4><ol class="recs">' + c.recs.map(function (rc) { return '<li><b>' + esc(t('drillT_' + rc.drill)) + '</b><span>' + esc(t('drill_' + rc.drill)) + '</span></li>'; }).join('') + '</ol>';
    h += '<p class="note">' + esc(t(c.focusSource === 'sg' ? 'coachHowSg' : 'coachHow')) + '</p>';
    return h + '</section>';
  }
  function sgBlock(sg, base) {
    var h = '<h4>Strokes Gained <small>' + esc(base.name === 'personal' ? t('vsOwn') : fmt(t('vsImported'), { n: base.name })) + '</small></h4>';
    h += sgBars({ ott: sg.ott, app: sg.app, arg: sg.arg, putt: sg.putt, total: sg.total });
    h += '<p class="note">' + esc(fmt(t('sgHoles'), { n: sg.holes, s: sg.skipped })) + '</p>';
    return h;
  }
  function sgBars(v) {
    var max = Math.max(1, Math.abs(v.ott), Math.abs(v.app), Math.abs(v.arg), Math.abs(v.putt), Math.abs(v.total));
    return '<div class="sgbars">' + ['ott', 'app', 'arg', 'putt', 'total'].map(function (k) {
      var w = Math.abs(v[k]) / max * 50;
      return '<div class="sgrow' + (k === 'total' ? ' tot' : '') + '"><span class="sgl">' + esc(t('sg_' + k)) + '</span><span class="sgtrack"><i class="' + (v[k] >= 0 ? 'pos' : 'neg') + '" style="' + (v[k] >= 0 ? 'left:50%' : 'right:50%') + ';width:' + w.toFixed(1) + '%"></i></span><b>' + (v[k] > 0 ? '+' : '') + dec(v[k], 1) + '</b></div>';
    }).join('') + '</div>';
  }

  // --- Statistik över tid ---
  var METRICS = ['points', 'gross', 'putts', 'gir', 'fir', 'scr', 'pen', 'sg'];
  function metricValue(key, r, m, base) {
    var s = m.s;
    if (key === 'points') return s.points;
    if (key === 'gross') return s.complete && !s.pickedUp ? s.gross : null;
    if (key === 'putts') return s.puttHoles === s.played && s.played ? s.putts * 18 / s.played : null;
    if (key === 'gir') return s.girTot ? s.girHit / s.girTot * 100 : null;
    if (key === 'fir') return s.firTot ? s.firHit / s.firTot * 100 : null;
    if (key === 'scr') return m.scrAtt ? m.scrOk / m.scrAtt * 100 : null;
    if (key === 'pen') return s.penalties;
    if (key === 'sg') { if (!base) return null; var g = ST.sgRound(r, base); return g.holes >= 9 ? g.total * 18 / g.holes : null; }
    return null;
  }
  function lineChart(vals, ref) {
    var pts = vals.map(function (v, i) { return v === null ? null : [i, v]; }).filter(Boolean);
    if (pts.length < 2) return '<p class="muted">' + esc(t('noData')) + '</p>';
    var W = 320, H = 150, pad = 24, ys = pts.map(function (p) { return p[1]; }).concat(ref !== undefined ? [ref] : []);
    var min = Math.min.apply(null, ys), max = Math.max.apply(null, ys); if (max - min < 1) { max += 1; min -= 1; }
    var step = (W - 2 * pad) / Math.max(1, vals.length - 1);
    function y(v) { return H - pad - (v - min) / (max - min) * (H - 2 * pad); }
    var avgV = pts.reduce(function (a, p) { return a + p[1]; }, 0) / pts.length;
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img">' +
      '<line x1="' + pad + '" x2="' + (W - pad) + '" y1="' + y(avgV).toFixed(1) + '" y2="' + y(avgV).toFixed(1) + '" class="ref"/><text x="' + (W - pad) + '" y="' + (y(avgV) - 4).toFixed(1) + '" class="reflbl">' + esc(t('avgShort')) + ' ' + dec(avgV) + '</text>' +
      (ref !== undefined ? '<line x1="' + pad + '" x2="' + (W - pad) + '" y1="' + y(ref).toFixed(1) + '" y2="' + y(ref).toFixed(1) + '" class="ref zero"/>' : '') +
      '<polyline points="' + pts.map(function (p) { return (pad + p[0] * step).toFixed(1) + ',' + y(p[1]).toFixed(1); }).join(' ') + '" class="line"/>' +
      pts.map(function (p) { return '<circle cx="' + (pad + p[0] * step).toFixed(1) + '" cy="' + y(p[1]).toFixed(1) + '" r="3.5" class="pt"/>'; }).join('') +
      '<text x="' + pad + '" y="' + (H - 6) + '" class="reflbl start">' + esc(t('older')) + '</text><text x="' + (W - pad) + '" y="' + (H - 6) + '" class="reflbl">' + esc(t('newer')) + '</text></svg>';
  }
  function statsExtra(rounds, n) {
    var list = rounds.slice(0, n), ms = list.map(metricsOf), h = '';
    if (!ms.length) return '';
    var att = 0, ok = 0, three = 0, bird = 0, pt = { 3: [0, 0], 4: [0, 0], 5: [0, 0] };
    ms.forEach(function (m) { att += m.scrAtt; ok += m.scrOk; three += m.threePutts; bird += m.birdies; [3, 4, 5].forEach(function (p) { pt[p][0] += m.parType[p].toPar; pt[p][1] += m.parType[p].n; }); });
    h += '<dl class="kpis">' + kpi(t('scrPct'), att ? Math.round(ok / att * 100) + ' %' : '–') + kpi(t('threePerRound'), dec(three / ms.length)) + kpi(t('birdiesPerRound'), dec(bird / ms.length)) +
      [3, 4, 5].map(function (p) { return kpi(fmt(t('parAvg'), { p: p }), pt[p][1] ? (pt[p][0] / pt[p][1] >= 0 ? '+' : '') + dec(pt[p][0] / pt[p][1], 2) : '–'); }).join('') + '</dl>';
    var key = state.ui.trendMetric || 'points', base = key === 'sg' ? activeBaseline() : null;
    h += '<section class="block"><h3>' + esc(t('trend')) + '</h3><div class="chips">' + METRICS.map(function (k) { return '<button class="chip' + (key === k ? ' on' : '') + '" data-act="metric:' + k + '">' + esc(t('m_' + k)) + '</button>'; }).join('') + '</div>';
    h += lineChart(list.slice().reverse().map(function (r, i) { return metricValue(key, r, ms[list.length - 1 - i], base); }), key === 'sg' ? 0 : undefined) + '</section>';
    return h;
  }
  function sgSection(rounds) {
    var h = '<section class="block"><h3>Strokes Gained</h3>', haveImp = !!state.baseline;
    h += '<div class="seg small"><button class="' + (state.ui.sgBase !== 'imported' ? 'on' : '') + '" data-act="sgbase:personal">' + esc(t('vsOwnShort')) + '</button><button class="' + (state.ui.sgBase === 'imported' ? 'on' : '') + '" data-act="sgbase:imported"' + (haveImp ? '' : ' disabled') + '>' + esc(haveImp ? state.baseline.name : t('noImported')) + '</button></div>';
    var base = activeBaseline(), logged = validHoleCount(ownDone(false));
    if (!base) {
      h += '<p class="muted">' + esc(fmt(t('sgProgress'), { n: logged, m: SG_MIN_HOLES })) + '</p><div class="progress"><i style="width:' + Math.min(100, logged / SG_MIN_HOLES * 100).toFixed(0) + '%"></i></div>';
    } else {
      var per = rounds.slice(0, state.ui.statsN).map(function (r) { return ST.sgRound(r, base); }).filter(function (g) { return g.holes >= 9; });
      if (!per.length) h += '<p class="muted">' + esc(t('sgNoRounds')) + '</p>';
      else {
        var acc = { ott: 0, app: 0, arg: 0, putt: 0, total: 0 };
        per.forEach(function (g) { Object.keys(acc).forEach(function (k) { acc[k] += g[k] * 18 / g.holes / per.length; }); });
        h += '<p class="note">' + esc(fmt(t('sgPer18'), { n: per.length })) + '</p>' + sgBars(acc);
        h += '<p class="note">' + esc(base.name === 'personal' ? t('sgOwnExplain') : t('sgImpExplain')) + '</p>';
      }
    }
    h += '<details class="rule"><summary>' + esc(t('sgRefTitle')) + '</summary><p>' + esc(t('sgRefText')) + '</p></details>';
    h += '<div class="holenav"><label class="btn ghost file">' + esc(t('importBaseline')) + '<input type="file" accept="application/json,.json" data-field="baseline-import"></label>' +
      (haveImp ? '<button class="btn ghost" data-act="baseline-del">' + esc(t('removeBaseline')) + '</button>' : '') + '</div>';
    return h + '</section>';
  }

  // --- Min golfbag ---
  var STD_BAG = ['Driver', '3-trä', '5-trä', 'Hybrid', '5-järn', '6-järn', '7-järn', '8-järn', '9-järn', 'PW', 'GW', 'SW', 'LW', 'Putter'];
  function bagSection() {
    var bag = state.bag || [], learned = learnedClubs(), h = '<section class="block"><h3>' + esc(t('myBag')) + '</h3><p class="note">' + esc(t('bagHelp')) + '</p>';
    bag.forEach(function (c) {
      var L = learned[c.id];
      h += '<div class="bagrow"><input data-field="bag.' + c.id + '.name" value="' + esc(c.name) + '" aria-label="' + esc(t('club')) + '">' +
        (c.putter ? '<span class="muted">–</span>' : '<input data-field="bag.' + c.id + '.carry" inputmode="numeric" value="' + esc(c.carry || '') + '" placeholder="m" aria-label="' + esc(t('clubLen')) + '">') +
        '<button class="chip" data-act="bag-del:' + c.id + '" aria-label="' + esc(t('remove')) + '">✕</button>' +
        (L ? '<small class="learn">' + esc(fmt(t('learned'), { a: L.median, n: L.n, lo: L.min, hi: L.max })) + '</small>' : '') + '</div>';
    });
    h += '<div class="holenav"><button class="btn ghost" data-act="bag-add">' + esc(t('addClub')) + '</button>' + (bag.length ? '' : '<button class="btn ghost" data-act="bag-std">' + esc(t('stdBag')) + '</button>') + '</div>';
    return h + '</section>';
  }

  // ======================= ETAPP 5: MOLNSYNK OCH LIVEMATCHER (Supabase) =======================
  var SY = window.Sync, CLOUD_KEY = 'banboken:cloud';
  // Molnuppgifter och inloggning sparas separat och följer aldrig med i exporterade säkerhetskopior.
  function loadCloud() {
    try { var c = JSON.parse(localStorage.getItem(CLOUD_KEY) || 'null'); if (c && typeof c === 'object') { c.synced = c.synced || {}; return c; } } catch (e) {}
    return { url: '', key: '', session: null, synced: {}, lastPull: null, lastSync: null };
  }
  var cloud = loadCloud();
  function saveCloud() { try { localStorage.setItem(CLOUD_KEY, JSON.stringify(cloud)); } catch (e) {} }
  function cloudReady() { return !!(cloud.url && cloud.key); }
  function signedIn() { return !!(cloudReady() && cloud.session && cloud.session.refresh); }
  var syncState = { busy: false, err: null, timer: null, conflicts: 0 };
  var cloudForm = { email: '', code: '', sent: false, err: null, busy: false };

  function httpJson(url, opts, ms) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, tm = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 20000);
    if (ctl) opts.signal = ctl.signal;
    return fetch(url, opts).then(function (res) {
      clearTimeout(tm);
      return res.text().then(function (txt) {
        var data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
        if (!res.ok) { var err = new Error((data && (data.msg || data.message || data.error_description || data.error)) || ('HTTP ' + res.status)); err.status = res.status; throw err; }
        return data;
      });
    }, function (e) { clearTimeout(tm); throw e; });
  }
  function sbFetch(path, opts, auth) {
    opts = opts || {};
    function go() {
      var headers = Object.assign({ apikey: cloud.key, 'Content-Type': 'application/json', Authorization: 'Bearer ' + (auth ? cloud.session.access : cloud.key) }, opts.headers || {});
      return httpJson(cloud.url + path, { method: opts.method || 'GET', headers: headers, body: opts.body }, opts.ms);
    }
    if (!auth) return go();
    return ensureToken().then(go).catch(function (e) { if (e.status === 401) return refreshToken().then(go); throw e; });
  }
  function ensureToken() { return cloud.session && cloud.session.exp && Date.now() < cloud.session.exp - 60000 ? Promise.resolve() : refreshToken(); }
  function refreshToken() {
    if (!cloud.session) return Promise.reject(new Error(t('signedOut')));
    return sbFetch('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: cloud.session.refresh }) }, false)
      .then(setSession, function (e) { if (e.status === 400 || e.status === 401) { cloud.session = null; saveCloud(); } throw e; });
  }
  function setSession(d) {
    var old = cloud.session || {};
    cloud.session = { access: d.access_token, refresh: d.refresh_token, exp: Date.now() + (d.expires_in || 3600) * 1000,
      email: (d.user && d.user.email) || old.email, uid: (d.user && d.user.id) || old.uid };
    saveCloud();
  }
  function cleanUrl(u) { return String(u || '').trim().replace(/\/+$/, ''); }

  // ---------- Synk ----------
  function pullAll() {
    var since = cloud.lastPull || '1970-01-01T00:00:00Z', total = { changed: 0, conflicts: 0 };
    function page() {
      return sbFetch('/rest/v1/user_docs?select=kind,doc_id,data,deleted,updated_at&updated_at=gt.' + encodeURIComponent(since) + '&order=updated_at.asc&limit=200', {}, true).then(function (rows) {
        rows = Array.isArray(rows) ? rows : [];
        var r = SY.applyPull(state, cloud.synced, rows); total.changed += r.changed; total.conflicts += r.conflicts;
        if (rows.length) { since = rows[rows.length - 1].updated_at; cloud.lastPull = since; saveCloud(); }
        return rows.length === 200 ? page() : total;
      });
    }
    return page();
  }
  function pushAll() {
    var p = SY.computePush(SY.collectDocs(state), cloud.synced), uid = cloud.session.uid;
    var rows = p.upserts.map(function (u) { return { user_id: uid, kind: u.kind, doc_id: u.id, data: u.data, deleted: false }; })
      .concat(p.deletes.map(function (d) { return { user_id: uid, kind: d.kind, doc_id: d.id, data: null, deleted: true }; }));
    var chunks = []; for (var i = 0; i < rows.length; i += 25) chunks.push(rows.slice(i, i + 25));
    return chunks.reduce(function (pr, ch) {
      return pr.then(function () {
        return sbFetch('/rest/v1/user_docs?on_conflict=user_id,kind,doc_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(ch) }, true).then(function () {
          ch.forEach(function (row) { cloud.synced[row.kind + ':' + row.doc_id] = row.deleted ? 'deleted' : SY.hash(JSON.stringify(row.data)); });
          saveCloud();
        });
      });
    }, Promise.resolve());
  }
  function syncNow(manual) {
    if (!signedIn() || syncState.busy || navigator.onLine === false) return Promise.resolve();
    syncState.busy = true; syncState.err = null;
    if (manual) render();
    return pullAll().then(function (res) {
      syncState.conflicts = res.conflicts;
      if (res.changed) { applyRatings(); saveLocalOnly(); render(); }
      return pushAll();
    }).then(function () { cloud.lastSync = new Date().toISOString(); saveCloud(); })
      .catch(function (e) { syncState.err = e.message || String(e); })
      .then(function () { syncState.busy = false; if (manual || view.tab === 'profile') render(); });
  }
  function scheduleSync() {
    if (!signedIn()) return;
    clearTimeout(syncState.timer);
    syncState.timer = setTimeout(function () { syncNow(false); }, 4000);
  }

  function cloudSection() {
    var h = '<section class="block" id="cloud"><h3>' + esc(t('cloudTitle')) + '</h3>';
    if (!cloudReady()) {
      h += '<p class="note">' + esc(t('cloudSetupHelp')) + '</p>' +
        '<label class="field"><span>Project URL</span><input data-field="cloud.url" inputmode="url" autocapitalize="off" autocorrect="off" placeholder="https://xxxx.supabase.co" value="' + esc(cloudForm.url || '') + '"></label>' +
        '<label class="field"><span>' + esc(t('anonKey')) + '</span><input data-field="cloud.key" autocapitalize="off" autocorrect="off" value="' + esc(cloudForm.key || '') + '"></label>' +
        '<button class="btn gold" data-act="cloud-save">' + esc(t('save')) + '</button>';
    } else if (!signedIn()) {
      h += '<p class="note">' + esc(t('signInHelp')) + '</p><label class="field"><span>' + esc(t('email')) + '</span><input data-field="cloud.email" type="email" inputmode="email" autocapitalize="off" value="' + esc(cloudForm.email) + '"></label>' +
        '<button class="btn ' + (cloudForm.sent ? 'ghost' : 'gold') + '" data-act="cloud-otp"' + (cloudForm.busy ? ' disabled' : '') + '>' + esc(cloudForm.sent ? t('resendCode') : t('sendCode')) + '</button>';
      if (cloudForm.sent) h += '<label class="field"><span>' + esc(t('emailCode')) + '</span><input data-field="cloud.code" inputmode="numeric" autocomplete="one-time-code" value="' + esc(cloudForm.code) + '"></label><button class="btn gold" data-act="cloud-verify"' + (cloudForm.busy ? ' disabled' : '') + '>' + esc(t('signIn')) + '</button>';
      h += '<button class="link" data-act="cloud-forget">' + esc(t('changeProject')) + '</button>';
    } else {
      h += '<p>' + esc(t('signedInAs')) + ' <b>' + esc(cloud.session.email || '') + '</b></p>';
      h += '<p class="note">' + (syncState.busy ? esc(t('syncing')) : cloud.lastSync ? esc(t('lastSync')) + ' ' + esc(new Date(cloud.lastSync).toLocaleString(state.profile.lang === 'sv' ? 'sv-SE' : 'en-GB')) : esc(t('neverSynced'))) + '</p>';
      if (syncState.conflicts) h += '<p class="note">' + esc(fmt(t('syncConflicts'), { n: syncState.conflicts })) + '</p>';
      h += '<div class="holenav"><button class="btn ghost" data-act="cloud-sync"' + (syncState.busy ? ' disabled' : '') + '>' + esc(t('syncNow')) + '</button><button class="btn ghost" data-act="cloud-out">' + esc(t('signOut')) + '</button></div>';
    }
    var err = cloudForm.err || syncState.err;
    if (err) h += '<p class="fail" role="alert">' + esc(err) + '</p>';
    return h + '<p class="note">' + esc(t('cloudPrivacy')) + '</p></section>';
  }

  // ---------- Livematcher ----------
  var live = { ownerTimer: null, viewer: null, viewerTimer: null, lastPushed: null, err: null, at: null };
  function rpc(cfg, name, args, token) {
    return httpJson(cfg.url + '/rest/v1/rpc/' + name, { method: 'POST', headers: { apikey: cfg.key, Authorization: 'Bearer ' + (token || cfg.key), 'Content-Type': 'application/json' }, body: JSON.stringify(args) }, 15000);
  }
  function liveLink(code) { return baseUrl() + '#L' + b64e(JSON.stringify({ u: cloud.url, k: cloud.key, c: code })); }
  function startLive(r) {
    var code = SY.newCode();
    live.err = null;
    return sbFetch('/rest/v1/live_matches', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ code: code, data: packRound(r) }) }, true)
      .then(function () { r.live = { code: code }; live.lastPushed = null; save(); render(); }, function (e) { live.err = e.message; render(); });
  }
  function ownerTick() {
    var r = activeRound();
    if (!r || !r.live || !signedIn() || document.hidden || navigator.onLine === false) return;
    var packed = packRound(r), hsh = SY.hash(JSON.stringify(packed));
    var push = hsh === live.lastPushed ? Promise.resolve() :
      sbFetch('/rest/v1/live_matches?code=eq.' + r.live.code, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ data: packed }) }, true).then(function () { live.lastPushed = hsh; });
    push.then(function () { return ensureToken(); }).then(function () { return rpc(cloud, 'get_live_match', { p_code: r.live.code }, cloud.session.access); }).then(function (rows) {
      live.err = null; live.at = new Date();
      var row = rows && rows[0];
      if (row && SY.mergeLiveScores(r, row.scores)) { save(); render(); }
    }).catch(function (e) { live.err = e.message; });
  }
  function liveControls(r) {
    var h = '<section class="block live"><h3>' + esc(t('liveTitle')) + '</h3>';
    if (!cloudReady()) return h + '<p class="note">' + esc(t('liveNeedCloud')) + '</p><button class="chip" data-act="tab:profile">' + esc(t('navProfile')) + '</button></section>';
    if (!signedIn()) return h + '<p class="note">' + esc(t('liveNeedSignIn')) + '</p><button class="chip" data-act="tab:profile">' + esc(t('navProfile')) + '</button></section>';
    if (!r.live) return h + '<p class="note">' + esc(t('liveHelp')) + '</p><button class="btn gold" data-act="live-start">' + esc(t('liveStart')) + '</button>' + (live.err ? '<p class="fail">' + esc(live.err) + '</p>' : '') + '</section>';
    h += '<p class="livecode">' + esc(r.live.code) + '</p><p class="note">' + esc(t('liveOn')) + (live.at ? ' · ' + esc(t('updated')) + ' ' + live.at.toLocaleTimeString(state.profile.lang === 'sv' ? 'sv-SE' : 'en-GB') : '') + '</p>';
    h += '<button class="btn ghost" data-act="live-share">' + esc(t('liveShare')) + '</button>';
    if (live.err) h += '<p class="fail">' + esc(live.err) + '</p>';
    return h + '</section>';
  }

  function viewerTick() {
    var v = live.viewer; if (!v || document.hidden) return;
    rpc(v.cfg, 'get_live_match', { p_code: v.code }).then(function (rows) {
      var row = rows && rows[0];
      if (!row) { v.err = t('liveNotFound'); render(); return; }
      var r = unpackRound(row.data); r.id = 'live-' + v.code; r.shared = true;
      SY.mergeLiveScores(r, row.scores);
      if (v.pending) { var p = r.extra.filter(function (x) { return x.id === v.me; })[0]; if (p) p.holes = unpackHoles(v.pending); }
      v.round = r; v.err = null; v.at = new Date(); v.done = row.data.st === 'done';
      if (!editingNow()) render();
    }).catch(function (e) { v.err = e.message; render(); });
  }
  function editingNow() { var a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'SELECT'); }
  function viewLive() {
    var v = live.viewer, h = header(t('liveTitle'), 'live-close') + '<main class="page">';
    h += '<p class="meta">' + esc(t('liveCode')) + ' <b>' + esc(v.code) + '</b>' + (v.at ? ' · ' + esc(t('updated')) + ' ' + v.at.toLocaleTimeString(state.profile.lang === 'sv' ? 'sv-SE' : 'en-GB') : '') + '</p>';
    if (v.err) h += '<p class="warn">' + esc(v.err) + '</p>';
    var r = v.round;
    if (!r) return h + '<p class="muted">' + esc(t('liveLoading')) + '</p></main>';
    h += '<p class="meta">' + esc(r.courseName) + ' · ' + esc(fmtDate(r.date)) + (v.done ? ' · ' + esc(t('liveDone')) : '') + '</p>';
    if (r.mode !== 'team' && r.extra.length && !v.done) {
      h += '<section class="block"><h3>' + esc(t('livePlayAs')) + '</h3><div class="chips">' + r.extra.map(function (p) {
        return '<button class="chip' + (v.me === p.id ? ' on' : '') + '" data-act="live-me:' + p.id + '">' + esc(p.name) + '</button>';
      }).join('') + '</div>';
      var me = r.extra.filter(function (p) { return p.id === v.me; })[0];
      if (me) {
        var hi = v.hole || 0, d = me.holes[hi], par = me.tee.holes[hi].par;
        h += '<div class="dots">' + me.holes.map(function (dd, k) {
          var has = typeof dd.strokes === 'number' || dd.pickedUp;
          return '<button class="' + (k === hi ? 'cur ' : '') + (has ? 'done' : '') + '" data-act="live-hole:' + k + '">' + (k + 1) + '</button>';
        }).join('') + '</div>';
        h += '<section class="entry others">' + stepper(t('hole') + ' ' + (hi + 1) + ' · ' + t('par') + ' ' + par, d, par, 'lv', 'lvp') + '</section>';
        h += '<p class="note">' + esc(v.saving ? t('liveSaving') : v.pending ? t('liveUnsent') : t('liveSaved')) + '</p>';
      }
      h += '</section>';
    }
    h += board(r, false).replace(/<div class="holenav"><button class="btn ghost" data-act="share:[^"]*">[^<]*<\/button><\/div><p class="note">[^<]*<\/p>/, '');
    h += groupCard(r).replace(/ data-act="go-hole:\d+"/g, '');
    h += '<div class="holenav"><button class="btn ghost" data-act="live-close">' + esc(t('close')) + '</button>' + (v.done ? '<button class="btn gold" data-act="live-save">' + esc(t('saveHistory')) + '</button>' : '') + '</div>';
    return h + '</main>';
  }
  function viewerSend() {
    var v = live.viewer, p = v && v.round && v.round.extra.filter(function (x) { return x.id === v.me; })[0];
    if (!p) return;
    v.pending = packHoles(p.holes); v.saving = true; render();
    rpc(v.cfg, 'live_put_player', { p_code: v.code, p_player: v.me, p_holes: v.pending }).then(function () {
      v.pending = null; v.saving = false; v.err = null; render();
    }, function (e) { v.saving = false; v.err = t('liveSendFailed') + ' (' + e.message + ')'; render(); });
  }
  function openViewer(cfg, code) {
    live.viewer = { cfg: cfg, code: code, round: null, me: null, hole: 0, pending: null };
    view.tab = 'live'; view.sub = null;
    setTimeout(viewerTick, 0);
  }
  function manageTimers() {
    var r = activeRound();
    var wantOwner = !!(r && r.live && signedIn());
    if (wantOwner && !live.ownerTimer) { live.ownerTimer = setInterval(ownerTick, 10000); setTimeout(ownerTick, 500); }
    if (!wantOwner && live.ownerTimer) { clearInterval(live.ownerTimer); live.ownerTimer = null; }
    var wantViewer = view.tab === 'live' && !!live.viewer;
    if (wantViewer && !live.viewerTimer) live.viewerTimer = setInterval(viewerTick, 10000);
    if (!wantViewer && live.viewerTimer) { clearInterval(live.viewerTimer); live.viewerTimer = null; }
  }

  // ======================= ALLA BANOR I SVERIGE (banregister från OpenStreetMap) =======================
  var DIR_KEY = 'banboken:dir-se';
  function loadDir() { try { var d = JSON.parse(localStorage.getItem(DIR_KEY) || 'null'); return d && Array.isArray(d.items) ? d : null; } catch (e) { return null; } }
  var dir = loadDir(), dirState = { status: 'idle', msg: null, pos: null };
  function fetchDirectory() {
    dirState.status = 'loading'; dirState.msg = null; render();
    var q = '[out:json][timeout:120];area["ISO3166-1"="SE"][admin_level=2]->.se;(way[leisure=golf_course](area.se);relation[leisure=golf_course](area.se););out tags bb;';
    overpass(q, 0, 150000, { maxAttempts: 3 }).then(function (j) {
      var d = G.parseDirectory(j);
      if (!d.items.length) throw new Error(t('emptyResult'));
      dir = { fetchedAt: new Date().toISOString(), items: d.items, unnamed: d.unnamed };
      try { localStorage.setItem(DIR_KEY, JSON.stringify(dir)); } catch (e) {}
      dirState.status = 'done'; render();
    }).catch(function (e) {
      dirState.status = 'error';
      dirState.msg = t('dirFailed') + ' ' + errText(e);
      render();
    });
  }
  // Snabb hämtning av banor runt en position (mindre fråga än hela Sverige). Reserv: Nominatim.
  var near = { status: 'idle', items: null, msg: null, key: null };
  function fetchNearby(pos) {
    var key = pos[0].toFixed(2) + ',' + pos[1].toFixed(2);
    if (near.key === key && (near.status === 'loading' || near.status === 'done')) return;
    near = { status: 'loading', items: near.items, msg: null, key: key }; render();
    var q = '[out:json][timeout:40];(way[leisure=golf_course](around:60000,' + pos[0] + ',' + pos[1] + ');relation[leisure=golf_course](around:60000,' + pos[0] + ',' + pos[1] + '););out tags bb;';
    overpass(q, 0, 30000, { maxAttempts: 3 }).then(function (j) {
      near.items = G.parseDirectory(j).items; near.status = 'done'; render();
    }).catch(function (e) {
      var d = 0.6, vb = [pos[1] - d, pos[0] + d / 2, pos[1] + d, pos[0] - d / 2].join(',');
      timedFetch('https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=se&limit=40&bounded=1&viewbox=' + vb + '&q=golf', { headers: { 'Accept-Language': state.profile.lang } }, 20000).then(function (list) {
        near.items = (list || []).filter(function (x) { return x.type === 'golf_course' && (x.osm_type === 'way' || x.osm_type === 'relation'); }).map(function (x) {
          var bb = x.boundingbox.map(parseFloat);
          return { n: x.name || x.display_name.split(',')[0], t: x.osm_type, id: x.osm_id, lat: +x.lat, lon: +x.lon, b: [bb[0], bb[2], bb[1], bb[3]], c: (x.display_name.split(',')[2] || '').trim(), h: null };
        });
        near.status = 'done'; render();
      }).catch(function (e2) { near.status = 'error'; near.msg = t('nearFailed') + ' ' + errText(e2 || e); render(); });
    });
  }
  function addedRefs() { var m = {}; state.courses.forEach(function (c) { if (c.geo && c.geo.osmRef) m[c.geo.osmRef] = c.id; }); return m; }
  function dirListHtml() {
    if (!dir) return '';
    var res = G.searchClubs(dirClubs(), view.dirQ || '', dirState.pos, 60), added = addedRefs();
    if (!res.length) return '<p class="muted">' + esc(t('noResults')) + '</p>';
    return res.map(function (x) {
      var cl = x.club, dist0 = x.d !== null ? dec(x.d / 1000) + ' km' : '';
      if (cl.courses.length === 1) {
        var it = cl.courses[0].item, ref = it.t + '/' + it.id;
        return '<button class="row" data-act="dir-pick:' + it.t + ':' + it.id + '"><span class="row-main"><strong>' + esc(it.n) + '</strong>' + (added[ref] ? ' <em class="tag ok">' + esc(t('added')) + '</em>' : '') +
          '<small>' + esc([cl.c, dist0, it.h ? it.h + ' ' + t('holesShort') : ''].filter(Boolean).join(' · ')) + '</small></span><span class="chev">›</span></button>';
      }
      var open = view.dirOpen === cl.key;
      var h = '<button class="row club" data-act="dir-club:' + esc(cl.key) + '" aria-expanded="' + open + '"><span class="row-main"><strong>' + esc(cl.name) + '</strong><small>' +
        esc([cl.c, dist0, fmt(t('nCourses'), { n: cl.courses.length })].filter(Boolean).join(' · ')) + '</small></span><span class="chev">' + (open ? '⌄' : '›') + '</span></button>';
      if (open) h += '<div class="subcourses">' + cl.courses.map(function (e) {
        var ref2 = e.item.t + '/' + e.item.id;
        return '<button class="row sub" data-act="dir-pick:' + e.item.t + ':' + e.item.id + '"><span class="row-main"><strong>' + esc(e.label) + '</strong>' + (added[ref2] ? ' <em class="tag ok">' + esc(t('added')) + '</em>' : '') +
          '<small>' + esc(e.item.h ? e.item.h + ' ' + t('holesShort') : t('holesUnknown')) + '</small></span><span class="chev">›</span></button>';
      }).join('') + '</div>';
      return h;
    }).join('') + (res.length === 60 ? '<p class="note">' + esc(t('dirMore')) + '</p>' : '');
  }
  function viewDirectory() {
    var h = header(t('allSweden'), 'back-dir') + '<main class="page">';
    if (view.find && view.find.status === 'loading') h += '<p class="muted loading">' + esc(view.find.msg || t('geoLoading')) + '</p>';
    if (view.find && view.find.status === 'error') h += '<p class="warn">' + esc(view.find.msg) + '</p>';
    if (!dir) {
      h += '<p>' + esc(t('dirIntro')) + '</p>';
      h += '<button class="btn gold big" data-act="dir-load"' + (dirState.status === 'loading' ? ' disabled' : '') + '>' + esc(dirState.status === 'loading' ? t('dirLoading') : t('dirLoad')) + '</button>';
      if (dirState.status === 'error') h += '<p class="warn">' + esc(dirState.msg) + '</p>';
      return h + '<p class="note">' + esc(t('osmNote')) + '</p><button class="link" data-act="find">' + esc(t('dirOther')) + '</button></main>';
    }
    h += '<p class="meta">' + esc(fmt(t('dirCount'), { n: dir.items.length })) + ' · ' + esc(t('updated')) + ' ' + esc(fmtDate(dir.fetchedAt)) + '</p>';
    h += '<div class="searchrow"><input data-field="dir.q" value="' + esc(view.dirQ || '') + '" placeholder="' + esc(t('dirSearchPh')) + '" autocorrect="off" enterkeyhint="search"></div>';
    h += '<div class="chips"><button class="chip' + (dirState.pos ? ' on' : '') + '" data-act="dir-near">' + esc(dirState.pos ? t('nearestFirst') : t('sortNear')) + '</button>' +
      '<button class="chip" data-act="dir-load"' + (dirState.status === 'loading' ? ' disabled' : '') + '>' + esc(dirState.status === 'loading' ? t('dirLoading') : t('dirRefresh')) + '</button></div>';
    if (dirState.status === 'error') h += '<p class="warn">' + esc(dirState.msg) + '</p>';
    h += '<section class="block" id="dir-list">' + dirListHtml() + '</section>';
    h += '<p class="note">' + esc(t('dirRatingNote')) + '</p>';
    h += '<p class="note">' + esc(t('osmNote')) + (dir.unnamed ? ' ' + esc(fmt(t('dirUnnamed'), { n: dir.unnamed })) : '') + '</p>';
    h += '<button class="link" data-act="find">' + esc(t('dirOther')) + '</button>';
    return h + '</main>';
  }

  // ======================= NY STARTSIDA OCH "SPELA GOLF"-FLÖDE =======================
  function svgUri(svg) { return "url('data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg).replace(/'/g, '%27') + "')"; }
  // Egna illustrationer (inga foton från andra appar).
  var HERO_BG = svgUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice">' +
    '<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2E6F9E"/><stop offset=".55" stop-color="#9CC9DE"/><stop offset="1" stop-color="#E8E2C4"/></linearGradient>' +
    '<linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4E9A4A"/><stop offset="1" stop-color="#1F5A30"/></linearGradient></defs>' +
    '<rect width="400" height="300" fill="url(#s)"/><circle cx="320" cy="60" r="26" fill="#FFF6D8" opacity=".85"/>' +
    '<path d="M0 150 L60 105 L110 135 L170 85 L230 130 L290 95 L350 128 L400 110 V190 H0Z" fill="#6E8C9E" opacity=".75"/>' +
    '<path d="M0 175 Q100 140 200 165 T400 160 V300 H0Z" fill="#2F6B3A"/>' +
    '<path d="M-20 300 Q120 205 250 190 Q330 182 420 196 V300Z" fill="url(#f)"/>' +
    '<ellipse cx="282" cy="196" rx="44" ry="10" fill="#7CC67A"/><path d="M290 196 V160" stroke="#fff" stroke-width="2"/><path d="M290 160 L306 166 L290 172Z" fill="#D6B25E"/>' +
    '<ellipse cx="226" cy="214" rx="20" ry="5" fill="#EADBA8"/>' +
    '<g fill="#173F25"><circle cx="40" cy="168" r="14"/><circle cx="62" cy="160" r="18"/><circle cx="360" cy="172" r="16"/><circle cx="382" cy="164" r="12"/></g></svg>');
  var AERIAL_BG = svgUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" preserveAspectRatio="xMidYMid slice">' +
    '<rect width="400" height="400" fill="#1D4A2C"/><path d="M-40 420 C60 300 120 260 200 210 S340 90 440 -20" stroke="#3E8A4A" stroke-width="120" fill="none" stroke-linecap="round"/>' +
    '<ellipse cx="300" cy="105" rx="62" ry="44" fill="#5DB067"/><path d="M228 150 q-30 10 -40 40 q22 6 46 -10 q10 -18 -6 -30z" fill="#E9DDB3"/>' +
    '<path d="M330 40 q40 -6 58 22 q-24 18 -52 4z" fill="#E9DDB3"/><path d="M60 250 q30 -20 60 -6 q-10 28 -44 26 q-22 -4 -16 -20z" fill="#2E6FA8" opacity=".85"/>' +
    '<g fill="#143A21" opacity=".9"><circle cx="40" cy="60" r="26"/><circle cx="80" cy="30" r="20"/><circle cx="370" cy="300" r="30"/><circle cx="330" cy="350" r="22"/></g></svg>');
  var PLAY_ART = {
    standard: '<svg viewBox="0 0 260 190" aria-hidden="true"><rect x="40" y="18" width="180" height="156" rx="14" fill="#fff"/><rect x="40" y="18" width="180" height="34" rx="14" fill="#1B5E45"/><rect x="40" y="38" width="180" height="14" fill="#1B5E45"/>' +
      '<text x="58" y="40" font-size="13" font-weight="700" fill="#fff">SCOREKORT</text>' + [0, 1, 2, 3].map(function (i) { return '<rect x="56" y="' + (64 + i * 26) + '" width="90" height="10" rx="5" fill="#C9D5CE"/><circle cx="196" cy="' + (69 + i * 26) + '" r="10" fill="' + (i === 1 ? '#D6B25E' : '#2A7A5B') + '"/>'; }).join('') + '</svg>',
    match: '<svg viewBox="0 0 260 190" aria-hidden="true"><circle cx="80" cy="95" r="46" fill="#fff"/><circle cx="180" cy="95" r="46" fill="#fff"/>' +
      [[66, 82], [92, 80], [78, 104], [100, 106], [62, 108]].map(function (p) { return '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="4" fill="#C9D5CE"/>'; }).join('') +
      [[166, 82], [192, 80], [178, 104], [200, 106], [162, 108]].map(function (p) { return '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="4" fill="#C9D5CE"/>'; }).join('') +
      '<rect x="104" y="80" width="52" height="30" rx="15" fill="#D6B25E"/><text x="130" y="101" text-anchor="middle" font-size="16" font-weight="800" fill="#000">VS</text></svg>',
    team: '<svg viewBox="0 0 260 190" aria-hidden="true"><circle cx="130" cy="95" r="70" fill="#1B5E45"/>' + [[130, 62], [96, 112], [164, 112]].map(function (p) {
      return '<circle cx="' + p[0] + '" cy="' + (p[1] - 10) + '" r="14" fill="#fff"/><path d="M' + (p[0] - 20) + ' ' + (p[1] + 24) + ' q20 -30 40 0z" fill="#fff"/>'; }).join('') +
      '<circle cx="130" cy="95" r="70" fill="none" stroke="#D6B25E" stroke-width="4"/></svg>',
    training: '<svg viewBox="0 0 260 190" aria-hidden="true"><rect x="40" y="20" width="180" height="150" rx="14" fill="#fff"/>' +
      [[64, 60], [96, 90], [128, 44], [160, 76]].map(function (b) { return '<rect x="' + b[0] + '" y="' + b[1] + '" width="22" height="' + (150 - b[1]) + '" rx="4" fill="#2A7A5B"/>'; }).join('') +
      '<path d="M60 130 L100 104 L140 116 L196 64" stroke="#D6B25E" stroke-width="5" fill="none" stroke-linecap="round"/><circle cx="196" cy="64" r="8" fill="#D6B25E"/></svg>'
  };
  var PLAY_TYPES = ['standard', 'match', 'team', 'training'];

  function greeting() { var hr = new Date().getHours(); return t(hr >= 5 && hr < 10 ? 'greetMorning' : hr >= 17 && hr < 23 ? 'greetEvening' : 'greetDay'); }
  function initials(n) { return String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w.charAt(0).toUpperCase(); }).join('') || '?'; }

  function viewHome2() {
    var p = state.profile, first = (p.name || '').split(' ')[0], h = '';
    h += '<header class="home-hero" style="background-image:' + HERO_BG + '"><div class="hh-row"><button class="avatar" data-act="tab:profile" aria-label="' + esc(t('navProfile')) + '">' + esc(initials(p.name)) + '</button></div>' +
      '<h1 class="hh-greet">' + esc(greeting()) + (first ? ',<br><b>' + esc(first) + '</b>' : '') + '</h1></header>';
    h += '<div class="hh-cards"><button class="hcard" data-act="tab:profile"><b>' + (state.friends || []).length + '</b><span>' + esc(t('friendsShort')) + '</span></button>' +
      '<button class="hcard" data-act="tab:profile"><b>' + esc(p.hi === null ? '–' : C.formatHandicap(p.hi)) + '</b><span>HCP</span></button></div>';
    h += '<main class="page home">';
    if (!profileReady()) {
      h += '<section class="welcome"><h2>' + esc(t('welcomeTitle')) + '</h2><p>' + esc(t('welcomeText')) + '</p><button class="btn gold big" data-act="tab:profile">' + esc(t('startHere')) + '</button></section>';
    }
    var ar = activeRound();
    if (ar) {
      var as = C.summarizeRound(ar, ar.tee);
      h += '<button class="live-card" data-act="tab:round"><span><small>' + esc(t('ongoing')) + '</small><b>' + esc(ar.courseName) + '</b><small>' + esc(t('hole')) + ' ' + (ar.current + 1) + ' · ' + esc(t('resumeRound')) + ' ›</small></span><strong>' + (as.played ? signed(as.toPar) : '–') + '</strong></button>';
    }
    var done = doneRounds();
    h += '<div class="sec-h"><h2>' + esc(t('roundsTitle')) + ' (' + done.length + ')</h2>' + (done.length ? '<button class="link" data-act="tab:stats">' + esc(t('showAllShort')) + '</button>' : '') + '</div>';
    if (!done.length) h += '<div class="rcard empty"><p>' + esc(t('firstRoundHint')) + '</p></div>';
    else h += '<div class="rcards">' + done.slice(0, 10).map(function (r) {
      var big = '–';
      if (r.mode === 'team') big = t('teamShort');
      else { var s = metricsOf(r).s; big = s.played ? signed(s.toPar) : '–'; }
      return '<button class="rcard" data-act="round:' + r.id + '"><b>' + esc(r.courseName) + '</b><small>' + esc(fmtDate(r.date)) + '</small>' +
        '<small>' + esc(r.games && r.games.length ? r.games.map(function (g) { return t('g_' + g.type); }).join(', ') : t(r.format === 'stroke' ? 'strokePlay' : 'stableford')) + '</small><strong>' + esc(big) + '</strong></button>';
    }).join('') + '</div>';
    h += weatherBlock(homeWeatherCourse());
    return h + '</main>';
  }

  function nav2() {
    var ar = activeRound(), onPlay = view.tab === 'play' || view.tab === 'round';
    var tabs = [['home', 'navHome', 'M4 11l8-7 8 7v9h-5v-6H9v6H4z'], ['courses', 'navCourses', 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14'], null,
      ['stats', 'navStats', 'M5 20V11M12 20V5M19 20v-7'], ['profile', 'navProfile', 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c1-4 4-6 8-6s7 2 8 6']];
    return '<nav class="tabs five">' + tabs.map(function (x) {
      if (!x) return '<div class="playslot"><button class="playbtn' + (onPlay ? ' on' : '') + (ar ? ' live' : '') + '" data-act="' + (ar ? 'tab:round' : 'play') + '"><span>' + (ar ? esc(t('toRoundShort')) : esc(t('playShort'))) + '</span></button></div>';
      var on = view.tab === x[0];
      return '<button data-act="tab:' + x[0] + '" class="' + (on ? 'on' : '') + '"' + (on ? ' aria-current="page"' : '') + '><svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + x[2] + '"/></svg><span>' + esc(t(x[1])) + '</span></button>';
    }).join('') + '</nav>';
  }

  // --- Spela golf: 1) speltyp ---
  function viewPlay() {
    var pl = view.play;
    if (pl.step === 'course') return viewPlayCourse();
    var ty = PLAY_TYPES[pl.type], h = '<div class="pscreen ptype">';
    h += '<div class="ptop"><button class="roundbtn" data-act="play-exit" aria-label="' + esc(t('cancel')) + '">‹</button><h1>' + esc(t('chooseGameType')) + '</h1><span></span></div>';
    h += '<div class="pswipe" data-swipe="type"><div class="part">' + PLAY_ART[ty] + '</div>' +
      '<div class="ptitle"><button class="roundbtn ghost" data-act="ptype:-1" aria-label="' + esc(t('prev')) + '">‹</button><h2>' + esc(t('pt_' + ty)) + '</h2><button class="roundbtn ghost" data-act="ptype:1" aria-label="' + esc(t('next')) + '">›</button></div>' +
      '<p class="pdesc">' + esc(t('ptd_' + ty)) + '</p><div class="pdots">' + PLAY_TYPES.map(function (x, i) { return '<i class="' + (i === pl.type ? 'on' : '') + '"></i>'; }).join('') + '</div></div>';
    h += '<button class="btn gold big pcta" data-act="play-type-ok">' + esc(t('chooseCourseCta')) + '</button>';
    h += '<button class="link light" data-act="tab:round">' + esc(t('liveJoin')) + '</button>';
    return h + '</div>';
  }

  // --- Spela golf: 2) närmaste bana ---
  // ======================= KLUBBAR MED FLERA BANOR =======================
  var clubCache = { key: null, clubs: [] };
  function dirClubs() {
    var pool = dir ? dir.items : near.items;
    if (!pool) return [];
    var key = (dir ? 'd' + dir.fetchedAt : 'n' + (near.key || '')) + ':' + pool.length;
    if (clubCache.key !== key) clubCache = { key: key, clubs: G.groupClubs(pool) };
    return clubCache.clubs;
  }
  function clubOfItem(it) {
    return dirClubs().filter(function (c) { return c.courses.some(function (e) { return e.item.t === it.t && e.item.id === it.id; }); })[0] || null;
  }
  function courseOsmRef(c) { return (c.geo && c.geo.osmRef) || (c.osm ? c.osm.type + '/' + c.osm.id : null); }
  function libCombosFor(name) {
    var st = G.clubStem(name), f = RT.fold(name);
    return RT.combos(effLib()).filter(function (cb) { return (st && G.clubStem(cb.club) === st) || RT.fold(cb.club) === f; });
  }
  function savedEntry(c, label) { return { kind: 'saved', id: 's:' + c.id, label: c.courseLabel || label || c.name, holes: c.tees[0] ? c.tees[0].holes.length : null, course: c }; }
  function fullCourseName(clubName, label, many) { return many && label && RT.fold(label) !== RT.fold(clubName) ? clubName + ' – ' + label : (label || clubName); }

  // Kandidater i "Spela golf" = klubbar. Varje klubb har en eller flera banor (sparade, från kartdata eller slopetabell).
  function playCandidates() {
    var pos = view.play.pos, cands = {}, order = [], placed = {}, byRef = {};
    function cand(key, name, lat, lon, sub) {
      if (!cands[key]) { cands[key] = { id: key, name: name, lat: lat, lon: lon, sub: sub || '', courses: [] }; order.push(key); }
      return cands[key];
    }
    state.courses.forEach(function (c) { if (c.demo) return; var r = courseOsmRef(c); if (r) byRef[r] = c; });
    var clubs = pos ? G.searchClubs(dirClubs(), '', pos, 40).map(function (x) { return x.club; }) : [];
    if (view.play.pinnedClub && clubs.indexOf(view.play.pinnedClub) < 0) clubs.unshift(view.play.pinnedClub);
    clubs.forEach(function (cl) {
      var cd = cand('c:' + cl.key, cl.name, cl.lat, cl.lon, cl.c); cd.clubKey = cl.key;
      cl.courses.forEach(function (e) {
        var sv = byRef[e.item.t + '/' + e.item.id];
        if (sv) { cd.courses.push(savedEntry(sv, e.label)); placed[sv.id] = 1; }
        else cd.courses.push({ kind: 'dir', id: 'd:' + e.item.t + ':' + e.item.id, label: e.label, holes: e.item.h, it: e.item, club: cl });
      });
    });
    state.courses.forEach(function (c) {
      if (c.demo || placed[c.id]) return;
      var k = c.clubKey ? 'c:' + c.clubKey : c.club ? 'n:' + RT.fold(c.club) : 's:' + c.id;
      cand(k, c.club || c.name, c.lat, c.lon, '').courses.push(savedEntry(c));
    });
    order.forEach(function (k) {
      var cd = cands[k];
      libCombosFor(cd.name).forEach(function (cb) {
        if (state.courses.some(function (c) { return c.ratingLink === cb.key || c.ratingCombo === cb.key; })) return;
        if (cd.courses.some(function (e) { return RT.fold(e.label) === RT.fold(cb.course); })) return;
        cd.courses.push({ kind: 'lib', id: 'l:' + cb.key, label: cb.course + (cb.combo && cb.combo !== '18' ? ' (' + cb.combo + ')' : ''), combo: cb });
      });
      cd.courses.sort(function (a, b) { return a.label.localeCompare(b.label, 'sv'); });
    });
    var out = order.map(function (k) { return cands[k]; });
    out.forEach(function (c) { c.d = pos && c.lat !== null && c.lat !== undefined ? G.dist(pos, [c.lat, c.lon]) : null; });
    out.sort(function (a, b) { return a.d === null && b.d === null ? a.name.localeCompare(b.name, 'sv') : a.d === null ? 1 : b.d === null ? -1 : a.d - b.d; });
    if (view.play.pinnedId) { var pi = out.filter(function (c) { return c.id === view.play.pinnedId; })[0]; if (pi) { out.splice(out.indexOf(pi), 1); out.unshift(pi); } }
    var demo = courseById('demo');
    if (demo) out.push({ id: 's:demo', name: demo.name, sub: t('demo'), lat: null, lon: null, d: null, courses: [savedEntry(demo)] });
    return out;
  }
  function curCandidate() { var l = playCandidates(); return l[Math.min(view.play.idx, l.length - 1)] || null; }
  // Vald bana: väljs aldrig automatiskt när klubben har flera banor.
  function selEntry(cur) {
    if (!cur) return null;
    if (cur.courses.length === 1) return cur.courses[0];
    return cur.courses.filter(function (e) { return e.id === view.play.sel; })[0] || null;
  }
  function entryRow(e, on) {
    var meta = [];
    meta.push(e.holes ? e.holes + ' ' + t('holesShort') : t('holesUnknown'));
    if (e.kind === 'saved') meta.push(e.course.geo ? 'GPS ' + G.coverage(e.course.geo).holes + '/' + (e.holes || 18) : t('noGpsShort'));
    else if (e.kind === 'dir') meta.push(t('fetchOnContinue'));
    else meta.push(t('fromSlopeTable'));
    return '<button class="teerow choice' + (on ? ' on' : '') + '" data-act="psel:' + esc(e.id) + '"><span class="teedot" style="background:var(--forest)"></span><strong>' + esc(e.label) + '</strong>' +
      (e.kind === 'saved' ? '<em class="tag ok">' + esc(t('added')) + '</em>' : '') + '<span class="tmeta">' + meta.map(function (m) { return '<span>' + esc(m) + '</span>'; }).join('') + '</span></button>';
  }
  function loopChooserHtml(lp) {
    var g = lp.geo, nineLoops = g.loops.filter(function (l) { return l.count === 9; });
    var h = '<h3>' + esc(fmt(t('loopsFound'), { n: g.loops.length })) + '</h3><p class="note">' + esc(t('loopsHelp')) + '</p><div class="teepick">';
    g.loops.forEach(function (l) {
      h += '<button class="teerow choice" data-act="ploop:' + l.id + '"><span class="teedot" style="background:var(--forest)"></span><strong>' + esc(l.label || t('loopWord') + ' ' + l.id) + '</strong>' +
        '<span class="tmeta"><span>' + l.count + ' ' + esc(t('holesShort')) + '</span><span>' + esc(t('holeWord')) + ' ' + l.from + '–' + l.to + '</span></span></button>';
    });
    for (var i = 0; i < nineLoops.length; i++) for (var j = 0; j < nineLoops.length; j++) {
      if (i === j) continue;
      var a = nineLoops[i], b = nineLoops[j];
      h += '<button class="teerow choice" data-act="ploop:' + a.id + ',' + b.id + '"><span class="teedot" style="background:var(--champagne)"></span><strong>' + esc((a.label || a.id) + ' + ' + (b.label || b.id)) + '</strong><span class="tmeta"><span>18 ' + esc(t('holesShort')) + '</span><span>' + esc(fmt(t('loopCombo'), { a: a.label || a.id, b: b.label || b.id })) + '</span></span></button>';
    }
    h += '</div><button class="btn ghost wide" data-act="ploop-all">' + esc(t('saveAllLoops')) + '</button><button class="link" data-act="ploop-cancel">' + esc(t('cancel')) + '</button>';
    return h;
  }
  // Skapar en bana från kartdata för vald slinga (eller kombination). Ofullständiga data → formuläret.
  function courseFromLoop(lp, ids) {
    var sub = G.geoForLoops(lp.geo, ids), labels = ids.map(function (id) { var l = lp.geo.loops.filter(function (x) { return x.id === id; })[0]; return (l && l.label) || t('loopWord') + ' ' + id; });
    var label = labels.join(' + ');
    return { id: uid(), name: lp.clubName + ' – ' + label, club: lp.clubName, clubKey: lp.clubKey || null, courseLabel: label, lat: lp.lat, lon: lp.lon, verified: false,
      geo: sub, osm: lp.osm, loopIds: ids, tees: [teeFromGeo(sub)] };
  }
  function finishCourse(course, from) {
    if (osmComplete(course.geo)) {
      state.courses.push(course); save();
      if (from === 'play') { goSetupFromPlay(course, course.tees[0].id); } else { view.tab = 'courses'; view.sub = null; view.flash = t('courseAdded'); }
    } else {
      course.isNew = true; view.draft = course; view.errors = []; if (from === 'play') view.playResume = PLAY_TYPES[view.play.type];
      view.tab = 'courses'; view.sub = 'edit'; view.flash = t('completeCard'); window.scrollTo(0, 0);
    }
  }
  function viewLoopPick() {
    return header(t('chooseLoop'), 'ploop-cancel') + '<main class="page"><p class="meta">' + esc(view.loopPick.clubName) + '</p>' + loopChooserHtml(view.loopPick) + '</main>';
  }

  function viewPlayCourse() {
    var pl = view.play, list = playCandidates(), cur = list[Math.min(pl.idx, list.length - 1)], sel = selEntry(cur);
    var h = '<div class="pscreen pcourse" style="background-image:' + AERIAL_BG + '">';
    h += '<div class="ptop"><button class="link light" data-act="play-back">' + esc(t('back')) + '</button><h1>' + esc(t('courseCaps')) + '</h1><button class="link light" data-act="play-exit">' + esc(t('cancel')) + '</button></div>';
    if (pl.search) return h + playSearch() + '</div>';
    if (!cur) {
      h += '<div class="pc-info"><h2>' + esc(t('noCoursesYet')) + '</h2></div>';
    } else {
      h += '<div class="pc-info pswipe" data-swipe="course"><h2>' + esc(cur.name) + '</h2>' + (cur.sub ? '<p>' + esc(cur.sub) + '</p>' : '') + '<div class="chips">' +
        (cur.d !== null ? '<span class="pill">📍 ' + esc(dec(cur.d / 1000)) + ' km</span>' : '') +
        '<span class="pill">' + esc(cur.courses.length === 1 ? (cur.courses[0].holes ? cur.courses[0].holes + ' ' + t('holesShort') : t('oneCourse')) : fmt(t('nCourses'), { n: cur.courses.length })) + '</span>' +
        (sel && sel.kind === 'saved' && sel.course.id !== 'demo' ? '<button class="pill" data-act="play-details">' + esc(t('showDetails')) + '</button>' : '') + '</div></div>';
    }
    h += '<div class="pc-nav"><button class="roundbtn ghost" data-act="pcourse:-1"' + (pl.idx <= 0 ? ' disabled' : '') + ' aria-label="' + esc(t('prev')) + '">‹</button>' +
      '<button class="searchbtn" data-act="play-search">🔍 ' + esc(t('searchCourses')) + '</button>' +
      '<button class="roundbtn" data-act="pcourse:1"' + (pl.idx >= list.length - 1 ? ' disabled' : '') + ' aria-label="' + esc(t('next')) + '">›</button></div></div>';
    h += '<div class="psheet">';
    if (pl.posStatus === 'asking') h += '<p class="note">' + esc(t('findingNearest')) + '</p>';
    if (pl.posStatus === 'denied' || pl.posStatus === 'timeout' || pl.posStatus === 'unavailable') {
      h += '<p class="note">' + esc(t(pl.posStatus === 'denied' ? 'posDenied' : pl.posStatus === 'timeout' ? 'posTimeout' : 'posUnavailable')) + '</p>' +
        (pl.posStatus !== 'denied' ? '<button class="chip" data-act="play-pos-retry">' + esc(t('retry')) + '</button>' : '');
    }
    if (!dir && near.status === 'loading') h += '<p class="note">' + esc(t('nearLoading')) + '</p>';
    else if (dirState.status === 'loading' && !(near.items && near.items.length)) h += '<p class="note">' + esc(t('dirLoading')) + '</p>';
    if (!dir && dirState.status === 'error' && near.status !== 'done') {
      h += '<p class="warn">' + esc(near.status === 'error' ? near.msg : dirState.msg) + '</p><button class="btn ghost" data-act="play-retry">' + esc(t('retry')) + '</button>';
    }
    if (pl.posStatus === 'ok' && near.status === 'done' && near.items && !near.items.length && !dir) h += '<p class="note">' + esc(t('noneNearby')) + '</p>';
    if (cur && cur.d !== null) {
      var sameArea = list.filter(function (c, i) { return i !== pl.idx && c.d !== null && G.dist([cur.lat, cur.lon], [c.lat, c.lon]) < 2500; }).slice(0, 6);
      if (sameArea.length) h += '<h3>' + esc(t('sameArea')) + '</h3><div class="chips">' + sameArea.map(function (c) { return '<button class="chip" data-act="pcourse-to:' + esc(c.id) + '">' + esc(c.name) + '</button>'; }).join('') + '</div>';
    }
    if (pl.loopPick) return h + loopChooserHtml(pl.loopPick) + '</div>';
    if (cur && cur.courses.length > 1) {
      h += '<h3>' + esc(t('chooseCourseAtClub')) + '</h3><div class="teepick">' + cur.courses.map(function (e) { return entryRow(e, sel && sel.id === e.id); }).join('') + '</div>';
      if (!sel) h += '<p class="note">' + esc(fmt(t('clubHasCourses'), { n: cur.courses.length })) + '</p>';
    }
    if (cur) h += '<button class="link" data-act="padd-course">' + esc(t('addCourseToClub')) + '</button>';
    if (sel && sel.kind === 'saved') {
      h += '<h3>' + esc(t('chooseTee')) + '</h3>' + teeRows(sel.course, playerGender(), '18', pl.teeId || sel.course.tees[0].id, 'ptee');
    } else if (sel && sel.kind === 'dir') h += '<p class="note">' + esc(t('dirCourseNote')) + '</p>';
    else if (sel && sel.kind === 'lib') h += '<p class="note">' + esc(t('libCourseNote')) + '</p>';
    if (pl.err) h += '<p class="warn">' + esc(pl.err) + '</p>';
    if (pl.busy) {
      h += '<div class="busybox" role="status"><span class="spin" aria-hidden="true"></span><span>' + esc(t('geoLoading')) + ' <b id="play-elapsed">' + Math.round((Date.now() - pl.started) / 1000) + ' s</b></span></div>' +
        '<p class="note" id="play-slow"' + (pl.attemptText ? '' : ' hidden') + '>' + esc(pl.attemptText || t('geoSlow')) + '</p><button class="btn ghost wide" data-act="play-cancel">' + esc(t('cancel')) + '</button>';
    } else {
      h += '<button class="btn gold big" data-act="play-go"' + (!sel ? ' disabled' : '') + '>' + (pl.err ? esc(t('retry')) : esc(t('gameSettings')) + ' »') + '</button>';
      if (pl.err && sel && sel.kind === 'dir') h += '<button class="btn ghost wide" data-act="play-nomap">' + esc(t('continueNoMap')) + '</button><p class="note">' + esc(t('continueNoMapHelp')) + '</p>';
    }
    return h + '</div>';
  }
  function playSearch() {
    var q = view.play.q || '', h = '<div class="psearch"><input data-field="play.q" value="' + esc(q) + '" placeholder="' + esc(t('dirSearchPh')) + '" autocorrect="off" enterkeyhint="search"><div id="play-results">' + playResults() + '</div>' +
      '<button class="btn ghost light" data-act="play-search-close">' + esc(t('close')) + '</button></div>';
    return h;
  }
  function playResults() {
    var q = view.play.q || '', f = G.fold(q).trim(), out = [];
    state.courses.forEach(function (c) { if (!f || G.fold(c.name + ' ' + (c.club || '')).indexOf(f) >= 0) out.push('<button class="row light" data-act="psaved:' + c.id + '"><span class="row-main"><strong>' + esc(c.name) + '</strong><small>' + esc(t('added')) + '</small></span></button>'); });
    if (f) G.searchClubs(dirClubs(), q, view.play.pos, 25).forEach(function (x) {
      var cl = x.club;
      out.push('<button class="row light" data-act="pclub:' + esc(cl.key) + '"><span class="row-main"><strong>' + esc(cl.name) + '</strong><small>' + esc([cl.c, x.d !== null ? dec(x.d / 1000) + ' km' : '', cl.courses.length > 1 ? fmt(t('nCourses'), { n: cl.courses.length }) + ': ' + cl.courses.map(function (e) { return e.label; }).join(', ') : ''].filter(Boolean).join(' · ')) + '</small></span></button>');
    });
    if (!dir) out.push('<p class="note light">' + esc(t('dirNeeded')) + '</p><button class="btn ghost light" data-act="dir-load">' + esc(t('dirLoad')) + '</button>');
    return out.join('') || '<p class="note light">' + esc(t('noResults')) + '</p>';
  }
  function osmComplete(geo) {
    var n = Object.keys(geo.holes || {}).length; if (n !== 9 && n !== 18) return false;
    var hs = [], want = []; for (var i = 1; i <= n; i++) { hs.push(geo.holes[String(i)]); want.push(i); }
    if (!hs.every(function (h) { return h && h.par >= 3 && h.par <= 6; })) return false;
    return hs.map(function (h) { return h.si; }).sort(function (a, b) { return a - b; }).join() === want.join();
  }
  function startPlayCourseStep() {
    view.play.step = 'course'; view.play.idx = 0;
    if (!dir && view.play.pos) fetchNearby(view.play.pos);
    if (!dir && dirState.status !== 'loading' && navigator.onLine !== false) fetchDirectory();
    if (!view.play.pos || Date.now() - (view.play.posAt || 0) > 10 * 60000) requestPlayPos();
  }
  // Position för "närmaste bana": skiljer på nekad behörighet, ingen position och tidsgräns.
  function requestPlayPos() {
    if (!navigator.geolocation) { view.play.posStatus = 'unavailable'; return; }
    view.play.posStatus = 'asking';
    navigator.geolocation.getCurrentPosition(function (p) {
      var first = !view.play.pos;
      view.play.pos = [p.coords.latitude, p.coords.longitude]; view.play.posAt = Date.now(); view.play.posAcc = p.coords.accuracy; view.play.posStatus = 'ok';
      if (first) view.play.idx = 0;
      if (!dir) fetchNearby(view.play.pos);
      if (view.tab === 'play') render();
    }, function (e) {
      view.play.posStatus = e && e.code === 1 ? 'denied' : e && e.code === 3 ? 'timeout' : 'unavailable';
      if (view.tab === 'play') render();
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
  }
  function goSetupFromPlay(course, teeId) {
    var ty = PLAY_TYPES[view.play.type];
    view.setup = { allowance: state.profile.allowance, format: 'stableford', extra: [], games: {}, teamOf: {}, add: {}, mode: 'own',
      courseId: course.id, teeId: teeId || (course.tees.length === 1 ? course.tees[0].id : null), fromPlay: true, playType: ty };
    if (ty === 'match') view.setup.games.match = { on: true };
    if (ty === 'team') { view.setup.mode = 'team'; view.setup.teamMode = 'scramble2'; view.setup.games.teamStroke = { on: true }; }
    if (ty === 'training') view.setup.training = true;
    view.tab = 'home'; view.sub = 'setup'; window.scrollTo(0, 0);
  }
  function playGo() {
    var pl = view.play, cur = curCandidate(), sel = selEntry(cur);
    if (!sel) return;
    if (sel.kind === 'saved') { goSetupFromPlay(sel.course, pl.teeId); render(); return; }
    if (sel.kind === 'lib') { playFromLibrary(cur, sel); render(); return; }
    var it = sel.it, res = { name: it.n, osmType: it.t, osmId: it.id, lat: it.lat, lon: it.lon, bounds: it.b };
    var clubName = cur.courses.length > 1 || (sel.club && sel.club.courses.length > 1) ? cur.name : it.n;
    var token = uid();
    pl.busy = token; pl.err = null; pl.started = Date.now(); render();
    clearInterval(pl.ticker);
    pl.ticker = setInterval(function () {
      var el = document.getElementById('play-elapsed');
      if (!el || pl.busy !== token) { clearInterval(pl.ticker); return; }
      var s = Math.round((Date.now() - pl.started) / 1000);
      el.textContent = s + ' s';
      var hint = document.getElementById('play-slow');
      if (hint && s >= 15 && !pl.attemptText) hint.hidden = false;
    }, 1000);
    pl.attemptText = null;
    fetchCourseGeo(res, { onAttempt: function (n, max) {
      if (n < 2) return;
      pl.attemptText = fmt(t('attemptN'), { n: n, m: max });
      var hint = document.getElementById('play-slow'); if (hint) { hint.textContent = pl.attemptText; hint.hidden = false; }
    } }).then(function (geo) {
      if (pl.busy !== token) return;
      pl.busy = false; clearInterval(pl.ticker);
      if (!Object.keys(geo.holes).length) { pl.err = t('noHolesInOsm'); pl.errKind = 'data'; render(); return; }
      if (geo.fromCache) view.flash = fmt(t('usingCache'), { d: fmtDate(geo.cachedAt) });
      var many = cur.courses.length > 1;
      if (geo.loops && geo.loops.length > 1) {
        pl.loopPick = { geo: geo, clubName: many ? cur.name : it.n, clubKey: cur.clubKey || null, lat: +it.lat.toFixed(5), lon: +it.lon.toFixed(5), osm: { type: it.t, id: it.id, bounds: it.b }, from: 'play' };
        render(); return;
      }
      var course = { id: uid(), name: fullCourseName(cur.name, sel.label, many), club: many ? cur.name : (it.c ? '' : ''), clubKey: cur.clubKey || null, courseLabel: many ? sel.label : null,
        lat: +it.lat.toFixed(5), lon: +it.lon.toFixed(5), verified: false, geo: geo, osm: { type: it.t, id: it.id, bounds: it.b }, tees: [teeFromGeo(geo)] };
      if (many) course.club = cur.name;
      if (osmComplete(geo)) {
        state.courses.push(course); save(); if (!geo.fromCache) view.flash = t('courseAdded'); goSetupFromPlay(course, course.tees[0].id); render();
      } else {
        course.isNew = true; view.draft = course; view.errors = []; view.playResume = PLAY_TYPES[pl.type];
        view.tab = 'courses'; view.sub = 'edit'; view.flash = t('completeCard'); window.scrollTo(0, 0); render();
      }
    }).catch(function (e) {
      if (pl.busy !== token) return;
      pl.busy = false; clearInterval(pl.ticker); pl.err = t('geoFailed') + ' ' + errText(e); pl.errKind = NET.classify(e); render();
    });
  }
  // Bana som bara finns i slopetabellen: tees och värderingar därifrån, håldata från tabellen eller formuläret.
  function playFromLibrary(cur, sel) {
    var cb = sel.combo, tees = RT.buildTees(effLib(), cb, []), ok = tees.length && tees.every(function (te) { return te.holes && te.holes.length >= 9 && te.holes.every(function (h) { return h.par && h.si; }); });
    if (!tees.length) tees = [manualTee()];
    tees.forEach(function (te) { if (!te.holes || !te.holes.length) te.holes = manualTee().holes; });
    var course = { id: uid(), name: fullCourseName(cur.name, sel.label, cur.courses.length > 1), club: cur.name, clubKey: cur.clubKey || null, courseLabel: sel.label,
      lat: cur.lat, lon: cur.lon, verified: false, ratingLink: cb.key, tees: tees };
    if (ok) { state.courses.push(course); save(); goSetupFromPlay(course, null); }
    else { course.isNew = true; view.draft = course; view.errors = []; view.playResume = PLAY_TYPES[view.play.type]; view.tab = 'courses'; view.sub = 'edit'; view.flash = t('libNeedsHoles'); window.scrollTo(0, 0); }
  }
  // Fortsätt utan karta: banan sparas utan GPS-data och par/index fylls i från scorekortet.
  function playNoMap() {
    var pl = view.play, cur = curCandidate(), sel = selEntry(cur);
    if (!sel || sel.kind !== 'dir') return;
    var it = sel.it, many = cur.courses.length > 1;
    view.draft = { isNew: true, id: uid(), name: fullCourseName(cur.name, sel.label, many), club: many ? cur.name : '', clubKey: cur.clubKey || null, courseLabel: many ? sel.label : null,
      lat: +it.lat.toFixed(5), lon: +it.lon.toFixed(5), verified: false, osm: { type: it.t, id: it.id, bounds: it.b }, tees: [manualTee()] };
    view.errors = []; view.playResume = PLAY_TYPES[pl.type]; pl.err = null;
    view.tab = 'courses'; view.sub = 'edit'; view.flash = t('noMapFlash'); window.scrollTo(0, 0);
  }

  // ======================= TEE, COURSE RATING OCH SLOPE =======================
  var RT = window.Ratings, SHARED_KEY = 'banboken:shared-ratings';
  var sharedRatings = (function () { try { var d = JSON.parse(localStorage.getItem(SHARED_KEY) || 'null'); return d && Array.isArray(d.rows) ? d : { rows: [], at: null }; } catch (e) { return { rows: [], at: null }; } })();
  var libCache = { key: null, lib: [] };
  // Effektivt bibliotek: delad officiell tabell + lokala rader (lokala ersätter samma värdering).
  function effLib() {
    var own = state.ratingLib || [], key = sharedRatings.rows.length + ':' + (sharedRatings.at || '') + ':' + own.length + ':' + (own.length ? own[own.length - 1].updatedAt : '');
    if (libCache.key !== key) libCache = { key: key, lib: RT.mergeLibrary(sharedRatings.rows, own, '').lib };
    return libCache.lib;
  }
  function playerGender() { return state.profile.gender || null; }
  // Lägger in officiella tees från slopetabellen på varje kopplad bana. Egna tees behålls.
  function applyRatings() {
    var lib = effLib(), changed = 0;
    state.courses.forEach(function (c) {
      if (c.demo) return;
      var combo = RT.comboForCourse(lib, c);
      if (!combo) return;
      var built = RT.buildTees(lib, combo, c.tees);
      var builtNames = built.map(function (x) { return RT.fold(x.name); }), builtColors = built.map(function (x) { return RT.fold(x.color); });
      // Egna tees ersätts av den officiella teen med samma namn eller färg (t.ex. egen "Gul" → officiell "56 Gul").
      var keep = c.tees.filter(function (x) { var f = RT.fold(x.name); return !x.official && builtNames.indexOf(f) < 0 && builtColors.indexOf(f) < 0 && !(x.unrated && (x.cr === null || x.cr === undefined)); });
      var next = built.concat(keep);
      if (JSON.stringify(next) !== JSON.stringify(c.tees)) { c.tees = next; c.ratingCombo = combo.key; changed++; }
    });
    if (changed) save();
    return changed;
  }
  // Ögonblicksbild av tee för en rond: rätt värdering för kön och rondtyp (aldrig påhittade värden).
  function resolvedTee(te, gender, mode) {
    mode = mode || '18';
    // En 9-hålsbana har en 9-hålsvärdering (rondtyp 1–9 i slopetabellen).
    var rmode = te.holes && te.holes.length === 9 && mode === '18' ? 'front9' : mode;
    var rating = gender ? RT.ratingFor(te, gender, rmode) : (te.ratings ? null : RT.ratingFor(te, null, rmode));
    if (!rating && rmode !== mode && !te.ratings && typeof te.cr === 'number') rating = RT.ratingFor(te, null, '18');
    var snap = mode === '18' ? JSON.parse(JSON.stringify(te)) : RT.nineTee(te, mode, rating);
    delete snap.ratings;
    snap.cr = rating ? rating.cr : null; snap.slope = rating ? rating.slope : null; snap.unrated = !rating;
    snap.ratingInfo = rating ? { official: rating.official, source: rating.source || null, verifiedAt: rating.verifiedAt || null, gender: gender, holes: mode, par: rating.par } : { missing: true, gender: gender, holes: mode };
    return snap;
  }
  function teeLength(te, mode) {
    var hs = te.holes || [], sl = mode === 'front9' ? hs.slice(0, 9) : mode === 'back9' ? hs.slice(9, 18) : hs;
    var r = te.ratings && (te.ratings.men[mode || '18'] || te.ratings.women[mode || '18']);
    if (r && r.length) return r.length;
    if ((!mode || mode === '18') && te.length) return te.length;
    var sum = sl.reduce(function (a, h) { return a + (h.length || 0); }, 0);
    return sl.every(function (h) { return h.length; }) && sum ? sum : null;
  }
  function genderName(g) { return t(g === 'women' ? 'genderWomen' : 'genderMen'); }
  function ratingLine(te, gender, mode) {
    var r = gender ? RT.ratingFor(te, gender, mode) : null, len = teeLength(te, mode);
    var parts = [];
    if (len) parts.push(len + ' m');
    if (r) parts.push('CR ' + dec(r.cr) + ' · Slope ' + r.slope);
    else if (!gender && te.ratings) parts.push(t('chooseGenderShort'));
    else parts.push(fmt(t('noRatingFor'), { g: gender ? genderName(gender).toLowerCase() : '', h: t('hm_' + (mode || '18')).toLowerCase() }));
    return parts.join(' · ');
  }
  function ratingBadge(te, gender, mode) {
    var r = gender ? RT.ratingFor(te, gender, mode) : null;
    if (!r) return '<em class="tag">' + esc(t('noRatingTag')) + '</em>';
    return r.official ? '<em class="tag ok" title="' + esc((r.source || '') + ' ' + (r.verifiedAt || '')) + '">' + esc(t('officialTag')) + '</em>' : '<em class="tag">' + esc(t('ownValueTag')) + '</em>';
  }
  function holeNo(r, i) { return i + 1 + (r && r.holeOffset ? r.holeOffset : 0); }

  // ---------- Score differential, PCC ----------
  function diffBlock(r, s) {
    if (s.unrated || (r.tee && r.tee.unrated)) return '<p class="note">' + esc(t('noDiffUnrated')) + '</p>';
    if (s.differential === null) return '';
    var h = '<div class="diffbox"><p class="diff">' + esc(s.pccKnown ? t('diffWithPcc') : t('diffPrelim')) + ': <b>' + dec(s.differential) + '</b></p>';
    if (s.nine) h += '<p class="note">' + esc(fmt(t('diffNineExpl'), { d9: dec(s.differential9), e: dec(C.expected9(r.hi), 2) })) + '</p>';
    if (r.status === 'done' && !r.shared) {
      h += '<label class="field inline"><span>' + esc(t('pccLabel')) + '</span><select data-field="pcc:' + r.id + '"><option value="">' + esc(t('pccUnknown')) + '</option>' +
        [-1, 0, 1, 2, 3].map(function (v) { return '<option value="' + v + '"' + (r.pcc === v ? ' selected' : '') + '>' + (v > 0 ? '+' : '') + v + '</option>'; }).join('') + '</select></label>';
    }
    var ri = r.tee && r.tee.ratingInfo;
    if (ri && !ri.missing) h += '<p class="note">' + esc(ri.official ? fmt(t('ratingSrcOfficial'), { g: ri.gender ? genderName(ri.gender) : '', s: ri.source || '', d: ri.verifiedAt || '' }) : t('ratingSrcOwn')) + '</p>';
    return h + '<p class="note">' + esc(t('diffNotOfficial')) + '</p></div>';
  }

  // ---------- Administration ----------
  function sha(text) {
    if (window.crypto && crypto.subtle && window.TextEncoder) {
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode('banboken-admin:' + text)).then(function (buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      });
    }
    return Promise.resolve(SY.hash('banboken-admin:' + text));
  }
  var adminUi = { unlocked: false, pin: '', pin2: '', err: null, sec: 'report', combo: null, form: null, importText: '', importRes: null, shared: { status: null, isAdmin: null } };
  var ISSUE_ORDER = ['notLinked', 'noTees', 'noRating', 'invalidRating', 'parMismatch', 'badSi', 'holesMissing', 'duplicateTee', 'duplicateCourse', 'multipleLoops', 'unverified'];
  function viewAdmin() {
    var h = header(t('adminTitle'), 'admin-close') + '<main class="page form">';
    if (!state.admin || !state.admin.pinHash) {
      h += '<p>' + esc(t('adminCreatePin')) + '</p>' +
        '<label class="field"><span>' + esc(t('pinNew')) + '</span><input type="password" inputmode="numeric" autocomplete="new-password" data-field="adm.pin" value=""></label>' +
        '<label class="field"><span>' + esc(t('pinRepeat')) + '</span><input type="password" inputmode="numeric" autocomplete="new-password" data-field="adm.pin2" value=""></label>' +
        (adminUi.err ? '<p class="fail">' + esc(adminUi.err) + '</p>' : '') + '<button class="btn gold" data-act="adm-setpin">' + esc(t('save')) + '</button>' +
        '<p class="note">' + esc(t('adminPinNote')) + '</p>';
      return h + '</main>';
    }
    if (!adminUi.unlocked) {
      h += '<label class="field"><span>' + esc(t('pinEnter')) + '</span><input type="password" inputmode="numeric" autocomplete="current-password" data-field="adm.pin" value=""></label>' +
        (adminUi.err ? '<p class="fail">' + esc(adminUi.err) + '</p>' : '') + '<button class="btn gold" data-act="adm-unlock">' + esc(t('unlock')) + '</button>';
      return h + '</main>';
    }
    var secs = ['report', 'tables', 'edit', 'import', 'link', 'shared'];
    h += '<div class="chips adm-tabs">' + secs.map(function (s) { return '<button class="chip' + (adminUi.sec === s ? ' on' : '') + '" data-act="adm-sec:' + s + '">' + esc(t('adm_' + s)) + '</button>'; }).join('') + '</div>';
    var lib = effLib();
    if (adminUi.sec === 'report') {
      var rep = RT.audit(state.courses, lib), bad = rep.filter(function (x) { return !x.ok; });
      h += '<p class="meta">' + esc(fmt(t('auditSummary'), { n: rep.length, ok: rep.length - bad.length, bad: bad.length, rows: lib.length })) + '</p>';
      if (!rep.length) h += '<p class="muted">' + esc(t('auditNoCourses')) + '</p>';
      rep.forEach(function (c) {
        h += '<section class="block"><h3>' + esc(c.name) + ' ' + (c.ok ? '<em class="tag ok">OK</em>' : '') + '</h3>';
        var issues = c.issues.slice().sort(function (a, b) { return ISSUE_ORDER.indexOf(a.code) - ISSUE_ORDER.indexOf(b.code); });
        if (issues.length) h += '<ul class="clist">' + issues.map(function (x) { return '<li>' + esc(fmt(t('iss_' + x.code), { tee: x.tee || '', g: x.gender ? genderName(x.gender).toLowerCase() : '', a: x.a || '', b: x.b || '' })) + '</li>'; }).join('') + '</ul>';
        if (issues.some(function (x) { return x.code === 'notLinked'; })) h += '<button class="chip" data-act="adm-sec:link">' + esc(t('adm_link')) + '</button>';
        h += '</section>';
      });
    } else if (adminUi.sec === 'tables') {
      var cs = RT.combos(lib);
      if (!cs.length) h += '<p class="muted">' + esc(t('noTables')) + '</p>';
      cs.forEach(function (c) {
        var open = adminUi.combo === c.key, rows = lib.filter(function (r) { return RT.comboKey(r) === c.key; });
        h += '<section class="block"><button class="row" data-act="adm-combo:' + esc(c.key) + '"><span class="row-main"><strong>' + esc(c.club + ' – ' + c.course) + '</strong><small>' + esc(t('combo') + ': ' + c.combo + ' · ' + Object.keys(c.tees).length + ' tee · ' + rows.length + ' ' + t('ratingsWord')) + '</small></span><span class="chev">' + (open ? '⌄' : '›') + '</span></button>';
        if (open) {
          h += '<div class="sc-wrap"><table class="lb adm"><thead><tr><th>Tee</th><th>' + esc(t('genderShort')) + '</th><th>' + esc(t('holesShortH')) + '</th><th>CR</th><th>Slope</th><th>Par</th><th>' + esc(t('clubLen')) + '</th><th>' + esc(t('sourceShort')) + '</th><th></th></tr></thead><tbody>' +
            rows.sort(function (a, b) { return (b.length || 0) - (a.length || 0) || a.tee.localeCompare(b.tee, 'sv') || a.gender.localeCompare(b.gender) || a.holes.localeCompare(b.holes); }).map(function (r) {
              var own = (state.ratingLib || []).some(function (x) { return RT.rowKey(x) === RT.rowKey(r); });
              return '<tr><td><b>' + esc(r.tee) + '</b>' + (r.color ? ' <small>' + esc(r.color) + '</small>' : '') + '</td><td>' + esc(r.gender === 'women' ? 'D' : 'H') + '</td><td>' + esc(t('hm_' + r.holes)) + '</td><td>' + dec(r.cr) + '</td><td>' + r.slope + '</td><td>' + r.par + '</td><td>' + (r.length || '–') + '</td>' +
                '<td><small>' + esc(r.source) + '<br>' + esc(r.verifiedAt) + (own ? '' : ' · ' + esc(t('sharedTag'))) + '</small></td><td><button class="chip" data-act="adm-editrow:' + esc(RT.rowKey(r)) + '">' + esc(t('editShort')) + '</button>' +
                (own ? '<button class="chip" data-act="adm-delrow:' + esc(RT.rowKey(r)) + '" aria-label="' + esc(t('delete')) + '">✕</button>' : '') + '</td></tr>';
            }).join('') + '</tbody></table></div>';
        }
        h += '</section>';
      });
    } else if (adminUi.sec === 'edit') {
      var f = adminUi.form || (adminUi.form = { club: '', course: '', combo: '18', tee: '', color: '', length: '', par: '', gender: 'men', holes: '18', cr: '', slope: '', source: '', verifiedAt: new Date().toISOString().slice(0, 10) });
      h += '<p class="note">' + esc(t('editHelp')) + '</p>';
      [['club', 'club'], ['course', 'courseName'], ['combo', 'combo'], ['tee', 'teeNameShort'], ['color', 'teeColor'], ['length', 'clubLen'], ['par', 'par'], ['cr', 'cr'], ['slope', 'slope'], ['source', 'sourceLong'], ['verifiedAt', 'verifiedDate']].forEach(function (x) {
        h += '<label class="field"><span>' + esc(t(x[1])) + '</span><input data-field="admf.' + x[0] + '" value="' + esc(f[x[0]]) + '"' + (['length', 'par', 'cr', 'slope'].indexOf(x[0]) >= 0 ? ' inputmode="decimal"' : '') + (x[0] === 'verifiedAt' ? ' type="date"' : '') + '></label>';
      });
      h += '<div class="seg small">' + ['men', 'women'].map(function (g) { return '<button class="' + (f.gender === g ? 'on' : '') + '" data-act="admf-g:' + g + '">' + esc(genderName(g)) + '</button>'; }).join('') + '</div>';
      h += '<div class="seg small">' + ['18', 'front9', 'back9'].map(function (m) { return '<button class="' + (f.holes === m ? 'on' : '') + '" data-act="admf-h:' + m + '">' + esc(t('hm_' + m)) + '</button>'; }).join('') + '</div>';
      if (adminUi.err) h += '<p class="fail">' + esc(adminUi.err) + '</p>';
      h += '<button class="btn gold" data-act="adm-saverow">' + esc(t('save')) + '</button>';
    } else if (adminUi.sec === 'import') {
      h += '<p class="note">' + esc(t('importHelp')) + '</p><pre class="tmpl">' + esc(t('csvTemplate')) + '</pre>' +
        '<label class="btn ghost file">' + esc(t('chooseFile')) + '<input type="file" accept=".csv,.json,text/csv,application/json" data-field="adm.file"></label>' +
        '<label class="field"><span>' + esc(t('orPaste')) + '</span><textarea data-field="adm.text" rows="6">' + esc(adminUi.importText) + '</textarea></label>' +
        '<button class="btn gold" data-act="adm-import">' + esc(t('importBtn')) + '</button>';
      var ir = adminUi.importRes;
      if (ir) {
        h += '<div class="block"><p><b>' + esc(fmt(t('importResult'), { a: ir.added, u: ir.updated, s: ir.unchanged, e: ir.errors.length, c: ir.courses })) + '</b></p>';
        if (ir.missingCols && ir.missingCols.length) h += '<p class="fail">' + esc(t('missingCols') + ': ' + ir.missingCols.join(', ')) + '</p>';
        if (ir.errors.length) h += '<ul class="clist">' + ir.errors.slice(0, 30).map(function (x) { return '<li>' + esc(fmt(t('importErrLine'), { l: x.line, tee: x.tee || '?', f: x.errors.map(function (k) { return t('fld_' + k); }).join(', ') })) + '</li>'; }).join('') + '</ul>';
        h += '</div>';
      }
      h += '<button class="btn ghost" data-act="adm-export">' + esc(t('exportCsv')) + '</button>';
    } else if (adminUi.sec === 'link') {
      var all = RT.combos(lib);
      h += '<p class="note">' + esc(t('linkHelp')) + '</p>';
      state.courses.filter(function (c) { return !c.demo; }).forEach(function (c) {
        var cur = RT.comboForCourse(lib, c), sug = RT.suggestCombos(lib, c);
        var opts = sug.concat(all.filter(function (x) { return sug.indexOf(x) < 0; }));
        h += '<label class="field"><span>' + esc(c.name) + (cur ? ' ✓' : '') + '</span><select data-field="adm.link:' + c.id + '"><option value="">' + esc(t('notLinkedOpt')) + '</option>' +
          opts.map(function (x) { return '<option value="' + esc(x.key) + '"' + (cur && cur.key === x.key ? ' selected' : '') + '>' + esc(x.club + ' – ' + x.course + ' (' + x.combo + ')') + '</option>'; }).join('') + '</select></label>';
      });
    } else if (adminUi.sec === 'shared') {
      var sh = adminUi.shared;
      h += '<p class="note">' + esc(t('sharedHelp')) + '</p><p class="meta">' + esc(fmt(t('sharedCount'), { n: sharedRatings.rows.length, d: sharedRatings.at ? fmtDate(sharedRatings.at) : '–' })) + '</p>';
      if (!cloudReady()) h += '<p class="warn">' + esc(t('liveNeedCloud')) + '</p>';
      else {
        h += '<button class="btn ghost" data-act="adm-pull">' + esc(t('sharedPull')) + '</button>';
        if (signedIn()) h += '<button class="btn gold" data-act="adm-push"' + (sh.isAdmin === false ? ' disabled' : '') + '>' + esc(t('sharedPush')) + '</button>' + (sh.isAdmin === false ? '<p class="note">' + esc(t('notAdmin')) + '</p>' : '');
        else h += '<p class="note">' + esc(t('liveNeedSignIn')) + '</p>';
      }
      if (sh.status) h += '<p class="' + (sh.err ? 'fail' : 'note') + '">' + esc(sh.status) + '</p>';
    }
    h += '<button class="link" data-act="adm-lock">' + esc(t('lockAdmin')) + '</button>';
    return h + '</main>';
  }
  function runImport(text) {
    var res;
    try { res = RT.parseImport(text, new Date().toISOString().slice(0, 10)); }
    catch (e) { adminUi.importRes = { added: 0, updated: 0, unchanged: 0, courses: 0, errors: [{ line: 0, errors: ['format'] }] }; return; }
    var m = RT.mergeLibrary(state.ratingLib || [], res.rows, new Date().toISOString());
    state.ratingLib = m.lib; save();
    var c = applyRatings();
    adminUi.importRes = { added: m.added, updated: m.updated, unchanged: m.unchanged, errors: res.errors, missingCols: res.missingCols, courses: c };
  }
  function libCsv() {
    var head = 'Klubb;Bana;Slinga;OSM;Tee;Färg;Längd;Par;Kön;Hål;CR;Slope;Källa;Verifierad';
    function q(v) { v = v === null || v === undefined ? '' : String(v); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    return head + '\n' + effLib().map(function (r) {
      return [r.club, r.course, r.combo, r.osmRef, r.tee, r.color, r.length, r.par, r.gender === 'women' ? 'Dam' : 'Herr', r.holes === '18' ? '18' : r.holes === 'front9' ? '1-9' : '10-18', String(r.cr).replace('.', ','), r.slope, r.source, r.verifiedAt].map(q).join(';');
    }).join('\n');
  }
  // Delad officiell slopetabell i Supabase (alla läser, bara administratörer skriver).
  function pullShared(quiet) {
    if (!cloudReady()) return Promise.resolve();
    return httpJson(cloud.url + '/rest/v1/tee_ratings?select=data,updated_at&order=updated_at.asc&limit=5000', { headers: { apikey: cloud.key, Authorization: 'Bearer ' + (signedIn() && cloud.session.access ? cloud.session.access : cloud.key) } }, 30000)
      .then(function (rows) {
        var ok = [];
        (rows || []).forEach(function (x) { var n = RT.normalizeRow(x.data || {}, null); if (!n.errors.length) ok.push(n.row); });
        sharedRatings = { rows: ok, at: new Date().toISOString() };
        try { localStorage.setItem(SHARED_KEY, JSON.stringify(sharedRatings)); } catch (e) {}
        applyRatings();
        if (!quiet) { adminUi.shared.status = fmt(t('sharedPulled'), { n: ok.length }); adminUi.shared.err = false; render(); }
      }).catch(function (e) { if (!quiet) { adminUi.shared.status = e.message; adminUi.shared.err = true; render(); } });
  }
  function checkAdmin() {
    if (!signedIn()) return;
    ensureToken().then(function () { return httpJson(cloud.url + '/rest/v1/rpc/is_banboken_admin', { method: 'POST', headers: { apikey: cloud.key, Authorization: 'Bearer ' + cloud.session.access, 'Content-Type': 'application/json' }, body: '{}' }, 15000); })
      .then(function (v) { adminUi.shared.isAdmin = v === true; render(); }).catch(function () {});
  }
  function pushShared() {
    var rows = (state.ratingLib || []).map(function (r) { return { rk: RT.rowKey(r), data: r }; });
    adminUi.shared.status = t('syncing'); render();
    var chunks = []; for (var i = 0; i < rows.length; i += 100) chunks.push(rows.slice(i, i + 100));
    chunks.reduce(function (p, ch) {
      return p.then(function () { return sbFetch('/rest/v1/tee_ratings?on_conflict=rk', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(ch) }, true); });
    }, Promise.resolve()).then(function () { adminUi.shared.status = fmt(t('sharedPushed'), { n: rows.length }); adminUi.shared.err = false; return pullShared(true); })
      .catch(function (e) { adminUi.shared.status = e.status === 401 || e.status === 403 ? t('notAdmin') : e.message; adminUi.shared.err = true; })
      .then(function () { render(); });
  }

  function shareFile(name, text, type) {
    var blob = new Blob([text], { type: type });
    try { var f = new File([blob], name, { type: type }); if (navigator.canShare && navigator.canShare({ files: [f] })) { navigator.share({ files: [f], title: name }).catch(function () {}); return; } } catch (e) {}
    var aEl = document.createElement('a'); aEl.href = URL.createObjectURL(blob); aEl.download = name; document.body.appendChild(aEl); aEl.click(); aEl.remove();
  }

  // ======================= PREMIUMDESIGN: VYER =======================
  // Höjdkurvor (som på en banguide) – egen illustration, ritas en gång.
  var CONTOURS = (function () {
    var paths = '';
    for (var k = 0; k < 9; k++) {
      var y = 40 + k * 34, a = 14 + k * 3, d = 'M-20 ' + y;
      for (var x = 0; x <= 440; x += 40) d += ' Q' + (x + 20) + ' ' + (y + (((x / 40 + k) % 2) ? a : -a)) + ' ' + (x + 40) + ' ' + y;
      paths += '<path d="' + d + '"/>';
    }
    return '<svg class="contours" viewBox="0 0 400 360" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><g fill="none" stroke="#C9A65A" stroke-opacity=".22" stroke-width="1">' + paths +
      '<ellipse cx="318" cy="92" rx="54" ry="34"/><ellipse cx="318" cy="92" rx="34" ry="20"/><ellipse cx="318" cy="92" rx="15" ry="8"/></g></svg>';
  })();
  function sparkSvg(vals, w, h) {
    var pts = vals.filter(function (v) { return v !== null && v !== undefined; });
    if (pts.length < 2) return '';
    w = w || 300; h = h || 56;
    var min = Math.min.apply(null, pts), max = Math.max.apply(null, pts); if (max - min < 1) { max += .5; min -= .5; }
    var step = (w - 8) / (pts.length - 1);
    var xy = pts.map(function (v, i) { return [4 + i * step, h - 6 - (v - min) / (max - min) * (h - 14)]; });
    var line = xy.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
    var last = xy[xy.length - 1];
    return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true"><polygon class="ar" points="4,' + h + ' ' + line + ' ' + (w - 4) + ',' + h + '"/><polyline class="ln" points="' + line + '"/><circle class="dt" cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="3.5"/></svg>';
  }
  function hiDelta() {
    var hh = state.profile.hiHistory || [];
    if (hh.length < 2) return null;
    var first = hh[0], last = hh[hh.length - 1];
    return { d: Math.round((last.hi - first.hi) * 10) / 10, since: first.d };
  }

  function viewHome3() {
    var p = state.profile, first = (p.name || '').split(' ')[0], ar = activeRound(), h = '';
    h += '<header class="home3">' + CONTOURS + '<div class="h3-top"><button class="h3-av" data-act="tab:profile" aria-label="' + esc(t('navProfile')) + '">' + esc(initials(p.name)) + '</button><span class="h3-brand">Banboken</span></div>';
    h += '<h1 class="h3-greet">' + esc(greeting()) + (first ? ', ' + esc(first) : '') + '</h1>';
    if (p.hi !== null) {
      var dl = hiDelta();
      h += '<div class="h3-hcp"><b>' + esc(C.formatHandicap(p.hi)) + '</b><span>' + esc(t('handicapIndex')) + (dl && dl.d ? '<em>' + (dl.d < 0 ? '−' : '+') + esc(dec(Math.abs(dl.d))) + ' ' + esc(t('sinceDate')) + ' ' + esc(fmtDate(dl.since)) + '</em>' : '') + '</span></div>';
    }
    h += '<div class="h3-cta">' + (ar
      ? '<button class="btn lux big" data-act="tab:round">' + esc(t('resumeRound')) + ' · ' + esc(t('hole')) + ' ' + holeNo(ar, ar.current) + '</button>'
      : '<button class="btn lux big" data-act="play">' + esc(t('startRound')) + '</button>') + '</div></header>';
    h += '<main class="page home">';
    if (!profileReady()) h += '<section class="card"><p class="title">' + esc(t('welcomeTitle')) + '</p><p class="sub">' + esc(t('welcomeText')) + '</p><div class="actions"><button class="btn gold" data-act="tab:profile">' + esc(t('startHere')) + '</button></div></section>';
    if (ar) {
      var as = C.summarizeRound(ar, ar.tee);
      h += '<button class="live-card" data-act="tab:round"><span><small>' + esc(t('ongoing')) + '</small><b>' + esc(ar.courseName) + '</b><small>' + esc(t('hole')) + ' ' + holeNo(ar, ar.current) + ' · ' + esc(t('resumeRound')) + '</small></span><strong>' + (as.played ? signed(as.toPar) : '–') + '</strong></button>';
    }
    var done = doneRounds(), own = done.filter(function (r) { return r.mode !== 'team' && !r.shared; });
    if (done.length) {
      var lr = done[0], lc = courseById(lr.courseId), ls = metricsOf(lr).s;
      h += '<section class="card"><h3>' + esc(t('lastPlayed')) + '</h3><p class="title">' + esc(lr.courseName) + '</p><p class="sub">' + esc(fmtDate(lr.date)) + ' · ' + esc(lr.tee.name) +
        (lr.mode === 'team' ? '' : ' · ' + ls.gross + ' ' + esc(t('strokesShort')) + ' · ' + ls.points + ' p') + '</p><div class="actions">' +
        (lc && !ar ? '<button class="btn gold" data-act="play-again:' + lc.id + '">' + esc(t('playAgain')) + '</button>' : '') +
        '<button class="btn ghost" data-act="round:' + lr.id + '">' + esc(t('toScorecard')) + '</button></div></section>';
    }
    if (own.length >= 2) {
      var ms = own.slice(0, 10).map(metricsOf), pts = ms.filter(function (m) { return !m.s.nine; }).map(function (m) { return m.s.points; }).reverse();
      var a = C.aggregate(ms.map(function (m) { return m.s; }), 10);
      h += '<button class="card devcard" data-act="tab:stats" style="display:block;width:100%;text-align:left;border:0"><h3>' + esc(t('yourDev')) + '</h3>' + sparkSvg(pts) +
        '<div class="dev"><div><b>' + dec(a.avgPoints) + '</b><small>' + esc(t('avgPoints')) + '</small></div><div><b>' + dec(a.avgGross) + '</b><small>' + esc(t('avgScore')) + '</small></div><div><b>' + own.length + '</b><small>' + esc(t('roundsPlayed')) + '</small></div></div></button>';
    }
    h += '<div class="sec-h"><h2>' + esc(t('roundsTitle')) + '</h2>' + (done.length ? '<button class="link" data-act="tab:stats">' + esc(t('showAllShort')) + '</button>' : '') + '</div>';
    if (!done.length) h += '<div class="rcard empty"><p>' + esc(t('firstRoundHint')) + '</p></div>';
    else h += '<div class="rcards">' + done.slice(0, 10).map(function (r) {
      var big = r.mode === 'team' ? t('teamShort') : (function () { var s = metricsOf(r).s; return s.played ? signed(s.toPar) : '–'; })();
      return '<button class="rcard" data-act="round:' + r.id + '"><b>' + esc(r.courseName) + '</b><small>' + esc(fmtDate(r.date)) + '</small><small>' + esc(r.nine ? t('hm_' + r.nine) : (r.games && r.games.length ? r.games.map(function (g) { return t('g_' + g.type); }).join(', ') : t(r.format === 'stroke' ? 'strokePlay' : 'stableford'))) + '</small><strong>' + esc(big) + '</strong></button>';
    }).join('') + '</div>';
    h += weatherBlock(homeWeatherCourse());
    return h + '</main>';
  }

  // Ikoner för kartknapparna (egna, tunna linjer)
  var ICON = {
    follow: '<svg viewBox="0 0 24 24"><path d="M12 3l7 18-7-4-7 4z"/></svg>',
    center: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>',
    green: '<svg viewBox="0 0 24 24"><path d="M6 21V4"/><path d="M6 4l10 3.5L6 11"/><ellipse cx="12" cy="20" rx="8" ry="2"/></svg>',
    hole: '<svg viewBox="0 0 24 24"><path d="M7 21c0-6 10-6 10-12V3"/><path d="M17 3l4 1.5-4 1.5"/><circle cx="7" cy="21" r="1"/></svg>',
    layers: '<svg viewBox="0 0 24 24"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/></svg>',
    sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
  };
  function distHtml(r, x) {
    var gi = greenInfo(x.hole, x.from), stale = !x.fromTee && gpsQ() === 'lost';
    return '<div class="plate dist3' + (stale ? ' stale' : '') + '">' + d3('frontEdge', gi.front) + d3('midGreen', gi.mid, !gi.exact, true) + d3('backEdge', gi.back) + '</div>';
  }
  var TEE_COLORS = { gul: '#E2B33C', yellow: '#E2B33C', rod: '#B83A2E', red: '#B83A2E', bla: '#2F64A8', blue: '#2F64A8', vit: '#F4F2EC', white: '#F4F2EC', svart: '#222', black: '#222', gron: '#2E7D4F', green: '#2E7D4F', orange: '#E07B2A', guld: '#C9A65A', gold: '#C9A65A', silver: '#B9BDBF', lila: '#7B4FA0' };
  function teeColor(te) {
    var keys = [te.color, te.name].map(function (v) { return RT.fold(v); });
    for (var i = 0; i < keys.length; i++) for (var k in TEE_COLORS) if (keys[i] && keys[i].indexOf(k) >= 0) return TEE_COLORS[k];
    return 'var(--line-strong)';
  }
  function teeRows(c, gender, mode, selId, act) {
    return '<div class="teepick">' + c.tees.map(function (te) {
      var r = gender ? RT.ratingFor(te, gender, mode) : (te.ratings ? null : RT.ratingFor(te, null, mode)), len = teeLength(te, mode);
      var par = C.sumPar(mode === '18' ? te.holes : mode === 'front9' ? te.holes.slice(0, 9) : te.holes.slice(9, 18));
      return '<button class="teerow choice' + (selId === te.id ? ' on' : '') + '" data-act="' + act + ':' + te.id + '"><span class="teedot" style="background:' + teeColor(te) + '"></span><strong>' + esc(te.name) + (te.color && RT.fold(te.color) !== RT.fold(te.name) ? ' <small>' + esc(te.color) + '</small>' : '') + '</strong>' + ratingBadge(te, gender, mode) +
        '<span class="tmeta">' + (len ? '<span><b>' + len + '</b> m</span>' : '') + '<span>Par <b>' + par + '</b></span>' +
        (r ? '<span>CR <b>' + dec(r.cr) + '</b></span><span>Slope <b>' + r.slope + '</b></span>' : '<span>' + esc(!gender && te.ratings ? t('chooseGenderShort') : fmt(t('noRatingFor'), { g: gender ? genderName(gender).toLowerCase() : '', h: t('hm_' + mode).toLowerCase() })) + '</span>') + '</span></button>';
    }).join('') + '</div>';
  }
  function courseList(s) {
    var q = RT.fold(view.setupQ || ''), fav = state.favCourses || [], last = {};
    state.rounds.forEach(function (r) { if (!last[r.courseId] || r.date > last[r.courseId]) last[r.courseId] = r.date; });
    var list = state.courses.filter(function (c) { return !q || RT.fold(c.name + ' ' + (c.club || '')).indexOf(q) >= 0; });
    function card(c) {
      var isFav = fav.indexOf(c.id) >= 0;
      return '<div class="ccard' + (s.courseId === c.id ? ' on' : '') + '" data-act="pick-course:' + c.id + '" role="button" tabindex="0"><b>' + esc(c.name) + '</b>' +
        '<button class="star' + (isFav ? ' on' : '') + '" data-act="fav:' + c.id + '" aria-label="' + esc(t('favorite')) + '" aria-pressed="' + isFav + '">' + (isFav ? '★' : '☆') + '</button>' +
        '<small>' + esc([c.club, c.tees.length + ' tee', last[c.id] ? t('lastPlayedShort') + ' ' + fmtDate(last[c.id]) : ''].filter(Boolean).join(' · ')) + '</small><span class="tags">' + badge(c) + '</span></div>';
    }
    var favs = list.filter(function (c) { return fav.indexOf(c.id) >= 0; });
    var recent = list.filter(function (c) { return fav.indexOf(c.id) < 0 && last[c.id]; }).sort(function (a, b) { return last[b.id] < last[a.id] ? -1 : 1; }).slice(0, 5);
    var rest = list.filter(function (c) { return favs.indexOf(c) < 0 && recent.indexOf(c) < 0; }).sort(function (a, b) { return a.name.localeCompare(b.name, 'sv'); });
    var h = '';
    if (favs.length) h += '<p class="grp-h">' + esc(t('favorites')) + '</p>' + favs.map(card).join('');
    if (recent.length) h += '<p class="grp-h">' + esc(t('recentCourses')) + '</p>' + recent.map(card).join('');
    if (rest.length) h += '<p class="grp-h">' + esc(favs.length || recent.length ? t('allCourses') : t('chooseCourse')) + '</p>' + rest.map(card).join('');
    return h || '<p class="muted">' + esc(t('noResults')) + '</p>';
  }
  function scoreDist(rounds) {
    var c = { eagle: 0, birdie: 0, par: 0, bogey: 0, dbl: 0 }, n = 0;
    rounds.forEach(function (r) {
      if (r.mode === 'team') return;
      r.tee.holes.forEach(function (h, i) {
        var d = r.holes[i] || {}; if (typeof d.strokes !== 'number' || d.pickedUp) return;
        var x = d.strokes - h.par; n++;
        if (x <= -2) c.eagle++; else if (x === -1) c.birdie++; else if (x === 0) c.par++; else if (x === 1) c.bogey++; else c.dbl++;
      });
    });
    return { c: c, n: n };
  }
  function statsDash(rounds, n) {
    var own = rounds.filter(function (r) { return r.mode !== 'team' && !r.shared; }), list = own.slice(0, n), ms = list.map(metricsOf);
    var a = C.aggregate(ms.map(function (m) { return m.s; }), n), hh = state.profile.hiHistory || [], h = '<div class="dash">';
    h += '<div class="tile hero"><small>' + esc(t('hcpDev')) + '</small><b>' + esc(state.profile.hi === null ? '–' : C.formatHandicap(state.profile.hi)) + '</b>' +
      (hh.length >= 2 ? sparkSvg(hh.slice(-20).map(function (x) { return x.hi; })) : '<small>' + esc(t('hcpDevEmpty')) + '</small>') + '</div>';
    h += '<div class="tile"><small>' + esc(t('roundsPlayed')) + '</small><b>' + own.length + '</b></div>' +
      '<div class="tile"><small>' + esc(t('avgScore')) + '</small><b>' + dec(a.avgGross) + '</b></div>' +
      '<div class="tile"><small>' + esc(t('avgPoints')) + '</small><b>' + dec(a.avgPoints) + '</b></div>' +
      '<div class="tile"><small>' + esc(t('avgPutts')) + '</small><b>' + dec(a.avgPutts) + '</b></div></div>';
    var sd = scoreDist(list);
    if (sd.n) {
      var keys = ['eagle', 'birdie', 'par', 'bogey', 'dbl'];
      h += '<section class="card"><h3>' + esc(t('scoreDist')) + '</h3><div class="distbar">' + keys.map(function (k) { return '<i class="dl-' + k + '" style="width:' + (sd.c[k] / sd.n * 100).toFixed(1) + '%"></i>'; }).join('') + '</div>' +
        '<div class="distleg">' + keys.map(function (k) { return '<span><b>' + dec(sd.c[k] / Math.max(1, list.length), 1) + '</b>' + esc(t('sd_' + k)) + '</span>'; }).join('') + '</div><p class="note">' + esc(t('perRound')) + '</p></section>';
    }
    return h;
  }

  var state = load();
  var storageOk = true;
  function saveLocalOnly() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); storageOk = true; }
    catch (e) { storageOk = false; }
  }
  function save() { saveLocalOnly(); scheduleSync(); }

  // ---------- Hjälpfunktioner ----------
  function t(k) { var d = window.I18N[state.profile.lang] || window.I18N.sv; return d[k] || window.I18N.sv[k] || k; }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function num(v) { var n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : null; }
  function dec(v, d) { return v === null || v === undefined ? '–' : v.toFixed(d === undefined ? 1 : d).replace('.', state.profile.lang === 'sv' ? ',' : '.'); }
  function fmtDate(iso) {
    try { return new Date(iso).toLocaleDateString(state.profile.lang === 'sv' ? 'sv-SE' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch (e) { return iso.slice(0, 10); }
  }
  function courseById(id) { return state.courses.filter(function (c) { return c.id === id; })[0]; }
  function activeRound() { return state.rounds.filter(function (r) { return r.status === 'active'; })[0]; }
  function doneRounds() {
    return state.rounds.filter(function (r) { return r.status === 'done' && (state.ui.showDemo || !r.demo); })
      .sort(function (a, b) { return b.date < a.date ? -1 : 1; });
  }
  function profileReady() { return state.profile.name && state.profile.hi !== null; }

  var view = { tab: 'home', sub: null, param: null, flash: null, holeMode: 'hole', setup: {}, draft: null, errors: [], tests: null, find: { status: 'idle', results: [] }, mapZoom: 'hole' };

  // ---------- Tema ----------
  function applyTheme() {
    var th = state.profile.theme;
    if (th === 'light' || th === 'dark') document.documentElement.setAttribute('data-theme', th);
    else document.documentElement.removeAttribute('data-theme');
    document.documentElement.lang = state.profile.lang;
  }

  // ---------- Vyer ----------
  function header(title, back) {
    return '<header class="bar"><div class="bar-in">' +
      (back ? '<button class="bar-back" data-act="' + back + '" aria-label="' + esc(t('cancel')) + '">‹</button>' : '<span class="mark" aria-hidden="true"></span>') +
      '<h1>' + esc(title) + '</h1></div></header>';
  }

  function nav() {
    var tabs = [['home', 'navHome', 'M4 11l8-7 8 7v9h-5v-6H9v6H4z'], ['round', 'navRound', 'M12 3v15M12 3l7 3.5-7 3.5M8 21h8'],
      ['courses', 'navCourses', 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14'], ['stats', 'navStats', 'M5 20V11M12 20V5M19 20v-7'],
      ['profile', 'navProfile', 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c1-4 4-6 8-6s7 2 8 6']];
    return '<nav class="tabs">' + tabs.map(function (x) {
      var on = view.tab === x[0];
      return '<button data-act="tab:' + x[0] + '" class="' + (on ? 'on' : '') + '"' + (on ? ' aria-current="page"' : '') + '>' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + x[2] + '"/></svg><span>' + esc(t(x[1])) + '</span></button>';
    }).join('') + '</nav>';
  }

  function flash() { return view.flash ? '<div class="flash" role="status">' + esc(view.flash) + '</div>' : ''; }

  // --- Hem ---
  function viewHome() {
    var p = state.profile, h = '';
    h += header(t('appName'));
    h += '<main class="page">';
    if (!profileReady()) {
      h += '<section class="hero"><h2>' + esc(t('welcomeTitle')) + '</h2><p>' + esc(t('welcomeText')) + '</p>' +
        '<button class="btn gold big" data-act="tab:profile">' + esc(t('startHere')) + '</button></section>';
    } else {
      h += '<section class="hero"><p class="hello">' + esc(t('hello')) + ' ' + esc(p.name.split(' ')[0]) + '</p>' +
        '<p class="hcp"><span>' + esc(C.formatHandicap(p.hi)) + '</span> ' + esc(t('handicapIndex')) + '</p>';
      var ar = activeRound();
      if (ar) {
        h += '<button class="btn gold big" data-act="tab:round">' + esc(t('resumeRound')) + ' · ' + esc(ar.courseName) + ', ' + esc(t('hole').toLowerCase()) + ' ' + (ar.current + 1) + '</button>';
      } else {
        h += '<button class="btn gold big" data-act="setup">' + esc(t('startRound')) + '</button>';
      }
      h += '</section>';
    }
    var done = doneRounds();
    h += '<section class="block"><h3>' + esc(t('lastRound')) + '</h3>';
    if (done.length) h += roundRow(done[0]); else h += '<p class="muted">' + esc(t('noRounds')) + '</p>';
    h += '</section>';
    h += weatherBlock(homeWeatherCourse());
    h += '</main>';
    return h;
  }

  function homeWeatherCourse() {
    var ar = activeRound();
    if (ar) { var c = courseById(ar.courseId); if (c) return c; }
    var home = state.courses.filter(function (c) { return !c.demo && c.lat !== null && c.lat !== undefined; })[0];
    return home || null;
  }

  function roundRow(r) {
    if (r.mode === 'team' || (r.shared && !r.holes.some(function (d) { return typeof d.strokes === 'number'; }))) {
      return '<button class="row" data-act="round:' + r.id + '"><span class="row-main"><strong>' + esc(r.courseName) + '</strong>' + (r.shared ? ' <em class="tag">' + esc(t('sharedTag')) + '</em>' : '') +
        '<small>' + esc(fmtDate(r.date)) + ' · ' + esc(r.mode === 'team' ? t('tm_' + r.teamMode) : '') + '</small></span><span class="chev">›</span></button>';
    }
    var s = metricsOf(r).s;
    return '<button class="row" data-act="round:' + r.id + '"><span class="row-main"><strong>' + esc(r.courseName) + '</strong>' +
      (r.demo ? ' <em class="tag demo">' + esc(t('demo')) + '</em>' : '') +
      '<small>' + esc(fmtDate(r.date)) + ' · ' + esc(r.tee.name) + '</small></span>' +
      '<span class="row-num"><b>' + s.gross + '</b><small>' + s.points + ' p</small></span></button>';
  }

  // --- Väder ---
  var weatherLive = {}; // key -> {status, data}
  function wKey(lat, lon) { return lat.toFixed(3) + ',' + lon.toFixed(3); }
  function compass(deg) {
    var sv = ['N', 'NO', 'O', 'SO', 'S', 'SV', 'V', 'NV'], en = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    var i = Math.round(((deg % 360) / 45)) % 8;
    return (state.profile.lang === 'sv' ? sv : en)[i];
  }
  function fetchWeather(lat, lon) {
    var k = wKey(lat, lon);
    weatherLive[k] = { status: 'loading' };
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
      '&current=temperature_2m,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m' +
      '&hourly=temperature_2m,precipitation_probability,wind_speed_10m,wind_gusts_10m,wind_direction_10m' +
      '&daily=sunrise,sunset&wind_speed_unit=ms&timezone=auto&forecast_days=2';
    var timer = setTimeout(function () { if (weatherLive[k].status === 'loading') { weatherLive[k] = { status: 'error' }; render(); } }, 12000);
    try {
      fetch(url).then(function (r) { if (!r.ok) throw new Error('http'); return r.json(); }).then(function (d) {
        clearTimeout(timer);
        var data = { fetchedAt: new Date().toISOString(), d: d };
        weatherLive[k] = { status: 'ok' };
        state.weatherCache[k] = data; save(); render();
      }).catch(function () { clearTimeout(timer); weatherLive[k] = { status: location.protocol === 'file:' ? 'error' : 'blockedOrError' }; render(); });
    } catch (e) { clearTimeout(timer); weatherLive[k] = { status: 'blockedOrError' }; }
  }

  function weatherBlock(course) {
    var h = '<section class="block weather"><h3>' + esc(course ? t('weatherFor') + ' ' + course.name : t('weather')) + '</h3>';
    if (!course) {
      return h + '<p class="muted">' + esc(t('weatherNeedsPos')) + '</p><button class="btn ghost" data-act="weather-here">' + esc(t('useMyPosition')) + '</button>' + hereWeather() + '</section>';
    }
    return h + weatherBody(course.lat, course.lon) + '</section>';
  }
  var herePos = null;
  function hereWeather() { return herePos ? weatherBody(herePos.lat, herePos.lon) : ''; }

  function weatherBody(lat, lon) {
    var k = wKey(lat, lon), live = weatherLive[k], cache = state.weatherCache[k];
    var fresh = cache && (Date.now() - new Date(cache.fetchedAt).getTime() < 30 * 60 * 1000);
    if (!live && !fresh) { setTimeout(function () { fetchWeather(lat, lon); }, 0); live = { status: 'loading' }; }
    var h = '';
    if (cache) h += weatherCard(cache, live && live.status !== 'ok');
    if (live && live.status === 'loading' && !cache) h += '<p class="muted">…</p>';
    if (live && live.status === 'blockedOrError' && !cache) h += '<p class="muted">' + esc(t('weatherFailed')) + '</p><p class="note">' + esc(t('weatherBlocked')) + '</p>';
    if (live && (live.status === 'blockedOrError' || live.status === 'error')) h += '<button class="btn ghost" data-act="weather-retry:' + lat + ',' + lon + '">' + esc(t('retry')) + '</button>';
    return h;
  }

  function weatherCard(cache, stale) {
    var d = cache.d, c = d.current || {}, h = '';
    var dir = c.wind_direction_10m || 0;
    h += '<div class="wx-now"><div class="wx-temp">' + Math.round(c.temperature_2m) + '°</div>' +
      '<div class="wx-wind"><svg viewBox="0 0 24 24" class="arrow" style="transform:rotate(' + (dir + 180) + 'deg)" aria-hidden="true"><path d="M12 3l5 9h-3.5v9h-3v-9H7z"/></svg>' +
      '<div><b>' + dec(c.wind_speed_10m, 0) + ' m/s</b> ' + esc(compass(dir)) + '<small>' + esc(t('gusts')) + ' ' + dec(c.wind_gusts_10m, 0) + ' m/s</small></div></div></div>';
    var hr = d.hourly || {}, times = hr.time || [], now = Date.now(), cells = [];
    for (var i = 0; i < times.length && cells.length < 5; i++) {
      var tm = new Date(times[i]).getTime();
      if (tm >= now - 30 * 60 * 1000) {
        cells.push('<li><span>' + times[i].slice(11, 16) + '</span><b>' + Math.round(hr.temperature_2m[i]) + '°</b><small>' +
          dec(hr.wind_speed_10m[i], 0) + ' m/s</small><small>' + (hr.precipitation_probability[i] === null ? '–' : hr.precipitation_probability[i]) + ' %</small></li>');
      }
    }
    if (cells.length) h += '<p class="mini">' + esc(t('nextHours')) + ' · ' + esc(t('wind')) + ' · ' + esc(t('rainRisk')) + '</p><ul class="wx-hours">' + cells.join('') + '</ul>';
    var dl = d.daily || {};
    if (dl.sunrise && dl.sunrise[0]) h += '<p class="wx-sun">' + esc(t('sunrise')) + ' ' + dl.sunrise[0].slice(11, 16) + ' · ' + esc(t('sunset')) + ' ' + dl.sunset[0].slice(11, 16) + '</p>';
    h += '<p class="note">' + (stale ? esc(t('cachedWeather')) + ' · ' : '') + esc(t('updated')) + ' ' + new Date(cache.fetchedAt).toLocaleTimeString(state.profile.lang === 'sv' ? 'sv-SE' : 'en-GB', { hour: '2-digit', minute: '2-digit' }) + ' · Open-Meteo</p>';
    return h;
  }

  // --- Starta rond ---
  function viewSetup() {
    var s = view.setup, h = header(t('startRound'), s.fromPlay ? 'play-back-course' : 'tab:home');
    h += '<main class="page">';
    if (!profileReady()) return h + '<p class="muted">' + esc(t('needProfile')) + '</p><button class="btn gold" data-act="tab:profile">' + esc(t('navProfile')) + '</button></main>';
    if (s.fromPlay && courseById(s.courseId)) {
      var pc = courseById(s.courseId);
      h += '<section class="block"><div class="pickedcourse"><span><small>' + esc(t('pt_' + s.playType)) + '</small><b>' + esc(pc.name) + '</b></span><button class="chip" data-act="play-back-course">' + esc(t('change')) + '</button></div>';
      if (s.playType === 'match' && !(s.extra || []).length) h += '<p class="note">' + esc(t('matchNeedsPlayers')) + '</p>';
      if (s.training) h += '<p class="note">' + esc(t('trainingNote')) + '</p>';
    } else {
    h += '<section class="block"><h3>' + esc(t('chooseCourse')) + '</h3><div class="coursefind"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg><input data-field="setup.q" value="' + esc(view.setupQ || '') + '" placeholder="' + esc(t('searchCourses')) + '" autocorrect="off"></div><div id="setup-courses">' + courseList(s) + '</div><div class="choices" hidden>';
    [].forEach(function (c) {
      h += '<button class="choice' + (s.courseId === c.id ? ' on' : '') + '" data-act="pick-course:' + c.id + '"><strong>' + esc(c.name) + '</strong><small>' + esc(c.club || '') + '</small>' + badge(c) + '</button>';
    });
    h += '</div>';
    }
    h += '</section>';
    var c = s.courseId && courseById(s.courseId);
    if (c) {
      if (c.demo) h += '<p class="warn">' + esc(t('demoWarning')) + '</p>';
      var gender = playerGender(), mode = s.holesMode || '18';
      if (!gender) h += '<section class="block"><h3>' + esc(t('ratingGender')) + '</h3><p class="note">' + esc(t('genderWhy')) + '</p><div class="seg">' + ['men', 'women'].map(function (g) { return '<button data-act="p-gender:' + g + '">' + esc(genderName(g)) + '</button>'; }).join('') + '</div></section>';
      h += '<section class="block"><h3>' + esc(t('chooseTee')) + '</h3><div hidden>';
      [].forEach(function (te) {
      });
      h += '</div>' + teeRows(c, gender, mode, s.teeId, 'pick-tee') + '</section>';
      var te = s.teeId && c.tees.filter(function (x) { return x.id === s.teeId; })[0];
      if (te) {
        var allowance = s.allowance || state.profile.allowance;
        var snap = resolvedTee(te, gender, mode), hi = state.profile.hi, par = C.sumPar(snap.holes);
        var rated = !snap.unrated, nineM = mode !== '18';
        var exact = !rated ? 0 : nineM ? (hi / 2) * (snap.slope / 113) + (snap.cr - par) : C.courseHandicapExact(hi, snap.slope, snap.cr, par);
        var ch = !rated ? 0 : nineM ? C.courseHandicap9(hi, snap.slope, snap.cr, par) : C.courseHandicap(hi, snap.slope, snap.cr, par), ph = C.playingHandicap(ch, allowance);
        if (te.holes.length === 18 && !(s.extra || []).length) h += '<section class="block"><h3>' + esc(t('holesToPlay')) + '</h3><div class="seg">' + ['18', 'front9', 'back9'].map(function (m) { return seg('holesMode', m, t('hm_' + m), mode); }).join('') + '</div></section>';
        h += '<section class="block"><h3>' + esc(t('roundSummary')) + '</h3><dl class="kv">' +
          kv(t('courseName'), c.name) + kv(t('tee'), te.name + (te.color ? ' (' + te.color + ')' : '')) + kv(t('clubLen'), teeLength(te, mode) ? teeLength(te, mode) + ' m' : '–') +
          kv(t('ratingFor'), gender ? genderName(gender) + ' · ' + t('hm_' + mode) : t('chooseGenderShort')) +
          kv('Course Rating', rated ? dec(snap.cr) : '–') + kv('Slope Rating', rated ? String(snap.slope) : '–') + kv('Par', String(par)) +
          kv(t('handicapIndex'), C.formatHandicap(hi)) + kv(t('courseHcp'), rated ? String(ch) : '–') + kv(t('playingHcp'), rated ? String(ph) : '–') + '</dl>' +
          (rated && snap.ratingInfo ? '<p class="note">' + esc(snap.ratingInfo.official ? fmt(t('ratingSrcOfficial'), { g: genderName(gender), s: snap.ratingInfo.source || '', d: snap.ratingInfo.verifiedAt || '' }) : t('ratingSrcOwn')) + '</p>' : '') + '</section>';
        h += '<section class="block"><h3>' + esc(t('format')) + '</h3><div class="seg">' +
          seg('format', 'stroke', t('strokePlay'), s.format || 'stableford') + seg('format', 'stableford', t('stableford'), s.format || 'stableford') + '</div>' +
          '<h3>' + esc(t('allowance')) + '</h3><div class="seg">' + [100, 95, 90, 85].map(function (a) { return seg('allowance', a, a + ' %', allowance); }).join('') + '</div>' +
          '<p class="note">' + esc(t('allowanceHelp')) + '</p></section>';
        if (!rated) h += '<div class="warn">' + esc(fmt(t('unratedFor'), { tee: te.name, g: gender ? genderName(gender).toLowerCase() : '', h: t('hm_' + mode).toLowerCase() })) + '<br><small>' + esc(t('unratedWhat')) + '</small></div>'; else
        h += '<section class="block hcpcalc"><div class="big-pair"><div><span>' + ph + '</span><small>' + esc(t('playingHcp')) + '</small></div><div><span>' + ch + '</span><small>' + esc(t('courseHcp')) + '</small></div></div>' +
          '<p class="formula">' + (nineM ? '(' + esc(C.formatHandicap(hi)) + ' ÷ 2)' : esc(C.formatHandicap(hi))) + ' × ' + snap.slope + '/113 + (' + dec(snap.cr) + ' − ' + par + ') = ' + dec(exact, 2) + ' → ' + ch +
          (allowance !== 100 ? '<br>' + ch + ' × ' + allowance + ' % = ' + dec(ch * allowance / 100, 2) + ' → ' + ph : '') + '</p></section>';
        h += setupGroupHtml(c, te);
        var serr = setupErrors(c, te);
        h += '<button class="btn gold big" data-act="begin"' + (serr.length ? ' disabled' : '') + '>' + esc(t('start')) + '</button>';
      }
    }
    return h + '</main>';
  }
  function kv(k, v) { return '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>'; }
  function seg(field, val, label, cur) {
    return '<button class="' + (String(cur) === String(val) ? 'on' : '') + '" data-act="set-' + field + ':' + val + '">' + esc(label) + '</button>';
  }
  function badge(c) {
    if (c.demo) return '<em class="tag demo">' + esc(t('demo')) + '</em>';
    return c.verified ? '<em class="tag ok">' + esc(t('verified')) + '</em>' : '<em class="tag">' + esc(t('unverified')) + '</em>';
  }

  // --- Rond: hålvy ---
  function viewRound() {
    var r = activeRound();
    if (!r) {
      return header(t('navRound')) + '<main class="page"><section class="hero"><h2>' + esc(t('noActiveRound')) + '</h2><p>' + esc(t('noActiveText')) + '</p>' +
        '<button class="btn gold big" data-act="setup">' + esc(t('startRound')) + '</button></section>' +
        '<section class="block"><h3>' + esc(t('liveJoin')) + '</h3><p class="note">' + esc(t('liveJoinHelp')) + '</p><div class="addp bycode"><input data-field="live.code" autocapitalize="characters" autocorrect="off" maxlength="8" placeholder="ABCD2345" value="' + esc(view.liveCode || '') + '"><button class="btn ghost" data-act="live-join">' + esc(t('liveFollow')) + '</button></div></section></main>';
    }
    var s = C.summarizeRound(r, r.tee);
    var grp = isGroup(r);
    var h = '<header class="bar"><div class="bar-in"><span class="mark" aria-hidden="true"></span><h1>' + esc(r.courseName) + '</h1>' +
      (grp ? '' : '<button class="bar-btn" data-act="hole-mode">' + esc(view.holeMode === 'hole' ? t('toScorecard') : t('toHole')) + '</button>') + '</div></header>';
    if (r.mode === 'team') h += teamScorebar(r); else h += '<div class="scorebar"><div><b>' + s.gross + '</b><small>' + esc(t('gross')) + '</small></div><div><b>' + (s.played ? C.formatSigned(s.toPar) : '–') + '</b><small>' + esc(t('toPar')) + '</small></div>' +
      '<div><b>' + s.points + '</b><small>' + esc(t('points')) + '</small></div><div><b>' + s.playingHandicap + '</b><small>' + esc(t('playingHcp')) + '</small></div></div>';
    if (grp) h += '<div class="modetabs">' + [['hole', 'toHole'], ['card', 'toScorecard'], ['board', 'competition']].map(function (x) { return '<button class="' + (view.holeMode === x[0] ? 'on' : '') + '" data-act="mode:' + x[0] + '">' + esc(t(x[1])) + '</button>'; }).join('') + '</div>';
    if (r.demo) h += '<p class="warn tight">' + esc(t('demoWarning')) + '</p>';
    if (!C.teeRated(r.tee)) h += '<p class="warn tight">' + esc(t('unratedBar')) + '</p>';
    var body = view.holeMode === 'hole' ? holeView(r, s)
      : view.holeMode === 'board' ? liveControls(r) + board(r, true)
      : (r.mode === 'team' ? groupCard(r) + '<button class="btn gold big" data-act="finish">' + esc(t('finishRound')) + '</button>' : grp ? scorecard(r, s, false) + groupCard(r) + '<button class="btn gold big" data-act="finish">' + esc(t('finishRound')) + '</button>' : scorecard(r, s, true));
    h += '<main class="page play">' + body + '</main>';
    return h;
  }

  function holeView(r, s) {
    var i = r.current, hole = r.tee.holes[i], d = r.holes[i], rec = s.allocation[i];
    var h = '<section class="hole-head"><button class="navbtn" data-act="go:' + (i - 1) + '"' + (i === 0 ? ' disabled' : '') + ' aria-label="' + esc(t('prev')) + '">‹</button><div class="hole-no"><small>' + esc(t('hole')) + '</small><span>' + holeNo(r, i) + '</span></div>' +
      '<dl><div><dt>' + esc(t('par')) + '</dt><dd>' + hole.par + '</dd></div><div><dt>' + esc(t('si')) + '</dt><dd>' + hole.si + '</dd></div>' +
      '<div><dt>' + esc(t('length')) + '</dt><dd>' + (hole.length ? hole.length + ' m' : '–') + '</dd></div>' +
      '<div><dt>' + esc(t('received')) + '</dt><dd>' + (rec > 0 ? '+' + rec : rec) + '</dd></div></dl>' +
      '<button class="navbtn" data-act="go:' + (i + 1) + '"' + (i >= r.tee.holes.length - 1 ? ' disabled' : '') + ' aria-label="' + esc(t('next')) + '">›</button></section>';
    h += '<section id="gps-box" class="gps">' + gpsInner(r) + '</section>';

    if (r.mode === 'team') { h += teamEntries(r); } else {
    // Slag – ett tryck sätter resultatet
    h += '<div class="logtoggle"><button class="chip' + (state.ui.shotLog ? ' on' : '') + '" data-act="shotlog">' + esc(t('shotByShot')) + ': ' + esc(state.ui.shotLog ? t('on') : t('off')) + '</button></div>';
    if (state.ui.shotLog) h += shotLogger(r);
    var lo = Math.max(1, hole.par - 2), hi = hole.par + 3, cur = d.strokes;
    if (typeof cur === 'number' && cur > hi) hi = cur;
    h += '<section class="entry"><h3>' + esc(t('strokes')) + '</h3><div class="pick strokes">';
    for (var v = lo; v <= hi; v++) {
      var cls = v - hole.par;
      h += '<button class="' + (cur === v && !d.pickedUp ? 'on ' + (view.justSet === 'strokes:' + v ? 'pop ' : '') : '') + (cls < 0 ? 'under' : cls === 0 ? 'par' : 'over') + '" data-act="strokes:' + v + '">' + v + '</button>';
    }
    h += '<button class="more" data-act="strokes:' + ((typeof cur === 'number' ? Math.max(cur, hi) : hi) + 1) + '" aria-label="+1">+</button></div>' +
      '<button class="link' + (d.pickedUp ? ' on' : '') + '" data-act="pickup">' + esc(d.pickedUp ? t('pickedUp') + ' ✓' : t('pickUp')) + '</button></section>';

    // Puttar
    h += '<section class="entry"><h3>' + esc(t('putts')) + '</h3><div class="pick">';
    [0, 1, 2, 3, 4].forEach(function (p) { h += '<button class="' + (d.putts === p ? 'on' + (view.justSet === 'putts:' + p ? ' pop' : '') : '') + '" data-act="putts:' + p + '">' + p + (p === 4 ? '+' : '') + '</button>'; });
    h += '</div></section>';

    // Fairway (par 4 och 5)
    if (hole.par >= 4) {
      h += '<section class="entry"><h3>' + esc(t('fairway')) + '</h3><div class="pick three">' +
        ['left', 'hit', 'right'].map(function (f) { return '<button class="' + (d.fir === f ? 'on' : '') + '" data-act="fir:' + f + '">' + esc(f === 'left' ? '← ' + t('left') : f === 'right' ? t('right') + ' →' : t('hit')) + '</button>'; }).join('') +
        '</div></section>';
    }
    // GIR räknas ut när slag och puttar finns
    var girTxt = typeof d.gir === 'boolean' ? (d.gir ? t('yes') : t('no')) : '–';
    h += '<p class="gir">' + esc(t('gir')) + ': <b>' + esc(girTxt) + '</b> <small>(' + esc(t('girAuto')) + ')</small></p>';

    // Mer
    h += '<details class="extra"' + (view.extraOpen ? ' open' : '') + '><summary data-act="toggle-extra">' + esc(t('more')) + '</summary>' +
      counter(t('penalties'), 'penalties', d.penalties || 0) + counter(t('bunker'), 'bunker', d.bunker || 0);
    if (d.gir === false) {
      h += '<h3>' + esc(t('missedGreen')) + '</h3><div class="pick four">' + ['short', 'long', 'left', 'right'].map(function (m) {
        return '<button class="' + (d.miss === m ? 'on' : '') + '" data-act="miss:' + m + '">' + esc(t(m)) + '</button>';
      }).join('') + '</div>';
    }
    h += '</details>';
    if (r.extra && r.extra.length) h += otherEntries(r);
    }
    if (r.games && r.games.length) h += gamesPanel(r);

    // Navigering
    h += '<div class="holenav"><button class="btn ghost" data-act="go:' + (i - 1) + '"' + (i === 0 ? ' disabled' : '') + '>‹ ' + esc(t('prev')) + '</button>' +
      (i < r.tee.holes.length - 1 ? '<button class="btn gold" data-act="go:' + (i + 1) + '">' + esc(t('next')) + ' ›</button>'
        : '<button class="btn gold" data-act="finish">' + esc(t('finishRound')) + '</button>') + '</div>';
    h += '<div class="dots" aria-hidden="true">' + r.tee.holes.map(function (_, k) {
      var dd = r.holes[k]; var has = typeof dd.strokes === 'number' || dd.pickedUp;
      return '<button tabindex="-1" class="' + (k === i ? 'cur ' : '') + (has ? 'done' : '') + '" data-act="go:' + k + '">' + holeNo(r, k) + '</button>';
    }).join('') + '</div>';
    h += '<button class="link danger" data-act="discard">' + esc(t('discardRound')) + '</button>';
    return h;
  }

  function counter(label, field, val) {
    return '<div class="counter"><span>' + esc(label) + '</span><button data-act="dec:' + field + '" aria-label="−">−</button><b>' + val + '</b><button data-act="inc:' + field + '" aria-label="+">+</button></div>';
  }

  // --- Scorekort ---
  function scorecard(r, s, live) {
    var holes = r.tee.holes;
    function cellScore(k) {
      var d = r.holes[k];
      if (d.pickedUp) return '<td class="sc pu">–</td>';
      if (typeof d.strokes !== 'number') return '<td class="sc"></td>';
      var diff = d.strokes - holes[k].par;
      var cls = diff <= -2 ? 'eagle' : diff === -1 ? 'birdie' : diff === 1 ? 'bogey' : diff >= 2 ? 'dbl' : '';
      return '<td class="sc"><span class="' + cls + '">' + d.strokes + '</span></td>';
    }
    function half(from, to, label) {
      var rows = { no: '', par: '', si: '', rec: '', sc: '', pts: '', putt: '' }, parSum = 0, scSum = 0, ptSum = 0, puSum = 0;
      for (var k = from; k < to; k++) {
        var d = r.holes[k], rec = s.allocation[k];
        rows.no += '<th' + (live ? ' data-act="go-hole:' + k + '"' : '') + '>' + holeNo(r, k) + '</th>';
        rows.par += '<td>' + holes[k].par + '</td>'; parSum += holes[k].par;
        rows.si += '<td>' + holes[k].si + '</td>';
        rows.rec += '<td class="rec">' + (rec > 0 ? '<i>' + new Array(rec + 1).join('•') + '</i>' : rec < 0 ? '<i>−</i>' : '') + '</td>';
        rows.sc += cellScore(k); if (typeof d.strokes === 'number' && !d.pickedUp) scSum += d.strokes;
        var p = (typeof d.strokes === 'number' || d.pickedUp) ? C.stablefordPoints(d.pickedUp ? null : d.strokes, holes[k].par, rec) : '';
        rows.pts += '<td>' + p + '</td>'; if (p !== '') ptSum += p;
        rows.putt += '<td>' + (typeof d.putts === 'number' ? d.putts : '') + '</td>'; if (typeof d.putts === 'number') puSum += d.putts;
      }
      return '<div class="sc-wrap"><table class="card"><tbody>' +
        '<tr class="hd"><th class="lbl">' + esc(t('hole')) + '</th>' + rows.no + '<th>' + esc(label) + '</th></tr>' +
        '<tr><th class="lbl">' + esc(t('par')) + '</th>' + rows.par + '<td><b>' + parSum + '</b></td></tr>' +
        '<tr class="dim"><th class="lbl">' + esc(t('si')) + '</th>' + rows.si + '<td></td></tr>' +
        '<tr class="dim"><th class="lbl">' + esc(t('received')) + '</th>' + rows.rec + '<td></td></tr>' +
        '<tr class="score"><th class="lbl">' + esc(t('strokes')) + '</th>' + rows.sc + '<td><b>' + scSum + '</b></td></tr>' +
        '<tr><th class="lbl">' + esc(t('putts')) + '</th>' + rows.putt + '<td>' + puSum + '</td></tr>' +
        '<tr><th class="lbl">' + esc(t('points')) + '</th>' + rows.pts + '<td><b>' + ptSum + '</b></td></tr>' +
        '</tbody></table></div>';
    }
    var h = holes.length === 9 ? half(0, 9, t('total')) : half(0, 9, t('out')) + half(9, 18, t('in'));
    h += '<p class="note">' + esc(t('receivedLegend')) + '</p>';
    h += '<dl class="totals"><div><dt>' + esc(t('gross')) + '</dt><dd>' + s.gross + '</dd></div><div><dt>' + esc(t('net')) + '</dt><dd>' + s.net + '</dd></div>' +
      '<div><dt>' + esc(t('points')) + '</dt><dd>' + s.points + '</dd></div><div><dt>' + esc(t('putts')) + '</dt><dd>' + s.putts + '</dd></div>' +
      '<div><dt>' + esc(t('firPct')) + '</dt><dd>' + s.firHit + '/' + s.firTot + '</dd></div><div><dt>' + esc(t('girPct')) + '</dt><dd>' + s.girHit + '/' + s.girTot + '</dd></div></dl>';
    h += diffBlock(r, s);
    if (live) h += '<button class="btn gold big" data-act="finish">' + esc(t('finishRound')) + '</button>';
    return h;
  }

  function viewRoundDetail(id) {
    var r = state.rounds.filter(function (x) { return x.id === id; })[0];
    if (!r) { view.sub = null; return viewStats(); }
    var s = C.summarizeRound(r, r.tee);
    var h = header(r.courseName, 'back-stats') + '<main class="page">';
    if (r.demo) h += '<p class="warn">' + esc(t('demoWarning')) + '</p>';
    if (r.shared) h += '<p class="warn">' + esc(t('sharedNote')) + '</p>';
    h += '<p class="meta">' + esc(fmtDate(r.date)) + ' · ' + esc(t('tee')) + ' ' + esc(r.tee.name) + ' · CR ' + dec(r.tee.cr) + ' / ' + r.tee.slope +
      ' · ' + esc(t('playingHcp')) + ' ' + s.playingHandicap + ' (' + r.allowance + ' %)</p>';
    h += coachCard(r);
    if (r.mode !== 'team') h += scorecard(r, s, false);
    if (isGroup(r)) h += '<h3 class="gc-h">' + esc(t('competition')) + '</h3>' + board(r, false) + groupCard(r).replace(/ data-act="go-hole:\d+"/g, '');
    h += '<button class="link danger" data-act="delete-round:' + r.id + '">' + esc(t('deleteRound')) + '</button></main>';
    return h;
  }

  // --- Banor ---
  function viewCourses() {
    if (view.sub === 'find') return viewFind();
    if (view.sub === 'dir') return viewDirectory();
    if (view.sub === 'loops' && view.loopPick) return viewLoopPick();
    var h = header(t('courses')) + '<main class="page"><button class="btn gold big" data-act="dir">' + esc(t('allSweden')) + (dir ? ' (' + dir.items.length + ')' : '') + '</button>' +
      '<button class="btn ghost wide" data-act="new-course">' + esc(t('addManual')) + '</button><section class="block">';
    var clubCount = {};
    state.courses.forEach(function (c) { if (c.club) clubCount[RT.fold(c.club)] = (clubCount[RT.fold(c.club)] || 0) + 1; });
    var lastClub = null;
    state.courses.slice().sort(function (a, b) { return (a.club || a.name).localeCompare(b.club || b.name, 'sv') || a.name.localeCompare(b.name, 'sv'); }).forEach(function (c) {
      var ck = c.club && clubCount[RT.fold(c.club)] > 1 ? RT.fold(c.club) : null;
      if (ck && ck !== lastClub) h += '<p class="grp-h">' + esc(c.club) + ' · ' + esc(fmt(t('nCourses'), { n: clubCount[ck] })) + '</p>';
      lastClub = ck;
      h += '<button class="row' + (ck ? ' sub' : '') + '" data-act="edit-course:' + c.id + '"><span class="row-main"><strong>' + esc(ck && c.courseLabel ? c.courseLabel : c.name) + '</strong> ' + badge(c) +
        (c.geo ? ' <em class="tag ok">GPS ' + G.coverage(c.geo).holes + '/18</em>' : '') + (c.tees.some(function (x) { return !C.teeRated(x); }) ? ' <em class="tag">' + esc(t('noRatingTag')) + '</em>' : '') + '<small>' + esc(c.club || '') + ' · ' + c.tees.length + ' tee' + (c.tees.length === 1 ? '' : 's') + '</small></span><span class="chev">›</span></button>';
    });
    return h + '</section></main>';
  }

  function blankTee() {
    var holes = []; for (var i = 0; i < 18; i++) holes.push({ par: 4, si: i + 1, length: null });
    return { id: uid(), name: '', cr: null, slope: null, holes: holes };
  }

  function viewCourseEdit() {
    var c = view.draft, h = header(c.isNew ? t('addCourse') : t('editCourse'), 'back-courses') + '<main class="page form">';
    if (c.demo) h += '<p class="warn">' + esc(t('demoWarning')) + '</p>';
    if (view.errors.length) h += '<div class="errors" role="alert"><b>' + esc(t('fixErrors')) + '</b><ul>' + view.errors.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></div>';
    h += field(t('courseName'), 'c.name', c.name) + field(t('club'), 'c.club', c.club);
    h += '<div class="two">' + field(t('latitude'), 'c.lat', c.lat, 'decimal') + field(t('longitude'), 'c.lon', c.lon, 'decimal') + '</div>' +
      '<p class="note">' + esc(t('coordsHelp')) + '</p><button class="btn ghost" data-act="course-here">' + esc(t('useMyPosition')) + '</button>';
    h += geoSection(c);
    c.tees.forEach(function (te, ti) {
      h += '<fieldset class="tee"><legend>' + esc(te.name || t('tee') + ' ' + (ti + 1)) + '</legend>' +
        field(t('teeName'), 't' + ti + '.name', te.name) +
        (te.official ? officialTable(te) : '<div class="two">' + field(t('cr'), 't' + ti + '.cr', te.cr, 'decimal') + field(t('slope'), 't' + ti + '.slope', te.slope, 'numeric') + '</div>');
      if (!te.official) h += '<label class="check"><input type="checkbox" data-field="t' + ti + '.unrated"' + (te.unrated ? ' checked' : '') + '> <span>' + esc(t('unratedCheck')) + '<small class="note block-note">' + esc(t('unratedHelp')) + '</small></span></label>';
      if (ti > 0) h += '<button class="link" data-act="copy-tee:' + ti + '">' + esc(t('copyFrom')) + ' ' + esc(c.tees[0].name || t('tee') + ' 1') + '</button>';
      h += '<div class="sc-wrap"><table class="holes-edit"><thead><tr><th>' + esc(t('hole')) + '</th><th>' + esc(t('par')) + '</th><th>' + esc(t('si')) + '</th><th>' + esc(t('length')) + ' (m)</th></tr></thead><tbody>';
      te.holes.forEach(function (ho, hi) {
        h += '<tr><th>' + (hi + 1) + '</th>' +
          '<td><input inputmode="numeric" data-field="t' + ti + '.h' + hi + '.par" value="' + esc(ho.par) + '" aria-label="' + esc(t('par')) + ' ' + (hi + 1) + '"></td>' +
          '<td><input inputmode="numeric" data-field="t' + ti + '.h' + hi + '.si" value="' + esc(ho.si) + '" aria-label="' + esc(t('si')) + ' ' + (hi + 1) + '"></td>' +
          '<td><input inputmode="numeric" data-field="t' + ti + '.h' + hi + '.length" value="' + esc(ho.length === null ? '' : ho.length) + '" aria-label="' + esc(t('length')) + ' ' + (hi + 1) + '"></td></tr>';
      });
      h += '</tbody></table></div>' + (c.tees.length > 1 ? '<button class="link danger" data-act="remove-tee:' + ti + '">' + esc(t('delete')) + ' ' + esc(te.name || t('tee')) + '</button>' : '') + '</fieldset>';
    });
    h += '<button class="btn ghost" data-act="add-tee">' + esc(t('addTee')) + '</button>';
    if (!c.demo) h += '<label class="check"><input type="checkbox" data-field="c.verified"' + (c.verified ? ' checked' : '') + '> <span>' + esc(t('verifiedCheck')) + '</span></label>';
    h += '<div class="holenav"><button class="btn ghost" data-act="back-courses">' + esc(t('cancel')) + '</button><button class="btn gold" data-act="save-course">' + esc(t('save')) + '</button></div>';
    if (!c.isNew) h += '<button class="link danger" data-act="delete-course">' + esc(t('delete')) + '</button>';
    return h + '</main>';
  }
  function officialTable(te) {
    var rows = [];
    ['men', 'women'].forEach(function (g) { ['18', 'front9', 'back9'].forEach(function (m) { var r = te.ratings && te.ratings[g] && te.ratings[g][m]; if (r) rows.push('<tr><td>' + esc(genderName(g)) + '</td><td>' + esc(t('hm_' + m)) + '</td><td>' + dec(r.cr) + '</td><td>' + r.slope + '</td><td>' + r.par + '</td></tr>'); }); });
    return '<div class="official"><p><em class="tag ok">' + esc(t('officialTag')) + '</em> ' + esc(te.source || '') + ' · ' + esc(t('verifiedDate')) + ' ' + esc(te.verifiedAt || '') + '</p>' +
      '<div class="sc-wrap"><table class="lb"><thead><tr><th>' + esc(t('genderShort')) + '</th><th>' + esc(t('holesShortH')) + '</th><th>CR</th><th>Slope</th><th>Par</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>' +
      '<p class="note">' + esc(t('officialLocked')) + '</p></div>';
  }
  function field(label, key, val, mode) {
    return '<label class="field"><span>' + esc(label) + '</span><input data-field="' + key + '" value="' + esc(val === null || val === undefined ? '' : val) + '"' + (mode ? ' inputmode="' + mode + '"' : '') + '></label>';
  }

  // --- Statistik ---
  function viewStats() {
    if (view.sub === 'round') return viewRoundDetail(view.param);
    var rounds = doneRounds(), sums = rounds.filter(function (r) { return r.mode !== 'team' && !r.shared; }).map(function (r) { return metricsOf(r).s; });
    var n = state.ui.statsN, a = C.aggregate(sums, n);
    var h = header(t('stats')) + '<main class="page">';
    if (rounds.length) h += statsDash(rounds, n);
    h += '<h3 class="seg-h">' + esc(t('lastN')) + ' … ' + esc(t('rounds')) + '</h3><div class="seg">' + [5, 10, 20, 50].map(function (x) { return '<button class="' + (n === x ? 'on' : '') + '" data-act="statsn:' + x + '">' + x + '</button>'; }).join('') + '</div>';
    if (!rounds.length) {
      h += '<p class="muted">' + esc(t('noRounds')) + '</p>';
    } else {
      h += '<dl class="kpis">' + kpi(t('firPct'), a.firPct === null ? '–' : Math.round(a.firPct) + ' %') + kpi(t('girPct'), a.girPct === null ? '–' : Math.round(a.girPct) + ' %') + kpi(t('avgPen'), dec(a.avgPen)) + '</dl>';
      h += '<p class="note">' + esc(a.rounds) + ' ' + esc(t('rounds')) + '</p>';
      var ownR = rounds.filter(function (r) { return r.mode !== 'team' && !r.shared; });
      h += statsExtra(ownR, n) + sgSection(ownR);
      h += '<p class="note">' + esc(t('strokesGainedNote')) + '</p>';
      h += matchHistory(rounds);
      var lim = view.histAll ? rounds.length : 30;
      h += '<section class="block"><h3>' + esc(t('history')) + '</h3>' + rounds.slice(0, lim).map(roundRow).join('') +
        (rounds.length > lim ? '<button class="btn ghost wide" data-act="hist-all">' + esc(fmt(t('showAll'), { n: rounds.length })) + '</button>' : '') + '</section>';
    }
    h += '<label class="check"><input type="checkbox" data-field="ui.showDemo"' + (state.ui.showDemo ? ' checked' : '') + '> <span>' + esc(t('showDemo')) + '</span></label>';
    return h + '</main>';
  }
  function kpi(l, v) { return '<div><dt>' + esc(l) + '</dt><dd>' + esc(v) + '</dd></div>'; }
  function trendChart(list) {
    if (list.length < 2) return '<p class="muted">' + esc(t('noData')) + '</p>';
    var W = 320, H = 140, pad = 22, max = Math.max.apply(null, list.map(function (s) { return s.points; }).concat([36])) + 2, min = Math.max(0, Math.min.apply(null, list.map(function (s) { return s.points; })) - 4);
    var step = (W - pad * 2) / (list.length - 1);
    function y(v) { return H - pad - (v - min) / (max - min) * (H - pad * 2); }
    var pts = list.map(function (s, i) { return (pad + i * step).toFixed(1) + ',' + y(s.points).toFixed(1); });
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(t('trend')) + '">' +
      '<line x1="' + pad + '" x2="' + (W - pad) + '" y1="' + y(36) + '" y2="' + y(36) + '" class="ref"/><text x="' + (W - pad) + '" y="' + (y(36) - 4) + '" class="reflbl">36</text>' +
      '<polyline points="' + pts.join(' ') + '" class="line"/>' +
      list.map(function (s, i) { return '<circle cx="' + (pad + i * step) + '" cy="' + y(s.points) + '" r="3.5" class="pt"/>'; }).join('') + '</svg>';
  }

  // --- Profil ---
  function viewProfile() {
    var p = state.profile, h = header(t('profile')) + '<main class="page form">';
    h += field(t('name'), 'p.name', p.name);
    h += '<label class="field"><span>' + esc(t('handicapIndex')) + '</span><input data-field="p.hi" inputmode="decimal" value="' + esc(p.hi === null ? '' : C.formatHandicap(p.hi)) + '"></label>';
    h += '<p class="note">' + esc(view.hiError ? t('hiInvalid') : t('hiHelp')) + '</p>';
    h += field(t('homeClub'), 'p.homeClub', p.homeClub);
    h += '<h3>' + esc(t('ratingGender')) + '</h3><div class="seg">' + ['men', 'women'].map(function (g) { return '<button class="' + (p.gender === g ? 'on' : '') + '" data-act="p-gender:' + g + '">' + esc(genderName(g)) + '</button>'; }).join('') + '</div><p class="note">' + esc(t('genderWhy')) + '</p>';
    h += '<h3>' + esc(t('defaultAllowance')) + '</h3><div class="seg">' + [100, 95].map(function (a) { return '<button class="' + (p.allowance === a ? 'on' : '') + '" data-act="p-allowance:' + a + '">' + a + ' %</button>'; }).join('') + '</div>';
    h += '<h3>' + esc(t('language')) + '</h3><div class="seg"><button class="' + (p.lang === 'sv' ? 'on' : '') + '" data-act="lang:sv">Svenska</button><button class="' + (p.lang === 'en' ? 'on' : '') + '" data-act="lang:en">English</button></div>';
    h += '<h3>' + esc(t('theme')) + '</h3><div class="seg">' + ['auto', 'light', 'dark'].map(function (x) {
      return '<button class="' + (p.theme === x ? 'on' : '') + '" data-act="theme:' + x + '">' + esc(t(x === 'auto' ? 'themeAuto' : x === 'light' ? 'themeLight' : 'themeDark')) + '</button>';
    }).join('') + '</div>';
    h += '<h3>' + esc(t('gpsData')) + '</h3><label class="check"><input type="checkbox" data-field="ui.gpsAuto"' + (state.ui.gpsAuto ? ' checked' : '') + '> <span>' + esc(t('gpsAutoLbl')) + '</span></label>' +
      '<label class="check"><input type="checkbox" data-field="ui.sat"' + (state.ui.sat ? ' checked' : '') + '> <span>' + esc(t('satellite')) + '<small class="note block-note">' + esc(t('satHelp')) + '</small></span></label>' +
      '<p class="note">' + esc(t('testModeHelp')) + '</p><button class="btn ghost" data-act="' + (gps.test ? 'test-off' : 'test-on') + '">' + esc(gps.test ? t('testOff') : t('testModeStart')) + '</button>';
    if (profileReady() && !activeRound()) h += '<button class="btn gold big" data-act="setup">' + esc(t('startRound')) + '</button>';

    h += cloudSection();
    h += '<section class="block"><h3>' + esc(t('adminTitle')) + '</h3><p class="note">' + esc(t('adminIntro')) + '</p><button class="btn ghost" data-act="admin-open">' + esc(t('adminOpen')) + '</button></section>';
    h += bagSection();
    h += '<section class="block"><h3>' + esc(t('myCode')) + '</h3><p class="note">' + esc(t('myCodeHelp')) + '</p>' + (profileReady() ? '<p class="code">' + esc(myCode()) + '</p><button class="btn ghost" data-act="share-code">' + esc(t('shareCode')) + '</button>' : '<p class="muted">' + esc(t('needProfile')) + '</p>') + '</section>';
    if (state.friends.length) h += '<section class="block"><h3>' + esc(t('friends')) + '</h3>' + state.friends.map(function (f) { return '<div class="pl"><span class="pl-n"><b>' + esc(f.name) + '</b><small>' + esc(t('handicapIndex')) + ' ' + esc(C.formatHandicap(f.hi)) + '</small></span><button class="chip" data-act="fdel:' + f.id + '">' + esc(t('remove')) + '</button></div>'; }).join('') + '</section>';
    h += '<section class="block"><h3>' + esc(t('tests')) + '</h3><button class="btn ghost" data-act="run-tests">' + esc(t('runTests')) + '</button>';
    if (view.tests) {
      var ok = view.tests.filter(function (x) { return x.ok; }).length;
      h += '<p class="' + (ok === view.tests.length ? 'pass' : 'fail') + '">' + ok + ' / ' + view.tests.length + ' ' + esc(t('testsPassed')) + '</p><ul class="testlist">' +
        view.tests.map(function (x) { return '<li class="' + (x.ok ? 'ok' : 'bad') + '">' + (x.ok ? '✓ ' : '✗ ') + esc(x.name) + (x.ok ? '' : ' – ' + esc(JSON.stringify(x.actual))) + '</li>'; }).join('') + '</ul>';
    }
    h += '</section>';
    h += '<section class="block"><h3>' + esc(t('backup')) + '</h3><p class="note">' + esc(t('exportHelp')) + '</p>' +
      '<div class="holenav"><button class="btn ghost" data-act="export">' + esc(t('exportData')) + '</button><label class="btn ghost file">' + esc(t('importData')) + '<input type="file" accept="application/json,.json" data-field="import"></label></div>' +
      '<button class="link danger" data-act="clear">' + esc(t('clearAll')) + '</button></section>';
    h += '<section class="block"><h3>' + esc(t('about')) + '</h3><p class="note">' + esc(t('aboutText')) + '</p></section>';
    return h + '</main>';
  }

  // ---------- Render ----------
  var appEl;
  function render() {
    applyTheme();
    var body;
    if (view.tab === 'live' && live.viewer) body = viewLive();
    else if (view.tab === 'shared' && view.shared) body = viewShared();
    else if (view.tab === 'play' && view.play) body = viewPlay();
    else if (view.tab === 'home') body = view.sub === 'setup' ? viewSetup() : viewHome3();
    else if (view.tab === 'round') body = view.sub === 'setup' ? viewSetup() : viewRound();
    else if (view.tab === 'courses') body = view.sub === 'edit' ? viewCourseEdit() : viewCourses();
    else if (view.tab === 'stats') body = viewStats();
    else body = view.sub === 'setup' ? viewSetup() : view.sub === 'admin' ? viewAdmin() : viewProfile();
    var warn = storageOk ? '' : '<p class="warn tight">Lagringen är full eller blockerad – exportera dina data.</p>';
    appEl.className = view.tab === 'play' ? 'playmode' : '';
    var vkey = view.tab + ':' + (view.sub || '') + ':' + (view.holeMode || '');
    var entering = vkey !== view.lastVkey; view.lastVkey = vkey;
    appEl.innerHTML = body + warn + flash() + (view.tab === 'play' ? '' : nav2());
    if (entering) { var mn = appEl.querySelector('main'); if (mn) mn.classList.add('enter'); }
    manageTimers();
    var inPlay = view.tab === 'round' && !view.sub && activeRound() && view.holeMode === 'hole';
    if (inPlay) {
      gps.lastRender = Date.now(); gps.boxKey = boxKeyFor(activeRound()); updateMapDynamic(false);
      if (!document.hidden && gps.status !== 'denied' && (gps.test || state.ui.gpsAuto) && (gps.test ? !gps.watchdog : gps.watchId === null)) gpsStart();
      acquireWake();
    } else if (gps.watchId !== null || gps.watchdog) gpsStop();
    else releaseWake();
    if (view.flash) { var f = view.flash; setTimeout(function () { if (view.flash === f) { view.flash = null; var el = appEl.querySelector('.flash'); if (el) el.remove(); } }, 1800); }
  }

  function updateHole(fn) {
    var r = activeRound(); if (!r) return;
    var d = r.holes[r.current], par = r.tee.holes[r.current].par;
    fn(d);
    if (typeof d.strokes === 'number' && typeof d.putts === 'number' && !d.pickedUp) {
      d.gir = (d.strokes - d.putts) <= par - 2;
      if (d.gir) delete d.miss;
    } else if (d.pickedUp) { d.gir = false; } else { delete d.gir; }
    r.updatedAt = new Date().toISOString();
    save(); render();
  }

  function getPos(cb, onErr) {
    if (!navigator.geolocation) { view.flash = t('gpsUnavailable'); if (onErr) onErr(); render(); return; }
    navigator.geolocation.getCurrentPosition(function (p) { cb(p.coords.latitude, p.coords.longitude); },
      function (e) { if (onErr) onErr(); view.flash = e.code === 1 ? (state.profile.lang === 'sv' ? 'Platsåtkomst nekad. Tillåt plats för appen i telefonens inställningar.' : 'Location access denied. Allow location for this app in your phone settings.') : (state.profile.lang === 'sv' ? 'Positionen kunde inte hämtas.' : 'Position could not be found.'); render(); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }

  // ---------- Händelser ----------
  function onAct(act) {
    var parts = act.split(':'), a = parts[0], v = parts.slice(1).join(':');
    var r = activeRound();
    switch (a) {
      case 'tab': view.tab = v; view.sub = null; view.errors = []; view.find = { status: 'idle', results: [] }; window.scrollTo(0, 0); break;
      case 'setup': view.sub = 'setup'; view.setup = { allowance: state.profile.allowance, format: 'stableford', extra: [], games: {}, teamOf: {}, add: {}, mode: 'own' }; window.scrollTo(0, 0); break;
      case 'pick-course': view.setup.courseId = v; var pc = courseById(v); view.setup.teeId = pc && pc.tees.length === 1 ? pc.tees[0].id : null; break;
      case 'pick-tee': view.setup.teeId = v; break;
      case 'set-format': view.setup.format = v; break;
      case 'set-allowance': view.setup.allowance = +v; break;
      case 'set-holesMode': view.setup.holesMode = v; break;
      case 'p-gender': state.profile.gender = v; save(); break;
      case 'xg': { var xgp = v.split(':'); view.setup.extra[+xgp[0]].gender = xgp[1]; break; }
      case 'begin': {
        var c = courseById(view.setup.courseId); var te = c.tees.filter(function (x) { return x.id === view.setup.teeId; })[0];
        var hmode = view.setup.holesMode || '18', snapT = resolvedTee(te, playerGender(), hmode);
        var holes = snapT.holes.map(function () { return {}; });
        state.rounds.push({ id: uid(), status: 'active', date: new Date().toISOString(), courseId: c.id, courseName: c.name, demo: !!c.demo, holeOffset: snapT.offset || 0, nine: hmode === '18' ? null : hmode,
          tee: snapT, hi: state.profile.hi, allowance: view.setup.allowance || 100, format: view.setup.format || 'stableford', holes: holes, current: 0 });
        if (setupErrors(c, te).length) { state.rounds.pop(); return; }
        beginGroup(state.rounds[state.rounds.length - 1], c, te);
        if (view.setup.training) state.ui.shotLog = true;
        gps.target = null; gps.suggest = null; gps.lastAuto = null; save(); view.tab = 'round'; view.sub = null; view.holeMode = 'hole'; window.scrollTo(0, 0); break;
      }
      case 'strokes': view.justSet = act; setTimeout(function () { view.justSet = null; }, 300); updateHole(function (d) { d.strokes = +v; d.pickedUp = false; if (typeof d.putts === 'number' && d.putts > d.strokes) d.putts = d.strokes; }); return;
      case 'pickup': updateHole(function (d) { d.pickedUp = !d.pickedUp; if (d.pickedUp) delete d.strokes; }); return;
      case 'putts': view.justSet = act; setTimeout(function () { view.justSet = null; }, 300); updateHole(function (d) { d.putts = +v; if (typeof d.strokes === 'number' && d.strokes < d.putts) d.strokes = d.putts; }); return;
      case 'fir': updateHole(function (d) { d.fir = d.fir === v ? undefined : v; }); return;
      case 'miss': updateHole(function (d) { d.miss = d.miss === v ? undefined : v; }); return;
      case 'inc': updateHole(function (d) { d[v] = (d[v] || 0) + 1; }); return;
      case 'dec': updateHole(function (d) { d[v] = Math.max(0, (d[v] || 0) - 1); }); return;
      case 'toggle-extra': view.extraOpen = !view.extraOpen; break;
      case 'go': if (r) { r.current = Math.max(0, Math.min(r.tee.holes.length - 1, +v)); gps.target = null; gps.suggest = null; gps.lastAuto = r.current; save(); window.scrollTo(0, 0); } break;
      case 'gps-start': state.ui.gpsAuto = true; save(); gpsStop(); gps.status = 'off'; gpsStart(); refreshGps(); return;
      case 'clear-target': gps.target = null; refreshGps(); return;
      case 'map-follow': gps.mv.follow = !gps.mv.follow; refreshGps(true); updateMapDynamic(true); return;
      case 'map-center': { var xc = r && holeCtx(r); if (xc && xc.me && !xc.fromTee) { var ft = followTransform(xc.me); gps.mv.k = ft.k; gps.mv.tx = ft.tx; gps.mv.ty = ft.ty; applyMapTransform(true); updateMapDynamic(false); } return; }
      case 'wake': state.ui.wakeLock = !state.ui.wakeLock; save(); if (state.ui.wakeLock) acquireWake(); else releaseWake(); refreshGps(true); return;
      case 'test-on': setTestMode(true); render(); return;
      case 'test-off': setTestMode(false); render(); return;
      case 'tmove': { var tm = v.split(':'); testMove(+tm[0], +tm[1]); return; }
      case 'ttee': { var xt = r && holeCtx(r); if (xt && xt.hole) { gpsF.reset(); gps.simOffset += 1000; var tp = teePoint(xt.hole); ingest({ lat: tp[0], lon: tp[1], acc: 4, ts: gpsNow() }); } return; }
      case 'tnoise': { if (!gps.pos) return; var base = [gps.pos.lat, gps.pos.lon]; for (var ni = 0; ni < 6; ni++) { gps.simOffset += 1000; var np2 = G.offsetPoint(base, Math.random() * 360, Math.random() * 2.5, 0); ingest({ lat: np2[0], lon: np2[1], acc: 5, ts: gpsNow(), speed: 0 }); } return; }
      case 'tlose': gps.errSinceFix = true; gps.simOffset += 20000; refreshGps(); return;
      case 'greg-open': view.gregOpen = true; refreshGps(true); return;
      case 'greg-close': view.gregOpen = false; view.gregTap = null; refreshGps(true); return;
      case 'greg-pos': if (gps.pos && gpsQ() === 'good' && gps.pos.acc <= 10) { saveGreenPoint(v, [gps.pos.lat, gps.pos.lon], gps.test ? 'test' : 'gps'); refreshGps(true); render(); } return;
      case 'greg-tap': view.gregTap = view.gregTap === v ? null : v; refreshGps(true); return;
      case 'greg-del': { var xd = r && holeCtx(r); if (xd && xd.hole && xd.hole.userGreen) { delete xd.hole.userGreen[v]; save(); refreshGps(true); } return; }
      case 'map-toggle': state.ui.mapOpen = !state.ui.mapOpen; save(); refreshGps(); return;
      case 'zoom': view.mapZoom = v; gps.mv.follow = false; gps.mv.key = null; refreshGps(true); return;
      case 'sim': setTestMode(!gps.test); render(); return;
      case 'find': view.sub = 'find'; view.find = { status: 'idle', results: [], link: false }; window.scrollTo(0, 0); break;
      case 'link-geo': view.sub = 'dir'; view.dirLink = true; view.dirQ = view.draft.name || ''; view.find = { status: 'idle', results: [], link: true }; window.scrollTo(0, 0); break;
      case 'dir': view.sub = 'dir'; view.dirLink = false; view.find = { status: 'idle', results: [], link: false }; window.scrollTo(0, 0); break;
      case 'back-dir': view.sub = view.dirLink ? 'edit' : null; view.dirLink = false; break;
      case 'dir-load': fetchDirectory(); return;
      case 'dir-near': getPos(function (lat, lon) { dirState.pos = [lat, lon]; render(); }); return;
      case 'dir-pick': {
        var dp = v.split(':'), it = dir && dir.items.filter(function (x) { return x.t === dp[0] && String(x.id) === dp[1]; })[0];
        if (!it) return;
        var dcl = clubOfItem(it), dEntry = dcl && dcl.courses.filter(function (e) { return e.item === it; })[0], dMany = dcl && dcl.courses.length > 1;
        view.find = { status: 'loading', msg: t('geoLoading'), results: [{ name: it.n, osmType: it.t, osmId: it.id, lat: it.lat, lon: it.lon, bounds: it.b,
          clubName: dcl ? dcl.name : it.n, clubKey: dcl ? dcl.key : null, label: dEntry ? dEntry.label : null, fullName: dMany ? fullCourseName(dcl.name, dEntry.label, true) : null }], link: !!view.dirLink };
        window.scrollTo(0, 0); pickOsm(0); return;
      }
      case 'back-find': view.sub = view.find.link ? 'edit' : null; break;
      case 'dir-club': view.dirOpen = view.dirOpen === v ? null : v; { var dlc = document.getElementById('dir-list'); if (dlc) { dlc.innerHTML = dirListHtml(); return; } } break;
      case 'find-near': findNearby(); return;
      case 'find-search': searchCourses(view.find.q); return;
      case 'pick-osm': pickOsm(+v); return;
      case 'remove-geo': if (confirm(t('removeGeoConfirm'))) { delete view.draft.geo; } else return; break;
      case 'update-geo': {
        var ref = (view.draft.geo.osmRef || '').split('/');
        if (ref.length !== 2) return;
        view.find = { status: 'loading', results: [{ name: view.draft.geo.name || view.draft.name, osmType: ref[0], osmId: ref[1], lat: view.draft.lat || 0, lon: view.draft.lon || 0, bounds: boundsOfGeo(view.draft.geo) }], link: true };
        pickOsm(0); return;
      }
      case 'go-hole': if (r) { r.current = +v; view.holeMode = 'hole'; save(); window.scrollTo(0, 0); } break;
      case 'mode': view.holeMode = v; window.scrollTo(0, 0); break;
      case 'smode': view.setup.mode = v; if (v === 'team' && !view.setup.teamMode) view.setup.teamMode = 'scramble2'; break;
      case 'stmode': view.setup.teamMode = v; break;
      case 'tm': { var pv = v.split(':'); if (pv[1] === '–') delete view.setup.teamOf[pv[0]]; else view.setup.teamOf[pv[0]] = pv[1]; break; }
      case 'gtog': {
        var gs = view.setup.games, cfg = gs[v] || (gs[v] = {});
        cfg.on = !cfg.on;
        if (cfg.on && (v === 'match' || v === 'nassau') && !cfg.sideA) {
          var tms = setupTeams(), opts = tms.length >= 2 ? [tms[0].id, tms[1].id] : ['me', view.setup.extra[0].id];
          cfg.sideA = opts[0]; cfg.sideB = opts[1];
        }
        break;
      }
      case 'gal': { var pa = v.split(':'); view.setup.games[pa[0]].allowance = pa[1] === 'auto' ? undefined : +pa[1]; break; }
      case 'gsc': { var ps2 = v.split(':'); view.setup.games[ps2[0]].scoring = ps2[1]; break; }
      case 'xdel': { var gone = view.setup.extra.splice(+v, 1)[0]; if (gone) delete view.setup.teamOf[gone.id]; break; }
      case 'xtee': { var px = v.split(':'); view.setup.extra[+px[0]].teeId = px[1]; break; }
      case 'xfriend': { var f = state.friends.filter(function (x) { return x.id === v; })[0]; if (f) view.setup.extra.push({ id: uid(), name: f.name, hi: f.hi, teeId: view.setup.teeId }); break; }
      case 'xadd': {
        var ad = view.setup.add, hiV = C.parseHandicapIndex(ad.hi || '');
        if (!String(ad.name || '').trim() || hiV === null) { view.setup.addErr = t('addErr'); break; }
        view.setup.extra.push({ id: uid(), name: ad.name.trim().slice(0, 40), hi: hiV, teeId: view.setup.teeId });
        view.setup.add = {}; view.setup.addErr = null; break;
      }
      case 'xcode': {
        var pc2 = readCode(view.setup.add.code);
        if (!pc2) { view.setup.addErr = t('badCode'); break; }
        view.setup.extra.push({ id: uid(), name: pc2.name, hi: pc2.hi, teeId: view.setup.teeId }); view.setup.add = {}; view.setup.addErr = null; break;
      }
      case 'ps': { var pp2 = v.split(':'); var pl = r.extra[+pp2[0]]; stepScore(pl.holes[r.current], pl.tee.holes[r.current].par, +pp2[1]); save(); render(); return; }
      case 'pp': { var pl2 = r.extra[+v], d2 = pl2.holes[r.current]; d2.pickedUp = !d2.pickedUp; if (d2.pickedUp) delete d2.strokes; save(); render(); return; }
      case 'ts': { var tp = v.split(':'), tm2 = r.teams.filter(function (x) { return x.id === tp[0]; })[0]; stepScore(r.teamHoles[tp[0]][r.current], teamTee(r, tm2).holes[r.current].par, +tp[1]); save(); render(); return; }
      case 'tp': { var d3 = r.teamHoles[v][r.current]; d3.pickedUp = !d3.pickedUp; if (d3.pickedUp) delete d3.strokes; save(); render(); return; }
      case 'share': {
        var rr = state.rounds.filter(function (x) { return x.id === v; })[0] || view.shared; if (!rr) return;
        shareText(t('sharedTitle') + ' – ' + rr.courseName, baseUrl() + '#m' + b64e(JSON.stringify(packRound(rr)))); return;
      }
      case 'close-shared': view.shared = null; view.tab = 'home'; clearHash(); break;
      case 'save-shared': state.rounds.push(view.shared); save(); view.flash = t('saved'); view.shared = null; view.tab = 'stats'; clearHash(); break;
      case 'share-code': shareText(t('myCode'), myCode()); return;
      case 'fdel': state.friends = state.friends.filter(function (x) { return x.id !== v; }); save(); break;
      case 'shotlog': state.ui.shotLog = !state.ui.shotLog; save(); break;
      case 'sl-lie': shotDraft(r).lie = v; if (v === 'green') shotDraft(r).club = null; break;
      case 'sl-club': { var sdc = shotDraft(r); sdc.club = sdc.club === v ? null : v; break; }
      case 'sl-pen': { var sdp = shotDraft(r); sdp.pen = (sdp.pen || 0) >= 2 ? 0 : (sdp.pen || 0) + 1; break; }
      case 'sl-gps': {
        var cg = courseById(r.courseId), hg = cg && cg.geo && cg.geo.holes[String(holeNo(r, r.current))];
        if (!gps.pos || !hg) return;
        var gdd = G.greenDistances([gps.pos.lat, gps.pos.lon], hg.green, greenCenter(hg));
        shotDraft(r).dist = String(Math.round(gdd.mid)); break;
      }
      case 'sl-add': case 'sl-holed': {
        var sd2 = shotDraft(r), shot = draftShot(sd2), dd = r.holes[r.current];
        view.shotErr = null;
        if (a === 'sl-add' && !shot) { view.shotErr = t('shotDistErr'); break; }
        if (a === 'sl-holed' && !shot && !(dd.shots && dd.shots.length)) { view.shotErr = t('shotDistErr'); break; }
        updateHole(function (d) {
          d.shots = d.shots || [];
          if (shot) d.shots.push(shot);
          if (a === 'sl-holed') { d.holed = true; syncFromShots(d); }
        });
        view.shot = { round: r.id, hole: r.current, lie: shot && shot.lie === 'green' ? 'green' : 'fairway', dist: '', club: null, pen: 0 };
        render(); return;
      }
      case 'shot-undo': {
        updateHole(function (d) {
          if (d.holed) { d.holed = false; return; }
          var last = d.shots.pop();
          if (last) view.shot = { round: r.id, hole: r.current, lie: last.lie, dist: String(last.dist), club: last.club || null, pen: last.pen || 0 };
        });
        return;
      }
      case 'metric': state.ui.trendMetric = v; save(); break;
      case 'hist-all': view.histAll = true; break;
      case 'sgbase': state.ui.sgBase = v; save(); break;
      case 'baseline-del': if (confirm(t('removeBaselineConfirm'))) { state.baseline = null; state.ui.sgBase = 'personal'; save(); } else return; break;
      case 'bag-add': state.bag.push({ id: uid(), name: t('club'), carry: null }); save(); break;
      case 'bag-std': state.bag = STD_BAG.map(function (n2) { return { id: uid(), name: n2, carry: null, putter: n2 === 'Putter' }; }); save(); break;
      case 'bag-del': state.bag = state.bag.filter(function (c) { return c.id !== v; }); save(); break;
      case 'cloud-save': {
        var u = cleanUrl(cloudForm.url), k = String(cloudForm.key || '').trim();
        if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(u)) { cloudForm.err = t('badUrl'); break; }
        if (!/^[A-Za-z0-9._-]{30,}$/.test(k)) { cloudForm.err = t('badKey'); break; }
        cloud.url = u; cloud.key = k; cloud.synced = {}; cloud.lastPull = null; cloud.session = null; saveCloud(); cloudForm.err = null; pullShared(true); break;
      }
      case 'cloud-forget': cloud = { url: '', key: '', session: null, synced: {}, lastPull: null }; saveCloud(); cloudForm = { email: '', code: '', sent: false }; break;
      case 'cloud-otp': {
        var em = String(cloudForm.email || '').trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { cloudForm.err = t('badEmail'); break; }
        cloudForm.busy = true; cloudForm.err = null; render();
        sbFetch('/auth/v1/otp', { method: 'POST', body: JSON.stringify({ email: em, create_user: true }) }, false)
          .then(function () { cloudForm.sent = true; view.flash = t('codeSent'); }, function (e) { cloudForm.err = e.message; })
          .then(function () { cloudForm.busy = false; render(); });
        return;
      }
      case 'cloud-verify': {
        cloudForm.busy = true; cloudForm.err = null; render();
        sbFetch('/auth/v1/verify', { method: 'POST', body: JSON.stringify({ type: 'email', email: String(cloudForm.email).trim(), token: String(cloudForm.code).trim() }) }, false)
          .then(function (d) { setSession(d); cloud.synced = {}; cloud.lastPull = null; saveCloud(); cloudForm = { email: '', code: '', sent: false }; view.flash = t('signedInFlash'); return syncNow(true).then(function () { return pullShared(true); }); }, function (e) { cloudForm.err = e.message; })
          .then(function () { cloudForm.busy = false; render(); });
        return;
      }
      case 'cloud-sync': syncNow(true); return;
      case 'cloud-out': {
        if (!confirm(t('signOutConfirm'))) return;
        var sess = cloud.session;
        cloud.session = null; cloud.synced = {}; cloud.lastPull = null; cloud.lastSync = null; saveCloud();
        if (sess) httpJson(cloud.url + '/auth/v1/logout', { method: 'POST', headers: { apikey: cloud.key, Authorization: 'Bearer ' + sess.access } }).catch(function () {});
        break;
      }
      case 'live-start': if (r) startLive(r); return;
      case 'live-share': if (r && r.live) shareText(t('liveTitle') + ' – ' + r.courseName, liveLink(r.live.code)); return;
      case 'live-join': {
        var lc = String(view.liveCode || '').trim().toUpperCase();
        if (!SY.validCode(lc)) { view.flash = t('badLiveCode'); break; }
        if (!cloudReady()) { view.flash = t('liveNeedCloud'); break; }
        openViewer({ url: cloud.url, key: cloud.key }, lc); break;
      }
      case 'live-me': live.viewer.me = v; live.viewer.hole = 0; break;
      case 'live-hole': live.viewer.hole = +v; break;
      case 'lv': case 'lvp': {
        var lvv = live.viewer, lp = lvv.round.extra.filter(function (x) { return x.id === lvv.me; })[0]; if (!lp) return;
        var ld = lp.holes[lvv.hole];
        if (a === 'lvp') { ld.pickedUp = !ld.pickedUp; if (ld.pickedUp) delete ld.strokes; }
        else stepScore(ld, lp.tee.holes[lvv.hole].par, +v.split(':').pop());
        viewerSend(); return;
      }
      case 'live-close': live.viewer = null; view.tab = 'home'; clearHash(); break;
      case 'live-save': { var lr = clone(live.viewer.round); lr.id = uid(); lr.status = 'done'; state.rounds.push(lr); save(); live.viewer = null; view.tab = 'stats'; clearHash(); view.flash = t('saved'); break; }
      case 'play': view.play = { step: 'type', type: 0, idx: 0, pos: (view.play && view.play.pos) || null }; view.tab = 'play'; view.sub = null; window.scrollTo(0, 0); break;
      case 'play-exit': view.tab = 'home'; view.sub = null; view.playResume = null; break;
      case 'ptype': view.play.type = (view.play.type + (+v) + PLAY_TYPES.length) % PLAY_TYPES.length; break;
      case 'play-type-ok': startPlayCourseStep(); window.scrollTo(0, 0); break;
      case 'play-back': if (view.play.search) view.play.search = false; else view.play.step = 'type'; break;
      case 'pcourse': view.play.idx = Math.max(0, view.play.idx + (+v)); view.play.teeId = null; view.play.err = null; view.play.sel = null; view.play.loopPick = null; break;
      case 'psel': view.play.sel = v; view.play.teeId = null; view.play.err = null; break;
      case 'pclub': { var pcl = dirClubs().filter(function (x) { return x.key === v; })[0]; if (pcl) { view.play.pinnedClub = pcl; view.play.pinnedId = 'c:' + pcl.key; view.play.idx = 0; view.play.search = false; view.play.sel = null; view.play.teeId = null; } break; }
      case 'padd-course': {
        var pc1 = curCandidate(); if (!pc1) return;
        view.draft = { isNew: true, id: uid(), name: pc1.name + ' – ', club: pc1.name, clubKey: pc1.clubKey || null, lat: pc1.lat, lon: pc1.lon, verified: false, tees: [manualTee()] };
        view.errors = []; view.playResume = PLAY_TYPES[view.play.type]; view.tab = 'courses'; view.sub = 'edit'; view.flash = t('addCourseFlash'); window.scrollTo(0, 0); break;
      }
      case 'ploop': {
        var lpk = view.play && view.play.loopPick ? view.play.loopPick : view.loopPick; if (!lpk) return;
        var nc = courseFromLoop(lpk, v.split(','));
        if (view.play) view.play.loopPick = null; view.loopPick = null;
        finishCourse(nc, lpk.from); break;
      }
      case 'ploop-all': {
        var lpa = view.play && view.play.loopPick ? view.play.loopPick : view.loopPick; if (!lpa) return;
        var made = 0, skipped = 0;
        lpa.geo.loops.forEach(function (l) { var c1 = courseFromLoop(lpa, [l.id]); if (osmComplete(c1.geo)) { state.courses.push(c1); made++; } else skipped++; });
        save(); view.flash = fmt(t('loopsSaved'), { n: made }) + (skipped ? ' ' + fmt(t('loopsSkipped'), { n: skipped }) : '');
        if (view.play) { view.play.loopPick = null; view.play.sel = null; } view.loopPick = null; break;
      }
      case 'ploop-cancel': if (view.play) view.play.loopPick = null; view.loopPick = null; if (view.tab === 'courses') view.sub = null; break;
      case 'pcourse-to': { var lst = playCandidates(); for (var pi = 0; pi < lst.length; pi++) if (lst[pi].id === v) view.play.idx = pi; view.play.teeId = null; view.play.sel = null; view.play.loopPick = null; break; }
      case 'ptee': view.play.teeId = v; break;
      case 'play-search': view.play.search = true; break;
      case 'play-search-close': view.play.search = false; break;
      case 'psaved': {
        var sc = courseById(v); if (!sc) break;
        var cands0 = playCandidates(), hit = cands0.filter(function (cd) { return cd.courses.some(function (e) { return e.kind === 'saved' && e.course.id === sc.id; }); })[0];
        if (hit) { view.play.pinnedId = hit.id; view.play.idx = 0; view.play.sel = 's:' + sc.id; }
        view.play.search = false; view.play.teeId = null; break;
      }
      case 'pdir': { var pd = v.split(':'), pit = (dir ? dir.items : near.items || []).filter(function (x) { return x.t === pd[0] && String(x.id) === pd[1]; })[0]; if (pit) { view.play.pinned = { kind: 'dir', id: pit.t + ':' + pit.id, name: pit.n, sub: pit.c, lat: pit.lat, lon: pit.lon, it: pit }; view.play.idx = 0; view.play.search = false; } break; }
      case 'play-details': { var pl0 = selEntry(curCandidate()); if (pl0 && pl0.kind === 'saved') { view.tab = 'courses'; onAct('edit-course:' + pl0.course.id); return; } break; }
      case 'play-go': playGo(); return;
      case 'play-nomap': playNoMap(); break;
      case 'play-pos-retry': requestPlayPos(); break;
      case 'geo-retry': {
        var gc = r && courseById(r.courseId); if (!gc || !gc.osm || view.geoBusy) return;
        view.geoBusy = true; refreshGps(true);
        fetchCourseGeo({ name: gc.name, osmType: gc.osm.type, osmId: gc.osm.id, bounds: gc.osm.bounds }, { force: true }).then(function (geo) {
          if (Object.keys(geo.holes).length) { gc.geo = geo; save(); view.flash = geo.fromCache ? fmt(t('usingCache'), { d: fmtDate(geo.cachedAt) }) : t('geoLoaded'); }
          else view.flash = t('noHolesInOsm');
        }, function (e) { view.flash = errText(e); }).then(function () { view.geoBusy = false; render(); });
        return;
      }
      case 'play-cancel': view.play.busy = false; clearInterval(view.play.ticker); break;
      case 'play-retry': near.key = null; if (view.play.pos) fetchNearby(view.play.pos); if (!dir) fetchDirectory(); return;
      case 'play-back-course': if (view.play) { view.tab = 'play'; view.sub = null; view.play.step = 'course'; } else { view.tab = 'home'; view.sub = null; } break;
      case 'admin-open': view.tab = 'profile'; view.sub = 'admin'; adminUi.err = null; window.scrollTo(0, 0); break;
      case 'admin-close': view.sub = null; break;
      case 'adm-lock': adminUi.unlocked = false; adminUi.pin = ''; break;
      case 'adm-setpin': {
        if (!/^\d{4,8}$/.test(adminUi.pin)) { adminUi.err = t('pinRule'); break; }
        if (adminUi.pin !== adminUi.pin2) { adminUi.err = t('pinMismatch'); break; }
        sha(adminUi.pin).then(function (hh) { state.admin = { pinHash: hh }; save(); adminUi.unlocked = true; adminUi.err = null; adminUi.pin = adminUi.pin2 = ''; render(); });
        return;
      }
      case 'adm-unlock': sha(adminUi.pin).then(function (hh) { adminUi.unlocked = hh === state.admin.pinHash; adminUi.err = adminUi.unlocked ? null : t('pinWrong'); adminUi.pin = ''; render(); }); return;
      case 'adm-sec': adminUi.sec = v; adminUi.err = null; if (v === 'shared') checkAdmin(); window.scrollTo(0, 0); break;
      case 'adm-combo': adminUi.combo = adminUi.combo === v ? null : v; break;
      case 'adm-editrow': { var er = effLib().filter(function (x) { return RT.rowKey(x) === v; })[0]; if (er) { adminUi.form = {}; Object.keys(er).forEach(function (k2) { adminUi.form[k2] = er[k2] === null || er[k2] === undefined ? '' : String(er[k2]); }); adminUi.form.holeData = er.holeData; adminUi.sec = 'edit'; window.scrollTo(0, 0); } break; }
      case 'adm-delrow': if (confirm(t('deleteRowConfirm'))) { state.ratingLib = (state.ratingLib || []).filter(function (x) { return RT.rowKey(x) !== v; }); save(); applyRatings(); } else return; break;
      case 'admf-g': adminUi.form.gender = v; break;
      case 'admf-h': adminUi.form.holes = v; break;
      case 'adm-saverow': {
        var nr = RT.normalizeRow(adminUi.form, new Date().toISOString().slice(0, 10));
        if (nr.errors.length) { adminUi.err = t('fixErrors') + ' ' + nr.errors.map(function (k2) { return t('fld_' + k2); }).join(', '); break; }
        state.ratingLib = RT.mergeLibrary(state.ratingLib || [], [nr.row], new Date().toISOString()).lib; save(); applyRatings();
        adminUi.err = null; adminUi.form = null; adminUi.sec = 'tables'; adminUi.combo = RT.comboKey(nr.row); view.flash = t('saved'); break;
      }
      case 'adm-import': runImport(adminUi.importText); break;
      case 'adm-export': shareFile('slopetabell-' + new Date().toISOString().slice(0, 10) + '.csv', libCsv(), 'text/csv'); return;
      case 'adm-pull': pullShared(false); return;
      case 'adm-push': pushShared(); return;
      case 'fav': { var fv = state.favCourses = state.favCourses || [], fi = fv.indexOf(v); if (fi >= 0) fv.splice(fi, 1); else fv.push(v); save(); var sc2 = document.getElementById('setup-courses'); if (sc2 && view.setup) { sc2.innerHTML = courseList(view.setup); return; } break; }
      case 'play-again': { var pc0 = courseById(v); if (pc0) { view.play = { step: 'course', type: 0, idx: 0, pos: null }; goSetupFromPlay(pc0, null); } break; }
      case 'sat-toggle': state.ui.sat = !state.ui.sat; save(); gps.boxKey = null; refreshGps(true); return;
      case 'hole-mode': view.holeMode = view.holeMode === 'hole' ? 'card' : 'hole'; window.scrollTo(0, 0); break;
      case 'finish': {
        if (!r) break;
        var lists = r.mode === 'team' ? Object.keys(r.teamHoles).map(function (k) { return r.teamHoles[k]; }) : [r.holes].concat((r.extra || []).map(function (p) { return p.holes; }));
        var missing = 0; lists.forEach(function (l) { missing += l.filter(function (d) { return typeof d.strokes !== 'number' && !d.pickedUp; }).length; });
        if (!confirm(t('finishConfirm') + (missing ? '\n' + missing + ' ' + t('unplayed') : ''))) return;
        r.status = 'done'; r.finishedAt = new Date().toISOString(); gps.target = null; if (gps.test) setTestMode(false); save();
        view.tab = 'stats'; view.sub = 'round'; view.param = r.id; view.flash = t('saved'); window.scrollTo(0, 0); break;
      }
      case 'discard': if (r && confirm(t('discardConfirm'))) { gps.target = null; if (gps.test) setTestMode(false); state.rounds = state.rounds.filter(function (x) { return x !== r; }); save(); view.tab = 'home'; } else return; break;
      case 'round': view.tab = 'stats'; view.sub = 'round'; view.param = v; window.scrollTo(0, 0); break;
      case 'back-stats': view.sub = null; break;
      case 'delete-round': if (confirm(t('deleteRoundConfirm'))) { state.rounds = state.rounds.filter(function (x) { return x.id !== v; }); save(); view.sub = null; } else return; break;
      case 'statsn': state.ui.statsN = +v; save(); break;
      case 'weather-here': getPos(function (lat, lon) { herePos = { lat: lat, lon: lon }; render(); }); return;
      case 'weather-retry': { var ll = v.split(','); fetchWeather(+ll[0], +ll[1]); break; }
      case 'new-course': view.sub = 'edit'; view.errors = []; view.draft = { isNew: true, id: uid(), name: '', club: '', lat: null, lon: null, verified: false, tees: [blankTee()] }; window.scrollTo(0, 0); break;
      case 'edit-course': view.sub = 'edit'; view.errors = []; view.draft = JSON.parse(JSON.stringify(courseById(v))); window.scrollTo(0, 0); break;
      case 'back-courses': view.sub = null; view.draft = null; view.errors = []; break;
      case 'add-tee': view.draft.tees.push(blankTee()); break;
      case 'remove-tee': view.draft.tees.splice(+v, 1); break;
      case 'copy-tee': { var src = view.draft.tees[0], dst = view.draft.tees[+v]; dst.holes.forEach(function (ho, i) { ho.par = src.holes[i].par; ho.si = src.holes[i].si; }); break; }
      case 'course-here': getPos(function (lat, lon) { view.draft.lat = +lat.toFixed(5); view.draft.lon = +lon.toFixed(5); render(); }); return;
      case 'save-course': {
        var d = view.draft, errs = [];
        if (!String(d.name || '').trim()) errs.push(t('courseName'));
        d.tees.forEach(function (te) {
          C.validateTee(te).forEach(function (e) { errs.push((te.name || t('tee')) + ': ' + e); });
        });
        if ((d.lat === null) !== (d.lon === null) || (d.lat !== null && (Math.abs(d.lat) > 90 || Math.abs(d.lon) > 180))) errs.push(t('latitude') + '/' + t('longitude'));
        if (errs.length) { view.errors = errs; window.scrollTo(0, 0); break; }
        var isNew = d.isNew; delete d.isNew;
        if (isNew) state.courses.push(d); else state.courses = state.courses.map(function (c) { return c.id === d.id ? d : c; });
        save(); view.sub = null; view.draft = null; view.errors = []; view.flash = t('saved');
        if (view.playResume && view.play) { var savedC = isNew ? state.courses[state.courses.length - 1] : courseById(d.id); view.playResume = null; goSetupFromPlay(savedC, savedC.tees[0].id); }
        break;
      }
      case 'delete-course': if (confirm(t('deleteConfirm'))) { state.courses = state.courses.filter(function (c) { return c.id !== view.draft.id; }); save(); view.sub = null; view.draft = null; } else return; break;
      case 'p-allowance': state.profile.allowance = +v; save(); break;
      case 'lang': state.profile.lang = v; save(); break;
      case 'theme': state.profile.theme = v; save(); break;
      case 'run-tests': view.tests = window.runCoreTests(C, window.Geo, window.Games, window.Stats, window.Sync, window.Ratings, window.Net); break;
      case 'export': {
        var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
        var fname = 'banboken-' + new Date().toISOString().slice(0, 10) + '.json';
        try {
          var file = new File([blob], fname, { type: 'application/json' });
          if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: fname }).catch(function () {}); return; }
        } catch (e) { /* faller tillbaka till nedladdning */ }
        var aEl = document.createElement('a'); aEl.href = URL.createObjectURL(blob); aEl.download = fname; document.body.appendChild(aEl); aEl.click(); aEl.remove();
        return;
      }
      case 'clear': if (confirm(t('clearConfirm'))) { cloud.session = null; cloud.synced = {}; cloud.lastPull = null; saveCloud(); var lang = state.profile.lang; state = defaultState(); state.profile.lang = lang; save(); view = { tab: 'home', setup: {}, errors: [], holeMode: 'hole' }; } else return; break;
      default: return;
    }
    render();
  }

  function onField(el) {
    var key = el.getAttribute('data-field'), val = el.type === 'checkbox' ? el.checked : el.value;
    if (key === 'import') {
      var f = el.files && el.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var s = JSON.parse(rd.result);
          if (!s || s.version !== 1 || !Array.isArray(s.rounds) || !Array.isArray(s.courses)) throw new Error('format');
          state = s; save(); state = load(); view.flash = t('importDone');
        } catch (e) { view.flash = t('importFailed'); }
        render();
      };
      rd.readAsText(f); return;
    }
    if (key === 'ui.showDemo') { state.ui.showDemo = val; save(); render(); return; }
    if (key === 'ui.sat' || key === 'ui.gpsAuto') { state.ui[key.slice(3)] = val; save(); render(); return; }
    if (key === 'find.q') { view.find.q = val; return; }
    if (key.indexOf('add.') === 0) { view.setup.add[key.slice(4)] = val; return; }
    if (key.indexOf('cloud.') === 0) { cloudForm[key.slice(6)] = val; return; }
    if (key === 'live.code') { view.liveCode = val; return; }
    if (key === 'setup.q') { if (view.setupQ === val) return; view.setupQ = val; var scl = document.getElementById('setup-courses'); if (scl && view.setup) scl.innerHTML = courseList(view.setup); return; }
    if (key === 'play.q') { if (view.play.q === val) return; view.play.q = val; var pr = document.getElementById('play-results'); if (pr) pr.innerHTML = playResults(); return; }
    if (key === 'dir.q') { if (view.dirQ === val) return; view.dirQ = val; var dl = document.getElementById('dir-list'); if (dl) dl.innerHTML = dirListHtml(); return; }
    if (key === 'adm.pin' || key === 'adm.pin2') { adminUi[key.slice(4)] = val; return; }
    if (key === 'adm.text') { adminUi.importText = val; return; }
    if (key.indexOf('admf.') === 0) { adminUi.form[key.slice(5)] = val; return; }
    if (key.indexOf('adm.link:') === 0) {
      var lc = courseById(key.slice(9)); if (!lc) return;
      if (val) lc.ratingLink = val; else delete lc.ratingLink;
      save(); applyRatings(); render(); return;
    }
    if (key === 'adm.file') { var af = el.files && el.files[0]; if (!af) return; var ar2 = new FileReader(); ar2.onload = function () { adminUi.importText = String(ar2.result || ''); runImport(adminUi.importText); render(); }; ar2.readAsText(af); return; }
    if (key.indexOf('pcc:') === 0) {
      var pr = state.rounds.filter(function (x) { return x.id === key.slice(4); })[0]; if (!pr) return;
      if (val === '') delete pr.pcc; else pr.pcc = +val;
      if (typeof mCache !== 'undefined' && mCache) mCache.delete(pr);
      save(); render(); return;
    }
    if (key === 'sd.dist') { var ar = activeRound(); if (ar) shotDraft(ar).dist = val; return; }
    if (key.indexOf('bag.') === 0) {
      var bp = key.split('.'), bc = state.bag.filter(function (c) { return c.id === bp[1]; })[0];
      if (bc) { if (bp[2] === 'carry') { var cv = parseInt(val, 10); bc.carry = isFinite(cv) && cv > 0 && cv < 400 ? cv : null; } else bc.name = String(val).slice(0, 20) || bc.name; save(); }
      return;
    }
    if (key === 'baseline-import') {
      var bf = el.files && el.files[0]; if (!bf) return;
      var br = new FileReader();
      br.onload = function () {
        try {
          var b = JSON.parse(br.result);
          if (!ST.validateBaseline(b)) throw new Error('format');
          b.name = String(b.name || t('importedName')).slice(0, 40);
          state.baseline = { name: b.name, source: String(b.source || '').slice(0, 200), lies: b.lies };
          state.ui.sgBase = 'imported'; save(); view.flash = t('baselineDone');
        } catch (e) { view.flash = t('baselineFailed'); }
        render();
      };
      br.readAsText(bf); return;
    }
    if (key.indexOf('gside:') === 0) { var gp = key.split(':'); view.setup.games[gp[1]][gp[2]] = val; render(); return; }
    if (key === 'gcarry:skins') { view.setup.games.skins.carryover = val; render(); return; }
    if (key.indexOf('p.') === 0) {
      var pk = key.slice(2);
      if (pk === 'hi') {
        var hi = C.parseHandicapIndex(val);
        view.hiError = val.trim() !== '' && hi === null;
        if (!view.hiError && hi !== state.profile.hi) {
          state.profile.hi = hi;
          if (hi !== null) {
            var hh = state.profile.hiHistory = state.profile.hiHistory || [], today = new Date().toISOString().slice(0, 10);
            if (hh.length && hh[hh.length - 1].d === today) hh[hh.length - 1].hi = hi; else hh.push({ d: today, hi: hi });
            if (hh.length > 120) hh.splice(0, hh.length - 120);
          }
        }
      } else state.profile[pk] = val;
      save(); render(); return;
    }
    var d = view.draft; if (!d) return;
    if (key.indexOf('c.') === 0) {
      var ck = key.slice(2);
      if (ck === 'lat' || ck === 'lon') d[ck] = String(val).trim() === '' ? null : num(val);
      else d[ck] = val;
      return; // ingen omritning medan man skriver
    }
    var m = key.match(/^t(\d+)\.(?:h(\d+)\.)?(\w+)$/);
    if (m) {
      var te = d.tees[+m[1]];
      if (m[2] !== undefined) {
        var hv = String(val).trim() === '' ? null : parseInt(val, 10);
        te.holes[+m[2]][m[3]] = isFinite(hv) ? hv : null;
      } else if (m[3] === 'name') te.name = val;
      else if (m[3] === 'unrated') te.unrated = !!val;
      else te[m[3]] = String(val).trim() === '' ? null : num(val);
    }
  }

  function init() {
    appEl = document.getElementById('app');
    document.addEventListener('click', function (e) {
      var el = e.target.closest('[data-act]');
      if (!el || el.disabled) return;
      if (el.tagName === 'SUMMARY') e.preventDefault();
      onAct(el.getAttribute('data-act'));
    });
    document.addEventListener('change', function (e) { if (e.target.hasAttribute('data-field')) onField(e.target); });
    document.addEventListener('input', function (e) {
      var k = e.target.getAttribute('data-field');
      if (k && (k.indexOf('c.') === 0 || /^t\d/.test(k) || k === 'find.q' || k.indexOf('add.') === 0 || k === 'sd.dist' || k.indexOf('cloud.') === 0 || k === 'live.code' || k === 'dir.q' || k === 'play.q' || k === 'setup.q' || k === 'adm.pin' || k === 'adm.pin2' || k === 'adm.text' || (k && k.indexOf('admf.') === 0))) onField(e.target);
    });
    window.addEventListener('pagehide', save);
    document.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.getAttribute && e.target.getAttribute('data-field') === 'find.q') { view.find.q = e.target.value; searchCourses(view.find.q); } });
    document.addEventListener('pointerdown', onMapDown);
    document.addEventListener('pointermove', onMapMove);
    document.addEventListener('pointerup', onMapUp);
    document.addEventListener('pointercancel', onMapUp);
    document.addEventListener('error', function (e) {
      var el = e.target;
      if (el && el.tagName === 'image' && el.closest && el.closest('svg.holemap') && !satFailed) { satFailed = true; refreshGps(); }
    }, true);
    window.addEventListener('online', function () { satFailed = false; });
    // Webbappar får ingen GPS i bakgrunden: spårningen stoppas när appen döljs och startar om när den visas.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { if (!gps.test) gpsStop(); releaseWake(); return; }
      if (view.tab === 'play' && view.play && view.play.step === 'course' && Date.now() - (view.play.posAt || 0) > 10 * 60000) requestPlayPos();
      render();
    });
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', render);
    }
    if ('serviceWorker' in navigator && location.protocol === 'https:' && !/claude|anthropic/.test(location.hostname)) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
    var sx = null;
    document.addEventListener('touchstart', function (e) { var el = e.target.closest && e.target.closest('[data-swipe]'); sx = el ? { x: e.touches[0].clientX, y: e.touches[0].clientY, k: el.getAttribute('data-swipe') } : null; }, { passive: true });
    document.addEventListener('touchend', function (e) {
      if (!sx) return; var dx = e.changedTouches[0].clientX - sx.x, dy = e.changedTouches[0].clientY - sx.y, k = sx.k; sx = null;
      if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return;
      onAct((k === 'type' ? 'ptype:' : 'pcourse:') + (dx < 0 ? 1 : -1));
    }, { passive: true });
    applyRatings();
    if (cloudReady()) setTimeout(function () { pullShared(true).then(function () { render(); }); }, 2500);
    setInterval(function () { syncNow(false); }, 60000);
    window.addEventListener('online', function () { syncNow(false); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) syncNow(false); });
    setTimeout(function () { syncNow(false); }, 1500);
    checkHash();
    window.addEventListener('hashchange', function () { checkHash(); render(); });
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
