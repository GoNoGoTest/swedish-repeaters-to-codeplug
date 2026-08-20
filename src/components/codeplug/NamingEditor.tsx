import { useMemo } from "react";
import type { NamingSettings, NormalizedChannel } from "@/lib/codeplug/models";
import { buildName } from "@/lib/codeplug/naming";
import { deriveRegion } from "@/lib/codeplug/region";
import { Field, Hint, NumberField } from "./common";

const REPEATER_EXAMPLES: Partial<NormalizedChannel>[] = [
  {
    source_type: "sk6ba",
    type: "Repeater",
    network: "",
    band: "2",
    district: "6",
    city: "Borås",
    call: "SK6BA",
    channel: "RV48",
  },
  {
    source_type: "sk6ba",
    type: "Repeater",
    network: "SvxLink",
    band: "70",
    district: "6",
    city: "Örnsköldsvik",
    call: "SK6RJW",
    channel: "RU368",
  },
  {
    source_type: "sk6ba",
    type: "Link",
    network: "",
    band: "2",
    district: "3",
    city: "Östersund/Frösön",
    call: "SM3XYZ",
    channel: "RV56",
  },
];

const PACK_EXAMPLES: Partial<NormalizedChannel>[] = [
  {
    source_type: "channel_pack",
    service: "PMR446",
    category: "Simplex",
    label: "PMR 1",
    name_hint: "PMR1",
    channel: "1",
    band: "70",
  },
  {
    source_type: "channel_pack",
    service: "Marine VHF",
    category: "Duplex",
    label: "M16",
    name_hint: "M16",
    channel: "16",
    band: "2",
  },
  {
    source_type: "channel_pack",
    service: "Amateur 2m",
    category: "Simplex",
    label: "Calling",
    name_hint: "S20",
    channel: "S20",
    band: "2",
  },
];

function makeExampleChannel(over: Partial<NormalizedChannel>): NormalizedChannel {
  const district = over.district ?? "";
  return {
    source_type: "sk6ba",
    tx_intent: "normal",
    source_row: 0,
    source_id: "ex",
    type: "Repeater",
    status: "QRV",
    mode_raw: "FM",
    mode_effective: "FM",
    source_supports_analog_fm: true,
    band: "",
    district,
    region: over.region ?? deriveRegion(district, over.call),
    city: "",
    call: "",
    channel: "",
    network: "",
    network_id: "",
    access_raw: "",
    rx_frequency: null,
    tx_shift_raw: "",
    tx_shift: null,
    shift_unclear: false,
    duplex: "",
    offset: 0,
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
    lat: null,
    lng: null,
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
  };
}

