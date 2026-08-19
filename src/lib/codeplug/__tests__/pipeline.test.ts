import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSk6baCsv } from "../importers/sk6ba";
import { parseChannelPackCsv } from "../importers/channel_pack";
import { runPipeline } from "../pipeline";
import { DEFAULT_SETTINGS } from "../defaults";
import type { Settings } from "../models";
import { makeChannel } from "./helpers";

const sk6baCsv = readFileSync(resolve(__dirname, "fixtures/sk6ba-sample.csv"), "utf8");
const pack2m = readFileSync(
  resolve(__dirname, "../../../../channelpacks/se_amateur_2m_channel_pack.csv"),
  "utf8",
);

const baseSettings: Settings = {
  ...DEFAULT_SETTINGS,
  filter: {
    ...DEFAULT_SETTINGS.filter,
    statuses: ["QRV"],
    includeUnknownRegions: true,
    countries: [],
  },
};

describe("runPipeline (sk6ba only)", () => {
  it("filters out digital and QRT rows, keeps FM/QRV", () => {
    const { rows } = parseSk6baCsv(sk6baCsv);
    const r = runPipeline({ sk6baRows: rows, settings: baseSettings });
    // 6 rows total → expect QRV FM only (rows 1,2,4,5). Row 5 has 'foo' shift but still FM/QRV
    expect(r.sk6baCount).toBe(4);
    expect(r.packCount).toBe(0);
  });

  it("reports withRx and droppedByDedupe counters", () => {
    const { rows } = parseSk6baCsv(sk6baCsv);
    const r = runPipeline({ sk6baRows: rows, settings: baseSettings });
    // Fixture has 6 rows; all have parseable output -> all 6 have RX.
    expect(r.withRx).toBe(6);
    // No packs supplied, so dedupe drops nothing.
    expect(r.droppedByDedupe).toBe(0);
  });

  it("excludes type=uW QTH rows from scope and reports outOfScope", () => {
    const uwRow: Record<string, string> = {
      id: "777",
      type: "uW QTH",
      status: "QRV",
      mode: "FM",
      output: "10368.000",
      tx_shift: "0",
      band: "3",
      district: "6",
      city: "Test",
      call: "SK6TST",
      channel: "uW1",
      lat: "57.7",
      lng: "12.9",
    };
    const fmRow: Record<string, string> = {
      id: "778",
      type: "Repeater",
      status: "QRV",
      mode: "FM",
      output: "145.6000",
      tx_shift: "-0.6",
      band: "2",
      district: "6",
      city: "Test",
      call: "SK6TST",
      channel: "RV48",
      lat: "57.7",
      lng: "12.9",
    };
    const r = runPipeline({ sk6baRows: [uwRow, fmRow], settings: baseSettings });
    expect(r.outOfScope).toBe(1);
    expect(r.withRx).toBe(1);
    expect(r.channels.every((c) => c.type !== "uW QTH")).toBe(true);
  });

  it("assigns final names and resolves collisions", () => {
    const { rows } = parseSk6baCsv(sk6baCsv);
    const r = runPipeline({ sk6baRows: rows, settings: baseSettings });
    const names = r.channels.map((c) => c.generated_name_final);
    expect(new Set(names).size).toBe(names.length);
  });

  it("DCS access on Link row exports as Cross + DTCS->", () => {
    const dcsRow: Record<string, string> = {
      id: "999",
      type: "Link",
      status: "QRV",
      mode: "FM",
      network: "AllStarLink",
      access: "DCS 025",
      output: "145.2375",
      tx_shift: "0",
      band: "2",
      district: "6",
      city: "Test",
      call: "SK6TST",
      channel: "L1",
      lat: "57.7",
      lng: "12.9",
    };
    const r = runPipeline({
      sk6baRows: [dcsRow],
      settings: {
        ...baseSettings,
        filter: { ...baseSettings.filter, types: ["Link"], statuses: ["QRV"] },
      },
    });
    const ch = r.channels[0];
    expect(ch).toBeDefined();
    expect(ch.dtcs_code).toBe("025");
    expect(ch.dtcs_polarity).toBe("NN");
    expect(ch.ctcss_tx).toBeNull();
  });
});

