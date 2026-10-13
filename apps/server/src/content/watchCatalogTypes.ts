import { parseRrule } from "./watch.js";

/**
 * The Watch Hall catalogue: which YouTube channels the gateway may list, the curated collections of replays, the
 * recurring events and public calendars behind the schedule, one-off events, and the attribution lines shown under
 * the Watch panel. The server reads it once at start (`watchCatalogFile.ts`): a JSON file in the shape of
 * `WatchCatalogJson`, checked by `parseWatchCatalog`, or the sample catalogue (`watchCatalog.sample.ts`).
 *
 * Only channels, playlists and video ids from the catalogue are ever fetched or listed; calendars are fetched only
 * from the URLs listed here and only events matching a rule are kept.
 */

export type WatchPlace = "zoom" | "youtube" | "in-person" | "hall";

/** One attribution line under the Watch panel, rendered as "label: text". */
export interface WatchSourceCredit {
  readonly label: string;
  readonly text: string;
}

export interface WatchChannelSource {
  /** YouTube channel id (UC + 22 characters). */
  readonly id: string;
  readonly title: string;
}

export interface CuratedVideo {
  /** YouTube video id (11 characters). */
  readonly id: string;
  readonly title: string;
  /** Upload time, ISO 8601. */
  readonly publishedAt: string;
  readonly durationSec: number;
}

export interface WatchCollectionSource {
  /** [a-z0-9-]{1,48} — also the `/content/watch/collection/:id` path segment. */
  readonly id: string;
  readonly title: string;
  readonly channel: WatchChannelSource;
  readonly description: string;
  /** Live source: a YouTube playlist (Data API playlistItems.list, or its Atom feed). */
  readonly playlistId?: string;
  /** Live source when there is no playlist: the channel's uploads, keeping titles that match. */
  readonly titleFilter?: RegExp;
  /** Still growing: live data refreshes more often than for a finished series. */
  readonly active: boolean;
  /** The verified fallback entries, in display order (newest first for active collections). */
  readonly videos: readonly CuratedVideo[];
}

/** A series on a fixed rule (RFC 5545 RRULE, UTC). Occurrence ids are `<id>-<yyyymmdd>`. */
export interface WatchRecurringEvent {
  /** [a-z0-9-]{1,32}; unique among recurring events and calendars. */
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** The first occurrence's start, ISO 8601 UTC. */
  readonly start: string;
  readonly durationMin: number;
  readonly rrule: string;
  readonly where: WatchPlace;
  /** Our own location text. */
  readonly location: string;
  /** https link a player opens to join, or "" for none. */
  readonly joinUrl: string;
  /** https page about the series, offered as a link on each occurrence. */
  readonly infoUrl?: string;
  /**
   * The organiser's own iCalendar file. When it answers with a calendar, its first weekly recurring event replaces
   * `start`, `durationMin` and `rrule` (with its EXDATEs); its location, description and links are never used.
   */
  readonly icsUrl?: string;
}

/** Keeps one kind of event from a public calendar; everything else in that calendar is dropped before caching. */
export interface WatchCalendarRule {
  /** Matched against the trimmed SUMMARY. */
  readonly title: RegExp;
  /** Prefix of the event ids ([a-z0-9-]). */
  readonly idPrefix: string;
  readonly where: Exclude<WatchPlace, "hall">;
  /** Our own text — never the calendar's LOCATION. */
  readonly location: string;
  /** Our own link for the event — never one taken from the calendar. */
  readonly infoUrl: string;
  /** Rewrites a kept title (to unify spellings); the result must still match `title`. */
  readonly rename?: { readonly pattern: RegExp; readonly replacement: string };
}

export interface WatchCalendarFeed {
  /** [a-z0-9-]{1,32}; unique among recurring events and calendars. */
  readonly id: string;
  /** A public iCalendar (.ics) URL, https. */
  readonly url: string;
  readonly rules: readonly WatchCalendarRule[];
}

