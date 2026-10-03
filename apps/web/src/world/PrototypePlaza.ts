import * as THREE from "three";
import type { CollisionSystem } from "../collision/CollisionSystem.ts";
import type { InteractionSystem } from "../interaction/InteractionSystem.ts";
import type { Interactable } from "../interaction/Interactable.ts";
import { ProjectBoothInteractable } from "../projects/ProjectBoothInteractable.ts";

/**
 * Builds the CORE-001 prototype plaza: a ~50x50m greybox-with-some-paint
 * space just large enough to prove scale, movement, collision and the
 * interaction pipeline (master spec sections 6, 25 step 1, and the
 * CORE-001 brief section 6). This is NOT the Founders' District — no
 * Tavern interior, no Builders Hall interior, no Market stalls with real
 * listings. The World/Level Design agent owns that build.
 *
 * Every placeholder mesh here is primitive geometry (boxes, cylinders,
 * cones) with hand-tuned warm colors — zero external assets, zero
 * license surface, per CORE-001 section 6 ("use primitive geometry if
 * necessary... do not spend significant time decorating").
 */

export interface PrototypePlazaResult {
  readonly group: THREE.Group;
  /** Static meshes the third-person camera should not clip through. */
  readonly cameraObstacles: THREE.Object3D[];
  readonly spawnPoint: THREE.Vector3;
}

export interface PrototypePlazaOptions {
  readonly collisions: CollisionSystem;
  readonly interactions: InteractionSystem;
  readonly onOpenProjectBoard: () => void;
  /** CORE-005: fired by a project booth's `[E]` interaction — opens the project discovery panel straight to that project's detail view. */
  readonly onSelectProject: (projectId: string) => void;
}

const GROUND_SIZE = 56;

const GRASS_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x4f6b47, roughness: 1 });
const STONE_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x9c968a, roughness: 0.95 });
const WOOD_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x6b4a32, roughness: 0.85 });
const ROOF_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x7a3b32, roughness: 0.8 });
const WALL_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xcbb994, roughness: 0.9 });
const FOLIAGE_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x3f5c3a, roughness: 1 });
const TRUNK_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 1 });
const WATER_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x3c6e80,
  roughness: 0.2,
  metalness: 0.1,
  transparent: true,
  opacity: 0.85,
});
const LANTERN_GLOW_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0xffb257,
  emissive: 0xffb257,
  emissiveIntensity: 1.8,
  roughness: 0.4,
});
const SIGN_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x3a2f24, roughness: 0.7 });

export function buildPrototypePlaza(options: PrototypePlazaOptions): PrototypePlazaResult {
  const group = new THREE.Group();
  group.name = "PrototypePlaza";

  const cameraObstacles: THREE.Object3D[] = [];

  group.add(buildGround());
  group.add(buildFountain());
  options.collisions.addCylinder(new THREE.Vector3(0, 0, 0), 2.6);
  group.add(...buildBench(new THREE.Vector3(3.5, 0, 4)));

  const buildingA = buildBuilding("Tavern (placeholder)", new THREE.Vector3(-14, 0, -11));
  const buildingB = buildBuilding("Builders Hall (placeholder)", new THREE.Vector3(14, 0, -11));
  group.add(buildingA.group, buildingB.group);
  cameraObstacles.push(buildingA.group, buildingB.group);
  options.collisions.addBox(buildingA.group.position, buildingA.halfWidth, buildingA.halfDepth);
  options.collisions.addBox(buildingB.group.position, buildingB.halfWidth, buildingB.halfDepth);

  for (const tree of scatterTrees()) {
    group.add(tree.group);
    options.collisions.addCylinder(tree.group.position, tree.trunkRadius);
  }

  for (const lanternPosition of lanternPositions()) {
    group.add(buildLantern(lanternPosition));
  }

  const { group: boardGroup, interactable } = buildProjectBoard(
    new THREE.Vector3(7, 0, -3.5),
    options.onOpenProjectBoard,
  );
  group.add(boardGroup);
  options.interactions.register(interactable);

  // CORE-005: a handful of placeholder project booths in front of the
  // "Builders Hall (placeholder)" building (buildingB, at x=14, z=-11) —
  // a coherent project-discovery area without redesigning the map (task
  // brief § 13). Primitive pedestal + sign only — see buildProjectBooth().
  for (const booth of projectBoothPlacements()) {
    const boothGroup = buildProjectBooth(booth.projectId, booth.position, options.onSelectProject);
    group.add(boothGroup.group);
    options.interactions.register(boothGroup.interactable);
  }

  return {
    group,
    cameraObstacles,
    spawnPoint: new THREE.Vector3(0, 0, 10),
  };
}

