# ADR-018: Mainnet in-game wallet on our own infrastructure (Sapling beta, then Ironwood) and the mainnet name fee

## Status

Accepted (2026-10-08). Amended 2026-10-08 (§ 1 deposits and shielding, § 6 transfer fee, § 7 network upgrades) and
2026-10-09 (§ 3 Stage 2 and the § 1 Stage 2 amendment). This ADR amends ADR-016, which excluded mainnet, and ADR-013.

Product requirements:
- **Own infrastructure, no leaving the game.** Players never have to leave the game to send money. The wallet runs on
  the project's own infrastructure rather than an external wallet extension.
- **How it works.** A player creates a wallet in the game, sends money to it from an exchange or another wallet,
  shields it there, and pays other players from inside the game.
- **Name fee.** Players pay the project a very small fee, about US$1, to confirm a name.
- **Transfer fee.** Player-to-player payments carry a project fee of about US$1.
- **Beta cap.** 0.01 ZEC per transaction, removable later.
- **Network upgrades.** Moving to a new network upgrade (NU7 first) is automatic for players.

## Context

The wallet has to work on mainnet with real ZEC: create and import a wallet inside the game, send ZEC to other
players, confirm names.

Verified facts (research of 2026-10-07/08):

**Network upgrades**
- NU6.3 ("Ironwood") is active on mainnet since height 3,428,143 (2026-07-28), consensus branch `0x37A5165B`.
- The Orchard pool is withdraw-only: no new value may enter it. New shielded value to Orchard-style `u1` receivers goes into the new Ironwood pool, which needs version-6 transactions.
- **The Sapling pool is unchanged.** ZIP 229 states that "version 4, version 5, and version 6 transactions are all valid from NU6.3 activation onward". ZIP 213 still allows Sapling coinbase outputs.
- NU7 needs a wallet rebuild.

