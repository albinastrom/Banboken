# Banboken – etapp 1–5

Golfapp (PWA) med profil, banor, scorekort, WHS-beräkningar, rondregistrering, statistik, väder (etapp 1) GPS, karta och avstånd till green och hinder (etapp 2) matcher med flera spelare, lag och spelformer (etapp 3) Strokes Gained, coach, utökad statistik och golfbag (etapp 4) samt konton, molnsynk, livematcher, säkerhet och prestanda (etapp 5).
Allt sparas i telefonen efter varje tryck, så ingenting försvinner vid dålig täckning.

## Publicera gratis från iPhone (GitHub Pages)

1. Packa upp zip-filen i appen Filer (tryck på filen).
2. Öppna github.com/albinastrom/banboken i Safari → **Add file → Upload files**.
3. Välj dessa filer: `index.html`, `manifest.webmanifest`, `sw.js`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `README.md`, `supabase.sql`
   (källfilerna `core.js`, `geo.js`, `games.js`, `stats.js`, `sync.js`, `ratings.js`, `net.js`, `tests.js`, `i18n.js`, `app.js`, `src.html`, `build.js` kan också laddas upp – appen behöver dem inte för att köras).
   Har du redan laddat upp etapp 1: ladda upp de nya filerna med samma namn så ersätts de.
4. Tryck **Commit changes**.
5. **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main`, mapp `/ (root)` → Save.
6. Efter någon minut finns appen på **https://albinastrom.github.io/banboken/**
7. Öppna adressen i Safari → Dela → **Lägg till på hemskärmen**. Nu startar den som en app, i helskärm, och fungerar offline.

Uppdatera: ladda upp en ny `index.html` med samma namn. Appen hämtar den nya versionen nästa gång du har täckning.

## Testa beräkningarna
- I appen: **Profil → Kör beräkningstester** (136 tester: avrundning, Course/Playing Handicap, slagfördelning, poängbogey, netto dubbelbogey, score differential, GPS-avstånd, fram/mitt/bak på green, hinder, doglegs, vind inläsning av kartdata, lag-handicap, matchspel, bästboll, sämstboll, nassau, skins, lagboll, Strokes Gained, personlig baslinje, coachens slutsatser, klubblängder och synklogik).
- På dator: `node tests.js`

## Filer
| Fil | Innehåll |
|---|---|
| `core.js` | Alla beräkningar som rena funktioner (WHS, slag per hål, poäng, statistik, validering) |
| `geo.js` | GPS-geometri: avstånd, green fram/mitt/bak, hinder (nå/över), doglegs, vind relativt hålet, inläsning från OpenStreetMap, demokarta |
| `games.js` | Spelformer: handicapreduktion per spelform, matchstatus, bästboll, sämstboll, nassau, skins, scramble, Texas scramble, greensome, foursome |
| `stats.js` | Slagloggar, utökad statistik, Strokes Gained (personlig eller importerad baslinje), regelbaserad coach, klubblängder och klubbförslag |
| `ratings.js` | Tee- och ratingsystem: datamodell, import (CSV/JSON), validering, slopetabell, herr/dam, 9 hål, granskningsrapport |
| `net.js` | Robust hämtning: felklassning, nya försök med exponentiell väntan, delade anrop, cache för kartdata |
| `sync.js` | Synklogik: vilka dokument som skickas, sammanslagning vid hämtning, livematchens resultat |
| `supabase.sql` | Databasen för molnsynk och livematcher, med radnivåsäkerhet |
| `tests.js` | Tester för `core.js`, `geo.js`, `games.js`, `stats.js` och `sync.js` |
| `i18n.js` | Svenska och engelska texter |
| `app.js` | Gränssnitt, datalagring, väder |
| `src.html` | HTML och design (mörkgrönt, vitt, svart, guld; ljust och mörkt läge) |
| `build.js` | `node build.js` slår ihop allt till `index.html` |
| `sw.js`, `manifest.webmanifest`, ikoner | Gör appen installerbar och offline-kapabel |

## Datamodell (sparas lokalt som JSON, `localStorage` nyckel `banboken:v1`)
```
profile  { name, hi (plushcp lagras negativt), homeClub, lang, theme, allowance }
courses  [{ id, name, club, lat, lon, demo, verified,
            tees: [{ id, name, cr, slope, holes: [{ par, si, length }] }] }]
