import { useMemo } from "react";
import type {
  ChirpSettings,
  FreqDupePolicy,
  PackPlacement,
  RxOnlyPolicy,
  Settings,
  SplitMode,
  SplitSettings,
  HomeDistrictSort,
  NormalizedChannel,
} from "@/lib/codeplug/models";
import type {
  VgcN76Settings,
  NicsureRt880Settings,
  RtSystemsYaesuSettings,
} from "@/lib/codeplug/targets";
import {
  NICSURE_ZONE_DIMENSIONS,
  buildZoneLegend,
  formatZoneLegend,
  type NicsureZoneDimensionId,
} from "@/lib/codeplug/targets/nicsure-rt880";
import { requireTarget } from "@/lib/codeplug/targets";
import { isValidMaidenhead } from "@/lib/codeplug/maidenhead";
import { Field, Hint, NumberField, SectionLabel } from "./common";

// eslint-disable-next-line react-refresh/only-export-components
export function rxOnlyHintForTarget(targetId: string): string {
  switch (targetId) {
    case "chirp-generic":
      return "'Spärra TX' sätter Duplex=off i CHIRP. 'Markera' lägger till RX-ONLY i Comment och exporterar som vanlig frekvens.";
    case "vgc-n76":
      return "'Spärra TX' sätter tx_dis=1 i VGC-CSV:n. 'Markera' lägger RX-ONLY i Comment.";
    case "nicsure-rt880":
      return "'Spärra TX' sätter TX_Power=N/T och TX=RX i RT-880-CSV:n. 'Markera' lägger RX-ONLY i Comment.";
    case "rt-systems-yaesu-generic":
      return "RT Systems Yaesu: vi saknar dokumentation om hur RT Systems markerar RX-only i CSV:n. Default är att hoppa över RX-only-kanaler. 'Markera' exporterar dem som vanlig frekvens med RX-ONLY i Comment — kontrollera då i radion att TX är spärrad.";
    default:
      return "Hur ska kanaler markerade som mottagning-bara hanteras vid export?";
  }
}

export function RxOnlyExportNote({
  channels,
  targetId,
  rxOnlyPolicy,
}: {
  channels: NormalizedChannel[];
  targetId: string;
  rxOnlyPolicy: RxOnlyPolicy;
}) {
  // Standard-bannern visas när det faktiskt finns RX-only-kanaler i exporten.
  // På RT-systems når RX-only-rader exporten endast om policy=mark (skip har
  // redan filtrerat bort dem i pipelinen). Den separata "RX-only hoppas över"-
  // notisen för RT-systems renderas av index-routen som har tillgång till
  // pre-policy-källan.
  void rxOnlyPolicy;
  void targetId;
  const rxOnlyCount = channels.filter(isRxOnlyChannel).length;
  if (rxOnlyCount === 0) return null;
  return (
    <p className="mt-2 rounded-md border border-amber-400/40 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200">
      Du exporterar <strong>{rxOnlyCount}</strong> {rxOnlyCount === 1 ? "kanal" : "kanaler"} som är
      RX-only — verifiera i din radio att du inte kan sända på dessa kanaler.
    </p>
  );
}


export function RtSystemsRxOnlySkippedNote({
  sourceHasRxOnly,
  targetId,
  rxOnlyPolicy,
}: {
  sourceHasRxOnly: boolean;
  targetId: string;
  rxOnlyPolicy: RxOnlyPolicy;
}) {
  if (targetId !== "rt-systems-yaesu-generic") return null;
  if (rxOnlyPolicy !== "skip") return null;
  if (!sourceHasRxOnly) return null;
  return (
    <p className="mt-2 rounded-md border border-amber-400/40 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200">
      Appen vet inte hur RX-only ska sättas i RT-systems — RX-only-kanaler hoppas över.
    </p>
  );
}

