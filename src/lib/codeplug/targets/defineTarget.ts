import type { z } from "zod";
import type { NormalizedChannel, SplitSettings, Warning } from "../models";
import { renderCsv, type RowMapper } from "../exporters/shared/rowMapper";
import { buildSplitFiles } from "./split";
import type { ExportTarget, HardwareLimits } from "./types";
import { assertTxIntentSerializable, type TxInhibitCapability } from "../txIntent";

/**
 * `defineTarget()` is the canonical entry point for a new CSV-based export
 * target. It composes:
 *  - a `RowMapper` (column list + per-channel row builder)
 *  - hardware limits + default settings + Zod schema
 *  - optional split / multi-file handling via `buildSplitFiles`
 *  - optional validate / previewMode / max-name-length hooks
 *
 * The returned object is a fully-typed `ExportTarget<TSettings>` ready to
 * hand to `registerTarget()`. Targets with custom row injection (APRS slot,
 * padding, leading empty columns) can opt out of `defineTarget()` and
 * implement `ExportTarget` manually — `defineTarget()` is sugar, not a
 * replacement.
 *
 * Example:
 *
 * ```ts
 * export const ICOM_IC705_TARGET = defineTarget({
 *   id: "icom-ic705",
 *   label: "Icom IC-705",
 *   vendor: "Icom",
 *   fileExtension: "csv",
 *   filenameBase: "icom-ic705",
 *   limits: IC705_LIMITS,
 *   defaultSettings: IC705_DEFAULTS,
 *   settingsSchema: ic705SettingsSchema,
 *   txInhibit: "verified_tx_inhibit",
 *   mapper: IC705_ROW_MAPPER,
 *   splitEnabled: true,
 *   resolveMaxNameLength: (s) => s.maxLength,
 * });
 * registerTarget(ICOM_IC705_TARGET);
 * ```
 */
export interface DefineTargetSpec<TSettings, TCols extends string> {
  id: string;
  label: string;
  vendor: string;
  description?: string;
  fileExtension: string;
  filenameBase?: string;
  /** Obligatorisk TX-spärr-förmåga, se ExportTarget.txInhibit. */
  txInhibit: TxInhibitCapability;
  limits: HardwareLimits;
  defaultSettings: TSettings;
  settingsSchema?: z.ZodType<TSettings>;
  mapper: RowMapper<TSettings, TCols>;
  /**
   * When `true`, `exportMany` is wired up via `buildSplitFiles` so the
   * target gets per-district splitting + chunked exports for free.
   */
  splitEnabled?: boolean;
  /** Pre-export validation hook. Receives the full channel list + settings. */
  validate?: (channels: NormalizedChannel[], settings: TSettings) => Warning[];
  resolveMaxNameLength?: (settings: TSettings) => number;
  previewMode?: (c: NormalizedChannel, settings: TSettings) => string;
}

export function defineTarget<TSettings, TCols extends string>(
  spec: DefineTargetSpec<TSettings, TCols>,
): ExportTarget<TSettings> {
  const baseFilename = spec.filenameBase ?? spec.id;
  const target: ExportTarget<TSettings> = {
    id: spec.id,
    label: spec.label,
    vendor: spec.vendor,
    description: spec.description,
    filenameBase: baseFilename,
    fileExtension: spec.fileExtension,
    txInhibit: spec.txInhibit,
    limits: spec.limits,
    defaultSettings: spec.defaultSettings,
    settingsSchema: spec.settingsSchema,
    validate: spec.validate,
    resolveMaxNameLength: spec.resolveMaxNameLength,
    previewMode: spec.previewMode,
    export: (channels, settings) => {
      // Automatisk defensiv vakt: ingen target-författare kan glömma den.
      assertTxIntentSerializable(channels, spec.txInhibit, spec.id);
      return {
        filename: `${baseFilename}.${spec.fileExtension}`,
        content: renderCsv(channels, spec.mapper, settings),
        warnings: spec.validate ? spec.validate(channels, settings) : [],
      };
    },
  };

  if (spec.splitEnabled) {
    target.exportMany = (
      channels: NormalizedChannel[],
      settings: TSettings,
      split: SplitSettings,
    ) => {
      assertTxIntentSerializable(channels, spec.txInhibit, spec.id);
      return {
        files: buildSplitFiles(channels, split, {
          filenameBase: baseFilename,
          extension: spec.fileExtension,
          renderChunk: (chunk) => renderCsv(chunk, spec.mapper, settings),
        }),
        warnings: spec.validate ? spec.validate(channels, settings) : [],
      };
    };
  }

  return target;
}
