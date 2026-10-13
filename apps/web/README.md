# apps/web — Zocial World web client

The browser client of Zocial World: a Three.js + TypeScript + Vite app (ADR-001) with a third-person
camera, movement and lightweight collision, multiplayer presence, text chat, proximity voice, the Watch
Hall, learning lessons, project discovery, the community hub and an in-game Zcash wallet.

See `docs/architecture/OVERVIEW.md` for how the systems fit together and `ARCHITECTURE.md` for the
repository-wide index.

## Requirements

- Node.js 22
- npm (this app is part of the npm workspaces monorepo; see the repository root `README.md`)

## Install and run

From the repository root:

```bash
npm install
npm run dev
```

`npm run dev` starts three processes: the web client (Vite, `http://localhost:5174`), the game server
(`apps/server`) and a local LiveKit server for voice (see below). The port is fixed: if 5174 is taken the
dev server fails instead of moving silently. `WEB_PORT=5340` moves it, and the game server then needs that
origin in `ALLOWED_ORIGINS`. Click the canvas once to lock the pointer and enable mouse-look.

Open the page in two browser windows to see each other as remote players.

## Typecheck, test, build

From the repository root:

```bash
npm run typecheck   # every workspace, tsc --noEmit
npm run test:unit   # this app's unit tests (node:test + tsx)
npm run build       # typecheck + vite build -> apps/web/dist/
npm run preview     # serve the built client locally
npm run test:e2e    # Playwright end-to-end tests (tests/e2e/, see tests/e2e/README.md)
```

## Configuration

Copy `.env.example` to `.env` to change settings; it holds no secrets, only endpoint URLs and options.

- `VITE_ZCASH_NETWORK` — `test` or `main`. A build fails closed without it; the local dev server uses
  `test` when it is unset and says so. `npm run dev:main` runs client and server on mainnet.
- `VITE_SERVER_ORIGIN` — where the game server lives (`same` when the server also serves the page). Every
  endpoint (WebSocket, voice token, content gateway, wallet bridge) derives from it unless set on its own.
- `ZW_CONTENT` (an environment variable, read by `vite.config.ts`) — `sample` forces the sample content
  (see "Content" below).

### The wallet engine

The in-game wallet runs a WebAssembly build of the WebZjs wallet engine. A `test` build without the engine
binary uses a stand-in module: everything except the wallet works, and the wallet panel reports that the
engine is not installed. A `main` build always requires the engine binary. The engine build scripts are
published separately.

## Content

Systems (rendering, movement, networking, voice, the Watch Hall and learning logic) are separate from
content (locations, destinations, the hall layout, lessons, atmosphere). `core/App.ts` imports the bare
specifier `@zw/content`, which resolves to a deployment's content module when one is present and to the
sample content otherwise. A plain checkout runs the sample: a prototype plaza, a small Watch Hall and three
lessons. See `src/content/README.md`.

## Controls

| Input | Action |
|---|---|
| `W` / `A` / `S` / `D` (or arrow keys) | Move |
| Mouse (after clicking the canvas) | Orbit camera |
| Mouse wheel | Zoom camera in/out |
| `Shift` (held) | Jog instead of walk |
| `E` | Interact with the nearest highlighted object (a board, a door, a seat, a player) |
| `V` (held) | Push-to-talk |
| `G` | Hold for the emote wheel, tap to wave |
| `H` / `1`–`8` | In the Watch Hall: raise your hand / send a reaction |
| `Esc` | Release the mouse / close an open panel |

Keys never reach the game while you type in a text field (chat, nickname).

## Folder structure

