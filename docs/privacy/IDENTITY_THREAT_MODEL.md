# Identity threat model — owned names (ADR-016)

**Scope.** Fee-confirmed, owned nicknames on the project's own test chain:
- a wallet holder confirms a name with a small shielded payment to the game's name registry;
- a returning player gets the name back by signing a challenge with a key derived from the wallet seed.

This covers what the game server stores, what it learns from the payments, how long it keeps it, and how it can be abused.

Related documents:
- ADR-015's split between guests and wallet holders: `SOCIAL_IDENTITY_THREAT_MODEL.md`;
- the in-game wallet: `ZCASH_WALLET_THREAT_MODEL.md`;
- player-to-player payments: `PLAYER_PAYMENTS_THREAT_MODEL.md`.

**Status.** Built first for the project's NU6.1 regtest test chain (ADR-016, accepted 2026-10-07). **Mainnet** came with ADR-018 (accepted 2026-10-08): what changes is in § 12. The wallet itself is still unaudited (ADR-018 Consequences).

**Code.**
- Server: `apps/server/src/identity/`
  - `nameRegistry.ts`: reservations, payment matching, claims;
  - `nameStore.ts`: the file store;
  - `nameScanner.ts`: the `zcashd` and `dev` backends;
  - `nameKeyVerify.ts`: signature checks;
  - `nameConfig.ts`, `nameService.ts`: configuration and the poll loop.
- Client:
  - `apps/web/src/zcash/nameKey.ts`: the name key;
  - `apps/web/src/onboarding/feeNameConfirmation.ts`: the fee and claim flows.
- Protocol: `docs/protocols/multiplayer-protocol.md` § Owned names.

---

## 1. Who learns what

| Party | Learns | Does not learn |
|---|---|---|
| **Other players** | The name, as before (it was always public), and ADR-015's one bit, "can receive ZEC privately". A confirmed name looks exactly like any other name. | That a fee was paid, when, how much, or from which transaction. Any key, key hash or address. Whether a name was confirmed or claimed. |
| **The game server** (operator) | **Stored:** name ↔ name-key hash ↔ the key's public key (after the first claim) ↔ the owner's last character ↔ first and last confirmation time.<br>**In memory only, until the reservation ends:** which connection reserved which name for which key, the memo nonce, and when "seen" and "confirmed" happened.<br>**From zcashd:** every note received at the registry address — value, memo, txid, output index, confirmations. | The payer's address (an Orchard or Sapling note carries no sender, and our client writes no reply-to). The payer's balance or any other transaction. The wallet seed and the name key's private half. |
| **The deployment's zcashd** (test chain; same operator, same host) | The registry account's received notes, kept in its wallet indefinitely: value, memo (`zw-name:v1:<nonce>:<16 hex of the key hash>`, never a name), txid, block. | The sender address. Names: the memo has none. |
| **Chain observers** | A shielded transaction: its fee and number of actions. If the payer's notes are Sapling, the transaction crosses into the Orchard-only registry address, and that crossing reveals its amount. | Sender, recipient, memo. The amount, when the payment is Orchard to Orchard (the faucet sends to Orchard receivers). |
| **lightwalletd** | A transaction broadcast through the game server's wallet bridge (`zcash/lwdProxy.ts`). | The player's IP address: the bridge relays it. |

**What this changes.** The server can now link a player's sessions over time. That is the point of an owned name: the same name key comes back on every visit.

ADR-015 introduced holders, guests and the claim key, but still had no persistent identifier. `MULTIPLAYER_THREAT_MODEL.md`'s statement "nothing about a player's identity survives a disconnect or a server restart" no longer holds for owned names. It still holds for everything else:
- `playerId`;
- the session capability;
- positions;
- chat;
- Guest names;
- honour-mode names (`NAME_REGISTRY=off`).

## 2. The first persistence: what is stored

The file is `NAME_REGISTRY_FILE` (default `./data/names.json`).

It is plain JSON, written atomically (a temporary file, fsync, then rename), and readable by the server's user only (`0600`, directory `0700`).

One record per owned name:

