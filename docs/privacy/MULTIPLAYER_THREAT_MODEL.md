# Multiplayer Threat Model

Scope: the WebSocket presence relay
(`apps/server/src/WorldServer.ts`, protocol documented in
`docs/protocols/multiplayer-protocol.md`). This document describes
**what this specific implementation actually does** — not an aspiration,
not a future state. If the implementation changes, this document must
be updated in the same commit (per `docs/privacy/PRIVACY_MODEL.md` § 7).

No privacy claim beyond what's written here may be made about
multiplayer (`docs/privacy/PRIVACY_MODEL.md`, § Rule).

## What does another player learn?

Only what the server broadcasts over the protocol
(`docs/protocols/multiplayer-protocol.md`):

- `playerId` — a random UUID with no relationship to the player's real
  identity, IP, or device.
- `nickname` — either `Guest-####` (server-generated) or whatever string
  the client supplied on `join` (validated and normalised — see
  `SOCIAL_IDENTITY_THREAT_MODEL.md`; the presence relay does not moderate
  nickname content).
- `colorSeed` — session-level pseudonymous metadata derived from the
  temporary `playerId`, used only for placeholder visual
  differentiation. It does not directly encode a real-world identity or
  wallet identity.
- `avatar` (a chosen or default model and colour; ADR-015)
  and `canReceive` — whether the player can receive ZEC privately, the
  one wallet-derived bit (§ Wallet holders and guests below). Since ADR-015
  only wallet holders choose a `nickname`; guests are always `Guest-####`.
- Real-time position (`x`, `y`, `z`), yaw (`rotationY`), and
  `animationState`, at up to ~10 Hz.

Another player's browser receives nothing else. No IP address, no
device information, no wallet data, no camera/input data (the protocol
has no field for any of these — see `docs/protocols/multiplayer-protocol.md`
§ Player network state).

## What does the application server learn?

- The same `join`/`player_transform`/`heartbeat` messages described
  above, from every connected client.
- The connection's source IP address and TCP port — this is inherent to
  operating a WebSocket server at all (the OS/Node runtime exposes the
  remote address of any TCP connection; a server cannot not know this).
  **`WorldServer.ts` never stores or forwards this value** — see
  "Does another player ever receive another user's IP address?" below.
  *Amended by moderation (ADR-019):* it now reads it once per
  connection, at the handshake, and keeps only a keyed hash of the network
  (§ Moderation below).
- Connection lifecycle timing (when a session connected, joined, and
  disconnected or went stale).
- Nothing else. The server runs no database, no file-based logging of
  connection data, and no analytics — see "What is logged?" below.

## What network metadata exists?

Standard WebSocket/TCP metadata at the network layer, visible only to
the operating system and the Node process handling the connection:
source IP:port, WebSocket handshake headers (`User-Agent`, `Origin`,
etc. — sent by the browser as part of any WebSocket connection; the
application code in `WorldServer.ts` does not read or store these),
and per-message receive timestamps (used only in-memory, for the stale
connection sweep and for the `t` field relayed to the client's
interpolation buffer).

## Does another player ever receive another user's IP address?

**No.** Every outgoing message type is enumerated in
`packages/shared/src/multiplayer-protocol.ts` (`ServerToClientMessage`)
and none of them — not `welcome`, `player_snapshot`, `player_joined`,
`player_left`, nor `player_transform`, nor any later chat, payment,
Watch Hall (`hall_*`) or moderation (`mod_*`, `report_ack`,
`moderation_notice`, `moderator_updated`) message — carries an IP field.
Since moderation (ADR-019) the server reads the handshake's peer address (and
`X-Forwarded-For` only from a `TRUST_PROXY` peer) exactly once, in
`WorldServer.handleConnection`, and immediately reduces it to a keyed hash
(§ Moderation below); the address itself goes nowhere — not to any message,
log line or file. Moderators never see an address or a hash either.

## What identifiers are temporary?

All of them:

- `playerId`: generated fresh (`crypto.randomUUID()`) on every
  connection, held only in the server's in-memory `Map` for the
  lifetime of that connection, discarded on disconnect. Never
  persisted to disk, never reused across reconnects.
- `nickname`: generated or accepted per connection, same lifetime as
  `playerId`. The presence relay does not persist nicknames (owned names,
  below, are the one exception).
