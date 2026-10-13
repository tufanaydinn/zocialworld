import * as THREE from "three";

/**
 * Procedural bone layers for the KayKit avatars (WATCH_HALL.md, ADR-014 § 10):
 * wave, dance, a seated cheer and the raised-hand pose, applied on top of whatever clip the mixer
 * plays (Idle while standing, Sit while seated). No new asset and no licence surface.
 *
 * Bone names are the GLTFLoader-sanitised KayKit ones (`upperarm.r` → `upperarmr`). The model faces +Z
 * and its left is +X.
 *
 * Arm poses are aimed once, at construction, in model space:
 * the bone-local rotation that points each arm bone along a wanted direction is stored, and every
 * frame the mixer's pose is slerped toward it by a smoothed weight. Body sway and nods are small
 * rotations about model-space axes, conjugated into bone space with the parent's rest rotation.
 * Every touched bone is restored before the next mixer update, so bones a clip does not animate
 * never accumulate the layer.
 */

export type EmoteLayerId = "wave" | "dance" | "cheer" | "hand";

/** What the layer should show this frame. */
export interface EmoteLayerInput {
  /** The character sits (Sit clip): dance and cheer keep to the upper body. */
  readonly seated: boolean;
  readonly wave: boolean;
  readonly dance: boolean;
  /** Both arms up — only as a layer while seated (standing cheer is the Cheer clip). */
  readonly cheer: boolean;
  readonly hand: boolean;
}

type Side = "l" | "r";
type Vec = readonly [number, number, number];

/**
 * Model-space bone directions (child − bone) for the RIGHT arm; x is mirrored for the left. The
 * KayKit characters are chibi: shoulders at ~0.83 m under a head that spans ~0.93–1.72 m and is
 * ~0.75 m wide, and the arm is ~0.35 m long. A hand can never rise above the head, so "raised"
 * poses swing the upper arm out to the side and stand the forearm up beside the head, where it
 * reads from the front and from behind.
 */
const POSES = {
  handUpper: [-0.9, 0.36, 0.24],
  handLower: [-0.34, 0.93, 0.12],
  handLowerSway: [-0.12, 0.98, 0.14],
  waveUpper: [-0.92, 0.32, 0.24],
  waveLowerA: [-0.72, 0.66, 0.2],
  waveLowerB: [0.05, 0.98, 0.2],
  cheerUpper: [-0.86, 0.46, 0.22],
  cheerLower: [-0.42, 0.9, 0.12],
  pumpUpperLow: [-0.86, -0.36, 0.36],
  pumpUpperHigh: [-0.84, 0.46, 0.3],
  pumpLower: [-0.2, 0.8, 0.56],
} as const satisfies Record<string, Vec>;

const WEIGHT_RATE = 9;
/** Dance tempo, beats per second (≈ 120 bpm). */
const BEAT_HZ = 2;
const WAVE_HZ = 2.4;

interface ArmTargets {
  hand: [THREE.Quaternion, THREE.Quaternion, THREE.Quaternion];
  wave: [THREE.Quaternion, THREE.Quaternion, THREE.Quaternion];
  cheer: [THREE.Quaternion, THREE.Quaternion];
  pump: [THREE.Quaternion, THREE.Quaternion, THREE.Quaternion];
}

interface Arm {
  readonly upper: THREE.Object3D;
  readonly lower: THREE.Object3D;
  readonly targets: ArmTargets;
}

export class EmoteBoneLayer {
  private readonly root: THREE.Object3D;
  private readonly arms: Partial<Record<Side, Arm>> = {};
  private readonly hips: THREE.Object3D | null;
  private readonly spine: THREE.Object3D | null;
  private readonly chest: THREE.Object3D | null;
  private readonly head: THREE.Object3D | null;
  /** Parent rest rotation (model space) of each bone that gets model-space offsets. */
  private readonly parentRest = new Map<THREE.Object3D, THREE.Quaternion>();
  private readonly touched: THREE.Object3D[] = [];
  /** Saved rotations, slot i for touched[i]; the slots are reused every frame (no per-frame allocation in a crowd). */
  private readonly saved: THREE.Quaternion[] = [];
  private readonly weights: Record<EmoteLayerId, number> = { wave: 0, dance: 0, cheer: 0, hand: 0 };
  private clock = 0;
  private rootLift = 0;
  private readonly scratch = new THREE.Quaternion();
  private readonly offset = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();