| Field | Why |
|---|---|
| `nameKey` | The NFKC, case-folded name: the uniqueness key. |
| `displayName` | The name as chosen, which is what everyone sees. |
| `keyHash` | SHA-256 of the owner's name-key public key. The registration binds to it. |
| `publicKey`, `alg` | Learned at the first successful claim. Later claims must use the same key. |
| `avatar` | The owner's last character (model and colour index). Cosmetic. |
| `createdAt`, `lastSeen` | When the name was confirmed, and the last confirmation or claim. The retention policy uses `lastSeen`. |
| `bannedUntil` (only while banned) | Moderation (ADR-019): when a moderator's ban of 24 hours or more on this name's key ends (ms since epoch; the largest JavaScript date means "until lifted"). No reason, no moderator, no report. § 13. |

The file also has a `usedNotes` list:
- on the test-chain backends (dev, zcashd) each entry is the SHA-256 of `zocial-world/name-note/v1:<txid>:<pool>:<index>`;
- on the lightwalletd backend (mainnet, § 12) each entry is an HMAC-SHA-256 of `zocial-world/name-note/v2:<txid>:<pool>:<index>` under a key derived from the registry's viewing key — the key is never in the file or on the data volume;
- it gives replay protection: a payment confirms at most one reservation, once.

The hash is one-way, so the file holds no txid. With v1, anyone who already knows the txid can confirm a match: the payer, and whoever holds the registry's keys. The v1 hash hides the txid only from someone who has nothing but this file **and whose candidate txids are not public** — true on the private test chain, false on mainnet, where every txid is public and an unkeyed hash could be reversed by hashing them all. That is why mainnet uses v2: without the viewing key, the file's hashes cannot be checked against any txid. A store written before v2 keeps its v1 entries (still honoured for replay protection); new entries are v2 only.

**Never stored:**
- an address;
- a balance or an amount;
- a txid in the clear;
- an IP address;
- a `playerId` or session id;
- a reservation, nonce or memo;
- chat;
- anything from other players.

**Server logs never contain:**
- names together with payment data;
- the registry address;
- player ids together with anything about names.

Concretely, the logs contain only three things:
- the startup line: mode, fee and store path;
- scan failures, at most once a minute, with addresses stripped;
- store write errors, as an error code.

**Honest limit.** `createdAt` is close to the payment's block time. The zcashd wallet keeps every registration memo, and a memo carries 16 hex characters of the key hash.

So the operator can link a stored name to its registration transaction (but not to a sender address) by combining the file with zcashd's wallet. A third party with only the chain cannot.

On mainnet the same holds for whoever has the file AND the viewing key (it decrypts every registration memo). Someone with only the file still has `createdAt`, which is close to the registration's block time: it narrows the candidates to the Sapling transactions of a few blocks, without confirming one (the keyed hashes cannot be checked).

## 3. Retention and deletion

- **Retention.**
  - Records are kept while the deployment that confirmed them runs.
  - When a test-chain deployment ends, the operator deletes `names.json` (and its backups) together with the test chain.
  - There is no automatic expiry in v1 (ADR-016 defers expiry).
  - The operator may delete records whose `lastSeen` is older than 90 days. The procedure is the same as for deletion on request.
- **Deletion on request.**
  - A player asks the operator through the deployment's contact channel and names the name. The name is public; nothing else is needed.
  - The operator stops the game service, removes the record and starts the service again. The record is one entry in `names.json`; nothing else refers to it.
  - The name is free again. The fee is not refunded.
  - The registration memo stays in zcashd's wallet and on the chain. It holds a nonce and 16 hex characters of a key hash, never the name, so it no longer leads to the deleted name.
- **Backups** of `names.json` follow the same retention, and the same deletions apply to them. Deleted names can come back if a backup is restored; the operator then repeats the deletion.

## 4. What the server learns from fee payments

- **Per payment, through `z_listreceivedbyaddress`:**
  - the note's value (at least the fee);
  - its memo (the reservation nonce and the key-hash prefix);
  - its txid and output index;
  - its confirmations and block.
- **At the moment of reservation, in memory:** which live connection asked, and so its IP address at the transport layer.
  - The registry never reads or stores the IP address (`MULTIPLAYER_THREAT_MODEL.md`).
  - The nonce ties that connection to the payment until confirmation or expiry. Then the in-memory reservation is dropped. An expired one is remembered by nonce, for at most 24 h, only to consume a late payment.
