# ADR-016: Fee-confirmed, owned nicknames via a shielded on-chain registration (test chain)

## Status

Accepted (2026-10-07) for the project's own regtest/test chain. Amended 2026-10-08 (see the amendment below) and extended to mainnet by ADR-018.

The principle: names are not sold. A player only pays a fee to confirm the name they chose with the wallet they connected — like buying a coin. The purpose is to stop bots.

**Mainnet was excluded from this decision.** Real fees needed a separate ADR, a mainnet-capable wallet build (the test-network WebZjs build proves only for our NU6.1 regtest chain), an audit, a mainnet scanner (zcashd is halted on mainnet) and legal review.

> **Mainnet: see ADR-018** (accepted 2026-10-08), which amends this ADR: the same flow on mainnet with a fee of
> about US$1 (`NAME_FEE_ZEC`, default 0.00075), a registry address with a Sapling receiver, and a new
> `lightwalletd` backend in place of zcashd — the paying client reports its txid (`name_payment_sent`) and
> the server decrypts that one transaction with the registry's viewing key (ADR-018 § 5). Mainnet registration
> needs `NAME_REGISTRY_MAINNET_ACK=accepted`.

## Context

ADR-015 makes nicknames a wallet-holder feature but cannot prove that someone holds a wallet; the flag is client-asserted. A small on-chain fee closes that gap:
- the fee proves the player controls a funded wallet;
- it makes mass bot registrations cost something.

Zcash has no smart contracts, so a "registration" is a shielded payment with a ZIP 302 memo that the game server verifies with a private viewing key. Claim keys and shielded scanning are an established pattern for this.

## Decision

1. **Name key.**
   - Each wallet derives a name-ownership key pair from its seed, domain-separated from other applications' keys derived from the same seed: info / salt `zocial-world/name-key/v1/<network>`.
   - It is used for challenge-response only. It is never an address and never touches the chain except as a hash in the memo.
   - The same seed restores the same names on any device.
2. **Reserve, then pay, then confirm.**
   1. **Reserve.** A holder asks to confirm a free name; the server reserves it for 30 minutes, bound to the key hash and the session.
   2. **Quote.** The server answers with the registry's **shielded** unified address (Orchard receiver), the fee (`NAME_FEE_ZEC`, default 0.01 test ZEC) and a memo `zw-name:v1:<nonce>:<keyHashPrefix>`.
   3. **Pay.** The player's wallet sends that shielded payment with the memo. A clear confirmation step shows the fee and the network fee. The address is used by the wallet and never displayed.
   4. **Verify.** The server watches the registry with its private viewing key and accepts the first payment that matches nonce, key hash and amount. It accepts 0 confirmations on the test chain and records the txid internally only.
   5. **Confirm.** The name is now **owned**: stored as `{nameKey, keyHash, avatar, createdAt, lastSeen}`. The server broadcasts the new nickname.
   6. **Return visits** need no new fee: the client signs a server challenge with the name key and gets the name back.
3. **Scanner backend.**
   - On the test chain, a test-chain deployment's zcashd wallet owns the registry account; the server reads `z_listreceivedbyaddress` (memo, amount, txid, confirmations) over the existing RPC client.
   - Without that configuration, registration is **disabled**: holders keep Guest-style names and the UI says why.
   - A `NAME_REGISTRY=dev` mode, which auto-confirms, exists for local development and tests only. It refuses to start with `NODE_ENV=production`.
4. **What this is not.**
   - Names are not sold, traded or auctioned: there is no transfer in v1 and no market.
   - The fee is a confirmation cost paid to the project's registry, like buying a coin, not a price for the name.
   - There are **no refunds**: refunding would need the payer's address and would create a name ↔ address link.
   - An expired reservation's payment cannot be reused.
5. **Privacy.**
   - Chain observers learn nothing: the payment is shielded, and the memo is encrypted to the registry.
   - The game server learns that a payment of the fee arrived with that memo, at that time. It does **not** learn the sender's address (Orchard hides it).
   - The registry's viewing key stays private on the server (it is not published on the test chain).
   - The txid is never shown in the profile. The stored record has no address and no balance.
   - This is the game server's **first persistence**: a small file store with a retention policy is documented in `docs/privacy/IDENTITY_THREAT_MODEL.md`.
