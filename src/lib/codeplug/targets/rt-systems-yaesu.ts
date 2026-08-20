import { z } from "zod";
import type { NormalizedChannel, SplitSettings, Warning } from "../models";
import { registerTarget } from "./registry";
import { buildSplitFiles } from "./split";
import { deriveTxMhz } from "../exporters/shared/frequency";
import { assertTxIntentSerializable } from "../txIntent";
import { truncateName as sharedTruncateName } from "../exporters/shared/name";
import type { ExportTarget, HardwareLimits } from "./types";

/**
 * RT Systems Yaesu CSV (radio model TBD — first iteration of an
 * upcoming "RT Systems Yaesu ???" family target).
 *
 * The header is reproduced byte-for-byte from a real RT Systems export
 * (see user-uploads/2026-06-21.csv). Notable quirks:
 *  - one leading empty column (row number, 1-indexed)
 *  - one trailing empty column (Papa's `Comment,` artefact in the source)
 *  - Operating Mode uses Yaesu's wire names: "FM", "DN" (C4FM/Fusion),
 *    "AM", "DW", "RTTY", … We only emit "FM" and "DN" in this iteration.
 *  - Offset Frequency carries a unit: "600 kHz", "5 MHz", ""
 *  - Tone Mode: "None" | "Tone" | "T Sql" | "DCS"
 */

export type RtSystemsPower = "Low" | "Medium" | "High";
export type RtSystemsAms = "Y" | "N";

export interface RtSystemsYaesuSettings {
  /** Max length of the Name column. RT Systems Yaesu radios typically 16. */
  maxLength: number;
  /** Default Tx Power written on every row. */
  defaultPower: RtSystemsPower;
  /** Default tuning step value (the literal that ends up in the Step column). */
  defaultStep: string;
  /** Default User CTCSS index (0–50). RT Systems integer field. */
  defaultUserCtcss: number;
  /** Default AMS column value. AMS = Auto Mode Select (Yaesu Fusion). */
  defaultAms: RtSystemsAms;
  /** Skip Link/Hotspot channels during scan. */
  skipLinks: boolean;
  /** Start number for the leading row-index column. */
  startNumber: number;
  /**
   * Pad output to this many channel rows (header excluded). Empty rows
   * keep the leading index and all 21 columns. Set to 0 to disable.
   * Reference RT Systems exports for FTM-510 are padded to 999 rows.
   */
  padToRows: number;
}

export const RT_SYSTEMS_YAESU_DEFAULTS: RtSystemsYaesuSettings = {
  maxLength: 16,
  defaultPower: "Medium",
  defaultStep: "12.5 kHz",
  defaultUserCtcss: 12,
  defaultAms: "N",
  skipLinks: false,
  startNumber: 1,
  padToRows: 999,
};

export const rtSystemsYaesuSettingsSchema: z.ZodType<RtSystemsYaesuSettings> = z.object({
  maxLength: z.number().int().min(1).max(64),
  defaultPower: z.enum(["Low", "Medium", "High"]),
  defaultStep: z.string().min(1),
  defaultUserCtcss: z.number().int().min(0).max(50),
  defaultAms: z.enum(["Y", "N"]),
  skipLinks: z.boolean(),
  startNumber: z.number().int().min(0),
  padToRows: z.number().int().min(0),
});

const RT_SYSTEMS_YAESU_LIMITS: HardwareLimits = {
  maxNameLength: 16,
  // Yaesu wire mode names.
  supportedModes: ["FM", "DN", "AM"],
  // Canonical modes from KNOWN_MODES that we actually emit usefully.
  supportedSignalModes: ["FM", "C4FM"],
  supportsSplit: true,
  supportsCtcss: true,
  supportsDcs: true,
};

/**
 * Header line as it appears in the reference RT Systems export. Note the
 * leading and trailing commas — those are real empty columns the radio
 * software round-trips. We build CSV manually instead of using
 * Papa.unparse to keep the empty header names byte-exact.
 */
export const RT_SYSTEMS_YAESU_HEADER_FIELDS = [
  "",
  "Receive Frequency",
  "Transmit Frequency",
  "Offset Frequency",
  "Offset Direction",
  "Operating Mode",
  "AMS",
  "Name",
  "Tone Mode",
  "CTCSS",
  "DCS",
  "RX DGID",
  "TX DGID",
  "User CTCSS",
  "Tx Power",
  "Skip",
  "Step",
  "Clock Shift",
  "Memory Group",
  "Comment",
  "",
] as const;

