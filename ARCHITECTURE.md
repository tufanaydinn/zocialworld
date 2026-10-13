# Architecture

A short index. This file does not explain the system itself; it points to the documents that do.

## Start here

- [docs/architecture/OVERVIEW.md](docs/architecture/OVERVIEW.md): the web client's systems and how they
  fit together: the render/update loop, the module map, the content seam and the extension points.
- [apps/web/src/content/README.md](apps/web/src/content/README.md): how systems and world content are
  kept apart, and what the sample content contains.
- [docs/architecture/WATCH_HALL.md](docs/architecture/WATCH_HALL.md): the Watch Hall's systems, the hall
  contract, its protocol, media and stage moderation.
- [docs/architecture/PERFORMANCE.md](docs/architecture/PERFORMANCE.md): how to measure frame rate
  reproducibly (`?perf=hall60`, `?perf=district`), what a full Watch Hall costs, and the rules that keep
  it fast.
- [docs/protocols/multiplayer-protocol.md](docs/protocols/multiplayer-protocol.md): the client-server
  wire protocol.
- [apps/server/README.md](apps/server/README.md): the game server.
- [docs/privacy/PRIVACY_MODEL.md](docs/privacy/PRIVACY_MODEL.md): the privacy model and the threat
  models of each system.

## Why things are organised this way

Architecture Decision Records live in [docs/decisions/](docs/decisions/README.md). Read them before
proposing a change that touches something with a recorded decision. Numbers are not contiguous.

| ADR | Decision |
|---|---|
| [001](docs/decisions/ADR-001-threejs-typescript-vite.md) | Three.js, TypeScript and Vite for the client |
| [002](docs/decisions/ADR-002-third-person-camera.md) | Third-person camera |
| [003](docs/decisions/ADR-003-monorepo-structure.md) | Monorepo structure |
| [004](docs/decisions/ADR-004-no-physics-engine-for-core-prototype.md) | No physics engine |
| [005](docs/decisions/ADR-005-client-authoritative-movement.md) | Client-authoritative movement |
| [006](docs/decisions/ADR-006-shared-multiplayer-protocol-contracts.md) | Shared multiplayer protocol contracts |
| [007](docs/decisions/ADR-007-proximity-voice-transport.md) | Proximity voice transport |
| [008](docs/decisions/ADR-008-district-ground-height-and-render-tiers.md) | Ground height and render tiers |
| [009](docs/decisions/ADR-009-community-content-gateway.md) | Community content gateway |
| [010](docs/decisions/ADR-010-additional-locations-shared-coordinates.md) | Additional locations in shared coordinates |
| [013](docs/decisions/ADR-013-private-player-payments.md) | Private player payments |
| [014](docs/decisions/ADR-014-watch-hall.md) | Watch Hall |
| [015](docs/decisions/ADR-015-wallet-holder-identity.md) | Wallet holders and guests |
| [016](docs/decisions/ADR-016-fee-confirmed-names.md) | Fee-confirmed owned names |
| [017](docs/decisions/ADR-017-point-light-pool.md) | Point-light pool |
| [018](docs/decisions/ADR-018-mainnet-in-game-wallet.md) | Mainnet in-game wallet |
| [019](docs/decisions/ADR-019-moderation-tools.md) | Moderation tools |

## Repository shape

```text
apps/web/         the browser client (docs/architecture/OVERVIEW.md)
apps/server/      the game server (apps/server/README.md)
packages/shared/  wire protocol types shared by client and server
assets/           third-party asset registry and licences
docs/             architecture, decisions, privacy, protocols
scripts/          development, asset and operator tools
tests/e2e/        Playwright end-to-end tests
vendor/           prebuilt helpers used by the game server
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, the comment rule and how to propose a new ADR.
