import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { ANIMATION_STATES } from "@project/shared";
import { createPlaceholderCharacter, HIP_HEIGHT } from "./PlaceholderCharacter.ts";
import { PlayerAnimation, baseClipFor, emoteLayersFor } from "./PlayerAnimation.ts";
import { EmoteBoneLayer } from "./emoteLayer.ts";

// ADR-014 § 10, WATCH_HALL.md: the dance/cheer states and how every state maps to clips and layers.

test("the networked animation states include the emote-wheel states", () => {
  assert.deepEqual([...ANIMATION_STATES], ["idle", "walk", "jog", "sit", "wave", "talk", "dance", "cheer"]);
});

test("baseClipFor: movement wins, then seated → Sit, cheer → Cheer, everything else over Idle", () => {
  const standing = Object.fromEntries(ANIMATION_STATES.map((state) => [state, baseClipFor(state, false)]));
  assert.deepEqual(standing, { idle: "Idle", walk: "Walk", jog: "Jog", sit: "Sit", wave: "Idle", talk: "Idle", dance: "Idle", cheer: "Cheer" });
  const seated = Object.fromEntries(ANIMATION_STATES.map((state) => [state, baseClipFor(state, true)]));
  assert.deepEqual(seated, { idle: "Sit", walk: "Walk", jog: "Jog", sit: "Sit", wave: "Sit", talk: "Sit", dance: "Sit", cheer: "Sit" });
});

test("emoteLayersFor: wave and dance are layers anywhere, cheer is a layer only while seated", () => {
  assert.deepEqual(emoteLayersFor("wave", false), { wave: true, dance: false, cheer: false });
  assert.deepEqual(emoteLayersFor("dance", true), { wave: false, dance: true, cheer: false });
  assert.deepEqual(emoteLayersFor("cheer", false), { wave: false, dance: false, cheer: false });
  assert.deepEqual(emoteLayersFor("cheer", true), { wave: false, dance: false, cheer: true });
  assert.deepEqual(emoteLayersFor("idle", true), { wave: false, dance: false, cheer: false });
});

test("placeholder (low tier): wave, cheer, dance, sit and the raised hand pose the primitive limbs", () => {
  const rig = createPlaceholderCharacter();
  const animation = new PlayerAnimation();
  animation.useProceduralRig(rig);
  const run = (seconds: number): void => {
    for (let t = 0; t < seconds; t += 1 / 30) animation.update(1 / 30, 0);
  };

  animation.setState("wave");
  run(0.5);
  assert.ok(rig.rightArm.rotation.x < -2, "wave raises the right arm");
  assert.ok(Math.abs(rig.leftArm.rotation.x) < 0.2, "and not the left");

  animation.setState("cheer");
  run(0.5);
  assert.ok(rig.rightArm.rotation.x < -2.3 && rig.leftArm.rotation.x < -2.3, "cheer raises both arms");

  animation.setState("dance");
  let minY = Infinity;
  let maxY = -Infinity;
  for (let t = 0; t < 1; t += 1 / 60) {
    animation.update(1 / 60, 0);
    minY = Math.min(minY, rig.torso.position.y);
    maxY = Math.max(maxY, rig.torso.position.y);
  }
  assert.ok(maxY - minY > 0.03, "dance bounces");

  animation.setState("idle");
  animation.setHandRaised(true);
  run(0.3);
  assert.ok(rig.rightArm.rotation.x < -2.8, "a raised hand points the right arm up");

  animation.setHandRaised(false);
  animation.setState("sit");
  run(1);
  assert.ok(Math.abs(rig.torso.position.y - (HIP_HEIGHT - 0.25)) < 1e-6, "sit lowers the hips");
  assert.ok(rig.rightArm.rotation.x > -0.5, "the arm comes back down");
});

/** A tiny KayKit-like rig (sanitised bone names), facing +Z with its left at +X. */
function kayKitLikeRig(): THREE.Group {
  const root = new THREE.Group();
  const bone = (name: string, parent: THREE.Object3D, x: number, y: number, z = 0): THREE.Bone => {
    const node = new THREE.Bone();
    node.name = name;
    node.position.set(x, y, z);
    parent.add(node);
    return node;
  };
  const hips = bone("hips", root, 0, 0.9);
  const spine = bone("spine", hips, 0, 0.15);
  const chest = bone("chest", spine, 0, 0.2);
  bone("head", chest, 0, 0.3);
  for (const [side, s] of [["l", 1], ["r", -1]] as const) {
    const upper = bone(`upperarm${side}`, chest, 0.2 * s, 0.15);
    const lower = bone(`lowerarm${side}`, upper, 0, -0.25);
    bone(`wrist${side}`, lower, 0, -0.22);
  }
  root.updateMatrixWorld(true);
  return root;
}

test("EmoteBoneLayer: the raised hand points the right forearm up and is undone by restore()", () => {
  const root = kayKitLikeRig();
  const layer = EmoteBoneLayer.tryCreate(root);
  assert.ok(layer);
  const upper = root.getObjectByName("upperarmr")!;
  const rest = upper.quaternion.clone();
  const wristY = (): number => {
    root.updateMatrixWorld(true);
    return root.getObjectByName("wristr")!.getWorldPosition(new THREE.Vector3()).y;
  };
  const restWrist = wristY();
  for (let i = 0; i < 60; i++) {
    layer.restore();
    layer.apply(1 / 30, { seated: false, wave: false, dance: false, cheer: false, hand: true });
  }
  assert.ok(layer.weight("hand") > 0.99);
  assert.ok(wristY() > 1.6, `the wrist is above the head (${wristY().toFixed(2)})`);
  layer.restore();
  assert.ok(upper.quaternion.angleTo(rest) < 1e-6, "restore() puts the mixer's pose back");
  assert.ok(Math.abs(wristY() - restWrist) < 1e-6);
  assert.equal(EmoteBoneLayer.tryCreate(new THREE.Group()), null, "a rig without the KayKit bones gets no layer");
});
