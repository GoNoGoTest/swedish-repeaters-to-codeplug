# Flexibel kolumnhantering för SK6BA-importen

Idag kräver `loadSk6baCsv()` att alla 24 poster i `EXPECTED_COLS` finns i rubrikraden. Saknas `masl`, `magl`, `ant`, `backup`, `dir`, `watt_pep` m.fl. avvisas en fullt användbar fil. Ingen av dessa kolumner läses av `normalize()` i pipeline.ts — den rör bara `output, tx_shift, access, mode, type, status, band, district, call, city, channel, network, network_id, id, lat, lng, locator`.

## 1. Vad som verkligen måste vara obligatoriskt

Bara **`output`** är semantiskt nödvändig. Utan RX-frekvens finns ingen kanal — allt annat kan defaultas.

`mode`, `type`, `status` föreslogs som required, men de är egentligen *starkt rekommenderade*, inte nödvändiga:

- `mode` saknas → `expandModes()` ger inga kanaler. Det är ett tomt men korrekt resultat; med fallback "FM" blir filen användbar.
- `status` / `type` saknas → farligare i praktiken, eftersom default-filtret är `statuses: ["QRV"]` och `types: ["Repeater","Link","Hotspot"]`. Alla rader får tom sträng och filtreras bort ⇒ tom förhandsvisning som ser ut som en bugg.

Föreslagen indelning:

| Nivå | Fält | Beteende om det saknas |
| --- | --- | --- |
| Required | `output` | Hard fail med tydligt felmeddelande |
| Recommended | `mode`, `status`, `type`, `tx_shift`, `access`, `band`, `district`, `call`, `city`, `channel` | Laddas ändå, med defaults + diagnostik, och filtret neutraliseras (se punkt 4) |
| Optional | `id`, `network`, `network_id`, `lat`, `lng`, `locator`, `updated`, `masl`, `magl`, `watt_pep`, `dir`, `ant`, `backup` + okända kolumner | Tyst, bevaras som de är |

Motivering: hard-fail bara där vi omöjligt kan gissa. Allt annat blir en synlig varning istället för ett stopp.

## 2. Manuell kolumnmappnings-UI

**Skjut upp.** Den behövs bara när `output` inte kan identifieras ens via alias, vilket blir sällsynt när aliaslistan finns. Ta först alias + diagnostik; lägg till mappnings-UI först om verklig användning visar att det behövs. Felmeddelandet vid hard fail listar då de kolumner filen faktiskt har, så användaren kan döpa om själv.

## 3. Minsta robusta arkitektur

Ny fil `src/lib/codeplug/importers/sk6ba.columns.ts`:

- `COLUMN_CONTRACT`: kanoniskt fältnamn → `{ level: "required" | "recommended" | "optional", aliases: string[] }`.
- `normalizeHeader(h)`: trim, lowercase, `-`/mellanslag → `_`, ta bort omgivande citattecken.
- `resolveColumns(headers)` → `{ map: Record<rawHeader, canonicalKey>, missingRequired, missingRecommended, aliasesApplied, unknownColumns, ambiguous }`.

Ändringar i `sk6ba.ts`:

- `parseSk6baCsv` använder `transformHeader` för normalisering och mappar sedan om raden till kanoniska nycklar. **Okända kolumner behålls** med sitt normaliserade namn, så `RawRow` (redan `Record<string,string>`) är oförändrad som typ.
- `ImportResult` byter ut `missingColumns: string[]` mot `contract: ColumnContractResult` (behåll `missingColumns` som deprecated alias för required-listan så UI/tester inte bryts abrupt).
- `loadSk6baCsv` hard-failar bara när `missingRequired.length > 0`. Övrigt går ut som `ParseWarning[]` (`source: "contract"`) i det befintliga `parseWarnings`-flödet.

Ambiguitet (två headers mappar till samma kanoniska fält): första exakta träffen vinner före alias-träff; annars första kolumnen — och en varning.

