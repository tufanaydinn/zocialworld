# Privacy model

The privacy rules below are binding project-wide. Each system that handles player data has its own
threat model in this directory (§ 7): what the system sends, stores and logs, and what the server, other
players and third parties learn from it. A system does not ship without its threat model, and no privacy
claim is made that a threat model here does not back.

## 1. Social identity separation

Public/social identity **may** include:

```text
nickname
avatar
bio
badges
project affiliation
presence
```

Public/social identity **must not automatically expose**:

```text
wallet address
wallet balance
transaction history
financial activity history
```

No feature may create a public identity relationship like:

```text
nickname -> wallet address -> chain history
```

As a binding rule: a user's nickname (social identity) must never be automatically
linkable to a wallet address (financial identity). No UI, API, or data
model anywhere in this project may expose that mapping by default.

## 2. Shielded ZEC payments

ZEC payments, support and donations are privacy-preserving by design,
not by accident:

- Support/donation/payment flows use shielded ZEC wherever technically
  possible.
- Donor wallet identity must not become public social metadata by
  default.
- Recipient/project pages must not publicly expose the donor's wallet
  address.
- Public acknowledgement of a donor's social nickname must be explicit
  opt-in, never automatic.
- Wallet balance must not be exposed to project owners or other users.
- Transaction history must not become a social profile feature.

**No "fully anonymous" or "untraceable" claim may be made.** Exact
privacy claims must be backed by the payment threat models (§ 4) —
precise claims only, such as "public wallet addresses are not
displayed" or "supports shielded ZEC payments".

## 3. The wallet: a browser adapter, not a new wallet

The in-game wallet is a Zcash browser wallet adapter over the vendored WebZjs engine (WebAssembly),
rather than a newly invented wallet implementation:

```text
Social World
    |
Wallet Adapter (apps/web/src/zcash/ZcashWalletAdapter.ts)
    |
WebZjs wallet engine (WebAssembly, in the browser)
    |
Game server's wallet bridge (keeps player IPs from the lightwalletd operator)
    |
Zcash Network
```

The seed is generated and kept encrypted in the player's browser. The game server never sees it, and
no other player sees an address, balance or history. Details: `ZCASH_WALLET_THREAT_MODEL.md`.

## 4. Payment threat model requirement

Every payment feature has a document in this directory answering:

```text
What does the sender learn?
What does the recipient learn?
What does the application server learn?
What does the wallet layer learn?
What does a public chain observer learn?
What identifiers are stored?
What metadata is logged?
How long is it retained?
Can social identity and financial identity be correlated?
```

No payment-related privacy claim may ship without this review. The
wallet and player payments answer it in `ZCASH_WALLET_THREAT_MODEL.md`
and `PLAYER_PAYMENTS_THREAT_MODEL.md`; owned names in
`IDENTITY_THREAT_MODEL.md`.

## 5. Network / IP privacy

Multiplayer infrastructure (and any other networked system) must
minimize unnecessary collection and exposure of:

```text
IP addresses
device identifiers
session metadata
persistent fingerprints
precise location
```

Binding requirements:

- Never expose IP information in UI/API/social profile.
- Do not store IP addresses longer than operational/security needs
  require.
- Avoid persistent device fingerprinting unless there is a documented
  abuse-prevention need.
- Analytics should be privacy-minimized by default.

These rules apply to the game server (`apps/server`) and every other
networked system. `MULTIPLAYER_THREAT_MODEL.md` records how the server
meets them.

## 6. Voice-specific privacy requirements

See `VOICE_THREAT_MODEL.md` and ADR-007 for the full detail. Summary:
never adopt raw peer-to-peer WebRTC blindly (evaluate TURN/relay/SFU first,
specifically to avoid exposing participants' IP addresses to each
other), minimize network metadata exposure, document voice provider
data retention, require explicit user-controlled microphone access, and
never activate a microphone silently.

## 7. Threat models

Each system that handles player data has a privacy review in this directory:

