# Issue #5: Stegvis domänmodellrefaktor av NormalizedChannel — analys

Read-only granskning av nuvarande kod. Ingen kod ändrad.

## 1. Var skapas NormalizedChannel?

Endast fyra ställen konstruerar en hel kanal från grunden:

| Plats | Typ | Kommentar |
|---|---|---|
| `src/lib/codeplug/pipeline.ts` → `normalize()` | produktion | SK6BA-rader. Bygger objektliteral + `emptyPackFields()` + `emptyAccessFields()`, avslutas med `satisfies NormalizedChannel` |
| `src/lib/codeplug/importers/channel_pack.ts` → `parseChannelPackCsv()` | produktion | Pack-rader, `ParsedPackChannel extends NormalizedChannel` med extra `enabled_default` |
| `src/components/codeplug/NamingEditor.tsx` → `makeExampleChannel()` | produktion (UI-förhandsvisning) | Egen full literal — tredje kopian av "alla fält med defaults" |
| `src/lib/codeplug/__tests__/helpers.ts` → `makeChannel()` + varianter | test | Fjärde kopian |

Derivat skapas via spread i: `expandModes`, `applyRxOnlyPolicy`, pack-split-degradering, `applyModeAccessSubset`, `applyPostExpansionAccessWarnings`, `applyFreqDedupe`, namngivning och `resolveCollisions`.

**Mutation:** en sökning efter fältassignment (`x.duplex =`, `.warnings =`, …) i `src/` utanför tester ger noll träffar. Pipelinen är redan helt kopierande/ren. Det finns alltså ingen mutationsdisciplin kvar att vinna — den vinsten är redan hemtagen.

## 2. Vilka konsumenter behöver hela typen?

Smala konsumenter (läser en handfull fält, skulle idag kunna ta ett delinterface):

- `filters.ts`: `status`, `type`, `band`, `region` → `ChannelMode & Pick<ChannelLocation,…>`
- `dedupe.ts`: `rx_frequency`, `source_type`, `warnings`
- `sorting.ts`: `region`/`district`, `type`, `city`, `rx_frequency`, `lat`/`lng`
- `targets/split.ts`: `region`, `pack_id`, `band`, `source_type`
- `exporters/shared/frequency.ts`: tar redan `ChannelFrequency` — enda stället där delinterfacen faktiskt används
- `exporters/shared/modeMap.ts`: tar redan `ChannelMode & Pick<ChannelPackMeta,"mode_pack"> & {source_type}`
- `modes.ts` (`effectiveModeOf`): strukturell minitype
- `PreviewTable`, `ExportPanel`, `routes/index.tsx`: läsande, breda men bara läsning

Breda konsumenter som realistiskt behöver hela kanalen: `naming.buildName` (token-resolver kan slå upp nästan vilket fält som helst), samt de fyra exporttargeten och `ExportTarget`-kontraktet (`validate`/`export`/`exportMany`/`previewMode`).

Slutsats: delinterface-parametrisering hjälper 4–5 filer och rör inte exportkontraktet. Det är en liten, äkta men begränsad vinst.

## 3. Faktiskt nåbara ogiltiga kombinationer

Dessa är verifierade i koden, inte bara typmässigt representerbara:

