import * as THREE from "three";
import { createPlaceholderCharacter, placeholderAccent, setPlaceholderAccent, setPlaceholderLift } from "../player/PlaceholderCharacter.ts";
import { avatarColor } from "../player/avatarPalette.ts";
import { locationAt } from "../world/locations.ts";
import { PlayerAnimation, type PlayerAnimationState } from "../player/PlayerAnimation.ts";
import { blobShadow } from "../player/avatarModels.ts";
import { InterpolationBuffer, RENDER_DELAY_MS, type InterpolatedTransform, type TransformSample } from "./interpolation.ts";
import { animationInterval, animationPhase, animationStepDue } from "./animationLod.ts";
import type { PlaceholderCrowd, PlaceholderCrowdEntry } from "../player/PlaceholderCrowd.ts";
import type { AnimationState, PlayerAvatar, PlayerAvatarModel } from "@project/shared";

/**
 * Senders skip unchanged poses (docs/protocols/multiplayer-protocol.md § Network
 * rate), so after a pause the newest buffered sample can be seconds old. When a transform arrives
 * after a gap longer than this, the previous pose is re-anchored one network tick earlier, so the
 * first step interpolates over one tick instead of snapping.
 */
const RESUME_GAP_MS = 250;
const NETWORK_TICK_MS = 100;
/** Head height of a seated character (Sit clip / seated placeholder), so the nameplate stays on the head. */
const SEATED_HEAD_HEIGHT = 1.3;
/** Emissive lift of the placeholder inside the Watch Hall (no point lights on the low tier; see setPlaceholderLift). */
export const HALL_PLACEHOLDER_LIFT = 0.35;

export interface RemotePlayerPose {
  x: number;
  y: number;
  z: number;
  rotationY: number;
  animationState: AnimationState;
}

export interface RemotePlayerOptions {
  /** Draws the placeholder as part of the instanced crowd (RemotePlayerManager's), not as its own meshes. */
  readonly crowd?: PlaceholderCrowd | null;
}

/**
 * The networked counterpart to LocalPlayer — same visual composition
 * (a model + PlayerAnimation), but driven by the interpolation buffer
 * instead of PlayerController. A RemotePlayer must never read keyboard
 * input and must never be pushed through CollisionSystem — its
 * transform comes entirely from the network (see ADR-005:
 * client-authoritative movement, and apps/web/src/networking/README's
 * sibling doc docs/protocols/multiplayer-protocol.md).
 *
 * It starts as createPlaceholderCharacter() in the player's avatar palette
 * colour (ADR-015). On the high tier
 * (ADR-014 § 11) `setModel()` swaps in the player's KayKit
 * avatar from RemoteAvatarLibrary once it has loaded — one merged skinned
 * draw, no shadow-map casting, a blob shadow — and disposes the placeholder;
 * a later `avatar_updated` swaps it again (`setAvatar` + `setModel`). The
 * Watch Hall adds two presentation flags from HallStore: seated (emotes over
 * the Sit clip) and a raised hand.
 */
export class RemotePlayer {
  readonly object = new THREE.Group();
  readonly animation = new PlayerAnimation();
  readonly playerId: string;
  /** Mutable: a session's nickname can change post-join via `set_nickname` — see `setNickname()`. */
  nickname: string;
  /** Stable for the lifetime of this session (animation phase, the default avatar). */
  readonly colorSeed: number;
  /** ADR-015: the player's current look (from presence / `avatar_updated`). */
  avatar: PlayerAvatar;
  /** ADR-015: whether this player can receive ZEC privately — the only wallet-derived bit any peer gets. Shown only in the player menu. */
  canReceive: boolean;
  /** Which model the rigged avatar currently shows (null while the placeholder shows). For tests and debugging. */
  loadedModel: PlayerAvatarModel | null = null;

  /** Approximate head height above the feet, for nameplate projection — matches PlaceholderCharacter's proportions closely enough for a label. */
  readonly headHeight = 1.65;

