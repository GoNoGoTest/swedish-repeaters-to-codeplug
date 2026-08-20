# Issue #8, fas 0 — Obligatorisk exportbekräftelse för RX-only-kanaler

Planläge. Ingen applikationskod ändrad. Denna fas ersätter inte den tidigare
föreslagna TX-kontraktsrefaktorn (tx_inhibited / isTxDisabled) — den kommer efter.

## 1. Är en appbekräftelse en rimlig första fas?

Ja, med en tydlig reservation.

Fördelar: den är billig, ändrar inga exportbytes, och adresserar den enda risk
appen faktiskt kan adressera — att användaren inte vet att TX-spärr är en
radioegenskap, inte en filegenskap. Den är särskilt motiverad för RT Systems,
där formatet inte kan uttrycka RX-only alls.

Invändning som bör respekteras: en modal kan ge *falsk trygghet i motsatt
riktning* — "jag klickade OK, alltså är det hanterat". Motmedel:

- Texten får aldrig påstå att appen spärrar något.
- Modalen ersätter inte fas 1–3 (intern TX-invariant). Den bör beskrivas i
  issuen som "användarupplysning", inte som "säkerhetsåtgärd".
- Ingen "visa inte igen" — bekräftas per exportförsök, enligt önskemål.

## 2. Vilka kanaler triggar? Gemensam predicate

Idag räknas RX-only olika på olika ställen (`rx_only` i `RxOnlyExportNote`,
`rx_only || !tx_allowed` i Nicsure/VGC, plus `duplex === "off"` i VGC/CHIRP).
Inför **en** ren funktion och låt stats, banner och modal använda den:

```ts
// src/lib/codeplug/rxOnly.ts (ny, ren, ingen UI)
export function isRxOnlyChannel(c: NormalizedChannel): boolean {
  return c.rx_only || !c.tx_allowed || c.duplex === "off";
}
export function collectRxOnly(channels: NormalizedChannel[]): NormalizedChannel[];
```

Trigger = `collectRxOnly(exportChannels).length > 0`.

`exportChannels` är rätt källa: den är efter pipeline-policy *och* efter manuella
exkluderingar. Vid `rxOnlyPolicy=skip` finns raderna inte kvar → ingen dialog.

Notera konsekvens av att ta med `duplex === "off"`: en SK6BA-rad som av annan
anledning har duplex off skulle också trigga. Det är i praktiken bara paket-/
policy-satta rader idag, och konservativt fel-åt-rätt-håll. Alternativet är att
utelämna `duplex === "off"` ur predikatet; jag rekommenderar att ta med det men
låta det vara ett enda beslut i en enda funktion.

## 3. Exakt svensk text

Rubrik:

> Bekräfta export med RX-only-kanaler

Brödtext:

> Exporten innehåller {N} kanaler som är avsedda endast för mottagning, till
> exempel flygradio, marin VHF och andra tjänster där sändning kan vara olaglig.
>
> Den här appen skriver bara en fil. Om sändning verkligen blockeras avgörs av
> din radio och av programmet du importerar filen med. Kontrollera i radion att
> PTT är spärrad på dessa kanaler innan du använder dem.

Target-tillägg (se punkt 5) renderas som en egen rad under brödtexten.

Checkbox:

> Jag förstår att jag själv måste verifiera i radion att sändning är spärrad.

Primärknapp: `Exportera ändå`
Avbrytknapp: `Avbryt`

Primärknappen är `disabled` tills checkboxen är ikryssad.

## 4. Antal och exempel

Ja till antal. Ja till exempel, men begränsat och sakligt: visa upp till tre
rader i en kompakt lista (`namn — RX-frekvens MHz`) och `+ N till` när fler
finns. Det gör dialogen konkret och låter användaren känna igen vad det gäller
utan att bli en andra previewtabell.

## 5. Targetskillnaden utan fyra dialoger

En dialog, en variabel textrad som väljs av ett litet map i UI-lagret:

- **rt-systems-yaesu-generic + mark**:
  > RT Systems-formatet kan inte uttrycka RX-only. Raderna skrivs som Simplex
  > med sändningsfrekvens = mottagningsfrekvens, vilket innebär att radion kan
  > sända på dem.
- **chirp-generic / vgc-n76 / nicsure-rt880**:
  > Filen märker kanalerna som spärrade (Duplex=off, tx_dis respektive N/T),
  > men importverktyget och radion kan tolka det annorlunda.

