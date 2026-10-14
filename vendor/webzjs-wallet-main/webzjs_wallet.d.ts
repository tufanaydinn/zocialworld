/* tslint:disable */
/* eslint-disable */
/**
 * The consensus branch this wallet build targets, as lightwalletd prints it ("37a5165b" =
 * NU6.3). Sending is refused when the chain reports another branch.
 */
export function expected_consensus_branch(): string;
/**
 * The stable error codes the engine's errors may carry (as `error.code` and as the message
 * prefix "<code>: "). Name kept from Stage 1.
 */
export function sapling_beta_error_codes(): string[];
/**
 * Build facts for diagnostics and the game's update check: `{ backend, txVersion,
 * expectedBranch, supportedBranches, pools, regtest, errorCodes, retiredErrorCodes }`.
 */
export function engine_info(): WalletEngineInfo;
/**
 * Diagnostics: the wallet database files this engine instance holds in its memory VFS. A wallet
 * that was dropped (`free()`, or garbage-collected) leaves none behind.
 */
export function open_wallet_databases(): string[];
export function start(): void;
export function initThreadPool(num_threads: number): Promise<any>;
export function wbg_rayon_start_worker(receiver: number): void;
/**
 * Generate a new BIP39 24-word seed phrase
 *
 * IMPORTANT: This probably does not use secure randomness when used in the browser
 * and should not be used for anything other than testing
 *
 * # Returns
 *
 * A string containing a 24-word seed phrase
 */
export function generate_seed_phrase(): string;
/**
 * Recover a human-verifiable summary of what a PCZT does.
 *
 * The Snap renders THIS, never the caller-supplied `signDetails`.
 *
 * # Arguments
 * * `network` - "main" or "test"
 * * `pczt` - the PCZT the dApp wants signed
 * * `ufvk` - the signer's Unified Full Viewing Key (for OVK/IVK recovery)
 *
 * # Returns
 * A JSON [`PcztSummary`] (`{ network, outputs, total_in, total_out, fee }`).
 */
export function pczt_describe(network: string, pczt: Pczt, ufvk: UnifiedFullViewingKey): any;
/**
 * Validate that a PCZT is safe to sign with this user's key.
 *
 * Returns `Ok(())` only if every spend is the user's, value balances, and the
 * fee is sane. Any failure is a hard reject — this is what kills blind signing.
 */
export function pczt_validate(network: string, pczt: Pczt, ufvk: UnifiedFullViewingKey): void;
/**
 * Signs and applies signatures to a PCZT.
 * Should in a secure environment (e.g. Metamask snap).
 *
 * # Arguments
 *
 * * `pczt` - The PCZT that needs to signed
 * * `usk` - UnifiedSpendingKey used to sign the PCZT
 * * `seed_fp` - The fingerprint of the seed used to create `usk`
 */
export function pczt_sign(network: string, pczt: Pczt, usk: UnifiedSpendingKey, seed_fp: SeedFingerprint): Promise<Pczt>;
/**
 * Entry point for web workers
 */
export function wasm_thread_entry_point(ptr: number): void;
/**
 * The status of a transaction
 */
export enum TransactionStatusType {
  /**
   * Transaction has been mined
   */
  Confirmed = 0,
  /**
   * Transaction is waiting to be mined
   */
  Pending = 1,
  /**
   * Transaction has expired without being mined
   */
  Expired = 2,
}
/**
 * The type of transaction
 */
export enum TransactionType {
  /**
   * Funds received from external source
   */
  Received = 0,
  /**
   * Funds sent to external recipient
   */
  Sent = 1,
  /**
   * Internal transfer (shielding, de-shielding, or pool migration)
   */
  Shielded = 2,
}
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */
type ReadableStreamType = "bytes";

