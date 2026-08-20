import Papa from "papaparse";
import { z } from "zod";
import type { NormalizedChannel, Warning } from "../models";
import { channelSignalMode } from "../modes";
import { registerTarget } from "./registry";
import { deriveTxMhz, formatMhzFixed } from "../exporters/shared/frequency";
import { truncateName as sharedTruncateName } from "../exporters/shared/name";
import type { ExportTarget, HardwareLimits } from "./types";

/**
 * Nicsure firmware (Radtel RT-880) export target.
 *
 * Plain CSV with a fixed 19-column header. Frequencies in MHz with 5 decimal
 * places, tones as either "None", CTCSS (e.g. "67.0") or DCS (e.g. "D051N"
 * with polarity letter), and four single-letter "Slot" group memberships
 * (used by the radio to scope scan lists / zones). Empty slots are written
 * as a single space — matching the Nicsure example file byte-for-byte.
 *
 * Slot letters are arbitrary identifiers (A–Z) that the user maps to friendly
 * names inside the Nicsure RMS app. Each enabled zone *dimension* (country,
 * district, channel type, pack category) gets its own letters auto-assigned
 * from a global A–Z pool in declaration order. The export panel renders a
 * legend so the user knows which letter to label what in RMS.
 */

export type NicsurePower = "Very High" | "High" | "Medium" | "Low" | "N/T";
export type NicsureBandwidth = "Wide" | "Narrow";

export type NicsureZoneDimensionId = "country" | "district" | "type" | "category";

export const NICSURE_ZONE_DIMENSIONS: ReadonlyArray<{
  id: NicsureZoneDimensionId;
  label: string;
  description: string;
}> = [
  { id: "country", label: "Land", description: "Landskod, t.ex. SE, NO, DK, FI." },
  {
    id: "district",
    label: "Distrikt",
    description: "Repeaterdistrikt (SM6, LA, OZ) eller kanalpakets-id för paketrader.",
  },
  { id: "type", label: "Kanaltyp", description: "Repeater, Link, Hotspot, Simplex." },
  {
    id: "category",
    label: "Paketkategori",
    description: "Kategori för kanalpaket (marine, pmr, …).",
  },
];

export interface NicsureRt880Settings {
  /** Number for the first channel row; subsequent rows increment by 1. */
  startLocation: number;
  /** Maximum length of the Name column (truncation only, no padding). */
  maxLength: number;
  /** Default TX power written on every row. */
  defaultPower: NicsurePower;
  /** Default bandwidth when the channel has no mode hint. */
  defaultBandwidth: NicsureBandwidth;
  /** Ordered list of zone dimensions, max 4. Index 0 = Slot1, … index 3 = Slot4. */
  zoneDimensions: NicsureZoneDimensionId[];
}

export const NICSURE_RT880_DEFAULTS: NicsureRt880Settings = {
  startLocation: 1,
  maxLength: 32,
  defaultPower: "Very High",
  defaultBandwidth: "Wide",
  zoneDimensions: ["country", "district", "type", "category"],
};

export const nicsureRt880SettingsSchema: z.ZodType<NicsureRt880Settings> = z.object({
  startLocation: z.number().int().min(0),
  maxLength: z.number().int().min(1).max(64),
  defaultPower: z.enum(["Very High", "High", "Medium", "Low", "N/T"]),
  defaultBandwidth: z.enum(["Wide", "Narrow"]),
  zoneDimensions: z.array(z.enum(["country", "district", "type", "category"])).max(4),
});

const NICSURE_RT880_LIMITS: HardwareLimits = {
  maxChannels: 999,
  maxNameLength: 32,
  supportedModes: ["NFM", "FM", "AM"],
  supportedSignalModes: ["FM"],
  supportsSplit: false,
  supportsCtcss: true,
  supportsDcs: true,
};

export const NICSURE_RT880_COLUMNS = [
  "Channel_Num",
  "Active",
  "Name",
  "RX",
  "TX",
  "RX_Tone",
  "TX_Tone",
  "TX_Power",
  "Slot1",
  "Slot2",
  "Slot3",
  "Slot4",
  "Bandwidth",
  "Modulation",
  "BusyLock",
  "Reversed",
  "PTTID",
  "Clarifier",
  "Scrambler",
] as const;

