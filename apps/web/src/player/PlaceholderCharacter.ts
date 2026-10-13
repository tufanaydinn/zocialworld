import * as THREE from "three";

/**
 * Builds a simple procedural low-poly humanoid out of primitives.
 *
 * This exists so the client runs with zero external character assets —
 * no license review needed, no download size, works immediately. A real
 * rigged GLB replaces it via `LocalPlayer.setModel()` without touching
 * PlayerController, CollisionSystem or the animation state machine (see
 * docs/architecture/OVERVIEW.md).
 *
 * The returned `ProceduralRig` exposes the limb nodes so
 * PlayerAnimation can drive a basic walk/idle cycle before any real
 * animation clips exist.
 *
 * All vertical measurements below are deliberately laid out foot-up
 * (feet at local y = 0, matching LocalPlayer's ground-level origin) so
 * legs, hips and shoulders line up with no floating gaps.
 */

/** The rig's meshes by part (PlaceholderCrowd draws each part of every remote placeholder as one instanced mesh). */
export type PlaceholderPart = "torso" | "belt" | "head" | "hat" | "arm" | "leg";

export interface ProceduralRig {
  readonly root: THREE.Group;
  readonly head: THREE.Object3D;
  readonly torso: THREE.Object3D;
  readonly leftArm: THREE.Object3D;
  readonly rightArm: THREE.Object3D;
  readonly leftLeg: THREE.Object3D;
  readonly rightLeg: THREE.Object3D;
  /** Every mesh with its part, in a fixed order (torso, belt, head, hat, left arm, right arm, left leg, right leg). */
  readonly parts: readonly { readonly mesh: THREE.Mesh; readonly part: PlaceholderPart }[];
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
   * Overrides the accent color (belt + hat) — the player's avatar palette
   * colour (ADR-015). LocalPlayer starts with the default accent
   * and switches to the palette colour with `setPlaceholderAccent` once its
   * avatar is known.
   */
  accentColor?: THREE.ColorRepresentation;
}

/** A warm candle tint mixed into the placeholder's emissive lift. */
export const LIFT_TINT = new THREE.Color(0xffc890);

/** The emissive colour is the material's own colour warmed a little; the lift itself is emissiveIntensity (0 = off, the default). */
function liftable(material: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  material.emissive.copy(material.color).lerp(LIFT_TINT, 0.15);
  material.emissiveIntensity = 0;
  return material;
}

/**
 * The low tier has no point lights, so inside the Watch Hall (warm, dim, lit by emissive candles)
 * an unlit placeholder reads almost black. A warm emissive lift (a uniform change: no shader recompile) makes
 * remote players read clearly there; 0 turns it off again. Touches only this placeholder's own materials.
 */
export function setPlaceholderLift(root: THREE.Object3D, intensity: number): void {
  root.traverse((object) => {
    const material = (object as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (material && (material as THREE.MeshStandardMaterial).isMeshStandardMaterial) material.emissiveIntensity = intensity;
  });
}

/** Names the belt/hat material so `setPlaceholderAccent` can find it again. */
const ACCENT_MATERIAL_NAME = "placeholder-accent";

/**
 * ADR-015: recolours the placeholder's accent (belt and hat) to the player's palette
 * colour — on `avatar_updated`, or once the local player's avatar is known. The emissive colour is
 * recomputed from the new colour, so the Watch Hall's warm glow (the low-tier lift,
 * `setPlaceholderLift`) follows at its current intensity. Touches only this placeholder's own material.
 */
export function setPlaceholderAccent(root: THREE.Object3D, color: THREE.ColorRepresentation): void {
  root.traverse((object) => {
    const material = (object as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (!material || !material.isMeshStandardMaterial || material.name !== ACCENT_MATERIAL_NAME) return;
    material.color.set(color);
    material.emissive.copy(material.color).lerp(LIFT_TINT, 0.15);
  });
}

/** The placeholder's current accent colour (belt and hat), or null if `root` is not a placeholder. For tests and debugging. */
export function placeholderAccent(root: THREE.Object3D): THREE.Color | null {
  let found: THREE.Color | null = null;
  root.traverse((object) => {
    const material = (object as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (!found && material?.isMeshStandardMaterial && material.name === ACCENT_MATERIAL_NAME) found = material.color.clone();
  });
  return found;
}

export function createPlaceholderCharacter(options: PlaceholderCharacterOptions = {}): ProceduralRig {
  const root = new THREE.Group();
  root.name = "PlaceholderCharacter";

  const bodyMaterial = liftable(new THREE.MeshStandardMaterial({ color: BODY_COLOR, roughness: 0.8 }));
  const accentMaterial = liftable(new THREE.MeshStandardMaterial({ color: options.accentColor ?? ACCENT_COLOR, roughness: 0.6 }));
  accentMaterial.name = ACCENT_MATERIAL_NAME;
  const skinMaterial = liftable(new THREE.MeshStandardMaterial({ color: SKIN_COLOR, roughness: 0.9 }));

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

  const parts: ProceduralRig["parts"] = [
    { mesh: torsoMesh, part: "torso" },
    { mesh: belt, part: "belt" },
    { mesh: headMesh, part: "head" },
    { mesh: hat, part: "hat" },
    { mesh: leftArmMesh, part: "arm" },
    { mesh: rightArmMesh, part: "arm" },
    { mesh: leftLegMesh, part: "leg" },
    { mesh: rightLegMesh, part: "leg" },
  ];
  return { root, head, torso, leftArm, rightArm, leftLeg, rightLeg, parts };
}