/** Zocial World wallet (ADR-018 Stage 2): one output of `WebWallet.send` / `preview_send`. */
export interface WalletOutput {
  /** Unified (u1…: its Orchard-family receiver gets an Ironwood output; without one, its Sapling receiver — a UA's transparent receiver is never paid), Sapling (zs1…) or, for withdrawals only, transparent (t1…) or TEX (tex1…, ZIP 320) address. */
  to: string;
  /** Whole zatoshis, 1..=21e14. A number must be a safe integer. */
  amountZat: number | bigint | string;
  /** UTF-8 text memo, at most 512 bytes. Not allowed on a transparent or TEX output. */
  memo?: string | null;
  /** true for a withdrawal to the player's own external wallet: allows a transparent or TEX recipient. */
  withdrawal?: boolean | null;
}
export interface WalletResolvedOutput {
  /** The receiver actually paid: a unified address with only an Orchard-family receiver (Ironwood), a plain Sapling (zs1…), transparent (t1…) or TEX (tex1…) address. */
  to: string;
  pool: "ironwood" | "sapling" | "transparent";
  amountZat: number;
  hasMemo: boolean;
  /** A TEX withdrawal: paid by the second transaction, from a one-time (ephemeral) transparent address. */
  tex: boolean;
}
export interface WalletSendResult {
  /** Transaction ids as explorers print them, in broadcast order: one, or two for a TEX withdrawal (empty for preview_send). */
  txids: string[];
  /** ZIP 317 network fee (all transactions together). */
  feeZat: number;
  /** Sum of the outputs (network fee and change excluded). */
  amountZat: number;
  outputs: WalletResolvedOutput[];
}
export interface WalletShieldResult {
  /** Transaction id (empty for preview_shield). */
  txid: string;
  utxos: number;
  transparentInZat: number;
  feeZat: number;
  /** transparentInZat - feeZat: what arrives in the Ironwood balance. */
  shieldedZat: number;
  /** Always "ironwood". */
  pool: "ironwood";
}
export interface WalletBalances {
  saplingSpendableZat: number;
  saplingPendingChangeZat: number;
  saplingPendingZat: number;
  saplingTotalZat: number;
  /** "Waiting to be shielded": confirmed transparent funds `shield` can spend now. */
  transparentShieldableZat: number;
  transparentPendingZat: number;
  transparentTotalZat: number;
  chainTipHeight: number;
  fullyScannedHeight: number;
  ironwoodSpendableZat: number;
  ironwoodPendingChangeZat: number;
  ironwoodPendingZat: number;
  ironwoodTotalZat: number;
  /** Legacy Orchard notes: spendable out of the withdraw-only Orchard pool (into Ironwood). */
  orchardSpendableZat: number;
  orchardPendingChangeZat: number;
  orchardPendingZat: number;
  orchardTotalZat: number;
  /** Ironwood + Sapling + Orchard spendable: what `send` can spend now. */
  shieldedSpendableZat: number;
  shieldedPendingZat: number;
  shieldedTotalZat: number;
  /** Every pool, transparent included. */
  totalZat: number;
}
export interface WalletAddresses {
  /** Full ZIP-316 unified address: Orchard-family (Ironwood payments arrive here) + Sapling + transparent receivers. */
  unified: string;
  /** Orchard-family + Sapling receivers, no transparent receiver: seal this one in player payments. */
  unifiedShielded: string;
  /** The Stage-1 main address: Sapling + transparent receivers, no Orchard (ADR-018 § 1 until the Stage-2 main address is switched on). */
  unifiedSaplingTransparent: string;
  /** The Sapling receiver alone (zs1…). */
  sapling: string;
  /** The transparent receiver alone (t1…), for exchanges. Public on chain. */
  transparent: string;
  diversifierIndex: string | null;
}
export interface WalletSendingStatus {
  allowed: boolean;
  /** Branch this build targets, e.g. "37a5165b" (NU6.3). */
  expectedBranch: string;
  /** Branch lightwalletd reports for the chain tip; null if it could not be read. */
  chainBranch: string | null;
  chainName: string | null;
  chainTip: number | null;
  nextBlockBranch: string | null;
  pendingUpgrade: { name: string; height: number } | null;
  /** ["ironwood", "sapling", "orchard", "transparent"] (Orchard: spend only). */
  pools: string[];
  /** "consensus_branch_mismatch" | "consensus_upgrade_pending" | "consensus_branch_unknown" when not allowed. */
  code: string | null;
  reason: string | null;
}
export interface WalletEngineInfo {
  backend: string;
  txVersion: string;
  expectedBranch: string;
  supportedBranches: string[];
  pools: string[];
  regtest: boolean;
  errorCodes: string[];
  retiredErrorCodes: string[];
}
/** Stage-1 names, kept as aliases (the Stage-2 types only add fields). */
export type SaplingBetaOutput = WalletOutput;
export type SaplingBetaResolvedOutput = WalletResolvedOutput;
export type SaplingBetaSendResult = WalletSendResult;
export type SaplingBetaShieldResult = WalletShieldResult;
export type SaplingBetaBalances = WalletBalances;
export type SaplingBetaAddresses = WalletAddresses;
export type SaplingBetaSendingStatus = WalletSendingStatus;


