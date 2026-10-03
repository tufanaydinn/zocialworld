import * as THREE from "three";
import { HIP_HEIGHT, type ProceduralRig } from "./PlaceholderCharacter.ts";

/**
 * The animation states every character — local or remote, placeholder
 * or final art — is expected to support. The Character Agent should
 * extend this list rather than inventing a parallel state concept.
 */
export type PlayerAnimationState = "idle" | "walk" | "jog" | "sit" | "wave" | "talk";

const CLIP_NAME_BY_STATE: Record<PlayerAnimationState, string> = {
  idle: "Idle",
  walk: "Walk",
  jog: "Jog",
  sit: "Sit",
  wave: "Wave",
  talk: "Talk",
};

const CROSSFADE_SECONDS = 0.25;

/**
 * Drives a character's visible motion from a logical `PlayerAnimationState`.
 *
 * Two backends are supported behind the same public API:
 *
 *  - **Procedural** (`useProceduralRig`): swings the placeholder
 *    character's primitive limbs by hand. Used until real art exists.
 *  - **Clip-driven** (`useAnimationClips`): a standard
 *    `THREE.AnimationMixer` crossfading between named clips
 *    (Idle/Walk/Jog/Sit/Wave/Talk). Used once a GLB with real
 *    animations is loaded via `LocalPlayer.setModel()`.
 *
 * Callers (PlayerController, and later RemotePlayer) only ever call
 * `setState()` and `update()` — they never need to know which backend
 * is active.
 */
export class PlayerAnimation {
  private state: PlayerAnimationState = "idle";

  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<PlayerAnimationState, THREE.AnimationAction>();

  private proceduralRig: ProceduralRig | null = null;
  private proceduralClock = 0;

  /** Switches to clip-driven playback using clips named per `CLIP_NAME_BY_STATE`. Missing clips are silently skipped. */
  useAnimationClips(root: THREE.Object3D, clips: THREE.AnimationClip[]): void {
    this.proceduralRig = null;
    this.mixer = new THREE.AnimationMixer(root);
    this.actions.clear();

    for (const [state, clipName] of Object.entries(CLIP_NAME_BY_STATE) as [PlayerAnimationState, string][]) {
      const clip = THREE.AnimationClip.findByName(clips, clipName);
      if (!clip) continue;
      const action = this.mixer.clipAction(clip);
      if (state === "idle" || state === "walk" || state === "jog") {
        action.setLoop(THREE.LoopRepeat, Infinity);
      } else {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.actions.set(state, action);
    }

    this.actions.get(this.state)?.play();
  }

  /** Switches to the built-in procedural limb animation for the primitive placeholder character. */
  useProceduralRig(rig: ProceduralRig): void {
    this.mixer = null;
    this.actions.clear();
    this.proceduralRig = rig;
  }

  setState(next: PlayerAnimationState): void {
    if (next === this.state) return;

    if (this.mixer) {
      const nextAction = this.actions.get(next);
      const prevAction = this.actions.get(this.state);
      if (nextAction) {
        nextAction.reset().play();
        if (prevAction && prevAction !== nextAction) {
          nextAction.crossFadeFrom(prevAction, CROSSFADE_SECONDS, true);
        }
      }
    }

    this.state = next;
  }

  getState(): PlayerAnimationState {
    return this.state;
  }

  /** @param normalizedSpeed 0 (standing still) to 1 (full jog) — only used by the procedural backend to scale limb swing. */
  update(deltaSeconds: number, normalizedSpeed: number): void {
    if (this.mixer) {
      this.mixer.update(deltaSeconds);
      return;
    }

    if (this.proceduralRig) {
      this.updateProcedural(deltaSeconds, normalizedSpeed);
    }
  }

  private updateProcedural(deltaSeconds: number, normalizedSpeed: number): void {
    const rig = this.proceduralRig;
    if (!rig) return;

    if (this.state === "walk" || this.state === "jog") {
      const cadence = this.state === "jog" ? 9 : 6;
      this.proceduralClock += deltaSeconds * cadence;
      const swing = Math.sin(this.proceduralClock) * 0.55 * Math.max(normalizedSpeed, 0.35);
      rig.leftLeg.rotation.x = swing;
      rig.rightLeg.rotation.x = -swing;
      rig.leftArm.rotation.x = -swing * 0.8;
      rig.rightArm.rotation.x = swing * 0.8;
      rig.torso.position.y = HIP_HEIGHT + Math.abs(Math.sin(this.proceduralClock * 2)) * 0.015;
    } else if (this.state === "wave") {
      this.proceduralClock += deltaSeconds * 10;
      rig.rightArm.rotation.x = -2.2;
      rig.rightArm.rotation.z = Math.sin(this.proceduralClock) * 0.4;
      this.decayToRest(rig, deltaSeconds, { skipRightArm: true });
    } else if (this.state === "talk") {
      this.proceduralClock += deltaSeconds * 4;
      rig.head.rotation.y = Math.sin(this.proceduralClock) * 0.12;
      this.decayToRest(rig, deltaSeconds, { skipHead: true });
    } else if (this.state === "sit") {
      rig.leftLeg.rotation.x = -1.2;
      rig.rightLeg.rotation.x = -1.2;
      rig.torso.position.y = HIP_HEIGHT - 0.25;
    } else {
      // idle: gentle breathing bob, everything else eases back to rest.
      this.proceduralClock += deltaSeconds * 1.5;
      rig.torso.position.y = HIP_HEIGHT + Math.sin(this.proceduralClock) * 0.01;
      this.decayToRest(rig, deltaSeconds, {});
    }
  }

  private decayToRest(
    rig: ProceduralRig,
    deltaSeconds: number,
    opts: { skipRightArm?: boolean; skipHead?: boolean },
  ): void {
    const t = Math.min(1, deltaSeconds * 8);
    rig.leftLeg.rotation.x = THREE.MathUtils.lerp(rig.leftLeg.rotation.x, 0, t);
    rig.rightLeg.rotation.x = THREE.MathUtils.lerp(rig.rightLeg.rotation.x, 0, t);
    rig.leftArm.rotation.x = THREE.MathUtils.lerp(rig.leftArm.rotation.x, 0, t);
    if (!opts.skipRightArm) {
      rig.rightArm.rotation.x = THREE.MathUtils.lerp(rig.rightArm.rotation.x, 0, t);
      rig.rightArm.rotation.z = THREE.MathUtils.lerp(rig.rightArm.rotation.z, 0, t);
    }
    if (!opts.skipHead) {
      rig.head.rotation.y = THREE.MathUtils.lerp(rig.head.rotation.y, 0, t);
    }
  }
}
