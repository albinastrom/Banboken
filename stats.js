/* Banboken – analys (etapp 4): slagloggar, utökad statistik, Strokes Gained och regelbaserad coach.
   Slag: { lie: tee|fairway|rough|sand|recovery|green, dist: meter kvar till hål före slaget, club?, pen? } */
(function (root) {
  'use strict';
  var Core = root.Core || (typeof require !== 'undefined' ? require('./core.js') : null);
  var LIES = ['tee', 'fairway', 'rough', 'sand', 'recovery', 'green'];
  var ARG_LIMIT = 27; // meter ≈ 30 yards: gränsen mellan närspel och inspel i Strokes Gained
  var FALLBACK = { tee: ['tee', 'fairway'], fairway: ['fairway', 'rough', 'tee'], rough: ['rough', 'fairway', 'recovery'], sand: ['sand', 'rough'], recovery: ['recovery', 'rough'], green: ['green'] };
  var BINS = {
    green: [0, 1, 2, 3, 5, 8, 12, 20, 40],
    other: [0, 10, 20, 35, 60, 90, 120, 150, 180, 210, 250, 300, 400, 650]
  };

  function shotStrokes(d) { return d.shots.length + d.shots.reduce(function (a, s) { return a + (s.pen || 0); }, 0); }
  function validShots(d) {
    return !!(d && d.shots && d.shots.length && d.holed && !d.pickedUp && typeof d.strokes === 'number' && d.strokes === shotStrokes(d) &&
      d.shots.every(function (s) { return LIES.indexOf(s.lie) >= 0 && typeof s.dist === 'number' && s.dist >= 0; }));
  }
  function category(shot, par) {
    if (shot.lie === 'green') return 'putt';
    if (shot.lie === 'tee' && par >= 4) return 'ott';
    return shot.dist > ARG_LIMIT ? 'app' : 'arg';
  }

  // Datapunkter: (läge, avstånd, slag kvar inkl. plikt) från alla korrekt loggade hål.
  function shotPoints(rounds) {
    var pts = [];
    rounds.forEach(function (r) {
      (r.holes || []).forEach(function (d) {
        if (!validShots(d)) return;
        var rem = shotStrokes(d);
        d.shots.forEach(function (s) { pts.push({ lie: s.lie, dist: s.dist, rem: rem }); rem -= 1 + (s.pen || 0); });
      });
    });
    return pts;
  }
  function monotone(arr) { // stigande med avstånd (pool adjacent violators)
    var blocks = arr.map(function (p) { return { x: [p[0]], y: p[1], w: p[2] }; });
    for (var i = 0; i < blocks.length - 1;) {
      if (blocks[i].y > blocks[i + 1].y) {
        var a = blocks[i], b = blocks[i + 1], w = a.w + b.w;
        blocks.splice(i, 2, { x: a.x.concat(b.x), y: (a.y * a.w + b.y * b.w) / w, w: w });
        if (i > 0) i--;
      } else i++;
    }
    var out = [];
    blocks.forEach(function (bk) { bk.x.forEach(function (x) { out.push([x, Math.round(bk.y * 1000) / 1000]); }); });
    return out;
  }
  // Personlig baslinje: förväntade slag kvar per läge och avstånd, från spelarens egna slag.
  function buildBaseline(points, minPerBin) {
    var min = minPerBin || 4, lies = {};
    LIES.forEach(function (lie) {
      var edges = lie === 'green' ? BINS.green : BINS.other, rows = [];
      for (var b = 0; b < edges.length - 1; b++) {
        var lo = edges[b], hi = edges[b + 1], used = null;
        for (var f = 0; f < FALLBACK[lie].length; f++) {
          var pool = FALLBACK[lie].slice(0, f + 1);
          var inBin = points.filter(function (p) { return pool.indexOf(p.lie) >= 0 && p.dist > lo && p.dist <= hi; });
          if (inBin.length >= min) { used = inBin; break; }
        }
        if (!used) continue;
        var mx = used.reduce(function (a, p) { return a + p.dist; }, 0) / used.length;
        var my = used.reduce(function (a, p) { return a + p.rem; }, 0) / used.length;
        rows.push([Math.round(mx * 10) / 10, my, used.length]);
      }
      if (rows.length) lies[lie] = monotone(rows);
    });
    return { name: 'personal', points: points.length, lies: lies };
  }
  function validateBaseline(b) {
    if (!b || typeof b !== 'object' || !b.lies) return false;
    return LIES.every(function (l) {
      var a = b.lies[l];
      return Array.isArray(a) && a.length >= 2 && a.every(function (p) { return Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]) && p[1] >= 1; });
    });
  }
  function expected(base, lie, dist) {
    if (dist <= 0) return 0;
    var a = base.lies[lie];
    for (var fb = 1; (!a || !a.length) && fb < FALLBACK[lie].length; fb++) a = base.lies[FALLBACK[lie][fb]];
    if (!a || !a.length) return null;
    if (lie === 'green' && dist < a[0][0]) { var x0 = a[0][0]; return 1 + (a[0][1] - 1) * (dist / x0); }
    if (dist <= a[0][0]) return a[0][1];
    for (var i = 0; i < a.length - 1; i++) {
      if (dist <= a[i + 1][0]) { var t = (dist - a[i][0]) / (a[i + 1][0] - a[i][0]); return a[i][1] + t * (a[i + 1][1] - a[i][1]); }
    }
    return a[a.length - 1][1];
  }

  // Strokes Gained för en rond. SG = E(före) − E(efter) − 1 − plikt.
  function sgRound(round, base) {
    var out = { ott: 0, app: 0, arg: 0, putt: 0, total: 0, shots: 0, holes: 0, skipped: 0 };
    (round.holes || []).forEach(function (d, hi) {
      if (!validShots(d)) return;
      var par = round.tee.holes[hi].par, vals = [], ok = true;
      d.shots.forEach(function (s, k) {
        var nx = d.shots[k + 1];
        var e0 = expected(base, s.lie, s.dist), e1 = nx ? expected(base, nx.lie, nx.dist) : 0;
        if (e0 === null || e1 === null) { ok = false; return; }
        vals.push({ cat: category(s, par), sg: e0 - e1 - 1 - (s.pen || 0) });
      });
      if (!ok) { out.skipped++; return; }
      out.holes++;
      vals.forEach(function (v) { out[v.cat] += v.sg; out.total += v.sg; out.shots++; });
    });
    ['ott', 'app', 'arg', 'putt', 'total'].forEach(function (k) { out[k] = Math.round(out[k] * 100) / 100; });
    return out;
  }

  // Utökad statistik per rond från hålregistreringen (och slagloggar där de finns).
  function roundMetrics(round) {
    var s = Core.summarizeRound(round, round.tee), m = {
      s: s, threePutts: 0, threePuttExtra: 0, onePutts: 0, scrAtt: 0, scrOk: 0, sandAtt: 0, sandOk: 0, dblPlus: 0, overNetBogey: 0,
      birdies: 0, firLeft: 0, firRight: 0, parType: { 3: { n: 0, toPar: 0 }, 4: { n: 0, toPar: 0 }, 5: { n: 0, toPar: 0 } },
      shotHoles: 0, shortAtt: 0, shortMade: 0, firstPutts: [], proximity: [], chipMiss: 0, sandStay: 0, penTee: 0
    };
    round.tee.holes.forEach(function (h, i) {
      var d = round.holes[i] || {}, g = d.pickedUp ? null : d.strokes, rec = s.allocation[i];
      if (typeof d.putts === 'number') { if (d.putts >= 3) { m.threePutts++; m.threePuttExtra += d.putts - 2; } if (d.putts === 1) m.onePutts++; }
      if (d.fir === 'left') m.firLeft++; if (d.fir === 'right') m.firRight++;
      if (typeof g === 'number') {
        if (g < h.par) m.birdies++;
        var nb = h.par + 1 + rec; if (g > nb) { m.dblPlus++; m.overNetBogey += g - nb; }
        var pt = m.parType[h.par]; if (pt) { pt.n++; pt.toPar += g - h.par; }
        if (d.gir === false) { m.scrAtt++; if (g <= h.par) m.scrOk++; if ((d.bunker || 0) > 0) { m.sandAtt++; if (g <= h.par) m.sandOk++; } }
      } else if (d.pickedUp && d.gir === false) m.scrAtt++;
      if (validShots(d)) {
        m.shotHoles++;
        var firstGreen = null;
        d.shots.forEach(function (sh, k) {
          var nx = d.shots[k + 1];
          if (sh.lie === 'green' && firstGreen === null) {
            firstGreen = k; m.firstPutts.push(sh.dist);
            if (sh.dist <= 2) { m.shortAtt++; if (!nx) m.shortMade++; }
            if (k > 0 && d.shots[k - 1].dist > ARG_LIMIT) m.proximity.push(sh.dist);
          }
          if (sh.lie !== 'green' && sh.dist <= ARG_LIMIT && nx && nx.lie !== 'green') m.chipMiss++;
          if (sh.lie === 'sand' && nx && nx.lie === 'sand') m.sandStay++;
          if (sh.lie === 'tee' && sh.pen) m.penTee += sh.pen;
        });
      }
    });
    return m;
  }

  function avg(arr) { return arr.length ? arr.reduce(function (a, b) { return a + b; }, 0) / arr.length : null; }
  function per18(v, n) { return n ? v * 18 / n : null; }
  function pct(a, b) { return b ? a / b * 100 : null; }

  // Regelbaserad coach. history = tidigare ronders roundMetrics (nyast först). sg = sgRound-resultat eller null.
  function coach(m, history, sg) {
    var s = m.s, F = [], L = [], T = [], h = history.slice(0, 10), out = { strengths: F, losses: L, trend: T, focus: [], recs: [], summary: null, enough: true };
    if (s.played < 9) { out.enough = false; return out; }
    var putts18 = s.puttHoles === s.played ? per18(s.putts, s.played) : null, gir = pct(s.girHit, s.girTot), fir = pct(s.firHit, s.firTot);
    var H = {
      putts: avg(h.filter(function (x) { return x.s.puttHoles === x.s.played && x.s.played; }).map(function (x) { return per18(x.s.putts, x.s.played); })),
      gir: avg(h.filter(function (x) { return x.s.girTot; }).map(function (x) { return pct(x.s.girHit, x.s.girTot); })),
      fir: avg(h.filter(function (x) { return x.s.firTot; }).map(function (x) { return pct(x.s.firHit, x.s.firTot); })),
      gross: avg(h.filter(function (x) { return x.s.complete && !x.s.pickedUp; }).map(function (x) { return x.s.gross; })),
      points: avg(h.map(function (x) { return x.s.points; })),
      pen: avg(h.map(function (x) { return x.s.penalties; }))
    };
    var full = s.complete && !s.pickedUp;

    // Styrkor (data)
    if (h.length >= 3 && putts18 !== null && H.putts !== null && putts18 <= H.putts - 1.5) F.push({ code: 'fewPutts', p: { v: Math.round(putts18), a: Math.round(H.putts * 10) / 10 } });
    if (h.length >= 3 && gir !== null && H.gir !== null && gir >= H.gir + 10) F.push({ code: 'highGir', p: { v: Math.round(gir), a: Math.round(H.gir) } });
    if (h.length >= 3 && fir !== null && H.fir !== null && fir >= H.fir + 10) F.push({ code: 'highFir', p: { v: Math.round(fir), a: Math.round(H.fir) } });
    if (s.penalties === 0 && s.played >= 18) F.push({ code: 'noPen', p: {} });
    if (m.threePutts === 0 && s.puttHoles === s.played && s.played >= 18) F.push({ code: 'noThree', p: {} });
    if (m.scrAtt >= 3 && m.scrOk / m.scrAtt >= 0.5) F.push({ code: 'scrGood', p: { ok: m.scrOk, att: m.scrAtt } });
    if (m.birdies >= 2) F.push({ code: 'birdies', p: { n: m.birdies } });
    if (full && h.length >= 3 && H.gross !== null && s.gross <= H.gross - 3) F.push({ code: 'betterScore', p: { v: s.gross, a: Math.round(H.gross * 10) / 10 } });

    // Tappade slag (data, räknade i slag)
    if (s.penalties) L.push({ code: 'pen', area: 'driving', strokes: s.penalties, p: { n: s.penalties, tee: m.penTee } });
    if (m.threePuttExtra) L.push({ code: 'three', area: 'putting', strokes: m.threePuttExtra, p: { n: m.threePutts, x: m.threePuttExtra } });
    if (m.overNetBogey) L.push({ code: 'dbl', area: 'strategy', strokes: m.overNetBogey, p: { n: m.dblPlus, x: m.overNetBogey } });
    if (m.scrAtt - m.scrOk > 0) L.push({ code: 'scrMiss', area: 'shortgame', strokes: (m.scrAtt - m.scrOk) * 0.5, p: { n: m.scrAtt - m.scrOk, att: m.scrAtt } });
    if (m.shortAtt - m.shortMade > 0) L.push({ code: 'shortMiss', area: 'putting', strokes: m.shortAtt - m.shortMade, p: { n: m.shortAtt - m.shortMade, att: m.shortAtt } });
    if (m.chipMiss) L.push({ code: 'chipMiss', area: 'shortgame', strokes: m.chipMiss, p: { n: m.chipMiss } });
    if (m.sandStay) L.push({ code: 'sandStay', area: 'shortgame', strokes: m.sandStay, p: { n: m.sandStay } });
    L.sort(function (a, b) { return b.strokes - a.strokes; });

    // Jämfört med tidigare ronder (data)
    if (h.length >= 3) {
      if (full && H.gross !== null) T.push({ code: 'scoreVsAvg', p: { d: Math.round((s.gross - H.gross) * 10) / 10, n: h.length } });
      T.push({ code: 'pointsVsAvg', p: { d: Math.round((s.points - H.points) * 10) / 10, n: h.length } });
      if (putts18 !== null && H.putts !== null) T.push({ code: 'puttsVsAvg', p: { d: Math.round((putts18 - H.putts) * 10) / 10 } });
      if (gir !== null && H.gir !== null) T.push({ code: 'girVsAvg', p: { d: Math.round(gir - H.gir) } });
      if (fir !== null && H.fir !== null) T.push({ code: 'firVsAvg', p: { d: Math.round(fir - H.fir) } });
      if (history.length >= 9) {
        var last5 = [m].concat(history.slice(0, 4)).map(function (x) { return x.s.points; }), prev5 = history.slice(4, 9).map(function (x) { return x.s.points; });
        T.push({ code: 'form', p: { d: Math.round((avg(last5) - avg(prev5)) * 10) / 10 } });
      }
    } else T.push({ code: 'fewRounds', p: { n: history.length } });

    // Fokusområden (uppskattning): Strokes Gained om det finns, annars tappade slag och jämförelse med snittet.
    var area = { putting: 0, shortgame: 0, approach: 0, driving: 0, strategy: 0 };
    if (sg && sg.holes >= 9) {
      area.driving = -sg.ott; area.approach = -sg.app; area.shortgame = -sg.arg; area.putting = -sg.putt;
      L.forEach(function (x) { if (x.area === 'strategy') area.strategy += x.strokes * 0.5; });
      out.focusSource = 'sg';
    } else {
      L.forEach(function (x) { area[x.area] += x.strokes; });
      if (putts18 !== null && H.putts !== null) area.putting += Math.max(0, putts18 - H.putts);
      if (gir !== null) area.approach += H.gir !== null ? Math.max(0, (H.gir - gir) / 100 * 18 * 0.5) : (s.girTot - s.girHit) * 0.15;
      if (fir !== null && H.fir !== null) area.driving += Math.max(0, (H.fir - fir) / 100 * 14 * 0.3);
      if (putts18 !== null && putts18 >= 34 && gir !== null && gir >= 35) area.putting += 1;
      out.focusSource = 'rules';
    }
    var order = ['putting', 'shortgame', 'approach', 'driving', 'strategy'];
    out.focus = order.slice().sort(function (a, b) { return area[b] - area[a]; }).map(function (k) { return { area: k, score: Math.round(area[k] * 10) / 10 }; });
    var top = out.focus[0];
    out.summary = { gir: gir === null ? null : Math.round(gir), putts: putts18 === null ? null : s.putts, area: top.score > 0 ? top.area : null };

    // Tre träningsrekommendationer
    function drillFor(a) {
      if (a === 'putting') return m.shortAtt - m.shortMade > 0 && m.shortAtt - m.shortMade >= m.threePuttExtra ? 'puttShort' : 'puttLag';
      if (a === 'shortgame') return m.sandStay > 0 || (m.sandAtt && m.sandOk < m.sandAtt) ? 'bunker' : 'upDown';
      if (a === 'approach') return 'approach';
      if (a === 'driving') return s.penalties > 0 ? 'safeTee' : 'fairway';
      return 'strategy';
    }
    var used = {};
    out.focus.forEach(function (f) { var d = drillFor(f.area); if (out.recs.length < 3 && !used[d]) { used[d] = 1; out.recs.push({ drill: d, area: f.area, priority: f.score > 0 }); } });
    return out;
  }

  // Klubblängder från slagloggar: avstånd avverkat mot hålet för fulla slag (uppskattning).
  function clubStats(rounds) {
    var by = {};
    rounds.forEach(function (r) {
      (r.holes || []).forEach(function (d) {
        if (!d.shots) return;
        d.shots.forEach(function (sh, k) {
          var nx = d.shots[k + 1];
          if (!sh.club || sh.pen || ['tee', 'fairway', 'rough'].indexOf(sh.lie) < 0) return;
          var end = nx ? nx.dist : (d.holed ? 0 : null);
          if (end === null || sh.dist <= ARG_LIMIT) return;
          var moved = sh.dist - end;
          if (moved <= 20) return;
          (by[sh.club] = by[sh.club] || []).push(moved);
        });
      });
    });
    var out = {};
    Object.keys(by).forEach(function (c) {
      var a = by[c].slice().sort(function (x, y) { return x - y; }), mean = avg(a);
      out[c] = { n: a.length, avg: Math.round(mean), min: Math.round(a[0]), max: Math.round(a[a.length - 1]), median: Math.round(a[Math.floor(a.length / 2)]) };
    });
    return out;
  }
  // Klubbförslag: klubban vars längd ligger närmast avståndet (inlärd median om minst 3 slag, annars angiven längd).
  function suggestClub(bag, learned, dist) {
    var best = null;
    (bag || []).forEach(function (c) {
      if (c.putter) return;
      var L = learned && learned[c.id] && learned[c.id].n >= 3 ? learned[c.id].median : c.carry;
      if (!L) return;
      var diff = Math.abs(L - dist);
      if (!best || diff < best.diff || (diff === best.diff && L > best.len)) best = { id: c.id, name: c.name, len: L, diff: diff, learned: !!(learned && learned[c.id] && learned[c.id].n >= 3) };
    });
    return best && best.diff <= 25 ? best : null;
  }

  var Stats = { LIES: LIES, ARG_LIMIT: ARG_LIMIT, validShots: validShots, shotStrokes: shotStrokes, category: category, shotPoints: shotPoints, buildBaseline: buildBaseline,
    validateBaseline: validateBaseline, expected: expected, sgRound: sgRound, roundMetrics: roundMetrics, coach: coach, clubStats: clubStats, suggestClub: suggestClub };
  if (typeof module !== 'undefined' && module.exports) module.exports = Stats;
  root.Stats = Stats;
})(typeof window !== 'undefined' ? window : globalThis);