export class BlockRange {
  private constructor();
  free(): void;
  0: number;
  1: number;
}
export class IntoUnderlyingByteSource {
  private constructor();
  free(): void;
  start(controller: ReadableByteStreamController): void;
  pull(controller: ReadableByteStreamController): Promise<any>;
  cancel(): void;
  readonly type: ReadableStreamType;
  readonly autoAllocateChunkSize: number;
}
export class IntoUnderlyingSink {
  private constructor();
  free(): void;
  write(chunk: any): Promise<any>;
  close(): Promise<any>;
  abort(reason: any): Promise<any>;
}
export class IntoUnderlyingSource {
  private constructor();
  free(): void;
  pull(controller: ReadableStreamDefaultController): Promise<any>;
  cancel(): void;
}
export class Pczt {
  private constructor();
  free(): void;
  /**
   * Returns the postcard serialization of the Pczt (latest PCZT version).
   */
  serialize(): Uint8Array;
  /**
   * Deserialize to a Pczt from postcard bytes.
   */
  static from_bytes(bytes: Uint8Array): Pczt;
}
/**
 * A Zcash Sapling proof generation key
 *
 * This is a wrapper around the `sapling::ProofGenerationKey` type. It is used for generating proofs for Sapling PCZTs.
 */
export class ProofGenerationKey {
  private constructor();
  free(): void;
}
/**
 * A handler to an immutable proposal. This can be passed to `create_proposed_transactions` to prove/authorize the transactions
 * before they are sent to the network.
 *
 * Stage 2: the note references are the SQLite wallet database's (`zcash_client_sqlite::ReceivedNoteId`).
 */
export class Proposal {
  private constructor();
  free(): void;
}
/**
 * A ZIP32 seed fingerprint. Essentially a Blake2b hash of the seed.
 *
 * This is a wrapper around the `zip32::fingerprint::SeedFingerprint` type.
 */
export class SeedFingerprint {
  free(): void;
  /**
   * Construct a new SeedFingerprint
   *
   * # Arguments
   *
   * * `seed` - At least 32 bytes of entry. Care should be taken as to how this is derived
   */
  constructor(seed: Uint8Array);
  to_bytes(): Uint8Array;
  static from_bytes(bytes: Uint8Array): SeedFingerprint;
}
/**
 * A single transaction history entry
 */
export class TransactionHistoryEntry {
  private constructor();
/**
** Return copy of self without private attributes.
*/
  toJSON(): Object;
/**
* Return stringified version of self.
*/
  toString(): string;
  free(): void;
  readonly txid: string;
  readonly tx_type: TransactionType;
  readonly value: bigint;
  readonly fee: bigint | undefined;
  readonly block_height: number | undefined;
  readonly confirmations: number;
  readonly status: TransactionStatusType;
  readonly memo: string | undefined;
  readonly timestamp: bigint | undefined;
  readonly pool: string;
}
/**
 * Response containing paginated transaction history
 */
export class TransactionHistoryResponse {
  private constructor();
/**
** Return copy of self without private attributes.
*/
  toJSON(): Object;
/**
* Return stringified version of self.
*/
  toString(): string;
  free(): void;
  readonly transactions: any;
  readonly total_count: number;
  readonly has_more: boolean;
}
/**
 * A Zcash viewing key
 *
 * This is a wrapper around the `zcash_keys::keys::ViewingKey` type.
 * UFVKs should be generated from a spending key by calling `to_unified_full_viewing_key`
 * They can also be encoded and decoded to a canonical string representation
 */
export class UnifiedFullViewingKey {
  free(): void;
  /**
   * Encode the UFVK to a string
   *
   * # Arguments
   *
   * * `network` - Must be either "main" or "test"
   */
  encode(network: string): string;
  /**
   * Construct a UFVK from its encoded string representation
   *
   * # Arguments
   *
   * * `network` - Must be either "main" or "test"
   * * `encoding` - The encoded string representation of the UFVK
   */
  constructor(network: string, encoding: string);
  /**
   * Get the default transparent address derived from this UFVK.
   *
   * This can be used before creating an account to detect the wallet birthday
   * by querying for transactions to this address.
   *
   * # Arguments
   *
   * * `network` - Must be either "main" or "test"
   *
   * # Returns
   *
   * The transparent address as a string, or None if this UFVK has no transparent component.
   */
  get_transparent_address(network: string): string | undefined;
}
/**
 * A Zcash spending key
 *
 * This is a wrapper around the `zcash_keys::keys::SpendingKey` type. It can be created from at least 32 bytes of seed entropy
 */
