import type { ContentProvider } from "../types.ts";
import { BASIC_VISUALIZERS } from "../../learning/visualizers/basics.ts";
import { SAMPLE_DESTINATIONS } from "./destinations.ts";
import { sampleHallLocation } from "./hall.ts";
import { sampleHallLayout } from "./hallLayout.ts";
import { createPlazaAtmosphere, plazaLocation } from "./plaza.ts";
import { SAMPLE_CURRICULUM } from "./sampleCurriculum.ts";

/**
 * The sample content: the prototype plaza (where players spawn) and a small sample Watch Hall, both built from
 * primitive geometry with no external assets, and three sample lessons that use the basic visualizers. It is what
 * `@zw/content` resolves to when no deployment content module (`content/production/`) is present.
 */
export const content: ContentProvider = {
  id: "sample",
  locations: () => [plazaLocation, sampleHallLocation],
  defaultLocation: "district",
  destinations: SAMPLE_DESTINATIONS,
  hallLayout: sampleHallLayout,
  lessonCatalog: SAMPLE_CURRICULUM,
  visualizers: BASIC_VISUALIZERS,
  createAtmosphere: (scene) => createPlazaAtmosphere(scene),
  riggedAvatars: false,
};
