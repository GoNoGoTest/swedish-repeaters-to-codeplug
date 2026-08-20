import { describe, it, expect } from "vitest";
import { runPipeline } from "../pipeline";
import { DEFAULT_SETTINGS } from "../defaults";
import type { NormalizedChannel, RawRow, Settings } from "../models";
import { makeChannel, makePackChannel } from "./helpers";
import {
  assertTxIntentSerializable,
  deriveTxIntent,
  isTxDisabled,
  TxIntentCapabilityError,
} from "../txIntent";
import { listTargets, requireTarget } from "../targets";
import { isRxOnlyChannel } from "../rxOnly";
import { CHIRP_GENERIC_DEFAULTS } from "../targets/chirp-generic";
import { exportChirpCsv } from "../exporters/chirp";
import { exportVgcN76Csv, VGC_N76_DEFAULTS } from "../targets/vgc-n76";
import { exportNicsureRt880Csv, NICSURE_RT880_DEFAULTS } from "../targets/nicsure-rt880";
import { RT_SYSTEMS_YAESU_DEFAULTS, RT_SYSTEMS_YAESU_TARGET } from "../targets/rt-systems-yaesu";

const base: Settings = {
  ...DEFAULT_SETTINGS,
  filter: { ...DEFAULT_SETTINGS.filter, statuses: [], countries: [], includeUnknownRegions: true },
};

function withPolicy(p: Settings["packs"]["rxOnlyPolicy"]): Settings {
  return { ...base, packs: { ...base.packs, placement: "append", rxOnlyPolicy: p } };
}

const rxOnlyPack = () =>
  makePackChannel({ rx_only: true, tx_allowed: false, rx_frequency: 156.8, pack_id: "p1" });

describe("pipeline härleder tx_intent", () => {
  it("vanlig repeater → normal", () => {
    const r = runPipeline({ sk6baRows: [], packChannels: [makePackChannel()], settings: base });
    expect(r.channels[0].tx_intent).toBe("normal");
  });

  it("RX-only + mark → best_effort_rx_only", () => {
    const r = runPipeline({
      sk6baRows: [],
      packChannels: [rxOnlyPack()],
      settings: withPolicy("mark"),
    });
    expect(r.channels[0].tx_intent).toBe("best_effort_rx_only");
  });

  it("RX-only + block_tx → must_block_tx", () => {
    const r = runPipeline({
      sk6baRows: [],
      packChannels: [rxOnlyPack()],
      settings: withPolicy("block_tx"),
    });
    expect(r.channels[0].tx_intent).toBe("must_block_tx");
    expect(r.channels[0].duplex).toBe("off");
  });

  it("RX-only + skip → kanalen tas bort som tidigare", () => {
    const r = runPipeline({
      sk6baRows: [],
      packChannels: [rxOnlyPack()],
      settings: withPolicy("skip"),
    });
    expect(r.channels).toHaveLength(0);
  });

  it("källflaggor och source_supports_analog_fm bevaras genom mode-expansion", () => {
    const row: RawRow = {
      id: "1",
      type: "Repeater",
      status: "QRV",
      mode: "FM / C4FM",
      output: "434.6000",
      tx_shift: "-2",
      band: "70",
      district: "6",
      city: "Borås",
      call: "SK6BA",
      channel: "RV48",
    };
    const r = runPipeline({
      sk6baRows: [row],
      settings: { ...base, filter: { ...base.filter, modes: ["FM", "C4FM"] } },
    });
    expect(r.channels).toHaveLength(2);
    for (const c of r.channels) {
      expect(c.source_supports_analog_fm).toBe(true);
      expect(c.rx_only).toBe(false);
      expect(c.tx_allowed).toBe(true);
      expect(c.tx_shift).toBe(-2);
      expect(c.tx_intent).toBe("normal");
      expect(isRxOnlyChannel(c)).toBe(false);
    }
  });

  it("regression: saknat mode och saknad tx_shift beter sig som tidigare", () => {
    const row: RawRow = {
      id: "2",
      type: "Simplex",
      status: "QRV",
      output: "145.5000",
      band: "2",
      district: "6",
      city: "Borås",
      call: "SK6BA",
      channel: "S20",
    };
    const r = runPipeline({ sk6baRows: [row], settings: base });
    expect(r.channels).toHaveLength(1);
    const c = r.channels[0];
    expect(c.mode_effective).toBe("");
    expect(c.duplex).toBe("");
    expect(c.tx_intent).toBe("normal");
    expect(isRxOnlyChannel(c)).toBe(false);
  });
});

