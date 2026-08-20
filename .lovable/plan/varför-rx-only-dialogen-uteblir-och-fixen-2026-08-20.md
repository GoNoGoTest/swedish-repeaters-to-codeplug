# Varför RX-only-dialogen uteblir — och fixen

## Diagnos (mätt i din session)

Sparade inställningar i din webbläsare:

- `export.targetId = "rt-systems-yaesu-generic"`
- `packs.rxOnlyPolicy = "skip"`

Med `skip` tar pipelinen bort alla RX-only-rader (airband, marin VHF, CB27, 69 MHz, jakt m.fl.) innan exporten. Filen innehåller då noll RX-only-kanaler, och dialogen ska enligt fas 0 inte visas. Koden gör rätt — det *sparade värdet* är skadat av den gamla buggen, som skrev över ditt val med `skip` så länge RT Systems var valt.

Appens default är redan `block_tx` ("Spärra TX i radion"); problemet är bara att den gamla, överskrivna inställningen ligger kvar i localStorage.

## Åtgärd: rensa gamla sparade inställningar

Eftersom det är okej att användare får ange sina inställningar igen:

1. Höj lagringsnyckeln i `src/hooks/useCodeplugSettings.ts` från `sk6ba-chirp-settings-v6` till `sk6ba-chirp-settings-v7`. Ingen läsning av `v6` — gammal data ignoreras helt och alla startar på `DEFAULT_SETTINGS`.
2. Ta bort den nu döda `v6`-nyckeln ur localStorage vid första laddningen av `v7`, så att skräpet inte ligger kvar för alltid.
3. Inga ändringar i defaults behövs: `packs.rxOnlyPolicy` är redan `block_tx` och `export.targetId` redan `chirp-generic`.

Effekt: efter omladdning står RX-only-valet på "Spärra TX i radion". På CHIRP/VGC/Nicsure hamnar RX-only-kanalerna i exporten med spärrad TX → bekräftelsedialogen visas igen. Väljer du RT Systems blir den *effektiva* policyn fortfarande `skip` (gula notisen), men ditt sparade val förblir `block_tx`.

## Test

- Ny nyckel: inget sparat → `DEFAULT_SETTINGS` med `rxOnlyPolicy: "block_tx"`.
- Gammal `v6`-data i localStorage ignoreras och nyckeln städas bort; `v7` skrivs vid första sparningen.
- Befintliga persistens- och migreringstester körs mot `v7`-nyckeln utan beteendeändring i övrigt.
- Full `bun run verify`.

## Not

De befintliga migreringarna (legacy `collisionPolicy: "stop"`, `includeUnknownDistricts`, `modeStrategy`) blir därmed bara relevanta för framtida `v7`-data. Jag behåller dem — de är testade och kostar inget.
