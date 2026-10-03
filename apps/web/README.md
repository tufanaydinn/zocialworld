# apps/web — ZocialWorld Web Client

Browser-based 3D social world client. Built in **CORE-001** (core web/3D
infrastructure — camera, movement, collision, interaction, asset
loading, prototype plaza) and extended in **CORE-002** (multiplayer
presence — see `apps/server/`, `apps/web/src/networking/`,
`docs/protocols/multiplayer-protocol.md`), **CORE-003** (social identity
— nicknames, nearby interaction, player context card, block — see
`apps/web/src/social/`), **CORE-004** (proximity voice — see
`apps/web/src/voice/`), and **CORE-005** (project discovery + project
booths — a static registry and discovery/detail UI, see
`apps/web/src/projects/`). Nearby chat, Zcash/wallet, and real
character/environment art are still future work.

See `/docs/architecture/OVERVIEW.md` for how the systems fit
together, and `/ARCHITECTURE.md` for the repository-wide index.

## Requirements

- Node.js 20+ (built against Node 22)
- npm (this app is part of an npm workspaces monorepo — see the
  repository root `README.md`)

## Install

From the **repository root** (not this directory):

```bash
npm install
```

## Run (development)

From the repository root:

```bash
npm run dev
```

or from this directory: `npm run dev`. Opens a Vite dev server (default
`http://localhost:5173`). Click the canvas once to lock the pointer and
enable mouse-look.

## Typecheck / Build / Preview

From the repository root:

```bash
npm run typecheck   # tsc --noEmit
npm run build        # typecheck + vite build -> apps/web/dist/
npm run preview      # serve the production build locally
```

Current production bundle: **~1.23 MB (≈316 KB gzip)**, effectively
unchanged since CORE-004 (~1.21 MB / ≈312 KB gzip) — CORE-005's project
discovery module adds no new npm dependency, only plain application
code/CSS, so its measured delta is negligible. The CORE-004→CORE-005
jump is almost entirely attributable to `livekit-client` (the voice SFU
SDK), already accounted for in the CORE-004 delivery report § Bundle
impact.

## End-to-end tests

Playwright tests live at the repository root
(`/tests/e2e/`, not inside this directory) since they drive the built
app as a whole. Run them from the repository root:

```bash
npm run test:e2e
```

See `/tests/e2e/README.md` for what's automated vs. manual.

## Controls

| Input | Action |
|---|---|
| `W` / `A` / `S` / `D` (or arrow keys) | Move |
| Mouse (after clicking the canvas) | Orbit camera |
| Mouse wheel | Zoom camera in/out |
| `Shift` (held) | Jog instead of walk |
| `E` | Interact with a nearby highlighted object |
| `V` (held) | Push-to-talk — transmit voice while held (CORE-004; ignored while typing in a text field, e.g. the nickname box) |
| `Esc` | Release the mouse / close an open panel |

Walk up to the signpost near the right-hand placeholder building and
press `E` to open the "Builders Hall — Projects" discovery panel — browse,
search, and filter a small static set of fictional prototype projects
(CORE-005). A handful of individual project booths stand nearby; pressing
`E` at one opens that project's detail view directly.

## Folder structure

```text
src/
  core/          Renderer, GameLoop, App (composition root)
  world/         Scene, lighting, sky, the prototype plaza
  player/        LocalPlayer, movement controller, animation state machine
  camera/        Third-person orbit camera
  input/         Keyboard/mouse input, isolated from gameplay code
  assets/        Centralized GLTF/GLB loader (AssetManager)
  interaction/   Generic "walk up and press E" system
  collision/     Lightweight 2.5D collision (no physics engine — see
                 /docs/decisions/ADR-004-no-physics-engine-for-core-prototype.md)
  ui/            DOM-based HUD, interaction prompt, dev stats, connection
                 status, nameplates, shared styles
  audio/         Ambient/SFX layer not implemented — README documents the
                 future integration point (voice lives in src/voice/, not here)
  networking/    Multiplayer client (CORE-002) — WebSocket connection,
                 protocol, interpolation, RemotePlayer. See its own README.
  social/        Social identity (CORE-003) — nicknames, nearby-player
                 detection, player context card, local block/mute state.
  voice/         Proximity voice client (CORE-004) — LiveKit SFU connection,
                 distance attenuation, spatial audio, push-to-talk, voice UI.
  projects/      Project discovery (CORE-005) — static typed registry,
                 search/filter, discovery + detail panels, project-booth
                 interactable. No backend, no wallet/payment code.
  zcash/         Not implemented — README documents the future integration point

public/assets/   Static asset directories (characters/environment/props/textures) — currently empty
```