function escapeCsv(value: string): string {
  // RFC 4180-ish: only quote if needed.
  if (value === "") return "";
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function joinRow(fields: readonly string[]): string {
  return fields.map(escapeCsv).join(",");
}

function truncateName(raw: string, maxLen: number): { name: string; truncated: boolean } {
  return sharedTruncateName(raw, maxLen);
}

function mobileTxMhz(c: NormalizedChannel): number | null {
  return deriveTxMhz(c);
}

function formatOffsetFrequency(c: NormalizedChannel): string {
  if (c.duplex === "") return "";
  if (c.duplex === "split") {
    if (c.tx_frequency != null && c.rx_frequency != null) {
      const diff = Math.abs(c.tx_frequency - c.rx_frequency);
      return formatOffsetKhz(diff);
    }
    return "";
  }
  const off = Math.abs(c.offset);
  if (off === 0) return "";
  return formatOffsetKhz(off);
}

function formatOffsetKhz(offsetMhz: number): string {
  // 0.6 MHz → "600 kHz", 2 MHz → "2.00000 MHz", 7.6 MHz → "7600 kHz".
  // Integer MHz offsets are written with 5 decimals to match the RT Systems
  // reference export (e.g. "2.00000 MHz" for the 70cm band). Non-integer
  // values fall back to kHz so we never lose precision.
  if (offsetMhz >= 1 && Number.isInteger(offsetMhz)) {
    return `${offsetMhz.toFixed(5)} MHz`;
  }
  const khz = Math.round(offsetMhz * 1000 * 100) / 100;
  return `${khz} kHz`;
}

function formatOffsetDirection(c: NormalizedChannel): string {
  if (c.duplex === "+") return "Plus";
  if (c.duplex === "-") return "Minus";
  if (c.duplex === "split") return "Split";
  return "Simplex";
}

function operatingMode(c: NormalizedChannel): { mode: string; unsupported: boolean } {
  const m = (c.mode_effective || "").toUpperCase();
  if (m === "FM" || m === "") return { mode: "FM", unsupported: false };
  if (m === "C4FM") return { mode: "DN", unsupported: false };
  // Fallback for D-Star/DMR/etc. — Yaesu can't natively use these so we
  // emit FM and surface a warning at the export level.
  return { mode: "FM", unsupported: true };
}

interface ToneFields {
  toneMode: "None" | "Tone" | "T Sql" | "DCS";
  ctcss: string;
  dcs: string;
}

function resolveTone(c: NormalizedChannel, mode: string): ToneFields {
  // C4FM (Operating Mode "DN") channels must never carry an analog tone,
  // even when the source row has CTCSS/DCS. The radio interprets Tone Mode
  // on DN channels as analog squelch and would mute incoming digital audio.
  if (mode === "DN") {
    return { toneMode: "None", ctcss: "100.0", dcs: "023" };
  }
  // CTCSS-TX from SK6BA or per-pack rtone_freq wins.
  const ctcssFreq = c.rtone_freq ?? c.ctcss_tx ?? null;
  const t = (c.tone_raw || "").toUpperCase();

  if (t === "TSQL" && ctcssFreq != null) {
    return { toneMode: "T Sql", ctcss: ctcssFreq.toFixed(1), dcs: "023" };
  }
  if (ctcssFreq != null) {
    return { toneMode: "Tone", ctcss: ctcssFreq.toFixed(1), dcs: "023" };
  }
  if (c.dtcs_code) {
    const digits = c.dtcs_code.padStart(3, "0").slice(-3);
    return { toneMode: "DCS", ctcss: "100.0", dcs: digits };
  }
  return { toneMode: "None", ctcss: "100.0", dcs: "023" };
}

function isScanned(c: NormalizedChannel, s: RtSystemsYaesuSettings): boolean {
  if (c.skip_raw === "S") return false;
  if (s.skipLinks) {
    const t = c.type.toLowerCase();
    if (t === "link" || t === "hotspot") return false;
  }
  return true;
}

export function toRtSystemsYaesuRow(
  c: NormalizedChannel,
  index: number,
  s: RtSystemsYaesuSettings,
): { fields: string[]; truncated: boolean; unsupportedMode: boolean } {
  const { name, truncated } = truncateName(c.generated_name_final, s.maxLength);
  const txMhz = mobileTxMhz(c);
  const rxMhz = c.rx_frequency;
  const { mode, unsupported } = operatingMode(c);
  const tone = resolveTone(c, mode);

  const fields = [
    String(index),
    rxMhz != null ? rxMhz.toFixed(5) : "",
    txMhz != null ? txMhz.toFixed(5) : "",
    formatOffsetFrequency(c),
    formatOffsetDirection(c),
    mode,
    s.defaultAms,
    name,
    tone.toneMode,
    tone.ctcss,
    tone.dcs,
    "0",
    "0",
    String(s.defaultUserCtcss),
    s.defaultPower,
    isScanned(c, s) ? "Scan" : "Skip",
    s.defaultStep,
    "N",
    "N",
    c.comment ?? "",
    "",
  ];
  return { fields, truncated, unsupportedMode: unsupported };
}

export function exportRtSystemsYaesuCsv(
  channels: NormalizedChannel[],
  s: RtSystemsYaesuSettings,
): { csv: string; warnings: Warning[] } {
  const warnings: Warning[] = [];
  let truncCount = 0;
  let unsupportedCount = 0;

  // RX-only-hantering sker i pipelinen (settings.packs.rxOnlyPolicy):
  //  - skip  → raderna är redan bortfiltrerade innan vi når hit
  //  - mark  → raderna kommer in med "RX-ONLY" i Comment och exporteras normalt
  // RT-systems-targetet exponerar inte "block_tx" i UI, så vi behöver inte
  // hantera en duplex=off-väg här.
  const exportable: NormalizedChannel[] = channels;

  const lines: string[] = [joinRow(RT_SYSTEMS_YAESU_HEADER_FIELDS)];
  exportable.forEach((c, i) => {
    const { fields, truncated, unsupportedMode } = toRtSystemsYaesuRow(c, s.startNumber + i, s);
    if (truncated) truncCount++;
    if (unsupportedMode) unsupportedCount++;
    lines.push(joinRow(fields));
  });
  // Pad with empty rows to match the reference RT Systems export shape
  // (typically 999 channel slots for FTM-510). Empty rows preserve the
  // leading row-index and all 21 columns so the radio software accepts
  // the file verbatim.
  const padTarget = Math.max(0, s.padToRows | 0);
  if (exportable.length < padTarget) {
    const emptyTail = new Array(RT_SYSTEMS_YAESU_HEADER_FIELDS.length - 1).fill("");
    for (let i = exportable.length; i < padTarget; i++) {
      lines.push(joinRow([String(s.startNumber + i), ...emptyTail]));
    }
  }
  // RT Systems exports include a trailing newline.
  const csv = lines.join("\r\n") + "\r\n";

  if (truncCount > 0) {
    warnings.push({
      code: "rt_name_truncated",
      message: `${truncCount} kanalnamn trunkerades till ${s.maxLength} tecken (RT Systems Name-fält).`,
    });
  }
  if (unsupportedCount > 0) {
    warnings.push({
      code: "rt_unsupported_mode",
      message: `${unsupportedCount} kanal(er) har mode som Yaesu inte stöder (D-Star/DMR/…); exporterade som Operating Mode=FM.`,
    });
  }
  return { csv, warnings };
}

export const RT_SYSTEMS_YAESU_TARGET: ExportTarget<RtSystemsYaesuSettings> = {
  id: "rt-systems-yaesu-generic",
  label: "RT-Systems Yaesu FTM-510",
  vendor: "RT Systems",
  description:
    "CSV för RT Systems programmeringsverktyg till Yaesu FTM-510. Stödjer FM och C4FM (Operating Mode FM/DN).",
  filenameBase: "rt-systems-yaesu",
  fileExtension: "csv",
  txInhibit: "no_tx_inhibit",
  limits: RT_SYSTEMS_YAESU_LIMITS,
  defaultSettings: RT_SYSTEMS_YAESU_DEFAULTS,
  settingsSchema: rtSystemsYaesuSettingsSchema,
  resolveMaxNameLength: (s) => s.maxLength,
  previewMode: (c) => operatingMode(c).mode,
  validate: (channels, s) => exportRtSystemsYaesuCsv(channels, s).warnings,
  export: (channels, s) => {
    assertTxIntentSerializable(channels, "no_tx_inhibit", "rt-systems-yaesu-generic");
    const { csv, warnings } = exportRtSystemsYaesuCsv(channels, s);
    return { filename: "rt-systems-yaesu.csv", content: csv, warnings };
  },
  exportMany: (channels: NormalizedChannel[], s: RtSystemsYaesuSettings, split: SplitSettings) => {
    assertTxIntentSerializable(channels, "no_tx_inhibit", "rt-systems-yaesu-generic");
    return {
    files: buildSplitFiles(channels, split, {
      filenameBase: "rt-systems-yaesu",
      extension: "csv",
      renderChunk: (chunk) => exportRtSystemsYaesuCsv(chunk, s).csv,
    }),
      warnings: exportRtSystemsYaesuCsv(channels, s).warnings,
    };
  },

};

registerTarget(RT_SYSTEMS_YAESU_TARGET);
