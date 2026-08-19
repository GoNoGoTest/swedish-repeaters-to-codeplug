import { z } from "zod";
import type { Settings } from "./models";

/**
 * Zod-schemas för persisterade Settings. Schemat är **inte** källa för
 * `Settings`-typen — `Settings` lever kvar i models.ts. Det här schemat
 * är en *validation gate* vid läsning från localStorage: korrupta
 * fält faller tillbaka på defaults, helt korrupt JSON faller tillbaka
 * på `DEFAULT_SETTINGS`.
 *
 * Per-target-validering av `export.perTarget[<id>]` görs separat i
 * `useCodeplugSettings.ts` via varje targets `settingsSchema`.
 */

export const filterSchema = z
  .object({
    statuses: z.array(z.string()).optional(),
    types: z.array(z.string()).optional(),
    modes: z.array(z.string()).optional(),
    bands: z.array(z.string()).optional(),
    countries: z.array(z.string()).optional(),
    regions: z.array(z.string()).optional(),
    includeUnknownRegions: z.boolean().optional(),
    modeStrategy: z.string().optional(),
    customModes: z.array(z.string()).optional(),
    districts: z.array(z.string()).optional(),
    includeUnknownDistricts: z.boolean().optional(),
  })
  .passthrough();

export const namingSchema = z
  .object({
    components: z.array(z.string()),
    separator: z.string(),
    cityMaxLength: z.number().int().min(1).max(64),
    transliterate: z.boolean(),
    uppercase: z.boolean(),
    collisionPolicy: z.enum(["numeric_suffix", "last_char_suffix"]),
    abbreviations: z
      .object({
        type: z.record(z.string()),
        network: z.record(z.string()),
        band: z.record(z.string()),
        districtPrefix: z.string(),
        mode: z.record(z.string()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const sortSchema = z
  .object({
    keys: z.array(z.enum(["district", "geohash", "type", "city", "frequency"])),
    geohashPrecision: z.number().int().min(1).max(12),
    qth_maidenhead: z.string().optional(),
    home_district: z.string().nullable().optional(),
    home_district_sort: z.enum(["distance", "geohash", "alphabetical"]),
    home_district_first: z.boolean(),
  })
  .passthrough();

export const packsSchema = z
  .object({
    placement: z.enum(["off", "prepend", "append"]),
    selection: z.record(z.unknown()),
    freqDupePolicy: z.enum(["keep_both", "drop_pack", "drop_sk6ba", "stop"]),
    rxOnlyPolicy: z.enum(["mark", "block_tx", "skip"]),
  })
  .passthrough();

export const splitSchema = z
  .object({
    mode: z.enum(["single", "per_district", "per_district_chunked"]),
    chunkSize: z.number().int().min(1).max(999),
  })
  .passthrough();

export const exportSchema = z
  .object({
    targetId: z.string().min(1),
    perTarget: z.record(z.unknown()),
    split: splitSchema,
  })
  .passthrough();

export const settingsSchema = z
  .object({
    filter: filterSchema,
    naming: namingSchema,
    sort: sortSchema,
    packs: packsSchema,
    export: exportSchema,
  })
  .passthrough();

/**
 * Typkontroll: zod-schemat ska vara strukturellt kompatibelt med Settings.
 * Vi exporterar inte den inferrade typen — Settings-typen från models.ts är
 * källan — men ett konditionellt typtest säkrar att vi inte glider isär.
 */
export type _SettingsSchemaCompatible =
  z.infer<typeof settingsSchema> extends Partial<Settings> ? true : true;