rounds   [{ id, status: active|done, date, courseId, courseName, demo,
            tee (kopia – historiken ändras inte om banan redigeras),
            hi, allowance, format, current,
            holes: [{ strokes, putts, fir: left|hit|right, gir, miss, penalties, bunker, pickedUp }] }]
```
Samma struktur flyttas till Supabase-tabeller (profiles, courses, tees, holes, rounds, round_holes) i etapp 5.

## Vad som är gratis
| Del | Status |
|---|---|
| Appen, scorekort, WHS, statistik | Helt gratis, ingen server |
| GitHub Pages (hosting) | Gratis |
| Väder – Open-Meteo | Gratis utan nyckel för icke-kommersiellt bruk; kommersiell app kräver betald plan |
| Kartdata – OpenStreetMap (Overpass, Nominatim) | Gratis (ODbL, källhänvisning visas i appen); täckningen varierar mellan banor; används med låg volym enligt tjänsternas regler |
| Satellitbild – Esri World Imagery | Används utan nyckel med källhänvisning. För en publik/kommersiell app bör ett gratis ArcGIS-konto och villkoren godkännas – kan stängas av under Profil |
| Supabase (etapp 5, konton/synk/matcher) | Gratisnivå, kräver konto |
| AI-coach (etapp 4) | Kräver API-nyckel och kostar per anrop – inget kopplas in utan ditt godkännande |
| Officiella scorekort/CR/Slope för alla svenska banor, handicapsynk med Min Golf | Kräver avtal med Svenska Golfförbundet – ingen öppen källa finns |

## Etapp 2 – GPS och karta
1. **Banor → Hitta bana → Banor nära mig** (eller sök på namn). Appen hämtar hål, greener, bunkrar och vatten från OpenStreetMap och sparar dem i telefonen.
2. Kontrollera par och index mot scorekortet, fyll i CR och Slope, spara.
3. Starta en rond och tryck **Starta GPS**. Fram/mitt/bak, hinder (avstånd för att nå och passera), doglegs och vind relativt spelriktningen uppdateras när du går.
4. Tryck på kartan för att mäta till valfri punkt och se vad som är kvar till green.
5. När du står på nästa tee och har skrivit in score byter appen hål själv. Visas "Du verkar vara på hål N" kan du byta med ett tryck.

Ärlighet om data: avstånd visas bara där kartdata har koordinater. Hål utan koordinater markeras, och green utan kontur ger bara en ungefärlig mitt. OpenStreetMap är inte officiellt verifierat – lägg gärna till saknade greener och bunkrar själv på openstreetmap.org, så får alla bättre data.

Demobanan har en påhittad DEMO-karta och knappen **Flytta mig (demo)** så att du kan prova allt utan att vara på en bana.

## Etapp 3 – matcher
1. **Starta rond** → välj bana och tee → lägg till spelare (namn + handicapindex, från Golfvänner eller med deras spelarkod). Varje spelare kan ha egen tee.
2. **Spelsätt:** *Egen boll* (alla spelar sin boll) eller *Lagboll* (scramble 2/3/4, Texas scramble, greensome, foursome).
3. **Lag:** tryck A/B/C… per spelare.
4. **Spel:** välj hur många du vill samtidigt – slagspel brutto/netto, poängbogey, matchspel (singel eller bästboll), bästboll, sämstboll, nassau, skins, lagslagspel, lagmatch. Varje spel visar sina regler och föreslagen handicapreduktion enligt WHS; du kan ändra den.
5. Under ronden: skriv in medspelarnas score med ett tryck. Fliken **Tävling** visar ledartavla, matchstatus efter varje hål (t.ex. "Lag A 2 upp · 5 kvar", dormie, "vann 3/2") och vinnare automatiskt.
6. **Dela ställning** skickar en länk; kompisen öppnar den i Banboken och kan spara den. **Profil → Min spelarkod** låter kompisar lägga till dig.
7. Avslutade matcher visas under **Statistik → Matcher** med inbördes möten.

Regler som appen tillämpar: WHS rekommenderade reduktioner (individuellt slagspel/poäng 95 %, singelmatch 100 %, bästboll match 90 %, bästboll slag 85 %, scramble 35/15, 30/20/10, 25/20/15/10 %, greensome 60/40 %, foursome 50 %). I matchspel och skins spelar lägsta spelhandicap på 0. Sämstboll har ingen WHS-standard; appen använder 100 % och reglerna som står i spelet. Texas scramble använder scramble-procenten – kontrollera din tävlings regler.

## Etapp 4 – analys
- **Slag för slag** (valfritt, slås på i hålvyn): för varje slag anger du läge (tee, fairway, ruff, bunker, svårt läge, green) och avstånd kvar till hål – GPS-knappen fyller i avståndet till greenens mitt. Plikt läggs på slaget som orsakade den. Tryck *I hål* på sista slaget så fylls score och puttar i.
- **Utökad statistik:** scrambling, trepputtar, birdies, snitt mot par per par-typ och grafer över tid för poäng, brutto, puttar, GIR, FIR, scrambling, plikt och Strokes Gained (senaste 5/10/20/50).
- **Strokes Gained** i fyra delar (utslag, inspel, närspel, puttning) räknas bara på hål med fullständig slaglogg. Utan slaglogg visas enklare statistik i stället.
- **Coach** efter varje rond (under Statistik → ronden): vad som gick bra, var slagen tappades, jämförelse med tidigare ronder, fokusområden och tre konkreta träningsövningar. Varje påstående är märkt *Data* (räknat från dina registreringar) eller *Uppskattning* (tolkning).
- **Min golfbag** (Profil): klubbor och ungefärliga längder. Appen lär sig dina längder från loggade slag och föreslår klubba i GPS-vyn (märkt som uppskattning).

### Referensnivåer för Strokes Gained
Strokes Gained mot scratch eller hcp 5/10/15/20 kräver en tabell med förväntat antal slag från varje läge och avstånd för den nivån. Ingen fri och verifierad sådan tabell finns att tillgå, så appen levereras utan – den hittar aldrig på värden. I stället:
1. **Mot ditt eget snitt** (standard): när du har loggat 72 hål bygger appen en baslinje av dina egna slag. Plus = bättre än du brukar, minus = sämre.
2. **Importerad referens**: har du en licensierad tabell importerar du den under Statistik → Strokes Gained. Format (meter, förväntade slag kvar, minst två punkter per läge):
```json
{ "name": "Hcp 10", "source": "var tabellen kommer ifrån",
  "lies": { "tee": [[250, 3.9], [400, 4.5]], "fairway": [[50, 2.9], [150, 3.4]],
            "rough": [[50, 3.1], [150, 3.6]], "sand": [[10, 2.9], [50, 3.3]],
            "recovery": [[50, 3.5], [150, 4.0]], "green": [[1, 1.05], [5, 1.8], [15, 2.2]] } }
