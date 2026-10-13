/**
 * An ordered list of lightwalletd upstreams with health-based failover (LIGHTWALLETD_URL="a,b,c"), shared by
 * the wallet bridge (lwdProxy.ts) and the server's own fee/name checks (lightwalletdClient.ts).
 *
 *  - Upstreams are tried in the configured order; the first is the primary.
 *  - A connection-level failure (cannot connect, TLS, timeout, a reset stream, gRPC UNAVAILABLE) marks that upstream
 *    unhealthy for `cooldownMs`; the next one is tried at once. A definitive answer (e.g. NOT_FOUND for a transaction)
 *    is not a failure.
 *  - After the cooldown the upstream is tried again in its place, so traffic returns to the primary when it recovers.
 *  - When every upstream is cooling down they are still all tried (oldest failure first) — never "no upstream at all".
 *
 * Nothing here logs a request; only the upstream's origin may appear in a warning.
 */

export const DEFAULT_UPSTREAM_COOLDOWN_MS = 60_000;

export class UpstreamPool {
  readonly urls: readonly URL[];
  private readonly cooldownMs: number;
  private readonly now: () => number;
  /** When each upstream last failed (0 = healthy). */
  private readonly failedAt: number[];

  constructor(urls: readonly string[], options: { readonly cooldownMs?: number; readonly now?: () => number } = {}) {
    if (urls.length === 0) throw new Error("UpstreamPool needs at least one upstream");
    this.urls = urls.map((url) => new URL(url));
    this.cooldownMs = options.cooldownMs ?? DEFAULT_UPSTREAM_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
    this.failedAt = urls.map(() => 0);
  }

  get size(): number {
    return this.urls.length;
  }

  /** Whether upstream `index` is outside its cooldown. */
  healthy(index: number): boolean {
    const failed = this.failedAt[index] ?? 0;
    return failed === 0 || this.now() - failed >= this.cooldownMs;
  }

  /** The order to try the upstreams in now: healthy ones in configured order, then the cooling ones, oldest failure first. */
  order(): number[] {
    const indices = this.urls.map((_, index) => index);
    const healthy = indices.filter((index) => this.healthy(index));
    const cooling = indices.filter((index) => !this.healthy(index)).sort((a, b) => this.failedAt[a]! - this.failedAt[b]!);
    return [...healthy, ...cooling];
  }

  markFailed(index: number): void {
    if (index >= 0 && index < this.failedAt.length) this.failedAt[index] = Math.max(1, this.now());
  }

  markOk(index: number): void {
    if (index >= 0 && index < this.failedAt.length) this.failedAt[index] = 0;
  }

  /** For the startup log: the origins in order (no paths, no credentials). */
  describe(): string {
    return this.urls.map((url) => url.origin).join(", ");
  }
}