function VgcN76Panel({
  settings,
  update,
}: {
  settings: VgcN76Settings;
  update: (patch: Record<string, unknown>) => void;
}) {
  return (
    <div className="border-t border-border pt-4">
      <SectionLabel>VGC N76-fält</SectionLabel>
      <Hint>
        VGC:s iOS/Android-app importerar denna CSV direkt — inga andra verktyg behövs. Frekvenser
        skrivs i Hz, CTCSS som Hz×100, DCS som decimal-form av oktal-koden. DCS-polaritet (N/I) går
        inte att uttrycka i filen och defaultas till N.
      </Hint>
      <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-5 mt-2">
        <NumberField
          label="Max längd title"
          value={settings.maxLength}
          onChange={(v) => update({ maxLength: v })}
          hint="N76 visar 8 tecken i kanallistan. Längre namn trunkeras och flaggas som varning."
        />
        <Field label="Default sändareffekt" hint="H/M/L. Per-rad-override stöds inte i v1.">
          <select
            value={settings.defaultPower}
            onChange={(e) =>
              update({ defaultPower: e.target.value as VgcN76Settings["defaultPower"] })
            }
            className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
          >
            <option value="H">H (hög)</option>
            <option value="M">M (medel)</option>
            <option value="L">L (låg)</option>
          </select>
        </Field>
        <Field
          label="Default bandbredd"
          hint="Används när kanalpaket inte anger NFM/FM. 12500 = smal, 25000 = bred."
        >
          <select
            value={settings.defaultBandwidth}
            onChange={(e) =>
              update({
                defaultBandwidth: Number(e.target.value) as VgcN76Settings["defaultBandwidth"],
              })
            }
            className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
          >
            <option value={12500}>12500 (NFM)</option>
            <option value={25000}>25000 (FM)</option>
          </select>
        </Field>
        <NumberField
          label="Kanaler per grupp"
          value={settings.channelsPerGroup}
          onChange={(v) => update({ channelsPerGroup: v })}
          hint="N76 grupperar i klumpar om 32. Vid 'En enda fil' visas bara en varning om gränsen överskrids — välj 'Per distrikt + chunka' nedan för att dela upp filen automatiskt."
        />
        <NumberField
          label="Padda till antal rader"
          value={settings.padToChannels ?? 0}
          onChange={(v) => update({ padToChannels: v > 0 ? v : null })}
          hint="0 = ingen padding. Sätt t.ex. 32 om appens template kräver fast längd."
        />
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={settings.skipLinks}
          onChange={(e) => update({ skipLinks: e.target.checked })}
        />
        Hoppa över länkar och hotspots vid skanning
        <span className="text-xs text-muted-foreground">(sätter scan=0 på Link/Hotspot-rader)</span>
      </label>
      <label className="mt-2 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={settings.reserveAprsSlot32}
          onChange={(e) => update({ reserveAprsSlot32: e.target.checked })}
        />
        <span>
          Lägg till APRS på kanalplats 32 i varje chunk
          <span className="ml-2 block text-xs text-muted-foreground">
            Reserverar plats 32 för APRS 144.800 FM 25 kHz. Kanaler som annars skulle hamnat på
            plats 32 flyttas till nästa chunk.
          </span>
        </span>
      </label>
    </div>
  );
}