External assets and their licenses are tracked at the **repository
root** (`/assets/LICENSES.md`, `/assets/asset-registry.json`) — see
`/assets/LICENSES.md` for how that tree relates to `public/assets/`
here.

## Multiplayer

As of CORE-002, opening this app in two or more browser tabs/windows
connects them to the same `apps/server` instance and each sees the
others as remote players with interpolated movement and a `Guest-####`
nameplate. Run `npm run dev` from the repository root to start both the
web client and the server together. See
`docs/protocols/multiplayer-protocol.md`,
`packages/multiplayer/README.md`, and `docs/privacy/PRIVACY_MODEL.md`
(CORE-002 section) for the full picture.

## Voice

As of CORE-004, an "Enable Voice" button (bottom-left) connects to a
self-hosted LiveKit SFU — never raw peer-to-peer WebRTC, so no other
player's browser ever receives your IP address through this app's own
signaling (see `docs/decisions/ADR-003-proximity-voice-transport.md`).
Microphone access is never requested automatically; voice stays OFF
until that button is clicked. Hold `V` to transmit (push-to-talk); other
players within range are heard with distance-based volume attenuation
and left/right spatialization, and become inaudible beyond
`VOICE_MAX_AUDIBLE_RADIUS_METERS`. Mute (player context card) and Block
(CORE-003) both suppress a player's voice locally, instantly, without
notifying them. See `apps/server/README.md` § Voice (CORE-004) for how
to run a local LiveKit server, and `docs/privacy/PRIVACY_MODEL.md`
(CORE-004 section) for exactly what is and isn't exposed, logged, or
retained. Voice is entirely optional — the rest of the app works
identically with no voice server running at all.

## Project discovery

As of CORE-005, the `[E] View Projects` board (and a handful of
standalone project booths near the "Builders Hall (placeholder)"
building) opens a static project discovery/detail UI — a small,
clearly-fictional, repository-curated registry (no backend, no
submission system, no wallet required). Search and category/featured
filtering are entirely client-side; nothing about what a player browses,
searches, or opens is ever sent anywhere. See `docs/privacy/PRIVACY_MODEL.md`
(CORE-005 section) for exactly what is and isn't exposed, and
`apps/web/src/projects/` for the implementation.

## Current limitations (by design — see task scope)

- No reconnection policy (see `packages/multiplayer/README.md` § Known
  limitations) and no interest management — fine at prototype scale.
- No ambient/SFX audio (footsteps, music, UI sounds) — see
  `src/audio/README.md`. Voice itself is implemented — see "Voice"
  above.
- No open mic, per-user report, or manual per-user volume for voice —
  push-to-talk + automatic distance attenuation only (see
  `packages/voice/README.md`).
- No Zcash/wallet code of any kind.
- Placeholder character is procedural primitive geometry, not a rigged
  GLB (see `src/player/PlaceholderCharacter.ts` — replacing it is a
  one-line `localPlayer.setModel(...)` call once real art exists).
- Only one location (Prototype Plaza), not the full Founders' District —
  see `/worlds/founders-district/README.md`.
- No text/nearby chat.
- No real project database/backend — `apps/web/src/projects/` is a
  static, repository-curated fixture registry only (CORE-005); no
  submission, editing, admin, or moderation UI exists.
- No wallet/Zcash support flow on a project's detail view yet —
  deferred to CORE-006.
- `/assets/asset-registry.json` is empty: zero external assets ship in
  this build.
