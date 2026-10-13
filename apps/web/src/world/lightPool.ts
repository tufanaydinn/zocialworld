import * as THREE from "three";

/**
 * ADR-017: the point-light pool.
 *
 * Every location builds its own PointLights (lanterns, fires, chandeliers). three.js evaluates every
 * point light in the scene for every lit pixel and compiles the light count into every shader, so
 * the old approach (all ~25 lights of all locations at scene level, so hiding a location never
 * changed the count) made the Watch Hall pay for the district's and the valley's lights 1000 m
 * away. Now the locations' lights are only *sources*: they stay where the location built them,
 * hidden, and keep being animated (flicker) by their location. A fixed pool of scene-level
 * PointLights, as many as the busiest location has, mirrors the active location's sources:
 *
 *  - `assign` (on a location change) copies each source's world position, colour, range and decay
 *    into a slot, in source order; slots the location doesn't need go dark (intensity 0);
 *  - `sync` (per frame) copies intensity and colour, so flicker keeps working.
 *
 * The light count never changes, so no shader ever recompiles. The loop is 12 slots instead of 25;
 * a dark slot uploads a zero colour, so its attenuated colour is zero and the existing range skip
 * (core/shaderPatches.ts) never runs the BRDF for it. Lights of other locations were out of range
 * (their cutoff is 8–28 m), so nothing on screen changes. (An extra uniform test that skipped dark
 * slots before the attenuation was measured on SwiftShader and made frames slower, so it was dropped.)
 */
export class PointLightPool {
  readonly group = new THREE.Group();
  private readonly slots: THREE.PointLight[];
  private sources: readonly THREE.PointLight[] = [];

  constructor(size: number) {
    this.group.name = "PointLightPool";
    this.slots = Array.from({ length: Math.max(0, size) }, (_, index) => {
      const light = new THREE.PointLight(0xffffff, 0, 1, 1.6);
      light.name = `PooledPointLight:${index}`;
      this.group.add(light);
      return light;
    });
  }

  get size(): number {
    return this.slots.length;
  }

  /** How many slots carry a source right now. */
  get used(): number {
    return Math.min(this.sources.length, this.slots.length);
  }

  /** Points the pool at a location's lights (its sources stay hidden; only the pool renders). Extra sources beyond the pool size are ignored. */
  assign(sources: readonly THREE.PointLight[]): void {
    this.sources = sources;
    this.slots.forEach((slot, index) => {
      const source = sources[index];
      if (!source) {
        slot.intensity = 0;
        return;
      }
      source.getWorldPosition(slot.position);
      slot.distance = source.distance;
      slot.decay = source.decay;
    });
    this.sync();
  }

  /** Per frame, after the active location's update: intensity (flicker) and colour follow the sources. */
  sync(): void {
    const count = this.used;
    for (let index = 0; index < count; index++) {
      const slot = this.slots[index]!;
      const source = this.sources[index]!;
      slot.intensity = source.intensity;
      slot.color.copy(source.color);
    }
  }
}

/** Collects the point lights under `root` (in traversal order) and hides them: from now on they are pool sources. */
export function takePointLightSources(root: THREE.Object3D): THREE.PointLight[] {
  const lights: THREE.PointLight[] = [];
  root.traverse((object) => {
    if ((object as THREE.PointLight).isPointLight) lights.push(object as THREE.PointLight);
  });
  for (const light of lights) light.visible = false;
  return lights;
}

/** The pool size: the busiest location's light count. */
export function lightPoolSize(counts: Iterable<number>): number {
  let size = 0;
  for (const count of counts) size = Math.max(size, count);
  return size;
}
