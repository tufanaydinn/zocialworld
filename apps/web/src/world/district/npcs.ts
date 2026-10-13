import * as THREE from "three";
import type { AssetManager } from "../../assets/AssetManager.ts";
import { character } from "./assetPaths.ts";
import { nameTexture, seededRandom } from "./textures.ts";
import type { Seat } from "../placement.ts";
import { mergeCharacterMeshes } from "./characterMerge.ts";
import { CHARACTER_HEIGHT, HIDDEN_CHARACTER_PARTS, blobShadow, type NpcModel } from "../../player/avatarModels.ts";

/**
 * Ambient resident NPCs — visual population only
 * (15–20 visible, clustered, not a grid). They sit at tables, chat in
 * pairs, browse stalls, work at benches and stroll around the plaza.
 * They have no networking, identity or wallet
 * surface; names are fictional flavor labels so the plaza reads like a
 * lived-in social scene.
 */

type Clip = "Idle" | "Unarmed_Idle" | "Sit_Chair_Idle" | "Sit_Floor_Idle" | "Cheer" | "Interact" | "Use_Item" | "Walking_A" | "Spellcasting";

export interface NpcSpec {
  readonly model: NpcModel;
  readonly position: THREE.Vector3;
  readonly yaw: number;
  readonly clip: Clip;
  readonly name?: string;
  readonly nameColor?: string;
  /** Closed loop of waypoints: the NPC walks it forever. */
  readonly path?: readonly THREE.Vector3[];
  /** Drop helmets/hats so adventurer models read more like townsfolk. */
  readonly bareHead?: boolean;
}

const WALK_SPEED = 1.15;
const HEADWEAR = /Helmet|_Hat$/;

interface ActiveNpc {
  readonly root: THREE.Object3D;
  readonly mixer: THREE.AnimationMixer;
  readonly path?: readonly THREE.Vector3[];
  pathIndex: number;
  readonly label?: THREE.Sprite;
  /** Animation time accumulated while off-screen, applied when the NPC is next visible. */
  pendingAnimation: number;
}

export interface NpcPopulation {
  readonly group: THREE.Group;
  readonly count: number;
  update(deltaSeconds: number, camera: THREE.Camera): void;
}

