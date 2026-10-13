import * as THREE from "three";
import type { MinimapData } from "../ui/minimapTypes.ts";
import { simplifyForLowQuality } from "../core/quality.ts";
import type { ContentProvider } from "../content/types.ts";
import type { CommunityBoards } from "./district/liveBoards.ts";
import type { WatchHallHandles } from "./hall/contract.ts";
import type { BuiltLocation, LocationBuildContext, WorldAtmosphere } from "./LocationModule.ts";
import { LOCATION_ORIGINS, locationAt, type LocationId } from "./locations.ts";
import { PointLightPool, lightPoolSize, takePointLightSources } from "./lightPool.ts";
import { ANCHOR, mergeAnchors, resolveAnchors, type AnchorMap } from "../debug/anchors.ts";

export type { LocationId } from "./locations.ts";

export interface WorldOptions extends LocationBuildContext {
  /** The locations, atmosphere and avatar policy to show. */
  readonly content: ContentProvider;
}

/**
 * three.js recomputes every local and world matrix in the scene every frame, hidden or not — the two
 * hidden locations were almost half of the scene's 7,000 nodes (their NPC skeletons included). While a location is
 * hidden its subtree is skipped: nothing in it moves (ADR-010: only the active location updates), and the matrices it
 * had when last shown stay valid. It is updated again from the first frame it is shown.
 */
export function skipMatricesWhileHidden(group: THREE.Object3D): void {
  const updateMatrixWorld = group.updateMatrixWorld.bind(group);
  group.updateMatrixWorld = (force?: boolean): void => {
    if (group.visible) updateMatrixWorld(force);
  };
}

const NO_OBSTACLES: THREE.Object3D[] = [];

/**
 * Owns the THREE.Scene: the content's atmosphere and its locations, one per slot of the shared coordinate space
 * (ADR-010, `locations.ts`). Only the location the camera is in is shown and updated; the light pool (ADR-017) mirrors
 * its point lights. World knows no particular location: the content provider's modules build them.
 */
export class World {
  readonly scene = new THREE.Scene();
  /** Camera collision obstacles of the active location (the camera only raycasts what it can reach; other locations are far away). */
  get cameraObstacles(): THREE.Object3D[] {
    return this.locations.get(this.currentLocation)?.cameraObstacles ?? NO_OBSTACLES;
  }
  /** Where a new player spawns: the default location's spawn point. */
  readonly spawnPoint: THREE.Vector3;
  /** Walkable ground height at (x, z), from the location whose slot contains x (0 where no location is built). */
  readonly groundHeightAt: (x: number, z: number) => number;
  /** Resolves once every location's streamed dressing has been added. */
  readonly ready: Promise<void>;
  /** True when players appear as the rigged character models (the content allows it and the tier is high). */
  readonly usesRiggedAvatars: boolean;
  /** Map of the location the camera is in (null when it has none). */
  get minimap(): MinimapData | null {
    return this.locations.get(this.currentLocation)?.minimap ?? null;
  }
  /** Location the camera is currently in (ADR-010: one coordinate space, only the active location is rendered). */
  get activeLocation(): LocationId {
    return this.currentLocation;
  }
  /** Where the featured-projects panel becomes relevant (the first location that has a project board), or null. */
  readonly featuredProjectsAnchor: { readonly x: number; readonly z: number } | null;
  /** Live community boards for the app to fill (the first location that has them), or null. */
  readonly communityBoards: CommunityBoards | null;
  /** The Watch Hall's screen, boards and seats for the stage/seat/chat/watch systems, or null when no location is a hall. */
  readonly watchHall: WatchHallHandles | null;
  /** Named test positions of every built location, plus the spawn point (`debug/anchors.ts`). */
  readonly anchors: AnchorMap;
  private currentLocation: LocationId;
  private readonly locations = new Map<LocationId, BuiltLocation>();
  private readonly locationListeners = new Set<(location: LocationId) => void>();
  private forceAllVisible = false;
  /** ADR-017: each location's point lights (hidden sources) and the scene-level pool that mirrors the active one (high tier). */
  private readonly lightSources = new Map<LocationId, THREE.PointLight[]>();
  private lightPool: PointLightPool | null = null;
  private readonly atmosphere: WorldAtmosphere;

