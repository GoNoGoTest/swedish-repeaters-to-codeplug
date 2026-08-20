# Varför RX-only-dialogen uteblir

## Vad jag mätte i din session

I din webbläsares sparade inställningar står nu:

- `export.targetId = "rt-systems-yaesu-generic"`
- `packs.rxOnlyPolicy = "skip"`

Med `skip` tar pipelinen bort alla RX-only-rader (airband, marin VHF, CB27, 69 MHz, jakt m.fl.) innan exporten. Exportfilen innehåller alltså noll RX-only-kanaler, och då ska bekräftelsedialogen enligt fas 0-specifikationen inte visas. Koden gör alltså rätt — det är det sparade *värdet* som är fel.

Värdet kommer från den gamla buggen: så länge RT Systems var valt skrev appen över ditt gemensamma val (`block_tx`) med `skip` och persisterade det i localStorage. Dagens fix stoppar framtida överskrivningar, men rensar inte den redan skadade sparade inställningen.

## Förslag: engångsreparation av skadat sparat värde

Avgränsad migrering i `src/hooks/useCodeplugSettings.ts`:

1. Höj lagringsnyckeln till `sk6ba-chirp-settings-v7` och läs `v6` som fallback en gång.
2. Vid migrering från `v6`: om `packs.rxOnlyPolicy === "skip"` **och** `export.targetId === "rt-systems-yaesu-generic"`, återställ `packs.rxOnlyPolicy` till default (`block_tx`). Kombinationen är signaturen för den gamla automutationen; ett medvetet `skip` på något annat target rörs inte.
3. Allt annat migreras oförändrat genom den befintliga sektionsvisa laddaren.
4. Skriv tillbaka under `v7` och lämna `v6` orörd (ingen destruktiv rensning).

Effekt för dig: efter en omladdning står valet åter på "Spärra TX i radion", RT Systems visar fortfarande effektiv `skip` med sin gula notis, och byte till CHIRP/VGC/Nicsure ger `block_tx` — då dyker RX-only-dialogen upp igen vid export.

## Risker och avvägning

- En användare som medvetet valde `skip` medan RT Systems var aktivt får sitt val ändrat en gång. Det går inte att skilja från buggens spår i sparad data. Alternativet — att inte migrera — låter buggens värde leva kvar tyst hos alla befintliga användare, vilket bedöms som sämre.
- Ingen ändring av exportlogik, targets eller dialogens villkor.

## Test

- Migrering: `v6` med `{skip, rt-systems}` → `block_tx`; `v6` med `{skip, chirp-generic}` → oförändrat `skip`; `v6` med `{mark, rt-systems}` → oförändrat `mark`.
- Ingen `v6`-data → defaults, ingen krasch.
- Efter migrering: `v7` skrivs, laddas vid nästa start.

## Om du hellre vill undvika migreringen

Ändra "RX-only-kanaler" tillbaka till "Spärra TX i radion" i exportpanelen (välj t.ex. CHIRP Generic tillfälligt om valet är dolt under RT Systems). Då sparas rätt värde och dialogen kommer tillbaka — utan kodändring.
