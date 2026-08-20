import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useCodeplugSettings, loadSettingsFromRaw } from "../useCodeplugSettings";
import { DEFAULT_SETTINGS } from "@/lib/codeplug/defaults";
import { settingsSchema } from "@/lib/codeplug/settings.schema";
import { CHIRP_GENERIC_DEFAULTS } from "@/lib/codeplug/targets/chirp-generic";
import "@/lib/codeplug/targets";

/**
 * Persistensregressioner för `useCodeplugSettings`. Testerna går via hooken
 * (inte via `loadStoredSettings`, som är privat) och skriver fixtures under
 * den skarpa nyckeln, eftersom det är den enda nyckel koden läser.
 */
const STORAGE_KEY = "sk6ba-chirp-settings-v6";

function store(payload: unknown) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

async function loadSettings() {
  const { result } = renderHook(() => useCodeplugSettings());
  await waitFor(() => expect(result.current.hydrated).toBe(true));
  return result;
}

/** Full, giltig payload som utgångspunkt för legacy-varianterna. */
function baseStored() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Record<string, unknown>;
}

describe("useCodeplugSettings – persistens och migration", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("utan sparad data används DEFAULT_SETTINGS", async () => {
    const result = await loadSettings();
    expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("migrerar legacy collisionPolicy 'stop' utan att tappa orelaterade fält", async () => {
    const stored = baseStored();
    stored.naming = {
      ...DEFAULT_SETTINGS.naming,
      collisionPolicy: "stop",
      separator: "_",
      cityMaxLength: 9,
    };
    stored.sort = { ...DEFAULT_SETTINGS.sort, geohashPrecision: 7 };
    store(stored);

    const result = await loadSettings();
    const s = result.current.settings;
    expect(s.naming.collisionPolicy).toBe("numeric_suffix");
    expect(s.naming.separator).toBe("_");
    expect(s.naming.cityMaxLength).toBe(9);
    // Orelaterade sektioner rörs inte.
    expect(s.sort.geohashPrecision).toBe(7);
    expect(s.packs).toEqual(DEFAULT_SETTINGS.packs);
  });

  it("migrerar legacy modeStrategy/customModes och includeUnknownDistricts", async () => {
    const stored = baseStored();
    stored.filter = {
      statuses: ["QRV"],
      types: ["Repeater"],
      bands: ["2"],
      countries: ["SE"],
      regions: [],
      modeStrategy: "custom",
      customModes: ["fm", "System Fusion"],
      districts: ["6"],
      includeUnknownDistricts: true,
    };
    store(stored);

    const result = await loadSettings();
    const f = result.current.settings.filter;
    expect(f.modes).toContain("FM");
    expect(f.modes).toContain("C4FM");
    expect(f.includeUnknownRegions).toBe(true);
    expect(f.types).toEqual(["Repeater"]);
  });

  it("migrerar legacy modeStrategy 'contains_fm' till modes=['FM']", async () => {
    const stored = baseStored();
    stored.filter = { ...DEFAULT_SETTINGS.filter, modes: undefined, modeStrategy: "contains_fm" };
    store(stored);

    const result = await loadSettings();
    expect(result.current.settings.filter.modes).toEqual(["FM"]);
  });

  it("ogiltig patch för ett känt target faller tillbaka på target-defaults utan att nollställa annat", async () => {
    const stored = baseStored();
    stored.naming = { ...DEFAULT_SETTINGS.naming, separator: "_" };
    stored.export = {
      ...DEFAULT_SETTINGS.export,
      perTarget: {
        ...DEFAULT_SETTINGS.export.perTarget,
        "chirp-generic": { ...CHIRP_GENERIC_DEFAULTS, maxLength: -1 },
      },
    };
    store(stored);

    const result = await loadSettings();
    const s = result.current.settings;
    expect(s.export.perTarget["chirp-generic"]).toEqual(CHIRP_GENERIC_DEFAULTS);
    expect(s.naming.separator).toBe("_");
  });

  it("giltig patch för ett känt target behålls", async () => {
    const stored = baseStored();
    stored.export = {
      ...DEFAULT_SETTINGS.export,
      perTarget: { "chirp-generic": { ...CHIRP_GENERIC_DEFAULTS, maxLength: 8 } },
    };
    store(stored);

    const result = await loadSettings();
    const chirp = result.current.settings.export.perTarget["chirp-generic"] as {
      maxLength: number;
    };
    expect(chirp.maxLength).toBe(8);
  });

  it("okänt target-id i perTarget droppas, kända target behålls", async () => {
    const stored = baseStored();
    stored.export = {
      ...DEFAULT_SETTINGS.export,
      perTarget: {
        ...DEFAULT_SETTINGS.export.perTarget,
        "removed-target": { whatever: 1 },
      },
    };
    store(stored);

    const result = await loadSettings();
    const perTarget = result.current.settings.export.perTarget;
    expect(perTarget["removed-target"]).toBeUndefined();
    expect(perTarget["chirp-generic"]).toBeDefined();
  });

  it("okänt valt targetId faller tillbaka på default-target", async () => {
    const stored = baseStored();
    stored.export = { ...DEFAULT_SETTINGS.export, targetId: "no-such-target" };
    store(stored);

    const result = await loadSettings();
    expect(result.current.settings.export.targetId).toBe(DEFAULT_SETTINGS.export.targetId);
  });

  it("okända fält bevaras på toppnivå och i sektioner med passthrough-spread", async () => {
    const stored = baseStored();
    (stored as Record<string, unknown>).myFutureFlag = 1;
    stored.filter = { ...DEFAULT_SETTINGS.filter, someFutureFacet: ["x"] };
    stored.naming = { ...DEFAULT_SETTINGS.naming, futureNamingFlag: true };
    stored.sort = { ...DEFAULT_SETTINGS.sort, futureSortFlag: 2 };
    stored.packs = { ...DEFAULT_SETTINGS.packs, futurePackFlag: "y" };
    store(stored);

    const result = await loadSettings();
    const s = result.current.settings as unknown as Record<string, unknown>;
    expect(s.myFutureFlag).toBe(1);
    expect((s.filter as Record<string, unknown>).someFutureFacet).toEqual(["x"]);
    expect((s.naming as Record<string, unknown>).futureNamingFlag).toBe(true);
    expect((s.sort as Record<string, unknown>).futureSortFlag).toBe(2);
    expect((s.packs as Record<string, unknown>).futurePackFlag).toBe("y");
  });

  it("load → save → load är idempotent", async () => {
    const stored = baseStored();
    stored.naming = { ...DEFAULT_SETTINGS.naming, collisionPolicy: "stop", separator: "_" };
    stored.filter = {
      ...DEFAULT_SETTINGS.filter,
      modeStrategy: "custom",
      customModes: ["fm"],
      includeUnknownDistricts: true,
    };
    store(stored);

    const first = await loadSettings();
    const firstSettings = JSON.parse(JSON.stringify(first.current.settings));

    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).naming.collisionPolicy).toBe(
        "numeric_suffix",
      ),
    );

    const second = await loadSettings();
    expect(JSON.parse(JSON.stringify(second.current.settings))).toEqual(firstSettings);
  });

  it("korrupt JSON ger DEFAULT_SETTINGS istället för krasch", async () => {
    window.localStorage.setItem(STORAGE_KEY, "{ inte json");
    const result = await loadSettings();
    expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
  });
});

