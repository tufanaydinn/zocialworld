import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { compactFaceGroups, faceToward, texturedBox } from "./geometry.ts";

test("faceToward turns a model's local +Z toward the target", () => {
  const yaw = faceToward(-20, -5, 0, 8);
  const front = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const toTarget = new THREE.Vector3(20, 0, 13).normalize();
  assert.ok(front.dot(toTarget) > 0.999);
});

test("texturedBox scales each face's UVs to its world size over the tile length", () => {
  const box = texturedBox(4, 2, 1, 0.5);
  const uv = box.getAttribute("uv") as THREE.BufferAttribute;
  const span = (face: number): [number, number] => {
    const us = [0, 1, 2, 3].map((i) => uv.getX(face * 4 + i));
    const vs = [0, 1, 2, 3].map((i) => uv.getY(face * 4 + i));
    return [Math.max(...us) - Math.min(...us), Math.max(...vs) - Math.min(...vs)];
  };
  // +x: depth x height; +y: width x depth; +z: width x height — each divided by the 0.5 m tile.
  assert.deepEqual(span(0), [2, 4]);
  assert.deepEqual(span(2), [8, 2]);
  assert.deepEqual(span(4), [8, 4]);
});

test("compactFaceGroups emits one draw group per distinct material and keeps every triangle", () => {
  const box = new THREE.BoxGeometry(1, 1, 1);
  const before = box.getIndex()!.count;
  compactFaceGroups(box, [0, 0, 1, 0, 0, 0]);
  assert.equal(box.groups.length, 2);
  assert.deepEqual(
    box.groups.map((group) => group.materialIndex),
    [0, 1],
  );
  assert.equal(box.getIndex()!.count, before);
  assert.equal(box.groups.reduce((sum, group) => sum + group.count, 0), before);
});
