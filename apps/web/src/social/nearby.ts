/**
 * Social interaction range (CORE-003).
 *
 * Deliberately engine-agnostic (no Three.js types), same reasoning as
 * `apps/web/src/networking/interpolation.ts`: the actual distance math
 * is trivially unit-testable this way — see `nearby.test.ts`.
 *
 * This is the one reusable source of truth for "how close is close
 * enough to socially interact" — CORE-003 §7/§21 explicitly calls out
 * not scattering this distance as a magic number in multiple systems.
 * It is reused for:
 *   - the player-selection interaction radius (`RemotePlayerManager`),
 *   - the "online" vs "nearby" presence state shown in the player
 *     context card (`App.ts`).
 *
 * A future audible/voice radius is expected to be its own constant and
 * its own decision, not an automatic reuse of this one — see CORE-003
 * §21 and `docs/protocols/multiplayer-protocol.md` § Nearby interaction
 * range.
 */

/** Meters. See docs/protocols/multiplayer-protocol.md § Nearby interaction range for why this value was chosen. */
export const SOCIAL_INTERACTION_RADIUS_METERS = 5;

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface PositionedPlayer extends Point3 {
  playerId: string;
}

/**
 * Returns the subset of `players` within `radiusMeters` of `localPosition`,
 * using world-space Euclidean distance (not screen-space). Nearby-ness is
 * derived client-side on demand — CORE-003 does not add a networked
 * presence message for this (see CORE-003 §6).
 */
export function getNearbyPlayers<T extends PositionedPlayer>(
  localPosition: Point3,
  players: readonly T[],
  radiusMeters: number = SOCIAL_INTERACTION_RADIUS_METERS,
): T[] {
  const radiusSq = radiusMeters * radiusMeters;
  return players.filter((player) => distanceSquared(localPosition, player) <= radiusSq);
}

function distanceSquared(a: Point3, b: Point3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
