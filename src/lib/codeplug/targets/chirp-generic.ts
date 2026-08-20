import { z } from "zod";
import type { ChirpSettings, NormalizedChannel, SplitSettings } from "../models";
import { exportChirpCsv, chirpDigitalWarnings, resolveChirpMode } from "../exporters/chirp";
import { registerTarget } from "./registry";
import { assertTxIntentSerializable } from "../txIntent";
import { buildSplitFiles } from "./split";
import type { ExportTarget, HardwareLimits } from "./types";

export const CHIRP_GENERIC_DEFAULTS: ChirpSettings = {
  startLocation: 1,
  mode: "NFM",
  tStep: 5.0,
  skipLinks: false,
  maxLength: 6,
};

export const chirpSettingsSchema: z.ZodType<ChirpSettings> = z.object({
  startLocation: z.number().int().min(0),
  mode: z.enum(["NFM", "FM"]),
  tStep: z.number().positive(),
  skipLinks: z.boolean(),
  maxLength: z.number().int().min(1).max(64),
});

const CHIRP_GENERIC_LIMITS: HardwareLimits = {
  // CHIRP itself doesn't impose a max; the actual radio does. We keep a
  // sane default name length matching CHIRP_GENERIC_DEFAULTS.maxLength.
  maxNameLength: 6,
  supportedModes: [
    "NFM",
    "FM",
    "WFM",
    "AM",
    "NAM",
    "DV",
    "DN",
    "DMR",
    "P25",
    "CW",
    "USB",
    "LSB",
    "RTTY",
    "DIG",
    "PKT",
  ],
  // CHIRP-CSV is permissive: analog modes export cleanly; digital modes
  // pass through as Mode=DN/DV/DMR/P25 with a non-blocking warning.
  supportedSignalModes: ["FM", "C4FM", "D-Star", "DMR", "DMRplus", "P25", "CW"],
  supportsSplit: true,
  supportsCtcss: true,
  supportsDcs: true,
};

export const CHIRP_GENERIC_TARGET: ExportTarget<ChirpSettings> = {
  id: "chirp-generic",
  label: "CHIRP generic CSV",
  vendor: "CHIRP",
  description:
    "Standard CHIRP-CSV — öppna i CHIRP och importera till valfri radioimage. Bredast hårdvarustöd.",
  filenameBase: "chirp",
  fileExtension: "csv",
  txInhibit: "verified_tx_inhibit",
  limits: CHIRP_GENERIC_LIMITS,
  defaultSettings: CHIRP_GENERIC_DEFAULTS,
  settingsSchema: chirpSettingsSchema,
  resolveMaxNameLength: (s) => s.maxLength,
  previewMode: (c, s) => resolveChirpMode(c, s.mode),
  validate: (channels) => chirpDigitalWarnings(channels),
  export: (channels: NormalizedChannel[], settings: ChirpSettings) => ({
    filename: "chirp.csv",
    content: exportChirpCsv(channels, settings),
    warnings: chirpDigitalWarnings(channels),
  }),
  exportMany: (channels: NormalizedChannel[], settings: ChirpSettings, split: SplitSettings) => ({
    files: buildSplitFiles(channels, split, {
      filenameBase: "chirp",
      extension: "csv",
      // Re-number Location per chunk so each file is internally consistent.
      renderChunk: (chunk) => exportChirpCsv(chunk, settings),
    }),
    warnings: chirpDigitalWarnings(channels),
  }),
};

registerTarget(CHIRP_GENERIC_TARGET);