const EMPTY_SLOT = " ";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function truncateName(raw: string, maxLen: number): { name: string; truncated: boolean } {
  return sharedTruncateName(raw, maxLen);
}

/** Mobile-side TX frequency in MHz, or null. */
function mobileTxMhz(c: NormalizedChannel): number | null {
  // RX-only channels: TX_Power column carries the "N/T" signal; TX frequency
  // mirrors RX (radio convention — no offset, no zero-frequency placeholder).
  if (c.rx_only || !c.tx_allowed) return c.rx_frequency;
  return deriveTxMhz(c);
}

function formatMhz5(mhz: number | null): string {
  return formatMhzFixed(mhz ?? 0, 5);
}

function encodeTone(side: "tx" | "rx", c: NormalizedChannel): string {
  let ctcss: number | null = null;
  if (side === "tx") {
    ctcss = c.rtone_freq ?? c.ctcss_tx ?? null;
  } else {
    ctcss = c.ctone_freq;
    if (ctcss == null) {
      const t = c.tone_raw.toUpperCase();
      if (t === "TSQL") ctcss = c.rtone_freq ?? c.ctcss_tx ?? null;
    }
  }
  if (ctcss != null) return ctcss.toFixed(1);
  if (c.dtcs_code) {
    const digits = c.dtcs_code.padStart(3, "0").slice(-3);
    const pol = c.dtcs_polarity || "NN";
    const polChar = side === "tx" ? pol.charAt(0) : pol.charAt(1);
    const letter = polChar === "R" ? "I" : "N";
    return `D${digits}${letter}`;
  }
  return "None";
}

function encodeBandwidth(c: NormalizedChannel, s: NicsureRt880Settings): NicsureBandwidth {
  const m = (c.mode_pack || "").toUpperCase();
  if (m === "NFM") return "Narrow";
  if (m === "FM" || m === "AM") return "Wide";
  return s.defaultBandwidth;
}

function encodeModulation(c: NormalizedChannel): { mod: string; unsupported: boolean } {
  const m = (c.mode_pack || "").toUpperCase();
  if (m === "AM") return { mod: "AM", unsupported: false };
  if (m === "FM" || m === "NFM" || m === "") return { mod: "Auto", unsupported: false };
  return { mod: "Auto", unsupported: true };
}

/** Read the raw value (already a string id) for a given zone dimension on a channel. */
export function dimensionValue(c: NormalizedChannel, d: NicsureZoneDimensionId): string | null {
  switch (d) {
    case "country": {
      const cc = c.region.countryCode;
      return cc && cc !== "unknown" ? cc : null;
    }
    case "district": {
      const label = c.region.districtLabel?.trim();
      if (label) return label;
      const pid = (c.pack_id || "").trim();
      return pid ? pid : null;
    }
    case "type": {
      const t = (c.type || "").trim();
      return t ? t : null;
    }
    case "category": {
      const cat = (c.category || "").trim();
      return cat ? cat : null;
    }
  }
}

export interface ZoneLegendEntry {
  letter: string;
  value: string;
}

export interface ZoneLegendSlot {
  slot: 1 | 2 | 3 | 4;
  dimension: NicsureZoneDimensionId;
  dimensionLabel: string;
  entries: ZoneLegendEntry[];
  /** Values that did not fit into the global A–Z pool. */
  overflow: string[];
}

export interface ZoneLegend {
  slots: ZoneLegendSlot[];
  /** value → letter, keyed by `${dimension}::${value}`. */
  lookup: Map<string, string>;
}

function dimensionLabel(d: NicsureZoneDimensionId): string {
  return NICSURE_ZONE_DIMENSIONS.find((x) => x.id === d)?.label ?? d;
}

/**
 * Build the zone legend for a set of channels and an ordered dimension list.
 *
 * Letters are pulled from a single global A–Z pool, in the order dimensions
 * appear in `dims`, and alphabetically within each dimension's unique values.
 * Anything that doesn't fit goes into `overflow` (no letter assigned).
 */
