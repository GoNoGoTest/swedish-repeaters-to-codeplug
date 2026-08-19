import { describe, it, expect } from "vitest";
import { buildName, resolveCollisions, translit, sanitize } from "../naming";
import { DEFAULT_SETTINGS } from "../defaults";
import { makeChannel } from "./helpers";

const naming = DEFAULT_SETTINGS.naming;

describe("translit/sanitize", () => {
  it("transliterates Swedish characters", () => {
    expect(translit("Åke Örnsköldsvik")).toBe("Ake Ornskoldsvik");
  });
  it("sanitize strips spaces and uppercases", () => {
    expect(sanitize("Hej världen!", { transliterate: true, uppercase: true })).toBe("HEJVARLDEN");
  });
});

describe("buildName", () => {
  it("uses primary city when split by /", () => {
    const ch = makeChannel({ city: "Borås/Sjuhärad" });
    const r = buildName(ch, { ...naming, components: ["{city}"], cityMaxLength: 6 }, 6);
    expect(r.full).toBe("BORAS");
    expect(r.clipped).toBe("BORAS");
  });

  it("smart-joins skipping empty tokens (no double separator)", () => {
    const ch = makeChannel({ city: "", call: "SK6BA", channel: "RV48" });
    const r = buildName(
      ch,
      { ...naming, components: ["{city}", "{call}", "{channel}"], separator: "-" },
      20,
    );
    expect(r.full).toBe("SK6BA-RV48");
  });

  it("falls back for empty channel_pack name", () => {
    const ch = makeChannel({
      source_type: "channel_pack",
      city: "",
      call: "",
      channel: "",
      label: "CW ACT",
      name_hint: "CW ACT",
    });
    const r = buildName(ch, { ...naming, components: ["{city}", "{call}"] }, 12);
    expect(r.full.length).toBeGreaterThan(0);
    expect(r.full).toBe("CWACT");
  });

  it("respects maxLength clipping", () => {
    const ch = makeChannel({ city: "Stockholm" });
    const r = buildName(ch, { ...naming, components: ["{city}"], cityMaxLength: 0 }, 4);
    expect(r.clipped.length).toBe(4);
  });

  it("expands district prefix and band abbrev", () => {
    const ch = makeChannel({ district: "6", band: "2" });
    const r = buildName(
      ch,
      { ...naming, components: ["{district}", "{band}"], separator: "-" },
      20,
    );
    expect(r.full).toBe("D6-2M");
  });

  it("{region} yields SM6 for Swedish, LA for Norway, OH0 for Åland", () => {
    const se = makeChannel({ district: "6" });
    const no = makeChannel({ district: "LA" });
    const ax = makeChannel({ district: "OH0" });
    const fi = makeChannel({ district: "OH6" });
    const opts = { ...naming, components: ["{region}"], separator: "-" };
    expect(buildName(se, opts, 10).full).toBe("SM6");
    expect(buildName(no, opts, 10).full).toBe("LA");
    expect(buildName(ax, opts, 10).full).toBe("OH0");
    expect(buildName(fi, opts, 10).full).toBe("OH6");
  });

  it("{country} yields country code", () => {
    const ch = makeChannel({ district: "LA", city: "Oslo" });
    const r = buildName(ch, { ...naming, components: ["{country}", "{city}"], separator: "-" }, 20);
    expect(r.full).toBe("NO-OSLO");
  });

  it("{district} returns empty for non-Swedish raw values (no DLA/DOZ artefacts)", () => {
    const la = makeChannel({ district: "LA", city: "Oslo" });
    const r = buildName(
      la,
      { ...naming, components: ["{district}", "{city}"], separator: "-" },
      20,
    );
    expect(r.full).toBe("OSLO");
  });

  it("{mode} resolves from mode_effective", () => {
    const fm = makeChannel({ city: "Göteborg", mode_effective: "FM" });
    const c4 = makeChannel({ city: "Göteborg", mode_effective: "C4FM" });
    const opts = { ...naming, components: ["{city}", "{mode}"], separator: "-", cityMaxLength: 0 };
    expect(buildName(fm, opts, 20).full).toBe("GOTEBORG-FM");
    expect(buildName(c4, opts, 20).full).toBe("GOTEBORG-C4FM");
  });

  it("{mode} honours abbreviations.mode override", () => {
    const ch = makeChannel({ city: "GBG", mode_effective: "C4FM" });
    const opts = {
      ...naming,
      components: ["{city}", "{mode}"],
      separator: "-",
      abbreviations: { ...naming.abbreviations, mode: { C4FM: "YSF" } },
    };
    expect(buildName(ch, opts, 20).full).toBe("GBG-YSF");
  });

  it("{mode} drops to empty for unknown mode_effective", () => {
    const ch = makeChannel({ city: "GBG", mode_effective: "" });
    const opts = { ...naming, components: ["{city}", "{mode}"], separator: "-" };
    expect(buildName(ch, opts, 20).full).toBe("GBG");
  });
});

