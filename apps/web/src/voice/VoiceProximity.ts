/**
 * Voice distance/attenuation policy (CORE-004 §12/§13).
 *
 * Deliberately a SEPARATE set of constants from
 * `apps/web/src/social/nearby.ts`'s `SOCIAL_INTERACTION_RADIUS_METERS`
 * (5m, used for player-selection/presence) — "nearby enough to select a
 * player" and "close enough to hear full-volume voice" are different
 * product questions with different answers, and CORE-004 §12 explicitly
 * warns against conflating them. This file is the one reusable source
 * of truth for voice distance/attenuation; do not re-derive these
 * numbers or this curve anywhere else.
 *
 * Pure, engine-agnostic (no Three.js types), same pattern as
 * `networking/interpolation.ts` and `social/nearby.ts` — trivially
 * unit-testable, see `VoiceProximity.test.ts`.
 */

/** Meters. At or inside this distance, voice is at (approximately) full volume. */
export const VOICE_FULL_VOLUME_RADIUS_METERS = 3;

/** Meters. At or beyond this distance, voice is silent. */
export const VOICE_MAX_AUDIBLE_RADIUS_METERS = 12;

/**
 * Returns the voice gain (0–1) for a given world-space distance.
 *
 * - `distance <= fullVolumeRadius` → `1` (full volume).
 * - `distance >= maxAudibleRadius` → `0` (silent).
 * - In between → a smooth (smoothstep) decline from 1 to 0, not a
 *   linear ramp or an abrupt cutoff — CORE-004 §13 explicitly calls for
 *   smooth attenuation; the only hard edge is the final cutoff at
 *   `maxAudibleRadius`, where smoothstep's own derivative is already 0,
 *   so there is no audible "click" at the boundary either.
 */
export function getVoiceGain(
  distanceMeters: number,
  fullVolumeRadius: number = VOICE_FULL_VOLUME_RADIUS_METERS,
  maxAudibleRadius: number = VOICE_MAX_AUDIBLE_RADIUS_METERS,
): number {
  if (distanceMeters <= fullVolumeRadius) return 1;
  if (distanceMeters >= maxAudibleRadius) return 0;

  const t = (distanceMeters - fullVolumeRadius) / (maxAudibleRadius - fullVolumeRadius);
  const smoothstep = t * t * (3 - 2 * t);
  return 1 - smoothstep;
}

/** Whether a remote participant at this distance should be subscribed/played at all — see CORE-004 §15 (far players unsubscribed/locally muted, not decoded for nothing). */
export function isWithinAudibleRange(
  distanceMeters: number,
  maxAudibleRadius: number = VOICE_MAX_AUDIBLE_RADIUS_METERS,
): boolean {
  return distanceMeters < maxAudibleRadius;
}

/**
 * The single reusable "should I actually hear this player, and how
 * loud" decision (CORE-004 §22/§23) — mute/block suppression short-
 * circuits distance entirely (muted/blocked always wins, 0 gain,
 * regardless of how close the player is), otherwise falls through to
 * the same distance curve above. `VoiceSession.update()` is the only
 * caller; it exists as its own pure, engine-agnostic function (same
 * reasoning as `getVoiceGain` above) so this decision is unit-testable
 * without a Web Audio/LiveKit runtime — see `VoiceProximity.test.ts`
 * Tests 5/6.
 */
export function resolveVoiceGain(
  distanceMeters: number,
  suppression: { muted: boolean; blocked: boolean },
  fullVolumeRadius: number = VOICE_FULL_VOLUME_RADIUS_METERS,
  maxAudibleRadius: number = VOICE_MAX_AUDIBLE_RADIUS_METERS,
): number {
  if (suppression.muted || suppression.blocked) return 0;
  return getVoiceGain(distanceMeters, fullVolumeRadius, maxAudibleRadius);
}