- `colorSeed`: session-level pseudonymous metadata derived from
  `playerId`, so it shares the same lifetime — a reconnecting client
  gets a new `playerId` and therefore a new (likely different) color.
  It does not directly encode a real-world identity or wallet identity.

Nothing about a player's identity survives a disconnect or a server
restart. There are no accounts, no database, no persistent store of any
kind in the presence relay (persistent accounts are deliberately out of
scope).

**Amended by owned names (ADR-016).** With a name registry
(`NAME_REGISTRY=dev|zcashd`), an **owned name** persists: the server keeps
one small JSON file of names with their name-key hash and public key, the
owner's character and two timestamps, and a returning player proves the
key to get the name back. That is a persistent pseudonymous identifier the
server can use to link sessions over time. Everything listed above stays
ephemeral. What is stored, retention, deletion and abuse:
`docs/privacy/IDENTITY_THREAT_MODEL.md`.

## What is logged?

Only operator-facing process output via `console.log`/`console.error`
in `apps/server/src/index.ts`: server start/stop and `WebSocketServer`
-level errors. There is no per-connection, per-message, or per-IP
logging anywhere in this implementation, and nothing is written to a
file or external service — `console.log` output exists only in
whatever terminal/process-manager is running the server.
Moderation (ADR-019) adds two nameless lines: `moderation action: <mute|kick|…>`
(no moderator, no target, no reason) and `livekit revoke failed` (no
identity); a test asserts no nickname, note, key or address reaches the log.

## How long should logs be retained?

Not currently applicable — nothing connection-identifying is logged at
all (see above). This is a forward-looking placeholder for if/when real
operational logging is added (e.g. for abuse investigation): any future
IP-bearing log must be retained only as long as operationally/security
necessary, must never be exposed to other players or any client-facing
API, and that addition should update this document, per
`docs/privacy/PRIVACY_MODEL.md` § 5 (Network/IP privacy).

## Can multiplayer identity be correlated with wallet identity?

**The presence relay itself introduces no application-level link.** The
presence protocol transmits no wallet identifiers of any kind (the one
wallet-derived bit is `canReceive`, below; the payment relay and the
wallet bridge are separate and covered by `PLAYER_PAYMENTS_THREAT_MODEL.md`
and `ZCASH_WALLET_THREAT_MODEL.md`), `playerId` is a random, ephemeral
UUID assigned fresh per connection, and presence contains no code path
that reads, stores, or transmits wallet data alongside multiplayer
identity.

That is a narrower claim than "cannot be correlated at all," and this
document does not make the broader one. External correlation is not
something this implementation can rule out, because it happens outside
this protocol's code paths: a player's chosen `nickname` may itself be
identifying, timing/behavioral patterns can link a session to a person
across contexts, the server operator or network infrastructure sees
connection metadata (§ What network metadata exists? above) that could
in principle be joined with other data the operator holds, a future
unrelated service could combine multiplayer session data with wallet
data if one were ever built to do so, and a player can always choose to
self-identify (e.g. announcing their own wallet address in chat, or
elsewhere). None of these are code paths in the presence relay — they are
things no protocol-level design can prevent.

The binding project-wide rule this document upholds
(`docs/privacy/PRIVACY_MODEL.md` § 1) is architectural: wallet identity and
social identity must remain separated *by this project's own systems*.
The wallet goes through the Zcash browser wallet adapter
(`docs/privacy/PRIVACY_MODEL.md` § 3) and must continue to avoid
introducing any automatic link between a social session
(`playerId`/`nickname`) and a wallet identity — that requirement applies
to all future work.

### Wallet holders and guests (ADR-015): one capability bit in presence

Since ADR-015 the protocol carries exactly **one** wallet-derived bit per
player: `canReceive` ("can receive ZEC privately"), in `welcome`,
`player_snapshot`, `player_joined` and `can_receive_updated`, plus the
cosmetic `avatar` (5 models × 8 colours). The statement above that the
protocol "transmits no wallet identifiers" still holds: `canReceive` is
not an identifier, and no address, balance, network, transaction, lock
state or unlock time is ever sent — the client's `participation.ts`
exposes only the sticky boolean, and the server stores only that boolean
on the session.

