/**
 * The approximate fiat value shown next to a fee ("Project fee ≈ US$1"). The fees themselves
 * are fixed ZEC amounts set by the operator (PAYMENT_FEE_ZEC, NAME_FEE_ZEC); the fiat value moves with the price, so
 * the client never assumes one. The game server publishes the operator's own approximate label (PAYMENT_FEE_USD,
 * NAME_FEE_USD → GET /zcash/info `payments.feeUsd` / `names.feeUsd`), and without one the client shows the ZEC
 * amount only.
 *
 * Pure: no DOM, no wallet engine.
 */

/** The largest label the client shows (a fee is capped far below this; anything above is a misconfiguration). */
const MAX_FEE_USD = 1000;

/** A published fee label: a finite amount above 0 and at most US$1,000, rounded to cents; null for anything else. */
export function parseFeeUsd(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_FEE_USD) return null;
  const cents = Math.round(value * 100);
  return cents > 0 ? cents / 100 : null;
}

/** 1 → "US$1", 1.5 → "US$1.50", 0.75 → "US$0.75". */
export function formatUsd(usd: number): string {
  return Number.isInteger(usd) ? `US$${usd}` : `US$${usd.toFixed(2)}`;
}

/** " ≈ US$1" after a label, or "" when the server published no fiat value. */
export function approxUsdSuffix(usd: number | null): string {
  return usd === null ? "" : ` ≈ ${formatUsd(usd)}`;
}
