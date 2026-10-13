import { test } from "node:test";
import assert from "node:assert/strict";
import { ANCHOR, hallAnchors, mergeAnchors, resolveAnchors } from "./anchors.ts";
import { sampleHallLayout } from "../content/sample/hallLayout.ts";
import { hallContains, toWorldXZ } from "../world/hall/hallGeometry.ts";

test("hall anchors lie inside the hall box, on the layout's floor", () => {
  const anchors = hallAnchors(sampleHallLayout);
  for (const name of [ANCHOR.hallArrival, ANCHOR.hallExit, ANCHOR.hallFloor, ANCHOR.hallPodium, ANCHOR.hallSpeakerCard, ANCHOR.hallDiscussion, ANCHOR.hallLiveNow]) {
    const point = anchors[name];
    assert.ok(point, name);
    assert.ok(hallContains(point.x, point.z), `${name} is inside the hall`);
    assert.equal(point.y, sampleHallLayout.heightAt(point.x, point.z), `${name} stands on the floor`);
  }
  // The podium is used from the raised stage; the open floor spot is not on it.
  assert.equal(sampleHallLayout.isOnStage(anchors[ANCHOR.hallFloor]!.x, anchors[ANCHOR.hallFloor]!.z), false);
});

test("hall view targets: the screen's centre and the Discussion Corner board's centre, from the layout", () => {
  const anchors = hallAnchors(sampleHallLayout);
  const screen = toWorldXZ(sampleHallLayout.screen.x, sampleHallLayout.screen.z);
  assert.deepEqual(anchors[ANCHOR.hallScreen], { x: screen.x, y: sampleHallLayout.screen.y, z: screen.z });
  const board = sampleHallLayout.boards.discussion;
  const centre = toWorldXZ(board.x, board.z);
  const target = anchors[ANCHOR.hallDiscussionBoard]!;
  assert.deepEqual({ x: target.x, z: target.z }, centre);
  assert.equal(target.y, sampleHallLayout.heightAt(centre.x, centre.z) + board.bottom + board.height / 2);
  assert.ok(hallContains(target.x, target.z), "the board is inside the hall");
});

test("resolveAnchors takes a missing height from the ground; mergeAnchors refuses a name defined twice", () => {
  const resolved = resolveAnchors({ a: { x: 1, z: 2 }, b: { x: 3, y: 9, z: 4 } }, (x, z) => x + z);
  assert.deepEqual(resolved, { a: { x: 1, y: 3, z: 2 }, b: { x: 3, y: 9, z: 4 } });
  assert.deepEqual(Object.keys(mergeAnchors(resolved, { c: { x: 0, y: 0, z: 0 } })), ["a", "b", "c"]);
  assert.throws(() => mergeAnchors(resolved, { a: { x: 0, y: 0, z: 0 } }), /defined twice/);
});
