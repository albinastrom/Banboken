// Bygger en fristående index.html av src.html + skripten.
const fs = require('fs');
let html = fs.readFileSync('src.html', 'utf8');
const map = { CORE: 'core.js', GEO: 'geo.js', GAMES: 'games.js', STATS: 'stats.js', SYNC: 'sync.js', RATINGS: 'ratings.js', NET: 'net.js', TESTS: 'tests.js', I18N: 'i18n.js', APP: 'app.js' };
for (const [k, f] of Object.entries(map)) html = html.replace('/*' + k + '*/', () => fs.readFileSync(f, 'utf8'));
fs.writeFileSync('index.html', html);
console.log('index.html', html.length, 'bytes');
