import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import type { HallClientMessage, HallStateMessage } from "@project/shared";
import type { Interactable } from "../interaction/Interactable.ts";
import type { SeatPose, StandListener, StandReason } from "../player/PlayerController.ts";
import { seatRows } from "../world/hall/hallGeometry.ts";
import { HallStore } from "./HallStore.ts";
import { SEATED_CAMERA_DISTANCE, SEATED_CAMERA_PITCH, SEAT_INTERACTION_PRIORITY, SEAT_INTERACTION_RADIUS, SeatSystem, type SeatController } from "./SeatSystem.ts";

// The client seat system against a real HallStore (docs/architecture/WATCH_HALL.md, ADR-014 § 9).

const IDLE_STAGE = { holder: null, status: "idle" as const, since: 0, queue: [], card: null, locked: false, audio: false };
/** Four seats in one row, two either side of the aisle (ids 0–3). */
const SEATS = seatRows({ rows: [{ z: -2, y: 0.4, standZ: -1.2 }], seatsPerBlock: 2, firstX: 1.6, pitch: 1.2, facing: { x: 0, z: -14 } });

function hallState(seats: [number, string][] = []): HallStateMessage {
  return { type: "hall_state", stage: IDLE_STAGE, seats, hands: [], floor: null, hosts: [], host: false, totals: {}, session: { id: 0, active: false }, vote: { votes: 0, needed: 0, voted: false } };
}

