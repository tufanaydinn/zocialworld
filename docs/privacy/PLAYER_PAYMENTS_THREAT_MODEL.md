# Player-to-player payments ("Send ZEC") — threat model (ADR-013)

This file answers `docs/privacy/PRIVACY_MODEL.md` § 4 for the in-game "Send ZEC" flow. Scope: the
project's test chain, and — since ADR-018 (accepted 2026-10-08) — mainnet, whose differences are in
§ Mainnet below (with the Stage-2 "Ironwood" wallet, ADR-018 § 3).

| Question | Answer |
|---|---|
| **What does the sender learn?** | That the recipient accepted. Their wallet receives the recipient's shielded address (sealed in transit, never displayed). It knows its own amount and memo and the txid. |
| **What does the recipient learn?** | The sender's nickname (it is a social request). On notice, the amount, the txid and whether a memo is attached; the memo itself is in the shielded note. The recipient never learns the sender's address. |
| **What does the application server learn?** | That session A asked session B, and whether B answered — in memory, for at most 5 minutes (30 after acceptance). It never sees an address, amount, memo or txid (sealed, AES-GCM). It stores no records and logs nothing. Through the wallet bridge it relays the sender's transaction broadcast, which is shielded and not linked to the request by the server. |
| **What does the wallet layer learn?** | The local wallet (WebZjs) knows everything about its own funds, as any wallet does. Nothing about the other player beyond the recipient address passed to the send call. |
| **What does a public chain observer learn?** | A shielded (Orchard/Sapling) transaction — no sender, recipient, amount or memo. The fee and timing are visible, as for every Zcash transaction. |
| **What identifiers are stored?** | None server-side. The client keeps ephemeral key pairs and request ids in memory until the card closes. The wallet stores its own history locally (`ZCASH_WALLET_THREAT_MODEL.md`). |
| **What metadata is logged?** | None. Relay errors return to the sender only. |
| **How long is it retained?** | Pending request entries for at most 30 minutes, then they are dropped, and also dropped on disconnect. |
| **Can social identity and financial identity be correlated?** | Only by the two participants, and only for this payment. The sender's wallet holds the recipient's address, which WebZjs reuses across payments (no per-request diversified addresses yet). Nothing reaches other players, the server or the chain. No UI shows an address, balance or history of another player. |

## Wallet holders only (ADR-015)

Payments travel only between **wallet holders**: a guest has no wallet address, so there is
nothing a payment to a guest could be sent to.

- **The server now knows which sessions declared a wallet** (`canReceive`, one boolean per
  session, client-asserted, in memory only). Other players see the same bit — in the player menu
  ("Can receive ZEC privately: yes/no — address never shown") and as the Send ZEC button's state,
  never as a nameplate badge. No address, balance or lock state is shared.
- **The server refuses** a `pay_request` from a guest (`sender_no_wallet`) and to a guest
  (`no_wallet`). Both checks run before the relay, so a refused request spends no rate token and
  the other player never sees it. Payments between holders are unchanged.
