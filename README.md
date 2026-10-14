# Zocial World

Zocial World is an open-source, browser-based 3D social world for the Zcash community. The official
experience is operated as a hosted service at **[zocialworld.com](https://zocialworld.com)**. This
repository contains the open-source application systems, protocols and contributor-facing components.
Production world content, original artwork and selected operational infrastructure are maintained
separately.

## What Zocial World is

Players meet in a shared 3D space under a chosen name and avatar, without exposing a public wallet
identity.

- **Districts.** Several locations share one world coordinate space and are reached through portals and
  doors.
- **Watch Hall.** Talks and community calls: a player on stage shares a tab, a window or a whole screen
  onto the big screen. The hall also has proximity voice, a schedule with live streams and replays,
  numbered seats, reactions, raise hand and a speaker card. Watching needs no wallet.
- **Learning Valley.** Zcash lessons built on a LEARN → SEE → TRY → PROVE framework, with quizzes,
  interactive visualizers, prerequisites and gates. Progress stays in the player's browser.
- **Community hub.** Read the Zcash Community Forum, the ZecHub wiki and project pages without leaving the
  game, through a read-only content gateway.
- **Shielded wallet.** An in-game Zcash wallet (WebAssembly, keys stay in the browser) with private
  player-to-player payments. Payment addresses are sealed end to end and never shown to other players.
- **Social layer.** Chat (general, nearby and whispers), proximity voice, emotes, a player menu, local mute
  and block, reporting and moderation tools.

The wallet on the hosted site is an experimental, unaudited beta, with a cap of
0.01 ZEC per transaction ([ADR-018](docs/decisions/ADR-018-mainnet-in-game-wallet.md)).

## What is in this repository

| In this repository | Added by the hosted deployment |
|---|---|
| The web client: rendering, camera, movement, collision, interaction, HUD, minimap, chat, voice, Watch Hall, Learning Valley framework, community hub, project discovery, onboarding, moderation client, wallet client | The production world content: district, hall and valley layouts, lesson curriculum, event catalogue |
| The game server: presence relay, chat, voice tokens, Watch Hall stage arbitration, content gateway, owned names, wallet bridge, payment and fee verification, moderation | Original Zocial World artwork, logos and branding |
| A placeholder world: the prototype plaza, a small sample Watch Hall and three sample lessons | |
| The wallet engine: build scripts, patches, verification harness and the vendored package (its WebAssembly module is a Release asset) | Deployment configuration, keys and operations |
| The multiplayer protocol, threat models, architecture notes and ADRs | |
| Asset licence metadata and a fetch-and-verify script for the third-party model packs | |

The client separates **systems** from **content**: systems never import content, and one content provider
supplies the locations, the hall layout and the lessons. A plain checkout uses the sample content in
`apps/web/src/content/sample/`; the hosted deployment adds its own content module. See
[apps/web/src/content/README.md](apps/web/src/content/README.md).

The wallet engine (WebZjs with our patches, see [scripts/wallet-engine/README.md](scripts/wallet-engine/README.md))
is built from source by `scripts/wallet-engine/build-engine.sh`. Its package is vendored in
`vendor/webzjs-wallet-main/`, except the 62 MB WebAssembly module, which is published as a GitHub Release
asset: `npm run engine:fetch` downloads it and refuses it unless it matches the committed `SHA256SUMS`.
A `main` build needs it. A `test` build does not: without the module the client uses a stand-in engine,
everything except the wallet works, and the wallet panel reports that the engine is not installed.

## Quick start

Requirements: Node.js 22 and npm.

```bash
npm install
npm run dev          # web client, game server and a local LiveKit voice server
npm run typecheck    # TypeScript across every workspace
npm test             # client unit tests, server tests and script tests
npm run test:e2e     # Playwright end-to-end tests on the sample content
VITE_ZCASH_NETWORK=test npm run build   # production build of the client and the server
npm run engine:fetch # mainnet builds only: download and verify the wallet engine's WebAssembly module
```

- `npm run dev` opens the client on <http://localhost:5174> with the game server on port 8787. The dev
  server defaults to the `test` network and says so. Copy `apps/web/.env.example` to `apps/web/.env` to
  set options.
- A build fails closed unless `VITE_ZCASH_NETWORK` is exactly `test` or `main`. Public builds use `test`.
- `npm run dev` downloads a pinned `livekit-server` for local voice (checked against its release
  checksums). Set `SKIP_LOCAL_LIVEKIT=1` to run without voice.
- `npm run assets:fetch` downloads the CC0 third-party model packs listed in
  [assets/asset-registry.json](assets/asset-registry.json) and checks every file's SHA-256. The sample
  world runs without them, on procedural placeholders.

See [apps/web/README.md](apps/web/README.md) and [apps/server/README.md](apps/server/README.md) for
app-specific detail, including local multi-user testing, and [tests/e2e/README.md](tests/e2e/README.md) for
the end-to-end suite.

## Repository map

```text
apps/
  web/              the browser client (Three.js, TypeScript, Vite)
    src/content/    the content seam and the sample content
  server/           the game server (Node.js, TypeScript, ws)
packages/
  shared/           the multiplayer wire protocol types shared by client and server
assets/             third-party asset registry and licences
docs/
  architecture/     system overview, Watch Hall systems, performance
  decisions/        Architecture Decision Records
  privacy/          privacy model and threat models
  protocols/        the multiplayer protocol
scripts/
  dev/              local development helpers (LiveKit, env, load tests)
  assets/           fetch and verify the third-party model packs
  tools/            operator tools (registry keys)
  wallet-engine/    the wallet engine's reproducible build, patches, fetch script and verification harness
tests/e2e/          Playwright end-to-end tests
vendor/
  webzjs-wallet-main/ the mainnet wallet engine package (the .wasm module is fetched by npm run engine:fetch)
  zcash-tx-decrypt/ the game server's prebuilt shielded transaction decryption helper
```

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): where to start reading.
- [docs/architecture/OVERVIEW.md](docs/architecture/OVERVIEW.md): the client's systems and how they fit
  together.
- [docs/decisions/README.md](docs/decisions/README.md): the published Architecture Decision Records.
- [docs/privacy/PRIVACY_MODEL.md](docs/privacy/PRIVACY_MODEL.md): the privacy model and the index of
  threat models.
- [docs/protocols/multiplayer-protocol.md](docs/protocols/multiplayer-protocol.md): the client-server
  wire protocol.
- [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute.
- [SECURITY.md](SECURITY.md): how to report a vulnerability.
- [ROADMAP.md](ROADMAP.md): what is done, in progress and planned.

## Licence

- **Code:** MIT, see [LICENSE](LICENSE).
- **Original Zocial World artwork, logos and branding:** all rights reserved. They are not included in
  this repository and are not covered by the MIT licence.
- **Third-party assets:** each pack keeps its own licence (CC0 Kenney and KayKit packs), recorded in
  [assets/LICENSES.md](assets/LICENSES.md).
- **Sample lesson text** follows the ZecHub wiki and is under CC BY-SA 4.0.

See [assets/ART_AND_ASSETS_LICENSE.md](assets/ART_AND_ASSETS_LICENSE.md) for the full split.
