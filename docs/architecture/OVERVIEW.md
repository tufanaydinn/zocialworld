# Core Architecture

Originally written for CORE-001 (client foundation); extended in
CORE-002 (multiplayer presence) without changing the systems it
already described. Each major addition is marked with its task ID
below so you can tell what's been there from the start vs. added later.

Audience: any agent extending this codebase (multiplayer, social,
character art, Zcash, UI). This document explains how the systems fit
together and, specifically, where to plug in future work without
reshaping what already exists.

## Guiding rule

Each system has exactly one job and talks to its neighbors through
narrow interfaces, never through shared globals or by reaching into each
other's internals:

```text
camera  ≠  player  ≠  world  ≠  UI  ≠  networking
```

`apps/web/src/core/App.ts` is the only file allowed to know about every system —
it is the composition root. If you're adding a new system, wire it there
and nowhere else.

## Render/update loop

```text
GameLoop (requestAnimationFrame)
  │
  ├─ update(deltaSeconds, elapsedSeconds)   ──▶ App.update()
  │     1. camera.update(...)                  (reads mouse/wheel, recomputes yaw/pitch/distance,
  │                                              follows the player's position from the PREVIOUS frame)
  │     2. playerController.update(...)        (reads camera.currentYaw + InputManager,
  │                                              moves LocalPlayer, resolves collisions,
  │                                              updates PlayerAnimation state)
  │     3. interactions.update(...)            (finds nearest Interactable in range,
  │                                              fires `interact()` on E)
  │     4. remotePlayers.update(...)            (CORE-002: advances each RemotePlayer's
  │                                              interpolation buffer — render FPS, not network rate)
  │     5. publishLocalTransform(...)           (CORE-002: ~10Hz-throttled, sends LocalPlayer's
  │                                              transform over NetworkClient — see
  │                                              docs/protocols/multiplayer-protocol.md § Network rate)
  │     6. updateVoice(...)                     (CORE-004: push-to-talk edge detection,
  │                                              VoiceSession.update() recomputes every subscribed
  │                                              remote participant's gain from distance each frame)
  │     7. input.endFrame()                    (clears this-frame-only key presses)
  │
  └─ render()                                  ──▶ App.render()
        renderer.render(world.scene, camera.camera)
        remotePlayers.updateNameplates(...)     (CORE-002: projects each RemotePlayer's head
                                                  position to screen space for the DOM nameplate)
```

Camera updates *before* the player moves each frame so player movement
can be computed relative to the camera's current-frame yaw. The visual
lag this introduces (camera position still following last frame's player
position) is smoothed away by the camera's own exponential follow and is
imperceptible at 60 FPS.

`GameLoop` itself (`apps/web/src/core/GameLoop.ts`) is generic — it has no idea
what "update" or "render" mean. It just calls two callbacks every frame
with a clamped delta time. A future fixed-step network simulation could
sit between `update` and `render` without changing `GameLoop`.

## Module map

