import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useCallback, useMemo, useRef, useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { RxOnlyConfirmDialog } from "../RxOnlyConfirmDialog";
import { useCodeplugDownload } from "@/hooks/useCodeplugDownload";
import { collectRxOnly } from "@/lib/codeplug/rxOnly";
import { DEFAULT_SETTINGS } from "@/lib/codeplug/defaults";
import { makeChannel } from "@/lib/codeplug/__tests__/helpers";
import type { NormalizedChannel, RxOnlyPolicy, Settings } from "@/lib/codeplug/models";
import "@/lib/codeplug/targets";

/**
 * Testharness som speglar exportgrinden i `src/routes/index.tsx` exakt:
 * samma predikat, samma state-flöde och samma download-hook. Vi renderar
 * inte hela routen (den kräver router-/localStorage-kontext och hela
 * previewträdet) — grinden är dock isolerad till dessa rader.
 */
function ExportHarness({
  exportChannels,
  settings = DEFAULT_SETTINGS,
}: {
  exportChannels: NormalizedChannel[];
  settings?: Settings;
}) {
  const { exportFiles } = useCodeplugDownload({ settings, exportChannels });
  const rxOnlyInExport = useMemo(() => collectRxOnly(exportChannels), [exportChannels]);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const runExport = useCallback(async () => {
    await exportFiles();
  }, [exportFiles]);

  const close = useCallback(() => {
    setOpen(false);
    btnRef.current?.focus();
  }, []);

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => {
          if (rxOnlyInExport.length > 0) {
            setOpen(true);
            return;
          }
          void runExport();
        }}
      >
        Exportera
      </button>
      <RxOnlyConfirmDialog
        open={open}
        channels={rxOnlyInExport}
        targetId={settings.export.targetId}
        rxOnlyPolicy={settings.packs.rxOnlyPolicy}
        onCancel={close}
        onConfirm={() => {
          close();
          void runExport();
        }}
      />
    </>
  );
}

const rxOnlyChannel = (name: string, freq: number) =>
  makeChannel({
    source_type: "channel_pack",
    pack_id: "se_airband",
    generated_name_final: name,
    rx_frequency: freq,
    duplex: "",
    rx_only: true,
    tx_allowed: false,
  });

