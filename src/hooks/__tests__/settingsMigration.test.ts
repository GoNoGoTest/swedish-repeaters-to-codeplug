import { describe, it, expect } from "vitest";
import { migrateNaming } from "../useCodeplugSettings";
import { settingsSchema } from "@/lib/codeplug/settings.schema";
import { DEFAULT_SETTINGS } from "@/lib/codeplug/defaults";

describe("migrateNaming", () => {
  it("migrerar legacy collisionPolicy 'stop' till numeric_suffix", () => {
    const out = migrateNaming({ ...DEFAULT_SETTINGS.naming, collisionPolicy: "stop" });
    expect(out?.collisionPolicy).toBe("numeric_suffix");
  });

  it("lämnar giltiga policies orörda", () => {
    const naming = { ...DEFAULT_SETTINGS.naming, collisionPolicy: "last_char_suffix" };
    expect(migrateNaming(naming)).toBe(naming);
  });

  it("migrerade legacy-inställningar godkänns av schemat (inget nollställs)", () => {
    const legacy = {
      ...DEFAULT_SETTINGS,
      naming: { ...DEFAULT_SETTINGS.naming, collisionPolicy: "stop", separator: "_" },
    };
    const migrated = { ...legacy, naming: migrateNaming(legacy.naming as never) };
    const r = settingsSchema.safeParse(migrated);
    expect(r.success).toBe(true);
    expect((r.success && (r.data.naming as { separator: string }).separator) || "").toBe("_");
  });
});