function NicsureRt880Panel({
  settings,
  update,
  channels,
}: {
  settings: NicsureRt880Settings;
  update: (patch: Record<string, unknown>) => void;
  channels: NormalizedChannel[];
}) {
  const dims = settings.zoneDimensions;
  const legend = useMemo(() => buildZoneLegend(channels, dims), [channels, dims]);
  const legendText = useMemo(() => formatZoneLegend(legend), [legend]);

  const setSlot = (slotIdx: number, value: NicsureZoneDimensionId | "") => {
    // Slot list as (dim | null) of fixed length 4.
    const arr: Array<NicsureZoneDimensionId | null> = [0, 1, 2, 3].map((i) => dims[i] ?? null);
    if (value === "") {
      arr[slotIdx] = null;
    } else {
      // Keep slots unique: if this dimension already lives in another slot, clear it there first.
      for (let i = 0; i < arr.length; i++) if (i !== slotIdx && arr[i] === value) arr[i] = null;
      arr[slotIdx] = value;
    }
    // Drop trailing nulls so zoneDimensions stays a tight ordered list.
    const cleaned: NicsureZoneDimensionId[] = [];
    for (const d of arr) if (d !== null) cleaned.push(d);
    update({ zoneDimensions: cleaned });
  };

  const copyLegend = async () => {
    try {
      await navigator.clipboard.writeText(legendText);
    } catch {
      /* noop */
    }
  };

  return (
    <div className="border-t border-border pt-4">
      <SectionLabel>Nicsure RT-880-fält</SectionLabel>
      <Hint>
        CSV för Nicsures custom firmware till Radtel RT-880. 19 kolumner, frekvenser i MHz (5
        decimaler), DCS-polaritet (N/I) bevaras, fyra slot-kolumner används som zon-/gruppmedlemskap
        i radion.
      </Hint>
      <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-4 mt-2">
        <NumberField
          label="Startnummer (Channel_Num)"
          value={settings.startLocation}
          onChange={(v) => update({ startLocation: v })}
          hint="Numret på första kanalraden. Övriga rader inkrementeras med 1."
        />
        <NumberField
          label="Max längd Name"
          value={settings.maxLength}
          onChange={(v) => update({ maxLength: v })}
          hint="Längre namn trunkeras. RT-880 visar längre strängar än de flesta handapparater, så 32 är säkert."
        />
        <Field
          label="Default sändareffekt"
          hint="Skrivs på varje rad. Per-rad-override stöds inte i v1."
        >
          <select
            value={settings.defaultPower}
            onChange={(e) =>
              update({ defaultPower: e.target.value as NicsureRt880Settings["defaultPower"] })
            }
            className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
          >
            <option value="Very High">Very High</option>
            <option value="High">High</option>
            <option value="Medium">Medium</option>
            <option value="Low">Low</option>
          </select>
        </Field>
        <Field label="Default bandbredd" hint="Används när kanalen saknar NFM/FM-hint.">
          <select
            value={settings.defaultBandwidth}
            onChange={(e) =>
              update({
                defaultBandwidth: e.target.value as NicsureRt880Settings["defaultBandwidth"],
              })
            }
            className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
          >
            <option value="Wide">Wide (25 kHz)</option>
            <option value="Narrow">Narrow (12.5 kHz)</option>
          </select>
        </Field>
      </div>

      <div className="mt-4">
        <SectionLabel>Zon-mappning (Slot1–Slot4)</SectionLabel>
      </div>
      <Hint>
        Varje slot grupperar på en dimension. Nicsure skriver en bokstav (A–Z) per värde — dessa
        bokstäver är bara löpnummer och du namnger dem själv i Nicsure RMS-appen enligt legenden
        nedan.
      </Hint>
      <div className="mt-2 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Field key={i} label={`Slot${i + 1} — dimension`}>
            <select
              value={dims[i] ?? ""}
              onChange={(e) => setSlot(i, e.target.value as NicsureZoneDimensionId | "")}
              className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
            >
              <option value="">(tom)</option>
              {NICSURE_ZONE_DIMENSIONS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            <Hint>
              {dims[i]
                ? NICSURE_ZONE_DIMENSIONS.find((d) => d.id === dims[i])?.description
                : "Lämna tom för att skriva mellanslag i denna slot."}
            </Hint>
          </Field>
        ))}
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between">
          <SectionLabel>Zon-legend (klistra in i Nicsure RMS)</SectionLabel>
          <button
            type="button"
            onClick={copyLegend}
            className="rounded border border-border px-2 py-1 text-xs"
          >
            Kopiera
          </button>
        </div>
        <pre className="mt-2 max-h-64 overflow-auto rounded border border-border bg-muted/30 p-3 text-xs font-mono whitespace-pre-wrap">
          {legendText}
        </pre>
      </div>
    </div>
  );
}

