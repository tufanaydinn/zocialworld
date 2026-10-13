# Voice Threat Model

Scope: proximity voice — microphone
capture, push-to-talk, the self-hosted LiveKit SFU connection, distance
attenuation/spatialization, speaking-state, and local mute/block
suppression (`apps/web/src/voice/`, `apps/server/src/voice/`, decided in
`docs/decisions/ADR-007-proximity-voice-transport.md`). This document
describes **what this specific implementation actually does** — not an
aspiration, not a future state. If the implementation changes, this
document must be updated in the same commit (per `docs/privacy/PRIVACY_MODEL.md`
§ 7).

No privacy claim beyond what's written here may be made about voice
(`docs/privacy/PRIVACY_MODEL.md` § 6 and § Rule). This document narrows, and does not relax,
`docs/privacy/MULTIPLAYER_THREAT_MODEL.md` and
`docs/privacy/SOCIAL_IDENTITY_THREAT_MODEL.md` — everything those
documents say about `playerId`/nickname/network metadata for the
gameplay WebSocket protocol is unchanged by voice, which is an
entirely separate transport (see ADR-007).

## 1. What does another player learn?

Only what LiveKit's SFU topology delivers to their browser: a subscribed
participant's `identity` (the multiplayer `playerId` — see § 8), their
`name` (the nickname at the moment the voice token was minted — display
metadata only, not re-synced live), their audio track, and
speaking/active-speaker state. Nothing else. (Inside the Watch Hall, a
viewer also receives the stage holder's shared screen video and its
audio — see the Watch Hall addendum at the end.)
Critically, **no other
player's IP address, ICE candidates, or SDP ever reach another player's
browser** — every browser's WebRTC negotiation is with `livekit-server`
only (see ADR-007's "Peer IP exposure model"), never with another
participant's browser directly, because this is an SFU relay, not a P2P
mesh.

## 2. What does the application server learn?

**Capability-based** (see § 20 for the full model): `apps/server/src/voice/tokenHandler.ts` now sees exactly one
thing per voice session over HTTP: a `{ capability }` token request —
an opaque, cryptographically random value, never a `playerId` or
nickname. The server resolves that capability to the authoritative
`{ playerId, nickname }` itself, server-side
(`WorldServer.resolveVoiceSession`), and mints the JWT
(`mintVoiceToken()`) from that resolved identity, not from anything the
HTTP request body claims. The application server never sees audio, SDP,
ICE candidates, or anything from the LiveKit connection itself — token
minting and media transport are entirely separate systems (that is the
architectural point of an SFU: the application server is not in the
media path at all). The request body is capped at 1024 bytes and the
capability field at 128 characters (`MAX_BODY_BYTES`/
`MAX_CAPABILITY_LENGTH`); nothing is persisted to disk or any
datastore — the HTTP handler itself is stateless per request (the
capability *registry* that backs `resolveVoiceSession` is in-memory
session state owned by `WorldServer`, same lifetime as everything else
the presence relay already keeps in memory — see § 20).

## 3. What does the signaling service learn?

In this architecture the signaling service *is* `livekit-server` (LiveKit
combines SFU and signaling in one process — there is no separate
signaling hop). It learns each connected participant's `identity`
(`playerId`), `name` (nickname), which room they joined
(`LIVEKIT_ROOM_NAME`, a single shared room for this prototype — see
ADR-007), their published/subscribed track state, and — inherently, as a
function of terminating a WebRTC connection at all, not because this
project configured it to — their real network address and standard
ICE/DTLS connection metadata (see § 7).

## 4. What does the SFU/relay learn?

Same answer as § 3 — `livekit-server` is both the signaling service and
the SFU in this architecture, so there is no additional learnable
surface beyond what § 3 already states.

**Precise claim:** standard WebRTC transport encryption
(DTLS-SRTP) protects media in transit between each browser and the SFU,
but **this project has not enabled LiveKit's end-to-end encryption
(E2EE)**. Without E2EE, the SFU is each publisher's actual DTLS/SRTP
endpoint — it is not a blind relay forwarding opaque encrypted bytes
end-to-end between two browsers the way a plain network relay would.
The correct trust model is:

```text
Browser A  ⇄ encrypted WebRTC transport ⇄  LiveKit SFU  ⇄ encrypted WebRTC transport ⇄  Browser B
```

transport is encrypted on each hop (browser↔SFU), but **the self-hosted
SFU is trusted media infrastructure and, without verified E2EE, must be
treated as technically capable of accessing media content** — it is a
trust boundary, not a cryptographic one. "This project does not record
or persist audio" (§ 11) is an **application-level behavior/policy**:
no code path here calls a recording API and no `roomRecord` grant is
ever issued. That is a true, verified, and meaningfully strong
guarantee about what this codebase does — but it is a different claim
from "the SFU is cryptographically unable to inspect audio," which
would require verified E2EE this project does not implement. Do not
read §11's no-recording guarantee as implying that stronger, unverified
claim.

## 5. What does a TURN server learn (if used)?

**Local development** (`livekit-server --dev`) uses no TURN server; it
relies on direct/STUN connectivity.

**A deployment may enable LiveKit's embedded TURN server** for players
whose network blocks direct UDP to the SFU's media port but lets the
TURN port through. What that changes:

- **Who runs it.** The relay is part of the same `livekit-server`
  process, on the same host and operator, as the SFU. No new party is
  added.
- **What it learns.** A relayed player's network address and port, and
  the timing and volume of their traffic. The SFU already sees exactly
  this (§ 3, § 7). It also sees the TURN username LiveKit mints for the
  participant. That username encodes the API key's name (not the
  secret), LiveKit's own session id for the participant and an expiry
  300 s ahead (LiveKit's default). It is handed out only on an
  authenticated signal connection, and carries no nickname, no
  `playerId` and no wallet data.
- **What it cannot see.** The relayed packets are the same DTLS-SRTP
  transport that runs between the browser and the SFU. The TURN relay
  forwards them without decrypting them. (The SFU, the other end of that
  transport, can still access media: § 4.)
- **Peers.** Nothing changes for other players. A relayed player's relay
  address belongs to the server and is offered only to the SFU, so
  players still do not receive each other's addresses through the app's
  topology (§ 7).
- **Logs.** The relay logs through `livekit-server`, so § 13's
  recommendations (a `warn` log level and capped log retention) cover it
  too.

**TURN over TLS on port 443** serves networks that block all UDP and
LiveKit's TCP fallback port. It needs port 443 and its own certificate.
A deployment without it should expect players on such networks to get no
voice or stage; the privacy properties above are the same either way.

## 6. What does the hosting provider / network operator learn?

Whatever any network operator or hosting provider sees for any TCP/UDP
traffic they carry: connection metadata (source/destination
address:port, approximate traffic volume and timing) for the WebRTC
media path to `livekit-server`, same as they already see for the
gameplay WebSocket connection (`docs/privacy/MULTIPLAYER_THREAT_MODEL.md`
§ What network metadata exists?). This is inherent to operating network
infrastructure at all and is not something any application-layer code in
this repository can prevent or needs to try to prevent — it is also not
something this document claims is hidden.

## 7. What IP exposure model does this implementation use?

**Peers do not receive each other's raw network metadata through this
application's topology.** Each browser's WebRTC ICE/SDP negotiation is
with `livekit-server` only (ADR-007); the application's own signaling
(the `/voice/token` HTTP endpoint and LiveKit's own room-join flow)
never relays one participant's ICE candidates, SDP, or address to
another participant.

This is a narrower, precise claim, not a broader one. The relay
infrastructure (`livekit-server` itself, and a TURN server if one is
ever added — see § 5) **inherently observes connection metadata as a
function of operating any media relay**, the same way the application
server inherently sees TCP connection metadata for the gameplay WebSocket
(`MULTIPLAYER_THREAT_MODEL.md`). **This document does not claim "IP
anonymous," "untraceable," or "nobody can know your IP."** Per
`docs/privacy/PRIVACY_MODEL.md`'s binding rule and ADR-007's own framing, the
correct statement is exactly the one above: peers don't receive each
other's raw network metadata *through the app's own topology* — the
relay layer is a different, acknowledged exception to that, not a gap in
it.

## 8. What identifiers are sent to the voice layer?

Exactly one application identifier: the multiplayer `playerId` (a random
UUID, the same ephemeral identifier `MULTIPLAYER_THREAT_MODEL.md` already
describes), passed as the LiveKit token's `identity` field
(`tokenHandler.ts`). The conceptual model is `playerId → ephemeral voice
participant mapping`, never `walletAddress → voice participant` — see
§ 9/§ 10. No device fingerprint, no persistent account identifier, and no
new identifier invented by the voice module itself is sent anywhere.

## 9. Is nickname sent to the voice layer?

**Yes, as display metadata only — never as the security identity, and
never supplied by the browser.**
When `enableVoice()` exchanges its capability for a token,
`WorldServer.resolveVoiceSession()` reads the session's **current**
server-authoritative nickname and that is what `mintVoiceToken()` places
in the token's `name` field — not anything the browser sent (there is
nothing for the browser to send; `VoiceTokenRequest` carries only the
capability). `identity` (the actual security/routing identifier other
code keys off of — subscriptions, mute/block lookups, speaking-state) is
always `playerId`, never `name`/nickname.

A nickname change (`set_nickname`) made *before* a given
voice session's one `enableVoice()` call is correctly reflected (§ 20 —
resolution always reads live state, not a stale snapshot). A nickname
change made *after* that session is already connected does not
retroactively update the already-minted token's `name` — LiveKit
doesn't support mutating a connected participant's metadata without
republishing, which this implementation doesn't do — this remains a
known, harmless display-only staleness, not a privacy gap.

