# Architecture Decision Records

An ADR records one architecture decision: the context that forced it, the decision, and its consequences.
Read the relevant ADRs before proposing a change to something they cover.

## Published ADRs

The numbers are not contiguous: some decisions are not published in this repository, and numbers are
never reused or renumbered, so code comments and other documents can cite an ADR by its number.

| ADR | Decision | Status |
|---|---|---|
| [ADR-001](ADR-001-threejs-typescript-vite.md) | Three.js, TypeScript and Vite as the client stack | Accepted |
| [ADR-002](ADR-002-third-person-camera.md) | Third-person over-the-shoulder camera | Accepted |
| [ADR-003](ADR-003-monorepo-structure.md) | Monorepo structure with npm workspaces | Accepted |
| [ADR-004](ADR-004-no-physics-engine-for-core-prototype.md) | No physics engine; a lightweight 2.5D collision system | Accepted |
| [ADR-005](ADR-005-client-authoritative-movement.md) | Client-authoritative movement for multiplayer | Accepted |
| [ADR-006](ADR-006-shared-multiplayer-protocol-contracts.md) | `packages/shared` for the multiplayer wire protocol contracts | Accepted |
| [ADR-007](ADR-007-proximity-voice-transport.md) | Proximity voice through a self-hosted LiveKit SFU | Accepted |
| [ADR-008](ADR-008-district-ground-height-and-render-tiers.md) | Analytic ground height, render quality tiers, bloom | Accepted |
| [ADR-009](ADR-009-community-content-gateway.md) | Read-only community content gateway | Accepted |
| [ADR-010](ADR-010-additional-locations-shared-coordinates.md) | Additional locations in one shared coordinate space | Accepted |
| [ADR-013](ADR-013-private-player-payments.md) | Private player-to-player payments | Accepted |
| [ADR-014](ADR-014-watch-hall.md) | Watch Hall: hall-scoped server state, stage sharing, opt-in personal player | Accepted |
| [ADR-015](ADR-015-wallet-holder-identity.md) | Wallet-holder identity, guest mode and onboarding | Accepted |
| [ADR-016](ADR-016-fee-confirmed-names.md) | Fee-confirmed owned names | Accepted |
| [ADR-017](ADR-017-point-light-pool.md) | Point-light pool | Accepted |
| [ADR-018](ADR-018-mainnet-in-game-wallet.md) | Mainnet in-game wallet and the mainnet fees | Accepted |
| [ADR-019](ADR-019-moderation-tools.md) | Moderation tools | Accepted |

## When to write an ADR

Write one before changing something architecture-affecting, for example:

- the client stack, the camera model or the collision approach;
- the repository structure (a new top-level directory, a new workspace package);
- the multiplayer protocol, its authority model or the identity model;
- a privacy boundary: what the server, other players or third parties learn;
- payments, fees or anything else that touches the wallet;
- a new location slot, a new external service or a new runtime dependency with operational weight.

Bug fixes, refactors inside one system and new features that follow an existing decision do not need one.

## How to propose an ADR

1. Copy the structure of an existing ADR: a title, then **Status**, **Context**, **Decision** and
   **Consequences**. Add **Options considered** when there were real alternatives.
2. Name the file `ADR-NNN-short-slug.md`, with the next number above the highest one in use in this
   directory. Your number may change if another proposal takes it first; the maintainers confirm it when
   the ADR is accepted.
3. Set the status to **Proposed**.
4. Explain the decision itself: the constraints, the trade-offs, and what anyone (the server, other
   players, third parties) learns as a result. Link the threat models you update.
5. Open a pull request with the ADR, ideally before or together with the implementation. Discussion
   happens on the pull request.
6. When the ADR is accepted, its status becomes **Accepted (YYYY-MM-DD)**. A later change to an accepted
   decision is either a dated amendment section in the same ADR or a new ADR that supersedes it; the old
   one then says **Superseded by ADR-NNN**.
