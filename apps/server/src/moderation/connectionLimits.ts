/**
 * The per-IP connection cap (ADR-019 § 5): at most `maxSessions` concurrent game sockets and at most
 * `maxNewPerMinute` new connections per minute from one network (the keyed address hash of clientAddress.ts). Every
 * attempt counts toward the minute, a refused one too, so hammering the server does not help.
 *
 * Pure, with an injected clock. It holds keyed hashes, counts and timestamps — never an address — in memory only, and
 * `sweep()` drops a network once it has no open socket and no attempt within the last minute.
 */

/** ADR-019 § 5 defaults: four sessions (a household, a small LAN party) and ten new connections a minute. */
export const DEFAULT_MAX_SESSIONS_PER_IP = 4;
export const DEFAULT_MAX_NEW_CONNECTIONS_PER_MINUTE = 10;
const WINDOW_MS = 60_000;

export interface ConnectionLimitsOptions {
  readonly maxSessions: number;
  readonly maxNewPerMinute: number;
  readonly now: () => number;
}

interface NetworkEntry {
  open: number;
  /** Attempt times within the last minute, oldest first. */
  attempts: number[];
}

export class ConnectionLimits {
  readonly maxSessions: number;
  readonly maxNewPerMinute: number;
  private readonly now: () => number;
  private readonly networks = new Map<string, NetworkEntry>();

  constructor(options: ConnectionLimitsOptions) {
    this.maxSessions = options.maxSessions;
    this.maxNewPerMinute = options.maxNewPerMinute;
    this.now = options.now;
  }

  /** How many networks are tracked (tests: the map stays bounded). */
  get size(): number {
    return this.networks.size;
  }

  /**
   * A new connection from `network`: counted, then admitted (true — the caller must `release` it when the socket
   * closes) or refused (false) for too many open sockets or too many new connections this minute.
   */
  admit(network: string): boolean {
    const now = this.now();
    let entry = this.networks.get(network);
    if (!entry) {
      entry = { open: 0, attempts: [] };
      this.networks.set(network, entry);
    }
    prune(entry, now);
    entry.attempts.push(now);
    // The window keeps at most the cap's worth of times plus this one (an attempt beyond it is refused anyway).
    if (entry.attempts.length > this.maxNewPerMinute + 1) entry.attempts.splice(0, entry.attempts.length - this.maxNewPerMinute - 1);
    if (entry.attempts.length > this.maxNewPerMinute) return false;
    if (entry.open >= this.maxSessions) return false;
    entry.open++;
    return true;
  }

  /** An admitted socket closed. */
  release(network: string): void {
    const entry = this.networks.get(network);
    if (!entry || entry.open === 0) return;
    entry.open--;
  }

  /** Drops networks with no open socket and no attempt within the last minute. */
  sweep(): void {
    const now = this.now();
    for (const [network, entry] of this.networks) {
      prune(entry, now);
      if (entry.open === 0 && entry.attempts.length === 0) this.networks.delete(network);
    }
  }
}

function prune(entry: NetworkEntry, now: number): void {
  let drop = 0;
  // A clock step backwards keeps the times (they age out once the clock passes them again).
  while (drop < entry.attempts.length && now - entry.attempts[drop]! >= WINDOW_MS) drop++;
  if (drop > 0) entry.attempts.splice(0, drop);
}

/**
 * MAX_SESSIONS_PER_IP: unset or empty → the default (4); a positive integer → that cap; 0 → no per-IP limits at all
 * (neither the cap nor the new-connection rate — for local load tests and the e2e suite only, never a public server).
 * Anything else keeps the default and says so.
 */
export function parseMaxSessionsPerIp(raw: string | undefined): { readonly value: number; readonly warning: string | null } {
  const text = raw?.trim() ?? "";
  if (text === "") return { value: DEFAULT_MAX_SESSIONS_PER_IP, warning: null };
  const value = Number(text);
  if (Number.isSafeInteger(value) && value >= 0 && value <= 10_000) return { value, warning: null };
  return { value: DEFAULT_MAX_SESSIONS_PER_IP, warning: `MAX_SESSIONS_PER_IP is not a whole number from 0 to 10000; keeping the default (${DEFAULT_MAX_SESSIONS_PER_IP})` };
}
