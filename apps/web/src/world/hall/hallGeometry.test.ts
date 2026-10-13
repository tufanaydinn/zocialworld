import { test } from "node:test";
import assert from "node:assert/strict";
import { WATCH_HALL_EXIT_MARGIN_METERS, WATCH_HALL_HALF_EXTENTS, WATCH_HALL_ORIGIN } from "@project/shared";
import { HALL_ORIGIN, hallContains, hallLayoutProblems, hallToWorld, seatLabel, seatRows, toWorldXZ, type HallLayout } from "./hallGeometry.ts";

const GRID = seatRows({
  rows: [
    { z: -4, y: 0.4, standZ: -3.2 },
    { z: -2, y: 0.8, standZ: -1.2 },
  ],
  seatsPerBlock: 3,
  firstX: 2,
  pitch: 1.2,
  facing: { x: 0, z: -14 },
});

test("the hall frame sits on the shared origin; local and world coordinates convert both ways", () => {
  assert.deepEqual(HALL_ORIGIN, WATCH_HALL_ORIGIN);
  assert.deepEqual(toWorldXZ(3, -2), { x: WATCH_HALL_ORIGIN.x + 3, z: WATCH_HALL_ORIGIN.z - 2 });
  assert.deepEqual(hallToWorld(3, 1.5, -2).toArray(), [WATCH_HALL_ORIGIN.x + 3, 1.5, WATCH_HALL_ORIGIN.z - 2]);
});

test("membership is the shared interior box, grown by the margin", () => {
  const edge = WATCH_HALL_ORIGIN.x + WATCH_HALL_HALF_EXTENTS.x;
  assert.equal(hallContains(WATCH_HALL_ORIGIN.x, WATCH_HALL_ORIGIN.z), true);
  assert.equal(hallContains(edge, 0), true);
  assert.equal(hallContains(edge + 0.5, 0), false);
  assert.equal(hallContains(edge + 0.5, 0, WATCH_HALL_EXIT_MARGIN_METERS), true);
  assert.equal(hallContains(WATCH_HALL_ORIGIN.x, WATCH_HALL_ORIGIN.z + WATCH_HALL_HALF_EXTENTS.z + 0.1), false);
  assert.equal(hallContains(0, 0, 100), false);
});

test("seat rows: ids row by row, the left block first, each block from the aisle outward", () => {
  assert.deepEqual(
    GRID.map((seat) => [seat.id, seat.row, seat.side, seat.index]),
    [
      [0, 0, "left", 0],
      [1, 0, "left", 1],
      [2, 0, "left", 2],
      [3, 0, "right", 0],
      [4, 0, "right", 1],
      [5, 0, "right", 2],
      [6, 1, "left", 0],
      [7, 1, "left", 1],
      [8, 1, "left", 2],
      [9, 1, "right", 0],
      [10, 1, "right", 1],
      [11, 1, "right", 2],
    ],
  );
  for (const seat of GRID) {
    const lx = seat.x - HALL_ORIGIN.x;
    assert.equal(lx < 0, seat.side === "left", `seat ${seat.id}: left is −x`);
    assert.ok(Math.abs(Math.abs(lx) - (2 + 1.2 * seat.index)) < 1e-9, `seat ${seat.id} x`);
    assert.equal(seat.standX, seat.x, "stand point straight behind the seat");
    assert.ok(seat.standZ > seat.z, "stand point toward the entrance");
    // Facing (atan2(dx, dz)): forward points at the screen.
    const toScreen = Math.atan2(0 - lx, -14 - (seat.z - HALL_ORIGIN.z));
    assert.ok(Math.abs(seat.yaw - toScreen) < 1e-12, `seat ${seat.id} faces the screen`);
  }
  assert.equal(GRID[7]!.y, 0.8, "row floor height");
});

test("seat labels: row from the stage, side of the aisle, place from the aisle outward", () => {
  assert.equal(seatLabel(GRID[0]!), "Row 1 · left 1");
  assert.equal(seatLabel(GRID[2]!), "Row 1 · left 3");
  assert.equal(seatLabel(GRID[3]!), "Row 1 · right 1");
  assert.equal(seatLabel(GRID[10]!), "Row 2 · right 2");
});

test("layout problems: a consistent layout has none; bad ids, positions and spots are named", () => {
  const stage = { x0: -8, x1: 8, zBack: -15, zFront: -10, y: 0 };
  const onStage = (x: number, z: number): boolean => {
    const lx = x - HALL_ORIGIN.x;
    const lz = z - HALL_ORIGIN.z;
    return lx >= stage.x0 && lx <= stage.x1 && lz >= stage.zBack && lz <= stage.zFront;
  };
  const board = { x: -14, z: -11, yaw: 0.6, width: 6, height: 3.6, bottom: 3.2, use: { x: -12, z: -8 } };
  const layout: HallLayout = {
    seats: GRID.map((seat) => ({ ...seat, y: 0 })),
    stage,
    screen: { x: 0, y: 4, z: -14.5, width: 9.6, height: 5.4 },
    speakerCard: { x: 0, y: 1, z: -14.4, width: 6, height: 0.8, use: { x: 0, z: -9 } },
    podium: { x: -5, y: 0, z: -12, use: { x: -5, z: -11 } },
    boards: { liveNow: board, discussion: { ...board, x: 14, yaw: -0.6, use: { x: 12, z: -8 } } },
    arrival: { x: 0, z: 11 },
    exit: { x: 0, z: 14 },
    crowd: { standing: [{ x: 0, z: -8, yaw: Math.PI }], walkway: { z: 5, laneSpacing: 0.9, length: 14 }, freeSeat: 11 },
    isOnStage: onStage,
    heightAt: () => 0,
    registerColliders: () => {},
    minimap: () => ({ title: "Watch Hall", bounds: { minX: 0, maxX: 1, minZ: 0, maxZ: 1 }, areas: [], circles: [], buildings: [], markers: [], regions: [] }),
  };
  assert.deepEqual(hallLayoutProblems(layout), []);

  const broken: HallLayout = {
    ...layout,
    seats: [...layout.seats, { ...layout.seats[0]!, id: 0 }, { ...layout.seats[1]!, id: 60, x: HALL_ORIGIN.x + 30 }, { ...layout.seats[2]!, id: 40, standZ: layout.seats[2]!.z + 1.5 }],
    podium: { ...layout.podium, use: { x: 0, z: 0 } },
    arrival: { x: 0, z: 40 },
    crowd: { ...layout.crowd, freeSeat: 59 },
  };
  const problems = hallLayoutProblems(broken);
  assert.ok(problems.includes("seat id 0 is used twice"), problems.join("\n"));
  assert.ok(problems.some((line) => line.startsWith("seat id 60 is outside")));
  assert.ok(problems.some((line) => line.startsWith("seat 60 (")));
  assert.ok(problems.includes("the podium spot is not on the stage"));
  assert.ok(problems.some((line) => line.startsWith("arrival (")));
  assert.ok(problems.includes("the free seat 59 is not a seat"));
  assert.ok(problems.includes("stand point of seat 40 is out of the seat's reach"));
});
