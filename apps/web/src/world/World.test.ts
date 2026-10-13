import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { World, type WorldOptions } from "./World.ts";
import type { BuiltLocation, LocationModule, WorldAtmosphere } from "./LocationModule.ts";
import type { ContentProvider } from "../content/types.ts";
import type { QualityTier } from "../core/quality.ts";
import type { LocationId } from "./locations.ts";
import type { CommunityBoards } from "./district/liveBoards.ts";
import type { WatchHallHandles } from "./hall/contract.ts";

// World as a location registry, driven by fixture location modules (no deployment content).

interface Log {
  readonly events: string[];
}

function fixtureLocation(id: LocationId, log: Log, extra: Partial<BuiltLocation> & { lights?: number; height?: number } = {}): LocationModule {
  return {
    id,
    build() {
      log.events.push(`build ${id}`);
      const group = new THREE.Group();
      group.name = id;
      for (let i = 0; i < (extra.lights ?? 0); i++) group.add(new THREE.PointLight(0xffffff, 1 + i, 10, 2));
      const { lights: _lights, height = 0, ...rest } = extra;
      return {
        group,
        cameraObstacles: [new THREE.Object3D()],
        spawnPoint: new THREE.Vector3(id === "district" ? 0 : id === "valley" ? 1000 : -1000, height, 5),
        heightAt: () => height,
        ready: Promise.resolve(),
        minimap: null,
        update: (delta) => log.events.push(`update ${id} ${delta}`),
        ...rest,
      };
    },
  };
}

function atmosphereLog(log: Log): (scene: THREE.Scene, quality: QualityTier) => WorldAtmosphere {
  return (scene, quality) => {
    log.events.push(`atmosphere ${quality} ${scene.children.length}`);
    return {
      setFocus: (x, z) => log.events.push(`focus ${x},${z}`),
      setInterior: (interior) => log.events.push(`interior ${interior}`),
      update: () => log.events.push("atmosphere update"),
    };
  };
}

function content(locations: LocationModule[], log: Log, overrides: Partial<ContentProvider> = {}): ContentProvider {
  return {
    id: "sample",
    locations: () => locations,
    defaultLocation: "district",
    destinations: [],
    lessonCatalog: { lessons: [], tierLabels: {}, zoneLabels: {}, upcoming: [], gates: {}, directoryIntro: "" },
    visualizers: {},
    createAtmosphere: atmosphereLog(log),
    riggedAvatars: true,
    ...overrides,
  };
}

function world(provider: ContentProvider, quality: QualityTier = "high"): World {
  return new World({ quality, content: provider } as unknown as WorldOptions);
}

const cameraAt = (x: number): THREE.Camera => {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(x, 3, 0);
  return camera;
};

test("World builds the atmosphere first, then the locations in the content's order", () => {
  const log: Log = { events: [] };
  world(content([fixtureLocation("district", log), fixtureLocation("hall", log), fixtureLocation("valley", log)], log));
  assert.deepEqual(log.events.slice(0, 4), ["atmosphere high 0", "build district", "build hall", "build valley"]);
});

test("World spawns in the default location and asks the location whose slot holds x for the ground height", () => {
  const log: Log = { events: [] };
  const w = world(content([fixtureLocation("district", log, { height: 2.4 }), fixtureLocation("valley", log, { height: 8 })], log));
  assert.deepEqual(w.spawnPoint.toArray(), [0, 2.4, 5]);
  assert.equal(w.groundHeightAt(10, 10), 2.4);
  assert.equal(w.groundHeightAt(1003, 0), 8);
  // No location in the west slot: flat ground.
  assert.equal(w.groundHeightAt(-1000, 0), 0);
  assert.equal(w.activeLocation, "district");
});

