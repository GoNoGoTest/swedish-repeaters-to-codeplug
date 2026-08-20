import type { ChirpSettings, NormalizedChannel, Warning } from "../models";
import { formatFrequency } from "../frequency";

import { isAnalogToneMode, classifyChannel } from "../accessModes";
import { parseAccess } from "../tones";
import { canonicalizeMode, type ModeMap } from "./shared/modeMap";
import { renderCsv, type RowMapper } from "./shared/rowMapper";

export const CHIRP_COLUMNS = [
  "Location",
  "Name",
  "Frequency",
  "Duplex",
  "Offset",
  "Tone",
  "rToneFreq",
  "cToneFreq",
  "DtcsCode",
  "DtcsPolarity",
  "RxDtcsCode",
  "CrossMode",
  "Mode",
  "TStep",
  "Skip",
  "Power",
  "Comment",
  "URCALL",
  "RPT1CALL",
  "RPT2CALL",
  "DVCODE",
] as const;

type ChirpColumn = (typeof CHIRP_COLUMNS)[number];

// Technical CSV-import defaults. CHIRP/RMS parse these columns as float/int
// even when Tone is empty, so the columns must always carry parsable values.
// These are NOT user-facing access settings.
const DEFAULT_RTONE = "88.5";
const DEFAULT_CTONE = "88.5";
const DEFAULT_DTCS = "023";
const DEFAULT_DTCS_POL = "NN";
const DEFAULT_RX_DTCS = "023";
const DEFAULT_CROSS = "Tone->";
const DEFAULT_POWER = "10.0W";

/**
 * Canonical signal mode → CHIRP Generic CSV Mode token.
 * `null` = analog fallback (caller picks NFM vs FM from settings).
 * Tetra is intentionally `null`: Generic CSV cannot carry Tetra; we emit
 * the user's analog default and `chirpDigitalWarnings` does NOT flag it.
 */
const CHIRP_MODE_MAP: ModeMap = {
  FM: null,
  C4FM: "DN",
  "D-Star": "DV",
  DMR: "DMR",
  DMRplus: "DMR",
  P25: "P25",
  Tetra: null,
  CW: "CW",
};

function mapEffectiveMode(m: string): string | null {
  const canon = canonicalizeMode(m);
  if (canon == null) return null;
  return CHIRP_MODE_MAP[canon] ?? null;
}

export function resolveChirpMode(c: NormalizedChannel, fallback: string): string {
  // Channel-pack: kör mode_pack genom samma digitala mapping så att
  // pack-rader med mode_pack="C4FM"/"DMR+"/"DV" exporteras som DN/DMR/DV.
  // Analoga och sideband-pack-modes (USB/LSB/AM/CW/FM/NFM) returneras as-is
  // eftersom mapEffectiveMode returnerar null för dem.
  if (c.source_type === "channel_pack" && c.mode_pack) {
    const mapped = mapEffectiveMode(c.mode_pack);
    return mapped ?? c.mode_pack;
  }
  const mapped = mapEffectiveMode(c.mode_effective);
  return mapped ?? fallback;
}

/**
 * Returns a single non-blocking warning when the export contains at least
 * one channel with a digital effective mode. CHIRP Generic CSV can carry
 * Mode=DN/DV/DMR/P25 but full radio support depends on driver/model and
 * system-specific fields (talkgroup, color code, slot, Fusion params) are
 * not part of the Generic CSV schema.
 *
 * Använder `classifyChannel()` så att synonymer (DN, DV, DMR+, DMRPLUS) och
 * framtida digitala modes upptäcks konsekvent — utan separat allowlist.
 * Tetra hoppas över: CHIRP Generic CSV bär inte Tetra alls och target-
 * limits faller tillbaka till analog mode för Tetra-rader.
 */
export function chirpDigitalWarnings(channels: NormalizedChannel[]): Warning[] {
  const has = channels.some((c) => {
    const cls = classifyChannel(c);
    return cls === "dmr" || cls === "c4fm" || cls === "dstar" || cls === "p25";
  });
  if (!has) return [];
  return [
    {
      code: "chirp_digital_partial",
      message:
        "CHIRP Generic CSV kan bära digitala mode-värden (DN, DV, DMR, P25), men " +
        "fullt stöd beror på radiomodell och CHIRP-drivrutin. Systemspecifika " +
        "inställningar som DMR talkgroup, color code, timeslot eller Fusion-" +
        "parametrar ingår inte och kan behöva kompletteras manuellt.",
    },
  ];
}

