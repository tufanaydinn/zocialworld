import type { ChainSource } from "./lightwalletdClient.js";
import type { DecryptedOutput, HelperNetwork, TxDecryptHelper } from "./txDecrypt.js";

/**
 * Reads ONE transaction a client reported (ADR-018 § 5 name fee, § 6 transfer fee) and returns only the
 * notes it pays to the project's own key: fetched through the server's lightwalletd connection, trial-decrypted with
 * the project's viewing key (fee/registry account), filtered to incoming Sapling and Ironwood outputs — the recipient's
 * output of a player payment is not decryptable with this key and never appears. The txid is passed in and dropped with the
 * result; nothing is logged or stored here.
 */

/** A note paid to the project's key, as the registries consume it. `ref` (`txid:pool:index`) is only ever hashed. */
export interface ProjectNote {
  readonly ref: string;
  readonly memo: string;
  readonly amountZat: number;
  readonly confirmations: number;
}

export type ReadResult =
  /**
   * lightwalletd does not know the transaction (yet). `tip` is the chain tip at that answer ("missing"
   * becomes definitive only once the chain passed the height where the transaction would have expired).
   */
  | { readonly status: "missing"; readonly tip?: number }
  /**
   * Known; `confirmations` is 0 while it is in the mempool. A transaction the helper cannot decrypt has no notes:
   * for a fetched transaction that answer is deterministic, so it reads as "no project note" (never as an outage).
   */
  | { readonly status: "found"; readonly confirmations: number; readonly notes: readonly ProjectNote[] };

export type Decrypt = (rawTxHex: string, height: number) => readonly DecryptedOutput[];

/** The decryption for a key: the vendored helper with the project's viewing key on its network. */
export function helperDecrypt(helper: TxDecryptHelper, network: HelperNetwork, ufvk: string): Decrypt {
  return (rawTxHex, height) => helper.decryptTransaction(rawTxHex, height, network, ufvk);
}

export class ShieldedPaymentReader {
  private readonly chain: ChainSource;
  private readonly decrypt: Decrypt;

  constructor(chain: ChainSource, decrypt: Decrypt) {
    this.chain = chain;
    this.decrypt = decrypt;
  }

  async read(txid: string): Promise<ReadResult> {
    const tx = await this.chain.getTransaction(txid);
    // Transport errors (getTransaction / tipHeight) propagate: the caller retries and never treats them as an answer.
    const tip = await this.chain.tipHeight();
    if (tx === null) return { status: "missing", tip };
    // An unmined transaction is decrypted as of the next block (ZIP 212 / branch rules by height).
    const height = tx.height ?? tip + 1;
    const confirmations = tx.height === null ? 0 : Math.max(0, tip - tx.height + 1);
    let outputs: readonly DecryptedOutput[];
    try {
      outputs = this.decrypt(tx.hex, height);
    } catch {
      outputs = []; // an undecryptable (malformed or foreign) transaction pays the project nothing
    }
    const notes = projectNotes(txid, outputs, confirmations);
    return { status: "found", confirmations, notes };
  }
}

/**
 * The pools a fee or name-fee note may arrive in (ADR-018 § 3 Stage 2): Sapling — a payment to the
 * registry's `zs1…` or Stage-1 unified address, or from a Stage-1 client that has not reloaded yet — and Ironwood — a
 * Stage-2 wallet pays a unified address with an Orchard-family receiver (the registry's full or shielded UA) as an
 * Ironwood output (zw-tx-decrypt 0.2 reports it as `pool: "ironwood"`). Legacy Orchard is withdraw-only since NU6.3:
 * no new value can arrive there, so it is not counted.
 */
export const PROJECT_NOTE_POOLS: ReadonlySet<DecryptedOutput["pool"]> = new Set(["sapling", "ironwood"]);

/** Incoming Sapling and Ironwood outputs with a text memo → notes. Outgoing/internal views and legacy Orchard are ignored. */
export function projectNotes(txid: string, outputs: readonly DecryptedOutput[], confirmations: number): ProjectNote[] {
  const notes: ProjectNote[] = [];
  for (const output of outputs) {
    if (!output.incoming || !PROJECT_NOTE_POOLS.has(output.pool) || output.memoText === null) continue;
    if (!Number.isSafeInteger(output.valueZat) || output.valueZat <= 0) continue;
    notes.push({ ref: `${txid.toLowerCase()}:${output.pool}:${output.outputIndex}`, memo: output.memoText, amountZat: output.valueZat, confirmations });
  }
  return notes;
}
