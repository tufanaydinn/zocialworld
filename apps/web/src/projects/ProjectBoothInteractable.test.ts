import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { ProjectBoothInteractable } from "./ProjectBoothInteractable.ts";
import { PROJECTS } from "./projectData.ts";

// CORE-005 § 31 Test 12: a booth referencing an unknown project fails loudly.
test("Test 12: a booth referencing an unknown projectId throws at construction", () => {
  assert.throws(
    () =>
      new ProjectBoothInteractable({
        projectId: "this-project-does-not-exist",
        position: new THREE.Vector3(0, 0, 0),
        onSelect: () => {},
      }),
    /no project registered/,
  );
});

test("a booth referencing a real project constructs successfully and exposes a name/status label", () => {
  const sample = PROJECTS[0]!;
  const booth = new ProjectBoothInteractable({
    projectId: sample.id,
    position: new THREE.Vector3(1, 0, 2),
    onSelect: () => {},
  });
  assert.equal(booth.projectId, sample.id);
  assert.ok(booth.label.includes(sample.name));
  assert.equal(booth.position.x, 1);
  assert.equal(booth.position.z, 2);
});

test("interacting with a booth calls onSelect with its projectId, nothing else", () => {
  const sample = PROJECTS[0]!;
  const selected: string[] = [];
  const booth = new ProjectBoothInteractable({
    projectId: sample.id,
    position: new THREE.Vector3(),
    onSelect: (projectId) => selected.push(projectId),
  });

  booth.interact();

  assert.deepEqual(selected, [sample.id]);
});

test("a custom interactionRadius overrides the default", () => {
  const sample = PROJECTS[0]!;
  const booth = new ProjectBoothInteractable({
    projectId: sample.id,
    position: new THREE.Vector3(),
    interactionRadius: 5,
    onSelect: () => {},
  });
  assert.equal(booth.interactionRadius, 5);
});