- **Not learned:**
  - the sender's address: Orchard and Sapling notes carry no sender, and the client writes no reply-to into the memo;
  - the sender's balance;
  - any other transaction.
- **Transparent funds.** The in-game wallet spends shielded notes; the faucet sends to shielded receivers.
  - Open item: it is not verified whether WebZjs's `propose_transfer` would ever pick transparent inputs.
  - That could only happen if someone sent coins to the wallet's transparent receiver.
  - If it did, the transparent input would be public on the chain. That is a chain-level leak, not a server-level one.

## 5. Why there are no refunds

- A refund needs a return address. Asking for one, or reading one out of a payment, would create the name ↔ address link that the privacy model forbids (`PRIVACY_MODEL.md` § 1). Orchard hides the sender, and we keep it that way.
- The fee is a confirmation cost, not a price for the name. The UI says before paying: "It is not a purchase, and there are no refunds".
- A payment that arrives after its reservation expired is consumed, so it can never be reused. The client says so when a reservation expires.
- The coins are test coins with no value.

## 6. The viewing key

- The registry account lives in the deployment's zcashd wallet, created with `z_getnewaccount` and then `z_getaddressforaccount <account> ["orchard"]`. The address is an Orchard-only unified address with no transparent receiver.
- Its keys never leave zcashd. The game server only asks `z_listreceivedbyaddress` over RPC. A deployment should keep that RPC on a private network, never published to the internet, with `rpcallowip` limited to private ranges: anyone who can reach it can read every registration the wallet received.
- The viewing key is **not published** (ADR-016 § 5). Publishing it would make the registry auditable, and it would also make every registration's time and key-hash prefix public. That is a later decision.
- The operator can see everything zcashd's wallet sees (§ 1).

## 7. The name key

- **Derivation.** HKDF-SHA-256 over the wallet's BIP-39 seed, with info `zocial-world/name-key/v1/<network>`:
  - Ed25519 where WebCrypto supports it;
  - ECDSA P-256 otherwise.
- **Domain separation.** The key is separate from every other key the seed makes.
  - It is also separate from any other application's key derived from the same seed, so a player who uses one seed in several apps does not link their nickname to activity elsewhere.
- **Not an address.** It never touches the chain except as a 16-hex hash prefix inside an encrypted memo.
- **Lifetime in the browser.**
  - It is derived when the wallet unlocks and kept only as a non-extractable `CryptoKey` plus its public key.
  - Intermediate bytes are zeroed.
  - It is dropped on lock, on disconnect and on "Forget this wallet".
- **What the server sees.**
  - At reservation: the key hash.
  - At claim: the raw public key and one signature over `zocial-world/name-claim/v1:<nonce>:<nickname>`.
  - The nonce is fresh, bound to the asking session, single use (any proof consumes it) and valid for 2 minutes.
  - A signature cannot be replayed into another session or at another time.
  - Other players never see the key or its hash.
- **Portability limit.** Ed25519 and P-256 give different keys from the same seed.
  - A name registered in a browser with Ed25519 cannot be claimed from a browser that only has P-256.
  - Every current Chrome, Edge, Firefox and Safari has Ed25519. The hosted beta recommends Chrome or Edge.
- **A lost seed means a lost name.** No recovery exists in v1. A payment-delivery proof is a possible later path (ADR-016 Deferred).

## 8. Abuse and anti-bot honesty

**What the fee buys on the test chain is small.** It is paid with faucet coins. One faucet claim (1 TAZ) covers about 99 fees of 0.01 TAZ, and the faucet's limits are:
- one claim per session per 10 minutes;
- one claim per address per 24 h;
- 20 claims per minute overall.

The fee makes mass registration slower and needs a working wallet per batch, but it does **not** stop a determined squatter on the test chain. The real deterrent arrives only with real ZEC, after a future mainnet ADR. We do not claim more.

**Limits that exist now:**

| Limit | Value |
|---|---|
| Reservations per session | burst 3, then 1 per 20 s |
| Claim challenges per session | burst 5, then 1 per 10 s |
| Pending reservations | one per session, one per key, 256 server-wide |
| Reservation lifetime | 30 minutes (one more TTL once a payment is seen) |

A refused request is answered with `rate_limited`.

