# Korrigerad analys: drift-skyddet i settings.schema.ts

Dina invändningar är i huvudsak korrekta. Nedan är rättelserna, verifierade mot koden.

## 1. `satisfies` — rättelse

Du har rätt, och min tidigare formulering slog ihop två skilda saker:

- **`satisfies` tar aldrig bort runtime-fält.** Det är enbart en typkontroll; objektet som byggs är exakt det spreadarna producerar. Ett `{ ...DEFAULT_SETTINGS, ...data, … } satisfies Settings` skulle bevara okända fält i runtime precis som idag.
- **Det som faktiskt händer är att `satisfies` inte typcheckar.** `data` är `z.infer<typeof settingsSchema>` med passthrough-indexsignatur (`{ [k: string]: unknown }`). Spreadar man in den blir resultattypen inte tilldelningsbar till `Settings` — objektliteral-spread av en indexsignaturtyp gör att TS inte kan garantera att t.ex. `naming` har rätt form, och excess-property-kontrollen mot `Settings` fallerar. Man skulle alltså tvingas till fler `as`, inte färre.

Så: risken med `satisfies` är **kompileringsfriktion som pressar fram omskrivningar**, inte dataförlust i sig. Faran är indirekt — någon "löser" typfelet genom att sluta spreada `data`, och *då* försvinner fälten. Min ursprungliga slutsats (undvik `satisfies` här) står, men av rätt skäl.

## 2. Exakt spårning av okända fält genom `loadStoredSettings`

Verifierat rad för rad. Bilden är mer blandad än jag beskrev:

| Nivå | Mekanism | Bevaras? |
| --- | --- | --- |
| Toppnivå | `...(data as Partial<Settings>)` | **Ja** — kräver `settingsSchema.passthrough()` |
| `filter` | `filter: migrated.filter` | **Ja**, men **inte** tack vare `filterSchema`. `migrateFilter` spreadar `parsedFilter`, dvs. den **råa** JSON:en före validering. Schemats passthrough är irrelevant för det här fältet. |
| `naming` | `{ ...DEFAULT.naming, ...(data.naming) }` | Ja — kräver `namingSchema.passthrough()` |
| `packs` | `{ ...DEFAULT.packs, ...(data.packs) }` | Ja — kräver `packsSchema.passthrough()` |
| `sort` | `{ ...DEFAULT.sort, ...(data.sort) }` | Ja — kräver `sortSchema.passthrough()` |
| `export` (toppnivå i sektionen) | objektet byggs om från `targetId` / `perTarget` / `split` — **`...exportPatch` spreadas aldrig** | **Nej. Okända fält direkt under `export` tappas idag.** `exportSchema.passthrough()` gör här ingen nytta. |
| `export.split` | `{ ...DEFAULT.split, ...(exportPatch.split) }` | Ja — kräver `splitSchema.passthrough()` |
| `export.perTarget`, okänt target-id | `sanitizePerTarget` hoppar över | Nej — **avsiktligt** |
| `export.perTarget[<känt id>]` | `resolveTargetSettings`-mönstret: `defaults + patch` → `t.settingsSchema.safeParse` | Kända fält ja; **okända fält inuti patchen strippas**, eftersom target-scheman (t.ex. `chirpSettingsSchema`) är vanliga `z.object` utan passthrough |

Jag påstod tidigare att passthrough ger round-trip-bevarande generellt. Det stämmer inte: **`export`-sektionen och per-target-patcharna tappar okända fält oavsett passthrough.** Om vi skriver acceptanstester måste de spegla det verkliga beteendet, annars låser vi fast ett påstående som inte gäller.

## 3. Behövs `filterSchema.passthrough()`?

**Inte för migreringen.** Två skäl, båda verifierade:

1. `migrateFilter(parsed?.filter)` läser den råa JSON:en, före `safeParse`. Legacy-fälten når migreringen oberoende av schemat.
2. Slutobjektet tar `filter: migrated.filter`, inte `data.filter`. Schemats `filter`-output används aldrig.

`filterSchema` listar dessutom legacy-fälten explicit (`modeStrategy`, `customModes`, `districts`, `includeUnknownDistricts`), så passthrough behövs inte ens för att släppa igenom dem — de är namngivna.

Passthrough på `filterSchema` har alltså exakt ett kvarvarande syfte: **att en okänd framtida filternyckel inte ska få hela `safeParse` att falla** (nedgraderingsscenario). Det är verkligt men svagt — och `.passthrough()` är gratis, så behåll det. Bara sluta beskriva det som migrationskritiskt.

## 4. "v5-payload" — rättelse

Verifierat: `STORAGE_KEY = "sk6ba-chirp-settings-v6"` är den enda nyckel koden rör, och ingenstans läses en äldre nyckel. Min formulering "en payload från v5-eran" var missvisande.

