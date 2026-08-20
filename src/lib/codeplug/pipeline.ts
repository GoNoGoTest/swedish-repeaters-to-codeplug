import type { NormalizedChannel, RawRow, Settings, Warning, NamingSettings } from "./models";
import { parseNumberLoose } from "./importers/sk6ba";
import { parseAccess, parseDigitalAccess } from "./tones";
import { parseShift } from "./frequency";
import { applyFilters } from "./filters";
import { buildName, resolveCollisions } from "./naming";
import { sortChannels } from "./sorting";
import { applyFreqDedupe } from "./dedupe";
import { DEFAULT_PACK_NAMING } from "./defaults";
import { deriveRegion } from "./region";
import { parseModes } from "./modes";
import { applyModeAccessSubset, classifyChannel } from "./accessModes";

/**
 * Type-värden i SK6BA-exporten som ligger utanför appens scope
 * (inte programmerbara repeatrar/kanaler). Filtreras bort tidigt så de
 * inte räknas in i "Saknar RX-frekvens" eller dyker upp i Typ-filtret.
 */
export const OUT_OF_SCOPE_TYPES = new Set<string>(["uW QTH"]);

function emptyPackFields() {
  return {
    pack_id: "",
    service: "",
    category: "",
    tags: [] as string[],
    label: "",
    name_hint: "",
    tx_frequency: null as number | null,
    mode_pack: "",
    tstep: null as number | null,
    tone_raw: "",
    rtone_freq: null as number | null,
    ctone_freq: null as number | null,
    dtcs_code: "",
    dtcs_polarity: "",
    skip_raw: "",
    tx_allowed: true,
    rx_only: false,
    license_note: "",
    source: "",
    source_url: "",
    inferred_from_range: false,
  };
}

/** Defaults för analog/digital access. Skrivs alltid i normalize() innan
 *  subset körs. Plockas ut i en helper så `normalize` förblir kort. */
function emptyAccessFields() {
  return {
    analog_carrier_open: false,
    dmr_color_code: null as number | null,
    dmr_timeslot: null as number | null,
    dmr_talkgroup: "",
    c4fm_dg_id_tx: null as number | null,
    c4fm_dg_id_rx: null as number | null,
    p25_nac: "",
    digital_access_raw: "",
    access_unknown_tokens: [] as string[],
  };
}