  private readonly buffer = new InterpolationBuffer();
  private lastSample: TransformSample;
  private latestAnimationState: PlayerAnimationState = "idle";
  /** Driven by VoiceSession's speaking-state events, not the network transform — see `setSpeaking()`. */
  private speaking = false;
  private modelRoot: THREE.Object3D;
  private shadow: THREE.Mesh | null = null;
  private rigged = false;
  private disposed = false;
  /** Animation time not yet applied while this player was culled (applied in one step when visible again). */
  private pendingAnimation = 0;
  /** Whether the placeholder currently has the Watch Hall's warm emissive lift. */
  private lifted = false;
  /** The placeholder rig root (kept until a rigged model replaces it). */
  private readonly placeholderRoot: THREE.Object3D;
  /** The instanced crowd that draws the placeholder (null: the rig's own meshes draw it). */
  private readonly crowd: PlaceholderCrowd | null;
  private readonly crowdEntry: PlaceholderCrowdEntry | null;
  /**
   * Nothing under this player changed since three last computed its matrices (no movement, no
   * animation step, no new model). three then skips the player's whole subtree in its per-frame matrix update and
   * the skeleton's bone texture is not rebuilt — the matrices it would compute are the ones it already has.
   */
  private frozen = false;
  private matricesDirty = true;
  private readonly sampleScratch: InterpolatedTransform = { x: 0, y: 0, z: 0, rotationY: 0 };

  constructor(playerId: string, nickname: string, colorSeed: number, initialPose: RemotePlayerPose, avatar: PlayerAvatar, canReceive = false, options: RemotePlayerOptions = {}) {
    this.playerId = playerId;
    this.nickname = nickname;
    this.colorSeed = colorSeed;
    this.avatar = { ...avatar };
    this.canReceive = canReceive;
    this.object.name = `RemotePlayer:${nickname}`;
    const updateMatrixWorld = this.object.updateMatrixWorld.bind(this.object);
    this.object.updateMatrixWorld = (force?: boolean): void => {
      if (!this.frozen) updateMatrixWorld(force);
    };

    const rig = createPlaceholderCharacter({ accentColor: avatarColor(avatar.color) });
    this.placeholderRoot = rig.root;
    this.modelRoot = rig.root;
    this.object.add(rig.root);
    this.animation.useProceduralRig(rig);
    this.crowd = options.crowd ?? null;
    this.crowdEntry = this.crowd ? { rig, visible: () => this.object.visible && this.object.parent !== null } : null;
    if (this.crowdEntry) this.crowd?.add(this.crowdEntry);
    // Players at the same distance step their animation on different frames (animationLod.ts).
    this.pendingAnimation = animationPhase(colorSeed, 1 / 15);

    this.object.position.set(initialPose.x, initialPose.y, initialPose.z);
    this.object.rotation.y = initialPose.rotationY;
    this.latestAnimationState = initialPose.animationState;
    this.animation.setState(initialPose.animationState);

    this.lastSample = { t: performance.now(), x: initialPose.x, y: initialPose.y, z: initialPose.z, rotationY: initialPose.rotationY };
    this.buffer.push(this.lastSample);
  }

  /** Called whenever a `player_transform` for this player arrives. Never applied directly to `object.position` — it only feeds the interpolation buffer (see interpolation.ts for why: naive `object.position = received` teleports between the ~10 Hz network updates). */
  receiveTransform(pose: RemotePlayerPose): void {
    const now = performance.now();
    if (now - this.lastSample.t > RESUME_GAP_MS) this.buffer.push({ ...this.lastSample, t: now - NETWORK_TICK_MS });
    this.lastSample = { t: now, x: pose.x, y: pose.y, z: pose.z, rotationY: pose.rotationY };
    this.buffer.push(this.lastSample);
    this.latestAnimationState = pose.animationState;
  }