**Pre-join reservations.**
- A connection may reserve while still in onboarding, before it joins. Onboarding happens before the player exists for anyone, and the payment is the proof of a funded wallet.
- A connection that then joins as a guest loses the result; the name stays registered to the key.
- Worst case: a script can hold up to 256 names for 30 minutes. That is a temporary denial of those names. The operator can restart the server, which drops every pending reservation (paid ones are lost; test coins).

**Faucet before join.**
- A new player must pay the fee during onboarding, before they have the session capability that `welcome` carries.
- So the faucet also accepts the connection's **pending reservation id** as the proof of a live connection.
- The id is random and owner-only, and it is valid only while the reservation is pending and the connection is open.
- The same faucet limits apply, keyed by that connection.

**The `dev` backend.**
- It confirms every reservation after ~2 s **without any payment**. It exists for local development and the e2e suite only.
- The server refuses to start with `NAME_REGISTRY=dev` and `NODE_ENV=production`.
- A deployment runs with `NODE_ENV=production` and `NAME_REGISTRY=zcashd` (or `lightwalletd` on mainnet).
- Its quotes carry a placeholder address, which the client never pays.

**Impersonation.**
- ADR-015's rules still apply: NFKC, case-insensitive uniqueness, the Guest pattern and system words reserved, and invisible or bidi characters rejected.
- A registered name cannot be shown by anyone but its key's owner.
- When the owner opens a second session, the newest proof wins and the older session becomes a Guest.
- Moderation: players report impersonation in the game (ADR-019); a moderator can ban the name (its key, § 13), and the operator can still delete a squatted or impersonating name (§ 3).

**A modified client.**
- The holder flag is still client-asserted (ADR-015), but an owned name is not: only a paid reservation or a valid signature gives one.
- While a registry runs, the server requires an owned name — not the flag — for the full (publishing) voice grant, the Watch Hall stage, the floor and the audience vote (`docs/architecture/WATCH_HALL.md` § 12). A modified client that only claims the flag gets listen-only voice. Stage cooldowns are keyed by the owned name's normalised key, in memory only, until they run out (`MULTIPLAYER_THREAT_MODEL.md` § Stage moderation state). Payments and `canReceive` still follow the flag.
- A client cannot make the server confirm a name without a matching payment (`zcashd`), and cannot claim one without the key.
- The client checks every quote before paying:
  - the memo must carry this wallet's key hash;
  - the amount must be the advertised fee and at most 0.1;
  - the address must be a test-chain shielded one.
  
  A hostile or misconfigured server therefore cannot make the wallet pay more or pay for someone else's key.
- A reservation id is paid at most once. The client remembers paid ids in `sessionStorage` across a reload, and asking again returns the same reservation.

## 9. Failure modes

| Event | Effect |
|---|---|
| Server restart | Pending reservations are lost (memory only). A payment in flight for one is not matched; its test coins are lost. Registered names survive (file). |
| `names.json` lost with no backup | Every owned name is free again. The chain still holds the memos, but they carry no names and the nonce-to-name map was in memory, so **the registry cannot be rebuilt in v1**. Hence the operator's backups. |
| `names.json` corrupt | The server refuses to start rather than overwrite it. The log names the path, never the content. |
| zcashd down | Scans fail, are retried every 5 s and logged at most once a minute. Reservations may expire; a payment seen later than 30 minutes (60 if it was already seen) is consumed and reported as expired. |
| `NAME_REGISTRY=zcashd` without address or RPC | Registration is **disabled**. Holders keep Guest-style names, the onboarding step says why, and the startup log is loud. |
| Name key unavailable (no WebCrypto, locked wallet) | The holder cannot confirm or claim. They keep a Guest-style name; nothing else breaks. |

## 10. What we do not claim

- **No anonymity claim.** The operator sees what § 1 lists, can link a player's sessions through the name key, and can link a stored name to its registration transaction.
- What we do claim, backed by the protocol, is narrower:
  - no peer ever gets an address, key or payment detail;
  - the server never receives the payer's address;
  - the store contains no address, amount or txid in the clear.

## 11. Verification

**Covered by tests.**
- Server, `apps/server/src/identity/*.test.ts`:
  - reservations and expiry;
  - uniqueness;
  - the store round trip and atomic write;
  - the `zcashd` scanner against a fake RPC: match, wrong amount, wrong memo, replayed note, 0-conf;
  - `dev` refused in production;
  - challenges: good, bad signature, replayed, expired;
  - socket flows.
