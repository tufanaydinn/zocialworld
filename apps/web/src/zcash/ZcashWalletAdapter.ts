// Framework-independent Zcash wallet adapter for in-app wallet support.
// Public API: initialize, createWallet, importSeed, disconnect, sync, send, etc.
// This boundary isolates wallet concerns from the React/UI layer (for testability & reusability).

import {
  detectAddressKind,
  isShieldedKind,
  validateAddress,
  validateKey,
  validateSeedPhrase,
  ZCASH_NETWORK,
  type WalletAccount,
} from "./core/wallet-types";
import type { WalletStatus } from "./WalletTypes";
import { realGenerateMnemonic, realValidateMnemonic } from "./core/keys";
import { getSeed, setSeed, clearSeed, hasSeed, getAcct, setAcct, loadWalletDb, saveWalletDb, clearWalletDb, isBackupPending, setBackupPending, getBirthday, setBirthday } from "./core/store";
import { openWallet, parseZecToZatoshi, setProxyUrl, type ReceiveAddresses, type SendOutput, type SendResult, type SendingStatus, type ShieldResult, type ZecWallet } from "./core/wallet";
import { capForNetwork, capProblem, type CapPurpose } from "./txCap.ts";
import { engineErrorCode, isBroadcastPhaseError, walletErrorMessage } from "./engineErrors.ts";
import { stage1SaveBirthday } from "./stage1Save.ts";
import { updateParticipationState, resetParticipationState } from "./participation";
import { activateNameKeyFromMnemonic, clearNameKey } from "./nameKey";

export interface WalletState {
  status: WalletStatus;
  error: string | null;
  account: WalletAccount | null;
  /** Display-only balance in decimal ZEC (number).
   *  NOT used for payment amount calculations; kept separate from money boundary.
   *  Payment amounts always use: string → parseZecDecimalToZatoshi → bigint zatoshi.
   *  This balance is only for UI display (e.g., "You have 1.5 ZEC").
   *  Floating-point precision loss is acceptable here since it's display-only. */
  balance: WalletBalance | null;
  txidInProgress: string | null;
  /**
   * ADR-018 § 1: a new mainnet wallet whose seed-phrase backup was not confirmed yet. Until the backup
   * check passes, the adapter sends nothing and gives out no address.
   */
  backupPending: boolean;
  /**
   * A wallet saved by the Stage-1 engine is being restored from its encrypted seed and birthday (a
   * one-time rescan). Sending waits until it finishes; the Stage-1 save stays on the device until the restored wallet
   * is saved. null otherwise.
   */
  migration: WalletMigration | null;
  /**
   * Unlocking found a Stage-1 save whose birthday could not be read: the player is asked roughly when the
   * wallet was created (never for the seed — the keystore has it), then unlocks again with that birthday.
   */
  migrationNeedsBirthday: boolean;
}

/** The Stage-1 → Stage-2 restore in progress (for the progress line in the wallet panel). */
export interface WalletMigration {
  /** The rescan starts here (the wallet's birthday). */
  readonly fromHeight: number;
  /** The chain tip when the rescan started, once known. */
  readonly tipHeight: number | null;
  /** Date.now() when the rescan started. */
  readonly startedAt: number;
}

/** Display-only balances (see WalletState.balance). On mainnet `totalZec` is the SHIELDED spendable balance. */
export interface WalletBalance {
  totalZec: number;
  pendingZec: number;
  transparentZec: number;
  /** Confirmed transparent funds that can be shielded now ("waiting to be shielded"). */
  shieldableZec?: number;
  /** Spendable shielded funds per pool (Ironwood, Sapling, legacy Orchard), display only. */
  shieldedPools?: { ironwoodZec: number; saplingZec: number; orchardZec: number };
}

/**
 * ADR-018: one transaction from the game, by purpose. The beta cap (txCap.ts) applies to `amountZat` of
 * a payment, a withdrawal and a name fee; the project's transfer fee (payments only) is a second output in the same
 * transaction and comes on top of the cap.
 */
export interface SendRequest {
  readonly purpose: "payment" | "withdrawal" | "name_fee";
  readonly to: string;
  readonly amountZat: bigint;
  readonly memo?: string;
  readonly projectFee?: { readonly address: string; readonly amountZat: bigint; readonly memo: string };
}

