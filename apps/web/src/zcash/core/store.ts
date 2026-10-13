// Local persistence for in-browser wallet (testnet/mainnet).
//  • the BIP-39 seed (needed by WebZjs to create the account + sign sends) — localStorage (ENCRYPTED)
//  • the synced wallet DB bytes (db_to_bytes) — IndexedDB, so re-opens sync incrementally
//
// SECURITY ARCHITECTURE:
// User-provided wallet encryption passphrase required on create/import.
// Restart behavior: encrypted seed persists; wallet remains LOCKED until user provides passphrase to unlock().
//
// Guarantees:
// • Seeds encrypted at-rest using PBKDF2-SHA256 key derivation + AES-GCM (WebCrypto)
// • Passphrase never persisted, logged, sent to server, or stored in any browser storage
// • Passphrase lives only in memory while wallet is unlocked
// • Wrong passphrase preserves encrypted data; does not destroy wallet
// • Wallet participation eligibility gated on "ready" status, not "locked"
//
// Browser-only — never import on the server.
// Passphrase validation: minimum 10 characters (no complexity requirements).

import { encryptSecret, decryptSecret, isEnvelope, type KeyEnvelope } from "./keystore";
import { ZCASH_NETWORK } from "./wallet-types";

// Storage names of the in-game wallet, namespaced under "zw" so they stay apart from other apps on the same origin. A
// mainnet build keeps its wallet under its own keys, so a test-chain wallet (and its regtest wallet database) is never
// opened as a mainnet wallet on the same origin — and the other way round.
const MAIN = ZCASH_NETWORK === "main";
const SEED_KEY = MAIN ? "zw.wallet.seed.main.v1" : "zw.wallet.seed.v1";
const ACCT_KEY = MAIN ? "zw.wallet.acct.main.v1" : "zw.wallet.acct.regtest.v1";
const DB_NAME = MAIN ? "zw-wallet-main" : "zw-wallet-regtest";
const DB_STORE = "kv";
const DB_KEY = "wallet-db";
/** ADR-018 § 1: set when a new mainnet wallet is created, cleared when its backup check passes. */
const BACKUP_PENDING_KEY = "zw.wallet.backup-pending.main.v1";
/**
 * The wallet's birthday height (where a rescan starts). Stored when a wallet is created, restored or
 * migrated, so a later restore from the seed (a Stage-1 save, a damaged save) needs nothing else. Not secret on its
 * own (the wallet database on this device holds it too); cleared with the wallet.
 */
const BIRTHDAY_KEY = MAIN ? "zw.wallet.birthday.main.v1" : "zw.wallet.birthday.regtest.v1";

