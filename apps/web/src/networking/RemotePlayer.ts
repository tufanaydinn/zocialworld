import * as THREE from "three";
import { createPlaceholderCharacter } from "../player/PlaceholderCharacter.ts";
import { PlayerAnimation, type PlayerAnimationState } from "../player/PlayerAnimation.ts";
import { InterpolationBuffer, RENDER_DELAY_MS } from "./interpolation.ts";
import type { AnimationState } from "@project/shared";

export interface RemotePlayerPose {
  x: number;
  y: number;
  z: number;
  rotationY: number;
  animationState: AnimationState;
}

/**
 * The networked counterpart to LocalPlayer — same visual composition
 * (a model + PlayerAnimation), but driven by the interpolation buffer
 * instead of PlayerController. A RemotePlayer must never read keyboard
 * input and must never be pushed through CollisionSystem — its
 * transform comes entirely from the network (see ADR-001:
 * client-authoritative movement, and apps/web/src/networking/README's
 * sibling doc docs/protocols/multiplayer-protocol.md).
 *
 * Reuses createPlaceholderCharacter()/PlayerAnimation verbatim (no
 * duplicated character-building code) — the only addition is a
 * deterministic accent-color tint per CORE-002 §13, purely so testers
 * can tell concurrent players apart.
 */
export class RemotePlayer {
  readonly object = new THREE.Group();
  readonly animation = new PlayerAnimation();
  readonly playerId: string;
  /** Mutable (CORE-003): a session's nickname can change post-join via `set_nickname` — see `setNickname()`. */
  nickname: string;
  /** Stable for the lifetime of this session — only ever read, e.g. for the CORE-003 player context card's accent swatch. */
  readonly colorSeed: number;

  /** Approximate head height above the feet, for nameplate projection — matches PlaceholderCharacter's proportions closely enough for a label. */
  readonly headHeight = 1.65;

  private readonly buffer = new InterpolationBuffer();
  private latestAnimationState: PlayerAnimationState = "idle";
  /** CORE-004: driven by VoiceSession's speaking-state events, not the network transform — see `setSpeaking()`. */
  private speaking = false;

  constructor(playerId: string, nickname: string, colorSeed: number, initialPose: RemotePlayerPose) {
    this.playerId = playerId;
    this.nickname = nickname;
    this.colorSeed = colorSeed;
    this.object.name = `RemotePlayer:${nickname}`;

    const accentColor = new THREE.Color().setHSL(colorSeed / 360, 0.55, 0.5);
    const rig = createPlaceholderCharacter({ accentColor });
    this.object.add(rig.root);
    this.animation.useProceduralRig(rig);

    this.object.position.set(initialPose.x, initialPose.y, initialPose.z);
    this.object.rotation.y = initialPose.rotationY;
    this.latestAnimationState = initialPose.animationState;
    this.animation.setState(initialPose.animationState);

    this.buffer.push({ t: performance.now(), x: initialPose.x, y: initialPose.y, z: initialPose.z, rotationY: initialPose.rotationY });
  }

  /** Called whenever a `player_transform` for this player arrives. Never applied directly to `object.position` — it only feeds the interpolation buffer (see interpolation.ts for why: naive `object.position = received` teleports between the ~10 Hz network updates). */
  receiveTransform(pose: RemotePlayerPose): void {
    this.buffer.push({ t: performance.now(), x: pose.x, y: pose.y, z: pose.z, rotationY: pose.rotationY });
    this.latestAnimationState = pose.animationState;
  }

  /** CORE-003: applies a server-confirmed `nickname_updated` for this player. Does not touch the nameplate DOM directly — see `RemotePlayerManager.updateNickname()`, which owns that. */
  setNickname(nickname: string): void {
    this.nickname = nickname;
    this.object.name = `RemotePlayer:${nickname}`;
  }

  /** CORE-004: VoiceSession's active-speaker state for this player — see `effectiveAnimationState()` for how this affects the talk animation. */
  setSpeaking(speaking: boolean): void {
    this.speaking = speaking;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Call once per rendered frame. */
  update(deltaSeconds: number): void {
    const renderTime = performance.now() - RENDER_DELAY_MS;
    const sample = this.buffer.sample(renderTime);
    if (sample) {
      this.object.position.set(sample.x, sample.y, sample.z);
      this.object.rotation.y = sample.rotationY;
    }

    this.animation.setState(this.effectiveAnimationState());
    // Remote players don't carry an explicit speed value over the wire;
    // 1 gives the procedural walk/jog cycle its full swing amplitude
    // whenever that state is active, which reads fine for a placeholder
    // character — see PlayerAnimation's own speed clamping.
    this.animation.update(deltaSeconds, 1);
  }

  /**
   * CORE-004 §21 animation-state priority: movement always wins. Voice
   * activity only ever promotes "idle" to "talk" — it never overrides
   * walk/jog/sit/wave, which would look wrong (e.g. a running character
   * suddenly head-bobbing mid-stride). This is deliberately the
   * simplest documented policy that satisfies "do not blindly overwrite
   * walk/jog if that looks wrong."
   */
  private effectiveAnimationState(): PlayerAnimationState {
    if (this.speaking && this.latestAnimationState === "idle") return "talk";
    return this.latestAnimationState;
  }

  get headPosition(): THREE.Vector3 {
    return this.object.position.clone().setY(this.object.position.y + this.headHeight);
  }
}