export function buildZoneLegend(
  channels: NormalizedChannel[],
  dims: NicsureZoneDimensionId[],
): ZoneLegend {
  const slice = dims.slice(0, 4);
  const slots: ZoneLegendSlot[] = [];
  const lookup = new Map<string, string>();
  let poolIdx = 0;

  slice.forEach((d, i) => {
    const seen = new Set<string>();
    for (const c of channels) {
      const v = dimensionValue(c, d);
      if (v) seen.add(v);
    }
    const sorted = [...seen].sort((a, b) => a.localeCompare(b));
    const entries: ZoneLegendEntry[] = [];
    const overflow: string[] = [];
    for (const v of sorted) {
      if (poolIdx < ALPHABET.length) {
        const letter = ALPHABET.charAt(poolIdx++);
        entries.push({ letter, value: v });
        lookup.set(`${d}::${v}`, letter);
      } else {
        overflow.push(v);
      }
    }
    slots.push({
      slot: (i + 1) as 1 | 2 | 3 | 4,
      dimension: d,
      dimensionLabel: dimensionLabel(d),
      entries,
      overflow,
    });
  });

  return { slots, lookup };
}

/** Render the legend as a plain-text block the user can paste into RMS. */
export function formatZoneLegend(legend: ZoneLegend): string {
  if (legend.slots.length === 0) {
    return "(inga zon-dimensioner valda — alla slot-kolumner blir tomma)";
  }
  const blocks = legend.slots.map((s) => {
    const header = `Slot${s.slot} — ${s.dimensionLabel}`;
    if (s.entries.length === 0 && s.overflow.length === 0) {
      return `${header}\n  (inga värden i datat)`;
    }
    const lines = s.entries.map((e) => `  ${e.letter} = ${e.value}`);
    if (s.overflow.length > 0) {
      lines.push(`  (utan bokstav, A–Z slut): ${s.overflow.join(", ")}`);
    }
    return `${header}\n${lines.join("\n")}`;
  });
  return blocks.join("\n\n");
}

interface NicsureRow {
  Channel_Num: string;
  Active: string;
  Name: string;
  RX: string;
  TX: string;
  RX_Tone: string;
  TX_Tone: string;
  TX_Power: string;
  Slot1: string;
  Slot2: string;
  Slot3: string;
  Slot4: string;
  Bandwidth: string;
  Modulation: string;
  BusyLock: string;
  Reversed: string;
  PTTID: string;
  Clarifier: string;
  Scrambler: string;
}

/**
 * RT-880 is analog-FM-only. Drop SK6BA rows whose effective mode is a
 * digital variant (C4FM/D-Star/DMR/DMRplus/P25). Channel-pack rows pass
 * through unchanged.
 */
function filterAnalogFmSk6ba(channels: NormalizedChannel[]): {
  kept: NormalizedChannel[];
  droppedCount: number;
} {
  const kept: NormalizedChannel[] = [];
  let droppedCount = 0;
  for (const c of channels) {
    if (c.source_type === "sk6ba" && c.mode_effective !== "" && c.mode_effective !== "FM") {
      droppedCount++;
      continue;
    }
    kept.push(c);
  }
  return { kept, droppedCount };
}

