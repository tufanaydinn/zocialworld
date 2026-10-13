import type { BuildingSpec } from "../../world/district/ModularBuilding.ts";

/**
 * A small house for `buildModularBuilding` (`world/district/ModularBuilding.ts`): three cells wide and two deep, a
 * stone ground floor with one door under a timbered upper floor, lit windows and a chimney. It shows the shape of a
 * `BuildingSpec`; a location lists its own specs and places them with a `StaticBatcher`. The pieces come from the
 * Kenney Fantasy Town Kit (see `assets/asset-registry.json`).
 */
export const SAMPLE_BUILDING: BuildingSpec = {
  id: "sample-house",
  position: { x: 0, y: 0, z: 0 },
  rotationY: 0,
  width: 3,
  depth: 2,
  floors: 2,
  ground: "stone",
  upper: "wood",
  doors: [1],
  chimney: true,
  litWindows: true,
  seed: 7,
};
