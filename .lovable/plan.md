# Issue #6 — Sektionsvis fallback för sparade inställningar (analys)

Endast analys. Ingen kod ändrad.

## 1. Vad nollställer hela konfigurationen idag

`loadStoredSettings()` migrerar `filter` och `naming`, kör sedan **en** `settingsSchema.safeParse()` på hela objektet. Faller den → `return DEFAULT_SETTINGS`. Allt annat (per-target-sanering, targetId-fallback, sektionsmerge mot defaults) körs *efter* grinden och skyddar alltså inget.

Viktig asymmetri: `filter` default-mergeas före validering (`migrateFilter` spreadar `DEFAULT_SETTINGS.filter`), medan `naming`, `sort`, `packs`, `export` valideras exakt som de ligger i localStorage. Alla fält i de schemana är obligatoriska (utom några `.optional()` i `sort`). Därför är **partiella/äldre payloads** den stora riskklassen, inte bara "korrupt data".

Konkreta, realistiska payloads som idag ger totalnollställning:

| Payload | Varför den failar |
| --- | --- |
| `packs` saknar `rxOnlyPolicy` (sparad innan fältet infördes) | `packsSchema` kräver fältet |
| `packs.placement: "before"` / annat legacy-värde | enum-miss |
| `packs.freqDupePolicy` saknas eller är legacy-sträng | enum-miss |
| `naming` saknas helt i objektet | `migrateNaming(undefined)` → `undefined` → `namingSchema` failar |
| `naming` saknar `transliterate`/`uppercase`/`abbreviations.districtPrefix` | obligatoriska fält |
| `naming.cityMaxLength: 0` (eller `"6"` som sträng) | min 1 / typfel |
| `sort` saknas eller saknar `home_district_first` | obligatoriskt fält |
| `sort.keys` innehåller en nyckel vi tagit bort/döpt om | enum-miss |
| `sort.geohashPrecision: 0` eller `13` | range |
| `export.split` saknas (äldre payload utan split-stöd) | `splitSchema` obligatoriskt |
| `export.split.chunkSize: 1000` | max 999 |
| `export.targetId: ""` | `min(1)` |
| `export.perTarget` är en array eller `null` | `z.record` failar |
| valfri sektion är `null` (t.ex. `naming: null`) | typfel |

Notera att flera av dessa **redan har en avsedd, mildare hantering längre ned** i funktionen (okänt `targetId` → default, ogiltig per-target-patch → target-defaults). Den hanteringen når man aldrig om något helt annat, t.ex. `sort.geohashPrecision`, är trasigt. Det är kärnan i issue #6.

Undantag som *inte* är problem: helt korrupt JSON (rimligt att ge defaults) och okända framtida fält (passthrough släpper igenom dem).

## 2. Minsta säkra arkitekturändring

Ersätt den enda helhetsgrinden med **sektionsvis pipeline**: per sektion `migrera → merga mot default → validera → vid fel: sektionens default`. Toppnivåns okända fält kopieras över oförändrat.

```text
raw JSON  ──parse fail──> DEFAULT_SETTINGS
   │
   ├─ filter : migrateFilter → filterSchema        → fel? DEFAULT.filter
   ├─ naming : migrateNaming → merge default → namingSchema → fel? DEFAULT.naming
   ├─ sort   : merge default → sortSchema          → fel? DEFAULT.sort
   ├─ packs  : merge default → packsSchema         → fel? DEFAULT.packs
   └─ export : delas upp (se nedan)
   + okända toppnivåfält bevaras
```

Merge-mot-default före validering är det som faktiskt löser hela "saknat fält"-klassen ovan; enbart sektionsvis fallback räddar inte en payload som saknar `rxOnlyPolicy` — den skulle fortfarande tappa användarens `placement`. Merge är **shallow, en nivå per sektion**. Enda undantaget är `naming.abbreviations`, som får exakt ett extra shallow-steg — se invändning 1 nedan (ingen djup map-merge).

**Ja, `export` behöver undersektionsnivå.** Annars tappar ett trasigt `split.chunkSize: 1000` både `targetId` och hela `perTarget`. Dela upp i tre oberoende delar:

- `targetId`: sträng och `getTarget(id)` finns → behåll, annars `DEFAULT.export.targetId`.
- `perTarget`: måste vara ett objekt (annars `{}`); därefter befintlig `sanitizePerTarget` per id — okända id droppas, ogiltig patch → det targetets defaults, övriga target orörda.
- `split`: merge mot default → `splitSchema` → fel? `DEFAULT.export.split`.

Det är enda strukturella ändringen. `settingsSchema` behålls som är (fortsatt användbart i tester och som dokumentation), men `loadStoredSettings` slutar använda helhetsvarianten som grind. Alternativt exporteras helheten som en ren `composeSettings`-hjälpare så testerna kan köra den direkt.

Rekommenderat att bryta ut logiken till `src/lib/codeplug/settings.load.ts` (ren funktion `loadSettingsFromRaw(raw: unknown): Settings`) så persistensen kan testas utan `renderHook`. Hooken blir tunn. Ingen `STORAGE_KEY`-bump behövs — poängen är just att gamla nycklar ska överleva.

## 3. Regressionsrisker

