import { TXID_PATTERN } from "@project/shared";
import type { RpcFn } from "../zcash/faucet.js";
import type { ReadResult } from "../zcash/shieldedPayments.js";
import type { PendingReservationView, ReceivedNote } from "./nameRegistry.js";

/**
 * Where the name registry learns about payments (ADR-016 § 3; ADR-018 § 5). Three backends:
 *
 *  - `zcashd` — the test chain's zcashd wallet owns the registry account (the deployment creates it); the server
 *    asks `z_listreceivedbyaddress <registry UA> 0` over the existing RPC client (zcash/faucet.ts) and gets every
 *    note received there, with its memo, value, txid, output index and confirmations. The registry's viewing key
 *    never leaves zcashd. Polled every 5 s, only while a reservation is pending.
 *  - `lightwalletd` — ADR-018 § 5 (mainnet, where zcashd no longer follows the chain): the paying client reports its
 *    txid (`name_payment_sent`); each poll fetches the reported transactions through the server's own lightwalletd
 *    connection and trial-decrypts them with the registry's viewing key (zcash/shieldedPayments.ts). Only the
 *    project's incoming Sapling notes come back. Polled every 10 s while a reservation is pending.
 *  - `dev` — local development and tests only (config refuses it with NODE_ENV=production): it "sees" a payment
 *    for every pending reservation after half the confirm delay and confirms it after the full delay (~2 s),
 *    without any chain.
 *
 * (`off` has no scanner: there is no registry at all.)
 */
export interface NameScanner {
  readonly kind: "zcashd" | "dev" | "lightwalletd";
  /** How often to poll while reservations are pending. */
  readonly pollMs: number;
  /** The notes now visible at the registry address. */
  scan(pending: readonly PendingReservationView[]): Promise<ReceivedNote[]>;
  /** Forgets per-reservation state (reported txids) of reservations that are no longer pending. */
  prune?(pending: readonly PendingReservationView[]): void;
}

export const ZCASHD_POLL_MS = 5_000;

export class ZcashdNameScanner implements NameScanner {
  readonly kind = "zcashd" as const;
  readonly pollMs = ZCASHD_POLL_MS;
  private readonly rpc: RpcFn;
  private readonly address: string;

  constructor(rpc: RpcFn, address: string) {
    this.rpc = rpc;
    this.address = address;
  }

  async scan(): Promise<ReceivedNote[]> {
    // minconf 0: ADR-016 accepts 0-conf payments on the test chain; the registry decides with each note's confirmations.
    return parseReceivedNotes(await this.rpc<unknown>("z_listreceivedbyaddress", [this.address, 0]));
  }
}

/**
 * Rows of `z_listreceivedbyaddress` → notes. Only shielded pools carry memos (`sapling`, `orchard`); change outputs
 * and conflicted transactions (negative confirmations) are skipped; a row without a usable txid or output index is
 * skipped too. A result that is not an array throws (a broken RPC answer must not read as "no payments").
 */
export function parseReceivedNotes(rows: unknown): ReceivedNote[] {
  if (!Array.isArray(rows)) throw new Error("unexpected z_listreceivedbyaddress result");
  const notes: ReceivedNote[] = [];
  for (const raw of rows as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    if (row.pool !== "sapling" && row.pool !== "orchard") continue;
    if (row.change === true) continue;
    if (typeof row.txid !== "string" || !/^[0-9a-f]{64}$/i.test(row.txid)) continue;
    if (!Number.isInteger(row.outindex) || (row.outindex as number) < 0) continue;
    if (!Number.isInteger(row.confirmations) || (row.confirmations as number) < 0) continue;
    const amountZat = Number.isInteger(row.amountZat) ? (row.amountZat as number) : typeof row.amount === "number" ? Math.round(row.amount * 1e8) : NaN;
    if (!Number.isFinite(amountZat)) continue;
    const memo = typeof row.memoStr === "string" ? row.memoStr : typeof row.memo === "string" ? decodeTextMemo(row.memo) : null;
    if (memo === null) continue;
    notes.push({ ref: `${row.txid.toLowerCase()}:${row.pool}:${row.outindex as number}`, memo, amountZat, confirmations: row.confirmations as number });
  }
  return notes;
}