export interface CuratedEvent {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly where: Exclude<WatchPlace, "hall">;
  readonly joinUrl: string;
  readonly summary: string;
  readonly location: string;
  /** Left out while a calendar lists any event whose title matches (the entry stands in for those sessions). */
  readonly fallbackForCalendar?: RegExp;
}

export interface WatchCatalog {
  readonly sources: readonly WatchSourceCredit[];
  readonly channels: readonly WatchChannelSource[];
  readonly collections: readonly WatchCollectionSource[];
  readonly recurringEvents: readonly WatchRecurringEvent[];
  readonly calendars: readonly WatchCalendarFeed[];
  readonly curatedEvents: readonly CuratedEvent[];
}

// ---------------------------------------------------------------- the JSON file

/** A regular expression in JSON: its source and flags (only `i`, `m`, `s` and `u` are allowed). */
export interface WatchPatternJson {
  readonly pattern: string;
  readonly flags?: string;
}

export interface WatchCatalogJson {
  readonly sources: readonly WatchSourceCredit[];
  readonly channels: readonly WatchChannelSource[];
  readonly collections: readonly (Omit<WatchCollectionSource, "channel" | "titleFilter"> & { readonly channel: string; readonly titleFilter?: WatchPatternJson })[];
  readonly recurringEvents?: readonly WatchRecurringEvent[];
  readonly calendars?: readonly (Omit<WatchCalendarFeed, "rules"> & {
    readonly rules: readonly (Omit<WatchCalendarRule, "title" | "rename"> & { readonly title: WatchPatternJson; readonly rename?: WatchPatternJson & { readonly replacement: string } })[];
  })[];
  readonly curatedEvents?: readonly (Omit<CuratedEvent, "fallbackForCalendar"> & { readonly fallbackForCalendar?: WatchPatternJson })[];
}

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,64}$/;
const COLLECTION_ID = /^[a-z0-9-]{1,48}$/;
const SHORT_ID = /^[a-z0-9-]{1,32}$/;
const PLACES: readonly string[] = ["zoom", "youtube", "in-person", "hall"];

type Json = Record<string, unknown>;

/** Collects every problem of a catalogue file instead of stopping at the first. */
class Checker {
  readonly problems: string[] = [];

  object(value: unknown, at: string): Json {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Json;
    this.problems.push(`${at}: expected an object`);
    return {};
  }

  list(value: unknown, at: string, optional = false): unknown[] {
    if (Array.isArray(value)) return value;
    if (!(optional && value === undefined)) this.problems.push(`${at}: expected a list`);
    return [];
  }

  text(value: unknown, at: string, pattern?: RegExp): string {
    if (typeof value === "string" && value.trim() !== "" && (!pattern || pattern.test(value))) return value;
    this.problems.push(`${at}: expected ${pattern ? `text matching ${pattern}` : "non-empty text"}`);
    return "";
  }

  optionalText(value: unknown, at: string, pattern?: RegExp): string | undefined {
    return value === undefined ? undefined : this.text(value, at, pattern);
  }

  https(value: unknown, at: string, allowEmpty = false): string {
    if (allowEmpty && value === "") return "";
    if (typeof value === "string" && /^https:\/\/[^\s/]+/.test(value)) return value;
    this.problems.push(`${at}: expected an https URL${allowEmpty ? ' or ""' : ""}`);
    return "";
  }

  time(value: unknown, at: string): string {
    if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
    this.problems.push(`${at}: expected an ISO 8601 time`);
    return new Date(0).toISOString();
  }

  positive(value: unknown, at: string): number {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    this.problems.push(`${at}: expected a positive number`);
    return 1;
  }

  place<T extends string>(value: unknown, at: string, allowHall: boolean): T {
    if (typeof value === "string" && PLACES.includes(value) && (allowHall || value !== "hall")) return value as T;
    this.problems.push(`${at}: expected one of ${PLACES.filter((place) => allowHall || place !== "hall").join(", ")}`);
    return "youtube" as T;
  }

