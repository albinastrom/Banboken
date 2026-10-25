/* Banboken – kärnberäkningar (WHS, slagfördelning, poäng, statistik).
   Rena funktioner utan UI, så de kan testas och flyttas till TypeScript senare. */
(function (root) {
  'use strict';

  // WHS: värden som slutar på exakt ,5 avrundas uppåt (även för plushandicap: -2,5 → -2).
  function whsRound(x) {
    return Math.round(Math.round(x * 1000) / 1000);
  }

  // "+2.3" eller "+2,3" betyder plushandicap och lagras som -2.3.
  function parseHandicapIndex(input) {
    if (input === null || input === undefined) return null;
    var s = String(input).trim().replace(',', '.');
    if (s === '') return null;
    var plus = s.charAt(0) === '+';
    var n = parseFloat(plus ? s.slice(1) : s);
    if (!isFinite(n)) return null;
    var v = plus ? -Math.abs(n) : n;
    if (v < -10 || v > 54) return null;
    return Math.round(v * 10) / 10;
  }

  function formatHandicap(v) {
    if (v === null || v === undefined || !isFinite(v)) return '–';
    if (v < 0) return '+' + String(Math.abs(v)).replace('.', ',');
    return String(v).replace('.', ',');
  }

  function formatSigned(v) {
    if (v === 0) return 'E';
    return (v > 0 ? '+' : '') + v;
  }

  // Course Handicap = HI × (Slope / 113) + (CR − Par), avrundat enligt WHS.
  function courseHandicapExact(hi, slope, cr, par) {
    return hi * (slope / 113) + (cr - par);
  }
  function courseHandicap(hi, slope, cr, par) {
    return whsRound(courseHandicapExact(hi, slope, cr, par));
  }

  // 9 hål (WHS): halva Handicap Index med 9-hålsbanans värdering.
  function courseHandicap9(hi, slope9, cr9, par9) {
    return whsRound((hi / 2) * (slope9 / 113) + (cr9 - par9));
  }
  // WHS 2024: förväntad score differential för 9 ospelade hål, utifrån Handicap Index.
  function expected9(hi) { return hi * 0.52 + 1.2; }

  // Playing Handicap = Course Handicap × handicapreduktion, avrundat.
  function playingHandicap(ch, allowancePct) {
    var pct = allowancePct === undefined ? 100 : allowancePct;
    return whsRound(ch * pct / 100);
  }

  // Slag per hål utifrån hålindex (1 = svårast). Plushandicap lämnar tillbaka slag
  // från hålindex 18 och nedåt.
  function strokesOnHole(ph, si, holeCount) {
    var n = holeCount || 18;
    if (ph >= 0) {
      return Math.floor(ph / n) + ((si <= ph % n) ? 1 : 0);
    }
    var give = -ph;
    return -(Math.floor(give / n) + ((si > n - (give % n)) ? 1 : 0));
  }

  function strokeAllocation(ph, holes) {
    return holes.map(function (h) { return strokesOnHole(ph, h.si, holes.length); });
  }

  // Poängbogey: 2 poäng för netto par. Strukna hål (null) ger 0 poäng.
  function stablefordPoints(gross, par, received) {
    if (gross === null || gross === undefined) return 0;
    return Math.max(0, 2 + par + received - gross);
  }

  // Netto dubbelbogey = maxresultat per hål för handicapregistrering.
  function netDoubleBogey(par, received) {
    return par + 2 + received;
  }

  // Justerat bruttoresultat: varje hål kapas vid netto dubbelbogey, strukna hål får NDB.
  function adjustedGross(scores, holes, alloc) {
    var sum = 0;
    for (var i = 0; i < holes.length; i++) {
      var ndb = netDoubleBogey(holes[i].par, alloc[i]);
      var g = scores[i];
      sum += (g === null || g === undefined) ? ndb : Math.min(g, ndb);
    }
    return sum;
  }

  // Score Differential = (113 / Slope) × (justerat brutto − CR − PCC), en decimal.
  function scoreDifferential(ags, cr, slope, pcc) {
    var d = (113 / slope) * (ags - cr - (pcc || 0));
    return Math.round(d * 10) / 10;
  }

  function sumPar(holes) {
    return holes.reduce(function (a, h) { return a + h.par; }, 0);
  }

  // Sammanställning av en rond. round.holes[i] = { strokes, putts, fir, gir, penalties, bunker, pickedUp }
  function teeRated(tee) { return typeof tee.cr === 'number' && isFinite(tee.cr) && typeof tee.slope === 'number' && isFinite(tee.slope); }

  function summarizeRound(round, tee) {
    var holes = tee.holes;
    var par = sumPar(holes);
    var rated = teeRated(tee);
    // Utan CR/Slope går det inte att räkna handicap: ronden räknas som brutto (0 slag).
    var nine = holes.length === 9;
    var ch = !rated ? 0 : nine ? courseHandicap9(round.hi, tee.slope, tee.cr, par) : courseHandicap(round.hi, tee.slope, tee.cr, par);
    var ph = playingHandicap(ch, round.allowance);
    var alloc = strokeAllocation(ph, holes);
    var gross = 0, net = 0, points = 0, putts = 0, played = 0, parPlayed = 0;
    var firHit = 0, firTot = 0, girHit = 0, girTot = 0, pen = 0, puttHoles = 0;
    var pickedUp = 0;
    var grossScores = [];
    for (var i = 0; i < holes.length; i++) {
      var r = round.holes[i] || {};
      var g = r.pickedUp ? null : (typeof r.strokes === 'number' ? r.strokes : undefined);
      grossScores.push(g === undefined ? null : g);
      if (r.pickedUp) { pickedUp++; }
      if (g !== undefined) {
        points += stablefordPoints(g, holes[i].par, alloc[i]);
      }
      if (typeof g === 'number') {
        gross += g; net += g - alloc[i]; played++; parPlayed += holes[i].par;
      }
      if (typeof r.putts === 'number') { putts += r.putts; puttHoles++; }
      if (holes[i].par >= 4 && r.fir) { firTot++; if (r.fir === 'hit') firHit++; }
      if (typeof r.gir === 'boolean') { girTot++; if (r.gir) girHit++; }
      if (typeof r.penalties === 'number') pen += r.penalties;
    }
    var complete = (played + pickedUp) === holes.length;
    var ags = complete ? adjustedGross(grossScores, holes, alloc) : null;
    // Score differential: PCC från förbundet om den angetts (annars 0 = preliminär).
    var pcc = typeof round.pcc === 'number' ? round.pcc : 0, diff18 = null, diff9 = null;
    if (ags !== null && rated) {
      if (nine) {
        var d9 = (113 / tee.slope) * (ags - tee.cr - 0.5 * pcc);
        diff9 = Math.round(d9 * 10) / 10;
        diff18 = Math.round((d9 + expected9(round.hi)) * 10) / 10;
      } else diff18 = scoreDifferential(ags, tee.cr, tee.slope, pcc);
    }
    return {
      par: par, courseHandicap: ch, playingHandicap: ph, allocation: alloc,
      gross: gross, net: net, points: points, putts: putts, puttHoles: puttHoles,
      played: played, pickedUp: pickedUp, parPlayed: parPlayed, complete: complete,
      toPar: gross - parPlayed,
      firHit: firHit, firTot: firTot, girHit: girHit, girTot: girTot, penalties: pen,
      adjustedGross: ags,
      differential: diff18,
      differential9: diff9,
      pccKnown: typeof round.pcc === 'number',
      nine: nine,
      unrated: !rated
    };
  }

  // Statistik över de senaste n avslutade ronderna (summaries i nyast-först-ordning).
  function aggregate(summaries, n) {
    var list = summaries.slice(0, n);
    var out = { rounds: list.length, avgGross: null, avgPoints: null, avgPutts: null, firPct: null, girPct: null, avgPen: null };
    if (!list.length) return out;
    var full = list.filter(function (s) { return s.complete && s.pickedUp === 0 && !s.nine; });
    function avg(arr) { return arr.length ? arr.reduce(function (a, b) { return a + b; }, 0) / arr.length : null; }
    out.avgGross = avg(full.map(function (s) { return s.gross; }));
    out.avgPoints = avg(list.filter(function (s) { return !s.nine; }).map(function (s) { return s.points; }));
    var puttRounds = list.filter(function (s) { return s.puttHoles === s.played && s.played > 0; });
    out.avgPutts = avg(puttRounds.map(function (s) { return s.putts * 18 / s.played; }));
    var fH = 0, fT = 0, gH = 0, gT = 0;
    list.forEach(function (s) { fH += s.firHit; fT += s.firTot; gH += s.girHit; gT += s.girTot; });
    out.firPct = fT ? fH / fT * 100 : null;
    out.girPct = gT ? gH / gT * 100 : null;
    out.avgPen = avg(list.map(function (s) { return s.penalties; }));
    return out;
  }

  function validateTee(tee) {
    var errors = [];
    if (!tee.name) errors.push('tee-namn saknas');
    var skip = tee.unrated && (tee.cr === null || tee.cr === undefined) && (tee.slope === null || tee.slope === undefined);
    if (!skip && !(tee.cr > 50 && tee.cr < 90)) errors.push('Course Rating ska vara mellan 50 och 90');
    if (!skip && !(tee.slope >= 55 && tee.slope <= 155)) errors.push('Slope Rating ska vara mellan 55 och 155');
    if (!tee.holes || (tee.holes.length !== 18 && tee.holes.length !== 9)) errors.push('9 eller 18 hål krävs');
    else {
      var nh = tee.holes.length, sis = tee.holes.map(function (h) { return h.si; }).slice().sort(function (a, b) { return a - b; });
      for (var i = 0; i < nh; i++) if (sis[i] !== i + 1) { errors.push('hålindex måste vara 1–' + nh + ', var och en en gång'); break; }
      tee.holes.forEach(function (h, i) {
        if (!(h.par >= 3 && h.par <= 6)) errors.push('par på hål ' + (i + 1) + ' ska vara 3–6');
      });
    }
    return errors;
  }

  var Core = {
    whsRound: whsRound, parseHandicapIndex: parseHandicapIndex, formatHandicap: formatHandicap,
    formatSigned: formatSigned, courseHandicapExact: courseHandicapExact, courseHandicap: courseHandicap,
    playingHandicap: playingHandicap, strokesOnHole: strokesOnHole, strokeAllocation: strokeAllocation,
    stablefordPoints: stablefordPoints, netDoubleBogey: netDoubleBogey, adjustedGross: adjustedGross,
    scoreDifferential: scoreDifferential, sumPar: sumPar, summarizeRound: summarizeRound,
    aggregate: aggregate, validateTee: validateTee, teeRated: teeRated, courseHandicap9: courseHandicap9, expected9: expected9
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  root.Core = Core;
})(typeof window !== 'undefined' ? window : globalThis);
