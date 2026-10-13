import type * as THREE from "three";
import type { QualityTier } from "../core/quality.ts";
import type { LocationModule, WorldAtmosphere } from "../world/LocationModule.ts";
import type { LocationId } from "../world/locations.ts";
import type { PortalDestination } from "../world/destinations.ts";
import type { HallLayout } from "../world/hall/hallGeometry.ts";
import type { LessonCatalog, VisualizerRegistry } from "../learning/catalog.ts";

/**
 * Everything the client shows that is content rather than a system: the locations, the travel destinations,
 * the Watch Hall layout, the lessons and the scene's atmosphere. The app resolves one provider through the `@zw/content` import (see
 * `content/README.md`); systems receive what they need from it as arguments and never import content directly.
 */
export interface ContentProvider {
  readonly id: "sample" | "production";
  /** Location modules in build order, at most one per slot. */
  locations(): readonly LocationModule[];
  /** The slot a new player spawns in; one of the modules must occupy it. */
  readonly defaultLocation: LocationId;
  /** Portal and door destinations. */
  readonly destinations: readonly PortalDestination[];
  /**
   * The layout of the Watch Hall that the module in the "hall" slot builds, or undefined when the content has no
   * hall. The hall systems that need more than the built hall's handles (the performance scene) read it here.
   */
  readonly hallLayout?: HallLayout;
  /** The lessons the Learning panel offers and the progress store tracks. */
  readonly lessonCatalog: LessonCatalog;
  /** The SEE and TRY views the catalogue's lessons name (`validateCatalog` checks that each one is present). */
  readonly visualizers: VisualizerRegistry;
  /** Adds the sky, fog and global lights to `scene` (before any location is built) and returns the rig World drives. */
  createAtmosphere(scene: THREE.Scene, quality: QualityTier): WorldAtmosphere;
  /** True when players appear as rigged character models on the high tier; false keeps the primitive placeholder. */
  readonly riggedAvatars: boolean;
}