export interface SendPreview {
  readonly networkFeeZat: number;
  readonly amountZat: bigint;
  readonly projectFeeZat: bigint;
  /**
   * The pool and receiver the engine resolved for the first output (`ironwood` for a
   * UA with an Orchard-family receiver, `sapling`, or `transparent` for a t1…/TEX withdrawal), so the confirmation can
   * say when an amount becomes public and Withdraw can recognise a player's address. null when the engine did not
   * report it.
   */
  readonly recipientPool: "ironwood" | "sapling" | "transparent" | null;
  readonly recipientAddress: string | null;
  /** The first output is a TEX (ZIP 320) withdrawal — two transactions, the network fee covers both. */
  readonly recipientTex: boolean;
}

export interface WalletAdapter {
  state: WalletState;
  initialize(proxyUrl: string): Promise<void>;
  createWallet(passphrase: string): Promise<string[]>;
  /** `birthdayHeight`: block height the wallet was first used at — scanning starts there (default: ~100 blocks ago, which misses older funds). */
  importSeed(seedPhrase: string, passphrase: string, birthdayHeight?: number): Promise<void>;
  importViewingKey(viewingKey: string): Promise<void>;
  /**
   * A Stage-1 save is restored from the decrypted seed and the wallet's birthday (stored, or read from the
   * save); `birthdayHeight` is used only when neither is available (`migrationNeedsBirthday`).
   */
  unlock(passphrase: string, options?: { readonly birthdayHeight?: number }): Promise<void>;
  lock(): Promise<void>;
  disconnect(): Promise<void>;
  sync(): Promise<void>;
  getAccount(): WalletAccount | null;
  getBalance(): WalletBalance | null;
  getReceiveAddress(): Promise<string>;
  /**
   * The address a player PAYMENT is sealed to. On mainnet the shielded-only unified address
   * (Orchard-family + Sapling receivers, `unifiedShielded`): the main unified address carries the transparent
   * "exchange" receiver, whose public deposit history must never reach another player. Elsewhere the receive address.
   */
  getPaymentAddress(): Promise<string>;
  /** The owner's receive addresses (full unified, shielded unified, Stage-1 unified, Sapling, transparent "exchange" address). Mainnet only. */
  getAddresses(): Promise<ReceiveAddresses>;
  /** The engine's upgrade guard (ADR-018 § 2). Mainnet only; on the test chain always allowed. */
  sendingStatus(): Promise<SendingStatus>;
  /** The network fee of a transaction, without proving (mainnet only). Enforces the cap. */
  previewSend(request: SendRequest): Promise<SendPreview>;
  /** Sends ONE transaction (recipient + optional project-fee output). Enforces the cap. Returns the (first) txid. */
  sendRequest(request: SendRequest): Promise<string>;
  /** As sendRequest, with every txid (two for a TEX withdrawal, in broadcast order). */
  sendRequestTxids(request: SendRequest): Promise<readonly string[]>;
  /** What shielding would move and cost (mainnet only; no cap, no project fee). */
  previewShield(): Promise<ShieldResult>;
  /** Shields every confirmed transparent UTXO into the wallet's own Ironwood balance. */
  shieldTransparent(): Promise<ShieldResult>;
  /** The backup check passed — the new wallet becomes usable. */
  confirmBackup(): void;
  sendShielded(toAddress: string, amountZec: string, memo: string): Promise<string>;
  send(toAddress: string, amountZec: string): Promise<string>;
  getTransactionStatus(txid: string): Promise<"pending" | "confirmed" | "failed" | "unknown">;
  clearAllData(): Promise<void>;
}

// Global wallet instance and state
let walletInstance: ZecWallet | null = null;
let currentState: WalletState = {
  status: "idle",
  error: null,
  account: null,
  balance: null,
  txidInProgress: null,
  backupPending: isBackupPending(),
  migration: null,
  migrationNeedsBirthday: false,
};
/** One sync at a time: a caller during a sync (auto-sync, a payment notice, the migration) gets one shared follow-up sync. */
let syncInFlight: Promise<void> | null = null;
let syncFollowUp: Promise<void> | null = null;

/**
 * TEST SEAM (unit tests only): the network and cap setting the adapter enforces. Production reads them from
 * VITE_ZCASH_NETWORK and VITE_MAINNET_TX_CAP_ZEC.
 */