test("World shows and updates only the location the camera is in, and tells listeners when it changes", () => {
  const log: Log = { events: [] };
  const w = world(
    content([fixtureLocation("district", log), fixtureLocation("valley", log, { focus: { x: 1000, z: -30 } }), fixtureLocation("hall", log, { interior: true })], log),
  );
  const visible = (): string[] => w.scene.children.filter((child) => child.visible && ["district", "valley", "hall"].includes(child.name)).map((child) => child.name);
  assert.deepEqual(visible(), ["district"]);
  const changes: LocationId[] = [];
  w.onLocationChange((location) => changes.push(location));

  log.events.length = 0;
  w.update(0.1, cameraAt(1000));
  assert.deepEqual(visible(), ["valley"]);
  assert.equal(w.activeLocation, "valley");
  assert.deepEqual(changes, ["valley"]);
  assert.deepEqual(log.events, ["focus 1000,-30", "interior false", "atmosphere update", "update valley 0.1"]);

  log.events.length = 0;
  w.update(0.1, cameraAt(-1000));
  assert.deepEqual(visible(), ["hall"]);
  // Without an explicit focus the key light follows the slot's origin; an interior location switches the profile.
  assert.deepEqual(log.events.slice(0, 2), ["focus -1000,0", "interior true"]);
  assert.deepEqual(changes, ["valley", "hall"]);

  w.revealAllLocations(true);
  assert.deepEqual(visible(), ["district", "valley", "hall"]);
  w.revealAllLocations(false);
  assert.deepEqual(visible(), ["hall"]);
});

test("World pools the point lights on the high tier (as many as the busiest location) and mirrors the active one", () => {
  const log: Log = { events: [] };
  const w = world(content([fixtureLocation("district", log, { lights: 3 }), fixtureLocation("hall", log, { lights: 5 })], log));
  assert.deepEqual({ size: w.pointLightPool?.size, used: w.pointLightPool?.used }, { size: 5, used: 3 });
  w.update(0.1, cameraAt(-1000));
  assert.equal(w.pointLightPool?.used, 5);
  const low = world(content([fixtureLocation("district", { events: [] }, { lights: 3 })], { events: [] }), "low");
  assert.equal(low.pointLightPool, null);
});

test("World takes capabilities from the first location that has them; rigged avatars need the content's consent and the high tier", () => {
  const log: Log = { events: [] };
  const boards = {} as CommunityBoards;
  const hall = {} as WatchHallHandles;
  const w = world(
    content(
      [
        fixtureLocation("district", log, { featuredProjectsAnchor: { x: 11, z: -5 }, communityBoards: boards }),
        fixtureLocation("hall", log, { watchHall: hall, featuredProjectsAnchor: { x: -990, z: 0 } }),
      ],
      log,
    ),
  );
  assert.deepEqual(w.featuredProjectsAnchor, { x: 11, z: -5 });
  assert.equal(w.communityBoards, boards);
  assert.equal(w.watchHall, hall);
  assert.equal(w.usesRiggedAvatars, true);

  const bare = world(content([fixtureLocation("district", log)], log, { riggedAvatars: false }));
  assert.equal(bare.featuredProjectsAnchor, null);
  assert.equal(bare.communityBoards, null);
  assert.equal(bare.watchHall, null);
  assert.equal(bare.usesRiggedAvatars, false);
  assert.equal(world(content([fixtureLocation("district", log)], log), "low").usesRiggedAvatars, false);
});

test("World refuses two locations in one slot and a default slot without a location", () => {
  const log: Log = { events: [] };
  assert.throws(() => world(content([fixtureLocation("district", log), fixtureLocation("district", log)], log)), /two locations in the "district" slot/);
  assert.throws(() => world(content([fixtureLocation("valley", log)], log)), /no location in the default "district" slot/);
});

test("World is ready once every location's streamed dressing is in", async () => {
  const log: Log = { events: [] };
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  const w = world(content([fixtureLocation("district", log), fixtureLocation("hall", log, { ready: pending })], log));
  let ready = false;
  void w.ready.then(() => (ready = true));
  await Promise.resolve();
  assert.equal(ready, false);
  release();
  await w.ready;
  assert.equal(ready, true);
});
