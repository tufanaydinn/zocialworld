# ADR-003: Proximity voice transport — self-hosted LiveKit SFU

## Status

Accepted

## Context

CORE-004 is the first real voice implementation in this repository.
`packages/voice/README.md` and `docs/privacy/README.md` already bind any
future voice work to a hard requirement: raw peer-to-peer WebRTC must not
be adopted blindly, specifically because a P2P mesh exposes every
participant's network address to every other participant's browser
through the application's own signaling — the opposite of what CORE-004
§3/§5 asks for. An SFU (Selective Forwarding Unit) relay topology avoids
this by construction: each browser only ever negotiates ICE/SDP with the
relay server, never with another participant's browser, so peer IP
exposure through the app's own topology is eliminated rather than merely
obscured.

CORE-004 also requires: self-hostable for local development (no paid
SaaS account, no committed secrets), mature dependencies ("do not
implement an SFU from scratch"), clean TypeScript/web integration, and a
short-lived scoped server-minted token model.

## Options considered

| Criterion | **LiveKit** (self-hosted) | mediasoup | Janus |
|---|---|---|---|
| Browser support | Excellent — official `livekit-client` SDK handles the full WebRTC lifecycle (negotiation, reconnection, simulcast, track pub/sub) | Good, but `mediasoup-client` is a lower-level toolkit — you still build your own signaling/room protocol on top | Works, but no modern first-party TS SDK comparable to the above two; community wrappers vary in quality |
| Self-hosting | Yes — single Go binary or container, Apache-2.0 | Yes — Node.js library + native worker, MIT | Yes — C server with a plugin architecture, GPLv3 |
| Server complexity | Low-moderate — `livekit-server` is a turnkey server; token minting is a small JS library call, not a service | **High** — mediasoup gives you the media primitives (routers/transports/producers/consumers) but *you* must build the entire room/signaling/auth layer yourself | High — plugin configuration (e.g. AudioBridge), admin APIs, systems-level ops knowledge |
| TypeScript/web integration | First-class, actively maintained, typed | Partial — Node-side has TS types, but the client experience is DIY | Weaker — no first-party TS SDK |
| SFU support | Yes, this is the product | Yes, this is the product (as a library) | Yes, via plugins |
| Peer IP privacy | Each browser's ICE/SDP negotiation is with the LiveKit server only — no browser ever receives another browser's ICE candidates/IP | Same topology property **if** you implement the signaling correctly — more surface area for us to introduce a leak by hand-rolling it | Same topology property, same caveat, with a less web-native toolchain making mistakes more likely |
| Scaling model | Single-node for a prototype; Redis-backed multi-node for production (not needed now) | Flexible but entirely your own responsibility to design | Flexible but entirely your own responsibility to design |
| Local dev difficulty | **Low** — `livekit-server --dev` starts instantly with placeholder keys, verified working in this repo's own sandboxed dev container (see "Verification" below) | Moderate-high — rooms, auth, and signaling must exist before anything works at all | High — native build toolchain, plugin config, NAT/ICE tuning before first audio flows |
| Future spatial/proximity suitability | Good — per-participant subscribe/unsubscribe is a first-class SDK operation; distance-based gain is done client-side via Web Audio regardless of SFU choice | Good in principle, but means building more of this ourselves | Possible, but AudioBridge is mixing-based, not the same clean per-track model |
| Operational burden | Low for one process; moderate for production HA (TURN, certs) | Higher — mediasoup needs careful RTC port range / announced-IP configuration, a common source of "no media flows" bugs | Higher — C dependency chain, plugin surface |
| Licensing | **Apache-2.0** — permissive | ISC — permissive | **GPLv3** — copyleft, more restrictive than either alternative |
| Vendor lock-in | Low — open-source self-hosted server; switching SFU later is contained to the voice module (see CORE-004's module-boundary requirement) | None technically, but the bespoke signaling/room code we'd have to write becomes *our own* lock-in | Low technically, same caveat as mediasoup plus a heavier runtime to replace |

## Decision

**Self-hosted LiveKit** (`livekit-server`, Apache-2.0), with `livekit-client`
(browser) and `livekit-server-sdk` (Node, server-side token minting
only).

This is the only option of the three that is a complete, turnkey,
self-hostable SFU with a first-class TypeScript client SDK — it directly
satisfies "do not implement an SFU from scratch" without requiring us to
also hand-build a signaling/room/auth protocol (which mediasoup would
require) or take on a heavier, less web-native runtime with a more
restrictive license (Janus). Its token model (`AccessToken`, server-side,
short-lived, scoped to one room + one identity) maps directly onto
CORE-004 §10's requirement.

**No paid service is used or required.** LiveKit Cloud is a separate,
optional commercial offering from the same project; this decision uses
only the open-source, self-hostable `livekit-server` binary. No account
was created, no payment credential was used or is required to run this
locally or to deploy it on infrastructure the project already controls.

### Verification performed for this decision

`livekit-server` (built from the official `github.com/livekit/livekit-server`
source, tag `v1.13.7`) was built and run in this repository's own sandboxed
development container to confirm the self-hosted path is real, not
theoretical:

```text
$ livekit-server --dev --bind 0.0.0.0
...starting LiveKit server  {"portHttp": 7880, ...}
$ curl http://127.0.0.1:7880/
200
```

`--dev` mode uses placeholder keys (`devkey`/`secret`) printed to the
console — these are LiveKit's own well-known development defaults, never
used for anything beyond local development, and never committed to this
repository (see `apps/server/.env.example`).

## Peer IP exposure model (binding on the implementation)

- A browser's WebRTC ICE/SDP negotiation is with `livekit-server` only.
  No browser ever receives another browser's ICE candidates, SDP, or
  (therefore) IP address through this application's signaling.
- This does **not** mean "nobody knows anyone's IP" — see
  `docs/privacy/VOICE_THREAT_MODEL.md` for the precise, non-marketing
  statement of what the LiveKit server, a TURN server (if configured),
  the hosting provider, and the network operator each inherently see as
  a function of operating any media relay at all. No "anonymous" or
  "untraceable" claim is made anywhere in this project about voice.

## Consequences

- A new runtime dependency exists for local development: a running
  `livekit-server` instance. Documented in `apps/server/README.md` /
  `.env.example` — the normal path for a developer with ordinary
  internet access is a prebuilt binary (GitHub releases) or
  `docker run livekit/livekit-server`; building from source was this
  session's own verification path given this specific sandbox's egress
  restrictions, not the documented developer workflow.
- Voice failure (no reachable LiveKit server) must not block the rest of
  the application — enforced in `apps/web/src/voice/` as a `"error"`
  state, never a thrown/uncaught exception (see CORE-004 §28, tested).
- The voice module (`apps/web/src/voice/`, `apps/server/src/voice/`)
  stays structurally separate from the gameplay WebSocket protocol
  (`apps/web/src/networking/`, `apps/server/src/WorldServer.ts`) per
  `packages/voice/README.md`'s pre-existing requirement — `WorldServer`
  remains a presence relay only, never a media/token service.
- If a future task needs multi-node scaling, TURN for restrictive
  networks, or a different SFU entirely, that is a new ADR — this one
  only covers the CORE-004 single-node prototype.
- `packages/voice/README.md` is updated to reflect this decision; it
  remains documentation-pointing-at-application-code, not an activated
  workspace package (no code here is genuinely shared between apps/web
  and apps/server beyond the small wire-contract already justified for
  `packages/shared` — see CORE-004 §37/§38).