What it adds, honestly:
- **Every peer learns who holds an in-game wallet.** With a chosen name
  it adds nothing (only holders can choose a name), except in the short
  window between connecting a wallet and choosing a name; the client
  closes that window by asking for a name.
- **The moment of the flip is visible.** A session's `false → true` is
  broadcast when its wallet first unlocks this page session. On a small
  test chain that is a weak timing link to, for example, a faucet claim
  made a moment later. Locking and unlocking afterwards are **not**
  visible (the flag is sticky), and only "Forget this wallet" sends it
  back to `false`.
- **The server learns which sessions declared a wallet.** It already
  learned, in memory and only for the faucet's cooldown, the address a
  session asked test coins for (`zcash/faucet.ts`); ADR-015 does not
  add an address anywhere, but the two facts sit in the same process —
  the operator could join "session X is a holder" with "session X asked
  for coins at address A". This was true before ADR-015 (the faucet
  needs a live session) and is restated here, not newly created.
- **It marks scam targets.** "Can receive ZEC" points at players who may
  hold coins. That is why there is no nameplate badge: the bit shows only
  in the player menu ("Can receive ZEC privately: yes/no — address never
  shown") and as the Send ZEC button state.
- **It is honour-system.** A modified client can claim it. That buys a
  chosen name and a full voice grant, not money: payments still need the
  recipient's own wallet to seal its own address (ADR-013), and a
  confirmed, owned name will need ADR-016's on-chain fee.

The device also remembers the chosen character (and a holder's name) in
`localStorage` (`player-profile-v1`). It never leaves the device except
as the `join` fields, never includes a guest number, and links visits
only as weakly as a low-entropy look and a public name can.

## What must never be transmitted?

Per `docs/protocols/multiplayer-protocol.md` and this implementation's
actual message set:

- IP addresses or any network-metadata field
- Device/browser fingerprints
- Wallet addresses, balances, or transaction data — and (ADR-015) any
  wallet network, lock state or unlock time; the single `canReceive`
  boolean is the only wallet-derived field
- Camera position/orientation
- Raw keyboard or mouse input
- Any persistent account identifier

None of these have a field in the protocol today. Adding one would be
an architecture-affecting change requiring a new ADR, and this document
would need a
corresponding update before such a change could ship.

## Addendum: Watch Hall server state (ADR-014)

The Watch Hall adds server-held, hall-scoped state
(`apps/server/src/watchHall.ts`; protocol in
`docs/protocols/multiplayer-protocol.md` § Watch Hall). The stage media
itself (shared tab video and audio over LiveKit) is covered by the voice
and Watch Hall threat models, not here.

### What the server holds, and for how long

In memory only, keyed by the session `playerId`, for the life of that
session:

- **Membership:** whether the session's last reported position is inside
  the hall box (2 m exit hysteresis). Derived from transforms the server
  already received; no new data is collected for it.
- **Stage:** the holder, its status and status time, the FIFO queue of
  session ids, the lock flag, the "tab audio included" flag, and the
  speaker card text and links the holder or a host typed.
- **Seats** (seat number → session id, plus the claim time), **raised
  hands** (in raise order), **the floor** (one session id) and the
  **host role** (session ids).
- **Limits:** per-session token buckets for reactions, hands and the
  broadcast-triggering hall operations, and a per-session host-auth
  attempt count. Nothing about limits outlives the session.
- **Reactions:** counts and up to 16 `{playerId, reaction}` samples,
  held at most `HALL_REACTION_FLUSH_MS` (250 ms) until they are flushed to
  members.
- **Reaction session totals**: eight anonymous per-reaction
  totals for the current or last stage turn, plus a turn counter. They
  name nobody (not the reactors, not the presenter) and are replaced when
  the next turn starts; members receive them in `hall_state` and
  `hall_reactions`. In memory only, like the rest; a restart resets them.

`forget()` drops all of it when the session disconnects (clean close,
abrupt close or stale sweep); a restart drops everything. Nothing is
persisted and **nothing is logged** — no hall message, card, reaction,
seat, hand, host attempt or key appears in any log line. The only new log
line is the start-up notice saying whether the host role is enabled.

### What other players learn

Only Watch Hall members receive `hall_*` messages (`hall_error` goes to
the sender only). Members learn, by session `playerId`: who holds or is
queued for the stage, who sits in which seat, who has a hand raised, who
has the floor, which hosts are in the hall, who reacted with which of the
eight reaction ids (sampled), and the speaker card. Non-members receive
none of it. Most of this (who is in the hall, who sits where) was already
inferable from relayed transforms. No hall message carries an IP address,
a device identifier, a wallet field or a nickname (clients resolve names
from presence they already have).

### Membership is a social scope, not access control

Positions are client-authoritative (ADR-005), so anyone can send a
transform inside the hall and become a member. The hall's chat, reactions
and stage state must be treated as **visible to anyone who walks (or
teleports) in**. No document or UI may present the hall as private.

### The host key

- `WATCH_HALL_HOST_KEY` lives only in the server environment. If it is
  unset, shorter than 24 or longer than 128 characters, or has fewer than
  10 distinct characters, host features are disabled (fail closed). The
  server keeps only its SHA-256 digest in memory.
- A player sends a candidate in `hall_host_auth` (client → server only,
  inside wss; the client must never put it in a URL). The server compares
  digests with `crypto.timingSafeEqual`, allows 5 attempts per session
  (every attempt counted), and never logs, echoes, persists or forwards the
  candidate or the key.
- The role is session-only: it ends on disconnect and is never written
  down. Other members see a host's session `playerId` in `hosts` — host
  status is visible, pseudonymous session metadata.
- There is **no process-wide budget**: anyone who can open sessions could
  keep a shared bucket empty indefinitely and lock every real host out (a
  correct key would be refused while the bucket was empty). Per-IP
  limits would avoid that, but the server deliberately never reads IPs
  (and behind the documented reverse proxy every client shares one
  address). So the brute-force bound is the key itself: a random key of
  ≥ 24 characters (`openssl rand -base64 32` gives 44 characters, about
  256 bits) is out of reach of guessing at any session rate, which is why
  weak keys are refused at start-up. The per-connection message limit
  (30/s) and the 5-per-session cap slow guessing further.

### Unchanged transforms are skipped

Clients may stop sending `player_transform` while their pose is unchanged
(heartbeats keep the session alive). This sends less data, not more; the
server still sees the connection's heartbeat timing, as before.

### Stage moderation state

`docs/architecture/WATCH_HALL.md` § 12. Added to the hall's in-memory
state:

- **Votes to end the current share:** the set of member session ids
  whose vote counts, for one turn only — cleared when the turn ends or a
  host locks the stage, and a voter's entry goes when they leave or
  disconnect. Members receive only the count, the bar and whether their
  own vote counts (`hall_vote`); **no message names a voter**, and nothing
  about votes is logged.
- **Stage cooldowns:** a map from an identity key to the time the
  cooldown ends — the owned name's normalised key while a name registry
  runs (`name:<key>`), otherwise the session id. Set by an audience vote
  (10 minutes) or a host (up to 24 h). This is the **one piece of hall
  state that outlives a disconnect**: it stays in memory until it runs out
  (at most 4096 entries; expired ones are pruned first), so a reconnect
  cannot escape it. It is never logged or persisted; a restart drops it.
  It links nothing new: the server already maps sessions to owned names.
- **Vote rate limit:** one more per-session token bucket (burst 3, one per
  10 s), dropped with the session.

Who may present, take the floor or vote is decided from server state (an
owned name with a registry, else the ADR-015 flag), never from anything a
client sends in a hall message.

## Addendum: moderation (ADR-019)

Report, chat mute, kick, ban, a per-IP connection cap and the LiveKit
publisher revoke. Code: `apps/server/src/moderation/` (pure state, keys,
client address, connection limits), `WorldServer.ts` (routing, closes),
`voice/roomAdmin.ts` (LiveKit). Tests: `moderation/*.test.ts`,
`voice/roomAdmin.test.ts`, `tests/e2e/moderation.spec.ts`.

### The connection hash

- At the WebSocket handshake the server takes the client address: the
  socket's peer, or — only when that peer is one of `TRUST_PROXY`'s
  addresses (the deployment's reverse proxy) — the rightmost
  `X-Forwarded-For` entry, the one the proxy appended. A client that is not
  the proxy cannot move its address with the header.
- The address is reduced to a **network** (IPv4 as is, IPv6 to its /64) and
  hashed with **HMAC-SHA-256 under a random key generated at start-up and
  never stored or logged**; 128 bits are kept. The raw address is dropped on
  the same line. The hash cannot be compared across restarts or servers,
  and nothing maps it back to an address.
- Every session holds its hash for as long as it is connected. It is used
  for: the per-IP cap, and the keys of a guest's (or an unnamed holder's)
  kick, ban or mute.

### What the server holds, and for how long (all in memory unless stated)

| Data | Keyed by | Lifetime |
|---|---|---|
| Per-IP cap: open sockets and the last minute's connection times | connection hash | dropped once the network has no socket and no attempt in the last minute |
| Kicks and bans | owned name's key hash, and/or connection hash | until they run out (kick 10 min; connection hash ≤ 24 h from when the server saw it — dropped from the entry then, even while the name ban runs on; name as chosen) or are lifted; at most 1000 entries |
| A ban ≥ 24 h on an owned name | `bannedUntil` in that name's `names.json` record | survives a restart; cleared when it ends or is lifted, at start-up if it ended while the server was down, or when the entry is evicted (`IDENTITY_THREAT_MODEL.md` § 13) |
| Chat mutes | owned name's key hash and connection hash | ≤ 24 h, or until lifted (the connection hash ≤ 24 h from when it was seen) |
| Reports | — (the reported player's keys are kept with the report, server side) | the last 100, each ≤ 24 h or until handled; an action taken from a report ends its connection key 24 h after the report |
| Report rate limits | every key the reporter has (name key hash and connection hash) | 10 minutes |
| Moderation log | — | the last 200 actions |
| Moderator role | the session | the session only (sign in again after a reconnect) |

A restart forgets everything here except `bannedUntil`. Nothing here is
logged.

### Who learns what

- **Moderators** see, for each report: the reported nickname, the reason,
  the optional note (≤ 280 characters, sanitized like chat), the time, the
  location name (district, valley or hall) and the **reporter's nickname**
  — needed to judge false reports; the report dialog tells the reporter so.
  For bans and mutes: the nickname, until when, and whether the name and/or
  the network is blocked. The log: moderator nickname, action, target
  nickname, duration, time. Never an address, a hash, a wallet or a
  payment — there is nothing to see.
- **The reported player** is never told who reported them, or that a report
  exists. A muted, kicked or banned player is told what happened and until
  when (`moderation_notice`), not who did it. This holds for a **reported
  moderator** too: a report about a moderator goes to the
  other moderators only, live and in the moderation state, and its dismissal
  is left out of that moderator's log. The match is by session or by owned
  name (a reconnect keeps it), never by the connection hash — a household
  shares that. A guest who is reported and then signs in as a moderator in
  the same session doesn't get the report either. The one gap: a reported
  guest who reconnects (a new session, a new Guest name) and only then signs
  in as a moderator can't be linked to the report, so they would see it —
  with the reporter's nickname — under their old Guest name. Moderators are
  the operator's own invitees; matching on the shared connection hash would
  hide reports about a whole household instead.
- **Everyone** sees a small "Moderator" tag on a moderator's nameplate
  (`moderator` in presence, `moderator_updated`). Whether a player is a
  moderator is never inferred from anything else.

### Honest limits

- People behind one address (a household, an office, a carrier-grade NAT)
  share the connection hash: a kick or a ban (a guest's, or the 24-hour
  network part of an owned name's) disconnects them too and keeps them out,
  and they share the cap (4 sockets by default, 10 new connections a minute)
  and the report budget. A mute is narrower: its connection key silences only
  sessions there without an owned name. A moderator on that network stays
  connected but can't reconnect until the key ends or another moderator
  lifts it.
- IPv6 behind a reverse proxy: a proxy setup that hands every visitor over
  from one gateway address would make all of them share one connection
  hash. The deployment has to forward real client addresses; the server
  warns once (no address) when its trusted proxy forwards a private
  address.
- A VPN or another network gets around the connection hash; for owned
  names the key hash holds, and a new fee-paid name with a new wallet is
  the only way around it. The name fee remains the main deterrent.
- Within one process, the hash does link a player's sessions from the same
  network (a reconnect has a new playerId but the same hash) — that is the
  point of a 24-hour guest ban; it is never shown, logged or persisted.
- The operator, holding the running process's memory, could in principle
  hash a candidate address and compare. Nothing in the server does this.
