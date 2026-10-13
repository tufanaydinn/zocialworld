import { WATCH_HALL_ORIGIN } from "@project/shared";

/**
 * The world's location slots (ADR-010: one shared coordinate space, each
 * location at its own far origin, only the active one rendered). The game
 * server splits the world the same way. This is the single location test:
 * World, the location builders and anything else that needs "where is
 * this point" ask `locationAt` instead of repeating the split.
 *
 *  - district:  the central slot around (0, 0), where new players spawn;
 *  - valley:    the east slot at x = +1000 (x > LOCATION_SPLIT_X);
 *  - hall:      the west slot at x = −1000 (x < −LOCATION_SPLIT_X).
 *
 * The content provider decides what is built in each slot.
 */

export type LocationId = "district" | "valley" | "hall";

export const LOCATION_IDS: readonly LocationId[] = ["district", "valley", "hall"];

/** World-space origin of the east slot. Everything with x > LOCATION_SPLIT_X belongs to it. */
export const VALLEY_ORIGIN = { x: 1000, z: 0 } as const;
/** |x| beyond which a point leaves the central slot. */
export const LOCATION_SPLIT_X = 500;

/** World-space origin of each location. */
export const LOCATION_ORIGINS: Readonly<Record<LocationId, { readonly x: number; readonly z: number }>> = {
  district: { x: 0, z: 0 },
  valley: VALLEY_ORIGIN,
  hall: WATCH_HALL_ORIGIN,
};

/** Which location a world-space x belongs to. */
export function locationAt(x: number): LocationId {
  if (x > LOCATION_SPLIT_X) return "valley";
  if (x < -LOCATION_SPLIT_X) return "hall";
  return "district";
}