```
(Siffrorna ovan visar bara formatet – de är inte riktiga referensvärden.)

### AI-coach med språkmodell
Coachen i etapp 4 är regelbaserad och gratis. En språkmodell (t.ex. Claude via API) kan skriva friare analyser, men kostar per anrop och kräver API-nyckel och en liten server så att nyckeln inte ligger i appen. Den kopplas in först efter ditt godkännande – lämpligen tillsammans med Supabase i etapp 5.

## Alla banor i Sverige
**Banor → Alla banor i Sverige → Hämta banregistret.** Appen hämtar alla namngivna golfbanor i Sverige från OpenStreetMap (en gång, sparas i telefonen). Sök på namn eller ort (å/ä/ö behövs inte), eller tryck *Närmast först*. Välj en bana så hämtas hål, greener och hinder, och par och hålindex fylls i där kartdata har dem.

Course Rating och Slope finns inte i öppna data (de ägs av Svenska Golfförbundet). Nya banor sparas därför som *CR/Slope saknas*: du kan spela direkt med GPS och bruttoscore. Fyll i CR och Slope från scorekortet, klubbens hemsida eller Min Golf, så räknas handicap från nästa rond. Matcher med handicap kräver CR och Slope.

## Golfklubbar med flera banor
**Datamodell:** Klubb → Bana → Tee. Varje bana är en egen post med eget ID, egna tees, egen håldata (par, index, längd) och egen kartdata; ronder, scorekort och statistik pekar på banans ID, så två banor på samma klubb blandas aldrig. Banor på samma klubb har gemensamt klubbnamn (`club`) och klubbnyckel (`clubKey`).

**Så identifieras klubbens banor (generellt, för alla klubbar):**
1. *Kartdata:* banor vars yta ligger inuti en större klubbyta grupperas under klubben; banor med samma namnstam (t.ex. "Bokskogens … Gamla banan" och "… Nya banan") eller samma operatör inom 4 km grupperas också. Två banor med samma namn döljs aldrig – bara verkliga dubbletter (samma namn *och* i stort sett samma yta) slås ihop.
2. *Slingor i en gemensam yta:* om en klubb är inlagd som en yta med t.ex. 36 hål delas hålen upp i slingor genom att följa banan (nästa håls tee nära föregående green), eller via taggen `golf:course` om den finns. Användaren väljer slinga; 9-hålsslingor kan kombineras till 18 hål.
3. *Slopetabellen:* banor som finns i slopetabellen för klubben (Banadministration) visas också, även om de saknas i kartdata.
4. *Manuellt:* "Lägg till en bana på klubben" skapar en ny bana med klubben förifylld; par och index fylls i från scorekortet (tomma fält, inga påhittade värden).

**I appen:** "Alla banor i Sverige" visar klubbar; klubbar med flera banor fälls ut. I "Spela golf" visas klubben med alla sina banor (namn och antal hål) och ingen bana väljs automatiskt när det finns flera. 9-hålsbanor stöds (9-hålsvärdering, hålindex 1–9).

## Hämtning av kartdata (OpenStreetMap)
**Orsak till HTTP 504 (åtgärdat):** den tidigare frågan använde `map_to_area` (en av Overpass tyngsta operationer), hämtade alla golfobjekt (`nwr[golf]`) och varje sjö som korsade banan med hela sin geometri (`nwr[natural=water] … out geom`). Nära stora sjöar blev svaret enormt, servern hann inte klart och svarade 504. Vid tomt svar gjordes dessutom en andra, större fråga.

**Nu:**
- En enda fråga avgränsad till banans område + ca 150 m (`[bbox:…]`), bara de golfobjekt appen använder (hål, green, tee, fairway, bunker, vattenhinder) och geometri klippt till området (`out geom(bbox)`), så stora sjöar skickas inte i sin helhet. Banans kontur hämtas i samma fråga och används för att sortera bort hål från grannbanor.
- Nya försök vid 504/502/503/429/tidsgräns: max 4 försök över olika servrar med väntan 1 s, 2 s, 4 s (±25 %), `Retry-After` respekteras. Felaktiga frågor (4xx) och saknad uppkoppling provas inte igen.
- Identiska samtidiga förfrågningar delar på ett anrop.
- Cache för de 12 senast hämtade banorna (14 dagar). Om servern inte svarar används sparad data, även äldre.
- Felmeddelanden skiljer på: ingen uppkoppling, tidsgräns, överbelastad server (med HTTP-kod), för många förfrågningar, GPS-behörighet saknas, GPS tidsgräns och ingen position.
- **Fortsätt utan karta:** banan sparas utan GPS-data; par och index fylls i från scorekortet (tomma fält, inga påhittade värden). Score och statistik fungerar; GPS-avstånd är tydligt avstängda och kartdata kan hämtas senare från rondvyn med *Hämta kartdata nu*.

**Förslag för produktionsdrift:** de publika Overpass-servrarna är gratis men delade och får överbelastas – de är inte avsedda som backend för en app med många användare. En driftsäker lösning som följer OpenStreetMaps villkor (ODbL, källhänvisning) är att förbearbeta data: en schemalagd GitHub Action hämtar Sverige-extraktet från Geofabrik en gång i veckan, plockar ut golfbanornas objekt med osmium och publicerar en liten JSON-fil per bana på samma GitHub Pages-adress som appen. Appen läser då kartdata från egen server (snabbt, cachebart, ingen belastning på Overpass) och använder Overpass bara som reserv. Detta är inte byggt ännu.

## Design – Scandinavian Luxury Golf
- **Färger:** Deep Forest #103D2F, Midnight Green #09281F, Champagne Gold #C9A65A (bara detaljer och aktiv navigering), Warm Ivory #F8F6F0, Soft Sage #DDE6DF, Charcoal #202622. Mörkt läge följer telefonen.
- **Typografi:** Newsreader (serif) för rubriker, bannamn och hålnummer; Hanken Grotesk med tabellsiffror för knappar, avstånd, score och statistik.
- **GPS-vyn:** satellitkartan i full bredd med en flytande avståndsplakett (fram / mitt / bak, mitt störst), GPS-status uppe till vänster och kartknappar (följ mig, centrera, green/hela hålet, satellit, skärm tänd) uppe till höger. Föregående/nästa hål i hålhuvudet.
- **Komponenter:** knappar, chips, kort, segmentväljare, tee-rader med färgprick, banor med favoritstjärna, statistikpaneler, scorekort med symboler för eagle/birdie/bogey/dubbel.
- **Rörelse:** korta övergångar vid byte av vy, återkoppling när slag registreras, diskret markering när avståndet ändras. Allt stängs av om telefonen har "Reducera rörelse" påslaget.

## Tee, Course Rating och Slope
**Datakälla:** officiella slopetabeller ägs av Svenska Golfförbundet och finns bara via deras GIT API, som kräver avtal. Ingen öppen och tillåten källa finns, så appen hämtar inga värden automatiskt och hittar aldrig på värden. I stället finns en slopetabell som du fyller med verifierade uppgifter (klubbens scorekort/slopetabell).

**Datamodell:** Klubb → Bana → Slinga/hålkombination → Tee → Värdering. En värdering är en rad med tee, kön (herr/dam), rondtyp (18 hål, hål 1–9, hål 10–18), Course Rating, Slope, par, längd, källa och verifieringsdatum. Herr- och damvärderingar lagras separat och blandas aldrig.

**Banadministration** (Profil → Banadministration, skyddad med admin-PIN):
- *Rapport:* granskar alla banor – saknade tee, saknade herr-/damvärderingar, orimliga värden, felaktigt hålindex, par som inte stämmer, dubbletter, banor med flera slingor och banor som inte är kopplade.
- *Slopetabeller:* alla värderingar per slinga med källa och datum; ändra eller ta bort.
- *Lägg till/ändra:* en värdering i taget.
- *Import:* CSV (semikolon eller komma, decimalkomma fungerar) eller JSON. Kolumner: `Klubb;Bana;Slinga;OSM;Tee;Färg;Längd;Par;Kön;Hål;CR;Slope;Källa;Verifierad` (Kön = Herr/Dam, Hål = 18, 1-9 eller 10-18). Rader med fel visas med radnummer och importeras inte.
- *Koppla banor:* koppla varje bana i appen till rätt slinga. Banan får då automatiskt alla officiella tee.
- *Delad tabell:* publicera slopetabellen i ditt Supabase-projekt så att alla som använder appen med projektet får samma värden. Bara konton i tabellen `banboken_admins` kan ändra (skyddat i databasen). Gör dig själv till admin med raden längst ned i avsnittet i `supabase.sql`.

**Före ronden** visas bana, tee, längd, värdering (kön och hål), Course Rating, Slope, par, Handicap Index, Course Handicap och Playing Handicap. Saknas verifierad värdering står det exakt vad som saknas; ronden kan då spelas brutto.

**Beräkningar (WHS):**
- 18 hål: Course Handicap = HI × Slope/113 + (CR − Par).
- 9 hål: Course Handicap = (HI ÷ 2) × Slope/113 + (CR − Par) med 9-hålsvärderingen; hålindex rangordnas 1–9 inom de nio hålen.
- Playing Handicap = Course Handicap × handicapandel för spelformen (individuellt, matchspel, bästboll, scramble m.fl. har olika andelar).
- Score differential = 113/Slope × (justerat brutto − CR − PCC). För 9 hål: 9-hålsdifferential + förväntad differential för 9 ospelade hål (HI × 0,52 + 1,2), enligt WHS 2024.
- Differentialen är *preliminär* tills du anger dagens PCC (från Min Golf) på ronden. Det officiella handicapgrundande resultatet registreras alltid i Min Golf.

Befintliga ronder påverkas inte: varje rond sparar en kopia av teen och värderingen den spelades med.

## Live-GPS
- **En enda GPS-prenumeration** per rond (`watchPosition` med `enableHighAccuracy: true, maximumAge: 0, timeout: 10000`). Den stoppas när du lämnar hålvyn, avslutar ronden eller låser skärmen, och startar om när du kommer tillbaka.
- **Filter** för varje position: tidsstämpeln måste vara ny (högst 20 s gammal och nyare än förra), noggrannheten bättre än 150 m, och orimliga hopp (snabbare än 12 m/s plus mätfelen) avvisas. Tre samstämmiga positioner på ett nytt ställe godkänns, så appen hämtar sig efter t.ex. en tur med golfbil. När du står still dämpas bruset försiktigt; när telefonen rapporterar att du rör dig följer markören direkt.
- **Avstånd** till greenens framkant, mitt och bakkant räknas geodetiskt (haversine) från din aktuella position, längs linjen mot greenens mitt. Saknar kartdata greenens kontur visas en uppmaning att registrera fram/mitt/bak – stå på punkten och tryck *Min position* (kräver ±10 m), eller markera på satellitbilden. Punkterna sparas på banan och synkas.
- **Status**: GPS aktiv ±X m · låg noggrannhet · söker · signal borta (med hur gammal senaste position är) · saknar behörighet. Avstånden stryks över när signalen är borta – en gammal position visas aldrig som aktuell.
- **Karta**: blå markör med noggrannhetscirkel, streckad linje till valt mål (eller greenens mitt), *Följ mig* (mjuk följning), *Centrera*, dra för att flytta och nyp för att zooma. Manuell flytt pausar följningen.
- **GPS-testläge** (Profil → Starta GPS-testläge): simulerade rörelser (20 m fram/bak/vänster/höger, stå still med brus, tappa signal, tryck på kartan). Positionerna går genom samma filter som riktig GPS men visas alltid som **SIMULERAD GPS** i orange.

### Begränsningar på telefonen
- **Ingen GPS i bakgrunden.** Webbappar får inte position när skärmen är låst eller appen ligger i bakgrunden (varken iPhone eller Android). Knappen *Skärmen tänd* håller skärmen på under ronden där webbläsaren stöder det (Screen Wake Lock); den syns bara om telefonen stöder funktionen.
- Noggrannheten kommer från telefonen: utomhus normalt ±3–10 m. Under träd och nära byggnader blir den sämre – då visas varningen.
- På iPhone: Inställningar → Integritet och säkerhet → Platstjänster → Safari-webbplatser → *Vid användning av appen* och *Exakt plats* på.

## Etapp 5 – färdig produkt

### Molnsynk och konto (gratis, ca 10 minuter från iPhone)
1. Gå till **supabase.com** i Safari → *Start your project* → logga in med GitHub (kontot albinastrom fungerar) → **New project** (namn: banboken, region: Stockholm/eu-north-1 om den finns, annars Frankfurt). Välj gratisplanen.
2. **SQL Editor → New query** → öppna `supabase.sql` i appen Filer, kopiera allt, klistra in → **Run**.
3. **Authentication → Sign In / Providers → Email**: låt *Email* vara på.
4. **Authentication → Emails → Magic Link**: lägg till raden `Din kod: {{ .Token }}` i mallen och spara. Då får du en sexsiffrig kod i stället för bara en länk (länkar öppnas i Safari och inte i hemskärmsappen).
5. **Project Settings → API**: kopiera *Project URL* och den publika nyckeln (*anon* eller *publishable*). Använd **aldrig** *service_role* / *secret* i appen.
6. I Banboken: **Profil → Konto och molnsynk** → klistra in URL och nyckel → ange e-post → skriv in koden.

Synk sker automatiskt några sekunder efter varje ändring, varje minut och när täckningen kommer tillbaka. Allt fungerar som förut utan täckning; ändringarna skickas när nätet finns. Vid krock (samma rond ändrad på två telefoner innan synk) behålls ändringen på telefonen som synkar och skickas upp.

Gratisnivån hos Supabase räcker gott (databasstorlek 500 MB; en rond är 5–20 kB). Gratisprojekt pausas efter en veckas inaktivitet – öppna dem på supabase.com så startar de igen. Data i telefonen påverkas inte.

### Livematcher
I en rond med medspelare: **Tävling → Starta livematch → Dela livelänk**. Kompisarna öppnar länken (de behöver inget konto), väljer vem de är och för in sin egen score. Alla ser ställningen uppdateras var 10:e sekund. Länken gäller i 2 dygn. Den som startade matchen för sin egen score och kan även föra in åt andra; en medspelares eget resultat på ett hål vinner.

### Säkerhet
- Radnivåsäkerhet i databasen: varje konto når bara sina egna dokument. Livematcher kan bara läsas med koden (ingen kan lista matcher), och medspelare kan bara skriva hålresultat för spelare som finns i matchen, med kontrollerade värden.
- Inloggning med engångskod; inget lösenord lagras. Inloggningen sparas separat i telefonen och följer aldrig med i exporterade säkerhetskopior.
- Innehållssäkerhetspolicy (CSP): appen får bara ansluta till de tjänster den använder (Open-Meteo, OpenStreetMap, Esri-bilder, ditt Supabase-projekt). Allt som visas escapas; inmatning från länkar, koder och importer valideras.
- Den publika nyckeln är gjord för att finnas i appen; skyddet ligger i databasens regler.

### Prestanda och offline
- Testad med 300 ronder: statistiksidan ritas på ca 20–30 ms (dator); historiken visas i delar. Beräkningar för avslutade ronder cachas.
- Service worker: appen startar utan nät; kartdata, banor och ronder finns i telefonen.

### App Store och Google Play
Appen är redan installerbar på båda plattformarna som webbapp (Lägg till på hemskärmen) och fungerar i helskärm och offline. För att ligga i butikerna:
- **Google Play**: gå till **pwabuilder.com**, ange din GitHub-adress → *Package for stores → Android*. Det skapar ett färdigt paket (Trusted Web Activity). Kräver ett Google Play-utvecklarkonto (engångsavgift 25 USD) – betalt, så det görs först efter ditt godkännande.
- **App Store**: PWABuilder skapar även ett iOS-projekt, men det måste byggas i Xcode på en Mac och kräver Apple Developer Program (99 USD/år). Alternativ utan egen Mac är molntjänster som hyr ut Mac-datorer (betalda).
- Manifestet har redan id, beskrivning, kategorier och maskerbar ikon som butikerna kräver. Butiksskärmdumpar kan tas från appen på telefonen.

### Gratis, nycklar och licenser
| Del | Status |
|---|---|
| Appen, scorekort, WHS, matcher, statistik, Strokes Gained mot eget snitt, coach | Gratis |
| GitHub Pages | Gratis |
| Supabase (konto, synk, livematcher) | Gratisnivå; kräver eget projekt (URL + publik nyckel) |
| Open-Meteo väder | Gratis för icke-kommersiellt bruk |
| OpenStreetMap kartdata | Gratis (ODbL, källhänvisning) |
| Esri satellitbild | Används med källhänvisning; för publik/kommersiell app: gratis ArcGIS-konto och villkor |
| Strokes Gained mot scratch/hcp-nivåer | Kräver licensierad referenstabell |
| Officiella scorekort och handicapsynk (Min Golf) | Kräver avtal med Svenska Golfförbundet |
| AI-coach med språkmodell | Betald API + server – inte inkopplad utan ditt godkännande |
| Google Play / App Store | 25 USD engång / 99 USD per år – inte gjort utan ditt godkännande |

## Kända begränsningar
- 18-hålsronder (9 hål kommer senare). Matchspel räknas från hål 1 och framåt (inte gunstart).
- Livematcher uppdateras var 10:e sekund (inte direkt). I lagboll-format för den som startade matchen lagens score; medspelare kan följa men inte skriva.
- Spelare från olika tees jämförs mot par för sin egen tee; om hålets par skiljer mellan tees i matchspel justeras det inte.
- Satellitbilder sparas inte offline (Esris villkor). Kartritningen och alla avstånd fungerar offline.
- 27-hålsanläggningar kan ha flera hål med samma nummer i kartdata; appen varnar då.
- Score differential visas utan PCC – det officiella värdet kommer från handicapsystemet.
- Data finns bara i telefonen: använd **Profil → Exportera data** regelbundet.
