import * as THREE from "three";
import type { HallClientMessage } from "@project/shared";
import type { Interactable } from "../interaction/Interactable.ts";
import type { SeatPose, StandListener, StandReason } from "../player/PlayerController.ts";
import { SEAT_INTERACTION_RADIUS, type HallSeat } from "../world/hall/hallGeometry.ts";
import type { HallStore, HallStoreEvent } from "./HallStore.ts";

/**
 * The Watch Hall seats on the client (WATCH_HALL.md; ADR-014 § 9).
 *
 *  - Registers one `wh-seat-<id>` interactable per seat (radius 0.9, priority 2 — above the hall
 *    boards' 1 and the players' 0, so a neighbour's card never captures E), at the seat point on
 *    the row floor, labelled "Sit down". A seat's interactable exists only while you are a hall
 *    member, the seat is free in HallStore and you are not seated — so while seated, E opens the
 *    nearest player's card instead.
 *  - E sends `hall_seat_claim`; the server arbitrates. When HallStore gives you the seat, the
 *    player controller pins you to it (`sit`) and the camera snaps behind you, facing the screen.
 *  - A movement or jog key stands you up at the seat's stand point and sends `hall_seat_release`
 *    (the server also frees it on a walk transform). Leaving the hall or disconnecting clears the
 *    seat (HallStore drops it; you stand at the stand point).
 *  - `hall_error {seat, taken}` → a chat line.
 *
 * Nothing is logged; the seat lives in HallStore (memory) only.
 */

export { SEAT_INTERACTION_RADIUS };
export const SEAT_INTERACTION_PRIORITY = 2;
/**
 * The seated camera. Looking 10° down at a pivot at standing head height would cut the top of the
 * big screen off in the front rows and put the screen behind the heads in front. Instead, while seated, App passes SEATED_TARGET_HEIGHT as the camera's existing
 * target height (the pivot rises to about 2.1 m above the row floor, over every seated head) and
 * the camera looks slightly UP. The camera model is unchanged (ThirdPersonCamera: same orbit,
 * smoothing and collision); these are only its pitch/distance (snapTo) and target-height inputs.
 * Hall layouts place their seats and screen so that, with these values, the whole screen stays in frame from every seat.
 */
/** Camera pitch (degrees; negative looks up) after sitting down. */
export const SEATED_CAMERA_PITCH = -8;
/** Seated follow distance: behind and above the head of the player in the row behind (it stays below the view). */
export const SEATED_CAMERA_DISTANCE = 3.2;
/** Camera target height while seated (the pivot is 0.9 × this ≈ 2.5 m above the row floor). */
export const SEATED_TARGET_HEIGHT = 2.8;

/** What SeatSystem needs from ThirdPersonCamera. */
export interface SeatCamera {
  snapTo(yaw: number, pitchDegrees?: number, distance?: number): void;
  readonly followDistance: number;
  setDistance(distance: number): void;
}
/** If the server's confirmation finds you further than this from the seat (you walked off), the seat is released instead. */
const CLAIM_REACH_METERS = 2.5;

/** What SeatSystem needs from the player controller. */
export interface SeatController {
  readonly seat: SeatPose | null;
  setSeat(seat: SeatPose | null): void;
  standUp(): void;
  onStand(listener: StandListener): () => void;
}

export interface SeatSystemOptions {
  readonly seats: readonly HallSeat[];
  readonly hall: HallStore;
  readonly controller: SeatController;
  /** The local player's position (live vector). */
  readonly playerPosition: THREE.Vector3;
  /** NetworkClient.sendHall. */
  readonly send: (message: HallClientMessage) => void;
  readonly register: (interactable: Interactable) => void;
  readonly unregister: (id: string) => void;
  /** The third-person camera: snapped behind a seated player, its zoom restored on standing. */
  readonly camera: SeatCamera;
  /** A system line in chat. */
  readonly announce: (text: string) => void;
  /** The local player sat down on `seatId`, or stood up (null) — App shows the seated key hints. */
  readonly onSeatedChange?: (seatId: number | null) => void;
}

export function seatInteractableId(seatId: number): string {
  return `wh-seat-${seatId}`;
}

export class SeatSystem {
  private readonly options: SeatSystemOptions;
  private readonly interactables = new Map<number, Interactable>();
  private readonly registered = new Set<number>();
  private readonly unsubscribeHall: () => void;
  private readonly unsubscribeStand: () => void;
  /** The seat this system pinned the player to (null when standing). */
  private applied: number | null = null;
  /** A seat we released whose server confirmation has not arrived yet (HallStore still says it is ours). */
  private released: number | null = null;
  /** The camera zoom from before sitting down, restored on standing up. */
  private standingZoom: number | null = null;

