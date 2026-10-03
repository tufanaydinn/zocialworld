import * as THREE from "three";

/**
 * Builds a simple procedural low-poly humanoid out of primitives.
 *
 * This exists so CORE-001 ships with zero external character assets —
 * no license review needed, no download size, works immediately. It is
 * explicitly a placeholder: the Character Agent is expected to replace
 * it with a real rigged GLB via `LocalPlayer.setModel()` without
 * touching PlayerController, CollisionSystem or the animation state
 * machine (see docs/OVERVIEW.md).
 *
 * The returned `ProceduralRig` exposes the limb nodes so
 * PlayerAnimation can drive a basic walk/idle cycle before any real
 * animation clips exist.
 *
 * All vertical measurements below are deliberately laid out foot-up
 * (feet at local y = 0, matching LocalPlayer's ground-level origin) so
 * legs, hips and shoulders line up with no floating gaps.
 */

export interface ProceduralRig {
  readonly root: THREE.Group;
  readonly head: THREE.Object3D;
  readonly torso: THREE.Object3D;
  readonly leftArm: THREE.Object3D;
  readonly rightArm: THREE.Object3D;
  readonly leftLeg: THREE.Object3D;
  readonly rightLeg: THREE.Object3D;
}

const BODY_COLOR = 0x3a4a5c;
const ACCENT_COLOR = 0xc98a3c;
const SKIN_COLOR = 0xe0b48a;

/** Exported so PlayerAnimation's procedural bob/sit poses stay in sync with the rig's actual proportions. */
export const HIP_HEIGHT = 0.85;
const SHOULDER_HEIGHT = 1.4;
const HEAD_RADIUS = 0.16;

export interface PlaceholderCharacterOptions {
  /**
   * Overrides the accent color (belt + hat) — used by RemotePlayer to
   * tint each remote player with a color derived from their session's
   * `colorSeed` so testers can tell players apart (CORE-002 §13).
   * LocalPlayer never passes this, so the local character keeps the
   * default accent unchanged.
   */
  accentColor?: THREE.ColorRepresentation;
}

export function createPlaceholderCharacter(options: PlaceholderCharacterOptions = {}): ProceduralRig {
  const root = new THREE.Group();
  root.name = "PlaceholderCharacter";

  const bodyMaterial = new THREE.MeshStandardMaterial({ color: BODY_COLOR, roughness: 0.8 });
  const accentMaterial = new THREE.MeshStandardMaterial({ color: options.accentColor ?? ACCENT_COLOR, roughness: 0.6 });
  const skinMaterial = new THREE.MeshStandardMaterial({ color: SKIN_COLOR, roughness: 0.9 });

  // Legs and torso both pivot at the hip, so walk-cycle leg rotation and
  // torso bob share a consistent joint height.
  const torsoHeight = SHOULDER_HEIGHT - HIP_HEIGHT;
  const torsoRadius = 0.2;
  const torso = new THREE.Group();
  torso.position.y = HIP_HEIGHT;
  const torsoMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(torsoRadius, Math.max(0.01, torsoHeight - torsoRadius * 2), 4, 8),
    bodyMaterial,
  );
  torsoMesh.position.y = torsoHeight / 2;
  torsoMesh.castShadow = true;
  torso.add(torsoMesh);

  const belt = new THREE.Mesh(new THREE.TorusGeometry(torsoRadius * 1.02, 0.035, 6, 12), accentMaterial);
  belt.rotation.x = Math.PI / 2;
  belt.position.y = 0.06;
  torso.add(belt);

  // Head pivots independently so future "look at speaker" behavior can rotate just the head.
  const head = new THREE.Group();
  head.position.y = torsoHeight + HEAD_RADIUS + 0.03;
  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(HEAD_RADIUS, 12, 10), skinMaterial);
  headMesh.castShadow = true;
  head.add(headMesh);
  const hat = new THREE.Mesh(new THREE.ConeGeometry(HEAD_RADIUS * 0.95, 0.18, 10), accentMaterial);
  hat.position.y = HEAD_RADIUS + 0.08;
  hat.castShadow = true;
  head.add(hat);
  torso.add(head);

  const armLength = 0.32;
  const armRadius = 0.06;
  const armGeometry = new THREE.CapsuleGeometry(armRadius, armLength, 4, 6);
  const shoulderLocalY = torsoHeight - 0.08;

  const leftArm = new THREE.Group();
  leftArm.position.set(torsoRadius + 0.06, shoulderLocalY, 0);
  const leftArmMesh = new THREE.Mesh(armGeometry, skinMaterial);
  leftArmMesh.position.y = -(armLength / 2 + armRadius);
  leftArmMesh.castShadow = true;
  leftArm.add(leftArmMesh);
  torso.add(leftArm);

  const rightArm = new THREE.Group();
  rightArm.position.set(-(torsoRadius + 0.06), shoulderLocalY, 0);
  const rightArmMesh = new THREE.Mesh(armGeometry, skinMaterial);
  rightArmMesh.position.y = -(armLength / 2 + armRadius);
  rightArmMesh.castShadow = true;
  rightArm.add(rightArmMesh);
  torso.add(rightArm);

  root.add(torso);

  const legLength = 0.42;
  const legRadius = 0.085;
  const legGeometry = new THREE.CapsuleGeometry(legRadius, legLength, 4, 6);
  const legMeshOffsetY = -(legLength / 2 + legRadius);

  const leftLeg = new THREE.Group();
  leftLeg.position.set(0.11, HIP_HEIGHT, 0);
  const leftLegMesh = new THREE.Mesh(legGeometry, bodyMaterial);
  leftLegMesh.position.y = legMeshOffsetY;
  leftLegMesh.castShadow = true;
  leftLeg.add(leftLegMesh);
  root.add(leftLeg);

  const rightLeg = new THREE.Group();
  rightLeg.position.set(-0.11, HIP_HEIGHT, 0);
  const rightLegMesh = new THREE.Mesh(legGeometry, bodyMaterial);
  rightLegMesh.position.y = legMeshOffsetY;
  rightLegMesh.castShadow = true;
  rightLeg.add(rightLegMesh);
  root.add(rightLeg);

  return { root, head, torso, leftArm, rightArm, leftLeg, rightLeg };
}
