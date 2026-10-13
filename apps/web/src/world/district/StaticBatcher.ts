import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { AssetManager } from "../../assets/AssetManager.ts";

/**
 * Collects many placements of static GLB props and bakes them into a
 * few merged meshes — one per distinct material.
 *
 * The district places well over a thousand modular wall/roof/prop
 * pieces; drawing each as its own mesh would cost thousands of draw
 * calls. Merging by material keeps the whole static world to a few
 * dozen, which is what makes a dense district browser-usable (reuse
 * meshes, reuse materials, batch statics).
 *
 * Usage: call `add()`/`place()` while laying out the scene, then
 * `await build()` once; the returned group goes into the scene.
 */

export interface PlacementOptions {
  /** Multiplies the asset's material color — e.g. to darken roof tiles to dusk slate. */
  readonly tint?: THREE.ColorRepresentation;
  /** Adds an emissive tint (for warm-lit pieces like lantern heads). */
  readonly emissive?: THREE.ColorRepresentation;
  readonly emissiveIntensity?: number;
  readonly castShadow?: boolean;
  /** Small decorative detail (flowers, grass tufts) — decimated on the low quality tier. */
  readonly detail?: boolean;
}

interface Batch {
  readonly url: string;
  readonly options: PlacementOptions;
  readonly matrices: THREE.Matrix4[];
}

const tmpMatrix = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpEuler = new THREE.Euler();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();

export class StaticBatcher {
  private readonly batches = new Map<string, Batch>();
  private readonly materialCache = new Map<string, THREE.Material>();
  private placementCount = 0;
  private detailCounter = 0;

  /** @param detailKeepRatio fraction of `detail: true` placements kept (1 = all; the low tier keeps fewer). */
  private readonly detailKeepRatio: number;
  /** Edge (m) of the map cells merges are split into, or Infinity for whole-map merges. */
  private readonly cellSize: number;

  /**
   * @param cellSize split merges per map cell so frustum culling can skip regions. Worth it where triangles dominate
   * (software rasterizers); on GPUs the extra draw calls cost more than the culled triangles save.
   */
  constructor(detailKeepRatio = 1, cellSize = Infinity) {
    this.detailKeepRatio = detailKeepRatio;
    this.cellSize = cellSize;
  }

  add(url: string, matrix: THREE.Matrix4, options: PlacementOptions = {}): void {
    if (options.detail && this.detailKeepRatio < 1) {
      // Deterministic stride decimation (stable across reloads, evenly spread).
      this.detailCounter++;
      if ((this.detailCounter * this.detailKeepRatio) % 1 >= this.detailKeepRatio) return;
    }
    const key = `${url}|${options.tint ?? ""}|${options.emissive ?? ""}|${options.emissiveIntensity ?? ""}|${options.castShadow ?? true}`;
    let batch = this.batches.get(key);
    if (!batch) {
      batch = { url, options, matrices: [] };
      this.batches.set(key, batch);
    }
    batch.matrices.push(matrix.clone());
    this.placementCount++;
  }

  /** Convenience: position + yaw (+ optional pitch/roll) + uniform or per-axis scale. */
  place(
    url: string,
    position: THREE.Vector3Like,
    rotationY = 0,
    scale: number | THREE.Vector3Like = 1,
    options: PlacementOptions = {},
    rotationX = 0,
    rotationZ = 0,
  ): void {
    tmpPos.set(position.x, position.y, position.z);
    tmpQuat.setFromEuler(tmpEuler.set(rotationX, rotationY, rotationZ, "YXZ"));
    if (typeof scale === "number") tmpScale.setScalar(scale);
    else tmpScale.set(scale.x, scale.y, scale.z);
    this.add(url, tmpMatrix.compose(tmpPos, tmpQuat, tmpScale), options);
  }

