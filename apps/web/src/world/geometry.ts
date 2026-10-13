import * as THREE from "three";

/**
 * Small geometry helpers shared by every location builder: world-scaled box UVs, merged box material
 * groups and the yaw that turns a model toward a point. No scene state, no imports beyond three.
 */

/** BoxGeometry whose UVs are scaled to world size so tiling textures keep a constant texel density. */
export function texturedBox(width: number, height: number, depth: number, tile: number): THREE.BoxGeometry {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  // Face order: +x, -x, +y, -y, +z, -z — 4 vertices each.
  const faceSize: [number, number][] = [
    [depth, height],
    [depth, height],
    [width, depth],
    [width, depth],
    [width, height],
    [width, height],
  ];
  for (let face = 0; face < 6; face++) {
    const [u, v] = faceSize[face]!;
    for (let i = 0; i < 4; i++) {
      const index = face * 4 + i;
      uv.setXY(index, (uv.getX(index) * u) / tile, (uv.getY(index) * v) / tile);
    }
  }
  return geometry;
}

/**
 * BoxGeometry has one draw group per face (6 draw calls). Re-sort the
 * index so faces sharing a material are contiguous and emit one group
 * per distinct material — e.g. a terrace block becomes 2 draws, not 6.
 * `faceMaterials` gives the material index for faces +x,-x,+y,-y,+z,-z.
 */
export function compactFaceGroups(geometry: THREE.BufferGeometry, faceMaterials: readonly number[]): THREE.BufferGeometry {
  const index = geometry.getIndex()!;
  const perFace = index.count / 6;
  const order = [0, 1, 2, 3, 4, 5].sort((a, b) => faceMaterials[a]! - faceMaterials[b]!);
  const indices: number[] = [];
  geometry.clearGroups();
  let start = 0;
  let current = -1;
  for (const face of order) {
    const material = faceMaterials[face]!;
    if (material !== current) {
      if (current !== -1) geometry.addGroup(start, indices.length - start, current);
      start = indices.length;
      current = material;
    }
    for (let i = 0; i < perFace; i++) indices.push(index.getX(face * perFace + i));
  }
  geometry.addGroup(start, indices.length - start, current);
  geometry.setIndex(indices);
  return geometry;
}

/** Yaw that turns a model's front (local +Z) at (fromX, fromZ) to face the world-space point (toX, toZ). */
export function faceToward(fromX: number, fromZ: number, toX: number, toZ: number): number {
  return Math.atan2(toX - fromX, toZ - fromZ);
}