describe("runPipeline mode expansion", () => {
  const baseRow: Record<string, string> = {
    id: "1",
    type: "Repeater",
    status: "QRV",
    output: "434.6000",
    tx_shift: "-2",
    band: "70",
    district: "6",
    city: "Borås",
    call: "SK6BA",
    channel: "RV48",
  };

  it("expands FM/C4FM into two channels when both modes are selected", () => {
    const r = runPipeline({
      sk6baRows: [{ ...baseRow, mode: "FM / C4FM" }],
      settings: {
        ...baseSettings,
        filter: { ...baseSettings.filter, modes: ["FM", "C4FM"] },
      },
    });
    const modes = r.channels.map((c) => c.mode_effective).sort();
    expect(modes).toEqual(["C4FM", "FM"]);
  });

  it("only emits FM when filter.modes=['FM']", () => {
    const r = runPipeline({
      sk6baRows: [{ ...baseRow, mode: "FM / C4FM" }],
      settings: {
        ...baseSettings,
        filter: { ...baseSettings.filter, modes: ["FM"] },
      },
    });
    expect(r.channels).toHaveLength(1);
    expect(r.channels[0].mode_effective).toBe("FM");
  });

  it("drops rows entirely when none of their modes are selected", () => {
    const r = runPipeline({
      sk6baRows: [{ ...baseRow, mode: "DMR / D-Star" }],
      settings: {
        ...baseSettings,
        filter: { ...baseSettings.filter, modes: ["FM"] },
      },
    });
    expect(r.channels).toHaveLength(0);
  });

  it("empty filter.modes = no gating (every parsed mode emitted)", () => {
    const r = runPipeline({
      sk6baRows: [{ ...baseRow, mode: "FM / DMR" }],
      settings: {
        ...baseSettings,
        filter: { ...baseSettings.filter, modes: [] },
      },
    });
    expect(r.channels.map((c) => c.mode_effective).sort()).toEqual(["DMR", "FM"]);
  });

  it("source_supports_analog_fm är true på BÅDA varianterna av 'FM / C4FM'", () => {
    const r = runPipeline({
      sk6baRows: [{ ...baseRow, mode: "FM / C4FM" }],
      settings: {
        ...baseSettings,
        filter: { ...baseSettings.filter, modes: ["FM", "C4FM"] },
      },
    });
    expect(r.channels).toHaveLength(2);
    expect(r.channels.every((c) => c.source_supports_analog_fm)).toBe(true);
    // Den aktuella variantens access-läge styrs av mode_effective, inte flaggan.
    const byMode = Object.fromEntries(r.channels.map((c) => [c.mode_effective, classifyChannel(c)]));
    expect(byMode).toEqual({ FM: "analog", C4FM: "c4fm" });
  });

  it("digital-only källrad ger source_supports_analog_fm === false", () => {
    const r = runPipeline({
      sk6baRows: [{ ...baseRow, mode: "DMR / D-Star" }],
      settings: {
        ...baseSettings,
        filter: { ...baseSettings.filter, modes: [] },
      },
    });
    expect(r.channels.length).toBeGreaterThan(0);
    expect(r.channels.every((c) => c.source_supports_analog_fm)).toBe(false);
  });
});