## 10. Is wallet identity sent to the voice layer?

**No, and there is no code path that could.** `tokenHandler.ts`'s
`VoiceTokenRequest` accepts only `{ capability }` from the browser, and
`mintVoiceToken()` accepts only the server-resolved `{ playerId,
nickname }` `VoiceIdentity` — there is no wallet field, no Zcash address
field, no balance/transaction field anywhere in the voice module's
types, request parsing, capability resolution, or token grant. The
in-game wallet exists, but voice receives nothing from it: the only link
is the client-side gate, which reads one local boolean (`canVoice` — is
the wallet unlocked) to enable the "Enable Voice" button and sends
nothing about the wallet anywhere; the server mints tokens without ever
checking a wallet. Watch mode needs no wallet at all.
Voice participation uses only the existing
temporary multiplayer session identity (§ 8), resolved server-side from
an ephemeral capability (§ 20), never a payment identity.

**Wallet holders and guests (ADR-015 § 5).** **Speaking needs a
wallet**; listening does not:
- The capability now resolves to `{ playerId, nickname, canReceive }`.
  `canReceive` is the session's wallet-holder flag — one boolean,
  client-asserted, the same bit every peer sees in presence. Nothing
  else about the wallet reaches the voice module, and nothing at all
  about the wallet goes into the token (no wallet-shaped claim; the
  token tests check this).
