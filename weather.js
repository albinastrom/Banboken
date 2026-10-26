/* Banboken – vilket väder som visas var.
   Två separata sammanhang som aldrig skriver över varandra:
   - Startsidan: användarens aktuella position (eller en plats användaren valt själv).
   - Ronden: den valda banans koordinater, så länge ronden pågår. */
(function (root) {
  'use strict';
  var G = root.Geo || (typeof require !== 'undefined' ? require('./geo.js') : null);
  var MOVE_M = 5000;            // ny plats (nytt platsnamn och ny prognos) först efter 5 km
  var FRESH_MS = 30 * 60000;    // prognosen hämtas om efter 30 minuter
  var USABLE_MS = 3 * 3600000;  // äldre än 3 timmar visas aldrig som aktuell

  // Startsidan: vald plats > position i den här sessionen > senast kända plats (tydligt märkt).
  function homeContext(home) {
    if (home.manual) return { kind: 'manual', lat: home.manual.lat, lon: home.manual.lon, place: home.manual.name, confirmed: true };
    if (home.anchor) return { kind: 'gps', lat: home.anchor.lat, lon: home.anchor.lon, place: home.anchor.place || null, confirmed: !!home.confirmed };
    return { kind: 'none' };
  }
  // Rondens väder: banans koordinater, bara medan ronden pågår.
  function roundContext(round, course) {
    if (!round || round.status !== 'active' || !course || course.lat === null || course.lat === undefined) return null;
    return { kind: 'round', lat: course.lat, lon: course.lon, place: course.name, confirmed: true };
  }
  // Ny position: behövs ny ankarpunkt (platsnamn + prognos)?
  function shouldMove(anchor, pos) {
    if (!anchor) return true;
    return G.dist([anchor.lat, anchor.lon], pos) > MOVE_M;
  }
  // Ska prognosen för en plats hämtas på nytt?
  function needsFetch(entry, lat, lon, now) {
    if (!entry || !entry.fetchedAt) return true;
    if (now - new Date(entry.fetchedAt).getTime() > FRESH_MS) return true;
    if (entry.lat !== undefined && G.dist([entry.lat, entry.lon], [lat, lon]) > MOVE_M) return true;
    return false;
  }
  // Får en cachad prognos visas för den här platsen? Aldrig om den gäller en annan plats eller är för gammal.
  function usable(entry, lat, lon, now) {
    if (!entry || !entry.fetchedAt) return false;
    if (now - new Date(entry.fetchedAt).getTime() > USABLE_MS) return false;
    if (entry.lat !== undefined && G.dist([entry.lat, entry.lon], [lat, lon]) > MOVE_M) return false;
    return true;
  }
  // Ortnamn från omvänd geokodning (Nominatim-adress).
  function placeName(addr) {
    if (!addr) return null;
    return addr.village || addr.town || addr.city || addr.suburb || addr.hamlet || addr.municipality || addr.county || null;
  }

  var Weather = { MOVE_M: MOVE_M, FRESH_MS: FRESH_MS, USABLE_MS: USABLE_MS, homeContext: homeContext, roundContext: roundContext, shouldMove: shouldMove, needsFetch: needsFetch, usable: usable, placeName: placeName };
  if (typeof module !== 'undefined' && module.exports) module.exports = Weather;
  root.Weather = Weather;
})(typeof window !== 'undefined' ? window : globalThis);
