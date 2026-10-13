import * as THREE from "three";
import type { StaticBatcher } from "./StaticBatcher.ts";
import { town } from "./assetPaths.ts";
import { seededRandom } from "./textures.ts";

/**
 * Assembles half-timbered buildings from the Kenney Fantasy Town Kit's
 * 1×1×1 modular pieces (walls sit on a cell's +X edge; roofs are
 * one-cell A-frames). A building is a W×D cell footprint, N floors,
 * a gable roof whose ridge runs along the building's width, and a few
 * dressing options. Everything is emitted into a StaticBatcher, so a
 * whole street of houses costs only a handful of draw calls.
 *
 * Local frame: the building's front faces local +Z; `rotationY` turns
 * the front toward the plaza.
 */

export type WallStyle = "stone" | "wood";

export interface BuildingSpec {
  readonly id: string;
  /** Ground-level center of the footprint. */
  readonly position: THREE.Vector3Like;
  readonly rotationY: number;
  /** Footprint in cells along local X (front width) and local Z (depth). */
  readonly width: number;
  readonly depth: number;
  readonly floors: number;
  /** Size of one modular cell in meters (wall height per floor too). */
  readonly cell?: number;
  readonly ground?: WallStyle;
  readonly upper?: WallStyle;
  /** Multiplies the kit's roof color (teal/red) — dusk slate, plum, burgundy. */
  readonly roofTint?: THREE.ColorRepresentation;
  readonly highRoof?: boolean;
  /** Multiplies the kit's lavender plaster so it reads warm cream under dusk light. */
  readonly stoneTint?: THREE.ColorRepresentation;
  readonly woodTint?: THREE.ColorRepresentation;
  /** Front-facade cell indices (0..width-1) that get a door on the ground floor. */
  readonly doors?: readonly number[];
  readonly chimney?: boolean;
  /** Cross gable over the central front cells — a tall gable end facing the plaza (e.g. a lodge or a tavern). */
  readonly frontGable?: boolean;
  /** Warm interior glow behind windows. */
  readonly litWindows?: boolean;
  readonly seed?: number;
  /** Low quality tier: only the lightest window variants (round/stone windows are ~3× the triangles). */
  readonly lite?: boolean;
  /** Background houses skip shadows to save fill-rate. */
  readonly castShadow?: boolean;
}

export interface BuildingResult {
  readonly spec: BuildingSpec;
  /** World-space footprint center and half extents (axis-aligned bounds of the rotated footprint). */
  readonly center: THREE.Vector3;
  readonly halfExtents: THREE.Vector2;
  /** World position at the middle of the front facade, ground level. */
  readonly frontCenter: THREE.Vector3;
  /** World-space outward normal of the front facade. */
  readonly frontNormal: THREE.Vector3;
  readonly wallHeight: number;
  /** Local→world transform of the footprint center (for attaching signs/banners). */
  readonly matrix: THREE.Matrix4;
  /** World positions just outside lit windows (for glow sprites / lights). */
  readonly windowPoints: THREE.Vector3[];
}

const WALL_PIECES = {
  stone: {
    plain: ["wall", "wall-detail-cross", "wall-detail-horizontal"],
    window: ["wall-window-shutters", "wall-window-small", "wall-window-round", "wall-window-stone"],
    door: ["wall-door", "wall-doorway-round"],
  },
  wood: {
    plain: ["wall-wood", "wall-wood-detail-cross", "wall-wood-detail-diagonal"],
    window: ["wall-wood-window-shutters", "wall-wood-window-small", "wall-wood-window-round", "wall-wood-window-stone"],
    door: ["wall-wood-door", "wall-wood-doorway-round"],
  },
} as const;

const STONE_TINT = 0xffe2c4;

/** Rotation that maps a wall piece's native +X face onto each footprint side. */
const SIDE_ROTATION = { front: -Math.PI / 2, back: Math.PI / 2, right: 0, left: Math.PI } as const;

/**
 * Window glow cards are collected as matrices (one shared unit plane)
 * and turned into a single InstancedMesh by the caller — see
 * `createWindowGlowMesh()`.
 */
