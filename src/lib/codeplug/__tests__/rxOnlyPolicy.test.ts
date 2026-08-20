import { describe, it, expect } from "vitest";
import {
  resolveEffectiveRxOnlyPolicy,
  targetSupportsRxOnlyPolicy,
  withEffectiveRxOnlyPolicy,
} from "../rxOnlyPolicy";
import { DEFAULT_SETTINGS } from "../defaults";
import type { Settings } from "../models";

const withTarget = (targetId: string, policy: Settings["packs"]["rxOnlyPolicy"]): Settings => ({
  ...DEFAULT_SETTINGS,
  packs: { ...DEFAULT_SETTINGS.packs, rxOnlyPolicy: policy },
  export: { ...DEFAULT_SETTINGS.export, targetId },
});

describe("resolveEffectiveRxOnlyPolicy", () => {
  it("RT Systems: block_tx faller tillbaka på skip", () => {
    expect(targetSupportsRxOnlyPolicy("rt-systems-yaesu-generic", "block_tx")).toBe(false);
    expect(resolveEffectiveRxOnlyPolicy("rt-systems-yaesu-generic", "block_tx")).toBe("skip");
  });

  it("RT Systems: explicit mark/skip behålls", () => {
    expect(resolveEffectiveRxOnlyPolicy("rt-systems-yaesu-generic", "mark")).toBe("mark");
    expect(resolveEffectiveRxOnlyPolicy("rt-systems-yaesu-generic", "skip")).toBe("skip");
  });

  it("CHIRP/VGC/Nicsure stöder alla policyer", () => {
    for (const id of ["chirp-generic", "vgc-n76", "nicsure-rt880"]) {
      for (const p of ["block_tx", "mark", "skip"] as const) {
        expect(targetSupportsRxOnlyPolicy(id, p)).toBe(true);
        expect(resolveEffectiveRxOnlyPolicy(id, p)).toBe(p);
      }
    }
  });
});

describe("withEffectiveRxOnlyPolicy", () => {
  it("muterar inte requested policy och återställer den vid byte tillbaka", () => {
    const requested = withTarget("chirp-generic", "block_tx");
    const rt = withTarget("rt-systems-yaesu-generic", "block_tx");

    expect(withEffectiveRxOnlyPolicy(rt).packs.rxOnlyPolicy).toBe("skip");
    // Requested-objektet är orört.
    expect(rt.packs.rxOnlyPolicy).toBe("block_tx");
    // Byte tillbaka ger åter block_tx.
    expect(withEffectiveRxOnlyPolicy(requested).packs.rxOnlyPolicy).toBe("block_tx");
  });

  it("returnerar samma referens när inget behöver ändras", () => {
    for (const id of ["chirp-generic", "vgc-n76", "nicsure-rt880"]) {
      const s = withTarget(id, "block_tx");
      expect(withEffectiveRxOnlyPolicy(s)).toBe(s);
    }
  });
});

describe("okänt target failar closed", () => {
  it("block_tx stöds inte av ett oregistrerat target", () => {
    expect(targetSupportsRxOnlyPolicy("does-not-exist", "block_tx")).toBe(false);
    expect(resolveEffectiveRxOnlyPolicy("does-not-exist", "block_tx")).toBe("skip");
  });

  it("mark/skip fungerar fortfarande för okänt target", () => {
    for (const p of ["mark", "skip"] as const) {
      expect(targetSupportsRxOnlyPolicy("does-not-exist", p)).toBe(true);
      expect(resolveEffectiveRxOnlyPolicy("does-not-exist", p)).toBe(p);
    }
  });
});