export function normalize(rows: RawRow[]): NormalizedChannel[] {
  return rows.map((r, idx) => {
    const warnings: Warning[] = [];
    const output = parseNumberLoose(r.output);
    if (r.output && parseNumberLoose(r.output) == null) {
      warnings.push({ code: "invalid_output", message: `Ogiltig output: ${r.output}` });
    }
    if (output == null) warnings.push({ code: "missing_output", message: "Saknad outputfrekvens" });

    const shift = parseShift(r.tx_shift);
    if (shift.unclear)
      warnings.push({ code: "unclear_shift", message: `Oklar tx_shift: ${r.tx_shift}` });

    const access = parseAccess(r.access);
    const digital = parseDigitalAccess(r.access);
    // ctcss_and_dcs är mode-beroende och appliceras efter expandModes
    // (se applyPostExpansionAccessWarnings nedan).

    const lat = parseNumberLoose(r.lat);
    const lng = parseNumberLoose(r.lng);
    if (lat == null || lng == null) {
      warnings.push({ code: "missing_coords", message: "Saknade koordinater" });
    }

    const modeRaw = (r.mode ?? "").toString();
    const district = (r.district ?? "").toString().trim();
    const type = (r.type ?? "").toString().trim();
    const network = (r.network ?? "").toString().trim();
    const city = (r.city ?? "").toString().trim();
    const call = (r.call ?? "").toString().trim();
    const channel = (r.channel ?? "").toString().trim();
    const band = (r.band ?? "").toString().trim();
    const locator = (r.locator ?? "").toString().trim();

    const commentParts = [
      call,
      channel,
      city,
      district ? `D${district}` : "",
      type,
      network,
      r.access ? `access=${r.access}` : "",
      locator ? `loc=${locator}` : "",
    ].filter(Boolean);

    return {
      source_type: "sk6ba",
      // Placeholder — sätts av applyTxIntent() efter RX-only-policyn.
      tx_intent: "normal" as const,
      source_row: idx + 2,
      source_id: (r.id ?? "").toString(),
      type,
      status: (r.status ?? "").toString().trim(),
      mode_raw: modeRaw,
      mode_effective: "",
      // Källradens egenskap: erbjuder raden analog FM? Härleds ur de
      // parsade källmoderna så att "FM / C4FM" ger true på BÅDA de
      // expanderade varianterna (expandModes kopierar fältet vidare).
      source_supports_analog_fm: parseModes(modeRaw).includes("FM"),
      band,
      district,
      region: deriveRegion(district, call),
      city,
      call,
      channel,
      network,
      network_id: (r.network_id ?? "").toString(),
      access_raw: (r.access ?? "").toString(),
      rx_frequency: output,
      tx_shift_raw: (r.tx_shift ?? "").toString(),
      tx_shift: shift.shift,
      shift_unclear: shift.unclear,
      duplex: shift.duplex,
      offset: shift.offset,
      ctcss_tx: access.ctcss,
      uses_1750: access.uses1750,
      lat,
      lng,
      locator,
      comment: commentParts.join(" | "),
      ...emptyPackFields(),
      ...emptyAccessFields(),
      // Re-apply DCS over the empty pack defaults so SK6BA rows with
      // access=DCS xxx export as Tone=Cross in the CHIRP exporter.
      dtcs_code: access.dcs ?? "",
      dtcs_polarity: access.dcs ? "NN" : "",
      analog_carrier_open: access.carrier,
      dmr_color_code: digital.dmr.colorCode,
      dmr_timeslot: digital.dmr.timeSlot,
      dmr_talkgroup: digital.dmr.talkGroup,
      c4fm_dg_id_tx: digital.c4fm.dgIdTx,
      c4fm_dg_id_rx: digital.c4fm.dgIdRx,
      p25_nac: digital.p25.nac,
      access_unknown_tokens: digital.unknownTokens,
      generated_name_full: "",
      generated_name_final: "",
      collided: false,
      warnings,
    } satisfies NormalizedChannel;
  });
}

/**
 * Per-mode expansion for SK6BA rows. A row like `mode_raw="FM / C4FM"` and
 * `selectedModes=["FM","C4FM"]` yields two channels — one per supported
 * mode — each with `mode_effective` set to the canonical mode.
 *
 * Rules:
 *  - `parseModes(mode_raw) === []` → keep the row as-is with
 *    `mode_effective = ""`. The user can still filter it out via other
 *    filter settings; we don't drop unknown modes silently.
 *  - `selectedModes === []` → no mode gating; emit one channel per parsed
 *    mode.
 *  - `selectedModes` set but `parsed ∩ selectedModes === []` → drop the
 *    row entirely (mode filter excludes it).
 *
 * Channel-pack rows pass through unchanged (they already have a single
 * `mode_effective` set by the channel-pack importer).
 */
export function expandModes(
  channels: NormalizedChannel[],
  selectedModes: string[],
): NormalizedChannel[] {
  const out: NormalizedChannel[] = [];
  const sel = new Set(selectedModes);
  for (const c of channels) {
    if (c.source_type !== "sk6ba") {
      out.push(c);
      continue;
    }
    const parsed = parseModes(c.mode_raw);
    if (parsed.length === 0) {
      out.push({ ...c, mode_effective: "" });
      continue;
    }
    const kept = sel.size === 0 ? parsed : parsed.filter((m) => sel.has(m));
    if (kept.length === 0) continue;
    for (const m of kept) {
      out.push({ ...c, mode_effective: m, warnings: [...c.warnings] });
    }
  }
  return out;
}

export interface PipelineInput {
  sk6baRows: RawRow[];
  packChannels?: NormalizedChannel[]; // already-selected channel pack rows
  settings: Settings;
  /**
   * Effective max channel-name length. Comes from the active export target
   * (e.g. ChirpSettings.maxLength for chirp-generic). Defaults to 6 so
   * legacy callers and tests work without wiring a target.
   */
  maxNameLength?: number;
}

