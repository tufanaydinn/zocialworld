# Multiplayer Protocol — v1

Single source of truth for the client ↔ server WebSocket protocol.
The message types themselves live in `packages/shared/src/multiplayer-protocol.ts`
and are imported directly by both `apps/server` and `apps/web` (see
`docs/decisions/ADR-006-shared-multiplayer-protocol-contracts.md`) — there
is one declaration, not two. Environment-specific parsing/validation
(`apps/server/src/protocol.ts`, `apps/web/src/networking/protocol.ts`)
stays local to each app. If you change a message shape, update
`packages/shared`, both apps' parsing code, and this document in the
same commit.

This is a **social-presence** protocol, not a competitive-game protocol.
It carries only what's needed for players to see and hear about each
other's presence in the world — never wallet data, never raw input,
never more identity than a temporary session needs. The one exception,
approved in ADR-015, is a single boolean per player,
`canReceive` ("can receive ZEC privately"), which separates wallet
holders from guests — see § Identity: wallet holders and guests. No
address, balance, network, lock state or unlock time is ever on the wire.

## Transport

Plain WebSocket (`ws://` in development; `wss://` in any real
deployment, behind a TLS reverse proxy). One text (JSON) message per frame.
No binary framing in v1 — payloads are tiny and JSON keeps this easy to
debug; revisit only if measured bandwidth demands it.

## Message envelope

Every message is a JSON object with a `type` field:

```ts
type Message = { type: string; [key: string]: unknown };
```

The server validates `type` against a known allow-list and drops
anything else (§ Server-side validation below).

## Client → Server

### `join`

Sent once per connection — since ADR-015 **not** on socket open but when
the player leaves onboarding (`NetworkClient.join()`); a reconnect sends
it again at once, with the same identity (§ Reconnecting).

```ts
{
  type: "join";
  nickname?: string;      // a holder's name, or a guest's previous Guest-#### (reconnect); see § Identity
  avatar?: PlayerAvatar;  // ADR-015: a holder's chosen look; ignored for guests; invalid = missing
  wallet?: boolean;       // ADR-015: "this session has an in-game wallet" → canReceive (must be a boolean)
}
type PlayerAvatar = { model: "rogue_hooded" | "rogue" | "knight" | "mage" | "barbarian"; color: number /* 0–7 */ };
```

Before `join` the server answers only `heartbeat` (nothing) and
`nickname_check` (§ Identity); everything else from a connection that
has not joined is dropped.

### `player_transform`

Sent at the client's publish rate (§ Network rate). Represents the
*sender's own* transform — the server relays it to everyone else, it is
never used to move another player.

```ts
{
  type: "player_transform";
  x: number;
  y: number;
  z: number;
  rotationY: number;      // radians, yaw only — a third-person character
                           // never needs pitch/roll networked
  animationState: "idle" | "walk" | "jog" | "sit" | "wave" | "talk" | "dance" | "cheer";
  seq: number;             // monotonically increasing per-client sequence number
}
```

`dance` and `cheer` (ADR-014 § 10) are emote-wheel states,
like `wave`: the player stays where they are, moving ends them, and a
seated player keeps their seat (only `walk`/`jog` auto-release it, § Watch
Hall). A client older than them drops transforms carrying them, so all
clients ship together. Raised hands and reactions are not animation
states — they are hall messages (`hall_hand`, `hall_react`).

Deliberately **not** included: camera position/orientation,
mouse input, raw keyboard input, wallet/address/balance fields.

### `heartbeat`

```ts
{ type: "heartbeat" }
```

Sent periodically (every 5s client-side) so idle players — standing
still, sending no `player_transform` — still count as alive. See
"Heartbeat & stale-connection cleanup" below for why this is
application-level rather than relying on WebSocket protocol ping/pong.

### `set_nickname`

Requests a nickname change for the sender's own session, at any point
after `join` completes.

```ts
{
  type: "set_nickname";
  nickname: string;
}
```

The server is authoritative (§ Nickname validation and conflict
resolution below) — the accepted value (possibly different from what was
requested) arrives back via `nickname_updated`, never as a direct reply
to this message. An invalid request is dropped silently; the session
keeps its current nickname. ADR-015: only wallet holders may rename — a
guest's request, a reserved name and a request beyond the rename limit
(burst 3, then one per 10 s) are dropped the same silent way.