export class UnifiedSpendingKey {
  free(): void;
  /**
   * Construct a new UnifiedSpendingKey
   *
   * # Arguments
   *
   * * `network` - Must be either "main" or "test"
   * * `seed` - At least 32 bytes of entry. Care should be taken as to how this is derived
   * * `hd_index` - [ZIP32](https://zips.z.cash/zip-0032) hierarchical deterministic index of the account
   */
  constructor(network: string, seed: Uint8Array, hd_index: number);
  /**
   * Obtain the UFVK corresponding to this spending key
   */
  to_unified_full_viewing_key(): UnifiedFullViewingKey;
  to_sapling_proof_generation_key(): ProofGenerationKey;
}
export class WalletSummary {
  private constructor();
/**
** Return copy of self without private attributes.
*/
  toJSON(): Object;
/**
* Return stringified version of self.
*/
  toString(): string;
  free(): void;
  chain_tip_height: number;
  fully_scanned_height: number;
  next_sapling_subtree_index: bigint;
  next_orchard_subtree_index: bigint;
  /**
   * Stage 2.
   */
  next_ironwood_subtree_index: bigint;
  readonly account_balances: any;
}
/**
 * # A Zcash wallet
 *
 * This is the main entry point for interacting with this library.
 *
 * Stage 2 (ADR-018 § 3): the wallet database is the upstream SQLite wallet backend
 * (`zcash_client_sqlite`) running in WebAssembly; it tracks the Ironwood, Sapling, legacy Orchard
 * and transparent pools. The class name, methods and result shapes are those of the Stage-1
 * (Sapling beta) engine, with fields added (see API-v2.md).
 *
 * ```javascript
 * const wallet = new WebWallet("main", "https://…/zcash/lwd", 1, 1, savedBytesOrNull);
 * const accountId = await wallet.create_account("Zocial World", seedPhrase, 0, birthdayHeight);
 * await wallet.sync();
 * const balances = await wallet.get_balances(accountId);
 * const { txids } = await wallet.send(accountId, [{ to, amountZat, memo }], seedPhrase, 0);
 * const bytes = await wallet.db_to_bytes(); // persist
 * ```
 *
 * Accounts are numbered 0, 1, … in creation order. Syncing and proving run in Web Workers; other
 * calls made meanwhile wait for the wallet database (one lock).
 */
