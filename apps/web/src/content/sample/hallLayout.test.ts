import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { CollisionSystem } from "../../collision/CollisionSystem.ts";
import { SEATED_CAMERA_DISTANCE, SEATED_CAMERA_PITCH, SEATED_TARGET_HEIGHT } from "../../hall/SeatSystem.ts";
import { HALL_ORIGIN, hallLayoutProblems, hallToWorld, seatLabel } from "../../world/hall/hallGeometry.ts";
import { sampleHallLayout as layout } from "./hallLayout.ts";

const RADIUS = 0.35;

test("sample hall layout: consistent for the hall systems, one row of four seats", () => {
  assert.deepEqual(hallLayoutProblems(layout), []);
  assert.deepEqual(layout.seats.map(seatLabel), ["Row 1 · left 1", "Row 1 · left 2", "Row 1 · right 1", "Row 1 · right 2"]);
  assert.deepEqual(layout.seats.map((seat) => seat.id), [0, 1, 2, 3]);
  assert.equal(layout.minimap().title, "Watch Hall");
});

test("sample hall colliders: the walls block; the stand points, the arrival, the exit and every use point stay open", () => {
  const collisions = new CollisionSystem();
  layout.registerColliders(collisions);
  const open = (x: number, z: number, what: string): void => {
    const p = new THREE.Vector3(x, 0, z);
    assert.ok(collisions.resolve(p, RADIUS).distanceTo(p) < 1e-6, `${what} should be walkable`);
  };
  for (const seat of layout.seats) open(seat.standX, seat.standZ, `stand point of seat ${seat.id}`);
  for (const [what, point] of [
    ["arrival", layout.arrival],
    ["exit", layout.exit],
    ["podium spot", layout.podium.use],
    ["speaker card spot", layout.speakerCard.use],
    ["Live Now spot", layout.boards.liveNow.use],
    ["Discussion spot", layout.boards.discussion.use],
  ] as const) {
    open(HALL_ORIGIN.x + point.x, HALL_ORIGIN.z + point.z, what);
  }
  const wall = new THREE.Vector3(HALL_ORIGIN.x + 19.9, 0, HALL_ORIGIN.z);
  assert.ok(collisions.resolve(wall, RADIUS).distanceTo(wall) > 0.1, "the side wall blocks");
});

test("sample hall: the stage is raised and walkable; seats sit on their floor", () => {
  const onStage = hallToWorld(0, 0, -12);
  assert.equal(layout.isOnStage(onStage.x, onStage.z), true);
  assert.equal(layout.heightAt(onStage.x, onStage.z), layout.stage.y);
  const pit = hallToWorld(0, 0, -8);
  assert.equal(layout.isOnStage(pit.x, pit.z), false);
  assert.equal(layout.heightAt(pit.x, pit.z), 0);
});

test("sample hall: the seated camera frames the whole screen from every seat", () => {
  const { screen } = layout;
  const corners = [-1, 1].flatMap((sx) => [-1, 1].map((sy) => hallToWorld(screen.x + (sx * screen.width) / 2, screen.y + (sy * screen.height) / 2, screen.z)));
  for (const seat of layout.seats) {
    // SeatSystem's seated camera through ThirdPersonCamera's orbit: behind the seat, pitched, at the seated target height.
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 600);
    const yaw = seat.yaw + Math.PI;
    const pitch = THREE.MathUtils.degToRad(SEATED_CAMERA_PITCH);
    const pivot = new THREE.Vector3(seat.x, seat.y + SEATED_TARGET_HEIGHT * 0.9, seat.z);
    camera.position.copy(pivot).add(new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(SEATED_CAMERA_DISTANCE));
    camera.lookAt(pivot);
    camera.updateMatrixWorld();
    for (const corner of corners) {
      const ndc = corner.clone().project(camera);
      assert.ok(Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z < 1, `seat ${seat.id}: corner at ndc (${ndc.x.toFixed(2)}, ${ndc.y.toFixed(2)})`);
    }
  }
});
