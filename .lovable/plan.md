# Issue #6 — Sektionsvis fallback för sparade inställningar (analys)

Endast analys. Ingen kod ändrad.

## 1. Vad nollställer hela konfigurationen idag

`loadStoredSettings()` migrerar `filter` och `naming`, kör sedan **en** `settingsSchema.safeParse()` på hela objektet. Faller den → `return DEFAULT_SETTINGS`. Allt annat (per-target-sanering, targetId-fallback, sektionsmerge mot defaults) körs _efter_ grinden och skyddar alltså inget.

Viktig asymmetri: `filter` default-mergeas före validering (`migrateFilter` spreadar `DEFAULT_SETTINGS.filter`), medan `naming`, `sort`, `packs`, `export` valideras exakt som de ligger i localStorage. Alla fält i de schemana är obligatoriska (utom några `.optional()` i `sort`). Därför är **partiella/äldre payloads** den stora riskklassen, inte bara "korrupt data".

Konkreta, realistiska payloads som idag ger totalnollställning:

| Payload                                                                    | Varför den failar                                                |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `packs` saknar `rxOnlyPolicy` (sparad innan fältet infördes)               | `packsSchema` kräver fältet                                      |
| `packs.placement: "before"` / annat legacy-värde                           | enum-miss                                                        |
| `packs.freqDupePolicy` saknas eller är legacy-sträng                       | enum-miss                                                        |
| `naming` saknas helt i objektet                                            | `migrateNaming(undefined)` → `undefined` → `namingSchema` failar |
| `naming` saknar `transliterate`/`uppercase`/`abbreviations.districtPrefix` | obligatoriska fält                                               |
| `naming.cityMaxLength: 0` (eller `"6"` som sträng)                         | min 1 / typfel                                                   |
| `sort` saknas eller saknar `home_district_first`                           | obligatoriskt fält                                               |
| `sort.keys` innehåller en nyckel vi tagit bort/döpt om                     | enum-miss                                                        |
| `sort.geohashPrecision: 0` eller `13`                                      | range                                                            |
| `export.split` saknas (äldre payload utan split-stöd)                      | `splitSchema` obligatoriskt                                      |
| `export.split.chunkSize: 1000`                                             | max 999                                                          |
| `export.targetId: ""`                                                      | `min(1)`                                                         |
| `export.perTarget` är en array eller `null`                                | `z.record` failar                                                |
| valfri sektion är `null` (t.ex. `naming: null`)                            | typfel                                                           |

Notera att flera av dessa **redan har en avsedd, mildare hantering längre ned** i funktionen (okänt `targetId` → default, ogiltig per-target-patch → target-defaults). Den hanteringen når man aldrig om något helt annat, t.ex. `sort.geohashPrecision`, är trasigt. Det är kärnan i issue #6.

Undantag som _inte_ är problem: helt korrupt JSON (rimligt att ge defaults) och okända framtida fält (passthrough släpper igenom dem).

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

Det är enda strukturella ändringen. `settingsSchema` behålls som är, men `loadStoredSettings` slutar använda helhetsvarianten som grind (se invändning 5). Filscope enligt invändning 4. Ingen `STORAGE_KEY`-bump — poängen är just att gamla nycklar ska överleva.

## 3. Regressionsrisker

- **Passthrough-fält**: sektionsvis merge måste spreada `{...default, ...stored}` och behålla `.passthrough()`, annars försvinner okända framtida fält som dagens tester uttryckligen skyddar (`someFutureFacet`, `futureNamingFlag`, …). Toppnivåns okända fält måste kopieras explicit när vi inte längre returnerar `check.data`.
- **Legacy-migrering körs före merge**: `migrateNaming` måste fortsatt se det _sparade_ värdet. Mergar man defaults först skrivs inte `collisionPolicy: "stop"` över — det är fortfarande ogiltigt — men ordningen måste ändå vara migrera → merge → validera för att `modeStrategy`/`customModes`-logiken i `migrateFilter` ska se rätt indata (den kollar `!Array.isArray(parsedFilter.modes)` på råvärdet).
- **Tystare fel**: idag ger en trasig payload en `console.warn` och ett synligt totalt återställ. Med sektionsvis fallback kan en användare tappa bara `sort` utan att märka det. Behåll en `console.warn` per fallande sektion med sektionsnamn.
- **Okända targets**: beteendet får inte skärpas — ett borttaget target ska droppas tyst ur `perTarget` och ett okänt valt `targetId` falla tillbaka, båda utan att röra andra sektioner.
- **Kors-sektionsinkonsistens**: sektionsvis fallback kan producera kombinationer som helhetsvalidering aldrig såg, t.ex. `sort.home_district` pekar på ett distrikt som inte längre finns i `filter.regions`, eller `export.split.mode: "per_district"` med default-filter. Detta är redan möjligt idag via UI:t och hanteras nedströms i pipeline/UI — vi bör explicit _inte_ införa kors-sektionsvalidering nu, bara notera det.
- **Idempotens**: vi sparar alltid ut hela det normaliserade objektet, så load → save → load är stabilt så länge merge är deterministisk. Måste testas om, eftersom fler payloads nu överlever första loaden.
- **`filter`-beteendet ändras inte** — det är redan sektionsvis i praktiken; risken är att man av misstag "städar" bort default-mergen i samma refaktor.

