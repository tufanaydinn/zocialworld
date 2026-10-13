# ADR-004: No physics engine for the core prototype

## Status

Accepted (2026-10-02)

## Context

Zocial World is a social hub where players walk around a
small, mostly static environment and talk to each other — not a
physics-driven game.
Movement needs are limited to: walking on a flat-ish ground plane, not
walking through buildings/trees/props, and (later) sitting on benches.
There is no jumping, no climbing, no swimming, no combat, no
physics-driven props.

A full physics engine (Rapier, Cannon-es, Ammo.js) would add: a WASM/JS
runtime dependency, a rigid-body simulation step every frame, collision
mesh authoring overhead, and a class of bugs (tunneling, jitter, sleep
states) that have nothing to do with the actual product need.

Note: `@types/three` transitively pulls in `@dimforge/rapier3d-compat`
as a **type-only devDependency** (because `three/examples/jsm` ships
optional Rapier integration types). This is unrelated to this decision —
it is never imported by application code and contributes nothing to the
production bundle (verified: the first prototype's production bundle was
658 KB raw with zero physics-engine code in it). It is not evidence of an actual
physics engine being used, and removing it would mean patching
`@types/three`'s own `package.json`, which is out of scope.

## Decision

Build a **custom, lightweight 2.5D (XZ-plane) collision system**
(`apps/web/src/collision/CollisionSystem.ts`) instead of adopting a
physics engine:

- Box colliders (buildings) and cylinder colliders (trees, the fountain)
  registered separately from visible render geometry.
- A circular body (the player) is resolved against these via simple
  push-out math — nearest-axis penetration resolution for boxes,
  radius-sum resolution for cylinders.
- No gravity, no velocity/impulse simulation, no broadphase/narrowphase
  split, no sleep states. Y is not simulated at all; the ground is
  assumed flat.

## Consequences

- Movement code stays simple, fast, and fully predictable —
  `PlayerController.update()` resolves collision synchronously every
  frame with no simulation step to tune.
- No physics-engine bundle weight or WASM load time.
- This does **not** scale to: slopes/stairs, physics-driven props,
  ragdoll, vehicles, or projectile-based interactions. If any future task
  genuinely needs real physics (unlikely given the product's social, not
  combat/exploration, focus), that is an architecture-affecting change
  requiring a new ADR, not a quiet `npm install` of a physics engine.
- Collision proxies must always stay simplified primitives, never the
  visible high-detail mesh — this is enforced by convention (`CollisionSystem` only accepts box/cylinder
  primitives, not arbitrary geometry) rather than by tooling.
- Ground height per location came later without a physics engine:
  a location supplies `heightAt(x, z)` (ADR-008).
