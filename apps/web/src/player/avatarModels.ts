import * as THREE from "three";
import type { AssetManager } from "../assets/AssetManager.ts";
import { character } from "../world/district/assetPaths.ts";
import { mergeCharacterMeshes } from "../world/district/characterMerge.ts";

/**
 * The KayKit adventurer models that players (and the ambient NPCs) appear as, and how one is loaded
 * as a player avatar.
 */

export type NpcModel = "Knight" | "Mage" | "Barbarian" | "Rogue" | "Rogue_Hooded";

/** Height every character model is scaled to, in metres. */
export const CHARACTER_HEIGHT = 1.72;
/** Props the character packs hold in their hands; hidden on every character. */
export const HIDDEN_CHARACTER_PARTS = /Knife|Throwable|Mug/;

/** The KayKit adventurers a player can appear as (remote avatars pick one from their colorSeed). Same order as the protocol's PLAYER_AVATAR_MODELS. */
export const AVATAR_MODELS: readonly NpcModel[] = ["Rogue_Hooded", "Rogue", "Knight", "Mage", "Barbarian"];

const blobGeometry = new THREE.CircleGeometry(0.42, 20).rotateX(-Math.PI / 2);
let blobMaterial: THREE.MeshBasicMaterial | null = null;

/** Soft dark disc under a character — stands in for a real shadow-map shadow (NPCs, remote player avatars). Shared geometry and material. */
export function blobShadow(): THREE.Mesh {
  if (!blobMaterial) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d")!;
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, "rgba(0,0,0,0.55)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
    blobMaterial = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false });
  }
  const mesh = new THREE.Mesh(blobGeometry, blobMaterial);
  mesh.position.y = 0.03;
  mesh.renderOrder = 1;
  return mesh;
}

/**
 * Loads a player avatar (default: the KayKit hooded rogue) as one merged skinned draw, with clips renamed to
 * PlayerAnimation's Idle/Walk/Jog/Sit/Cheer. Wave, dance and the raised hand are procedural layers
 * (player/emoteLayer.ts) — the pack has no wave clip.
 *
 * `castShadow: false` is for remote players: like the NPCs, they get a blob shadow instead of a shadow-map pass per
 * character.
 */
export async function loadPlayerAvatar(
  assets: AssetManager,
  modelName: NpcModel = "Rogue_Hooded",
  options: { castShadow?: boolean } = {},
): Promise<{ model: THREE.Object3D; clips: THREE.AnimationClip[] }> {
  const { scene, animations } = await assets.instantiate(character(modelName));
  scene.traverse((object) => {
    if (HIDDEN_CHARACTER_PARTS.test(object.name)) object.visible = false;
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = options.castShadow ?? true;
      mesh.frustumCulled = false;
      if (options.castShadow === false) {
        const material = mesh.material as THREE.MeshStandardMaterial;
        if (material.isMeshStandardMaterial) {
          material.metalness = 0;
          material.roughness = Math.max(0.7, material.roughness);
        }
      }
    }
  });
  const box = new THREE.Box3().setFromObject(scene);
  scene.scale.setScalar(CHARACTER_HEIGHT / Math.max(0.01, box.max.y - box.min.y));
  mergeCharacterMeshes(scene);
  const rename = (source: string, target: string): THREE.AnimationClip | null => {
    const clip = THREE.AnimationClip.findByName(animations, source);
    if (!clip) return null;
    const copy = clip.clone();
    copy.name = target;
    return copy;
  };
  const clips = [rename("Idle", "Idle"), rename("Walking_A", "Walk"), rename("Running_A", "Jog"), rename("Sit_Chair_Idle", "Sit"), rename("Cheer", "Cheer")].filter(
    (clip): clip is THREE.AnimationClip => clip !== null,
  );
  return { model: scene, clips };
}