```text
apps/web/src/core/
  Renderer.ts       Owns THREE.WebGLRenderer, pixel ratio, resize, color/tone mapping
  GameLoop.ts        rAF loop, delta clamping — knows nothing about Three.js
  App.ts             Composition root — wires every other system together

apps/web/src/input/
  InputManager.ts    Single owner of all DOM input listeners. Exposes
                     isPressed() (continuous) and wasJustPressed() (one-shot edge),
                     plus pointer-lock-gated mouse deltas and wheel deltas.
                     Nothing else attaches its own key/mouse listeners.

apps/web/src/camera/
  ThirdPersonCamera.ts
                     Owns the THREE.PerspectiveCamera. Orbits on yaw/pitch from
                     mouse delta, zooms on wheel delta, follows the player with
                     exponential smoothing, raycasts pivot→desired-position
                     against `setObstacles()` to avoid clipping through buildings.

apps/web/src/player/
  PlaceholderCharacter.ts
                     Builds a primitive-geometry humanoid (capsules/spheres/cones).
                     Zero external assets. Exposes a `ProceduralRig` (named limb
                     nodes) for PlayerAnimation to drive before real art exists.
  PlayerAnimation.ts Animation STATE machine (idle/walk/jog/sit/wave/talk) with
                     two interchangeable backends behind one API:
                       - procedural (drives ProceduralRig limb rotations by hand)
                       - clip-driven (THREE.AnimationMixer + named AnimationClips)
                     Callers only ever call setState()/update() — never need to
                     know which backend is active.
  LocalPlayer.ts     World-space root (`object`), collision radius, height, and
                     the PlayerAnimation instance. `setModel(model, animations)`
                     swaps the visible model (procedural → real GLB) without
                     touching PlayerController, CollisionSystem, or the camera.
  PlayerController.ts
                     Reads InputManager + camera yaw, computes camera-relative
                     movement, resolves it through CollisionSystem, updates
                     LocalPlayer's transform and animation state. This is the
                     ONLY system that writes to LocalPlayer.object.position.

apps/web/src/collision/
  CollisionSystem.ts Lightweight 2.5D (XZ-plane) collision: box and cylinder
                     colliders, push-out resolution against a circular agent
                     radius. No physics engine — see CORE-001 section 13.

apps/web/src/interaction/
  Interactable.ts    Generic `{ id, label, position, interactionRadius, interact() }`
                     contract. Anything interactable implements this — a project
                     board today, a booth/bench/door/support terminal later
                     (master spec section 66).
  InteractionSystem.ts
                     Finds the nearest in-range Interactable each frame, notifies
                     UI of changes (for the "[E] <label>" prompt), fires
                     `interact()` on E. World objects register themselves; the
                     player controller never needs to know interaction exists.

apps/web/src/assets/
  AssetManager.ts    Centralized GLTFLoader wrapper: caching, SkeletonUtils-based
                     cloning (safe to instantiate the same GLB many times),
                     progress/error callbacks. No scene file should construct its
                     own GLTFLoader. Currently unused by the default scene (no
                     external assets ship yet) but fully wired — see
                     `window.__assetManager` in dev builds for a console-testable
                     hook.

apps/web/src/world/
  World.ts           Owns THREE.Scene, lighting (one directional "sun" + hemisphere
                     + ambient fill — see master spec section 27), sky, fog.
                     Composes the active location (currently only PrototypePlaza).
  PrototypePlaza.ts  The ~50×50 m greybox-with-paint test space: ground, fountain,
                     two placeholder buildings, trees, a bench, lanterns, and the
                     one working Interactable (project board). Registers its own
                     colliders with CollisionSystem and its own obstacle meshes
                     with the camera.
  Sky.ts             Cheap vertical-gradient sky dome (custom ShaderMaterial on a
                     big inverted sphere) — no HDRI/texture download.

apps/web/src/ui/
  styles.ts          One injected <style> tag shared by every UI widget (dark
                     translucent panel + amber accent, per master spec section 67).
  InteractionPrompt.ts  The floating "[E] <label>" prompt.
  HUD.ts             Always-on chrome: top-left info corner, bottom-left location label.
  DebugStats.ts      Dev-only (import.meta.env.DEV-gated) FPS/triangle/draw-call panel.
  ConnectionStatus.ts (CORE-002) Dev-only multiplayer connection indicator.
  Nameplates.ts      (CORE-002) Projects each RemotePlayer's head position to a
                     screen-space DOM label — no CSS2DRenderer/sprite-text dependency.

apps/web/src/networking/   (CORE-002) Multiplayer client: NetworkClient (owns the
                     WebSocket connection only), protocol.ts (message types +
                     validation, mirrors apps/server/src/protocol.ts), interpolation.ts
                     (pure, engine-agnostic entity interpolation buffer),
                     RemotePlayer.ts (LocalPlayer's networked counterpart —
                     same model/animation composition, driven by the
                     interpolation buffer instead of PlayerController),
                     RemotePlayerManager.ts (Map<playerId, RemotePlayer>
                     bookkeeping; as of CORE-003 also owns each remote
                     player's InteractionSystem registration and
                     block-driven nameplate visibility). See
                     docs/protocols/multiplayer-protocol.md and
                     apps/web/src/networking/README.md.

apps/web/src/social/      (CORE-003) Social identity / nearby interaction —
                     application code, same pattern CORE-002 used for
                     apps/server + apps/web/src/networking/ before any
                     shared-package extraction (packages/social remains
                     documentation-only; see its README):
                       nearby.ts                pure, engine-agnostic
                                                 getNearbyPlayers() +
                                                 SOCIAL_INTERACTION_RADIUS_METERS
                                                 — the one reusable source
                                                 of truth for "how close
                                                 counts as nearby", unit
                                                 tested independent of
                                                 Three.js (same pattern as
                                                 networking/interpolation.ts).
                       SocialStore.ts            client-side-only, session-
                                                 scoped relationship state
                                                 (blockedPlayerIds,
                                                 mutedPlayerIds reserved,
                                                 selectedPlayerId) — no
                                                 networking import, by
                                                 design (see
                                                 docs/privacy/SOCIAL_IDENTITY_THREAT_MODEL.md).
                       RemotePlayerInteractable.ts
                                                 adapts a RemotePlayer into
                                                 the existing Interactable
                                                 contract so player
                                                 selection reuses
                                                 InteractionSystem verbatim
                                                 — see § Player selection
                                                 below.
                       PlayerContextCard.ts      the prototype-level
                                                 selected-player modal
                                                 (nickname/presence/accent
                                                 + Block/Mute/Report/
                                                 Whisper actions — only
                                                 Block has real behavior).
                       NicknameControls.ts       always-on (not dev-gated)
                                                 nickname entry/edit widget
                                                 — every nickname choice
                                                 goes through set_nickname,
                                                 including the first one,
                                                 to keep exactly one
                                                 validation/conflict code
                                                 path.
                     See docs/protocols/multiplayer-protocol.md §§
                     Nickname validation and conflict resolution / Nearby
                     interaction range / Player selection, and
                     docs/privacy/SOCIAL_IDENTITY_THREAT_MODEL.md.

apps/web/src/voice/       (CORE-004) Proximity voice client — structurally
                     separate from apps/web/src/networking/ per
                     packages/voice/README.md's pre-existing requirement:
                       VoiceClient.ts      owns the LiveKit `Room` connection
                                           only (mic capture/publish, push-to-
                                           talk mute/unmute, active-speaker
                                           events) — no scene access, no DOM,
                                           same separation NetworkClient keeps.
                       VoiceAudioGraph.ts  one THREE.PositionalAudio per
                                           subscribed remote participant,
                                           attached to that RemotePlayer's
                                           object; the panner's own distance
                                           rolloff is disabled so 100% of gain
                                           comes from VoiceProximity below.
                       VoiceProximity.ts   pure, engine-agnostic getVoiceGain()
                                           distance→gain curve +
                                           VOICE_FULL_VOLUME_RADIUS_METERS /
                                           VOICE_MAX_AUDIBLE_RADIUS_METERS —
                                           deliberately distinct from
                                           SOCIAL_INTERACTION_RADIUS_METERS
                                           (apps/web/src/social/nearby.ts).
                       VoiceSession.ts     orchestration layer tying the three
                                           above together with SocialStore's
                                           isMuted()/isBlocked() (read fresh
                                           every frame, see App.ts's
                                           updateVoice()).
                       VoiceControls.ts    prototype-level status/control
                                           widget (Enable Voice button, OFF/
                                           READY/CONNECTED/ERROR, mic mode).
                     Server-side counterpart: apps/server/src/voice/ (token
                     minting only — see apps/server/README.md § Voice
                     (CORE-004)). See docs/decisions/ADR-003-proximity-voice-transport.md
                     and docs/privacy/VOICE_THREAT_MODEL.md.

apps/web/src/projects/   (CORE-005) Project discovery — static,
                     repository-curated registry + discovery/detail UI +
                     world booths, no backend:
                       ProjectTypes.ts          Project interface + bounded
                                                 ProjectStatus/ProjectCategory
                                                 enums and their human-
                                                 readable label maps. No
                                                 wallet/payment field exists
                                                 on Project.
                       projectData.ts           the static fixture dataset
                                                 (7 clearly-fictional
                                                 prototype projects).
                       ProjectRegistry.ts       validateProjects() (runs at
                                                 module load — an invalid
                                                 fixture throws immediately,
                                                 never silently breaks a
                                                 booth) + getProjectById/
                                                 BySlug/getFeaturedProjects/
                                                 getProjectsByCategory/
                                                 searchProjects. The one
                                                 place project metadata
                                                 lives — booths and UI only
                                                 ever hold a projectId, never
                                                 a copy of the data (see
                                                 ProjectBoothInteractable
                                                 below).
                       urlSafety.ts             isSafeExternalUrl() (pure,
                                                 unit-tested) +
                                                 createSafeExternalLink()
                                                 (DOM-touching, e2e-tested) —
                                                 http/https only, every
                                                 rendered <a> gets
                                                 rel="noopener noreferrer".
                       ProjectDiscoveryPanel.ts the discovery list/search/
                                                 filter UI. Reuses the
                                                 existing `[E] View Projects`
                                                 board interaction (replaces
                                                 CORE-001's PrototypePanel —
                                                 same Interactable/
                                                 InteractionSystem wiring,
                                                 only what onOpenProjectBoard
                                                 does changed) and swaps a
                                                 detail view in/out of the
                                                 same .zw-modal-backdrop
                                                 rather than stacking a
                                                 second modal.
                       ProjectDetailPanel.ts    renders one project's full
                                                 detail — textContent/DOM-
                                                 element construction only,
                                                 never innerHTML; links only
                                                 render when both present and
                                                 isSafeExternalUrl()-checked.
                       ProjectBoothInteractable.ts
                                                 a world Interactable that
                                                 holds only a projectId
                                                 (throws at construction if
                                                 unknown — fails loudly, not
                                                 silently) and opens that
                                                 project's detail view
                                                 directly via
                                                 ProjectDiscoveryPanel.openProject().
                     Placeholder world booths (primitive pedestal + sign)
                     live in apps/web/src/world/PrototypePlaza.ts's
                     projectBoothPlacements()/buildProjectBooth() — world
                     code passes only a projectId, never name/description/
                     tags (see docs/privacy/PROJECT_DISCOVERY_THREAT_MODEL.md).
                     No wallet/payment code anywhere in this module — that
                     is CORE-006's scope.

apps/web/src/audio/, apps/web/src/zcash/
                     Each contains only a README.md documenting the future
                     integration point (ambient/SFX audio for the former —
                     voice itself now lives in apps/web/src/voice/, not
                     here, see above). No code, no stubs, for either — see
                     CORE-001 sections 21-23 and each README for the
                     expected shape.
```

