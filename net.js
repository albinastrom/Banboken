/* Banboken – robust hämtning från OpenStreetMap (Overpass).
   - Felklassning: nätverk, tidsgräns, serverfel (5xx), överbelastning (429), klientfel (4xx).
   - Nya försök med exponentiell väntan (respekterar Retry-After), mot flera servrar, med maxgräns.
   - Identiska samtidiga förfrågningar delar på samma anrop.
   - Lokal cache för kartdata per bana. */
(function (root) {
  'use strict';

  // Felet som klassas: { kind: 'network'|'timeout'|'server'|'rate'|'client'|'data', status, retryAfter }
  function classify(e, online) {
    if (!e) return 'network';
    if (e.kind) return e.kind;
    if (online === false) return 'network';
    if (e.name === 'AbortError' || e.name === 'TimeoutError') return 'timeout';
    if (typeof e.status === 'number') {
      if (e.status === 429) return 'rate';
      if (e.status >= 500) return 'server';
      if (e.status >= 400) return 'client';
    }
    return 'network';
  }
  function retryable(kind) { return kind === 'server' || kind === 'rate' || kind === 'timeout' || kind === 'network'; }

  // Väntetid före försök nr attempt (0-baserat): base × 2^attempt, max cap, ±25 % slump. Retry-After vinner (max cap).
  function backoffMs(attempt, opts, rand, retryAfterSec) {
    var o = Object.assign({ base: 1000, cap: 8000 }, opts || {});
    if (retryAfterSec && isFinite(retryAfterSec)) return Math.min(o.cap, Math.max(0, retryAfterSec * 1000));
    var r = typeof rand === 'number' ? rand : 0.5;
    return Math.round(Math.min(o.cap, o.base * Math.pow(2, attempt)) * (0.75 + 0.5 * r));
  }

  // Overpass-klient. deps: { request(url, body, ms) → Promise<json>, sleep(ms) → Promise, servers, online(), rand() }
  function createOverpass(deps) {
    var inflight = {};
    function query(q, opts) {
      opts = opts || {};
      var key = q + '|' + (opts.ms || 0);
      if (inflight[key]) return inflight[key];
      var servers = deps.servers, max = opts.maxAttempts || 4, ms = opts.ms || 25000, last = null;
      function attempt(n) {
        if (opts.onAttempt) opts.onAttempt(n + 1, max, servers[n % servers.length]);
        return deps.request(servers[n % servers.length], q, ms).then(null, function (e) {
          var kind = classify(e, deps.online ? deps.online() : true);
          last = e; last.kind = kind;
          // Klientfel (felaktig fråga) och nätverksfel utan uppkoppling: inga fler försök.
          if (!retryable(kind) || n + 1 >= max || (kind === 'network' && deps.online && deps.online() === false)) throw last;
          return deps.sleep(backoffMs(n, opts.backoff, deps.rand ? deps.rand() : 0.5, e.retryAfter)).then(function () { return attempt(n + 1); });
        });
      }
      var p = attempt(0);
      inflight[key] = p;
      function done() { delete inflight[key]; }
      p.then(done, done);
      return p;
    }
    return { query: query, inflightCount: function () { return Object.keys(inflight).length; } };
  }

  // Cache för kartdata per bana (OSM-referens). storage = { get(key) → string|null, set(key, string) }
  function createGeoCache(storage, key, max) {
    max = max || 12;
    function read() { try { var d = JSON.parse(storage.get(key) || 'null'); return d && typeof d === 'object' && d.items ? d : { items: {} }; } catch (e) { return { items: {} }; } }
    function write(d) {
      var ids = Object.keys(d.items).sort(function (a, b) { return d.items[a].at < d.items[b].at ? -1 : 1; });
      while (ids.length > max) delete d.items[ids.shift()];
      // Om lagringen är full: släpp äldsta tills det går.
      for (;;) {
        try { storage.set(key, JSON.stringify(d)); return true; }
        catch (e) { ids = Object.keys(d.items).sort(function (a, b) { return d.items[a].at < d.items[b].at ? -1 : 1; }); if (!ids.length) return false; delete d.items[ids.shift()]; }
      }
    }
    return {
      get: function (ref) { var it = read().items[ref]; return it ? { geo: it.geo, at: it.at } : null; },
      put: function (ref, geo, atIso) { var d = read(); d.items[ref] = { geo: geo, at: atIso }; return write(d); },
      size: function () { return Object.keys(read().items).length; }
    };
  }

  var Net = { classify: classify, retryable: retryable, backoffMs: backoffMs, createOverpass: createOverpass, createGeoCache: createGeoCache };
  if (typeof module !== 'undefined' && module.exports) module.exports = Net;
  root.Net = Net;
})(typeof window !== 'undefined' ? window : globalThis);