- **Passthrough-fält**: sektionsvis merge måste spreada `{...default, ...stored}` och behålla `.passthrough()`, annars försvinner okända framtida fält som dagens tester uttryckligen skyddar (`someFutureFacet`, `futureNamingFlag`, …). Toppnivåns okända fält måste kopieras explicit när vi inte längre returnerar `check.data`.
- **Legacy-migrering körs före merge**: `migrateNaming` måste fortsatt se det *sparade* värdet. Mergar man defaults först skrivs inte `collisionPolicy: "stop"` över — det är fortfarande ogiltigt — men ordningen måste ändå vara migrera → merge → validera för att `modeStrategy`/`customModes`-logiken i `migrateFilter` ska se rätt indata (den kollar `!Array.isArray(parsedFilter.modes)` på råvärdet).
- **Tystare fel**: idag ger en trasig payload en `console.warn` och ett synligt totalt återställ. Med sektionsvis fallback kan en användare tappa bara `sort` utan att märka det. Behåll en `console.warn` per fallande sektion med sektionsnamn.
- **Okända targets**: beteendet får inte skärpas — ett borttaget target ska droppas tyst ur `perTarget` och ett okänt valt `targetId` falla tillbaka, båda utan att röra andra sektioner.
- **Kors-sektionsinkonsistens**: sektionsvis fallback kan producera kombinationer som helhetsvalidering aldrig såg, t.ex. `sort.home_district` pekar på ett distrikt som inte längre finns i `filter.regions`, eller `export.split.mode: "per_district"` med default-filter. Detta är redan möjligt idag via UI:t och hanteras nedströms i pipeline/UI — vi bör explicit *inte* införa kors-sektionsvalidering nu, bara notera det.
- **Idempotens**: vi sparar alltid ut hela det normaliserade objektet, så load → save → load är stabilt så länge merge är deterministisk. Måste testas om, eftersom fler payloads nu överlever första loaden.
- **`filter`-beteendet ändras inte** — det är redan sektionsvis i praktiken; risken är att man av misstag "städar" bort default-mergen i samma refaktor.

## 4. Testfall / acceptanskriterier

Utökar `src/hooks/__tests__/settingsPersistence.test.tsx` (eller ny `settings.load.test.ts` mot den rena funktionen). Alla befintliga tester ska passera oförändrade.

Sektionsisolering — för varje fall: den trasiga sektionen = default, **alla andra sektioner behåller sina sparade värden**:
1. `sort.geohashPrecision: 99` → `sort` default, `naming.separator: "_"` kvar, `packs.placement: "prepend"` kvar.
2. `packs.placement: "before"` (legacy) → `packs` default, `sort.keys` kvar.
3. `naming.cityMaxLength: 0` → `naming` default, `filter.modes` kvar.
4. `naming: null` och `sort: undefined` samtidigt → båda default, `export.targetId` kvar.

Merge av saknade fält:
5. `packs` utan `rxOnlyPolicy` → `rxOnlyPolicy` = default, `freqDupePolicy: "drop_pack"` från payloaden bevarat (inte hela sektionen nollställd).
6. `naming` utan `transliterate` → fältet defaultas, `components` från payloaden bevarat.
7. `naming.abbreviations.type` med bara `{ Repeater: "REP" }` → övriga nycklar från defaults kvar.

Export-undersektioner:
8. `export.split.chunkSize: 5000` → `split` default, men `targetId: "vgc-n76"` och giltig `perTarget["chirp-generic"].maxLength: 8` bevaras.
9. `export.targetId: "no-such-target"` → default-target, `perTarget` orörd, `split.mode: "per_district"` bevarad.
10. `export.perTarget: null` → `{}` + defaults, `targetId` och `split` bevarade.
11. ogiltig patch för `chirp-generic` + giltig patch för `vgc-n76` → bara chirp återställs.
12. okänt target-id i `perTarget` droppas, kända kvar (befintligt test, ska fortsatt gälla).

Legacy och passthrough:
13. `collisionPolicy: "stop"` + trasig `sort` → naming migreras till `numeric_suffix` *och* behåller `separator`, sort defaultas.
14. `modeStrategy: "custom"` + trasig `packs` → filter-migreringen gäller fortfarande.
15. okända fält på toppnivå och i varje sektion bevaras även när en *annan* sektion faller tillbaka.
16. korrupt JSON → `DEFAULT_SETTINGS` (oförändrat).
17. `{}` som sparad payload → exakt `DEFAULT_SETTINGS`.
18. load → save → load idempotent för en payload med två trasiga sektioner.

Acceptanskriterium sammanfattat: *ett fel i en sektion får aldrig påverka en annan sektion, och ett saknat fält får aldrig kasta bort syskonfält i samma sektion.*

## 5. Rekommendation

**Implementera — men i den avgränsade formen ovan.** Motivet är konkret: dagens beteende innebär att varje framtida fälttillägg i `naming`/`sort`/`packs`/`export` tyst nollställer alla sparade inställningar för befintliga användare vid nästa läsning, om vi inte kommer ihåg att skriva en migrering. Med merge-före-validering blir fälttillägg bakåtkompatibla per konstruktion. Det är en förutsättning för att lägga till fler exporttargets utan att bränna användarnas konfiguration.

Avgränsning: ingen kors-sektionsvalidering, ingen ny lagringsnyckel, ingen ändring av `settingsSchema`s form, inga UI-ändringar utöver eventuell `console.warn`-text. Uppskattad omfattning: en ny ren modul (~120 rader), en tunnare hook, samt testfallen i punkt 4.