## Extension points for future agents

### Character Agent — replacing the placeholder character

```ts
const { scene, animations } = await assetManager.instantiate("/assets/characters/builder.glb");
localPlayer.setModel(scene, animations);
```

If `animations` contains clips named `Idle`, `Walk`, `Jog`, `Sit`,
`Wave`, `Talk`, `PlayerAnimation` automatically switches from the
procedural backend to `THREE.AnimationMixer` crossfades. No changes
needed in `PlayerController`, `CollisionSystem`, or the camera.

### Multiplayer (implemented in CORE-002)

See `apps/web/src/networking/README.md`,
`docs/protocols/multiplayer-protocol.md`, and
`packages/multiplayer/README.md`. `RemotePlayer` mirrors `LocalPlayer`'s
composition (a model + `PlayerAnimation`) but is driven by the
interpolation buffer instead of `PlayerController` — see
`docs/decisions/ADR-001-client-authoritative-movement.md`. Remote
players are **not** added to `CollisionSystem` or
`ThirdPersonCamera.setObstacles()` in CORE-002 (both already accept
arbitrary object lists, so this is straightforward future work, not an
architectural blocker) — walking through another player's placeholder
character is an accepted gap at this stage, not a bug.

### Social (implemented in CORE-003)

See `docs/protocols/multiplayer-protocol.md` §§ Nickname validation and
conflict resolution / Nearby interaction range / Player selection, and
`apps/web/src/social/`. Player selection reuses `InteractionSystem`
unchanged via `RemotePlayerInteractable` — a remote player and a world
object (e.g. the project board) compete for "nearest interactable" under
the exact same rule `InteractionSystem` already applies to multiple world
objects; whichever is physically closer wins and is what "[E] …" acts on.
No raycasting/click-to-select was added, to avoid touching the camera or
introducing combat-style lock-on.

