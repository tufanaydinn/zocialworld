import type * as THREE from "three";
import type { CollisionSystem } from "../collision/CollisionSystem.ts";
import type { InteractionSystem } from "../interaction/InteractionSystem.ts";
import type { AssetManager } from "../assets/AssetManager.ts";
import type { QualityTier } from "../core/quality.ts";
import type { MinimapData } from "../ui/minimapTypes.ts";
import type { LearningProgress } from "../learning/progress.ts";
import type { Tier } from "../learning/types.ts";
import type { CommunityBoards } from "./district/liveBoards.ts";
import type { WatchHallCallbacks, WatchHallHandles } from "./hall/contract.ts";
import type { LocationId } from "./locations.ts";
import type { AnchorSpec } from "../debug/anchors.ts";

/**
 * The contract between World and the content it shows. A location module builds one location into one of
 * the world's slots (`locations.ts`); World owns the scene, switches the active location by the camera's
 * position and drives the atmosphere. Location modules come from the content provider (`content/types.ts`).
 */

/** What a location may use while it builds: the shared systems, the render tier and the app actions its interactables trigger. */
export interface LocationBuildContext {
  readonly collisions: CollisionSystem;
  readonly interactions: InteractionSystem;
  /** Loads GLB dressing (buildings, props, NPCs). */
  readonly assets: AssetManager;
  /** Render tier — a location may trim crowds and far layers on "low". */
  readonly quality: QualityTier;
  /** Opens the project board. */
  readonly onOpenProjectBoard: () => void;
  /** Opens one project's detail view (project booths). */
  readonly onSelectProject: (projectId: string) => void;
  /** Opens the in-game Community Hub on a given view. */
  readonly onOpenCommunity: (view: "bounties" | "wiki" | "forum" | "github") => void;
  /** Opens the portal destination menu. */
  readonly onOpenPortal: () => void;
  /** Travels to a destination by id (doors between locations). */
  readonly onTravel: (destinationId: string) => void;
  /** Local learning progress — drives station boards and quiz gates. */
  readonly learning: LearningProgress;
  readonly onOpenLesson: (lessonId: string, step?: number) => void;
  readonly onOpenLearningDirectory: (tier?: Tier) => void;
  /** What a Watch Hall's interactables open. */
  readonly watchHall: WatchHallCallbacks;
}

/** A built location. Colliders and interactables are registered on the context's systems during `build`. */
export interface BuiltLocation {
  readonly group: THREE.Group;
  /** Static meshes the third-person camera should not clip through. */
  readonly cameraObstacles: THREE.Object3D[];
  /** Where a player arriving in this location stands (the spawn point for the default location). */
  readonly spawnPoint: THREE.Vector3;
  /** Walkable ground height at a world-space (x, z) inside this location. */
  readonly heightAt: (x: number, z: number) => number;
  /** Resolves once streamed dressing has been added to `group`. */
  readonly ready: Promise<void>;
  /** The location's minimap, or null for none. */
  readonly minimap: MinimapData | null;
  /** Key light / shadow frustum centre while active (default: the slot's origin). */
  readonly focus?: { readonly x: number; readonly z: number };
  /** True for an indoor location: the atmosphere switches to its interior profile while it is active. */
  readonly interior?: boolean;
  /** Where the featured-projects panel becomes relevant (the project board), if this location has one. */
  readonly featuredProjectsAnchor?: { readonly x: number; readonly z: number };
  /** Live community boards for the app to fill, if this location has them. */
  readonly communityBoards?: CommunityBoards;
  /** The Watch Hall's screen, boards and seats, if this location is a hall. */
  readonly watchHall?: WatchHallHandles;
  /** Named positions end-to-end tests stand a player at (`debug/anchors.ts` lists the names they use). */
  readonly anchors?: Readonly<Record<string, AnchorSpec>>;
  /** Per-frame animation while the location is active. */
  update?(deltaSeconds: number, camera: THREE.Camera): void;
}

export interface LocationModule {
  /** The slot this location occupies. */
  readonly id: LocationId;
  build(context: LocationBuildContext): BuiltLocation;
}

/** The scene-wide sky, fog and global lights, as World drives them. */
export interface WorldAtmosphere {
  /** Re-centres the key light and its shadow frustum on the active location. */
  setFocus(x: number, z: number): void;
  /** Switches between the outdoor and the interior light profile. */
  setInterior(interior: boolean): void;
  update(deltaSeconds: number, camera: THREE.Camera): void;
}
