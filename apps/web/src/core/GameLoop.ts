/**
 * GameLoop drives the render/update cycle via requestAnimationFrame.
 *
 * It knows nothing about Three.js, the player, or the world — it only
 * calls `update(deltaSeconds)` then `render()` every frame and tracks
 * basic timing. Keeping this generic means future systems (fixed-step
 * networking simulation, etc.) can hook in without touching rendering.
 */

export type UpdateCallback = (deltaSeconds: number, elapsedSeconds: number) => void;
export type RenderCallback = () => void;

/** Clamp large deltas (tab backgrounded, breakpoint, etc.) so physics/movement never "jumps". */
const MAX_DELTA_SECONDS = 1 / 15;

export class GameLoop {
  private updateCallback: UpdateCallback;
  private renderCallback: RenderCallback;

  private running = false;
  private rafHandle = 0;
  private lastTimeMs = 0;
  private elapsedSeconds = 0;

  constructor(updateCallback: UpdateCallback, renderCallback: RenderCallback) {
    this.updateCallback = updateCallback;
    this.renderCallback = renderCallback;
    this.tick = this.tick.bind(this);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTimeMs = performance.now();
    this.rafHandle = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafHandle);
  }

  private tick(nowMs: number): void {
    if (!this.running) return;

    const rawDelta = (nowMs - this.lastTimeMs) / 1000;
    this.lastTimeMs = nowMs;
    const delta = Math.min(rawDelta, MAX_DELTA_SECONDS);
    this.elapsedSeconds += delta;

    this.updateCallback(delta, this.elapsedSeconds);
    this.renderCallback();

    this.rafHandle = requestAnimationFrame(this.tick);
  }
}
