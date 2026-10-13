// Safe public wallet types for the Zocial World wallet integration.
// These types are used by UI layers and other modules to interact with the wallet.

/** Wallet adapter status lifecycle.
 *  - idle: no wallet created/imported yet
 *  - locked: encrypted seed exists but wallet not unlocked (passphrase required)
 *  - initializing: attempting to create/import/unlock wallet
 *  - syncing: active wallet syncing with blockchain
 *  - ready: wallet open and usable
 *  - error: wallet initialization or operation failed
 *  - disconnected: wallet deliberately closed (preserved on disk)
 */
export type WalletStatus = "idle" | "locked" | "initializing" | "syncing" | "ready" | "error" | "disconnected";

export interface ProjectSupportTarget {
  /** Project ID in the project registry */
  projectId: string;
  /** Recipient address for support funds (shielded Zcash address) */
  recipientAddress: string;
  /** Zcash network: "main" or "test" */
  network: "main" | "test";
  /** Human-readable label for this support target (e.g. "Support [Project Name]") */
  label: string;
}

export interface SupportIntent {
  target: ProjectSupportTarget;
  /** Authoritative amount in zatoshi (1 ZEC = 100,000,000 zatoshi). Never use JS number. */
  amountZatoshi: bigint;
  /** Display amount as decimal ZEC string (e.g. "1.5") */
  amountDisplayZec: string;
  memo: string;
  /** Timestamp when the intent was created */
  createdAt: number;
}

export interface SupportConfirmation {
  intent: SupportIntent;
  /** User has reviewed and confirmed the support details */
  confirmed: boolean;
  /** Transaction ID from the blockchain */
  txid?: string;
  /** Error message if the support failed */
  error?: string;
}
