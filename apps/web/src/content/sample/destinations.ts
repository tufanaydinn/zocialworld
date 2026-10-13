import type { PortalDestination } from "../../world/destinations.ts";
import { HALL_DESTINATION_ID, HALL_EXIT_DESTINATION_ID } from "../../world/hall/contract.ts";
import { toWorldXZ } from "../../world/hall/hallGeometry.ts";
import { sampleHallLayout } from "./hallLayout.ts";

/** Travel destinations of the sample world: the plaza, the sample hall and the hall's exit back to the plaza. */
export const SAMPLE_DESTINATIONS: readonly PortalDestination[] = [
  {
    id: "plaza",
    name: "Prototype Plaza",
    description: "Back to the fountain in the middle of the plaza.",
    icon: "★",
    available: true,
    arrival: { x: 0, z: 10 },
    lookAt: { x: 0, z: 0 },
  },
  {
    id: HALL_DESTINATION_ID,
    name: "Watch Hall",
    description: "The sample hall: a screen, a podium and a row of seats to try the stage and the boards.",
    icon: "🎬",
    available: true,
    arrival: toWorldXZ(sampleHallLayout.arrival.x, sampleHallLayout.arrival.z),
    lookAt: toWorldXZ(sampleHallLayout.screen.x, sampleHallLayout.screen.z),
    cameraPitch: 12,
  },
  {
    id: HALL_EXIT_DESTINATION_ID,
    name: "Prototype Plaza",
    description: "Out of the Watch Hall, back on the plaza.",
    icon: "★",
    available: true,
    listed: false,
    arrival: { x: 0, z: 10 },
    lookAt: { x: 0, z: 0 },
  },
];
