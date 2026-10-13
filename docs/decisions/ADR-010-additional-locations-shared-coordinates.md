# ADR-010: Additional locations in one shared world coordinate space (first: Learning Valley)

## Status

Accepted (2026-10-06)

## Context

The portal lists destinations beyond the starting district. The first
one, **Learning Valley** (a structured Zcash education district with
lesson stations following LEARN → SEE → TRY → PROVE), needs its own
environment, atmosphere focus, minimap and stations.

`apps/web/src/world/World.ts` already anticipates more locations ("would
be swapped in here behind the same `scene` without other systems needing
to change"), but there are several ways to do it, and some of them would
touch decisions that already have an ADR:

- **Separate scenes / rooms per location** would require the
  multiplayer server to know which location each player is in (a
  protocol + framework change, ADR-006 territory) so players in different
  locations don't appear in each other's world.
- **Server-side progress** for the valley would need an account / identity
  model (identity model change) and would tie learning progress to a
  persistent identifier.

## Decision

1. **All locations share one world coordinate space.** Each location is
   built at its own far-away origin (the central slot at the origin, an
   east slot at x = +1000 m, a west slot at x = −1000 m;
   `apps/web/src/world/locations.ts`). The multiplayer protocol is unchanged: remote
   players simply are where they are; someone in another location is
   1 km away, beyond camera range.
2. **The client renders only the active location.** `World` decides the
   active location from the camera position each frame and toggles each
   location's root group (so inactive locations cost nothing to render),
   moves the key light/shadow frustum to the active location, and exposes
   the active location's minimap. Ground height and colliders of all
   locations are registered once; they never overlap.
3. **Travel is a teleport** through the existing portal menu (portal at
   each location, plus doors a location defines), using the same
   flash/camera-snap path as in-district waypoints.
4. **Learning progress is local-only** (`localStorage`, per browser),
   never sent to the server and never linked to the nickname or any
   wallet. Clearing site data resets it. No account system is introduced.
5. **Real testnet verification is out of scope for this decision.**
   Testnet Academy missions are guided (in-game simulations are verified
   in-game; real-wallet steps link out explicitly). A verification service
   (faucet / explorer integration, viewing-key or memo based) needs its
   own ADR, a privacy review and a partner agreement first.

## Consequences

- No change to the camera model, collision approach, multiplayer
  framework/protocol, identity model or rendering stack.
- Players in another location still receive each other's presence
  messages (bandwidth grows with total player count, not per location).
  Interest management/sharding stays a future item (`ROADMAP.md`).
- Voice proximity naturally excludes players 1 km away.
- Learning progress does not follow a player across devices/browsers; a
  future opt-in sync would need an identity ADR.
- Each new location must pick a free slot and register its regions in
  `World`'s active-location test. The Watch Hall (ADR-014) uses the west
  slot.
- Systems never import a particular location: a content provider supplies
  the location modules (`apps/web/src/content/README.md`).
