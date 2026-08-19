import Papa from "papaparse";
import type { NormalizedChannel, Warning } from "../models";
import { parseNumberLoose } from "./sk6ba";
import { parseDigitalAccess } from "../tones";
import { UNKNOWN_REGION } from "../region";
import { packRowSchema, papaErrorToWarning, zodIssueToWarning, type ParseWarning } from "./schemas";

export const PACK_COLUMNS = [
  "pack_id",
  "source_id",
  "enabled_default",
  "service",
  "band",
  "category",
  "tags",
  "type",
  "label",
  "channel",
  "name_hint",
  "rx_frequency",
  "tx_frequency",
  "duplex",
  "offset",
  "mode",
  "tstep",
  "tone",
  "rtone_freq",
  "ctone_freq",
  "dtcs_code",
  "dtcs_polarity",
  "skip",
  "tx_allowed",
  "rx_only",
  "license_note",
  "comment",
  "source",
  "source_url",
  "inferred_from_range",
] as const;

const REQUIRED_COLUMNS = ["pack_id", "source_id", "rx_frequency"];

export interface ParsedPackChannel extends NormalizedChannel {
  enabled_default: boolean;
}

export interface PackParseResult {
  packId: string;
  channels: ParsedPackChannel[];
  fileName: string;
  headerWarnings: string[];
  /** Icke-fatala PapaParse-fel och schema-warnings för enskilda rader. */
  parseWarnings: ParseWarning[];
}

function parseBool(v: string | undefined, fieldName: string, warnings: Warning[]): boolean {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  if (!s) return false;
  if (s === "true" || s === "1" || s === "yes" || s === "y") return true;
  if (s === "false" || s === "0" || s === "no" || s === "n") return false;
  warnings.push({
    code: "pack_invalid_boolean",
    message: `Ogiltigt booleanvärde i ${fieldName}: ${v}`,
  });
  return false;
}

function parseTags(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split("|")
    .map((t) => t.trim())
    .filter(Boolean);
}

function deriveBandFromFreq(rx: number | null): string {
  if (rx == null) return "";
  if (rx >= 144 && rx <= 148) return "2m";
  if (rx >= 430 && rx <= 440) return "70cm";
  return "";
}