Det verkliga legacy-scenariot är: **data som skrevs under v6-nyckeln av en äldre version av appen**, dvs. en gammal *form* under aktuell nyckel. Det är precis vad `migrateFilter` och `migrateNaming` finns för. En äldre nyckel (v5 eller tidigare) är permanent oåtkomlig — de användarna fick redan defaults vid nyckelbytet.

Konsekvens för testerna: legacy-fixtures ska skrivas under `sk6ba-chirp-settings-v6`, inte under en påhittad gammal nyckel.

## 5. A vs B

**A har lägre risk och löser hela den konkreta smell:en.** Rekommendation: gör A nu, skippa B.

- **A** = ta bort `_SettingsSchemaCompatible`, lägg smala `Eq`-assertions på de persisterade literal-unionerna, lägg reload-/migrationstester. Noll runtime-ändring, noll ändring i `loadStoredSettings`. Fångar exakt den drift som gör verklig skada: någon utökar en union i models.ts men glömmer `z.enum`, varpå sparade inställningar nollställs tyst i produktion.
- **B** (`StoredSettings` + omtypad `loadStoredSettings`) rör den mest resiliensbärande funktionen i konfigurationsvägen och ger, som du påpekar, ingen ny garanti — bara en trevligare typsignatur. `export type StoredSettings = z.infer<typeof settingsSchema>` som ren dokumentationsalias är ofarligt och får gärna följa med, men refaktorering av casts i `loadStoredSettings` bör vara ett separat, testat steg.

De unioner som ska assertas (samtliga persisteras och har idag duplicerade literaler i models.ts och settings.schema.ts):

- `NamingSettings["collisionPolicy"]` ↔ `namingSchema`
- `SplitMode` ↔ `splitSchema.mode`
- `FreqDupePolicy` ↔ `packsSchema.freqDupePolicy`
- `RxOnlyPolicy` ↔ `packsSchema.rxOnlyPolicy`
- `SortSettings["keys"][number]` ↔ `sortSchema.keys`
- `HomeDistrictSort` ↔ `sortSchema.home_district_sort`

```ts
type Assert<T extends true> = T;
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type _Collision = Assert<Eq<z.infer<typeof namingSchema>["collisionPolicy"],
                            NamingSettings["collisionPolicy"]>>;
```

Alternativet med delade `as const`-arrayer gör drift omöjlig men ger en bred diff i models.ts. Rimlig kompromiss: `Eq`-assertions nu; `as const`-konstanter när nästa union ändå ska ändras.

## Beteende som måste bevaras oförändrat

1. Korrupt JSON eller schemafel ⇒ `DEFAULT_SETTINGS` (inte krasch).
2. `migrateFilter` och `migrateNaming` körs **före** `safeParse`, på rå JSON.
3. `collisionPolicy: "stop"` ⇒ `"numeric_suffix"` utan att övriga sparade fält nollställs.
4. `modeStrategy`/`customModes` ⇒ `modes`; `includeUnknownDistricts` ⇒ `includeUnknownRegions`.
5. Okända fält bevaras på toppnivå och i `filter`, `naming`, `packs`, `sort`, `export.split` — och tappas (som idag) direkt under `export` och inuti per-target-patchar.
6. Okänt `targetId` ⇒ `DEFAULT_SETTINGS.export.targetId`; okänt target-id i `perTarget` droppas; ogiltig target-patch ⇒ target-defaults.
7. Saknad toppnivåsektion ⇒ full reset. Sprött, men ändra det inte här.

## Acceptanstester (justerade)

Under nyckeln `sk6ba-chirp-settings-v6`:

1. `DEFAULT_SETTINGS` passerar schemat och `safeParse().data` deep-equals input.
2. Legacy-payload (`collisionPolicy: "stop"`, `modeStrategy: "custom"`, `customModes: ["fm","System Fusion"]`, `includeUnknownDistricts: true`, `separator: "_"`, `perTarget: { "chirp-generic": { maxLength: 8 }, "removed-target": {…} }`) ⇒ policy migrerad, `separator` bevarat, `modes` innehåller FM och C4FM, `includeUnknownRegions === true`, `maxLength === 8`, `removed-target` borta.
3. Okänt toppnivåfält överlever `load`.
4. Okänt fält i `filter` / `naming` / `sort` / `packs` / `export.split` överlever.
5. **Negativt test som låser fast dagens beteende**: okänt fält direkt under `export` och okänt fält i en per-target-patch försvinner. Dokumenterar avsikten så att ingen "fixar" det oavsiktligt.
6. Reload-idempotens: `load → save → load` deep-equal.
7. Drift-vakt: varje literal i `COLLISION_POLICIES`/split-modes/dupe-/rx-policies passerar respektive delschema (runtime-komplement till `Eq`-assertionerna).
