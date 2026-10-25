/* Banboken – synklogik (etapp 5). Rena funktioner: vilka dokument som ska skickas och hur hämtade dokument slås ihop.
   Regel vid krock: osynkade ändringar på den här telefonen vinner och skickas vid nästa synk. */
(function (root) {
  'use strict';
  var KINDS = ['round', 'course', 'profile', 'bag', 'friends', 'baseline', 'ratings'];

  function hash(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8) + ':' + str.length.toString(36);
  }
  function stable(v) { return JSON.stringify(v); }

  function collectDocs(state) {
    var d = {};
    (state.rounds || []).forEach(function (r) { d['round:' + r.id] = { kind: 'round', id: r.id, data: r }; });
    (state.courses || []).forEach(function (c) { if (c.id !== 'demo') d['course:' + c.id] = { kind: 'course', id: c.id, data: c }; });
    var p = state.profile || {};
    d['profile:me'] = { kind: 'profile', id: 'me', data: { name: p.name, hi: p.hi, homeClub: p.homeClub, lang: p.lang, theme: p.theme, allowance: p.allowance, gender: p.gender || null, hiHistory: p.hiHistory || [] } };
    d['bag:all'] = { kind: 'bag', id: 'all', data: state.bag || [] };
    d['friends:all'] = { kind: 'friends', id: 'all', data: state.friends || [] };
    if (state.baseline) d['baseline:all'] = { kind: 'baseline', id: 'all', data: state.baseline };
    if (state.ratingLib && state.ratingLib.length) d['ratings:all'] = { kind: 'ratings', id: 'all', data: state.ratingLib };
    return d;
  }

  function computePush(docs, synced) {
    var up = [], del = [];
    Object.keys(docs).forEach(function (k) {
      var h = hash(stable(docs[k].data));
      if (synced[k] !== h) up.push({ key: k, kind: docs[k].kind, id: docs[k].id, data: docs[k].data, h: h });
    });
    Object.keys(synced).forEach(function (k) {
      if (!docs[k] && synced[k] !== 'deleted') { var p = k.split(':'); del.push({ key: k, kind: p[0], id: p.slice(1).join(':') }); }
    });
    return { upserts: up, deletes: del };
  }

  function setDoc(state, kind, id, data) {
    if (kind === 'round' || kind === 'course') {
      var list = kind === 'round' ? state.rounds : state.courses, found = false;
      for (var i = 0; i < list.length; i++) if (list[i].id === id) { list[i] = data; found = true; }
      if (!found) list.push(data);
    } else if (kind === 'profile') { state.profile = Object.assign(state.profile || {}, data); }
    else if (kind === 'bag') state.bag = Array.isArray(data) ? data : [];
    else if (kind === 'friends') state.friends = Array.isArray(data) ? data : [];
    else if (kind === 'baseline') state.baseline = data;
    else if (kind === 'ratings') state.ratingLib = Array.isArray(data) ? data : [];
  }
  function removeDoc(state, kind, id) {
    if (kind === 'round') state.rounds = state.rounds.filter(function (r) { return r.id !== id; });
    else if (kind === 'course') state.courses = state.courses.filter(function (c) { return c.id !== id; });
    else if (kind === 'baseline') state.baseline = null;
    else if (kind === 'bag') state.bag = [];
    else if (kind === 'friends') state.friends = [];
    else if (kind === 'ratings') state.ratingLib = [];
  }
  function validRow(row) {
    if (!row || KINDS.indexOf(row.kind) < 0 || typeof row.doc_id !== 'string') return false;
    if (row.deleted) return true;
    var d = row.data;
    if (row.kind === 'round') return d && d.id === row.doc_id && Array.isArray(d.holes) && d.tee && Array.isArray(d.tee.holes);
    if (row.kind === 'course') return d && d.id === row.doc_id && Array.isArray(d.tees);
    if (row.kind === 'bag' || row.kind === 'friends' || row.kind === 'ratings') return Array.isArray(d);
    return d && typeof d === 'object';
  }

  // Slår ihop hämtade rader i state. synced uppdateras med vad som nu är i takt med servern.
  function applyPull(state, synced, rows) {
    var docs = collectDocs(state), res = { changed: 0, conflicts: 0, invalid: 0 };
    rows.forEach(function (row) {
      if (!validRow(row)) { res.invalid++; return; }
      var key = row.kind + ':' + row.doc_id, local = docs[key];
      var localH = local ? hash(stable(local.data)) : null;
      var single = row.kind === 'profile' || row.kind === 'bag' || row.kind === 'friends' || row.kind === 'ratings';
      // Profil, golfbag och vänner som aldrig synkats på den här telefonen tar emot molnets version.
      var dirty = local ? (synced[key] === undefined ? !single : synced[key] !== localH) : !!(synced[key] && synced[key] !== 'deleted');
      if (row.deleted) {
        if (!local) { synced[key] = 'deleted'; return; }
        if (dirty) { res.conflicts++; return; }
        removeDoc(state, row.kind, row.doc_id); synced[key] = 'deleted'; res.changed++; return;
      }
      var rh = hash(stable(row.data));
      if (local && localH === rh) { synced[key] = rh; return; }
      if (dirty) { res.conflicts++; return; }
      setDoc(state, row.kind, row.doc_id, row.data); synced[key] = rh; res.changed++;
    });
    return res;
  }

  // Livematch: slå ihop spelarnas egna hålresultat (packade: -1 struket, 0 tomt, n slag) i rondens medspelare.
  function mergeLiveScores(round, scores) {
    var changed = 0;
    Object.keys(scores || {}).forEach(function (pid) {
      var p = (round.extra || []).filter(function (x) { return x.id === pid; })[0], arr = scores[pid] && scores[pid].h;
      if (!p || !Array.isArray(arr)) return;
      arr.forEach(function (v, i) {
        if (i >= p.holes.length || typeof v !== 'number' || v === 0) return;
        var cur = p.holes[i] || {}, want = v === -1 ? { pickedUp: true } : { strokes: v };
        if (stable(cur) !== stable(want)) { p.holes[i] = want; changed++; }
      });
    });
    return changed;
  }
  var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function newCode(rand) {
    var s = '', r = rand || Math.random;
    for (var i = 0; i < 8; i++) s += CODE_CHARS.charAt(Math.floor(r() * CODE_CHARS.length));
    return s;
  }
  function validCode(c) { return /^[A-HJ-NP-Z2-9]{8}$/.test(String(c || '')); }

  var Sync = { hash: hash, collectDocs: collectDocs, computePush: computePush, applyPull: applyPull, mergeLiveScores: mergeLiveScores, newCode: newCode, validCode: validCode, validRow: validRow };
  if (typeof module !== 'undefined' && module.exports) module.exports = Sync;
  root.Sync = Sync;
})(typeof window !== 'undefined' ? window : globalThis);