```text
src/
  core/          Renderer, GameLoop, frame pacing, App (composition root)
  world/         Scene, lighting, sky, locations, the Watch Hall geometry, the point-light pool
  player/        LocalPlayer, movement controller, animation state machine, placeholder character
  camera/        Third-person orbit camera
  input/         Keyboard/mouse input, isolated from gameplay code
  assets/        Centralized GLTF/GLB loader and the installed model packs
  interaction/   Generic "walk up and press E" system
  collision/     Lightweight 2.5D collision (no physics engine, ADR-004)
  ui/            DOM HUD, chat panel, nameplates, minimap, shared styles
  networking/    Multiplayer client: WebSocket, protocol validation, interpolation, remote players
  social/        Nicknames, nearby players, player context card, local block/mute, emotes
  voice/         Proximity voice (LiveKit SFU), spatial audio, push-to-talk, voice UI (ADR-007)
  hall/          Watch Hall client: stage, seats, boards, speaker card, hall state
  watch/         Watch panel: live, schedule and replays; the opt-in personal YouTube player
  learning/      Lessons, progress and the interactive visualizers
  community/     Community hub (ZecHub, forum, open source) through the server's content gateway
  projects/      Project discovery: a static registry, discovery and detail panels, booths
  moderation/    Reports and the moderator tools (ADR-019)
  onboarding/    Start-of-game flow: guest or wallet holder, character, name
  zcash/         In-game Zcash wallet, payments and name confirmation
  content/       The content seam and the sample content
  audio/         Reserved for ambient sound and effects (not implemented)
  debug/         Named anchors for tests and debugging

public/assets/   Third-party model packs, downloaded by `npm run assets:fetch` (not committed)
```

External assets and their licences are tracked at the repository root (`assets/LICENSES.md`,
`assets/asset-registry.json`).

## Multiplayer

Every open page connects to the game server and sees the others as remote players with interpolated
movement and a nameplate. The wire protocol is in `docs/protocols/multiplayer-protocol.md`; what is and
is not transmitted is in `docs/privacy/MULTIPLAYER_THREAT_MODEL.md`.

## Voice

"Enable Voice" (bottom-left) connects to a LiveKit SFU, never raw peer-to-peer WebRTC, so no other
player's browser receives your IP address through this app's signaling (ADR-007). The microphone is never
requested automatically. Players in range are heard with distance attenuation and left/right
spatialization; mute and block silence a player locally. Talking needs a wallet; guests can listen. Voice
is optional: the rest of the app works without a voice server. See `docs/privacy/VOICE_THREAT_MODEL.md`.

### Voice in local development

| Process | What it does |
|---|---|
| `voice` — `scripts/dev/livekit.mjs` | The first time, downloads `livekit-server` **1.13.8** (the tested version) for your platform from the official GitHub release, checks its SHA-256 against the release's `checksums.txt` and caches it in `node_modules/.cache/livekit/`. Then starts it with `--dev` on `127.0.0.1:7880`, media on TCP 7881 and UDP 7882. |
| `server` — `apps/server` with `--local-livekit` | Uses that LiveKit: `ws://127.0.0.1:7880` with the `--dev` keys. Development only: ignored with `NODE_ENV=production`. |

Options (environment variables, or `apps/server/.env` for `SKIP_LOCAL_LIVEKIT`, `LIVEKIT_*` and
`LOCAL_LIVEKIT_PORT`; the environment wins):

- `SKIP_LOCAL_LIVEKIT=1` — don't start a local LiveKit (voice is then off unless `LIVEKIT_*` is configured).
- `LIVEKIT_URL` + `LIVEKIT_API_KEY` + `LIVEKIT_API_SECRET` — use your own LiveKit; no local one is started.
- `LIVEKIT_BINARY=/path/to/livekit-server` — use that binary (no download).
- `LOCAL_LIVEKIT_PORT=7880` — move it (TCP/UDP media use the next two ports).
- `LIVEKIT_NODE_IP=127.0.0.1` — the address LiveKit advertises for media (the e2e tests use it).

**macOS:** LiveKit publishes no macOS archive. Run `brew install livekit` once; the script then uses
`livekit-server` from `PATH` (it warns if the version isn't 1.13.8).

**Windows:** the first start may show a firewall prompt for `livekit-server.exe`; allowing private
networks is enough.

When something fails, the voice panel says why (`src/voice/voiceErrors.ts`) and offers the next step:
no voice server, an insecure page (`http://` on a LAN address), a blocked or missing microphone, a guest
trying to talk, or an unreachable voice server. Browsers block the microphone on `http://<LAN IP>`, so a
test from a second device needs the client served over https.

## Privacy

Social identity (nickname, character) and financial identity (the wallet) stay separate; nameplates never
show wallet data. The rules and threat models are in `docs/privacy/`.