- A **full (publishing) grant needs `canReceive`**: a guest's request
  gets `403 {"error":"wallet_required"}`. This is a second layer behind
  the client's own gate (Enable Voice needs an unlocked wallet); a
  modified client that claims the holder flag can still obtain a full
  grant — the flag is honour-system until ADR-016.
- The full grant now also sets `canPublishData: false` (the client never
  uses LiveKit data messages).
- **Guests may listen.** The listen-only grant is unchanged and open to
  every live session. A guest's "Listen to voices (guests can't talk)"
  button starts it: they hear nearby voices by the normal proximity
  rules, the stage microphones and the Watch Hall stage, and can never
  publish. **Speakers should assume their audience may include guests**
  — anyone within range who chose to listen, exactly as before for
  players with a wallet.

## 10a. What a listen-only participant can hear (ADR-015)

Listen mode is now a general voice mode, not only Watch Hall watch mode:
- Honest clients subscribe to nearby microphones by the speaker's range
  (whisper 4 m, talk 12 m, shout 30 m + hysteresis), the stage/floor
  microphones inside the hall, and the stage; mute and block still win.
  It no longer ends 10 s after leaving the hall (outside, only the stage
  stops being downloaded).
- The listen-only grant has `canSubscribe: true` for the whole room, as
  before: a **modified** client can subscribe to any microphone in the
  room, not only nearby ones — "Whisper 4 m" is a courtesy enforced by
  honest clients, not a confidentiality guarantee. This was already true
  for watch mode and for full voice (Watch Hall addendum); ADR-015
  makes it available to guests as well.
