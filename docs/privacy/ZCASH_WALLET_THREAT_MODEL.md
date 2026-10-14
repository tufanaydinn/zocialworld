
# Zcash Wallet Threat Model

**Status**: questions 1–18 cover the test-chain wallet; § Mainnet covers mainnet builds with the Stage-2 wallet  
**Date**: October 2026  
**Scope**: The in-browser Zcash wallet of Zocial World — keys and storage on the device, the wallet bridge, lightwalletd and project support payments. Player-to-player payments and owned names build on this wallet and have their own threat models (`PLAYER_PAYMENTS_THREAT_MODEL.md`, `IDENTITY_THREAT_MODEL.md`).

> **Mainnet builds.** Questions 1–18 below describe the test-chain wallet. A mainnet build
> (`VITE_ZCASH_NETWORK=main`, ADR-018) differs in the pools (with the Stage-2 wallet Ironwood, Sapling,
> legacy Orchard and transparent: § 2), the network (§ 5 no longer applies — mainnet is a supported configuration behind a
> consent step), the page CSP (§ 7), what the wallet bridge learns (§ 9) and the residual risks
> (§§ 7, 15: the coins are real). **§ Mainnet** at the end of this document is the review for those
> builds and wins wherever it differs from the questions.

## Executive Summary

This document analyzes the privacy and security properties of the in-game Zcash wallet. Questions 1–18 follow its first use, shielded ZEC support payments to project creators; the same properties carry over to the later uses. The design preserves:

1. **Donor privacy**: Support transactions use shielded Zcash (Orchard pool), no persistent linking of identity to payment
2. **Project creator privacy**: Recipient addresses are listed in public configuration, no surprise reveals
3. **Game world separation**: Wallet operations are isolated from multiplayer/social systems
4. **Fail-closed design**: No unknown network configs, no fallback to unsafe client wallets

---

## Threat Model: 18 Questions Answered

### 1. Can the game server observe who supported a project?

**Question**: If a player supports a project in-game, does the game server learn which player sent the payment?

**Answer**: No. The wallet runs entirely in the player's browser. The game server never learns:
- Which player created a wallet
- Which seed phrase they imported
- Their Zcash address
- Their balance
- The fact that they sent a payment