function SplitPanel({
  settings,
  setSettings,
}: {
  settings: Settings;
  setSettings: (s: Settings) => void;
}) {
  const target = requireTarget(settings.export.targetId);
  const split = settings.export.split;
  const supportsSplit = !!target.exportMany;

  const updSplit = (patch: Partial<SplitSettings>) =>
    setSettings({
      ...settings,
      export: { ...settings.export, split: { ...split, ...patch } },
    });

  const groupCap = target.limits.maxChannelsPerGroup;

  const modes: Array<[SplitMode, string, string]> = [
    ["single", "En enda fil", "Alla kanaler i samma CSV (standard)."],
    [
      "per_district",
      "En fil per distrikt",
      "Repeatrar grupperas per region (SM0–SM7, LA, OZ, OH0–OH9, …). Kanalpaket hamnar i egna filer.",
    ],
    [
      "per_district_chunked",
      "Per distrikt + chunka",
      `Som ovan men varje fil delas vidare när den når kanaltaket${groupCap ? ` (default ${groupCap})` : ""}.`,
    ],
  ];

  return (
    <div>
      <SectionLabel>Uppdelning av exporten</SectionLabel>
      <Hint>
        {supportsSplit
          ? "Flera filer levereras som en ZIP. En enda fil laddas ned direkt som CSV."
          : `${target.label} stöder inte multifil-export — uppdelning ignoreras.`}
      </Hint>
      <div className="mt-2 flex flex-col gap-2">
        {supportsSplit &&
          modes.map(([mode, label, desc]) => (
            <label key={mode} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="split-mode"
                className="mt-1"
                checked={split.mode === mode}
                onChange={() => updSplit({ mode })}
              />
              <span>
                <span className="font-medium">{label}</span>
                <span className="ml-2 text-xs text-muted-foreground">{desc}</span>
              </span>
            </label>
          ))}
      </div>
      {supportsSplit && split.mode === "per_district_chunked" && (
        <div className="mt-3 max-w-xs">
          <NumberField
            label="Kanaler per chunk"
            value={split.chunkSize}
            onChange={(v) => updSplit({ chunkSize: Math.max(1, v) })}
            hint={
              groupCap
                ? `${target.label}: max ${groupCap} kanaler/grupp.`
                : "Anpassa till radions per-grupp-gräns."
            }
          />
        </div>
      )}
    </div>
  );
}

