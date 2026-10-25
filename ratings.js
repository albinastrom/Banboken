/* Banboken – officiella tee- och ratinguppgifter.
   Datamodell: Klubb → Bana → Slinga/hålkombination → Tee → Värdering (kön × 18 / 1–9 / 10–18).
   En rad i slopetabellen = en officiell värdering för en tee:
   { club, course, combo, osmRef?, tee, color?, length?, par, gender: men|women, holes: 18|front9|back9,
     cr, slope, source, verifiedAt: 'ÅÅÅÅ-MM-DD', holeData?: [{par, si, length}] } */
(function (root) {
  'use strict';
  var GENDERS = ['men', 'women'], HOLES = ['18', 'front9', 'back9'];

  function fold(s) {
    return String(s === null || s === undefined ? '' : s).trim().toLowerCase()
      .replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/[éè]/g, 'e').replace(/ü/g, 'u').replace(/\s+/g, ' ');
  }
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = parseFloat(String(v).replace(',', '.').trim());
    return isFinite(n) ? n : null;
  }
  function normGender(v) {
    var f = fold(v);
    if (['men', 'man', 'herr', 'herrar', 'h', 'm', 'male'].indexOf(f) >= 0) return 'men';
    if (['women', 'woman', 'dam', 'damer', 'd', 'w', 'f', 'female', 'kvinna'].indexOf(f) >= 0) return 'women';
    return null;
  }
  function normHoles(v) {
    var f = fold(v).replace(/\s/g, '');
    if (f === '' || f === '18') return '18';
    if (['front9', '1-9', '1–9', 'ut', 'out', 'f9', 'första9'].indexOf(f) >= 0) return 'front9';
    if (['back9', '10-18', '10–18', 'in', 'b9', 'sista9'].indexOf(f) >= 0) return 'back9';
    return null;
  }
  function validDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
    var d = new Date(s + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }

  // Normaliserar och validerar en rad. Returnerar { row, errors }.
  function normalizeRow(raw, today) {
    var e = [], r = {
      club: String(raw.club || '').trim(), course: String(raw.course || '').trim(), combo: String(raw.combo || '').trim() || '18',
      osmRef: raw.osmRef ? String(raw.osmRef).trim() : null, tee: String(raw.tee === undefined ? '' : raw.tee).trim(),
      color: raw.color ? String(raw.color).trim() : null, length: num(raw.length), par: num(raw.par),
      gender: normGender(raw.gender), holes: normHoles(raw.holes), cr: num(raw.cr), slope: num(raw.slope),
      source: String(raw.source || '').trim(), verifiedAt: String(raw.verifiedAt || '').trim()
    };
    if (!r.club) e.push('club'); if (!r.course) e.push('course'); if (!r.tee) e.push('tee');
    if (!r.gender) e.push('gender'); if (!r.holes) e.push('holes');
    var nine = r.holes === 'front9' || r.holes === 'back9';
    if (r.cr === null || r.cr < (nine ? 25 : 50) || r.cr > (nine ? 45 : 90)) e.push('cr');
    if (r.slope === null || r.slope < 55 || r.slope > 155 || Math.round(r.slope) !== r.slope) e.push('slope');
    if (r.par === null || r.par < (nine ? 27 : 54) || r.par > (nine ? 40 : 80) || Math.round(r.par) !== r.par) e.push('par');
    if (r.length !== null && (r.length < (nine ? 600 : 1200) || r.length > (nine ? 4500 : 8500))) e.push('length');
    if (!r.source) e.push('source');
    if (!validDate(r.verifiedAt) || (today && r.verifiedAt > today)) e.push('verifiedAt');
    if (raw.holeData) {
      var hd = raw.holeData;
      if (!Array.isArray(hd) || hd.length !== (nine ? 9 : 18) || hd.some(function (h) { return !(h && h.par >= 3 && h.par <= 6); })) e.push('holeData');
      else {
        var sis = hd.map(function (h) { return h.si; }).slice().sort(function (a, b) { return a - b; });
        var want = []; for (var i = 1; i <= 18; i++) want.push(i);
        if (!nine && sis.join() !== want.join()) e.push('holeData');
        else if (!e.length || e.indexOf('holeData') < 0) r.holeData = hd.map(function (h) { return { par: h.par, si: h.si, length: num(h.length) }; });
        if (!e.length && r.holeData && r.holeData.reduce(function (a, h) { return a + h.par; }, 0) !== r.par) e.push('parSum');
      }
    }
    return { row: r, errors: e };
  }

  // CSV med rubrikrad; avgränsare ; eller , (autodetekteras). Svenska och engelska kolumnnamn.
  var COLS = {
    club: ['club', 'klubb', 'golfklubb'], course: ['course', 'bana'], combo: ['combo', 'slinga', 'halkombination', 'kombination'],
    osmRef: ['osmref', 'osm_ref', 'osm'], tee: ['tee', 'tee_name', 'teenamn'], color: ['color', 'farg', 'teefarg'],
    length: ['length', 'langd', 'banlangd'], par: ['par'], gender: ['gender', 'kon', 'vardering'], holes: ['holes', 'hal', 'rondtyp'],
    cr: ['cr', 'course_rating', 'courserating'], slope: ['slope', 'slope_rating', 'sloperating'],
    source: ['source', 'kalla'], verifiedAt: ['verifiedat', 'verified_at', 'verifierad', 'verifierat', 'datum']
  };
  function splitCsvLine(line, d) {
    var out = [], cur = '', q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (q) { if (ch === '"') { if (line.charAt(i + 1) === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === d) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }
  function parseCsv(text) {
    var lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
    if (lines.length < 2) return { rows: [], errors: [{ line: 0, errors: ['empty'] }] };
    var d = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
    var head = splitCsvLine(lines[0], d).map(function (h) { return fold(h).replace(/[\s-]/g, '_').replace(/_+/g, '_'); });
    var map = {};
    Object.keys(COLS).forEach(function (k) {
      for (var i = 0; i < head.length; i++) if (COLS[k].indexOf(head[i].replace(/_/g, '')) >= 0 || COLS[k].indexOf(head[i]) >= 0) { map[k] = i; break; }
    });
    var raws = lines.slice(1).map(function (l) {
      var c = splitCsvLine(l, d), o = {};
      Object.keys(map).forEach(function (k) { o[k] = (c[map[k]] || '').trim(); });
      return o;
    });
    return { raws: raws, missingCols: ['club', 'course', 'tee', 'gender', 'cr', 'slope', 'par', 'source', 'verifiedAt'].filter(function (k) { return map[k] === undefined; }) };
  }
  function parseImport(text, today) {
    var raws, missingCols = [], t = String(text || '').trim();
    if (t.charAt(0) === '[' || t.charAt(0) === '{') {
      var j = JSON.parse(t); raws = Array.isArray(j) ? j : (j.rows || j.tees || []);
    } else { var c = parseCsv(t); raws = c.raws || []; missingCols = c.missingCols || []; }
    var rows = [], errors = [];
    raws.forEach(function (raw, i) {
      var n = normalizeRow(raw, today);
      if (n.errors.length) errors.push({ line: i + 2, errors: n.errors, tee: n.row.tee, club: n.row.club }); else rows.push(n.row);
    });
    return { rows: rows, errors: errors, missingCols: missingCols };
  }

  function rowKey(r) { return [fold(r.club), fold(r.course), fold(r.combo || '18'), fold(r.tee), r.gender, r.holes].join('|'); }
  function teeKey(r) { return [fold(r.club), fold(r.course), fold(r.combo || '18'), fold(r.tee)].join('|'); }
  function comboKey(r) { return [fold(r.club), fold(r.course), fold(r.combo || '18')].join('|'); }

  // Lägger in nya/ändrade rader i biblioteket. Samma värdering (nyckel) ersätts, aldrig dubbleras.
  function mergeLibrary(lib, rows, nowIso) {
    var map = {}, out = (lib || []).slice(), res = { added: 0, updated: 0, unchanged: 0 };
    out.forEach(function (r, i) { map[rowKey(r)] = i; });
    rows.forEach(function (r) {
      var k = rowKey(r), copy = JSON.parse(JSON.stringify(r)); copy.updatedAt = nowIso;
      if (map[k] === undefined) { map[k] = out.length; out.push(copy); res.added++; return; }
      var old = out[map[k]], same = ['cr', 'slope', 'par', 'length', 'color', 'source', 'verifiedAt', 'osmRef'].every(function (f) { return (old[f] === undefined ? null : old[f]) === (copy[f] === undefined ? null : copy[f]); }) && JSON.stringify(old.holeData || null) === JSON.stringify(copy.holeData || null);
      if (same) { res.unchanged++; return; }
      out[map[k]] = copy; res.updated++;
    });
    res.lib = out;
    return res;
  }

  // Alla slingor/hålkombinationer i biblioteket.
  function combos(lib) {
    var m = {};
    (lib || []).forEach(function (r) {
      var k = comboKey(r);
      if (!m[k]) m[k] = { key: k, club: r.club, course: r.course, combo: r.combo || '18', osmRef: r.osmRef || null, tees: {} };
      if (r.osmRef && !m[k].osmRef) m[k].osmRef = r.osmRef;
      m[k].tees[fold(r.tee)] = r.tee;
    });
    return Object.keys(m).sort().map(function (k) { return m[k]; });
  }
  // Vilken slinga en bana i appen hör till: uttrycklig koppling eller OSM-referens.
  function comboForCourse(lib, course) {
    var cs = combos(lib);
    if (course.ratingLink) { var k = course.ratingLink; return cs.filter(function (c) { return c.key === k; })[0] || null; }
    var ref = course.geo && course.geo.osmRef;
    if (ref) { var byRef = cs.filter(function (c) { return c.osmRef === ref; }); if (byRef.length === 1) return byRef[0]; }
    return null;
  }
  // Förslag på slinga utifrån namn (för koppling i administrationen).
  function suggestCombos(lib, course) {
    var n = fold(course.name) + ' ' + fold(course.club);
    return combos(lib).map(function (c) {
      var words = (fold(c.club) + ' ' + fold(c.course)).split(' ').filter(function (w) { return w.length > 2 && ['golf', 'klubb', 'golfklubb', 'club', 'bana'].indexOf(w) < 0; });
      var hit = words.filter(function (w) { return n.indexOf(w) >= 0; }).length;
      return { c: c, score: words.length ? hit / words.length : 0 };
    }).filter(function (x) { return x.score > 0; }).sort(function (a, b) { return b.score - a.score; }).map(function (x) { return x.c; });
  }

  // Bygger tees för en bana från biblioteket. Befintliga tees med samma namn behåller id och håldata.
  function buildTees(lib, combo, existingTees) {
    var rows = (lib || []).filter(function (r) { return comboKey(r) === combo.key; }), byTee = {};
    rows.forEach(function (r) { (byTee[fold(r.tee)] = byTee[fold(r.tee)] || []).push(r); });
    var baseHoles = existingTees && existingTees[0] ? existingTees[0].holes : null;
    return Object.keys(byTee).sort(function (a, b) {
      var la = byTee[a][0].length || 0, lb = byTee[b][0].length || 0; return lb - la || a.localeCompare(b, 'sv');
    }).map(function (tk) {
      var rs = byTee[tk], ex = (existingTees || []).filter(function (x) { return fold(x.name) === tk; })[0];
      var ratings = { men: {}, women: {} }, src = [], ver = '', len = null, color = null, hd = null;
      rs.forEach(function (r) {
        ratings[r.gender][r.holes] = { cr: r.cr, slope: r.slope, par: r.par, length: r.length, source: r.source, verifiedAt: r.verifiedAt };
        if (src.indexOf(r.source) < 0) src.push(r.source);
        if (r.verifiedAt > ver) ver = r.verifiedAt;
        if (r.holes === '18' && r.length) len = r.length;
        if (r.color) color = r.color;
        if (r.holes === '18' && r.holeData) hd = r.holeData;
      });
      var holes = hd ? hd.map(function (h) { return { par: h.par, si: h.si, length: h.length }; }) : JSON.parse(JSON.stringify((ex && ex.holes) || baseHoles || []));
      var any = ratings.men['18'] || ratings.women['18'];
      return { id: ex ? ex.id : 'tee-' + tk.replace(/[^a-z0-9]/g, '') + '-' + rs[0].combo.replace(/[^A-Za-z0-9]/g, ''), name: rs[0].tee, color: color, length: len,
        holes: holes, official: true, ratings: ratings, source: src.join(' · '), verifiedAt: ver, combo: combo.key,
        cr: any ? any.cr : null, slope: any ? any.slope : null, unrated: !any };
    });
  }

  // Rätt värdering för spelaren: kön × rondtyp. Egna (ej officiella) värden gäller oavsett kön men märks.
  function ratingFor(tee, gender, holes) {
    holes = holes || '18';
    if (tee.ratings) {
      var r = tee.ratings[gender] && tee.ratings[gender][holes];
      return r ? { cr: r.cr, slope: r.slope, par: r.par, length: r.length, official: true, source: r.source, verifiedAt: r.verifiedAt, gender: gender, holes: holes } : null;
    }
    if (holes === '18' && typeof tee.cr === 'number' && typeof tee.slope === 'number') return { cr: tee.cr, slope: tee.slope, par: null, official: false, gender: null, holes: '18' };
    return null;
  }
  // Tee för en 9-hålsrond: hålen 1–9 eller 10–18, hålindex rangordnat 1–9 inom de nio hålen.
  function nineTee(tee, which, rating) {
    var off = which === 'back9' ? 9 : 0, hs = tee.holes.slice(off, off + 9).map(function (h) { return { par: h.par, si: h.si, length: h.length }; });
    var order = hs.map(function (h, i) { return { i: i, si: h.si }; }).sort(function (a, b) { return a.si - b.si; });
    order.forEach(function (o, rank) { hs[o.i].si18 = hs[o.i].si; hs[o.i].si = rank + 1; });
    return { id: tee.id + ':' + which, name: tee.name, holes: hs, cr: rating ? rating.cr : null, slope: rating ? rating.slope : null, unrated: !rating, nine: which, offset: off };
  }

  // Granskning av banorna i appen mot biblioteket.
  function audit(courses, lib) {
    var out = [], names = {};
    (courses || []).forEach(function (c) {
      if (c.demo) return;
      var issues = [], k = fold(c.name);
      if (names[k]) issues.push({ code: 'duplicateCourse' }); names[k] = 1;
      if (!c.tees || !c.tees.length) issues.push({ code: 'noTees' });
      var tn = {};
      (c.tees || []).forEach(function (te) {
        var f = fold(te.name);
        if (tn[f]) issues.push({ code: 'duplicateTee', tee: te.name }); tn[f] = 1;
        GENDERS.forEach(function (g) { if (!ratingFor(te, g, '18')) issues.push({ code: 'noRating', tee: te.name, gender: g }); });
        var any = ratingFor(te, 'men') || ratingFor(te, 'women');
        if (any && (any.cr < 50 || any.cr > 90 || any.slope < 55 || any.slope > 155)) issues.push({ code: 'invalidRating', tee: te.name });
        if (te.holes && te.holes.length === 18) {
          var sis = te.holes.map(function (h) { return h.si; }).slice().sort(function (a, b) { return a - b; }).join();
          if (sis !== '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18') issues.push({ code: 'badSi', tee: te.name });
          var par = te.holes.reduce(function (a, h) { return a + h.par; }, 0), rp = te.ratings && (te.ratings.men['18'] || te.ratings.women['18']);
          if (rp && rp.par && rp.par !== par) issues.push({ code: 'parMismatch', tee: te.name, a: par, b: rp.par });
        } else issues.push({ code: 'holesMissing', tee: te.name });
        if (!te.official && any) issues.push({ code: 'unverified', tee: te.name });
      });
      var link = comboForCourse(lib, c);
      if (!link) issues.push({ code: 'notLinked' });
      if (c.geo && c.geo.duplicates) issues.push({ code: 'multipleLoops' });
      if (c.geo && Object.keys(c.geo.holes || {}).length > 18) issues.push({ code: 'multipleLoops' });
      out.push({ id: c.id, name: c.name, issues: issues, ok: !issues.length });
    });
    return out;
  }

  var Ratings = { GENDERS: GENDERS, HOLES: HOLES, fold: fold, normalizeRow: normalizeRow, parseImport: parseImport, rowKey: rowKey, teeKey: teeKey, comboKey: comboKey,
    mergeLibrary: mergeLibrary, combos: combos, comboForCourse: comboForCourse, suggestCombos: suggestCombos, buildTees: buildTees,
    ratingFor: ratingFor, nineTee: nineTee, audit: audit, validDate: validDate };
  if (typeof module !== 'undefined' && module.exports) module.exports = Ratings;
  root.Ratings = Ratings;
})(typeof window !== 'undefined' ? window : globalThis);