describe("RX-only-bekräftelse före export", () => {
  let clickSpy: ReturnType<typeof vi.fn>;
  let originalCreate: typeof URL.createObjectURL;
  let originalRevoke: typeof URL.revokeObjectURL;
  let originalClick: typeof HTMLAnchorElement.prototype.click;

  beforeEach(() => {
    originalCreate = URL.createObjectURL;
    originalRevoke = URL.revokeObjectURL;
    originalClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = vi.fn(() => "blob:mock") as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
    clickSpy = vi.fn();
    HTMLAnchorElement.prototype.click = clickSpy as unknown as () => void;
    // jsdom saknar layoutimplementation för <dialog> i vissa versioner.
    if (!HTMLDialogElement.prototype.showModal) {
      HTMLDialogElement.prototype.showModal = function () {
        this.open = true;
      };
      HTMLDialogElement.prototype.close = function () {
        this.open = false;
      };
    }
  });

  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    HTMLAnchorElement.prototype.click = originalClick;
  });

  const clickExport = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Exportera" }));
    await new Promise((r) => setTimeout(r, 0));
  };

  const confirmButton = () => screen.getByRole("button", { name: "Jag förstår – exportera" });

  it("exporterar direkt när inga RX-only-kanaler finns", async () => {
    render(<ExportHarness exportChannels={[makeChannel({ generated_name_final: "SK6BA" })]} />);
    await clickExport();
    expect(screen.queryByText("Bekräfta export med RX-only-kanaler")).toBeNull();
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("exporterar direkt när rxOnlyPolicy=skip har tagit bort raderna", async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      packs: { ...DEFAULT_SETTINGS.packs, rxOnlyPolicy: "skip" as RxOnlyPolicy },
    };
    // skip → pipelinen levererar inga RX-only-rader alls.
    render(<ExportHarness exportChannels={[makeChannel()]} settings={settings} />);
    await clickExport();
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("blockerar nedladdning tills användaren bekräftar", async () => {
    render(<ExportHarness exportChannels={[makeChannel(), rxOnlyChannel("AIR-1", 118.1)]} />);
    await clickExport();
    expect(screen.getByText("Bekräfta export med RX-only-kanaler")).toBeTruthy();
    expect(clickSpy).not.toHaveBeenCalled();

    // Primärknappen är disabled tills checkboxen är markerad.
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(confirmButton());
    await new Promise((r) => setTimeout(r, 0));
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("avbryt ger ingen nedladdning och återför fokus till exportknappen", async () => {
    render(<ExportHarness exportChannels={[rxOnlyChannel("AIR-1", 118.1)]} />);
    await clickExport();
    fireEvent.click(screen.getByRole("button", { name: "Avbryt" }));
    expect(clickSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Exportera" }));
  });

  it("Escape avbryter utan nedladdning", async () => {
    render(<ExportHarness exportChannels={[rxOnlyChannel("AIR-1", 118.1)]} />);
    await clickExport();
    const dialog = document.querySelector("dialog")!;
    fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
    expect(clickSpy).not.toHaveBeenCalled();
    expect(screen.queryByText("Bekräfta export med RX-only-kanaler")).toBeNull();
  });

  it("dialogen återkommer vid nästa exportförsök med urkryssad checkbox", async () => {
    render(<ExportHarness exportChannels={[rxOnlyChannel("AIR-1", 118.1)]} />);
    await clickExport();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirmButton());
    await new Promise((r) => setTimeout(r, 0));
    expect(clickSpy).toHaveBeenCalledTimes(1);

    await clickExport();
    expect(screen.getByText("Bekräfta export med RX-only-kanaler")).toBeTruthy();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("manuellt exkluderade RX-only-rader triggar inte dialogen", async () => {
    // Routen skickar redan in exportChannels utan exkluderade rader.
    render(<ExportHarness exportChannels={[makeChannel()]} />);
    await clickExport();
    expect(screen.queryByText("Bekräfta export med RX-only-kanaler")).toBeNull();
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("tx_allowed=false utan rx_only triggar dialogen", async () => {
    render(
      <ExportHarness
        exportChannels={[makeChannel({ tx_allowed: false, generated_name_final: "MARIN" })]}
      />,
    );
    await clickExport();
    expect(screen.getByText("Bekräfta export med RX-only-kanaler")).toBeTruthy();
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("visar antal och upp till tre exempel", async () => {
    const many = [1, 2, 3, 4].map((i) => rxOnlyChannel(`AIR-${i}`, 118 + i / 100));
    render(<ExportHarness exportChannels={many} />);
    await clickExport();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText(/AIR-1 — 118\.01000 MHz/)).toBeTruthy();
    expect(screen.getByText(/AIR-3/)).toBeTruthy();
    expect(screen.queryByText(/AIR-4 —/)).toBeNull();
    expect(screen.getByText("+ 1 till")).toBeTruthy();
  });

  it("RT Systems + mark får den skarpare texten", async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      packs: { ...DEFAULT_SETTINGS.packs, rxOnlyPolicy: "mark" as RxOnlyPolicy },
      export: { ...DEFAULT_SETTINGS.export, targetId: "rt-systems-yaesu-generic" },
    };
    render(<ExportHarness exportChannels={[rxOnlyChannel("AIR-1", 118.1)]} settings={settings} />);
    await clickExport();
    expect(screen.getByText(/kan inte uttrycka RX-only/)).toBeTruthy();
  });

  it("övriga targets får den försiktiga generella texten", async () => {
    render(<ExportHarness exportChannels={[rxOnlyChannel("AIR-1", 118.1)]} />);
    await clickExport();
    expect(screen.getByText(/Appen skapar bara en fil/)).toBeTruthy();
  });
});