function buildGround(): THREE.Mesh {
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE), GRASS_MATERIAL);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.name = "Ground";

  return ground;
}

function buildFountain(): THREE.Group {
  const fountain = new THREE.Group();
  fountain.name = "FountainPlaceholder";

  const plaza = new THREE.Mesh(new THREE.CircleGeometry(8, 24), STONE_MATERIAL);
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.y = 0.01;
  plaza.receiveShadow = true;
  fountain.add(plaza);

  const basin = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.4, 0.5, 20), STONE_MATERIAL);
  basin.position.y = 0.25;
  basin.castShadow = true;
  basin.receiveShadow = true;
  fountain.add(basin);

  const water = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 0.08, 20), WATER_MATERIAL);
  water.position.y = 0.46;
  fountain.add(water);

  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 1.2, 12), STONE_MATERIAL);
  pillar.position.y = 1.0;
  pillar.castShadow = true;
  fountain.add(pillar);

  const crown = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.5, 12), STONE_MATERIAL);
  crown.position.y = 1.85;
  crown.castShadow = true;
  fountain.add(crown);

  return fountain;
}

function buildBench(position: THREE.Vector3): THREE.Object3D[] {
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.08, 0.45), WOOD_MATERIAL);
  seat.position.copy(position).setY(0.45);
  seat.castShadow = true;

  const back = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 0.06), WOOD_MATERIAL);
  back.position.copy(position).add(new THREE.Vector3(0, 0.7, -0.2));
  back.castShadow = true;

  const legGeometry = new THREE.BoxGeometry(0.08, 0.45, 0.08);
  const legOffsets = [
    [0.6, -0.17],
    [-0.6, -0.17],
    [0.6, 0.17],
    [-0.6, 0.17],
  ];
  const legs = legOffsets.map(([x, z]) => {
    const leg = new THREE.Mesh(legGeometry, WOOD_MATERIAL);
    leg.position.copy(position).add(new THREE.Vector3(x!, 0.22, z!));
    leg.castShadow = true;
    return leg;
  });

  return [seat, back, ...legs];
}

interface BuildingResult {
  group: THREE.Group;
  halfWidth: number;
  halfDepth: number;
}

function buildBuilding(label: string, position: THREE.Vector3): BuildingResult {
  const width = 8;
  const depth = 7;
  const height = 4.5;

  const group = new THREE.Group();
  group.name = label;
  group.position.copy(position);

  const walls = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), WALL_MATERIAL);
  walls.position.y = height / 2;
  walls.castShadow = true;
  walls.receiveShadow = true;
  group.add(walls);

  const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.hypot(width, depth) * 0.5, 2.2, 4), ROOF_MATERIAL);
  roof.rotation.y = Math.PI / 4;
  roof.position.y = height + 1.1;
  roof.castShadow = true;
  group.add(roof);

  const doorway = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.2, 0.2), WOOD_MATERIAL);
  doorway.position.set(0, 1.1, depth / 2 + 0.05);
  group.add(doorway);

  return { group, halfWidth: width / 2, halfDepth: depth / 2 };
}

interface TreeResult {
  group: THREE.Group;
  trunkRadius: number;
}

function scatterTrees(): TreeResult[] {
  const positions: [number, number][] = [
    [-22, 18], [-18, 20], [-24, -2], [-20, -18],
    [22, 18], [18, 20], [24, -2], [20, -18],
    [-4, 22], [4, 22], [-2, -22], [3, -22],
  ];

  return positions.map(([x, z]) => buildTree(new THREE.Vector3(x, 0, z)));
}