**Why**: The wallet code (`apps/web/src/zcash/`) runs client-side. The game server only knows:
- That a player clicked a "Support" button (UI event)
- What the *intent* was (which project, how much they said they'd send)

The actual Zcash transaction is signed in the player's browser and broadcast directly to the Zcash network (via grpc-web lightwalletd proxy), never through the game server.

**Risk level**: ✅ MITIGATED

---

### 2. Can the Zcash network observe the player's identity?

**Question**: When a shielded ZEC payment arrives at the project's address, can Zcash network observers determine who sent it?

**Answer**: No. Shielded transactions (Orchard pool) are cryptographically private.

**Why**: 
- The sender's address is not visible in the blockchain
- The recipient sees the transaction in their wallet, but cannot determine who sent it without additional metadata
- The amount is encrypted
- The memo (support metadata) is encrypted

**Risk level**: ✅ MITIGATED (by Zcash protocol)

---

### 3. Does the support memo leak identity?

**Question**: The support payment includes a memo (ZIP-302). Does this memo contain personally identifiable information?

**Answer**: No. The memo is empty: a support payment carries no application metadata on-chain — no protocol marker, project ID, amount or timestamp.

It therefore does NOT contain:
- Player nickname
- Player ID
- Account ID
- Game location
- Social relationships
- Voice channel membership

**Why**: The `SupportFlow.buildSupportMemo()` function (`apps/web/src/zcash/SupportFlow.ts`) returns an empty string: the chosen project exists only in application state, and shielded transactions already hide the amount and the recipient. The separation is enforced in the TypeScript type system: `ProjectSupportTarget` contains only `projectId`, `recipientAddress`, `network`, and `label`.

**Risk level**: ✅ MITIGATED

---

### 4. Can the game crash if the wallet fails?

**Question**: If wallet operations fail (e.g., network error, WASM load failure), can it crash the game world or disconnect the player?

**Answer**: No. Wallet errors are isolated from core game systems.

**Why**:
- Wallet state is independent of game loop, physics, multiplayer, voice
- Wallet state changes via `subscribeToWalletState()` (ZcashWalletAdapter.ts:50-52)
- Error states are handled in the adapter and propagated as state, never thrown to crash
- The wallet UI layer catches errors and shows them in the wallet panel
- Core game (rendering, movement, multiplayer) continues unchanged

**Test**: no automated test covers this yet.

**Risk level**: ✅ MITIGATED

---

### 5. Can the wallet be used on mainnet accidentally?

**Question**: Could a player accidentally send real ZEC funds to the wrong address or network?

**Answer** (test-chain builds; a mainnet build is deliberate — see § Mainnet): No. A test-chain build is fixed to its chain and rejects mainnet configurations.

**Why**:
- `ZCASH_NETWORK` is set to `"test"` in `wallet-types.ts:27`
- The config module (`apps/web/src/zcash/config.ts`) only defines testnet configuration
- `validateSupportTarget()` compares the support target's network against `getNetworkConfig()` and throws if they don't match
- No fallback, no silent downgrade: **fail-closed**

**Test**: `apps/web/src/viteConfig.test.ts` checks that a build without a network fails closed; the runtime check in `config.ts` has no automated test yet.

**Risk level**: ✅ MITIGATED

---

### 6. What if an attacker changes the support recipient address?

**Question**: Can an attacker or malicious deploy change the recipient address to steal funds?

**Answer**: Yes, but only at deploy time or via legitimate configuration changes.

**Why**:
- Recipient addresses are defined in code or configuration
- Players can see the address in the support confirmation screen (masked, e.g., `u1qx…7f3a`)
- The support memo is empty (no project ID, no player identity)—misrouting doesn't reveal who sent it
- No code path silently changes the recipient

**Mitigation**:
- Configure recipient addresses in `config.ts` (hardcoded for testnet MVP)
- Code review any changes to recipient configuration
- Display the masked recipient address to the player for review
- Show the amount and project name in confirmation

**Risk level**: ⚠️ REQUIRES CONFIGURATION TRUST

---

### 7. Can the seed phrase be leaked via XSS?

**Question**: If an XSS vulnerability exists in the app, can an attacker steal the seed phrase?

**Answer**: Partially mitigated, with optional passphrase protection.

**Why**:
- Seeds are stored in `localStorage` (plaintext by default)
- An XSS attacker with `localStorage` access can read the seed
- However, `keystore.ts` provides optional at-rest encryption via PBKDF2 + AES-GCM
- A player can encrypt their seed with a passphrase, making the `localStorage` value useless without the passphrase

**Mitigations**:
1. **CSP** (sent by the game server when it serves the page — `apps/server/src/staticSite.ts` `buildPageCsp`): `connect-src` limited to the server's own origins and LiveKit, scripts only from the page's origin (the wallet engine needs `'unsafe-eval'` and blob workers). The Vite dev server and `vite preview` do not send it. See § Mainnet.
2. **Optional seed encryption**: players can set a passphrase in the future
3. **No auto-sign**: every send requires player confirmation
4. **Testnet only**: TAZ is valueless

**Test**: address masking has no automated test yet.

**Risk level**: 🟡 MITIGATED WITH CAVEATS (XSS + localStorage is the app's security baseline; mainnet would need stricter key management)

---

### 8. Can a man-in-the-middle intercept the transaction?

**Question**: If the player's connection to lightwalletd is compromised, can an attacker intercept or modify the payment?

**Answer**: No. The transaction is cryptographically signed before sending.

**Why**:
- The wallet signs the transaction in the browser (`wallet.ts:186-194`, `wallet.ts:212-220`)
- The signature proof is computed in a worker (slow, ~5-15 seconds)
- The signed `txids` are broadcast to the network
- A MITM can see the transaction (network-level), but cannot modify or forge a signature

**Risk level**: ✅ MITIGATED (by Zcash cryptography)

---

### 9. Can the proxy (grpc-web to lightwalletd) learn the player's balance?

**Question**: The grpc-web proxy receives `sync()` calls and wallet queries. Can it infer the player's balance or recent transactions?

**Answer**: Yes, the proxy can observe when the player syncs, but:
- The proxy is operator-controlled (not third-party in MVP)
- The proxy does not learn which player owns the wallet (no session binding)
- In a real deployment, use a standard lightwalletd public endpoint or run your own proxy

**Mitigations**:
- Configure proxy URL at runtime: `ZcashWalletAdapter.initialize(proxyUrl)`
- No hardcoded third-party endpoints
- Operators must be trusted to manage lightwalletd

**For mainnet**: consider Tor or a private proxy to avoid IP-level observation.

**Risk level**: 🟡 DEPENDS ON PROXY OPERATOR

---

### 10. Is the viewing key protected?

**Question**: If a player imports a viewing key (for watch-only wallet), is it protected?

**Answer**: No, watch-only wallet import is not yet implemented. Support payments require a full seed phrase.

**Why**: Watch-only support is marked `NOT YET IMPLEMENTED` in `ZcashWalletAdapter.importViewingKey()`.

**Future work**: When implemented, viewing keys can be stored alongside seeds and optionally encrypted.

**Risk level**: N/A (feature not implemented)

---

### 11. Can the app know if a support payment succeeded?

**Question**: Does the game server or player receive confirmation that the payment was included in the blockchain?

**Answer**: Partially. The player gets a transaction ID immediately; full confirmation requires external verification.

**Why**:
- `sendShielded()` and `send()` return a `txid` when the transaction is broadcast
- The player sees this in the UI: "Transaction sent: 0xabc123…"
- To verify confirmation (mempool → block), the app would need to query the blockchain
- The game server does NOT learn about the payment

**Implementation note**: `getTransactionStatus()` in the adapter is marked as a placeholder (`return "unknown"`). Real implementation would:
1. Query Zcash blockchain via proxy
2. Return "pending" | "confirmed" | "failed"
3. Show status in the UI

**Risk level**: 🟡 FEATURE-LIMITED IN MVP

---

### 12. Can a player support the same project twice and be identified?

**Question**: If a player sends two support payments to the same project, can they be linked as the same donor?

**Answer**: On the Zcash network, no. Shielded transactions don't reveal sender addresses.

**Why**: Each shielded payment uses a new random output on the Zcash blockchain. Different shielded sends from the same wallet use different chain outputs and cannot be deterministically linked.

**Caveat**: If the project creator receives *two payments of the same unusual amount* close together, they might *infer* it's the same player. This is mitigated by:
1. The memo is empty, so it carries nothing that links two payments
2. Multiple players could send the same amount to the same project

**Risk level**: ✅ MITIGATED

---

### 13. Does the support button reveal anything to other players?

**Question**: When a player clicks "Support with ZEC", can other players in the world see this action?

**Answer**: No. The support flow is entirely client-side UI.

**Why**:
- The support button click triggers local UI changes only
- No message is sent to the multiplayer server
- Other players do not see the wallet panel, amount input, or confirmation
- The actual transaction is on the Zcash blockchain, not the game server
- Only if the player chooses to *announce* their support in voice/chat would others learn about it

**Risk level**: ✅ MITIGATED

---

### 14. Can the wallet observe who's nearby in the game?

**Question**: When the wallet is open, can it observe proximity of other players?

**Answer**: No. The wallet module does not access the proximity system.

**Why**:
- `ZcashWalletAdapter` is framework-independent and has no access to game state
- The React hook `useZecWallet()` is purely for wallet operations
- Even if a player is visible in the game world, their presence doesn't change wallet state
- The support target requires only `projectId` and a configured recipient address, not any player data

**Risk level**: ✅ MITIGATED

---

### 15. Can the app forget to clear the seed after disconnect?

**Question**: If a player disconnects the wallet, does the seed remain in memory/localStorage?

**Answer**: Depends on the player's disconnect pattern.

**Why**:
- `clearAllData()` removes the seed from `localStorage` and IndexedDB
- After calling `disconnect()`, the seed is cleared *if* the player explicitly disconnects
- However, if the player just closes the browser tab, the seed persists for next visit
- This is intentional: the MVP treats seeds as persistent for convenience

**For mainnet**: would need stricter cleanup (clear on each tab close, etc.).

**Test**: `apps/web/src/zcash/wallet-adapter.lifecycle.test.ts` checks that `clearAllData()` removes the encrypted seed and the wallet database.

**Risk level**: 🟡 ACCEPTABLE FOR TESTNET (TAZ IS VALUELESS)

---

### 16. Can support metadata be forged?

**Question**: Can an attacker send a fake support memo (claiming to be from a player who didn't send it)?

**Answer**: No. Only the player's private key can sign a transaction.

**Why**:
- The memo is encrypted inside the transaction
- The transaction is signed by the private key
- An attacker without the key cannot create a valid signed transaction
- Even if they modify the memo, the signature fails validation

**Risk level**: ✅ MITIGATED (by Zcash cryptography)

---

### 17. Does the addressbook leak social graphs?

**Question**: If the game stored an addressbook of recent supports, would that reveal social relationships?

**Answer**: Not in the current implementation (no addressbook).

**Why**:
- The wallet doesn't maintain a list of recent recipients
- Each support payment is independent
- The game server doesn't observe supports
- If an addressbook were added in the future, it would need careful privacy analysis

**Risk level**: ✅ NOT APPLICABLE (FEATURE NOT IMPLEMENTED)

---

### 18. Can a player's total support history be reconstructed?

**Question**: Over time, can someone reconstruct all of a player's support payments?

**Answer**: Partially, but attribution is cryptographically hard.

**Why**:
- Shielded transactions are not linked by sender address (unknown to observer)
- An external observer (e.g., project creator) sees payments arrive, but not who sent them
- A player who reveals multiple memos (via UI or conversation) could be identified as a regular supporter
- The game server never learns about payments at all

**Mitigations**:
1. Shielded Zcash hides sender addresses
2. Support memo doesn't include player identity
3. Each transaction can use a different address in the wallet's account pool

**Risk level**: ✅ MITIGATED

---

## Mainnet (ADR-018) — the Stage-2 "Ironwood" wallet

Added with the mainnet build (2026-10-08) and updated for Stage 2 (2026-10-09). It covers a
build with `VITE_ZCASH_NETWORK=main`, the mainnet wallet engine (Stage 2: upstream
`zcash_client_sqlite` in WebAssembly; its build scripts are in `scripts/wallet-engine/`, its provenance in `vendor/webzjs-wallet-main/PROVENANCE.md`) and a game server with `ZCASH_NETWORK=main`. It is an
invited, real-money beta of **unaudited** software: a consent step, a per-transaction cap (0.01 ZEC by default) and a
fresh wallet with a small amount are the stated conditions.

**Pools and addresses (ADR-018 § 3 and the § 1 Stage 2 amendment).** The wallet sees and spends every shielded pool:
**Ironwood** (where new Orchard-style value goes since NU6.3, and where the wallet's change and shielded deposits go),
**Sapling**, and legacy **Orchard** (withdraw-only since NU6.3: the wallet spends old notes out of it, nothing new
arrives there). Transactions are version 6.
- *Add funds* shows the owner's **full unified address** (an Orchard-family receiver, a Sapling receiver and a
  transparent receiver — any wallet can pay it, and a shielded payment arrives shielded), the **exchange address**
  (`t1…`, for exchanges that only withdraw to transparent addresses) and the Sapling-only `zs1…`. They are shown only in
  the owner's own panel.
- Deposits to the transparent address are public on the chain (the amount and the address) until the player shields
  them; shielding moves them into Ironwood and is public on its transparent side. The wallet shields any amount above
  the network fee (threshold 1 zatoshi).
- A player-to-player payment goes to the recipient's **shielded-only unified address** (Orchard-family + Sapling, no
  transparent receiver): the full address is never sealed to another player, because its transparent receiver points at
  the player's exchange deposits (`PLAYER_PAYMENTS_THREAT_MODEL.md`). A Stage-2 payer pays it as Ironwood; a client that
  has not reloaded since Stage 1 pays its Sapling receiver.
- Withdrawals go to any `u1…`, `zs1…`, `t1…` or **TEX** (`tex1…`, ZIP 320) address. A unified address's transparent
  receiver is never paid (a `u1…` without a shielded receiver is refused). A `t1…` or TEX withdrawal makes the amount and
  the address public, and the game says so; a TEX withdrawal is two transactions — shielded funds to a one-time
  transparent address of the wallet, then that output to the exchange — so the one-time address is public too, and
  linkable to the exchange's. **A withdrawal to a `zs1…` or a Sapling + transparent `u1…` is a Sapling output**: funded
  from Ironwood (the usual case — the wallet's Sapling notes rarely cover it), it moves that value from Ironwood into
  Sapling, so its **amount** is public (the Sapling value balance; the addresses stay private). The withdraw Review says
  so and suggests the destination's full unified address. The same holds for a player payment to a
  stale Stage-1 recipient's `zs1…` (the confirmation says so) and for a fee to a registry/fee address
  without an Orchard-family receiver (an exact `-fee` Sapling value balance; operators must use the full unified
  address).
- **Change always goes to Ironwood** (an engine rule). A payment funded from Sapling (or legacy Orchard) notes therefore
  crosses pools, and its change amount shows as that pool's value balance — the amount moved between pools is public,
  as for any pool crossing; recipients, addresses and memos stay shielded.
- **A TEX withdrawal half sent**: if the first transaction is mined and the second is refused or
  lost, the amount plus the second fee stays on the one-time transparent address; once the second expires, the
  engine's next scheduled check of that address (upstream randomises the time) reads its unspent outputs from
  lightwalletd and the value returns under "Waiting to be shielded". Shielding takes the regular t-addresses and each
  one-time address separately (upstream refuses to link them in one transaction).
- **The wallet's addresses are fixed**: always the account's default address (ZIP 316 default diversifier), never "the
  most recently used" one, so a deposit to another of the seed's t-addresses changes nothing.
- Seeds restored from other wallets (Zashi, Zodl, Zingo, …) show their shielded funds in every pool. Transparent funds:
  the engine watches the seed's standard transparent addresses with upstream's gap limit (10 unused receiving and 5
  change addresses past the last used one — read from `zcash_client_sqlite`'s code, not yet tried with a real Zashi
  seed); a deposit further out is not found.

**On the device.** The seed is encrypted at rest with the player's passphrase (PBKDF2-SHA256 + AES-GCM,
`core/keystore.ts`), under mainnet-only keys (`zw.wallet.seed.main.v1`, `zw.wallet.acct.main.v1`), so a
test-chain wallet is never opened as a mainnet one on the same origin. The wallet database (`db_to_bytes`, IndexedDB
`zw-wallet-main`) is a **SQLite file** and is **not** encrypted: it holds the viewing keys,
addresses, balances, transaction history and memos — anyone with the browser profile can read the history, not spend.
`localStorage` holds the consent (`zw-mainnet-consent-v1`), an unconfirmed backup
(`zw.wallet.backup-pending.main.v1`) and the wallet's **birthday height**
(`zw.wallet.birthday.main.v1`, so a restore from the seed starts at the right block; the database holds it too).
The seed words are shown only while the backup view or the backup check is open; closing the wallet panel clears them
from the page.

**Migrating a Stage-1 wallet.** The Stage-2 engine cannot open a Stage-1 save (a protobuf dump of the
memory backend). On unlock, the game decrypts the seed with the passphrase as always and rebuilds the wallet from it and
its birthday — the stored one, else the one read from the old save on the device (`zcash/stage1Save.ts`, which reads
only the account's birthday field), else a month and year the player chooses. **The seed is never asked for again and
never leaves the device**; the rescan is a normal sync through the bridge. The old save stays in IndexedDB until the
rescanned wallet replaces it (closing the page restarts the rescan), so nothing is lost if the rescan is interrupted.
The rescan tells the bridge and lightwalletd the same thing a restore does: the block range from the birthday on, and
the account's transparent addresses.

**Page CSP.** When the game server serves the client (`WEB_DIST`), every page response carries
`default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; worker-src 'self' blob:;
connect-src 'self' <this deployment's page origins and their ws(s) form, LiveKit>; …;
frame-ancestors 'none'; object-src 'none'; base-uri 'self'` (`apps/server/src/staticSite.ts`). The
engine needs `'unsafe-eval'` (wasm-bindgen glue) and blob workers (its thread pool), so the policy
cannot stop an injected script from running code; what it does is stop it from sending the seed,
the passphrase or the wallet database to another origin. SQLite runs inside the engine's WebAssembly (in-memory
virtual file system): no new origin, worker type or storage API. `CSP_MODE=minimal` is the documented
escape hatch (only `frame-ancestors`, `object-src`, `base-uri`). The Vite dev server and
`vite preview` send no such policy. HSTS is set by the deployment's HTTPS front end.

**What the game server's wallet bridge learns** (`/zcash/lwd`, in the game server process). For every player: the
block ranges it syncs and when (from the birthday on for a new restore or a Stage-1 migration); the account's
**transparent addresses** on every sync (`GetAddressUtxos` for the receiving and change addresses within the gap limit;
`GetTaddressTxids` when the wallet checks one of them, including the one-time addresses of a TEX withdrawal — upstream
schedules those checks at random times); the txids of the wallet's own transactions and of received notes whose memo
or status it fetches (`GetTransaction`); every broadcast (the raw transaction — its txid); the consensus-branch checks
(`GetLightdInfo`); the subtree roots it downloads. All of it comes from the same IP as the player's nicknamed WebSocket
session. The bridge logs none of it, and nothing in the code links it to a session, but an operator who changes the
server could: the player's exchange address and, by timing, which transaction a relayed payment was
(`PLAYER_PAYMENTS_THREAT_MODEL.md` § Mainnet).

**What the public lightwalletd learns** (`zec.rocks:443` by default, `LIGHTWALLETD_URL`). The same queries, all from
the game server's IP: it learns every player's transparent addresses and fetched txids, but no player IP and no
nickname.

**Branch guard and NU7.** The engine refuses to build anything when the chain's next block is not on the consensus
branch it was built for (NU6.3 `37a5165b`), or when an upgrade activates within 41 blocks; balances stay visible and the
player sees "sending paused". Moving to NU7 is a new engine build (ADR-018 § 7), expected before NU7's mainnet activation (≈ 2026-11-05).

**Residual risks (real money).**
- An XSS or a malicious dependency in the page runs with the unlocked wallet: it can spend up to the
  cap per transaction (repeatedly) and read the seed while it is unlocked (an unlocked wallet keeps
  the seed in memory for the session; there is no idle auto-lock yet). The CSP limits where it can
  send data, not what it can do in the page.
- The engine is a community fork with our patches on upstream `zcash_client_sqlite`, not audited; SQLite is built from the official amalgamation, reproducibly.
- The game server operator (or anyone who compromises it) sees the metadata above.
- A transparent deposit links the exchange account to the `t1…` publicly; the later shielded payments
  are not linked to it on chain. A `t1…`/TEX withdrawal is public the same way.
- A pool crossing (Sapling or legacy Orchard notes spent, change to Ironwood) makes the moved amount public.
- A Sapling output funded from Ironwood (a `zs1…` / Sapling + transparent `u1…` withdrawal, a payment to a stale
  Stage-1 page's `zs1…`, a fee to a Sapling-only registry address) makes its amount public; the game warns for
  withdrawals and payments, the server for its own fee addresses.
- A lost answer from the network leaves a payment "may have been sent"; the wallet never retries on
  its own, the next sync shows the truth.
- A Stage-1 player's first unlock after the upgrade is a rescan from the birthday (about twice the Stage-1 sync time
  per block); sending waits for it.
---

## Summary Table

| # | Threat | Status |
|---|--------|--------|
| 1 | Server observes support sender | ✅ Mitigated (client-side wallet) |
| 2 | Zcash network identifies sender | ✅ Mitigated (Orchard shielded) |
| 3 | Memo leaks identity | ✅ Mitigated (memo has no PII) |
| 4 | Wallet crash crashes game | ✅ Mitigated (error isolation) |
| 5 | Accidental mainnet use | ✅ Mitigated (fail-closed) |
| 6 | Attacker changes recipient | ⚠️ Config trust required |
| 7 | XSS steals seed | 🟡 CSP + optional encryption |
| 8 | MITM intercepts transaction | ✅ Mitigated (cryptographic sig) |
| 9 | Proxy learns balance | 🟡 Operator trust required |
| 10 | Viewing key unprotected | N/A (not implemented) |
| 11 | Payment confirmation | 🟡 Partial (txid only) |
| 12 | Repeated payments linked | ✅ Mitigated (no sender address) |
| 13 | Support visible to others | ✅ Mitigated (client-side only) |
| 14 | Wallet observes proximity | ✅ Mitigated (no access) |
| 15 | Seed persists after disconnect | 🟡 Acceptable for testnet |
| 16 | Memo forged | ✅ Mitigated (signature required) |
| 17 | Addressbook leaks socials | ✅ N/A (not stored) |
| 18 | Support history reconstructed | ✅ Mitigated (shielded + no memo ID) |

---

## Recommendations

### For MVP (Testnet)
- ✅ Current implementation is acceptable
- Deploy with strict CSP
- Use testnet only (TAZ valueless)
- Document that the app stores seeds in plaintext localStorage

### For Mainnet (Future)
- Add optional seed encryption UI (already implemented in `keystore.ts`)
- Use a private or Tor-proxied lightwalletd connection
- Implement full transaction confirmation tracking
- Add viewing key support with encryption
- Consider additional privacy measures (e.g., spend delay, address reuse prevention)
- Audit seed cleanup behavior
- Implement rate limiting on support sends to prevent metadata inference

### Ongoing
- Audit XSS risks (CSP violations)
- Review updates to WebZjs / librustzcash
- Test against new Zcash network upgrades (NU6+)
- Monitor for new privacy deanonymization techniques

---

## Test Coverage

Threat model validated by:

1. **Unit tests** (`npm test`):
   - `apps/web/src/zcash/wallet-adapter.lifecycle.test.ts`: lock, unlock, wrong passphrase, clearing all wallet data
   - `apps/web/src/viteConfig.test.ts`: a build without a network fails closed

2. **E2E tests** (13 scenarios):
   - `tests/e2e/support-flow.spec.ts`: A-M full workflow + recovery + network isolation

3. **Code review**:
   - No player identity in any transaction or memo
   - Wallet errors caught and isolated
   - Network config fail-closed

---

**Document**: docs/privacy/ZCASH_WALLET_THREAT_MODEL.md  
**Status**: questions 1–18 cover the test-chain wallet; § Mainnet covers mainnet builds  
**Review**: ✅ Threat model complete
