import { z } from "zod";
import type {
  FreqDupePolicy,
  HomeDistrictSort,
  NamingSettings,
  RxOnlyPolicy,
  SortSettings,
  SplitMode,
} from "./models";

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
 * Äkta kompileringstidskontroll av de literal-unioner som dupliceras mellan
 * `models.ts` (domäntyp) och schemat här (persistensgrind).
 *
 * Varför bara unionerna: schemats objekt är `.passthrough()`, så `z.infer`
 * bär indexsignaturer och kan aldrig vara *exakt* lika med `Settings`. En
 * assertion på hela objektet blir därför antingen falsklarm eller — som den
 * tidigare `_SettingsSchemaCompatible` — urvattnad till en no-op.
 *
 * Unionerna är däremot den verkliga driftrisken: utökas t.ex.
 * `SortSettings["keys"]` i models.ts utan att `sortSchema` följer med, så
 * underkänns sparade inställningar tyst och användaren får defaults. Dessa
 * assertions bryter bygget i stället.
 */
type Assert<T extends true> = T;
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export type _CollisionPolicyInSync = Assert<
  Eq<z.infer<typeof namingSchema>["collisionPolicy"], NamingSettings["collisionPolicy"]>
>;
export type _SplitModeInSync = Assert<Eq<z.infer<typeof splitSchema>["mode"], SplitMode>>;
export type _FreqDupePolicyInSync = Assert<
  Eq<z.infer<typeof packsSchema>["freqDupePolicy"], FreqDupePolicy>
>;
export type _RxOnlyPolicyInSync = Assert<
  Eq<z.infer<typeof packsSchema>["rxOnlyPolicy"], RxOnlyPolicy>
>;
export type _SortKeysInSync = Assert<
  Eq<z.infer<typeof sortSchema>["keys"][number], SortSettings["keys"][number]>
>;
export type _HomeDistrictSortInSync = Assert<
  Eq<z.infer<typeof sortSchema>["home_district_sort"], HomeDistrictSort>
>;
