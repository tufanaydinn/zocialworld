/**
 * The mainnet beta's per-transaction cap (ADR-018 § 4): 0.01 ZEC per transaction by default; the operator can raise
 * or lift it.
 *
 *  - It applies to every transaction sent from the game on MAINNET: a player payment (the amount the recipient gets —
 *    the transfer fee comes on top), a withdrawal to the player's own wallet, and the name fee.
 *  - Shielding one's own transparent funds is exempt (the funds stay in the player's own wallet).
 *  - One setting, VITE_MAINNET_TX_CAP_ZEC: default 0.01; `off` removes it. An unreadable value keeps the default (fail
 *    safe). The test chain has no cap.
 *  - Enforced in the wallet adapter (ZcashWalletAdapter), not only in the UI; the server also refuses relayed payment
 *    requests whose declared cap is above its own (PAYMENT_CAP_ZEC).
 *
 * Pure: no DOM, no wallet engine.
 */

export type CapPurpose = "payment" | "withdrawal" | "name_fee" | "shield";

export const DEFAULT_MAINNET_CAP_ZAT = 1_000_000n; // 0.01 ZEC

/** "0.01" → 1_000_000n exactly; null for anything that is not a positive amount with at most 8 decimals. */
export function parseZecAmount(text: string): bigint | null {
  const match = /^(\d{1,8})(?:\.(\d{1,8}))?$/.exec(text.trim());
  if (!match) return null;
  const zat = BigInt(match[1]!) * 100_000_000n + BigInt((match[2] ?? "").padEnd(8, "0"));
  return zat > 0n ? zat : null;
}

/** The cap for a network and the VITE_MAINNET_TX_CAP_ZEC setting: null = no cap (test chain, or `off`). */
export function capForNetwork(network: "main" | "test", setting: string | undefined): bigint | null {
  if (network !== "main") return null;
  const raw = (setting ?? "").trim();
  if (raw.toLowerCase() === "off") return null;
  if (raw === "") return DEFAULT_MAINNET_CAP_ZAT;
  return parseZecAmount(raw) ?? DEFAULT_MAINNET_CAP_ZAT;
}

/** 1000000n → "0.01" (exact). */
export function formatZatBig(zat: bigint): string {
  const negative = zat < 0n;
  const abs = negative ? -zat : zat;
  const whole = abs / 100_000_000n;
  const fraction = (abs % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export class CapExceededError extends Error {
  readonly code = "over_cap";
  readonly capZat: bigint;
  constructor(capZat: bigint, unit: string) {
    super(`over_cap: the beta limit is ${formatZatBig(capZat)} ${unit} per transaction`);
    this.capZat = capZat;
  }
}

/** Null when `amountZat` may be sent for `purpose` under `capZat`; otherwise the error to throw. Shielding is exempt. */
export function capProblem(amountZat: bigint, purpose: CapPurpose, capZat: bigint | null, unit = "ZEC"): CapExceededError | null {
  if (capZat === null || purpose === "shield") return null;
  return amountZat > capZat ? new CapExceededError(capZat, unit) : null;
}
