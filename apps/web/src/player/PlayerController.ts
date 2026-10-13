import * as THREE from "three";
import type { InputManager } from "../input/InputManager.ts";
import type { CollisionSystem } from "../collision/CollisionSystem.ts";
import type { LocalPlayer } from "./LocalPlayer.ts";

const WALK_SPEED = 3.5; // m/s
const JOG_SPEED = 6.0; // m/s
const ROTATION_SMOOTHING = 12; // higher = snappier turning
const ACCELERATION_SMOOTHING = 10; // higher = snappier speed changes
const GROUND_FOLLOW_SMOOTHING = 18; // higher = tighter tracking of stair/terrace height

/** Emote-wheel emotes (ADR-014 § 10). Dance loops until you move or stop; wave and cheer end by themselves. */
export type Emote = "wave" | "cheer" | "dance";
const EMOTE_SECONDS: Readonly<Record<Emote, number>> = { wave: 2.6, cheer: 3.2, dance: Infinity };

/**
 * A seat the player can be pinned to (`HallSeat`): world position at the row
 * floor, the facing yaw (atan2(dx, dz), like the player's own rotation) and the point in the lane
 * where the player stands up.
 */
export interface SeatPose {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly standX: number;
  readonly standZ: number;
}

/** Why the player left a seat: a movement key, or an external move (portal, door, debug teleport). */
export type StandReason = "input" | "moved";
export type StandListener = (seat: SeatPose, reason: StandReason) => void;

/** An external move further than this from the seat (a teleport) drops the seat without walking back. */
const SEAT_TELEPORT_METERS = 1.5;

/**
 * Turns InputManager state into LocalPlayer movement.
 *
 * Movement is camera-relative (pressing "forward" moves away from the
 * camera, not along world -Z), so this needs to know the camera's
 * current yaw. It takes that as a plain `() => number` getter rather
 * than a reference to ThirdPersonCamera itself, so the two systems
 * don't depend on each other's full interface — only this one number.
 *
 * While seated (`setSeat`) movement is skipped, x/z/yaw are
 * pinned to the seat, the ground follow keeps going and the animation is
 * `sit` (or an emote over it). A movement or jog key stands the player up at
 * the seat's stand point and tells the `onStand` listeners. Moving also ends
 * any emote (`playEmote`).
 */
export class PlayerController {
  private readonly input: Pick<InputManager, "isPressed" | "wasJustPressed">;
  private readonly collisions: CollisionSystem;
  private readonly player: LocalPlayer;
  private readonly getCameraYaw: () => number;

  private readonly groundHeightAt: (x: number, z: number) => number;

  private currentSpeed = 0;
  private seatPose: SeatPose | null = null;
  private emoteState: Emote | null = null;
  private emoteTimeLeft = 0;
  private readonly standListeners = new Set<StandListener>();

  /**
   * @param groundHeightAt walkable ground height at (x, z) — the world's
   * terraces and stairs. Collision stays 2.5D on the XZ plane; this only
   * sets the player's Y so stairs can be climbed. Defaults to flat ground.
   */
  constructor(
    input: Pick<InputManager, "isPressed" | "wasJustPressed">,
    collisions: CollisionSystem,
    player: LocalPlayer,
    getCameraYaw: () => number,
    groundHeightAt: (x: number, z: number) => number = () => 0,
  ) {
    this.input = input;
    this.collisions = collisions;
    this.player = player;
    this.getCameraYaw = getCameraYaw;
    this.groundHeightAt = groundHeightAt;
  }

  /** The seat the player is pinned to, or null. */
  get seat(): SeatPose | null {
    return this.seatPose;
  }

  /** The running emote, or null. */
  get emote(): Emote | null {
    return this.emoteState;
  }

  /**
   * Pins the player to `seat` (snapping onto it and facing its yaw), or with null just unpins
   * without moving. Never notifies `onStand` — only the player's own movement or a teleport does.
   */
  setSeat(seat: SeatPose | null): void {
    this.seatPose = seat;
    this.player.animation.setSeated(seat !== null);
    if (!seat) return;
    this.currentSpeed = 0;
    this.player.position.x = seat.x;
    this.player.position.z = seat.z;
    this.player.object.rotation.y = seat.yaw;
    if (this.emoteState === "dance" || this.emoteState === "cheer" || this.emoteState === "wave") this.player.animation.setState(this.emoteState);
    else this.player.animation.setState("sit");
  }

  /** Unpins and steps to the seat's stand point (in the lane). No-op when not seated. Never notifies `onStand`. */
  standUp(): void {
    const seat = this.seatPose;
    if (!seat) return;
    this.setSeat(null);
    this.player.position.x = seat.standX;
    this.player.position.z = seat.standZ;
    this.player.animation.setState("idle");
  }

