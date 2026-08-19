# Gör drift-skyddet i settings.schema.ts äkta

## Vad som faktiskt är fel

```ts
export type _SettingsSchemaCompatible =
  z.infer<typeof settingsSchema> extends Partial<Settings> ? true : true;
```

Båda grenarna är `true`, så uttrycket är en no-op. Kommentaren ovanför lovar ett skydd som inte finns. Det är hela buggen — ingen runtime-påverkan.

Det finns dessutom en andra, viktigare sanning: **villkoret skulle ändå inte hålla om det aktiverades.** `settingsSchema` är byggt av `.passthrough()`-objekt, så `z.infer` innehåller indexsignaturer (`{ [k: string]: unknown }`) på varje nivå. En sådan typ är inte `extends Partial<Settings>` — t.ex. `naming.collisionPolicy` är rätt, men `filter.statuses` är `string[] | undefined` mot `string[]`, och passthrough-indexet gör jämförelsen ännu lösare. Byter man `: true` mot `: false` får man alltså en kompileringsfel som **inte** speglar ett verkligt fel. Det är därför den naiva varianten av kandidatfixen är farlig.

## 1. Vad kandidatfixen kan råka förstöra

Nuvarande `loadStoredSettings()` har en medveten kaskad av resiliens som lätt går sönder om man "städar bort casts":

- `settingsSchema.safeParse(migrated)` är **allt-eller-inget på toppnivån**. `filter`, `naming`, `sort`, `packs`, `export` är alla obligatoriska. Saknas en av dem → hela sparade konfigurationen kastas och man faller till `DEFAULT_SETTINGS`. Det är dagens verkliga beteende och det är redan sprött; att göra fler fält obligatoriska (t.ex. i `filterSchema`, där allt idag är `.optional()`) skulle öka antalet nollställningar.
- Slutobjektet byggs som `{ ...DEFAULT_SETTINGS, ...(data as Partial<Settings>), filter: …, naming: {…spread}, packs: {…}, sort: {…}, export: {…} }`. Den breda spreaden av `data` är det som bär över **okända toppnivåfält** från localStorage tillbaka in i state, och därmed tillbaka ut vid nästa `setItem`. Ett strikt `satisfies Settings` på ett objekt-literal skulle tvinga bort just den spreaden (eller kräva `as`), och då tappas okända fält tyst vid första inladdning.
- `migrateNaming` returnerar avsiktligt `Record<string, unknown>` och kör **före** schemat. Poängen är att `"stop"` ska hinna bli `"numeric_suffix"` innan `z.enum` underkänner och nollställer allt. Låter man den returnera en exakt `NamingSettings`-slice måste den validera/fylla i alla fält själv — och då flyttar man reset-logiken in i migreringen istället för att undvika den.
- `sanitizePerTarget` droppar tyst okända target-id:n (target borttagen) och ersätter ogiltig patch med `target.defaultSettings`. Att typa den som `Record<string, unknown>` → exakt typ ger inget, eftersom `perTarget` per definition är target-definierad och otypbar centralt.

## 2. Behövs `.passthrough()`, och var?

Ja, men inte överallt. Rollerna:

| Schema | Passthrough behövs? | Varför |
| --- | --- | --- |
| `settingsSchema` (topp) | **Ja** | Framtida/okända toppnivåsektioner ska överleva en nedgradering (användaren kör äldre deploy). |
| `filterSchema` | **Ja** | Bär de deprecated fälten `districts`, `includeUnknownDistricts`, `modeStrategy`, `customModes` som migreringen läser. |
| `namingSchema` | Ja (svagt) | `abbreviations` kan få nya kategorier. |
| `packsSchema`, `sortSchema`, `splitSchema`, `exportSchema` | Ja (svagt) | Samma forward-compat-argument; ingen kostnad. |

Viktigt: passthrough skyddar bara det som *passerar* schemat. Idag går ändå hela objektet förlorat om en obligatorisk sektion saknas — passthrough hjälper inte där.