1. **`is_analog_fm` speglar `mode_raw`, inte `mode_effective`.** `normalize()` sätter `is_analog_fm: /\bFM\b/i.test(mode_raw)`. En SK6BA-rad `"FM / C4FM"` expanderas till två kanaler där *båda* har `is_analog_fm === true`, inklusive C4FM-kanalen. Idag räddas exporten av att VGC och Nicsure droppar digitala SK6BA-rader före `encodeBandwidth`, och att CHIRP inte läser flaggan. Fältet är alltså både felaktigt och nästan oanvänt — en fälla för nästa target (IC-705).
2. **`duplex: "off"` kan samexistera med `tx_frequency != null`.** RX-only-policyn `block_tx` sätter `duplex: "off"` men rör inte `tx_frequency`. Delade `deriveTxMhz()` returnerar `tx_frequency` först av allt och struntar i `"off"` — den skulle alltså räkna fram en TX-frekvens för en spärrad kanal. Nuvarande target räddas av egna för-kontroller (`nicsure` kollar `rx_only` först, `vgc` sätter `tx_dis`, `chirp` hanterar `"off"` explicit). Detta är den mest konkreta reella buggrisken idag.
3. **`duplex: "+"/"-"` med `tx_shift === null` och `offset === 0`** ger tyst simplex-TX i `deriveTxMhz` utan varning.
4. **`ParsedPackChannel.enabled_default` följer med** genom hela pipelinen som en extra runtime-property på objekt typade som `NormalizedChannel`. Harmlöst idag, men bryter antagandet "runtime-shape == typen".
5. Motsatt: kombinationer som **inte** längre är nåbara — analog tone på digital kanal och digital access på analog kanal — hindras av `applyModeAccessSubset` som körs på *hela* det kombinerade settet efter placement. Den invarianten är i praktiken redan enforcerad, men bara en gång, sent, och utan testat skydd mot att en ny pipeline-stage körs efter den.

## 4. Persistens

`NormalizedChannel` persisteras inte någonstans. localStorage innehåller bara:

- `sk6ba:exports:v1` → färdig CSV-text (`saved-exports.ts`, zod-validerad)
- inställningsnyckeln i `useCodeplugSettings.ts` → `Settings`, inklusive pack-selektion som listor av `source_id`

En modellrefaktor kräver därför **ingen datamigrering**. Det tar bort ett vanligt argument mot en union — men tar också bort brådskan.

## 5. Vad en stor discriminated union skulle kunna sabba

- **Placement/kombination:** `combined = [...packValidated, ...sk6baSorted]` blir en unionslista; varje stage efter den (`applyModeAccessSubset`, dedupe, namngivning, sortering) måste narrow:a eller acceptera unionen. Nettoresultatet blir troligen `NormalizedChannel = Sk6baChannel | PackChannel` som ändå läses ostrukturerat överallt.
- **Exporterna:** alla fyra target läser fritt mellan "pack-fält" och "sk6ba-fält" på samma objekt (`mode_pack` på SK6BA-rader är `""`, `rx_only` på SK6BA-rader är `false`). Med en union måste varje läsning av `c.mode_pack`, `c.rx_only`, `c.tx_allowed`, `c.pack_id` gate:as. Det är ~40 träffar och byte-identiska snapshots står på spel.
- **En access-union** (analog | dmr | c4fm | …) krockar direkt med `applyModeAccessSubset`, som bygger på att alla fält finns och nollas. Den skulle behöva bytas mot en konstruktor — större ändring än den ser ut.
- `Partial<NormalizedChannel>` i `NamingEditor` och testhelpers slutar fungera rakt av.

## 6. Kritik av din rekommendation

**För:**
- Punkt 1–2 (ingen stor omskrivning, behåll platt runtime + exportkontrakt) är rätt: nyttan är låg och risken hög, och ingen datamigrering tvingar fram det.
- Punkt 4 (karakteriseringstester före union) är precis rätt ordning.
- Delinterfacen finns redan och används i `shared/frequency.ts` och `shared/modeMap.ts` — mönstret är bevisat.

**Emot / justeringar:**
- "Centralisera konstruktion" motiveras i din formulering med mutations-/invariantdisciplin. Men pipelinen muterar redan inget. Den verkliga vinsten är i stället **tre duplicerade fältdefaults** (pipeline, NamingEditor, testhelpers) som glider isär när ett fält läggs till — vilket är exakt vad som händer när IC-705 kommer.
- "Smalare parametertyper där det minskar koppling" är kosmetiskt för `filters`/`sorting`/`dedupe`. Det ändrar ingen bugg. Prioritera det lågt.
- Din punkt 5 antyder att en union blir aktuell om ogiltiga tillstånd hittas. De två som hittats (`is_analog_fm`, `duplex "off"` + `tx_frequency`) löses båda av härledning/normalisering — inte av en union. Det är ett argument för att unionen kan skjutas upp *permanent*, inte bara "senare".

