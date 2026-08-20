import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useCallback, useMemo, useRef, useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { RxOnlyConfirmDialog } from "../RxOnlyConfirmDialog";
import { ExportPanel, RtSystemsRxOnlySkippedNote } from "../ExportPanel";
import { useCodeplugDownload } from "@/hooks/useCodeplugDownload";
import { collectRxOnly } from "@/lib/codeplug/rxOnly";
import {
  resolveEffectiveRxOnlyPolicy,
  withEffectiveRxOnlyPolicy,
} from "@/lib/codeplug/rxOnlyPolicy";
import { runPipeline } from "@/lib/codeplug/pipeline";
import { DEFAULT_SETTINGS } from "@/lib/codeplug/defaults";
import { makeChannel } from "@/lib/codeplug/__tests__/helpers";
import type { RxOnlyPolicy, Settings } from "@/lib/codeplug/models";
import "@/lib/codeplug/targets";

const rxOnlyPack = () =>
  makeChannel({
    source_type: "channel_pack",
    pack_id: "se_airband",
    generated_name_final: "AIR-1",
    rx_frequency: 118.1,
    tx_frequency: null,
    duplex: "",
    tx_shift: 0,
    offset: 0,
    rx_only: true,
    tx_allowed: false,
  });

/**
 * Harness som speglar `src/routes/index.tsx`: requested policy lever i
 * settings, targetbyte ändrar bara `export.targetId`, och pipeline + UI
 * kör på den *effektiva* policyn.
 */
function RouteHarness({ initial = DEFAULT_SETTINGS }: { initial?: Settings }) {
  const [settings, setSettings] = useState<Settings>(initial);
  const packChannels = useMemo(() => [rxOnlyPack()], []);

  const effectiveRxOnlyPolicy = resolveEffectiveRxOnlyPolicy(
    settings.export.targetId,
    settings.packs.rxOnlyPolicy,
  );
  const effectiveSettings = withEffectiveRxOnlyPolicy(settings);

  const pipeline = runPipeline({ sk6baRows: [], packChannels, settings: effectiveSettings });
  const exportChannels = pipeline.channels;
  const rxOnlyInExport = collectRxOnly(exportChannels);

  const { exportFiles } = useCodeplugDownload({ settings, exportChannels });
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => {
    setOpen(false);
    btnRef.current?.focus();
  }, []);

  const setTargetId = (targetId: string) =>
    setSettings((prev) => ({ ...prev, export: { ...prev.export, targetId } }));

  return (
    <>
      <div data-testid="requested">{settings.packs.rxOnlyPolicy}</div>
      <div data-testid="effective">{effectiveRxOnlyPolicy}</div>
      <div data-testid="exported">{exportChannels.length}</div>
      {["chirp-generic", "vgc-n76", "nicsure-rt880", "rt-systems-yaesu-generic"].map((id) => (
        <button key={id} onClick={() => setTargetId(id)}>
          {`target:${id}`}
        </button>
      ))}
      <RtSystemsRxOnlySkippedNote
        sourceHasRxOnly
        targetId={settings.export.targetId}
        rxOnlyPolicy={effectiveRxOnlyPolicy}
      />
      <ExportPanel
        settings={settings}
        setSettings={setSettings}
        hasPacks
        chirpSettings={{ startLocation: 1, mode: "NFM", tStep: 5.0, skipLinks: false, maxLength: 6 }}
        targetSettings={{}}
        setTargetSettings={() => {}}
        channels={exportChannels}
        effectiveRxOnlyPolicy={effectiveRxOnlyPolicy}
      />
      <button
        ref={btnRef}
        onClick={() => {
          if (rxOnlyInExport.length > 0) {
            setOpen(true);
            return;
          }
          void exportFiles();
        }}
      >
        Exportera
      </button>
      <RxOnlyConfirmDialog
        open={open}
        channels={rxOnlyInExport}
        targetId={settings.export.targetId}
        rxOnlyPolicy={effectiveRxOnlyPolicy}
        onCancel={close}
        onConfirm={() => {
          close();
          void exportFiles();
        }}
      />
    </>
  );
}

