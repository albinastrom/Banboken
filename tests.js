/* Banboken – tester för handicap- och poängberäkningar.
   Körs i appen (Profil → Kör beräkningstester) och med: node tests.js */
(function (root) {
  'use strict';
  function runTests(Core, Geo, Games, Stats, Sync, Ratings, Net) {
    var results = [];
    function eq(name, actual, expected) {
      var ok = JSON.stringify(actual) === JSON.stringify(expected);
      results.push({ name: name, ok: ok, actual: actual, expected: expected });
    }

    // Avrundning enligt WHS
    eq('Avrundning 12,5 → 13', Core.whsRound(12.5), 13);
    eq('Avrundning 12,49 → 12', Core.whsRound(12.49), 12);
    eq('Avrundning −2,5 → −2 (uppåt)', Core.whsRound(-2.5), -2);
    eq('Avrundning −2,51 → −3', Core.whsRound(-2.51), -3);

    // Handicapindex-tolkning
    eq('Tolka "18,4"', Core.parseHandicapIndex('18,4'), 18.4);
    eq('Tolka "+2.3" som plus', Core.parseHandicapIndex('+2.3'), -2.3);
    eq('Avvisa "60"', Core.parseHandicapIndex('60'), null);
    eq('Visa −2,3 som +2,3', Core.formatHandicap(-2.3), '+2,3');

    // Course Handicap = HI × Slope/113 + (CR − Par)
    eq('CH: HI 18,4 / Slope 128 / CR 71,2 / Par 72 → 20', Core.courseHandicap(18.4, 128, 71.2, 72), 20);
    eq('CH: HI 0 / Slope 113 / CR 72 / Par 72 → 0', Core.courseHandicap(0, 113, 72, 72), 0);
    eq('CH: HI +2,3 / Slope 130 / CR 73,1 / Par 72 → −2', Core.courseHandicap(-2.3, 130, 73.1, 72), -2);
    eq('CH: HI 54 / Slope 155 / CR 74 / Par 72 → 76', Core.courseHandicap(54, 155, 74, 72), 76);
    eq('CH: HI 10 / Slope 113 / CR 70,5 / Par 72 → 9 (8,5 avrundas upp)', Core.courseHandicap(10, 113, 70.5, 72), 9);

    // Playing Handicap med handicapreduktion
    eq('PH 100 % av 20 → 20', Core.playingHandicap(20, 100), 20);
    eq('PH 95 % av 20 → 19', Core.playingHandicap(20, 95), 19);
    eq('PH 95 % av 10 → 10 (9,5 avrundas upp)', Core.playingHandicap(10, 95), 10);
    eq('PH 85 % av 15 → 13', Core.playingHandicap(15, 85), 13);
    eq('PH 90 % av 7 → 6', Core.playingHandicap(7, 90), 6);

    // Slagfördelning per hålindex
    eq('PH 20: hålindex 1 → 2 slag', Core.strokesOnHole(20, 1), 2);
    eq('PH 20: hålindex 2 → 2 slag', Core.strokesOnHole(20, 2), 2);
    eq('PH 20: hålindex 3 → 1 slag', Core.strokesOnHole(20, 3), 1);
    eq('PH 18: hålindex 18 → 1 slag', Core.strokesOnHole(18, 18), 1);
    eq('PH 0: hålindex 1 → 0 slag', Core.strokesOnHole(0, 1), 0);
    eq('PH 40: hålindex 4 → 3 slag', Core.strokesOnHole(40, 4), 3);
    eq('PH 40: hålindex 5 → 2 slag', Core.strokesOnHole(40, 5), 2);
    eq('PH −2: hålindex 18 → −1', Core.strokesOnHole(-2, 18), -1);
    eq('PH −2: hålindex 17 → −1', Core.strokesOnHole(-2, 17), -1);
    eq('PH −2: hålindex 16 → 0', Core.strokesOnHole(-2, 16), 0);

    var holes = [];
    for (var i = 0; i < 18; i++) holes.push({ par: 4, si: i + 1 });
    [0, 7, 18, 25, 36, 41, -3].forEach(function (ph) {
      var total = Core.strokeAllocation(ph, holes).reduce(function (a, b) { return a + b; }, 0);
      eq('Summan av fördelade slag = PH (' + ph + ')', total, ph);
    });

    // Poängbogey
    eq('Poäng: par 4, 1 slag, brutto 5 → 2', Core.stablefordPoints(5, 4, 1), 2);
    eq('Poäng: par 4, 1 slag, brutto 4 → 3', Core.stablefordPoints(4, 4, 1), 3);
    eq('Poäng: par 3, 0 slag, brutto 1 → 4', Core.stablefordPoints(1, 3, 0), 4);
    eq('Poäng: par 4, 1 slag, brutto 8 → 0', Core.stablefordPoints(8, 4, 1), 0);
    eq('Poäng: struket hål → 0', Core.stablefordPoints(null, 4, 1), 0);
    eq('Poäng: plushandicap, par 4, −1 slag, brutto 4 → 1', Core.stablefordPoints(4, 4, -1), 1);

    // Netto dubbelbogey och Score Differential
    eq('Netto dubbelbogey: par 4, 1 slag → 7', Core.netDoubleBogey(4, 1), 7);
    eq('Differential: 90 / CR 71,2 / Slope 128 → 16,6', Core.scoreDifferential(90, 71.2, 128, 0), 16.6);

    // Hel rond
    var tee = { name: 'Test', cr: 71.2, slope: 128, holes: [] };
    var pars = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 4, 3, 5, 4, 4, 3, 4, 5];
    for (var j = 0; j < 18; j++) tee.holes.push({ par: pars[j], si: j + 1, length: 350 });
    var round = { hi: 18.4, allowance: 100, holes: [] };
    for (var k = 0; k < 18; k++) round.holes.push({ strokes: pars[k] + 1, putts: 2 });
    round.holes[0] = { strokes: 9, putts: 3 };   // kapas till netto dubbelbogey (4+2+2 = 8)
    round.holes[17] = { pickedUp: true };         // struket hål → NDB (5+2+1 = 8), 0 poäng
    var s = Core.summarizeRound(round, tee);
    eq('Rond: banans par', s.par, 72);
    eq('Rond: spelhandicap', s.playingHandicap, 20);
    eq('Rond: brutto (17 spelade hål)', s.gross, 9 + pars.slice(1, 17).reduce(function (a, b) { return a + b; }, 0) + 16);
    eq('Rond: poäng', s.points, 0 + 3 * 1 + 2 * 15 + 0);
    eq('Rond: komplett med ett struket hål', [s.complete, s.pickedUp], [true, 1]);
    eq('Rond: justerat brutto', s.adjustedGross, 8 + (pars.slice(1, 17).reduce(function (a, b) { return a + b; }, 0) + 16) + 8);
    eq('Tee-validering godkänner korrekt tee', Core.validateTee(tee), []);


    // ---------- 9 hål och PCC (WHS) ----------
    eq('9 hål: Course Handicap = HI/2 × Slope/113 + (CR − Par): 14,0 / 113 / 34,5 / 36 → 6', Core.courseHandicap9(14, 113, 34.5, 36), 6);
    eq('9 hål: förväntad differential för HI 14,0 = 8,48', Math.round(Core.expected9(14) * 100) / 100, 8.48);
    var t9 = { cr: 33.8, slope: 113, holes: [] }; for (var n9 = 0; n9 < 9; n9++) t9.holes.push({ par: 4, si: n9 + 1 });
    var r9 = { hi: 14, allowance: 100, holes: [] }; [5, 4, 5, 4, 5, 4, 5, 4, 5].forEach(function (g) { r9.holes.push({ strokes: g }); });
    var s9 = Core.summarizeRound(r9, t9);
    eq('9 hål: 41 slag, CR 33,8, Slope 113 → 9-hålsdifferential 7,2 och 18-hålsdifferential 15,7 (USGA:s exempel)', [s9.gross, s9.differential9, s9.differential, s9.nine], [41, 7.2, 15.7, true]);
    var rp = JSON.parse(JSON.stringify(round)); rp.pcc = 1;
    var sp = Core.summarizeRound(rp, tee);
    eq('PCC +1 sänker score differential (preliminär → med PCC)', [sp.pccKnown, sp.differential < s.differential, s.pccKnown], [true, true, false]);
    // Banor utan Course Rating/Slope: bara brutto
    var ut = { name: 'Gul', cr: null, slope: null, unrated: true, holes: tee.holes };
    eq('Tee utan CR/Slope godkänns när det är markerat', Core.validateTee(ut), []);
    eq('Tee utan CR/Slope underkänns om det inte är markerat', Core.validateTee({ name: 'Gul', cr: null, slope: null, holes: tee.holes }).length, 2);
    var us = Core.summarizeRound(round, ut);
    eq('Rond utan CR/Slope: inga hcp-slag, ingen differential', [us.playingHandicap, us.differential, us.unrated, us.gross], [0, null, true, s.gross]);


    if (Geo) {
      var O = [57.0, 14.0], P = Geo.proj(O);
      function L(x, y) { return P.ll([x, y]); }
      function sq(x0, y0, x1, y1) { return [L(x0, y0), L(x1, y0), L(x1, y1), L(x0, y1)]; }
      eq('GPS: 0,001° latitud ≈ 111 m', Math.round(Geo.dist([57, 14], [57.001, 14])), 111);
      eq('GPS: 0,001° longitud vid 60° N ≈ 56 m', Math.round(Geo.dist([60, 14], [60, 14.001])), 56);
      eq('GPS: bäring rakt norrut = 0°', Math.round(Geo.bearing([57, 14], [57.01, 14])), 0);
      eq('GPS: bäring rakt österut ≈ 90°', Math.round(Geo.bearing([57, 14], [57, 14.01])), 90);
      var green = sq(-10, 90, 10, 110);
      var gd = Geo.greenDistances(O, green);
      eq('Green: fram/mitt/bak = 90/100/110 m', [Math.round(gd.front), Math.round(gd.mid), Math.round(gd.back)], [90, 100, 110]);
      var gd2 = Geo.greenDistances(L(0, 95), green);
      eq('Green: på greenen saknas framkant', [gd2.front, gd2.inside], [null, true]);
      var gd3 = Geo.greenDistances(O, null, L(0, 150));
      eq('Green utan polygon: bara ungefärlig mitt', [gd3.front, Math.round(gd3.mid), gd3.exact], [null, 150, false]);
      var hz = Geo.hazardsAhead(O, Geo.centroid(green), [
        { kind: 'bunker', poly: sq(15, 40, 25, 50) },
        { kind: 'bunker', poly: sq(15, -30, 25, -20) },
        { kind: 'water', poly: sq(-30, 60, -15, 75) },
        { kind: 'water', poly: sq(-20, 20, 20, 30) }
      ]);
      eq('Hinder: bakom spelaren räknas inte', hz.length, 3);
      eq('Hinder: vatten tvärs över – nå 20, passera 30, mitt', [hz[0].kind, Math.round(hz[0].reach), Math.round(hz[0].carry), hz[0].side], ['water', 20, 30, 'center']);
      eq('Hinder: bunker höger – nå 40, passera 50', [hz[1].side, Math.round(hz[1].reach), Math.round(hz[1].carry)], ['right', 40, 50]);
      eq('Hinder: vatten vänster', hz[2].side, 'left');
      var dl = Geo.doglegs(O, [L(0, 0), L(0, 200), L(100, 350)]);
      eq('Dogleg höger på 200 m', [dl.length, dl[0].dir, Math.round(dl[0].distance)], [1, 'right', 200]);
      eq('Dogleg passerad räknas inte', Geo.doglegs(L(0, 250), [L(0, 0), L(0, 200), L(100, 350)]).length, 0);
      eq('Vind: från green mot spelaren = motvind', Geo.windRelative(0, 0).type, 'head');
      eq('Vind: medvind', Geo.windRelative(180, 0).type, 'tail');
      eq('Vind: från höger', Geo.windRelative(90, 0).type, 'fromRight');
      function way(id, tags, pts) { return { type: 'way', id: id, tags: tags, geometry: pts.map(function (p) { return { lat: p[0], lon: p[1] }; }) }; }
      var osm = { elements: [
        way(1, { golf: 'hole', ref: '1', par: '4', handicap: '7' }, [L(0, 0), L(0, 300)]),
        way(2, { golf: 'green' }, sq(-12, 290, 12, 315)),
        way(3, { golf: 'bunker' }, sq(16, 285, 24, 295)),
        way(4, { natural: 'water' }, sq(400, 0, 450, 50)),
        way(5, { golf: 'hole', ref: '2', par: '3' }, [L(100, 320), L(100, 470)])
      ] };
      var geo = Geo.buildFromOsm(osm, { osmRef: 'way/9' });
      eq('OSM: hål, par och index läses in', [geo.holes['1'].par, geo.holes['1'].si], [4, 7]);
      eq('OSM: green kopplas till rätt hål', [!!geo.holes['1'].green, !!geo.holes['2'].green], [true, false]);
      eq('OSM: bunker nära hålet kopplas, avlägset vatten gör det inte', geo.holes['1'].hazards.map(function (h) { return h.kind; }), ['bunker']);
      var cov = Geo.coverage(geo);
      eq('OSM: täckning räknas per hål', [cov.holes, cov.greens, cov.list[1], cov.list[2], cov.list[3]], [2, 1, 'full', 'line', 'none']);
      eq('Närmaste hål', Geo.nearestHole(L(98, 400), geo.holes).ref, '2');
      var spec = []; for (var q = 0; q < 18; q++) spec.push({ par: 4, si: q + 1, length: 350 });
      var demo = Geo.demoGeometry([57.1, 14.1], spec);
var dj = { elements: [
        { type: 'way', id: 1, tags: { leisure: 'golf_course', name: 'Ullna Golf & Country Club', 'addr:city': 'Åkersberga' }, bounds: { minlat: 59.48, minlon: 18.15, maxlat: 59.50, maxlon: 18.18 } },
        { type: 'relation', id: 2, tags: { leisure: 'golf_course', name: 'Ullna Golf & Country Club' }, bounds: { minlat: 59.481, minlon: 18.151, maxlat: 59.501, maxlon: 18.181 } },
        { type: 'way', id: 3, tags: { leisure: 'golf_course', name: 'Österåkers GK' }, bounds: { minlat: 59.46, minlon: 18.30, maxlat: 59.47, maxlon: 18.32 } },
        { type: 'way', id: 4, tags: { leisure: 'golf_course' }, bounds: { minlat: 59.0, minlon: 18.0, maxlat: 59.01, maxlon: 18.01 } },
        { type: 'way', id: 5, tags: { leisure: 'golf_course', golf: 'driving_range', name: 'Range' }, bounds: { minlat: 59.0, minlon: 18.0, maxlat: 59.01, maxlon: 18.01 } }
      ] };
      var dir = Geo.parseDirectory(dj);
      eq('Banregister: dubbletter slås ihop, range och namnlösa tas bort', [dir.items.length, dir.unnamed, dir.items[0].t], [2, 1, 'relation']);
      eq('Banregister: sök utan å/ä/ö-krav', Geo.searchDirectory(dir.items, 'osteraker').map(function (x) { return x.it.n; }), ['Österåkers GK']);
      eq('Banregister: sortering efter avstånd', Geo.searchDirectory(dir.items, '', [59.465, 18.31])[0].it.n, 'Österåkers GK');
// ---------- Live-GPS: scenarier ----------
      var gC = L(0, 300), gPoly = sq(-12, 288, 12, 312), teeP = L(0, 0);
      var d0 = Geo.greenDistances(teeP, gPoly);
      eq('GPS 1: på tee – fram/mitt/bak 288/300/312 m', [Math.round(d0.front), Math.round(d0.mid), Math.round(d0.back)], [288, 300, 312]);
      eq('GPS 1: mitt räknas med haversine', Math.round(d0.mid), Math.round(Geo.dist(teeP, Geo.centroid(gPoly))));
      var fwd = Geo.offsetPoint(teeP, 0, 20, 0);
      eq('GPS 2: 20 m framåt → 280 m till mitt', Math.round(Geo.greenDistances(fwd, gPoly).mid), 280);
      var rgt = Geo.offsetPoint(teeP, 0, 0, 20);
      eq('GPS 3: 20 m åt höger → √(300²+20²) ≈ 301 m', Math.round(Geo.greenDistances(rgt, gPoly).mid), Math.round(Math.sqrt(300 * 300 + 400)));
      eq('GPS 3: framkant följer ny spellinje', Math.round(Geo.greenDistances(rgt, gPoly).front), Math.round(288 * Math.sqrt(300 * 300 + 400) / 300));
      var bwd = Geo.offsetPoint(teeP, 0, -20, 0);
      eq('GPS 4: 20 m bakåt → 320 m till mitt', Math.round(Geo.greenDistances(bwd, gPoly).mid), 320);
      var F = Geo.createGpsFilter(), T0 = 1000000;
      eq('Filter: första positionen godkänns', F.push({ lat: teeP[0], lon: teeP[1], acc: 4, ts: T0 }, T0).reason, 'first');
      var maxDev = 0;
      [[1.5, -1], [-2, 1.5], [1, 2], [-1.5, -2], [2, 0.5], [-1, 1]].forEach(function (n, k) {
        var np = Geo.offsetPoint(teeP, 0, n[0], n[1]), r5 = F.push({ lat: np[0], lon: np[1], acc: 5, ts: T0 + (k + 1) * 1000 }, T0 + (k + 1) * 1000);
        maxDev = Math.max(maxDev, Geo.dist(teeP, [r5.pos.lat, r5.pos.lon]));
      });
      eq('GPS 5: står stilla – markören rör sig mindre än bruset (≤ 1,5 m)', maxDev <= 1.5, true);
      var jp = Geo.offsetPoint(teeP, 0, 400, 0);
      eq('Filter: orimligt hopp 400 m på 1 s avvisas', F.push({ lat: jp[0], lon: jp[1], acc: 5, ts: T0 + 8000 }, T0 + 8000).reason, 'jump');
      var w1 = Geo.offsetPoint(teeP, 0, 1.4, 0);
      var rw = F.push({ lat: w1[0], lon: w1[1], acc: 4, ts: T0 + 9000, speed: 1.4 }, T0 + 9000);
      eq('Filter: när man börjar gå (fart > 0,6 m/s) följer markören direkt', [rw.reason, Math.round(Geo.dist(teeP, [rw.pos.lat, rw.pos.lon]) * 10) / 10], ['move', 1.4]);
      eq('Filter: gammal tidsstämpel avvisas', F.push({ lat: w1[0], lon: w1[1], acc: 4, ts: T0 + 9000 }, T0 + 9500).reason, 'old');
      eq('Filter: position äldre än 20 s avvisas', Geo.createGpsFilter().push({ lat: 1, lon: 1, acc: 4, ts: T0 }, T0 + 25000).reason, 'stale');
      eq('Filter: noggrannhet sämre än 150 m avvisas', Geo.createGpsFilter().push({ lat: 1, lon: 1, acc: 300, ts: T0 }, T0).reason, 'inaccurate');
      var F2 = Geo.createGpsFilter(); F2.push({ lat: teeP[0], lon: teeP[1], acc: 4, ts: T0 }, T0);
      var far = Geo.offsetPoint(teeP, 90, 2000, 0), rr = [];
      for (var q2 = 1; q2 <= 3; q2++) rr.push(F2.push({ lat: far[0], lon: far[1], acc: 5, ts: T0 + q2 * 1000 }, T0 + q2 * 1000).reason);
      eq('Filter: tre samstämmiga positioner på nytt ställe godkänns (återhämtning)', rr, ['jump', 'jump', 'relocated']);
      eq('GPS 6: ingen ny position på 16 s → signal förlorad', Geo.gpsQuality({ acc: 5, ts: T0 }, T0 + 16000), 'lost');
      eq('GPS-status: ±25 m → låg noggrannhet', Geo.gpsQuality({ acc: 25, ts: T0 }, T0 + 1000), 'weak');
      eq('GPS-status: ±5 m → bra', Geo.gpsQuality({ acc: 5, ts: T0 }, T0 + 1000), 'good');
// Overpass-frågan för en bana
      var cq = Geo.courseQuery({ type: 'way', id: 123 }, [59.40, 18.10, 59.42, 18.14]);
      eq('Fråga: begränsad till banans område med marginal', /\[bbox:59\.39850,18\.09720,59\.42150,18\.14280\]/.test(cq), true);
      eq('Fråga: geometrin klipps till området (inga hela sjöar)', /out geom\(59\.39850,18\.09720,59\.42150,18\.14280\);$/.test(cq), true);
      eq('Fråga: ingen tung areasökning och bara nödvändiga golfobjekt', [cq.indexOf('map_to_area'), cq.indexOf('nwr[golf]'), /golf~"\^\(hole\|green/.test(cq)], [-1, -1, true]);
      var nb = { elements: [
        { type: 'way', id: 9, tags: { leisure: 'golf_course' }, geometry: sq(-50, -50, 150, 400).concat([L(-50, -50)]).map(function (p) { return { lat: p[0], lon: p[1] }; }) },
        way(1, { golf: 'hole', ref: '1', par: '4' }, [L(0, 0), L(0, 300)]),
        way(2, { golf: 'hole', ref: '1', par: '5' }, [L(600, 0), L(600, 400)])
      ] };
      var nbg = Geo.buildFromOsm(nb, { osmRef: 'way/9', boundary: 'way/9' });
      eq('Grannbanans hål med samma nummer sorteras bort via banans kontur', [nbg.holes['1'].par, nbg.duplicates, nbg.outside], [4, 0, 1]);
      eq('Demo-geometri: 18 hål med green', Geo.coverage(demo).greens, 18);
    }

    if (Games) {
      function mkTee() { var hs = []; for (var i = 0; i < 18; i++) hs.push({ par: 4, si: i + 1 }); return { cr: 72, slope: 113, holes: hs }; }
      function mkP(id, hi, scores) { return { id: id, name: id, hi: hi, tee: mkTee(), holes: scores.map(function (s) { return s === 'x' ? { pickedUp: true } : s === undefined ? {} : { strokes: s }; }) }; }
      function rep(v, n) { var a = []; for (var i = 0; i < n; i++) a.push(v); return a; }
      eq('Lag-hcp scramble 2: 35 % + 15 % (10 och 20) → 7', Games.teamPlayingHcp([20, 10], 'scramble2'), 7);
      eq('Lag-hcp scramble 4: 25/20/15/10 % (4, 8, 12, 16) → 6', Games.teamPlayingHcp([16, 4, 12, 8], 'scramble4'), 6);
      eq('Lag-hcp greensome: 60 % + 40 % (9 och 21) → 14', Games.teamPlayingHcp([9, 21], 'greensome'), 14);
      eq('Lag-hcp foursome: 50 % av summan (9 och 20) → 15', Games.teamPlayingHcp([9, 20], 'foursome'), 15);
      eq('Lag-hcp fel lagstorlek → ingen', Games.teamPlayingHcp([9], 'foursome'), null);

      var ms = Games.matchStatus([3, 4, 4, 5], [4, 4, 5, 4], 0, 18);
      eq('Match: 2 upp efter 3 vunna/delade, 1 upp efter 4', [ms.up, ms.thru, ms.closed], [1, 4, false]);
      var aW = rep(3, 18), bL = rep(4, 18);
      var ms2 = Games.matchStatus(aW, bL, 0, 18);
      eq('Match: avgjord 10/8', [ms2.closed, ms2.winner, ms2.result, ms2.thru], [true, 'A', '10/8', 10]);
      var ms3 = Games.matchStatus(rep(4, 18), rep(4, 18), 0, 18);
      eq('Match: alla hål delade → delad match', [ms3.winner, ms3.result], ['halved', 'halved']);
      var d1 = rep(4, 16).concat([undefined, undefined]), d2 = [3, 3].concat(rep(4, 14)).concat([undefined, undefined]);
      eq('Match: dormie 2 upp med 2 kvar', Games.matchStatus(d2, d1, 0, 18).dormie, true);
      eq('Match: struket hål förlorar mot spelat', Games.matchStatus([null], [6], 0, 18).up, -1);

      var teams = [{ id: 'A', name: 'Lag A', members: ['p1', 'p2'] }, { id: 'B', name: 'Lag B', members: ['p3', 'p4'] }, { id: 'S1', name: 'P1', members: ['p1'] }, { id: 'S3', name: 'P3', members: ['p3'] }];
      // Singelmatch: p1 hcp 10, p3 hcp 14 → p3 får 4 slag (hålindex 1–4). Lika brutto → p3 vinner hål 1–4.
      var players = [mkP('p1', 10, rep(4, 18)), mkP('p2', 20, rep(5, 18)), mkP('p3', 14, rep(4, 18)), mkP('p4', 5, rep(4, 18))];
      var sm = Games.compute({ type: 'match', sides: ['S1', 'S3'], allowance: 100 }, { players: players, teams: teams });
      eq('Singelmatch: slag till högre hcp = skillnaden', sm.strokes.map(function (x) { return x.ph; }), [0, 4]);
      eq('Singelmatch: P3 vinner hål 1–4, avgjort 4/3 efter 15 hål', [sm.up, sm.thru, sm.winner, sm.result], [-4, 15, 'B', '4/3']);
      // Bästboll match 90 %: p1 10→9, p2 20→18, p3 14→13 (12,6), p4 5→5 (4,5→5). Lägst 5 → 4, 13, 8, 0
      var fb = Games.compute({ type: 'match', sides: ['A', 'B'], allowance: 90 }, { players: players, teams: teams });
      eq('Bästboll match 90 %: slag relativt lägsta spelaren', fb.strokes.map(function (x) { return x.ph; }), [4, 13, 8, 0]);
      eq('Bästboll match: Lag B vinner hål 5–8, avgjort 4/3', [fb.winner, fb.result], ['B', '4/3']);
      var nas = Games.compute({ type: 'nassau', sides: ['S1', 'S3'], allowance: 100 }, { players: players, teams: teams });
      eq('Nassau: ut/in/totalt', [nas.front.winner, nas.back.winner, nas.total.winner], ['B', 'halved', 'B']);

      var st = Games.compute({ type: 'stroke', allowance: 100 }, { players: players, teams: teams });
      eq('Slagspel netto: ledare har lägst netto mot par', [st.rows[0].id, st.rows[0].netToPar], ['p3', -14]);
      var sf = Games.compute({ type: 'stableford', allowance: 100 }, { players: players, teams: teams });
      eq('Poängbogey: p3 = 36 + 14', [sf.rows[0].id, sf.rows[0].points], ['p3', 50]);
      var pk = [mkP('a', 0, ['x'].concat(rep(4, 17)))];
      eq('Slagspel: struket hål ger NR', Games.compute({ type: 'stroke', allowance: 100 }, { players: pk, teams: [] }).rows[0].nr, true);

      var bb = Games.compute({ type: 'bestball', teams: ['A', 'B'], scoring: 'stroke', allowance: 100 }, { players: players, teams: teams });
      eq('Bästboll slag: lagets bästa netto per hål (B −14, A −10)', bb.rows.map(function (r) { return [r.id, r.netToPar]; }), [['B', -14], ['A', -10]]);
      var wb = Games.compute({ type: 'worstball', teams: ['A', 'B'], scoring: 'stableford', allowance: 100 }, { players: players, teams: teams });
      eq('Sämstboll poäng: lagets sämsta poäng per hål', wb.rows.map(function (r) { return [r.id, r.points]; }), [['B', 41], ['A', 38]]);
      var wbx = Games.compute({ type: 'worstball', teams: ['A'], scoring: 'stroke', allowance: 100 }, { players: [mkP('p1', 0, ['x'].concat(rep(4, 17))), mkP('p2', 0, rep(4, 18))], teams: teams });
      eq('Sämstboll slag: struket hål hos en spelare ger lag-NR', wbx.rows[0].nr, true);

      // Skins: hål 1 delas (carry), hål 2 vinner p1 → 2 skins
      var sk = Games.compute({ type: 'skins', allowance: 100, carryover: true }, { players: [mkP('p1', 0, [4, 3, 4]), mkP('p2', 0, [4, 4, 5])], teams: [] });
      eq('Skins: delat hål går vidare, vinnaren tar potten', [sk.rows[0].id, sk.rows[0].skins, sk.rows[1].skins, sk.thru], ['p1', 3, 0, 3]);
      var sk2 = Games.compute({ type: 'skins', allowance: 100, carryover: true }, { players: [mkP('p1', 0, [4, 4]), mkP('p2', 0, [4, 4])], teams: [] });
      eq('Skins: potten ackumuleras', sk2.carry, 2);

      var sp = [mkP('p1', 10, []), mkP('p2', 20, [])];
      var stTeams = [{ id: 'A', name: 'Lag A', members: ['p1', 'p2'] }];
      var th = { A: rep(0, 18).map(function () { return { strokes: 4 }; }) };
      var ts = Games.compute({ type: 'teamStroke' }, { players: sp, teams: stTeams, teamHoles: th, teamMode: 'scramble2' });
      eq('Scramble 2: lag-hcp 7, netto −7', [ts.rows[0].ph, ts.rows[0].netToPar], [7, -7]);
      eq('Validering: foursome kräver lag om 2', Games.validate({ type: 'teamStroke' }, { players: sp, teams: [{ id: 'A', name: 'A', members: ['p1'] }], teamMode: 'foursome' }), 'teamSize');
      eq('Match: sida kan vara en spelare direkt', Games.compute({ type: 'match', sides: ['p1', 'p3'], allowance: 100 }, { players: players, teams: teams }).winner, 'B');
      eq('Validering: samma spelare på båda sidor avvisas', Games.validate({ type: 'match', sides: ['A', 'p1'] }, { players: players, teams: teams }), 'overlap');
      eq('Validering: match kräver två sidor', Games.validate({ type: 'match', sides: ['A'] }, { players: players, teams: teams }), 'twoSides');
    }

    if (Stats) {
      // Syntetisk testbaslinje – endast för att kontrollera räknelogiken, inga riktiga referensvärden.
      var B = { lies: { green: [[1, 1.1], [5, 1.6], [10, 1.9]], fairway: [[50, 2.5], [150, 3.0]], tee: [[300, 3.8], [400, 4.0]], rough: [[50, 2.7], [150, 3.2]], sand: [[10, 2.4], [50, 2.8]], recovery: [[50, 3], [150, 3.5]] } };
      eq('SG: interpolering mellan punkter', Math.round(Stats.expected(B, 'fairway', 100) * 100) / 100, 2.75);
      eq('SG: i hål = 0 slag kvar', Stats.expected(B, 'green', 0), 0);
      eq('SG: under 1 m på green går mot 1 putt', Math.round(Stats.expected(B, 'green', 0.5) * 100) / 100, 1.05);
      eq('SG: baslinje godkänns', Stats.validateBaseline(B), true);
      eq('SG: ofullständig baslinje avvisas', Stats.validateBaseline({ lies: { green: [[1, 1]] } }), false);
      eq('SG-kategori: utslag par 4 = tee', Stats.category({ lie: 'tee', dist: 380 }, 4), 'ott');
      eq('SG-kategori: utslag par 3 = inspel', Stats.category({ lie: 'tee', dist: 150 }, 3), 'app');
      eq('SG-kategori: 20 m ruff = närspel', Stats.category({ lie: 'rough', dist: 20 }, 4), 'arg');
      eq('SG-kategori: green = puttning', Stats.category({ lie: 'green', dist: 3 }, 4), 'putt');
      function rnd(holesData) {
        var tee = { cr: 72, slope: 113, holes: [] }; for (var i = 0; i < 18; i++) tee.holes.push({ par: 4, si: i + 1 });
        var hs = []; for (var j = 0; j < 18; j++) hs.push(holesData[j] || {});
        return { hi: 0, allowance: 100, tee: tee, holes: hs };
      }
      var shots = [{ lie: 'tee', dist: 400 }, { lie: 'fairway', dist: 150 }, { lie: 'green', dist: 10 }, { lie: 'green', dist: 1 }];
      var r1 = rnd([{ strokes: 4, putts: 2, holed: true, shots: shots }]);
      eq('Slaglogg: giltig när slag + plikt = score', Stats.validShots(r1.holes[0]), true);
      var sg1 = Stats.sgRound(r1, B);
      eq('SG: tee 0, inspel +0,1, puttar −0,1, totalt 0', [sg1.ott, sg1.app, sg1.putt, sg1.total], [0, 0.1, -0.1, 0]);
      var pen = JSON.parse(JSON.stringify(shots)); pen[0].pen = 1;
      var r2 = rnd([{ strokes: 5, holed: true, shots: pen }]);
      eq('SG: pliktslag på utslaget ger −1 på tee', Stats.sgRound(r2, B).ott, -1);
      eq('Slaglogg: ogiltig när score inte stämmer', Stats.validShots({ strokes: 6, holed: true, shots: shots }), false);
      var pts = Stats.shotPoints([r1]);
      eq('Datapunkter: slag kvar per slag', pts.map(function (p) { return p.rem; }), [4, 3, 2, 1]);
      var gp = []; for (var q = 0; q < 4; q++) { gp.push({ lie: 'green', dist: 1.5, rem: 1 }); gp.push({ lie: 'green', dist: 4, rem: 2 }); gp.push({ lie: 'green', dist: 7, rem: 1 }); }
      var pb = Stats.buildBaseline(gp, 4);
      eq('Personlig baslinje: medel per avståndsintervall, alltid stigande', pb.lies.green, [[1.5, 1], [4, 1.5], [7, 1.5]]);
      var mr = Stats.roundMetrics(rnd([
        { strokes: 6, putts: 3, gir: true }, { strokes: 4, putts: 1, gir: false }, { strokes: 6, putts: 2, gir: false, bunker: 1 }, { strokes: 4, putts: 3, gir: true }
      ]));
      eq('Statistik: trepputtar och extra slag', [mr.threePutts, mr.threePuttExtra], [2, 2]);
      eq('Statistik: scrambling 1 av 2, sand save 0 av 1', [mr.scrOk, mr.scrAtt, mr.sandOk, mr.sandAtt], [1, 2, 0, 1]);
      var many = []; for (var z = 0; z < 18; z++) many.push({ strokes: 6, putts: 3, gir: true });
      var ch = Stats.coach(Stats.roundMetrics(rnd(many)), [], null);
      eq('Coach: många trepputtar → fokus puttning', ch.focus[0].area, 'putting');
      eq('Coach: tre träningsförslag, puttning först', [ch.recs.length, ch.recs[0].drill], [3, 'puttLag']);
      eq('Coach: för få ronder för jämförelse markeras', ch.trend[0].code, 'fewRounds');
      eq('Coach: under 9 spelade hål ger ingen analys', Stats.coach(Stats.roundMetrics(rnd([{ strokes: 4 }])), [], null).enough, false);
      var cr = rnd([]); cr.holes[0] = { strokes: 4, holed: true, shots: [{ lie: 'tee', dist: 380, club: 'd' }, { lie: 'fairway', dist: 140, club: '7' }, { lie: 'green', dist: 6 }, { lie: 'green', dist: 1 }] };
      var cs = Stats.clubStats([cr, cr, cr]);
      eq('Klubblängd lärs från slag: driver 240 m, 7-järn 134 m', [cs.d.avg, cs.d.n, cs['7'].avg], [240, 3, 134]);
      var bag = [{ id: 'd', name: 'Driver', carry: 230 }, { id: '7', name: '7-järn', carry: 140 }, { id: 'p', name: 'Putter', putter: true }];
      eq('Klubbförslag använder inlärd längd', Stats.suggestClub(bag, cs, 135).name, '7-järn');
      eq('Klubbförslag saknas när inget passar', Stats.suggestClub(bag, cs, 60), null);
    }

    if (Sync) {
      function mkState() {
        return { profile: { name: 'A', hi: 10 }, courses: [{ id: 'demo', tees: [] }, { id: 'c1', name: 'Bana', tees: [] }],
          rounds: [{ id: 'r1', holes: [{ strokes: 4 }], tee: { holes: [{ par: 4 }] } }], bag: [], friends: [], baseline: null };
      }
      var S1 = mkState(), syn = {};
      var p1 = Sync.computePush(Sync.collectDocs(S1), syn);
      eq('Synk: demobanan skickas aldrig', p1.upserts.map(function (u) { return u.key; }).indexOf('course:demo'), -1);
      eq('Synk: första gången skickas alla dokument', p1.upserts.length, 5);
      p1.upserts.forEach(function (u) { syn[u.key] = u.h; });
      eq('Synk: oförändrat skickas inte igen', Sync.computePush(Sync.collectDocs(S1), syn).upserts.length, 0);
      S1.rounds[0].holes[0].strokes = 5;
      eq('Synk: ändrad rond skickas', Sync.computePush(Sync.collectDocs(S1), syn).upserts.map(function (u) { return u.key; }), ['round:r1']);
      S1.rounds[0].holes[0].strokes = 4; S1.courses = S1.courses.filter(function (c) { return c.id !== 'c1'; });
      eq('Synk: raderad bana skickas som borttagen', Sync.computePush(Sync.collectDocs(S1), syn).deletes.map(function (d) { return d.key; }), ['course:c1']);
      // Hämtning till en annan telefon
      var S2 = { profile: {}, courses: [], rounds: [], bag: [], friends: [], baseline: null }, syn2 = {};
      var rows = [{ kind: 'round', doc_id: 'r1', data: mkState().rounds[0] }, { kind: 'profile', doc_id: 'me', data: { name: 'A', hi: 10 } }, { kind: 'round', doc_id: 'x', data: { id: 'annat' } }];
      var res = Sync.applyPull(S2, syn2, rows);
      eq('Synk: hämtade dokument läggs in, ogiltiga ignoreras', [res.changed, res.invalid, S2.rounds.length, S2.profile.name], [2, 1, 1, 'A']);
      eq('Synk: efter hämtning finns inget att skicka', Sync.computePush(Sync.collectDocs(S2), syn2).upserts.filter(function (u) { return u.kind === 'round'; }).length, 0);
      S2.rounds[0].holes[0].strokes = 7;
      var res2 = Sync.applyPull(S2, syn2, [{ kind: 'round', doc_id: 'r1', data: { id: 'r1', holes: [{ strokes: 3 }], tee: { holes: [{ par: 4 }] } } }]);
      eq('Synk: lokal osynkad ändring vinner vid krock', [res2.conflicts, S2.rounds[0].holes[0].strokes], [1, 7]);
      var S3 = { profile: {}, courses: [], rounds: [mkState().rounds[0]], bag: [], friends: [], baseline: null }, syn3 = {};
      Sync.computePush(Sync.collectDocs(S3), syn3).upserts.forEach(function (u) { syn3[u.key] = u.h; });
      Sync.applyPull(S3, syn3, [{ kind: 'round', doc_id: 'r1', deleted: true }]);
      eq('Synk: borttagning från annan telefon tar bort rond', S3.rounds.length, 0);
      var SR = { profile: {}, courses: [], rounds: [], bag: [], friends: [], baseline: null, ratingLib: [{ club: 'A', course: 'B', combo: '18', tee: '56', gender: 'men', holes: '18', cr: 70, slope: 125, par: 72, source: 'x', verifiedAt: '2026-01-01' }] };
      eq('Synk: slopetabellen synkas som eget dokument', Sync.computePush(Sync.collectDocs(SR), {}).upserts.map(function (u) { return u.key; }).indexOf('ratings:all') >= 0, true);
      var lr = { extra: [{ id: 'p1', holes: [{}, {}, {}] }] };
      eq('Livematch: spelarens egna hål slås ihop', [Sync.mergeLiveScores(lr, { p1: { h: [5, 0, -1] } }), lr.extra[0].holes], [2, [{ strokes: 5 }, {}, { pickedUp: true }]]);
      eq('Livematch: okänd spelare ignoreras', Sync.mergeLiveScores(lr, { zz: { h: [3] } }), 0);
      var seq = [0.01, 0.2, 0.4, 0.6, 0.8, 0.99, 0.5, 0.3], qi = 0;
      var code = Sync.newCode(function () { return seq[qi++]; });
      eq('Livekod: 8 tecken utan förväxlingsbara tecken', [code.length, Sync.validCode(code), Sync.validCode('ABCD1234'), Sync.validCode('abcdefgh')], [8, true, false, false]);
    }

    if (Ratings) {
      var today = '2026-10-25';
      var csv = 'Klubb;Bana;Slinga;Tee;Färg;Längd;Par;Kön;Hål;CR;Slope;Källa;Verifierad\n' +
        'Exempel GK;Södra;18;56;Gul;5600;72;Herr;18;70,1;128;Scorekort 2026 (exempel);2026-04-01\n' +
        'Exempel GK;Södra;18;56;Gul;5600;72;Dam;18;75,4;136;Scorekort 2026 (exempel);2026-04-01\n' +
        'Exempel GK;Södra;18;56;Gul;2790;36;Herr;1-9;34,9;127;Scorekort 2026 (exempel);2026-04-01\n' +
        'Exempel GK;Södra;18;48;Röd;4800;72;Dam;18;70,9;125;Scorekort 2026 (exempel);2026-04-01\n' +
        'Exempel GK;Södra;18;48;Röd;4800;72;Dam;18;99,0;125;Scorekort 2026 (exempel);2026-04-01\n' +
        'Exempel GK;Södra;18;52;Blå;5200;72;Herr;18;68,0;121;;2026-04-01\n' +
        'Exempel GK;Södra;18;40;Vit;4000;72;Okänd;18;66,0;115;Scorekort;2027-01-01';
      var imp = Ratings.parseImport(csv, today);
      eq('Import CSV: semikolon, decimalkomma, svenska kolumnnamn', imp.rows.length, 4);
      eq('Import: ogiltig CR, saknad källa, okänt kön och framtida datum avvisas', imp.errors.map(function (x) { return x.errors.join(','); }), ['cr', 'source', 'gender,verifiedAt']);
      var jimp = Ratings.parseImport(JSON.stringify([{ club: 'Exempel GK', course: 'Södra', tee: 56, gender: 'men', holes: '18', cr: 70.1, slope: 128, par: 72, source: 'Scorekort', verifiedAt: '2026-04-01' }]), today);
      eq('Import JSON fungerar', jimp.rows.length, 1);
      var m1 = Ratings.mergeLibrary([], imp.rows, '2026-10-25T10:00:00Z');
      var m2 = Ratings.mergeLibrary(m1.lib, imp.rows.slice(0, 1).map(function (r) { var x = JSON.parse(JSON.stringify(r)); x.slope = 129; return x; }), '2026-10-26T10:00:00Z');
      eq('Bibliotek: samma värdering ersätts, inga dubbletter', [m1.added, m2.updated, m2.added, m2.lib.length], [4, 1, 0, 4]);
      var combo = Ratings.combos(m1.lib)[0];
      var base = []; for (var b2 = 0; b2 < 18; b2++) base.push({ par: 4, si: b2 + 1, length: 300 });
      var tees = Ratings.buildTees(m1.lib, combo, [{ id: 'old', name: '56', holes: base }]);
      eq('Tees byggs från slopetabellen, längst först, befintligt id behålls', tees.map(function (x) { return [x.name, x.id === 'old']; }), [['56', true], ['48', false]]);
      var g56 = tees[0];
      eq('Herr och dam blandas inte ihop: tee 56', [Ratings.ratingFor(g56, 'men').cr, Ratings.ratingFor(g56, 'women').cr], [70.1, 75.4]);
      eq('Saknad värdering ger ingen gissning (tee 48 herr)', Ratings.ratingFor(tees[1], 'men'), null);
      eq('9-hålsvärdering hämtas separat', [Ratings.ratingFor(g56, 'men', 'front9').cr, Ratings.ratingFor(g56, 'men', 'back9')], [34.9, null]);
      var nt = Ratings.nineTee({ id: 'x', name: '56', holes: [3, 1, 17, 5, 9, 7, 13, 11, 15, 2, 4, 6, 8, 10, 12, 14, 16, 18].map(function (si) { return { par: 4, si: si }; }) }, 'back9', { cr: 35, slope: 120 });
      eq('9 hål: hål 10–18 med hålindex rangordnat 1–9', [nt.offset, nt.holes.map(function (h) { return h.si; }).join()], [9, '1,2,3,4,5,6,7,8,9']);
      eq('Egen (ej officiell) värdering märks', Ratings.ratingFor({ cr: 71, slope: 125, holes: [] }, 'women').official, false);
      var aud = Ratings.audit([{ id: 'c', name: 'Exempel GK Södra', tees: tees }, { id: 'd', name: 'Tom bana', tees: [] }], m1.lib);
      eq('Granskning: saknad damvärdering och saknad koppling hittas', [aud[0].issues.some(function (x) { return x.code === 'noRating' && x.tee === '48' && x.gender === 'men'; }), aud[1].issues.map(function (x) { return x.code; }).indexOf('noTees') >= 0], [true, true]);
      eq('Koppling via förslag på namn', Ratings.suggestCombos(m1.lib, { name: 'Exempel GK', club: '' })[0].course, 'Södra');
    }

    if (Net) {
      eq('Felklass: HTTP 504 = serverfel', Net.classify({ status: 504 }), 'server');
      eq('Felklass: 429 = överbelastning, 400 = klientfel, avbrott = tidsgräns', [Net.classify({ status: 429 }), Net.classify({ status: 400 }), Net.classify({ name: 'AbortError' })], ['rate', 'client', 'timeout']);
      eq('Felklass: utan uppkoppling = nätverk', Net.classify(new TypeError('Load failed'), false), 'network');
      eq('Väntetid växer exponentiellt med tak', [Net.backoffMs(0, null, 0.5), Net.backoffMs(1, null, 0.5), Net.backoffMs(2, null, 0.5), Net.backoffMs(5, null, 0.5)], [1000, 2000, 4000, 8000]);
      eq('Retry-After från servern respekteras (max 8 s)', [Net.backoffMs(0, null, 0.5, 3), Net.backoffMs(0, null, 0.5, 60)], [3000, 8000]);
    }
    return results;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = runTests;
  root.runCoreTests = runTests;
})(typeof window !== 'undefined' ? window : globalThis);

function runAsyncNetTests(Net) {
  var out = [];
  function eqA(name, a, b) { out.push({ name: name, ok: JSON.stringify(a) === JSON.stringify(b), actual: a, expected: b }); }
  function client(script, extra) {
    var calls = [], sleeps = [];
    var c = Net.createOverpass(Object.assign({ servers: ['s1', 's2', 's3', 's4'], rand: function () { return 0.5; },
      sleep: function (ms) { sleeps.push(ms); return Promise.resolve(); },
      request: function (url, q, ms) { calls.push(url); var r = script[calls.length - 1]; return r && r.ok ? Promise.resolve(r.ok) : Promise.reject(r ? r.err : { status: 504 }); } }, extra || {}));
    return { c: c, calls: calls, sleeps: sleeps };
  }
  var a = client([{ err: { status: 504 } }, { err: { status: 504 } }, { ok: { elements: [1] } }]);
  var b = client([{ err: { status: 400 } }]);
  var c2 = client([{ err: { name: 'AbortError' } }, { err: { name: 'AbortError' } }, { err: { name: 'AbortError' } }, { err: { name: 'AbortError' } }]);
  var d = client([{ err: { status: 429, retryAfter: 2 } }, { ok: { elements: [] } }]);
  var e = client([{ ok: { elements: [] } }]);
  var f = client([{ err: new TypeError('Load failed') }], { online: function () { return false; } });
  var p1 = e.c.query('Q'), p2 = e.c.query('Q');
  return Promise.all([
    a.c.query('Q').then(function (j) { eqA('504 två gånger → lyckas på tredje servern efter väntan 1 s, 2 s', [j.elements.length, a.calls, a.sleeps], [1, ['s1', 's2', 's3'], [1000, 2000]]); }),
    b.c.query('Q').then(null, function (er) { eqA('Felaktig fråga (400) provas inte igen', [er.kind, b.calls.length], ['client', 1]); }),
    c2.c.query('Q').then(null, function (er) { eqA('Tidsgräns: max 4 försök, sedan tydligt fel', [er.kind, c2.calls.length], ['timeout', 4]); }),
    d.c.query('Q').then(function () { eqA('429 med Retry-After 2 s → väntar 2 s', d.sleeps, [2000]); }),
    Promise.all([p1, p2]).then(function () { eqA('Två identiska samtidiga förfrågningar → ett anrop', [e.calls.length, p1 === p2], [1, true]); }),
    f.c.query('Q').then(null, function (er) { eqA('Ingen uppkoppling → avbryts direkt utan nya försök', [er.kind, f.calls.length], ['network', 1]); })
  ]).then(function () {
    var mem = {}, store = { get: function (k) { return mem[k] || null; }, set: function (k, v) { if (v.length > 400) throw new Error('quota'); mem[k] = v; } };
    var cache = Net.createGeoCache(store, 'g', 3);
    cache.put('way/1', { holes: { 1: 1 } }, '2026-10-01'); cache.put('way/2', { holes: {} }, '2026-10-02'); cache.put('way/3', {}, '2026-10-03'); cache.put('way/4', {}, '2026-10-04');
    eqA('Cache: håller max 3 banor, äldsta släpps', [cache.size(), cache.get('way/1'), !!cache.get('way/4')], [3, null, true]);
    var big = Net.createGeoCache(store, 'h', 10);
    for (var i = 0; i < 8; i++) big.put('w' + i, { pad: 'xxxxxxxxxxxxxxxxxxxxxxxx' }, '2026-10-0' + i);
    eqA('Cache: full lagring hanteras genom att släppa äldsta, ingen krasch', big.size() > 0 && big.size() < 8 && !!big.get('w7'), true);
    return out;
  });
}
if (typeof module !== 'undefined') module.exports.runAsyncNetTests = runAsyncNetTests;
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  var r = module.exports(require('./core.js'), require('./geo.js'), require('./games.js'), require('./stats.js'), require('./sync.js'), require('./ratings.js'), require('./net.js'));
  var failed = r.filter(function (x) { return !x.ok; });
  r.forEach(function (x) { console.log((x.ok ? 'OK   ' : 'FEL  ') + x.name + (x.ok ? '' : '  (fick ' + JSON.stringify(x.actual) + ', väntat ' + JSON.stringify(x.expected) + ')')); });
  runAsyncNetTests(require('./net.js')).then(function (ra) {
    ra.forEach(function (x) { console.log((x.ok ? 'OK   ' : 'FEL  ') + x.name + (x.ok ? '' : '  (fick ' + JSON.stringify(x.actual) + ', väntat ' + JSON.stringify(x.expected) + ')')); });
    var all = r.concat(ra), bad = all.filter(function (x) { return !x.ok; });
    console.log('\n' + (all.length - bad.length) + ' av ' + all.length + ' tester godkända');
    process.exit(bad.length ? 1 : 0);
  });
}