  /** Null when the model lacks the bones the layer needs (any non-KayKit rig). */
  static tryCreate(root: THREE.Object3D): EmoteBoneLayer | null {
    const required = ["upperarmr", "lowerarmr", "wristr", "upperarml", "lowerarml", "wristl"];
    return required.every((name) => root.getObjectByName(name)) ? new EmoteBoneLayer(root) : null;
  }

  private constructor(root: THREE.Object3D) {
    this.root = root;
    this.hips = root.getObjectByName("hips") ?? null;
    this.spine = root.getObjectByName("spine") ?? null;
    this.chest = root.getObjectByName("chest") ?? null;
    this.head = root.getObjectByName("head") ?? null;
    root.updateMatrixWorld(true);
    for (const side of ["r", "l"] as const) {
      const upper = root.getObjectByName(`upperarm${side}`)!;
      const lower = root.getObjectByName(`lowerarm${side}`)!;
      const wrist = root.getObjectByName(`wrist${side}`)!;
      const mirror = (v: Vec): THREE.Vector3 => new THREE.Vector3(side === "l" ? -v[0] : v[0], v[1], v[2]).normalize();
      const pair = (upperDir: Vec, lowerDirs: Vec[]): THREE.Quaternion[] => {
        const restUpper = upper.quaternion.clone();
        const upperTarget = this.aim(upper, lower, mirror(upperDir));
        upper.quaternion.copy(upperTarget);
        upper.updateMatrixWorld(true);
        const lowers = lowerDirs.map((dir) => this.aim(lower, wrist, mirror(dir)));
        upper.quaternion.copy(restUpper);
        root.updateMatrixWorld(true);
        return [upperTarget, ...lowers];
      };
      const [handU, handL, handSway] = pair(POSES.handUpper, [POSES.handLower, POSES.handLowerSway]);
      const [waveU, waveA, waveB] = pair(POSES.waveUpper, [POSES.waveLowerA, POSES.waveLowerB]);
      const [cheerU, cheerL] = pair(POSES.cheerUpper, [POSES.cheerLower]);
      const [pumpLow, pumpLower] = pair(POSES.pumpUpperLow, [POSES.pumpLower]);
      const [pumpHigh] = pair(POSES.pumpUpperHigh, []);
      this.arms[side] = {
        upper,
        lower,
        targets: {
          hand: [handU!, handL!, handSway!],
          wave: [waveU!, waveA!, waveB!],
          cheer: [cheerU!, cheerL!],
          pump: [pumpLow!, pumpHigh!, pumpLower!],
        },
      };
    }
    for (const bone of [this.hips, this.spine, this.chest, this.head]) {
      if (bone?.parent) this.parentRest.set(bone, this.modelQuaternion(bone.parent));
    }
  }

  /** Smoothed weight of a layer (0..1), for tests and debugging. */
  weight(layer: EmoteLayerId): number {
    return this.weights[layer];
  }

  /** Puts back the bones this layer changed last frame. Call right before the mixer update. */
  restore(): void {
    for (let i = 0; i < this.touched.length; i++) this.touched[i]!.quaternion.copy(this.saved[i]!);
    this.touched.length = 0;
  }

