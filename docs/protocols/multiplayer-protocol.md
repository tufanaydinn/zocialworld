# Multiplayer Protocol — v1 (CORE-002)

Single source of truth for the client ↔ server WebSocket protocol.
The message types themselves live in `packages/shared/src/multiplayer-protocol.ts`
and are imported directly by both `apps/server` and `apps/web` (see
`docs/decisions/ADR-002-shared-multiplayer-protocol-contracts.md`) — there
is one declaration, not two. Environment-specific parsing/validation
(`apps/server/src/protocol.ts`, `apps/web/src/networking/protocol.ts`)
stays local to each app. If you change a message shape, update
`packages/shared`, both apps' parsing code, and this document in the
same commit.

This is a **social-presence** protocol, not a competitive-game protocol.
It carries only what's needed for players to see and hear about each
other's presence in the world — never wallet data, never raw input,
never more identity than a temporary session needs.

## Transport

Plain WebSocket (`ws://` in development; `wss://` expected in any real
deployment, not set up in CORE-002). One text (JSON) message per frame.
No binary framing in v1 — payloads are tiny and JSON keeps this easy to
debug; revisit only if bandwidth numbers (§ Performance in
`packages/multiplayer/README.md`) demand it.

## Message envelope

Every message is a JSON object with a `type` field:

```ts
type Message = { type: string; [key: string]: unknown };
```

The server validates `type` against a known allow-list and drops
anything else (§ Server-side validation below).

## Client → Server

### `join`

Sent once, immediately after the socket opens.

```ts
{
  type: "join";
  nickname?: string; // optional; server assigns "Guest-XXXX" if omitted or invalid
}
```

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
  animationState: "idle" | "walk" | "jog" | "sit" | "wave" | "talk";
  seq: number;             // monotonically increasing per-client sequence number
}
```

Deliberately **not** included, per CORE-002 §10: camera position/orientation,
mouse input, raw keyboard input, wallet/address/balance fields.

### `heartbeat`

```ts
{ type: "heartbeat" }
```

Sent periodically (every 5s client-side) so idle players — standing
still, sending no `player_transform` — still count as alive. See
"Heartbeat & stale-connection cleanup" below for why this is
application-level rather than relying on WebSocket protocol ping/pong.

### `set_nickname` (CORE-003)

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
keeps its current nickname.

## Server → Client

### `welcome`

Sent once, immediately after the server accepts a `join`.

```ts
{
  type: "welcome";
  playerId: string;    // server-assigned temporary session id (crypto.randomUUID())
  nickname: string;     // the accepted nickname (server-assigned if the client didn't send one)
  colorSeed: number;    // 0-359, deterministically derived from playerId — see "Color variation"
  tickRateHz: number;   // informational: the rate the server expects transforms at
}
```

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
    x: number; y: number; z: number;
    rotationY: number;
    animationState: AnimationState;
  }>;
}
```

### `player_joined`

Broadcast to every *other* connected client when a new player completes
`join`.

```ts
{
  type: "player_joined";
  playerId: string;
  nickname: string;
  colorSeed: number;
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
CORE-002 deliberately timestamps interpolation samples with local
receive time (`performance.now()`) because there is no server/client
clock synchronization — see `packages/multiplayer/README.md` §
Interpolation strategy:

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

### `nickname_updated` (CORE-003)

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

## Network rate

Target **~10 Hz** (one `player_transform` roughly every 100ms),
explicitly not render frame rate. The server does not enforce a tick
loop of its own — it relays each `player_transform` to other clients as
soon as it validates it, and rate-limits abusive senders (§ Server-side
validation) rather than batching/throttling well-behaved ones. See
`packages/multiplayer/README.md` for the measured bytes/sec this
produces.

## Movement authority

**Deliberate architecture decision for CORE-002**: the local client is
the movement authority for its own player. The server relays and
sanity-validates, but does not simulate or correct client-reported
positions. This is acceptable because this is a social space, not
competitive gameplay — see `docs/decisions/ADR-001-client-authoritative-movement.md`
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
- `nickname`: either client-supplied (validated for shape and uniqueness
  as of CORE-003 — content/meaning is not moderated, see § Nickname
  validation and conflict resolution below) or server-generated as
  `Guest-####` (4 random digits). Not persisted. Mutable mid-session as
  of CORE-003 via `set_nickname`/`nickname_updated`.
- `colorSeed`: deterministic `hash(playerId) % 360`. It is session-level
  pseudonymous metadata derived from the temporary `playerId` and is
  used only for placeholder visual differentiation. It does not
  directly encode a real-world identity or wallet identity.

No field in this protocol is, or derives from, a wallet address, and
nothing in this protocol's code paths links one. See
`docs/privacy/MULTIPLAYER_THREAT_MODEL.md` for the fuller discussion of
what correlation this protocol does and does not rule out, and
`docs/privacy/SOCIAL_IDENTITY_THREAT_MODEL.md` for the CORE-003-specific
discussion (nickname choice, mid-session renaming, block privacy).