export async function spawnNpcs(
  assets: AssetManager,
  specs: readonly NpcSpec[],
  heightAt: (x: number, z: number) => number,
): Promise<NpcPopulation> {
  const group = new THREE.Group();
  group.name = "NPCs";
  const scaleByModel = new Map<NpcModel, number>();
  const active: ActiveNpc[] = [];
  const random = seededRandom(5150);

  await Promise.all(
    specs.map(async (spec) => {
      const url = character(spec.model);
      let instance: { scene: THREE.Object3D; animations: THREE.AnimationClip[] };
      try {
        instance = await assets.instantiate(url);
      } catch (error) {
        console.warn(`[district] NPC model failed to load: ${url}`, error);
        return;
      }
      const model = instance.scene;
      model.traverse((object) => {
        if (HIDDEN_CHARACTER_PARTS.test(object.name) || (spec.bareHead && HEADWEAR.test(object.name))) object.visible = false;
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh) {
          // Real shadow maps for 25 skinned characters cost ~2× their draw calls; a blob shadow reads fine at dusk.
          mesh.castShadow = false;
          mesh.frustumCulled = false; // skinned bounds are bind-pose; avoid popping
          const material = mesh.material as THREE.MeshStandardMaterial;
          if (material.isMeshStandardMaterial) {
            material.metalness = 0;
            material.roughness = Math.max(0.7, material.roughness);
          }
        }
      });

      let scale = scaleByModel.get(spec.model);
      if (scale === undefined) {
        const box = new THREE.Box3().setFromObject(model);
        scale = CHARACTER_HEIGHT / Math.max(0.01, box.max.y - box.min.y);
        scaleByModel.set(spec.model, scale);
      }
      model.scale.setScalar(scale);
      // After sizing (the bounds above include hidden parts, as they always have): one draw call per character.
      mergeCharacterMeshes(model);

      const root = new THREE.Group();
      root.add(model);
      root.add(blobShadow());
      root.position.copy(spec.position);
      if (!spec.path) root.position.y = Math.max(spec.position.y, heightAt(spec.position.x, spec.position.z));
      root.rotation.y = spec.yaw;
      group.add(root);

      const mixer = new THREE.AnimationMixer(model);
      const clip = THREE.AnimationClip.findByName(instance.animations, spec.path ? "Walking_A" : spec.clip);
      if (clip) {
        const action = mixer.clipAction(clip);
        action.play();
        // Desynchronize identical idles so a crowd doesn't breathe in unison.
        action.time = random() * clip.duration;
        action.timeScale = 0.9 + random() * 0.2;
      }

      let label: THREE.Sprite | undefined;
      if (spec.name) {
        label = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: nameTexture(spec.name, spec.nameColor ?? "#f1e9dd"), transparent: true, depthWrite: false }),
        );
        label.scale.set(1.2, 0.3, 1);
        label.position.set(0, spec.clip === "Sit_Chair_Idle" ? 1.75 : 2.15, 0);
        label.renderOrder = 5;
        root.add(label);
      }

      active.push({ root, mixer, ...(spec.path ? { path: spec.path } : {}), pathIndex: 0, ...(label ? { label } : {}), pendingAnimation: 0 });
    }),
  );

  const toTarget = new THREE.Vector3();
  const frustum = new THREE.Frustum();
  const viewProjection = new THREE.Matrix4();
  // Covers a standing character plus its name label; skinned bounds are bind-pose, so cull per character instead.
  const bounds = new THREE.Sphere(new THREE.Vector3(), 1.8);
  return {
    group,
    count: active.length,
    update(deltaSeconds, camera) {
      camera.updateMatrixWorld();
      frustum.setFromProjectionMatrix(viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      for (const npc of active) {
        if (npc.path && npc.path.length > 1) {
          const target = npc.path[npc.pathIndex]!;
          toTarget.subVectors(target, npc.root.position).setY(0);
          const distance = toTarget.length();
          if (distance < 0.3) {
            npc.pathIndex = (npc.pathIndex + 1) % npc.path.length;
          } else {
            toTarget.multiplyScalar(Math.min(1, (WALK_SPEED * deltaSeconds) / distance));
            npc.root.position.add(toTarget);
            const desiredYaw = Math.atan2(toTarget.x, toTarget.z);
            const delta = THREE.MathUtils.euclideanModulo(desiredYaw - npc.root.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
            npc.root.rotation.y += delta * Math.min(1, deltaSeconds * 6);
          }
          npc.root.position.y = heightAt(npc.root.position.x, npc.root.position.z);
        }
        bounds.center.copy(npc.root.position).y += 1;
        npc.pendingAnimation += deltaSeconds;
        npc.root.visible = frustum.intersectsSphere(bounds);
        if (!npc.root.visible) continue;
        npc.mixer.update(npc.pendingAnimation);
        npc.pendingAnimation = 0;
        if (npc.label) {
          const far = npc.root.position.distanceTo(camera.position);
          (npc.label.material as THREE.SpriteMaterial).opacity = THREE.MathUtils.clamp((34 - far) / 10, 0, 1);
        }
      }
    },
  };
}

/** Seat → a seated NPC spec (chairs face the table; the model sits facing the same way). */
export function seatedAt(seat: Seat, model: NpcModel, name?: string, nameColor?: string): NpcSpec {
  return {
    model,
    position: seat.position.clone(),
    yaw: seat.yaw,
    clip: "Sit_Chair_Idle",
    bareHead: true,
    ...(name ? { name } : {}),
    ...(nameColor ? { nameColor } : {}),
  };
}
