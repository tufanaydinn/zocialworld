import type * as THREE from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { PLAYER_AVATAR_MODELS, type PlayerAvatar, type PlayerAvatarModel } from "@project/shared";
import type { AssetManager } from "../assets/AssetManager.ts";
import { AVATAR_MODELS, loadPlayerAvatar, type NpcModel } from "../player/avatarModels.ts";

/**
 * KayKit avatars for players (ADR-014 § 11; high tier only for remote players — the
 * low tier keeps PlaceholderCharacter, ADR-008). ADR-015: the model is the player's
 * chosen (or default) `PlayerAvatar.model`, so every client — including the player's own — shows
 * the same character. The onboarding preview and the local player use the same library, so a model
 * is loaded and merged once per page.
 *
 * Each of the five models is loaded once, through the same path as the local avatar
 * (`loadPlayerAvatar`: hidden props, scaled, merged into ONE skinned mesh), with no shadow-map
 * casting. Every instance then gets a SkeletonUtils clone of that template: its own bones
 * and mixer, but the merged geometry and material are shared — so a player costs one draw call
 * and no new GPU buffers. Shared resources are never disposed per player.
 */

export interface RemoteAvatar {
  readonly model: THREE.Object3D;
  readonly clips: THREE.AnimationClip[];
  readonly modelName: NpcModel;
}

/**
 * The pre-ADR-015 mapping: the model a session appeared as, from its colorSeed. Kept because the
 * default avatar (`defaultPlayerAvatar` in @project/shared) must keep giving every player exactly
 * this model — remoteAvatars.test.ts holds the two together.
 */
export function avatarModelFor(colorSeed: number): NpcModel {
  const index = Math.abs(Math.trunc(Number.isFinite(colorSeed) ? colorSeed : 0)) % AVATAR_MODELS.length;
  return AVATAR_MODELS[index]!;
}

/** The KayKit model for a wire model id (PLAYER_AVATAR_MODELS and AVATAR_MODELS share their order). */
export function npcModelFor(model: PlayerAvatarModel): NpcModel {
  const index = PLAYER_AVATAR_MODELS.indexOf(model);
  return AVATAR_MODELS[index < 0 ? 0 : index]!;
}

/** Display names for the character picker. */
export const AVATAR_MODEL_LABELS: Readonly<Record<PlayerAvatarModel, string>> = {
  rogue_hooded: "Hooded Rogue",
  rogue: "Rogue",
  knight: "Knight",
  mage: "Mage",
  barbarian: "Barbarian",
};

export class RemoteAvatarLibrary {
  private readonly assets: AssetManager;
  private readonly templates = new Map<NpcModel, Promise<{ model: THREE.Object3D; clips: THREE.AnimationClip[] }>>();

  constructor(assets: AssetManager) {
    this.assets = assets;
  }

  /** A fresh, independently animated instance of `avatar`'s model. Rejects when the model cannot load (the caller keeps the placeholder). */
  async instantiate(avatar: Pick<PlayerAvatar, "model">): Promise<RemoteAvatar> {
    const modelName = npcModelFor(avatar.model);
    let template = this.templates.get(modelName);
    if (!template) {
      template = loadPlayerAvatar(this.assets, modelName, { castShadow: false });
      this.templates.set(modelName, template);
      template.catch(() => this.templates.delete(modelName)); // a later spawn may retry
    }
    const { model, clips } = await template;
    return { model: cloneSkeleton(model), clips, modelName };
  }
}
