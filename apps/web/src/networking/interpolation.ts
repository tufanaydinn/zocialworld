/**
 * Entity interpolation buffer for remote players.
 *
 * Deliberately engine-agnostic (no Three.js types) so the actual
 * interpolation math is trivially unit-testable — see
 * interpolation.test.ts. `RemotePlayer.ts` is the only place this
 * touches `THREE.Object3D`.
 *
 * Strategy (documented in full in docs/protocols/multiplayer-protocol.md
 * § Interpolation strategy): keep a short buffer of recently received
 * `(t, x, y, z, rotationY)` samples, keyed by *local receive time*
 * (not the server's own clock — CORE-002 does no clock synchronization,
 * so mixing local and server time for interpolation math would be
 * meaningless). Render at `now - RENDER_DELAY_MS`, lerping between the
 * two samples that bracket that time. If the render time has run past
 * the newest sample (a dropped/delayed packet), hold at the latest
 * known transform rather than extrapolating — overshoot from a wrong
 * guess is more visually jarring than a brief stall.
 */

export interface TransformSample {
  /** Local receive time (e.g. `performance.now()`), in ms. Samples must be pushed in non-decreasing order of `t`. */
  t: number;
  x: number;
  y: number;
  z: number;
  rotationY: number;
}

export interface InterpolatedTransform {
  x: number;
  y: number;
  z: number;
  rotationY: number;
}

/** A bit more than one network tick at the documented ~10 Hz rate, so there's almost always a sample on each side to interpolate between. */
export const RENDER_DELAY_MS = 120;

const MAX_BUFFER_SIZE = 10;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest-path angle interpolation so a player rotating through ±π doesn't spin the long way around. */
function lerpAngle(a: number, b: number, t: number): number {
  const twoPi = Math.PI * 2;
  let diff = ((b - a + Math.PI) % twoPi) - Math.PI;
  if (diff < -Math.PI) diff += twoPi;
  return a + diff * t;
}

function toTransform(sample: TransformSample): InterpolatedTransform {
  return { x: sample.x, y: sample.y, z: sample.z, rotationY: sample.rotationY };
}

export class InterpolationBuffer {
  private samples: TransformSample[] = [];

  /** Adds a newly received sample. Samples are expected in non-decreasing `t` order; an out-of-order sample is still inserted correctly (sorted), just at extra cost. */
  push(sample: TransformSample): void {
    const last = this.samples[this.samples.length - 1];
    if (!last || sample.t >= last.t) {
      this.samples.push(sample);
    } else {
      const index = this.samples.findIndex((s) => s.t > sample.t);
      this.samples.splice(index === -1 ? this.samples.length : index, 0, sample);
    }

    if (this.samples.length > MAX_BUFFER_SIZE) {
      this.samples.shift();
    }
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  /** Returns the interpolated transform at `renderTime` (same clock as the `t` values pushed), or `null` if nothing has been pushed yet. */
  sample(renderTime: number): InterpolatedTransform | null {
    if (this.samples.length === 0) return null;
    if (this.samples.length === 1) return toTransform(this.samples[0]!);

    const first = this.samples[0]!;
    if (renderTime <= first.t) return toTransform(first);

    const last = this.samples[this.samples.length - 1]!;
    if (renderTime >= last.t) return toTransform(last); // buffer underrun — hold, don't extrapolate

    for (let i = 0; i < this.samples.length - 1; i++) {
      const a = this.samples[i]!;
      const b = this.samples[i + 1]!;
      if (renderTime >= a.t && renderTime <= b.t) {
        const span = b.t - a.t;
        const alpha = span <= 0 ? 1 : (renderTime - a.t) / span;
        return {
          x: lerp(a.x, b.x, alpha),
          y: lerp(a.y, b.y, alpha),
          z: lerp(a.z, b.z, alpha),
          rotationY: lerpAngle(a.rotationY, b.rotationY, alpha),
        };
      }
    }

    return toTransform(last); // unreachable in practice; satisfies the type checker
  }
}