export class WebWallet {
  free(): void;
  /**
   * Create a new instance of a Zcash wallet for a given network.
   *
   * * `network` - "main" or "test" ("test" is the local regtest chain in the regtest twin build)
   * * `lightwalletd_url` - Url of the lightwalletd instance (the game server's bridge)
   * * `min_confirmations_trusted` / `min_confirmations_untrusted` - confirmations policy
   * * `db_bytes` - (Optional) the bytes of `db_to_bytes()` to restore a saved wallet. A Stage-1
   *   (memory backend) save, or damaged bytes, is refused with `wallet_format_unsupported`:
   *   restore the wallet from its seed phrase and birthday instead.
   */
  constructor(network: string, lightwalletd_url: string, min_confirmations_trusted: number, min_confirmations_untrusted: number, db_bytes?: Uint8Array | null);
  /**
   * `"sqlite <version>"`: the wallet database backend, for diagnostics.
   */
  static backend(): string;
  /**
   * Add a new account to the wallet using a given seed phrase; returns its numeric id
   * (creation order, from 0).
   *
   * * `seed_phrase` - 24 word mnemonic seed phrase
   * * `account_hd_index` - [ZIP32](https://zips.z.cash/zip-0032) index of the account
   * * `birthday_height` - Block height at which the account was created (scanning starts there)
   */
  create_account(account_name: string, seed_phrase: string, account_hd_index: number, birthday_height?: number | null): Promise<number>;
  /**
   * Add a new spending account by importing a Unified Full Viewing Key (UFVK); the matching
   * spending key must be supplied when sending.
   */
  create_account_ufvk(account_name: string, encoded_ufvk: string, seed_fingerprint: SeedFingerprint, account_hd_index: number, birthday_height?: number | null): Promise<number>;
  /**
   * Add a new view-only account by importing a Unified Full Viewing Key (UFVK).
   */
  create_account_view_ufvk(account_name: string, encoded_ufvk: string, birthday_height?: number | null): Promise<number>;
  /**
   * Syncs the wallet in a Web Worker: scans compact blocks to the chain tip through the game
   * server's bridge (Ironwood, Sapling and Orchard outputs are trial-decrypted, spends detected
   * by nullifier, transparent UTXOs refreshed), then fetches what the wallet still needs —
   * received memos and the status of sent transactions (`GetTransaction`), transparent history
   * (`GetTaddressTxids`) — checks the witnesses of spendable notes, and reconciles transparent
   * funds spent by another wallet with the same seed.
   */
  sync(): Promise<void>;
  /**
   * The wallet summary (`account_balances` keyed by numeric account id).
   */
  get_wallet_summary(): Promise<WalletSummary | undefined>;
  /**
   * Legacy API: a proposal paying one (non-withdrawal) output, under the Stage-2 pool policy
   * (an Orchard-family receiver gets an Ironwood output, else Sapling; change to Ironwood).
   * Prefer `send` / `preview_send`.
   */
  propose_transfer(account_id: number, to_address: string, value: bigint, memo?: string | null): Promise<Proposal>;
  /**
   * Legacy API: proves and signs the transactions of a `propose_transfer` proposal in a Web
   * Worker and stores them. Returns the txids flattened (32 bytes each, internal byte order).
   */
  create_proposed_transactions(proposal: Proposal, seed_phrase: string, account_hd_index: number): Promise<Uint8Array>;
  /**
   * The wallet database as bytes — a SQLite database file — to persist and pass back to the
   * constructor. Taken under the wallet lock (waits for a running sync).
   */
  db_to_bytes(): Promise<Uint8Array>;
  /**
   * Legacy API: broadcasts transactions created by `create_proposed_transactions` (txids
   * flattened, 32 bytes each). Re-checks the consensus branch first.
   */
  send_authorized_transactions(txids: Uint8Array): Promise<void>;
  /**
   * The wallet's main receive address: the full unified address (Orchard-family receiver —
   * where Ironwood payments arrive — + Sapling + transparent), per the ADR-018 § 1 Stage 2
   * amendment. Same as `get_unified_address` and `get_addresses().unified`.
   */
  get_current_address(account_id: number): Promise<string>;
  /**
   * The full unified address (see `get_current_address`).
   */
  get_unified_address(account_id: number): Promise<string>;
  /**
   * The same Sapling receiver in the plain Sapling encoding (`zs1…` on mainnet).
   */
  get_sapling_address(account_id: number): Promise<string>;
  /**
   * The plain transparent address (`t1…` on mainnet) of the same diversifier index: the
   * exchange address. Funds sent here are public and wait to be shielded (`shield` → Ironwood).
   */
  get_transparent_address(account_id: number): Promise<string>;
  /**
   * All receive addresses: `{ unified, unifiedShielded, unifiedSaplingTransparent, sapling,
   * transparent, diversifierIndex }`.
   */
  get_addresses(account_id: number): Promise<WalletAddresses>;
  /**
   * Balances of every pool in zatoshis (Ironwood, Sapling, legacy Orchard, transparent; each
   * spendable / pending / total) plus `shieldedSpendableZat` (what `send` can use).
   */
  get_balances(account_id: number): Promise<WalletBalances>;
  /**
   * The upgrade guard, unchanged from Stage 1. Never throws; returns `{ allowed,
   * expectedBranch, chainBranch, chainName, chainTip, nextBlockBranch, pendingUpgrade, pools,
   * code, reason }`. When `allowed` is false every send/shield refuses with `code`
   * (`consensus_branch_mismatch`, `consensus_upgrade_pending` or `consensus_branch_unknown`),
   * while sync and balances keep working.
   */
  sending_status(): Promise<WalletSendingStatus>;
  /**
   * The ONE general send. Pays every output in a single version-6 transaction (a TEX
   * withdrawal takes two: shielded → ephemeral address → TEX), spending Ironwood, Sapling and
   * legacy Orchard notes with change to Ironwood, and broadcasts it. Proving runs in a Web
   * Worker.
   *
   * * `outputs` - `[{ to, amountZat, memo?, withdrawal? }]` (1–8). `to`: a unified address
   *   (Orchard-family receiver → Ironwood; else its Sapling receiver), a Sapling address, or —
   *   withdrawals only — a transparent or TEX address.
   *
   * Returns `{ txids, feeZat, amountZat, outputs: [{ to, pool, amountZat, hasMemo, tex }] }`.
   * Errors carry a stable `code` (see `sapling_beta_error_codes`).
   */
  send(account_id: number, outputs: WalletOutput[], seed_phrase: string, account_hd_index: number): Promise<WalletSendResult>;
  /**
   * What `send` would do for these outputs — `{ txids: [], feeZat, amountZat, outputs }` —
   * without proving, signing or broadcasting. Use it to show the network fee.
   */
  preview_send(account_id: number, outputs: WalletOutput[]): Promise<WalletSendResult>;
  /**
   * Shields the account's confirmed transparent funds into its own Ironwood address
   * (version-6 transaction, ZIP 317 network fee, no project fee) and broadcasts it.
   * `threshold_zat` (optional, default 1) is the minimum transparent input to shield.
   *
   * Returns `{ txid, utxos, transparentInZat, feeZat, shieldedZat, pool: "ironwood" }`.
   */
  shield(account_id: number, seed_phrase: string, account_hd_index: number, threshold_zat?: bigint | null): Promise<WalletShieldResult>;
  /**
   * What `shield` would do — `{ txid: "", utxos, transparentInZat, feeZat, shieldedZat, pool }`
   * — without proving or broadcasting.
   */
  preview_shield(account_id: number, threshold_zat?: bigint | null): Promise<WalletShieldResult>;
  /**
   * Legacy PCZT path: a shielding PCZT (transparent → own Ironwood address, threshold
   * 100,000 zat). Then `pczt_sign` → `pczt_prove` → `pczt_send`. Prefer `shield`.
   */
  pczt_shield(account_id: number): Promise<Pczt>;
  /**
   * Legacy PCZT path: a PCZT for one payment (Stage-2 pool policy, no withdrawals).
   */
  pczt_create(account_id: number, to_address: string, value: bigint): Promise<Pczt>;
  /**
   * Creates and inserts the Sapling, Orchard and Ironwood proofs of a PCZT. If there are
   * Sapling spends, a ProofGenerationKey must be supplied.
   */
  pczt_prove(pczt: Pczt, sapling_proof_gen_key?: ProofGenerationKey | null): Promise<Pczt>;
  pczt_send(pczt: Pczt): Promise<void>;
  pczt_combine(pczts: Pczt[]): Pczt;
  /**
   * The transparent receiver of the account's receive address (same as
   * `get_transparent_address`; kept for the existing game code).
   */
  get_current_address_transparent(account_id: number): Promise<string>;
  /**
   * Transaction history of an account, newest first (unmined at the top), from the wallet
   * database's `v_transactions` / `v_tx_outputs` views.
   *
   * ```javascript
   * const history = await wallet.get_transaction_history(0, 50, 0);
   * console.log(history.transactions);
   * ```
   */
  get_transaction_history(account_id: number, limit?: number | null, offset?: number | null): Promise<TransactionHistoryResponse>;
  /**
   *
   * Get the highest known block height from the connected lightwalletd instance
   */
  get_latest_block(): Promise<bigint>;
  /**
   * Detect the wallet birthday by querying for the first transaction to a transparent address.
   * Returns the earliest transaction height minus 100 blocks, or None.
   */
  detect_birthday_from_transparent_address(transparent_address: string): Promise<number | undefined>;
}
export class wbg_rayon_PoolBuilder {
  private constructor();
  free(): void;
  numThreads(): number;
  receiver(): number;
  build(): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly __wbg_proposal_free: (a: number, b: number) => void;
  readonly __wbg_transactionhistoryentry_free: (a: number, b: number) => void;
  readonly transactionhistoryentry_txid: (a: number) => [number, number];
  readonly transactionhistoryentry_tx_type: (a: number) => number;
  readonly transactionhistoryentry_value: (a: number) => bigint;
  readonly transactionhistoryentry_fee: (a: number) => [number, bigint];
  readonly transactionhistoryentry_block_height: (a: number) => number;
  readonly transactionhistoryentry_confirmations: (a: number) => number;
  readonly transactionhistoryentry_status: (a: number) => number;
  readonly transactionhistoryentry_memo: (a: number) => [number, number];
  readonly transactionhistoryentry_timestamp: (a: number) => [number, bigint];
  readonly transactionhistoryentry_pool: (a: number) => [number, number];
  readonly __wbg_transactionhistoryresponse_free: (a: number, b: number) => void;
  readonly transactionhistoryresponse_transactions: (a: number) => any;
  readonly transactionhistoryresponse_total_count: (a: number) => number;
  readonly transactionhistoryresponse_has_more: (a: number) => number;
  readonly __wbg_webwallet_free: (a: number, b: number) => void;
  readonly webwallet_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
  readonly webwallet_backend: () => [number, number];
  readonly webwallet_create_account: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => any;
  readonly webwallet_create_account_ufvk: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => any;
  readonly webwallet_create_account_view_ufvk: (a: number, b: number, c: number, d: number, e: number, f: number) => any;
  readonly webwallet_sync: (a: number) => any;
  readonly webwallet_get_wallet_summary: (a: number) => any;
  readonly webwallet_propose_transfer: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number) => any;
  readonly webwallet_create_proposed_transactions: (a: number, b: number, c: number, d: number, e: number) => any;
  readonly webwallet_db_to_bytes: (a: number) => any;
  readonly webwallet_send_authorized_transactions: (a: number, b: number, c: number) => any;
  readonly webwallet_get_current_address: (a: number, b: number) => any;
  readonly webwallet_get_unified_address: (a: number, b: number) => any;
  readonly webwallet_get_sapling_address: (a: number, b: number) => any;
  readonly webwallet_get_transparent_address: (a: number, b: number) => any;
  readonly webwallet_get_addresses: (a: number, b: number) => any;
  readonly webwallet_get_balances: (a: number, b: number) => any;
  readonly webwallet_sending_status: (a: number) => any;
  readonly webwallet_send: (a: number, b: number, c: any, d: number, e: number, f: number) => any;
  readonly webwallet_preview_send: (a: number, b: number, c: any) => any;
  readonly webwallet_shield: (a: number, b: number, c: number, d: number, e: number, f: number, g: bigint) => any;
  readonly webwallet_preview_shield: (a: number, b: number, c: number, d: bigint) => any;
  readonly webwallet_pczt_shield: (a: number, b: number) => any;
  readonly webwallet_pczt_create: (a: number, b: number, c: number, d: number, e: bigint) => any;
  readonly webwallet_pczt_prove: (a: number, b: number, c: number) => any;
  readonly webwallet_pczt_send: (a: number, b: number) => any;
  readonly webwallet_pczt_combine: (a: number, b: number, c: number) => [number, number, number];
  readonly webwallet_get_current_address_transparent: (a: number, b: number) => any;
  readonly webwallet_get_transaction_history: (a: number, b: number, c: number, d: number) => any;
  readonly webwallet_get_latest_block: (a: number) => any;
  readonly webwallet_detect_birthday_from_transparent_address: (a: number, b: number, c: number) => any;
  readonly __wbg_walletsummary_free: (a: number, b: number) => void;
  readonly __wbg_get_walletsummary_chain_tip_height: (a: number) => number;
  readonly __wbg_set_walletsummary_chain_tip_height: (a: number, b: number) => void;
  readonly __wbg_get_walletsummary_fully_scanned_height: (a: number) => number;
  readonly __wbg_set_walletsummary_fully_scanned_height: (a: number, b: number) => void;
  readonly __wbg_get_walletsummary_next_sapling_subtree_index: (a: number) => bigint;
  readonly __wbg_set_walletsummary_next_sapling_subtree_index: (a: number, b: bigint) => void;
  readonly __wbg_get_walletsummary_next_orchard_subtree_index: (a: number) => bigint;
  readonly __wbg_set_walletsummary_next_orchard_subtree_index: (a: number, b: bigint) => void;
  readonly __wbg_get_walletsummary_next_ironwood_subtree_index: (a: number) => bigint;
  readonly __wbg_set_walletsummary_next_ironwood_subtree_index: (a: number, b: bigint) => void;
  readonly walletsummary_account_balances: (a: number) => any;
  readonly expected_consensus_branch: () => [number, number];
  readonly sapling_beta_error_codes: () => [number, number];
  readonly engine_info: () => [number, number, number];
  readonly open_wallet_databases: () => [number, number];
  readonly start: () => void;
  readonly __wbg_blockrange_free: (a: number, b: number) => void;
  readonly __wbg_get_blockrange_0: (a: number) => number;
  readonly __wbg_set_blockrange_0: (a: number, b: number) => void;
  readonly __wbg_get_blockrange_1: (a: number) => number;
  readonly __wbg_set_blockrange_1: (a: number, b: number) => void;
  readonly __wbg_wbg_rayon_poolbuilder_free: (a: number, b: number) => void;
  readonly wbg_rayon_poolbuilder_numThreads: (a: number) => number;
  readonly wbg_rayon_poolbuilder_receiver: (a: number) => number;
  readonly wbg_rayon_poolbuilder_build: (a: number) => void;
  readonly initThreadPool: (a: number) => any;
  readonly wbg_rayon_start_worker: (a: number) => void;
  readonly rust_sqlite_wasm_shim_localtime_js: (a: bigint, b: number) => void;
  readonly rust_sqlite_wasm_shim_tzset_js: (a: number, b: number, c: number, d: number) => void;
  readonly rust_sqlite_wasm_shim_emscripten_get_now: () => number;
  readonly rust_sqlite_wasm_shim_wasi_random_get: (a: number, b: number) => number;
  readonly rust_sqlite_wasm_shim_exit: (a: number) => void;
  readonly rust_sqlite_wasm_shim_abort_js: () => void;
  readonly rust_sqlite_wasm_shim_malloc: (a: number) => number;
  readonly rust_sqlite_wasm_shim_free: (a: number) => void;
  readonly rust_sqlite_wasm_shim_realloc: (a: number, b: number) => number;
  readonly rust_sqlite_wasm_shim_calloc: (a: number, b: number) => number;
  readonly sqlite3_os_init: () => number;
  readonly __wbg_seedfingerprint_free: (a: number, b: number) => void;
  readonly seedfingerprint_new: (a: number, b: number) => [number, number, number];
  readonly seedfingerprint_to_bytes: (a: number) => [number, number];
  readonly seedfingerprint_from_bytes: (a: number, b: number) => [number, number, number];
  readonly __wbg_proofgenerationkey_free: (a: number, b: number) => void;
  readonly __wbg_unifiedspendingkey_free: (a: number, b: number) => void;
  readonly unifiedspendingkey_new: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly unifiedspendingkey_to_unified_full_viewing_key: (a: number) => number;
  readonly unifiedspendingkey_to_sapling_proof_generation_key: (a: number) => number;
  readonly __wbg_unifiedfullviewingkey_free: (a: number, b: number) => void;
  readonly unifiedfullviewingkey_encode: (a: number, b: number, c: number) => [number, number, number, number];
  readonly unifiedfullviewingkey_new: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly unifiedfullviewingkey_get_transparent_address: (a: number, b: number, c: number) => [number, number, number, number];
  readonly generate_seed_phrase: () => [number, number];
  readonly pczt_describe: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly pczt_validate: (a: number, b: number, c: number, d: number) => [number, number];
  readonly pczt_sign: (a: number, b: number, c: number, d: number, e: number) => any;
  readonly __wbg_pczt_free: (a: number, b: number) => void;
  readonly pczt_serialize: (a: number) => [number, number];
  readonly pczt_from_bytes: (a: number, b: number) => number;
  readonly wasm_thread_entry_point: (a: number) => void;
  readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
  readonly intounderlyingbytesource_type: (a: number) => number;
  readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
  readonly intounderlyingbytesource_start: (a: number, b: any) => void;
  readonly intounderlyingbytesource_pull: (a: number, b: any) => any;
  readonly intounderlyingbytesource_cancel: (a: number) => void;
  readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
  readonly intounderlyingsource_pull: (a: number, b: any) => any;
  readonly intounderlyingsource_cancel: (a: number) => void;
  readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
  readonly intounderlyingsink_write: (a: number, b: any) => any;
  readonly intounderlyingsink_close: (a: number) => any;
  readonly intounderlyingsink_abort: (a: number, b: any) => any;
  readonly rustsecp256k1_v0_10_0_context_create: (a: number) => number;
  readonly rustsecp256k1_v0_10_0_context_destroy: (a: number) => void;
  readonly rustsecp256k1_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
  readonly rustsecp256k1_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
  readonly memory: WebAssembly.Memory;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_5: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_export_7: WebAssembly.Table;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __externref_drop_slice: (a: number, b: number) => void;
  readonly closure2911_externref_shim: (a: number, b: number, c: any) => void;
  readonly _dyn_core__ops__function__FnMut_____Output___R_as_wasm_bindgen__closure__WasmClosure___describe__invoke__h1ec9f2f4bb78ee38: (a: number, b: number) => void;
  readonly closure2982_externref_shim: (a: number, b: number, c: any) => void;
  readonly closure4389_externref_shim: (a: number, b: number, c: any, d: any) => void;
  readonly __wbindgen_thread_destroy: (a?: number, b?: number, c?: number) => void;
  readonly __wbindgen_start: (a: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number }} module - Passing `SyncInitInput` directly is deprecated.
* @param {WebAssembly.Memory} memory - Deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number } | SyncInitInput, memory?: WebAssembly.Memory): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number }} module_or_path - Passing `InitInput` directly is deprecated.
* @param {WebAssembly.Memory} memory - Deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number } | InitInput | Promise<InitInput>, memory?: WebAssembly.Memory): Promise<InitOutput>;