- **Clients agree:** Send ZEC is disabled for a player who cannot receive ("Send ZEC — this
  player has no wallet") and follows `can_receive_updated` live; a recipient whose device has no
  wallet at all (status `idle`) declines with `no_wallet` automatically.
- **A fake holder** (a modified client claiming the flag) can be offered a payment, but cannot
  receive it: accepting needs its own wallet to produce and seal a shielded receive address, and
  the sender's wallet only sends to a valid shielded address on its own network. At worst
  "nothing was sent". A guest harvesting addresses with an old or modified client is refused
  (`sender_no_wallet`); the recipient's consent and the security code remain the real defence.
- **Toggling the flag** does not reset the payment rate limit: "Forget this wallet" leaves pending
  requests to expire rather than forgetting the sender's bucket.

## Attacks considered

- **Unsolicited address pushes / spam:** the relay forwards answers and notices only within a
  request it relayed, between the same two sessions. Requests are rate-limited (burst 3, then one
  per 10 s), and blocked players are auto-declined. Since ADR-015 guests can neither send nor
  receive requests at all.
- **Malicious relay swapping keys (a man-in-the-middle):** it would learn the address and could
  substitute its own. Both players see a 4-emoji security code derived from both public keys;
  differing codes reveal the swap. Compare them by voice or chat before sending large amounts.
- **Wrong-network or transparent address:** the sender's client accepts only a shielded address
  on its own wallet's network (on the test chain: the same HRP; on mainnet: `u1…` or `zs1…`), and
  `sendShielded` rejects transparent targets. Any other acceptance cancels the request at once
  (`pay_cancel`), so no transfer fee can be owed for it.
- **Tampered ciphertext:** AES-GCM authentication fails, so nothing is sent.
- **Phishing via memo:** memos are free text from another player; they are shown as text only and
  never as links.

## Other wallet services on the game server

These are not part of the payment handshake, but the same server runs them:

- **Wallet bridge (`/zcash/lwd`).** It sees what lightwalletd would see, apart from the
  player's IP, which lightwalletd no longer gets: block-range sync requests, transaction
  submission timing (and the raw transaction, so its txid), the received-memo lookups by txid,
  and any transparent-address queries the wallet makes (on mainnet: the player's exchange `t1…`
  on every sync). It logs none of it, but it runs in the game server process, next to the
  nicknamed sessions — see the correlation row in § Mainnet. Shielded transactions stay encrypted.
- **Test-coin faucet (`/zcash/faucet`, test chain only).** A claim sends the player's **own**
  receive address together with their session capability. The server keeps the address only as
  an in-memory 24-hour cooldown key, never logs it, and scrubs it from error messages. Players
  who don't want that link can skip the faucet and ask another player for coins.

## Mainnet (ADR-018 § 2, § 4, § 6)

On a mainnet build the flow above is unchanged (consent, sealed address, security code). What changes:

| Question | On mainnet |
|---|---|
| **What does the sender learn?** | As above, and the recipient's address is its **shielded-only unified address** (an Orchard-family and a Sapling receiver, no transparent receiver — Stage 2; a Stage-1 recipient sealed its plain `zs1…`). The recipient never seals its full unified address: that one carries a transparent receiver — the same `t1…` its exchange deposits go to, public on the chain — so the sender could have looked up the recipient's deposit history. The sender's client accepts a `u1…` or `zs1…`; the engine never pays a unified address's transparent receiver. |
| **What does the recipient learn?** | As above. |
| **What does the application server learn?** | As above, plus — on a server that charges the **transfer fee** (§ 6): (1) the fee quote it issued for this request (its own address, amount and a random nonce); (2) that the sender broadcast a payment, and its **txid**, from `pay_sent`. It fetches that one transaction from lightwalletd and decrypts it with the project's viewing key: it can read **only the fee output** (amount, memo `zw-fee:v1:<nonce>`). The recipient's output and both addresses stay unreadable to it (verified on the engine's regtest fixtures: the project key decrypts exactly one output of a payment); so does the recipient's **amount — except** when the recipient's output is a **Sapling** output paid from Ironwood funds (a recipient on a stale Stage-1 page sealed its `zs1…`): the transaction then moves that value from Ironwood into Sapling, and its public Sapling value balance shows the amount (with a Sapling fee output, the amount plus the known fee), which the server reads from the transaction it fetched. The sender's confirmation card says so in that case (and drops "never the amount"). This is a **new, server-only link between two nicknames and a shielded transaction id** (ADR-018 Consequences): it exists in memory from `pay_sent` until the fee is checked (at least one confirmation, at most 60 minutes), then the txid is dropped. It is never stored, logged or shown; the used fee note is remembered only as an HMAC under a per-process random key. The **cap** check (§ 4) reads `capZat` — the sender's configured limit, the same for every honest client — never the amount. |
| **What does lightwalletd learn?** | The game server's IP asking for that transaction id (`GetTransaction`), and the wallet bridge's usual traffic: every player's sync, broadcasts, transparent-address queries and received-memo fetches arrive from the game server's IP. Never a player's IP. A public lightwalletd operator (`zec.rocks` by default) could correlate the request with the transaction it already sees on chain; it does not learn nicknames. |
| **What does a public chain observer learn?** | With the Stage-2 wallet: a version-6 shielded transaction whose recipient output, fee output and change are Ironwood actions, like any other with that many actions — neither the amounts nor the addresses — **when the recipient and the fee address have an Orchard-family receiver** (the shielded-only `u1…` a Stage-2 recipient seals; the registry's full `u1…`). **A Sapling output paid from Ironwood funds publishes its amount**: a payment to a Stage-1 player's `zs1…` (a stale page), or a fee to a registry/fee address without an Orchard-family receiver (a `u1…` from Stage 1, or a `zs1…`), is a Sapling output in the same transaction; a Stage-2 sender's funds are normally all Ironwood, so value moves from Ironwood into Sapling and the public Sapling value balance shows it — exactly the recipient's amount, or exactly the fee (`-NAME_FEE`, 0.00075 ZEC by default: every such fee transaction is recognisable as a game fee, and a name's is linkable by timing to the `nickname_updated` broadcast). The addresses stay private. Operators must therefore run the registry and fee addresses as the **full unified address** (`registry-keys.mjs`; the server warns at startup otherwise). When the sender spent **Sapling or legacy Orchard notes**, the change crosses into Ironwood and that pool's value balance makes the moved amount public (not who paid whom, not the recipient's amount). When the sender's funds came from a transparent (exchange) deposit, the **shielding** transaction before it made that deposit's amount public — not the later payment. |
| **What identifiers are stored?** | None server-side (the fee check is in memory; a session's `fee_unpaid` sanction ends with the connection). |
| **What metadata is logged?** | None about payments. The fee checker logs a lightwalletd failure at most once a minute, with txids and addresses removed. |
| **Can social identity and financial identity be correlated?** | **By the game server's operator, on any mainnet server — fee or no fee**. The wallet bridge runs in the game server process, so the operator can see, from the same player IPs as the nicknamed WebSocket sessions, the sender's `SendTransaction` (the raw transaction, its txid computable) seconds before the relayed `pay_notice`, and the recipient's next sync fetching that txid (`GetTransaction`, the received-memo lookup). Matching the two by IP and timing gives "these two nicknames' payment is that transaction". Nothing is logged and nothing in the code does that matching, but an operator who wants it can add it. On a fee-charging server, `pay_sent` hands over the same link directly (held in memory until the fee is checked). The transaction's addresses and the recipient amount stay encrypted either way. A player who does not trust the operator should not use in-game payments for anything that must not be linked to their nickname. |

**Attacks and limits on mainnet**

- **Skipping the fee.** The server cannot see the recipient's output, so a modified client can pay a
  player directly and then send a "cancelled" notice or `pay_cancel` (no `pay_sent`), or never accept a
  fee quote. The sanction (`fee_unpaid`, the rest of the session) applies when a `pay_sent` transaction
  is mined without the fee or when nothing arrives within 30 minutes; a new session starts clean. The
  fee is honest-client enforcement, not a cryptographic guarantee — documented, not hidden.
- **Skipping the fee with the stock client: Withdraw**. Withdraw is for the player's
  own external wallet and carries no transfer fee (ADR-018 § 1, § 6). A non-custodial wallet cannot
  prove that an address is the player's own, so two players who swap addresses in chat (from Add
  funds) can pay each other up to the cap through Withdraw, fee-free, with no `pay_request` and no
  sanction. The client refuses a withdrawal to an address another player sealed to this wallet in this
  session, and to the wallet's own addresses — a deterrent against doing it by accident, not a control.
  In practice the fee is voluntary for anyone who wants to avoid it. Withdrawals stay fee-free
  during the beta (ADR-018 § 6); this is to be revisited before a public release.
- **Cancelling is never charged.** Cancel (before or after the acceptance), a refused acceptance, an
  expired card, a recipient who left and a transaction the network refused all end the request with
  `pay_cancel`; the server drops the fee entry when no transaction was reported. A lightwalletd outage
  never sanctions (only a definitive "mined without the fee" or "unknown after the expiry height"
  does), and a valid `pay_sent` that arrives after the 30-minute deadline lifts the sanction.
- **The cap** is also honest-client enforcement: the server refuses a request whose declared `capZat`
  is above its own, and the wallet adapter refuses a larger amount; a modified client can bypass both.
  It limits what an honest player can lose to a mistake or a scam per transaction, not a theft (an XSS
  that reads the seed is not limited by it — ADR-018 Consequences).
- **A hostile server's fee quote.** The client pays a quote only if its amount equals the fee the server
  advertised in `/zcash/info`, is at most 0.01 ZEC (`PAY_FEE_MAX_ZAT`) and goes to a mainnet shielded
  address (`u1…`/`zs1…`). A hostile server can still name its own fee address — that is the operator's decision the
  player trusts by playing on that server. With Stage 2 the registry's address is its full unified address: a
  Stage-2 wallet pays the fee as an Ironwood output and the server counts it (as it counts a Sapling one).
- **Recipients and the pools (Stage 2).** The Stage-2 engine pays any unified address with an Orchard-family
  receiver (Orchard-only `u1…` included) as Ironwood, a `zs1…` or a Sapling + transparent `u1…` as Sapling. It never
  pays a unified address's transparent receiver: one with only transparent/unknown receivers is refused
  (`recipient_unsupported`). Withdrawals may go to a `t1…` or a **TEX** (`tex1…`, ZIP 320) address;
  the confirmation says the amount and the address become public, and a TEX withdrawal is two transactions through a
  one-time transparent address of the wallet (public and linkable to the exchange's address). A Sapling output
  (a withdrawal to a `zs1…` or a Sapling + transparent `u1…`, or a payment to a stale Stage-1 recipient's `zs1…`)
  funded from Ironwood makes its amount public through the pool crossing: the withdraw
  Review and the payment confirmation say so whenever the wallet's Sapling notes do not cover it, and suggest the
  destination's full unified address. The own-address refusal also covers the TEX form of the wallet's own
  t-address.
- **A TEX withdrawal half sent**. When the network accepts the first transaction
  of a TEX pair and refuses (or never answers) the second, the amount plus the second fee sit on the wallet's
  one-time transparent address — not at the exchange. The wallet says exactly that (never "nothing was sent") and
  not to withdraw again. Once the stored second transaction expires, the engine's next scheduled check of that
  address (usually within a day; upstream randomises it so the lightwalletd operator cannot link the addresses by
  timing) reads the address's unspent outputs from lightwalletd, the value appears under "Waiting to be shielded", and
  Shield brings it back. That check reveals the one-time address to the lightwalletd operator — it is already public
  on chain since the first transaction.
- **A lost answer from the network**. When the transaction was built and signed but the
  answer to sending it was lost (a timeout, a busy server), the wallet says it *may* have been sent,
  shows the txid and does not retry; the sender's `pay_sent` still carries that txid and the recipient
  is told the payment may arrive. Retrying blindly could pay twice.
- **Sending paused.** When the chain's consensus branch is not the one the engine was built for (NU7
  activation before the update ships), the engine refuses to build anything; balances stay visible.

## Claims allowed

- "Neither player sees the other's address, and the game server never sees the addresses,
  amounts or memos of player-to-player payments."
- "Payments are shielded Zcash transactions."
- Mainnet: "The game server can check the project fee, never the amount you send a player or anyone's address."
  — only for a recipient with an Orchard-family receiver (every Stage-2 client). A payment to a stale Stage-1 page's
  `zs1…` funded from Ironwood makes the amount public on chain: the confirmation card then says so
  and does not make this claim.

## Claims not allowed

- "Anonymous" or "untraceable" payments: the participants know each other's nicknames, and the
  server sees that a request happened.
