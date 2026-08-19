import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useCodeplugSettings } from "../useCodeplugSettings";
import { DEFAULT_SETTINGS } from "@/lib/codeplug/defaults";
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
