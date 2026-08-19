import type { NormalizedChannel } from "../models";
import { deriveRegion } from "../region";

/**
 * Test fixture builder. Returns a fully-populated `NormalizedChannel` with
 * sane defaults, overridable via `over`. The default profile is a Swedish
 * 2 m repeater (SK6BA RV48 → 145.6 MHz with -0.6 MHz shift).
 *
 * Named variants (`makeAnalogRepeater`, `makeC4fmRepeater`, `makePackChannel`)
 * are thin wrappers — they only pre-set the fields that distinguish that
 * category, otherwise everything funnels through `makeChannel`.
 */
export function makeChannel(over: Partial<NormalizedChannel> = {}): NormalizedChannel {
  const district = over.district ?? "6";
  const region = over.region ?? deriveRegion(district, over.call);
  return {
    source_type: "sk6ba",
    source_row: 2,
    source_id: "x",
    type: "Repeater",
    status: "QRV",
    mode_raw: "FM",
    mode_effective: "FM",
    source_supports_analog_fm: true,
    band: "2",
    city: "Borås",
    call: "SK6BA",
    channel: "RV48",
    network: "",
    network_id: "",
    access_raw: "",
    rx_frequency: 145.6,
    tx_shift_raw: "-0.6",
    tx_shift: -0.6,
    shift_unclear: false,
    duplex: "-",
    offset: 0.6,
    ctcss_tx: null,
    uses_1750: false,
    analog_carrier_open: false,
    dmr_color_code: null,
    dmr_timeslot: null,
    dmr_talkgroup: "",
    c4fm_dg_id_tx: null,
    c4fm_dg_id_rx: null,
    p25_nac: "",
    digital_access_raw: "",
    access_unknown_tokens: [],
    lat: 57.7,
    lng: 12.9,
    locator: "",
    comment: "",
    pack_id: "",
    service: "",
    category: "",
    tags: [],
    label: "",
    name_hint: "",
    tx_frequency: null,
    mode_pack: "",
    tstep: null,
    tone_raw: "",
    rtone_freq: null,
    ctone_freq: null,
    dtcs_code: "",
    dtcs_polarity: "",
    skip_raw: "",
    tx_allowed: true,
    rx_only: false,
    license_note: "",
    source: "",
    source_url: "",
    inferred_from_range: false,
    generated_name_full: "",
    generated_name_final: "",
    collided: false,
    warnings: [],
    ...over,
    district,
    region,
  };
}

/** Analog FM 2 m repeater preset (matches `makeChannel` default). */
export function makeAnalogRepeater(over: Partial<NormalizedChannel> = {}): NormalizedChannel {
  return makeChannel({ mode_raw: "FM", mode_effective: "FM", source_supports_analog_fm: true, ...over });
}

/** C4FM/Fusion 2 m repeater preset. */
export function makeC4fmRepeater(over: Partial<NormalizedChannel> = {}): NormalizedChannel {
  return makeChannel({
    mode_raw: "C4FM",
    mode_effective: "C4FM",
    source_supports_analog_fm: false,
    ...over,
  });
}

/**
 * Channel-pack row preset. Default is a marine VHF entry with
 * `source_type: "channel_pack"`, `pack_id: "marine_vhf"`, and `mode_pack: "FM"`.
 */
export function makePackChannel(over: Partial<NormalizedChannel> = {}): NormalizedChannel {
  return makeChannel({
    source_type: "channel_pack",
    pack_id: "marine_vhf",
    category: "marine",
    service: "marine",
    mode_pack: "FM",
    duplex: "",
    offset: 0,
    source_supports_analog_fm: true,
    ...over,
  });
}
