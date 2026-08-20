# Issue #8 — Säker TX-härledning för RX-only-kanaler (analys + plan)

Analys på commit d41f114. Ingen kod ändrad.

## 1. Är deriveTxMhz-beteendet ett faktiskt fel idag?

Nej — i dagens stödda flöden är det en **kontraktsrisk, inte en aktiv bugg**.

Verifierat i koden:

- `deriveTxMhz()` (`exporters/shared/frequency.ts`) returnerar explicit `tx_frequency`
  först och tittar aldrig på `duplex`, inte heller på `rx_only`/`tx_allowed`.
- Alla inbyggda RX-only-paketrader har tom `tx_frequency`, så grenen nås inte.
- Nicsure har redan en egen förgren före `deriveTxMhz` (`mobileTxMhz`:
  `if (c.rx_only || !c.tx_allowed) return c.rx_frequency`).
- VGC läser källflaggorna direkt i `tx_dis`
  (`c.duplex === "off" || c.rx_only || !c.tx_allowed ? "1" : "0"`).
- CHIRP spärrar via `duplex === "off"`.

Den enda vägen till en sändningsbar rad är en syntetisk/framtida källa med
`duplex="off"` **och** explicit `tx_frequency`. Den kombinationen är i sig ett
ogiltigt tillstånd i modellen (samma invariant som noterades i #5-analysen).

Din slutsats håller alltså. Men två saker i din beskrivning bör skärpas:

- RT Systems läser **inte** `rx_only`/`tx_allowed` alls; kommentaren i
  `exportRtSystemsYaesuCsv` säger uttryckligen att block_tx inte exponeras.
  Warningkoden `rt_rx_only_excluded` finns i `models.ts` men används ingenstans
  — död kod som antyder ett tidigare, borttaget beteende.
- Policysemantiken är inkonsekvent mellan targets: för VGC och Nicsure är
  `mark` och `block_tx` funktionellt identiska (källflaggorna spärrar ändå),
  medan CHIRP bara spärrar för att paketdatan råkar ha `duplex="off"`.

## 2. Vilken semantik bör skip / mark / block_tx ha?

Definiera policyn som **vad användaren vill att exporten ska uttrycka**, inte
som en per-target-implementation:

- **skip** — kanalen exporteras inte alls. Enda garanterat säkra läget i format
  som inte kan uttrycka RX-only.
- **mark** — kanalen exporteras med målformatets *bästa* RX-only-uttryck och
  markeras för användaren (kommentar + varning). Detta är alltså inte "exportera
  som vanlig sändbar frekvens": nuvarande acceptanskriterium i issuen krockar
  bara med en felaktig tolkning av mark. Rätt formulering: mark får aldrig
  *aktivt* skriva en sändbar TX-frekvens som avviker från RX.
- **block_tx** — kanalen exporteras och målformatet MÅSTE spärra TX på ett sätt
  som radion respekterar. Om formatet inte kan det får policyn inte vara valbar
  (target deklarerar det, som RT Systems gör idag).

Skillnaden mark/block_tx blir därmed medvetet liten i format som ändå spärrar
(VGC, Nicsure); det är korrekt och bör dokumenteras snarare än "fixas".

## 3. Arkitektur: härlett tillstånd + gemensam helper

Tre lager ska hållas isär:

```text
källmetadata      rx_only, tx_allowed        (ChannelPackMeta, oförändrad)
användarpolicy    settings.packs.rxOnlyPolicy
härlett tillstånd tx_inhibited: boolean      (sätts av pipeline efter policy)
serialisering     per target: off / tx_dis=1 / N/T / Simplex+RX
```

Rekommendation (minsta säkra ändring, inte stor refaktor):

1. Lägg till ett härlett fält `tx_inhibited: boolean` på `NormalizedChannel`
   (default `false`), satt i `applyRxOnlyPolicy` för `block_tx` och `mark`
   (mark = true också, eftersom mark inte får skriva avvikande TX).
2. Lägg en delad helper `isTxDisabled(c)` i
   `exporters/shared/frequency.ts` (eller ny `txState.ts`) som är
   `c.tx_inhibited || c.rx_only || !c.tx_allowed || c.duplex === "off"`.
   Källflaggorna behålls i uttrycket som defensivt skydd för framtida källor.
3. Gör `deriveTxMhz()` säker: returnera `rx_frequency` när `isTxDisabled(c)`
   är sant, **innan** explicit `tx_frequency` läses. Det är den faktiska
   fixen i issue #8 och tar bort behovet av Nicsures lokala specialgren.
4. Låt varje target fortsätta äga sin serialisering, men uttrycka den via
   `isTxDisabled()` i stället för ad-hoc-uttryck.

Inget nytt tillstånd hamnar i persistens (NormalizedChannel sparas inte).

## 4. RT Systems Yaesu

Formatet kan inte uttrycka RX-only (Offset Direction=Simplex + TX=RX är
sändningsbart). Rätt hantering:

- Behåll att `block_tx` inte är valbar (`supportsRxOnlyPolicy` i
  `useActiveExportTarget`), men **rendera detta som ett tydligt UI-meddelande**
  i stället för en tyst fallback till skip.
- `mark` förblir tillåtet men ska ge en target-varning
  (`rt_rx_only_marked`) om att radion kan sända på kanalen.
- Aktivera den redan definierade men oanvända `rt_rx_only_excluded` bara om vi
  väljer att auto-skippa; annars ta bort den döda koden.
- Följ projektregeln: nya targets ska blockera RX-only-export med varning tills
  beteendet är verifierat mot referensexport.

## 5. Implementeringsplan (regressionssäker)

Ordning, en fas per commit:

1. **Helper + modellfält.** `tx_inhibited` i `models.ts`, sätts i
   `pipeline.applyRxOnlyPolicy`; `isTxDisabled()` i shared. Inga
   exportörsändringar → alla snapshots byte-identiska.
2. **Säker deriveTxMhz.** Lägg till `isTxDisabled`-grenen. Ta bort Nicsures
   duplicerade gren i `mobileTxMhz`. Snapshots ska förbli byte-identiska.
3. **Targets via helper.** VGC `tx_dis` och CHIRP `duplex="off"` uttrycks via
   `isTxDisabled()`. Byte-identiska snapshots.
4. **RT Systems.** Ny varning vid mark + RX-only, UI-text vid otillåten
   block_tx. Snapshot uppdateras endast för warnings, inte CSV-bytes.
5. **Dokumentation.** Kort semantiktabell för skip/mark/block_tx i
   `src/routes/README.md` eller target-docs.

### Testmatris

| Fall | Indata | Förväntat |
| --- | --- | --- |
| Inbyggd RX-only, skip | rx_only, tom tx | rad saknas i alla targets |
| Inbyggd RX-only, mark | rx_only, tom tx | CHIRP off, VGC tx_dis=1, Nicsure TX=RX+N/T, RT mark-varning; **byte-identisk CSV mot idag** |
| Inbyggd RX-only, block_tx | rx_only, tom tx | som mark, annan warning; RT ej valbar |
| Syntetisk: duplex=off + explicit tx | rx_only, tx=145.000 | `deriveTxMhz` → RX; VGC skriver RX (inte 145.000) + tx_dis=1; Nicsure TX=RX; CHIRP off |
| Syntetisk: tx_allowed=false, duplex="+" | offset 0.6 | TX speglar RX i alla targets |
| Normal repeater | tx_allowed=true | oförändrad TX-härledning (regressionsvakt) |
| Split-pack utan tx_frequency | duplex=split | oförändrat: degraderas till simplex |
| RT Systems + block_tx vald i settings | — | UI visar orsak, exporten kör skip |

Acceptanskriterium omformulerat: *ingen kanal med `rx_only`/`tx_allowed=false`
får någonsin exporteras med en TX-frekvens som skiljer sig från RX, och i
format som kan uttrycka TX-spärr ska spärren alltid sättas.*

## Rekommendation

Genomför fas 1–3 nu (liten, snapshot-neutral, tar bort kontraktsrisken innan
IC-705). Fas 4–5 kan tas separat eftersom de rör UI-text och varningar.
