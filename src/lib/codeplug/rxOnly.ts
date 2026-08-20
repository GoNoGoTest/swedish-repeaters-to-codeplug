import type { NormalizedChannel } from "./models";
import { hasRxOnlySourceFlags } from "./txIntent";

/**
 * Enda källan till sanning för "är den här kanalen avsedd endast för
 * mottagning?" i UI-lagret (statistik, passiv banner och den blockerande
 * exportbekräftelsen).
 *
 * Predikatet är medvetet brett: utöver paketflaggorna `rx_only`/`tx_allowed`
 * räknas även `duplex === "off"`, eftersom både pipelinens `block_tx`-policy
 * och kanalpaketen använder det för att uttrycka TX-spärr. Att felaktigt
 * fråga användaren en gång för mycket är bättre än att missa en RX-only-rad.
 *
 * Notera: funktionen ändrar inget i exporten och används inte av någon
 * exporter — targets äger fortfarande sin egen serialisering.
 */
export function isRxOnlyChannel(c: NormalizedChannel): boolean {
  return c.tx_intent !== "normal" || hasRxOnlySourceFlags(c);
}

/** Alla RX-only-kanaler i den faktiska exportlistan, i exportordning. */
export function collectRxOnly(channels: NormalizedChannel[]): NormalizedChannel[] {
  return channels.filter(isRxOnlyChannel);
}
