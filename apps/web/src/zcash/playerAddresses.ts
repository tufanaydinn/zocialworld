/**
 * Other players' receive addresses this wallet unsealed during this page session (from
 * their `pay_accept`), so "Withdraw" can refuse to pay one of them fee-free. A deterrent for the stock client only —
 * the client cannot know who owns an address, and a player can always pay another one from outside the game
 * (docs/privacy/PLAYER_PAYMENTS_THREAT_MODEL.md § Mainnet, "Skipping the fee").
 *
 * In memory only: never stored, logged, rendered or sent. Pure: no DOM, no wallet engine.
 */

const MAX_REMEMBERED = 64;
const remembered = new Set<string>();

function normalize(address: string): string {
  return address.trim().toLowerCase();
}

/** Remembers an address another player's wallet sealed to this one (oldest dropped beyond MAX_REMEMBERED). */
export function rememberPlayerAddress(address: string): void {
  const key = normalize(address);
  if (!key) return;
  remembered.delete(key);
  remembered.add(key);
  while (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.values().next().value as string);
}

/** Whether any of `addresses` (as typed, or as the engine resolved it) is a player's address from this session. */
export function isKnownPlayerAddress(...addresses: readonly (string | null | undefined)[]): boolean {
  return addresses.some((address) => typeof address === "string" && remembered.has(normalize(address)));
}

/** Test seam. */
export function forgetPlayerAddresses(): void {
  remembered.clear();
}
