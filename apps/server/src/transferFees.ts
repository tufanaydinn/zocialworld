import { createHmac, randomBytes as nodeRandomBytes } from "node:crypto";
import { PAY_FEE_DEADLINE_MS, PAY_FEE_MAX_ZAT, TXID_PATTERN, buildPayFeeMemo, type PayFeeQuote } from "@project/shared";
import { parseZecToZat, readViewingKey } from "./identity/nameConfig.js";
import type { ReadResult } from "./zcash/shieldedPayments.js";

/**
 * The transfer fee between players (ADR-018 § 6; amends ADR-013).
 *
 *  - When the recipient accepts a payment request, the relay adds a fee quote {address, zat, nonce} to the acceptance
 *    it forwards to the SENDER (a server-issued field, not content). The sender's wallet pays the recipient and the
 *    project in ONE transaction: the fee is a second shielded output with the memo `zw-fee:v1:<nonce>` — an Ironwood
 *    output when a Stage-2 wallet pays the registry's full unified address, a Sapling output when the
 *    address is a zs1…/Stage-1 UA or the payer is a Stage-1 client; both count (shieldedPayments.ts PROJECT_NOTE_POOLS).
 *  - After broadcasting, the sender reports `pay_sent {requestId, txid}`. The server fetches that transaction through
 *    its own lightwalletd connection, decrypts ONLY the fee output with the project's viewing key (the recipient's
 *    output is not decryptable with it), waits for PAYMENT_MIN_CONF confirmations, and accepts a note with the exact
 *    memo and at least the fee — each note once (a keyed hash, in memory). The txid is then dropped: never stored,
 *    logged or shown.
 *  - A sender who accepted a fee-bearing payment and then sends no `pay_sent` (and no `pay_cancel` / cancelling
 *    `pay_notice`) within PAY_FEE_DEADLINE_MS, or whose transaction is MINED without a matching fee output, or is
 *    still unknown to a reachable lightwalletd after the verification window AND after the chain passed the
 *    transaction's expiry height, is `fee_unpaid`: its further pay_requests are refused for the rest of the session.
 *
 * Fairness rules:
 *  - `cancel` (the sender's `pay_cancel`, a cancelling notice even when the relay already forgot the
 *    request, or the recipient leaving) drops an entry without a reported transaction: no fee is owed.
 *  - The deadline sanction is kept as a "late" entry for the verification window: a `pay_sent` that arrives
 *    late and verifies (or a late cancel) lifts that request's sanction, so a valid fee note is never punished.
 *  - A sender holds at most MAX_ENTRIES_PER_SENDER unsettled entries, and a full table returns no quote — the
 *    relay then refuses the acceptance instead of forwarding it fee-free.
 *  - Only DEFINITIVE answers sanction. A lightwalletd error (unreachable, rate-limited, timed out) never does:
 *    the entry is retried and dropped without a sanction after MAX_UNSETTLED_MS. A transaction that cannot be
 *    decrypted is read as "no matching fee output" (that answer is deterministic for a fetched transaction).
 *
 * Honest limit: the server cannot see the recipient's output, so a modified client can pay a player without the fee and
 * cancel (or never accept a fee at all with an old client — those are refused on a capped mainnet server, which needs
 * `capZat`). The sanction is per session. Documented in docs/privacy/PLAYER_PAYMENTS_THREAT_MODEL.md.
 */

export interface TransferFeeConfig {
  readonly feeZat: number;
  /** Where the fee goes (never logged). */
  readonly address: string;
  /** The fee account's viewing key (never logged). */
  readonly ufvk: string;
  readonly minConfirmations: number;
}

export type TransferFeeConfigResult =
  | { readonly ok: true; readonly config: TransferFeeConfig | null; readonly problem?: string }
  | { readonly ok: false; readonly error: string };

/** ADR-018 § 6: about US$1 at the 2026-10-05/07 price; re-check with the price. */
export const DEFAULT_MAINNET_PAYMENT_FEE = "0.00075";