export interface PipelineResult {
  channels: NormalizedChannel[];
  filteredOut: number;
  unresolvedCollisions: number;
  totalInput: number;
  packCount: number;
  sk6baCount: number;
  duplicateStop: boolean;
  /** SK6BA-rader med tolkbar RX-frekvens (innan filter/mode-expansion). */
  withRx: number;
  /** Antal rader som droppades av frekvensdedupe-policyn. */
  droppedByDedupe: number;
  /** Antal rader vars `type` ligger i OUT_OF_SCOPE_TYPES (t.ex. "uW QTH"). */
  outOfScope: number;
}

function applyRxOnlyPolicy(channels: NormalizedChannel[], settings: Settings): NormalizedChannel[] {
  const out: NormalizedChannel[] = [];
  for (const ch of channels) {
    const isRxOnly = ch.source_type === "channel_pack" && (ch.rx_only || !ch.tx_allowed);
    if (!isRxOnly) {
      out.push(ch);
      continue;
    }
    switch (settings.packs.rxOnlyPolicy) {
      case "skip":
        continue;
      case "block_tx":
        out.push({
          ...ch,
          duplex: "off",
          warnings: [
            ...ch.warnings,
            {
              code: "rx_only_blocked",
              message: "RX-only: TX spärrad enligt target-konvention",
            } satisfies Warning,
          ],
        });
        break;
      case "mark":
      default:
        out.push({
          ...ch,
          comment: ch.comment ? `RX-ONLY | ${ch.comment}` : "RX-ONLY",
          warnings: [
            ...ch.warnings,
            {
              code: "rx_only_marked",
              message: "RX-only: markerad i Comment, exporteras som vanlig frekvens",
            } satisfies Warning,
          ],
        });
        break;
    }
  }
  return out;
}

/**
 * Lägger till `ctcss_and_dcs` på analoga SK6BA-rader där både CTCSS och DCS
 * faktiskt hittats i access-fältet. Kallas efter `applyModeAccessSubset`
 * så digitala rader (där analog access redan nollats) aldrig får varningen.
 *
 * Notera: saknad analog access (tom access-sträng) varnas inte längre — tomt
 * fält tolkas i praktiken som öppen squelch och är inte ett kvalitetsproblem.
 */
function applyPostExpansionAccessWarnings(channels: NormalizedChannel[]): NormalizedChannel[] {
  return channels.map((c) => {
    if (c.source_type !== "sk6ba") return c;
    if (classifyChannel(c) !== "analog") return c;
    if (c.ctcss_tx != null && c.dtcs_code !== "") {
      return {
        ...c,
        warnings: [
          ...c.warnings,
          {
            code: "ctcss_and_dcs",
            message: "Både CTCSS och DCS hittades; CTCSS valdes för analog CHIRP-export.",
          } satisfies Warning,
        ],
      };
    }
    return c;
  });
}