function NamingPreview({
  naming,
  kind,
  maxLength,
  sampleChannels,
}: {
  naming: NamingSettings;
  kind: "repeater" | "pack";
  maxLength: number;
  sampleChannels?: NormalizedChannel[];
}) {
  const examples = useMemo(() => {
    if (sampleChannels && sampleChannels.length > 0) {
      const n = sampleChannels.length;
      const idxs = n <= 3 ? Array.from({ length: n }, (_, i) => i) : [0, Math.floor(n / 2), n - 1];
      return idxs.map((i) => {
        const ch = sampleChannels[i];
        const { full, clipped } = buildName(ch, naming, maxLength);
        const label =
          `${ch.service || ""} ${ch.name_hint || ch.channel || ch.label || ""}`
            .trim()
            .slice(0, 24) || "—";
        return { label, full, clipped };
      });
    }
    const seeds = kind === "repeater" ? REPEATER_EXAMPLES : PACK_EXAMPLES;
    return seeds.map((seed) => {
      const ch = makeExampleChannel(seed);
      const { full, clipped } = buildName(ch, naming, maxLength);
      const label =
        kind === "repeater"
          ? `${seed.city || seed.call || "?"}${seed.channel ? `/${seed.channel}` : ""}`
          : `${seed.service || ""} ${seed.name_hint || seed.label || ""}`.trim();
      return { label, full, clipped };
    });
  }, [naming, kind, maxLength, sampleChannels]);
  return (
    <div className="mt-3">
      <div className="text-xs text-muted-foreground mb-1">
        Förhandsvisning (max {maxLength} tecken)
      </div>
      <div className="flex flex-wrap gap-2">
        {examples.map((ex, i) => (
          <div key={i} className="rounded border border-border bg-muted/40 px-2 py-1">
            <div className="text-[10px] text-muted-foreground leading-tight">{ex.label}</div>
            <div
              className="font-mono text-xs leading-tight"
              title={ex.full !== ex.clipped ? `Full: ${ex.full}` : undefined}
            >
              {ex.clipped || <span className="italic text-muted-foreground">(tom)</span>}
              {ex.full !== ex.clipped && <span className="text-muted-foreground"> ✂</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function NamingEditor({
  value,
  onChange,
  tokens,
  hint,
  previewKind,
  maxLength,
  showCityMaxLength = true,
  sampleChannels,
}: {
  value: NamingSettings;
  onChange: (n: NamingSettings) => void;
  tokens: string[];
  hint?: string;
  previewKind?: "repeater" | "pack";
  maxLength: number;
  showCityMaxLength?: boolean;
  sampleChannels?: NormalizedChannel[];
}) {
  const upd = (patch: Partial<NamingSettings>) => onChange({ ...value, ...patch });
  return (
    <div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="md:col-span-2">
          <div className="text-xs text-muted-foreground mb-1">
            Komponenter (klicka för att lägga till/ta bort, i tur och ordning)
          </div>
          <div className="flex flex-wrap gap-1 mb-2 min-h-[28px]">
            {value.components.map((t, i) => (
              <button
                key={`${t}-${i}`}
                type="button"
                onClick={() => upd({ components: value.components.filter((_, j) => j !== i) })}
                className="rounded border border-primary bg-primary px-2 py-0.5 text-xs font-mono text-primary-foreground"
              >
                {t} ×
              </button>
            ))}
            {value.components.length === 0 && (
              <span className="text-xs text-muted-foreground italic">
                Inga komponenter — kanalens fallback (name_hint / channel / label) används.
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {tokens.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => upd({ components: [...value.components, t] })}
                className="rounded border border-border px-2 py-0.5 text-xs font-mono"
              >
                + {t}
              </button>
            ))}
          </div>
          {hint && <Hint>{hint}</Hint>}
        </div>
        <div className="space-y-2">
          {showCityMaxLength && (
            <NumberField
              label="Max längd ort"
              value={value.cityMaxLength}
              onChange={(v) => upd({ cityMaxLength: v })}
            />
          )}
          <Field label="Separator" hint="Tecken mellan tokens. Default: -">
            <input
              value={value.separator}
              onChange={(e) => upd({ separator: e.target.value })}
              className="w-full rounded border border-input bg-background px-2 py-1 text-sm font-mono"
              placeholder="-"
            />
          </Field>
        </div>
        <div className="md:col-span-3 grid gap-3 md:grid-cols-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={value.transliterate}
              onChange={(e) => upd({ transliterate: e.target.checked })}
            />
            Translitterera svenska tecken (Å→A, Ä→A, Ö→O)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={value.uppercase}
              onChange={(e) => upd({ uppercase: e.target.checked })}
            />
            VERSALER
          </label>
          <Field label="Vid namnkollision">
            <select
              value={value.collisionPolicy}
              onChange={(e) =>
                upd({ collisionPolicy: e.target.value as NamingSettings["collisionPolicy"] })
              }
              className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
            >
              <option value="numeric_suffix">Numeriskt suffix (1, 2, 3…)</option>
              <option value="last_char_suffix">Bokstavssuffix (A, B, C…)</option>
            </select>
          </Field>
        </div>
      </div>
      {previewKind && (
        <NamingPreview
          naming={value}
          kind={previewKind}
          maxLength={maxLength}
          sampleChannels={sampleChannels}
        />
      )}
    </div>
  );
}