/**
 *   PAYMENT_FEE_ZEC              the fee (default 0.00075 on mainnet; on the test chain the fee is off unless set)
 *   PAYMENT_FEE_ADDRESS          where it goes (default: NAME_REGISTRY_ADDRESS)
 *   PAYMENT_FEE_UFVK / _FILE     its viewing key (default: NAME_REGISTRY_UFVK / _FILE)
 *   PAYMENT_FEE_MAINNET_ACK      must be `accepted` on mainnet (the operator's explicit opt-in, ADR-018 § 6)
 *   PAYMENT_MIN_CONF             confirmations the fee needs (default 1)
 * Without an address, a key, the bridge or (mainnet) the acknowledgement, payments work WITHOUT a fee and `problem`
 * says why (startup log). A fee above PAY_FEE_MAX_ZAT is refused (every client would refuse to pay it).
 */
export function loadTransferFeeConfig(env: Record<string, string | undefined>, options: { readonly network: "main" | "test"; readonly lightwalletd: boolean }): TransferFeeConfigResult {
  const feeText = env.PAYMENT_FEE_ZEC?.trim() || (options.network === "main" ? DEFAULT_MAINNET_PAYMENT_FEE : "");
  if (!feeText || feeText.toLowerCase() === "off") return { ok: true, config: null, problem: options.network === "main" ? "PAYMENT_FEE_ZEC=off" : "off on the test chain unless PAYMENT_FEE_ZEC is set" };
  const feeZat = parseZecToZat(feeText);
  if (feeZat === null || feeZat <= 0 || feeZat > PAY_FEE_MAX_ZAT) return { ok: false, error: `PAYMENT_FEE_ZEC must be a positive amount of at most ${PAY_FEE_MAX_ZAT / 1e8} ZEC (or off)` };
  const address = env.PAYMENT_FEE_ADDRESS?.trim() || env.NAME_REGISTRY_ADDRESS?.trim() || null;
  const ownKey = readViewingKey(env, "PAYMENT_FEE_UFVK");
  if ("error" in ownKey) return { ok: false, error: ownKey.error };
  let ufvk = ownKey.ufvk;
  if (ufvk === null) {
    const registryKey = readViewingKey(env, "NAME_REGISTRY_UFVK");
    if ("error" in registryKey) return { ok: false, error: registryKey.error };
    ufvk = registryKey.ufvk;
  }
  const minConf = Number(env.PAYMENT_MIN_CONF ?? 1);
  if (!Number.isInteger(minConf) || minConf < 0 || minConf > 100) return { ok: false, error: "PAYMENT_MIN_CONF must be a whole number of confirmations (0–100)" };
  if (address === null) return { ok: true, config: null, problem: "PAYMENT_FEE_ADDRESS (or NAME_REGISTRY_ADDRESS) is not set" };
  if (ufvk === null) return { ok: true, config: null, problem: "PAYMENT_FEE_UFVK (or NAME_REGISTRY_UFVK) is not set" };
  if (!options.lightwalletd) return { ok: true, config: null, problem: "the wallet bridge is off (LIGHTWALLETD_URL=off), so fee payments cannot be read" };
  if (options.network === "main" && env.PAYMENT_FEE_MAINNET_ACK?.trim() !== "accepted") {
    return { ok: true, config: null, problem: "PAYMENT_FEE_MAINNET_ACK is not set to accepted — the mainnet transfer fee needs the operator's explicit acknowledgement (ADR-018 § 6)" };
  }
  return { ok: true, config: { feeZat, address, ufvk, minConfirmations: minConf } };
}

/** What the fee checks need: one transaction's project notes (zcash/shieldedPayments.ts). */
export interface FeePaymentReader {
  read(txid: string): Promise<ReadResult>;
}