describe("deriveTxIntent / isTxDisabled", () => {
  it("normal simplex är inte RX-only oavsett policy", () => {
    const c = makeChannel({ duplex: "", offset: 0 });
    expect(deriveTxIntent(c, "block_tx")).toBe("normal");
    expect(isTxDisabled(c)).toBe(false);
  });

  it("must_block_tx räknas som TX-spärrad", () => {
    expect(isTxDisabled(makeChannel({ tx_intent: "must_block_tx" }))).toBe(true);
  });
});

describe("target capability", () => {
  it("varje registrerat target deklarerar txInhibit", () => {
    const targets = listTargets();
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) {
      expect(["verified_tx_inhibit", "no_tx_inhibit"]).toContain(t.txInhibit);
    }
  });

  it("kända targets har förväntad förmåga", () => {
    expect(requireTarget("chirp-generic").txInhibit).toBe("verified_tx_inhibit");
    expect(requireTarget("vgc-n76").txInhibit).toBe("verified_tx_inhibit");
    expect(requireTarget("nicsure-rt880").txInhibit).toBe("verified_tx_inhibit");
    expect(requireTarget("rt-systems-yaesu-generic").txInhibit).toBe("no_tx_inhibit");
  });
});

describe("defensiv vakt", () => {
  const blocked: NormalizedChannel = makeChannel({
    tx_intent: "must_block_tx",
    rx_only: true,
    duplex: "off",
    generated_name_final: "MARIN16",
  });

  it("no_tx_inhibit-target kan inte serialisera must_block_tx", () => {
    expect(() =>
      RT_SYSTEMS_YAESU_TARGET.export([blocked], RT_SYSTEMS_YAESU_DEFAULTS),
    ).toThrow(TxIntentCapabilityError);
  });

  it("verified_tx_inhibit-target passerar vakten", () => {
    expect(() =>
      assertTxIntentSerializable([blocked], "verified_tx_inhibit", "chirp-generic"),
    ).not.toThrow();
  });

  it("no_tx_inhibit + best_effort_rx_only (mark) är fortsatt tillåtet", () => {
    const marked = makeChannel({
      tx_intent: "best_effort_rx_only",
      rx_only: true,
      generated_name_final: "MARIN16",
    });
    const res = RT_SYSTEMS_YAESU_TARGET.export([marked], RT_SYSTEMS_YAESU_DEFAULTS);
    expect(res.content).toContain("Simplex");
  });
});

describe("must_block_tx vinner över avvikande tx_frequency", () => {
  const conflict = makeChannel({
    tx_intent: "must_block_tx",
    rx_only: true,
    duplex: "off",
    rx_frequency: 145.6,
    tx_frequency: 431.0,
    generated_name_final: "TEST",
  });

  it("CHIRP skriver Duplex=off", () => {
    const csv = exportChirpCsv([conflict], CHIRP_GENERIC_DEFAULTS);
    const cols = csv.split("\r\n")[1].split(",");
    expect(cols[3]).toBe("off");
  });

  it("VGC sätter tx_dis=1", () => {
    const { csv } = exportVgcN76Csv([conflict], VGC_N76_DEFAULTS);
    const cols = csv.split("\r\n")[1].split(",");
    expect(cols[11]).toBe("1");
  });

  it("Nicsure sätter TX_Power=N/T och TX=RX", () => {
    const { csv } = exportNicsureRt880Csv([conflict], NICSURE_RT880_DEFAULTS);
    const cols = csv.split("\r\n")[1].split(",");
    expect(cols[3]).toBe(cols[4]);
    expect(cols[7]).toBe("N/T");
  });
});