describe("runPipeline with channel pack", () => {
  const packRes = parseChannelPackCsv(pack2m, "p.csv");
  const packChannels = packRes.channels.slice(0, 3);

  it("placement=prepend puts pack rows first", () => {
    const { rows } = parseSk6baCsv(sk6baCsv);
    const r = runPipeline({
      sk6baRows: rows,
      packChannels,
      settings: { ...baseSettings, packs: { ...baseSettings.packs, placement: "prepend" } },
    });
    expect(r.channels[0].source_type).toBe("channel_pack");
    expect(r.packCount).toBe(3);
  });

  it("placement=append puts pack rows last", () => {
    const { rows } = parseSk6baCsv(sk6baCsv);
    const r = runPipeline({
      sk6baRows: rows,
      packChannels,
      settings: { ...baseSettings, packs: { ...baseSettings.packs, placement: "append" } },
    });
    expect(r.channels[r.channels.length - 1].source_type).toBe("channel_pack");
  });

  it("placement=off omits pack rows", () => {
    const { rows } = parseSk6baCsv(sk6baCsv);
    const r = runPipeline({
      sk6baRows: rows,
      packChannels,
      settings: { ...baseSettings, packs: { ...baseSettings.packs, placement: "off" } },
    });
    expect(r.packCount).toBe(0);
  });

  it("rxOnlyPolicy=skip removes rx_only rows", () => {
    const { rows } = parseSk6baCsv(sk6baCsv);
    const withRxOnly = packChannels.map((c, i) =>
      i === 0 ? { ...c, rx_only: true, warnings: [...c.warnings] } : c,
    );
    const r = runPipeline({
      sk6baRows: rows,
      packChannels: withRxOnly,
      settings: {
        ...baseSettings,
        packs: { ...baseSettings.packs, placement: "append", rxOnlyPolicy: "skip" },
      },
    });
    expect(r.packCount).toBe(2);
  });

  it("rxOnlyPolicy=block_tx sets duplex=off and emits rx_only_blocked warning", () => {
    const { rows } = parseSk6baCsv(sk6baCsv);
    const withRxOnly = packChannels.map((c, i) =>
      i === 0 ? { ...c, rx_only: true, warnings: [...c.warnings] } : c,
    );
    const r = runPipeline({
      sk6baRows: rows,
      packChannels: withRxOnly,
      settings: {
        ...baseSettings,
        packs: { ...baseSettings.packs, placement: "append", rxOnlyPolicy: "block_tx" },
      },
    });
    const rxOnly = r.channels.find((c) => c.rx_only);
    expect(rxOnly?.duplex).toBe("off");
    expect(rxOnly?.warnings.some((w) => w.code === "rx_only_blocked")).toBe(true);
  });
});

describe("runPipeline filteredOut semantics", () => {
  it("räknar inte mode-expansion som extra utgångskanaler", () => {
    const row = {
      id: "1",
      type: "Repeater",
      status: "QRV",
      output: "434.6000",
      tx_shift: "-2",
      band: "70",
      district: "6",
      city: "Borås",
      call: "SK6BA",
      channel: "RV48",
      mode: "FM / C4FM",
      access: "123.0",
    };
    const r = runPipeline({
      sk6baRows: [row],
      settings: {
        ...baseSettings,
        filter: { ...baseSettings.filter, modes: [] },
      },
    });
    expect(r.channels.length).toBe(2);
    // 1 källrad → 1 använd source_row → 0 filteredOut.
    expect(r.filteredOut).toBe(0);
  });
});

describe("runPipeline split utan tx_frequency", () => {
  it("degraderar duplex till simplex och lägger varning", () => {
    const pack = makeChannel({
      source_type: "channel_pack",
      pack_id: "p1",
      mode_pack: "FM",
      mode_effective: "FM",
      duplex: "split",
      offset: 0,
      tx_frequency: null,
      rx_frequency: 145.5,
    });
    const r = runPipeline({
      sk6baRows: [],
      packChannels: [pack],
      settings: baseSettings,
    });
    expect(r.channels.length).toBe(1);
    const c = r.channels[0];
    expect(c.duplex).toBe("");
    expect(c.offset).toBe(0);
    expect(c.warnings.some((w) => w.code === "pack_split_unsupported")).toBe(true);
  });
});