export const __walletPolicyTestSeam = {
  network: null as "main" | "test" | null,
  capSetting: undefined as string | undefined,
};

function policyNetwork(): "main" | "test" {
  return __walletPolicyTestSeam.network ?? ZCASH_NETWORK;
}

/** The per-transaction cap in force (null = none): ADR-018 § 4, mainnet only. */
export function transactionCapZat(): bigint | null {
  const fromBuild = typeof import.meta !== "undefined" ? (import.meta.env?.VITE_MAINNET_TX_CAP_ZEC as string | undefined) : undefined;
  const fromNode = typeof process !== "undefined" ? process.env.VITE_MAINNET_TX_CAP_ZEC : undefined;
  const setting = __walletPolicyTestSeam.capSetting ?? fromBuild ?? fromNode;
  return capForNetwork(policyNetwork(), setting);
}

/** Throws the cap error when `amountZat` exceeds the cap for `purpose` (shielding is exempt). */
function enforceCap(amountZat: bigint, purpose: CapPurpose): void {
  const problem = capProblem(amountZat, purpose, transactionCapZat(), policyNetwork() === "main" ? "ZEC" : "TAZ");
  if (problem) throw problem;
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function requireBackup(): void {
  if (currentState.backupPending) throw codedError("backup_pending", "confirm the seed-phrase backup first");
}

/** Nothing is sent while a Stage-1 wallet is being rescanned (the engine would wait for the whole scan). */
function requireNotMigrating(): void {
  if (currentState.migration) throw codedError("wallet_migrating", "the wallet is being upgraded (a one-time rescan)");
}

function mainnetEngine(): NonNullable<ZecWallet["mainnetEngine"]> {
  if (!walletInstance) throw new Error("Wallet not open");
  if (!walletInstance.mainnetEngine) throw new Error("not available on this network (mainnet only)");
  return walletInstance.mainnetEngine;
}

/** A plausible birthday height (a positive whole number), else null. */
function validBirthday(height: number | null | undefined): number | null {
  return typeof height === "number" && Number.isSafeInteger(height) && height > 0 ? height : null;
}

/**
 * The account of a freshly opened wallet. A wallet created now (or recreated because its save could not
 * be used) records the birthday it was created with, so a later restore from the seed needs nothing else.
 */
function rememberBirthday(wallet: ZecWallet): void {
  const birthday = validBirthday(wallet.createdWithBirthday);
  if (birthday !== null) setBirthday(birthday);
}

function accountFor(address: string, source: WalletAccount["source"] = "created"): WalletAccount {
  return {
    address,
    kind: detectAddressKind(address),
    shielded: isShieldedKind(detectAddressKind(address)),
    source,
    label: "Zocial World wallet",
    watchOnly: false,
  };
}

/**
 * ADR-018 § 3: the one-time rescan of a wallet restored from a Stage-1 save. Asks the tip (for the
 * progress line), then syncs; `sync()` saves the rescanned wallet — replacing the Stage-1 save — and ends the
 * migration. The addresses are cached by `unlock()` before the wallet turns "ready" (the ready state
 * already starts the auto-sync, so asking them here could wait for the whole rescan). A failed
 * sync (network) leaves the migration on; the next sync (auto-sync every two minutes, or "Sync now") continues it, and
 * a reload restarts it from the Stage-1 save, which is still on the device.
 */
async function runMigration(wallet: ZecWallet): Promise<void> {
  try {
    const tip = await wallet.tip();
    const migration = currentState.migration;
    if (migration && walletInstance === wallet && Number.isFinite(tip) && tip > 0) updateState({ migration: { ...migration, tipHeight: tip } });
  } catch {
    // the progress line then shows elapsed time only
  }
  if (walletInstance !== wallet) return;
  await ZcashWalletAdapter.sync().catch(() => undefined);
}

/** The engine's outputs for a request: the recipient, then (payments only) the project's fee output. */
function outputsOf(request: SendRequest): SendOutput[] {
  if (request.amountZat <= 0n) throw codedError("invalid_amount", "the amount must be positive");
  const recipient: SendOutput = {
    to: request.to.trim(),
    amountZat: request.amountZat.toString(),
    ...(request.memo ? { memo: request.memo } : {}),
    ...(request.purpose === "withdrawal" ? { withdrawal: true } : {}),
  };
  if (!request.projectFee) return [recipient];
  if (request.purpose !== "payment") throw codedError("invalid_outputs", "a project fee belongs to a player payment only");
  return [recipient, { to: request.projectFee.address, amountZat: request.projectFee.amountZat.toString(), memo: request.projectFee.memo }];
}

async function persistDb(): Promise<void> {
  if (!walletInstance) return;
  await saveWalletDb(await walletInstance.exportDb());
}

/**
 * After a broadcast the wallet DB (which now reserves the spent notes) is saved BEFORE the send counts
 * as finished: `txidInProgress` stays set until then, so the update prompt never reloads in between. A failed save
 * after a successful broadcast is logged, never reported as a failed send (the transaction is already out).
 */
async function persistAfterSend(): Promise<void> {
  try {
    await persistDb();
  } catch (error) {
    console.warn("[wallet] saving the wallet after a send failed:", error instanceof Error ? error.name : "error");
  }
}

/**
 * Runs one send/shield: busy (`txidInProgress`) from the start until the wallet DB is saved, also after a broadcast-
 * phase error (the stored transaction reserves its notes — that must survive a reload).
 */
async function runSend<T>(send: () => Promise<T>): Promise<T> {
  updateState({ status: "syncing", error: null, txidInProgress: "pending" });
  try {
    const result = await send();
    await persistAfterSend();
    return result;
  } catch (error) {
    if (isBroadcastPhaseError(error)) await persistAfterSend();
    throw error;
  } finally {
    updateState({ status: "ready", txidInProgress: null });
  }
}
let stateListeners: Array<(state: WalletState) => void> = [];

function updateState(updates: Partial<WalletState>): void {
  currentState = { ...currentState, ...updates };
  stateListeners.forEach((listener) => listener(currentState));
  // Sync participation state whenever wallet state changes
  if (updates.status) {
    if (updates.status === "disconnected") {
      resetParticipationState();
    } else {
      updateParticipationState(updates.status);
    }
  }
}

export function subscribeToWalletState(listener: (state: WalletState) => void): () => void {
  stateListeners.push(listener);
  return () => {
    stateListeners = stateListeners.filter((l) => l !== listener);
  };
}

/** EXPLICIT RECOVERY BOUNDARY: Retrieve the stored seed for backup/recovery only.
 *  This is NOT part of the normal WalletAdapter API. Use only for deliberate user-initiated
 *  recovery export (e.g., backup UI with explicit confirmation).
 *  Requires passphrase authentication. */
export async function exportSeedPhraseForRecovery(passphrase: string): Promise<string | null> {
  return getSeed(passphrase);
}

export function getWalletState(): WalletState {
  return { ...currentState };
}

export const ZcashWalletAdapter: WalletAdapter = {
  get state(): WalletState {
    return getWalletState();
  },

  async initialize(proxyUrl: string): Promise<void> {
    try {
      updateState({ status: "initializing", error: null });
      setProxyUrl(proxyUrl);
      // Check if encrypted seed exists — if so, wallet is LOCKED and requires unlock() call
      const seedExists = await hasSeed();
      if (seedExists) {
        updateState({ status: "locked", error: null });
      } else {
        updateState({ status: "idle", error: null });
      }
    } catch (e: any) {
      updateState({ status: "error", error: e?.message || "initialization failed" });
    }
  },

  async createWallet(passphrase: string): Promise<string[]> {
    try {
      if (!passphrase || passphrase.length < 10) {
        throw new Error("Wallet encryption passphrase must be at least 10 characters");
      }
      updateState({ status: "initializing", error: null, migration: null, migrationNeedsBirthday: false });
      const mnemonic = realGenerateMnemonic();
      const words = mnemonic.split(" ");
      // ADR-018 § 1: real money — a new mainnet wallet is unusable until its backup check passes.
      if (policyNetwork() === "main") {
        setBackupPending(true);
        updateState({ backupPending: true });
      }
      // Encrypt and persist seed with user-provided passphrase
      await setSeed(mnemonic, passphrase);
      // Open the wallet to validate it works
      walletInstance = await openWallet({
        seedPhrase: mnemonic,
        dbBytes: null,
      });
      setAcct(walletInstance.accountId);
      rememberBirthday(walletInstance); // A later restore from the seed starts here
      const addr = await walletInstance.address();
      // ADR-016: the name key comes from the seed while it is in memory (non-extractable afterwards).
      void activateNameKeyFromMnemonic(mnemonic, ZCASH_NETWORK);
      updateState({ status: "ready", account: accountFor(addr) });
      return words;
    } catch (e: any) {
      updateState({ status: "error", error: e?.message || "wallet creation failed" });
      throw e;
    }
  },

  async importSeed(seedPhrase: string, passphrase: string, birthdayHeight?: number): Promise<void> {
    try {
      if (!passphrase || passphrase.length < 10) {
        throw new Error("Wallet encryption passphrase must be at least 10 characters");
      }
      updateState({ status: "initializing", error: null, migration: null, migrationNeedsBirthday: false });
      // Validate seed phrase format
      const validation = validateSeedPhrase(seedPhrase);
      if (!validation.ok) {
        throw new Error(validation.message || "Invalid seed phrase");
      }
      // Validate with real BIP-39 checksum
      if (!realValidateMnemonic(seedPhrase)) {
        throw new Error("Invalid BIP-39 checksum");
      }
      // Encrypt and persist seed with user-provided passphrase
      await setSeed(seedPhrase, passphrase);
      // A restored wallet's phrase is already in the player's hands: no backup check.
      setBackupPending(false);
      updateState({ backupPending: false });
      // Open the wallet
      walletInstance = await openWallet({
        seedPhrase,
        dbBytes: null,
        birthdayHeight: validBirthday(birthdayHeight),
      });
      setAcct(walletInstance.accountId);
      rememberBirthday(walletInstance);
      const addr = await walletInstance.address();
      void activateNameKeyFromMnemonic(seedPhrase, ZCASH_NETWORK); // ADR-016: the same seed restores the same names
      updateState({ status: "ready", account: accountFor(addr) });
    } catch (e: any) {
      updateState({ status: "error", error: e?.message || "seed import failed" });
      throw e;
    }
  },

  async importViewingKey(viewingKey: string): Promise<void> {
    const validation = validateKey(viewingKey);
    if (!validation.ok) {
      throw new Error(validation.message || "Invalid viewing key");
    }
    // TODO: Implement viewing key import (watch-only wallet)
    // For now, this is a placeholder since watch-only support requires additional work.
    throw new Error("Viewing key import not yet implemented");
  },

  async unlock(passphrase: string, options: { readonly birthdayHeight?: number } = {}): Promise<void> {
    try {
      if (currentState.status !== "locked") {
        throw new Error(`Cannot unlock from status "${currentState.status}"; wallet must be in "locked" state`);
      }
      updateState({ status: "initializing", error: null });
      // Attempt to decrypt seed with provided passphrase
      const seedPhrase = await getSeed(passphrase);
      if (!seedPhrase) {
        throw new Error("SEED_NOT_FOUND: encrypted seed missing or corrupted");
      }
      // Load persisted wallet DB if available
      const dbBytes = await loadWalletDb();
      const storedAcct = getAcct();
      let migration: WalletMigration | null = null;
      try {
        // Open wallet with decrypted seed. Should the save be unusable, the stored birthday (not ~100
        // blocks ago) is where a recreated account starts scanning.
        walletInstance = await openWallet({
          seedPhrase,
          dbBytes: dbBytes || undefined,
          knownAccountId: storedAcct || undefined,
          birthdayHeight: getBirthday(),
        });
      } catch (error) {
        if (engineErrorCode(error) !== "wallet_format_unsupported" || !dbBytes) throw error;
        // ADR-018 § 3: a wallet saved by the Stage-1 engine. Restore it from the seed we just decrypted
        // and its birthday — stored, else read from the old save (zcash/stage1Save.ts), else asked (a month and year,
        // never the seed). The Stage-1 save stays in IndexedDB until the rescanned wallet replaces it (sync()).
        const birthday = getBirthday() ?? stage1SaveBirthday(dbBytes, storedAcct) ?? validBirthday(options.birthdayHeight);
        if (birthday === null) {
          updateState({ status: "locked", error: walletErrorMessage({ code: "migration_birthday_unknown" }), migrationNeedsBirthday: true });
          throw codedError("migration_birthday_unknown", "the wallet's birthday could not be read from its old save");
        }
        walletInstance = await openWallet({ seedPhrase, dbBytes: null, birthdayHeight: birthday });
        setAcct(walletInstance.accountId);
        setBirthday(birthday);
        migration = { fromHeight: birthday, tipHeight: null, startedAt: Date.now() };
      }
      if (getBirthday() === null) rememberBirthday(walletInstance);
      const addr = await walletInstance.address();
      // Fill the address cache BEFORE "ready". The ready state starts the auto-sync at once (the
      // wallet panel's listener), and a sync — above all a migration rescan — holds the engine's database lock for its
      // whole run; asked later, accepting a payment and "Add funds" would wait for the rescan. Best effort.
      if (walletInstance.mainnetEngine) await walletInstance.mainnetEngine.addresses().catch(() => undefined);
      void activateNameKeyFromMnemonic(seedPhrase, ZCASH_NETWORK); // ADR-016: a returning player claims its name with it
      updateState({ status: "ready", account: accountFor(addr), migration, migrationNeedsBirthday: false });
      if (migration) void runMigration(walletInstance);
    } catch (e: any) {
      // On wrong passphrase or decryption error, remain LOCKED with explicit error
      const errorMsg = e?.message || "unlock failed";
      if (engineErrorCode(e) === "migration_birthday_unknown") {
        // already "locked", with the date question (see above)
      } else if (errorMsg.includes("DECRYPTION_FAILED") || errorMsg.includes("wrong passphrase")) {
        updateState({ status: "locked", error: "Wrong passphrase. Wallet data preserved." });
      } else {
        updateState({ status: "error", error: errorMsg });
      }
      throw e;
    }
  },

  async lock(): Promise<void> {
    try {
      // During a migration rescan nothing is saved — the Stage-1 save stays until the rescanned wallet
      // replaces it (the engine's export would also wait for the whole scan). The next unlock restarts the rescan.
      if (walletInstance && !currentState.migration) {
        // Persist wallet DB before locking
        const db = await walletInstance.exportDb();
        await saveWalletDb(db);
      }
      // Clear in-memory wallet instance and sensitive data
      walletInstance = null;
      clearNameKey();
      updateState({
        status: "locked",
        error: null,
        account: null,
        balance: null,
        migration: null,
      });
    } catch (e: any) {
      updateState({ status: "error", error: e?.message || "lock failed" });
      throw e;
    }
  },

  /** Disconnect from wallet without destroying persistent data.
   *
   * SEMANTICS:
   *  - Similar to lock(): persists wallet DB, clears in-memory state
   *  - Different: sets status to "disconnected" (not "locked")
   *  - DOES NOT clear encrypted seed (seed persists in storage)
   *
   * Use disconnect() for external wallet flows (e.g., user clicked "Use External Wallet").
   * Use lock() for persistent embedded wallet (user closed app or logged out).
   * Use clearAllData() for destructive removal (e.g., user clicked "Clear All Data").
   */
  async disconnect(): Promise<void> {
    try {
      if (walletInstance && !currentState.migration) {
        // Persist wallet DB for potential future reconnection (not mid-migration, see lock())
        const db = await walletInstance.exportDb();
        await saveWalletDb(db);
      }
      walletInstance = null;
      clearNameKey();
      updateState({
        status: "disconnected",
        error: null,
        account: null,
        balance: null,
        migration: null,
      });
      // Note: encrypted seed is NOT cleared; wallet data persists in storage
    } catch (e: any) {
      updateState({ status: "error", error: e?.message || "disconnect failed" });
    }
  },

  async sync(): Promise<void> {
    if (!walletInstance) {
      throw new Error("Wallet not open");
    }
    // One sync at a time (the Stage-2 engine holds its database lock for the whole scan anyway). A call made while one
    // runs gets ONE follow-up sync that starts after it (shared by every caller meanwhile), so a caller that asks
    // because something just happened (a payment notice, a mined block) never gets an older scan's answer.
    if (syncInFlight) {
      syncFollowUp ??= syncInFlight
        .catch(() => undefined)
        .then(() => {
          syncFollowUp = null;
          return ZcashWalletAdapter.sync();
        });
      return syncFollowUp;
    }
    const wallet = walletInstance;
    const run = async (): Promise<void> => {
      try {
        updateState({ status: "syncing", error: null });
        await wallet.sync();
        const balances = await wallet.balances();
        if (walletInstance !== wallet) return; // locked or replaced meanwhile
        updateState({
          status: "ready",
          balance: {
            totalZec: balances.totalZec,
            pendingZec: balances.pendingZec,
            transparentZec: balances.transparentZec,
            ...(balances.shieldableZec !== undefined ? { shieldableZec: balances.shieldableZec } : {}),
            ...(balances.shieldedPools ? { shieldedPools: balances.shieldedPools } : {}),
          },
        });
        // Persist the synced DB (after a migration rescan this replaces the Stage-1 save).
        const db = await wallet.exportDb();
        if (walletInstance !== wallet) return;
        await saveWalletDb(db);
        if (currentState.migration) updateState({ migration: null });
      } catch (e: any) {
        // The wallet is still open — a failed sync (e.g. network) must not look like a
        // locked/broken wallet (that would also end voice via participation gating).
        if (walletInstance === wallet) updateState({ status: "ready", error: e?.message || "sync failed" });
        throw e;
      }
    };
    syncInFlight = run().finally(() => {
      syncInFlight = null;
    });
    return syncInFlight;
  },

  getAccount(): WalletAccount | null {
    return currentState.account;
  },

  getBalance(): WalletBalance | null {
    return currentState.balance;
  },

  async getReceiveAddress(): Promise<string> {
    if (!walletInstance) {
      throw new Error("Wallet not open");
    }
    requireBackup();
    return walletInstance.address();
  },

  async getPaymentAddress(): Promise<string> {
    if (!walletInstance) {
      throw new Error("Wallet not open");
    }
    requireBackup();
    // Never the full unified address on mainnet — its transparent receiver is the public exchange address.
    // The shielded-only unified address (Orchard-family + Sapling): a Stage-2 payer pays it as Ironwood, a
    // Stage-1 payer (an old page) as Sapling.
    if (walletInstance.mainnetEngine) return (await walletInstance.mainnetEngine.addresses()).unifiedShielded;
    return walletInstance.address();
  },

  async getAddresses(): Promise<ReceiveAddresses> {
    const engine = mainnetEngine();
    requireBackup();
    return engine.addresses();
  },

  async sendingStatus(): Promise<SendingStatus> {
    if (!walletInstance?.mainnetEngine) return { allowed: true, expectedBranch: "", chainBranch: null, code: null, reason: null, pendingUpgrade: null };
    return walletInstance.mainnetEngine.sendingStatus();
  },

  async previewSend(request: SendRequest): Promise<SendPreview> {
    const engine = mainnetEngine();
    requireBackup();
    requireNotMigrating();
    enforceCap(request.amountZat, request.purpose);
    const result = await engine.previewSend(outputsOf(request));
    const first = Array.isArray(result.outputs) ? result.outputs[0] : undefined;
    const pool = first?.pool;
    return {
      networkFeeZat: result.feeZat,
      amountZat: request.amountZat,
      projectFeeZat: request.projectFee?.amountZat ?? 0n,
      recipientPool: pool === "ironwood" || pool === "sapling" || pool === "transparent" ? pool : null,
      recipientAddress: typeof first?.to === "string" ? first.to : null,
      recipientTex: first?.tex === true,
    };
  },

  async sendRequest(request: SendRequest): Promise<string> {
    const txids = await ZcashWalletAdapter.sendRequestTxids(request);
    return txids[0]!;
  },

  async sendRequestTxids(request: SendRequest): Promise<readonly string[]> {
    const engine = mainnetEngine();
    requireBackup();
    requireNotMigrating();
    enforceCap(request.amountZat, request.purpose);
    const outputs = outputsOf(request);
    const result: SendResult = await runSend(() => engine.send(outputs));
    const txids = Array.isArray(result.txids) ? result.txids.filter((t) => typeof t === "string" && t.length > 0) : [];
    if (txids.length === 0) throw codedError("transaction_build_failed", "no transaction id");
    return txids;
  },

  async previewShield(): Promise<ShieldResult> {
    const engine = mainnetEngine();
    requireBackup();
    requireNotMigrating();
    return engine.previewShield();
  },

  async shieldTransparent(): Promise<ShieldResult> {
    const engine = mainnetEngine();
    requireBackup();
    requireNotMigrating();
    // ADR-018 § 4: shielding one's own funds is exempt from the cap and pays no project fee. Shielding goes into Ironwood.
    return runSend(() => engine.shield());
  },

  confirmBackup(): void {
    setBackupPending(false);
    updateState({ backupPending: false });
  },

  async sendShielded(toAddress: string, amountZec: string, memo: string): Promise<string> {
    if (!walletInstance) {
      throw new Error("Wallet not open");
    }
    // Validate recipient
    const addrValidation = validateAddress(toAddress);
    if (!addrValidation.ok) {
      throw new Error(addrValidation.message || "Invalid recipient address");
    }
    if (!isShieldedKind(addrValidation.kind)) {
      throw new Error("Recipient must be a shielded address for memo-bearing sends");
    }
    // Parse and validate amount
    let amountZatoshi: bigint;
    try {
      amountZatoshi = parseZecToZatoshi(amountZec);
    } catch (e: any) {
      throw new Error(`Invalid amount: ${e?.message || "amount parsing failed"}`);
    }
    // ADR-018 § 4: the cap and the backup check hold for every send from the game.
    requireBackup();
    requireNotMigrating();
    enforceCap(amountZatoshi, "payment");
    const wallet = walletInstance;
    try {
      // Busy until the DB that reserves the spent notes is saved.
      return await runSend(() => wallet.sendWithMemo(toAddress, amountZatoshi, memo));
    } catch (e: any) {
      // A sentence, never the engine's raw text (it can carry an address).
      updateState({ error: policyNetwork() === "main" ? walletErrorMessage(e) : e?.message || "send failed" });
      throw e;
    }
  },

  async send(toAddress: string, amountZec: string): Promise<string> {
    if (!walletInstance) {
      throw new Error("Wallet not open");
    }
    const addrValidation = validateAddress(toAddress);
    if (!addrValidation.ok) {
      throw new Error(addrValidation.message || "Invalid recipient address");
    }
    // Parse and validate amount
    let amountZatoshi: bigint;
    try {
      amountZatoshi = parseZecToZatoshi(amountZec);
    } catch (e: any) {
      throw new Error(`Invalid amount: ${e?.message || "amount parsing failed"}`);
    }
    requireBackup();
    requireNotMigrating();
    enforceCap(amountZatoshi, "payment");
    const wallet = walletInstance;
    try {
      return await runSend(() => wallet.send(toAddress, amountZatoshi));
    } catch (e: any) {
      updateState({ error: policyNetwork() === "main" ? walletErrorMessage(e) : e?.message || "send failed" });
      throw e;
    }
  },

  async getTransactionStatus(txid: string): Promise<"pending" | "confirmed" | "failed" | "unknown"> {
    if (!walletInstance) {
      return "unknown";
    }
    try {
      // Query transaction history to find this txid
      const history = await walletInstance.getTransactionHistory(100, 0);
      if (!history || !history.transactions) {
        return "unknown";
      }
      // Search for the transaction with matching txid
      for (const tx of history.transactions) {
        if (tx.txid === txid) {
          // Map webzjs status to our status type
          // TransactionStatusType: 0=Confirmed, 1=Pending, other values default to unknown
          const statusValue = tx.status;
          if (statusValue === 0) return "confirmed";
          if (statusValue === 1) return "pending";
          return "unknown";
        }
      }
      // Transaction not found in history
      return "unknown";
    } catch (e: any) {
      // On any error, return unknown rather than throwing
      return "unknown";
    }
  },


  async clearAllData(): Promise<void> {
    try {
      clearSeed();
      setBackupPending(false);
      setBirthday(null);
      updateState({ backupPending: false });
      await clearWalletDb();
      walletInstance = null;
      clearNameKey();
      updateState({
        status: "idle",
        error: null,
        account: null,
        balance: null,
        txidInProgress: null,
        migration: null,
        migrationNeedsBirthday: false,
      });
    } catch (e: any) {
      updateState({ status: "error", error: e?.message || "clear failed" });
      throw e;
    }
  },
};
