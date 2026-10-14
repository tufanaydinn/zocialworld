# Wallet engine Stage 2 ("Ironwood") — API for the game (ADR-018 § 3)

> **In this repository:** the package is vendored as `vendor/webzjs-wallet-main/` (its wasm binary is a
> GitHub Release asset, see `README.md`) and the helper as `vendor/zcash-tx-decrypt/`; the build scripts,
> `harness/` and `fixtures/` are in this directory. The game's adapter that follows this API is
> `apps/web/src/zcash/core/wallet.ts` (+ `apps/web/src/zcash/ZcashWalletAdapter.ts`).

Package: `webzjs-wallet-main/` (wasm-pack name `@zcashcommunitygrants/webzjs-wallet`; the game keeps
importing it under its `@chainsafe/webzjs-wallet` alias). `webzjs-wallet-regtest/` is the same
engine whose `"test"` network is a local regtest chain (every upgrade through NU6.3 at height 1) —
**testing only, never deployed**.

This document describes the Stage-2 engine against the Stage 1 ("Sapling beta") engine it replaced.
**Same class (`WebWallet`), same methods, same result shapes; fields are only added.** Everything
marked _unchanged_ behaves exactly as in Stage 1. All amounts are **zatoshis** (1 ZEC = 100,000,000 zat);
amounts in results are JS numbers (always < 2^53).

> **Build and verification.** The reproducible build (`build-engine.sh`, SQLite compiled from source)
> reproduces both packages byte for byte in two independent directories (main `772d2606…`, regtest
> `768907a2…`). The server helper is **zw-tx-decrypt 0.2** (Appendix B: full / shielded / Stage-1
> registry addresses, Ironwood fee outputs). The engine passed the full regtest matrix
> (`harness/run-regtest-m3.mjs`), the game server's own fee and name checks with Ironwood and Sapling
> fee outputs and its start-up address check (`harness/run-server-checks-m3.mjs`), a mainnet smoke test
> through the game server's bridge (`harness/run-mainnet-m3.mjs`) and the NU7 guard on the public
> Testnet (`harness/run-testnet-m3.mjs`).
>
> **Behaviour notes.** `get_addresses` always returns the account's default address; `shield` takes one
> source per call (regular t-addresses, or one TEX one-time address); a half-sent TEX pair comes back as
> shieldable after the expiry; damaged saves give `wallet_format_unsupported`.

## 0. What changed since Stage 1

| Area | Stage 1 | Stage 2 (this engine) |
|---|---|---|
| Wallet database | `zcash_client_memory` (no Ironwood) | upstream `zcash_client_sqlite` in wasm (sqlite-wasm-rs, SQLite 3.50.4, memory VFS): Ironwood, Sapling, Orchard, transparent |
| Saved wallet (`db_to_bytes`) | postcard/protobuf memory dump | a **SQLite database file** (`"SQLite format 3\0"`). A Stage-1 save is refused: `wallet_format_unsupported` |
| Addresses | `{ unified (Sapling+t), sapling, transparent, diversifierIndex }` | **adds** `unifiedShielded` (Orchard-family + Sapling) and `unifiedSaplingTransparent` (the Stage-1 address); `unified` is now the **full** UA (Orchard-family + Sapling + t) — ADR-018 § 1 Stage 2 amendment |
| Balances | Sapling + transparent | **adds** Ironwood and legacy Orchard (each spendable / pending change / pending / total) and `shieldedSpendableZat`, `shieldedPendingZat`, `shieldedTotalZat`, `totalZat`; Stage-1 fields keep their meaning (Sapling only) |
| Spending | Sapling notes only | **Ironwood, Sapling and legacy Orchard notes** |
| Paying | Sapling receiver (refused Orchard-only `u1`) | UA with an Orchard-family receiver → **Ironwood** output; else Sapling; `zs1` → Sapling; `t1` → withdrawals; **TEX → withdrawals (two transactions)** |
| Change / shielding | Sapling | **Ironwood** |
| Transactions | version 5, no Orchard/Ironwood bundle | **version 6** (ZIP 229), Ironwood bundle; Orchard bundle only to spend legacy Orchard notes |
| `send` result outputs | `{ to, pool: "sapling"\|"transparent", amountZat, hasMemo }` | `pool` may be `"ironwood"`; **adds** `tex: boolean`; `txids` has 2 entries for a TEX withdrawal |
| `shield` result | `{ txid, utxos, transparentInZat, feeZat, shieldedZat }` | **adds** `pool: "ironwood"` |
| Upgrade guard | NU6.3 branch + pending-upgrade guard | _unchanged_ (`pools` now `["ironwood","sapling","orchard","transparent"]`) |
| Memos | `enhance_received_memos` (patched memory backend) | the backend's `transaction_data_requests()` loop (memos, status of sent transactions, transparent history) |
| History | walked memory-backend tables | the database's `v_transactions` / `v_tx_outputs` views; same shape; `value` includes the fee, `fee` filled in |
| Error codes | 21 codes | all kept; **new** `pool_policy_violation`; `recipient_no_sapling_receiver` / `sapling_only_violation` retired (never produced) |
| New exports | — | `WebWallet.backend()`, `engine_info()`, `open_wallet_databases()`; TS types `Wallet*` (the `SaplingBeta*` names stay as aliases) |
| Removed | — | the memory backend (`zcash_client_memory`) and the interim `IronwoodWallet` class (folded into `WebWallet`) |


## 1. Error codes

Every engine error the game should handle is a JS `Error` whose `message` starts with a stable
code and `": "`, and whose `code` property is that code (`e.code`); broadcast errors also carry
`e.txid`. Errors that are not listed (network, sync, internal) have no `code`.
`sapling_beta_error_codes(): string[]` (name kept) returns the whole list, retired codes included;
`engine_info().retiredErrorCodes` lists the two Stage 2 no longer produces.