6. **Anti-bot honesty.** On the test chain the fee is paid with faucet coins, so its deterrent value is small; the faucet's per-session, per-address and global limits matter. The real deterrent arrives with real ZEC, after a future mainnet ADR.

## Consequences

**Protocol and server.** New messages: `name_reserve`, `name_quote`, `name_status`, `name_claim_challenge`, `name_claim_proof`, `name_confirmed`. The server gains a registry module, a scanner poller (only while reservations are pending) and a file store.

**User experience.**
- Confirming a name takes about 15–60 s on the test chain: proving plus one block, or less with 0-conf.
- A brand-new player first needs faucet coins.

**Verification.** Server-side scanning against zcashd is covered by unit tests with a fake RPC.

**Deferred:** mainnet, transfers, expiry, a published viewing key (auditability) and recovery proofs (for example zcash-delivery-proof).

**As built (2026-10-07).** These are implementation details inside the decision above. None changes what is paid, what is stored or what anyone learns.

- **Messages.** The protocol uses `name_reserve` → `name_quote`, `name_status`, `name_claim_request` → `name_challenge` → `name_claim_proof`. There is no separate `name_confirmed`: confirmation is `name_status confirmed`, followed by the existing `nickname_updated` broadcast. Details: `docs/protocols/multiplayer-protocol.md` § Owned names.
- **Record.** The record also keeps:
  - `displayName`, the name as chosen;
  - the owner's raw `publicKey` and `alg`, learned at the first claim (later claims must use the same key);
  - a `usedNotes` list of one-way note hashes, for replay protection.
  
  It still holds no address, amount or txid.
- **Before join.** Reservations and claims are answered before join: onboarding confirms the name before the player exists for anyone, and the join gives it.
  - The faucet accepts the connection's pending reservation id as its proof of a live connection, so a brand-new player can get test coins for the fee during onboarding.
  - A connection that joins as a guest drops its owned name; the name stays registered to the key.
- **Modes.**
  - `NAME_REGISTRY=off` (the default) is ADR-015's honour mode: `set_nickname`, not owned, nothing stored.
  - With a registry (`dev`, `zcashd`), `set_nickname` is ignored for holders: a holder's name changes only through a confirmed registration or a claim.
  - `zcashd` without an address or RPC is "disabled": holders keep Guest-style names and the UI says why, as decided above.
- **The `dev` backend's quotes** carry a placeholder address (`zw-dev-registry`) unless `NAME_REGISTRY_ADDRESS` is set. The client never pays the placeholder.
- **The newest proof wins.** The owner's newer session takes the name over from an older one, which gets a Guest name.
- **Name key.**
  - Ed25519 where WebCrypto has it; ECDSA P-256 otherwise.
  - The two give different keys from one seed. A name registered with one cannot be claimed with the other. Every current mainstream browser has Ed25519.
- **zcashd v6.12.5.** `z_getnewaccount`, `z_getaddressforaccount` and `z_listreceivedbyaddress` are not deprecated, so `zcash.conf` needs no new `allowdeprecated`. Regtest needs no seed-backup acknowledgement for `z_getnewaccount`.
- **Persistence and retention:** `docs/privacy/IDENTITY_THREAT_MODEL.md`.

**Amendment (accepted 2026-10-08): what an owned name unlocks.** Accepted together with the ADR-015 amendment of the
same date.
- While the registry is live, an owned name — not the client-asserted holder flag — is what the server checks for the
  full voice grant, presenting on the Watch Hall stage, receiving the floor and voting to end a share. The fee thus
  also prices talking and presenting, which is the anti-bot purpose this ADR states.
- A Watch Hall stage cooldown (after an audience vote or set by a host) is keyed by the owned name's normalised key,
  so a reconnect does not escape it. It is held in memory until it runs out, never stored in `names.json`, never
  logged.
- Honest limit: on the test chain three faucet-funded names can end a share in a very small hall; the real deterrent
  still arrives only with mainnet fees (§ 6).
