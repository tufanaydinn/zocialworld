/**
 * Voice distance/attenuation policy.
 *
 * Deliberately a SEPARATE set of constants from
 * `apps/web/src/social/nearby.ts`'s `SOCIAL_INTERACTION_RADIUS_METERS`
 * (5m, used for player-selection/presence) — "nearby enough to select a
 * player" and "close enough to hear full-volume voice" are different
 * product questions with different answers, and must not be conflated. This file is the one reusable source
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
 *   linear ramp or an abrupt cutoff; the only hard edge is the final cutoff at
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

/** Whether a remote participant at this distance should be subscribed/played at all — far players are unsubscribed/locally muted, not decoded for nothing. */
export function isWithinAudibleRange(
  distanceMeters: number,
  maxAudibleRadius: number = VOICE_MAX_AUDIBLE_RADIUS_METERS,
): boolean {
  return distanceMeters < maxAudibleRadius;
}

/**
 * The single reusable "should I actually hear this player, and how
 * loud" decision — mute/block suppression short-
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

/**
 * Speaking ranges. The SPEAKER picks one; every listener
 * applies the speaker's range, so a whisper stays a whisper for everyone.
 * "talk" equals the defaults above.
 */
export const VOICE_RANGES = {
  whisper: { full: 1, max: 4 },
  talk: { full: VOICE_FULL_VOLUME_RADIUS_METERS, max: VOICE_MAX_AUDIBLE_RADIUS_METERS },
  shout: { full: 8, max: 30 },
} as const;
export type VoiceRange = keyof typeof VOICE_RANGES;
export const DEFAULT_VOICE_RANGE: VoiceRange = "talk";
/** Extra metres beyond a speaker's range before their audio is subscribed (and twice that before it's dropped), so walking in and out doesn't flap. */
export const VOICE_SUBSCRIBE_MARGIN_METERS = 4;

export function parseVoiceRange(value: unknown): VoiceRange {
  return value === "whisper" || value === "talk" || value === "shout" ? value : DEFAULT_VOICE_RANGE;
}

/**
 * Final gain for one remote speaker: their range curve × the listener's
 * per-player volume × master volume (both 0–2, i.e. up to +100 %), clamped
 * to 0–2. Mute/block always wins.
 */
export function resolveSpeakerGain(
  distanceMeters: number,
  suppression: { muted: boolean; blocked: boolean },
  range: VoiceRange,
  playerVolume = 1,
  masterVolume = 1,
): number {
  const { full, max } = VOICE_RANGES[range];
  const gain = resolveVoiceGain(distanceMeters, suppression, full, max) * playerVolume * masterVolume;
  return Math.max(0, Math.min(2, gain));
}

/** Subscribe/unsubscribe decision with hysteresis — `currently` is whether the track is subscribed now. */
export function shouldSubscribe(distanceMeters: number, range: VoiceRange, currently: boolean): boolean {
  const max = VOICE_RANGES[range].max;
  return currently ? distanceMeters < max + 2 * VOICE_SUBSCRIBE_MARGIN_METERS : distanceMeters < max + VOICE_SUBSCRIBE_MARGIN_METERS;
}
