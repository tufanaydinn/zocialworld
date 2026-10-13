# ADR-002: Third-person over-the-shoulder camera for MVP

## Status

Accepted (2026-10-02)

## Context

Zocial World is a social hub, not a combat or exploration game. The
camera needs to support recognizing other players, easy navigation
around a small compact district, and low motion-sickness risk for a
broad audience in a browser.

Candidates considered: first-person, third-person over-the-shoulder,
fixed isometric/top-down.

## Decision

Use a **third-person, mouse-orbit, over-the-shoulder camera** for the
MVP. First-person is deferred to a later, optional
exploration/accessibility mode — not required for v0.1.

Implementation (`apps/web/src/camera/ThirdPersonCamera.ts`):

- Yaw/pitch orbit driven by pointer-locked mouse movement, pitch clamped
  to avoid flipping under/over the character.
- Distance (zoom) clamped between a minimum and maximum, adjustable by
  mouse wheel.
- Exponential-smoothing follow (never a hard snap) — a social space where
  people stand still often reads as jittery with naive lerp-to-target
  camera code.
- A pivot → desired-position raycast against registered world obstacles
  so the camera pulls in instead of clipping through buildings, rather
  than a full physics-based camera collider.
- No first-person mode, no cinematic/combat lock-on camera — both out
  of scope for a social hub.

## Consequences

- Players always see their own avatar, reinforcing visual identity in a
  social space — the core reason for this choice.
- Movement direction is computed camera-relative
  (`apps/web/src/player/PlayerController.ts` reads
  `ThirdPersonCamera.currentYaw`), which couples the two systems through
  exactly one number rather than a full interface — see
  `docs/architecture/OVERVIEW.md`.
- Adding first-person mode later is additive (a camera-mode switch), not
  a rewrite, because `PlayerController` already treats "camera yaw" as
  an injected dependency rather than assuming a specific camera
  implementation.
- Combat-style camera features (lock-on, aim-down-sights) are not
  supported by this design and would need a new ADR if ever required —
  not expected, since this is explicitly not a combat game.