export function parseChannelPackCsv(text: string, fileName: string): PackParseResult {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  const columns = result.meta.fields ?? [];
  const headerWarnings: string[] = [];
  for (const req of REQUIRED_COLUMNS) {
    if (!columns.includes(req)) headerWarnings.push(`Saknad obligatorisk kolumn: ${req}`);
  }
  const parseWarnings: ParseWarning[] = (result.errors ?? []).map((e) =>
    papaErrorToWarning({ row: e.row, code: e.code ?? e.type, message: e.message }),
  );
  const seenIds = new Set<string>();
  const channels: ParsedPackChannel[] = [];
  let packId = "";

  result.data.forEach((r, idx) => {
    const warnings: Warning[] = [];
    const check = packRowSchema.safeParse(r);
    if (!check.success) {
      const issue = check.error.issues[0];
      if (issue) parseWarnings.push(zodIssueToWarning(idx, issue));
    }
    const rowPackId = (r.pack_id ?? "").trim();
    if (rowPackId && !packId) packId = rowPackId;
    if (!rowPackId) warnings.push({ code: "pack_missing_required", message: "Saknad pack_id" });

    const sourceId = (r.source_id ?? "").trim();
    if (!sourceId) warnings.push({ code: "pack_missing_required", message: "Saknad source_id" });
    else if (seenIds.has(sourceId)) {
      warnings.push({
        code: "pack_duplicate_source_id",
        message: `Dubblett source_id: ${sourceId}`,
      });
    } else seenIds.add(sourceId);

    const rxRaw = (r.rx_frequency ?? "").trim();
    const rx = parseNumberLoose(rxRaw);
    if (!rxRaw) warnings.push({ code: "pack_missing_required", message: "Saknad rx_frequency" });
    else if (rx == null)
      warnings.push({ code: "pack_invalid_frequency", message: `Ogiltig rx_frequency: ${rxRaw}` });

    const tx = parseNumberLoose(r.tx_frequency);
    const offset = parseNumberLoose(r.offset) ?? 0;
    const duplexRaw = (r.duplex ?? "").trim().toLowerCase();
    let duplex: NormalizedChannel["duplex"] = "";
    if (duplexRaw === "+" || duplexRaw === "-" || duplexRaw === "split" || duplexRaw === "off") {
      duplex = duplexRaw as NormalizedChannel["duplex"];
    } else if (duplexRaw && duplexRaw !== "simplex") {
      warnings.push({ code: "pack_missing_required", message: `Okänt duplex: ${r.duplex}` });
    }
    // Auto-detect split if tx differs from rx and duplex not set
    if (!duplex && rx != null && tx != null && Math.abs(tx - rx) > 1e-6) {
      duplex = "split";
    }

    const mode = (r.mode ?? "").trim().toUpperCase();
    // Utökad lista: digital pack-rader (DMR/C4FM/P25/DV) får finnas så att
    // digital access kan kopplas till en pack-kanal utan att kasta
    // pack_unsupported_mode-varning.
    const knownModes = [
      "NFM",
      "FM",
      "USB",
      "LSB",
      "CW",
      "AM",
      "DV",
      "DIG",
      "DMR",
      "DMRPLUS",
      "DMR+",
      "C4FM",
      "P25",
    ];
    if (mode && !knownModes.includes(mode)) {
      warnings.push({ code: "pack_unsupported_mode", message: `Okänt mode: ${r.mode}` });
    }

    const label = (r.label ?? "").trim();
    const channelCode = (r.channel ?? "").trim();
    const nameHint = (r.name_hint ?? "").trim();
    if (!label && !channelCode && !nameHint) {
      warnings.push({
        code: "pack_no_name_source",
        message: "Saknar både label, channel och name_hint",
      });
    }

    const tags = parseTags(r.tags);
    const enabled_default = parseBool(r.enabled_default, "enabled_default", warnings);
    const tx_allowed =
      (r.tx_allowed ?? "").trim() === "" ? true : parseBool(r.tx_allowed, "tx_allowed", warnings);
    const rx_only = parseBool(r.rx_only, "rx_only", warnings);
    const inferred_from_range = parseBool(r.inferred_from_range, "inferred_from_range", warnings);

    const band = (r.band ?? "").trim() || deriveBandFromFreq(rx);
    const category = (r.category ?? "").trim();
    const service = (r.service ?? "").trim();
    const licenseNote = (r.license_note ?? "").trim();
    const comment = (r.comment ?? "").trim();

    // Konservativ digital-access-parsning: vi rör inte de etablerade analoga
    // pack-kolumnerna (tone/rtone_freq/ctone_freq/dtcs_*). parseDigitalAccess
    // körs ENDAST om tone-strängen tydligt innehåller digitala tokens —
    // annars hamnar TSQL/Tone/DTCS som unknownTokens, vilket vore brus.
    const toneRaw = (r.tone ?? "").trim();
    const DIGITAL_TONE_RE =
      /(?:\bCC\s*=?\s*\d{1,2}\b|\bTS\s*=?\s*[12]\b|\bTG\s*=?\s*[\w-]+\b|\bNAC\s*=?\s*[0-9A-F]{3}\b|\b(?:TX|RX)\s*=?\s*\d{2}\b)/i;
    const digital = DIGITAL_TONE_RE.test(toneRaw) ? parseDigitalAccess(toneRaw) : null;

    const ch: ParsedPackChannel = {
      source_type: "channel_pack",
      source_row: idx + 2,
      source_id: sourceId,
      type: (r.type ?? "").trim(),
      status: "",
      mode_raw: mode || "FM",
      mode_effective: mode || "FM",
      source_supports_analog_fm: /^(N?FM)$/.test(mode),
      band,
      district: "",
      region: UNKNOWN_REGION,
      city: "",
      call: "",
      channel: channelCode,
      network: "",
      network_id: "",
      access_raw: toneRaw,
      rx_frequency: rx,
      tx_shift_raw: "",
      tx_shift: null,
      shift_unclear: false,
      duplex,
      offset,
      ctcss_tx: parseNumberLoose(r.rtone_freq),
      uses_1750: false,
      analog_carrier_open: false,
      dmr_color_code: digital?.dmr.colorCode ?? null,
      dmr_timeslot: digital?.dmr.timeSlot ?? null,
      dmr_talkgroup: digital?.dmr.talkGroup ?? "",
      c4fm_dg_id_tx: digital?.c4fm.dgIdTx ?? null,
      c4fm_dg_id_rx: digital?.c4fm.dgIdRx ?? null,
      p25_nac: digital?.p25.nac ?? "",
      digital_access_raw: digital ? toneRaw : "",
      access_unknown_tokens: digital?.unknownTokens ?? [],
      lat: null,
      lng: null,
      locator: "",
      comment,
      pack_id: rowPackId,
      service,
      category,
      tags,
      label,
      name_hint: nameHint,
      tx_frequency: tx,
      mode_pack: mode,
      tstep: parseNumberLoose(r.tstep),
      tone_raw: (r.tone ?? "").trim(),
      rtone_freq: parseNumberLoose(r.rtone_freq),
      ctone_freq: parseNumberLoose(r.ctone_freq),
      dtcs_code: (r.dtcs_code ?? "").trim(),
      dtcs_polarity: (r.dtcs_polarity ?? "").trim(),
      skip_raw: (r.skip ?? "").trim(),
      tx_allowed,
      rx_only,
      license_note: licenseNote,
      source: (r.source ?? "").trim(),
      source_url: (r.source_url ?? "").trim(),
      inferred_from_range,
      generated_name_full: "",
      generated_name_final: "",
      collided: false,
      warnings,
      enabled_default,
    };
    channels.push(ch);
  });

  return { packId: packId || fileName, channels, fileName, headerWarnings, parseWarnings };
}

export interface PackFilterCriteria {
  bands: string[]; // empty = all
  categories: string[]; // empty = all
  tags: string[]; // empty = all
  useEnabledDefault: boolean;
  manualSourceIds?: string[]; // if defined non-empty, overrides
}

export function selectPackChannels(
  channels: ParsedPackChannel[],
  c: PackFilterCriteria,
): ParsedPackChannel[] {
  if (c.manualSourceIds && c.manualSourceIds.length > 0) {
    const set = new Set(c.manualSourceIds);
    return channels.filter((ch) => set.has(ch.source_id));
  }
  return channels.filter((ch) => {
    if (c.useEnabledDefault && !ch.enabled_default) return false;
    if (c.bands.length && !c.bands.includes(ch.band)) return false;
    if (c.categories.length && !c.categories.includes(ch.category)) return false;
    if (c.tags.length && !ch.tags.some((t) => c.tags.includes(t))) return false;
    return true;
  });
}