export function buildModularBuilding(spec: BuildingSpec, batcher: StaticBatcher, glowMatrices: THREE.Matrix4[]): BuildingResult {
  const cell = spec.cell ?? 2.6;
  const ground = spec.ground ?? "stone";
  const upper = spec.upper ?? "wood";
  const random = seededRandom(spec.seed ?? hashString(spec.id));
  const castShadow = spec.castShadow ?? true;

  const root = new THREE.Matrix4().compose(
    new THREE.Vector3(spec.position.x, spec.position.y, spec.position.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spec.rotationY),
    new THREE.Vector3(1, 1, 1),
  );

  const windowPoints: THREE.Vector3[] = [];
  const offsetX = (spec.width - 1) / 2;
  const offsetZ = (spec.depth - 1) / 2;

  const placeLocal = (
    url: string,
    lx: number,
    ly: number,
    lz: number,
    rotY: number,
    scale: THREE.Vector3,
    tint?: THREE.ColorRepresentation,
  ): void => {
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(lx, ly, lz),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY),
      scale,
    );
    batcher.add(url, new THREE.Matrix4().multiplyMatrices(root, local), {
      castShadow,
      ...(tint !== undefined ? { tint } : {}),
    });
  };

  const cellScale = new THREE.Vector3(cell, cell, cell);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;

  const sides: { side: keyof typeof SIDE_ROTATION; cells: number }[] = [
    { side: "front", cells: spec.width },
    { side: "back", cells: spec.width },
    { side: "left", cells: spec.depth },
    { side: "right", cells: spec.depth },
  ];

  for (let floor = 0; floor < spec.floors; floor++) {
    const style = floor === 0 ? ground : upper;
    const pieces = WALL_PIECES[style];
    const y = floor * cell;
    for (const { side, cells } of sides) {
      for (let i = 0; i < cells; i++) {
        // Cell center in local footprint coordinates.
        let cx = 0;
        let cz = 0;
        if (side === "front") [cx, cz] = [(i - offsetX) * cell, offsetZ * cell];
        else if (side === "back") [cx, cz] = [(offsetX - i) * cell, -offsetZ * cell];
        else if (side === "left") [cx, cz] = [-offsetX * cell, (i - offsetZ) * cell];
        else [cx, cz] = [offsetX * cell, (offsetZ - i) * cell];

        let piece: string;
        const isDoor = floor === 0 && side === "front" && (spec.doors ?? [Math.floor(spec.width / 2)]).includes(i);
        if (isDoor) piece = pieces.door[0];
        else if (side === "front" || random() < 0.55) piece = spec.lite ? pieces.window[random() < 0.5 ? 0 : 1] : pick(pieces.window);
        else piece = pick(pieces.plain);

        const rotY = SIDE_ROTATION[side];
        placeLocal(town(piece), cx, y, cz, rotY, cellScale, style === "stone" ? spec.stoneTint ?? STONE_TINT : spec.woodTint);

        if (spec.litWindows !== false && !isDoor && piece.includes("window")) {
          // Emissive card just inside the wall: only visible through the window opening.
          const normal = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
          const inset = cell * 0.4;
          const local = new THREE.Vector3(cx, y + cell * 0.55, cz).addScaledVector(normal, inset);
          glowMatrices.push(
            new THREE.Matrix4().compose(
              local.applyMatrix4(root),
              new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spec.rotationY + rotY + Math.PI / 2),
              new THREE.Vector3(cell * 0.62, cell * 0.62, 1),
            ),
          );
          if (random() < 0.5) {
            windowPoints.push(new THREE.Vector3(cx, y + cell * 0.55, cz).addScaledVector(normal, cell * 0.62).applyMatrix4(root));
          }
        }
      }
    }
    // Floor slab between storeys (hides the open top of the wall ring from above).
    if (floor > 0) {
      placeLocal(
        town("planks"),
        0,
        y - 0.02,
        0,
        0,
        new THREE.Vector3(spec.width * cell, cell, spec.depth * cell),
      );
    }
  }

  // Gable roof: one A-frame piece per width cell, stretched across the full depth.
  const wallHeight = spec.floors * cell;
  const roofPiece = spec.highRoof === false ? "roof-gable" : "roof-high-gable";
  const roofTint = spec.roofTint ?? 0xffffff;
  const roofHeightScale = cell * Math.min(1.25, 0.55 + spec.depth * 0.32);
  for (let i = 0; i < spec.width; i++) {
    placeLocal(
      town(roofPiece),
      (i - offsetX) * cell,
      wallHeight,
      0,
      0,
      new THREE.Vector3(cell * 1.0, roofHeightScale, spec.depth * cell),
      roofTint,
    );
  }

  if (spec.frontGable) {
    // A taller A-frame turned 90° so its gable end faces front, spanning the middle cell(s)
    // and projecting slightly forward over the facade.
    const span = spec.width >= 5 ? 1.6 : 1.2;
    placeLocal(
      town("roof-high-gable"),
      0,
      wallHeight - 0.05,
      cell * 0.25,
      -Math.PI / 2,
      new THREE.Vector3((spec.depth + 0.5) * cell, roofHeightScale * 1.18, span * cell),
      roofTint,
    );
    // Lit attic window in the gable end.
    const atticLocal = new THREE.Vector3(0, wallHeight + roofHeightScale * 0.42, (offsetZ + 0.5) * cell + cell * 0.25 + 0.06);
    glowMatrices.push(
      new THREE.Matrix4().compose(
        atticLocal.clone().applyMatrix4(root),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spec.rotationY),
        new THREE.Vector3(cell * 0.32, cell * 0.36, 1),
      ),
    );
    windowPoints.push(atticLocal.clone().setZ(atticLocal.z + 0.3).applyMatrix4(root));
  }

  if (spec.chimney) {
    placeLocal(town("chimney"), (offsetX - 0.3) * cell, wallHeight * 0.92, -offsetZ * cell * 0.4, 0, cellScale);
  }

  const center = new THREE.Vector3(spec.position.x, spec.position.y, spec.position.z);
  const corners = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ].map(([sx, sz]) =>
    new THREE.Vector3((sx! * spec.width * cell) / 2, 0, (sz! * spec.depth * cell) / 2).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      spec.rotationY,
    ),
  );
  const halfExtents = new THREE.Vector2(
    Math.max(...corners.map((c) => Math.abs(c.x))),
    Math.max(...corners.map((c) => Math.abs(c.z))),
  );
  const frontNormal = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), spec.rotationY);
  const frontCenter = center.clone().addScaledVector(frontNormal, (spec.depth * cell) / 2);

  return { spec, center, halfExtents, frontCenter, frontNormal, wallHeight, matrix: root, windowPoints };
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** One draw call for every lit window in the district. Unlit (MeshBasic) and above 1.0 so bloom catches it. */
export function createWindowGlowMesh(matrices: readonly THREE.Matrix4[]): THREE.InstancedMesh {
  const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 0.95, 0.3), side: THREE.DoubleSide });
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, Math.max(1, matrices.length));
  matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
  mesh.count = matrices.length;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.name = "WindowGlow";
  return mesh;
}
