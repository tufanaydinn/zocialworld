# ADR-013: Private player-to-player ZEC ("Send ZEC" in the player menu)

## Status

Accepted (2026-10-06) for testnet/regtest. Extended to mainnet by ADR-018 (2026-10-08).

The design in one sentence: the recipient accepts → the recipient's wallet sends its address
end-to-end encrypted to the sender's wallet → the address is never shown on any screen and the server
can't see it; the wallet can't make a fresh address per request, so the sender's wallet technically
knows the address but never displays it.

> **Mainnet transfer fee: see ADR-018 § 6.** ADR-018 (accepted 2026-10-08) brings this flow to mainnet
> (the Sapling-beta wallet) and adds a project fee of about US$1 per player payment: the server adds a
> fee quote to the acceptance it relays to the sender, ONE transaction pays the recipient and the fee
> output, and the sender reports the txid (`pay_sent`) for a fee-only check. The relayed request also
> declares the sender's per-transaction cap (ADR-018 § 4). The address exchange, the sealing and the
> security code below are unchanged.

## Context

Players should be able to send ZEC to each other from the player menu (Whisper · View Profile ·
Send ZEC) without seeing each other's addresses. Binding rules:

- `docs/privacy/PRIVACY_MODEL.md` forbids any `nickname → address → history` link and any
  "View Wallet" action. Financial actions must not become public social metadata.
- The wallet is the Zcash browser wallet adapter over the vendored WebZjs build. That build can't
  make a new diversified address per request: it has only `get_current_address`.
- The game server is a relay (ADR-005/006). It must not become a payment processor or learn who
  pays whom how much.

## Decision

1. **Consent first.** "Send ZEC" sends a `pay_request` to the recipient, who must Accept.
   Requests from blocked players are declined automatically, and at most three requests can be
   open at once.
2. **Sealed address exchange.** Each side makes a fresh ECDH P-256 key pair per payment; the
   private key is non-extractable. HKDF-SHA-256, salted with the request id, derives an
   AES-GCM-256 key.
   - The recipient seals its receive address; the sender's client unseals it, checks that it is a
     shielded address on the same network (same HRP), and passes it straight to
     `ZcashWalletAdapter.sendShielded`. It is never rendered.
   - After broadcasting, the sender seals `{amount, txid, memo?}` as a `pay_notice`.
3. **Relay with rules, not content** (`apps/server/src/payments.ts`).
   - The server forwards `pay_accept` / `pay_decline` only from a request's recipient to its
     sender, and `pay_notice` only after acceptance, from sender to recipient. So nobody can push
     sealed data to a player who never asked.
   - Requests expire after 5 minutes (30 for the notice), with a per-session rate limit (burst 3,
     then one per 10 seconds).
   - Fields are opaque base64 with size caps, and nothing is logged.
4. **Security code.** Both cards show four emoji derived from the two public keys. A relay that
   swapped keys (a man-in-the-middle) would produce different codes, so players can compare them
   by voice or chat.
5. **Wallet requirements.** Both players need an unlocked wallet; the memo is optional and at most
   512 bytes.

## Consequences

- **Server:** neither the server nor other players see an address, amount or memo. The server
  sees only that session A sent a request to session B (and when), in memory, briefly.
- **Recipient's address:** the sender's wallet learns it, because that is unavoidable for any
  payment. It is never displayed. Because WebZjs reuses one address, a sender who digs through
  devtools could recognise the same recipient in a later payment; it reveals nothing on-chain
  (shielded) and nothing to anyone else. Fresh diversified addresses per request (needs a WebZjs
  binding) would remove this — recommended follow-up.
- **Chain:** a public chain observer sees an Orchard/Sapling shielded transaction — no sender,
  recipient, amount or memo.
- **Malicious relay:** it can deny service, or swap keys to read the address (mitigated by the
  security code). It cannot redirect funds unnoticed if the codes are compared.
- **Network:** the vendored test-network WebZjs build treats "test" as **regtest** (a
  project-run NU6.1 regtest chain: the public testnet moved to NU6.2, whose Orchard circuit that
  build can't prove for). On the test network, payments work on a regtest chain the operator runs,
  not on the public testnet.
