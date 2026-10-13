import * as THREE from "three";
import type { AnimationState } from "@project/shared";
import { HIP_HEIGHT, type ProceduralRig } from "./PlaceholderCharacter.ts";
import { EmoteBoneLayer } from "./emoteLayer.ts";

/**
 * The animation states every character — local or remote, placeholder
 * or final art — is expected to support: exactly the networked
 * `ANIMATION_STATES` (packages/shared), so a new state cannot be added on
 * one side only. `dance` and `cheer` are the emote-wheel
 * states (ADR-014 § 10).
 */
export type PlayerAnimationState = AnimationState;

/** Clip names the clip backend looks for (loadPlayerAvatar renames the KayKit clips to these). */
export type AvatarClipName = "Idle" | "Walk" | "Jog" | "Sit" | "Cheer";
const AVATAR_CLIPS: readonly AvatarClipName[] = ["Idle", "Walk", "Jog", "Sit", "Cheer"];
const LOOPING_CLIPS = new Set<AvatarClipName>(["Idle", "Walk", "Jog", "Sit", "Cheer"]);

/**
 * The clip a rigged avatar plays for a state (WATCH_HALL.md). Wave, dance, a seated cheer and
 * the raised hand are procedural bone layers on top of it (emoteLayer.ts), so an emote works
 * standing (over Idle) and seated (over Sit). The KayKit pack has no talk clip: talking is Idle.
 */
export function baseClipFor(state: PlayerAnimationState, seated: boolean): AvatarClipName {
  if (state === "walk") return "Walk";
  if (state === "jog") return "Jog";
  if (state === "sit" || seated) return "Sit";
  if (state === "cheer") return "Cheer";
  return "Idle";
}

/** Which procedural layers a state shows on top of its clip (the raised hand is a separate flag). */
export function emoteLayersFor(state: PlayerAnimationState, seated: boolean): { wave: boolean; dance: boolean; cheer: boolean } {
  const moving = state === "walk" || state === "jog";
  return {
    wave: state === "wave",
    dance: state === "dance",
    // Standing, the Cheer clip does it; seated, both arms go up over the Sit clip.
    cheer: state === "cheer" && seated && !moving,
  };
}

const CROSSFADE_SECONDS = 0.25;

export interface AnimationClipOptions {
  /** 0..1: offsets the looping clips' start so a crowd of the same model never breathes in unison. */
  readonly phase?: number;
}

/**
 * Drives a character's visible motion from a logical `PlayerAnimationState`.
 *
 * Two backends are supported behind the same public API:
 *
 *  - **Procedural** (`useProceduralRig`): swings the placeholder
 *    character's primitive limbs by hand (low tier, and until a model loads).
 *  - **Clip-driven** (`useAnimationClips`): a standard
 *    `THREE.AnimationMixer` crossfading between named clips
 *    (Idle/Walk/Jog/Sit/Cheer, see `baseClipFor`), plus the procedural
 *    emote layers (`EmoteBoneLayer`) for wave, dance, a seated cheer and the
 *    raised hand.
 *
 * Callers (PlayerController, RemotePlayer) only ever call `setState()`,
 * `setSeated()`, `setHandRaised()` and `update()` — they never need to know
 * which backend is active.
 */
export class PlayerAnimation {
  private state: PlayerAnimationState = "idle";
  private seated = false;
  private handRaised = false;

  private mixer: THREE.AnimationMixer | null = null;
  private readonly actions = new Map<AvatarClipName, THREE.AnimationAction>();
  private currentClip: AvatarClipName | null = null;
  private layer: EmoteBoneLayer | null = null;

  private proceduralRig: ProceduralRig | null = null;
  private proceduralClock = 0;
  private emoteClock = 0;

