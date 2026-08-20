import Papa from "papaparse";
import { z } from "zod";
import type { NormalizedChannel, SplitSettings, Warning } from "../models";
import { channelSignalMode } from "../modes";
import { registerTarget } from "./registry";
import { buildSplitFiles } from "./split";
import { deriveTxMhz, mhzToHz } from "../exporters/shared/frequency";
import { truncateName } from "../exporters/shared/name";
import type { ExportTarget, HardwareLimits } from "./types";

/**
 * VGC N76 export target.
 *
 * The VGC iOS/Android app imports plain CSV with a very specific header
 * (parameter spec embedded in the column names). Frequencies are integer
 * Hz, CTCSS is Hz×100, DCS is the 3-digit octal code as a decimal
 * integer. Disambiguation on read: value < 1000 ⇒ DCS, ≥ 1000 ⇒ CTCSS.
 *
 * Limitations (v1):
 *  - DCS polarity (N/I) is not representable in the file; we emit N only
 *    and warn when the source row carries I-polarity.
 *  - AM is not exposed yet (NormalizedChannel has no AM flag).
 *  - Per-row power/bandwidth override is not exposed; settings apply
 *    target-wide unless the channel pack carries an explicit mode.
 *  - The 32-channels-per-group N76 limit is surfaced as a warning only;
 *    splitting into groups is the user's responsibility for now.
 */

export interface VgcN76Settings {
  /** Max length of the `title` column. UTF-8 chars, not bytes. */
  maxLength: number;
  /** Default TX power letter when the channel has no override. */
  defaultPower: "H" | "M" | "L";
  /** Default bandwidth in Hz when mode is unknown. */
  defaultBandwidth: 12500 | 25000;
  /** N76 hardware constraint — channels per memory group. */
  channelsPerGroup: number;
  /** Pad output with empty rows up to this row count. null = no padding. */
  padToChannels: number | null;
  /** Mirror chirp-generic: omit links from scan (scan=0 for Link/Hotspot rows). */
  skipLinks: boolean;
  /**
   * Reserve channel slot 32 in every chunk for a fixed APRS channel
   * (144.800 FM 25 kHz, scan=0, sign=0). User channels that would have
   * landed on slot 32 spill over to the next chunk instead of being
   * overwritten. Effective user-channel cap per chunk drops from 32 to 31.
   */
  reserveAprsSlot32: boolean;
}

export const VGC_N76_DEFAULTS: VgcN76Settings = {
  maxLength: 8,
  defaultPower: "H",
  defaultBandwidth: 12500,
  channelsPerGroup: 32,
  padToChannels: null,
  skipLinks: false,
  reserveAprsSlot32: false,
};

export const vgcN76SettingsSchema: z.ZodType<VgcN76Settings> = z.object({
  maxLength: z.number().int().min(1).max(64),
  defaultPower: z.enum(["H", "M", "L"]),
  defaultBandwidth: z.union([z.literal(12500), z.literal(25000)]),
  channelsPerGroup: z.number().int().min(1).max(32),
  padToChannels: z.number().int().min(0).nullable(),
  skipLinks: z.boolean(),
  reserveAprsSlot32: z.boolean(),
});

const VGC_N76_CHANNELS_PER_GROUP = 32;

const VGC_N76_LIMITS: HardwareLimits = {
  maxChannels: 500,
  maxChannelsPerGroup: VGC_N76_CHANNELS_PER_GROUP,
  maxNameLength: 8,
  supportedModes: ["NFM", "FM", "AM"],
  supportedSignalModes: ["FM"],
  supportsSplit: true,
  supportsCtcss: true,
  supportsDcs: true,
};

function isAm(c: NormalizedChannel): boolean {
  return (c.mode_pack || "").toUpperCase() === "AM";
}

// Exact header as emitted by the VGC app — every paren spec must match
// byte-for-byte or the app rejects the file silently.
export const VGC_N76_COLUMNS = [
  "title",
  "tx_freq",
  "rx_freq",
  "tx_sub_audio(CTCSS=freq/DCS=number)",
  "rx_sub_audio(CTCSS=freq/DCS=number)",
  "tx_power(H/M/L)",
  "bandwidth(12500/25000)",
  "scan(0=OFF/1=ON)",
  "talk around(0=OFF/1=ON)",
  "pre_de_emph_bypass(0=OFF/1=ON)",
  "sign(0=OFF/1=ON)",
  "tx_dis(0=OFF/1=ON)",
  "bclo(0=OFF/1=ON)",
  "mute(0=OFF/1=ON)",
  "rx_modulation(0=FM/1=AM)",
  "tx_modulation(0=FM/1=AM)",
] as const;