describe("resolveCollisions", () => {
  it("appends numeric suffixes on collision, including the first occurrence", () => {
    const a = makeChannel({ generated_name_final: "BORAS" });
    const b = makeChannel({ generated_name_final: "BORAS" });
    const c = makeChannel({ generated_name_final: "BORAS" });
    const { channels, unresolved } = resolveCollisions(
      [a, b, c],
      { ...naming, collisionPolicy: "numeric_suffix" },
      6,
    );
    expect(unresolved).toBe(0);
    expect(channels[0].generated_name_final).toBe("BORAS1");
    expect(channels[1].generated_name_final).toBe("BORAS2");
    expect(channels[2].generated_name_final).toBe("BORAS3");
    expect(channels[0].collided).toBe(true);
    expect(channels[1].collided).toBe(true);
    // Inputs must not be mutated.
    expect(a.generated_name_final).toBe("BORAS");
    expect(a.collided).toBe(false);
  });

  it("leaves unique names untouched", () => {
    const a = makeChannel({ generated_name_final: "LUND" });
    const b = makeChannel({ generated_name_final: "MALMO" });
    const { channels } = resolveCollisions(
      [a, b],
      { ...naming, collisionPolicy: "numeric_suffix" },
      6,
    );
    expect(channels[0].generated_name_final).toBe("LUND");
    expect(channels[1].generated_name_final).toBe("MALMO");
  });

  it("maxLength=1 ger unika ensiffriga namn utan att hänga", () => {
    const chans = Array.from({ length: 5 }, () => makeChannel({ generated_name_final: "X" }));
    const { channels, unresolved } = resolveCollisions(
      chans,
      { ...naming, collisionPolicy: "numeric_suffix" },
      1,
    );
    expect(unresolved).toBe(0);
    expect(channels.map((c) => c.generated_name_final)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("markerar uttömd namnrymd som olöst istället för tyst dubblett", () => {
    const chans = Array.from({ length: 12 }, () => makeChannel({ generated_name_final: "X" }));
    const { channels, unresolved } = resolveCollisions(
      chans,
      { ...naming, collisionPolicy: "numeric_suffix" },
      1,
    );
    expect(unresolved).toBeGreaterThan(0);
    const flagged = channels.filter((c) =>
      c.warnings.some((w) => w.code === "unresolved_name_collision"),
    );
    expect(flagged.length).toBe(unresolved);
  });

  it("bokstavssuffix rullar över till AA efter Z", () => {
    const chans = Array.from({ length: 27 }, () => makeChannel({ generated_name_final: "X" }));
    const { channels, unresolved } = resolveCollisions(
      chans,
      { ...naming, collisionPolicy: "last_char_suffix" },
      6,
    );
    expect(unresolved).toBe(0);
    expect(channels[25].generated_name_final).toBe("XZ");
    expect(channels[26].generated_name_final).toBe("XAA");
  });
});
