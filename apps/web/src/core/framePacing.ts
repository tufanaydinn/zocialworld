/**
 * The high tier's frame-pacing guard (Renderer.adapt), as pure state so it is testable.
 *
 * When frames run slow for a while (weaker GPU, big window, 4K screen) it first drops the scene target's MSAA, then
 * steps the render resolution down (to 75 % at most — lower made text visibly soft); with lasting headroom it climbs
 * back, and retries MSAA once.
 *
 * Tuned for a full Watch Hall:
 *  - It runs on real elapsed time. It used to count the game loop's step, which is clamped to 1/15 s, so on a machine
 *    at 2 FPS each decision took 23 frames — about 12 s — and a slow hall took minutes to settle.
 *  - `crowdReduced`: still slow with MSAA off and the resolution at its floor, the bottleneck is not pixels. Then the
 *    crowd's animation detail is reduced (animationLod.ts) until there is lasting headroom again. That is the hall's
 *    budget lever: 60 animated avatars are the one cost that grows with the audience.
 */

export const SLOW_FRAME = 1 / 42;
export const FAST_FRAME = 1 / 57;
export const MIN_RESOLUTION_SCALE = 0.75;
/** A frame longer than this (a hidden tab, a breakpoint) counts as this long (a 2 FPS machine still counts real time). */
const MAX_FRAME = 0.5;

export interface PacingState {
  averageFrame: number;
  slowTime: number;
  fastTime: number;
  /** Seconds slow while already at the floor (MSAA off, minimum resolution). */
  floorSlowTime: number;
  resolutionScale: number;
  msaaOn: boolean;
  msaaDrops: number;
  crowdReduced: boolean;
}

export type PacingAction = "none" | "msaa-off" | "msaa-on" | "resolution";

export function initialPacing(msaaOn: boolean): PacingState {
  return { averageFrame: 1 / 60, slowTime: 0, fastTime: 0, floorSlowTime: 0, resolutionScale: 1, msaaOn, msaaDrops: 0, crowdReduced: false };
}

/** One frame of `frameSeconds` (real time): updates `state` in place and says what the renderer must change. */
export function pace(state: PacingState, frameSeconds: number): PacingAction {
  const frame = Math.min(MAX_FRAME, Math.max(0, frameSeconds));
  state.averageFrame += (frame - state.averageFrame) * 0.08;
  if (state.averageFrame > SLOW_FRAME) {
    state.slowTime += frame;
    state.fastTime = 0;
  } else if (state.averageFrame < FAST_FRAME) {
    state.fastTime += frame;
    state.slowTime = 0;
  } else {
    state.slowTime = 0;
    state.fastTime = 0;
  }
  const atFloor = !state.msaaOn && state.resolutionScale <= MIN_RESOLUTION_SCALE;
  state.floorSlowTime = atFloor && state.averageFrame > SLOW_FRAME ? state.floorSlowTime + frame : 0;
  if (state.floorSlowTime > 1.5) state.crowdReduced = true;
  else if (state.fastTime > 4) state.crowdReduced = false;

  if (state.slowTime > 1.5) {
    if (state.msaaOn) {
      state.msaaOn = false;
      state.msaaDrops++;
      state.slowTime = 0;
      state.fastTime = 0;
      return "msaa-off";
    }
    const next = Math.max(MIN_RESOLUTION_SCALE, state.resolutionScale - 0.05);
    if (next === state.resolutionScale) return "none";
    state.resolutionScale = next;
    state.slowTime = 0;
    state.fastTime = 0;
    return "resolution";
  }
  if (state.fastTime > 4) {
    if (state.resolutionScale < 1) {
      state.resolutionScale = Math.min(1, state.resolutionScale + 0.05);
      state.slowTime = 0;
      state.fastTime = 0;
      return "resolution";
    }
    // Retry MSAA once there is lasting headroom at full resolution; give up after it has had to be dropped twice.
    if (!state.msaaOn && state.msaaDrops > 0 && state.msaaDrops < 2 && state.fastTime > 10) {
      state.msaaOn = true;
      state.slowTime = 0;
      state.fastTime = 0;
      return "msaa-on";
    }
  }
  return "none";
}
