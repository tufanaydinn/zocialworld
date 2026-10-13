import * as THREE from "three";
import { WATCH_HALL_HALF_EXTENTS, WATCH_HALL_ORIGIN, WATCH_HALL_SEAT_COUNT } from "@project/shared";
import type { CollisionSystem } from "../../collision/CollisionSystem.ts";
import type { MinimapData } from "../../ui/minimapTypes.ts";

/**
 * The Watch Hall contract between the hall systems (seats, presence, stage, voice, the performance scene) and the
 * content that builds a hall. Pure data and functions: no scene code, so every system and node:test can import it.
 *
 * Local frame: world = WATCH_HALL_ORIGIN + local. +z points toward the entrance and the stage is at −z, so arriving
 * players face −z. Membership is the shared interior box (WATCH_HALL_HALF_EXTENTS) that the game server uses too, and
 * seat ids are the ids the server arbitrates (0 … WATCH_HALL_SEAT_COUNT − 1), so every hall layout keeps both.
 */

export const HALL_ORIGIN = WATCH_HALL_ORIGIN;

/**
 * Reach of a seat's "Sit down" interactable (metres, around the seat point). Each seat's stand point lies within it,
 * so a player who has just stood up can sit straight back down.
 */
export const SEAT_INTERACTION_RADIUS = 0.9;

/** A seat a player can claim. Coordinates are world space. */
export interface HallSeat {
  /** 0 … WATCH_HALL_SEAT_COUNT − 1, the id the server arbitrates. */
  readonly id: number;
  /** Row, counted from the stage (0 = front row). */
  readonly row: number;
  /** Side of the centre aisle as seen facing the stage ("left" is −x). */
  readonly side: "left" | "right";
  /** Place within its side of the row, counted from the centre aisle outward (0 = next to the aisle). */
  readonly index: number;
  /** World coordinates of the seat point (floor height of the row — the sit pose lowers the hips). */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Facing the screen; same convention as PlayerController (atan2(dx, dz)). */
  readonly yaw: number;
  /** World point behind the seat where a player stands up, within SEAT_INTERACTION_RADIUS of the seat point. */
  readonly standX: number;
  readonly standZ: number;
}

/** A point on the hall floor (hall-local). */
export interface HallPoint {
  readonly x: number;
  readonly z: number;
}

/** A flat panel facing +z: centre and size (hall-local). */
export interface HallPanel {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly width: number;
  readonly height: number;
}

/** A big board standing on the floor, angled toward the audience (hall-local; yaw faces the board's front). */
export interface HallBoardPlacement {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly width: number;
  readonly height: number;
  /** Bottom edge above the floor (≥ 3.2 so seated and standing players never block it). */
  readonly bottom: number;
  /** Where a player stands to use it (the interactable). */
  readonly use: HallPoint;
}

/** Open floor where extra players stand and walk in load and performance scenes (hall-local). */
export interface HallCrowdSpots {
  /** Standing spots, each with the yaw the player faces. */
  readonly standing: readonly (HallPoint & { readonly yaw: number })[];
  /** A straight walkway along x, centred on x = 0, with up to four lanes: the first lane's z, the lane spacing and the length. */
  readonly walkway: { readonly z: number; readonly laneSpacing: number; readonly length: number };
  /** A seat the scene leaves free for the local player. */
  readonly freeSeat: number;
}

/**
 * Everything the hall systems and a hall builder must agree on. The content provider supplies one
 * (`ContentProvider.hallLayout`); the location module that builds the hall reads the same object.
 */
export interface HallLayout {
  /** The seats, ids unique. Their ids, rows, sides and places name them in the people list. */
  readonly seats: readonly HallSeat[];
  /** The stage platform (hall-local rectangle) and its floor height. */
  readonly stage: { readonly x0: number; readonly x1: number; readonly zBack: number; readonly zFront: number; readonly y: number };
  /** The big screen's picture, 16:9. */
  readonly screen: HallPanel;
  /** The speaker-card strip under the screen, and where a player stands to open the card. */
  readonly speakerCard: HallPanel & { readonly use: HallPoint };
  /** The podium on the stage, and where a player stands to use it. */
  readonly podium: { readonly x: number; readonly y: number; readonly z: number; readonly use: HallPoint };
  /** The Live Now and Discussion Corner boards. */
  readonly boards: { readonly liveNow: HallBoardPlacement; readonly discussion: HallBoardPlacement };
  /** Where a player arriving in the hall stands (the hall's travel destination arrives here). */
  readonly arrival: HallPoint;
  /** The exit door's interaction point. */
  readonly exit: HallPoint;
  readonly crowd: HallCrowdSpots;
  /** On the stage platform (world coordinates). */
  isOnStage(x: number, z: number): boolean;
  /** Walkable floor height (world coordinates). */
  heightAt(x: number, z: number): number;
  /** Registers the hall's colliders; the arrival, the exit, the stand points and every use point stay open. */
  registerColliders(collisions: CollisionSystem): void;
  /** The hall's map, titled "Watch Hall". */
  minimap(): MinimapData;
}

/** World coordinates from hall-local ones. */
export function toWorldXZ(x: number, z: number): { x: number; z: number } {
  return { x: HALL_ORIGIN.x + x, z: HALL_ORIGIN.z + z };
}

