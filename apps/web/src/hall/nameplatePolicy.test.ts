import { test } from "node:test";
import assert from "node:assert/strict";
import { HALL_PLATE_RANGE_METERS, HALL_SEATED_VIEW_PLATE_RANGE_METERS, hallBadge, hallPlateVisible, type HallPlateFacts } from "./nameplatePolicy.ts";

// Seated players' plates beyond 8 m are hidden unless the room should notice them (docs/architecture/WATCH_HALL.md).

const BASE: HallPlateFacts = { inHall: true, seated: true, distance: 12, speaking: false, handRaised: false, holder: false, floor: false };

test("a seated player beyond 8 m is hidden; within 8 m, standing, or outside the hall always shown", () => {
  assert.equal(hallPlateVisible(BASE), false);
  assert.equal(hallPlateVisible({ ...BASE, distance: HALL_PLATE_RANGE_METERS }), true);
  assert.equal(hallPlateVisible({ ...BASE, seated: false }), true);
  assert.equal(hallPlateVisible({ ...BASE, inHall: false }), true);
});

test("while you are seated, seated plates beyond 4 m are hidden (the crowd under the screen); attention still wins", () => {
  const seatedView = { ...BASE, localSeated: true, distance: 6 };
  assert.equal(hallPlateVisible(seatedView), false);
  assert.equal(hallPlateVisible({ ...seatedView, distance: HALL_SEATED_VIEW_PLATE_RANGE_METERS }), true);
  assert.equal(hallPlateVisible({ ...seatedView, localSeated: false }), true, "standing: the 8 m range");
  assert.equal(hallPlateVisible({ ...seatedView, handRaised: true }), true);
  assert.equal(hallPlateVisible({ ...seatedView, seated: false }), true, "a standing player is always labelled");
});

test("speaking, a raised hand, the stage holder and the floor keep a far seated plate visible", () => {
  for (const key of ["speaking", "handRaised", "holder", "floor"] as const) assert.equal(hallPlateVisible({ ...BASE, [key]: true }), true, key);
});

test("badges: 🎤 holder, 🎙 floor, ✋ raised hand", () => {
  assert.equal(hallBadge({ holder: false, floor: false, handRaised: false }), "");
  assert.equal(hallBadge({ holder: true, floor: false, handRaised: false }), "🎤");
  assert.equal(hallBadge({ holder: false, floor: true, handRaised: false }), "🎙");
  assert.equal(hallBadge({ holder: false, floor: false, handRaised: true }), "✋");
});