export interface TransferFeesOptions {
  readonly config: TransferFeeConfig;
  readonly reader: FeePaymentReader;
  readonly now: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  /** How often pending checks run (default 15 s). */
  readonly pollMs?: number;
  /** How long after `pay_sent` a transaction may take to confirm (default 60 min: the ≈ 50 min expiry of an unmined one). */
  readonly verifyWindowMs?: number;
  /** The mainnet NU7 activation height once it is known (NU7_ACTIVATION_HEIGHT), for the longer NU7 expiry. */
  readonly nu7ActivationHeight?: number | null;
}

interface FeeEntry {
  readonly requestId: string;
  readonly senderId: string;
  readonly nonce: string;
  readonly acceptedAt: number;
  /** Set by `pay_sent`; dropped after the check (never logged). */
  txid: string | null;
  sentAt: number | null;
  /** The deadline passed without a `pay_sent`; the sender is sanctioned for this request until it verifies. */
  late: boolean;
  /** The chain tip at the first successful "missing" answer (the transaction expires at most 41 blocks later). */
  firstTip: number | null;
}

const DEFAULT_POLL_MS = 15_000;
const DEFAULT_VERIFY_WINDOW_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
/** Unsettled fee entries one sender session may hold (an honest player has one or two at a time). */
export const MAX_ENTRIES_PER_SENDER = 20;
/** An entry lightwalletd could not settle (errors, a transaction stuck unconfirmed) is dropped WITHOUT a sanction after this long. */
export const MAX_UNSETTLED_MS = 6 * 60 * 60 * 1000;
/**
 * Blocks after which an unmined transaction has certainly expired: the builder's expiry delta (40, as the
 * engine's UPGRADE_GUARD_BLOCKS) + 1. NU7 (ZIP 218) raises the delta to 120: see txExpiryBlocks. Still 40
 * with the Stage-2 engine (upstream zcash_primitives DEFAULT_TX_EXPIRY_DELTA at librustzcash 0a2c6d1a, and the
 * engine's policy.rs UPGRADE_GUARD_BLOCKS = 40); a TEX withdrawal's second transaction carries no project fee, so
 * nothing here waits for it.
 */
export const TX_EXPIRY_BLOCKS = 41;
/** The same after NU7 (ZIP 218: an expiry delta of 120 blocks) + 1. */
export const NU7_TX_EXPIRY_BLOCKS = 121;

/**
 * How many blocks past `firstTip` an unmined transaction certainly expired. Without a known NU7 activation
 * height, the pre-NU7 delta. With one (NU7_ACTIVATION_HEIGHT), a transaction seen within the old delta of activation
 * or later may have been built with the NU7 delta, so the longer wait applies — later, never a wrong sanction.
 */
export function txExpiryBlocks(firstTip: number, nu7ActivationHeight: number | null): number {
  if (nu7ActivationHeight === null) return TX_EXPIRY_BLOCKS;
  return firstTip + TX_EXPIRY_BLOCKS >= nu7ActivationHeight ? NU7_TX_EXPIRY_BLOCKS : TX_EXPIRY_BLOCKS;
}
const USED_NOTES_MAX = 100_000;
const ERROR_LOG_INTERVAL_MS = 60_000;

export class TransferFees {
  readonly feeZat: number;
  private readonly address: string;
  private readonly minConfirmations: number;
  private readonly reader: FeePaymentReader;
  private readonly now: () => number;
  private readonly random: (size: number) => Uint8Array;
  private readonly pollMs: number;
  private readonly verifyWindowMs: number;
  private readonly nu7ActivationHeight: number | null;
  /** One-way, per-process key for the used-note hashes: they cannot even be checked against a txid offline. */
  private readonly noteKey: Uint8Array;
  private readonly entries = new Map<string, FeeEntry>();
  private readonly usedNotes = new Set<string>();
  /** Sanctioned sessions → the requests they owe a fee for (a late `pay_sent` that verifies lifts its own request). */
  private readonly sanctioned = new Map<string, Set<string>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private checking = false;
  private disposed = false;
  private lastErrorLog = -Infinity;

