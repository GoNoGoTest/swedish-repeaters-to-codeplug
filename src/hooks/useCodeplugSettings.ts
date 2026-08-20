import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";
import type { Settings } from "@/lib/codeplug/models";
import { DEFAULT_SETTINGS } from "@/lib/codeplug/defaults";

const STORAGE_KEY = "sk6ba-chirp-settings-v7";
/**
 * v6-data kunde innehålla ett `packs.rxOnlyPolicy` som den gamla
 * targetväxlingsbuggen skrev över med "skip". Vi läser inte v6 alls —
 * alla startar på DEFAULT_SETTINGS ("Spärra TX i radion") — och städar
 * bort den döda nyckeln vid första laddningen.
 */
const LEGACY_STORAGE_KEYS = ["sk6ba-chirp-settings-v6"];

import { parseModes } from "@/lib/codeplug/modes";
import { getTarget } from "@/lib/codeplug/targets";
import {
  filterSchema,
  namingSchema,
  packsSchema,
  settingsSchema,
  sortSchema,
  splitSchema,
} from "@/lib/codeplug/settings.schema";

function migrateFilter(
  parsedFilter: Record<string, unknown> | undefined | null,
): Settings["filter"] {
  const base: Record<string, unknown> = { ...DEFAULT_SETTINGS.filter, ...(parsedFilter ?? {}) };
  // Legacy `includeUnknownDistricts` → `includeUnknownRegions` if new field missing.
  if (
    parsedFilter &&
    parsedFilter.includeUnknownRegions === undefined &&
    parsedFilter.includeUnknownDistricts !== undefined
  ) {
    base.includeUnknownRegions = !!parsedFilter.includeUnknownDistricts;
  }
  // Legacy `modeStrategy` / `customModes` → `modes`.
  if (parsedFilter && !Array.isArray(parsedFilter.modes)) {
    const strategy = parsedFilter.modeStrategy;
    if (strategy === "contains_fm" || strategy === "exact_fm") {
      base.modes = ["FM"];
    } else if (strategy === "all") {
      base.modes = [];
    } else if (strategy === "custom" && Array.isArray(parsedFilter.customModes)) {
      // Normalise custom values through parseModes so aliases map onto KNOWN_MODES.
      const out: string[] = [];
      for (const raw of parsedFilter.customModes) {
        for (const m of parseModes(String(raw))) {
          if (!out.includes(m)) out.push(m);
        }
      }
      base.modes = out;
    } else {
      base.modes = [...DEFAULT_SETTINGS.filter.modes];
    }
  }
  if (!Array.isArray(base.countries)) base.countries = DEFAULT_SETTINGS.filter.countries;
  if (!Array.isArray(base.regions)) base.regions = DEFAULT_SETTINGS.filter.regions;
  if (!Array.isArray(base.modes)) base.modes = [...DEFAULT_SETTINGS.filter.modes];
  return base as unknown as Settings["filter"];
}

/**
 * Validera `export.perTarget` mot varje targets eget `settingsSchema`. Ogiltiga
 * patches ersätts av target-defaults så vi inte läcker ut t.ex. `maxLength: -1`
 * till exportern. Okända target-id:n droppas tyst (target finns inte längre).
 */
function sanitizePerTarget(perTarget: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, patch] of Object.entries(perTarget)) {
    const t = getTarget(id);
    if (!t) continue;
    if (t.settingsSchema) {
      const merged = { ...(t.defaultSettings as object), ...((patch as object) ?? {}) };
      const parsed = t.settingsSchema.safeParse(merged);
      out[id] = parsed.success ? parsed.data : t.defaultSettings;
    } else {
      out[id] = patch;
    }
  }
  return out;
}

/**
 * Legacy `collisionPolicy: "stop"` finns inte längre — vanliga namnkollisioner
 * löses automatiskt. Migrera värdet till `numeric_suffix` istället för att
 * låta schemat underkänna (och nollställa) hela den sparade konfigurationen.
 */
export function migrateNaming(
  parsedNaming: Record<string, unknown> | undefined | null,
): Record<string, unknown> | undefined {
  if (!parsedNaming || typeof parsedNaming !== "object") return parsedNaming ?? undefined;
  const policy = parsedNaming.collisionPolicy;
  if (policy === "numeric_suffix" || policy === "last_char_suffix") return parsedNaming;
  return { ...parsedNaming, collisionPolicy: "numeric_suffix" };
}

/** Vanligt objekt: inte null, inte array. Arrayer/primitiver är aldrig sektioner. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Sektionsvis grind: shallow-merga sparad sektion ovanpå defaults och validera
 * *bara* den sektionen. Saknade fält fylls från defaults (äldre payload är inte
 * ett fel), medan ett närvarande men ogiltigt värde ger sektionens default —
 * utan att röra syskonsektionerna.
 */