  constructor(options: WorldOptions) {
    const { content } = options;
    // The atmosphere goes into the scene first, then the locations in the content's order.
    this.atmosphere = content.createAtmosphere(this.scene, options.quality);
    for (const module of content.locations()) {
      if (this.locations.has(module.id)) throw new Error(`World: two locations in the "${module.id}" slot`);
      this.locations.set(module.id, module.build(options));
    }
    const home = this.locations.get(content.defaultLocation);
    if (!home) throw new Error(`World: no location in the default "${content.defaultLocation}" slot`);
    this.currentLocation = content.defaultLocation;
    for (const entry of this.locations.values()) {
      this.scene.add(entry.group);
      skipMatricesWhileHidden(entry.group);
    }
    // ADR-017: only the active location's point lights reach the shaders. Each location's lights become hidden sources
    // (its flicker keeps animating them) and a fixed pool of scene-level lights, as many as the busiest location has,
    // mirrors the active one — the light count never changes, so no shader recompiles on travel. The low tier renders
    // no point lights at all (simplifyForLowQuality hides the sources), so it needs no pool.
    if (options.quality === "high") {
      for (const [id, { group }] of this.locations) this.lightSources.set(id, takePointLightSources(group));
      this.lightPool = new PointLightPool(lightPoolSize([...this.lightSources.values()].map((lights) => lights.length)));
      this.scene.add(this.lightPool.group);
    }
    this.spawnPoint = home.spawnPoint;
    const locations = this.locations;
    this.groundHeightAt = (x, z) => locations.get(locationAt(x))?.heightAt(x, z) ?? 0;
    const built = [...this.locations.values()];
    const loaded = Promise.all(built.map((entry) => entry.ready)).then(() => undefined);
    if (options.quality === "low") {
      const cache = new Map<string, THREE.Material>();
      simplifyForLowQuality(this.scene, cache);
      // Streamed dressing arrives later — simplify it too once it is in the scene.
      this.ready = loaded.then(() => simplifyForLowQuality(this.scene, cache));
    } else {
      this.ready = loaded;
    }
    // Rigged avatars are skinned; software rasterizers render skinned meshes extremely slowly, so the low tier keeps the primitive placeholder.
    this.usesRiggedAvatars = content.riggedAvatars && options.quality === "high";
    this.featuredProjectsAnchor = built.find((entry) => entry.featuredProjectsAnchor)?.featuredProjectsAnchor ?? null;
    this.communityBoards = built.find((entry) => entry.communityBoards)?.communityBoards ?? null;
    this.watchHall = built.find((entry) => entry.watchHall)?.watchHall ?? null;
    this.anchors = mergeAnchors(
      { [ANCHOR.spawn]: { x: home.spawnPoint.x, y: home.spawnPoint.y, z: home.spawnPoint.z } },
      ...built.map((entry) => resolveAnchors(entry.anchors ?? {}, entry.heightAt)),
    );
    // Everything built so far gets its matrices before the inactive locations are hidden (skipMatricesWhileHidden).
    this.scene.updateMatrixWorld(true);
    this.applyLocation();
  }

  /** Calls `listener` whenever the active location changes (e.g. the HUD title card in the Watch Hall). Returns an unsubscribe. */
  onLocationChange(listener: (location: LocationId) => void): () => void {
    this.locationListeners.add(listener);
    return () => this.locationListeners.delete(listener);
  }

  /**
   * Shader warm-up: show every location so all their materials compile up front (no hitch on first travel),
   * then go back to rendering only the active one.
   */
  revealAllLocations(reveal: boolean): void {
    this.forceAllVisible = reveal;
    this.applyLocation();
    // Every location's matrices are computed at least once with all its streamed content in (the warm-up runs after
    // `ready`): a hidden location skips its matrix update (skipMatricesWhileHidden), but camera raycasts may still test
    // its obstacles.
    if (reveal) this.scene.updateMatrixWorld(true);
  }

  private applyLocation(): void {
    for (const [id, entry] of this.locations) entry.group.visible = this.forceAllVisible || id === this.currentLocation;
    const active = this.locations.get(this.currentLocation);
    const focus = active?.focus ?? LOCATION_ORIGINS[this.currentLocation];
    this.atmosphere.setFocus(focus.x, focus.z);
    this.atmosphere.setInterior(active?.interior ?? false);
    this.lightPool?.assign(this.lightSources.get(this.currentLocation) ?? []);
  }

  /** ADR-017 pool state, for the perf probe and tests: slots in the pool and slots the active location uses. */
  get pointLightPool(): { readonly size: number; readonly used: number } | null {
    return this.lightPool;
  }

  update(deltaSeconds: number, camera: THREE.Camera): void {
    const location = locationAt(camera.position.x);
    if (location !== this.currentLocation) {
      this.currentLocation = location;
      this.applyLocation();
      for (const listener of this.locationListeners) listener(location);
    }
    this.atmosphere.update(deltaSeconds, camera);
    this.locations.get(location)?.update?.(deltaSeconds, camera);
    this.lightPool?.sync();
  }
}
