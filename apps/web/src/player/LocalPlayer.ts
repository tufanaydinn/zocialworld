import * as THREE from "three";
import { createPlaceholderCharacter, placeholderAccent, setPlaceholderAccent, setPlaceholderLift } from "./PlaceholderCharacter.ts";
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
  private readonly placeholderRoot: THREE.Object3D;

  constructor() {
    this.object.name = "LocalPlayer";

    const placeholder = createPlaceholderCharacter();
    this.modelRoot = placeholder.root;
    this.placeholderRoot = placeholder.root;
    this.object.add(this.modelRoot);
    this.animation.useProceduralRig(placeholder);
  }

  /**
   * Replaces the visible model. Call it once the rigged model has loaded, e.g.:
   *
   *   const { scene, animations } = await assetManager.instantiate("/assets/characters/builder.glb");
   *   localPlayer.setModel(scene, animations);
   *
   * PlayerController, CollisionSystem and the camera are untouched by this call.
   */
  setModel(model: THREE.Object3D, animations: THREE.AnimationClip[] = []): void {
    if (model === this.modelRoot) return;
    const previous = this.modelRoot;
    this.object.remove(previous);
    this.modelRoot = model;
    this.object.add(this.modelRoot);

    if (animations.length > 0) {
      this.animation.useAnimationClips(model, animations);
    }
    // Changing character mid-session: a replaced rigged model frees its own skeleton
    // (bone texture). Its geometry and material are shared avatar templates and stay.
    if (previous !== this.placeholderRoot) disposeSkeletons(previous);
  }

  /**
   * ADR-015: the player's palette colour on the placeholder's belt and hat (the low
   * tier, where the chosen model is not shown). Stored even while a rigged model is shown.
   */
  setAccent(color: THREE.ColorRepresentation): void {
    setPlaceholderAccent(this.placeholderRoot, color);
  }

  /** The placeholder's accent colour (tests and debugging). */
  get accentColor(): THREE.Color | null {
    return placeholderAccent(this.placeholderRoot);
  }

  /** Whether a rigged model replaced the placeholder. */
  get isRigged(): boolean {
    return this.modelRoot !== this.placeholderRoot;
  }

  /**
   * The warm emissive lift for the placeholder inside the Watch Hall (the low tier has no point
   * lights there). A no-op once a real model replaced the placeholder.
   */
  setHallLift(on: boolean, intensity = 0.35): void {
    if (this.modelRoot === this.placeholderRoot) setPlaceholderLift(this.placeholderRoot, on ? intensity : 0);
  }

  get position(): THREE.Vector3 {
    return this.object.position;
  }
}

function disposeSkeletons(root: THREE.Object3D): void {
  const skeletons = new Set<THREE.Skeleton>();
  root.traverse((object) => {
    if ((object as THREE.SkinnedMesh).isSkinnedMesh) skeletons.add((object as THREE.SkinnedMesh).skeleton);
  });
  for (const skeleton of skeletons) skeleton.dispose();
}
