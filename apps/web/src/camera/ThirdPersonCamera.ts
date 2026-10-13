import * as THREE from "three";
import type { InputManager } from "../input/InputManager.ts";

const MIN_PITCH = THREE.MathUtils.degToRad(-15);
const MAX_PITCH = THREE.MathUtils.degToRad(70);
const MIN_DISTANCE = 2.5;
const MAX_DISTANCE = 8;
const DEFAULT_DISTANCE = 5;

const YAW_SENSITIVITY = 0.0025;
const PITCH_SENSITIVITY = 0.0025;
const ZOOM_SENSITIVITY = 0.0025;

const POSITION_SMOOTHING = 14; // higher = snappier follow
const LOOK_SMOOTHING = 18;

const CAMERA_COLLISION_MARGIN = 0.3;

/**
 * Over-the-shoulder third-person camera.
 *
 * Orbits a target on yaw/pitch, follows it with exponential smoothing
 * (never a hard snap, which reads as jittery in a social space where
 * people stand still a lot), and raycasts from the pivot toward the
 * desired eye position so it can't clip through buildings — see
 * `resolveCollision()`.
 *
 * This class owns the actual `THREE.PerspectiveCamera` instance; nothing
 * else should construct one.
 */
export class ThirdPersonCamera {
  readonly camera: THREE.PerspectiveCamera;

  private yaw = 0; // start behind the target looking toward -Z (where the plaza content sits)
  private pitch = THREE.MathUtils.degToRad(12);
  private distance = DEFAULT_DISTANCE;

  private readonly currentPosition = new THREE.Vector3();
  private readonly currentLookAt = new THREE.Vector3();
  private initialized = false;

  private getObstacles: () => THREE.Object3D[] = () => [];
  private readonly raycaster = new THREE.Raycaster();
  /** Scratch vectors, so a frame allocates nothing (the same maths as before). */
  private readonly pivot = new THREE.Vector3();
  private readonly desiredOffset = new THREE.Vector3();
  private readonly desiredPosition = new THREE.Vector3();
  private readonly finalPosition = new THREE.Vector3();
  private readonly toCamera = new THREE.Vector3();
  private readonly rayDirection = new THREE.Vector3();
  private readonly hits: THREE.Intersection[] = [];

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 600);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Buildings/props the camera should not clip through. Static scenery only — never the player's own model. */
  setObstacles(provider: () => THREE.Object3D[]): void {
    this.getObstacles = provider;
  }

  get currentYaw(): number {
    return this.yaw;
  }

  /** Teleports: look along `yaw` and jump straight to the new spot instead of smoothing across the map. */
  /**
   * Jumps behind the target at `yaw` (and, optionally, a pitch in degrees: positive looks down, and a
   * follow distance in metres — the Watch Hall frames a seated player over the shoulder, above the row behind).
   */
  snapTo(yaw: number, pitchDegrees?: number, distance?: number): void {
    this.yaw = yaw;
    if (pitchDegrees !== undefined) this.pitch = THREE.MathUtils.clamp(THREE.MathUtils.degToRad(pitchDegrees), MIN_PITCH, MAX_PITCH);
    if (distance !== undefined) this.setDistance(distance);
    this.initialized = false;
  }

  /** The current follow distance (metres; the mouse wheel changes it). */
  get followDistance(): number {
    return this.distance;
  }

  /** Sets the follow distance, clamped to the zoom range. */
  setDistance(distance: number): void {
    this.distance = THREE.MathUtils.clamp(distance, MIN_DISTANCE, MAX_DISTANCE);
  }

  update(deltaSeconds: number, input: InputManager, targetPosition: THREE.Vector3, targetHeight: number): void {
    if (input.isPointerLocked) {
      const { x, y } = input.consumeMouseDelta();
      this.yaw -= x * YAW_SENSITIVITY;
      this.pitch = THREE.MathUtils.clamp(this.pitch - y * PITCH_SENSITIVITY, MIN_PITCH, MAX_PITCH);
    }

    const wheel = input.consumeWheelDelta();
    if (wheel !== 0) {
      this.distance = THREE.MathUtils.clamp(this.distance + wheel * ZOOM_SENSITIVITY, MIN_DISTANCE, MAX_DISTANCE);
    }

    const pivot = this.pivot.copy(targetPosition).setY(targetPosition.y + targetHeight * 0.9);

    const desiredOffset = this.desiredOffset
      .set(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch))
      .multiplyScalar(this.distance);

    const desiredPosition = this.desiredPosition.copy(pivot).add(desiredOffset);
    const safeDistance = this.resolveCollision(pivot, desiredPosition);
    const finalPosition = this.finalPosition.copy(desiredOffset).setLength(safeDistance).add(pivot);

    if (!this.initialized) {
      this.currentPosition.copy(finalPosition);
      this.currentLookAt.copy(pivot);
      this.initialized = true;
    } else {
      const posT = 1 - Math.exp(-POSITION_SMOOTHING * deltaSeconds);
      const lookT = 1 - Math.exp(-LOOK_SMOOTHING * deltaSeconds);
      this.currentPosition.lerp(finalPosition, posT);
      this.currentLookAt.lerp(pivot, lookT);
    }

    this.camera.position.copy(this.currentPosition);
    this.camera.lookAt(this.currentLookAt);
  }

  /** Raycasts pivot -> desired camera position; returns a (possibly shortened) safe distance. */
  private resolveCollision(pivot: THREE.Vector3, desiredPosition: THREE.Vector3): number {
    const toCamera = this.toCamera.copy(desiredPosition).sub(pivot);
    const fullDistance = toCamera.length();
    if (fullDistance < 1e-6) return this.distance;

    const obstacles = this.getObstacles();
    if (obstacles.length === 0) return this.distance;

    this.raycaster.set(pivot, this.rayDirection.copy(toCamera).normalize());
    this.raycaster.far = fullDistance;
    const hits = this.hits;
    hits.length = 0;
    this.raycaster.intersectObjects(obstacles, true, hits);

    if (hits.length === 0) return this.distance;
    return Math.max(MIN_DISTANCE, hits[0]!.distance - CAMERA_COLLISION_MARGIN);
  }
}
