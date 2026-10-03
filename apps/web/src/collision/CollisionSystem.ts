import * as THREE from "three";

/**
 * Lightweight 2.5D collision system.
 *
 * We deliberately do NOT use a physics engine. Everything in the social
 * world is static geometry (buildings, trees, props) plus player
 * capsules walking on a flat-ish ground plane, so simple XZ-plane shape
 * tests are enough and far cheaper than a full physics simulation.
 *
 * Colliders are invisible primitives registered separately from the
 * visible meshes — never collide against render geometry directly.
 */

export interface BoxCollider {
  readonly type: "box";
  readonly center: THREE.Vector3;
  /** Half-width/half-depth extents on the X/Z axes (Y is ignored — collision is 2.5D). */
  readonly halfExtents: THREE.Vector2;
}

export interface CylinderCollider {
  readonly type: "cylinder";
  readonly center: THREE.Vector3;
  readonly radius: number;
}

export type Collider = BoxCollider | CylinderCollider;

export class CollisionSystem {
  private readonly colliders: Collider[] = [];

  addBox(center: THREE.Vector3, halfWidth: number, halfDepth: number): BoxCollider {
    const collider: BoxCollider = {
      type: "box",
      center: center.clone(),
      halfExtents: new THREE.Vector2(halfWidth, halfDepth),
    };
    this.colliders.push(collider);
    return collider;
  }

  addCylinder(center: THREE.Vector3, radius: number): CylinderCollider {
    const collider: CylinderCollider = { type: "cylinder", center: center.clone(), radius };
    this.colliders.push(collider);
    return collider;
  }

  clear(): void {
    this.colliders.length = 0;
  }

  /**
   * Resolves a desired (x, z) position against all registered colliders
   * for a circular agent of the given radius, and returns the corrected
   * position. Uses simple push-out resolution rather than swept/CCD
   * collision — adequate for walking speeds in a small social space.
   */
  resolve(desired: THREE.Vector3, agentRadius: number): THREE.Vector3 {
    const resolved = desired.clone();

    for (const collider of this.colliders) {
      if (collider.type === "cylinder") {
        this.resolveAgainstCylinder(resolved, agentRadius, collider);
      } else {
        this.resolveAgainstBox(resolved, agentRadius, collider);
      }
    }

    return resolved;
  }

  private resolveAgainstCylinder(point: THREE.Vector3, agentRadius: number, collider: CylinderCollider): void {
    const dx = point.x - collider.center.x;
    const dz = point.z - collider.center.z;
    const distSq = dx * dx + dz * dz;
    const minDist = collider.radius + agentRadius;

    if (distSq >= minDist * minDist || distSq < 1e-10) return;

    const dist = Math.sqrt(distSq);
    const push = (minDist - dist) / dist;
    point.x += dx * push;
    point.z += dz * push;
  }

  private resolveAgainstBox(point: THREE.Vector3, agentRadius: number, collider: BoxCollider): void {
    const minX = collider.center.x - collider.halfExtents.x - agentRadius;
    const maxX = collider.center.x + collider.halfExtents.x + agentRadius;
    const minZ = collider.center.z - collider.halfExtents.y - agentRadius;
    const maxZ = collider.center.z + collider.halfExtents.y + agentRadius;

    if (point.x <= minX || point.x >= maxX || point.z <= minZ || point.z >= maxZ) return;

    // Inside the expanded box: push out along the axis of least penetration.
    const penLeft = point.x - minX;
    const penRight = maxX - point.x;
    const penTop = point.z - minZ;
    const penBottom = maxZ - point.z;
    const minPen = Math.min(penLeft, penRight, penTop, penBottom);

    if (minPen === penLeft) point.x = minX;
    else if (minPen === penRight) point.x = maxX;
    else if (minPen === penTop) point.z = minZ;
    else point.z = maxZ;
  }
}
