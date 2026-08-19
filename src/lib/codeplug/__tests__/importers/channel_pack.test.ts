import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseChannelPackCsv, selectPackChannels } from "../../importers/channel_pack";

const pack2m = readFileSync(
  resolve(__dirname, "../../../../../channelpacks/se_amateur_2m_channel_pack.csv"),
  "utf8",
);
const pack70 = readFileSync(
  resolve(__dirname, "../../../../../channelpacks/se_amateur_70cm_channel_pack.csv"),
  "utf8",
);

describe("parseChannelPackCsv", () => {
  it("parses 2m pack with expected pack id and channels", () => {
    const r = parseChannelPackCsv(pack2m, "se_amateur_2m_channel_pack.csv");
    expect(r.packId).toBe("se_amateur_2m_70cm");
    expect(r.channels.length).toBeGreaterThan(20);
    expect(r.headerWarnings).toEqual([]);
    for (const c of r.channels) {
      expect(c.source_type).toBe("channel_pack");
      expect(c.rx_frequency).not.toBeNull();
      expect(c.band).toBe("2m");
    }
  });

  it("parses 70cm pack and assigns 70cm band", () => {
    const r = parseChannelPackCsv(pack70, "se_amateur_70cm_channel_pack.csv");
    expect(r.channels.every((c) => c.band === "70cm")).toBe(true);
  });

  it("warns on duplicate source_id (not fail)", () => {
    const dup = [
      "pack_id,source_id,enabled_default,rx_frequency,label",
      "p1,row-1,true,144.000,A",
      "p1,row-1,true,144.100,B",
    ].join("\n");
    const r = parseChannelPackCsv(dup, "dup.csv");
    expect(r.channels).toHaveLength(2);
    const codes = r.channels[1].warnings.map((w) => w.code);
    expect(codes).toContain("pack_duplicate_source_id");
  });

  it("warns on missing required fields without crashing", () => {
    const bad = "pack_id,source_id,rx_frequency\n,,";
    const r = parseChannelPackCsv(bad, "bad.csv");
    expect(r.channels).toHaveLength(1);
    expect(r.channels[0].warnings.map((w) => w.code)).toContain("pack_missing_required");
  });

  it("parses booleans for tx_allowed / rx_only", () => {
    const r = parseChannelPackCsv(pack2m, "x.csv");
    expect(r.channels[0].tx_allowed).toBe(true);
    expect(r.channels[0].rx_only).toBe(false);
  });

  it("sätter source_supports_analog_fm från packens källmode", () => {
    const csv = [
      "pack_id,source_id,rx_frequency,mode,label",
      "p1,fm,145.000,FM,A",
      "p1,nfm,145.100,NFM,B",
      "p1,blank,145.200,,C",
      "p1,am,118.000,AM,D",
      "p1,dmr,145.300,DMR,E",
    ].join("\n");
    const r = parseChannelPackCsv(csv, "modes.csv");
    const flag = (id: string) =>
      r.channels.find((c) => c.source_id === id)?.source_supports_analog_fm;
    expect(flag("fm")).toBe(true);
    expect(flag("nfm")).toBe(true);
    // Tomt mode faller tillbaka till FM i importern → flaggan följer med.
    expect(flag("blank")).toBe(true);
    expect(flag("am")).toBe(false);
    expect(flag("dmr")).toBe(false);
  });
});

describe("selectPackChannels", () => {
  const r = parseChannelPackCsv(pack2m, "x.csv");
  it("filters by category", () => {
    const cats = Array.from(new Set(r.channels.map((c) => c.category))).filter(Boolean);
    expect(cats.length).toBeGreaterThan(0);
    const picked = selectPackChannels(r.channels, {
      bands: [],
      categories: [cats[0]],
      tags: [],
      useEnabledDefault: false,
    });
    expect(picked.every((c) => c.category === cats[0])).toBe(true);
  });

  it("manual source ids override other filters", () => {
    const id = r.channels[0].source_id;
    const picked = selectPackChannels(r.channels, {
      bands: ["nonexistent"],
      categories: [],
      tags: [],
      useEnabledDefault: true,
      manualSourceIds: [id],
    });
    expect(picked).toHaveLength(1);
    expect(picked[0].source_id).toBe(id);
  });
});

describe("channel pack — digital access in tone column", () => {
  it("tone=TSQL with rtone_freq does not fill digital fields", () => {
    const csv = [
      "pack_id,source_id,enabled_default,rx_frequency,label,mode,tone,rtone_freq",
      "p1,r1,true,144.000,A,FM,TSQL,88.5",
    ].join("\n");
    const r = parseChannelPackCsv(csv, "x.csv");
    const ch = r.channels[0];
    expect(ch.dmr_color_code).toBeNull();
    expect(ch.access_unknown_tokens).toEqual([]);
    expect(ch.digital_access_raw).toBe("");
  });

  it("tone=CC1 on DMR pack fills dmr_color_code, no pack_unsupported_mode", () => {
    const csv = [
      "pack_id,source_id,enabled_default,rx_frequency,label,mode,tone",
      "p1,r1,true,433.475,A,DMR,CC1",
    ].join("\n");
    const r = parseChannelPackCsv(csv, "x.csv");
    const ch = r.channels[0];
    expect(ch.dmr_color_code).toBe(1);
    expect(ch.digital_access_raw).toBe("CC1");
    expect(ch.warnings.map((w) => w.code)).not.toContain("pack_unsupported_mode");
  });

  it("mode=DMR+ alone produces no pack_unsupported_mode warning", () => {
    const csv = [
      "pack_id,source_id,enabled_default,rx_frequency,label,mode",
      "p1,r1,true,433.475,A,DMR+",
    ].join("\n");
    const r = parseChannelPackCsv(csv, "x.csv");
    expect(r.channels[0].warnings.map((w) => w.code)).not.toContain("pack_unsupported_mode");
  });

  it("mode=C4FM and mode=P25 also accepted without warning", () => {
    const csv = [
      "pack_id,source_id,enabled_default,rx_frequency,label,mode",
      "p1,r1,true,433.475,A,C4FM",
      "p1,r2,true,433.500,B,P25",
    ].join("\n");
    const r = parseChannelPackCsv(csv, "x.csv");
    for (const ch of r.channels) {
      expect(ch.warnings.map((w) => w.code)).not.toContain("pack_unsupported_mode");
    }
  });
});