function QthHomeDistrictPanel({
  settings,
  updSort,
}: {
  settings: Settings;
  updSort: (patch: Partial<Settings["sort"]>) => void;
}) {
  const qth = settings.sort.qth_maidenhead ?? "";
  const qthValid = qth === "" || isValidMaidenhead(qth);
  const home = settings.sort.home_district ?? "";
  const sortMode = settings.sort.home_district_sort;
  const hasQth = qth !== "" && qthValid;

  return (
    <div>
      <SectionLabel>QTH och hemdistrikt (för repeatersortering)</SectionLabel>
      <Hint>
        När hemdistrikt är valt sorteras dess repeatrar enligt valet nedan. Övriga distrikt
        grupperas geohash-mässigt i nummerordning (SM1, SM2, … SM7). Påverkar inte kanalpaket.
      </Hint>
      <div className="grid gap-3 md:grid-cols-4 mt-3">
        <Field
          label="QTH (Maidenhead-lokator)"
          hint="6 tecken rek., t.ex. JO67bp. Tomt = ingen distanssortering."
        >
          <input
            value={qth}
            placeholder="JO67bp"
            onChange={(e) => updSort({ qth_maidenhead: e.target.value })}
            className={`w-full rounded border px-2 py-1 text-sm font-mono ${
              qthValid ? "border-input bg-background" : "border-destructive bg-destructive/5"
            }`}
          />
          {!qthValid && <Hint>Ogiltig lokator (förväntar t.ex. JO67 eller JO67bp).</Hint>}
        </Field>
        <Field label="Hemdistrikt" hint="Distrikt vars repeatrar sorteras separat.">
          <select
            value={home}
            onChange={(e) => updSort({ home_district: e.target.value || null })}
            className="w-full rounded border border-input bg-background px-2 py-1 text-sm font-mono"
          >
            <option value="">(inget — använd fallback nedan)</option>
            {["0", "1", "2", "3", "4", "5", "6", "7"].map((d) => (
              <option key={d} value={d}>
                SM{d}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sortering inom hemdistrikt">
          <div className="flex flex-col gap-1">
            {(
              [
                ["distance", "Avstånd från QTH"],
                ["geohash", "Geohash (regional)"],
                ["alphabetical", "Alfabetiskt"],
              ] as Array<[HomeDistrictSort, string]>
            ).map(([k, label]) => {
              const disabled = k === "distance" && !hasQth;
              return (
                <label
                  key={k}
                  className={`flex items-center gap-2 text-sm ${disabled ? "opacity-50" : ""}`}
                  title={disabled ? "Kräver giltig QTH-lokator" : ""}
                >
                  <input
                    type="radio"
                    name="home_district_sort"
                    checked={sortMode === k}
                    disabled={disabled}
                    onChange={() => updSort({ home_district_sort: k })}
                  />
                  {label}
                </label>
              );
            })}
          </div>
        </Field>
        <Field label="Placering">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.sort.home_district_first}
              onChange={(e) => updSort({ home_district_first: e.target.checked })}
            />
            Visa hemdistrikt först
          </label>
          <Hint>Avmarkera för att lägga hemdistriktet sist istället.</Hint>
        </Field>
      </div>
    </div>
  );
}

export function ExportPanel({
  settings,
  setSettings,
  hasPacks,
  chirpSettings,
  targetSettings,
  setTargetSettings,
  channels = [],
}: {
  settings: Settings;
  setSettings: (s: Settings) => void;
  hasPacks: boolean;
  chirpSettings: ChirpSettings;
  targetSettings: Record<string, unknown>;
  setTargetSettings: (patch: Record<string, unknown>) => void;
  channels?: NormalizedChannel[];
}) {
  const updPacks = (patch: Partial<Settings["packs"]>) =>
    setSettings({ ...settings, packs: { ...settings.packs, ...patch } });
  const updChirp = (patch: Partial<ChirpSettings>) =>
    setTargetSettings(patch as Record<string, unknown>);
  const updSort = (patch: Partial<Settings["sort"]>) =>
    setSettings({ ...settings, sort: { ...settings.sort, ...patch } });

  return (
    <div className="space-y-5">
      {hasPacks && (
        <div>
          <SectionLabel>Var hamnar kanalpaketen?</SectionLabel>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Placering i CHIRP-listan">
              <div className="flex flex-wrap gap-1">
                {(
                  [
                    ["prepend", "I början"],
                    ["append", "I slutet"],
                    ["off", "Inte med alls"],
                  ] as Array<[PackPlacement, string]>
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => updPacks({ placement: k })}
                    className={`rounded border px-2 py-1 text-xs ${settings.packs.placement === k ? "bg-primary text-primary-foreground border-primary" : "border-border bg-background"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Hint>
                Repeatrar sorteras alltid efter sorteringsordningen nedan. Kanalpaketen ligger i den
                ordning de står i CSV:n.
              </Hint>
            </Field>
            <Field
              label="Frekvensdubblett mellan paket och repeatrar"
              hint="Vad ska hända om en paketkanal har samma RX-frekvens som en repeater?"
            >
              <select
                value={settings.packs.freqDupePolicy}
                onChange={(e) => updPacks({ freqDupePolicy: e.target.value as FreqDupePolicy })}
                className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
              >
                <option value="keep_both">Behåll båda</option>
                <option value="drop_pack">Hoppa över paket-raden</option>
                <option value="drop_sk6ba">Hoppa över repeater-raden</option>
                <option value="stop">Stoppa export</option>
              </select>
            </Field>
            <Field label="RX-only-kanaler (t.ex. marin VHF, airband)">
              <select
                value={settings.packs.rxOnlyPolicy}
                onChange={(e) => updPacks({ rxOnlyPolicy: e.target.value as RxOnlyPolicy })}
                className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
              >
                {settings.export.targetId !== "rt-systems-yaesu-generic" && (
                  <option value="block_tx">Spärra TX i radion (rekommenderas)</option>
                )}
                <option value="mark">Exportera normalt + markera RX-ONLY i Comment</option>
                <option value="skip">
                  {settings.export.targetId === "rt-systems-yaesu-generic"
                    ? "Hoppa över helt (rekommenderas)"
                    : "Hoppa över helt"}
                </option>
              </select>
              <Hint>{rxOnlyHintForTarget(settings.export.targetId)}</Hint>
            </Field>
          </div>
          <RxOnlyExportNote
            channels={channels}
            targetId={settings.export.targetId}
            rxOnlyPolicy={settings.packs.rxOnlyPolicy}
          />
        </div>
      )}

      <div className="border-t border-border pt-4">
        <QthHomeDistrictPanel settings={settings} updSort={updSort} />
      </div>

      <div className="border-t border-border pt-4">
        <SectionLabel>Sorteringsordning för repeatrar (fallback)</SectionLabel>
        <Hint>
          Används när inget hemdistrikt är valt ovan. Klicka för att lägga till/ta bort en
          sorteringsnyckel. Ordningen styr prioritet.
        </Hint>
        <div className="flex flex-wrap gap-1 mt-2">
          {(["district", "geohash", "type", "city", "frequency"] as const).map((k) => {
            const idx = settings.sort.keys.indexOf(k);
            const on = idx !== -1;
            return (
              <button
                key={k}
                type="button"
                onClick={() => {
                  const keys = on
                    ? settings.sort.keys.filter((x) => x !== k)
                    : [...settings.sort.keys, k];
                  updSort({ keys });
                }}
                className={`rounded border px-2 py-0.5 text-xs font-mono ${on ? "bg-primary text-primary-foreground border-primary" : "border-border"}`}
              >
                {on ? `${idx + 1}. ${k}` : k}
              </button>
            );
          })}
        </div>
      </div>

      <div className="border-t border-border pt-4">
        <SplitPanel settings={settings} setSettings={setSettings} />
      </div>

      {settings.export.targetId === "chirp-generic" && (
        <div className="border-t border-border pt-4">
          <SectionLabel>CHIRP-fält & radio</SectionLabel>
          <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-5">
            <NumberField
              label="Startnummer (Location)"
              value={chirpSettings.startLocation}
              onChange={(v) => updChirp({ startLocation: v })}
              hint="Första minnesposition i radion. T.ex. 1 om du vill skriva från början, 100 om du vill lägga repeatrarna efter befintliga kanaler."
            />
            <NumberField
              label="Max längd kanalnamn"
              value={chirpSettings.maxLength}
              onChange={(v) => updChirp({ maxLength: v })}
              hint="Hårdvarubegränsning — många radior trunkerar vid 6–7 tecken. Gäller alla kanaler (både repeatrar och paket)."
            />
            <Field
              label="Mode"
              hint="NFM = smal FM (12,5 kHz) — standard för amatörradio idag. FM = bred (25 kHz), äldre repeatrar."
            >
              <select
                value={chirpSettings.mode}
                onChange={(e) => updChirp({ mode: e.target.value as ChirpSettings["mode"] })}
                className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
              >
                <option value="NFM">NFM (smal FM)</option>
                <option value="FM">FM (bred)</option>
              </select>
            </Field>
            <NumberField
              label="TStep (kHz)"
              step={0.5}
              value={chirpSettings.tStep}
              onChange={(v) => updChirp({ tStep: v })}
              hint="Frekvensraster vid manuell rattning på radion. 5 kHz funkar för 2m/70cm i Sverige. PMR/marin sätter eget per kanal."
            />
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={chirpSettings.skipLinks}
              onChange={(e) => updChirp({ skipLinks: e.target.checked })}
            />
            Hoppa över länkar och hotspots vid skanning i radion
            <span className="text-xs text-muted-foreground">
              (sätter Skip=S på Link/Hotspot — kanalen finns kvar men skannas inte)
            </span>
          </label>
        </div>
      )}

      {settings.export.targetId === "vgc-n76" &&
        (() => {
          // Narrow via the typed registry instead of `as unknown as VgcN76Settings`.
          const vgcTarget = requireTarget("vgc-n76");
          if (vgcTarget.id !== "vgc-n76") return null; // unreachable; satisfies TS narrowing
          const vgcSettings: VgcN76Settings = {
            ...vgcTarget.defaultSettings,
            ...(targetSettings as Partial<VgcN76Settings>),
          };
          return <VgcN76Panel settings={vgcSettings} update={setTargetSettings} />;
        })()}

      {settings.export.targetId === "nicsure-rt880" &&
        (() => {
          const nicTarget = requireTarget("nicsure-rt880");
          if (nicTarget.id !== "nicsure-rt880") return null;
          const nicSettings: NicsureRt880Settings = {
            ...nicTarget.defaultSettings,
            ...(targetSettings as Partial<NicsureRt880Settings>),
          };
          return (
            <NicsureRt880Panel
              settings={nicSettings}
              update={setTargetSettings}
              channels={channels}
            />
          );
        })()}

      {settings.export.targetId === "rt-systems-yaesu-generic" &&
        (() => {
          const rtTarget = requireTarget("rt-systems-yaesu-generic");
          if (rtTarget.id !== "rt-systems-yaesu-generic") return null;
          const rtSettings: RtSystemsYaesuSettings = {
            ...rtTarget.defaultSettings,
            ...(targetSettings as Partial<RtSystemsYaesuSettings>),
          };
          return <RtSystemsYaesuPanel settings={rtSettings} update={setTargetSettings} />;
        })()}
    </div>
  );
}

function RtSystemsYaesuPanel({
  settings,
  update,
}: {
  settings: RtSystemsYaesuSettings;
  update: (patch: Record<string, unknown>) => void;
}) {
  return (
    <div className="border-t border-border pt-4">
      <SectionLabel>RT Systems Yaesu-fält</SectionLabel>
      <Hint>
        CSV-format som RT Systems programmeringsverktyg använder för flera Yaesu-modeller. Stödjer
        FM och C4FM (Operating Mode FM/DN). Exakt radiomodell ej fastställd — använd som
        mellanlagring tills modellspecifika varianter finns.
      </Hint>
      <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-5 mt-2">
        <NumberField
          label="Startnummer"
          value={settings.startNumber}
          onChange={(v) => update({ startNumber: v })}
          hint="Värdet i den ledande (anonyma) kolumnen för första raden."
        />
        <NumberField
          label="Max längd Name"
          value={settings.maxLength}
          onChange={(v) => update({ maxLength: v })}
          hint="Yaesu-displayer visar typiskt 16 tecken. Längre namn trunkeras och flaggas."
        />
        <Field
          label="Default sändareffekt"
          hint="Skrivs på varje rad. Per-rad-override stöds inte i v1."
        >
          <select
            value={settings.defaultPower}
            onChange={(e) =>
              update({ defaultPower: e.target.value as RtSystemsYaesuSettings["defaultPower"] })
            }
            className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
          >
            <option value="Low">Low</option>
            <option value="Medium">Medium</option>
            <option value="High">High</option>
          </select>
        </Field>
        <Field
          label="Default Step"
          hint="Frekvensraster, skrivs som-is (t.ex. '12.5 kHz', '25 kHz')."
        >
          <select
            value={settings.defaultStep}
            onChange={(e) => update({ defaultStep: e.target.value })}
            className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
          >
            <option value="5 kHz">5 kHz</option>
            <option value="6.25 kHz">6.25 kHz</option>
            <option value="10 kHz">10 kHz</option>
            <option value="12.5 kHz">12.5 kHz</option>
            <option value="15 kHz">15 kHz</option>
            <option value="20 kHz">20 kHz</option>
            <option value="25 kHz">25 kHz</option>
            <option value="50 kHz">50 kHz</option>
            <option value="100 kHz">100 kHz</option>
          </select>
        </Field>
        <Field
          label="Default AMS"
          hint="AMS = Auto Mode Select. Slå på om radion ska växla FM/C4FM automatiskt per kanal."
        >
          <select
            value={settings.defaultAms}
            onChange={(e) =>
              update({ defaultAms: e.target.value as RtSystemsYaesuSettings["defaultAms"] })
            }
            className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
          >
            <option value="N">N (av)</option>
            <option value="Y">Y (på)</option>
          </select>
        </Field>
        <NumberField
          label="User CTCSS-index"
          value={settings.defaultUserCtcss}
          onChange={(v) => update({ defaultUserCtcss: v })}
          hint="0–50. RT Systems-specifikt fält som mappar till radioföreskrivna toner."
        />
        <NumberField
          label="Padda till antal rader"
          value={settings.padToRows}
          onChange={(v) => update({ padToRows: Math.max(0, Math.min(999, v | 0)) })}
          hint="Fyller filen med tomma rader så RT Systems-mjukvaran ser ett komplett minne. 0 = ingen padding. FTM-510 har 999 minnesplatser."
        />
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={settings.skipLinks}
          onChange={(e) => update({ skipLinks: e.target.checked })}
        />
        Hoppa över länkar och hotspots vid skanning
        <span className="text-xs text-muted-foreground">(sätter Skip på Link/Hotspot-rader)</span>
      </label>
    </div>
  );
}