/** The stored birthday height, or null (never stored, unreadable, or storage unavailable). */
export function getBirthday(): number | null {
  try {
    const raw = localStorage.getItem(BIRTHDAY_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Remembers the wallet's birthday height (best effort: a storage error leaves the old value). */
export function setBirthday(height: number | null): void {
  try {
    if (height === null) localStorage.removeItem(BIRTHDAY_KEY);
    else if (Number.isSafeInteger(height) && height > 0) localStorage.setItem(BIRTHDAY_KEY, String(height));
  } catch {
    // Storage unavailable: the save keeps the birthday too (the wallet database records the account's birthday).
  }
}

/** Whether the current wallet's seed-phrase backup is still unconfirmed (mainnet only; storage errors read as "no"). */
export function isBackupPending(): boolean {
  if (!MAIN) return false;
  try {
    return localStorage.getItem(BACKUP_PENDING_KEY) === "1";
  } catch {
    return false;
  }
}

export function setBackupPending(pending: boolean): void {
  if (!MAIN) return;
  try {
    if (pending) localStorage.setItem(BACKUP_PENDING_KEY, "1");
    else localStorage.removeItem(BACKUP_PENDING_KEY);
  } catch {
    // Storage unavailable: the in-memory flag in the adapter still holds for this page.
  }
}

/** Retrieve and decrypt the stored seed.
 *  Requires the user-provided passphrase.
 *  Throws on corruption, decryption failure, or wrong passphrase.
 *  Returns null only if seed has not been set yet (NOT_FOUND).
 */
export async function getSeed(passphrase: string): Promise<string | null> {
  if (!passphrase || typeof passphrase !== "string" || passphrase.length < 1) {
    throw new Error("PASSPHRASE_REQUIRED: unlock passphrase must be provided");
  }

  const stored = localStorage.getItem(SEED_KEY);
  if (!stored) return null; // NOT_FOUND: seed never set

  // CORRUPTION: Stored value must be valid encrypted envelope
  if (!isEnvelope(stored)) {
    throw new Error("SEED_STORAGE_CORRUPTED: stored value is not an encrypted envelope");
  }

  let envelope: KeyEnvelope;
  try {
    envelope = JSON.parse(stored);
  } catch (e) {
    throw new Error(`SEED_STORAGE_CORRUPTED: envelope JSON parse failed: ${e}`);
  }

  // DECRYPTION FAILED: AES-GCM makes passphrase mismatch and corruption indistinguishable.
  // Both result in authentication failure. This is acceptable — fail-closed behavior is identical:
  // either way, decryption fails and data is preserved (not cleared).
  try {
    return await decryptSecret(envelope, passphrase);
  } catch (e) {
    throw new Error(`SEED_DECRYPTION_FAILED: wrong passphrase or corrupted seed (AES-GCM indistinguishable): ${e}`);
  }
}

/** Encrypt and store the seed with user-provided passphrase.
 *  Awaitable for async encryption. Throws if encryption or persistence fails.
 *  Passphrase must never be logged, persisted, or sent to server.
 */
export async function setSeed(mnemonic: string, passphrase: string): Promise<void> {
  if (!passphrase || typeof passphrase !== "string" || passphrase.length < 1) {
    throw new Error("PASSPHRASE_REQUIRED: wallet encryption passphrase must be provided");
  }

  const trimmed = mnemonic.trim().toLowerCase();
  const envelope = await encryptSecret(trimmed, passphrase);
  try {
    localStorage.setItem(SEED_KEY, JSON.stringify(envelope));
  } catch (e) {
    throw new Error(`SEED_PERSISTENCE_FAILED: localStorage.setItem failed: ${e}`);
  }
}

export function clearSeed(): void {
  try {
    localStorage.removeItem(SEED_KEY);
  } catch (e) {
    throw new Error(`SEED_CLEAR_FAILED: localStorage.removeItem failed: ${e}`);
  }
}

export async function hasSeed(): Promise<boolean> {
  const stored = localStorage.getItem(SEED_KEY);
  return stored !== null;
}

/** The WebZjs account id created for this seed (WebZjs doesn't always assign 0).
 *  Returns null if not set. Throws on storage error.
 */
export function getAcct(): number | null {
  try {
    const v = localStorage.getItem(ACCT_KEY);
    return v == null ? null : Number(v);
  } catch (e) {
    throw new Error(`ACCT_RETRIEVAL_FAILED: localStorage.getItem failed: ${e}`);
  }
}

export function setAcct(id: number): void {
  try {
    localStorage.setItem(ACCT_KEY, String(id));
  } catch (e) {
    throw new Error(`ACCT_PERSISTENCE_FAILED: localStorage.setItem failed: ${e}`);
  }
}

// ── IndexedDB: store the (large) wallet DB blob ──────────────────────────────
function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadWalletDb(): Promise<Uint8Array | null> {
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(DB_KEY);
      tx.onsuccess = () => resolve((tx.result as Uint8Array) ?? null);
      tx.onerror = () => reject(new Error(`WALLET_DB_LOAD_FAILED: IndexedDB transaction error: ${tx.error}`));
    });
  } catch (e) {
    throw new Error(`WALLET_DB_LOAD_FAILED: ${e}`);
  }
}

export async function saveWalletDb(bytes: Uint8Array): Promise<void> {
  try {
    const db = await idb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).put(bytes, DB_KEY);
      tx.onsuccess = () => resolve();
      tx.onerror = () => reject(new Error(`WALLET_DB_SAVE_FAILED: IndexedDB transaction error: ${tx.error}`));
    });
  } catch (e) {
    throw new Error(`WALLET_DB_PERSISTENCE_FAILED: ${e}`);
  }
}

export async function clearWalletDb(): Promise<void> {
  try {
    const db = await idb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).delete(DB_KEY);
      tx.onsuccess = () => resolve();
      tx.onerror = () => reject(new Error(`WALLET_DB_CLEAR_FAILED: IndexedDB transaction error: ${tx.error}`));
    });
  } catch (e) {
    throw new Error(`WALLET_DB_CLEAR_FAILED: ${e}`);
  }
}