### Voice (implemented in CORE-004)

See `docs/decisions/ADR-003-proximity-voice-transport.md`,
`docs/privacy/VOICE_THREAT_MODEL.md`, and `apps/web/src/voice/`. Voice
attaches to the exact object `apps/web/src/audio/README.md` anticipated
before any audio code existed (`RemotePlayer.object`), reuses
`InputManager`'s existing text-input guard for push-to-talk (`KeyV`
added to `KEY_TO_ACTION`, no new guard code), and reuses `SocialStore`'s
existing block state as-is (read by `VoiceSession`, no change to
CORE-003's block privacy contract) — `SocialStore.mute()`/`unmute()` are
the one new piece of relationship state, local-only like block. The SFU
connection (LiveKit) and the gameplay WebSocket connection are
deliberately two separate systems; only token minting shares the
underlying `http.Server` process, for local-dev convenience.

### World/Level Design agent — the real Founders' District

Swap `World`'s composed location from `PrototypePlaza` to a real
district build. `World` already separates "scene/lighting owner" from
"what's in the scene" — a new `FoundersDistrict.ts` exporting the same
shape PrototypePlaza does (`{ group, cameraObstacles, spawnPoint }`,
registering colliders/interactables the same way) drops in without
touching `World.ts`'s lighting/sky/fog setup.

### Project discovery (implemented in CORE-005)

See `docs/privacy/PROJECT_DISCOVERY_THREAT_MODEL.md` and
`apps/web/src/projects/`. CORE-001's `PrototypePanel` (three hardcoded
placeholder cards) is gone — the `[E] View Projects` board interaction
now opens `ProjectDiscoveryPanel`, and the `Interactable`/
`InteractionSystem` wiring around it did not need to change, only what
`onOpenProjectBoard` does (exactly as the CORE-001 architecture note this
replaces anticipated). A project booth is the same pattern applied to a
single project: `ProjectBoothInteractable` holds only a `projectId` and
calls `ProjectDiscoveryPanel.openProject()` directly. Next real step for
a future Project Platform agent: CORE-006's wallet/Zcash work wiring a
real "Support with ZEC" action into `ProjectDetailPanel`'s links row,
and/or CORE-008 replacing the primitive pedestal/sign booths with real
art — neither is in scope yet (see `ROADMAP.md`).

