/**
 * A token bucket with an injected clock: `burst` tokens, refilled
 * continuously at `refillPerSecond`. The chat limiter (chat.ts) and the
 * Watch Hall's reaction / hand / broadcast-op limits (watchHall.ts) use it.
 * It holds two numbers and nothing about who is being limited.
 *
 * The clock is the wall clock in production, which can step backwards (an
 * NTP step, a VM resuming): a negative elapsed time is treated as zero, so
 * a step never drains a bucket below what it held.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly burst: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;

  constructor(burst: number, refillPerSecond: number, now: () => number) {
    this.burst = burst;
    this.refillPerSecond = refillPerSecond;
    this.now = now;
    this.tokens = burst;
    this.last = now();
  }

  /** Spends one token if one is available. */
  take(): boolean {
    const now = this.now();
    const elapsed = Math.max(0, now - this.last);
    this.tokens = Math.min(this.burst, this.tokens + (elapsed / 1000) * this.refillPerSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
