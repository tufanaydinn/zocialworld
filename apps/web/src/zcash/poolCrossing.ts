/**
 * ADR-018 § 3: when a payment or a withdrawal becomes visible on the chain
 * through a POOL CROSSING.
 *
 * The Stage-2 engine pays a `zs1…` address — or a unified address without an Orchard-family receiver (Sapling +
 * transparent, e.g. a Stage-1 player's address) — as a SAPLING output. A player's shielded funds are normally in
 * Ironwood (every shielding and every change goes there). The engine spends the output's own pool first (upstream's
 * "fewest pool crossings"), so when the Sapling notes do not cover the amount and the fees, Ironwood (or legacy
 * Orchard) notes pay it: value moves from Ironwood into Sapling, and the transaction's Sapling value balance — a public
 * field — shows that value. With Ironwood funds only, it is exactly the amount (plus a Sapling fee output, if any).
 * The addresses stay private.
 *
 * Pure: no DOM, no wallet engine.
 */

const ZAT_PER_ZEC = 100_000_000;

/**
 * Whether paying `neededZat` (outputs + network fee) to an output of `recipientPool` moves value from Ironwood (or
 * legacy Orchard) into Sapling, making the amount public. Unknown per-pool balances count as "crosses" (the warning is
 * then shown rather than missed).
 */
export function saplingOutputCrossesPools(
  recipientPool: string | null,
  neededZat: bigint,
  pools: { readonly saplingZec: number } | undefined,
): boolean {
  if (recipientPool !== "sapling") return false;
  if (!pools || !Number.isFinite(pools.saplingZec)) return true;
  const saplingZat = BigInt(Math.round(pools.saplingZec * ZAT_PER_ZEC));
  return saplingZat < neededZat;
}

/** The note on the withdrawal's Review step. */
export const SAPLING_CROSSING_WITHDRAW_NOTE =
  "This is a Sapling address and your shielded funds are in Ironwood: the withdrawal moves them from one pool to the other, so the amount becomes public on the chain (the addresses stay private). To keep the amount private, use your wallet's full unified address (u1…) instead.";

/** The player-payment confirmation's warning: the recipient's (older) client gave a Sapling address. */
export function saplingCrossingPaymentNote(nickname: string): string {
  return `${nickname}'s wallet gave a Sapling address (an older version of the game). Paying it from your Ironwood funds moves them from one pool to the other, so the amount becomes public on the chain — and the game server can read it from the transaction. The addresses stay private.`;
}
