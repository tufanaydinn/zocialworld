# Contributing

Thank you for your interest in Zocial World. This guide covers the workflow, the checks a change must
pass, how the code is organised around content, and how architecture decisions are made.

## Workflow

1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/your-feature`.
3. Make your change, with tests.
4. Run the checks below.
5. Push to your fork and open a pull request that explains what changed and why.

## Local setup

Requirements: Node.js 22 and npm.

```bash
npm install
npm run dev          # web client (http://localhost:5174), game server (port 8787) and a local LiveKit
```

`npm run dev` uses the `test` network and the sample content. Without the wallet engine's WebAssembly
module the wallet runs on a stand-in engine that reports "not installed"; everything else works. The
engine's sources and build are in [scripts/wallet-engine/](scripts/wallet-engine/README.md);
`npm run engine:fetch` downloads the published mainnet module and checks it against `SHA256SUMS`. `npm run assets:fetch` downloads the optional
third-party model packs. See [apps/web/README.md](apps/web/README.md) and
[apps/server/README.md](apps/server/README.md), which also explain local multi-user testing.

## Checks

Before you push:

```bash
npm run typecheck                        # TypeScript across every workspace
npm test                                 # all of the following:
npm run test:unit                        #   client unit tests (apps/web)
npm run test:server                      #   game server tests (apps/server)
npm run test:scripts                     #   tests of the scripts under scripts/
VITE_ZCASH_NETWORK=test npm run build    # production build
npm run test:e2e                         # Playwright end-to-end tests on the sample content
```

Some tests need external infrastructure and are skipped by default: the specs that run against a real
LiveKit server (`voice-integration.spec.ts`, `watch-hall-voice-real.spec.ts`,
`watch-stage-integration.spec.ts`, `moderation-livekit-real.spec.ts`). See
[tests/e2e/README.md](tests/e2e/README.md) for how to run them.

## Systems and content

The client separates **systems** (rendering, movement, collision, networking, voice, the Watch Hall and
learning logic) from **content** (the locations, travel destinations, the Watch Hall layout, the lessons
and the scene's atmosphere).

- Systems never import content. The composition root, `apps/web/src/core/App.ts`, resolves one content
  provider and hands its parts to the systems that need them.
- This repository ships **sample content** in `apps/web/src/content/sample/`: the prototype plaza, a small
  Watch Hall with one row of seats, and three lessons. The hosted deployment adds its own content module,
  which is maintained separately. A plain checkout resolves to the sample content.
- The game server follows the same pattern: the Watch Hall schedule comes from a catalogue file the
  operator provides, and falls back to the sample catalogue in
  `apps/server/src/content/watchCatalog.sample.ts`.
- End-to-end tests stand players at named anchors (`apps/web/src/debug/anchors.ts`), never at hard-coded
  coordinates, so the same spec runs on any content that publishes the anchors it needs.

When you add a system, give it an interface the content can fill, and extend the sample content so the
system can be tried in `npm run dev` and the tests. Do not add production-scale world layouts, original
artwork or curriculum to this repository. See
[apps/web/src/content/README.md](apps/web/src/content/README.md).

## Comments

A comment explains what the code does, why, and which constraint it protects. It does not say who asked
for the change, which ticket or review produced it, or where the code came from: that belongs in the
commit message and the pull request. If a rule is not obvious from the code, write the rule down.

```ts
// Bad:  // Fixed after the review in issue 123
// Good: // Scratch vectors, so a frame allocates nothing.
```

## Architecture decisions

Changes that touch the client stack, the camera model, the collision approach, the repository structure,
the wire protocol, the privacy boundaries or anything else with a recorded decision need an
Architecture Decision Record. Read [docs/decisions/README.md](docs/decisions/README.md) first: it lists
the published ADRs and explains how to propose a new one. A pull request that changes a recorded
decision includes the new or superseding ADR.

## Privacy and security

- Changes to privacy-sensitive systems (multiplayer presence, chat, voice, identity, the wallet and
  payments) need careful review. Read [docs/privacy/PRIVACY_MODEL.md](docs/privacy/PRIVACY_MODEL.md) and
  the threat model of the system you change, and update the threat model in the same pull request.
- Never commit `.env` files, keys, seeds or other secrets. `.env.example` files hold placeholders only.
- Use the `test` network for development. Never test with meaningful funds.
- Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## Assets

Third-party assets must have a licence that allows redistribution, recorded in
[assets/LICENSES.md](assets/LICENSES.md) and [assets/asset-registry.json](assets/asset-registry.json)
(source, version, licence, and whether the file was modified). Do not assume that an entire asset site
has one licence. Original Zocial World artwork is not part of this repository; see
[assets/ART_AND_ASSETS_LICENSE.md](assets/ART_AND_ASSETS_LICENSE.md).

## Questions

Start with [docs/architecture/OVERVIEW.md](docs/architecture/OVERVIEW.md) for the system design and
[docs/decisions/](docs/decisions/) for the decisions behind it.
