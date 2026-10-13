import { getContentBaseUrl } from "../community/config.ts";
import type { WatchCollectionPage, WatchListing } from "./types.ts";

/**
 * Typed client for the gateway's Watch Hall catalogue (`/content/watch*`).
 * Unlike CommunityClient's session memo this one EXPIRES: the listing carries live status, so it
 * is reused for about a minute (enough for the panel, the Live Now board and the speaker card to
 * share one request) and refetched after that. Failed loads are never cached, so Retry retries.
 * The browser only ever talks to our server here.
 */

export interface WatchClientOptions {
  /** Gateway base URL (default: the content gateway, `…/content`). */
  readonly base?: string;
  /** Reuse window for the listing (default 60 s). Collection pages are reused 10× longer. */
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

interface MemoEntry {
  readonly promise: Promise<unknown>;
  readonly at: number;
  settled: boolean;
}

export class WatchClient {
  private readonly base: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly fetcher: (url: string, init: RequestInit) => Promise<Response>;
  private readonly memo = new Map<string, MemoEntry>();
  private latest: WatchListing | null = null;

  constructor(options: WatchClientOptions = {}) {
    this.base = (options.base ?? getContentBaseUrl()).replace(/\/$/, "");
    this.ttlMs = options.ttlMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  }

  /** The last listing that loaded successfully (for boards that redraw between fetches), or null. */
  get lastListing(): WatchListing | null {
    return this.latest;
  }

  /** The combined listing (live, schedule, latest, collections). `fresh` skips the reuse window (the panel's 60 s poll). */
  listing(fresh = false): Promise<WatchListing> {
    return this.get<WatchListing>("/watch", this.ttlMs, fresh).then((listing) => {
      this.latest = listing;
      return listing;
    });
  }

  /** One page of a listed collection (the gateway answers 404 for anything else). */
  collection(id: string, page = 0): Promise<WatchCollectionPage> {
    const safePage = Math.max(0, Math.trunc(page));
    return this.get(`/watch/collection/${encodeURIComponent(id)}${safePage > 0 ? `?page=${safePage}` : ""}`, this.ttlMs * 10, false);
  }

  private get<T>(path: string, ttl: number, fresh: boolean): Promise<T> {
    const hit = this.memo.get(path);
    // A request still in flight is always shared; a settled one only within its window.
    if (hit && (!hit.settled || (!fresh && this.now() - hit.at < ttl))) return hit.promise as Promise<T>;
    const promise = this.fetcher(`${this.base}${path}`, { headers: { Accept: "application/json" } }).then(async (response) => {
      if (!response.ok) throw new Error(`watch ${path} → ${response.status}`);
      const body = (await response.json()) as T & { available?: boolean };
      if (body.available === false) throw new Error(`watch ${path} unavailable`);
      return body;
    });
    const entry: MemoEntry = { promise, at: this.now(), settled: false };
    this.memo.set(path, entry);
    promise.then(
      () => {
        entry.settled = true;
      },
      () => {
        // Failures are not cached: the next call (Retry) asks again.
        if (this.memo.get(path) === entry) this.memo.delete(path);
      },
    );
    return promise;
  }
}
