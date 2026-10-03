# ZocialWorld

**Status: Early Prototype — Active Development**

Open-source browser-based social world for the Zcash ecosystem. Meet builders, discover projects, and participate in privacy-conscious community experiences in a shared 3D space.

This is an early prototype. The current implementation covers CORE-001 through CORE-005:
3D foundation, multiplayer presence, social identity, proximity voice, and project discovery.

The visual layer is currently basic (procedural placeholder geometry). Licensed production assets are being integrated for a more visually representative version.

## Current Implementation Status

**Completed Foundations:**
- ✅ **CORE-001** — 3D client prototype: movement, collision, interaction system
- ✅ **CORE-002** — Multiplayer presence: players joining/leaving, position broadcasting
- ✅ **CORE-003** — Social identity: nicknames, player context cards, block lists
- ✅ **CORE-004** — Proximity voice: LiveKit SFU integration, distance-gated audio
- ✅ **CORE-005** — Project discovery: static registry, discovery UI, placeholder booths

**In Development:**
- 🔄 **CORE-006** — Zcash wallet integration
- 🔄 **CORE-007** — End-to-end system test

**Not Yet Started:**
- ⬜ Visual production (real character/environment assets)
- ⬜ Advanced social features (chat, reputation)
- ⬜ Payment flows

## Quick start

```bash
npm install
npm run dev          # start the web client AND multiplayer server together
npm run typecheck    # tsc --noEmit across the workspace
npm run build        # production build (web + server)
npm run test:e2e     # Playwright end-to-end tests
npm test              # unit tests (client) + server tests
```

`npm run dev` runs both `dev:web` and `dev:server` via `concurrently`;
use those individually if you only need one. These root scripts
delegate to the relevant workspace — see `apps/web/README.md` and
`apps/server/README.md` for app-specific detail, and
`tests/e2e/README.md` for what the e2e suite covers.

## Repository map

```text
apps/
  web/            the web client (see apps/web/README.md)
  server/         the multiplayer presence relay (apps/server/README.md)

packages/         ownership placeholders for future shared code
                   (world-core, player, voice, social, projects, zcash,
                   ui, shared) — each README says where the working
                   code currently lives. `multiplayer` is implemented
                   as apps/server + apps/web/src/networking instead of
                   living here — see packages/multiplayer/README.md.

assets/           asset authoring pipeline + license registry
                   (LICENSES.md, asset-registry.json) — see
                   assets/LICENSES.md for how this relates to
                   apps/web/public/assets/

worlds/
  founders-district/   level-design data for the real district — NOT
                        the current prototype plaza, see its README

docs/
  architecture/   detailed system docs (start at OVERVIEW.md)
  decisions/      ADRs — read before proposing an architecture change
  privacy/        identity/wallet/network privacy baseline + threat
                   models
  protocols/      the multiplayer wire protocol (done — see
                   multiplayer-protocol.md) and future chat protocols
  art-direction/  style guide and visual-consistency references

scripts/          reserved for future build/asset tooling (glTF
                   optimization, texture pipeline, asset audit)

tests/e2e/        Playwright end-to-end tests (repo-root level)

.github/workflows/  CI
```

## Documentation index

- **`ARCHITECTURE.md`** — overview of the system architecture.
- **`ROADMAP.md`** — implementation status and planned features.
- **`apps/web/README.md`** / **`apps/server/README.md`** — how to run/build/test
  each app, controls, current limitations.
- **`docs/architecture/OVERVIEW.md`** — the client's system map
  and extension points.
- **`docs/protocols/multiplayer-protocol.md`** — the client↔server wire protocol.
- **`docs/privacy/`** — privacy baselines and threat models for each system.
- **`docs/decisions/`** — Architecture Decision Records.