/** Mobile-side TX frequency in MHz, or null if not derivable. */
function mobileTxMhz(c: NormalizedChannel): number | null {
  return deriveTxMhz(c);
}

/**
 * Encode one tone side (tx or rx) to the VGC integer:
 *  - 0  = no tone
 *  - DCS code (1..777) = 3-digit octal as decimal int (D023 → 23)
 *  - CTCSS Hz×100 (≥1000) = e.g. 114.8 Hz → 11480
 */
function encodeTone(side: "tx" | "rx", c: NormalizedChannel): number {
  // CTCSS picks: explicit pack tone first, then SK6BA ctcss_tx (TX-side
  // access tone — also used as RX TSQL fallback when tone_raw=TSQL).
  let freq: number | null = null;
  if (side === "tx") {
    freq = c.rtone_freq ?? c.ctcss_tx ?? null;
  } else {
    freq = c.ctone_freq;
    if (freq == null) {
      const t = c.tone_raw.toUpperCase();
      if (t === "TSQL") freq = c.rtone_freq ?? c.ctcss_tx ?? null;
    }
  }
  if (freq != null) return Math.round(freq * 100);
  if (c.dtcs_code) {
    const n = parseInt(c.dtcs_code, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function encodeBandwidth(c: NormalizedChannel, s: VgcN76Settings): 12500 | 25000 {
  const m = (c.mode_pack || "").toUpperCase();
  if (m === "NFM") return 12500;
  if (m === "FM") return 25000;
  if (m === "AM") return 25000;
  // Övriga fall (inkl. SK6BA-rader utan mode_pack) använder targetens
  // default. Tidigare fanns en separat gren för analoga källrader, men
  // båda grenarna returnerade samma värde.
  return s.defaultBandwidth;
}

function isScanned(c: NormalizedChannel, s: VgcN76Settings): boolean {
  if (c.skip_raw === "S") return false;
  if (s.skipLinks) {
    const t = c.type.toLowerCase();
    if (t === "link" || t === "hotspot") return false;
  }
  return true;
}

function truncateTitle(raw: string, maxLen: number): { title: string; truncated: boolean } {
  const { name, truncated } = truncateName(raw, maxLen);
  return { title: name, truncated };
}

interface VgcRow {
  title: string;
  tx_freq: string;
  rx_freq: string;
  tx_sub: string;
  rx_sub: string;
  power: string;
  bandwidth: string;
  scan: string;
  talk_around: string;
  pre_de_emph: string;
  sign: string;
  tx_dis: string;
  bclo: string;
  mute: string;
  rx_mod: string;
  tx_mod: string;
}

const EMPTY_ROW: VgcRow = {
  title: "",
  tx_freq: "",
  rx_freq: "",
  tx_sub: "",
  rx_sub: "",
  power: "",
  bandwidth: "",
  scan: "",
  talk_around: "",
  pre_de_emph: "",
  sign: "",
  tx_dis: "",
  bclo: "",
  mute: "",
  rx_mod: "",
  tx_mod: "",
};

/**
 * VGC N76 is analog-FM-only. Drop any SK6BA row whose effective mode is
 * a digital variant (C4FM/D-Star/DMR/DMRplus/P25). Channel-pack rows pass
 * through unchanged — their `mode_pack` (AM/FM/NFM) is what drives the
 * VGC modulation/bandwidth columns.
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

export function toVgcN76Rows(
  channels: NormalizedChannel[],
  s: VgcN76Settings,
): { rows: VgcRow[]; warnings: Warning[] } {
  const warnings: Warning[] = [];
  let truncCount = 0;
  let polLost = 0;
  let unsupported = 0;

  const { kept, droppedCount: digitalSk6baDropped } = filterAnalogFmSk6ba(channels);
  if (digitalSk6baDropped > 0) {
    warnings.push({
      code: "vgc_digital_sk6ba_skipped",
      message: `${digitalSk6baDropped} kanal(er) från SK6BA hoppades över: VGC N76 stöder bara analog FM, digitala mode (C4FM/D-Star/DMR/DMRplus/P25) går inte att skriva i app-CSV:n.`,
    });
  }
  channels = kept;

  const rows: VgcRow[] = channels.map((c) => {
    const { title, truncated } = truncateTitle(c.generated_name_final, s.maxLength);
    if (truncated) truncCount++;

    if (c.dtcs_code && c.dtcs_polarity && c.dtcs_polarity !== "NN") polLost++;

    const m = (c.mode_pack || "").toUpperCase();
    if (m && m !== "NFM" && m !== "FM" && m !== "AM") unsupported++;

    const txMhz = mobileTxMhz(c);
    const rxMhz = c.rx_frequency;
    const am = isAm(c);

    return {
      title,
      tx_freq: txMhz != null ? String(mhzToHz(txMhz)) : "",
      rx_freq: rxMhz != null ? String(mhzToHz(rxMhz)) : "",
      tx_sub: String(encodeTone("tx", c)),
      rx_sub: String(encodeTone("rx", c)),
      power: s.defaultPower,
      bandwidth: String(encodeBandwidth(c, s)),
      scan: isScanned(c, s) ? "1" : "0",
      talk_around: "0",
      pre_de_emph: "0",
      sign: "1",
      tx_dis: c.duplex === "off" || c.rx_only || !c.tx_allowed ? "1" : "0",
      bclo: "0",
      mute: "0",
      rx_mod: am ? "1" : "0",
      tx_mod: am ? "1" : "0",
    };
  });

  if (truncCount > 0) {
    warnings.push({
      code: "vgc_title_truncated",
      message: `${truncCount} kanalnamn trunkerades till ${s.maxLength} tecken (VGC title-fält).`,
    });
  }
  if (polLost > 0) {
    warnings.push({
      code: "vgc_dcs_polarity_lost",
      message: `${polLost} kanal(er) har DCS med I-polaritet; VGC-CSV stödjer bara N-polaritet — info gick förlorad.`,
    });
  }
  if (unsupported > 0) {
    warnings.push({
      code: "vgc_unsupported_mode",
      message: `${unsupported} kanal(er) har mode som N76 inte stöder (USB/CW/DV); exporterade som ${s.defaultBandwidth === 12500 ? "NFM" : "FM"}.`,
    });
  }
  if (channels.length > s.channelsPerGroup) {
    warnings.push({
      code: "vgc_over_group_limit",
      message: `${channels.length} kanaler överstiger N76:s ${s.channelsPerGroup}/grupp — välj split-läget 'Per distrikt + chunka' i exportpanelen, eller dela upp manuellt innan import.`,
    });
  }

  // Optional padding to a fixed row count (some N76 templates expect a
  // fixed length and parse trailing empty rows as "unused slots").
  if (s.padToChannels != null && rows.length < s.padToChannels) {
    const pad = s.padToChannels - rows.length;
    for (let i = 0; i < pad; i++) rows.push({ ...EMPTY_ROW });
  }

  return { rows, warnings };
}

function rowsToCsv(rows: VgcRow[]): string {
  const data = rows.map((r) => [
    r.title,
    r.tx_freq,
    r.rx_freq,
    r.tx_sub,
    r.rx_sub,
    r.power,
    r.bandwidth,
    r.scan,
    r.talk_around,
    r.pre_de_emph,
    r.sign,
    r.tx_dis,
    r.bclo,
    r.mute,
    r.rx_mod,
    r.tx_mod,
  ]);
  return Papa.unparse({ fields: [...VGC_N76_COLUMNS], data });
}

/**
 * Fixed APRS row inserted at chunk slot 32 when `reserveAprsSlot32` is on.
 * 144.800 MHz simplex, FM wide (25 kHz), no subtones, NOT in scan list,
 * ROGER beep off (data/packet mode — beeps would be disruptive).
 */
function aprsVgcRow(s: VgcN76Settings): VgcRow {
  return {
    title: "APRS",
    tx_freq: "144800000",
    rx_freq: "144800000",
    tx_sub: "0",
    rx_sub: "0",
    power: s.defaultPower,
    bandwidth: "25000",
    scan: "0",
    talk_around: "0",
    pre_de_emph: "0",
    sign: "0",
    tx_dis: "0",
    bclo: "0",
    mute: "0",
    rx_mod: "0",
    tx_mod: "0",
  };
}

/**
 * Insert APRS row at slot 32 (0-indexed 31). For chunks with ≥31 user
 * rows it is spliced in at position 31 so any overflow user rows shift
 * down rather than being overwritten. For chunks with <31 user rows we
 * pad upp till index 31 med tomma rader så APRS alltid hamnar exakt på
 * slot 32 — det är vad inställningen lovar.
 */
function insertAprsRow(rows: VgcRow[], aprs: VgcRow): VgcRow[] {
  const SLOT_INDEX = VGC_N76_CHANNELS_PER_GROUP - 1; // 31
  if (rows.length >= SLOT_INDEX) {
    return [...rows.slice(0, SLOT_INDEX), aprs, ...rows.slice(SLOT_INDEX)];
  }
  const padded = [...rows];
  while (padded.length < SLOT_INDEX) padded.push({ ...EMPTY_ROW });
  padded.push(aprs);
  return padded;
}

export function exportVgcN76Csv(
  channels: NormalizedChannel[],
  s: VgcN76Settings,
): { csv: string; warnings: Warning[] } {
  if (!s.reserveAprsSlot32) {
    const { rows, warnings } = toVgcN76Rows(channels, s);
    return { csv: rowsToCsv(rows), warnings };
  }
  // With APRS-slot reservation we need to insert the APRS row before any
  // padding is applied, so pad inside this function instead of in
  // toVgcN76Rows.
  const innerSettings: VgcN76Settings = { ...s, padToChannels: null };
  const { rows, warnings } = toVgcN76Rows(channels, innerSettings);
  const withAprs = insertAprsRow(rows, aprsVgcRow(s));
  if (s.padToChannels != null && withAprs.length < s.padToChannels) {
    const pad = s.padToChannels - withAprs.length;
    for (let i = 0; i < pad; i++) withAprs.push({ ...EMPTY_ROW });
  }
  return { csv: rowsToCsv(withAprs), warnings };
}

export const VGC_N76_TARGET: ExportTarget<VgcN76Settings> = {
  id: "vgc-n76",
  label: "VGC N76 (app-CSV)",
  vendor: "VGC",
  description:
    "CSV importerbar direkt i VGC:s iOS/Android-app. 8-tecken kanalnamn, 32 kanaler/grupp, integer-Hz frekvenser.",
  filenameBase: "vgc-n76",
  fileExtension: "csv",
  txInhibit: "verified_tx_inhibit",
  limits: VGC_N76_LIMITS,
  defaultSettings: VGC_N76_DEFAULTS,
  settingsSchema: vgcN76SettingsSchema,
  resolveMaxNameLength: (s) => s.maxLength,
  previewMode: (c, s) => {
    // Digitala SK6BA-rader filtreras bort vid export — visa kanonisk signal
    // i previewen så det är tydligt att de inte hamnar i filen.
    const sig = channelSignalMode(c);
    if (c.source_type === "sk6ba" && sig && sig !== "FM") {
      return sig;
    }
    if (isAm(c)) return "AM";
    return encodeBandwidth(c, s) === 12500 ? "NFM" : "FM";
  },
  validate: (channels, s) => toVgcN76Rows(channels, s).warnings,
  export: (channels, s) => {
    const { csv, warnings } = exportVgcN76Csv(channels, s);
    return { filename: "vgc-n76.csv", content: csv, warnings };
  },
  exportMany: (channels: NormalizedChannel[], s: VgcN76Settings, split: SplitSettings) => {
    // When APRS slot 32 is reserved, each chunk holds at most 31 user
    // channels (slot 32 = APRS). Cap both the per-district chunkSize and
    // the packs hard cap so the 32nd user channel spills into the next
    // file instead of being overwritten by APRS.
    const userCap = s.reserveAprsSlot32
      ? Math.max(1, VGC_N76_CHANNELS_PER_GROUP - 1)
      : VGC_N76_CHANNELS_PER_GROUP;
    const effectiveSplit: SplitSettings =
      s.reserveAprsSlot32 && split.mode === "per_district_chunked"
        ? { ...split, chunkSize: Math.min(Math.max(1, split.chunkSize), userCap) }
        : split;
    return {
      files: buildSplitFiles(channels, effectiveSplit, {
        filenameBase: "vgc-n76",
        extension: "csv",
        renderChunk: (chunk) => exportVgcN76Csv(chunk, s).csv,
        // Channel-packs have no district and must always respect the
        // N76 per-group hardware limit (reduced by 1 when APRS slot is
        // reserved), even when the user picks per_district (un-chunked)
        // for repeaters.
        packsChunkSize: userCap,
      }),
      warnings: toVgcN76Rows(channels, s).warnings,
    };
  },
};

registerTarget(VGC_N76_TARGET);