  constructor(options: TransferFeesOptions) {
    this.feeZat = options.config.feeZat;
    this.address = options.config.address;
    this.minConfirmations = options.config.minConfirmations;
    this.reader = options.reader;
    this.now = options.now;
    this.random = options.randomBytes ?? ((size) => new Uint8Array(nodeRandomBytes(size)));
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.verifyWindowMs = options.verifyWindowMs ?? DEFAULT_VERIFY_WINDOW_MS;
    this.nu7ActivationHeight = options.nu7ActivationHeight ?? null;
    this.noteKey = this.random(32);
  }

  /** `fee_unpaid`: this session's further pay_requests are refused. */
  isSanctioned(sessionId: string): boolean {
    return (this.sanctioned.get(sessionId)?.size ?? 0) > 0;
  }

  /**
   * At acceptance: the quote the relay adds for the sender. Asking again for the same request returns the same quote.
   * null when no quote can be issued (another sender's request, the sender's own limit, a full table): the relay then
   * refuses the acceptance rather than forwarding it without a fee.
   */
  quote(requestId: string, senderId: string): PayFeeQuote | null {
    const existing = this.entries.get(requestId);
    if (existing) return existing.senderId === senderId ? this.quoteOf(existing) : null;
    if (this.entries.size >= MAX_ENTRIES) return null;
    let own = 0;
    for (const entry of this.entries.values()) if (entry.senderId === senderId) own++;
    if (own >= MAX_ENTRIES_PER_SENDER) return null;
    const entry: FeeEntry = { requestId, senderId, nonce: Buffer.from(this.random(16)).toString("hex"), acceptedAt: this.now(), txid: null, sentAt: null, late: false, firstTip: null };
    this.entries.set(requestId, entry);
    this.arm();
    return this.quoteOf(entry);
  }

  /** `pay_sent`: the sender's transaction for a fee-bearing request (also after the deadline, which lifts a late sanction). False (ignored) for anything else. */
  reportSent(requestId: string, senderId: string, txid: string): boolean {
    const entry = this.entries.get(requestId);
    const id = txid.toLowerCase();
    if (!entry || entry.senderId !== senderId || entry.txid !== null || !TXID_PATTERN.test(id)) return false;
    entry.txid = id;
    entry.sentAt = this.now();
    this.arm();
    return true;
  }

  /**
   * The sender cancelled (`pay_cancel`, or a `pay_notice` that came without a `pay_sent`), or the recipient left: an
   * entry with no reported transaction owes nothing, and a late request's sanction is lifted.
   */
  cancel(requestId: string, senderId: string): void {
    const entry = this.entries.get(requestId);
    if (!entry || entry.senderId !== senderId || entry.txid !== null) return;
    this.entries.delete(requestId);
    this.lift(entry);
  }

  /** The sender's `pay_notice` (relayed or not). Without an earlier `pay_sent` it cancelled: no fee is owed. */
  noticeRelayed(requestId: string, senderId: string): void {
    this.cancel(requestId, senderId);
  }

  /** A session left: its entries and its sanction go (the sanction is per session — ADR-018 § 6). */
  forgetSession(sessionId: string): void {
    for (const [id, entry] of this.entries) if (entry.senderId === sessionId) this.entries.delete(id);
    this.sanctioned.delete(sessionId);
  }

  get pendingCount(): number {
    return this.entries.size;
  }