function resolveTStep(c: NormalizedChannel, fallback: number): number {
  if (c.source_type === "channel_pack" && c.tstep != null) return c.tstep;
  return fallback;
}

function resolveDuplexAndOffset(c: NormalizedChannel): { duplex: string; offset: string } {
  // TX-kontraktet vinner över frekvensdata: en must_block_tx-kanal skrivs
  // alltid som Duplex=off, även om raden bär en explicit tx_frequency.
  if (c.tx_intent === "must_block_tx") {
    return { duplex: "off", offset: c.offset.toFixed(6) };
  }
  if (c.duplex === "split" && c.tx_frequency != null) {
    return { duplex: "split", offset: c.tx_frequency.toFixed(6) };
  }
  if (c.duplex === "off") {
    return { duplex: "off", offset: c.offset.toFixed(6) };
  }
  return { duplex: c.duplex, offset: c.offset.toFixed(6) };
}

function digitalMetadataComment(c: NormalizedChannel): string {
  const cls = classifyChannel(c);
  const parts: string[] = [];
  if (cls === "dmr") {
    const dmr: string[] = [];
    if (c.dmr_color_code != null) dmr.push(`CC=${c.dmr_color_code}`);
    if (c.dmr_timeslot != null) dmr.push(`TS=${c.dmr_timeslot}`);
    if (c.dmr_talkgroup) dmr.push(`TG=${c.dmr_talkgroup}`);
    if (dmr.length) parts.push(`DMR ${dmr.join(" ")}`);
  } else if (cls === "c4fm") {
    const c4: string[] = [];
    if (c.c4fm_dg_id_tx != null) c4.push(`TX=${String(c.c4fm_dg_id_tx).padStart(2, "0")}`);
    if (c.c4fm_dg_id_rx != null) c4.push(`RX=${String(c.c4fm_dg_id_rx).padStart(2, "0")}`);
    if (c4.length) parts.push(`C4FM ${c4.join(" ")}`);
  } else if (cls === "p25") {
    if (c.p25_nac) parts.push(`P25 NAC=${c.p25_nac}`);
  }
  // "analog tone ignored for <MODE>" — när digital kanal hade analog tone i
  // den råa accessen som vi nu slänger.
  if (cls !== "analog" && cls !== "none") {
    const a = parseAccess(c.digital_access_raw);
    if (a.ctcss != null || a.uses1750 || a.carrier || a.dcs != null) {
      parts.push(`analog tone ignored for ${(c.mode_effective || "").toUpperCase()}`);
    }
  }
  return parts.join(" | ");
}

function resolveComment(c: NormalizedChannel): string {
  const base: string[] = [];
  if (c.source_type === "channel_pack") {
    if (c.comment) base.push(c.comment);
    if (c.license_note) base.push(c.license_note);
    if (c.source) base.push(`src=${c.source}`);
  } else if (c.comment) {
    base.push(c.comment);
  }
  const digital = digitalMetadataComment(c);
  if (digital) base.push(digital);
  return base.join(" | ");
}

interface ToneFields {
  Tone: string;
  rToneFreq: string;
  cToneFreq: string;
  DtcsCode: string;
  DtcsPolarity: string;
  RxDtcsCode: string;
  CrossMode: string;
}

const DEFAULT_TONE_FIELDS: ToneFields = {
  Tone: "",
  rToneFreq: DEFAULT_RTONE,
  cToneFreq: DEFAULT_CTONE,
  DtcsCode: DEFAULT_DTCS,
  DtcsPolarity: DEFAULT_DTCS_POL,
  RxDtcsCode: DEFAULT_RX_DTCS,
  CrossMode: DEFAULT_CROSS,
};

