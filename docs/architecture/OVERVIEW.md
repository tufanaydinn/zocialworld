# Architecture overview

This document explains how the web client's systems fit together and where new work plugs in without
reshaping what already exists. It is the starting point for contributors to `apps/web`. The game server
is described in `apps/server/README.md`, the wire protocol in `docs/protocols/multiplayer-protocol.md`,
and the reasons behind the main choices in the ADRs (`docs/decisions/README.md`).

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

Systems never import world content either. `App.ts` resolves one content provider (the sample content
in a plain checkout) and hands its locations, destinations, Watch Hall layout and lessons to the systems
that need them — see `apps/web/src/content/README.md`.

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
  │     4. world.update(...)                   (shows and updates only the location the camera
  │                                              is in; runs the point-light pool)
  │     5. remotePlayers.update(...)           (advances each RemotePlayer's interpolation
  │                                              buffer — render FPS, not network rate)
  │     6. publishLocalTransform(...)          (~10Hz-throttled, sends LocalPlayer's
  │                                              transform over NetworkClient — see
  │                                              docs/protocols/multiplayer-protocol.md § Network rate)
  │     7. updateVoice(...)                    (push-to-talk edge detection; the stage and
  │                                              VoiceSession.update() recompute every subscribed
  │                                              remote participant's gain from distance each frame)
  │     8. updateHallUi(...)                   (Watch Hall boards and stage widget)
  │     9. input.endFrame()                    (clears this-frame-only key presses)
  │
  └─ render()                                  ──▶ App.render()
        renderer.render(world.scene, camera.camera)
        remotePlayers.updateNameplates(...)     (projects each RemotePlayer's head
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
                     colliders, push-out resolution against a circular body
                     radius. No physics engine — see ADR-004.

apps/web/src/interaction/
  Interactable.ts    Generic `{ id, label, position, interactionRadius, interact() }`
                     contract. Anything interactable implements this — a project
                     board, a booth, a seat, a door or a lesson station.
  InteractionSystem.ts
                     Finds the nearest in-range Interactable each frame, notifies
                     UI of changes (for the "[E] <label>" prompt), fires
                     `interact()` on E. World objects register themselves; the
                     player controller never needs to know interaction exists.

apps/web/src/assets/
  AssetManager.ts    Centralized GLTFLoader wrapper: caching, SkeletonUtils-based
                     cloning (safe to instantiate the same GLB many times),
                     progress/error callbacks. No scene file should construct its
                     own GLTFLoader. The third-party model packs are optional
                     (`npm run assets:fetch`); assetPacks.ts tells the manager
                     which packs the build has, so a checkout without them shows
                     procedural placeholders. `window.__assetManager` is exposed
                     in dev builds for console testing.

apps/web/src/world/
  World.ts           Owns THREE.Scene and the location registry: builds the content
                     provider's atmosphere and location modules, shows and updates
                     only the location the camera is in, and runs the point-light
                     pool. See apps/web/src/content/README.md.
  LocationModule.ts  The contract a location implements: its build context, the
                     built location (group, colliders, ground height, spawn,
                     minimap, optional capabilities) and the atmosphere rig.
  PrototypePlaza.ts  The ~50×50 m greybox-with-paint space of the sample content:
                     ground, fountain, two placeholder buildings, trees, a bench,
                     lanterns, the project board and booths. Registers its own
                     colliders with CollisionSystem and its own obstacle meshes
                     with the camera.
  Sky.ts             Cheap vertical-gradient sky dome (custom ShaderMaterial on a
                     big inverted sphere) — no HDRI/texture download.

apps/web/src/ui/
  styles.ts          One injected <style> tag shared by every UI widget (dark
                     translucent panel + amber accent).
  InteractionPrompt.ts  The floating "[E] <label>" prompt.
  HUD.ts             Always-on chrome: top-left info corner, bottom-left location label.
  DebugStats.ts      Dev-only (import.meta.env.DEV-gated) FPS/triangle/draw-call panel.
  ConnectionStatus.ts Dev-only multiplayer connection indicator.
  Nameplates.ts      Projects each RemotePlayer's head position to a
                     screen-space DOM label — no CSS2DRenderer/sprite-text dependency.

  ChatPanel.ts       Chat tabs (General / Nearby / Whispers) and speech bubbles.
  WorldHud.ts, MinimapRenderer.ts, PortalPanel.ts, LoadingOverlay.ts
                     Location HUD, the minimap a location supplies, the portal
                     destination list and the loading screen.

apps/web/src/networking/
                     Multiplayer client: NetworkClient (owns the WebSocket
                     connection only), protocol.ts (message types + validation,
                     built on packages/shared), interpolation.ts (pure,
                     engine-agnostic entity interpolation buffer), RemotePlayer.ts
                     (LocalPlayer's networked counterpart — same model/animation
                     composition, driven by the interpolation buffer instead of
                     PlayerController), RemotePlayerManager.ts (Map<playerId,
                     RemotePlayer> bookkeeping, each remote player's
                     InteractionSystem registration and block-driven nameplate
                     visibility), remoteAvatars.ts and animationLod.ts (rigged
                     avatars and their animation level of detail). See
                     docs/protocols/multiplayer-protocol.md and
                     apps/web/src/networking/README.md.

apps/web/src/social/      Social identity and nearby interaction:
                       nearby.ts                pure getNearbyPlayers() +
                                                 SOCIAL_INTERACTION_RADIUS_METERS,
                                                 the one source of truth for
                                                 "how close counts as nearby",
                                                 unit-tested without Three.js.
                       SocialStore.ts            client-side-only, session-scoped
                                                 relationship state (blocked and
                                                 muted players, the selected
                                                 player) — no networking import,
                                                 by design (see
                                                 docs/privacy/SOCIAL_IDENTITY_THREAT_MODEL.md).
                       RemotePlayerInteractable.ts
                                                 adapts a RemotePlayer into the
                                                 Interactable contract, so player
                                                 selection reuses
                                                 InteractionSystem verbatim.
                       PlayerContextCard.ts      the player menu (Whisper, View
                                                 Profile, Send ZEC, volume, Mute,
                                                 Block, Report).
                       NicknameControls.ts       nickname entry/edit — every
                                                 nickname choice goes through
                                                 set_nickname, including the
                                                 first one, so there is one
                                                 validation/conflict code path.
                       Emotes.ts, EmoteWheel.ts, FloatingReactions.ts
                                                 the emote wheel (hold G) and
                                                 reactions.
                     See docs/protocols/multiplayer-protocol.md §§
                     Nickname validation and conflict resolution / Nearby
                     interaction range / Player selection.

apps/web/src/voice/       Proximity voice client — structurally separate from
                     apps/web/src/networking/:
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
                                           distance→gain curve and the voice
                                           ranges — deliberately distinct from
                                           SOCIAL_INTERACTION_RADIUS_METERS
                                           (apps/web/src/social/nearby.ts).
                       VoiceSession.ts     orchestration layer tying the three
                                           above together with SocialStore's
                                           isMuted()/isBlocked() (read fresh
                                           every frame, see App.ts's
                                           updateVoice()).
                       VoiceControls.ts    status/control widget (Enable Voice,
                                           mic mode, volume, microphone).
                       hallAudio.ts, stageShareQuality.ts
                                           the Watch Hall's audio rules and the
                                           stage screen share's encoding.
                     Server-side counterpart: apps/server/src/voice/ (token
                     minting only — see apps/server/README.md). See
                     docs/decisions/ADR-007-proximity-voice-transport.md
                     and docs/privacy/VOICE_THREAT_MODEL.md.

apps/web/src/hall/, apps/web/src/watch/
                     The Watch Hall's client logic (seats, stage queue and
                     widget, boards, presence, the speaker card, the
                     Discussion Corner) and the Watch panel (schedule, live
                     streams, replays, the opt-in personal YouTube player).
                     The hall's geometry comes from the content's HallLayout;
                     see docs/architecture/WATCH_HALL.md and
                     docs/decisions/ADR-014-watch-hall.md.

apps/web/src/learning/   The Learning Valley framework: the lesson catalogue
                     and its validation (catalog.ts), the LEARN → SEE → TRY →
                     PROVE panel, question pools, local-only progress
                     (progress.ts) and the visualizer framework
                     (visualizers/). Lessons come from the content provider.

apps/web/src/community/  The community hub client: forum, ZecHub wiki and
                     project pages read through the game server's read-only
                     gateway, with sanitised HTML (safeHtml.ts). See
                     docs/decisions/ADR-009-community-content-gateway.md.

apps/web/src/projects/   Project discovery — a static, repository-curated
                     registry + discovery/detail UI + world booths, no backend:
                       ProjectTypes.ts          Project interface + bounded
                                                 ProjectStatus/ProjectCategory
                                                 enums. No wallet/payment field
                                                 exists on Project.
                       projectData.ts           the static fixture dataset
                                                 (clearly fictional sample
                                                 projects).
                       ProjectRegistry.ts       validateProjects() (runs at
                                                 module load — an invalid fixture
                                                 throws immediately, never
                                                 silently breaks a booth) and the
                                                 lookup/search functions. The one
                                                 place project metadata lives —
                                                 booths and UI only ever hold a
                                                 projectId.
                       urlSafety.ts             isSafeExternalUrl() +
                                                 createSafeExternalLink() —
                                                 http/https only, every rendered
                                                 <a> gets rel="noopener noreferrer".
                       ProjectDiscoveryPanel.ts the discovery list/search/filter
                                                 UI, opened from the
                                                 `[E] View Projects` board.
                       ProjectDetailPanel.ts    one project's detail —
                                                 textContent/DOM construction
                                                 only, never innerHTML.
                       ProjectBoothInteractable.ts
                                                 a world Interactable that holds
                                                 only a projectId (throws at
                                                 construction if unknown) and
                                                 opens that project's detail view.
                     See docs/privacy/PROJECT_DISCOVERY_THREAT_MODEL.md.

apps/web/src/onboarding/ Welcome → wallet → character → nickname → Enter, the
                     character preview, the profile store and the name
                     confirmation interface (ADR-015, ADR-016).

apps/web/src/moderation/ Report dialog, the moderator panel and action
                     dialogs, and the overlay a removed player sees
                     (ADR-019).

apps/web/src/zcash/      The in-game wallet: the WebZjs engine boundary and the
                     encrypted keystore (core/), the adapter every UI uses
                     (ZcashWalletAdapter.ts), the wallet panel, private
                     player payments (PaymentFlow.ts, paymentCrypto.ts), the
                     mainnet cap and consent, and the name key. See
                     apps/web/src/zcash/README.md,
                     docs/privacy/ZCASH_WALLET_THREAT_MODEL.md and
                     docs/privacy/PLAYER_PAYMENTS_THREAT_MODEL.md.

apps/web/src/content/    The content seam (types.ts) and the sample content
                     (sample/): the prototype plaza, a small Watch Hall and
                     three lessons. See apps/web/src/content/README.md.

apps/web/src/audio/      Only a README: the planned ambient/SFX layer. Voice
                     lives in apps/web/src/voice/.
```

## Extension points

### Replacing the placeholder character

```ts
const { scene, animations } = await assetManager.instantiate("/assets/characters/builder.glb");
localPlayer.setModel(scene, animations);
```

If `animations` contains clips named `Idle`, `Walk`, `Jog`, `Sit`,
`Wave`, `Talk`, `PlayerAnimation` automatically switches from the
procedural backend to `THREE.AnimationMixer` crossfades. No changes
needed in `PlayerController`, `CollisionSystem`, or the camera.

### Adding a location

A location is a `LocationModule` (`apps/web/src/world/LocationModule.ts`) in one slot of the shared
coordinate space (`apps/web/src/world/locations.ts`). It builds its scene group, registers its colliders
and interactables, and reports its ground height, spawn point, minimap and optional capabilities (a
project board anchor, live community boards, a Watch Hall). `World` owns the scene, lighting, sky and fog
and drops a new module in without changing its own setup. To try one, add it to
`apps/web/src/content/sample/index.ts`. See
`docs/decisions/ADR-010-additional-locations-shared-coordinates.md` and
`docs/decisions/ADR-008-district-ground-height-and-render-tiers.md`.

### Multiplayer

See `apps/web/src/networking/README.md` and `docs/protocols/multiplayer-protocol.md`. `RemotePlayer`
mirrors `LocalPlayer`'s composition (a model + `PlayerAnimation`) but is driven by the interpolation
buffer instead of `PlayerController` — see
`docs/decisions/ADR-005-client-authoritative-movement.md`. Remote players are **not** added to
`CollisionSystem` or `ThirdPersonCamera.setObstacles()` (both accept arbitrary object lists, so this is
straightforward future work) — walking through another player is an accepted gap, not a bug.

### Social

See `docs/protocols/multiplayer-protocol.md` §§ Nickname validation and conflict resolution / Nearby
interaction range / Player selection, and `apps/web/src/social/`. Player selection reuses
`InteractionSystem` unchanged via `RemotePlayerInteractable` — a remote player and a world object (e.g.
the project board) compete for "nearest interactable" under the same rule. An optional
`Interactable.priority` comes first (the Watch Hall's seats 2, its boards and doors 1, players and
everything else 0; ADR-014 § 9), and distance breaks ties. No raycasting/click-to-select was added, to
avoid touching the camera or introducing combat-style lock-on.

### Identity and onboarding

See `docs/decisions/ADR-015-wallet-holder-identity.md`, the protocol doc's § Identity: wallet holders and
guests, and `apps/web/src/onboarding/`. `App` opens the WebSocket at startup but `NetworkClient.join()`
is called only when `OnboardingFlow` completes (Welcome → wallet → character → nickname → Enter; guests
skip to Enter), so a player in onboarding is invisible to others. The wallet step reuses `WalletPanel`;
the character step's turntable (`CharacterPreview`) has its own small renderer, disposed with
`forceContextLoss`, and shares the avatar templates of `RemoteAvatarLibrary` with the local player and
the remote avatars. `participation.ts` adds the sticky `walletHolder` boolean, which App maps to
`join.wallet` / `set_wallet`; the server's `canReceive` comes back in presence and gates Send ZEC
(`PlayerContextCard`), renaming (`NicknameControls`, the Profile panel) and full voice. A holder's name
is applied through the `NameConfirmation` interface (`onboarding/nameConfirmation.ts`: a plain
`set_nickname`, or the fee-confirmed registration of ADR-016 in `feeNameConfirmation.ts`).
`profileStore.ts` remembers the character (and a holder's name) under `player-profile-v1`; the e2e suite
seeds `{ autoEnter: "guest" }`, which App honours only in DEV / `VITE_TEST_HOOKS` builds.

### Voice

See `docs/decisions/ADR-007-proximity-voice-transport.md`, `docs/privacy/VOICE_THREAT_MODEL.md`, and
`apps/web/src/voice/`. Voice attaches to `RemotePlayer.object`, reuses `InputManager`'s text-input guard
for push-to-talk (`KeyV` in `KEY_TO_ACTION`), and reads `SocialStore`'s block and mute state, which stay
local-only. The SFU connection (LiveKit) and the gameplay WebSocket connection are deliberately two
separate systems; only token minting shares the game server's `http.Server` process.

### The Watch Hall

A content with a Watch Hall supplies a `HallLayout`; the hall systems read seats, stage, screen, podium,
boards and floor heights from it and never hard-code positions. `docs/architecture/WATCH_HALL.md`
describes the systems and the hall contract.

### Lessons

A lesson catalogue (`apps/web/src/learning/catalog.ts`: `LessonCatalog`) comes from the content provider.
`validateCatalog` checks the rules every catalogue keeps (unique ids, known and acyclic prerequisites,
answerable quizzes, a TRY step behind every simulation proof). A visualizer is registered by id; a
content can add its own next to `BASIC_VISUALIZERS`.

### Project discovery

See `docs/privacy/PROJECT_DISCOVERY_THREAT_MODEL.md` and `apps/web/src/projects/`. The `[E] View
Projects` board interaction opens `ProjectDiscoveryPanel`; a project booth is the same pattern applied to
one project: `ProjectBoothInteractable` holds only a `projectId` and calls
`ProjectDiscoveryPanel.openProject()` directly. `ProjectDetailPanel`'s links row has a "Support with ZEC"
action (`apps/web/src/zcash/SupportFlow.ts`): a shielded payment to the project, with no memo by default.

### Audio

Start from `apps/web/src/audio/README.md`. The ambient/SFX layer is not built yet.