ADR-016: `set_nickname` is honoured **only without a name registry**
(`NAME_REGISTRY=off`, ADR-015's honour mode). While a registry runs, a
holder's name changes only through a confirmed registration or a claim
(§ Owned names), and `set_nickname` is dropped like an invalid request.
The choice keeps one rule per server: either every chosen name is on the
honour system, or every chosen name is owned — never a mix in which a
free rename could take a name someone paid to confirm.

### `set_wallet`, `set_avatar`, `nickname_check` (ADR-015)

```ts
{ type: "set_wallet"; connected: boolean }   // the wallet-holder flag changed (sticky; false only on "Forget this wallet")
{ type: "set_avatar"; avatar: PlayerAvatar } // a holder changes character (dropped for guests)
{ type: "nickname_check"; nickname: string } // is this name free? (allowed before join; reserves nothing)
```

Rules, answers and limits: § Identity: wallet holders and guests.

### `name_reserve`, `name_claim_request`, `name_claim_proof` (ADR-016)

```ts
{ type: "name_reserve"; nickname: string; keyHash: string }            // reserve a name for a name key (64 hex)
{ type: "name_claim_request"; nickname: string }                       // a returning player asks for a challenge
{ type: "name_claim_proof"; nickname: string; publicKey: string; signature: string; alg: "ed25519" | "p256" }
{ type: "name_payment_sent"; reservationId: string; txid: string }    // the name-fee txid (64 lowercase hex)
```

Answered before and after join. Rules: § Owned names. `name_payment_sent`
(ADR-018 § 5) is read only by the `lightwalletd` registry backend; nothing
is answered (progress comes as `name_status`).

## Server → Client

### `welcome`

Sent once, immediately after the server accepts a `join`.

```ts
{
  type: "welcome";
  playerId: string;    // server-assigned temporary session id (crypto.randomUUID())
  nickname: string;     // the accepted nickname (server-assigned if the client didn't send one)
  colorSeed: number;    // 0-359, deterministically derived from playerId — see "Color variation"
  avatar: PlayerAvatar; // ADR-015: the accepted look (the colorSeed default for a guest)
  canReceive: boolean;  // ADR-015: the accepted wallet-holder flag
  tickRateHz: number;   // informational: the rate the server expects transforms at
  voiceCapability: string; // owner-only session credential (see below)
  build?: string;       // ADR-018 § 7: the id of the client build this server serves
}
```

`build` is the id the web build wrote to `dist/build-id.txt`
(or the server's `BUILD_ID`). A client running another build shows
"Update ready — reload" and reloads only between actions. The same id is
served at `GET /version` → `{ "build": string | null }` (CORS as the other
`/zcash` endpoints), which clients also poll every 10 minutes. Absent in
development.

`voiceCapability` is a cryptographically
random, session-scoped credential. The session's owner exchanges it at
`POST /voice/token` (and the regtest faucet) for something minted with the
server's own `playerId`/nickname — the server never trusts a
client-supplied identity there. It is **owner-only**: `welcome` goes only
to the connecting session, and no broadcast or peer-visible message may
ever carry it. It is revoked on disconnect or stale cleanup; a reconnect
gets a fresh one. See `docs/privacy/VOICE_THREAT_MODEL.md` § Voice
capability authentication.

### `player_snapshot`

Sent once, immediately after `welcome`, listing every player already in
the world so the new client can construct their `RemotePlayer`s without
waiting for individual `player_joined` events.

```ts
{
  type: "player_snapshot";
  players: Array<{
    playerId: string;
    nickname: string;
    colorSeed: number;
    avatar: PlayerAvatar;  // ADR-015
    canReceive: boolean;   // ADR-015: the only wallet-derived bit any peer receives
    moderator?: true;      // present only for a moderator (the nameplate tag)
    x: number; y: number; z: number;
    rotationY: number;
    animationState: AnimationState;
  }>;
}
```

The web client fills a missing or malformed `avatar` with the colorSeed
default and a missing `canReceive` with `false`, rather than dropping the
entry — one bad entry used to discard the whole snapshot.

### `player_joined`

Broadcast to every *other* connected client when a new player completes
`join`.

```ts
{
  type: "player_joined";
  playerId: string;
  nickname: string;
  colorSeed: number;
  avatar: PlayerAvatar;  // ADR-015
  canReceive: boolean;   // ADR-015
  moderator?: true;
  x: number; y: number; z: number;
  rotationY: number;
  animationState: AnimationState;
}
```

### `player_left`

Broadcast to every remaining client when a player disconnects (clean
close, abrupt close, or stale-connection cleanup — same message either
way; clients don't need to distinguish the reason).

```ts
{ type: "player_left"; playerId: string }
```

### `player_transform`

The relay of another player's `player_transform`. Same shape as the
client → server version, plus the sender's `playerId` and the server's receive timestamp. The
server timestamp is retained as protocol metadata/diagnostics; the
current client interpolation buffer does **not** use it as its clock.
The client deliberately timestamps interpolation samples with local
receive time (`performance.now()`) because there is no server/client
clock synchronization — see § Interpolation strategy below:

```ts
{
  type: "player_transform";
  playerId: string;
  x: number; y: number; z: number;
  rotationY: number;
  animationState: AnimationState;
  seq: number;
  t: number; // server receive time, ms since epoch; not the current interpolation clock
}
```

The server **never** echoes a client's own transform back to itself —
only to the other connected clients.

### `nickname_updated`

Broadcast to **every** joined client, including the renaming client
itself, whenever a session's nickname changes via `set_nickname`. The
initial nickname accepted at `join` does **not** trigger this — it
arrives in `welcome`/`player_snapshot`/`player_joined` as usual; this
message only fires for a later change.

```ts
{
  type: "nickname_updated";
  playerId: string;
  nickname: string; // the server-accepted value — may differ from what was requested, see below
}
```

ADR-015: also sent when "Forget this wallet" turns a holder back into a
guest (a fresh `Guest-####`).

### `avatar_updated`, `can_receive_updated`, `nickname_check_result` (ADR-015)

```ts
{ type: "avatar_updated"; playerId: string; avatar: PlayerAvatar }          // to everyone, incl. the player
{ type: "can_receive_updated"; playerId: string; canReceive: boolean }      // to everyone, incl. the player
{ type: "nickname_check_result"; nickname: string; status: "available" | "taken" | "invalid" | "reserved"; suggestion?: string } // to the asker only
```

### `name_quote`, `name_status`, `name_challenge` (ADR-016)

```ts
{ type: "name_quote"; reservationId: string; nickname: string; address: string; amountZat: number; memo: string; expiresAt: number }
{ type: "name_status"; status: NameStatus; reservationId?: string; nickname?: string }
{ type: "name_challenge"; nonce: string; nickname: string }
```

All three go to the asking session only — never broadcast. Rules: § Owned names.

## Identity: wallet holders and guests (ADR-015)

**Two kinds of players.** A *wallet holder* is a session whose in-game
wallet reached `ready`/`syncing` at least once this page session; the
flag is sticky (it survives locking and is cleared only by "Forget this
wallet"), and the client sends it as `join.wallet` / `set_wallet`. The
server keeps it as `canReceive` and shows it to peers. Everyone else is a
*guest*. The flag is **client-asserted** (honour system) until ADR-016's
fee-confirmed names; a modified client can claim it, but cannot steal or
redirect money — payments still need the recipient's own wallet to seal
its own address (ADR-013).

| | Guest | Wallet holder |
|---|---|---|
| Name | server-assigned `Guest-####`; cannot rename | chooses one: `join.nickname` / `set_nickname` without a registry; with one (ADR-016), a fee-confirmed or claimed owned name (§ Owned names) |
| Character | the colorSeed default; `join.avatar` and `set_avatar` are dropped | chooses one (`join.avatar`, `set_avatar`) |
| ZEC | cannot send or receive (`sender_no_wallet` / `no_wallet`) | sends and receives privately (ADR-013) |
| Voice | listen-only token (nearby voices + the stage); full token refused with 403 `wallet_required` | full token (talk, present) |
| Text chat, whispers, hall | yes | yes |

**Join rules** (`WorldServer.handleJoin`):
- `canReceive = join.wallet === true`.
- A requested `Guest-####` that is still free is kept by anyone (a guest's
  number survives a reconnect).
- Otherwise a holder gets the requested name — sanitized, not reserved,
  with today's `-2` suffix on a collision; a guest (or an invalid/reserved
  request) gets a fresh free guest number — never `Guest-1234-2`.
- ADR-016, while a name registry runs: a holder gets the owned name its
  connection confirmed or claimed before joining, else a Guest-style name
  — a requested name alone is never granted (§ Owned names).
- A holder's valid `join.avatar` is kept; everyone else gets
  `defaultPlayerAvatar(colorSeed)` (`@project/shared`): model
  `PLAYER_AVATAR_MODELS[colorSeed % 5]` — the same model the web client
  derived before ADR-015 — and colour `colorSeed % 8`.

**`set_wallet`.** `false → true`: `can_receive_updated` to everyone.
`true → false`: a fresh `Guest-####` (`nickname_updated`), the default
avatar (`avatar_updated`, if it changed), then `can_receive_updated`. The
same value again does nothing. Pending payment requests are left to
expire (`payments.forget()` would also reset the sender's payment rate
limit).

**`set_avatar`.** Holders only; broadcast as `avatar_updated` to everyone
including the sender. The colour is a palette index (0–7); the colours
live in the web client (`player/avatarPalette.ts`: eight hues at the old
accent's saturation/lightness, skipping the ZEC-gold band). The KayKit
models share one atlas material, so the colour is an accent (placeholder
belt and hat, nameplate underline, menu chip), never a tint on the model.

**`nickname_check`.** Answered before and after join, to the asker only:
`invalid` (fails the shape rules), `reserved`, `taken` (with the name the
server would give instead, e.g. `Alice-2`) or `available`. It reserves
nothing and is never logged. `nickname` echoes the request so a client
can match the answer to what its input holds now.

**Payments.** `pay_request` from a guest → `pay_error{sender_no_wallet}`;
to a guest → `pay_error{no_wallet}`. Both are checked before the relay,
so a refused request spends no rate token and nothing reaches the other
player.

**Limits** (per session, token buckets, `IDENTITY_LIMITS` in
`WorldServer.ts`; a refused request is dropped silently):

| Message | Burst | Refill |
|---|---|---|
| `set_nickname` | 3 | 1 per 10 s |
| `set_wallet` | 2 | 1 per 60 s |
| `set_avatar` | 3 | 1 per 20 s |
| `nickname_check` | 5 | 1 per s |

**Onboarding.** The client opens the socket at startup but joins only
when onboarding finishes: Welcome ("Connect a wallet" / "Continue as
guest") → wallet (the existing wallet panel) → character (holders) →
nickname (holders; `nickname_check` while typing) → Enter. How a holder's
chosen name is applied depends on the server (GET `/zcash/info` →
`names.mode`): without a registry (`off`) it is a `set_nickname` after the
join; with one (`fee`) it is confirmed (or claimed) during onboarding,
**before** the join, and the join gives it (§ Owned names); while the
registry is `disabled`, holders keep Guest-style names. The device
remembers the character and, for holders, the name (`player-profile-v1`);
never a guest number.

## Owned names (ADR-016)

A wallet holder confirms a name with a small shielded payment to the
game's name registry, on the project's test chain only. The payment
carries a memo that binds it to a reservation and to the holder's **name
key**: a key pair derived from the wallet seed with HKDF-SHA-256, info
`zocial-world/name-key/v1/<network>` (Ed25519, or ECDSA P-256 where the
browser lacks Ed25519). The name key is not an address. The name is then
owned by that key: a returning player proves the key and gets the name
back without paying. Privacy, storage and abuse:
`docs/privacy/IDENTITY_THREAT_MODEL.md`.

**Modes** (server env `NAME_REGISTRY`; GET `/zcash/info` tells clients
`names: { mode: "off" | "fee" | "disabled", feeZat }` — never the address):

| Server | Clients see | Holders' names |
|---|---|---|
| `off` (default) | `off` | ADR-015 honour mode: `set_nickname`, not owned, nothing stored |
| `dev` (development and tests; refuses `NODE_ENV=production`) | `fee` | fee flow; every reservation is "paid" and confirmed after ~2 s; quotes carry the placeholder `zw-dev-registry`, which clients never pay |
| `zcashd` (test chain) | `fee` | fee flow against real payments, seen through zcashd's `z_listreceivedbyaddress` |
| `zcashd` without address or RPC | `disabled` | Guest-style names; the client says why |
| `lightwalletd` (ADR-018 § 5; the mainnet backend) | `fee` | fee flow: the client reports its txid (`name_payment_sent`); the server fetches that transaction through its own lightwalletd connection and decrypts it with `NAME_REGISTRY_UFVK` |
| `lightwalletd` without address, key, bridge, or (mainnet) `NAME_REGISTRY_MAINNET_ACK=accepted` | `disabled` | Guest-style names; the startup log says why |

**Registration** (`name_reserve` → `name_quote` → payment → `name_status`):

1. The client sends `name_reserve { nickname, keyHash }`. `keyHash` is the
   SHA-256 of the name key's raw public key, 64 lowercase hex.
2. The server answers the asker only, with one of:
   - `name_quote { reservationId, nickname, address, amountZat, memo, expiresAt }`,
     followed by `name_status { reservationId, status: "pending" }`;
   - a refusal, `name_status { nickname, status }`, where `status` is
     `taken`, `invalid`, `disabled` (no registry, or a joined guest) or
     `rate_limited`.

   `nickname` in the quote is the sanitized display name. `memo` is
   `zw-name:v1:<nonce>:<first 16 hex of keyHash>` (a ZIP 302 text memo,
   60 bytes, 16 random nonce bytes).
3. The client checks the quote before its wallet pays anything:
   - the memo carries its own key-hash prefix;
   - `amountZat` equals the advertised fee and is at most
     `NAME_FEE_MAX_ZAT` (0.1 ZEC);
   - the address is a test-chain shielded address — on a mainnet build,
     a mainnet shielded address with a Sapling receiver
     (`u1…` / `zs1…`). The wallet adapter also applies the beta cap.
   - After its wallet broadcast the payment, the client sends
     `name_payment_sent { reservationId, txid }` (any backend; only
     `lightwalletd` reads it). The server accepts it only from the session
     the reservation is bound to, at most three txids per reservation, and
     drops them when the reservation ends. It stores no txid (only the
     one-way note hash, as before).

   It then pays `amountZat` to `address` with `memo` from the in-game
   wallet (`ZcashWalletAdapter.sendShielded`). The address is never
   displayed. The dev placeholder is never paid.
4. Progress goes to the session bound to the reservation, as
   `name_status { reservationId, nickname, status }`:
   - `seen`: a matching payment arrived;
   - `confirmed`: the name is owned now; a joined holder's new name is
     broadcast with the existing `nickname_updated`;
   - `expired`: no matching payment within 30 minutes.

   A payment matches when all four hold:
   - its memo has the reservation's nonce and key-hash prefix;
   - its value is at least the fee;
   - it has the required confirmations (`zcashd`: 0, as ADR-016 accepts
     0-conf on the test chain; `dev`: 1);
   - its note (`txid:pool:outindex`) was never used before.

   A seen payment gets one more 30 minutes to collect its confirmations.
   A payment that arrives after expiry is consumed (it is never reused)
   and answered with `expired` again.

**Reservations:**
- A name is free only if three things hold:
  - nobody has registered it (registered names are `taken` even for their
    owner, who claims instead of paying again);
  - no other key has it reserved;
  - no other joined session shows it.
- Names follow ADR-015's rules (NFKC, case-insensitive). The Guest
  pattern and system words are reserved (`invalid`).
- Asking again with the same key for the same name returns the **same**
  reservation, re-bound to the asking session (a reload or reconnect must
  never cause a second payment).
- There is one pending reservation per session and per key: a new name
  replaces an unpaid one, never one whose payment was seen. The replaced
  one is answered `expired`, and a payment that still arrives for it is
  consumed.
- At most 256 reservations are pending server-wide.
- Reservations live in memory only; a server restart drops them.
- `nickname_check` answers `taken` for registered and reserved names too.

**Claims** (a returning player, no payment):
1. The client sends `name_claim_request { nickname }`.
2. The server answers `name_challenge { nonce, nickname }`: 16 random
   bytes in hex, bound to the asking session, single use (any proof
   consumes it), valid for 2 minutes. It is issued for any valid name,
   registered or not.
3. The client sends `name_claim_proof { nickname, publicKey, signature, alg }`.
   `signature` is base64url, over the UTF-8 string
   `zocial-world/name-claim/v1:<nonce>:<nickname>`. `publicKey` is the raw
   key in base64url (Ed25519: 32 bytes; P-256: the 65-byte uncompressed
   point).
4. The server answers `name_status { nickname, status: "confirmed" | "failed" }`.
   `confirmed` requires that:
   - the key hashes to the registered `keyHash`;
   - the signature verifies (WebCrypto in Node);
   - after the first claim, the key is the one remembered.

   On `confirmed`, `nickname` is the registered display name.
- A claim by the owner's newer session moves the name there: the older
  session gets a fresh Guest name (`nickname_updated`).

**Before join:**
- `name_*` requests are answered before `join`: onboarding confirms or
  claims a name before the player exists for anyone.
- The connection remembers the owned name; a holder's `join` then gets
  it, whatever `join.nickname` asked for.
- A connection that joins as a guest drops it. The name stays registered
  to the key.
- While a registry runs, a holder without an owned name joins with a
  Guest-style name.
- After join: holders only. A guest's request is answered `disabled`.
  `set_wallet false` ("Forget this wallet") drops the session's owned name
  (fresh Guest name, as before).

**Faucet before join.** `POST /zcash/faucet` accepts, as its `capability`,
the connection's pending `reservationId`. A new player can then get test
coins for the fee during onboarding, before `welcome` hands out the session
capability. The same faucet limits apply.

**Limits** (per session, token buckets; a refused request is answered
`name_status { status: "rate_limited" }`):

| Message | Burst | Refill |
|---|---|---|
| `name_reserve` | 3 | 1 per 20 s |
| `name_claim_request` | 5 | 1 per 10 s |

**Privacy.** Every name answer goes to the asking session only. Peers see
only the resulting `nickname_updated`. Nothing about names or payments is
logged. The registry address is never logged and never shown in the UI.
Persistence (the registry file) and what the server learns from payments:
`docs/privacy/IDENTITY_THREAT_MODEL.md`.

## Text chat

### `chat_send` (client → server)

```ts
{ type: "chat_send"; channel: "general" | "nearby" | "hall"; text: string }
```

- `general` reaches every joined player in this world instance.
- `nearby` reaches every joined player whose last known position is within
  `NEARBY_CHAT_RADIUS_METERS` (20 m, 3D) of the sender's — so the Learning
  Valley (x ≈ 1000) and the district never hear each other's nearby chat.
- `hall` reaches only Watch Hall members (§ Watch Hall). A
  sender who is not a member gets `chat_rejected{not_in_hall}`; membership
  is checked **before** the line spends a chat token. Clients show hall
  lines in the Hall tab, never as speech bubbles.

### `whisper_send` (client → server)

```ts
{ type: "whisper_send"; to: string /* recipient playerId */; text: string }
```

Delivered only to the recipient, plus an echo to the sender.

### `chat_message` (server → client)

```ts
{
  type: "chat_message";
  channel: "general" | "nearby" | "hall" | "whisper";
  messageId: string;          // server-assigned
  fromPlayerId: string;
  fromNickname: string;
  toPlayerId?: string;        // whisper only
  toNickname?: string;        // whisper only
  text: string;
  t: number;                  // server receive time, display only
}
```

The sender receives its own accepted lines too, so a client shows exactly
what the server accepted.

### `chat_rejected` (server → sender only)

```ts
{ type: "chat_rejected"; reason: "rate_limited" | "empty" | "too_long" | "unknown_recipient" | "self" | "not_in_hall" }
```

An unknown `channel` is not rejected but dropped silently, like any other
malformed frame.

### Rules (`apps/server/src/chat.ts`)

- **Sanitizing:** whitespace is collapsed and trimmed; C0/C1 control
  characters, bidi overrides/isolates and zero-width characters are
  removed. Empty → `empty`; over `MAX_CHAT_LENGTH` (200) characters →
  `too_long`.
- **Rate limit:** a per-session token bucket, a burst of 5 refilling at
  one message every 2 s, on top of the generic 30 messages/s limit.
- **No storage:** lines are relayed and forgotten. The server never logs
  chat text.
- **Block** stays client-side: a client hides lines from players
  it has blocked; the server is not told.
- **Hall scope**: `hall` lines need Watch Hall
  membership, checked before the rate limit (§ Watch Hall).

## Private payments (ADR-013)

The server **relays** a sealed handshake between two sessions so players
can send ZEC without seeing each other's addresses
(`docs/decisions/ADR-013-private-player-payments.md`,
`docs/privacy/PLAYER_PAYMENTS_THREAT_MODEL.md`). The recipient's address
and the payment notice travel end-to-end encrypted between the two
browsers (ECDH P-256 → HKDF-SHA-256 → AES-GCM-256); every key, ciphertext
and IV is opaque base64 to the server, which never sees an address, amount
or memo.

### Client → server

```ts
{ type: "pay_request"; to: string /* recipient playerId */; requestId: string; senderKey: string; capZat?: number /* mainnet: the sender's declared cap */ }
{ type: "pay_accept"; requestId: string; recipientKey: string; sealed: string; iv: string }
{ type: "pay_decline"; requestId: string; reason: "declined" | "no_wallet" | "busy" | "expired" | "failed" }
{ type: "pay_notice"; requestId: string; sealed: string; iv: string }
{ type: "pay_sent"; requestId: string; txid: string /* 64 lowercase hex */ } // fee-bearing payments only
{ type: "pay_cancel"; requestId: string } // the sender withdraws its own request
```

Shape limits (`apps/server/src/protocol.ts`): `requestId` matches
`/^[A-Za-z0-9_-]{8,40}$/`; `senderKey`/`recipientKey` are base64 of at most
`PAY_KEY_MAX` (120) characters, `sealed` at most `PAY_SEALED_MAX` (1600),
`iv` at most 32; `to` is 1–64 characters. Anything else is dropped
silently.

### Server → client

The relayed message carries the counterpart's session id, plus the
current nickname on a request and a notice:

```ts
{ type: "pay_request"; from: string; fromNickname: string; to: string; requestId: string; senderKey: string }
{ type: "pay_accept";  from: string; requestId: string; recipientKey: string; sealed: string; iv: string; fee?: { address: string; zat: number; nonce: string } }
{ type: "pay_decline"; from: string; requestId: string; reason: PayDeclineReason }
{ type: "pay_notice";  from: string; fromNickname: string; requestId: string; sealed: string; iv: string }
{ type: "pay_cancel";  from: string; requestId: string } // the other side ended the request (cancelled or left)
{ type: "pay_error";   requestId: string; reason: "unknown_recipient" | "self" | "rate_limited" | "unknown_request" | "no_wallet" | "sender_no_wallet" | "over_cap" | "fee_unpaid" } // sender only
```

### Rules (`apps/server/src/payments.ts`)

- ADR-015: payments travel only between wallet holders — a request from a
  guest is `sender_no_wallet`, to a guest `no_wallet`, checked before the
  relay (no rate token spent, nothing reaches the other player).
- A request goes to an existing, different, joined session
  (`unknown_recipient`, `self`); a reused `requestId` is `unknown_request`.
- `pay_accept`/`pay_decline` are forwarded only from the request's
  recipient back to its sender, once; `pay_notice` only after acceptance,
  from the sender to the recipient, and it closes the request. Anything
  else is `unknown_request` — nobody can push sealed data to a player who
  never asked.
- Requests expire after 5 minutes unanswered (30 minutes for the notice
  after acceptance). New requests are rate-limited per session (burst 3,
  then one per 10 s; `rate_limited`), with at most 5000 pending
  process-wide.
- **`pay_cancel`**. Only the request's
  sender may send it, before or after the acceptance; it needs no key. The
  server drops the request (a later answer or notice is `unknown_request`)
  and any transfer-fee entry without a reported transaction — nothing is
  owed — and relays `pay_cancel { from, requestId }` to the recipient if it
  is still there. A `pay_cancel` for a request the relay already forgot is
  still applied to the fee entry. Clients send it for Cancel, for an
  acceptance they refuse (a malformed key or address, a fee quote that does
  not match, a missing quote on a server that advertises a fee), when the
  accepted card expires (`PAY_FEE_DEADLINE_MS` − 5 minutes, so a send never
  lands after the fee deadline), and when the network refused the
  transaction (`broadcast_failed`: nothing was paid).
- **Leaving.** When a session disconnects, each request it was part of is
  forgotten; the other side, if still joined, gets `pay_cancel` with
  `from` = the leaver (the sender's card says "X left — nothing was
  sent", the recipient's "X cancelled"). A fee entry whose RECIPIENT left
  before a `pay_sent` is dropped (nothing can be paid through it any more).
- **The sealed notice.** Its plaintext is `{ status: "sent" | "uncertain" |
  "cancelled", amount?, txid?, memo? }`. `uncertain` means the
  sender's wallet built and signed the transaction but lost the network's
  answer to sending it: it may arrive, and the sender's wallet does not
  retry by itself (that could pay twice). A fee-bearing `uncertain` send
  still reports `pay_sent` with the txid first.
- Nothing is logged; a pending entry holds two session ids and times, and
  is forgotten when either session disconnects.

### Mainnet: the beta cap and the transfer fee (ADR-018 § 4, § 6)

GET `/zcash/info` also tells clients `network: "main" | "test"` and
`payments: { feeZat, capZat, feeUsd }` (`capZat` null without a cap) — never
the fee address. `feeUsd` (and `names.feeUsd` next to `names.feeZat`) is the
operator's approximate US-dollar label of a charged fee (`PAYMENT_FEE_USD`,
`NAME_FEE_USD`), or `null`: the client then shows the
ZEC amount only, never an assumed price.

- **Cap** (`PAYMENT_CAP_ZEC`: 0.01 ZEC by default on `ZCASH_NETWORK=main`,
  off on the test chain, `off` lifts it). The amount stays sealed between
  the two browsers (ADR-013), so the server checks the cap the sender's
  wallet enforces: a `pay_request` without `capZat`, or with `capZat`
  above the server's cap, is refused with `pay_error{over_cap}` before the
  relay (no rate token spent, nothing reaches the recipient). The relayed
  request does not carry `capZat`. The sender's wallet adapter refuses any
  amount above its cap (`VITE_MAINNET_TX_CAP_ZEC`), so an honest client
  never sends more; a modified client is not stopped by this check.
- **Fee quote.** On a server that charges the transfer fee
  (`PAYMENT_FEE_*`, ADR-018 § 6), the `pay_accept` relayed to the SENDER
  carries `fee: { address, zat, nonce }` — a server-issued field (any `fee`
  in the recipient's own message is dropped by the parser). `nonce` is 16
  random bytes (32 lowercase hex), one per request. The sender's client
  checks it (a mainnet Sapling-capable address, `zat` equal to the
  advertised `payments.feeZat` and at most `PAY_FEE_MAX_ZAT` = 0.01 ZEC) and
  pays the recipient and the fee in ONE transaction: the fee is a second
  shielded output with the memo `zw-fee:v1:<nonce>`.
- **`pay_sent`.** After broadcasting a fee-bearing payment the sender sends
  `pay_sent { requestId, txid }` — before its `pay_notice`. The server
  fetches the transaction through its own lightwalletd connection, waits
  for `PAYMENT_MIN_CONF` (default 1) confirmations, decrypts ONLY the
  outputs its fee viewing key can see (the recipient's output is not one
  of them), and accepts a note with exactly that memo and at least the fee,
  each note once (an HMAC with a per-process key, in memory). Then the
  txid is dropped; it is never stored, logged or shown.
- **No quote, no relay**. A sender holds at most 20 unsettled fee
  entries (`MAX_ENTRIES_PER_SENDER`); when a server that charges the fee
  cannot issue a quote, the acceptance is NOT forwarded fee-free: the
  request is dropped and both the acceptor and the sender get
  `pay_error{rate_limited}` for that `requestId`. A client that sees
  `payments.feeZat > 0` refuses (and cancels) an acceptance without a quote.
- **`fee_unpaid`.** After an acceptance with a fee, the sender owes a
  `pay_sent` (checked as above), a `pay_cancel`, or a `pay_notice` WITHOUT a
  `pay_sent` before it (a cancellation: nothing owed). The sender's further
  `pay_request`s are refused with `pay_error{fee_unpaid}` for the rest of
  the session (the sanction ends with the connection) when: none of those
  arrives within `PAY_FEE_DEADLINE_MS` (30 minutes) — a `pay_sent` (or a
  cancel) that arrives within the following 60-minute verification window
  and checks out lifts that request's sanction; the reported
  transaction is mined without a matching fee output; or a reachable
  lightwalletd still does not know the transaction after the 60-minute
  window AND the chain has passed the transaction's expiry
  (`TX_EXPIRY_BLOCKS` = 41 blocks after the first check). A lightwalletd
  error (unreachable, rate-limited, timed out) never sanctions: the
  check is retried and dropped without a sanction after 6 hours.

## Watch Hall (ADR-014)

The Watch Hall is the third location (`WATCH_HALL_ORIGIN = (-1000, 0)`,
ADR-010). Its server-side state — the stage queue, seats, raised hands,
the floor, reactions and hosts — lives in `apps/server/src/watchHall.ts`, a
pure class with an injected clock; `WorldServer` only routes the messages,
delivers the effects it returns and runs its one lazy timer. Shapes and
constants are in `packages/shared/src/multiplayer-protocol.ts` § Watch
Hall; the design is `docs/architecture/WATCH_HALL.md`; the decision is
`docs/decisions/ADR-014-watch-hall.md`.

### Membership

- Derived from each session's **last pose** (every accepted
  `player_transform`), never from a message: a session becomes a member
  when `|x − (−1000)| ≤ 20` and `|z − 0| ≤ 15`
  (`WATCH_HALL_HALF_EXTENTS`), and stops being one only beyond
  `WATCH_HALL_EXIT_MARGIN_METERS` (2 m) outside that box (hysteresis, so a
  player at the door doesn't flap). New sessions start at the origin pose,
  so nobody is a member at join.
- Entering sends that session `hall_state`. Leaving sends it `hall_exit`
  and drops its queue place, seat, raised hand and floor (the remaining
  members get the deltas). A holder who leaves keeps the stage for
  `HALL_STAGE_LEAVE_GRACE_MS` (15 s).
- **Membership is a social scope, not access control.** Positions are
  client-authoritative (ADR-005); anyone can walk — or teleport — in.

### Client → server

Every request needs a joined session. "Members only" requests from a
non-member get `hall_error{op, "not_in_hall"}`. "Holder or host" means the
current stage holder, or a host who is in the hall.

**Verified identity.** Presenting — requesting the stage,
being granted it (by the queue, a handover or a host) — and receiving the
floor need a **server-verified identity**: while a name registry runs
(`NAME_REGISTRY=dev|zcashd`, § Owned names) an **owned name** the session
confirmed with the fee or claimed with its name key; without one, ADR-015's
client-asserted wallet-holder flag. Anything else is refused with
`identity_required`. The same rule decides whether `/voice/token` mints the
full (publishing) grant (403 `name_required` for a holder without an owned
name; 403 `wallet_required` for a guest, as before). When a session loses
it (`set_wallet{connected:false}`, or its owned name is taken over by the
owner's newer session) it loses its queue place, its turn, the floor and
its vote at once.

**Broadcast budget.** Requests that change shared state and so make the
server broadcast to every member — `hall_stage_request`,
`hall_stage_handover`, a `hall_stage_live{live:true}` that changes
something, `hall_stage_card`, `hall_stage_lock`, `hall_floor` (giving it),
`hall_hand_lower` and `hall_seat_claim` — share one per-session token
bucket (burst `HALL_OP_BURST` = 8, refill 2/s; refused with
`rate_limited`). Requests that only end something (`hall_stage_cancel`,
`hall_stage_stop`, `live:false`, `hall_seat_release`, giving up the floor)
are never limited, and a request that changes nothing (the same card
again, an unchanged live report, lowering a lowered hand) costs no token
and sends nothing.

| Message | Shape | Rule |
|---|---|---|
| `hall_stage_request` | `{}` | Members only. Joins the FIFO queue (`HALL_STAGE_QUEUE_MAX` = 12, else `queue_full`). Idempotent for the holder or a queued player. Allowed while locked. Needs a verified identity (`identity_required`); refused during a stage cooldown (`cooldown`, with `retryInMs`). |
| `hall_stage_cancel` | `{}` | Leaves the queue (`not_queued` if not in it). |
| `hall_stage_stop` | `{}` | The holder ends their turn (also from outside the hall during the grace); a host force-stops the holder. Otherwise `not_holder`. |
| `hall_stage_handover` | `{ to: string }` | Holder or host. `to` must already be queued (`not_queued`) — queuing is the consent. A host inside the hall may also hand over to a member whose hand is raised (raising a hand is the consent), so a queue full of squatters can't keep a presenter off a locked stage. The current turn ends and `to` becomes holder (`preparing`), also while locked. `to` needs a verified identity (`identity_required`); a holder can't pass the turn to a player on a cooldown (`cooldown`), a host may. |
| `hall_stage_live` | `{ live: boolean; audio: boolean }` | Holder only (`not_holder`). `live:true` turns `preparing` into `live` (or updates `audio`); `live:false` after live ends the turn; `live:false` while preparing (a cancelled picker) changes nothing. |
| `hall_stage_card` | `{ card: HallCard \| null }` | Holder or host (a host may set an "up next" card while idle; it stays when the next turn starts). See § Speaker card. Invalid → `invalid`. |
| `hall_stage_lock` | `{ locked: boolean }` | Host only (`not_host`). Unlocking lets the queue advance. The lock is released automatically when the last host session disconnects (the host role is session-only). Locking closes the audience vote and drops the votes cast. |
| `hall_floor` | `{ playerId: string \| null }` | Holder or host. Gives one member (`not_found` otherwise) a hall-wide microphone, and lowers their hand; `null` takes it back. **Consent:** the target must have raised a hand (`not_raised` otherwise), unless it is the sender. The target needs a verified identity (`identity_required`). The member who has the floor may give it up with `null` (any other non-holder gets `not_holder`). |
| `hall_stage_vote` | `{ end: boolean }` | Members other than the holder (`invalid` for the holder) vote to end the **live** share (`not_live` otherwise) or take the vote back. Closed while the stage is locked (`locked`). While a name registry runs only owned names vote (`identity_required`). Bucket: burst 3, refill one per 10 s (`rate_limited`); voting twice, or taking back a vote never cast, changes nothing and costs nothing. At max(`HALL_VOTE_MIN` = 3, ceil(`HALL_VOTE_FRACTION` = 50 % × the other members present)) votes the turn ends and the holder gets a `HALL_STAGE_VOTE_COOLDOWN_MS` (10 min) stage cooldown. "The other members" are every member but the holder — guests included, so they raise the bar even while they can't vote. Votes belong to one turn and to members present: they reset when the turn ends or the stage is locked, and a voter who leaves takes the vote along (a departure can also lower the bar enough to end the share). |
| `hall_stage_dequeue` | `{ playerId: string }` | Host only (`not_host`): takes a player out of the queue (`not_queued` otherwise). Not a ban — they may queue again. Broadcast budget. |
| `hall_stage_cooldown` | `{ playerId: string; ms: number }` | Host only (`not_host`): keeps a member, the holder or a queued player (`not_found` otherwise) off the stage for `ms` (an integer, at most `HALL_STAGE_COOLDOWN_MAX_MS` = 24 h; `invalid` otherwise); `0` lifts it. A cooldown also ends that player's turn and drops their queue place. Broadcast budget. |
| `hall_react` | `{ reaction: HallReaction }` | Members only. One of `HALL_REACTIONS` (`clap`, `heart`, `fire`, `laugh`, `wow`, `party`, `zec`, `idea` — ids, never raw emoji). Bucket: burst 8, refill 3/s (`rate_limited`). |
| `hall_hand` | `{ raised: boolean }` | Members only. Idempotent; raise order is kept. Bucket: burst 3, refill 0.2/s. At most `HALL_HANDS_MAX` (128) hands are up at once (`full`). |
| `hall_hand_lower` | `{ playerId: string \| "*" }` | Holder or host. Lowers one hand (a no-op if it isn't raised) or every hand. |
| `hall_seat_claim` | `{ seatId: number }` | Members only. Integer 0..59 (`WATCH_HALL_SEAT_COUNT`). Free seats only (`taken`; messages are processed one at a time, so the first claim wins). A new claim frees your old seat; re-claiming your own seat restarts the settle window. |
| `hall_seat_release` | `{}` | Frees your seat (a no-op if you have none). Also automatic on leaving the hall, on disconnect, and on a `walk`/`jog` transform arriving more than `HALL_SEAT_SETTLE_MS` (1.5 s) after the claim (the walk onto the seat doesn't count). |
| `hall_host_auth` | `{ key: string }` | See § Host role. |

Shape checks (`apps/server/src/protocol.ts`): ids are 1–64 characters;
booleans must be booleans; `seatId` an integer in range; `key` 1–
`HALL_HOST_KEY_MAX` (128) characters; the card is rebuilt from known
fields only. A malformed frame is dropped silently (§ Server-side
validation), like any other.

### Server → client

Sent to hall members only, except `hall_error` (to the sender of the
refused request). Every message carries playerIds, never nicknames —
clients resolve names from presence, so hall state can't go stale after a
rename.

| Message | Shape | When |
|---|---|---|
| `hall_state` | `{ stage, seats: [seatId, playerId][], hands: string[], floor: string \| null, hosts: string[], host: boolean, totals: Partial<Record<HallReaction, number>>, session: { id: number, active: boolean }, vote: HallVoteState }` | On entering the hall and after a successful host auth. `seats` lists occupied seats; `hands` is in raise order; `hosts` are the hosts in the hall; `host` is whether the recipient holds the role. `totals` / `session`: the reaction session (§ Reaction sessions below). `vote` is the audience vote as the recipient sees it. |
| `hall_vote` | `{ votes: number, needed: number, voted: boolean }` | When the vote count or its bar changes (the bar moves with the audience). `needed` is 0 while voting is closed (nothing live, or locked). `voted` is whether the **recipient's own** vote counts — voters and everyone else get separate copies; no message ever says who voted. |
| `hall_exit` | `{}` | To a session that left the hall: drop all hall state. |
| `hall_stage` | `{ stage: HallStageState }` | On every stage change. |
| `hall_seat` | `{ seatId, playerId \| null }` | On each seat change (a move is two deltas: the old seat freed, the new one taken). |
| `hall_hands` | `{ hands: string[] }` | When raised hands change. |
| `hall_floor` | `{ playerId \| null }` | When the floor changes. |
| `hall_hosts` | `{ hosts: string[] }` | When the hosts in the hall change. |
| `hall_reactions` | `{ counts: Partial<Record<HallReaction, number>>, sample: { playerId, reaction }[], totals: Partial<Record<HallReaction, number>>, session: { id: number, active: boolean } }` | Aggregated: flushed at most every `HALL_REACTION_FLUSH_MS` (250 ms) by a lazy timer, only when something is pending; `sample` has at most `HALL_REACTION_SAMPLE_MAX` (16) entries. `counts` are this window's; `totals` are the session's after it. A session start or end also sends one with empty `counts` and `sample`. |
| `hall_error` | `{ op, reason, retryInMs? }` | `op` ∈ `stage card floor react hand seat host lock vote`; `reason` ∈ `not_in_hall rate_limited taken queue_full not_holder not_queued not_host locked invalid host_disabled bad_key not_found not_raised full identity_required cooldown not_live` (`locked` is sent only for a vote: queuing stays open while the stage is locked). `retryInMs` comes with a `cooldown` refusal of the sender's own request: how long until it may ask again. |

```ts
interface HallStageState {
  holder: string | null;
  status: "idle" | "preparing" | "live";
  since: number;          // server time (ms since epoch) of the last status change
  queue: string[];        // FIFO, at most 12
  card: HallCard | null;
  locked: boolean;
  audio: boolean;         // the holder reported tab audio in its share
}

interface HallVoteState {
  votes: number;          // counted votes to end the live share
  needed: number;         // the bar; 0 while voting is closed
  voted: boolean;         // the recipient's own vote counts
}
```

The web client (`apps/web/src/networking/protocol.ts`) validates and
rebuilds each of these, caps every array (queue 12, seats 60, hands 128,
sample 16, hosts 32 — hands and hosts are **truncated** to the shared
`HALL_HANDS_MAX` / `HALL_HOSTS_MAX` rather than dropping the frame, so a
mismatch can never keep a player out of the hall), re-validates the card with the same rules (an
invalid card becomes `null`), and hands them to `NetworkClient.onHall` →
`apps/web/src/hall/HallStore.ts`. A missing or malformed `hall_state.vote` becomes "no vote open" (never a dropped
frame); `hall_vote` counts are integers 0–10 000; a `retryInMs` that is not a number of milliseconds up to 24 h is
dropped.

### Reaction sessions

The Discussion Corner's reaction counter resets for every presentation, and
every member sees the same numbers:

- A **session** is one stage turn. It starts when a player becomes holder
  (`preparing`, by the queue or a handover): `session.id` goes up by one,
  `active` becomes true and `totals` start from zero.
- While a session is active, each accepted `hall_react` adds one to its
  reaction's total (capped at `HALL_REACTION_TOTAL_MAX`, 999,999).
  `hall_reactions.counts` and `sample` stay per flush window, as before.
- When the turn ends (any of the ways in § Stage state machine), `active`
  becomes false and the totals are kept: clients show them as "Last
  session". Reactions while the stage is idle still float over avatars but
  change no totals.
- A session start or end sends every member a `hall_reactions` with empty
  `counts` and `sample` and the new `totals` / `session`, so all boards reset
  together. A newcomer gets them in `hall_state`.
- `session.id` 0 means no turn since the server started (`totals` is
  empty). Session ids and totals live in memory only, like the rest of the
  hall state; a restart starts again from 0.

Clients show the server's `totals` and never add batches up. The web client
(`HallStore.reactionTotals` / `reactionSession`, `boardFeeds.reactionTally`)
labels them "This session" or "Last session". Before the first turn it
falls back to the reactions this client saw in the last minute, labelled
"Last minute". A frame without valid `totals` and `session` (an older
server) is dropped.

### Stage state machine

1. While the stage is idle and **unlocked**, the queue head becomes holder
   with status `preparing`. Becoming holder lowers that player's hand.
2. `hall_stage_live{live:true}` makes it `live`. Live/ended are taken
   from LiveKit events, so a presenter whose game tab is in the background
   still reports correctly.
3. Without `live:true` within `HALL_STAGE_PREPARE_TIMEOUT_MS` (45 s — the
   browser picker needs a click), the turn is skipped.
4. The turn ends on `hall_stage_live{live:false}` after live, on
   `hall_stage_stop`, on a handover, or **at once** when the holder
   disconnects (a reconnect is a new session). If the holder walks out of
   the hall, it ends after `HALL_STAGE_LEAVE_GRACE_MS` (15 s) unless they
   come back first.
5. When a turn ends, the card, the `audio` flag, the floor and the votes
   are cleared, and the queue advances (unless locked). A queue head that
   no longer has a verified identity, or is on a cooldown, is dropped and
   the next one is tried.
6. **Max turn** (`WATCH_HALL_MAX_TURN_MS`, capped at 24 h; **60 minutes
   when unset or empty**, `0` turns it off): a turn that
   has lasted longer ends while the stage is **unlocked**, others are
   queued and no host is in the hall. A locked stage is host-managed, so
   the cap never cuts off the speaker a host chose.
7. **Audience vote** (`hall_stage_vote`): reaching the bar
   ends the turn and gives the holder a 10-minute stage cooldown.
   Cooldowns (after a vote, or set by a host) follow the **owned name**
   while a registry runs, so reconnecting doesn't escape them; without a
   registry they follow the session. They are the one piece of hall state
   kept after a disconnect — in memory, until they run out, at most 4096
   at once.

### Speaker card

```ts
interface HallCard {
  title: string;          // ≤ HALL_CARD_TITLE_MAX (80) after sanitizing; required
  speaker?: string;       // ≤ HALL_CARD_NAME_MAX (48)
  project?: string;       // ≤ 48
  links?: { kind: "github" | "docs" | "zechub" | "forum" | "web"; url: string }[]; // ≤ HALL_CARD_LINKS_MAX (4)
  eventId?: string;       // /^[a-z0-9-]{1,48}$/ — a /content/watch id
  videoId?: string;       // /^[A-Za-z0-9_-]{11}$/ — for the viewer's opt-in personal player
}
```

- Text goes through the chat sanitizer (`sanitizeChatText(raw, max)`):
  controls, bidi overrides and zero-width characters removed, whitespace
  collapsed; an empty optional field is dropped. Clients render with
  `textContent` only.
- Links must be `https://`, with no credentials and no port, on exactly one
  of `HALL_CARD_LINK_HOSTS` (github.com, zechub.wiki, www.zechub.wiki,
  forum.zcashcommunity.com, z.cash, zips.z.cash, zcash.readthedocs.io,
  zfnd.org, electriccoin.co, zcashcommunitygrants.org, shieldedlabs.net),
  at most `HALL_CARD_URL_MAX` (200) characters. They are stored normalised
  (`URL.href`). One bad field rejects the whole card.
- The whole client frame must fit `MAX_MESSAGE_BYTES` (2 KB);
  `apps/web/src/hall/hallCard.ts` lets the UI check a card before sending.

### Host role

- Enabled only when `WATCH_HALL_HOST_KEY` is 24–128 characters long with
  at least 10 distinct characters (generate it with
  `openssl rand -base64 32`); otherwise `hall_host_auth` answers
  `host_disabled` and the start-up log says why (never the key).
- Members only. The key is compared as SHA-256 digests with
  `crypto.timingSafeEqual`. At most `5` attempts per session, every
  attempt counted (`rate_limited` after that). There is deliberately **no
  process-wide budget**: anyone can open sessions, so a shared bucket could
  be kept empty by a griefer and lock every real host out. The key's
  strength is the brute-force bound. A wrong key is `bad_key`; at most
  `HALL_HOSTS_MAX` (32) host sessions at once (`full`).
- Success sends the host a fresh `hall_state{host:true}` and the other
  members `hall_hosts`. The role belongs to the session only: it survives
  stepping out of the hall, and ends on disconnect. Host powers need the
  host to be in the hall.
- Powers: force stop, hand over / grant to a queued player (or to a
  member with a raised hand), lock the stage, give the floor (to a raised
  hand), lower hands, set the card (also while idle), remove a player from the queue (`hall_stage_dequeue`) and
  set a per-player stage cooldown (`hall_stage_cooldown`). A host's grant
  overrides a cooldown; it never overrides the verified-identity rule.
- The key is never logged, echoed, persisted or sent to any client.
- Moderators (ADR-019 § 1): the same `hall_host_auth` field takes a
  **moderator key** (`MODERATOR_KEYS`), from anywhere in the world (no
  membership needed) — see § Moderation. A moderator has every host power
  (also listed in `hosts`, not counted toward `HALL_HOSTS_MAX`); the lock is
  released when the last host *or moderator* session disconnects. While
  moderator keys are configured, every `hall_host_auth` counts toward the
  session's 5 attempts, and a wrong key on a server without a host key is
  `bad_key` (not `host_disabled`).

### Privacy and lifetime

All hall state is in memory, keyed by session playerId, never logged and
never persisted; `forget()` drops a session's state on disconnect and a
restart drops everything. The exception is a stage cooldown,
kept in memory by owned-name key (or session id) until it runs out. Who
voted is known to the server only, for the length of one turn, and is never
sent or logged. The server learns who is in the hall, seated,
queued, raising a hand or reacting — peers learn the same through these
messages, and could infer most of it from transforms already. See
`docs/privacy/MULTIPLAYER_THREAT_MODEL.md` § Addendum: Watch Hall server
state and `docs/privacy/CHAT_THREAT_MODEL.md` § Addendum: the Hall
channel.

## Moderation (ADR-019)

Report (everyone), chat mute, kick and ban (moderators), the per-IP
connection cap and the LiveKit publisher revoke. Shapes:
`packages/shared/src/multiplayer-protocol.ts` § Moderation. Rules:
`apps/server/src/moderation/` and `WorldServer.ts`. Privacy:
`docs/privacy/MULTIPLAYER_THREAT_MODEL.md` § Moderation.

### Signing in as a moderator

A session sends one of the operator's `MODERATOR_KEYS` in **`hall_host_auth`**
(the Watch Hall host-key field; Profile → "Moderator sign-in" opens the same
dialog anywhere). Keys follow the host key's rules (24–128 characters, ≥ 10
distinct; weaker ones are ignored at start-up), are compared as SHA-256
digests in constant time against every configured key, 5 attempts per session.
On success the moderator gets `mod_log` (the moderation state), everyone gets
`moderator_updated {playerId, moderator: true}`, and — inside the hall — the
moderator gets `hall_state {host: true}`. The role lasts for the session only.

### Client → server

```ts
{ type: "report"; targetId: string; reason: ReportReason; note?: string }
// reason: "spam" | "harassment" | "impersonation" | "scam" | "inappropriate_share" | "other"
// note: optional, ≤ 280 characters after the chat sanitizer

{ type: "mod_action"; action: "mute" | "kick" | "ban" | "unmute" | "unban" | "dismiss_report";
  targetId?: string; reportId?: string; entryId?: string; durationMs?: number | null }
```

| Action | Fields | Effect |
|---|---|---|
| `mute` | `targetId` or `reportId`; `durationMs` ∈ {600000, 3600000, 86400000} | The target's `chat_send` (every channel) and `whisper_send` are dropped; each gets `moderation_notice {muted, until}`. Also every other session the mute's keys cover (see Keys below). |
| `kick` | `targetId` or `reportId` | `moderation_notice {kicked, until}`, then the socket closes with **4001 `kicked`**; the identity can't connect for 10 minutes. Every other live session the kick covers is closed the same way. |
| `ban` | `targetId` or `reportId`; `durationMs` ∈ {3600000, 86400000, 604800000} or `null` (until lifted) | `moderation_notice {banned, until}`, then **4002 `banned`** — for every live session the ban covers. |
| `unmute` / `unban` | `entryId` (from `mod_log`) | Lifted at once. `unmute`: every online session the mute had silenced and that was told so (the target, a reconnect of it, another tab on its network) gets `moderation_notice {unmuted}`, unless another mute still holds it. |
| `dismiss_report` | `reportId` | The report leaves the queue. |

`reportId` with a `targetId` marks that report handled; `reportId` alone acts
on the report's target, also after they left (the server kept their keys with
the report; its connection key then ends 24 hours after the report was made,
not 24 hours after the action). A target who reconnected meanwhile is closed by
a kick or ban all the same (by its keys). Moderators can't act on themselves
(`self`) or on another moderator (`moderator`). Every action from a
non-moderator is refused with `not_moderator`.

### Server → client

```ts
{ type: "report_ack"; status: "sent" | "rate_limited" | "unknown_player" | "self" | "invalid" | "unavailable" }
{ type: "mod_report"; report: ModReport }                 // live, to every online moderator but the reported one
{ type: "mod_action_result"; action; ok: boolean; error?: ModActionError; target?: string; until?: number }
{ type: "mod_log"; reports: ModReport[]; log: ModLogEntry[]; bans: ModBanEntry[]; mutes: ModMuteEntry[] }
{ type: "moderation_notice"; kind: "muted" | "unmuted" | "kicked" | "banned" | "too_many_connections"; until?: number }
{ type: "moderator_updated"; playerId: string; moderator: boolean }   // to everyone

ModReport   = { id, t, reporter, target, targetId: string | null, reason, note?, location: "district" | "valley" | "hall" }
ModLogEntry = { id, t, moderator, action, target?, durationMs?: number | null }
ModBanEntry = { id, nickname, kind: "kick" | "ban", until, byName: boolean, byConnection: boolean }
ModMuteEntry = { id, nickname, until }
```

- `mod_log` goes to moderators only: on sign-in and after every change (an
  action, an expiry, a reported player leaving). Reports and log newest first.
- **Reports about a moderator** go to the other moderators
  only: the reported moderator — matched by session, or by owned name across
  reconnects; never by the shared connection hash — gets no `mod_report`, and
  its `mod_log` leaves out those reports and their dismissals. The same holds
  for a reported player who signs in as a moderator later.
- `until` is server time (ms since epoch); `8640000000000000`
  (`MOD_BAN_FOREVER`) means "until a moderator lifts it".
- `mod_action_result.until` (a successful mute, kick or ban): when it really
  ends. For a target without an owned name a 7-day or "until lifted" ban ends
  after 24 hours (the connection key's cap), and the moderator's confirmation
  says so. The log's `durationMs` is the effective length too.
- Nicknames in moderation messages are at most `MOD_NICKNAME_LABEL_MAX` (96)
  characters. A stored ban on a key that owns several names is labelled
  "A, B +N more" within it. The web client skips a malformed entry of a
  `mod_log` list instead of dropping the whole frame (a missing list still
  drops it).
- `report_ack: unavailable` — the server has no moderator keys, so nobody
  would read the report; it isn't kept.

### Keys, limits and lifetimes

- **Kick/ban/mute keys.** An owned name by its name-key hash (for the chosen
  time; a ban ≥ 24 h is stored as `bannedUntil` in `names.json`), and every
  connection by a keyed hash of its network address (HMAC-SHA-256 under a
  random per-process key; IPv6 by /64) for at most 24 hours from when the
  server saw it. A guest has only the second. Both apply when the target has
  an owned name. Once an entry's connection part ends, the hash is dropped
  from it while the name part runs on.
- **Who a key covers.** A kick's or ban's connection key covers everyone on
  that network (it is checked before the server knows who is connecting). A
  mute's connection key covers only sessions **without** an owned name: an
  unrelated owned-name holder on the same network keeps chatting. Moderators
  are never muted and are never closed by a kick or ban sweep (a moderator who
  shares the banned network stays connected, but can't reconnect until the
  connection key ends or another moderator lifts the ban).
- **When a ban is checked.** At the WebSocket handshake (the connection
  hash: refused with the notice and 4001/4002 before any session exists), at
  `join`, the moment an owned name is proved (claim or confirmation), and —
  right after a kick or ban — against every live session (joined or still
  onboarding): each one the new entry covers is closed at once.
- **Reports.** 3 per reporter per 10 minutes, one per reporter–target pair per
  10 minutes (`rate_limited`). A report counts against **every** key the
  reporter has (its owned name and its connection), so forgetting the wallet
  or a second tab is no fresh budget. A pair's target is its owned name, or
  else its session (two guests behind one address are two targets). The queue
  keeps the last 100, each ≤ 24 h or until handled. Never written to disk or
  logged.
- **Log.** The last 200 actions, in memory. The server log says only
  `moderation action: <action>`.
- **Per-IP cap.** At most `MAX_SESSIONS_PER_IP` (default 4) concurrent sockets
  and 10 new connections a minute per network; beyond that the socket gets
  `moderation_notice {too_many_connections}` and closes with **4003
  `too_many_connections`**. Every attempt counts. `0` turns both limits off
  (local tests only). Behind a reverse proxy, `TRUST_PROXY` names it: only a
  connection from that address may name the client with `X-Forwarded-For`
  (the rightmost entry). When that proxy forwards a private network address
  (RFC 1918, loopback, CGNAT, IPv6 ULA/link-local) the server warns once, with
  no address: it usually means IPv6 visitors reach the proxy through Docker's
  userland proxy as the network gateway and would all share one key; the
  deployment then has to forward real client addresses.
- **Kick and ban effects.** The session is removed at once — its stage turn,
  floor, queue place, vote, seat, voice capability and presence
  (`player_left`) go before the close handshake — and its LiveKit participant
  is removed.

### LiveKit publisher revoke

The server calls RoomService (`/twirp/livekit.RoomService/…`) with a 60-second
`roomAdmin` token signed with `LIVEKIT_API_SECRET`: `UpdateParticipant`
(subscribe-only permission, `canPublish: false`) when a host's or moderator's
stop or grant, an audience vote or a cooldown takes a holder's turn, or when a
session loses the right to talk; `RemoveParticipant` on kick or ban. One retry,
then `livekit revoke failed` in the log (no identity). When its own
`canPublish` goes false the client stops and releases its microphone and any
share but keeps the room (subscribe-only): it drops to listening — nearby
voices and the stage keep playing — and says why; Enable Voice asks for a new
full grant.

## Reconnecting

After a close with 4001 (`kicked`), 4002 (`banned`) or 4003
(`too_many_connections`) the client does **not** reconnect on its own: it shows
the notice (until when, or "too many connections from your network") with a
"Try again" button.

After an unexpected close the client reconnects with exponential backoff
(1 s → 15 s, ±25 % jitter) and — once the player has left onboarding —
rejoins with the same identity (ADR-015): `{ nickname: <last accepted>,
avatar: <a holder's look>, wallet: <the sticky holder flag> }`. A guest's
`Guest-####` is kept if it is still free; a holder's name goes through
the usual conflict rules. Each reconnect is a new session: a new
`playerId` and a fresh voice capability. The client leaves the voice room
on disconnect; the player re-enables voice after reconnecting.

## Network rate

Target **~10 Hz** (one `player_transform` roughly every 100ms),
explicitly not render frame rate. The server does not enforce a tick
loop of its own — it relays each `player_transform` to other clients as
soon as it validates it, and rate-limits abusive senders (§ Server-side
validation) rather than batching/throttling well-behaved ones.

**Unchanged poses are skipped** (ADR-014). Clients MAY
skip a `player_transform` whose `x`/`y`/`z`/`rotationY`/`animationState`
equal the last one they sent on this connection; the web client
(`NetworkClient.sendTransform`) does. `heartbeat` keeps the session alive
(§ Heartbeat & stale-connection cleanup), and the server keeps the last
pose for presence, `nearby` chat and Watch Hall membership, so nothing
else changes:

- the first transform after every (re)connect is always sent (a new
  session starts at the origin pose);
- any change is sent at once — including the `walk`/`jog` that releases a
  Watch Hall seat;
- receivers hold the last pose (§ Interpolation strategy); when movement
  resumes after a gap, `RemotePlayer` re-anchors the previous sample one
  tick back so the first step interpolates instead of snapping.

A seated audience therefore sends almost nothing, which matters because
transform fan-out (every transform to every joined player, O(n²)) is the
capacity limit.

## Movement authority

**Deliberate architecture decision**: the local client is
the movement authority for its own player. The server relays and
sanity-validates, but does not simulate or correct client-reported
positions. This is acceptable because this is a social space, not
competitive gameplay — see `docs/decisions/ADR-005-client-authoritative-movement.md`
for the full reasoning and what would need to change if that ever
stops being true.

## Interpolation strategy (client-side)

Remote players never jump straight to a newly received transform. Each
`RemotePlayer` keeps a short buffer of recent `(t, x, y, z, rotationY)`
samples and renders at `now - RENDER_DELAY_MS` (default 120ms — a bit
more than one network tick at 10 Hz, so there's almost always a sample
on each side to interpolate between), lerping position and
shortest-path-lerping rotation between the two bracketing samples. If
the render time is ahead of the newest sample (buffer underrun — e.g. a
dropped packet), the player holds at the latest known transform rather
than extrapolating, to avoid overshoot artifacts. `animationState`
itself isn't interpolated — it snaps to the latest known value and
`PlayerAnimation`'s own crossfade (apps/web/src/player/PlayerAnimation.ts)
smooths the visual transition.

See `apps/web/src/networking/interpolation.ts` for the implementation
(a pure function, unit-tested independent of Three.js — see
`apps/web/src/networking/interpolation.test.ts`).

## Temporary identity

- `playerId`: `crypto.randomUUID()`, assigned by the server per
  connection. Not derived from IP, not derived from any device/browser
  fingerprint, not persisted across reconnects/sessions.
- `nickname`: a wallet holder's own choice (validated for shape,
  reserved names and case-insensitive uniqueness — content/meaning is not
  moderated, see § Nickname validation and conflict resolution below), or
  server-generated as `Guest-####` (4 random digits, always free) for
  every guest (ADR-015). Not persisted by the server. Mutable mid-session
  via `set_nickname`/`nickname_updated` — holders only.
- `colorSeed`: deterministic `hash(playerId) % 360`. It is session-level
  pseudonymous metadata derived from the temporary `playerId` and is
  used for the animation phase and the default avatar. It does not
  directly encode a real-world identity or wallet identity.
- `avatar` (ADR-015): `{model, color}` — chosen by a holder, else
  `defaultPlayerAvatar(colorSeed)`. Cosmetic; 40 combinations.
- `canReceive` (ADR-015): the session declared an in-game wallet. The
  ONLY wallet-derived bit in this protocol.

No field in this protocol is, or derives from, a wallet address, and
nothing in this protocol's code paths links one; `canReceive` says only
"this player can receive ZEC privately" (a chosen name already implies
it). See `docs/privacy/MULTIPLAYER_THREAT_MODEL.md` for the fuller
discussion of what correlation this protocol does and does not rule out,
and `docs/privacy/SOCIAL_IDENTITY_THREAT_MODEL.md` for the identity
discussion (nickname choice, wallet holders vs guests, renaming, block
privacy).

## Nickname validation and conflict resolution

Applies identically to the nickname requested at `join` and to a later
`set_nickname`. Implemented in `apps/server/src/nickname.ts`, called from
`apps/server/src/WorldServer.ts`.

**There is exactly one semantic nickname policy**, and it lives entirely
in `sanitizeNickname()` — `apps/server/src/protocol.ts`'s wire parser
checks only that `nickname`, when present, is a `string` (structural/type
safety); it does **not** reject based on raw length, so a nickname is
always **trimmed before it is measured**. A raw value like
`"  " + "a".repeat(24) + "  "` (28 raw characters) is accepted and
normalized to its 24-character trimmed form, rather than being rejected
for an untrimmed length over the limit; both layers agree on this (see
`apps/server/src/WorldServer.test.ts` Tests A/B/E).

- **Shape validation** (`sanitizeNickname`): NFKC-normalises (ADR-015 —
  a fullwidth "Ａｌｉｃｅ" is "Alice"), trims whitespace, then rejects
  (returns no usable nickname) if the *trimmed* result is empty, longer
  than `MAX_NICKNAME_LENGTH` (24), contains a C0/C1 control or DEL, a
  zero-width character (U+200B–200F), a bidi override/isolate
  (U+202A–202E, U+2066–2069) or the BOM (the same class chat strips —
  `UNSAFE_TEXT_CHARACTERS` in `chat.ts`), or a raw `<`/`>` character (a
  deliberately simple denylist against obviously markup-shaped input like
  `<script>…</script>` — not a full sanitizer, deliberately: the goal is
  safety, not a censorship system). This is content-*safety* validation,
  not moderation — no word/phrase dictionary exists or is planned here.
- **Reserved names** (ADR-015, `isReservedNickname`): the Guest pattern
  and its look-alikes (`guest`, `Guest 12`, `guest_7`, any dash, fullwidth
  forms) and the system words `system`, `admin`, `host`, `moderator` and
  `zocial world` (any spacing or case) can't be chosen — only the server
  hands out `Guest-####`. A reserved request is treated like an invalid one.
- **Who may choose** (ADR-015): wallet holders only. A guest's `join`
  nickname is kept only if it is a free server-style `Guest-####`
  (reconnect continuity); a guest's `set_nickname` is dropped.
- **On an invalid `join` nickname**: falls back to a generated, free
  `Guest-####`, exactly as for a missing nickname.
- **On an invalid `set_nickname`**: dropped silently — the session keeps
  its current nickname. No error is sent back (consistent with how a
  malformed `player_transform` is handled); client-side input validation
  should prevent most invalid submissions before send, but the server is
  the final authority.
- **Uniqueness** (`resolveUniqueNickname`): a valid candidate that
  collides with another currently-joined session's nickname — compared
  case-insensitively after NFKC (`nicknameKey`, ADR-015), so `Alice` and
  `alice` collide — is resolved by appending `-2`, `-3`, … until free
  (e.g. two players both requesting `Alice` become `Alice` and `Alice-2`;
  `Alice` then `alice` gives `alice-2`). A taken guest number is replaced
  by another number instead, never suffixed. A join or rename is never
  rejected outright for a conflict — a safe suffix is preferred over
  refusing the request. This check only ever compares
  against other sessions that have completed `join`; a session renaming
  to a name it already holds is a no-op (no `nickname_updated`
  broadcast).
- **Every server-approved nickname fits `MAX_NICKNAME_LENGTH`, including
  its conflict suffix.** A candidate already at the 24-character limit
  that also collides is resolved by truncating the *base*, never the
  suffix — e.g. a 24-character name becomes a 22-character prefix plus
  `-2` (24 total), and if conflicts continue into a multi-digit suffix
  (`-10`, `-100`, …), the base is truncated further each time so the
  full suffix always survives intact and the total never exceeds 24
  (see `apps/server/src/nickname.test.ts` and `WorldServer.test.ts`
  Test C).

## Nearby interaction range

"Nearby" (as opposed to merely "online") is **not a networked concept** —
computed entirely client-side from transform data the protocol already
relays, via `getNearbyPlayers()` in `apps/web/src/social/nearby.ts`. No
message or field in this protocol represents presence/nearby state.

The single source of truth for the distance threshold is
`SOCIAL_INTERACTION_RADIUS_METERS = 5`, defined once in that same file
and reused for both the nearby-presence classification (shown in the
player context card as "Online" vs "Nearby") and the player-selection
interaction radius (§ Player selection below) — one reusable constant rather than this
number scattered across systems. 5m was chosen as a comfortable conversational
distance at this world's scale — a future audible/voice radius is expected to be
its own, separately-chosen and separately-reviewed constant, not an
automatic reuse of this one.

## Player selection

A remote player can be selected the same way the player already
interacts with world objects: `RemotePlayerInteractable`
(`apps/web/src/social/RemotePlayerInteractable.ts`) adapts each spawned
`RemotePlayer` into the existing `Interactable` contract
(`apps/web/src/interaction/Interactable.ts`) and registers it with the
same `InteractionSystem` that already drives "[E] View Projects". No
changes were needed to `InteractionSystem` itself.

**Precedence rule: highest priority in range, then nearest**
(ADR-014 § 9; `pickInteractable` in
`apps/web/src/interaction/InteractionSystem.ts`). Each `Interactable` may
carry an optional `priority` (default 0). Among the interactables whose
radius reaches the player, the highest priority wins, and the physically
closest breaks a tie — that one is shown in the "[E] …" prompt and acted on
when E is pressed. Players and most world objects are priority 0, so
the original "nearest valid interactable wins" rule still holds between them: if a
remote player and a world object (or two remote players) are both in range,
whichever is closer wins. The Watch Hall raises two kinds:

| Priority | Interactables |
|---|---|
| 2 | The 60 seats (`wh-seat-<id>`, radius 0.9 m, registered only while the seat is free, you are a hall member and you are not seated) |
| 1 | The hall's boards, doors, podium and portal (`wh-live-now`, `wh-discussion`, `wh-card`, `wh-podium`, `wh-exit`, `wh-portal`) |
| 0 | Remote players (5 m, `SOCIAL_INTERACTION_RADIUS_METERS`), everything else |

Without it, every neighbour's 5 m player card would capture E in a full
hall. While you are seated the seat interactables are gone, so E opens the
nearest player's card. Click-to-select was rejected specifically to avoid adding
raycasting/camera-aware mouse-picking under the existing pointer-locked
third-person camera (no camera redesign, no combat-style lock-on).

Pressing E on a remote player's interactable opens the player context
card (`apps/web/src/social/PlayerContextCard.ts`) and releases pointer
lock so the user can click its buttons. A **blocked** player is
unregistered from `InteractionSystem` entirely (see
`docs/privacy/SOCIAL_IDENTITY_THREAT_MODEL.md` § What does blocking do?)
— they can never become the nearest interactable again on the blocking
client, so no misleading "[E] View …" prompt can appear for them.

## Heartbeat & stale-connection cleanup

Chosen strategy: **application-level heartbeat, not raw WebSocket
ping/pong frames.** The server tracks `lastSeenAt` per connection,
updated on receipt of *any* valid message (`join`, `player_transform`,
or `heartbeat`). A periodic sweep (every 5s) closes and removes any
connection whose `lastSeenAt` is older than `staleTimeoutMs` (default
30s — six missed heartbeats; raised from 15s because a slow
machine can stall for more than 15s while building a location's scene, and
being dropped also ended that player's voice session). This was chosen over relying solely on
WebSocket protocol-level ping/pong because:

- it's deterministically testable (the timeout is just a number, not a
  dependency on how a given WS client auto-responds to ping frames —
  see `apps/server/src/WorldServer.test.ts` Test 6),
- it survives intermediaries that strip raw WS ping/pong frames (some
  proxies/load balancers do), which a future real deployment may sit
  behind.

## Server-side validation (sanity only, not anti-cheat)

This is sanity validation, not a full anti-abuse
system:

- **Known type**: unrecognized `type` values are dropped.
- **Finite numbers**: `x`/`y`/`z`/`rotationY` must be finite
  (`Number.isFinite`) — `NaN`/`Infinity`/non-numbers are rejected.
- **Message size**: raw messages over 2 KB are dropped before parsing.
  The socket itself refuses messages over 4 KiB (`ws` `maxPayload`,
  `WS_MAX_PAYLOAD_BYTES` in `apps/server/src/socketServer.ts`): it closes
  that connection with 1009 (Message Too Big) before buffering the frame.
  A normal client never gets near either limit.
- **Valid animation state**: `animationState` must be one of the eight
  known values (`ANIMATION_STATES`).
- **Rate limiting**: a fixed-window counter (max ~30 messages/sec/connection
  — generous headroom over the ~10 Hz expected rate) drops excess
  messages from a single connection without disconnecting it. Chat,
  payment and Watch Hall token buckets stack on top of it.
- **Exact shapes**: each known type is rebuilt from its checked fields
  only (strings capped, ids 1–64 characters, enums against their tuples —
  e.g. the `hall_*` family in § Watch Hall). Both apps dispatch with an
  exhaustive `switch` (`message satisfies never`), so a new message type
  without a handler fails to compile.

A malformed message is dropped silently (no error sent back, no crash,
no broadcast) — see `apps/server/src/protocol.ts`. A well-formed request
the server refuses gets a sender-only reply instead (`chat_rejected`,
`pay_error`, `hall_error`).

## Origin validation

The server validates the `Origin` header on every WebSocket handshake
via `ws`'s `verifyClient` hook (`apps/server/src/origin.ts`):

- **The allowlist is environment-sensitive** (`resolveAllowedOrigins` in
  `apps/server/src/origin.ts`), keyed off `NODE_ENV`:
  - **Anything but `NODE_ENV=production`** (unset, `development`,
    `test`, …): the local dev defaults (`http://localhost:5173`,
    `http://127.0.0.1:5173` — Vite's defaults) are always included, on
    top of whatever `ALLOWED_ORIGINS` adds. This is what makes
    `npm run dev` work with zero configuration.
  - **`NODE_ENV=production`**: the dev defaults are **not** included.
    The allowlist is exactly whatever `ALLOWED_ORIGINS` configures — a
    deployed production server does not trust `localhost:5173` forever.
  - If `NODE_ENV=production` and `ALLOWED_ORIGINS` resolves to an empty
    list, the server **refuses to start** (fail closed) rather than run
    with an allowlist that would reject every real browser forever —
    see `apps/server/src/index.ts` and `apps/server/.env.example`.
- A **present** `Origin` header that isn't on the resolved allowlist is
  **rejected** (the handshake fails before `join` is ever processed).
- A **missing** `Origin` header is **allowed**. This is a deliberate
  policy, not an oversight: `Origin` is a header browsers attach and
  page JavaScript cannot override, so it's a useful (browser-cooperation)
  check against a hostile *website* opening a WebSocket to this server
  on a visitor's behalf. It is not an authentication mechanism — a
  non-browser client (curl, a bot, a modified game client, this
  project's own server-side tests) can send any `Origin` it likes, or
  none at all, and rejecting "no Origin" would only break those
  legitimate non-browser callers without meaningfully stopping a
  motivated attacker, who doesn't need a browser in the first place.

See `apps/server/src/origin.ts` for the full reasoning and
`apps/server/src/origin.test.ts` for the approved/rejected/missing-Origin
test coverage.
