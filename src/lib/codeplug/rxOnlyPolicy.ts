import type { RxOnlyPolicy, Settings } from "./models";
// Import via targets/index så registret garanterat är fyllt när resolvern
// frågar efter ett targets deklarerade TX-spärr-förmåga.
import { getTarget } from "./targets";

/**
 * Requested vs effektiv RX-only-policy.
 *
 * `settings.packs.rxOnlyPolicy` är användarens *önskade* val och ägs av
 * användaren — den får aldrig skrivas över när man byter exporttarget.
 * Vissa targets kan däremot inte uttrycka alla policyer; för dem härleds en
 * *effektiv* policy som pipelinen och exportrelaterat UI använder.
 *
 * Vilka targets som kan uttrycka "blockera TX" avgörs av targetens egen
 * deklarerade `txInhibit`-capability — inga hårdkodade target-id:n här.
 * RT Systems Yaesu Generic CSV deklarerar `no_tx_inhibit`, därför faller
 * `block_tx` tillbaka på `skip` för det targetet (se projektets memory-regel:
 * hitta inte på RX-only-beteende).
 */
export function targetSupportsRxOnlyPolicy(targetId: string, policy: RxOnlyPolicy): boolean {
  if (policy !== "block_tx") return true;
  const target = getTarget(targetId);
  // Okänt target (t.ex. testdubbel som inte registrerats): var tillåtande —
  // vakten `assertTxIntentSerializable()` fångar ändå ett riktigt fel.
  if (!target) return true;
  return target.txInhibit === "verified_tx_inhibit";
}

/** Effektiv policy för ett target utan att röra det requested värdet. */
export function resolveEffectiveRxOnlyPolicy(
  targetId: string,
  requested: RxOnlyPolicy,
): RxOnlyPolicy {
  return targetSupportsRxOnlyPolicy(targetId, requested) ? requested : "skip";
}

/**
 * Settings-vy där `packs.rxOnlyPolicy` är den effektiva policyn. Returnerar
 * samma objektreferens när inget behöver ändras, så memoisering inte bryts.
 */
export function withEffectiveRxOnlyPolicy(settings: Settings): Settings {
  const effective = resolveEffectiveRxOnlyPolicy(
    settings.export.targetId,
    settings.packs.rxOnlyPolicy,
  );
  if (effective === settings.packs.rxOnlyPolicy) return settings;
  return { ...settings, packs: { ...settings.packs, rxOnlyPolicy: effective } };
}
