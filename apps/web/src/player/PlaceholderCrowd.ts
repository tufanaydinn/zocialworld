import * as THREE from "three";
import { LIFT_TINT, createPlaceholderCharacter, type PlaceholderPart, type ProceduralRig } from "./PlaceholderCharacter.ts";

/**
 * Every remote placeholder in six draw calls.
 *
 * The placeholder (ADR-008; every remote player on the low tier, and on the high tier until the KayKit model has
 * loaded) is eight primitive meshes, so a full Watch Hall cost 59 × 8 = 472 draw calls on exactly the machines least
 * able to afford them (software rasterizers). Each player keeps its own rig — the same Object3D hierarchy that
 * PlayerAnimation swings, with its own materials for the accent colour and the hall lift — but its meshes are hidden;
 * this crowd draws all of them as one InstancedMesh per part (torso, belt, head, hat, arms, legs) with shared
 * geometry, copying each part's world matrix every frame (`sync`, run from the scene's onBeforeRender, after three has
 * updated the matrices and before it culls and draws).
 *
 * Exactly the same pixels: the same geometry, the same material parameters, the accent colour per instance (the accent
 * material's emissive follows it through a one-line shader change, see `accentMaterial`), the same shadow casting.
 * The hall lift is the visible players' (they all stand in the active location, so they share it).
 */

/** Every part of the rig and how many of it one player has. */
const PARTS: readonly { readonly part: PlaceholderPart; readonly perPlayer: number }[] = [
  { part: "torso", perPlayer: 1 },
  { part: "belt", perPlayer: 1 },
  { part: "head", perPlayer: 1 },
  { part: "hat", perPlayer: 1 },
  { part: "arm", perPlayer: 2 },
  { part: "leg", perPlayer: 2 },
];
const ACCENT_PARTS = new Set<PlaceholderPart>(["belt", "hat"]);
const WHITE = new THREE.Color(1, 1, 1);

export interface PlaceholderCrowdEntry {
  readonly rig: ProceduralRig;
  /** Whether the player is drawn this frame (RemotePlayerManager's location and frustum culling). */
  readonly visible: () => boolean;
}

export class PlaceholderCrowd {
  readonly object = new THREE.Group();
  private readonly entries = new Set<PlaceholderCrowdEntry>();
  private readonly geometry = new Map<PlaceholderPart, THREE.BufferGeometry>();
  private readonly material = new Map<PlaceholderPart, THREE.MeshStandardMaterial>();
  private readonly castShadow = new Map<PlaceholderPart, boolean>();
  private readonly liftMaterials: THREE.MeshStandardMaterial[];
  private meshes = new Map<PlaceholderPart, THREE.InstancedMesh>();
  private capacity = 0;
  private readonly counts = new Map<PlaceholderPart, number>();
  private readonly accentScratch = new THREE.Color();

  constructor(initialCapacity = 32) {
    this.object.name = "PlaceholderCrowd";
    // The template rig gives the crowd exactly the placeholder's geometry and material parameters.
    const template = createPlaceholderCharacter();
    for (const { mesh, part } of template.parts) {
      if (this.geometry.has(part)) continue;
      this.geometry.set(part, mesh.geometry);
      this.castShadow.set(part, mesh.castShadow);
      const source = mesh.material as THREE.MeshStandardMaterial;
      this.material.set(part, ACCENT_PARTS.has(part) ? accentMaterial(source) : source);
    }
    this.liftMaterials = [...new Set(this.material.values())];
    this.grow(initialCapacity);
  }

  /** Players currently drawn by the crowd (tests, debugging). */
  get size(): number {
    return this.entries.size;
  }

  /** Draws `entry.rig` from now on (its own meshes are hidden). */
  add(entry: PlaceholderCrowdEntry): void {
    for (const { mesh } of entry.rig.parts) mesh.visible = false;
    this.entries.add(entry);
    if (this.entries.size > this.capacity) this.grow(Math.max(this.capacity * 2, this.entries.size));
  }

  /** Stops drawing `entry` (its meshes become visible again, e.g. for a rig handed back to plain rendering). */
  remove(entry: PlaceholderCrowdEntry): void {
    if (!this.entries.delete(entry)) return;
    for (const { mesh } of entry.rig.parts) mesh.visible = true;
  }