## 7. Minsta säkra första ändring

Tre små steg, i ordning. Inga exportbytes ändras.

**Steg A — en enda kanalkonstruktor**
- Ny `src/lib/codeplug/channelFactory.ts` med `makeEmptyChannel(): NormalizedChannel` (alla fältdefaults på ett ställe) och `createChannel(over: Partial<NormalizedChannel>)`.
- `pipeline.normalize()` och `channel_pack.parseChannelPackCsv()` byggs ovanpå den; `emptyPackFields`/`emptyAccessFields` ersätts.
- `NamingEditor.makeExampleChannel` och testhelpern `makeChannel` använder samma bas.
- Krav: byte-identiska snapshots i `targets/__snapshots__/snapshot-mixed-modes.test.ts.snap`.

**Steg B — härled `is_analog_fm` från effektiv mode**
- Flytta beräkningen till expansionssteget (eller gör den till en helper `isAnalogFm(c)` byggd på `classifyChannel`) så att en C4FM-expanderad rad inte längre påstår sig vara analog FM.
- Kontrollera VGC `encodeBandwidth` för regression.

**Steg C — invariantvakt i pipelinen (utvecklingsläge)**
- `assertChannelInvariants(c)` som verifierar de faktiskt uppnåbara reglerna: `duplex === "off"` ⇒ ingen TX härleds; digital mode ⇒ ingen analog access; analog mode ⇒ inga digitala fält; `mode_effective` satt för SK6BA-rader efter expansion.
- Körs i test (och ev. bakom `import.meta.env.DEV`), aldrig som runtime-throw i produktion.
- Kompletteras med att `deriveTxMhz` respekterar `duplex === "off"` — antingen där, eller genom att `block_tx` nollställer `tx_frequency`. Detta bör beslutas explicit; det är en beteendeändring för nästa target.

**Berörda filer:** `src/lib/codeplug/channelFactory.ts` (ny), `pipeline.ts`, `importers/channel_pack.ts`, `accessModes.ts` (ev. `isAnalogFm`), `exporters/shared/frequency.ts` (steg C), `src/components/codeplug/NamingEditor.tsx`, `src/lib/codeplug/__tests__/helpers.ts`.

**Testplan:**
1. Karakterisering: befintliga target-snapshots måste vara byte-identiska före/efter steg A.
2. Nytt: `channelFactory.test.ts` — factory ger samma fältuppsättning som dagens literal (nyckeljämförelse mot en fryst fältlista).
3. Nytt: `pipeline.invariants.test.ts` — kör hela fixture-flödet (SK6BA + 2m-pack, alla rxOnlyPolicy-lägen, mode-expansion FM/C4FM/DMR) och kör `assertChannelInvariants` på varje utgångskanal.
4. Nytt: regression för `is_analog_fm` på `"FM / C4FM"`-expansion.
5. Nytt: `duplex === "off"` + `tx_frequency` → TX-härledningen ger inte en TX-frekvens.

## 8. Slutligt råd

Din rekommendation är i huvudsak rätt, med en omprioritering: **gör inte unionen — nu eller senare — utan bevis, men flytta "centralisera konstruktion" från motivet "invariantkontroll" till motivet "en enda källa för fältdefaults", och lägg smalare parametertyper sist eftersom de inte löser något problem som faktiskt finns.** De två reella defekterna (`is_analog_fm` mot fel modefält, samt `duplex: "off"` med kvarvarande `tx_frequency`) är normaliseringsbuggar och ska fixas som sådana innan IC-705 påbörjas — en discriminated union hade inte fångat någon av dem.
