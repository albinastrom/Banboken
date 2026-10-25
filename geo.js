/* Banboken – geometri för GPS (etapp 2). Rena funktioner, koordinater som [lat, lon]. */
(function (root) {
  'use strict';
  var R = 6371008.8, D = Math.PI / 180;

  function dist(a, b) {
    var dLat = (b[0] - a[0]) * D, dLon = (b[1] - a[1]) * D;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[0] * D) * Math.cos(b[0] * D) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function bearing(a, b) {
    var y = Math.sin((b[1] - a[1]) * D) * Math.cos(b[0] * D);
    var x = Math.cos(a[0] * D) * Math.sin(b[0] * D) - Math.sin(a[0] * D) * Math.cos(b[0] * D) * Math.cos((b[1] - a[1]) * D);
    return (Math.atan2(y, x) / D + 360) % 360;
  }
  // Lokal plan projektion i meter runt en referenspunkt (x = öster, y = norr). Exakt nog inom en golfbana.
  function proj(ref) {
    var k = Math.cos(ref[0] * D);
    return {
      xy: function (p) { return [(p[1] - ref[1]) * D * R * k, (p[0] - ref[0]) * D * R]; },
      ll: function (q) { return [ref[0] + q[1] / (R * D), ref[1] + q[0] / (R * D * k)]; }
    };
  }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }
  function cross(a, b) { return a[0] * b[1] - a[1] * b[0]; }
  function len(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1]); }

  function centroid(poly) {
    if (!poly || !poly.length) return null;
    var P = proj(poly[0]), pts = poly.map(P.xy), A = 0, cx = 0, cy = 0;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i], q = pts[(i + 1) % pts.length], f = p[0] * q[1] - q[0] * p[1];
      A += f; cx += (p[0] + q[0]) * f; cy += (p[1] + q[1]) * f;
    }
    if (Math.abs(A) < 1e-6) {
      var sx = 0, sy = 0; pts.forEach(function (p) { sx += p[0]; sy += p[1]; });
      return P.ll([sx / pts.length, sy / pts.length]);
    }
    return P.ll([cx / (3 * A), cy / (3 * A)]);
  }
  function pointInPolyXY(p, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var a = poly[i], b = poly[j];
      if (((a[1] > p[1]) !== (b[1] > p[1])) && (p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0])) inside = !inside;
    }
    return inside;
  }
  function segInfo(p, a, b) {
    var ab = sub(b, a), l2 = dot(ab, ab), t = l2 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
    var c = [a[0] + ab[0] * t, a[1] + ab[1] * t];
    return { d: len(sub(p, c)), t: t, segLen: Math.sqrt(l2) };
  }
  // Avstånd från punkt till linje samt hur långt längs linjen närmaste punkt ligger.
  function polylineInfo(p, line) {
    var P = proj(p), pts = line.map(P.xy), best = { d: Infinity, along: 0 }, acc = 0;
    if (pts.length === 1) return { d: len(pts[0]), along: 0 };
    for (var i = 0; i < pts.length - 1; i++) {
      var s = segInfo([0, 0], pts[i], pts[i + 1]);
      if (s.d < best.d) best = { d: s.d, along: acc + s.t * s.segLen };
      acc += s.segLen;
    }
    best.total = acc;
    return best;
  }
  function lineLength(line) {
    var s = 0; for (var i = 0; i < line.length - 1; i++) s += dist(line[i], line[i + 1]); return s;
  }
  // Skärningspunkter (som avstånd längs strålen) mellan en linje genom origo och en polygon.
  function rayHits(u, poly) {
    var hits = [];
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length], e = sub(b, a), den = cross(u, e);
      if (Math.abs(den) < 1e-12) continue;
      var s = cross(a, u) / den;      // position längs kanten
      if (s < 0 || s > 1) continue;
      hits.push(cross(a, e) / den);  // position längs strålen
    }
    return hits;
  }

  // Fram/mitt/bak längs linjen spelare → greenens mitt.
  function greenDistances(player, green, fallbackCenter) {
    if (green && green.length >= 3) {
      var c = centroid(green), P = proj(player), cxy = P.xy(c), mid = len(cxy);
      var poly = green.map(P.xy);
      var inside = pointInPolyXY([0, 0], poly);
      if (mid < 0.5) return { front: null, mid: 0, back: null, inside: true, center: c, exact: true };
      var u = [cxy[0] / mid, cxy[1] / mid], hits = rayHits(u, poly).filter(function (t) { return t > 0; });
      return {
        front: inside || !hits.length ? null : Math.min.apply(null, hits),
        mid: mid,
        back: hits.length ? Math.max.apply(null, hits) : null,
        inside: inside, center: c, exact: true
      };
    }
    if (fallbackCenter) return { front: null, mid: dist(player, fallbackCenter), back: null, inside: false, center: fallbackCenter, exact: false };
    return null;
  }

  // Hinder framför spelaren: avstånd för att nå och passera, mätt längs spellinjen mot greenen.
  function hazardsAhead(player, greenCenter, hazards) {
    var P = proj(player), g = P.xy(greenCenter), L = len(g);
    if (L < 1) return [];
    var u = [g[0] / L, g[1] / L], out = [];
    (hazards || []).forEach(function (hz) {
      var pts = hz.poly.map(P.xy), al = [], la = [];
      pts.forEach(function (v) { al.push(dot(v, u)); la.push(cross(u, v)); });
      var maxA = Math.max.apply(null, al), minA = Math.min.apply(null, al);
      var minAbsLat = Math.min.apply(null, la.map(Math.abs));
      var crosses = Math.min.apply(null, la) < 0 && Math.max.apply(null, la) > 0;
      if (maxA <= 2 || minA > L + 30) return;
      if (!crosses && minAbsLat > 45) return;
      var meanLat = la.reduce(function (a, b) { return a + b; }, 0) / la.length;
      out.push({
        kind: hz.kind,
        side: crosses ? 'center' : meanLat > 0 ? 'left' : 'right',
        reach: Math.max(0, minA), carry: maxA,
        nearGreen: minA > L - 35
      });
    });
    return out.sort(function (a, b) { return a.reach - b.reach; });
  }

  // Doglegs: brytpunkter i hålets mittlinje som ligger framför spelaren.
  function doglegs(player, line) {
    if (!line || line.length < 3) return [];
    var P = proj(line[0]), pts = line.map(P.xy), info = polylineInfo(player, line), acc = 0, out = [];
    for (var i = 1; i < pts.length - 1; i++) {
      var a = sub(pts[i], pts[i - 1]), b = sub(pts[i + 1], pts[i]);
      acc += len(a);
      var ang = Math.atan2(cross(a, b), dot(a, b)) / D;
      if (Math.abs(ang) >= 12 && acc > info.along + 5) {
        out.push({ dir: ang > 0 ? 'left' : 'right', angle: Math.abs(ang), distance: dist(player, line[i]), point: line[i] });
      }
    }
    return out;
  }

  function nearestHole(player, holes) {
    var best = null;
    Object.keys(holes || {}).forEach(function (ref) {
      var h = holes[ref]; if (!h.line || h.line.length < 2) return;
      var inf = polylineInfo(player, h.line);
      if (!best || inf.d < best.d) best = { ref: ref, d: inf.d };
    });
    return best;
  }

  // Vind relativt spelriktningen. windFrom = varifrån vinden blåser (grader).
  function windRelative(windFrom, playBearing) {
    var rel = ((windFrom - playBearing) % 360 + 540) % 360 - 180; // −180..180, 0 = rakt emot
    var a = Math.abs(rel);
    if (a <= 45) return { type: 'head', rel: rel };
    if (a >= 135) return { type: 'tail', rel: rel };
    return { type: rel > 0 ? 'fromRight' : 'fromLeft', rel: rel };
  }

  // ---------- OpenStreetMap ----------
  function r6(p) { return [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6]; }
  function geomOf(el) { return (el.geometry || []).filter(Boolean).map(function (g) { return r6([g.lat, g.lon]); }); }
  function polysOf(el) {
    if (el.type === 'way') { var g = geomOf(el); return g.length >= 3 ? [g] : []; }
    if (el.type === 'relation') {
      var outers = (el.members || []).filter(function (m) { return m.type === 'way' && (m.role === 'outer' || m.role === '') && m.geometry; })
        .map(function (m) { return m.geometry.filter(Boolean).map(function (g) { return r6([g.lat, g.lon]); }); });
      var closed = outers.filter(function (o) { return o.length >= 4 && o[0][0] === o[o.length - 1][0] && o[0][1] === o[o.length - 1][1]; });
      if (closed.length) return closed;
      var joined = [].concat.apply([], outers); return joined.length >= 3 ? [joined] : [];
    }
    return [];
  }
  function kindOf(t) {
    if (t.golf === 'hole') return 'hole';
    if (t.golf === 'green') return 'green';
    if (t.golf === 'bunker') return 'bunker';
    if (t.golf === 'water_hazard' || t.golf === 'lateral_water_hazard' || t.natural === 'water') return 'water';
    if (t.golf === 'fairway') return 'fairway';
    if (t.golf === 'tee') return 'tee';
    return null;
  }
  function intTag(v) { var n = parseInt(v, 10); return isFinite(n) ? n : null; }

  function buildFromOsm(json, meta) {
    var holes = {}, polys = { green: [], bunker: [], water: [], fairway: [], tee: [] }, dup = 0;
    (json.elements || []).forEach(function (el) {
      var t = el.tags || {}, k = kindOf(t);
      if (!k) return;
      if (k === 'hole') {
        var line = geomOf(el), ref = String(intTag(t.ref) || '');
        if (!ref || line.length < 2) return;
        if (holes[ref]) { dup++; return; }
        holes[ref] = { ref: ref, par: intTag(t.par), si: intTag(t.handicap), dist: intTag(t.dist), line: line };
      } else {
        polysOf(el).forEach(function (p) { polys[k].push(p); });
      }
    });
    Object.keys(holes).forEach(function (ref) { assign(holes[ref], polys); });
    return {
      source: 'osm', osmRef: meta && meta.osmRef, name: meta && meta.name, fetchedAt: new Date().toISOString(),
      holes: holes, duplicates: dup
    };
  }
  function assign(h, polys) {
    var end = h.line[h.line.length - 1], start = h.line[0], best = null;
    polys.green.forEach(function (g) {
      var d = dist(centroid(g), end), P = proj(end);
      if (pointInPolyXY([0, 0], g.map(P.xy))) d = 0;
      if (d < 60 && (!best || d < best.d)) best = { d: d, g: g };
    });
    h.green = best ? best.g : null;
    var total = lineLength(h.line);
    h.tees = polys.tee.filter(function (p) { return dist(centroid(p), start) < 45; });
    h.fairways = polys.fairway.filter(function (p) { return polylineInfo(centroid(p), h.line).d < 40; });
    h.hazards = [];
    ['bunker', 'water'].forEach(function (kind) {
      polys[kind].forEach(function (p) {
        var c = centroid(p), ci = polylineInfo(c, h.line);
        var minD = Math.min.apply(null, p.map(function (v) { return polylineInfo(v, h.line).d; }));
        if (minD <= 45 && ci.along > -20 && ci.along < total + 40) h.hazards.push({ kind: kind, poly: p });
      });
    });
  }
  function coverage(geo) {
    var out = { holes: 0, greens: 0, hazards: 0, list: {} };
    if (!geo) return out;
    for (var i = 1; i <= 18; i++) {
      var h = geo.holes[String(i)];
      var st = !h ? 'none' : h.green ? 'full' : 'line';
      out.list[i] = st;
      if (h) { out.holes++; if (h.green) out.greens++; out.hazards += h.hazards.length; }
    }
    return out;
  }

  // ---------- Demo-geometri (påhittad, märks alltid som DEMO) ----------
  function circle(P, c, rx, ry, rot, n) {
    var pts = [], cr = Math.cos(rot), sr = Math.sin(rot);
    for (var i = 0; i < (n || 16); i++) {
      var a = i / (n || 16) * Math.PI * 2, x = Math.cos(a) * rx, y = Math.sin(a) * ry;
      pts.push(r6(P.ll([c[0] + x * cr - y * sr, c[1] + x * sr + y * cr])));
    }
    return pts;
  }
  function demoGeometry(center, holesSpec) {
    var P = proj(center), pos = [0, 0], heading = 20 * D, holes = {};
    holesSpec.forEach(function (hs, i) {
      var L = hs.length, dir = [Math.sin(heading), Math.cos(heading)], line = [pos.slice()], end;
      if (hs.par >= 4 && i % 3 !== 2) {
        var c1 = [pos[0] + dir[0] * L * 0.6, pos[1] + dir[1] * L * 0.6];
        var turn = (i % 2 ? 1 : -1) * 22 * D, h2 = heading - turn;
        var d2 = [Math.sin(h2), Math.cos(h2)];
        end = [c1[0] + d2[0] * L * 0.42, c1[1] + d2[1] * L * 0.42];
        line.push(c1, end);
      } else {
        end = [pos[0] + dir[0] * L, pos[1] + dir[1] * L]; line.push(end);
      }
      var last = line[line.length - 2], gd = sub(end, last), gl = len(gd), gu = [gd[0] / gl, gd[1] / gl], gn = [-gu[1], gu[0]];
      var rot = Math.atan2(gu[1], gu[0]);
      var h = { ref: String(i + 1), par: hs.par, si: hs.si, dist: null, line: line.map(function (q) { return r6(P.ll(q)); }) };
      h.green = circle(P, end, 15, 11, rot, 20);
      h.tees = [circle(P, [pos[0] - dir[0] * 4, pos[1] - dir[1] * 4], 8, 4, rot, 8)];
      h.fairways = [fairwayPoly(P, line, Math.min(110, L * 0.5), L - 25, 16)];
      h.hazards = [
        { kind: 'bunker', poly: circle(P, [end[0] + gn[0] * 21, end[1] + gn[1] * 21], 7, 5, rot, 12) },
        { kind: 'bunker', poly: circle(P, [end[0] - gn[0] * 20 - gu[0] * 6, end[1] - gn[1] * 20 - gu[1] * 6], 6, 4, rot, 12) }
      ];
      if (hs.par >= 4) {
        var fb = pointAlong(line, Math.min(215, L - 120)), side = i % 2 ? 1 : -1;
        var nrm = normalAt(line, Math.min(215, L - 120));
        h.hazards.push({ kind: 'bunker', poly: circle(P, [fb[0] + nrm[0] * 22 * side, fb[1] + nrm[1] * 22 * side], 10, 6, rot, 12) });
      }
      if (i === 2 || i === 11) {
        var wc = [end[0] - gu[0] * 34, end[1] - gu[1] * 34];
        h.hazards.push({ kind: 'water', poly: circle(P, wc, 14, 26, rot, 18) });
      }
      holes[h.ref] = h;
      pos = [end[0] + gn[0] * 30 + gu[0] * 15, end[1] + gn[1] * 30 + gu[1] * 15];
      heading = Math.atan2(gu[0], gu[1]) + (i % 2 ? 160 : 110) * D;
    });
    return { source: 'demo', name: 'Demo', fetchedAt: null, holes: holes, duplicates: 0 };
  }
  function pointAlong(line, a) {
    for (var i = 0; i < line.length - 1; i++) {
      var s = sub(line[i + 1], line[i]), l = len(s);
      if (a <= l || i === line.length - 2) { var t = Math.max(0, Math.min(1, a / l)); return [line[i][0] + s[0] * t, line[i][1] + s[1] * t]; }
      a -= l;
    }
    return line[line.length - 1];
  }
  function normalAt(line, a) {
    for (var i = 0; i < line.length - 1; i++) {
      var s = sub(line[i + 1], line[i]), l = len(s);
      if (a <= l || i === line.length - 2) return [-s[1] / l, s[0] / l];
      a -= l;
    }
    return [1, 0];
  }
  function fairwayPoly(P, line, from, to, w) {
    var left = [], right = [];
    for (var a = from; a <= to + 0.01; a += (to - from) / 8) {
      var p = pointAlong(line, a), n = normalAt(line, a), ww = w * (0.8 + 0.4 * Math.sin((a - from) / (to - from) * Math.PI));
      left.push(r6(P.ll([p[0] + n[0] * ww, p[1] + n[1] * ww])));
      right.push(r6(P.ll([p[0] - n[0] * ww, p[1] - n[1] * ww])));
    }
    return left.concat(right.reverse());
  }


  // ---------- Banregister (alla golfbanor i ett land från OpenStreetMap) ----------
  function fold(s) {
    return String(s || '').toLowerCase().replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/[éè]/g, 'e').replace(/ü/g, 'u');
  }
  function parseDirectory(json) {
    var items = [], unnamed = 0;
    (json.elements || []).forEach(function (e) {
      var tg = e.tags || {}, b = e.bounds;
      if (!b || !isFinite(b.minlat)) return;
      if (tg.golf === 'driving_range' || tg.golf === 'miniature_golf' || tg.leisure === 'miniature_golf') return;
      var name = tg.name || tg['name:sv'];
      if (!name) { unnamed++; return; }
      var lat = (b.minlat + b.maxlat) / 2, lon = (b.minlon + b.maxlon) / 2;
      items.push({ n: String(name).slice(0, 80), t: e.type, id: e.id, lat: r6([lat, lon])[0], lon: r6([lat, lon])[1],
        b: [b.minlat, b.minlon, b.maxlat, b.maxlon].map(function (v) { return Math.round(v * 1e5) / 1e5; }),
        c: String(tg['addr:city'] || tg['addr:municipality'] || tg['is_in:municipality'] || '').slice(0, 40), h: intTag(tg.holes) });
    });
    // Samma bana kan finnas som både yta och relation – behåll en per namn inom 1,5 km.
    items.sort(function (a, b) { return a.n.localeCompare(b.n, 'sv'); });
    var out = [];
    items.forEach(function (it) {
      var dup = out.filter(function (o) { return fold(o.n) === fold(it.n) && dist([o.lat, o.lon], [it.lat, it.lon]) < 1500; })[0];
      if (dup) { if (it.t === 'relation' && dup.t !== 'relation') out[out.indexOf(dup)] = it; return; }
      out.push(it);
    });
    return { items: out, unnamed: unnamed };
  }
  function searchDirectory(items, q, pos, limit) {
    var f = fold(q).trim(), list = items;
    if (f) {
      var words = f.split(/\s+/);
      list = items.filter(function (it) { var hay = fold(it.n + ' ' + it.c); return words.every(function (w) { return hay.indexOf(w) >= 0; }); });
    }
    list = list.map(function (it) { return { it: it, d: pos ? dist(pos, [it.lat, it.lon]) : null }; });
    if (pos) list.sort(function (a, b) { return a.d - b.d; });
    return list.slice(0, limit || 60);
  }

  // ---------- Kartplattor (Web Mercator) ----------
  function lon2tile(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
  function lat2tile(lat, z) { var r = lat * D; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z); }
  function tile2lon(x, z) { return x / Math.pow(2, z) * 360 - 180; }
  function tile2lat(y, z) { var n = Math.PI - 2 * Math.PI * y / Math.pow(2, z); return Math.atan(Math.sinh(n)) / D; }

  var Geo = {
    dist: dist, bearing: bearing, proj: proj, centroid: centroid, polylineInfo: polylineInfo, lineLength: lineLength,
    greenDistances: greenDistances, hazardsAhead: hazardsAhead, doglegs: doglegs, nearestHole: nearestHole,
    windRelative: windRelative, buildFromOsm: buildFromOsm, coverage: coverage, demoGeometry: demoGeometry,
    pointInPolyXY: pointInPolyXY, parseDirectory: parseDirectory, searchDirectory: searchDirectory, fold: fold, lon2tile: lon2tile, lat2tile: lat2tile, tile2lon: tile2lon, tile2lat: tile2lat
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Geo;
  root.Geo = Geo;
})(typeof window !== 'undefined' ? window : globalThis);
