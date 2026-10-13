import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { FULL_RATE_DISTANCE, animationInterval, animationPhase, animationStepDue } from "./animationLod.ts";
import { RemotePlayer } from "./RemotePlayer.ts";
import { PlaceholderCrowd } from "../player/PlaceholderCrowd.ts";

// Remote avatars animate at a reduced rate beyond 10 m, and a player whose nothing changed is frozen
// (three skips its matrices and bone texture that frame).

test("full rate within 10 m; 30 / 20 / 15 Hz further out; a walk keeps 30 Hz", () => {
  assert.equal(animationInterval({ distance: 0, moving: false }), 0);
  assert.equal(animationInterval({ distance: FULL_RATE_DISTANCE, moving: false }), 0);
  assert.equal(animationInterval({ distance: 12, moving: false }), 1 / 30);
  assert.equal(animationInterval({ distance: 18, moving: false }), 1 / 30);
  assert.equal(animationInterval({ distance: 22, moving: false }), 1 / 20);
  assert.equal(animationInterval({ distance: 40, moving: false }), 1 / 15);
  assert.equal(animationInterval({ distance: 40, moving: true }), 1 / 30);
  assert.equal(animationInterval({ distance: Number.NaN, moving: false }), 0, "unknown distance: full rate");
});

test("reduced detail (the frame-pacing guard's crowd lever): full rate only within 6 m, every rate halved", () => {
  assert.equal(animationInterval({ distance: 5, moving: false, reduced: true }), 0);
  assert.equal(animationInterval({ distance: 8, moving: false, reduced: true }), 1 / 15);
  assert.equal(animationInterval({ distance: 22, moving: false, reduced: true }), 1 / 10);
  assert.equal(animationInterval({ distance: 40, moving: false, reduced: true }), 1 / 8);
  assert.equal(animationInterval({ distance: 40, moving: true, reduced: true }), 1 / 20);
  assert.equal(animationInterval({ distance: 8, moving: false, reduced: false }), 0, "not reduced: 8 m is full rate");
});

test("a step is due once the interval's worth of animation time has piled up", () => {
  assert.equal(animationStepDue(0, 0), true, "full rate: every frame");
  assert.equal(animationStepDue(0.02, 1 / 30), false);
  assert.equal(animationStepDue(1 / 30, 1 / 30), true);
});

test("phases spread players over the interval, deterministically", () => {
  const phases = Array.from({ length: 60 }, (_, seed) => animationPhase(seed, 1 / 15));
  assert.ok(phases.every((phase) => phase >= 0 && phase < 1 / 15));
  assert.ok(new Set(phases.map((phase) => Math.floor(phase * 15 * 4))).size === 4, "all four quarters used");
  assert.equal(animationPhase(7, 1 / 15), animationPhase(7, 1 / 15));
});

function seatedPlayer(): RemotePlayer {
  return new RemotePlayer("p1", "Viewer", 3, { x: -1000, y: 0.4, z: -5, rotationY: 0, animationState: "sit" }, { model: "rogue", color: 2 });
}

test("a far seated player steps every few frames and is frozen in between; a near one animates every frame", () => {
  const player = seatedPlayer();
  const now = 10_000;
  player.update(1 / 60, true, 25, now); // first frame: matrices dirty
  assert.equal(player.isFrozen, false);
  let frozen = 0;
  let stepped = 0;
  for (let frame = 1; frame <= 60; frame++) {
    player.update(1 / 60, true, 25, now + frame * 16.7);
    if (player.isFrozen) frozen++;
    else stepped++;
  }
  // 20 Hz at 60 FPS: about one frame in three animates.
  assert.ok(stepped >= 18 && stepped <= 22, `stepped ${stepped}`);
  assert.equal(frozen + stepped, 60);
  for (let frame = 61; frame <= 70; frame++) {
    player.update(1 / 60, true, 4, now + frame * 16.7);
    assert.equal(player.isFrozen, false, "within 10 m: every frame");
  }
});

test("off screen nothing animates and a stationary player stays frozen; moving unfreezes it", () => {
  const player = seatedPlayer();
  player.update(1 / 60, true, 25, 1000);
  player.update(1 / 60, false, 0, 1016);
  assert.equal(player.isFrozen, true);
  player.receiveTransform({ x: -998, y: 0.4, z: -5, rotationY: 0, animationState: "walk" });
  player.update(1 / 60, false, 0, performance.now() + 500);
  assert.equal(player.isFrozen, false, "moved (even off screen: positional voice follows the object)");
});

test("a frozen player's subtree keeps its matrices: three's per-frame update skips it", () => {
  const player = seatedPlayer();
  const scene = new THREE.Scene();
  scene.add(player.object);
  player.update(1 / 60, true, 25, 1000);
  scene.updateMatrixWorld();
  const before = player.object.matrixWorld.clone();
  player.update(1 / 60, false, 0, 1016);
  assert.equal(player.isFrozen, true);
  player.object.position.x += 5; // what a stale frame would pick up, were it not skipped
  scene.updateMatrixWorld();
  assert.ok(player.object.matrixWorld.equals(before));
});

test("the placeholder joins the crowd at spawn and leaves it on dispose", () => {
  const crowd = new PlaceholderCrowd(4);
  const player = new RemotePlayer("p2", "Guest", 5, { x: 0, y: 0, z: 0, rotationY: 0, animationState: "idle" }, { model: "knight", color: 1 }, false, { crowd });
  assert.equal(crowd.size, 1);
  player.dispose();
  assert.equal(crowd.size, 0);
});