/** World point from hall-local coordinates. */
export const hallToWorld = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(HALL_ORIGIN.x + x, y, HALL_ORIGIN.z + z);

/** Inside the hall interior (world coordinates), optionally grown by `margin` metres — the server's membership box. */
export function hallContains(x: number, z: number, margin = 0): boolean {
  return Math.abs(x - HALL_ORIGIN.x) <= WATCH_HALL_HALF_EXTENTS.x + margin && Math.abs(z - HALL_ORIGIN.z) <= WATCH_HALL_HALF_EXTENTS.z + margin;
}

/** "Row 2 · left 3": the row from the stage, the side of the centre aisle and the place from the aisle outward. */
export function seatLabel(seat: Pick<HallSeat, "row" | "side" | "index">): string {
  return `Row ${seat.row + 1} · ${seat.side} ${seat.index + 1}`;
}

/** Rows of seats in two blocks either side of a centre aisle at x = 0. */
export interface SeatRowsSpec {
  /** One entry per row, front row first: the seat line (local z), its floor height and the stand line behind it. */
  readonly rows: readonly { readonly z: number; readonly y: number; readonly standZ: number }[];
  readonly seatsPerBlock: number;
  /** |x| of the seat next to the aisle, and the spacing outward (local). */
  readonly firstX: number;
  readonly pitch: number;
  /** The local point every seat faces (the screen centre). */
  readonly facing: HallPoint;
}

/**
 * Seats for `spec`. Ids run row by row, the left block first, each block from the aisle outward:
 * id = (row · 2 + block) · seatsPerBlock + index.
 */
export function seatRows(spec: SeatRowsSpec): HallSeat[] {
  const seats: HallSeat[] = [];
  spec.rows.forEach((row, r) => {
    for (let block = 0; block < 2; block++) {
      const sign = block === 0 ? -1 : 1;
      for (let k = 0; k < spec.seatsPerBlock; k++) {
        const lx = sign * (spec.firstX + spec.pitch * k);
        const world = toWorldXZ(lx, row.z);
        const stand = toWorldXZ(lx, row.standZ);
        seats.push({
          id: (r * 2 + block) * spec.seatsPerBlock + k,
          row: r,
          side: block === 0 ? "left" : "right",
          index: k,
          x: world.x,
          y: row.y,
          z: world.z,
          yaw: Math.atan2(spec.facing.x - lx, spec.facing.z - row.z),
          standX: stand.x,
          standZ: stand.z,
        });
      }
    }
  });
  return seats;
}

/**
 * What is wrong with a layout, as readable lines (empty when it is consistent): seat ids unique and within the server's
 * range, every seat and stand point inside the membership box, each stand point within the seat's reach, seats on their
 * floor, and the arrival, the exit, the use points and the crowd spots inside the hall, with the podium's use point on
 * the stage.
 */
export function hallLayoutProblems(layout: HallLayout): string[] {
  const problems: string[] = [];
  const inside = (what: string, x: number, z: number): void => {
    if (!hallContains(x, z)) problems.push(`${what} (${x.toFixed(2)}, ${z.toFixed(2)}) is outside the hall`);
  };
  const insideLocal = (what: string, point: HallPoint): void => {
    const world = toWorldXZ(point.x, point.z);
    inside(what, world.x, world.z);
  };
  const ids = new Set<number>();
  for (const seat of layout.seats) {
    if (!Number.isInteger(seat.id) || seat.id < 0 || seat.id >= WATCH_HALL_SEAT_COUNT) problems.push(`seat id ${seat.id} is outside 0 … ${WATCH_HALL_SEAT_COUNT - 1}`);
    if (ids.has(seat.id)) problems.push(`seat id ${seat.id} is used twice`);
    ids.add(seat.id);
    inside(`seat ${seat.id}`, seat.x, seat.z);
    inside(`stand point of seat ${seat.id}`, seat.standX, seat.standZ);
    if (Math.hypot(seat.standX - seat.x, seat.standZ - seat.z) > SEAT_INTERACTION_RADIUS) problems.push(`stand point of seat ${seat.id} is out of the seat's reach`);
    if (seat.y !== layout.heightAt(seat.x, seat.z)) problems.push(`seat ${seat.id} is not on its floor`);
  }
  insideLocal("arrival", layout.arrival);
  insideLocal("exit", layout.exit);
  insideLocal("Live Now board spot", layout.boards.liveNow.use);
  insideLocal("Discussion Corner board spot", layout.boards.discussion.use);
  insideLocal("speaker card spot", layout.speakerCard.use);
  insideLocal("podium spot", layout.podium.use);
  const podium = toWorldXZ(layout.podium.use.x, layout.podium.use.z);
  if (!layout.isOnStage(podium.x, podium.z)) problems.push("the podium spot is not on the stage");
  layout.crowd.standing.forEach((spot, i) => insideLocal(`standing spot ${i}`, spot));
  const { walkway } = layout.crowd;
  for (const lane of [0, 3]) {
    for (const end of [-1, 1]) insideLocal(`walkway lane ${lane + 1} end`, { x: (end * walkway.length) / 2, z: walkway.z + lane * walkway.laneSpacing });
  }
  if (!ids.has(layout.crowd.freeSeat)) problems.push(`the free seat ${layout.crowd.freeSeat} is not a seat`);
  return problems;
}
