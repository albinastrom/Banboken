/* Banboken – spelformer (etapp 3). Rena funktioner.
   Spelare: { id, name, hi, tee: {cr, slope, holes:[{par, si}]}, holes: [{strokes, pickedUp}] }
   Lag:     { id, name, members: [spelar-id] }  Lagboll: teamHoles[lag-id][hål] = {strokes, pickedUp} */
(function (root) {
  'use strict';
  var Core = root.Core || (typeof require !== 'undefined' ? require('./core.js') : null);

  // Rekommenderade handicapreduktioner enligt WHS (Appendix C). Kan ändras per spel.
  var DEFAULTS = { stroke: 95, stableford: 95, matchSingles: 100, matchFourball: 90, bestball: 85, worstball: 100, skins: 100 };
  var TEAM_PCT = {
    scramble2: [35, 15], scramble3: [30, 20, 10], scramble4: [25, 20, 15, 10],
    texas: [25, 20, 15, 10], greensome: [60, 40], foursome: [50, 50]
  };
  var TEAM_SIZE = { scramble2: 2, scramble3: 3, scramble4: 4, texas: 4, greensome: 2, foursome: 2 };

  function courseHcp(p) { return Core.courseHandicap(p.hi, p.tee.slope, p.tee.cr, Core.sumPar(p.tee.holes)); }

  // Lagets spelhandicap: procent av spelarnas Course Handicap, lägst först, avrundas en gång.
  function teamPlayingHcp(chs, mode) {
    var pct = TEAM_PCT[mode]; if (!pct) return null;
    var s = chs.slice().sort(function (a, b) { return a - b; });
    if (s.length !== pct.length) return null;
    var sum = 0; for (var i = 0; i < s.length; i++) sum += s[i] * pct[i] / 100;
    return Core.whsRound(sum);
  }

  // Bruttoresultat: tal, null = struket, undefined = ej ifyllt.
  function grossOf(h) { if (!h) return undefined; if (h.pickedUp) return null; return typeof h.strokes === 'number' ? h.strokes : undefined; }

  function entity(id, name, tee, holes, ph) {
    return { id: id, name: name, tee: tee, holes: holes, ph: ph, alloc: Core.strokeAllocation(ph, tee.holes) };
  }
  function netOf(e, i) { var g = grossOf(e.holes[i]); return typeof g === 'number' ? g - e.alloc[i] : g; }
  function pointsOf(e, i) {
    var g = grossOf(e.holes[i]); if (g === undefined) return undefined;
    return Core.stablefordPoints(g, e.tee.holes[i].par, e.alloc[i]);
  }

  function byId(players) { var m = {}; players.forEach(function (p) { m[p.id] = p; }); return m; }

  // Spelhandicap per spelare för ett spel. relative = lägsta spelar från 0 (matchspel, skins).
  function playerHcps(players, pct, relative) {
    var phs = players.map(function (p) { return Core.playingHandicap(courseHcp(p), pct); });
    var min = relative ? Math.min.apply(null, phs) : 0;
    return phs.map(function (x) { return x - min; });
  }

  // Lägsta (bäst) eller högsta (sämst) netto i en sida. Struket räknas bara om alla strukit (bäst) / någon strukit (sämst).
  function sideNet(entities, i, worst) {
    var vals = entities.map(function (e) { return netOf(e, i); });
    if (vals.some(function (v) { return v === undefined; })) return undefined;
    var nums = vals.filter(function (v) { return typeof v === 'number'; });
    if (worst) return nums.length === vals.length ? Math.max.apply(null, nums) : null;
    return nums.length ? Math.min.apply(null, nums) : null;
  }
  function sidePoints(entities, i, worst) {
    var vals = entities.map(function (e) { return pointsOf(e, i); });
    if (vals.some(function (v) { return v === undefined; })) return undefined;
    return worst ? Math.min.apply(null, vals) : Math.max.apply(null, vals);
  }

  // Matchspel: a[i], b[i] = netto per hål (tal / null struket / undefined ej spelat).
  function matchStatus(a, b, from, to) {
    var up = 0, thru = 0, total = to - from, holes = [];
    for (var i = from; i < to; i++) {
      var x = a[i], y = b[i];
      if (x === undefined || y === undefined) break;
      var w;
      if (x === null && y === null) w = 0;
      else if (x === null) w = -1;
      else if (y === null) w = 1;
      else w = x < y ? 1 : x > y ? -1 : 0;
      up += w; thru++; holes.push(w);
      var rem = total - thru;
      if (Math.abs(up) > rem) return { up: up, thru: thru, remaining: rem, closed: true, winner: up > 0 ? 'A' : 'B', result: Math.abs(up) + '/' + rem, holes: holes };
    }
    var remaining = total - thru, done = remaining === 0;
    return {
      up: up, thru: thru, remaining: remaining, closed: done, holes: holes,
      dormie: !done && up !== 0 && Math.abs(up) === remaining,
      winner: done ? (up > 0 ? 'A' : up < 0 ? 'B' : 'halved') : null,
      result: done ? (up === 0 ? 'halved' : Math.abs(up) + 'up') : null
    };
  }

  function sumKnown(arr) {
    var s = 0, n = 0, nr = false;
    arr.forEach(function (v) { if (typeof v === 'number') { s += v; n++; } else if (v === null) nr = true; });
    return { sum: s, n: n, nr: nr };
  }
  function parThru(tee, vals) { var s = 0; vals.forEach(function (v, i) { if (typeof v === 'number') s += tee.holes[i].par; }); return s; }
  function thruCount(vals) { var n = 0; for (var i = 0; i < vals.length; i++) { if (vals[i] === undefined) break; n++; } return n; }

  // ---------- Spel ----------
  function compute(game, ctx) {
    var players = ctx.players, P = byId(players), teams = ctx.teams || [];
    var pct = game.allowance;
    function teamById(id) { return teams.filter(function (t) { return t.id === id; })[0]; }
    function membersOf(tid) { var t = teamById(tid); if (!t && P[tid]) return [P[tid]]; return t ? t.members.map(function (m) { return P[m]; }).filter(Boolean) : []; }
    function sideName(id) { var t = teamById(id); return t ? t.name : P[id] ? P[id].name : '?'; }
    var t = game.type;

    if (t === 'stroke' || t === 'stableford') {
      var phs = playerHcps(players, pct, false);
      var rows = players.map(function (p, k) {
        var e = entity(p.id, p.name, p.tee, p.holes, phs[k]), gross = [], net = [], pts = [];
        for (var i = 0; i < p.tee.holes.length; i++) { gross.push(grossOf(p.holes[i])); net.push(netOf(e, i)); pts.push(pointsOf(e, i)); }
        var g = sumKnown(gross), nt = sumKnown(net), pp = sumKnown(pts), par = parThru(p.tee, gross);
        return { id: p.id, name: p.name, ph: phs[k], thru: thruCount(gross), gross: g.sum, net: nt.sum, grossToPar: g.sum - par, netToPar: nt.sum - par, points: pp.sum, nr: g.nr };
      });
      rows.sort(t === 'stableford'
        ? function (a, b) { return b.points - a.points; }
        : function (a, b) { return (a.nr - b.nr) || (a.netToPar - b.netToPar); });
      return { type: t, rows: rows, complete: rows.every(function (r) { return r.thru === 18; }) };
    }

    if (t === 'match' || t === 'nassau') {
      var sides = (game.sides || []).map(membersOf);
      if (sides.length !== 2 || !sides[0].length || !sides[1].length) return { type: t, error: 'sides' };
      var four = sides[0].length > 1 || sides[1].length > 1;
      var all = sides[0].concat(sides[1]);
      var hc = playerHcps(all, pct, true), ents = all.map(function (p, k) { return entity(p.id, p.name, p.tee, p.holes, hc[k]); });
      var eA = ents.slice(0, sides[0].length), eB = ents.slice(sides[0].length);
      var a = [], b = [];
      for (var i = 0; i < 18; i++) { a.push(sideNet(eA, i, false)); b.push(sideNet(eB, i, false)); }
      var base = { type: t, fourball: four, sides: game.sides.map(sideName), strokes: ents.map(function (e) { return { id: e.id, name: e.name, ph: e.ph }; }) };
      if (t === 'match') return Object.assign(base, matchStatus(a, b, 0, 18));
      return Object.assign(base, { front: matchStatus(a, b, 0, 9), back: matchStatus(a, b, 9, 18), total: matchStatus(a, b, 0, 18) });
    }

    if (t === 'bestball' || t === 'worstball') {
      var worst = t === 'worstball', ids = game.teams || [];
      var ph2 = playerHcps(players, pct, false), ent = {};
      players.forEach(function (p, k) { ent[p.id] = entity(p.id, p.name, p.tee, p.holes, ph2[k]); });
      var rows2 = ids.map(function (tid) {
        var tm = teamById(tid), es = (tm ? tm.members : []).map(function (m) { return ent[m]; }).filter(Boolean);
        if (!es.length) return null;
        var nets = [], pts = [];
        for (var i = 0; i < 18; i++) { nets.push(sideNet(es, i, worst)); pts.push(sidePoints(es, i, worst)); }
        var n = sumKnown(nets), pp = sumKnown(pts);
        return { id: tid, name: tm.name, thru: Math.min(thruCount(nets), thruCount(pts)), net: n.sum, netToPar: n.sum - parThru(es[0].tee, nets), points: pp.sum, nr: n.nr, nets: nets };
      }).filter(Boolean);
      var sf = game.scoring === 'stableford';
      rows2.sort(sf ? function (x, y) { return y.points - x.points; } : function (x, y) { return (x.nr - y.nr) || (x.netToPar - y.netToPar); });
      return { type: t, scoring: sf ? 'stableford' : 'stroke', rows: rows2, complete: rows2.every(function (r) { return r.thru === 18; }) };
    }

    if (t === 'skins') {
      var ph3 = playerHcps(players, pct, true), es3 = players.map(function (p, k) { return entity(p.id, p.name, p.tee, p.holes, ph3[k]); });
      var won = {}, carry = 0, holes = [];
      es3.forEach(function (e) { won[e.id] = 0; });
      for (var i = 0; i < 18; i++) {
        var vals = es3.map(function (e) { return netOf(e, i); });
        if (vals.some(function (v) { return v === undefined; })) break;
        var pot = 1 + carry, nums = vals.filter(function (v) { return typeof v === 'number'; });
        if (!nums.length) { holes.push({ hole: i + 1, winner: null, pot: pot }); carry = game.carryover === false ? 0 : pot; continue; }
        var min = Math.min.apply(null, nums), who = es3.filter(function (e, k) { return vals[k] === min; });
        if (who.length === 1) { won[who[0].id] += pot; holes.push({ hole: i + 1, winner: who[0].id, pot: pot }); carry = 0; }
        else { holes.push({ hole: i + 1, winner: null, pot: pot }); carry = game.carryover === false ? 0 : pot; }
      }
      var rows3 = es3.map(function (e) { return { id: e.id, name: e.name, skins: won[e.id], ph: e.ph }; }).sort(function (x, y) { return y.skins - x.skins; });
      return { type: t, rows: rows3, holes: holes, carry: carry, thru: holes.length, complete: holes.length === 18 };
    }

    if (t === 'teamStroke' || t === 'teamMatch') {
      var mode = ctx.teamMode, tIds = game.teams || teams.map(function (x) { return x.id; });
      var tents = tIds.map(function (tid) {
        var tm = teamById(tid), ms = membersOf(tid);
        if (!tm || !ms.length) return null;
        var ph = teamPlayingHcp(ms.map(courseHcp), mode);
        if (ph === null) return { id: tid, name: tm.name, error: 'size' };
        return entity(tid, tm.name, ms[0].tee, (ctx.teamHoles || {})[tid] || [], ph);
      }).filter(Boolean);
      if (tents.some(function (e) { return e.error; })) return { type: t, error: 'size' };
      if (t === 'teamMatch') {
        if (tents.length !== 2) return { type: t, error: 'sides' };
        var mn = Math.min(tents[0].ph, tents[1].ph);
        var A = entity(tents[0].id, tents[0].name, tents[0].tee, tents[0].holes, tents[0].ph - mn);
        var B = entity(tents[1].id, tents[1].name, tents[1].tee, tents[1].holes, tents[1].ph - mn);
        var aa = [], bb = [];
        for (var i = 0; i < 18; i++) { aa.push(netOf(A, i)); bb.push(netOf(B, i)); }
        return Object.assign({ type: t, sides: [A.name, B.name], strokes: [{ id: A.id, name: A.name, ph: A.ph }, { id: B.id, name: B.name, ph: B.ph }], teamPh: [tents[0].ph, tents[1].ph] }, matchStatus(aa, bb, 0, 18));
      }
      var rows4 = tents.map(function (e) {
        var gross = [], net = [];
        for (var i = 0; i < 18; i++) { gross.push(grossOf(e.holes[i])); net.push(netOf(e, i)); }
        var g = sumKnown(gross), n = sumKnown(net), par = parThru(e.tee, gross);
        return { id: e.id, name: e.name, ph: e.ph, thru: thruCount(gross), gross: g.sum, net: n.sum, grossToPar: g.sum - par, netToPar: n.sum - par, nr: g.nr };
      }).sort(function (x, y) { return (x.nr - y.nr) || (x.netToPar - y.netToPar); });
      return { type: t, rows: rows4, complete: rows4.every(function (r) { return r.thru === 18; }) };
    }
    return { type: t, error: 'unknown' };
  }

  // Validering av en spelkonfiguration mot spelare och lag.
  function validate(game, ctx) {
    var teams = ctx.teams || [], n = ctx.players.length;
    function team(id) { return teams.filter(function (x) { return x.id === id; })[0]; }
    var t = game.type;
    if ((t === 'stroke' || t === 'stableford') && n < 1) return 'players';
    if (t === 'skins' && n < 2) return 'skins2';
    if (t === 'match' || t === 'nassau') {
      var s = game.sides || [], pids = ctx.players.map(function (p) { return p.id; });
      function mem(id) { return team(id) ? team(id).members : pids.indexOf(id) >= 0 ? [id] : null; }
      if (s.length !== 2 || !mem(s[0]) || !mem(s[1]) || s[0] === s[1]) return 'twoSides';
      var ma = mem(s[0]), mb = mem(s[1]);
      if (!ma.length || !mb.length || ma.length > 2 || mb.length > 2) return 'sideSize';
      if (ma.some(function (x) { return mb.indexOf(x) >= 0; })) return 'overlap';
    }
    if (t === 'bestball' || t === 'worstball') {
      var ts = game.teams || [];
      if (!ts.length) return 'teams';
      for (var i = 0; i < ts.length; i++) { if (!team(ts[i]) || team(ts[i]).members.length !== 2) return 'pairs'; }
    }
    if (t === 'teamStroke' || t === 'teamMatch') {
      var need = TEAM_SIZE[ctx.teamMode];
      if (!teams.length) return 'teams';
      for (var j = 0; j < teams.length; j++) if (teams[j].members.length !== need) return 'teamSize';
      if (t === 'teamMatch' && teams.length !== 2) return 'twoSides';
    }
    return null;
  }

  var Games = { DEFAULTS: DEFAULTS, TEAM_PCT: TEAM_PCT, TEAM_SIZE: TEAM_SIZE, teamPlayingHcp: teamPlayingHcp, matchStatus: matchStatus, compute: compute, validate: validate, courseHcp: courseHcp };
  if (typeof module !== 'undefined' && module.exports) module.exports = Games;
  root.Games = Games;
})(typeof window !== 'undefined' ? window : globalThis);
