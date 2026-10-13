/** Wallet participation state boundary (participation gating).
 *
 *  Exposes ONLY whether a user is eligible to participate via booleans (capabilities).
 *  Does NOT expose:
 *    - wallet address
 *    - balance
 *    - seed or private keys
 *    - UFVK (Unified Full Viewing Key)
 *    - transaction history
 *    - wallet identifier
 *
 *  This is a clean privacy boundary: social, voice, project, and UI systems
 *  consume capability booleans without accessing financial data.
 *
 *  PRIVACY BOUNDARY: Participation system must never expose
 *  wallet data to WebSocket presence, remote player state, nameplates,
 *  voice metadata, or social UI state. Only capability booleans cross into
 *  generic social/UI systems.
 *
 *  ADR-015 § 4 amends that boundary by exactly ONE bit: the
 *  sticky `walletHolder` flag below. App sends it to the server (`join.wallet`
 *  / `set_wallet`) and the server publishes it to other players as
 *  `canReceive` ("can receive ZEC privately"). It says only "this page
 *  session has had an unlocked in-game wallet" — never an address, balance,
 *  network, lock state or unlock time. It is sticky: true from the first
 *  `ready`/`syncing`, it stays true through `locked` and `disconnected` (so
 *  lock/unlock times never reach the network), and becomes false only on
 *  `idle` after having been true ("Forget this wallet on this device").
 */

import type { WalletStatus } from "./WalletTypes";

/**
 * Wallet-gated participation capabilities.
 * Only includes currently implemented features.
 * Future capabilities can be added to this interface when implemented.
 */
export interface ParticipationCapabilities {
  /** Can participate in proximity voice chat (Enable Voice button enabled) */
  canVoice: boolean;
  /** Can send support/ZEC to projects */
  canSupportProjects: boolean;
}

interface ParticipationState {
  /** Whether wallet is connected and usable (internal only) */
  walletConnected: boolean;
  /** Whether user is eligible for social/product features (same as walletConnected for now) */
  participationEligible: boolean;
  /** When the eligibility state last changed */
  lastUpdated: number;
}

let participationState: ParticipationState = {
  walletConnected: false,
  participationEligible: false,
  lastUpdated: Date.now(),
};

let capabilityListeners: Array<(capabilities: ParticipationCapabilities) => void> = [];

/** ADR-015: the sticky wallet-holder flag (see the header). */
let walletHolder = false;
let holderListeners: Array<(holder: boolean) => void> = [];

/** ADR-015: whether this page session is a wallet holder (sticky — see the header). A boolean only. */
export function isWalletHolder(): boolean {
  return walletHolder;
}

/** ADR-015: subscribe to the wallet-holder flag; called at once with the current value, then on every change. */
export function subscribeToWalletHolder(listener: (holder: boolean) => void): () => void {
  holderListeners.push(listener);
  listener(walletHolder);
  return () => {
    holderListeners = holderListeners.filter((l) => l !== listener);
  };
}

function setWalletHolder(next: boolean): void {
  if (next === walletHolder) return;
  walletHolder = next;
  for (const listener of [...holderListeners]) listener(next);
}

/** Get current participation state (for testing wallet state transitions).
 *  Internal type; exposed only for test assertions on wallet lifecycle.
 */
export function getParticipationState(): { walletConnected: boolean; participationEligible: boolean; lastUpdated: number } {
  return Object.freeze({ ...participationState });
}

/** Get current participation capabilities.
 *  Only exposes capability booleans, never wallet data.
 */
export function getParticipationCapabilities(): Readonly<ParticipationCapabilities> {
  const isReady = participationState.participationEligible;
  return Object.freeze({
    canVoice: isReady,
    canSupportProjects: isReady,
  });
}

/** Subscribe to capability changes.
 *  Use this for gating UI features instead of subscribeToParticipationState.
 */
export function subscribeToCapabilities(
  listener: (capabilities: ParticipationCapabilities) => void
): () => void {
  capabilityListeners.push(listener);
  // Immediately call with current state
  listener(getParticipationCapabilities());
  return () => {
    capabilityListeners = capabilityListeners.filter((l) => l !== listener);
  };
}

/** Update participation state based on wallet status.
 *  Called by wallet initialization/connection logic.
 *  This is the ONLY place that touches participationState.
 */
export function updateParticipationState(walletStatus: WalletStatus): void {
  // "syncing" is an UNLOCKED wallet doing background work (sync, or broadcasting a payment). Treating it as
  // ineligible would kick players out of voice on every sync — the rule is "voice ends when the wallet locks",
  // so ready and syncing both count as unlocked.
  const unlocked = walletStatus === "ready" || walletStatus === "syncing";
  // ADR-015 sticky holder flag: set by the first unlock, cleared only when the wallet is gone (idle after being a holder).
  if (unlocked) setWalletHolder(true);
  else if (walletStatus === "idle") setWalletHolder(false);
  const newState: ParticipationState = {
    walletConnected: unlocked,
    participationEligible: unlocked,
    lastUpdated: Date.now(),
  };

  // Only notify listeners if state changed
  if (
    participationState.walletConnected !== newState.walletConnected ||
    participationState.participationEligible !== newState.participationEligible
  ) {
    participationState = newState;
    capabilityListeners.forEach((listener) => listener(getParticipationCapabilities()));
  }
}

/** Reset participation state on disconnect. ADR-015: the wallet-holder flag is sticky and survives this. */
export function resetParticipationState(): void {
  participationState = {
    walletConnected: false,
    participationEligible: false,
    lastUpdated: Date.now(),
  };
  capabilityListeners.forEach((listener) => listener(getParticipationCapabilities()));
}

/** Test seam for verifying listener cleanup */
export const __testSeam = {
  getListenerCount: () => capabilityListeners.length,
  clearAllListeners: () => {
    capabilityListeners = [];
    holderListeners = [];
  },
  /** Back to a fresh page session (no holder), without notifying anyone. */
  resetWalletHolder: () => {
    walletHolder = false;
  },
};
