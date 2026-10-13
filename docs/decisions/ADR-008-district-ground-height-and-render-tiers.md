# ADR-008: Analytic ground height, render quality tiers, bloom

## Status

Accepted (2026-10-05)

## Context

A district needs raised ground: terraces reached by stairs, and a spawn point that looks down into a
plaza. ADR-004 deliberately assumed flat ground and said stairs would need a new ADR.

A production district is also far denser than the first greybox prototype (thousands of static
placements, a few dozen skinned characters, a dozen warm point lights), and its look depends on glowing
lanterns and windows. On a software rasterizer (SwiftShader, the same class of renderer headless CI uses),
the full-quality district rendered at about 0.5 FPS, which breaks the Playwright suite (movement and
interaction tests need several frames per second).

## Decision

1. **Analytic ground height, collision unchanged.** A location exposes `heightAt(x, z)`, a pure function
   of position (for example: plaza level, terrace levels and linear ramps on the stairways).
   `PlayerController` takes an optional `groundHeightAt` and eases the player's Y toward it. Collision
   stays exactly ADR-004's 2.5D XZ box/cylinder resolution; terrace edges are fenced with box colliders
   so the stairs are the only way between levels. No physics engine, no raycasts, no navmesh. The default
   is `() => 0`, so a flat location behaves exactly as before.
2. **Render quality tiers** (`apps/web/src/core/quality.ts`). Auto-detected from the WebGL renderer string
   (software rasterizers → "low"), overridable with `?quality=high|low`. Low tier: render scale 0.4, no
   shadow map, no bloom, Lambert instead of PBR materials, point lights hidden, decimated decorative
   detail, no skinned characters.
3. **Bloom post-processing** in `Renderer` (three.js `EffectComposer` + half-resolution `UnrealBloomPass`
   + `OutputPass`) on the high tier only; `?bloom=0` disables it.
4. Camera far plane 200 → 600 m so a far skyline layer is visible.

## Consequences

- Stairs and terraces work with zero change to collision semantics; remote players already receive Y
  over the network.
- Headless e2e passes on the low tier, but at about 4 FPS on SwiftShader the suite is slower and more
  timing-sensitive than with a greybox.
- The high tier of a dense district costs about 500k triangles and 570 draw calls per frame including
  the shadow and bloom passes. Real-GPU frame rates are measured with `docs/architecture/PERFORMANCE.md`.
- Revert path: pass no `groundHeightAt` (flat), stop using `quality.ts`, drop the composer branch in
  `Renderer.render()` — each is a few lines.