/**
 * Issue #6: sektionsvis fallback. Ett fel i en sektion får aldrig påverka en
 * annan sektion, och ett saknat fält får aldrig kasta bort syskonfält i samma
 * sektion. Testas mot den rena loadern.
 */
describe("loadSettingsFromRaw – sektionsisolering", () => {
  const base = () => JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Record<string, unknown>;

  it("1. ogiltig sort nollställer bara sort", () => {
    const s = loadSettingsFromRaw({
      ...base(),
      sort: { ...DEFAULT_SETTINGS.sort, geohashPrecision: 99 },
      naming: { ...DEFAULT_SETTINGS.naming, separator: "_" },
      packs: { ...DEFAULT_SETTINGS.packs, placement: "prepend" },
    });
    expect(s.sort).toEqual(DEFAULT_SETTINGS.sort);
    expect(s.naming.separator).toBe("_");
    expect(s.packs.placement).toBe("prepend");
  });

  it("2. legacy packs.placement nollställer bara packs", () => {
    const s = loadSettingsFromRaw({
      ...base(),
      packs: { ...DEFAULT_SETTINGS.packs, placement: "before" },
      sort: { ...DEFAULT_SETTINGS.sort, keys: ["city"] },
    });
    expect(s.packs).toEqual(DEFAULT_SETTINGS.packs);
    expect(s.sort.keys).toEqual(["city"]);
  });

  it("3. ogiltig naming nollställer bara naming", () => {
    const s = loadSettingsFromRaw({
      ...base(),
      naming: { ...DEFAULT_SETTINGS.naming, cityMaxLength: 0 },
      filter: { ...DEFAULT_SETTINGS.filter, modes: ["C4FM"] },
    });
    expect(s.naming).toEqual(DEFAULT_SETTINGS.naming);
    expect(s.filter.modes).toEqual(["C4FM"]);
  });

  it("4. naming: null och sort: saknad ger defaults men behåller export.targetId", () => {
    const raw = base();
    raw.naming = null;
    delete raw.sort;
    raw.export = { ...DEFAULT_SETTINGS.export, targetId: "vgc-n76" };
    const s = loadSettingsFromRaw(raw);
    expect(s.naming).toEqual(DEFAULT_SETTINGS.naming);
    expect(s.sort).toEqual(DEFAULT_SETTINGS.sort);
    expect(s.export.targetId).toBe("vgc-n76");
  });

  it("5. packs utan rxOnlyPolicy fyller bara det fältet", () => {
    const packs: Record<string, unknown> = { ...DEFAULT_SETTINGS.packs, freqDupePolicy: "drop_pack" };
    delete packs.rxOnlyPolicy;
    const s = loadSettingsFromRaw({ ...base(), packs });
    expect(s.packs.rxOnlyPolicy).toBe(DEFAULT_SETTINGS.packs.rxOnlyPolicy);
    expect(s.packs.freqDupePolicy).toBe("drop_pack");
  });

  it("6. naming utan transliterate behåller components", () => {
    const naming: Record<string, unknown> = { ...DEFAULT_SETTINGS.naming, components: ["{call}"] };
    delete naming.transliterate;
    const s = loadSettingsFromRaw({ ...base(), naming });
    expect(s.naming.transliterate).toBe(DEFAULT_SETTINGS.naming.transliterate);
    expect(s.naming.components).toEqual(["{call}"]);
  });

  it("7. abbreviations mergas bara på toppnivå – type-record bevaras exakt", () => {
    const s = loadSettingsFromRaw({
      ...base(),
      naming: {
        ...DEFAULT_SETTINGS.naming,
        abbreviations: {
          ...DEFAULT_SETTINGS.naming.abbreviations,
          type: { Repeater: "REP" },
        },
      },
    });
    expect(s.naming.abbreviations.type).toEqual({ Repeater: "REP" });
    expect(s.naming.abbreviations.network).toEqual(DEFAULT_SETTINGS.naming.abbreviations.network);
    expect(s.naming.abbreviations.districtPrefix).toBe("D");
  });

  it("8. trasig split behåller targetId och perTarget", () => {
    const s = loadSettingsFromRaw({
      ...base(),
      export: {
        targetId: "vgc-n76",
        perTarget: { "chirp-generic": { ...CHIRP_GENERIC_DEFAULTS, maxLength: 8 } },
        split: { mode: "single", chunkSize: 5000 },
      },
    });
    expect(s.export.split).toEqual(DEFAULT_SETTINGS.export.split);
    expect(s.export.targetId).toBe("vgc-n76");
    expect((s.export.perTarget["chirp-generic"] as { maxLength: number }).maxLength).toBe(8);
  });

  it("9. okänt targetId rör inte perTarget eller split", () => {
    const s = loadSettingsFromRaw({
      ...base(),
      export: {
        targetId: "no-such-target",
        perTarget: { "chirp-generic": { ...CHIRP_GENERIC_DEFAULTS, maxLength: 8 } },
        split: { mode: "per_district", chunkSize: 32 },
      },
    });
    expect(s.export.targetId).toBe(DEFAULT_SETTINGS.export.targetId);
    expect((s.export.perTarget["chirp-generic"] as { maxLength: number }).maxLength).toBe(8);
    expect(s.export.split.mode).toBe("per_district");
  });

  it("10. perTarget: null ger defaults men behåller targetId och split", () => {
    const s = loadSettingsFromRaw({
      ...base(),
      export: {
        targetId: "vgc-n76",
        perTarget: null,
        split: { mode: "per_district_chunked", chunkSize: 16 },
      },
    });
    expect(s.export.perTarget).toEqual(DEFAULT_SETTINGS.export.perTarget);
    expect(s.export.targetId).toBe("vgc-n76");
    expect(s.export.split.chunkSize).toBe(16);
  });

  it("11. ogiltig patch för ett target rör inte ett annat target", () => {
    const s = loadSettingsFromRaw({
      ...base(),
      export: {
        ...DEFAULT_SETTINGS.export,
        perTarget: {
          "chirp-generic": { ...CHIRP_GENERIC_DEFAULTS, maxLength: -1 },
          "vgc-n76": { ...(DEFAULT_SETTINGS.export.perTarget["vgc-n76"] as object) },
        },
      },
    });
    expect(s.export.perTarget["chirp-generic"]).toEqual(CHIRP_GENERIC_DEFAULTS);
    expect(s.export.perTarget["vgc-n76"]).toEqual(DEFAULT_SETTINGS.export.perTarget["vgc-n76"]);
  });

  it("13. legacy collisionPolicy migreras även när sort är trasig", () => {
    const s = loadSettingsFromRaw({
      ...base(),
      naming: { ...DEFAULT_SETTINGS.naming, collisionPolicy: "stop", separator: "_" },
      sort: { ...DEFAULT_SETTINGS.sort, geohashPrecision: 0 },
    });
    expect(s.naming.collisionPolicy).toBe("numeric_suffix");
    expect(s.naming.separator).toBe("_");
    expect(s.sort).toEqual(DEFAULT_SETTINGS.sort);
  });

  it("14. filtermigrering gäller även när packs är trasig", () => {
    const s = loadSettingsFromRaw({
      ...base(),
      filter: { ...DEFAULT_SETTINGS.filter, modes: undefined, modeStrategy: "custom", customModes: ["fm"] },
      packs: { ...DEFAULT_SETTINGS.packs, freqDupePolicy: "nope" },
    });
    expect(s.filter.modes).toEqual(["FM"]);
    expect(s.packs).toEqual(DEFAULT_SETTINGS.packs);
  });

  it("15. okända fält bevaras även när en annan sektion faller tillbaka", () => {
    const s = loadSettingsFromRaw({
      ...base(),
      myFutureFlag: 1,
      naming: { ...DEFAULT_SETTINGS.naming, futureNamingFlag: true },
      sort: { ...DEFAULT_SETTINGS.sort, geohashPrecision: 99 },
    }) as unknown as Record<string, unknown>;
    expect(s.myFutureFlag).toBe(1);
    expect((s.naming as Record<string, unknown>).futureNamingFlag).toBe(true);
    expect(s.sort).toEqual(DEFAULT_SETTINGS.sort);
  });

  it("16/17. icke-objekt och tom payload ger DEFAULT_SETTINGS", () => {
    for (const raw of [null, [1, 2], "sträng", 5, undefined]) {
      expect(loadSettingsFromRaw(raw)).toEqual(DEFAULT_SETTINGS);
    }
    expect(loadSettingsFromRaw({})).toEqual(DEFAULT_SETTINGS);
  });

  it("18. load → save → load är idempotent med två trasiga sektioner", () => {
    const first = loadSettingsFromRaw({
      ...base(),
      naming: { ...DEFAULT_SETTINGS.naming, cityMaxLength: 0 },
      export: { ...DEFAULT_SETTINGS.export, split: { mode: "single", chunkSize: 5000 } },
      filter: { ...DEFAULT_SETTINGS.filter, modeStrategy: "custom", customModes: ["fm"] },
    });
    const second = loadSettingsFromRaw(JSON.parse(JSON.stringify(first)));
    expect(JSON.parse(JSON.stringify(second))).toEqual(JSON.parse(JSON.stringify(first)));
  });

  it("resultatet godkänns alltid av settingsSchema", () => {
    const payloads: unknown[] = [
      {},
      { ...base(), sort: 5 },
      { ...base(), naming: null, packs: "x" },
      { ...base(), export: { targetId: "", perTarget: [], split: null } },
      { ...base(), filter: { modeStrategy: "custom", customModes: ["fm"] } },
    ];
    for (const p of payloads) {
      expect(settingsSchema.safeParse(loadSettingsFromRaw(p)).success).toBe(true);
    }
  });
});