  /** Copies every visible player's part matrices (and accent colours) into the instanced meshes. After three's matrix update, before culling. */
  sync(): void {
    for (const { part } of PARTS) this.counts.set(part, 0);
    let lift = 0;
    let lifted = false;
    for (const entry of this.entries) {
      if (!entry.visible()) continue;
      for (const { mesh, part } of entry.rig.parts) {
        const target = this.meshes.get(part)!;
        const index = this.counts.get(part)!;
        this.counts.set(part, index + 1);
        target.setMatrixAt(index, mesh.matrixWorld);
        if (ACCENT_PARTS.has(part)) target.setColorAt(index, this.accentScratch.copy((mesh.material as THREE.MeshStandardMaterial).color));
        if (!lifted) {
          lift = (mesh.material as THREE.MeshStandardMaterial).emissiveIntensity;
          lifted = true;
        }
      }
    }
    for (const [part, mesh] of this.meshes) {
      const count = this.counts.get(part)!;
      // An empty part stays visible: three skips a zero-instance draw, and the shader warm-up compiles its program
      // before the first player arrives (no hitch on the first spawn).
      mesh.count = count;
      if (count === 0) continue;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    for (const material of this.liftMaterials) material.emissiveIntensity = lift;
  }

  /** Instances in the last `sync` for `part` (tests, debugging). */
  instanceCount(part: PlaceholderPart): number {
    return this.meshes.get(part)?.count ?? 0;
  }

  /** The instanced mesh drawing `part` (tests, debugging). */
  meshFor(part: PlaceholderPart): THREE.InstancedMesh | undefined {
    return this.meshes.get(part);
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) mesh.dispose();
    for (const geometry of this.geometry.values()) geometry.dispose();
    for (const material of this.liftMaterials) material.dispose();
    this.object.clear();
    this.entries.clear();
  }

  private grow(players: number): void {
    for (const mesh of this.meshes.values()) {
      this.object.remove(mesh);
      mesh.dispose();
    }
    this.capacity = players;
    const meshes = new Map<PlaceholderPart, THREE.InstancedMesh>();
    for (const { part, perPlayer } of PARTS) {
      const mesh = new THREE.InstancedMesh(this.geometry.get(part)!, this.material.get(part)!, players * perPlayer);
      mesh.name = `PlaceholderCrowd:${part}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = this.castShadow.get(part) ?? false;
      // Players are culled one by one before they get here; the instanced bounds would be stale anyway.
      mesh.frustumCulled = false;
      // The accent parts carry a colour per instance from the start, so the program the warm-up compiles is the one used.
      if (ACCENT_PARTS.has(part)) mesh.setColorAt(0, WHITE);
      mesh.count = 0;
      this.object.add(mesh);
      meshes.set(part, mesh);
    }
    this.meshes = meshes;
  }
}

/**
 * The accent (belt and hat) material for instancing: white diffuse times the per-instance colour gives the player's
 * accent, and the emissive — the placeholder's `color.lerp(LIFT_TINT, 0.15)` — is rebuilt from the instance colour:
 * three uploads `emissive × emissiveIntensity`, so a white emissive times `mix(vColor, tint, 0.15)` is that value.
 */
function accentMaterial(source: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  const material = source.clone();
  material.name = "placeholder-crowd-accent";
  material.color.setRGB(1, 1, 1);
  material.emissive.setRGB(1, 1, 1);
  const tint = LIFT_TINT;
  const tintGlsl = `vec3( ${tint.r.toFixed(6)}, ${tint.g.toFixed(6)}, ${tint.b.toFixed(6)} )`;
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "vec3 totalEmissiveRadiance = emissive;",
      // The fragment stage knows instance colours as USE_COLOR (this material has no vertex colours).
      `vec3 totalEmissiveRadiance = emissive;\n#ifdef USE_COLOR\n\ttotalEmissiveRadiance *= mix( vColor.rgb, ${tintGlsl}, 0.15 );\n#endif`,
    );
  };
  material.customProgramCacheKey = () => "placeholder-crowd-accent";
  return material;
}