Default (okänt/nytt target): den generiska varianten utan påstående om spärr.
Lägg tilläggstexten som ett fält på targeten först när ett fjärde behov dyker
upp — nu räcker en `switch` i dialogkomponenten.

## 6. Placering, state och tillgänglighet

Ny fil `src/components/codeplug/RxOnlyConfirmDialog.tsx`. Projektet har ingen
shadcn `dialog`/`alert-dialog` i `src/components/ui/` (endast `switch.tsx`), så
komponenten byggs som en liten egen modal — undvik att dra in Radix bara för
detta.

State i `src/routes/index.tsx`:

```text
doExport()
  → pipeline saknas / duplicateStop → return
  → rxOnly = collectRxOnly(exportChannels)
  → rxOnly.length === 0 → runExport()
  → annars setPendingExport(true)   // ingen download ännu

dialog: Avbryt   → setPendingExport(false)
        Bekräfta → setPendingExport(false); runExport()
```

`runExport()` är dagens body i `doExport` (anropar `exportFiles()`).
Checkbox-state lever i dialogkomponenten och nollställs vid varje öppning
(t.ex. via `key={openCount}` eller `useEffect` på `open`).

Tillgänglighet:

- `role="dialog"`, `aria-modal="true"`, `aria-labelledby`/`aria-describedby`.
- Fokus flyttas till rubriken/checkboxen vid öppning; fokus återgår till
  exportknappen vid stängning.
- Escape stänger = avbryt. Klick på overlay stänger = avbryt.
- Enkel fokusfälla (Tab cyklar mellan checkbox, Avbryt, Exportera ändå).
- Bakgrundsscroll låses medan dialogen är öppen.

## 7. Testplan

Enhetstester för predikatet (`src/lib/codeplug/__tests__/rxOnly.test.ts`):

| Fall | Förväntat |
| --- | --- |
| `rx_only=true` | true |
| `tx_allowed=false`, `rx_only=false` | true |
| `duplex="off"` | true |
| vanlig repeater | false |

Komponent-/integrationstester (`src/routes/__tests__` eller
`src/components/codeplug/__tests__/RxOnlyConfirmDialog.test.tsx`, med mockad
download precis som i `useCodeplugDownload.test.tsx`):

1. Ingen RX-only i exporten → klick på Exportera ger exakt en download, ingen dialog.
2. `rxOnlyPolicy=skip` → RX-only-raderna saknas i `exportChannels` → direkt export.
3. RX-only finns → klick ger dialog och **noll** downloads.
4. Avbryt → dialogen stängs, noll downloads.
5. Primärknappen är disabled tills checkboxen kryssas.
6. Checkbox + Exportera ändå → exakt en download.
7. Andra exportförsöket visar dialogen igen med checkboxen urkryssad.
8. Manuellt exkluderad RX-only-rad (via `excludedKeys`) → ingen dialog.
9. `tx_allowed=false` utan `rx_only` → dialog visas.
10. Target = rt-systems-yaesu-generic + mark → dialogen innehåller den skarpare
    texten om Simplex/sändningsbar.
11. Escape stänger utan download; fokus återgår till exportknappen.

Regressionsvakt: inga snapshot-ändringar i `src/lib/codeplug/__tests__/targets/`
— exportbytes ska vara oförändrade i hela denna fas.

## 8. Ska den passiva bannern vara kvar?

Ja, men justerad. Bannern har ett annat jobb: den syns *innan* användaren klickar
och kan påverka policyvalet. Två ändringar:

- Byt dess `c.rx_only || !c.tx_allowed`-check mot den nya `isRxOnlyChannel`, så
  banner, statistik och dialog aldrig räknar olika.
- Låt bannern nämna antalet, så att dialogens siffra inte kommer som en
  överraskning.

`RtSystemsRxOnlySkippedNote` lämnas orörd — den beskriver pre-policy-källan.

## Filscope för implementationen

- ny: `src/lib/codeplug/rxOnly.ts`
- ny: `src/components/codeplug/RxOnlyConfirmDialog.tsx`
- ändrad: `src/routes/index.tsx` (state + `doExport`-grind)
- ändrad: `src/components/codeplug/ExportPanel.tsx` (banner använder predikatet)
- nya tester enligt ovan

Inga ändringar i targets, exporters, pipeline eller settings i denna fas.
