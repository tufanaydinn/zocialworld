import { YOUTUBE_API, YOUTUBE_FEEDS } from "./sources.js";
import type { CuratedEvent, WatchCalendarRule, WatchCatalog, WatchCollectionSource, WatchRecurringEvent, WatchSourceCredit } from "./watchCatalogTypes.js";

/**
 * Watch Hall listings for the content gateway: `GET /content/watch` and `GET /content/watch/collection/:id`
 * (ADR-014 § 8, docs/architecture/WATCH_HALL.md). What is listed comes from the catalogue the server was
 * started with (`watchCatalogTypes.ts`); this module is the engine.
 *
 * Sources, each degrading to the next:
 *  1. YouTube Data API v3 when the server has YOUTUBE_API_KEY (playlistItems.list and videos.list,
 *     never search.list) — the only source of live/upcoming status and viewer counts;
 *  2. the public Atom feeds (a failure is remembered for 5 minutes, so a dead feed is not hammered);
 *  3. the catalogue's verified replays — always.
 * The schedule is the catalogue's recurring events (each from its organiser's own .ics when that really is a
 * calendar, else from the rule in the catalogue), its public calendars filtered by title rules, and its one-off
 * events.
 *
 * Everything here is pure except `createWatchSource`, which only uses the gateway's own cached,
 * de-duplicated, size-capped upstream loader. The API key is never logged, never part of a cache
 * key and never in a response; free text is stripped of tags, links and personal data and capped.
 *
 * HTTP gateway shapes are not wire-protocol contracts (ADR-006): apps/web/src/watch/types.ts mirrors
 * the types below.
 */

// ---------------------------------------------------------------- shapes (mirrored by apps/web/src/watch/types.ts)

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
  /** https://i.ytimg.com/vi/<id>/mqdefault.jpg — always loaded through the gateway media proxy. */
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
  /** https link from the catalogue (never from a calendar) or "" — opened only on an explicit click. */
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
  /** Live and upcoming YouTube streams (needs the API key); the client buckets upcoming ones by start. */
  live: WatchVideo[];
  /** Events from now - 12 h to now + 30 days, sorted by start. */
  schedule: WatchEvent[];
  latest: WatchVideo[];
  collections: WatchCollection[];
  /** Human-readable note, e.g. that live status needs a YouTube API key on the server. */
  notice?: string;
  /** Attribution lines for the panel footer, from the catalogue. */
  sources?: WatchSourceCredit[];
}

export interface WatchCollectionPage {
  available: boolean;
  stale: boolean;
  collection: WatchCollection;
  videos: WatchVideo[];
  page: number;
  pages: number;
}

// ---------------------------------------------------------------- small helpers

export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
export const thumbUrl = (id: string): string => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
export const videoUrl = (id: string): string => `https://www.youtube.com/watch?v=${id}`;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** A failing source is not asked again for this long. */
export const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
/** Live status (videos.list) is refreshed at most this often. */
const LIVE_TTL_MS = 60 * 1000;
/** Schedule window around "now". */
const SCHEDULE_PAST_MS = 12 * HOUR_MS;
const SCHEDULE_FUTURE_MS = 30 * DAY_MS;
export const WATCH_PAGE_SIZE = 24;
export const WATCH_MAX_PAGE = 20;
const LATEST_MAX = 12;
const SUMMARY_MAX = 600;
const TITLE_MAX = 160;

/** Strips control characters and caps length — same rules as communityContent.cleanText (kept local: no import cycle). */
function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const point = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/**
 * Removes personal data from relayed free text (WATCH_HALL.md): e-mail addresses, phone numbers
 * (9–15 digits), Zcash addresses (t1/t3 transparent, zs1 Sapling, u1 unified, tex1) and Bitcoin
 * addresses (legacy and bech32). Over-redacting a long number is the safe failure.
 */
export function redactPersonal(text: string): string {
  return (
    text
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "[email]")
      // Zcash shielded / unified / TEX and Bitcoin bech32: bech32 alphabet (no 1, b, i, o after the separator).
      .replace(/\b(?:u1[02-9ac-hj-np-z]{50,}|zs1[02-9ac-hj-np-z]{60,}|tex1[02-9ac-hj-np-z]{30,}|bc1[02-9ac-hj-np-z]{11,71})\b/gi, "[address]")
      // Zcash transparent: t1 / t3 + 33 base58 characters.
      .replace(/\bt[13][1-9A-HJ-NP-Za-km-z]{33}\b/g, "[address]")
      // Bitcoin legacy (1… / 3…): base58, 26–35 characters, mixed case with digits like every real address.
      .replace(/\b[13][1-9A-HJ-NP-Za-km-z]{25,34}\b/g, (match) => (/[a-z]/.test(match) && /[A-Z]/.test(match) && /\d/.test(match.slice(1)) ? "[address]" : match))
      .replace(/(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d[\d\s.-]{6,}\d/g, (match) => {
        const digits = match.replace(/\D/g, "").length;
        return digits >= 9 && digits <= 15 && !/\d{4}-\d{2}-\d{2}/.test(match) ? "[phone]" : match;
      })
  );
}

