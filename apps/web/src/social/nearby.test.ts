import { test } from "node:test";
import assert from "node:assert/strict";
import { getNearbyPlayers, SOCIAL_INTERACTION_RADIUS_METERS } from "./nearby.ts";

// CORE-003 §23 Test 7.

test("a player exactly inside the radius is classified as nearby", () => {
  const local = { x: 0, y: 0, z: 0 };
  const players = [{ playerId: "a", x: 3, y: 0, z: 0 }]; // 3m away, radius 5m
  const nearby = getNearbyPlayers(local, players, 5);
  assert.deepEqual(
    nearby.map((p) => p.playerId),
    ["a"],
  );
});

test("a player outside the radius is excluded", () => {
  const local = { x: 0, y: 0, z: 0 };
  const players = [{ playerId: "a", x: 10, y: 0, z: 0 }]; // 10m away, radius 5m
  const nearby = getNearbyPlayers(local, players, 5);
  assert.deepEqual(nearby, []);
});

test("a player exactly on the radius boundary is included (inclusive comparison)", () => {
  const local = { x: 0, y: 0, z: 0 };
  const players = [{ playerId: "a", x: 5, y: 0, z: 0 }]; // exactly 5m away, radius 5m
  const nearby = getNearbyPlayers(local, players, 5);
  assert.deepEqual(
    nearby.map((p) => p.playerId),
    ["a"],
  );
});

test("distance is measured in full 3D world space, not just on one axis", () => {
  const local = { x: 0, y: 0, z: 0 };
  // 3-4-0 triangle => 5m away in the XZ plane, right at the boundary.
  const atBoundary = { playerId: "boundary", x: 3, y: 0, z: 4 };
  // Same XZ offset, but 1m up — now just over 5m away (sqrt(3^2+4^2+1^2) ≈ 5.1).
  const justOutside = { playerId: "outside", x: 3, y: 1, z: 4 };
  const nearby = getNearbyPlayers(local, [atBoundary, justOutside], 5);
  assert.deepEqual(
    nearby.map((p) => p.playerId),
    ["boundary"],
  );
});

test("classifies multiple players independently, inside and outside mixed", () => {
  const local = { x: 0, y: 0, z: 0 };
  const players = [
    { playerId: "close", x: 1, y: 0, z: 0 },
    { playerId: "far", x: 50, y: 0, z: 0 },
    { playerId: "edge", x: 0, y: 0, z: 4.9 },
  ];
  const nearby = getNearbyPlayers(local, players, 5);
  assert.deepEqual(
    nearby.map((p) => p.playerId).sort(),
    ["close", "edge"],
  );
});

test("defaults to SOCIAL_INTERACTION_RADIUS_METERS when no radius is given", () => {
  const local = { x: 0, y: 0, z: 0 };
  const justInside = { playerId: "in", x: SOCIAL_INTERACTION_RADIUS_METERS - 0.1, y: 0, z: 0 };
  const justOutside = { playerId: "out", x: SOCIAL_INTERACTION_RADIUS_METERS + 0.1, y: 0, z: 0 };
  const nearby = getNearbyPlayers(local, [justInside, justOutside]);
  assert.deepEqual(
    nearby.map((p) => p.playerId),
    ["in"],
  );
});
