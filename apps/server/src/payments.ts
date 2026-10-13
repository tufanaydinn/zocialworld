/**
 * Relay rules for private player-to-player payments (ADR-013).
 *
 * The server never sees an address, amount or memo — those travel sealed
 * between the two browsers. What it does enforce:
 *  - a request goes to an existing, different session;
 *  - accept/decline only answer a request this server relayed, from its
 *    recipient back to its sender; a notice only follows an accepted
 *    request, from its sender to its recipient — so nobody can push
 *    sealed data (e.g. an address) to a player who never asked;
 *  - per-session rate limit on new requests;
 *  - requests expire (5 min to answer, 30 min for the notice).
 * Nothing is logged; pending entries hold only two session ids and times.
 */

export const PAY_REQUEST_TTL_MS = 5 * 60 * 1000;
export const PAY_NOTICE_TTL_MS = 30 * 60 * 1000;
const REQUEST_BURST = 3;
const REQUEST_REFILL_PER_SECOND = 1 / 10;
const MAX_PENDING = 5000;

interface Pending {
  from: string;
  to: string;
  expiresAt: number;
  accepted: boolean;
}

export type RelayDecision = { ok: true; target: string } | { ok: false; reason: "unknown_request" | "rate_limited" };

export class PaymentRelay {
  private readonly pending = new Map<string, Pending>();
  private readonly buckets = new Map<string, { tokens: number; last: number }>();
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  /** A new request from `from` to `to` (both already validated as live, distinct sessions). */
  request(requestId: string, from: string, to: string): RelayDecision {
    this.sweep();
    if (this.pending.has(requestId)) return { ok: false, reason: "unknown_request" };
    if (!this.take(from)) return { ok: false, reason: "rate_limited" };
    if (this.pending.size >= MAX_PENDING) return { ok: false, reason: "rate_limited" };
    this.pending.set(requestId, { from, to, expiresAt: this.now() + PAY_REQUEST_TTL_MS, accepted: false });
    return { ok: true, target: to };
  }

  /** Recipient answers (accept or decline) → goes to the original sender. */
  answer(requestId: string, by: string, accepted: boolean): RelayDecision {
    const entry = this.live(requestId);
    if (!entry || entry.to !== by || entry.accepted) return { ok: false, reason: "unknown_request" };
    if (accepted) {
      entry.accepted = true;
      entry.expiresAt = this.now() + PAY_NOTICE_TTL_MS;
    } else {
      this.pending.delete(requestId);
    }
    return { ok: true, target: entry.from };
  }

  /** Sender reports the broadcast payment → goes to the recipient; closes the request. */
  notice(requestId: string, by: string): RelayDecision {
    const entry = this.live(requestId);
    if (!entry || entry.from !== by || !entry.accepted) return { ok: false, reason: "unknown_request" };
    this.pending.delete(requestId);
    return { ok: true, target: entry.to };
  }

  /**
   * The SENDER withdraws its request, before or after the acceptance → goes to the
   * recipient; closes the request. Nobody else may cancel it.
   */
  cancel(requestId: string, by: string): RelayDecision {
    const entry = this.live(requestId);
    if (!entry || entry.from !== by) return { ok: false, reason: "unknown_request" };
    this.pending.delete(requestId);
    return { ok: true, target: entry.to };
  }

  /**
   * A session left: forget its pending requests. Returns them, so the caller can tell the other side and drop the
   * fee entries that can no longer be paid or cancelled through the relay.
   */
  forget(playerId: string): { requestId: string; from: string; to: string }[] {
    const removed: { requestId: string; from: string; to: string }[] = [];
    const now = this.now();
    for (const [id, entry] of this.pending) {
      if (entry.from !== playerId && entry.to !== playerId) continue;
      this.pending.delete(id);
      if (entry.expiresAt >= now) removed.push({ requestId: id, from: entry.from, to: entry.to });
    }
    this.buckets.delete(playerId);
    return removed;
  }

  get size(): number {
    return this.pending.size;
  }

  private live(requestId: string): Pending | null {
    const entry = this.pending.get(requestId);
    if (!entry) return null;
    if (entry.expiresAt < this.now()) {
      this.pending.delete(requestId);
      return null;
    }
    return entry;
  }

  private take(playerId: string): boolean {
    const now = this.now();
    const bucket = this.buckets.get(playerId) ?? { tokens: REQUEST_BURST, last: now };
    bucket.tokens = Math.min(REQUEST_BURST, bucket.tokens + ((now - bucket.last) / 1000) * REQUEST_REFILL_PER_SECOND);
    bucket.last = now;
    this.buckets.set(playerId, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.pending) if (entry.expiresAt < now) this.pending.delete(id);
  }
}