function buildTree(position: THREE.Vector3): TreeResult {
  const group = new THREE.Group();
  group.position.copy(position);

  const scale = 0.85 + Math.random() * 0.4;
  group.scale.setScalar(scale);

  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 1.6, 8), TRUNK_MATERIAL);
  trunk.position.y = 0.8;
  trunk.castShadow = true;
  group.add(trunk);

  const foliageLow = new THREE.Mesh(new THREE.ConeGeometry(1.1, 1.6, 8), FOLIAGE_MATERIAL);
  foliageLow.position.y = 2.1;
  foliageLow.castShadow = true;
  group.add(foliageLow);

  const foliageHigh = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.3, 8), FOLIAGE_MATERIAL);
  foliageHigh.position.y = 3.0;
  foliageHigh.castShadow = true;
  group.add(foliageHigh);

  return { group, trunkRadius: 0.24 * scale };
}

function lanternPositions(): THREE.Vector3[] {
  return [
    new THREE.Vector3(-6, 0, 6),
    new THREE.Vector3(6, 0, 6),
    new THREE.Vector3(-6, 0, -1),
    new THREE.Vector3(10, 0, -4),
  ];
}

function buildLantern(position: THREE.Vector3): THREE.Group {
  const group = new THREE.Group();
  group.position.copy(position);
  group.name = "Lantern";

  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 2.4, 8), WOOD_MATERIAL);
  post.position.y = 1.2;
  post.castShadow = true;
  group.add(post);

  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), LANTERN_GLOW_MATERIAL);
  glow.position.y = 2.5;
  group.add(glow);

  return group;
}

function buildProjectBoard(
  position: THREE.Vector3,
  onInteract: () => void,
): { group: THREE.Group; interactable: Interactable } {
  const group = new THREE.Group();
  group.position.copy(position);
  group.name = "ProjectBoard";

  const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.6, 0.12), WOOD_MATERIAL);
  post.position.y = 0.8;
  post.castShadow = true;
  group.add(post);

  const board = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.9, 0.08), SIGN_MATERIAL);
  board.position.y = 1.55;
  board.castShadow = true;
  group.add(board);

  const interactable: Interactable = {
    id: "prototype-project-board",
    label: "View Projects",
    position,
    interactionRadius: 2.5,
    interact: onInteract,
  };

  return { group, interactable };
}

/**
 * CORE-005: where each prototype booth stands, and which project it
 * maps to. Only a `projectId` reference — never name/description/
 * category/etc., which stay owned by `ProjectRegistry` (task brief §
 * 38). Clustered in front of "Builders Hall (placeholder)"
 * (`buildingB`, at x=14, z=-11) so the project-discovery area reads as
 * one coherent spot rather than scattered world dressing.
 */
function projectBoothPlacements(): Array<{ projectId: string; position: THREE.Vector3 }> {
  return [
    { projectId: "shieldkit", position: new THREE.Vector3(9, 0, -6) },
    { projectId: "privatepay", position: new THREE.Vector3(12, 0, -6) },
    { projectId: "zk-forge", position: new THREE.Vector3(16, 0, -6) },
    { projectId: "orchard-tools", position: new THREE.Vector3(19, 0, -6) },
  ];
}

/**
 * A single placeholder project booth: a pedestal + a small sign, built
 * entirely from primitive geometry (no sourced/modeled assets, per
 * CORE-005 § 12/§ 27 — this is systems-first, not a visual pass).
 * Visually distinct from `buildProjectBoard`'s taller single board
 * (shorter pedestal shape) purely so the two interactables don't look
 * identical in testing/screenshots — not a meaningful design choice.
 */
function buildProjectBooth(
  projectId: string,
  position: THREE.Vector3,
  onSelect: (projectId: string) => void,
): { group: THREE.Group; interactable: Interactable } {
  const group = new THREE.Group();
  group.position.copy(position);
  group.name = `ProjectBooth:${projectId}`;

  const pedestal = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), STONE_MATERIAL);
  pedestal.position.y = 0.45;
  pedestal.castShadow = true;
  pedestal.receiveShadow = true;
  group.add(pedestal);

  const sign = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.55, 0.06), SIGN_MATERIAL);
  sign.position.y = 1.18;
  sign.castShadow = true;
  group.add(sign);

  const interactable = new ProjectBoothInteractable({ projectId, position, onSelect });

  return { group, interactable };
}
