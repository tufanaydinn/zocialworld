import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { buildModularBuilding } from "../../world/district/ModularBuilding.ts";
import { StaticBatcher } from "../../world/district/StaticBatcher.ts";
import { SAMPLE_BUILDING } from "./building.ts";

// The modular building assembler on the sample spec: which kit pieces it places, where, and that it is deterministic.

function build(): { result: ReturnType<typeof buildModularBuilding>; placements: ReturnType<StaticBatcher["exportPlacements"]>; glow: THREE.Matrix4[] } {
  const batcher = new StaticBatcher();
  const glow: THREE.Matrix4[] = [];
  const result = buildModularBuilding(SAMPLE_BUILDING, batcher, glow);
  return { result, placements: batcher.exportPlacements(), glow };
}

test("sample building: walls, a door, a roof and a chimney from the town kit, inside the footprint", () => {
  const { result, placements, glow } = build();
  const pieces = placements.map((placement) => /\/kenney-fantasy-town\/([\w-]+)\.glb$/.exec(placement.url)?.[1]);
  assert.ok(pieces.every((piece) => piece !== undefined), "every piece is a town kit model");
  assert.ok(pieces.some((piece) => piece!.includes("door")), "the front has a door");
  assert.ok(pieces.some((piece) => piece!.startsWith("roof")), "a roof covers it");
  assert.ok(pieces.includes("chimney"));
  assert.ok(pieces.some((piece) => piece!.startsWith("wall-wood")) && pieces.some((piece) => piece!.startsWith("wall") && !piece!.includes("wood")), "stone below, timber above");
  const cell = 2.6;
  assert.equal(result.wallHeight, SAMPLE_BUILDING.floors * cell);
  assert.deepEqual(result.frontNormal.toArray().map((value) => Math.round(value)), [0, 0, 1]);
  assert.ok(result.windowPoints.length > 0 && glow.length > 0, "lit windows glow");
  const position = new THREE.Vector3();
  for (const placement of placements) {
    position.setFromMatrixPosition(placement.matrix);
    assert.ok(Math.abs(position.x) <= (SAMPLE_BUILDING.width / 2) * cell + 0.01 && Math.abs(position.z) <= (SAMPLE_BUILDING.depth / 2) * cell + 0.01, `${placement.url} outside the footprint`);
  }
});

test("sample building: the same spec always gives the same pieces", () => {
  const a = build().placements.map((placement) => `${placement.url} ${placement.matrix.elements.map((value) => value.toFixed(4)).join(",")}`);
  const b = build().placements.map((placement) => `${placement.url} ${placement.matrix.elements.map((value) => value.toFixed(4)).join(",")}`);
  assert.deepEqual(a, b);
});