  /**
   * Adds an already-built procedural object (pillar, planter, parapet…)
   * to the merge pool: its single-material meshes are baked into the
   * shared merged meshes instead of costing their own draw calls.
   * The object must be static and already positioned in world space.
   */
  addStatic(object: THREE.Object3D): void {
    object.updateMatrixWorld(true);
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material)) return;
      this.proceduralParts.push({ geometry: mesh.geometry, material: mesh.material, matrix: mesh.matrixWorld.clone(), castShadow: mesh.castShadow });
    });
  }

  private readonly proceduralParts: { geometry: THREE.BufferGeometry; material: THREE.Material; matrix: THREE.Matrix4; castShadow: boolean }[] = [];

  /** Every GLB placement in authoring order. */
  exportPlacements(): { url: string; matrix: THREE.Matrix4; options: PlacementOptions }[] {
    const result: { url: string; matrix: THREE.Matrix4; options: PlacementOptions }[] = [];
    for (const batch of this.batches.values()) {
      for (const matrix of batch.matrices) result.push({ url: batch.url, matrix, options: batch.options });
    }
    return result;
  }

  get totalPlacements(): number {
    return this.placementCount;
  }

  get uniqueAssets(): number {
    return new Set([...this.batches.values()].map((batch) => batch.url)).size;
  }

  /**
   * Loads every referenced asset and bakes all placements that share a
   * material into ONE merged static mesh. The Kenney kits use a single
   * palette texture per pack, so a whole street of walls, roofs and
   * props collapses into a handful of draw calls (far fewer than one
   * InstancedMesh per asset-mesh pair).
   */
  async build(assets: AssetManager): Promise<THREE.Group> {
    const root = new THREE.Group();
    root.name = "StaticBatches";

    interface MergeGroup {
      material: THREE.Material;
      castShadow: boolean;
      parts: THREE.BufferGeometry[];
    }
    const groups = new Map<string, MergeGroup>();
    // Optionally split per map cell (see `cellSize`) so frustum culling can skip whole regions.
    const center = new THREE.Vector3();
    const groupFor = (material: THREE.Material, castShadow: boolean, source: THREE.BufferGeometry, part: THREE.BufferGeometry): MergeGroup => {
      part.computeBoundingBox();
      part.boundingBox!.getCenter(center);
      const cell = Number.isFinite(this.cellSize) ? `${Math.floor(center.x / this.cellSize)},${Math.floor(center.z / this.cellSize)}` : "";
      const key = `${material.uuid}|${castShadow}|${attributeSignature(source)}|${cell}`;
      let group = groups.get(key);
      if (!group) {
        group = { material, castShadow, parts: [] };
        groups.set(key, group);
      }
      return group;
    };

    await Promise.all(
      [...this.batches.values()].map(async (batch) => {
        let scene: THREE.Object3D;
        try {
          scene = (await assets.loadGltf(batch.url)).scene;
        } catch (error) {
          // A missing optional prop must never take the whole world down.
          console.warn(`[district] failed to load ${batch.url}:`, error);
          return;
        }
        scene.updateMatrixWorld(true);
        scene.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (!mesh.isMesh || Array.isArray(mesh.material)) return;
          const material = this.resolveMaterial(mesh.material, batch);
          const source = normalizedGeometry(mesh.geometry);
          const castShadow = batch.options.castShadow ?? true;
          for (const placement of batch.matrices) {
            const part = transformed(source, tmpMatrix.multiplyMatrices(placement, mesh.matrixWorld));
            groupFor(material, castShadow, source, part).parts.push(part);
          }
        });
      }),
    );

    for (const part of this.proceduralParts) {
      const source = normalizedGeometry(part.geometry);
      const geometry = transformed(source, part.matrix);
      groupFor(part.material, part.castShadow, source, geometry).parts.push(geometry);
    }

    for (const group of groups.values()) {
      const merged = mergeGeometries(group.parts, false);
      for (const part of group.parts) part.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, group.material);
      mesh.castShadow = group.castShadow;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.name = `merged:${group.material.name || group.material.type}`;
      root.add(mesh);
    }
    this.mergedGroupCount = groups.size;
    return root;
  }

  /**
   * Every GLB in a pack carries its own copy of the pack's materials (e.g. each Kenney piece has its own "colormap"
   * material over the same palette texture), which would keep identical surfaces in separate merges. Materials that
   * match on pack, name, texture and settings are folded onto one instance, so they merge into one draw call.
   */
  private canonicalMaterial(material: THREE.Material, url: string): THREE.Material {
    const standard = material as THREE.MeshStandardMaterial;
    if (!standard.isMeshStandardMaterial) return material;
    const map = standard.map;
    const image = map?.image as { width?: number; height?: number } | undefined;
    const key = [
      url.slice(0, url.lastIndexOf("/")),
      standard.name,
      standard.color.getHexString(),
      standard.emissive.getHexString(),
      standard.emissiveIntensity,
      map ? `${map.name}:${image?.width}x${image?.height}:${map.flipY}` : "-",
      standard.vertexColors,
      standard.transparent,
      standard.opacity,
      standard.side,
      standard.alphaTest,
    ].join("|");
    const existing = this.canonicalMaterials.get(key);
    if (existing) return existing;
    this.canonicalMaterials.set(key, material);
    return material;
  }

  private readonly canonicalMaterials = new Map<string, THREE.Material>();

  /** Number of merged meshes (≈ static draw calls) produced by the last build(). */
  mergedGroupCount = 0;

  private resolveMaterial(loaded: THREE.Material, batch: Batch): THREE.Material {
    const source = this.canonicalMaterial(loaded, batch.url);
    normalizeMaterial(source);
    const { tint, emissive, emissiveIntensity } = batch.options;
    if (tint === undefined && emissive === undefined) return source;
    const key = `${source.uuid}|${tint ?? ""}|${emissive ?? ""}|${emissiveIntensity ?? ""}`;
    let material = this.materialCache.get(key);
    if (!material) {
      const clone = source.clone() as THREE.MeshStandardMaterial;
      if (tint !== undefined) clone.color.multiply(new THREE.Color(tint));
      if (emissive !== undefined) {
        clone.emissive = new THREE.Color(emissive);
        clone.emissiveIntensity = emissiveIntensity ?? 1;
      }
      material = clone;
      this.materialCache.set(key, material);
    }
    return material;
  }
}