**Wallet engine**
- ChainSafe WebZjs, which our vendored engine comes from, only knows NU6.1. It can no longer make valid mainnet transactions.
- The Zcash Community Grants fork (`bdbc6f2`, red.dev's NU6.3 port) builds here and synced mainnet: 2,001 blocks in 8.3 s.
- Its in-memory wallet database (`zcash_client_memory`) does **not** track Ironwood:
  - Ironwood receipts are invisible;
  - a send to an Orchard-style `u1` receiver creates an Ironwood output and panics.
- Porting Ironwood into that backend is estimated at 3–5 engineer-weeks plus a security review.

**Server and services**
- zcashd stopped following mainnet (around height 3,417,100), so ADR-016's zcashd scanner cannot work on mainnet.
- The public lightwalletd endpoints `zec.rocks:443` (and its regional mirrors) are reachable and Ironwood-aware. The game server's wallet bridge (`apps/server/src/zcash/lwdProxy.ts`) already keeps players' IPs away from the lightwalletd operator.

**Rejected interim options**
- External wallets: the Noir browser extension, and QR codes or links for mobile wallets. QR codes and links mean leaving the game, which the requirements rule out, and an extension depends on a third party; the project's own engine replaces both.

## Decision

### 1. One wallet, our own: the in-game WebZjs wallet on mainnet

- **Create and import stay in the game.**
  - **Create:** a new 24-word seed, a mandatory backup step (real money), and a birthday at the current tip.
  - **Import:** a seed phrase plus an approximate start date, which the game converts to a birthday height so the scan is not years long.
  - The seed stays encrypted on the device as today.
- **No external wallet** and no game exit is needed to pay a player or confirm a name.
- **Adding funds.** The only step outside the game is sending ZEC in, from an exchange or another wallet. For that, the player sees **their own** addresses, in their own wallet panel only:
  - **The wallet's main address:** a unified address with a Sapling receiver and a transparent receiver, and **no Orchard receiver**. A sending wallet therefore never routes the payment into the Ironwood pool, which the Stage 1 wallet cannot see.
  - **An exchange address:** the plain transparent `t1…` address, for exchanges that only withdraw to transparent addresses. The game says that a transparent deposit is public on chain.
- **Shielding.** Transparent funds show as "waiting to be shielded", with a **Shield** button that moves them into the wallet's own Sapling balance.
  - The player pays only the network fee: no project fee, and no cap (the funds stay in the player's own wallet).
  - Only shielded funds can pay players, so every in-game payment stays shielded.
- **Withdrawing.** A player can send to their own external wallet: a Sapling address or a unified address with a Sapling receiver, or a transparent address (with a warning that the amount becomes public). The beta cap applies; the transfer fee does not, because it is not a payment between players.

### 2. Stage 1 now: "Sapling beta" mode (mainnet, limited)

> **Superseded on 2026-10-09 by Stage 2** (§ 3 — see **As built (Stage 2)** below). This section
> stays as the record of what Stage 1 was; its restrictions (Sapling-only receive, send and change; refused Orchard-only
> recipients; the hidden-pools import note) no longer apply.

The mainnet build is the Zcash Community Grants fork at the NU6.3 consensus rules. It is patched so the in-game wallet uses **only the Sapling pool**:

- **Receive.** The addresses of § 1: Sapling + transparent receivers only, never Orchard.
- **Send.** Payments are built only from Sapling notes. Change also goes to Sapling. These are version-5 transactions, which stay valid under NU6.3.
  - Player payments go to a Sapling receiver.
  - Withdrawals may also go to a transparent address.
  - Shielding spends transparent funds into the wallet's own Sapling address.
- **Refused recipients.** A recipient without a Sapling receiver (an Orchard-only or Ironwood-only `u1`) is refused with a clear message, never a crash. So is a transparent recipient outside a withdrawal.
- **Balance.** The game shows Sapling and transparent funds only. The import screen says that funds the same seed holds in Orchard or Ironwood are not visible in the beta. Those are most balances in Zashi-style wallets; whether a Zingo, Zodl or Noir balance is visible depends on the pool it sits in.
- **Fail-safe for upgrades.**
  - The wallet compares the chain's consensus branch, as reported by lightwalletd, with the branch it was built for.
  - On any mismatch (for example after NU7 activates), sending is disabled until a new build ships.
  - Viewing the balance still works.

### 3. Stage 2 next: full Ironwood support

- The memory backend gains Ironwood tracking:
  - port Ironwood note tracking into it; **or**
  - if a spike shows it is cheaper and sound, run the upstream SQLite wallet database in WebAssembly.
- This work is tested first on a local chain with NU6.3 active, then on the public testnet, then reviewed.
- Then the Sapling-only restriction is lifted: imported seeds show all funds, and payments to any `u1` address work.
- A further rebuild is needed for NU7.
- **Accepted on 2026-10-09.** The path is the one chosen by a Stage 2 spike: the upstream SQLite wallet database (zcash_client_sqlite) in WebAssembly through sqlite-wasm-rs.
- **§ 1 amendment for Stage 2, accepted the same day.** Once Ironwood sending ships and passes review, the main address becomes a full unified address with an Orchard-family receiver (where Ironwood payments arrive) plus the Sapling and transparent receivers. Imported seeds then show every pool, and payments to any `u1` work. Until then, § 1's Sapling + transparent address stays.
- Stage 2 also covers TEX (ZIP 320) withdrawals for exchanges that require them.

### 4. Beta safety limits (mainnet only)

- **Per-transaction cap.**
  - At most **0.01 ZEC** per transaction sent from the game: player payments (the amount the recipient gets; the transfer fee comes on top), withdrawals and the name fee. Shielding one's own funds is exempt.
  - It is a single configuration value and can be removed later.
  - The server cannot read the amount: it is sealed between the two players (ADR-013). So it checks the cap that the sender's wallet declares with each payment request, and refuses a request that declares no cap or a cap above `PAYMENT_CAP_ZEC`. The amount itself is enforced in the game's wallet adapter, which means a modified client could bypass the cap.
- **Consent.** First use on mainnet needs a consent step: "experimental, unaudited software, real money; use a fresh wallet with a small amount". Every send shows the network fee.
- **No faucet** on mainnet: the server refuses it and the UI hides it.

### 5. Mainnet name fee (amends ADR-016)

- **Fee.** On mainnet the ADR-016 flow is unchanged (reserve → quote → shielded payment with memo → server verifies → owned name), with a fee of about **US$1** paid to the project's registry.
  - The fee is set in ZEC by the operator (`NAME_FEE_ZEC`) and must be re-checked when the price moves. The default is 0.00075 ZEC: ZEC traded at about US$1,310–1,335 on 2026-10-05/07.
  - There is no price feed: no new third party learns about the game's users. Fees are fixed ZEC amounts set by the operator, not a live price. `NAME_FEE_USD` and `PAYMENT_FEE_USD` are optional labels; the game shows "≈ US$…" only when they are set.
- **Registry address.** It has a Sapling receiver, so Stage-1 wallets can pay it.
- **Verification without zcashd.**
  1. The paying client hands the server the transaction id.
  2. The server fetches that transaction through its own lightwalletd connection and trial-decrypts it with the registry's private viewing key. The decryption uses a small WebAssembly helper built from the same pinned librustzcash as the wallet.
  3. It accepts the payment when the amount ≥ fee and the memo matches.
  - Each note is accepted once.
  - On mainnet at least one confirmation is required (configurable).
  - If that helper had proved infeasible, a light-client sidecar (zingolib 6.x) was the fallback. The helper was built (`vendor/zcash-tx-decrypt`).
- **Operator acknowledgement.** Mainnet registration is off unless the operator configures the registry and sets an explicit acknowledgement (`NAME_REGISTRY_MAINNET_ACK`), so that charging a real-money fee is always a deliberate act.
- **Unchanged from ADR-016:** the privacy rules, and no refunds (a refund would need the payer's address).

### 6. Transfer fee between players (mainnet; amends ADR-013)

- **What is charged.** Every player-to-player payment carries a project fee of about **US$1** (`PAYMENT_FEE_ZEC`, default 0.00075 ZEC; re-check with the price).
  - The recipient receives the full amount the sender typed.
  - The confirmation card shows three lines: the amount, the project fee and the network fee.
- **One transaction.**
  - The fee is a second shielded Sapling output in the **same** transaction, to the project's fee address (by default the registry address of § 5).
  - Its memo is `zw-fee:v1:<nonce>`; the server issues the nonce for that payment request.
  - On chain it looks like any other shielded transaction with two outputs.
- **Verification.**
  1. After broadcasting, the sender's client reports the transaction id for that payment request.
  2. The server fetches the transaction and decrypts **only the fee output** with the project's viewing key (the § 5 helper). The recipient's output stays unreadable to it.
  3. It checks the amount ≥ fee and the nonce. Each note is accepted once.
  - The txid is used for that check and then discarded: it is never stored, logged or shown.
  - A client that skips or underpays the fee has its further payment requests refused for the rest of the session.
- **Exempt:** shielding and withdrawals to one's own wallet. On the test chains the fee is off unless configured.
- **Known gap, accepted for the beta.** A non-custodial wallet cannot prove that a withdrawal address is the player's own. Two players who exchange addresses in chat could therefore pay each other through Withdraw without the fee.
  - The game refuses to withdraw to an address that another player sealed for it in the same session, and to the wallet's own address.
  - Withdrawals stay fee-free during the beta; this is to be revisited before a public release.
- **Operator acknowledgement.** Enabling the fee on mainnet needs the fee address, the viewing key and `PAYMENT_FEE_MAINNET_ACK=accepted`. Without them, payments work without a fee.

### 7. Network upgrades (NU7 and later)

- **Automatic for players.** The game is a web page, so a rebuilt wallet engine reaches players on their next page load. Nothing is installed, and the encrypted wallet stays on the device.
  - The server announces its build id.
  - A client running an older build shows "Update ready — reload" and reloads safely between actions (never during a send).
- **A one-command rebuild.** The engine's build is reproducible: pinned sources, patch files and a build script (`scripts/wallet-engine/`). Moving to NU7 means bumping the pinned upstream revisions once librustzcash and the wallet fork support NU7, running the script, testing on the public testnet (NU7 has been active there since block 4,465,026, 2026-10-04) and deploying before the mainnet activation height.
  - NU7 also shortens the block target to 25 seconds; the import date estimator accounts for that.
- **Safety net.** If the chain upgrades before the new build is live, the branch check of § 2 pauses sending and keeps balances visible.

## Consequences

**Real money, beta quality**
- The engine is a community fork with our small patches and has had **no independent audit**.
- The browser holds the seed, so a cross-site-scripting bug could empty a wallet. The cap limits each payment, not a theft.
- Hence the consent step, the "use a fresh wallet with a small amount" advice, a strict Content-Security-Policy for the whole page, and a beta limited to small amounts until an independent review.

**Limits of Stage 1**
- An imported main-wallet seed may show a zero balance in the game when its funds sit in Orchard or Ironwood. The intended flow is a **fresh game wallet** topped up from an exchange or another wallet (Zashi, Zingo, Zodl, Noir, …), all of which can pay a Sapling or transparent receiver.
- Sapling payments between players are fully shielded.
- Crossing pools makes the amount public on chain, though not who paid whom; the game says so. This happens when a payment comes in from Orchard or Ironwood funds, or from a transparent (exchange) deposit. (Stage 2: the crossing also happens the other way — a Sapling output paid from Ironwood funds — and the withdraw Review and the payment confirmation say so; see As built.)

**Network and privacy**
- **Network.** Wallet sync and broadcast go through the game server's bridge to a public lightwalletd (`zec.rocks` by default; configurable). The operator sees the game server's IP, never a player's.
- **What the server learns from the name fee.** A transaction id and that a fee with that memo arrived. It does not learn the sender's address: the sender is a shielded Sapling spend.
- **What the server learns from the transfer fee.**
  - It already relays the payment request (ADR-013), so it knows that the two players started a payment.
  - From the fee it also learns that the payment was broadcast, and its transaction id for the moment of the check.
  - It cannot read the amount sent to the recipient or either address.
  - This is a new, server-only link between two nicknames and a shielded transaction id. It is never stored or shown, and the threat models record it.
- **Records.** The record stores no txid, address or amount (as in ADR-016).
- **Threat models.** `docs/privacy/IDENTITY_THREAT_MODEL.md` and `docs/privacy/PLAYER_PAYMENTS_THREAT_MODEL.md` record these points.

**Maintenance**
- Two wallet builds ship side by side: the existing test-chain build and the mainnet build. A deploy chooses one network.
- Every network upgrade (NU7 first) needs a rebuild before its activation height (§ 7). Players receive it automatically on reload; the branch check turns sending off if the rebuild is late.
- The project's fee address collects real ZEC. Its seed is kept offline by the operator; the server holds only the viewing key.

**Stage 1 scope**
- Stage 1 was built and verified on a local chain with NU6.3 rules, then tested against mainnet sync. It covers:
  - the Sapling beta build;
  - deposits and shielding;
  - mainnet plumbing;
  - the name and transfer fees with their verification;
  - consent, the cap and the update prompt.
- Stage 2 (Ironwood) followed (§ 3).

## As built (Stage 2, 2026-10-09)

Implementation notes for § 3 and the § 1 Stage 2 amendment (both accepted on 2026-10-09). None changes what the
decision above says players get, what is charged or what anyone learns beyond what is listed here.

**Engine.** The Stage-2 engine is the Zcash Community Grants WebZjs fork (`bdbc6f2`) with five small patches, upstream
`zcash_client_sqlite` (librustzcash `0a2c6d1a`) in WebAssembly through a 30-line `libsqlite3-sys` shim over
sqlite-wasm-rs 0.4.3 — SQLite 3.50.4 compiled from the official amalgamation with a pinned emscripten (byte-identical
to the crate's prebuilt library, which is no longer linked). Version-6 transactions on NU6.3 (`37a5165b`). The wasm
(62,478,361 bytes, sha256 `772d2606…`) rebuilds byte for byte in two independent directories. The memory backend
(`zcash_client_memory`) is gone. The engine's build scripts and patches are in `scripts/wallet-engine/`.

**§ 1 as amended — addresses.**
- *Add funds* shows the **full unified address** (Orchard-family + Sapling + transparent receivers): any wallet pays it,
  and a shielded payment arrives shielded (Ironwood or Sapling). The exchange `t1…` and the Sapling-only `zs1…` are
  shown below it. The Stage-1 address (Sapling + transparent) is still received: the receivers are the same.
- A player payment is sealed to the recipient's **shielded-only unified address** (Orchard-family + Sapling, **no
  transparent receiver**), so a payer never learns the recipient's exchange `t1…`.

**§ 3 as built — pools.**
- Spends Ironwood, Sapling and legacy Orchard notes (Orchard is withdraw-only since NU6.3). A unified address with an
  Orchard-family receiver is paid as **Ironwood** (an Orchard-only `u1…` is payable now); a `zs1…` or a Sapling +
  transparent `u1…` as Sapling; a unified address's transparent receiver is never paid.
- **Change always goes to Ironwood**, and shielding moves transparent funds into Ironwood. A payment funded from Sapling
  or legacy Orchard notes therefore crosses pools: its moved amount is public on chain (not who paid whom, not the
  recipient's amount) — `docs/privacy/ZCASH_WALLET_THREAT_MODEL.md` § Mainnet.
- **The other direction:** a SAPLING output — a withdrawal to a `zs1…` or a Sapling +
  transparent `u1…`, a payment to a stale Stage-1 page's `zs1…`, a fee to a registry/fee address without an
  Orchard-family receiver — is funded from Ironwood when the wallet's Sapling notes do not cover it (the usual case),
  and its **amount becomes public** (the Sapling value balance; exactly the fee for a fee output). The withdraw Review
  and the payment confirmation say so; the registry and fee addresses must be the full unified address (the server
  warns at startup on mainnet otherwise).
- A player payment's recipient output and the project's fee output are always ONE transaction (§ 6 unchanged).
- **Balance:** "Shielded" = Ironwood + Sapling + legacy Orchard spendable; "Waiting to be shielded" = transparent.
- **Withdrawals** go to any `u1…`, `zs1…`, `t1…` or **TEX** (`tex1…`, ZIP 320) address. TEX is two transactions
  (shielded → a one-time transparent address of the wallet → the exchange); the game validates the TEX address
  (bech32m checksum) and says that the amount and the address become public, as for `t1…`. The cap applies, the
  transfer fee does not (§ 6, unchanged). If the second transaction is refused after the first left, the game says
  where the ZEC is; once the second expires the engine finds it again (an unspent-outputs check of the one-time
  address) and Shield brings it back. Shielding takes one source at a time: the regular t-addresses, or one one-time
  address (upstream refuses to link them).
- **Imported seeds** (Zashi, Zodl, Zingo, …) show their funds in every shielded pool. Transparent funds are found on the
  seed's standard transparent addresses (upstream's gap limit: 10 unused receiving, 5 change addresses).

**Stage-1 saves.** The Stage-2 engine cannot open a Stage-1 (memory-backend) save. On unlock the game restores the wallet
from the encrypted seed it has just decrypted and the wallet's birthday — stored since Stage 2, else read from the
old save on the device, else asked as a month and year — and rescans with a progress line. The seed is never asked for
again; the old save stays until the rescanned wallet replaces it; sending waits for the rescan; the update prompt does
not reload meanwhile.

**Server.** The fee and name checks count **Ironwood** as well as Sapling fee outputs (zw-tx-decrypt 0.2, built from the
engine's lockfile). `scripts/tools/registry-keys.mjs` prints the registry's **full unified address** as
`NAME_REGISTRY_ADDRESS` (it has a Sapling receiver, so a client that has not reloaded since Stage 1 still pays it —
as Sapling); the start-up check accepts any of the viewing key's shielded addresses (full, shielded, Stage-1, `zs1`)
and nothing else. A deployment that keeps its Stage-1 registry address keeps *working* (Stage-2 wallets pay its Sapling
receiver), but every fee then crosses from Ironwood into Sapling and is public on chain as an exact Sapling value
balance, so switching to the full unified address is a **required** upgrade step; on mainnet the server logs a
warning while it is not done. The operator acknowledgements are unchanged. The transfer-fee expiry wait stays
41 blocks (the Stage-2 builder's expiry delta is still 40), and `NU7_ACTIVATION_HEIGHT` still switches it to 121.

**Known limits:** the Stage-2 sync takes ≈ 2.1× the Stage-1 time on mainnet (the Ironwood
commitment tree Stage 1 never kept; target ≤ 1.5× not met), so a Stage-1 player's first unlock is a longer rescan;
`send` takes 25–45 s; the legacy-Orchard spend was verified with the native engine only; nothing has been tested with
real funds yet; the engine is still unaudited.

**Still open.** § 7's NU7 rebuild, after the network upgrade: one more engine patch that adds the NU7 branch to the
supported consensus branches and raises the expiry delta to 120. An independent audit before any public release.
