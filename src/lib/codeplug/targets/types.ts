import type { z } from "zod";
import type { NormalizedChannel, SplitSettings, Warning } from "../models";
import type { TxInhibitCapability } from "../txIntent";

/**
 * Hardware/software limits for a concrete export target (radio or app).
 * Used by target.validate() and by UI to surface constraints. The pipeline
 * does NOT enforce these automatically in this iteration — actual
 * truncation/grouping is the responsibility of each target's exporter.
 */
export interface HardwareLimits {
  /** Total channels the radio can hold (undefined = unlimited / unknown). */
  maxChannels?: number;
  /** Some radios (e.g. VGC N76) group channels with a per-group cap. */
  maxChannelsPerGroup?: number;
  /** Display width in characters for the channel name field. */
  maxNameLength: number;
  /**
   * Modes the target can import, using the exporter's native vocabulary
   * (e.g. CHIRP's "NFM"/"FM"/"AM" or RT Systems' "FM"/"DN"). Mostly used
   * for documentation and the legend/validate paths.
   */
  supportedModes: string[];
  /**
   * Canonical signal modes (from `KNOWN_MODES` in modes.ts) the target can
   * meaningfully export. Drives the disabled state of the mode-filter
   * toggles in the UI. Undefined = "all modes supported" (legacy default).
   */
  supportedSignalModes?: string[];
  supportsSplit: boolean;
  supportsCtcss: boolean;
  supportsDcs: boolean;
  /** Allowed manual-tuning step values in kHz, if the target is picky. */
  toneStepKhz?: number[];
}

export interface ExportResult {
  /** Suggested filename including extension. */
  filename: string;
  /** File body (CSV text, etc.). */
  content: string;
  /** Pre-export validation warnings (non-blocking unless target opts in). */
  warnings: Warning[];
}

/** One file in a multi-file export (used by exportMany). */
export interface ExportFile {
  filename: string;
  content: string;
}

/** Result of a multi-file export — files plus aggregated target warnings. */
export interface ExportManyResult {
  files: ExportFile[];
  /** Aggregerade target-warnings för hela exporten (inte per chunk). */
  warnings: Warning[];
}

export interface ExportTarget<TSettings = unknown> {
  /** Stable id, e.g. "chirp-generic". */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Vendor / family for UI grouping ("CHIRP", "VGC", "RT Systems", ...). */
  vendor: string;
  /** Short one-liner shown in the format picker. */
  description?: string;
  /** Base filename without extension (e.g. "vgc-n76"). Defaults to id. */
  filenameBase?: string;
  fileExtension: "csv" | "txt" | string;
  /**
   * OBLIGATORISK deklaration: kan targetets filformat uttrycka en verifierad
   * TX-spärr? Läses av `resolveEffectiveRxOnlyPolicy()` och av den defensiva
   * vakten `assertTxIntentSerializable()`. Nya targets tvingas av
   * kompilatorn att ta ställning — gissa aldrig, verifiera mot formatets
   * dokumentation eller en referensexport.
   */
  txInhibit: TxInhibitCapability;
  limits: HardwareLimits;
  defaultSettings: TSettings;
  /**
   * Zod-schema för target-specifika settings. Används av loaders för att
   * validera localStorage-data och avgöra om patchen ska accepteras eller
   * falla tillbaka på defaults. Valfritt — saknat schema ⇒ inget extra
   * skydd, settings antas redan strukturellt korrekta (legacy beteende).
   */
  settingsSchema?: z.ZodType<TSettings>;
  /** Optional pre-export validation against limits. */
  validate?: (channels: NormalizedChannel[], settings: TSettings) => Warning[];
  /** Produce a single exportable file. */
  export: (channels: NormalizedChannel[], settings: TSettings) => ExportResult;
  /**
   * Produce multiple files according to `split`. Targets that don't
   * implement this are exported as a single file regardless of split.
   * The returned filenames must NOT include a directory component.
   */
  exportMany?: (
    channels: NormalizedChannel[],
    settings: TSettings,
    split: SplitSettings,
  ) => ExportManyResult;
  /**
   * Derive the effective max-name-length the pipeline should clip to,
   * given user-tunable settings (may be lower than limits.maxNameLength).
   * Defaults to limits.maxNameLength.
   */
  resolveMaxNameLength?: (settings: TSettings) => number;
  /**
   * Returnera mode-token som targeten faktiskt skulle skriva för den här
   * kanalen — t.ex. "DN" för en C4FM-rad i RT Systems Yaesu. Rent
   * presentationsbeteende: används av previewen för att visa export-mode
   * vid sidan av signal-mode. Påverkar inte exportfilen.
   */
  previewMode?: (c: NormalizedChannel, settings: TSettings) => string;
}
