import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { PlaceholderCrowd } from "./PlaceholderCrowd.ts";
import { createPlaceholderCharacter, setPlaceholderLift, type ProceduralRig } from "./PlaceholderCharacter.ts";

// Every remote placeholder drawn as six instanced meshes, with exactly the rig's own matrices,
// accent colours and hall lift.

function rigAt(x: number, accent: number): ProceduralRig {
  const rig = createPlaceholderCharacter({ accentColor: accent });
  rig.root.position.set(x, 0, -4);
  rig.leftArm.rotation.x = 0.7; // a pose, so the parts don't share a matrix
  rig.root.updateMatrixWorld(true);
  return rig;
}

test("six instanced draws carry every visible player's parts; the rigs' own meshes are hidden", () => {
  const crowd = new PlaceholderCrowd(2);
  const rigs = [rigAt(0, 0xff0000), rigAt(2, 0x00ff00), rigAt(4, 0x0000ff)];
  const visible = [true, false, true];
  rigs.forEach((rig, index) => crowd.add({ rig, visible: () => visible[index]! }));
  assert.equal(crowd.size, 3, "grew past the initial capacity");
  assert.equal(crowd.object.children.length, 6);
  assert.ok(rigs.every((rig) => rig.parts.every(({ mesh }) => !mesh.visible)));
  crowd.sync();
  assert.equal(crowd.instanceCount("torso"), 2);
  assert.equal(crowd.instanceCount("arm"), 4);
  assert.equal(crowd.instanceCount("leg"), 4);

  // Instance 1 of each part is the third rig (the second is culled), in the rig's part order.
  const matrix = new THREE.Matrix4();
  crowd.meshFor("arm")!.getMatrixAt(2, matrix);
  const expected = rigs[2]!.parts[4]!.mesh.matrixWorld.elements;
  assert.ok(matrix.elements.every((value, index) => Math.abs(value - expected[index]!) < 1e-6), "left arm of the third rig (float32 instance buffer)");
  const color = new THREE.Color();
  crowd.meshFor("hat")!.getColorAt(1, color);
  assert.equal(color.getHex(), 0x0000ff, "accent colour per instance");
  assert.equal(crowd.meshFor("belt")!.castShadow, false);
  assert.equal(crowd.meshFor("torso")!.castShadow, true, "the same shadow casting as the rig's meshes");
});

test("the hall lift and an accent change follow the rigs' own materials", () => {
  const crowd = new PlaceholderCrowd(4);
  const rig = rigAt(0, 0xc98a3c);
  crowd.add({ rig, visible: () => true });
  setPlaceholderLift(rig.root, 0.35);
  crowd.sync();
  assert.equal((crowd.meshFor("torso")!.material as THREE.MeshStandardMaterial).emissiveIntensity, 0.35);
  assert.equal((crowd.meshFor("hat")!.material as THREE.MeshStandardMaterial).emissiveIntensity, 0.35);
  (rig.parts[3]!.mesh.material as THREE.MeshStandardMaterial).color.setHex(0x123456);
  crowd.sync();
  const color = new THREE.Color();
  crowd.meshFor("hat")!.getColorAt(0, color);
  assert.equal(color.getHex(), 0x123456);
});

test("removing a player hands its meshes back and empties its instances", () => {
  const crowd = new PlaceholderCrowd(4);
  const rig = rigAt(0, 0xffffff);
  const entry = { rig, visible: () => true };
  crowd.add(entry);
  crowd.remove(entry);
  assert.ok(rig.parts.every(({ mesh }) => mesh.visible));
  crowd.sync();
  assert.equal(crowd.instanceCount("torso"), 0);
  assert.equal(crowd.meshFor("torso")!.visible, true, "an empty part stays visible (three skips zero-instance draws; the warm-up compiles it)");
  assert.ok(crowd.meshFor("hat")!.instanceColor, "accent parts carry instance colours from the start");
});

test("the accent material rebuilds the placeholder's emissive (colour warmed by the lift tint) from the instance colour", () => {
  const crowd = new PlaceholderCrowd(1);
  const material = crowd.meshFor("hat")!.material as THREE.MeshStandardMaterial;
  assert.equal(material.color.getHex(), 0xffffff);
  assert.equal(material.emissive.getHex(), 0xffffff);
  const shader = { fragmentShader: "void main() {\n\tvec3 totalEmissiveRadiance = emissive;\n}" } as unknown as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
  assert.match(shader.fragmentShader, /#ifdef USE_COLOR\n\ttotalEmissiveRadiance \*= mix\( vColor\.rgb, vec3\( [\d.]+, [\d.]+, [\d.]+ \), 0\.15 \);\n#endif/);
});
