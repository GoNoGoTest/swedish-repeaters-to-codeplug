import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";
import type { Settings } from "@/lib/codeplug/models";
import { DEFAULT_SETTINGS } from "@/lib/codeplug/defaults";

const STORAGE_KEY = "sk6ba-chirp-settings-v6";

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

function loadStoredSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const migrated = {
      ...parsed,
      filter: migrateFilter(parsed?.filter as never),
      naming: migrateNaming(parsed?.naming as never),
    };
    const check = settingsSchema.safeParse(migrated);
    if (!check.success) {
      console.warn("Sparade inställningar ogiltiga, återställer defaults", check.error.format());
      return DEFAULT_SETTINGS;
    }
    const data = check.data as Record<string, unknown>;
    const exportPatch = (data.export as Record<string, unknown>) ?? {};
    const perTargetRaw = (exportPatch.perTarget as Record<string, unknown>) ?? {};
    const perTarget = sanitizePerTarget(perTargetRaw);
    const targetIdRaw = exportPatch.targetId as string | undefined;
    const targetId =
      targetIdRaw && getTarget(targetIdRaw) ? targetIdRaw : DEFAULT_SETTINGS.export.targetId;
    return {
      ...DEFAULT_SETTINGS,
      ...(data as Partial<Settings>),
      filter: migrated.filter as Settings["filter"],
      naming: { ...DEFAULT_SETTINGS.naming, ...((data.naming as object) ?? {}) },
      packs: { ...DEFAULT_SETTINGS.packs, ...((data.packs as object) ?? {}) },
      sort: { ...DEFAULT_SETTINGS.sort, ...((data.sort as object) ?? {}) },
      export: {
        targetId,
        perTarget: { ...DEFAULT_SETTINGS.export.perTarget, ...perTarget },
        split: {
          ...DEFAULT_SETTINGS.export.split,
          ...((exportPatch.split as object) ?? {}),
        },
      },
    };
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
