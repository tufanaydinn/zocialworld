import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { PointLightPool, lightPoolSize, takePointLightSources } from "./lightPool.ts";
import { applyShaderPatches } from "../core/shaderPatches.ts";

// ADR-017: a fixed pool of scene-level point lights mirrors the active location's lights.

function location(lights: { x: number; z: number; intensity: number; distance: number; color?: number }[], offsetX = 0): THREE.Group {
  const group = new THREE.Group();
  group.position.x = offsetX;
  const inner = new THREE.Group();
  inner.position.z = 1; // sources may sit deep in a location's hierarchy
  group.add(inner);
  for (const spec of lights) {
    const light = new THREE.PointLight(spec.color ?? 0xffa040, spec.intensity, spec.distance, 1.6);
    light.position.set(spec.x, 3, spec.z);
    inner.add(light);
  }
  return group;
}

test("the pool is as large as the busiest location", () => {
  assert.equal(lightPoolSize([12, 8, 5]), 12);
  assert.equal(lightPoolSize([]), 0);
});

test("sources are hidden: from now on only the pool renders", () => {
  const group = location([{ x: 0, z: 0, intensity: 10, distance: 8 }, { x: 4, z: 0, intensity: 20, distance: 12 }]);
  const sources = takePointLightSources(group);
  assert.equal(sources.length, 2);
  assert.ok(sources.every((light) => !light.visible));
});

test("assign copies world position, range and decay in source order; spare slots go dark; sync follows flicker and colour", () => {
  const hall = takePointLightSources(location([{ x: 1, z: 2, intensity: 42, distance: 24 }, { x: -3, z: 5, intensity: 30, distance: 20, color: 0xffb060 }], -1000));
  const pool = new PointLightPool(4);
  assert.equal(pool.size, 4);
  assert.equal(pool.group.children.length, 4);
  pool.assign(hall);
  assert.equal(pool.used, 2);
  const slots = pool.group.children as THREE.PointLight[];
  assert.deepEqual(slots[0]!.position.toArray(), [-999, 3, 3]);
  assert.deepEqual(slots[1]!.position.toArray(), [-1003, 3, 6]);
  assert.equal(slots[0]!.distance, 24);
  assert.equal(slots[1]!.decay, 1.6);
  assert.equal(slots[0]!.intensity, 42);
  assert.equal(slots[1]!.color.getHex(), 0xffb060);
  assert.equal(slots[2]!.intensity, 0);
  assert.equal(slots[3]!.intensity, 0);
  assert.ok(slots.every((slot) => slot.visible), "the light count never changes");

  hall[0]!.intensity = 37.5; // the location's flicker
  pool.sync();
  assert.equal(slots[0]!.intensity, 37.5);
});

test("travel: a busier location fills every slot, a quieter one darkens the rest", () => {
  const district = takePointLightSources(location(Array.from({ length: 6 }, (_, i) => ({ x: i, z: 0, intensity: 10 + i, distance: 10 }))));
  const hall = takePointLightSources(location([{ x: 0, z: 0, intensity: 40, distance: 24 }], -1000));
  const pool = new PointLightPool(lightPoolSize([district.length, hall.length]));
  const slots = pool.group.children as THREE.PointLight[];
  pool.assign(district);
  assert.deepEqual(slots.map((slot) => slot.intensity), [10, 11, 12, 13, 14, 15]);
  pool.assign(hall);
  assert.deepEqual(slots.map((slot) => slot.intensity), [40, 0, 0, 0, 0, 0]);
  hall[0]!.intensity = 0.5;
  pool.sync();
  assert.deepEqual(slots.map((slot) => slot.intensity), [0.5, 0, 0, 0, 0, 0], "dark slots stay dark");
});

test("a location with more lights than the pool fills the pool and ignores the rest", () => {
  const sources = takePointLightSources(location(Array.from({ length: 5 }, (_, i) => ({ x: i, z: 0, intensity: i + 1, distance: 10 }))));
  const pool = new PointLightPool(3);
  pool.assign(sources);
  assert.equal(pool.used, 3);
  assert.deepEqual((pool.group.children as THREE.PointLight[]).map((slot) => slot.intensity), [1, 2, 3]);
});

test("a dark slot never reaches the BRDF: its zero colour makes the light invisible to the range skip", () => {
  applyShaderPatches();
  applyShaderPatches(); // idempotent
  const begin = THREE.ShaderChunk.lights_fragment_begin;
  const section = begin.slice(begin.indexOf("#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )"), begin.indexOf("#if ( NUM_SPOT_LIGHTS > 0 )"));
  assert.ok(section.includes("/* point-light range skip */ if ( directLight.visible ) RE_Direct("), "the BRDF runs only for a visible light");
  assert.equal(begin.split("/* point-light range skip */").length, 2, "patched once");
  // three computes `visible` from the attenuated colour, which is zero for a zero-colour (dark) slot.
  const pars = THREE.ShaderChunk.lights_pars_begin;
  assert.match(pars, /light\.color = pointLight\.color;\s*light\.color \*= getDistanceAttenuation\([^;]*\);\s*light\.visible = \( light\.color != vec3\( 0\.0 \) \);/);
});