## 4. Testfall / acceptanskriterier

Utökar `src/hooks/__tests__/settingsPersistence.test.tsx` (eller ny `settings.load.test.ts` mot den rena funktionen). Alla befintliga tester ska passera oförändrade.

Sektionsisolering — för varje fall: den trasiga sektionen = default, **alla andra sektioner behåller sina sparade värden**:

1. `sort.geohashPrecision: 99` → `sort` default, `naming.separator: "_"` kvar, `packs.placement: "prepend"` kvar.
2. `packs.placement: "before"` (legacy) → `packs` default, `sort.keys` kvar.
3. `naming.cityMaxLength: 0` → `naming` default, `filter.modes` kvar.
4. `naming: null` och `sort: undefined` samtidigt → båda default, `export.targetId` kvar.

Merge av saknade fält: 5. `packs` utan `rxOnlyPolicy` → `rxOnlyPolicy` = default, `freqDupePolicy: "drop_pack"` från payloaden bevarat (inte hela sektionen nollställd). 6. `naming` utan `transliterate` → fältet defaultas, `components` från payloaden bevarat. 7. `naming.abbreviations.type` med bara `{ Repeater: "REP" }` → övriga nycklar från defaults kvar.

Export-undersektioner: 8. `export.split.chunkSize: 5000` → `split` default, men `targetId: "vgc-n76"` och giltig `perTarget["chirp-generic"].maxLength: 8` bevaras. 9. `export.targetId: "no-such-target"` → default-target, `perTarget` orörd, `split.mode: "per_district"` bevarad. 10. `export.perTarget: null` → `{}` + defaults, `targetId` och `split` bevarade. 11. ogiltig patch för `chirp-generic` + giltig patch för `vgc-n76` → bara chirp återställs. 12. okänt target-id i `perTarget` droppas, kända kvar (befintligt test, ska fortsatt gälla).

Legacy och passthrough: 13. `collisionPolicy: "stop"` + trasig `sort` → naming migreras till `numeric_suffix` _och_ behåller `separator`, sort defaultas. 14. `modeStrategy: "custom"` + trasig `packs` → filter-migreringen gäller fortfarande. 15. okända fält på toppnivå och i varje sektion bevaras även när en _annan_ sektion faller tillbaka. 16. korrupt JSON → `DEFAULT_SETTINGS` (oförändrat). 17. `{}` som sparad payload → exakt `DEFAULT_SETTINGS`. 18. load → save → load idempotent för en payload med två trasiga sektioner.

Acceptanskriterium sammanfattat: _ett fel i en sektion får aldrig påverka en annan sektion, och ett saknat fält får aldrig kasta bort syskonfält i samma sektion._

## 5. Prövning av invändningarna

### 1. `naming.abbreviations` — ingen djup map-merge. Invändningen är riktig.

Kontrollerat: `NamingEditor.tsx` innehåller inga referenser till `abbreviations` alls, och `naming.ts` läser mapparna rent uppslagsvis med fallback (`n.abbreviations.type[ch.type] ?? ch.type`). Alltså:

- En saknad nyckel är **ofarlig** — namngivningen faller tillbaka på råvärdet.
- Mapparna är fritt användarstyrda `Record<string,string>` och schemat kräver inga specifika nycklar.
- En djup map-merge skulle därför lösa ett icke-problem och samtidigt kunna återinföra en mapping som användaren avsiktligt tagit bort (via importerad/handredigerad payload — UI:t kan det inte idag, men det är inte något vi vill låsa fast).

**Rekommendation: bara `{ ...DEFAULT.abbreviations, ...stored.abbreviations }`.** Det fyller saknade `type`/`network`/`band`/`districtPrefix` (som schemat kräver) men bevarar ett uttryckligen sparat `type`-record exakt. Ändrat i avsnitt 2 ovan.

### 2. Rot måste vara ett vanligt objekt. Ja.

`JSON.parse` kan ge `null`, array, sträng eller tal, och `"[1,2]"` skulle med naiv toppnivå-passthrough ge oss `{"0":1,"1":2}` som bevarade "framtida fält" — brus som sedan skrivs tillbaka till localStorage och lever vidare för alltid.