- Web:
  - the name key: determinism, domain separation, both algorithms;
  - the memo builder;
  - the confirmation state machine;
  - the onboarding UI.
- End to end, against the `dev` registry: `tests/e2e/names.spec.ts`.

**Live (client side), 2026-10-07.** On a NU6.1 regtest chain served by zebrad and lightwalletd, the registry address was a second in-game wallet's unified address, standing in for the zcashd account. The game server ran the production build with the `dev` registry and `NAME_REGISTRY_ADDRESS` set, so the quote carried that real address.

The player:
1. created a wallet in onboarding;
2. received mined shielded coinbase;
3. pressed **Confirm & pay**.

What happened:
- The in-game wallet proved and sent **0.01 TAZ** in 33 s, with the memo `zw-name:v1:<nonce>:<16 hex>` taken from the quote, to exactly that address.
- The transaction was in the mempool, then mined at height 498.
  - It is a v5 transaction with 2 Orchard actions: no transparent inputs or outputs, no Sapling.
  - Orchard → Orchard, so the amount was not revealed; the Orchard value balance is the 0.0001 ZIP 317 fee.
- The registry wallet's balance went from 0 to 0.01.
- The registry address never appeared in the page.

**Not exercised live: server-side scanning with zcashd.** `z_listreceivedbyaddress` was checked against zcashd's source (field names `pool`, `txid`, `amountZat`, `memo`/`memoStr`, `outindex`, `confirmations`, `change`) and a fake RPC, not against a running node.

## 12. Mainnet (ADR-018 § 5)

On `ZCASH_NETWORK=main` zcashd is not available (it stopped following mainnet), so the registry runs the
**`lightwalletd` backend**. Everything in §§ 1–11 holds, with these differences:

- **How a payment is seen.** The paying client sends `name_payment_sent { reservationId, txid }` after its
  wallet broadcast the fee. The server accepts it only from the session the reservation is bound to, fetches
  that one transaction through its own lightwalletd connection and trial-decrypts it with the registry's
  **viewing key** (`NAME_REGISTRY_UFVK`, vendor/zcash-tx-decrypt). Only outputs paid to the registry's own
  address decrypt; the payer's change and anything else stay encrypted.
- **What the server learns per registration:** the txid (from the client), the fee note's value, memo and
  output index, and its confirmations. Not the payer's address (a Sapling spend or an Ironwood action carries
  none).
- **The txid moment.** The reported txid is held in memory, keyed by the reservation, until the reservation
  ends (confirmed, expired or replaced) — at most the reservation's lifetime. The scanner drops it as soon as the reservation ends, also when no other reservation is pending. It is never logged or written; the store keeps only the keyed note
  hash (§ 2, v2: an HMAC under a key derived from the viewing key, so the file alone cannot be matched
  against the public mainnet txids). Compared with zcashd (§ 6), the server no longer
  has a wallet that keeps every memo forever: the viewing key decrypts on demand and nothing is kept.
- **The viewing key on the server.** The registry account's seed stays offline with the operator
  (`scripts/tools/registry-keys.mjs` derives the key and address once). The server holds only the viewing
  key (an env variable or a 0600 file). Someone who steals it can see every name fee and transfer fee the
  project received (amounts, memos, times) — not spend them, and not who paid. At startup the server checks
  that the configured address is the key's own (else it refuses to start), so no fee goes to an address it
  cannot see.
- **lightwalletd** (`zec.rocks` by default) sees the game server's IP asking for each reported transaction.
  It never sees a player's IP or a name.