  /** One pass (exposed for tests): deadlines, then the reported transactions. One pass at a time. */
  async check(): Promise<void> {
    this.timer = null;
    if (this.checking || this.disposed) return;
    this.checking = true;
    try {
      const now = this.now();
      for (const entry of [...this.entries.values()]) {
        if (entry.txid === null) {
          if (!entry.late) {
            // No pay_sent within the deadline: sanctioned, but kept as "late" so a late valid fee still clears it.
            if (now - entry.acceptedAt >= PAY_FEE_DEADLINE_MS) this.sanction(entry, true);
          } else if (now - entry.acceptedAt >= PAY_FEE_DEADLINE_MS + this.verifyWindowMs) {
            this.entries.delete(entry.requestId); // the grace ended: the sanction stays
          }
          continue;
        }
        const age = now - (entry.sentAt ?? now);
        let result: ReadResult;
        try {
          result = await this.reader.read(entry.txid);
        } catch (error) {
          // lightwalletd unreachable, rate-limited or timed out — not an answer about the fee. Retry; never sanction.
          this.logError(error);
          if (age >= MAX_UNSETTLED_MS) this.entries.delete(entry.requestId);
          continue;
        }
        if (!this.entries.has(entry.requestId)) continue; // the session left meanwhile
        if (result.status === "found" && result.confirmations >= this.minConfirmations) {
          const memo = buildPayFeeMemo(entry.nonce);
          const note = result.notes.find((n) => n.memo === memo && n.amountZat >= this.feeZat && !this.usedNotes.has(this.noteHash(n.ref)));
          if (note) {
            if (this.usedNotes.size >= USED_NOTES_MAX) this.usedNotes.clear();
            this.usedNotes.add(this.noteHash(note.ref));
            this.entries.delete(entry.requestId); // paid: the txid goes with the entry
            this.lift(entry); // a late pay_sent that verifies clears its request's sanction
          } else {
            this.sanction(entry, false); // MINED without a matching fee output (missing, short, wrong nonce or reused)
          }
        } else if (result.status === "missing") {
          // Definitive only when a reachable lightwalletd still does not know it after the window AND after the
          // chain passed the height where the transaction would have expired.
          if (result.tip !== undefined && entry.firstTip === null) entry.firstTip = result.tip;
          const expired = result.tip !== undefined && entry.firstTip !== null && result.tip >= entry.firstTip + txExpiryBlocks(entry.firstTip, this.nu7ActivationHeight);
          if (age >= this.verifyWindowMs && expired) this.sanction(entry, false);
          else if (age >= MAX_UNSETTLED_MS) this.entries.delete(entry.requestId);
        } else if (age >= MAX_UNSETTLED_MS) {
          this.entries.delete(entry.requestId); // known but never confirmed for hours: not an answer either way
        }
      }
    } finally {
      this.checking = false;
    }
    this.arm();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private quoteOf(entry: FeeEntry): PayFeeQuote {
    return { address: this.address, zat: this.feeZat, nonce: entry.nonce };
  }

  /** Sanctions the sender for this request. `late` keeps the entry for the grace window. */
  private sanction(entry: FeeEntry, late: boolean): void {
    if (late) entry.late = true;
    else this.entries.delete(entry.requestId);
    const owed = this.sanctioned.get(entry.senderId) ?? new Set<string>();
    owed.add(entry.requestId);
    this.sanctioned.set(entry.senderId, owed);
  }

  /** Lifts the sanction this request caused (if any); other unpaid requests keep the session sanctioned. */
  private lift(entry: FeeEntry): void {
    const owed = this.sanctioned.get(entry.senderId);
    if (!owed) return;
    owed.delete(entry.requestId);
    if (owed.size === 0) this.sanctioned.delete(entry.senderId);
  }

  private noteHash(ref: string): string {
    return createHmac("sha256", this.noteKey).update(`zocial-world/fee-note/v1:${ref}`).digest("hex");
  }

  private arm(): void {
    if (this.disposed || this.timer || this.checking || this.entries.size === 0) return;
    this.timer = setTimeout(() => void this.check(), this.pollMs);
    this.timer.unref?.();
  }

  private logError(error: unknown): void {
    const now = this.now();
    if (now - this.lastErrorLog < ERROR_LOG_INTERVAL_MS) return;
    this.lastErrorLog = now;
    const reason = (error instanceof Error ? error.message : String(error)).replace(/[0-9a-f]{64}/gi, "<txid>").replace(/\b(u|zs|t)[0-9a-z]{20,}\b/gi, "<address>");
    console.warn(`[fees] fee check failed (retrying): ${reason}`);
  }
}