**Rekommendation:** loadern kräver först `typeof raw === "object" && raw !== null && !Array.isArray(raw)`, annars `DEFAULT_SETTINGS` — samma väg som korrupt JSON. Samma vakt tillämpas per sektion innan merge: en sektion som inte är ett vanligt objekt går direkt till sin default. (`filter.statuses` m.fl. är fortfarande arrayer inuti sektionerna; vakten gäller bara sektionsroten.)

### 3. Gränsen merge-vid-saknat / default-vid-ogiltigt — bekräftas.

Regeln är: _frånvaro är inte ett fel, det är en äldre payload; ett närvarande men ogiltigt värde är okänd data vi inte kan tolka._

Vi ska **inte** gå ned till fältvis räddning av typ-/enumfel, av tre skäl:

- Det kräver att varje sektionsschema splittas i per-fält-scheman eller att vi tolkar `ZodError.issues` och plockar bort felande paths — betydligt mer kod och en ny felkälla, tvärtemot "minsta säkra ändring".
- Zod-fel har inte alltid en entydig path (unions, `.refine`), så fältvis räddning blir approximativ.
- Ett ogiltigt enum-värde signalerar oftast en _legacy-form_ vi borde migrera explicit (som `collisionPolicy: "stop"`), inte tysta bort fält för fält. Sektionsdefault gör den skulden synlig i en `console.warn` i stället för att dölja den.

Blastradien för sektionsdefault är dessutom liten så snart sektionerna är isolerade: du tappar en sektion, inte hela konfigurationen.

### 4. Filscope — mindre än ~120 rader, en fil.

Invändningen är befogad; en egen "modul" med flera exports vore överarkitektur. Nästan all logik finns redan (`migrateFilter`, `migrateNaming`, `sanitizePerTarget`, targetId-fallbacken). Det som verkligen tillkommer är en liten generisk hjälpare plus fem anrop.

**Exakt scope:**

- `src/hooks/useCodeplugSettings.ts` — behålls som enda hem för logiken. Där: en lokal `parseSection(name, stored, fallback, schema)` (~10 rader) och en omskriven `loadStoredSettings` som anropar den per sektion. Nettotillskott uppskattat 40–60 rader. `migrateNaming` fortsätter exporteras (befintligt test).
- Ny export från samma fil: `export function loadSettingsFromRaw(raw: unknown): Settings` — det testbara ytan. `loadStoredSettings` blir `loadSettingsFromRaw(JSON.parse(localStorage.getItem(KEY)))` med try/catch runt.
- `src/hooks/__tests__/settingsPersistence.test.tsx` — utökas; de nya rena fallen kan testas direkt mot `loadSettingsFromRaw` utan `renderHook`, befintliga hook-tester lämnas kvar.

Ingen ny fil under `src/lib/codeplug/`. `settings.schema.ts` och `targets/registry.ts` rörs inte.

### 5. Ingen slutkontroll med `settingsSchema` i runtime-vägen.

Att köra den sammansatta produkten genom `settingsSchema` och falla tillbaka på `DEFAULT_SETTINGS` vid fel återinför exakt den totalfallback vi tar bort — och i det värsta läget: efter att varje sektion redan validerats kan bara ett programmeringsfel få helheten att fela, och då straffas användaren för vår bugg.

**Rekommendation:** upptäck programmeringsfel utan runtime-kostnad:

- I test: ett fall som kör `loadSettingsFromRaw` på ett urval trasiga payloads och asserterar `settingsSchema.safeParse(result).success === true` för varje. Där är totalvalideringen exakt rätt verktyg.
- Behåll den befintliga invarianten "`settingsSchema` godkänner `DEFAULT_SETTINGS`".
- Valfritt i runtime: `if (import.meta.env.DEV)` → `settingsSchema.safeParse(result)` och `console.error` vid fel, men **returnera resultatet ändå**. Ingen fallback, bara ett larm.

## 6. Slutligt beslut

**Implementera, med justeringarna ovan.** Sektionsvis migrera → shallow-merge → validera → sektionsdefault, `export` uppdelat i `targetId` / `perTarget` / `split`, objektvakt på rot och per sektion, `abbreviations` enbart shallow-mergad, ingen fältvis räddning, ingen runtime-slutvalidering av helheten. Allt i `src/hooks/useCodeplugSettings.ts` plus utökade tester i `src/hooks/__tests__/settingsPersistence.test.tsx`.

Utanför scope: kors-sektionsvalidering, ny lagringsnyckel, ändringar i `settings.schema.ts` eller target-registret, UI-ändringar.