function resolveToneFields(c: NormalizedChannel): ToneFields {
  // Digital kanaler får aldrig bära analog tone i Tone-kolumnen.
  // resolveComment lägger till strukturerad digital metadata + en
  // "analog tone ignored" not när källraden hade en analog access.
  if (!isAnalogToneMode(c)) {
    return { ...DEFAULT_TONE_FIELDS };
  }
  if (c.source_type === "channel_pack") {
    const t = (c.tone_raw || "").trim().toUpperCase();
    if (t === "TSQL") {
      const f = c.ctone_freq ?? c.rtone_freq ?? c.ctcss_tx;
      if (f == null) return { ...DEFAULT_TONE_FIELDS };
      return {
        ...DEFAULT_TONE_FIELDS,
        Tone: "TSQL",
        rToneFreq: f.toFixed(1),
        cToneFreq: f.toFixed(1),
      };
    }
    if (t === "DTCS" || t === "DCS") {
      if (!c.dtcs_code) return { ...DEFAULT_TONE_FIELDS };
      return {
        ...DEFAULT_TONE_FIELDS,
        Tone: "DTCS",
        DtcsCode: c.dtcs_code,
        DtcsPolarity: c.dtcs_polarity || "NN",
      };
    }
    if (t === "TONE" || (t === "" && c.rtone_freq != null)) {
      const f = c.rtone_freq ?? c.ctcss_tx;
      if (f == null) return { ...DEFAULT_TONE_FIELDS };
      return { ...DEFAULT_TONE_FIELDS, Tone: "Tone", rToneFreq: f.toFixed(1) };
    }
    return { ...DEFAULT_TONE_FIELDS };
  }
  if (c.ctcss_tx != null) {
    return { ...DEFAULT_TONE_FIELDS, Tone: "Tone", rToneFreq: c.ctcss_tx.toFixed(1) };
  }
  if (c.dtcs_code) {
    return {
      ...DEFAULT_TONE_FIELDS,
      Tone: "Cross",
      DtcsCode: c.dtcs_code,
      DtcsPolarity: c.dtcs_polarity || "NN",
      CrossMode: "DTCS->",
    };
  }
  return { ...DEFAULT_TONE_FIELDS };
}

/**
 * Per-channel row builder for CHIRP Generic CSV. Used both by `toChirpRows`
 * (legacy callers that want plain row objects) and `renderCsv` via the
 * `CHIRP_ROW_MAPPER` below.
 */
function buildChirpRow(
  c: NormalizedChannel,
  ctx: { index: number; settings: ChirpSettings },
): Record<ChirpColumn, string> {
  const s = ctx.settings;
  const skip = (s.skipLinks && c.type.toLowerCase() === "link") || c.skip_raw === "S" ? "S" : "";
  const { duplex, offset } = resolveDuplexAndOffset(c);
  const tone = resolveToneFields(c);
  return {
    Location: String(s.startLocation + ctx.index),
    Name: c.generated_name_final,
    Frequency: c.rx_frequency != null ? formatFrequency(c.rx_frequency) : "",
    Duplex: duplex,
    Offset: offset,
    Tone: tone.Tone,
    rToneFreq: tone.rToneFreq,
    cToneFreq: tone.cToneFreq,
    DtcsCode: tone.DtcsCode,
    DtcsPolarity: tone.DtcsPolarity,
    RxDtcsCode: tone.RxDtcsCode,
    CrossMode: tone.CrossMode,
    Mode: resolveChirpMode(c, s.mode),
    TStep: resolveTStep(c, s.tStep).toFixed(2),
    Skip: skip,
    Power: DEFAULT_POWER,
    Comment: resolveComment(c),
    URCALL: "",
    RPT1CALL: "",
    RPT2CALL: "",
    DVCODE: "",
  };
}

export const CHIRP_ROW_MAPPER: RowMapper<ChirpSettings, ChirpColumn> = {
  columns: CHIRP_COLUMNS,
  toRow: buildChirpRow,
};

export function toChirpRows(channels: NormalizedChannel[], s: ChirpSettings) {
  return channels.map((c, index) => buildChirpRow(c, { index, settings: s }));
}

export function exportChirpCsv(channels: NormalizedChannel[], s: ChirpSettings): string {
  return renderCsv(channels, CHIRP_ROW_MAPPER, s);
}