describe("targetväxling och RX-only-policy", () => {
  let clickSpy: ReturnType<typeof vi.fn>;
  let originalClick: typeof HTMLAnchorElement.prototype.click;
  let originalCreate: typeof URL.createObjectURL;
  let originalRevoke: typeof URL.revokeObjectURL;

  beforeEach(() => {
    originalCreate = URL.createObjectURL;
    originalRevoke = URL.revokeObjectURL;
    originalClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = vi.fn(() => "blob:mock") as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
    clickSpy = vi.fn();
    HTMLAnchorElement.prototype.click = clickSpy as unknown as () => void;
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

  const switchTo = (id: string) => fireEvent.click(screen.getByText(`target:${id}`));
  const clickExport = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Exportera" }));
    await new Promise((r) => setTimeout(r, 0));
  };
  const modalShown = () => screen.queryByText("Bekräfta export med RX-only-kanaler") !== null;

  it("regression: RT Systems ger effektiv skip utan att mutera requested; byte tillbaka ger block_tx", () => {
    render(<RouteHarness />);
    expect(screen.getByTestId("requested").textContent).toBe("block_tx");

    switchTo("rt-systems-yaesu-generic");
    expect(screen.getByTestId("requested").textContent).toBe("block_tx");
    expect(screen.getByTestId("effective").textContent).toBe("skip");
    // RX-only-raden hoppas över.
    expect(screen.getByTestId("exported").textContent).toBe("0");
    expect(screen.getByText(/RX-only-kanaler hoppas över/)).toBeTruthy();

    for (const id of ["chirp-generic", "vgc-n76", "nicsure-rt880"]) {
      switchTo(id);
      expect(screen.getByTestId("requested").textContent).toBe("block_tx");
      expect(screen.getByTestId("effective").textContent).toBe("block_tx");
      expect(screen.getByTestId("exported").textContent).toBe("1");
    }
  });

  it("selecten visar den effektiva fallbacken men explicit val uppdaterar requested", () => {
    render(<RouteHarness />);
    switchTo("rt-systems-yaesu-generic");
    const select = (screen.getAllByRole("combobox") as HTMLSelectElement[]).find((el) =>
      Array.from(el.options).some((o) => o.value === "mark"),
    )!;
    expect(select.value).toBe("skip");

    fireEvent.change(select, { target: { value: "mark" } });
    expect(screen.getByTestId("requested").textContent).toBe("mark");
    expect(screen.getByTestId("effective").textContent).toBe("mark");
  });

  it("RT Systems + effektiv skip: direkt export utan modal", async () => {
    render(<RouteHarness />);
    switchTo("rt-systems-yaesu-generic");
    await clickExport();
    expect(modalShown()).toBe(false);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("RT Systems + explicit mark: modal med skarp RT-text och ingen download före bekräftelse", async () => {
    const initial: Settings = {
      ...DEFAULT_SETTINGS,
      packs: { ...DEFAULT_SETTINGS.packs, rxOnlyPolicy: "mark" as RxOnlyPolicy },
    };
    render(<RouteHarness initial={initial} />);
    switchTo("rt-systems-yaesu-generic");
    await clickExport();
    expect(modalShown()).toBe(true);
    expect(clickSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/kan inte uttrycka RX-only/)).toBeTruthy();
  });

  it("CHIRP/VGC/Nicsure efter RT-besök: modal krävs igen", async () => {
    for (const id of ["chirp-generic", "vgc-n76", "nicsure-rt880"]) {
      const view = render(<RouteHarness />);
      switchTo("rt-systems-yaesu-generic");
      switchTo(id);
      await clickExport();
      expect(modalShown()).toBe(true);
      expect(clickSpy).not.toHaveBeenCalled();
      view.unmount();
    }
  });
});