| System | Threat model |
|---|---|
| Multiplayer networking (presence, the game server, moderation's keyed connection hash and what moderators see) | [MULTIPLAYER_THREAT_MODEL.md](MULTIPLAYER_THREAT_MODEL.md) |
| Social identity and nearby interaction | [SOCIAL_IDENTITY_THREAT_MODEL.md](SOCIAL_IDENTITY_THREAT_MODEL.md) |
| Identity: wallet holders, owned names (fee-confirmed registration, name key, the server's persistence, `bannedUntil`) | [IDENTITY_THREAT_MODEL.md](IDENTITY_THREAT_MODEL.md) |
| Proximity voice and screen sharing | [VOICE_THREAT_MODEL.md](VOICE_THREAT_MODEL.md) |
| Chat (general, nearby, whispers, hall chat) | [CHAT_THREAT_MODEL.md](CHAT_THREAT_MODEL.md) |
| Watch Hall (stage sharing, hall audio, watch catalogue, personal YouTube player, stage moderation) | [WATCH_HALL_THREAT_MODEL.md](WATCH_HALL_THREAT_MODEL.md) |
| Project discovery | [PROJECT_DISCOVERY_THREAT_MODEL.md](PROJECT_DISCOVERY_THREAT_MODEL.md) |
| The in-game Zcash wallet (pools, keys on the device, the page's CSP, the wallet bridge, lightwalletd) | [ZCASH_WALLET_THREAT_MODEL.md](ZCASH_WALLET_THREAT_MODEL.md) |
| Private player payments, the transfer fee and the cap | [PLAYER_PAYMENTS_THREAT_MODEL.md](PLAYER_PAYMENTS_THREAT_MODEL.md) |
| Analytics | None: the project has no analytics. One is required before any is added. |

Moderation (report, chat mute, kick, ban, per-IP connection cap, LiveKit publisher revoke; ADR-019) is
covered across the multiplayer, identity, chat, voice and Watch Hall threat models.

**Mainnet (ADR-018).** A mainnet deployment is an invited,
real-money beta of an **unaudited** wallet: consent step, a 0.01 ZEC
per-transaction cap; the Stage-2 wallet pays and receives in
every shielded pool (Ironwood, Sapling, legacy Orchard spends) and withdraws to
`t1…`/TEX addresses with a public-amount warning. Server-side facts that are new
and documented in the threat models above: the game server holds the
fee/registry account's **viewing key** (never its seed); on a
fee-charging server it holds a **txid linked to two nicknames**
(`pay_sent`) — in memory, for the fee check only, never stored, logged or
shown; and on **any** mainnet server the wallet bridge, which runs in the
game server process, carries each player's transparent (`t1…`) addresses on
every sync, every broadcast and every memo or status lookup by txid, from
the same IP as the player's nicknamed session — so the operator *could*
link a relayed payment to its transaction by timing, fee or no fee
(`PLAYER_PAYMENTS_THREAT_MODEL.md` § Mainnet; nothing logs or matches it).
The bridge talks to a public lightwalletd (`zec.rocks` by default), which
sees the server's IP, never a player's. `ZCASH_WALLET_THREAT_MODEL.md`
§ Mainnet covers the wallet layer (pools, keys on the device, the page's
CSP, what the bridge and lightwalletd learn); the name registry stores
only keyed note hashes on mainnet (`IDENTITY_THREAT_MODEL.md` § 2, § 12).

**What the game server persists.** `IDENTITY_THREAT_MODEL.md` records the only data the game server
persists: the owned-name registry file (name, name-key hash and public
key, the owner's character, two timestamps; never an address, amount or
txid). Its retention and deletion-on-request policy is there (§ 3).
Moderation (ADR-019) adds one field to it, `bannedUntil` (a ban of 24 hours
or more on an owned name; no reason or moderator), and keeps in memory, never
logged, a per-process keyed hash of each connection's network address (HMAC
under a random start-up key; at most 24 hours from when it was seen in any
kick, ban, mute or action taken from a report) — § 5's
"store IP addresses no longer than security needs require" applied: the raw
address is never stored at all. Reports (the last 100, ≤ 24 h) show moderators
the reporter's nickname, which the report dialog says.
Everything else on the server is in memory only.

Each threat model covers what its system actually does. It is not a blanket clearance for future
features built on the same transport: a new feature that changes what is sent, stored or learned
updates the relevant threat model in the same change.

## Rule

No privacy marketing claim ("anonymous", "untraceable", "the server
knows nothing") may be made until the corresponding document here
proves it.