  constructor(options: SeatSystemOptions) {
    this.options = options;
    for (const seat of options.seats) {
      this.interactables.set(seat.id, {
        id: seatInteractableId(seat.id),
        label: "Sit down",
        position: new THREE.Vector3(seat.x, seat.y, seat.z),
        interactionRadius: SEAT_INTERACTION_RADIUS,
        priority: SEAT_INTERACTION_PRIORITY,
        interact: () => this.claim(seat.id),
      });
    }
    this.unsubscribeHall = options.hall.subscribe((event) => this.onHallEvent(event));
    this.unsubscribeStand = options.controller.onStand((seat, reason) => this.onStand(seat, reason));
    this.sync();
  }

  /** The seat the player is sitting on (as applied locally), or null. */
  get seatedOn(): number | null {
    return this.applied;
  }

  /** Seat ids whose "Sit down" interactable is currently registered (tests, debugging). */
  get availableSeats(): readonly number[] {
    return [...this.registered].sort((a, b) => a - b);
  }

  /** Asks the server for a seat (E on a seat; also the e2e hook). */
  claim(seatId: number): void {
    this.options.send({ type: "hall_seat_claim", seatId });
  }

  dispose(): void {
    this.unsubscribeHall();
    this.unsubscribeStand();
    for (const id of this.registered) this.options.unregister(seatInteractableId(id));
    this.registered.clear();
  }

  private onHallEvent(event: HallStoreEvent): void {
    if (event.type === "change") {
      if (event.parts.includes("seats") || event.parts.includes("member")) this.sync();
      return;
    }
    if (event.type === "error" && event.op === "seat") {
      if (event.reason === "taken") this.options.announce("That seat was just taken — pick another one.");
      else if (event.reason === "not_in_hall") this.options.announce("Seats work inside the Watch Hall.");
    }
  }

  /** The player stood up by moving (or was teleported away): release the seat on the server. */
  private onStand(seat: SeatPose, _reason: StandReason): void {
    if (this.applied !== seat.id) return;
    this.setApplied(null);
    this.released = seat.id;
    this.options.send({ type: "hall_seat_release" });
    this.restoreZoom();
    this.refreshInteractables();
  }

  private restoreZoom(): void {
    if (this.standingZoom === null) return;
    this.options.camera.setDistance(this.standingZoom);
    this.standingZoom = null;
  }

  /** Applies HallStore's view of our seat to the controller and refreshes the "Sit down" interactables. */
  private sync(): void {
    const hall = this.options.hall;
    const mine = hall.member ? hall.mySeat : null;
    if (this.released !== null && mine !== this.released) this.released = null;

    if (mine === null || mine === this.released) {
      if (this.applied !== null) {
        // The server freed our seat (we left the hall, disconnected or walked): stand at the stand point.
        this.setApplied(null);
        if (this.options.controller.seat) this.options.controller.standUp();
        this.restoreZoom();
      }
    } else if (mine !== this.applied) {
      const seat = this.options.seats.find((candidate) => candidate.id === mine);
      const position = this.options.playerPosition;
      if (!seat || Math.hypot(position.x - seat.x, position.z - seat.z) > CLAIM_REACH_METERS) {
        // We walked away before the confirmation arrived (or an unknown seat): give it back.
        this.released = mine;
        this.options.send({ type: "hall_seat_release" });
      } else {
        this.setApplied(mine);
        this.options.controller.setSeat(seat);
        this.standingZoom ??= this.options.camera.followDistance;
        this.options.camera.snapTo(seat.yaw + Math.PI, SEATED_CAMERA_PITCH, SEATED_CAMERA_DISTANCE);
      }
    }
    this.refreshInteractables();
  }

  private setApplied(seatId: number | null): void {
    if (this.applied === seatId) return;
    this.applied = seatId;
    this.options.onSeatedChange?.(seatId);
  }

  private refreshInteractables(): void {
    const hall = this.options.hall;
    const open = hall.member && this.applied === null && this.options.controller.seat === null;
    for (const [id, interactable] of this.interactables) {
      const want = open && hall.isSeatFree(id);
      if (want === this.registered.has(id)) continue;
      if (want) {
        this.options.register(interactable);
        this.registered.add(id);
      } else {
        this.options.unregister(interactable.id);
        this.registered.delete(id);
      }
    }
  }
}
