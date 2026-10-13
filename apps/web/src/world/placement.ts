import * as THREE from "three";

/**
 * Placement primitives shared by location builders: seats and stand spots for characters, and a local
 * frame aligned with a building facade for placing props along it.
 */

export interface Seat {
  readonly position: THREE.Vector3;
  /** Yaw the seated character faces (toward the table). */
  readonly yaw: number;
}

export interface NpcSpot {
  readonly position: THREE.Vector3;
  readonly yaw: number;
}

/** A facade-aligned local frame: u runs along the facade, v points out of it. */
export class Frame {
  readonly origin: THREE.Vector3;
  readonly yaw: number;
  readonly tangent: THREE.Vector3;
  readonly normal: THREE.Vector3;

  constructor(origin: THREE.Vector3, yaw: number) {
    this.origin = origin;
    this.yaw = yaw;
    this.tangent = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    this.normal = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  }

  at(u: number, v: number, y = 0): THREE.Vector3 {
    return this.origin.clone().addScaledVector(this.tangent, u).addScaledVector(this.normal, v).setY(this.origin.y + y);
  }

  /** The frame on a building's front: origin at the facade centre, yaw of the building. */
  static ofBuilding(building: { readonly frontCenter: THREE.Vector3; readonly spec: { readonly rotationY: number } }): Frame {
    return new Frame(building.frontCenter.clone(), building.spec.rotationY);
  }
}