  /**
   * Replaces the placeholder with a rigged avatar (high tier). The model's geometry
   * and material are shared with other players (RemoteAvatarLibrary) and are never disposed here.
   * Ignored after `dispose()` (the model arrived after the player left).
   */
  setModel(model: THREE.Object3D, clips: THREE.AnimationClip[], modelName: PlayerAvatarModel = this.avatar.model): void {
    if (this.disposed) return;
    const previous = this.modelRoot;
    this.object.remove(previous);
    if (!this.rigged) this.releasePlaceholder();
    this.modelRoot = model;
    this.object.add(model);
    this.matricesDirty = true;
    // A frozen player (see `frozen`) keeps its bone matrices, so its bone texture needn't be rebuilt either.
    model.traverse((object) => {
      const skeleton = (object as THREE.SkinnedMesh).isSkinnedMesh ? (object as THREE.SkinnedMesh).skeleton : null;
      if (!skeleton) return;
      const updateSkeleton = skeleton.update.bind(skeleton);
      skeleton.update = (): void => {
        if (!this.frozen || skeleton.boneTexture === null) updateSkeleton();
      };
    });
    this.shadow ??= blobShadow();
    this.object.add(this.shadow);
    // A desynchronised phase per player: a hall full of the same model never breathes in unison.
    // useAnimationClips also re-creates the emote bone layer (wave, dance, raised hand) for the new skeleton;
    // the seated / hand-raised flags live on PlayerAnimation and carry over.
    this.animation.useAnimationClips(model, clips, { phase: ((this.colorSeed * 0.618034) % 1 + 1) % 1 });
    this.animation.setState(this.effectiveAnimationState());
    // A character change replaces a rigged clone — free its own skeleton (shared geometry/material stay).
    if (this.rigged) disposeSkeletons(previous);
    this.rigged = true;
    this.loadedModel = modelName;
  }

  /** Whether a rigged (KayKit) avatar has replaced the placeholder. */
  get isRigged(): boolean {
    return this.rigged;
  }

  /**
   * ADR-015 `avatar_updated`: stores the new look and recolours the placeholder accent (the hall glow
   * follows). Swapping the rigged model is RemotePlayerManager's job (it owns the avatar library).
   */
  setAvatar(avatar: PlayerAvatar): void {
    this.avatar = { ...avatar };
    if (!this.rigged) setPlaceholderAccent(this.placeholderRoot, avatarColor(avatar.color));
  }

  /** The placeholder's accent colour (null once a rigged model replaced it). For tests and debugging. */
  get accentColor(): THREE.Color | null {
    return this.rigged ? null : placeholderAccent(this.placeholderRoot);
  }

  /** The player holds a Watch Hall seat (HallStore) — emotes then play over the Sit pose. */
  setSeated(seated: boolean): void {
    this.animation.setSeated(seated);
  }

  /** The raised-hand arm override (HallStore.hands). */
  setHandRaised(raised: boolean): void {
    this.animation.setHandRaised(raised);
  }

  /** Applies a server-confirmed `nickname_updated` for this player. Does not touch the nameplate DOM directly — see `RemotePlayerManager.updateNickname()`, which owns that. */
  setNickname(nickname: string): void {
    this.nickname = nickname;
    this.object.name = `RemotePlayer:${nickname}`;
  }