  /** Fired when the player leaves the seat by itself (movement key or teleport) — the seat system releases it. */
  onStand(listener: StandListener): () => void {
    this.standListeners.add(listener);
    return () => this.standListeners.delete(listener);
  }

  /** Starts an emote (replacing any running one), or stops it with null. Seated emotes keep the seat. */
  playEmote(emote: Emote | null): void {
    this.emoteState = emote;
    this.emoteTimeLeft = emote ? EMOTE_SECONDS[emote] : 0;
  }

  update(deltaSeconds: number): void {
    const moveX = (this.input.isPressed("moveRight") ? 1 : 0) - (this.input.isPressed("moveLeft") ? 1 : 0);
    const moveZ = (this.input.isPressed("moveBackward") ? 1 : 0) - (this.input.isPressed("moveForward") ? 1 : 0);

    const hasInput = moveX !== 0 || moveZ !== 0;
    const jogRequested = this.input.isPressed("jog");

    if (this.emoteState) {
      this.emoteTimeLeft -= deltaSeconds;
      if (hasInput || this.emoteTimeLeft <= 0) this.playEmote(null);
    }

    if (this.seatPose && !this.updateSeated(deltaSeconds, hasInput || this.input.wasJustPressed("jog"))) return;

    const targetSpeed = hasInput ? (jogRequested ? JOG_SPEED : WALK_SPEED) : 0;

    const speedLerpFactor = 1 - Math.exp(-ACCELERATION_SMOOTHING * deltaSeconds);
    this.currentSpeed = THREE.MathUtils.lerp(this.currentSpeed, targetSpeed, speedLerpFactor);

    if (hasInput) {
      const yaw = this.getCameraYaw();
      const inputVector = new THREE.Vector3(moveX, 0, moveZ).normalize();
      const worldDirection = inputVector.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);

      if (this.currentSpeed > 0.01) {
        const desired = this.player.position.clone().addScaledVector(worldDirection, this.currentSpeed * deltaSeconds);
        const resolved = this.collisions.resolve(desired, this.player.radius);
        this.player.position.x = resolved.x;
        this.player.position.z = resolved.z;
      }

      const targetAngle = Math.atan2(worldDirection.x, worldDirection.z);
      const rotationLerpFactor = 1 - Math.exp(-ROTATION_SMOOTHING * deltaSeconds);
      this.player.object.rotation.y = shortestAngleLerp(
        this.player.object.rotation.y,
        targetAngle,
        rotationLerpFactor,
      );
    }

    this.followGround(deltaSeconds);

    const normalizedSpeed = this.currentSpeed / JOG_SPEED;
    this.player.animation.setState(
      this.currentSpeed < 0.05 ? this.emoteState ?? "idle" : jogRequested && hasInput ? "jog" : "walk",
    );
    this.player.animation.update(deltaSeconds, normalizedSpeed);
  }

  /**
   * One seated frame. Returns true when the player just stood up (the caller then runs the normal
   * movement step this same frame), false when still seated (the frame is done).
   */
  private updateSeated(deltaSeconds: number, standRequested: boolean): boolean {
    const seat = this.seatPose!;
    const position = this.player.position;
    if (Math.hypot(position.x - seat.x, position.z - seat.z) > SEAT_TELEPORT_METERS) {
      // Something else moved the player (a portal, a door, a debug hook): drop the seat where we are.
      this.setSeat(null);
      this.notifyStand(seat, "moved");
      return true;
    }
    if (standRequested) {
      this.playEmote(null);
      this.standUp();
      this.notifyStand(seat, "input");
      return true;
    }
    position.x = seat.x;
    position.z = seat.z;
    this.player.object.rotation.y = seat.yaw;
    this.currentSpeed = 0;
    this.followGround(deltaSeconds);
    this.player.animation.setState(this.emoteState ?? "sit");
    this.player.animation.update(deltaSeconds, 0);
    return false;
  }

  private notifyStand(seat: SeatPose, reason: StandReason): void {
    for (const listener of [...this.standListeners]) listener(seat, reason);
  }

  /** Follow the ground (stairs/terraces) with a short ease so steps don't jitter the camera. */
  private followGround(deltaSeconds: number): void {
    const groundY = this.groundHeightAt(this.player.position.x, this.player.position.z);
    const heightLerp = 1 - Math.exp(-GROUND_FOLLOW_SMOOTHING * deltaSeconds);
    this.player.position.y = Math.abs(groundY - this.player.position.y) > 1.5
      ? groundY // teleports (spawn, debug hooks) snap instead of floating down
      : THREE.MathUtils.lerp(this.player.position.y, groundY, heightLerp);
  }
}

/** Lerps an angle toward a target taking the shortest path around the circle. */
function shortestAngleLerp(current: number, target: number, t: number): number {
  const delta = THREE.MathUtils.euclideanModulo(target - current + Math.PI, Math.PI * 2) - Math.PI;
  return current + delta * t;
}