Berörda filer: `importers/sk6ba.ts`, ny `importers/sk6ba.columns.ts`, `importers/schemas.ts` (utöka `ParseWarning["source"]`), `components/codeplug/RepeaterLoader.tsx` (visa kontraktsdiagnostik i den befintliga `ParseWarningsPanel`), `routes/index.tsx` (filter-neutralisering, se nedan). Pipeline, exportörer och naming rörs inte.

## 4. Defaults och filter när rekommenderade kolumner saknas

- `mode` saknas → sätt `"FM"` per rad vid normalisering av rådata, plus en varning "mode saknas, antar FM".
- `status` saknas → hoppa över statusfiltret helt (behandla filtret som avstängt), inte "matcha tom sträng". Samma för `type`.
- Konkret: `parseSk6baCsv` returnerar `presentFields: Set<canonicalKey>`; `filterChannels` (eller anroparen i `routes/index.tsx`) hoppar över facetter vars källkolumn saknas.
- `RepeaterFilterPanel` bygger sina val från `summary.uniqueCounts` — dölj facetter utan källkolumn istället för att visa en ensam "(tom)"-post.
- `band` saknas → härleds redan från frekvens av `bands.ts`; ingen åtgärd.
- `district`/`call` saknas → `deriveRegion()` ger "unknown"; region-facetten döljs på samma sätt.
- `lat`/`lng` saknas → avståndsfiltret stängs av (visa förklaring i UI).

## 5. Migration och bakåtkompatibilitet

- Rena SK6BA-exporter fortsätter parsa bit-identiskt: alla kanoniska namn matchar redan exakt, inga alias appliceras, inga varningar.
- Sparade exporter i localStorage lagrar rå CSV-text och parsas om ⇒ inget migrationssteg.
- Sparade filterinställningar kan innehålla statusar som inte finns i en smalare fil; neutraliseringen ovan gör det ofarligt utan att skriva om användarens inställningar.
- `missingColumns` behålls i typen (nu = enbart required) så nuvarande fel-UI och tester fortsätter fungera.

## 6. Testplan

Nya/utökade tester i `src/lib/codeplug/__tests__/importers/`:

1. Fil utan `masl,magl,ant,backup,dir,watt_pep` → `status: "loaded"`, inga varningar av nivå error.
2. Fil utan `output` → `status: "error"`, meddelandet listar filens faktiska kolumner.
3. Alias: `frequency`/`rx_frequency` → `output`, `shift`/`offset` → `tx_shift`, `latitude`/`longitude` → `lat`/`lng`; verifiera att `rows[0].output` finns.
4. Header-normalisering: `"Output "`, `"TX Shift"`, `"District"` mappar rätt.
5. Okänd kolumn `foo` bevaras i `RawRow` och rapporteras som `unknown_column`-varning.
6. Ambiguitet: både `output` och `frequency` finns → exakt matchning vinner + varning.
7. Snapshot: nuvarande `sk6ba-sample.csv` ger identiska `rows` före/efter (regressionsskydd).
8. Filter: fil utan `status`-kolumn ger icke-tom förhandsvisning trots default `statuses: ["QRV"]` (pipeline- eller komponenttest).

## 7. Risker och invändningar mot ursprungsförslaget

- **Att göra `mode`/`type`/`status` required löser fel problem.** Det byter ett falskt "saknad kolumn"-fel mot ett annat. Det verkliga felet är att default-filtret tyst tömmer resultatet — därför är filter-neutraliseringen (punkt 4) den viktigaste delen av den här ändringen, inte kontraktet i sig.
- **Alias kan tolka fel.** `offset` betyder shift-belopp i vissa exporter men riktning i andra. Vi mappar bara namn, aldrig värden; `parseShift()` avgör tolkningen och flaggar `unclear_shift` som förut.
- **Tyst default `mode: "FM"`** kan producera kanaler som inte finns i verkligheten. Mildras av en synlig varning; alternativet (noll kanaler) är sämre.
- **Diagnostikbrus**: en främmande CSV kan generera dussintals `unknown_column`-varningar. Slå ihop dem till en rad ("N okända kolumner: …") i panelen.
- **Scope creep**: manuell mappnings-UI + kontrakt i samma steg fördubblar ytan. Därför uppdelningen ovan.