  /** VoiceSession's active-speaker state for this player — see `effectiveAnimationState()` for how this affects the talk animation. */
  setSpeaking(speaking: boolean): void {
    this.speaking = speaking;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /**
   * Call once per rendered frame. `animate: false` (outside the active location, or off screen)
   * still moves the player but defers the animation work; the skipped time is applied in one step
   * when the player is animated again, so loops stay in phase. `cameraDistance`
   * (animationLod.ts): beyond 10 m the animation steps at a reduced rate, the time between steps
   * applied in each step.
   */
  update(deltaSeconds: number, animate = true, cameraDistance = 0, now = performance.now(), reducedDetail = false): void {
    const sample = this.buffer.sampleInto(now - RENDER_DELAY_MS, this.sampleScratch);
    let moved = false;
    if (sample) {
      const position = this.object.position;
      moved = position.x !== sample.x || position.y !== sample.y || position.z !== sample.z || this.object.rotation.y !== sample.rotationY;
      if (moved) {
        position.set(sample.x, sample.y, sample.z);
        this.object.rotation.y = sample.rotationY;
      }
    }

    if (!this.rigged) {
      const inHall = locationAt(this.object.position.x) === "hall";
      if (inHall !== this.lifted) {
        this.lifted = inHall;
        setPlaceholderLift(this.modelRoot, inHall ? HALL_PLACEHOLDER_LIFT : 0);
      }
    }

    const state = this.effectiveAnimationState();
    this.animation.setState(state);
    if (this.shadow) this.shadow.visible = !this.animation.isSeated; // the bench is under a seated player
    this.pendingAnimation += deltaSeconds;
    let stepped = false;
    if (animate && animationStepDue(this.pendingAnimation, animationInterval({ distance: cameraDistance, moving: state === "walk" || state === "jog", reduced: reducedDetail }))) {
      // Remote players don't carry an explicit speed value over the wire;
      // 1 gives the procedural walk/jog cycle its full swing amplitude
      // whenever that state is active, which reads fine for a placeholder
      // character — see PlayerAnimation's own speed clamping.
      this.animation.update(Math.min(this.pendingAnimation, 1), 1);
      this.pendingAnimation = 0;
      stepped = true;
    }
    this.frozen = !moved && !stepped && !this.matricesDirty;
    this.matricesDirty = false;
  }

  /** Whether three skips this player's matrices this frame (nothing under it changed). For tests and debugging. */
  get isFrozen(): boolean {
    return this.frozen;
  }

  /**
   * Animation-state priority: movement always wins. Voice
   * activity only ever promotes "idle" to "talk" — it never overrides
   * walk/jog/sit/wave/dance/cheer, which would look wrong (e.g. a running
   * character suddenly head-bobbing mid-stride). This is deliberately the
   * simplest documented policy that satisfies "do not blindly overwrite
   * walk/jog if that looks wrong."
   */
  private effectiveAnimationState(): PlayerAnimationState {
    if (this.speaking && this.latestAnimationState === "idle") return "talk";
    return this.latestAnimationState;
  }

  get headPosition(): THREE.Vector3 {
    return this.headPositionInto(new THREE.Vector3());
  }

  /** The nameplate anchor written into `target` (per-frame callers reuse one vector instead of allocating). */
  headPositionInto(target: THREE.Vector3): THREE.Vector3 {
    return target.copy(this.object.position).setY(this.object.position.y + (this.animation.isSeated ? SEATED_HEAD_HEIGHT : this.headHeight));
  }

  /** Hands the placeholder back: out of the crowd, its own geometries and materials freed. */
  private releasePlaceholder(): void {
    if (this.crowdEntry) this.crowd?.remove(this.crowdEntry);
    disposePlaceholder(this.placeholderRoot);
  }

  /**
   * Releases this player's own resources: the placeholder's geometries/materials, the mixer, and a
   * rigged clone's own Skeleton (three builds a float bone texture for it on first render; leaving
   * it would leak one GPU texture per despawn and a roster's worth per reconnect). Shared avatar
   * geometry and materials stay.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.animation.dispose();
    if (!this.rigged) this.releasePlaceholder();
    else disposeSkeletons(this.modelRoot);
    this.object.clear();
  }
}

/** A rigged clone's own Skeletons (three builds a float bone texture for each on first render). */
function disposeSkeletons(root: THREE.Object3D): void {
  const skeletons = new Set<THREE.Skeleton>();
  root.traverse((object) => {
    if ((object as THREE.SkinnedMesh).isSkinnedMesh) skeletons.add((object as THREE.SkinnedMesh).skeleton);
  });
  for (const skeleton of skeletons) skeleton.dispose();
}

/** The placeholder builds its own geometries and materials per instance: free them with it. */
function disposePlaceholder(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) material.dispose();
  });
}