export function runPipeline(input: PipelineInput): PipelineResult {
  const { sk6baRows, packChannels = [], settings, maxNameLength = 6 } = input;
  const totalInput = sk6baRows.length + packChannels.length;
  const normalized = normalize(sk6baRows);
  const inScope = normalized.filter((c) => !OUT_OF_SCOPE_TYPES.has(c.type));
  const outOfScope = normalized.length - inScope.length;
  const exportable = inScope.filter((c) => c.rx_frequency != null);
  const withRx = exportable.length;
  // Expand multi-mode SK6BA rows into one channel per selected mode.
  // Channel-pack rows pass through unchanged.
  const expanded = expandModes(exportable, settings.filter.modes ?? []);
  const sk6baFiltered = applyFilters(expanded, settings.filter);
  const sk6baSorted = sortChannels(sk6baFiltered, settings.sort);

  // Channel-pack rows come from a module-level cache and are reused across
  // renders. The pipeline below is pure — every stage returns new channel
  // objects rather than mutating in place — so no defensive cloning or
  // per-run reset of warnings/name fields is needed.
  const validPacks = packChannels.filter((c) => c.rx_frequency != null);
  const packWithPolicy = applyRxOnlyPolicy(validPacks, settings);
  // Validate split: needs tx_frequency or it can't export properly.
  // Saknas tx_frequency degraderar vi raden till säker simplex i stället
  // för att lämna duplex="split" vidare till exportern, där den annars
  // skulle bli "Duplex=split, Offset=0.000000".
  const packValidated: NormalizedChannel[] = packWithPolicy.map((ch) =>
    ch.duplex === "split" && ch.tx_frequency == null
      ? {
          ...ch,
          duplex: "" as const,
          offset: 0,
          warnings: [
            ...ch.warnings,
            {
              code: "pack_split_unsupported",
              message: "Split-kanal saknar tx_frequency; exporteras som simplex",
            } satisfies Warning,
          ],
        }
      : ch,
  );

  // Combine according to placement
  let combined: NormalizedChannel[];
  if (settings.packs.placement === "off" || packValidated.length === 0) {
    combined = sk6baSorted;
  } else if (settings.packs.placement === "prepend") {
    combined = [...packValidated, ...sk6baSorted];
  } else {
    combined = [...sk6baSorted, ...packValidated];
  }

  // Mode-medveten subset: nolla analog access på digitala kanaler och vice
  // versa. Körs på alla kanaler (även packs) så invarianten "DMR-kanal har
  // inte ctcss_tx" alltid håller, oavsett källa.
  combined = combined.map(applyModeAccessSubset);

  // Mode-beroende access-varningar appliceras efter subset. Tidigare lades
  // dessa i normalize() innan mode-expansion, vilket gjorde att en DMR-rad
  // med "CC 1" felaktigt varnades för "saknad analog access".
  combined = applyPostExpansionAccessWarnings(combined);

  // Freq dedupe across the whole set
  const dedupe = applyFreqDedupe(combined, settings.packs.freqDupePolicy);
  combined = dedupe.channels;
  const droppedByDedupe = dedupe.dropped.length;

  // Resolve naming per channel using the correct rules
  // (sk6ba = settings.naming, channel_pack = per-pack override or DEFAULT_PACK_NAMING)
  const namingFor = (ch: NormalizedChannel): NamingSettings => {
    if (ch.source_type === "sk6ba") return settings.naming;
    const override = settings.packs.selection[ch.pack_id]?.naming;
    return override ?? DEFAULT_PACK_NAMING;
  };

  const named = combined.map((ch) => {
    const n = namingFor(ch);
    const { full, clipped } = buildName(ch, n, maxNameLength);
    const final = clipped || "NONAME";
    const extraWarnings: Warning[] = clipped
      ? []
      : [{ code: "empty_name", message: "Tomt kanalnamn" }];
    return {
      ...ch,
      generated_name_full: full,
      generated_name_final: final,
      collided: false,
      warnings: extraWarnings.length ? [...ch.warnings, ...extraWarnings] : ch.warnings,
    };
  });

  // Collisions are resolved globally with the repeater naming policy
  // (we just need a deterministic suffix scheme — maxLength comes from the active export target).
  const { channels: resolved, unresolved } = resolveCollisions(
    named,
    settings.naming,
    maxNameLength,
  );
  const finalChannels: NormalizedChannel[] = resolved.map((ch) => {
    if (!ch.collided) return ch;
    if (ch.warnings.some((w) => w.code === "name_collision")) return ch;
    return {
      ...ch,
      warnings: [
        ...ch.warnings,
        { code: "name_collision", message: "Namnkollision" } satisfies Warning,
      ],
    };
  });

  // filteredOut mäts som "antal källrader som inte producerade någon
  // utgångskanal". Räkna unika SK6BA source_row som överlevde + antal
  // packs som överlevde, så att mode-expansion (1 SK6BA-rad → flera
  // kanaler) inte ger negativ eller nonsens-siffra.
  const usedSk6baRows = new Set<number>();
  let usedPacks = 0;
  for (const c of finalChannels) {
    if (c.source_type === "sk6ba") usedSk6baRows.add(c.source_row);
    else if (c.source_type === "channel_pack") usedPacks++;
  }
  const filteredOut = sk6baRows.length - usedSk6baRows.size + (packChannels.length - usedPacks);

  return {
    channels: finalChannels,
    filteredOut,
    unresolvedCollisions: unresolved,
    totalInput,
    packCount: finalChannels.filter((c) => c.source_type === "channel_pack").length,
    sk6baCount: finalChannels.filter((c) => c.source_type === "sk6ba").length,
    duplicateStop: dedupe.stopped,
    withRx,
    droppedByDedupe,
    outOfScope,
  };
}
