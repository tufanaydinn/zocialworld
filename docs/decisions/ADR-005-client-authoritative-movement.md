# ADR-005: Client-authoritative movement for multiplayer

## Status

Accepted (2026-10-02)

## Context

The first multiplayer transport needs an answer to a standard
question for any networked game: who owns movement truth: the client
that's actually being played, or the server relaying it to everyone
else. Full server-authoritative movement (server simulates every
player, clients only ever render server state, server rejects/corrects
client-reported positions) is the standard answer for competitive or
cheat-sensitive games.

This project is explicitly not that. Zocial World is a social hub:
players walk around a
small space and talk to each other. There is no PvP, no scoring, no
economy tied to position, nothing a player meaningfully gains by
spoofing their own location to another player.

## Decision

**The local client is the movement authority for its own player.** The
server:

- relays each client's `player_transform` to the other connected
  clients,
- performs sanity validation (finite numbers, known message shape,
  known animation state, basic rate limiting — see
  `docs/protocols/multiplayer-protocol.md` § Server-side validation),
- does **not** run its own physics/collision simulation, does **not**
  track a "true" position per player, and does **not** correct or
  reject a transform merely for being different from what the server
  would have computed (there is no such computation).

This is a deliberate, documented choice, not an oversight: full
server-authoritative physics is out of scope for the multiplayer
foundation.

## Consequences

- A malicious client *can* report an impossible position (e.g. teleport
  across the map, walk through a building) and other clients will
  render it. There is no anti-cheat here beyond sanity bounds (finite
  numbers, plausible message rate). For a social space with no
  competitive stakes, this is an accepted risk.
- The server stays simple: no physics step, no authoritative world
  state to keep in sync, no reconciliation/replay logic on the client.
  This keeps the multiplayer foundation small and testable, with
  minimal dependencies and no anti-cheat system.
- **This must be revisited before any feature introduces real stakes
  tied to position** — most notably, if a future task ties ZEC
  support/payment flows, exclusive spaces, or any competitive mechanic
  to a player's in-world position, client-authoritative movement likely
  becomes insufficient and needs a new ADR superseding this one (a
  multiplayer framework/authority change requires careful architectural
  review before implementation).
- Positions stay client-reported in the features built since: Watch Hall
  membership is a social scope, not access control (ADR-014), and
  payments and the stage rely on server-verified identity rather than
  position (ADR-013, ADR-015, ADR-016).
- Voice (an early core feature) needing
  "who is near whom" is compatible with this model — proximity is a
  presentation detail, not something requiring server-verified
  positions, as long as spoofed proximity carries no real-world stakes.