export function toNicsureRows(
  channels: NormalizedChannel[],
  s: NicsureRt880Settings,
): { rows: NicsureRow[]; warnings: Warning[]; legend: ZoneLegend } {
  const warnings: Warning[] = [];
  let truncCount = 0;
  let unsupported = 0;
  let rxOnlyCount = 0;

  const { kept, droppedCount: digitalSk6baDropped } = filterAnalogFmSk6ba(channels);
  if (digitalSk6baDropped > 0) {
    warnings.push({
      code: "nicsure_digital_sk6ba_skipped",
      message: `${digitalSk6baDropped} kanal(er) från SK6BA hoppades över: RT-880 stöder bara analog FM, digitala mode (C4FM/D-Star/DMR/DMRplus/P25) går inte att skriva i Nicsure-CSV:n.`,
    });
  }
  channels = kept;

  const dims = s.zoneDimensions.slice(0, 4);
  const legend = buildZoneLegend(channels, dims);
  const overflowTotal = legend.slots.reduce((n, sl) => n + sl.overflow.length, 0);
  if (overflowTotal > 0) {
    warnings.push({
      code: "nicsure_zone_pool_exhausted",
      message: `${overflowTotal} värde(n) fick ingen zon-bokstav (A–Z slut). Minska antalet dimensioner eller filtrera datat.`,
    });
  }

  const slotFor = (c: NormalizedChannel, idx: number): string => {
    const d = dims[idx];
    if (!d) return EMPTY_SLOT;
    const v = dimensionValue(c, d);
    if (!v) return EMPTY_SLOT;
    return legend.lookup.get(`${d}::${v}`) ?? EMPTY_SLOT;
  };

  const rows: NicsureRow[] = channels.map((c, i) => {
    const { name, truncated } = truncateName(c.generated_name_final, s.maxLength);
    if (truncated) truncCount++;

    const { mod, unsupported: modUnsupported } = encodeModulation(c);
    if (modUnsupported) unsupported++;
    const isRxOnly = c.rx_only || !c.tx_allowed;
    if (isRxOnly) rxOnlyCount++;

    return {
      Channel_Num: String(s.startLocation + i),
      Active: "True",
      Name: name,
      RX: formatMhz5(c.rx_frequency),
      TX: formatMhz5(mobileTxMhz(c)),
      RX_Tone: encodeTone("rx", c),
      TX_Tone: encodeTone("tx", c),
      TX_Power: isRxOnly ? "N/T" : s.defaultPower,
      Slot1: slotFor(c, 0),
      Slot2: slotFor(c, 1),
      Slot3: slotFor(c, 2),
      Slot4: slotFor(c, 3),
      Bandwidth: encodeBandwidth(c, s),
      Modulation: mod,
      BusyLock: "False",
      Reversed: "False",
      PTTID: "Off",
      Clarifier: "0.00",
      Scrambler: "Off",
    };
  });

  if (truncCount > 0) {
    warnings.push({
      code: "nicsure_name_truncated",
      message: `${truncCount} kanalnamn trunkerades till ${s.maxLength} tecken (Nicsure Name-fält).`,
    });
  }
  if (unsupported > 0) {
    warnings.push({
      code: "nicsure_unsupported_mode",
      message: `${unsupported} kanal(er) har mode (USB/LSB/CW/DV) som RT-880 inte stöder; exporterade som Auto/${s.defaultBandwidth}.`,
    });
  }
  if (rxOnlyCount > 0) {
    warnings.push({
      code: "nicsure_rx_only_marked",
      message: `${rxOnlyCount} kanal(er) är RX-only: TX_Power satt till N/T, TX=RX.`,
    });
  }
  return { rows, warnings, legend };
}

export function exportNicsureRt880Csv(
  channels: NormalizedChannel[],
  s: NicsureRt880Settings,
): { csv: string; warnings: Warning[]; legend: ZoneLegend; legendText: string } {
  const { rows, warnings, legend } = toNicsureRows(channels, s);
  const data = rows.map((r) => NICSURE_RT880_COLUMNS.map((col) => r[col]));
  const csv = Papa.unparse({ fields: [...NICSURE_RT880_COLUMNS], data });
  return { csv, warnings, legend, legendText: formatZoneLegend(legend) };
}

export const NICSURE_RT880_TARGET: ExportTarget<NicsureRt880Settings> = {
  id: "nicsure-rt880",
  label: "Nicsure firmware (Radtel RT-880)",
  vendor: "Nicsure",
  description:
    "CSV för Nicsures custom firmware till Radtel RT-880. 19 kolumner, frekvenser i MHz, DCS med polaritet, fyra slot-grupper för zonering (bokstäver mappas i RMS-appen).",
  filenameBase: "nicsure-rt880",
  fileExtension: "csv",
  txInhibit: "verified_tx_inhibit",
  limits: NICSURE_RT880_LIMITS,
  defaultSettings: NICSURE_RT880_DEFAULTS,
  settingsSchema: nicsureRt880SettingsSchema,
  resolveMaxNameLength: (s) => s.maxLength,
  previewMode: (c, s) => {
    // Digitala SK6BA-rader filtreras bort vid export — visa kanonisk signal
    // i previewen så det är tydligt att de inte hamnar i filen.
    const sig = channelSignalMode(c);
    if (c.source_type === "sk6ba" && sig && sig !== "FM") {
      return sig;
    }
    const mod = encodeModulation(c);
    if (mod.mod === "AM") return "AM";
    const bw = encodeBandwidth(c, s);
    return bw === "Narrow" ? "NFM" : "FM";
  },
  validate: (channels, s) => toNicsureRows(channels, s).warnings,
  export: (channels, s) => {
    const { csv, warnings } = exportNicsureRt880Csv(channels, s);
    return { filename: "nicsure-rt880.csv", content: csv, warnings };
  },
};

registerTarget(NICSURE_RT880_TARGET);