- Listeners join the room as non-publishing participants, so the SFU and
  the other participants learn their `identity` (playerId) and `name`
  (nickname — a guest's `Guest-####`), as for any voice user (§ 1, § 3).

## 11. Is voice audio recorded or persisted?

**No.** Three independent reasons this is true, not just a stated
policy:

1. **No recording grant is ever issued.** `mintVoiceToken()` builds its
   LiveKit grant with `roomJoin`/`canPublish`/`canSubscribe` only —
   `roomRecord` is deliberately never set (see the code comment at
   `tokenHandler.ts`'s `addGrant()` call), so a token minted by this
   server could not authorize a recording API call even if one were
   attempted.
2. **No code anywhere in this repository calls a LiveKit recording,
   egress, or composite API.** Voice is transport-only, start to finish.
3. **No audio is written to disk, a database, or any external service**
   by `apps/web/src/voice/` or `apps/server/src/voice/`. There is no
   speech-to-text, no moderation-recording, no voice-clip/voice-message
   feature — all explicitly out of scope.

## 12. Are voice sessions logged?

Not by this application's own code. Neither `apps/web/src/voice/` nor
`apps/server/src/voice/tokenHandler.ts` writes a per-session log of who
connected, for how long, or with whom — the token handler is stateless
per request (§ 2) and the client-side `VoiceClient`/`VoiceSession`
classes hold connection state only in memory for the lifetime of the
page. The one exception, consistent with every other error path in this
codebase (`MULTIPLAYER_THREAT_MODEL.md` § What is logged?), is
`console.warn` on a microphone or voice-connect failure
(`App.ts`'s `onMicrophoneError`/`enableVoice().catch()`) — these log the
error object only, never SDP, ICE candidates, tokens, or audio content,
and exist only in whatever terminal/devtools console is running the
client, not a file or external service.

The `livekit-server` process itself has its own operator-configurable
logging (room/participant join and leave, track publish/subscribe
lifecycle events) — that is LiveKit's own behavior as a server, not
something `apps/server/src/voice/` adds to or configures beyond passing
it the room name. See § 13.

## 13. What metadata appears in voice infrastructure logs by default?

`livekit-server`'s own process logs (stdout, in `--dev` mode) record
room/participant lifecycle events — at minimum each participant's
`identity` (`playerId`) and room name, and, inherently as part of
operating a WebRTC server, standard connection-level metadata for each
peer connection it terminates. This repository's code does not read,
forward, or add to those logs; a production deployment should review and
configure `livekit-server`'s own logging level/retention per its own
documentation before going live, since this document only covers what
*this project's application code* does, not every log line a
self-hosted binary may emit by default. No stress should be read into
that gap — it is flagged explicitly here, per `docs/privacy/PRIVACY_MODEL.md`'s
"document the actual implementation" rule, rather than silently assumed
away.

**Recommended deployment settings:**

- **Log level.** Configure LiveKit with `logging.level: warn` (and
  `pion_level: error`). LiveKit's routine per-participant connection
  lines are logged at `info`, so they are then not written.
- **What can still appear.** Warnings and errors can still include a
  participant `identity` (`playerId`), a room name or a network address.
  A warning level reduces what is written; it does not guarantee that no
  address is ever written.
- **Retention.** Rotate and cap the logs of every service in the stack
  (for example a few files of 10 MB each), so that older LiveKit lines,
  which may carry a `playerId` or an address, are deleted after a bounded
  amount of output instead of accumulating.

**Never logged by this implementation, by construction:** microphone
audio content, SDP bodies, ICE candidates, raw IP addresses, LiveKit
access tokens/API secrets, voice capabilities (§ 20 — temporary
credential material, same discipline as a token or API secret), or
wallet data — none of these are ever passed to a `console.*` call
anywhere in `apps/web/src/voice/` or `apps/server/src/voice/`, and no
test or debug output prints a capability's value either (see
`capability.test.ts`/`WorldServer.test.ts`'s own capability tests,
which assert on resolution behavior, never log the value).

## 14. How long is anything retained?

- **Voice tokens:** 600 seconds (`TOKEN_TTL_SECONDS` in
  `tokenHandler.ts`) — short-lived by design. After expiry a token simply stops working; there is no
  token revocation list or persistent token store (none is needed —
  nothing is persisted in the first place).
- **Voice session state:** held only in the browser tab's memory
  (`VoiceClient`/`VoiceSession`) and `livekit-server`'s own in-memory
  room state — both discarded on disconnect/page close/server restart.
  No database, no file-based voice session store exists anywhere in this
  implementation.
- **Audio:** never retained at all — see § 11.
- **LiveKit's own process logs:** governed by LiveKit's own
  operator-configured logging, not this application — see § 13's caveat.

## 15. Can voice identity be correlated with social or wallet identity?

**Voice identity IS the social/multiplayer identity, by design — the
`playerId` — so "correlated" is the wrong frame for social identity:
they are the same identifier, not two identifiers being linked.** That
is the intended model (§ 8): `playerId → ephemeral voice participant`,
never a second independent identity system to correlate against the
first.

**Wallet identity: no new link, for the same reasons
`MULTIPLAYER_THREAT_MODEL.md` and `SOCIAL_IDENTITY_THREAT_MODEL.md`
already give.** Voice adds no wallet code, no wallet-adjacent field,
and no code path that reads or stores wallet data alongside `playerId`,
nickname, or any voice state (§ 10). The same external-correlation
caveats those documents already state apply unchanged here (a nickname
can itself be identifying, timing/behavioral correlation is not
preventable by protocol design, a future unrelated service could combine
data if one were ever built to) — none of these are code paths this
implementation introduces.

## 16. What happens when a player blocks or mutes another player?

Both are **local-only voice suppression, never transmitted to the server
or the affected player** — see `SocialStore.ts` and
`VoiceSession.update()`:

- **Mute**: `SocialStore.mute()`/`unmute()`
  only ever mutate an in-memory `Set` and call local listener callbacks
  — same no-networking-dependency guarantee
  `SOCIAL_IDENTITY_THREAT_MODEL.md` already documents for block. Muting
  Player B sets that remote audio's gain to `0` on every subsequent
  frame (`VoiceSession.update()`'s `isMuted()` check) without
  unsubscribing from B's track at the SFU — B keeps receiving/sending
  normally, remains visible and interactable, and is never notified.
- **Block** (the social block contract, also read by voice): unchanged —
  `SocialStore.isBlocked()` is read by `VoiceSession.update()` exactly
  like `isMuted()` is, suppressing B's gain to `0` with the same
  no-notification guarantee. The existing block privacy contract
  is unmodified by voice (no new field, no new message type) — voice
  simply became a second, independent consumer of the same local
  boolean.
- Neither mute nor block causes any message to reach the application
  server or `livekit-server` about the relationship — the suppression
  happens entirely in this client's own Web Audio graph
  (`VoiceAudioGraph.setGain(playerId, 0)`), so the blocked/muted player's
  own audio pipeline, subscription, and connection to the SFU are
  completely unaffected and give them no signal anything changed.

## 17. What happens when microphone permission is denied or unavailable?

Voice connection and the rest of the application continue normally.
`VoiceClient.enableMicrophone()`'s failure is caught at the
`VoiceSession.enableVoice()` boundary and surfaced only via
`onMicrophoneError` (never thrown past that point) — the user stays
connected to the SFU (able to hear others) but simply
can never transmit. No repeated permission prompt is ever issued
(`VoiceControls`'s "Enable Voice" button is a single explicit gesture;
nothing in this codebase calls `enableMicrophone()` automatically or in
a retry loop). Movement, multiplayer, nickname, and social features are
entirely unaffected — voice is additive, never a gate (see the
"Voice failure does not crash core app state" unit test and the e2e
suite, both of which pass with no voice server running at all).

## 18. What happens when the SFU is unreachable or voice is unconfigured?

Two independent cases, both already exercised by this implementation's
tests:

- **Server-side unconfigured** (`LIVEKIT_API_KEY`/`SECRET`/`URL` unset):
  `loadVoiceConfig()` returns `null`, `/voice/token` responds `503`, and
  nothing else about the server is affected — the gameplay WebSocket
  server starts and runs identically either way (`apps/server/src/index.ts`).
- **Client-side connect failure** (LiveKit unreachable, token request
  fails, or `Room.connect()` rejects): `VoiceClient` reports state
  `"error"` (never an uncaught exception), `App.ts`'s
  `enableVoice().catch()` logs a `console.warn` and sets `VoiceControls`
  to the `ERROR` label. The world, movement, multiplayer presence,
  nickname, and social/block/mute systems are all unaffected — none of
  them have any dependency on voice having connected successfully.

**Failures are explained, and local development has voice (2026-10-08).** The data flows above are unchanged; two things are new.

- **Precise messages.** `apps/web/src/voice/voiceErrors.ts` maps each
  failure to its cause and shows it in the voice panel and as one chat line:
  no voice server (`/voice/token` now answers `503
  {"error":"voice_unconfigured"}`), an insecure page, a refused or
  OS-blocked permission, no or busy microphone, a guest session (`403
  wallet_required`), an unknown session, an unreachable or refusing SFU,
  blocked media. Nothing is sent anywhere: the classification runs in the
  browser. The insecure-page message quotes the page's own host back to the
  player. Still no automatic retry and no repeated prompt: "Try again" is
  another explicit click. One exception, which asks for no permission:
  when the token answer is `wallet_required` but the browser holds an
  unlocked wallet, the client re-sends its `set_wallet` flag (the one
  wallet-derived bit, ADR-015) and requests the token once more.
- **The local development SFU.** The root `npm run dev` starts
  `livekit-server` 1.13.8 on this computer (`scripts/dev/livekit.mjs`).
  The binary is downloaded once from the official GitHub release, its
  SHA-256 checked against the release's `checksums.txt` before use, and
  cached under `node_modules/.cache/livekit/`. It listens for signalling on
  127.0.0.1 only and uses the `--dev` placeholder keys (`devkey` /
  `secret`), which the game server uses only when started with
  `--local-livekit`, never with `NODE_ENV=production`, and never over a
  configured `LIVEKIT_*`. A deployment runs its own LiveKit with
  generated keys.

## 19. What privacy claims does this document make — and refuse to make?

**Made:** peers do not receive each other's raw network metadata through
this application's own signaling topology (§ 7); voice identity is the
existing ephemeral multiplayer `playerId`, never a wallet identifier
(§ 8–10); no audio is recorded, transcribed, or persisted anywhere in
this implementation (§ 11); mute and block suppress voice locally without
notifying the affected player or informing the server of the
relationship (§ 16); no voice access token or API secret is ever
reachable from client code (`apps/server/.env.example`,
`apps/web/.env.example` — only a non-secret endpoint URL ships to the
browser).

**Refused:** "anonymous," "untraceable," "the server/SFU knows nothing,"
or any equivalent phrasing anywhere in this project's UI, documentation,
or marketing copy about voice. The SFU relay (and a TURN server, if one
is ever added) inherently observes connection metadata as a function of
relaying real-time media at all (§ 3–7) — this document states that
plainly rather than implying otherwise, per `docs/privacy/PRIVACY_MODEL.md`'s
binding rule.

Also explicitly refused (§ 4): **"the SFU cannot decrypt audio," "media is end-to-end encrypted
between users," or "the relay is cryptographically blind to content."**
None of these are true of this implementation — E2EE is not enabled, so
the self-hosted LiveKit SFU is a trust boundary with technical access to
media content, not a cryptographically blind relay. "This project does
not record audio" (an application-level behavior this codebase
genuinely guarantees, § 11) is never to be read or restated as "the SFU
cannot access audio" (a cryptographic guarantee this codebase does not
make).

## 20. Voice capability authentication

**Why a capability.** `/voice/token` never accepts a client-supplied
`{ playerId, nickname }`. Every connected client already learns every
other player's `playerId` through the ordinary multiplayer protocol
(`player_snapshot`/`player_joined`), so minting a token from such values
would let any client request a voice token *as* another visible player.
LiveKit participant identity is the routing/security identity for
subscriptions and track ownership, so that would be a real
voice-identity-impersonation vulnerability, not a cosmetic one.

**Capability generation.** `WorldServer` (not the voice module — see §
module boundaries below) issues one cryptographically random capability
per successfully joined session, via `VoiceCapabilityRegistry.issue()`
(`apps/server/src/voice/capability.ts`): 32 bytes from Node's
`crypto.randomBytes`, base64url-encoded. It is **not** the `playerId`
encoded differently — knowing a `playerId` (which every client already
does, for every player) grants no ability to derive, guess, or forge
another session's capability.

**Capability delivery.** Sent exactly once, in the `welcome` message
(`WelcomeMessage.voiceCapability`) — which, like every other `welcome`
field, is sent only to the connecting session itself, never broadcast.
The shared protocol's own type documents this field as owner-only and
forbids adding it to any peer-visible message
(`player_snapshot`/`player_joined`/`player_transform`/
`nickname_updated`/nameplates). No other code path ever transmits a
capability.

**Capability lifetime and invalidation.** At most one live capability
per session at a time (`issue()` invalidates any previous one for that
`playerId` first). Invalidated immediately on disconnect
(`WorldServer.handleClose`) and on stale-connection cleanup
(`sweepStaleConnections`'s `ws.terminate()` triggers the same `close`
handler) — there is no window where a disconnected session's capability
still works. A reconnect is always a brand-new WebSocket connection with
a freshly generated `playerId` (the multiplayer identity model has
no session resumption), so it always receives a brand-new capability
via the next `welcome`; the previous one stays permanently invalid.
Capabilities are never persisted to disk or any datastore — purely
in-memory, process-lifetime state, same as every other session field
`WorldServer` already keeps.

**Server-side resolution.** `WorldServer.resolveVoiceSession(capability)`
is the only interface the voice module is allowed into `WorldServer`'s
session state — it resolves a capability to that session's
`playerId`, then reads the **current** nickname fresh from live session
state (not a snapshot taken at `issue()` time), so a nickname changed
via `set_nickname` after join is correctly reflected in the next token
minted from that capability. An unknown, revoked, or superseded
capability resolves to `null`, and the HTTP handler
(`createVoiceTokenHandler`) treats that as an outright rejection
(`403`) — there is no fallback to anything browser-supplied, because
nothing browser-supplied is read in the first place
(`VoiceTokenRequest` is `{ capability: string }` only; an extra
`playerId`/`nickname` field in the request body is parsed out and
silently ignored, never merged into the minted identity — see
`tokenHandler.test.ts`'s impersonation-attempt tests).

**What this is, and is not.** A capability is temporary credential
material — same handling discipline as a LiveKit token or the LiveKit
API secret (§ 13's "never logged" list now includes it explicitly). It
is **not** a persistent account, not a password, not tied to any
cookie, and not wallet identity of any kind — it exists only for the
lifetime of one WebSocket connection and authorizes exactly one thing
(minting a voice token for the session it was issued to). No database
was introduced to support this; `WorldServer`'s existing in-memory
session map already owns everything this needed.

**Browser-supplied identity trust (restated plainly):** the browser's
claimed `playerId` is **never** trusted as voice-token authority. The
browser's claimed nickname is **never** trusted as voice-token
authority. The only authoritative source for both is server-side
session state, resolved from the capability.


## Addendum (2026-10-06): ranges, subscriptions, screen sharing

- **Speaking range** (Whisper 4 m / Talk 12 m / Shout 30 m) is published as a LiveKit participant
  attribute (`voiceRange`). Other participants in the room can read it; it carries no identity.
- **Distance-based subscription:** clients subscribe to a speaker's audio only within that
  speaker's range plus a margin. Far voices are no longer downloaded, which reduces what a client
  receives. The SFU still knows all participants in the room, as before.
- **Token sources:** voice tokens may publish **microphone and screen share only**; webcam
  publishing is impossible at the token layer. `canUpdateOwnMetadata` is granted for the range
  attribute (the earlier `screen` attribute was removed with the Watch Hall); display names in the game come
  from the multiplayer server, never from LiveKit metadata.
- **Screen sharing** — *superseded by the Watch Hall addendum below: the earlier outdoor screen,
  its `screen` attribute and the 28 m radius are gone.* As first built (`ScreenShareSystem.ts`,
  removed):
  - It requires an explicit in-game confirmation that warns not to show seeds or wallets, then
    the browser's own picker and sharing indicator. It is video only, with no system audio.
  - The `screen` attribute names which in-world screen a share is for.
  - Viewers subscribe only within 28 m of that screen; blocked players' shares are never shown.
  - **Risk:** whatever a player shares is visible to everyone nearby and passes through the SFU
    unencrypted (no E2EE, same as voice). The warning says so; the share can be stopped at any
    time.
- **Disconnect:** when the game WebSocket drops, the client now leaves the voice room too. This
  fixes voices staying audible after their avatar disappeared.

## Addendum — Watch Hall (2026-10-07): the stage, tab audio, watch mode

Decided in `docs/decisions/ADR-014-watch-hall.md` §§ 3–5; design in
`docs/architecture/WATCH_HALL.md` § 6. Code: `apps/web/src/hall/StageSystem.ts`,
`apps/web/src/voice/` (`VoiceClient`, `VoiceSession`, `VoiceAudioGraph`, `hallAudio`),
`apps/server/src/watchHall.ts`, `apps/server/src/voice/tokenHandler.ts`. The Watch Hall threat model
(`docs/privacy/WATCH_HALL_THREAT_MODEL.md` § Stage sharing and hall audio) restates this from the
hall's side.

- **A server-arbitrated stage replaces the in-world screen.** The earlier outdoor screen
  and its self-asserted `screen` participant attribute are removed, together with their
  stale-claimant bug and the "any client can claim the screen" griefing vector. The game server
  keeps one stage queue in memory (`MULTIPLAYER_THREAT_MODEL.md` addendum) and tells hall members
  the holder's and queue's playerIds. Nothing about the stage is read from LiveKit attributes,
  which now carry only `voiceRange`.
- **What is shared — with audio.** The holder shares a browser tab, a window or the whole screen,
  chosen in the browser's own picker (`displaySurface: "browser"` only pre-selects the tab list).
  The share's audio is captured without echo cancellation, noise suppression or gain control and
  published as `ScreenShareAudio` (stereo, music preset, no DTX); the token already allowed that
  source, and webcam publishing stays impossible.
- **System audio is excluded by default** (`systemAudio: "exclude"`): on Windows it would
  re-broadcast the game's own playback of other players' voices to the hall — a privacy leak and
  an echo loop. **Opt-in computer sound** (ADR-014 § 4): the confirm dialog's box "Share my
  computer's sound (whole screen or window; Windows/ChromeOS)" asks for `systemAudio: "include"`.
  - The dialog warns that notifications and other apps' sound (for example another call) are
    shared too.
  - While that share is live, **the holder's own incoming hall audio — every voice and the stage —
    is muted** at the Web Audio listener, set *before* the picker opens, so nothing the game plays
    is captured back. It is restored when the share ends or loses its audio.
  - Residual risk: anything else the computer plays (other tabs, other apps) is captured. The
    holder chose that, after the warning.
- **Consent and start.** Only from the holder's click: the dialog says everyone in the hall sees
  the content **and hears its audio**, and never to show a seed phrase, passwords or a wallet; then
  the browser's own picker and sharing indicator. With no audio track, the holder is told how to
  add one. Publishing needs full voice (an unlocked wallet); a listen-only token cannot
  publish anything.
- **Live and ended** are reported to the game server (`hall_stage_live {live, audio}`) from LiveKit
  events — the publish result, local unpublish, track end — never from the game loop. Losing the
  holder role (handover, host stop, prepare timeout, or 15 s after walking out) stops the share.
- **Hall-only subscription.** Subscriptions stay manual (`autoSubscribe: false`). A client
  subscribes to the ScreenShare and ScreenShareAudio of **exactly the server-named holder**, only
  while its own player is inside the hall (2 m exit hysteresis) and has not blocked that player.
  Every other screen publication in the room — for example from a modified client that never got
  the stage — is never downloaded by honest clients. Outside the hall nothing of the stage is
  downloaded or heard.
  - The SFU still announces publications (track metadata, not media) to every room participant.
  - Hall membership is a social scope, not access control (ADR-005, ADR-014 § 2): a modified client
    could subscribe to the holder's tracks from anywhere in the room.
- **Playback.** The stage audio plays through one non-positional channel, separate from the
  per-player microphone nodes, at stage volume × master volume, lowered while the viewer's own
  personal player is open, and silent when the viewer muted the holder (local only, § 16). The
  stage volume is stored per device in `localStorage` (`watch-hall-stage-volume-v1`, a number).
  The full-size viewer overlay is muted, so nothing plays twice. Each remote stream is also
  attached to a muted, off-DOM `<audio>` element (Chromium needs it to feed WebRTC into Web Audio);
  it outputs nothing.
- **Stage mic and floor.** The holder's microphone, and that of a member given the floor
  (`hall_floor`), is heard at distance 0 by every listener inside the hall, so it carries hall-wide
  whatever range the speaker picked. This is decided from server state only, never from a
  participant attribute (`parseVoiceRange` still accepts only whisper, talk and shout). Audience
  microphones keep their normal ranges; mute and block still win.
  - **Consent.** Taking the stage is the holder's own request. The floor goes only to a member who
    raised a hand (the server refuses anyone else with `not_raised`), and the member with the floor
    can give it up (`hall_floor {playerId: null}`) at any time.
  - **Notice.** The speaker is told when their microphone becomes hall-wide: a chat line on getting
    the stage or the floor, "🎙 You have the floor" in the stage panel header (also collapsed), and
    "🎙 Hall-wide" next to the range buttons in the voice controls.
  - **Only inside.** A stage mic needs the speaker's avatar inside the hall as well (2 m exit
    hysteresis): a holder who walks out — or teleports away — keeps the turn for the 15 s leave
    grace, but whatever they say outside keeps its normal range.
- **Watch mode (listen-only).** Watching needs no wallet (ADR-014 § 5).
  - `POST /voice/token` accepts `{ capability, listenOnly: true }` and mints a strictly narrower
    grant: `canPublish: false`, no publish sources, no data, no metadata updates. The server only
    ever narrows the grant.
  - The client never captures the microphone in this mode. (ADR-015: listen mode also subscribes to nearby microphones by the normal proximity rules — § 10a.)
  - It starts from the "▶ Watch the stage (audio + video)" click (the audio context resumes inside
    that gesture) — or, for anyone without an unlocked wallet, from "Listen to voices" in the voice
    controls. Since ADR-015 it no longer ends 10 s after leaving the hall. A wallet lock does not end
    it (it still ends full voice). "Enable Voice" upgrades by reconnecting with the full grant
    (wallet holders only).
  - Listen-only viewers join the LiveKit room as non-publishing participants: the SFU and the other
    participants learn their `identity` (playerId) and `name` (nickname), as for any voice user
    (§ 1, § 3), and the SFU learns their network address (§ 7). They publish nothing.
- **What the SFU and hall members see.** The self-hosted SFU carries the holder's video and audio
  and, without end-to-end encryption, can technically access both (§ 4). Hall members see and hear
  whatever the holder shares. No recording grant exists: § 11 covers screen video and tab or system
  audio too, and there is no egress.
- **Not claimed:** no end-to-end encryption; no guarantee that a holder never shows something
  sensitive; no guarantee that nobody outside the hall can obtain a share with a modified client.

## Addendum — verified identity (2026-10-08): a server-verified identity for the full grant; share quality

Design: `docs/architecture/WATCH_HALL.md` § 6 (share quality) and § 12 (stage moderation). Code:
`apps/server/src/WorldServer.ts` (`mayPresent`), `apps/server/src/voice/tokenHandler.ts`,
`apps/web/src/voice/stageShareQuality.ts`, `VoiceClient.ts`.

- **Who gets the publishing grant.** `/voice/token` now resolves two facts from live session state: `canReceive` (the
  ADR-015 holder flag) and `canTalk`. While a name registry runs (`NAME_REGISTRY=dev`/`zcashd` on the test chain, or
  `lightwalletd` — the mainnet backend, ADR-018, where the name fee is real ZEC), `canTalk` is true only
  for a session showing an **owned name** — confirmed with the on-chain fee or claimed by a signature from the
  wallet's name key (ADR-016) — so the client-asserted flag alone no longer buys a microphone: a holder without one
  gets 403 `name_required`, a guest still gets 403 `wallet_required`. Without a registry (or with a `disabled` one)
  `canTalk` equals the holder flag, as before (§ 10, ADR-015 § 6). The listen-only grant is unchanged. The same rule
  gates the stage and the floor on the game server.
- **What the operator learns.** Nothing new: the server already knew which session shows which owned name.
- **Residual.** A token is checked when the room is joined. A session that loses its identity afterwards (forgets the
  wallet, or the owner's newer session takes the name) keeps its connected LiveKit session until it reconnects — its
  microphone keeps its normal proximity range but is never hall-wide (the stage and the floor are dropped at once).
  Revoking a participant through the LiveKit server API closes this (Moderation addendum below).
- **Share quality.** The stage share is published with an explicit top layer (Slides: 1080p, 30 fps, ≤ 3.5 Mbps,
  content hint `detail`; Video: 1080p, 60 fps, ≤ 7 Mbps, `motion`) plus 720p30 and 360p15 simulcast layers; viewers
  request the top layer on the high render tier and 720p30 on the low tier. This changes bitrate and frame rate only:
  the same SFU, the same participants and the same subscription rule (only the server-named holder) — nothing new is
  exposed. Higher bitrates mean the presenter's uplink and the SFU's upload carry more
  (`docs/architecture/WATCH_HALL.md` § 6).

## Addendum — Moderation (2026-10-09): the server revokes LiveKit publishers (ADR-019 § 6)

- **What changed.** The game server now calls LiveKit's RoomService (its HTTP/Twirp API) itself:
  `UpdateParticipant` with a subscribe-only permission (`canPublish: false`, no sources, no data, no metadata) when a
  stage turn is **taken** from its holder — a host's or moderator's stop or grant to someone else, an audience vote, a
  cooldown — or when a session **loses** the right to talk (a forgotten wallet, its owned name taken over by the
  owner's newer session); `RemoveParticipant` on a **kick or ban**. A turn the holder ends itself, and the timeouts,
  don't revoke (the honest client unpublishes anyway). This closes the gap "a token minted before the
  identity was lost keeps publishing until it reconnects".
- **Credentials.** Each call carries its own admin token: `roomAdmin` for the one room (`LIVEKIT_ROOM_NAME`), valid
  60 seconds, signed with the existing `LIVEKIT_API_SECRET` by the SDK the server already uses (no new dependency).
  The secret still never leaves the server. `LIVEKIT_API_URL` (optional) lets the server reach RoomService over an
  internal network.
- **What LiveKit learns.** Nothing new: the participant identity (the opaque playerId) it already has, and that the
  server changed its permission or removed it. No nickname, reason or report is sent.
- **Logging.** A failure is retried once, then logged as `livekit revoke failed` — no identity. A participant LiveKit
  doesn't know (404) is not a failure. LiveKit's own logs (level `warn`) are unchanged (§ 13).
- **What the client does.** On a revoke the client stops and releases its microphone and any share (the device is
  let go, not just muted) but keeps its subscribe-only room: it drops to listening — nearby voices and the stage keep
  playing — and says why. Enable Voice asks for a new full token, minted only if the server still
  allows talking (owned name / holder rules, verified identity addendum). Honest
  viewers still subscribe only to the server-named holder (Watch Hall addendum), so a rogue share was already never
  downloaded; the revoke also stops its upload at the SFU.
- **Verified against a real LiveKit** (v1.13.8): `tests/e2e/moderation-livekit-real.spec.ts` — a publisher benched by
  a moderator shows `canPublish: false` and no published tracks in `ListParticipants`; a kicked one is gone from it.