/** HTML or plain free text → one redacted, link-free, capped paragraph. */
export function cleanFreeText(value: unknown, max = SUMMARY_MAX): string {
  if (typeof value !== "string") return "";
  const text = decodeEntities(
    value
      .replace(/<\s*(br|\/p|\/li|\/div|\/h\d)\b[^>]*>/gi, " ")
      .replace(/<[^>]*>/g, "")
      .replace(/<|>/g, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
  return clean(redactPersonal(stripLinksAndSecrets(text)), max);
}

/**
 * Drops links (with or without a scheme: "meet.google.com/abc-defg-hij", "zoom.us/j/1?pwd=…")
 * and redacts meeting credentials ("Passcode: 942817", "Meeting ID: 123 456 7890"), so no
 * conference field ever reaches a player (WATCH_HALL.md).
 */
export function stripLinksAndSecrets(text: string): string {
  return text
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*/gi, "")
    .replace(/\b(meeting\s*id|passcode|password|pwd|pin|access\s*code)\b\s*[:=#]?\s*[\w-]+(?:\s+\d+)*/gi, "$1: [redacted]")
    .replace(/\s+/g, " ")
    .trim();
}

/** A calendar title → redacted, link-free, capped (the allowlist matched the raw SUMMARY first). */
export function cleanCalendarTitle(value: string): string {
  return clean(redactPersonal(stripLinksAndSecrets(value.replace(/\s+/g, " ").trim())), TITLE_MAX);
}

/** "Talk title - ZconVI #zcash #ZEC" → "Talk title - ZconVI" (hashtag runs at the end only). */
export function tidyTitle(value: unknown): string {
  const title = clean(typeof value === "string" ? decodeEntities(value) : "", TITLE_MAX).replace(/\s+/g, " ").trim();
  const tidy = title.replace(/(?:\s+#[\p{L}\p{N}_]+)+$/u, "").trim();
  return tidy || title;
}

/** ISO 8601 duration ("PT1H26M5S", "P0D") → seconds, or null for zero/invalid. */
export function parseIsoDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!match) return null;
  const [, d = "0", h = "0", m = "0", s = "0"] = match;
  const seconds = Number(d) * 86400 + Number(h) * 3600 + Number(m) * 60 + Number(s);
  return seconds > 0 ? seconds : null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function countOrNull(value: unknown): number | null {
  const number = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Short stable hash for ids (FNV-1a, 32 bit, hex). */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

/** 2026-10-15T15:00Z → "20261015" (or "202610151500" with the time). */
function compactUtc(time: number, withTime = false): string {
  const iso = new Date(time).toISOString();
  const date = iso.slice(0, 10).replace(/-/g, "");
  return withTime ? `${date}${iso.slice(11, 16).replace(":", "")}` : date;
}

// ---------------------------------------------------------------- YouTube mapping

export interface MapVideoOptions {
  /** Keep only videos from these channels. */
  readonly channelIds?: readonly string[];
  /** Tag every video with this collection id. */
  readonly collection?: string;
}

/**
 * YouTube Data API v3 → WatchVideo[]. Accepts a `videos.list` response (snippet, contentDetails,
 * statistics, liveStreamingDetails → live/upcoming/replay, viewers, duration) or a
 * `playlistItems.list` response (snippet + contentDetails → replays without duration). Private and
 * deleted items, malformed ids and other channels are dropped; duplicates keep the first.
 */
export function mapYoutubeVideos(payload: unknown, options: MapVideoOptions = {}): WatchVideo[] {
  const items = record(payload).items;
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const out: WatchVideo[] = [];
  for (const raw of items) {
    const item = record(raw);
    const snippet = record(item.snippet);
    const details = record(item.contentDetails);
    const isPlaylistItem = item.kind === "youtube#playlistItem" || snippet.resourceId !== undefined;
    const id = isPlaylistItem ? (details.videoId ?? record(snippet.resourceId).videoId) : item.id;
    if (typeof id !== "string" || !VIDEO_ID_PATTERN.test(id) || seen.has(id)) continue;
    const channelId = isPlaylistItem ? snippet.videoOwnerChannelId : snippet.channelId;
    // Private/deleted playlist entries carry no owner channel.
    if (typeof channelId !== "string" || !/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) continue;
    if (options.channelIds && !options.channelIds.includes(channelId)) continue;
    const live = record(item.liveStreamingDetails);
    const broadcast = snippet.liveBroadcastContent;
    const status: WatchStatus = !isPlaylistItem && broadcast === "live" ? "live" : !isPlaylistItem && broadcast === "upcoming" ? "upcoming" : "replay";
    seen.add(id);
    const video: WatchVideo = {
      id,
      title: tidyTitle(snippet.title),
      channel: clean(isPlaylistItem ? snippet.videoOwnerChannelTitle : snippet.channelTitle, 80),
      channelId,
      publishedAt: isoOrNull(isPlaylistItem ? details.videoPublishedAt : snippet.publishedAt),
      durationSec: isPlaylistItem ? null : parseIsoDuration(details.duration),
      views: isPlaylistItem ? null : countOrNull(record(item.statistics).viewCount),
      status,
      scheduledStart: status === "replay" ? null : isoOrNull(live.scheduledStartTime),
      concurrentViewers: status === "live" ? countOrNull(live.concurrentViewers) : null,
      thumb: thumbUrl(id),
      url: videoUrl(id),
    };
    if (options.collection) video.collection = options.collection;
    out.push(video);
  }
  return out;
}

function xmlField(entry: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`).exec(entry);
  return match ? decodeEntities(match[1]!.trim()) : null;
}

/** A YouTube channel/playlist Atom feed → replays (the feed has no live flag and no duration). */
export function mapYoutubeFeed(xml: unknown, options: MapVideoOptions = {}): WatchVideo[] {
  if (typeof xml !== "string" || !xml.includes("<feed")) return [];
  const seen = new Set<string>();
  const out: WatchVideo[] = [];
  for (const [, entry = ""] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const id = xmlField(entry, "yt:videoId");
    const channelId = xmlField(entry, "yt:channelId");
    if (!id || !VIDEO_ID_PATTERN.test(id) || seen.has(id)) continue;
    if (!channelId || !/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) continue;
    if (options.channelIds && !options.channelIds.includes(channelId)) continue;
    seen.add(id);
    const author = /<author>([\s\S]*?)<\/author>/.exec(entry)?.[1] ?? "";
    const views = /<media:statistics\s+views="(\d{1,15})"/.exec(entry)?.[1];
    const video: WatchVideo = {
      id,
      title: tidyTitle(xmlField(entry, "title")),
      channel: clean(xmlField(author, "name"), 80),
      channelId,
      publishedAt: isoOrNull(xmlField(entry, "published")),
      durationSec: null,
      views: views === undefined ? null : countOrNull(views),
      status: "replay",
      scheduledStart: null,
      concurrentViewers: null,
      thumb: thumbUrl(id),
      url: videoUrl(id),
    };
    if (options.collection) video.collection = options.collection;
    out.push(video);
  }
  return out;
}

// ---------------------------------------------------------------- iCalendar (RFC 5545 subset)

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

export interface RecurrenceRule {
  readonly freq: "DAILY" | "WEEKLY" | "OTHER";
  readonly interval: number;
  /** Weekdays, 0 = Sunday … 6 = Saturday (empty: the start's weekday). */
  readonly byDay: readonly number[];
  readonly until: number | null;
  readonly count: number | null;
  /** Week start, 0 = Sunday (default Monday). */
  readonly weekStart: number;
}

export interface IcsEvent {
  readonly uid: string;
  readonly summary: string;
  readonly description: string;
  readonly location: string;
  readonly status: string;
  /** Epoch ms (UTC). */
  readonly start: number;
  readonly end: number;
  readonly allDay: boolean;
  readonly rrule: RecurrenceRule | null;
  readonly exdates: readonly number[];
  readonly recurrenceId: number | null;
  /** X-GOOGLE-CONFERENCE / CONFERENCE present (never relayed). */
  readonly conference: boolean;
}

export interface IcsOccurrence {
  readonly event: IcsEvent;
  readonly start: number;
  readonly end: number;
}

/** TEXT value escapes: \\ \; \, \n \N. */
export function unescapeIcsText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_whole, char: string) => (char === "n" || char === "N" ? "\n" : char));
}

/**
 * A DATE-TIME in UTC ("20261015T150000Z") or a DATE ("20261015", all day, as UTC midnight).
 * Local times (TZID or floating) are outside this subset → null, and the event is skipped: a wrong
 * time is worse than a missing event. (Both ZF calendars publish UTC.)
 */
export function parseIcsDate(value: string, params = ""): { time: number; allDay: boolean } | null {
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (date && (/VALUE=DATE(?:;|$)/i.test(params) || !/VALUE=/i.test(params))) {
    return { time: Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3])), allDay: true };
  }
  const time = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!time) return null;
  const [, y, mo, d, h, mi, s] = time;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isFinite(ms) ? { time: ms, allDay: false } : null;
}

export function parseRrule(value: string): RecurrenceRule | null {
  const parts = new Map<string, string>();
  for (const part of value.split(";")) {
    const [key, val] = part.split("=", 2);
    if (key && val !== undefined) parts.set(key.trim().toUpperCase(), val.trim().toUpperCase());
  }
  const freqText = parts.get("FREQ");
  if (!freqText) return null;
  const freq = freqText === "DAILY" || freqText === "WEEKLY" ? freqText : "OTHER";
  const interval = Math.max(1, Math.min(52, Number.parseInt(parts.get("INTERVAL") ?? "1", 10) || 1));
  const byDay = (parts.get("BYDAY") ?? "")
    .split(",")
    .map((day) => WEEKDAYS.indexOf(day.replace(/^[+-]?\d+/, "") as (typeof WEEKDAYS)[number]))
    .filter((day) => day >= 0);
  const untilText = parts.get("UNTIL");
  const until = untilText ? (parseIcsDate(untilText)?.time ?? null) : null;
  // A DATE-valued UNTIL includes that whole day.
  const untilInclusive = until !== null && untilText && /^\d{8}$/.test(untilText) ? until + DAY_MS - 1 : until;
  const countText = parts.get("COUNT");
  const count = countText && /^\d{1,4}$/.test(countText) ? Number(countText) : null;
  const weekStart = WEEKDAYS.indexOf((parts.get("WKST") ?? "MO") as (typeof WEEKDAYS)[number]);
  return { freq, interval, byDay: [...new Set(byDay)], until: untilInclusive, count, weekStart: weekStart >= 0 ? weekStart : 1 };
}

/** Splits `NAME;PARAM=a;PARAM="b:c":value` at the first colon outside quotes. */
function splitProperty(line: string): { name: string; params: string; value: string } | null {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') quoted = !quoted;
    else if (char === ":" && !quoted) {
      const head = line.slice(0, i);
      const semicolon = head.indexOf(";");
      return {
        name: (semicolon < 0 ? head : head.slice(0, semicolon)).toUpperCase(),
        params: semicolon < 0 ? "" : head.slice(semicolon + 1),
        value: line.slice(i + 1),
      };
    }
  }
  return null;
}

/** Parses the VEVENTs of an iCalendar text: unfolding, TEXT unescaping, UTC dates, RRULE, EXDATE, RECURRENCE-ID. */
export function parseIcs(text: unknown): IcsEvent[] {
  if (typeof text !== "string") return [];
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const events: IcsEvent[] = [];
  let current: Map<string, { params: string; value: string }[]> | null = null;
  let nested = 0;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = new Map();
      nested = 0;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("BEGIN:")) {
      nested++; // VALARM and friends: their properties are not the event's
      continue;
    }
    if (line.startsWith("END:")) {
      if (nested > 0) {
        nested--;
        continue;
      }
      if (line === "END:VEVENT") {
        const event = buildEvent(current);
        if (event) events.push(event);
        current = null;
      }
      continue;
    }
    if (nested > 0) continue;
    const property = splitProperty(line);
    if (!property) continue;
    const list = current.get(property.name) ?? [];
    list.push({ params: property.params, value: property.value });
    current.set(property.name, list);
  }
  return events;
}

function buildEvent(props: Map<string, { params: string; value: string }[]>): IcsEvent | null {
  const first = (name: string): { params: string; value: string } | undefined => props.get(name)?.[0];
  const dtstart = first("DTSTART");
  const start = dtstart ? parseIcsDate(dtstart.value.trim(), dtstart.params) : null;
  if (!start) return null;
  const dtend = first("DTEND");
  let end = dtend ? parseIcsDate(dtend.value.trim(), dtend.params)?.time : undefined;
  if (end === undefined) {
    const duration = parseIsoDuration(first("DURATION")?.value.trim());
    end = start.time + (duration !== null ? duration * 1000 : start.allDay ? DAY_MS : 0);
  }
  if (end < start.time) end = start.time;
  const exdates: number[] = [];
  for (const exdate of props.get("EXDATE") ?? []) {
    for (const value of exdate.value.split(",")) {
      const parsed = parseIcsDate(value.trim(), exdate.params);
      if (parsed) exdates.push(parsed.time);
    }
  }
  const recurrence = first("RECURRENCE-ID");
  const rrule = first("RRULE");
  return {
    uid: first("UID")?.value.trim() ?? "",
    summary: unescapeIcsText(first("SUMMARY")?.value ?? ""),
    description: unescapeIcsText(first("DESCRIPTION")?.value ?? ""),
    location: unescapeIcsText(first("LOCATION")?.value ?? ""),
    status: (first("STATUS")?.value ?? "").trim().toUpperCase(),
    start: start.time,
    end,
    allDay: start.allDay,
    rrule: rrule ? parseRrule(rrule.value) : null,
    exdates,
    recurrenceId: recurrence ? (parseIcsDate(recurrence.value.trim(), recurrence.params)?.time ?? null) : null,
    conference: props.has("X-GOOGLE-CONFERENCE") || props.has("CONFERENCE"),
  };
}

/** Occurrence starts of a recurring event, in order, up to `to` (FREQ=DAILY/WEEKLY; other rules yield only the first). */
function recurrenceStarts(event: IcsEvent, to: number, limit: number): number[] {
  const rule = event.rrule!;
  const starts: number[] = [];
  const upper = Math.min(to, rule.until ?? Number.POSITIVE_INFINITY);
  if (rule.freq === "OTHER") return event.start <= upper ? [event.start] : [];
  const startDay = Math.floor(event.start / DAY_MS) * DAY_MS;
  const timeOfDay = event.start - startDay;
  let produced = 0;
  if (rule.freq === "DAILY") {
    for (let day = startDay; produced < limit; day += rule.interval * DAY_MS) {
      const time = day + timeOfDay;
      if (time > upper) break;
      if (rule.byDay.length > 0 && !rule.byDay.includes(new Date(day).getUTCDay())) continue;
      if (rule.count !== null && produced >= rule.count) break;
      starts.push(time);
      produced++;
    }
    return starts;
  }
  // WEEKLY: weeks begin on WKST; every `interval`-th week counting from the start's week.
  const days = rule.byDay.length > 0 ? rule.byDay : [new Date(startDay).getUTCDay()];
  const offsets = days.map((day) => (day - rule.weekStart + 7) % 7).sort((a, b) => a - b);
  const firstWeek = startDay - ((new Date(startDay).getUTCDay() - rule.weekStart + 7) % 7) * DAY_MS;
  for (let week = firstWeek, guard = 0; guard < 10_000; week += rule.interval * WEEK_MS, guard++) {
    if (week + timeOfDay > upper) break;
    for (const offset of offsets) {
      const time = week + offset * DAY_MS + timeOfDay;
      if (time < event.start) continue;
      if (time > upper || (rule.count !== null && produced >= rule.count) || produced >= limit) return starts;
      starts.push(time);
      produced++;
    }
  }
  return starts;
}

/**
 * Occurrences overlapping [from, to], sorted by start. Recurring events are expanded, EXDATEs
 * removed, RECURRENCE-ID overrides replace their instance (a cancelled override removes it), and
 * cancelled events are dropped.
 */
export function expandOccurrences(events: readonly IcsEvent[], from: number, to: number, limitPerEvent = 1000): IcsOccurrence[] {
  const overrides = new Map<string, Map<number, IcsEvent>>();
  for (const event of events) {
    if (event.recurrenceId === null || !event.uid) continue;
    const byTime = overrides.get(event.uid) ?? new Map<number, IcsEvent>();
    byTime.set(event.recurrenceId, event);
    overrides.set(event.uid, byTime);
  }
  const out: IcsOccurrence[] = [];
  const push = (event: IcsEvent, start: number, end: number): void => {
    if (event.status !== "CANCELLED" && end > from && start < to) out.push({ event, start, end });
  };
  for (const event of events) {
    if (event.recurrenceId !== null) {
      // An override is shown on its own; its master skips that instance below.
      push(event, event.start, event.end);
      continue;
    }
    if (!event.rrule) {
      push(event, event.start, event.end);
      continue;
    }
    const duration = event.end - event.start;
    const excluded = new Set(event.exdates);
    const replaced = overrides.get(event.uid);
    for (const start of recurrenceStarts(event, to, limitPerEvent)) {
      if (excluded.has(start) || replaced?.has(start)) continue;
      push(event, start, start + duration);
    }
  }
  return out.sort((a, b) => a.start - b.start || a.event.summary.localeCompare(b.event.summary));
}

/** Throws unless `text` is an iCalendar document (some organisers answer automated clients with a captcha page). */
function requireCalendar(text: string): string {
  if (!/^﻿?\s*BEGIN:VCALENDAR/.test(text)) throw new Error("not a calendar");
  return text;
}

// ---------------------------------------------------------------- schedule mapping

/** The calendar rule an event's title matches, or null (events no rule names, such as internal meetings, never match). */
export function calendarRuleFor(summary: string, rules: readonly WatchCalendarRule[]): WatchCalendarRule | null {
  const title = summary.trim();
  return rules.find((rule) => rule.title.test(title)) ?? null;
}

/**
 * Keeps only the events of a public calendar that a rule names, and only what may be relayed: the title (with the
 * rule's rename applied), times, recurrence and a cleaned summary. LOCATION, conference data and every link are
 * dropped.
 */
export function filterCalendar(events: readonly IcsEvent[], rules: readonly WatchCalendarRule[]): IcsEvent[] {
  const kept: IcsEvent[] = [];
  for (const event of events) {
    const rule = calendarRuleFor(event.summary, rules);
    if (!rule) continue;
    const title = event.summary.trim();
    kept.push({
      ...event,
      summary: rule.rename ? title.replace(rule.rename.pattern, rule.rename.replacement) : title,
      description: cleanFreeText(event.description, SUMMARY_MAX),
      location: "",
      conference: false,
    });
  }
  return kept;
}

/** Kept calendar occurrences → WatchEvent[] (our own location text and link per rule). */
export function calendarToWatchEvents(events: readonly IcsEvent[], from: number, to: number, rules: readonly WatchCalendarRule[]): WatchEvent[] {
  const out: WatchEvent[] = [];
  for (const occurrence of expandOccurrences(events, from, to)) {
    const rule = calendarRuleFor(occurrence.event.summary, rules);
    if (!rule) continue;
    const title = cleanCalendarTitle(occurrence.event.summary);
    out.push({
      id: `${rule.idPrefix}-${compactUtc(occurrence.start, true)}-${shortHash(`${occurrence.event.uid}|${title}`)}`,
      title,
      start: new Date(occurrence.start).toISOString(),
      end: new Date(occurrence.end).toISOString(),
      source: "calendar",
      where: rule.where,
      joinUrl: rule.infoUrl,
      videoId: null,
      summary: cleanFreeText(occurrence.event.description, SUMMARY_MAX),
      location: rule.location,
    });
  }
  return out;
}

export interface Recurrence {
  readonly start: number;
  readonly durationMs: number;
  readonly rrule: RecurrenceRule;
  readonly exdates: readonly number[];
}

/** The rule written in the catalogue. */
export function bakedRecurrence(event: WatchRecurringEvent): Recurrence {
  return { start: Date.parse(event.start), durationMs: event.durationMin * 60_000, rrule: parseRrule(event.rrule)!, exdates: [] };
}

/** The recurrence from an organiser's .ics (its first weekly recurring event), or null. Its LOCATION and description are never used. */
export function recurrenceFromIcs(text: string): Recurrence | null {
  const event = parseIcs(requireCalendar(text)).find((candidate) => candidate.rrule && candidate.recurrenceId === null && candidate.rrule.freq === "WEEKLY");
  if (!event) return null;
  return { start: event.start, durationMs: event.end - event.start, rrule: event.rrule!, exdates: event.exdates };
}

/** A recurring event's occurrences in [from, to] as WatchEvents (always with the catalogue's own text and links). */
export function recurringEvents(event: WatchRecurringEvent, recurrence: Recurrence, from: number, to: number): WatchEvent[] {
  const synthetic: IcsEvent = {
    uid: event.id,
    summary: event.title,
    description: "",
    location: "",
    status: "CONFIRMED",
    start: recurrence.start,
    end: recurrence.start + recurrence.durationMs,
    allDay: false,
    rrule: recurrence.rrule,
    exdates: recurrence.exdates,
    recurrenceId: null,
    conference: false,
  };
  return expandOccurrences([synthetic], from, to).map((occurrence) => ({
    id: `${event.id}-${compactUtc(occurrence.start)}`,
    title: event.title,
    start: new Date(occurrence.start).toISOString(),
    end: new Date(occurrence.end).toISOString(),
    source: "recurring",
    where: event.where,
    joinUrl: event.joinUrl,
    videoId: null,
    summary: event.summary,
    location: event.location,
    ...(event.infoUrl ? { links: [{ kind: "web" as const, url: event.infoUrl }] } : {}),
  }));
}

/** One-off events in [from, to]; an umbrella entry is left out when a calendar already lists its sessions. */
export function curatedEvents(events: readonly CuratedEvent[], from: number, to: number, calendarTitles: readonly string[]): WatchEvent[] {
  return events.filter((event) => {
    const start = Date.parse(event.start);
    const end = Date.parse(event.end);
    if (!(end > from && start < to)) return false;
    return !(event.fallbackForCalendar && calendarTitles.some((title) => event.fallbackForCalendar!.test(title)));
  }).map((event) => ({
    id: event.id,
    title: event.title,
    start: new Date(Date.parse(event.start)).toISOString(),
    end: new Date(Date.parse(event.end)).toISOString(),
    source: "curated",
    where: event.where,
    joinUrl: event.joinUrl,
    videoId: null,
    summary: event.summary,
    location: event.location,
  }));
}

// ---------------------------------------------------------------- curated catalogue

function curatedVideos(collection: WatchCollectionSource): WatchVideo[] {
  return collection.videos.map((video) => ({
    id: video.id,
    title: tidyTitle(video.title),
    channel: collection.channel.title,
    channelId: collection.channel.id,
    publishedAt: video.publishedAt,
    durationSec: video.durationSec,
    views: null,
    status: "replay",
    scheduledStart: null,
    concurrentViewers: null,
    thumb: thumbUrl(video.id),
    url: videoUrl(video.id),
    collection: collection.id,
  }));
}

function collectionSummary(collection: WatchCollectionSource, count = collection.videos.length): WatchCollection {
  return { id: collection.id, title: collection.title, channel: collection.channel.title, count, description: collection.description };
}

/** Which collection a channel upload belongs to (curated membership, else the collection's title filter). */
function collectionOf(collections: readonly WatchCollectionSource[], video: WatchVideo): string | undefined {
  for (const collection of collections) {
    if (collection.videos.some((curated) => curated.id === video.id)) return collection.id;
  }
  return collections.find((collection) => collection.titleFilter && collection.channel.id === video.channelId && collection.titleFilter.test(video.title))?.id;
}

const byNewest = (a: WatchVideo, b: WatchVideo): number => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");

/** Fills duration/date gaps (feeds and playlist items carry none) from the curated entry for the same id. */
function enrichFromCatalogue(collections: readonly WatchCollectionSource[], video: WatchVideo): WatchVideo {
  for (const collection of collections) {
    const curated = collection.videos.find((entry) => entry.id === video.id);
    if (curated) return { ...video, durationSec: video.durationSec ?? curated.durationSec, publishedAt: video.publishedAt ?? curated.publishedAt };
  }
  return video;
}

// ---------------------------------------------------------------- the gateway source

export interface WatchSourceContext {
  /** What may be listed: channels, collections, recurring events, calendars, one-off events and credits. */
  readonly catalog: WatchCatalog;
  /** The gateway's cached + de-duplicated loader (serves the last good value, marked stale, when a refresh fails). */
  readonly cached: <T>(key: string, load: () => Promise<T>, ttl?: number) => Promise<{ value: T; stale: boolean }>;
  /** Size-capped, timed-out upstream GET; errors say only `upstream <status>`. */
  readonly upstreamText: (url: string, accept: string) => Promise<string>;
  readonly now: () => number;
  /** The gateway's default TTL (10 min); ICS uses 6×, past conferences 36×. */
  readonly ttlMs: number;
  /** Server-side only. Never logged, never in a cache key or a response. */
  readonly youtubeApiKey?: string;
}

/** Error text that is safe to log (never a URL — API URLs carry the key). */
function safeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^(upstream \d{3}|upstream response too large|not a calendar|no videos)$/.test(message) ? message : "request failed";
}

export interface WatchSource {
  listing(): Promise<WatchListing>;
  /** null for an id that is not a listed collection. */
  collection(id: string, page: number): Promise<WatchCollectionPage | null>;
}

export function createWatchSource(ctx: WatchSourceContext): WatchSource {
  const { catalog } = ctx;
  const collections = catalog.collections;
  const backoffUntil = new Map<string, number>();
  const key = ctx.youtubeApiKey;
  const icsTtl = ctx.ttlMs * 6;

  /**
   * One upstream source behind the gateway cache, with a failure backoff: after a failure the
   * source is not asked again for `backoffMs` (the last good value, if any, is served stale).
   */
  async function source<T>(cacheKey: string, ttl: number, load: () => Promise<T>, backoffMs = FAILURE_BACKOFF_MS): Promise<{ value: T; stale: boolean } | null> {
    const blocked = ctx.now() < (backoffUntil.get(cacheKey) ?? 0);
    try {
      return await ctx.cached(
        cacheKey,
        blocked
          ? () => Promise.reject(new Error("backoff"))
          : async () => {
              try {
                const value = await load();
                backoffUntil.delete(cacheKey);
                return value;
              } catch (error) {
                backoffUntil.set(cacheKey, ctx.now() + backoffMs);
                throw error;
              }
            },
        ttl,
      );
    } catch (error) {
      if (!blocked) console.warn(`[content] watch source ${cacheKey.slice(0, 60)} unavailable: ${safeReason(error)}`);
      return null;
    }
  }

  const apiUrl = (path: string, query: string): string => `${YOUTUBE_API}/${path}?${query}&key=${encodeURIComponent(key ?? "")}`;
  const apiJson = async (path: string, query: string): Promise<unknown> => JSON.parse(await ctx.upstreamText(apiUrl(path, query), "application/json"));

  /** playlistItems.list → video ids (newest first for uploads playlists). */
  async function playlistIds(playlistId: string, max: number): Promise<string[]> {
    const payload = await apiJson("playlistItems", `part=snippet,contentDetails&maxResults=${max}&playlistId=${encodeURIComponent(playlistId)}`);
    return mapYoutubeVideos(payload).map((video) => video.id);
  }

  /** videos.list for up to 50 ids → full WatchVideos (live status, viewers, duration). */
  async function videoDetails(ids: readonly string[], channelIds: readonly string[]): Promise<WatchVideo[]> {
    if (ids.length === 0) return [];
    const payload = await apiJson("videos", `part=snippet,contentDetails,statistics,liveStreamingDetails&maxResults=50&id=${ids.slice(0, 50).join(",")}`);
    return mapYoutubeVideos(payload, { channelIds });
  }

  const allChannelIds = catalog.channels.map((channel) => channel.id);
  const uploadsPlaylist = (channelId: string): string => `UU${channelId.slice(2)}`;

  /** Latest uploads (+ live/upcoming) across the allowlisted channels. */
  async function channelVideos(): Promise<{ videos: WatchVideo[]; live: boolean; stale: boolean } | null> {
    if (key) {
      const lists = await Promise.all(catalog.channels.map((channel) => source(`watch:yt:uploads:${channel.id}`, ctx.ttlMs, () => playlistIds(uploadsPlaylist(channel.id), 10))));
      const ids = [...new Set(lists.flatMap((list) => list?.value ?? []))];
      if (ids.length > 0) {
        const details = await source(`watch:yt:videos:${[...ids].sort().join(",")}`, LIVE_TTL_MS, () => videoDetails(ids, allChannelIds));
        if (details) return { videos: details.value, live: true, stale: details.stale || lists.some((list) => list?.stale) };
      }
    }
    const feeds = await Promise.all(
      catalog.channels.map((channel) =>
        source(`watch:atom:channel:${channel.id}`, ctx.ttlMs, async () => {
          const videos = mapYoutubeFeed(await ctx.upstreamText(`${YOUTUBE_FEEDS}?channel_id=${channel.id}`, "application/atom+xml, application/xml"), { channelIds: [channel.id] });
          if (videos.length === 0) throw new Error("no videos");
          return videos;
        }),
      ),
    );
    const videos = feeds.flatMap((feed) => feed?.value ?? []);
    return videos.length > 0 ? { videos, live: false, stale: feeds.some((feed) => feed?.stale) } : null;
  }

  async function schedule(now: number): Promise<{ events: WatchEvent[]; stale: boolean }> {
    const from = now - SCHEDULE_PAST_MS;
    const to = now + SCHEDULE_FUTURE_MS;
    const [recurring, calendars] = await Promise.all([
      Promise.all(
        catalog.recurringEvents.map(async (event) => {
          // Opportunistic: an organiser's .ics may answer automated clients with a captcha page, so a failure is
          // remembered for the ICS TTL while the catalogue's own rule stands in.
          const fromIcs = event.icsUrl
            ? await source(
                `watch:ics:${event.id}`,
                icsTtl,
                async () => {
                  const recurrence = recurrenceFromIcs(await ctx.upstreamText(event.icsUrl!, "text/calendar"));
                  if (!recurrence) throw new Error("not a calendar");
                  return recurrence;
                },
                Math.max(FAILURE_BACKOFF_MS, icsTtl),
              )
            : null;
          return { events: recurringEvents(event, fromIcs?.value ?? bakedRecurrence(event), from, to), stale: Boolean(fromIcs?.stale) };
        }),
      ),
      Promise.all(
        catalog.calendars.map(async (calendar) => {
          // Only events a rule names are ever kept (and cached): everything else never leaves the parser.
          const kept = await source(`watch:ics:${calendar.id}`, icsTtl, async () => filterCalendar(parseIcs(requireCalendar(await ctx.upstreamText(calendar.url, "text/calendar"))), calendar.rules));
          return { calendar, events: kept?.value ?? [], stale: Boolean(kept?.stale) };
        }),
      ),
    ]);
    const calendarTitles = calendars.flatMap((calendar) => calendar.events.map((event) => event.summary));
    const events = [
      ...recurring.flatMap((entry) => entry.events),
      ...calendars.flatMap((entry) => calendarToWatchEvents(entry.events, from, to, entry.calendar.rules)),
      ...curatedEvents(catalog.curatedEvents, from, to, calendarTitles),
    ].sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
    return { events: events.slice(0, 200), stale: [...recurring, ...calendars].some((entry) => entry.stale) };
  }

  function curatedLatest(): WatchVideo[] {
    return collections.filter((collection) => collection.active)
      .flatMap((collection) => curatedVideos(collection))
      .sort(byNewest)
      .slice(0, LATEST_MAX);
  }

  async function listing(): Promise<WatchListing> {
    const now = ctx.now();
    const [videos, plan] = await Promise.all([channelVideos(), schedule(now)]);
    const live = (videos?.videos ?? [])
      .filter((video) => video.status !== "replay")
      .sort((a, b) => (a.status === b.status ? (a.scheduledStart ?? "").localeCompare(b.scheduledStart ?? "") : a.status === "live" ? -1 : 1));
    const replays = (videos?.videos ?? []).filter((video) => video.status === "replay").map((video) => enrichFromCatalogue(collections, video));
    const latest = (replays.length > 0 ? replays.sort(byNewest).slice(0, LATEST_MAX) : curatedLatest()).map((video) => {
      const collection = video.collection ?? collectionOf(collections, video);
      return collection ? { ...video, collection } : video;
    });
    const notice = !key
      ? "Live YouTube status needs an API key on the server — showing the schedule and replays."
      : videos?.live
        ? undefined
        : "YouTube can't be reached right now — showing the schedule and saved replays.";
    const result: WatchListing = {
      available: true,
      stale: Boolean(videos?.stale || plan.stale),
      generatedAt: new Date(now).toISOString(),
      live,
      schedule: plan.events,
      latest,
      collections: collections.map((collection) => collectionSummary(collection)),
      sources: catalog.sources.map((source) => ({ label: source.label, text: source.text })),
    };
    if (notice) result.notice = notice;
    return result;
  }

  /** Live entries of one collection (API or Atom), newest first; null when no live source answered. */
  async function collectionLive(collection: WatchCollectionSource): Promise<{ value: WatchVideo[]; stale: boolean } | null> {
    const ttl = collection.active ? ctx.ttlMs : ctx.ttlMs * 36;
    const channelIds = [collection.channel.id];
    const keep = (videos: WatchVideo[]): WatchVideo[] => videos.filter((video) => !collection.titleFilter || collection.titleFilter.test(video.title));
    if (key) {
      const playlistId = collection.playlistId ?? uploadsPlaylist(collection.channel.id);
      const result = await source(`watch:yt:collection:${collection.id}`, ttl, async () => {
        const ids = await playlistIds(playlistId, 50);
        const videos = keep(await videoDetails(ids, channelIds));
        if (videos.length === 0) throw new Error("no videos");
        return videos;
      });
      if (result) return result;
    }
    const feedQuery = collection.playlistId ? `playlist_id=${collection.playlistId}` : `channel_id=${collection.channel.id}`;
    return source(`watch:atom:collection:${collection.id}`, ttl, async () => {
      const videos = keep(mapYoutubeFeed(await ctx.upstreamText(`${YOUTUBE_FEEDS}?${feedQuery}`, "application/atom+xml, application/xml"), { channelIds }));
      if (videos.length === 0) throw new Error("no videos");
      return videos;
    });
  }

  async function collection(id: string, page: number): Promise<WatchCollectionPage | null> {
    const entry = collections.find((candidate) => candidate.id === id);
    if (!entry) return null;
    const live = await collectionLive(entry);
    const merged: WatchVideo[] = [];
    const seen = new Set<string>();
    for (const video of [...(live?.value ?? []).map((video) => enrichFromCatalogue(collections, video)), ...curatedVideos(entry)]) {
      if (seen.has(video.id)) continue;
      seen.add(video.id);
      merged.push({ ...video, collection: entry.id });
    }
    const videos = entry.active ? merged.sort(byNewest) : merged;
    const pages = Math.max(1, Math.ceil(videos.length / WATCH_PAGE_SIZE));
    const current = Math.max(0, Math.min(pages - 1, page));
    return {
      available: true,
      stale: Boolean(live?.stale),
      collection: collectionSummary(entry, videos.length),
      videos: videos.slice(current * WATCH_PAGE_SIZE, (current + 1) * WATCH_PAGE_SIZE),
      page: current,
      pages,
    };
  }

  return { listing, collection };
}

/** The shape served when the listing itself cannot be built (HTTP 200, so boards and panels degrade quietly). */
export function unavailableListing(now: number): WatchListing {
  return { available: false, stale: false, generatedAt: new Date(Number.isFinite(now) ? now : 0).toISOString(), live: [], schedule: [], latest: [], collections: [] };
}

/** `?page=` for collection pages: an integer 0..WATCH_MAX_PAGE (anything else → 0). */
export function watchPageParam(value: string | null): number {
  const page = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(page) ? Math.max(0, Math.min(WATCH_MAX_PAGE, page)) : 0;
}