### Audio/Zcash agents

Start from the respective README in `apps/web/src/audio/` / `apps/web/src/zcash/`. Neither
module exists yet; both are intentionally undocumented-in-code beyond
their README per the CORE-001 task brief.

## Known architectural deviations from the CORE-001 file list

The task brief's suggested `apps/web/src/` tree names only
`ui/InteractionPrompt.ts` and `ui/PrototypePanel.ts` under `ui/`. This
build also adds:

- `ui/styles.ts` — a single shared stylesheet so every widget doesn't
  reimplement "dark panel, amber border, rounded corners".
- `ui/HUD.ts` — the always-on info corner + location label (task brief
  section 24 asks for this content but didn't name a file for it).
- `ui/DebugStats.ts` — the dev-only FPS/triangle/draw-call panel (task
  brief section 17 asks for this; same reasoning).
- `world/Sky.ts` — split out of `World.ts` for readability.
- `player/PlaceholderCharacter.ts` — split out of `LocalPlayer.ts` so the
  "how the primitive character is built" code doesn't bloat the class
  that owns the player's runtime state.

No behavior-affecting deviations (engine, world scale, identity model,
multiplayer framework) were made — those remain explicitly out of scope
per CORE-001 section 32 ("Critical Collaboration Rule") and section 33.

## DECISION REQUIRED (pending architectural review)

None at this time. No scope outside CORE-001 was touched.