## 3. Kan skärpningen orsaka reset / förlorade fält?

Ja, på fyra konkreta sätt om man inte är försiktig:

1. **Legacy-reset**: gör man fler fält obligatoriska (särskilt i `filterSchema`) nollställs sparade konfigurationer som idag överlever.
2. **Okända fält försvinner**: byter man ut `...(data as Partial<Settings>)` mot explicit fält-för-fält-konstruktion tappas passthrough-fälten. Det är en tyst regression.
3. **Target-settings avvisas**: `t.settingsSchema` är typad `z.ZodType<TSettings>` — tar man bort `as` i `registry.ts`/`sanitizePerTarget` kan varianstrubbel tvinga fram nya, striktare parses. Att `merged` alltid är `defaults + patch` är det som räddar delvisa patchar idag; behåll det.
4. **Partiella gamla settings**: en payload från `sk6ba-chirp-settings-v5`-eran med bara `{ filter, naming }` nollställs redan idag. Ändra inte det i samma PR — men dokumentera det.

## 4. Minsta säkra fix

Tre små steg, ingen användarsynlig förändring:

1. **Ta bort `_SettingsSchemaCompatible`** och den vilseledande kommentaren. En falsk garanti är sämre än ingen.
2. **Namnge den persisterade formen** i settings.schema.ts:
   ```ts
   export type StoredSettings = z.infer<typeof settingsSchema>;
   ```
   `Settings` i models.ts förblir domänens sanning. `loadStoredSettings` blir explicit: `StoredSettings` in → `Settings` ut, och den befintliga spread-konstruktionen är just den konverteringen.
3. **Lägg ett äkta typskydd bara där det går att göra rätt** — på unionerna, inte på hela objektet:
   ```ts
   type Assert<T extends true> = T;
   type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

   type _Collision = Assert<Eq<
     z.infer<typeof namingSchema>["collisionPolicy"],
     NamingSettings["collisionPolicy"]
   >>;
   type _SplitMode = Assert<Eq<z.infer<typeof splitSchema>["mode"], SplitMode>>;
   type _DupePolicy = Assert<Eq<z.infer<typeof packsSchema>["freqDupePolicy"], FreqDupePolicy>>;
   type _RxOnly = Assert<Eq<z.infer<typeof packsSchema>["rxOnlyPolicy"], RxOnlyPolicy>>;
   type _SortKeys = Assert<Eq<z.infer<typeof sortSchema>["keys"][number], SortSettings["keys"][number]>>;
   ```
   Detta är kärnan i verklig drift-risk: någon lägger till `"pack_first"` i `SortSettings["keys"]` men glömmer `z.enum`, och sparade inställningar nollställs tyst i produktion. Assertionen fångar exakt det, och den är sann idag.

   Ännu bättre för de fyra unionerna: härled dem från delade `as const`-arrayer (t.ex. `export const COLLISION_POLICIES = ["numeric_suffix","last_char_suffix"] as const`) och låt både models.ts (`(typeof COLLISION_POLICIES)[number]`) och `z.enum(COLLISION_POLICIES)` använda samma konstant. Då blir drift omöjlig och assertionen redundant. Rekommenderas för `collisionPolicy`, `SplitMode`, `FreqDupePolicy`, `RxOnlyPolicy`, `SortSettings["keys"]`.

**Uttryckligen inte i denna ändring**: `satisfies Settings` på slutobjektet (dödar passthrough-spreaden), strikta returtyper på `migrateFilter`/`migrateNaming` (flyttar reset-risk uppströms), och att göra `filterSchema`-fält obligatoriska.

## 5. Typassertion, sanitizer eller runtime-test?

Kombination, med tydliga roller:

- **Typnivå** (`Assert<Eq<…>>` eller delade `as const`-konstanter): för enum-/unionsdrift. Billigt, exakt, fångar rätt fel vid kompilering.
- **Runtime-test**: för det typer inte kan uttrycka — att `DEFAULT_SETTINGS` faktiskt passerar schemat, att legacy-payloads inte nollställs, att okända fält överlever. Detta är den viktigaste delen; `settings.schema.test.ts` har redan grunden.
- **Sanitizers**: behåll som de är. De är avsiktligt löst typade eftersom de arbetar på otrodd data *före* validering.

