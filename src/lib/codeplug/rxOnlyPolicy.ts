import type { RxOnlyPolicy, Settings } from "./models";

/**
 * Requested vs effektiv RX-only-policy.
 *
 * `settings.packs.rxOnlyPolicy` är användarens *önskade* val och ägs av
 * användaren — den får aldrig skrivas över när man byter exporttarget.
 * Vissa targets kan däremot inte uttrycka alla policyer; för dem härleds en
 * *effektiv* policy som pipelinen och exportrelaterat UI använder.
 *
 * RT Systems Yaesu Generic CSV saknar ett dokumenterat sätt att uttrycka
 * "blockera TX", därför faller `block_tx` tillbaka på `skip` för det targetet
 * (se projektets memory-regel: hitta inte på RX-only-beteende).
 */
export function targetSupportsRxOnlyPolicy(targetId: string, policy: RxOnlyPolicy): boolean {
  if (targetId === "rt-systems-yaesu-generic") return policy !== "block_tx";
  return true;
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
