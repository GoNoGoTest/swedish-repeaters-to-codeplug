import { useMemo } from "react";
import type {
  ChirpSettings,
  NormalizedChannel,
  RxOnlyPolicy,
  Settings,
  Warning,
} from "@/lib/codeplug/models";
import { assertNever } from "@/lib/codeplug/assertNever";
import { type AnyExportTarget, requireTarget, resolveTargetSettings } from "@/lib/codeplug/targets";
import type { ExportTarget } from "@/lib/codeplug/targets/types";

/**
 * Bundle med target-relaterade deriveringar som tidigare låg utspridda i
 * `routes/index.tsx` som fyra närmast identiska `switch (target.id)`-block.
 *
 * Hookan gör narrowing exakt en gång — externa konsumenter får färdiga
 * värden och stabila closures utan att behöva känna till target-listan.
 *
 * Nya targets läggs till genom att utöka `switch`en nedan; `assertNever`
 * tvingar fram uppdateringen vid kompilering.
 */
export interface ActiveExportTargetBundle {
  /** Aktivt target (diskriminerad union — narrowa via `target.id` om du måste). */
  target: AnyExportTarget;
  /** Opaque user-patch från `settings.export.perTarget[id]`. */
  storedPatch: Record<string, unknown> | undefined;
  /** Effektiv max-namnlängd (target.resolveMaxNameLength ?? limits.maxNameLength). */
  maxNameLength: number;
  /** Stabil preview-mode-funktion: returnerar exportmodets visningstoken. */
  previewMode: (c: NormalizedChannel) => string;
  /** Stabil target-validator (returnerar tom array om target saknar validate). */
  validate: (channels: NormalizedChannel[]) => Warning[];
  /**
   * Loc-startposition för previewn. CHIRP läser `startLocation` ur sina
   * settings; övriga targets börjar alltid på 1.
   */
  previewStartLocation: number;
  /**
   * Targetspecifik RX-only-policy-kompatibilitet. RT-Systems Yaesu kan inte
   * uttrycka "blockera TX" på en RX-only kanal i sin Generic CSV; UI:t
   * faller tillbaka på "skip" när policyn väljs.
   */
  supportsRxOnlyPolicy: (p: RxOnlyPolicy) => boolean;
  /**
   * Bakåtkompatibel ChirpSettings-vy: när aktivt target är `chirp-generic`
   * returneras de resolvade settings; annars säkra defaults. Behövs av
   * `ExportPanel` som idag tar `chirpSettings` som prop oavsett target.
   */
  chirpSettings: ChirpSettings;
}

const CHIRP_FALLBACK: ChirpSettings = {
  startLocation: 1,
  mode: "NFM",
  tStep: 5.0,
  skipLinks: false,
  maxLength: 6,
};

const supportsRxOnlyPolicyAll = (p: RxOnlyPolicy): boolean =>
  targetSupportsRxOnlyPolicy("chirp-generic", p);
const supportsRxOnlyPolicyRtSystems = (p: RxOnlyPolicy): boolean =>
  targetSupportsRxOnlyPolicy("rt-systems-yaesu-generic", p);

/**
 * Generisk bundle-byggare: tar ett narrowat `ExportTarget<T>` + dess
 * resolvade settings och binder previewMode/validate/maxNameLength med
 * exakt rätt typ — inga `as`-casts.
 */
function bindTarget<T>(
  target: ExportTarget<T>,
  resolved: T,
): {
  previewMode: (c: NormalizedChannel) => string;
  validate: (channels: NormalizedChannel[]) => Warning[];
  maxNameLength: number;
} {
  return {
    previewMode: (c) => target.previewMode?.(c, resolved) ?? "—",
    validate: (channels) => target.validate?.(channels, resolved) ?? [],
    maxNameLength: target.resolveMaxNameLength?.(resolved) ?? target.limits.maxNameLength,
  };
}

export function useActiveExportTarget(settings: Settings): ActiveExportTargetBundle {
  const target = useMemo(() => requireTarget(settings.export.targetId), [settings.export.targetId]);
  const storedPatch = settings.export.perTarget[settings.export.targetId] as
    | Record<string, unknown>
    | undefined;

  return useMemo<ActiveExportTargetBundle>(() => {
    switch (target.id) {
      case "chirp-generic": {
        const s = resolveTargetSettings(target, storedPatch);
        const bound = bindTarget(target, s);
        return {
          target,
          storedPatch,
          ...bound,
          previewStartLocation: s.startLocation,
          supportsRxOnlyPolicy: supportsRxOnlyPolicyAll,
          chirpSettings: s,
        };
      }
      case "vgc-n76": {
        const s = resolveTargetSettings(target, storedPatch);
        const bound = bindTarget(target, s);
        return {
          target,
          storedPatch,
          ...bound,
          previewStartLocation: 1,
          supportsRxOnlyPolicy: supportsRxOnlyPolicyAll,
          chirpSettings: CHIRP_FALLBACK,
        };
      }
      case "nicsure-rt880": {
        const s = resolveTargetSettings(target, storedPatch);
        const bound = bindTarget(target, s);
        return {
          target,
          storedPatch,
          ...bound,
          previewStartLocation: 1,
          supportsRxOnlyPolicy: supportsRxOnlyPolicyAll,
          chirpSettings: CHIRP_FALLBACK,
        };
      }
      case "rt-systems-yaesu-generic": {
        const s = resolveTargetSettings(target, storedPatch);
        const bound = bindTarget(target, s);
        return {
          target,
          storedPatch,
          ...bound,
          previewStartLocation: 1,
          supportsRxOnlyPolicy: supportsRxOnlyPolicyRtSystems,
          chirpSettings: CHIRP_FALLBACK,
        };
      }
      default:
        return assertNever(target);
    }
  }, [target, storedPatch]);
}