| `e.code` | Stage | When | Game should |
|---|---|---|---|
| `invalid_address` | 1 | the `to` string is not a Zcash address | "That is not a Zcash address." |
| `recipient_transparent_not_allowed` | 1, **widened** | a `t1…` **or `tex1…`** address in an output that is not a withdrawal | only withdrawals may go to transparent / TEX addresses |
| `recipient_unsupported` | 1, **narrowed** | Sprout, or a unified address with no Orchard-family and no Sapling receiver (transparent / unknown receivers only — a UA's transparent receiver is never paid). **TEX is no longer refused** (withdrawals) | "This address type is not supported." |
| `recipient_wrong_network` | 1 | e.g. a testnet address on mainnet | "This address is for another network." |
| `memo_not_allowed` | 1 | a memo on an output that resolves to a transparent or TEX address | drop the memo for transparent withdrawals |
| `memo_too_long` | 1 | memo > 512 UTF-8 bytes | |
| `invalid_amount` | 1 | amountZat not a whole number in 1..=2.1e15 (also the shield threshold) | |
| `invalid_outputs` | 1 | outputs not an array of objects, empty, or more than 8 | programming error |
| `insufficient_funds` | 1, **widened** | spendable **shielded** balance (Ironwood + Sapling + legacy Orchard) < outputs + network fee | "Not enough shielded ZEC." (transparent funds must be shielded first) |
| `nothing_to_shield` | 1 | no confirmed transparent funds, or not more than the network fee | hide/disable Shield |
| `wallet_not_synced` | 1 | the wallet was never synced | sync first |
| `consensus_branch_mismatch` | 1 | lightwalletd's chain is on a consensus branch this build cannot sign for | "Sending is paused until the game updates. Your balance is safe." |
| `consensus_upgrade_pending` | 1 | a network upgrade activates within 41 blocks | same |
| `consensus_branch_unknown` | 1 | GetLightdInfo failed or returned an unparseable branch | "Can't reach the network right now" |
| `proposal_failed` | 1 | other proposal errors (detail in the message) | generic failure |
| `transaction_build_failed` | 1 | proving/signing failed, or the worker panicked | generic failure; nothing was broadcast |
| `broadcast_failed` | 1 | the node rejected the transaction (`[txid=…]`, `e.txid`); for a TEX pair the message says which of the two: `… (transaction 1 of 2)` or `… (transaction 2 of 2; transaction 1 <txid> was sent)` — a stable marker (the game's message relies on it; same for `broadcast_uncertain`) | notes stay reserved until expiry (≈ 40 blocks). **TEX, transaction 2 refused after 1 left:** the amount + tx 2's fee sit on the one-time t-address (not at the exchange); after tx 2 expires, the next scheduled check of that address (an unspent-outputs request) makes the value shieldable again — "waiting to be shielded", then `shield` |
| `broadcast_uncertain` | 1 | the answer to `SendTransaction` was lost; the transaction may have been sent (`e.txid`) | never retry blindly |
| `wallet_format_unsupported` | **2 (new)** | the constructor got bytes that are not a Stage-2 (SQLite) wallet — a Stage-1 (memory backend) save, or damaged bytes: no SQLite header, a page size that is not a power of two in 512–65,536, a length that is not whole pages, a corrupt first page, or SQLite's `NotADatabase` / `DatabaseCorrupt` while opening or migrating the save (checked before sqlite-wasm-rs sees the bytes — a page size of 0 used to trap the instance) | restore from the encrypted seed + birthday (a rescan), then save the new bytes |
| `pool_policy_violation` | **2 (new)** | internal safety check: a proposal or built transaction does not follow the Stage-2 pool policy (§ 7). Replaces `sapling_only_violation` | report as a bug; nothing was broadcast |
| `recipient_no_sapling_receiver` | 1, **retired** | no longer produced: an Orchard-only `u1` is payable now | keep the mapping; it will not occur |
| `sapling_only_violation` | 1, **retired** | no longer produced (see `pool_policy_violation`) | keep the mapping |

Recipient errors in `send` / `preview_send` read `"<code>: output <i>: …"` (unchanged).

## 2. Construction, persistence and the wallet file

```ts
new WebWallet(network: "main" | "test", lightwalletd_url: string, min_confirmations_trusted: number,
              min_confirmations_untrusted: number, db_bytes?: Uint8Array | null)      // unchanged signature
db_to_bytes(): Promise<Uint8Array>            // CHANGED content: a SQLite database file
free(): void                                   // wasm-bindgen; Stage 2 also deletes the wallet file
WebWallet.backend(): string                    // NEW static: "sqlite 3.50.4"
open_wallet_databases(): string[]              // NEW free function (diagnostics): wallet files held in the memory VFS
```

* **Storage.** The wallet is a SQLite database (`zcash_client_sqlite`, all upstream migrations run
  on open) in sqlite-wasm-rs's in-memory VFS. `db_to_bytes()` returns the database file itself
  (starts with `"SQLite format 3\0"`), taken under the wallet lock, so it waits for a running sync.
  Persist it exactly as today (`exportDb` → IndexedDB); pass it back as `db_bytes`.
* **Stage-1 saves.** Bytes that are not a SQLite wallet (a Stage-1 memory-backend save, or damaged
  bytes) make the constructor throw `wallet_format_unsupported`. The game then restores from
  the encrypted seed and the stored birthday: `new WebWallet(net, url, 1, 1, null)` →
  `create_account("Zocial World", seed, 0, birthday)` → `sync()` → `db_to_bytes()`. Verified on the
  local chain with a **real** Stage-1 save made by the Stage-1 engine (`stage1-save-refused`), and
  the seed + birthday rescan finds every pool, the history and the memos (`restore-from-seed-*`).
* **Size.** The engine compacts the database (`VACUUM` once at least a quarter of its pages are free)
  after every chain scan and before every `db_to_bytes()`: scan batches rewrite tree shards,
  checkpoints and the nullifier map and used to leave most pages free (1,333 of 1,741 after 5,500
  blocks). Measured on mainnet, a fresh wallet synced over 30,000 blocks saves **3.51 MB** (Stage 1
  in the same page: 10.22 MB); natively, 5,520 blocks save 1.5 MB (7.1 MB before compaction).
  The save then grows with the wallet's own notes and transactions and the retained tree data.
* **Lifetime.** One wallet = one connection = one file. When the last reference to the wallet is
  dropped (`free()`, or wasm-bindgen's FinalizationRegistry after garbage collection) the
  connection is closed and the file is deleted from the memory VFS (`db-file-deleted-on-drop`:
  `open_wallet_databases()` goes from n+1 back to n after `free()`).
* **Lock discipline.** Every access to the database goes through ONE lock (`tokio::sync::Mutex`,
  SQLite is single-threaded here). Calls made during a sync wait for it (`calls-during-sync-complete`:
  balances, addresses, history and `db_to_bytes` issued while `sync()` runs all complete). A
  re-entrant acquisition by the same task is refused with an internal error instead of
  deadlocking (task-local lock scope; native test `nested_locking_is_refused_not_deadlocked`).

## 3. Accounts — _unchanged API_

```ts
create_account(name: string, seed_phrase: string, account_hd_index: number, birthday_height?: number | null): Promise<number>
create_account_ufvk(name: string, ufvk: string, seed_fingerprint: SeedFingerprint, account_hd_index: number, birthday_height?: number | null): Promise<number>
create_account_view_ufvk(name: string, ufvk: string, birthday_height?: number | null): Promise<number>
```

Numeric account ids are positions in creation order (0, 1, …), as with the memory backend; the
database's UUIDs never reach JavaScript. Unknown ids throw `Account with given id not found`.

## 4. Addresses (ADR-018 § 1, Stage 2 amendment)

```ts
get_current_address(account_id: number): Promise<string>       // CHANGED: the FULL unified address
get_unified_address(account_id: number): Promise<string>       // same value
get_sapling_address(account_id: number): Promise<string>       // unchanged (zs1…)
get_transparent_address(account_id: number): Promise<string>   // unchanged (t1…)
get_current_address_transparent(account_id: number): Promise<string>  // unchanged
get_addresses(account_id: number): Promise<WalletAddresses>    // fields ADDED

interface WalletAddresses {            // alias: SaplingBetaAddresses
  unified: string;                     // u1…: Orchard-family + Sapling + transparent (P2PKH) receivers — CHANGED
  unifiedShielded: string;             // NEW u1…: Orchard-family + Sapling, no transparent receiver
  unifiedSaplingTransparent: string;   // NEW u1…: Sapling + transparent, no Orchard (= Stage-1 `unified`)
  sapling: string;                     // zs1…  (unchanged)
  transparent: string;                 // t1…   (unchanged)
  diversifierIndex: string | null;     // unchanged
}
```

* All five encodings carry the **same receivers** (one diversifier index, ZIP 316). The Sapling and
  transparent receivers are exactly the Stage-1 ones (`addresses-match-stage1`: equal to the
  Stage-1 helper's addresses for the same seed), so funds sent to a Stage-1 address arrive.
* **Always the same**: the account's **default** address (ZIP 316 default diversifier,
  every receiver — what `zcash_client_sqlite` stored when the account was added), never "the most
  recently exposed" external address. A deposit to another t-address of the seed (an imported wallet
  that rotates t-addresses; a gap-limit address) exposes that address in the database but changes
  nothing here.
* Which to show (game policy): **`unified`** is the main address once Ironwood sending has
  shipped and passed review (ADR-018 § 1 amendment); until then keep showing
  `unifiedSaplingTransparent` (the Stage-1 main address) — both are received by this engine.
  **`unifiedShielded`** is what a recipient seals in a player payment: a payer never learns the
  recipient's exchange `t1`. `transparent` stays the "exchange address" (public on chain).
* An Ironwood payment arrives on the Orchard-family receiver of `unified` / `unifiedShielded`
  (a payer's wallet builds an Ironwood output for an Orchard receiver since NU6.3).

## 5. Balances

```ts
get_balances(account_id: number): Promise<WalletBalances>   // fields ADDED

interface WalletBalances {             // alias: SaplingBetaBalances
  // Stage 1 (meaning unchanged: Sapling only / transparent)
  saplingSpendableZat: number; saplingPendingChangeZat: number; saplingPendingZat: number; saplingTotalZat: number;
  transparentShieldableZat: number;    // "waiting to be shielded" — what shield() spends now
  transparentPendingZat: number; transparentTotalZat: number;
  chainTipHeight: number; fullyScannedHeight: number;
  // NEW
  ironwoodSpendableZat: number; ironwoodPendingChangeZat: number; ironwoodPendingZat: number; ironwoodTotalZat: number;
  orchardSpendableZat: number; orchardPendingChangeZat: number; orchardPendingZat: number; orchardTotalZat: number; // legacy Orchard: spendable OUT
  shieldedSpendableZat: number;        // Ironwood + Sapling + Orchard spendable: what send() can use
  shieldedPendingZat: number;          // all shielded pending (change + received)
  shieldedTotalZat: number;
  totalZat: number;                    // every pool, transparent included
}
```

* **Game note:** show `shieldedSpendableZat` as "spendable" (Stage 1 showed
  `saplingSpendableZat`, which now excludes Ironwood — where change and shielded funds go),
  `shieldedPendingZat` as pending and `transparentTotalZat` / `transparentShieldableZat` as
  "waiting to be shielded".
* Spendable needs the note's block range to be scanned (witness); a fresh restore shows funds as
  pending until the scan reaches the tip. Shielded coinbase (Ironwood) is spendable without the
  100-block maturity (ZIP 213: maturity is for transparent coinbase only).
* `get_wallet_summary()` (CHANGED): `account_balances[i][1]` = `{ sapling_balance, orchard_balance,
  ironwood_balance, unshielded_balance, pending_change, pending_spendable }` (spendable values per
  pool; `orchard_balance` is back, `ironwood_balance` new; `pending_*` cover every pool); the
  summary adds `next_ironwood_subtree_index`. The game's legacy `parseBalances` should read
  `get_balances()` instead.

## 6. Shielding (ADR-018 § 1) → Ironwood

```ts
preview_shield(account_id: number, threshold_zat?: bigint | null): Promise<WalletShieldResult>
shield(account_id: number, seed_phrase: string, account_hd_index: number, threshold_zat?: bigint | null): Promise<WalletShieldResult>

interface WalletShieldResult {         // alias: SaplingBetaShieldResult
  txid: string; utxos: number; transparentInZat: number; feeZat: number;
  shieldedZat: number;                 // arrives in ironwoodSpendable after 1 block (was Sapling)
  pool: "ironwood";                    // NEW
}
```

Spends the account's confirmed transparent UTXOs (coinbase included) into the wallet's own
**Ironwood** address: a **version-6** transaction with transparent inputs, an Ironwood bundle and
no transparent, Sapling or Orchard outputs (checked before proving and before broadcast).
**One source per call**: all regular t-addresses together, or ONE TEX ephemeral
(one-time) address alone — upstream refuses to link an ephemeral address with any other address in
one transaction (`EphemeralAddressLinkability`), and an ephemeral address is public once its TEX
withdrawal is mined, so anyone can send to it. The regular addresses go first; what remains stays in
`transparentShieldableZat` for the next `shield` (the result's `transparentInZat` is what this one
spends).
Threshold default 1 zat (unchanged). Errors: `nothing_to_shield`,
`wallet_not_synced`, `consensus_*`, `broadcast_*`. Verified: 3 coinbase UTXOs → `vin=3 vout=0
ironwood actions=4` (change split into notes), fee 35,000 (ZIP 317: 3 transparent inputs + 4 Ironwood actions); a 90,000-zat deposit with one
confirmation → `vin=1 ironwood actions=2`, fee 15,000.

## 7. Sending: the ONE general call (ADR-018 § 2, § 5, § 6)

```ts
preview_send(account_id: number, outputs: WalletOutput[]): Promise<WalletSendResult>
send(account_id: number, outputs: WalletOutput[], seed_phrase: string, account_hd_index: number): Promise<WalletSendResult>

interface WalletOutput {               // alias: SaplingBetaOutput — unchanged fields
  to: string;                          // u1… | zs1… | t1… / tex1… (withdrawals only)
  amountZat: number | bigint | string;
  memo?: string | null;                // ≤ 512 bytes; not on transparent / TEX outputs
  withdrawal?: boolean | null;         // allows t1… and tex1…
}
interface WalletSendResult {           // alias: SaplingBetaSendResult
  txids: string[];                     // explorer order; ONE, or TWO for a TEX withdrawal (broadcast order)
  feeZat: number;                      // ZIP 317 network fee (both transactions for TEX)
  amountZat: number;
  outputs: { to: string; pool: "ironwood" | "sapling" | "transparent"; amountZat: number; hasMemo: boolean;
             tex: boolean /* NEW */ }[];
}
```

### Pool policy (enforced on the proposal before proving and on the built transaction before broadcast)

| Recipient `to` | Paid as | Notes |
|---|---|---|
| UA with an Orchard-family receiver (`u1…`: full, shielded-only, **Orchard-only**, Orchard+t) | **Ironwood** output to that receiver | v6. Its Sapling / transparent receivers are not used. Stage 1 refused an Orchard-only UA — **now payable** |
| UA without one (Sapling + t, e.g. a Stage-1 player address) | Sapling output | |
| `zs1…` | Sapling output | |
| `t1…` | transparent output | **withdrawals only** (`recipient_transparent_not_allowed`), no memo |
| `tex1…` (ZIP 320) | transparent output via the upstream **ephemeral-address two-step flow** | withdrawals only, no memo: tx 1 = shielded → a one-time ("ephemeral") t-address of the wallet (+ any other outputs); tx 2 = that output → the TEX's P2PKH. Two txids |
| UA with only transparent / unknown receivers, Sprout | refused `recipient_unsupported` | a UA's transparent receiver is never paid |

* **Inputs:** Ironwood, Sapling and legacy Orchard notes (`SpendPolicy` Ironwood + Sapling +
  Orchard; upstream picks the fewest pool crossings: the output's own pool first). Never
  transparent UTXOs (only `shield` spends those; inside a TEX withdrawal, tx 2 spends tx 1's
  ephemeral output).
* **Change → Ironwood, always** (engine change strategy wrapping upstream's ZIP 317 strategy). When
  upstream would keep change in Sapling (Sapling notes → Sapling recipient) or return it to the
  withdraw-only Orchard pool, the change goes to Ironwood and the fee is recomputed for the
  resulting bundles (the builder re-checks the exact balance, so a mis-estimate can never be
  broadcast). Privacy: as with any pool crossing, the change amount then shows as the Sapling
  (or Orchard) value balance; recipients, addresses and the paid amount stay shielded.
* **Version 6, NU6.3 branch**, Ironwood bundle always present for payments (change, possibly
  zero-valued); an Orchard bundle only to spend legacy Orchard notes (value balance > 0); no
  Sprout. Anything else → `pool_policy_violation` (nothing is broadcast).
* **ONE transaction:** every non-TEX `send` is one transaction — a player payment's recipient output
  and the project fee output always go together (any mix of Ironwood / Sapling outputs; verified
  Ironwood+Ironwood and Ironwood+Sapling). **The only case that needs two is a TEX withdrawal**
  (ZIP 320 requires the TEX payment to come from a transaction whose inputs are all transparent);
  withdrawals carry no project fee (ADR-018 § 6), so a fee output never has to be split from its
  payment. If a TEX output were mixed with other outputs, those go in tx 1.
* If the wallet is more than 10 blocks behind, `send` syncs first; a wallet that never scanned →
  `wallet_not_synced`. The consensus-branch guard runs before proposing and before proving
  (unchanged; not during the broadcast).

### Fees and timing measured on the local NU6.3 chain (ZIP 317; 4 browser threads, shared 4-vCPU machine)

| Transaction (decoded from zebrad) | Shape | Fee (zat) |
|---|---|---|
| shield 3 coinbase UTXOs → Ironwood | v6, 3 transparent inputs, Ironwood 4 actions, nothing else | 35,000 |
| **player payment**: Ironwood recipient 100,000 + Ironwood fee output 75,000, **one tx** | v6, Ironwood 5 actions (2 payments + change split into notes) | 25,000 |
| player payment with a **Sapling** fee output (Stage-1 registry address) | v6, Ironwood 2 actions + Sapling 2 outputs, one tx | 20,000 |
| Ironwood → `zs1` | v6, Ironwood 2 actions (change) + Sapling 2 outputs | 20,000 |
| Sapling notes → Ironwood recipient (change → Ironwood) | v6, Sapling 1 spend + 2 outputs (padding), Ironwood 4 actions | 30,000 |
| → **Orchard-only `u1`** | v6, Ironwood 3 actions | 15,000 |
| withdrawal → `t1` | v6, 1 transparent output, Ironwood 2 actions | 15,000 |
| withdrawal → **`tex1`** (two txs, mined in the same block) | tx 1: v6, ephemeral transparent output + Ironwood 2 actions; tx 2: v6, 1 transparent input → 1 output to the TEX's P2PKH | 15,000 + 10,000 |
| name fee (one Ironwood output to an Orchard-only UA) | v6, Ironwood 2 actions | 10,000 |
| small deposit (90,000 zat, one UTXO) shielded | v6, 1 transparent input, Ironwood 2 actions | 15,000 |
| **legacy Orchard** notes → Ironwood + Sapling (chain c5, native engine) | v6, Orchard 2 actions (value balance **+6.25 ZEC**: leaves the pool), Ironwood 2 actions (payment + change), Sapling 2 outputs | 30,000 |

Every one of these was mined by zebrad 6.4.2 on the NU6.3 branch `37a5165b`. `send()` wall time in
the browser (proving included, 4 threads, on a shared build machine): shielding 38.5 s, the
player payment 42.3 s; the other sends took 26–52 s per step including mining a block and syncing
both wallets. `preview_send` / `preview_shield` return in well under a second.

Always show `preview_send(...).feeZat` (it equals the fee `send` pays).

### How the game calls it — unchanged

```ts
// Player payment (ADR-018 § 6): recipient output + project fee output in ONE transaction.
const outputs = [
  { to: recipientUnifiedShielded, amountZat, memo: playerMemo || undefined },
  { to: PAYMENT_FEE_ADDRESS, amountZat: PAYMENT_FEE_ZAT, memo: `zw-fee:v1:${nonceFromServer}` },
];
const preview = await w.preview_send(accountId, outputs);
const { txids: [txid] } = await w.send(accountId, outputs, seed, 0);
// Name fee: one output. Withdrawal: one output with withdrawal: true (t1… or tex1…; a TEX
// withdrawal returns two txids — report nothing to the server for withdrawals, as today).
```

Server note: a fee or name-fee output to a UA with an Orchard-family receiver (the registry's full or
shielded UA) is an **Ironwood** output. zw-tx-decrypt 0.2 decrypts it (`pool: "ironwood"`, value,
memo), and the game server counts incoming Ironwood notes as well as Sapling notes
(`apps/server/src/zcash/shieldedPayments.ts`, `PROJECT_NOTE_POOLS`). A registry configured as its
`zs1` (or the Stage-1 Sapling + t UA) receives **Sapling** fee outputs. Both modes are checked end to
end by `harness/run-server-checks-m3.mjs`; Appendix B has the server side.

Legacy calls (still work, Stage-2 policy): `propose_transfer(account, to, value, memo)` →
`create_proposed_transactions(proposal, seed, hd)` → `send_authorized_transactions(txids)` for ONE
non-withdrawal output (verified, `legacy-path-received-with-memo`); `pczt_create` / `pczt_shield`
→ `pczt_sign` → `pczt_prove` (now also creates the Ironwood proof) → `pczt_send`. Prefer `send` /
`shield`.

## 8. Upgrade guard — _unchanged_ (ADR-018 § 2 fail-safe, § 7)

```ts
sending_status(): Promise<WalletSendingStatus>   // alias SaplingBetaSendingStatus; never throws for network problems
expected_consensus_branch(): string              // "37a5165b"
```

Same fields and rules as Stage 1: the chain's branch (lightwalletd `GetLightdInfo`) must be a
supported branch and the one this build's rules give the tip, and no known or announced upgrade
may activate within 41 blocks. `pools` is now `["ironwood","sapling","orchard","transparent"]`
(Orchard: spend only). Verified with a forged lightwalletd answer: branch `c8e71055` →
`consensus_branch_mismatch` for `send`, `preview_send`, `shield` and `propose_transfer`, while
`sync` and `get_balances` keep working; an announced upgrade 20 blocks ahead →
`consensus_upgrade_pending`; 500 blocks ahead → allowed.

## 9. History and memos

```ts
get_transaction_history(account_id: number, limit?: number, offset?: number): Promise<TransactionHistoryResponse>
// .transactions: [{ txid, tx_type: "Received"|"Sent"|"Shielded", value, fee, block_height, confirmations,
//                   status: "Confirmed"|"Pending"|"Expired", memo, timestamp, pool }], .total_count, .has_more
```

* Same shape. Source: the database's `v_transactions` / `v_tx_outputs` views (newest first,
  unmined first).
* CHANGED meaning: `value` = the account's net balance change **including the network fee** (a
  payment of 100,000 + 75,000 fee output with a 25,000 network fee shows `-200000`); for a
  shielding (`tx_type: "Shielded"`) it is the value shielded. `fee` is now filled in when known.
  `pool` adds `"ironwood"` (and `"unknown"`). `memo` joins the received memos and the memos the
  wallet sent (as in Stage 1). `txid` in explorer order (as in Stage 1).
* Memos and statuses come from `sync()`: after the chain scan it serves the database's
  **transaction-data requests** — `Enhancement` (GetTransaction → decrypt and store: received
  memos, outgoing outputs), `GetStatus` (mined / pending / unknown for the wallet's own
  transactions) and `TransactionsInvolvingAddress` (GetTaddressTxids: spends of the wallet's
  UTXOs, also by another wallet with the same seed, and funds sent back to a TEX ephemeral
  address; randomly scheduled checks are served when due). A request for **unspent** outputs (the
  TEX ephemeral-address check) is also answered from the UTXO set (GetAddressUtxos for that one
  address): that records the output as seen unspent at the tip, which is what
  brings back the funds of a TEX pair whose second transaction was never mined once it has expired.
  At most 200 per sync; failures are retried by the next sync. This replaces Stage 1's
  `enhance_received_memos`.

## 10. Sync

```ts
sync(): Promise<void>     // unchanged signature; runs in a Web Worker
get_latest_block(): Promise<bigint>   // unchanged
detect_birthday_from_transparent_address(t: string): Promise<number | undefined>   // unchanged
```

One `sync()`: upstream `sync::run` (subtree roots of Sapling, Orchard **and Ironwood**, chain tip,
transparent UTXOs, compact blocks in batches of 5,000 (`SYNC_BATCH_SIZE`) blocks, trial decryption of all three
shielded pools, spend detection by nullifier, note commitment trees) → transaction-data requests
(§ 9) → `check_witnesses` (rescans any range whose spendable notes have no valid witness; a
second chain pass only if one was queued) → the transparent UTXO reconcile (unchanged rule). The
database lock is held for the chain scan; other calls wait.

## 11. Other exports

| Export | Status |
|---|---|
| `initThreadPool(n)`, `generate_seed_phrase()`, `UnifiedSpendingKey`, `SeedFingerprint`, `pczt_sign`, … (webzjs-keys) | unchanged |
| `expected_consensus_branch(): string` | unchanged |
| `sapling_beta_error_codes(): string[]` | unchanged name; list extended (§ 1) |
| `engine_info(): WalletEngineInfo` | **NEW** `{ backend, txVersion: "V6", expectedBranch, supportedBranches, pools, regtest, errorCodes, retiredErrorCodes }` |
| `open_wallet_databases(): string[]` | **NEW** diagnostics (§ 2) |
| `WebWallet.backend(): string` | **NEW** |
| `WebWallet.pczt_*`, `propose_transfer`, `create_proposed_transactions`, `send_authorized_transactions` | unchanged signatures, Stage-2 policy |
| `IronwoodWallet` (interim class, never shipped) | **removed** — folded into `WebWallet` |
| TypeScript: `WalletOutput`, `WalletResolvedOutput`, `WalletSendResult`, `WalletShieldResult`, `WalletBalances`, `WalletAddresses`, `WalletSendingStatus`, `WalletEngineInfo` | **NEW** names; `SaplingBeta*` kept as type aliases |

## 12. Performance and size

### Sync: 30,000 mainnet blocks, both engines in the same page (same lightwalletd, same browser)

| Run | Order | Stage 1 (memory backend) | Stage 2 (SQLite) | Stage 2 / Stage 1 | Saved wallet (Stage 1 / Stage 2) |
|---|---|---|---|---|---|
| run 1 (package before compaction and TEX-check scheduling) | Stage 1 → Stage 2 | 441.7 s | 907.5 s | **2.05×** | 10.21 MB / 10.42 MB |
| **final** (shipped package) | Stage 2 → Stage 1 | 374.3 s | 800.7 s | **2.14×** | 10.22 MB / 3.51 MB |

Target was ≤ 1.5×: **not met** (2.14× final, 2.05× run 1; a 10,000-block run gave 2.45×). Run 1 ran
while other browser tests loaded the shared 4-vCPU machine; the final run on a mostly quiet
machine (load average 1–2). The order was alternated between the runs. The final Stage 2 save is about a
third of Stage 1's (compaction).

**Why (measured):**
- Downloads take the same time in both engines; the gap is all in scanning/writing (10,000-block
  timeline: 39.6 s vs 123.6 s of scan phase).
- The Stage-1 memory backend keeps **no Ironwood note commitment tree at all** (zcash_client_memory
  `1feb38d`: "The in-memory backend does not track an Ironwood (NU6.3) note commitment tree"). Mainnet
  Ironwood already holds 10 complete subtrees (> 655,000 commitments) and gets most new commitments,
  so Stage 1 skips the most expensive part of the work. Stage 2 cannot: Ironwood notes are unspendable
  without their witnesses.
- Native stack sampling of the Stage 2 sync (15,000 blocks):
  **72 %** of the sync thread is the Ironwood tree update (shardtree `insert_tree` → `merge_checked`
  → `root_hash` → Sinsemilla), 8 % the Orchard tree, 8 % rows and nullifiers, 11 % trial decryption.
  SQLite itself barely shows.

**Tuning done:** connection pragmas (`journal_mode=MEMORY`, `synchronous=OFF`, `temp_store=MEMORY`,
64 MiB `cache_size`, `locking_mode=EXCLUSIVE`; −20–35 % against the SQLite defaults); batch size
measured natively at 1,000 / 2,000 / 5,000 / 10,000 blocks (5,000 fastest, kept; smaller batches
only shrank the uncompacted file, which compaction now handles); scan ranges stay upstream's
(`suggest_scan_ranges`, chain tip first, then history); compaction (above); TEX ephemeral-address
checks are scheduled (upstream's randomised times) instead of querying every ephemeral address at
every sync. **What would close the gap:** an upstream shardtree change: `merge_checked` recomputes
subtree root hashes at every level of a merge (O(n · depth) Sinsemilla hashes per inserted chunk);
caching node hashes there would remove most of the 72 %. That is an upstream crate change, outside
this engine; recommended as a follow-up with librustzcash.

### Size

`webzjs_wallet_bg.wasm` (wasm-opt `-O4 -O4`): **62,478,361 bytes**, Stage 1: 60,555,546 (+1.92 MB,
+3.2 %); an interim build with both backends: 62,950,202. Removing the memory backend recovered about
**0.47 MB**, not the ~2.39 MB hoped for: the memory backend was only that much of the interim
difference; the remaining +1.92 MB is the SQLite C library, `zcash_client_sqlite` (with its schema migrations) and the Ironwood
code.

## 13. Known limitations

1. **Sync ≈ 2× Stage 1** (§ 12): the Ironwood tree Stage 1 never kept. Mitigation for the game: the
   first sync after an upgrade from Stage 1 is a rescan from the birthday anyway (Stage-1 saves are
   refused); show progress.
2. **`send()` takes 25–45 s in the browser** (Orchard-family Halo 2 proofs; upstream's builder also
   builds the Halo 2 proving key for every transaction). Keep the "sending…" state; the engine's
   PCZT path (`pczt_prove`) is the place for a cached key later.
3. **The sync holds the database lock for the whole chain scan** (as Stage 1 held its write lock):
   calls made meanwhile wait and then complete (`calls-during-sync-complete`). A long first sync
   therefore delays e.g. `get_balances` until it ends; the game should show cached values.
4. **Change always goes to Ironwood**, so a payment funded from Sapling (or legacy Orchard) notes
   crosses pools and its change amount appears as that pool's value balance (as any pool crossing
   does; recipients, addresses and memos stay shielded).
5. **Legacy Orchard spends were verified with the native engine only** (same Rust code, chain c5 with
   NU6.3 at 130). The browser regtest twin activates NU6.3 at height 1, so no legacy Orchard note can
   exist on its chain.
6. **PCZT path** (`pczt_create` / `pczt_shield` / `pczt_prove` / `pczt_send`): compiled and kept (now
   also proves Ironwood) but not exercised live by the harness. Prefer `send` / `shield`.
7. Memos, sent-transaction statuses and transparent history are fetched by `sync()` right after its
   chain scan, at most 200 requests per call (the rest on the following syncs); a failed request is
   retried by the next sync and never fails the sync itself.
8. The regtest twin and the `ZW_REGTEST_NU6_3_HEIGHT` switch are TESTING ONLY.

## Appendix A. Every export with its TypeScript signature

Generated from the shipped package's `webzjs_wallet.d.ts` (doc comments removed; the wasm-bindgen
`init` / `InitInput` boilerplate omitted). Against the Stage-1 package the surface only adds exports,
and renames the `SaplingBeta*` interfaces to `Wallet*` with the old names kept as type aliases. Result shapes of the methods returning `any`
(`get_wallet_summary`'s `account_balances`, `pczt_describe`) are described in §§ 5 and 7.

```ts
/* tslint:disable */
/* eslint-disable */
export function expected_consensus_branch(): string;
export function sapling_beta_error_codes(): string[];
export function engine_info(): WalletEngineInfo;
export function open_wallet_databases(): string[];
export function start(): void;
export function initThreadPool(num_threads: number): Promise<any>;
export function wbg_rayon_start_worker(receiver: number): void;
export function generate_seed_phrase(): string;
export function pczt_describe(network: string, pczt: Pczt, ufvk: UnifiedFullViewingKey): any;
export function pczt_validate(network: string, pczt: Pczt, ufvk: UnifiedFullViewingKey): void;
export function pczt_sign(network: string, pczt: Pczt, usk: UnifiedSpendingKey, seed_fp: SeedFingerprint): Promise<Pczt>;
export function wasm_thread_entry_point(ptr: number): void;
export enum TransactionStatusType {
  Confirmed = 0,
  Pending = 1,
  Expired = 2,
}
export enum TransactionType {
  Received = 0,
  Sent = 1,
  Shielded = 2,
}
type ReadableStreamType = "bytes";
export interface WalletOutput {
  to: string;
  amountZat: number | bigint | string;
  memo?: string | null;
  withdrawal?: boolean | null;
}
export interface WalletResolvedOutput {
  to: string;
  pool: "ironwood" | "sapling" | "transparent";
  amountZat: number;
  hasMemo: boolean;
  tex: boolean;
}
export interface WalletSendResult {
  txids: string[];
  feeZat: number;
  amountZat: number;
  outputs: WalletResolvedOutput[];
}
export interface WalletShieldResult {
  txid: string;
  utxos: number;
  transparentInZat: number;
  feeZat: number;
  shieldedZat: number;
  pool: "ironwood";
}
export interface WalletBalances {
  saplingSpendableZat: number;
  saplingPendingChangeZat: number;
  saplingPendingZat: number;
  saplingTotalZat: number;
  transparentShieldableZat: number;
  transparentPendingZat: number;
  transparentTotalZat: number;
  chainTipHeight: number;
  fullyScannedHeight: number;
  ironwoodSpendableZat: number;
  ironwoodPendingChangeZat: number;
  ironwoodPendingZat: number;
  ironwoodTotalZat: number;
  orchardSpendableZat: number;
  orchardPendingChangeZat: number;
  orchardPendingZat: number;
  orchardTotalZat: number;
  shieldedSpendableZat: number;
  shieldedPendingZat: number;
  shieldedTotalZat: number;
  totalZat: number;
}
export interface WalletAddresses {
  unified: string;
  unifiedShielded: string;
  unifiedSaplingTransparent: string;
  sapling: string;
  transparent: string;
  diversifierIndex: string | null;
}
export interface WalletSendingStatus {
  allowed: boolean;
  expectedBranch: string;
  chainBranch: string | null;
  chainName: string | null;
  chainTip: number | null;
  nextBlockBranch: string | null;
  pendingUpgrade: { name: string; height: number } | null;
  pools: string[];
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
  serialize(): Uint8Array;
  static from_bytes(bytes: Uint8Array): Pczt;
}
export class ProofGenerationKey {
  private constructor();
  free(): void;
}
export class Proposal {
  private constructor();
  free(): void;
}
export class SeedFingerprint {
  free(): void;
  constructor(seed: Uint8Array);
  to_bytes(): Uint8Array;
  static from_bytes(bytes: Uint8Array): SeedFingerprint;
}
export class TransactionHistoryEntry {
  private constructor();
  toJSON(): Object;
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
export class TransactionHistoryResponse {
  private constructor();
  toJSON(): Object;
  toString(): string;
  free(): void;
  readonly transactions: any;
  readonly total_count: number;
  readonly has_more: boolean;
}
export class UnifiedFullViewingKey {
  free(): void;
  encode(network: string): string;
  constructor(network: string, encoding: string);
  get_transparent_address(network: string): string | undefined;
}
export class UnifiedSpendingKey {
  free(): void;
  constructor(network: string, seed: Uint8Array, hd_index: number);
  to_unified_full_viewing_key(): UnifiedFullViewingKey;
  to_sapling_proof_generation_key(): ProofGenerationKey;
}
export class WalletSummary {
  private constructor();
  toJSON(): Object;
  toString(): string;
  free(): void;
  chain_tip_height: number;
  fully_scanned_height: number;
  next_sapling_subtree_index: bigint;
  next_orchard_subtree_index: bigint;
  next_ironwood_subtree_index: bigint;
  readonly account_balances: any;
}
export class WebWallet {
  free(): void;
  constructor(network: string, lightwalletd_url: string, min_confirmations_trusted: number, min_confirmations_untrusted: number, db_bytes?: Uint8Array | null);
  static backend(): string;
  create_account(account_name: string, seed_phrase: string, account_hd_index: number, birthday_height?: number | null): Promise<number>;
  create_account_ufvk(account_name: string, encoded_ufvk: string, seed_fingerprint: SeedFingerprint, account_hd_index: number, birthday_height?: number | null): Promise<number>;
  create_account_view_ufvk(account_name: string, encoded_ufvk: string, birthday_height?: number | null): Promise<number>;
  sync(): Promise<void>;
  get_wallet_summary(): Promise<WalletSummary | undefined>;
  propose_transfer(account_id: number, to_address: string, value: bigint, memo?: string | null): Promise<Proposal>;
  create_proposed_transactions(proposal: Proposal, seed_phrase: string, account_hd_index: number): Promise<Uint8Array>;
  db_to_bytes(): Promise<Uint8Array>;
  send_authorized_transactions(txids: Uint8Array): Promise<void>;
  get_current_address(account_id: number): Promise<string>;
  get_unified_address(account_id: number): Promise<string>;
  get_sapling_address(account_id: number): Promise<string>;
  get_transparent_address(account_id: number): Promise<string>;
  get_addresses(account_id: number): Promise<WalletAddresses>;
  get_balances(account_id: number): Promise<WalletBalances>;
  sending_status(): Promise<WalletSendingStatus>;
  send(account_id: number, outputs: WalletOutput[], seed_phrase: string, account_hd_index: number): Promise<WalletSendResult>;
  preview_send(account_id: number, outputs: WalletOutput[]): Promise<WalletSendResult>;
  shield(account_id: number, seed_phrase: string, account_hd_index: number, threshold_zat?: bigint | null): Promise<WalletShieldResult>;
  preview_shield(account_id: number, threshold_zat?: bigint | null): Promise<WalletShieldResult>;
  pczt_shield(account_id: number): Promise<Pczt>;
  pczt_create(account_id: number, to_address: string, value: bigint): Promise<Pczt>;
  pczt_prove(pczt: Pczt, sapling_proof_gen_key?: ProofGenerationKey | null): Promise<Pczt>;
  pczt_send(pczt: Pczt): Promise<void>;
  pczt_combine(pczts: Pczt[]): Pczt;
  get_current_address_transparent(account_id: number): Promise<string>;
  get_transaction_history(account_id: number, limit?: number | null, offset?: number | null): Promise<TransactionHistoryResponse>;
  get_latest_block(): Promise<bigint>;
  detect_birthday_from_transparent_address(transparent_address: string): Promise<number | undefined>;
}
export class wbg_rayon_PoolBuilder {
  private constructor();
  free(): void;
  numThreads(): number;
  receiver(): number;
  build(): void;
}
```

## Appendix B. Server helper zw-tx-decrypt 0.2

Package `zw-tx-decrypt/` (Node.js, CommonJS, synchronous, no network, no logging; vendored as
`vendor/zcash-tx-decrypt/`); source in `zw-tx-decrypt/`, built by `build-engine.sh helper` with the
engine's own `Cargo.lock` (librustzcash `0a2c6d1a…`, orchard `3bd2b736…`). wasm sha256
`4ff4b6c095c7e6397ae3a3c48ea5d22615f623f5046e14a765806647b9590804`.

```ts
export type ZwNetwork = "main" | "test" | "regtest";
decryptTransaction(rawTxHex: string, height: number, network: ZwNetwork, ufvk: string): ZwDecryptedOutput[];
registryKeysFromSeed(seedPhrase: string, network: ZwNetwork, account: number): ZwRegistryKeys;   // CHANGED fields
addressesFromUfvk(ufvk: string, network: ZwNetwork): ZwKeyAddresses;                            // CHANGED fields
describeAddress(address: string): ZwAddressInfo;      // unchanged
inspectTransaction(rawTxHex: string, height: number, network: ZwNetwork): ZwTxShape;           // unchanged
buildInfo(): string;                                  // "zw-tx-decrypt 0.2.0 (Stage 2 wallet engine); librustzcash …; orchard …; NU6.3 branch 37a5165b"

interface ZwDecryptedOutput {          // unchanged shape
  pool: "sapling" | "orchard" | "ironwood"; outputIndex: number; valueZat: number;
  memoText: string | null; memoHex: string; incoming: boolean; transferType: "incoming" | "internal" | "outgoing";
}
interface ZwKeyAddresses {             // = the engine's get_addresses() for the same account
  unifiedAddress: string;                   // CHANGED: FULL UA, Orchard-family + Sapling + p2pkh (engine `unified`)
  unifiedShieldedAddress: string;           // NEW: Orchard-family + Sapling (engine `unifiedShielded`)
  unifiedSaplingTransparentAddress: string; // NEW: Sapling + p2pkh = the 0.1 `unifiedAddress` (engine `unifiedSaplingTransparent`)
  saplingAddress: string;                   // zs1…
  transparentAddress: string | null;        // t1…
  diversifierIndex: string;
}
interface ZwRegistryKeys extends ZwKeyAddresses { ufvk: string; }
```

Verified: 15 Node tests on real regtest transactions (Stage-2 version-6 Ironwood fee / name-fee outputs, a
Sapling fee output, Orchard-only u1, zs1, Sapling → Ironwood, shielding, t1 and TEX withdrawals, and the
Stage-1 version-5 fixtures) + 2 native tests; in the regtest matrix every produced transaction is checked
with it (15 helper checks), and the engine's five address encodings equal its output for every test
key.

**Game server side** (`apps/server/src/zcash/`):

1. `shieldedPayments.ts` counts incoming `pool === "ironwood"` notes as well as `"sapling"`
   (`PROJECT_NOTE_POOLS`), so the name fee and the transfer fee are accepted from Ironwood fee outputs.
2. `txDecrypt.ts` `checkAddressAgainstKey()`: with 0.2, `own.unifiedAddress` is the FULL UA. The
   server accepts every one of the key's addresses (`unifiedAddress`, `unifiedShieldedAddress`,
   `unifiedSaplingTransparentAddress`, `saplingAddress`) and requires a Sapling **or** Orchard
   receiver. `scripts/tools/registry-keys.mjs` prints `unifiedAddress` (the full UA) as the address
   to configure.
3. The helper, the two server rules and the configured address belong together: with the 0.1 helper
   (whose `unifiedAddress` was the Sapling + t UA) a server configured with the full UA refuses to
   start, and a server that counted Sapling notes only would never confirm an Ironwood fee output.