/** A ZIP 302 memo given as hex → its text, or null if it is not a text memo (first byte above 0xF4, or invalid UTF-8). */
export function decodeTextMemo(hex: string): string | null {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex) || hex.length === 0) return null;
  const bytes = Buffer.from(hex, "hex");
  if (bytes[0]! > 0xf4) return null;
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
  } catch {
    return null;
  }
}

export class DevNameScanner implements NameScanner {
  readonly kind = "dev" as const;
  readonly pollMs = 250;
  private readonly now: () => number;
  private readonly confirmAfterMs: number;

  constructor(now: () => number, confirmAfterMs = 2_000) {
    this.now = now;
    this.confirmAfterMs = confirmAfterMs;
  }

  async scan(pending: readonly PendingReservationView[]): Promise<ReceivedNote[]> {
    const t = this.now();
    return pending
      .filter((reservation) => t - reservation.createdAt >= this.confirmAfterMs / 2)
      .map((reservation) => ({
        ref: `dev:${reservation.reservationId}`,
        memo: reservation.memo,
        amountZat: reservation.amountZat,
        confirmations: t - reservation.createdAt >= this.confirmAfterMs ? 1 : 0,
      }));
  }
}

/** What the lightwalletd scanner needs: one transaction's project notes (zcash/shieldedPayments.ts). */
export interface PaymentReader {
  read(txid: string): Promise<ReadResult>;
}

export const LIGHTWALLETD_POLL_MS = 10_000;
/** A reservation may report at most this many transactions (a retry after a failed broadcast, say). */
const MAX_TXIDS_PER_RESERVATION = 3;

export class LightwalletdNameScanner implements NameScanner {
  readonly kind = "lightwalletd" as const;
  readonly pollMs: number;
  private readonly reader: PaymentReader;
  /** reservationId → the txids its owner reported; dropped once the reservation is no longer pending. Never logged. */
  private readonly reported = new Map<string, string[]>();

  constructor(reader: PaymentReader, pollMs = LIGHTWALLETD_POLL_MS) {
    this.reader = reader;
    this.pollMs = pollMs;
  }

  /** The owner of `reservationId` paid in `txid` (the caller checked ownership). False if the txid is malformed or too many were reported. */
  report(reservationId: string, txid: string): boolean {
    const id = txid.toLowerCase();
    if (!TXID_PATTERN.test(id)) return false;
    const list = this.reported.get(reservationId) ?? [];
    if (list.includes(id)) return true;
    if (list.length >= MAX_TXIDS_PER_RESERVATION) return false;
    list.push(id);
    this.reported.set(reservationId, list);
    return true;
  }

  get reportedCount(): number {
    return this.reported.size;
  }

  /**
   * Drops the txids of every reservation that is no longer pending (confirmed, expired or replaced).
   * NameService calls it after every registry change, so a txid is held at most for its reservation's lifetime
   * (IDENTITY_THREAT_MODEL § 12) — not until some other reservation happens to trigger a scan.
   */
  prune(pending: readonly PendingReservationView[]): void {
    const live = new Set(pending.map((reservation) => reservation.reservationId));
    for (const id of [...this.reported.keys()]) if (!live.has(id)) this.reported.delete(id);
  }

  async scan(pending: readonly PendingReservationView[]): Promise<ReceivedNote[]> {
    this.prune(pending);
    const notes: ReceivedNote[] = [];
    for (const txids of this.reported.values()) {
      for (const txid of txids) {
        const result = await this.reader.read(txid);
        if (result.status === "found") notes.push(...result.notes);
      }
    }
    return notes;
  }
}
