# ADR-017: Point-light pool — only the active location's lights reach the shaders

## Status

Accepted (2026-10-08). A performance change with no visual change. ADR-014 had already flagged it ("flagged
for a future light-pool change"). The goal: a full 60-person Watch Hall must keep its frame rate.

## Context

- three.js compiles the number of point lights into every lit shader and evaluates every point light for every lit
  pixel. Changing the count recompiles every program, which takes seconds on a software rasterizer.
- ADR-010 places each location at its own far origin and renders only the active one. To keep the light count fixed,
  World.ts moved every location's point lights to scene level (ADR-014). With several locations of up to a dozen lights
  each, every location paid for the point lights of all of them.
- The lights of other locations are 1000 m away and have an 8–28 m cutoff. They add exactly nothing, yet each one
  still costs a uniform fetch, a normalise, a length and an attenuation per pixel (the existing range skip only skips
  the BRDF).
- Measured with `?perf=hall60` (SwiftShader, 1280 × 720, a full hall with 67 players), hiding the lights the hall
  does not need cut the GPU process's work per frame by about a third. It is the largest single GPU cost in the hall.

## Decision

1. Each location's PointLights stay where the location builds them, but hidden. They are *sources*. The location
   keeps animating them (flicker), as before.
2. A fixed pool of scene-level PointLights (`apps/web/src/world/lightPool.ts`), as many as the busiest location has
   (12 today), mirrors the active location:
   - On a location change, `assign` copies each source's world position, colour, range and decay into a slot, in
     source order. Slots the location does not need get intensity 0.
   - Every frame, `sync` copies intensity and colour, so flicker keeps working.
3. The light count never changes, so no shader recompiles on travel. The shader warm-up compiles the same programs as
   before.
4. A dark slot uploads a zero colour, so its attenuated colour is zero and the existing range skip
   (`core/shaderPatches.ts`) never runs the BRDF for it. Every location's shaders loop over 12 slots instead of 25.
   An extra uniform test that skipped dark slots even before the attenuation was tried and measured: on SwiftShader it
   made frames about 8 % slower, so it is not part of this decision.
5. The low tier is unchanged: it renders no point lights at all.

## Consequences

- No visual change. Lights of other locations were out of range everywhere, and before/after screenshots match.
- Fewer per-pixel light evaluations everywhere: every location loops over 12 slots instead of 25, and only the active
  location's lights can reach the BRDF.
- A location may have at most as many lights as the pool. The pool grows automatically with the busiest location (its
  size is computed at load), so adding a light to any location still works. A larger busiest location makes every
  location's shaders loop over more slots.
- Lights are no longer real scene children of the scene-level `LocationLights` group, so code that wants a location's
  lights reads that location's own list.
- Revert: remove the pool. World.ts then moves the lights to scene level again, as before this decision.
