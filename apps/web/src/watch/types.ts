/**
 * Watch catalogue shapes served by the content gateway at /content/watch
 * (ADR-014 § 8, docs/architecture/WATCH_HALL.md). HTTP
 * gateway types are not wire-protocol contracts (ADR-006), so the server keeps
 * its own copy in apps/server/src/content/watch.ts and this file mirrors it.
 * All times are UTC ISO strings; the client groups "Today" by local date.
 */

export type WatchStatus = "live" | "upcoming" | "replay";

export interface WatchVideo {
  /** YouTube video id (11 characters). */
  id: string;
  title: string;
  channel: string;
  channelId: string;
  publishedAt: string | null;
  durationSec: number | null;
  views: number | null;
  status: WatchStatus;
  scheduledStart: string | null;
  concurrentViewers: number | null;
  /** https://i.ytimg.com/vi/<id>/mqdefault.jpg — always load through the gateway media proxy. */
  thumb: string;
  /** https://www.youtube.com/watch?v=<id> — opened only on an explicit click (new tab). */
  url: string;
  /** Collection id this video was listed under, if any. */
  collection?: string;
}

export type WatchEventSource = "recurring" | "calendar" | "curated";
export type WatchEventWhere = "zoom" | "youtube" | "in-person" | "hall";

export interface WatchLink {
  kind: "github" | "docs" | "zechub" | "forum" | "web";
  url: string;
}

export interface WatchEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  source: WatchEventSource;
  where: WatchEventWhere;
  /** https URL on an allowlisted host (Zoom, YouTube, zfnd.org …) or "" — opened only on an explicit click. */
  joinUrl: string;
  videoId: string | null;
  /** Redacted, tag-free, capped. */
  summary: string;
  location: string;
  speakers?: string[];
  links?: WatchLink[];
}

export interface WatchCollection {
  id: string;
  title: string;
  channel: string;
  count: number;
  description?: string;
}

export interface WatchListing {
  available: boolean;
  stale: boolean;
  generatedAt: string;
  /** Live and upcoming YouTube streams (needs the server's API key); the client buckets upcoming ones by start. */
  live: WatchVideo[];
  /** Events from now - 12 h to now + 30 days, sorted by start. */
  schedule: WatchEvent[];
  latest: WatchVideo[];
  collections: WatchCollection[];
  /** Human-readable note, e.g. "Live status needs a YouTube API key on the server". */
  notice?: string;
  /** Attribution lines for the panel footer ("label: text"), from the server's catalogue. */
  sources?: { label: string; text: string }[];
}

export interface WatchCollectionPage {
  available: boolean;
  stale: boolean;
  collection: WatchCollection;
  videos: WatchVideo[];
  page: number;
  pages: number;
}
