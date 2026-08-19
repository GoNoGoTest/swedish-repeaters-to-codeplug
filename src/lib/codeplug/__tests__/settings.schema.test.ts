import { describe, it, expect } from "vitest";
import { settingsSchema } from "../settings.schema";
import { DEFAULT_SETTINGS } from "../defaults";

describe("settingsSchema", () => {
  it("godkänner DEFAULT_SETTINGS", () => {
    const r = settingsSchema.safeParse(DEFAULT_SETTINGS);
    expect(r.success).toBe(true);
  });

  it("parsad DEFAULT_SETTINGS är identisk med indata (inga fält tappas)", () => {
    const r = settingsSchema.safeParse(DEFAULT_SETTINGS);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toEqual(DEFAULT_SETTINGS);
  });

  it("varje literal i de persisterade unionerna godkänns av sitt delschema", () => {
    for (const collisionPolicy of ["numeric_suffix", "last_char_suffix"] as const) {
      expect(
        settingsSchema.safeParse({
          ...DEFAULT_SETTINGS,
          naming: { ...DEFAULT_SETTINGS.naming, collisionPolicy },
        }).success,
      ).toBe(true);
    }
    for (const mode of ["single", "per_district", "per_district_chunked"] as const) {
      expect(
        settingsSchema.safeParse({
          ...DEFAULT_SETTINGS,
          export: {
            ...DEFAULT_SETTINGS.export,
            split: { ...DEFAULT_SETTINGS.export.split, mode },
          },
        }).success,
      ).toBe(true);
    }
    for (const freqDupePolicy of ["keep_both", "drop_pack", "drop_sk6ba", "stop"] as const) {
      expect(
        settingsSchema.safeParse({
          ...DEFAULT_SETTINGS,
          packs: { ...DEFAULT_SETTINGS.packs, freqDupePolicy },
        }).success,
      ).toBe(true);
    }
    for (const rxOnlyPolicy of ["mark", "block_tx", "skip"] as const) {
      expect(
        settingsSchema.safeParse({
          ...DEFAULT_SETTINGS,
          packs: { ...DEFAULT_SETTINGS.packs, rxOnlyPolicy },
        }).success,
      ).toBe(true);
    }
    for (const key of ["district", "geohash", "type", "city", "frequency"] as const) {
      expect(
        settingsSchema.safeParse({
          ...DEFAULT_SETTINGS,
          sort: { ...DEFAULT_SETTINGS.sort, keys: [key] },
        }).success,
      ).toBe(true);
    }
    for (const home_district_sort of ["distance", "geohash", "alphabetical"] as const) {
      expect(
        settingsSchema.safeParse({
          ...DEFAULT_SETTINGS,
          sort: { ...DEFAULT_SETTINGS.sort, home_district_sort },
        }).success,
      ).toBe(true);
    }
  });

  it("avvisar strukturellt trasig payload (filter saknar struktur)", () => {
    const broken = { ...DEFAULT_SETTINGS, filter: 5 };
    const r = settingsSchema.safeParse(broken);
    expect(r.success).toBe(false);
  });

  it("avvisar ogiltigt collisionPolicy-värde", () => {
    const broken = {
      ...DEFAULT_SETTINGS,
      naming: { ...DEFAULT_SETTINGS.naming, collisionPolicy: "not_a_policy" },
    };
    const r = settingsSchema.safeParse(broken);
    expect(r.success).toBe(false);
  });

  it("släpper igenom okända toppnivåfält via passthrough", () => {
    const withExtra = { ...DEFAULT_SETTINGS, unknownField: 123 };
    const r = settingsSchema.safeParse(withExtra);
    expect(r.success).toBe(true);
  });
});
