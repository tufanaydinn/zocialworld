import * as THREE from "three";
import { createPlaceholderCharacter } from "./PlaceholderCharacter.ts";
import { PlayerAnimation } from "./PlayerAnimation.ts";

/**
 * LocalPlayer is the player entity driven by this browser's own input.
 *
 * It is deliberately kept separate from the (not-yet-implemented)
 * `RemotePlayer` concept described in `src/networking/README.md`: a
 * future RemotePlayer will share the same `model` + `PlayerAnimation`
 * composition, but will be driven by interpolated network state instead
 * of `PlayerController`. Keeping the visual/animation half (this class)
 * decoupled from the input/physics half (`PlayerController`) is what
 * makes that split possible without rewriting either.
 */
export class LocalPlayer {
  /** World-space root. Position/rotation here IS the authoritative player transform. */
  readonly object = new THREE.Group();

  readonly animation = new PlayerAnimation();

  /** Collision radius in meters, used by CollisionSystem and ThirdPersonCamera. */
  radius = 0.35;

  /** Approximate eye/shoulder height, used by the camera to aim above the feet. */
  height = 1.7;

  private modelRoot: THREE.Object3D;

  constructor() {
    this.object.name = "LocalPlayer";

    const placeholder = createPlaceholderCharacter();
    this.modelRoot = placeholder.root;
    this.object.add(this.modelRoot);
    this.animation.useProceduralRig(placeholder);
  }

  /**
   * Replaces the visible model. Intended for the Character Agent to call
   * once real character art exists, e.g.:
   *
   *   const { scene, animations } = await assetManager.instantiate("/assets/characters/builder.glb");
   *   localPlayer.setModel(scene, animations);
   *
   * PlayerController, CollisionSystem and the camera are untouched by this call.
   */
  setModel(model: THREE.Object3D, animations: THREE.AnimationClip[] = []): void {
    this.object.remove(this.modelRoot);
    this.modelRoot = model;
    this.object.add(this.modelRoot);

    if (animations.length > 0) {
      this.animation.useAnimationClips(model, animations);
    }
  }

  get position(): THREE.Vector3 {
    return this.object.position;
  }
}