  pattern(value: unknown, at: string): RegExp {
    const spec = this.object(value, at);
    const source = this.text(spec.pattern, `${at}.pattern`);
    const flags = spec.flags === undefined ? "" : typeof spec.flags === "string" && /^[imsu]*$/.test(spec.flags) ? spec.flags : null;
    if (flags === null) {
      this.problems.push(`${at}.flags: only i, m, s and u are allowed`);
      return /$^/;
    }
    try {
      return new RegExp(source, flags);
    } catch {
      this.problems.push(`${at}.pattern: not a valid regular expression`);
      return /$^/;
    }
  }

  unique(ids: readonly string[], what: string): void {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) this.problems.push(`duplicate ${what} ${id}`);
      seen.add(id);
    }
  }
}

/**
 * Checks a catalogue file (parsed JSON) and turns it into a `WatchCatalog`: patterns become regular expressions and
 * each collection's channel id becomes its channel. Throws one error listing every problem.
 */
export function parseWatchCatalog(json: unknown): WatchCatalog {
  const check = new Checker();
  const root = check.object(json, "catalogue");

  const sources = check.list(root.sources, "sources").map((raw, i) => {
    const source = check.object(raw, `sources[${i}]`);
    return { label: check.text(source.label, `sources[${i}].label`), text: check.text(source.text, `sources[${i}].text`) };
  });

  const channels = check.list(root.channels, "channels").map((raw, i) => {
    const channel = check.object(raw, `channels[${i}]`);
    return { id: check.text(channel.id, `channels[${i}].id`, CHANNEL_ID), title: check.text(channel.title, `channels[${i}].title`) };
  });
  check.unique(channels.map((channel) => channel.id), "channel");

  const collections = check.list(root.collections, "collections").map((raw, i): WatchCollectionSource => {
    const at = `collections[${i}]`;
    const collection = check.object(raw, at);
    const channelId = check.text(collection.channel, `${at}.channel`, CHANNEL_ID);
    const channel = channels.find((candidate) => candidate.id === channelId);
    if (channelId && !channel) check.problems.push(`${at}.channel: ${channelId} is not in channels`);
    const playlistId = check.optionalText(collection.playlistId, `${at}.playlistId`, PLAYLIST_ID);
    if (typeof collection.active !== "boolean") check.problems.push(`${at}.active: expected true or false`);
    const videos = check.list(collection.videos, `${at}.videos`).map((rawVideo, k) => {
      const video = check.object(rawVideo, `${at}.videos[${k}]`);
      const durationSec = check.positive(video.durationSec, `${at}.videos[${k}].durationSec`);
      return {
        id: check.text(video.id, `${at}.videos[${k}].id`, VIDEO_ID),
        title: check.text(video.title, `${at}.videos[${k}].title`),
        publishedAt: check.time(video.publishedAt, `${at}.videos[${k}].publishedAt`),
        durationSec: Math.round(durationSec),
      };
    });
    return {
      id: check.text(collection.id, `${at}.id`, COLLECTION_ID),
      title: check.text(collection.title, `${at}.title`),
      channel: channel ?? { id: channelId, title: "" },
      description: check.text(collection.description, `${at}.description`),
      ...(playlistId !== undefined ? { playlistId } : {}),
      ...(collection.titleFilter !== undefined ? { titleFilter: check.pattern(collection.titleFilter, `${at}.titleFilter`) } : {}),
      active: collection.active === true,
      videos,
    };
  });
  check.unique(collections.map((collection) => collection.id), "collection");
  // A video belongs to one collection: the listing tags channel uploads with the first collection that holds them.
  check.unique(collections.flatMap((collection) => collection.videos.map((video) => video.id)), "video");

  const recurringEvents = check.list(root.recurringEvents, "recurringEvents", true).map((raw, i): WatchRecurringEvent => {
    const at = `recurringEvents[${i}]`;
    const event = check.object(raw, at);
    const rrule = check.text(event.rrule, `${at}.rrule`);
    if (rrule && !parseRrule(rrule)) check.problems.push(`${at}.rrule: not a recurrence rule`);
    const infoUrl = event.infoUrl === undefined ? undefined : check.https(event.infoUrl, `${at}.infoUrl`);
    const icsUrl = event.icsUrl === undefined ? undefined : check.https(event.icsUrl, `${at}.icsUrl`);
    return {
      id: check.text(event.id, `${at}.id`, SHORT_ID),
      title: check.text(event.title, `${at}.title`),
      summary: check.text(event.summary, `${at}.summary`),
      start: check.time(event.start, `${at}.start`),
      durationMin: check.positive(event.durationMin, `${at}.durationMin`),
      rrule,
      where: check.place<WatchPlace>(event.where, `${at}.where`, true),
      location: check.text(event.location, `${at}.location`),
      joinUrl: check.https(event.joinUrl, `${at}.joinUrl`, true),
      ...(infoUrl !== undefined ? { infoUrl } : {}),
      ...(icsUrl !== undefined ? { icsUrl } : {}),
    };
  });

  const calendars = check.list(root.calendars, "calendars", true).map((raw, i): WatchCalendarFeed => {
    const at = `calendars[${i}]`;
    const calendar = check.object(raw, at);
    return {
      id: check.text(calendar.id, `${at}.id`, SHORT_ID),
      url: check.https(calendar.url, `${at}.url`),
      rules: check.list(calendar.rules, `${at}.rules`).map((rawRule, k): WatchCalendarRule => {
        const ruleAt = `${at}.rules[${k}]`;
        const rule = check.object(rawRule, ruleAt);
        let rename: WatchCalendarRule["rename"];
        if (rule.rename !== undefined) {
          const replacement = check.object(rule.rename, `${ruleAt}.rename`).replacement;
          if (typeof replacement !== "string") check.problems.push(`${ruleAt}.rename.replacement: expected text`);
          rename = { pattern: check.pattern(rule.rename, `${ruleAt}.rename`), replacement: typeof replacement === "string" ? replacement : "" };
        }
        return {
          title: check.pattern(rule.title, `${ruleAt}.title`),
          idPrefix: check.text(rule.idPrefix, `${ruleAt}.idPrefix`, SHORT_ID),
          where: check.place<Exclude<WatchPlace, "hall">>(rule.where, `${ruleAt}.where`, false),
          location: check.text(rule.location, `${ruleAt}.location`),
          infoUrl: check.https(rule.infoUrl, `${ruleAt}.infoUrl`),
          ...(rename ? { rename } : {}),
        };
      }),
    };
  });
  check.unique([...recurringEvents.map((event) => event.id), ...calendars.map((calendar) => calendar.id)], "recurring event or calendar id");

  const curatedEvents = check.list(root.curatedEvents, "curatedEvents", true).map((raw, i): CuratedEvent => {
    const at = `curatedEvents[${i}]`;
    const event = check.object(raw, at);
    const start = check.time(event.start, `${at}.start`);
    const end = check.time(event.end, `${at}.end`);
    if (Date.parse(end) < Date.parse(start)) check.problems.push(`${at}: ends before it starts`);
    return {
      id: check.text(event.id, `${at}.id`, COLLECTION_ID),
      title: check.text(event.title, `${at}.title`),
      start,
      end,
      where: check.place<Exclude<WatchPlace, "hall">>(event.where, `${at}.where`, false),
      joinUrl: check.https(event.joinUrl, `${at}.joinUrl`, true),
      summary: check.text(event.summary, `${at}.summary`),
      location: check.text(event.location, `${at}.location`),
      ...(event.fallbackForCalendar !== undefined ? { fallbackForCalendar: check.pattern(event.fallbackForCalendar, `${at}.fallbackForCalendar`) } : {}),
    };
  });
  check.unique(curatedEvents.map((event) => event.id), "curated event");

  if (check.problems.length > 0) throw new Error(`invalid watch catalogue:\n  ${check.problems.join("\n  ")}`);
  return { sources, channels, collections, recurringEvents, calendars, curatedEvents };
}