  /** Switches to clip-driven playback using clips named per `AvatarClipName`. Missing clips are silently skipped. */
  useAnimationClips(root: THREE.Object3D, clips: THREE.AnimationClip[], options: AnimationClipOptions = {}): void {
    this.proceduralRig = null;
    // A previous model's mixer (a character change swaps models) releases its cached bindings.
    const previous = this.mixer;
    previous?.stopAllAction();
    if (previous) previous.uncacheRoot(previous.getRoot());
    this.mixer = new THREE.AnimationMixer(root);
    this.actions.clear();
    this.currentClip = null;

    for (const name of AVATAR_CLIPS) {
      const clip = THREE.AnimationClip.findByName(clips, name);
      if (!clip) continue;
      const action = this.mixer.clipAction(clip);
      if (LOOPING_CLIPS.has(name)) {
        action.setLoop(THREE.LoopRepeat, Infinity);
      } else {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.actions.set(name, action);
    }

    // Aim the emote layer's arm poses from the Idle pose (stop() rewinds the action, so phases are set after).
    const idle = this.actions.get("Idle");
    if (idle) {
      idle.play();
      this.mixer.update(0);
      idle.stop();
    }
    this.layer = EmoteBoneLayer.tryCreate(root);
    if (options.phase !== undefined) {
      for (const [name, action] of this.actions) if (LOOPING_CLIPS.has(name)) action.time = (options.phase % 1) * action.getClip().duration;
    }
    this.playClip(baseClipFor(this.state, this.seated), false);
  }

  /** Switches to the built-in procedural limb animation for the primitive placeholder character. */
  useProceduralRig(rig: ProceduralRig): void {
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.actions.clear();
    this.currentClip = null;
    this.layer = null;
    this.proceduralRig = rig;
  }

  setState(next: PlayerAnimationState): void {
    if (next === this.state) return;
    this.state = next;
    this.syncClip();
  }

  getState(): PlayerAnimationState {
    return this.state;
  }

  /** The character is seated (Sit clip / seated placeholder pose) — emotes then keep to the upper body. */
  setSeated(seated: boolean): void {
    if (seated === this.seated) return;
    this.seated = seated;
    this.syncClip();
  }

  get isSeated(): boolean {
    return this.seated || this.state === "sit";
  }

  /** The raised-hand arm override (HallStore.hands), shown in any state. */
  setHandRaised(raised: boolean): void {
    this.handRaised = raised;
  }

  get isHandRaised(): boolean {
    return this.handRaised;
  }

  /** The clip the mixer is playing (null on the procedural backend). For tests and debugging. */
  get clip(): AvatarClipName | null {
    return this.currentClip;
  }

  /** Stops the mixer (a disposed character). */
  dispose(): void {
    this.mixer?.stopAllAction();
    const root = this.mixer?.getRoot();
    if (root) this.mixer?.uncacheRoot(root);
    this.mixer = null;
    this.actions.clear();
    this.layer = null;
    this.proceduralRig = null;
  }

  /** @param normalizedSpeed 0 (standing still) to 1 (full jog) — only used by the procedural backend to scale limb swing. */
  update(deltaSeconds: number, normalizedSpeed: number): void {
    if (this.mixer) {
      this.layer?.restore();
      this.mixer.update(deltaSeconds);
      if (this.layer) {
        const seated = this.isSeated;
        this.layer.apply(deltaSeconds, { seated, ...emoteLayersFor(this.state, seated), hand: this.handRaised });
      }
      return;
    }

    if (this.proceduralRig) {
      this.updateProcedural(deltaSeconds, normalizedSpeed);
    }
  }

  private syncClip(): void {
    if (this.mixer) this.playClip(baseClipFor(this.state, this.seated), true);
  }

  private playClip(name: AvatarClipName, crossfade: boolean): void {
    if (name === this.currentClip) return;
    const next = this.actions.get(name) ?? this.actions.get("Idle");
    if (!next) return;
    const previous = this.currentClip ? this.actions.get(this.currentClip) : undefined;
    this.currentClip = name;
    if (previous === next) return;
    const time = next.time;
    next.reset().play();
    if (LOOPING_CLIPS.has(name)) next.time = time; // keep the desynchronised phase
    if (previous) {
      if (crossfade) next.crossFadeFrom(previous, CROSSFADE_SECONDS, true);
      else previous.stop();
    }
  }

  private updateProcedural(deltaSeconds: number, normalizedSpeed: number): void {
    const rig = this.proceduralRig;
    if (!rig) return;
    const state = this.state;
    const moving = state === "walk" || state === "jog";
    const seated = !moving && this.isSeated;
    const t = Math.min(1, deltaSeconds * 8);
    const ease = (value: number, target: number): number => THREE.MathUtils.lerp(value, target, t);
    const emote = state === "wave" || state === "cheer" || state === "dance";
    this.emoteClock = emote || this.handRaised ? this.emoteClock + deltaSeconds : 0;
    const beat = this.emoteClock * Math.PI * 4; // 2 beats per second

    // Legs and hips.
    let torsoY = HIP_HEIGHT;
    let armSwing = 0;
    if (moving) {
      const cadence = state === "jog" ? 9 : 6;
      this.proceduralClock += deltaSeconds * cadence;
      const swing = Math.sin(this.proceduralClock) * 0.55 * Math.max(normalizedSpeed, 0.35);
      rig.leftLeg.rotation.x = swing;
      rig.rightLeg.rotation.x = -swing;
      armSwing = swing;
      torsoY = HIP_HEIGHT + Math.abs(Math.sin(this.proceduralClock * 2)) * 0.015;
    } else if (seated) {
      rig.leftLeg.rotation.x = -1.2;
      rig.rightLeg.rotation.x = -1.2;
      torsoY = HIP_HEIGHT - 0.25;
    } else {
      rig.leftLeg.rotation.x = ease(rig.leftLeg.rotation.x, 0);
      rig.rightLeg.rotation.x = ease(rig.rightLeg.rotation.x, 0);
      this.proceduralClock += deltaSeconds * 1.5;
      torsoY = HIP_HEIGHT + Math.sin(this.proceduralClock) * 0.01;
    }
    if (state === "dance") torsoY += (seated ? 0.012 : 0.05) * Math.abs(Math.sin(beat / 2));
    if (state === "cheer" && !seated) torsoY += 0.04 * Math.abs(Math.sin(beat * 0.9));
    rig.torso.position.y = torsoY;
    rig.torso.rotation.z = state === "dance" ? 0.12 * Math.sin(beat / 2) : ease(rig.torso.rotation.z, 0);
    rig.torso.rotation.y = state === "dance" && !seated ? 0.2 * Math.sin(beat / 2) : ease(rig.torso.rotation.y, 0);

    // Arms: walk swing < dance pumps < cheer < raised hand < wave (right arm).
    let leftX = moving ? -armSwing * 0.8 : 0;
    let rightX = moving ? armSwing * 0.8 : 0;
    let leftZ = 0;
    let rightZ = 0;
    if (!moving && state === "dance") {
      leftX = -1.5 - 0.6 * Math.sin(beat);
      rightX = -1.5 + 0.6 * Math.sin(beat);
      leftZ = 0.35;
      rightZ = -0.35;
    }
    if (!moving && state === "cheer") {
      leftX = -2.75 + 0.25 * Math.sin(beat * 1.1);
      rightX = -2.75 + 0.25 * Math.sin(beat * 1.1 + 1);
      leftZ = 0.3;
      rightZ = -0.3;
    }
    if (this.handRaised) {
      rightX = -2.95;
      rightZ = -0.12 + 0.06 * Math.sin(this.emoteClock * 2);
    }
    if (!moving && state === "wave") {
      rightX = -2.2;
      rightZ = Math.sin(this.emoteClock * 10) * 0.4;
    }
    const snap = emote || this.handRaised || moving;
    rig.leftArm.rotation.x = snap ? leftX : ease(rig.leftArm.rotation.x, leftX);
    rig.rightArm.rotation.x = snap ? rightX : ease(rig.rightArm.rotation.x, rightX);
    rig.leftArm.rotation.z = ease(rig.leftArm.rotation.z, leftZ);
    rig.rightArm.rotation.z = state === "wave" || this.handRaised ? rightZ : ease(rig.rightArm.rotation.z, rightZ);

    // Head: talk shakes, dance nods.
    if (state === "talk") {
      this.proceduralClock += deltaSeconds * 4;
      rig.head.rotation.y = Math.sin(this.proceduralClock) * 0.12;
    } else {
      rig.head.rotation.y = ease(rig.head.rotation.y, 0);
    }
    rig.head.rotation.x = state === "dance" ? 0.14 * Math.sin(beat) : ease(rig.head.rotation.x, 0);
  }
}
