import { useEffect, useRef, useState } from "react";
import type { NormalizedChannel } from "@/lib/codeplug/models";
import type { RxOnlyPolicy } from "@/lib/codeplug/models";

const CHECKBOX_LABEL =
  "Jag förstår att jag själv måste verifiera i radion att sändning är spärrad.";

/**
 * Targetspecifikt tillägg. RT Systems Yaesu kan inte uttrycka RX-only i sin
 * CSV — raderna blir Simplex med TX=RX och är därmed sändningsbara. Övriga
 * targets skriver någon form av spärr, men appen kan ändå inte lova något
 * om importverktyget eller radion.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function rxOnlyDialogTargetNote(targetId: string, rxOnlyPolicy: RxOnlyPolicy): string {
  if (targetId === "rt-systems-yaesu-generic" && rxOnlyPolicy === "mark") {
    return (
      "RT Systems-formatet kan inte uttrycka RX-only. Kanalerna skrivs som Simplex med " +
      "sändningsfrekvens = mottagningsfrekvens, vilket innebär att radion kan sända på dem."
    );
  }
  return (
    "Appen skapar bara en fil. Den kan inte garantera vad importverktyget eller radion gör " +
    "med kanalerna."
  );
}

function formatExample(c: NormalizedChannel): string {
  const name = c.generated_name_final || c.generated_name_full || "(namnlös)";
  const freq = c.rx_frequency != null ? `${c.rx_frequency.toFixed(5)} MHz` : "okänd frekvens";
  return `${name} — ${freq}`;
}

export function RxOnlyConfirmDialog({
  open,
  channels,
  targetId,
  rxOnlyPolicy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** Endast RX-only-kanalerna ur den faktiska exporten. */
  channels: NormalizedChannel[];
  targetId: string;
  rxOnlyPolicy: RxOnlyPolicy;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) {
      setAcknowledged(false);
      if (!el.open) el.showModal?.();
    } else if (el.open) {
      el.close();
    }
  }, [open]);

  if (!open) return null;

  /**
   * Stäng det native-elementet SYNKRONT medan det fortfarande är monterat.
   * Föräldern sätter `open=false` i callbacken, vilket avmonterar dialogen —
   * hinner vi inte anropa close() först lämnas dokumentet i modalt/inert
   * läge och fokus återställs aldrig. Webbläsaren flyttar själv tillbaka
   * fokus till elementet som öppnade modalen efter close().
   */
  const closeThen = (cb: () => void) => {
    const el = ref.current;
    if (el?.open) el.close();
    cb();
  };

  const count = channels.length;
  const examples = channels.slice(0, 3);
  const rest = Math.max(0, count - examples.length);

  return (
    <dialog
      ref={ref}
      aria-labelledby="rx-only-confirm-title"
      aria-describedby="rx-only-confirm-desc"
      onCancel={(e) => {
        // Escape: låt inte webbläsaren stänga tyst — kör vår avbryt-väg så
        // att fokus återgår till exportknappen.
        e.preventDefault();
        closeThen(onCancel);
      }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-border bg-card p-5 text-foreground backdrop:bg-black/50"
    >
      <h2 id="rx-only-confirm-title" className="text-base font-semibold">
        Bekräfta export med RX-only-kanaler
      </h2>

      <div id="rx-only-confirm-desc" className="mt-3 space-y-3 text-sm text-muted-foreground">
        <p>
          Exporten innehåller <strong className="text-foreground">{count}</strong>{" "}
          {count === 1 ? "kanal" : "kanaler"} som är avsedda endast för mottagning, till exempel
          flygradio, marin VHF och andra tjänster där sändning kan vara olaglig.
        </p>
        <p>{rxOnlyDialogTargetNote(targetId, rxOnlyPolicy)}</p>
        <p>Kontrollera i radion att PTT är spärrad på dessa kanaler innan du använder dem.</p>
        <ul className="rounded border border-border bg-muted/40 px-3 py-2 font-mono text-xs">
          {examples.map((c, i) => (
            <li key={i}>{formatExample(c)}</li>
          ))}
          {rest > 0 && <li className="text-muted-foreground">+ {rest} till</li>}
        </ul>
      </div>

      <label className="mt-4 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="mt-0.5"
        />
        <span>{CHECKBOX_LABEL}</span>
      </label>

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => closeThen(onCancel)}
          className="rounded border border-border px-3 py-1.5 text-sm"
        >
          Avbryt
        </button>
        <button
          type="button"
          onClick={() => closeThen(onConfirm)}
          disabled={!acknowledged}
          className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          Jag förstår – exportera
        </button>
      </div>
    </dialog>
  );
}
