import * as THREE from "three";
import type { InputManager } from "../input/InputManager.ts";
import type { CollisionSystem } from "../collision/CollisionSystem.ts";
import type { LocalPlayer } from "./LocalPlayer.ts";

const WALK_SPEED = 3.5; // m/s
const JOG_SPEED = 6.0; // m/s
const ROTATION_SMOOTHING = 12; // higher = snappier turning
const ACCELERATION_SMOOTHING = 10; // higher = snappier speed changes

/**
 * Turns InputManager state into LocalPlayer movement.
 *
 * Movement is camera-relative (pressing "forward" moves away from the
 * camera, not along world -Z), so this needs to know the camera's
 * current yaw. It takes that as a plain `() => number` getter rather
 * than a reference to ThirdPersonCamera itself, so the two systems
 * don't depend on each other's full interface — only this one number.
 */
export class PlayerController {
  private readonly input: InputManager;
  private readonly collisions: CollisionSystem;
  private readonly player: LocalPlayer;
  private readonly getCameraYaw: () => number;

  private currentSpeed = 0;

  constructor(input: InputManager, collisions: CollisionSystem, player: LocalPlayer, getCameraYaw: () => number) {
    this.input = input;
    this.collisions = collisions;
    this.player = player;
    this.getCameraYaw = getCameraYaw;
  }

  update(deltaSeconds: number): void {
    const moveX = (this.input.isPressed("moveRight") ? 1 : 0) - (this.input.isPressed("moveLeft") ? 1 : 0);
    const moveZ = (this.input.isPressed("moveBackward") ? 1 : 0) - (this.input.isPressed("moveForward") ? 1 : 0);

    const hasInput = moveX !== 0 || moveZ !== 0;
    const jogRequested = this.input.isPressed("jog");
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

    const normalizedSpeed = this.currentSpeed / JOG_SPEED;
    this.player.animation.setState(
      this.currentSpeed < 0.05 ? "idle" : jogRequested && hasInput ? "jog" : "walk",
    );
    this.player.animation.update(deltaSeconds, normalizedSpeed);
  }
}

/** Lerps an angle toward a target taking the shortest path around the circle. */
function shortestAngleLerp(current: number, target: number, t: number): number {
  const delta = THREE.MathUtils.euclideanModulo(target - current + Math.PI, Math.PI * 2) - Math.PI;
  return current + delta * t;
}