/**
 * Low-poly packs ship with assorted PBR values; without an environment
 * map anything metallic renders near-black. Force a matte, consistent
 * response so every pack sits in the same lighting.
 */
export function normalizeMaterial(material: THREE.Material): void {
  const standard = material as THREE.MeshStandardMaterial;
  if (!standard.isMeshStandardMaterial || standard.userData.districtNormalized) return;
  standard.metalness = 0;
  standard.roughness = Math.max(standard.roughness, 0.75);
  standard.userData.districtNormalized = true;
}

/** Packs disagree on attribute sets (quantized ints, extra UV sets, vertex colors); normalize to float position/normal/uv(/color). */
function normalizedGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const cached = geometry.userData.districtNormalized as THREE.BufferGeometry | undefined;
  if (cached) return cached;
  const result = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "uv", "color"]) {
    const attribute = geometry.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (!attribute) continue;
    const array = new Float32Array(attribute.count * attribute.itemSize);
    for (let i = 0; i < attribute.count; i++) {
      for (let c = 0; c < attribute.itemSize; c++) array[i * attribute.itemSize + c] = attribute.getComponent(i, c);
    }
    result.setAttribute(name, new THREE.BufferAttribute(array, attribute.itemSize));
  }
  if (!result.getAttribute("normal")) result.computeVertexNormals();
  const index = geometry.getIndex();
  if (index) result.setIndex(Array.from(index.array as ArrayLike<number>));
  geometry.userData.districtNormalized = result;
  return result;
}

function attributeSignature(geometry: THREE.BufferGeometry): string {
  return Object.keys(geometry.attributes)
    .sort()
    .map((name) => `${name}${geometry.getAttribute(name).itemSize}`)
    .join(",") + (geometry.getIndex() ? "|i" : "");
}

/** Clone + bake a transform; mirrored transforms (negative determinant) get their triangle winding flipped back. */
function transformed(source: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry {
  const geometry = source.clone().applyMatrix4(matrix);
  if (matrix.determinant() < 0) {
    const index = geometry.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const b = index.getX(i + 1);
        index.setX(i + 1, index.getX(i + 2));
        index.setX(i + 2, b);
      }
    }
  }
  return geometry;
}
