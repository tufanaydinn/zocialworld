# ADR-001: Client-authoritative movement for CORE-002 multiplayer

## Status

Accepted

## Context

CORE-002 introduces the first real multiplayer transport. A standard
question for any networked game is who owns movement truth: the client
that's actually being played, or the server relaying it to everyone
else. Full server-authoritative movement (server simulates every
player, clients only ever render server state, server rejects/corrects
client-reported positions) is the standard answer for competitive or
cheat-sensitive games.

This project is explicitly not that. Per the master spec (section 2)
and CORE-001's own framing, this is a social hub: players walk around a
small space and talk to each other. There is no PvP, no scoring, no
economy tied to position, nothing a player meaningfully gains by
spoofing their own location to another player.

## Decision

For CORE-002, **the local client is the movement authority for its own
player.** The server:

- relays each client's `player_transform` to the other connected
  clients,
- performs sanity validation (finite numbers, known message shape,
  known animation state, basic rate limiting — see
  `docs/protocols/multiplayer-protocol.md` § Server-side validation),
- does **not** run its own physics/collision simulation, does **not**
  track a "true" position per player, and does **not** correct or
  reject a transform merely for being different from what the server
  would have computed (there is no such computation).

This is a deliberate, documented choice, not an oversight — CORE-002 §19
explicitly calls for it and explicitly rules out building full
server-authoritative physics in this task.

## Consequences

- A malicious client *can* report an impossible position (e.g. teleport
  across the map, walk through a building) and other clients will
  render it. There is no anti-cheat here beyond sanity bounds (finite
  numbers, plausible message rate). For a social space with no
  competitive stakes, this is an accepted risk for CORE-002.
- The server stays simple: no physics step, no authoritative world
  state to keep in sync, no reconciliation/replay logic on the client.
  This keeps the multiplayer foundation small and testable, consistent
  with CORE-002's "keep dependencies minimal, no anti-cheat system"
  instructions.
- **This must be revisited before any feature introduces real stakes
  tied to position** — most notably, if a future task ties ZEC
  support/payment flows, exclusive spaces, or any competitive mechanic
  to a player's in-world position, client-authoritative movement likely
  becomes insufficient and needs a new ADR superseding this one (a
  multiplayer framework/authority change requires careful architectural
  review before implementation).
- Voice (an early core feature per `packages/voice/README.md`) needing
  "who is near whom" is compatible with this model — proximity is a
  presentation detail, not something requiring server-verified
  positions, as long as spoofed proximity carries no real-world stakes.

