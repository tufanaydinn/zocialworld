/**
 * Animation level of detail for remote players (a full Watch Hall is 59 animated avatars).
 *
 * A remote avatar's animation (KayKit AnimationMixer + emote bone layer, or the placeholder's procedural limbs) is the
 * biggest per-player CPU cost, and every animation step also forces its skeleton's matrices and bone texture to be
 * rebuilt. Nearby players animate every frame; further away a step is due only once `minimumInterval` seconds of
 * animation time have piled up, and the whole pile is applied in one step, so loops stay in phase and a crossfade
 * still finishes on time. The interval is in seconds, not frames: at 60 FPS a seated viewer 15 m away steps at 30 Hz
 * (every 2nd frame), at 30 FPS every frame — a slow machine never sees choppier motion than a fast one.
 *
 * Off-screen players don't animate at all (RemotePlayerManager's frustum test); their time is applied when they are
 * back in view.
 */

/** Within this distance (metres from the camera) a player animates every frame. */
export const FULL_RATE_DISTANCE = 10;
/** The same, while the frame-pacing guard asks for less crowd detail (core/framePacing.ts `crowdReduced`). */
export const REDUCED_FULL_RATE_DISTANCE = 6;

export interface AnimationLodFacts {
  /** Metres from the camera. */
  readonly distance: number;
  /** Walking or jogging: a gait reads choppy sooner than a seated idle, so it keeps at least 30 Hz (20 Hz reduced). */
  readonly moving: boolean;
  /** The machine cannot hold its frame budget even at the lowest resolution: every rate is halved. */
  readonly reduced?: boolean;
}

/** Seconds of animation that must pile up before the next step (0: every frame). */
export function animationInterval(facts: AnimationLodFacts): number {
  const { distance } = facts;
  const reduced = facts.reduced === true;
  if (!(distance > (reduced ? REDUCED_FULL_RATE_DISTANCE : FULL_RATE_DISTANCE))) return 0;
  if (facts.moving) return reduced ? 1 / 20 : 1 / 30;
  if (distance <= 18) return reduced ? 1 / 15 : 1 / 30;
  if (distance <= 28) return reduced ? 1 / 10 : 1 / 20;
  return reduced ? 1 / 8 : 1 / 15;
}

/** Whether a step is due with `pending` seconds of animation time waiting. */
export function animationStepDue(pending: number, interval: number): boolean {
  return pending >= interval;
}

/**
 * Where a player's pending time starts (0 … interval), from a stable per-player seed: players at the same distance
 * then step on different frames instead of all at once.
 */
export function animationPhase(seed: number, interval: number): number {
  const fraction = (((seed * 0.618034) % 1) + 1) % 1;
  return fraction * interval;
}