function parseSection<T>(
  name: string,
  stored: unknown,
  fallback: T,
  schema: z.ZodTypeAny,
  premerged?: Record<string, unknown>,
): T {
  if (stored !== undefined && !isPlainObject(stored)) {
    console.warn(`Sparad sektion "${name}" har fel form, använder defaults`);
    return fallback;
  }
  const merged = premerged ?? { ...(fallback as object), ...(stored ?? {}) };
  const parsed = schema.safeParse(merged);
  if (!parsed.success) {
    console.warn(`Sparad sektion "${name}" ogiltig, använder defaults`, parsed.error.format());
    return fallback;
  }
  return parsed.data as T;
}

/**
 * `export` delas upp i tre oberoende delar så att t.ex. en trasig `split` inte
 * tar med sig ett fullt giltigt `targetId` eller `perTarget` i fallet.
 */
function parseExport(stored: unknown): Settings["export"] {
  if (stored !== undefined && !isPlainObject(stored)) {
    console.warn('Sparad sektion "export" har fel form, använder defaults');
    return {
      targetId: DEFAULT_SETTINGS.export.targetId,
      perTarget: { ...DEFAULT_SETTINGS.export.perTarget },
      split: { ...DEFAULT_SETTINGS.export.split },
    };
  }
  const patch = stored ?? {};
  const targetIdRaw = patch.targetId;
  const targetId =
    typeof targetIdRaw === "string" && getTarget(targetIdRaw)
      ? targetIdRaw
      : DEFAULT_SETTINGS.export.targetId;
  const perTarget = isPlainObject(patch.perTarget) ? sanitizePerTarget(patch.perTarget) : {};
  const split = parseSection(
    "export.split",
    patch.split,
    DEFAULT_SETTINGS.export.split,
    splitSchema,
  );
  const rest = { ...patch };
  delete rest.targetId;
  delete rest.perTarget;
  delete rest.split;
  return {
    ...(rest as object),
    targetId,
    perTarget: { ...DEFAULT_SETTINGS.export.perTarget, ...perTarget },
    split,
  } as Settings["export"];
}

/**
 * Ren, testbar loader. Sektionsvis migrera → merga → validera → sektionsdefault.
 * Ingen helhetsfallback efter sammansättningen: ett fel i en sektion får aldrig
 * kasta bort en annan.
 */
export function loadSettingsFromRaw(raw: unknown): Settings {
  if (!isPlainObject(raw)) return DEFAULT_SETTINGS;

  const filter = parseSection(
    "filter",
    raw.filter,
    DEFAULT_SETTINGS.filter,
    filterSchema,
    migrateFilter(raw.filter as never) as unknown as Record<string, unknown>,
  );

  const namingStored = migrateNaming(raw.naming as never);
  const namingMerged = isPlainObject(namingStored)
    ? {
        ...DEFAULT_SETTINGS.naming,
        ...namingStored,
        // Shallow — aldrig djup map-merge: type/network/band är användarstyrda.
        // Saknat fält fylls från defaults; närvarande men ogiltigt värde skickas
        // vidare till schemat så att hela naming-sektionen faller tillbaka.
        abbreviations:
          namingStored.abbreviations === undefined
            ? { ...DEFAULT_SETTINGS.naming.abbreviations }
            : isPlainObject(namingStored.abbreviations)
              ? { ...DEFAULT_SETTINGS.naming.abbreviations, ...namingStored.abbreviations }
              : namingStored.abbreviations,
      }
    : undefined;
  const naming = parseSection(
    "naming",
    raw.naming,
    DEFAULT_SETTINGS.naming,
    namingSchema,
    namingMerged,
  );

  const sort = parseSection("sort", raw.sort, DEFAULT_SETTINGS.sort, sortSchema);
  const packs = parseSection("packs", raw.packs, DEFAULT_SETTINGS.packs, packsSchema);
  const exportSettings = parseExport(raw.export);

  const rest = { ...raw };
  delete rest.filter;
  delete rest.naming;
  delete rest.sort;
  delete rest.packs;
  delete rest.export;

  const result = {
    ...rest,
    filter,
    naming,
    sort,
    packs,
    export: exportSettings,
  } as Settings;

  if (import.meta.env?.DEV) {
    const check = settingsSchema.safeParse(result);
    if (!check.success) {
      // Programmeringsfel — larma, men returnera ändå (ingen totalfallback).
      console.error("Sammansatta inställningar bryter mot schemat", check.error.format());
    }
  }
  return result;
}

function loadStoredSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return loadSettingsFromRaw(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function useCodeplugSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setSettings(loadStoredSettings());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings, hydrated]);

  const reset = useCallback(() => setSettings(DEFAULT_SETTINGS), []);

  return { settings, setSettings, hydrated, reset };
}