- **Chain observers** — with the Stage-2 wallet (ADR-018 § 3): the registry address is its full unified
  address (`scripts/tools/registry-keys.mjs`), so a Stage-2 payer's fee is an **Ironwood** output and an Ironwood →
  Ironwood payment reveals no amount; a payer spending Sapling or legacy Orchard notes crosses into Ironwood, which
  makes the moved amount public (not the payer). A Stage-1 client (an old page) pays the address's Sapling receiver:
  Sapling → Sapling, no amount revealed. The server counts both pools (`apps/server/src/zcash/shieldedPayments.ts`).
  (On the test chain the registry was Orchard-only, so a Sapling payer crossed pools; § 1.)
  **A registry address WITHOUT an Orchard-family receiver** (a `u1…` or a `zs1…` kept from the Stage-1 setup)
  is paid by a Stage-2 wallet as a Sapling output funded from its Ironwood notes: every name fee
  then crosses pools and shows on chain as a Sapling value balance of exactly `-NAME_FEE` (0.00075 ZEC by default),
  which marks the transaction as a game fee. Because the server broadcasts `nickname_updated` to every player once the
  payment is confirmed, anyone who also watches the chain can match an owned name to its txid by timing — the very
  name-to-txid link "the txid moment" above keeps server-only. So switching `NAME_REGISTRY_ADDRESS` (and
  `PAYMENT_FEE_ADDRESS`) to the full unified address is a **required** step once the Stage-2 server build runs;
  on mainnet the server warns at startup when it was not done.
- **Operator acknowledgement.** Mainnet registration is off unless `NAME_REGISTRY_MAINNET_ACK=accepted`
  (ADR-018 § 5); without it the mode is `disabled` and holders keep Guest-style names.
- **Fee and deterrence.** About US$1 (0.00075 ZEC by default, set by the operator — re-check with the price).
  With real money the anti-bot deterrent of § 8 is real; still no refunds (§ 5).
- **The transfer fee** (ADR-018 § 6) uses the same account by default (`PAYMENT_FEE_*` falls back to the
  registry's address and key); its memos (`zw-fee:v1:…`) never match a registration memo, and its txids are
  dropped after the check (`PLAYER_PAYMENTS_THREAT_MODEL.md` § Mainnet).

Covered by `apps/server/src/identity/nameLightwalletd.test.ts` (configuration, ownership of reports,
seen → confirmed, short or foreign payments, real decryption of the engine's name-fee fixture),
`apps/server/src/zcash/feeVerifier.test.ts` and `walletServices.test.ts` (the address/key startup check), and
`apps/server/src/zcash/ironwoodFees.test.ts` (real Ironwood name-fee and fee outputs of the Stage-2 engine
through zw-tx-decrypt 0.2; the startup check accepts each of the key's shielded addresses). Live,
the mainnet onboarding reached the fee step (0.00075 ZEC, reservation and quote from a throwaway registry) and
refused cleanly for an empty wallet; no real fee was paid.

## 13. Moderation (ADR-019 § 4)

- **What a ban on an owned name is keyed by.** The name's **key hash** (the `keyHash` above), so every name the same
  key owns is blocked, and a reconnect or a second device with the same wallet doesn't help. A new fee-paid name
  with a **new wallet** is the only way around it. The connection hash (`MULTIPLAYER_THREAT_MODEL.md` § Moderation)
  is blocked as well, for at most 24 hours — then the hash is dropped from the ban while the name part runs on. A
  session of that key already online elsewhere when the ban is made is closed at once.
- **What is stored.** A ban of 24 hours or longer writes `bannedUntil` into every record with that key hash —
  nothing else: no reason, no moderator, no reporter, no session, no address. Shorter bans, kicks and mutes stay in
  memory. At start-up the server clears every stored `bannedUntil` that has already ended (one that ran out while
  the server was down) and reloads the ones still running; one that ends while the server runs is
  cleared on the next sweep (about every 5 seconds), and one evicted from the bounded in-memory list is cleared then;
  unban clears it at once. The moderation label for a key that owns several names is "A, B +N more".
- **When it applies.** The moment the name is proved — a claim (before or after join) or a confirmed registration
  for a banned key — the connection is told it is banned and until when, and closed (WebSocket code 4002).
- **Retention and deletion.** A stored ban lasts until it ends or a moderator lifts it. Deleting a name record on
  request (§ 3) deletes its ban too; that does not unban the key's other names.
- **What this links.** Nothing new: the server already maps sessions to owned names and keys. A ban adds one
  timestamp to a record the operator already holds. Moderators see the name and until when, never the key hash.

## History

- 2026-10-07: owned names on the test chain (ADR-016).
- 2026-10-08: § 12, mainnet (ADR-018 § 5).
- 2026-10-09: § 13, bans of owned names (ADR-019 § 4).