Att försöka bevisa "schemat ⊇ Settings" på typnivå för hela objektet är inte värt det med passthrough i bilden — det ger antingen falska larm eller en assertion man tvingas urvattna tills den blir meningslös igen (exakt hur den nuvarande uppstod).

## 6. Acceptanstester

Utöka `src/lib/codeplug/__tests__/settings.schema.test.ts` och `src/hooks/__tests__/settingsMigration.test.ts`:

1. `DEFAULT_SETTINGS` passerar `settingsSchema` (finns redan) — plus att `safeParse(DEFAULT_SETTINGS).data` deep-equals input (inga fält tappas).
2. **Okända toppnivåfält överlever hela round-trippen**: skriv `{...DEFAULT_SETTINGS, myFutureFlag: 1}` till localStorage, kör `loadStoredSettings`, förvänta att `myFutureFlag` finns kvar i resultatet.
3. **Okända fält i undersektion**: `filter.someFutureFacet: ["x"]` överlever.
4. **Legacy-payload nollställs inte** — exempel att testa mot:
   ```json
   {
     "filter": {
       "statuses": ["QRV"], "types": ["Repeater"],
       "modeStrategy": "custom", "customModes": ["fm", "System Fusion"],
       "districts": ["6"], "includeUnknownDistricts": true,
       "bands": ["2"], "countries": ["SE"]
     },
     "naming": { "components": ["{city}"], "separator": "_", "cityMaxLength": 6,
       "transliterate": true, "uppercase": true, "collisionPolicy": "stop",
       "abbreviations": { "type": {}, "network": {}, "band": {}, "districtPrefix": "D" } },
     "sort": { "keys": ["district"], "geohashPrecision": 5,
       "home_district_sort": "distance", "home_district_first": false },
     "packs": { "placement": "off", "selection": {}, "freqDupePolicy": "keep_both",
       "rxOnlyPolicy": "mark" },
     "export": { "targetId": "chirp-generic",
       "perTarget": { "chirp-generic": { "maxLength": 8 }, "removed-target": { "x": 1 } },
       "split": { "mode": "single", "chunkSize": 32 } }
   }
   ```
   Förväntat: `collisionPolicy === "numeric_suffix"`, `separator === "_"` bevarat, `filter.modes` innehåller `"FM"` och `"C4FM"`, `includeUnknownRegions === true`, `perTarget["chirp-generic"].maxLength === 8`, `perTarget["removed-target"]` borta, allt annat = defaults.
5. **Ogiltig target-patch** (`perTarget["chirp-generic"] = { maxLength: -1 }`) → ersätts av target-defaults, övriga sektioner orörda.
6. **Okänt `targetId`** → faller till `DEFAULT_SETTINGS.export.targetId`, resten bevarat.
7. **Reload-idempotens**: `load → save → load` ger deep-equal resultat (fångar tysta fältförluster).
8. **Regressionsvakt för drift** (om vi väljer runtime framför typnivå): loopa `COLLISION_POLICIES` / split-modes / dupe-policies och assertera att varje värde passerar respektive delschema.

## Risker och avvägningar

- Att ta bort assertionen utan att ersätta den ger noll skydd — därför är punkt 3 i "minsta säkra fix" inte valfri.
- Delade `as const`-konstanter rör models.ts, som många filer importerar; det är en mekanisk men bred diff. Alternativet (`Assert<Eq<…>>`) är noll-risk men fångar drift först när någon kör typecheck, inte vid författandet.
- Den kvarstående verkliga svagheten är oförändrad efter denna fix: **en saknad toppnivåsektion nollställer hela konfigurationen.** Vill vi laga det är rätt åtgärd per-sektion-validering med fallback till defaults per sektion — en separat, större ändring med egen testomgång.
