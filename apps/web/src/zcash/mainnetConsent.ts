/**
 * The mainnet beta's consent step (ADR-018 § 4): before a wallet is created, restored or unlocked on
 * mainnet for the first time on this device, the player confirms that this is experimental, unaudited software
 * handling real money and that they will use a fresh wallet with a small amount.
 *
 * Remembered per device (localStorage `zw-mainnet-consent-v1`, the wording version), every access in try/catch: when
 * storage is unavailable the consent lasts for this page only, so the step simply appears again next time. Nothing
 * about it leaves the browser.
 */

export const MAINNET_CONSENT_KEY = "zw-mainnet-consent-v1";
/** Bump when the wording changes materially: everyone is asked again. */
export const MAINNET_CONSENT_VERSION = 1;

export const MAINNET_CONSENT_TITLE = "Real money — experimental beta";
export const MAINNET_CONSENT_POINTS: readonly string[] = [
  "This in-game wallet is experimental, unaudited software. It handles real ZEC on the Zcash mainnet.",
  "Use a fresh wallet with a small amount — never your main savings. Each transaction is limited during the beta.",
  "Your seed phrase stays in this browser, encrypted with your passphrase. If you lose both, nobody can recover your coins.",
  "Payments to players are shielded. Deposits from an exchange's transparent address are public on the chain.",
];
export const MAINNET_CONSENT_CHECKBOX = "I understand: experimental, unaudited software, real money. I'll use a fresh wallet with a small amount.";

type ConsentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

let memoryConsent = false;

function storage(override?: ConsentStorage | null): ConsentStorage | null {
  if (override !== undefined) return override;
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Whether this device already agreed to the current wording. */
export function hasMainnetConsent(store?: ConsentStorage | null): boolean {
  if (memoryConsent) return true;
  try {
    const raw = storage(store)?.getItem(MAINNET_CONSENT_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { v?: unknown };
    return parsed.v === MAINNET_CONSENT_VERSION;
  } catch {
    return false;
  }
}

/** Records the consent (and keeps it for this page even if storage fails). */
export function giveMainnetConsent(store?: ConsentStorage | null, now: number = Date.now()): void {
  memoryConsent = true;
  try {
    storage(store)?.setItem(MAINNET_CONSENT_KEY, JSON.stringify({ v: MAINNET_CONSENT_VERSION, at: now }));
  } catch {
    // Storage unavailable: asked again next time.
  }
}

/** Tests only: forget the in-memory consent. */
export function resetMainnetConsentForTests(store?: ConsentStorage | null): void {
  memoryConsent = false;
  try {
    storage(store)?.removeItem(MAINNET_CONSENT_KEY);
  } catch {
    // ignore
  }
}