class FakeController implements SeatController {
  seat: SeatPose | null = null;
  readonly calls: string[] = [];
  private readonly listeners = new Set<StandListener>();
  private readonly position: THREE.Vector3;
  constructor(position: THREE.Vector3) {
    this.position = position;
  }
  setSeat(seat: SeatPose | null): void {
    this.seat = seat;
    this.calls.push(seat ? `setSeat ${seat.id}` : "setSeat null");
    if (seat) this.position.set(seat.x, this.position.y, seat.z);
  }
  standUp(): void {
    const seat = this.seat;
    this.seat = null;
    this.calls.push("standUp");
    if (seat) this.position.set(seat.standX, this.position.y, seat.standZ);
  }
  onStand(listener: StandListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** The player pressed a movement key (PlayerController stands up, then notifies). */
  walkAway(reason: StandReason = "input"): void {
    const seat = this.seat!;
    this.standUp();
    for (const listener of this.listeners) listener(seat, reason);
  }
}

function setup() {
  const hall = new HallStore();
  hall.setLocalPlayerId("me");
  const seat = SEATS[2]!;
  const position = new THREE.Vector3(seat.standX, seat.y, seat.standZ);
  const controller = new FakeController(position);
  const sent: HallClientMessage[] = [];
  const registered = new Map<string, Interactable>();
  const announced: string[] = [];
  const snaps: [number, number | undefined, number | undefined][] = [];
  const camera = {
    followDistance: 5,
    snapTo(yaw: number, pitch?: number, distance?: number) {
      snaps.push([yaw, pitch, distance]);
      if (distance !== undefined) this.followDistance = distance;
    },
    setDistance(distance: number) {
      this.followDistance = distance;
    },
  };
  const system = new SeatSystem({
    seats: SEATS,
    hall,
    controller,
    playerPosition: position,
    send: (message) => sent.push(message),
    register: (interactable) => registered.set(interactable.id, interactable),
    unregister: (id) => registered.delete(id),
    camera,
    announce: (text) => announced.push(text),
  });
  return { hall, seat, position, controller, sent, registered, announced, snaps, camera, system };
}

test("seat interactables exist only for hall members, one per free seat: radius 0.9, priority 2, 'Sit down' at the row floor", () => {
  const { hall, registered, system } = setup();
  assert.equal(registered.size, 0, "not a member yet");
  hall.apply(hallState([[3, "p2"]]));
  assert.equal(registered.size, 3);
  assert.equal(registered.has("wh-seat-3"), false, "taken");
  const seat = registered.get("wh-seat-2")!;
  assert.equal(seat.label, "Sit down");
  assert.equal(seat.interactionRadius, SEAT_INTERACTION_RADIUS);
  assert.equal(seat.priority, SEAT_INTERACTION_PRIORITY);
  assert.deepEqual(seat.position.toArray(), [SEATS[2]!.x, SEATS[2]!.y, SEATS[2]!.z]);
  hall.apply({ type: "hall_seat", seatId: 3, playerId: null });
  assert.equal(registered.size, 4);
  hall.apply({ type: "hall_exit" });
  assert.equal(registered.size, 0, "left the hall");
  assert.deepEqual(system.availableSeats, []);
});

test("E claims; the server's hall_seat seats the player, snaps the camera and disables every seat interactable", () => {
  const { hall, seat, controller, sent, registered, snaps, system } = setup();
  hall.apply(hallState());
  registered.get("wh-seat-2")!.interact();
  assert.deepEqual(sent, [{ type: "hall_seat_claim", seatId: 2 }]);
  assert.deepEqual(controller.calls, [], "nothing happens before the server confirms");
  hall.apply({ type: "hall_seat", seatId: 2, playerId: "me" });
  assert.equal(controller.seat?.id, 2);
  assert.equal(system.seatedOn, 2);
  assert.deepEqual(snaps, [[seat.yaw + Math.PI, SEATED_CAMERA_PITCH, SEATED_CAMERA_DISTANCE]], "behind the player, facing the screen, over the shoulder");
  assert.equal(registered.size, 0, "while seated, E falls through to the nearest player's card");
  // Unrelated hall changes never re-seat or stand the player.
  hall.apply({ type: "hall_hands", hands: ["p9"] });
  hall.apply({ type: "hall_seat", seatId: 1, playerId: "p9" });
  assert.deepEqual(controller.calls, ["setSeat 2"]);
});

test("WASD stands up: release once, ignore the stale 'still yours' until the server frees it, then the seat is offered again", () => {
  const { hall, controller, sent, registered, camera, system } = setup();
  hall.apply(hallState());
  hall.apply({ type: "hall_seat", seatId: 2, playerId: "me" });
  assert.equal(camera.followDistance, SEATED_CAMERA_DISTANCE);
  sent.length = 0;
  controller.walkAway();
  assert.deepEqual(sent, [{ type: "hall_seat_release" }]);
  assert.equal(system.seatedOn, null);
  assert.equal(camera.followDistance, 5, "the zoom from before sitting is back");
  assert.equal(registered.has("wh-seat-2"), false, "still ours on the server");
  assert.equal(registered.size, 3);
  hall.apply({ type: "hall_hands", hands: [] }); // any change while the release is in flight
  assert.equal(controller.seat, null, "not re-seated");
  hall.apply({ type: "hall_seat", seatId: 2, playerId: null });
  assert.equal(registered.has("wh-seat-2"), true);
  assert.deepEqual(sent, [{ type: "hall_seat_release" }]);
});

test("a teleport away releases the seat; leaving the hall or disconnecting stands the player up at the stand point", () => {
  const { hall, seat, position, controller, sent } = setup();
  hall.apply(hallState());
  hall.apply({ type: "hall_seat", seatId: 2, playerId: "me" });
  controller.walkAway("moved");
  assert.deepEqual(sent.at(-1), { type: "hall_seat_release" });

  hall.apply({ type: "hall_seat", seatId: 2, playerId: null });
  hall.apply({ type: "hall_seat", seatId: 2, playerId: "me" });
  assert.equal(controller.seat?.id, 2);
  hall.reset(); // disconnect (hallStoreFeed) or hall_exit
  assert.equal(controller.seat, null);
  assert.equal(controller.calls.at(-1), "standUp");
  assert.equal(position.x, seat.standX);
  assert.equal(position.z, seat.standZ);
});

test("a confirmation that finds the player already walked off gives the seat back instead of teleporting", () => {
  const { hall, position, controller, sent } = setup();
  hall.apply(hallState());
  position.set(position.x + 6, position.y, position.z);
  hall.apply({ type: "hall_seat", seatId: 2, playerId: "me" });
  assert.equal(controller.seat, null);
  assert.deepEqual(sent, [{ type: "hall_seat_release" }]);
});

test("hall_error {seat, taken} becomes a chat line; other ops are not the seat system's", () => {
  const { hall, announced } = setup();
  hall.apply(hallState());
  hall.apply({ type: "hall_error", op: "seat", reason: "taken" });
  hall.apply({ type: "hall_error", op: "stage", reason: "taken" });
  assert.deepEqual(announced, ["That seat was just taken — pick another one."]);
});
