import type { NormalizedChannel, RxOnlyPolicy, TxIntent } from "./models";

export type { TxIntent } from "./models";

/**
 * Targetens deklarerade förmåga att uttrycka en *verifierad* TX-spärr i
 * sitt filformat.
 *
 * - `verified_tx_inhibit`: formatet har en dokumenterad spärr-representation
 *   (CHIRP `Duplex=off`, VGC `tx_dis=1`, Nicsure `TX_Power=N/T` + `TX=RX`).
 * - `no_tx_inhibit`: formatet saknar dokumenterat sätt att spärra TX
 *   (RT Systems Yaesu Generic CSV). Ett sådant target får ALDRIG serialisera
 *   en kanal vars intent är `must_block_tx`.
 */
export type TxInhibitCapability = "verified_tx_inhibit" | "no_tx_inhibit";

/**
 * Källflaggor som uttrycker "den här kanalen är avsedd endast för
 * mottagning", oberoende av det härledda intentet. Används av
 * `deriveTxIntent` (som annars skulle bli cirkulär) och av
 * `isRxOnlyChannel`.
 */
export function hasRxOnlySourceFlags(c: NormalizedChannel): boolean {
  return c.rx_only || !c.tx_allowed || c.duplex === "off";
}

/**
 * Enda stället där sändningsavsikten härleds. Körs i pipelinen med den
 * *effektiva* RX-only-policyn (se rxOnlyPolicy.ts) — exporters ska läsa
 * `c.tx_intent`, aldrig gissa själva.
 *
 * - vanlig kanal → `normal`
 * - RX-only + `mark` → `best_effort_rx_only`
 * - RX-only + `block_tx` → `must_block_tx`
 * - RX-only + `skip` → raderna är redan borttagna av pipelinen; skulle en
 *   sådan rad ändå nå hit behandlas den som `best_effort_rx_only`.
 */
export function deriveTxIntent(c: NormalizedChannel, policy: RxOnlyPolicy): TxIntent {
  if (!hasRxOnlySourceFlags(c)) return "normal";
  return policy === "block_tx" ? "must_block_tx" : "best_effort_rx_only";
}

/** Ren map-pass: sätter `tx_intent` på varje kanal. */
export function applyTxIntent(
  channels: NormalizedChannel[],
  policy: RxOnlyPolicy,
): NormalizedChannel[] {
  return channels.map((c) => {
    const intent = deriveTxIntent(c, policy);
    return c.tx_intent === intent ? c : { ...c, tx_intent: intent };
  });
}

/** True när targetens serializer måste skriva sin TX-spärr-representation. */
export function isTxDisabled(c: NormalizedChannel): boolean {
  return c.tx_intent === "must_block_tx" || hasRxOnlySourceFlags(c);
}

/** Kastas av den defensiva vakten. Fångas inte av normalflödet. */
export class TxIntentCapabilityError extends Error {
  readonly code = "tx_intent_capability";
  constructor(
    readonly targetId: string,
    readonly channelNames: string[],
  ) {
    super(
      `Exportmålet "${targetId}" kan inte garantera TX-spärr (no_tx_inhibit) men fick ` +
        `${channelNames.length} kanal(er) med tx_intent=must_block_tx: ${channelNames.join(", ")}. ` +
        `Exporten avbröts i stället för att skriva en sändningsbar rad.`,
    );
    this.name = "TxIntentCapabilityError";
  }
}

/**
 * Defensiv hård vakt. Anropas av varje targets export-väg. För
 * `verified_tx_inhibit` är den en no-op; för `no_tx_inhibit` kastar den om
 * någon kanal bär `must_block_tx`. I normalflödet kan det inte inträffa —
 * `resolveEffectiveRxOnlyPolicy()` degraderar `block_tx` till `skip` för
 * sådana targets — så vakten träffar bara programmeringsfel.
 */
export function assertTxIntentSerializable(
  channels: NormalizedChannel[],
  capability: TxInhibitCapability,
  targetId: string,
): void {
  if (capability === "verified_tx_inhibit") return;
  const offenders = channels.filter((c) => c.tx_intent === "must_block_tx");
  if (offenders.length === 0) return;
  throw new TxIntentCapabilityError(
    targetId,
    offenders.slice(0, 5).map((c) => c.generated_name_final || c.call || "(namnlös)"),
  );
}