  /** Applies the layers over the mixer's pose. Call right after the mixer update. */
  apply(deltaSeconds: number, input: EmoteLayerInput): void {
    const ease = 1 - Math.exp(-WEIGHT_RATE * deltaSeconds);
    const w = this.weights;
    w.wave += ((input.wave ? 1 : 0) - w.wave) * ease;
    w.dance += ((input.dance ? 1 : 0) - w.dance) * ease;
    w.cheer += ((input.cheer ? 1 : 0) - w.cheer) * ease;
    w.hand += ((input.hand ? 1 : 0) - w.hand) * ease;
    const active = w.wave > 0.001 || w.dance > 0.001 || w.cheer > 0.001 || w.hand > 0.001;
    this.clock = active ? this.clock + deltaSeconds : 0;
    const beat = this.clock * BEAT_HZ * Math.PI * 2;

    // Dance: body first (sway, counter-twist, nod), then the arms pump in alternation.
    const lift = w.dance > 0.001 && !input.seated ? 0.045 * Math.abs(Math.sin(beat / 2)) * w.dance : 0;
    if (lift !== this.rootLift) {
      this.root.position.y += lift - this.rootLift;
      this.rootLift = lift;
    }
    if (w.dance > 0.001) {
      const d = w.dance;
      const sway = Math.sin(beat / 2);
      if (!input.seated) this.rotate(this.hips, 0, 1, 0, 0.24 * sway * d);
      this.rotate(this.spine, 0, 0, 1, 0.16 * sway * d);
      this.rotate(this.chest, 0, 1, 0, -0.26 * sway * d);
      this.rotate(this.head, 0, 0, 1, -0.12 * sway * d);
      this.rotate(this.head, 1, 0, 0, 0.2 * Math.sin(beat) * d);
      for (const side of ["r", "l"] as const) {
        const arm = this.arms[side]!;
        const phase = 0.5 + 0.5 * Math.sin(beat + (side === "l" ? Math.PI : 0));
        this.scratch.slerpQuaternions(arm.targets.pump[0], arm.targets.pump[1], phase);
        this.blend(arm.upper, this.scratch, d);
        this.blend(arm.lower, arm.targets.pump[2], d);
      }
    }
    if (w.cheer > 0.001) {
      const pump = 0.75 + 0.25 * Math.sin(this.clock * 7);
      for (const side of ["r", "l"] as const) {
        const arm = this.arms[side]!;
        this.blend(arm.upper, arm.targets.cheer[0], w.cheer * pump);
        this.blend(arm.lower, arm.targets.cheer[1], w.cheer);
      }
    }
    const right = this.arms.r!;
    if (w.hand > 0.001) {
      // A slow sway of the raised forearm, so a raised hand catches the eye in a seated crowd.
      const sway = 0.5 + 0.5 * Math.sin(this.clock * 2.2);
      this.blend(right.upper, right.targets.hand[0], w.hand);
      this.scratch.slerpQuaternions(right.targets.hand[1], right.targets.hand[2], sway);
      this.blend(right.lower, this.scratch, w.hand);
    }
    if (w.wave > 0.001) {
      const swing = 0.5 + 0.5 * Math.sin(this.clock * WAVE_HZ * Math.PI * 2);
      this.blend(right.upper, right.targets.wave[0], w.wave);
      this.scratch.slerpQuaternions(right.targets.wave[1], right.targets.wave[2], swing);
      this.blend(right.lower, this.scratch, w.wave);
    }
  }

  /** Bone-local rotation that points `bone → child` along `direction` (model space), from the current pose. */
  private aim(bone: THREE.Object3D, child: THREE.Object3D, direction: THREE.Vector3): THREE.Quaternion {
    const from = this.modelPosition(child).sub(this.modelPosition(bone)).normalize();
    const delta = new THREE.Quaternion().setFromUnitVectors(from, direction);
    const target = delta.multiply(this.modelQuaternion(bone));
    return this.modelQuaternion(bone.parent!).invert().multiply(target);
  }

  private modelPosition(object: THREE.Object3D): THREE.Vector3 {
    return this.root.worldToLocal(object.getWorldPosition(new THREE.Vector3()));
  }

  private modelQuaternion(object: THREE.Object3D): THREE.Quaternion {
    const rootQ = this.root.getWorldQuaternion(new THREE.Quaternion()).invert();
    return rootQ.multiply(object.getWorldQuaternion(new THREE.Quaternion()));
  }

  private remember(bone: THREE.Object3D): void {
    if (this.touched.includes(bone)) return;
    const slot = this.touched.length;
    this.touched.push(bone);
    (this.saved[slot] ??= new THREE.Quaternion()).copy(bone.quaternion);
  }

  private blend(bone: THREE.Object3D, target: THREE.Quaternion, weight: number): void {
    this.remember(bone);
    bone.quaternion.slerp(target, Math.min(1, weight));
  }

  /** Rotates `bone` by `angle` about a model-space axis (through the bone's own origin). */
  private rotate(bone: THREE.Object3D | null, x: number, y: number, z: number, angle: number): void {
    if (!bone) return;
    const parent = this.parentRest.get(bone);
    if (!parent) return;
    this.remember(bone);
    this.offset.setFromAxisAngle(this.axis.set(x, y, z), angle);
    // local' = P⁻¹ · R · P · local, so the bone turns by R in model space.
    this.scratch.copy(parent).invert().multiply(this.offset).multiply(parent);
    bone.quaternion.premultiply(this.scratch);
  }
}