## Nickname validation and conflict resolution (CORE-003)

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
for an untrimmed length over the limit — the two layers previously
disagreed on this (fixed in CORE-003's merge-gate revision; see
`apps/server/src/WorldServer.test.ts` Tests A/B/E).

- **Shape validation** (`sanitizeNickname`): trims whitespace, then
  rejects (returns no usable nickname) if the *trimmed* result is empty,
  longer than `MAX_NICKNAME_LENGTH` (24), contains a C0/DEL control
  character, or contains a raw `<`/`>` character (a deliberately simple
  denylist against obviously markup-shaped input like
  `<script>…</script>` — not a full sanitizer, see CORE-003 §20: "do not
  overbuild a censorship system"). This is content-*safety* validation,
  not moderation — no word/phrase dictionary exists or is planned here.
- **On an invalid `join` nickname**: falls back to a generated
  `Guest-####`, exactly as CORE-002 already did for a missing nickname.
- **On an invalid `set_nickname`**: dropped silently — the session keeps
  its current nickname. No error is sent back (consistent with how a
  malformed `player_transform` is handled); client-side input validation
  should prevent most invalid submissions before send, but the server is
  the final authority.
- **Uniqueness** (`resolveUniqueNickname`): a valid candidate that
  collides with another currently-joined session's nickname is resolved
  by appending `-2`, `-3`, … until free (e.g. two players both requesting
  `Tufan` become `Tufan` and `Tufan-2`). A join or rename is never
  rejected outright for a conflict — CORE-003 §5 explicitly prefers a
  safe suffix over refusing the request. This check only ever compares
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
  (fixed in CORE-003's merge-gate revision; see
  `apps/server/src/nickname.test.ts` and `WorldServer.test.ts` Test C).

## Nearby interaction range (CORE-003)

"Nearby" (as opposed to merely "online") is **not a networked concept** —
computed entirely client-side from transform data the protocol already
relays, via `getNearbyPlayers()` in `apps/web/src/social/nearby.ts`. No
message or field in this protocol represents presence/nearby state.

The single source of truth for the distance threshold is
`SOCIAL_INTERACTION_RADIUS_METERS = 5`, defined once in that same file
and reused for both the nearby-presence classification (shown in the
player context card as "Online" vs "Nearby") and the player-selection
interaction radius (§ Player selection below) — CORE-003 §7/§21
explicitly calls for one reusable constant rather than scattering this
number across systems. 5m was chosen as a comfortable conversational
distance at this world's scale (see `worlds/founders-district/README.md`
for scale reference) — a future audible/voice radius is expected to be
its own, separately-chosen and separately-reviewed constant, not an
automatic reuse of this one.

## Player selection (CORE-003)

A remote player can be selected the same way the player already
interacts with world objects: `RemotePlayerInteractable`
(`apps/web/src/social/RemotePlayerInteractable.ts`) adapts each spawned
`RemotePlayer` into the existing `Interactable` contract
(`apps/web/src/interaction/Interactable.ts`) and registers it with the
same `InteractionSystem` that already drives "[E] View Projects". No
changes were needed to `InteractionSystem` itself.

**Precedence rule: nearest valid interactable wins**, exactly as
`InteractionSystem` already behaves for multiple world objects — if a
remote player and a world object (or two remote players) are both in
range, whichever is physically closer becomes the "nearest interactable"
shown in the "[E] …" prompt and acted on when E is pressed. This was
chosen over a separate click-to-select input (the brief's other option)
specifically to avoid adding raycasting/camera-aware mouse-picking under
the existing pointer-locked third-person camera — see CORE-003 §8/§17 ("do
not redesign the camera", "do not introduce combat-style lock-on").

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
15s — three missed heartbeats). This was chosen over relying solely on
WebSocket protocol-level ping/pong because:

- it's deterministically testable (the timeout is just a number, not a
  dependency on how a given WS client auto-responds to ping frames —
  see `apps/server/src/worldServer.test.ts` Test 6),
- it survives intermediaries that strip raw WS ping/pong frames (some
  proxies/load balancers do), which a future real deployment may sit
  behind.

## Server-side validation (sanity only, not anti-cheat)

Per CORE-002 §18, this is sanity validation, not a full anti-abuse
system:

- **Known type**: unrecognized `type` values are dropped.
- **Finite numbers**: `x`/`y`/`z`/`rotationY` must be finite
  (`Number.isFinite`) — `NaN`/`Infinity`/non-numbers are rejected.
- **Message size**: raw messages over 2 KB are dropped before parsing.
- **Valid animation state**: `animationState` must be one of the six
  known values.
- **Rate limiting**: a fixed-window counter (max ~30 messages/sec/connection
  — generous headroom over the ~10 Hz expected rate) drops excess
  messages from a single connection without disconnecting it.

A rejected message is dropped silently (no error sent back, no crash,
no broadcast) — see `apps/server/src/protocol.ts`.

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
