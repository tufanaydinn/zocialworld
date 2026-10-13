import type { WatchEvent, WatchListing, WatchVideo } from "./types.ts";

/**
 * Watch Hall schedule logic (docs/architecture/WATCH_HALL.md): which
 * tab an event or stream belongs to and how times read. The gateway serves UTC; "Today" is the
 * viewer's own local date. Pure — `now` and the time zone are injected, so it is testable and the
 * panel can re-bucket every minute without refetching.
 */

export type ScheduleItem =
  | { readonly kind: "event"; readonly event: WatchEvent; readonly start: number; readonly end: number; readonly live: boolean; readonly ended: boolean }
  | { readonly kind: "video"; readonly video: WatchVideo; readonly start: number | null; readonly live: boolean };

export interface WatchBuckets {
  /** In progress right now: live YouTube streams and calendar events between start and end. */
  readonly live: ScheduleItem[];
  /** The rest of the viewer's local today (later today, or already ended today). */
  readonly today: ScheduleItem[];
  /** After today (local), soonest first. */
  readonly upcoming: ScheduleItem[];
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function parse(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : null;
}

/**
 * Building an Intl.DateTimeFormat is far slower than using one, and the Watch Hall's Live Now board
 * re-buckets the whole schedule every second (a few hundred formatter constructions per run — the hall's largest
 * main-thread hitch). One formatter per kind and time zone, built on first use; the output is unchanged.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(kind: string, locale: string | undefined, options: Intl.DateTimeFormatOptions, timeZone: string | undefined): Intl.DateTimeFormat {
  const key = `${kind}|${timeZone ?? ""}`;
  let cached = formatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    formatters.set(key, cached);
  }
  return cached;
}

/** "YYYY-MM-DD" of `time` in `timeZone` (default: the viewer's). */
export function localDateKey(time: number, timeZone?: string): string {
  const parts = formatter("date-key", "en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }, timeZone).formatToParts(new Date(time));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Days between two local date keys (b − a). */
function dayDifference(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

const itemStart = (item: ScheduleItem): number => item.start ?? Number.POSITIVE_INFINITY;

/** Sorts the listing's events and streams into Live / Today / Upcoming for `now`. Events that ended before today are dropped. */
export function bucketWatch(listing: Pick<WatchListing, "live" | "schedule">, now: number, timeZone?: string): WatchBuckets {
  const today = localDateKey(now, timeZone);
  const buckets: { live: ScheduleItem[]; today: ScheduleItem[]; upcoming: ScheduleItem[] } = { live: [], today: [], upcoming: [] };
  for (const event of listing.schedule) {
    const start = parse(event.start);
    const end = parse(event.end);
    if (start === null || end === null) continue;
    const live = start <= now && now < end;
    const ended = end <= now;
    const item: ScheduleItem = { kind: "event", event, start, end, live, ended };
    if (live) buckets.live.push(item);
    else if (localDateKey(start, timeZone) === today) buckets.today.push(item);
    else if (start > now) buckets.upcoming.push(item);
  }
  for (const video of listing.live) {
    const start = parse(video.scheduledStart);
    if (video.status === "live") {
      buckets.live.push({ kind: "video", video, start, live: true });
      continue;
    }
    if (video.status !== "upcoming") continue;
    const item: ScheduleItem = { kind: "video", video, start, live: false };
    // An overdue premiere is "starting soon" — it belongs to today.
    if (start !== null && (start <= now || localDateKey(start, timeZone) === today)) buckets.today.push(item);
    else buckets.upcoming.push(item);
  }
  // Live streams before live calendar events; then by start.
  buckets.live.sort((a, b) => Number(b.kind === "video") - Number(a.kind === "video") || itemStart(a) - itemStart(b));
  buckets.today.sort((a, b) => itemStart(a) - itemStart(b));
  buckets.upcoming.sort((a, b) => itemStart(a) - itemStart(b));
  return buckets;
}

export interface DayGroup {
  readonly key: string;
  readonly label: string;
  readonly items: ScheduleItem[];
}

/** Groups items by local day (input order kept), labelled "Today", "Tomorrow" or "Thu 15 Oct". */
export function groupByDay(items: readonly ScheduleItem[], now: number, timeZone?: string): DayGroup[] {
  const groups = new Map<string, ScheduleItem[]>();
  for (const item of items) {
    const key = item.start === null ? "later" : localDateKey(item.start, timeZone);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return [...groups].map(([key, list]) => ({ key, label: key === "later" ? "Date to be announced" : formatDayLabel(list[0]!.start!, now, timeZone), items: list }));
}

/** "15:00" in the viewer's locale and zone. */
export function formatTime(time: number, timeZone?: string): string {
  return formatter("time", undefined, { hour: "2-digit", minute: "2-digit" }, timeZone).format(new Date(time));
}

/** "Today", "Tomorrow" or e.g. "Thu, 15 Oct" (locale-dependent order). */
export function formatDayLabel(time: number, now: number, timeZone?: string): string {
  const diff = dayDifference(localDateKey(now, timeZone), localDateKey(time, timeZone));
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return formatter("day-label", undefined, { weekday: "short", day: "numeric", month: "short" }, timeZone).format(new Date(time));
}

/** "in 25 min", "in 3 h", "in 2 days" — or "" once started. */
export function formatCountdown(start: number, now: number): string {
  const ahead = start - now;
  if (ahead <= 0) return "";
  if (ahead < HOUR_MS) return `in ${Math.max(1, Math.round(ahead / MINUTE_MS))} min`;
  if (ahead < DAY_MS) return `in ${Math.round(ahead / HOUR_MS)} h`;
  const days = Math.round(ahead / DAY_MS);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

/** When an event happens, for a card: "Live now · until 16:30", "Today · 15:00–16:30 (in 3 h)", "Ended at 16:30", "Thu, 15 Oct · 15:00–16:30". */
export function formatEventWhen(event: Pick<WatchEvent, "start" | "end">, now: number, timeZone?: string): string {
  const start = parse(event.start);
  const end = parse(event.end);
  if (start === null || end === null) return "";
  if (start <= now && now < end) return `Live now · until ${formatEndLabel(end, now, timeZone)}`;
  if (end <= now) return `Ended at ${formatTime(end, timeZone)}`;
  const day = formatDayLabel(start, now, timeZone);
  const range = `${formatTime(start, timeZone)}–${formatEndLabel(end, start, timeZone)}`;
  const countdown = day === "Today" ? formatCountdown(start, now) : "";
  return `${day} · ${range}${countdown ? ` (${countdown})` : ""}`;
}

/** End time, with its day when it is not on the same local day as `reference`. */
function formatEndLabel(end: number, reference: number, timeZone?: string): string {
  return localDateKey(end, timeZone) === localDateKey(reference, timeZone) ? formatTime(end, timeZone) : `${formatDayLabel(end, reference, timeZone)} ${formatTime(end, timeZone)}`;
}

/** 5165 → "1:26:05", 2609 → "43:29", null → "". */
export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0 || !Number.isFinite(seconds)) return "";
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 42 → "42", 1234 → "1.2K", 3_400_000 → "3.4M". */
export function formatCount(count: number | null | undefined): string {
  if (count === null || count === undefined || !Number.isFinite(count) || count < 0) return "";
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${trim(count / 1000)}K`;
  return `${trim(count / 1_000_000)}M`;
}
function trim(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

/** "2 Oct 2026" (locale-dependent), or "" for a missing date. */
export function formatDate(iso: string | null | undefined, timeZone?: string): string {
  const time = parse(iso);
  return time === null ? "" : formatter("date", undefined, { day: "numeric", month: "short", year: "numeric" }, timeZone).format(new Date(time));
}

/** Case- and accent-insensitive "every word of the query appears" test (the Replays filter). */
export function matchesFilter(text: string, query: string): boolean {
  const fold = (value: string): string => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const haystack = fold(text);
  return fold(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

// ---------------------------------------------------------------- .ics download (made locally — no network)

function icsEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function icsUtc(time: number): string {
  return new Date(time).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Folds a content line at 75 octets (RFC 5545 § 3.1) without splitting a character. */
function fold(line: string): string {
  const encoder = new TextEncoder();
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > (out.length === 0 ? 75 : 74)) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n ");
}

/** A one-event calendar file for "Add to calendar (.ics)" — built in the browser from the listing. */
export function eventToIcs(event: WatchEvent, now: number): string {
  const start = parse(event.start);
  const end = parse(event.end);
  if (start === null || end === null) throw new TypeError("event without valid times");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Zocial World//Watch Hall//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${event.id}@watch-hall.invalid`,
    `DTSTAMP:${icsUtc(now)}`,
    `DTSTART:${icsUtc(start)}`,
    `DTEND:${icsUtc(end)}`,
    `SUMMARY:${icsEscape(event.title)}`,
  ];
  if (event.summary) lines.push(`DESCRIPTION:${icsEscape(event.summary)}`);
  if (event.location) lines.push(`LOCATION:${icsEscape(event.location)}`);
  if (/^https:\/\//.test(event.joinUrl)) lines.push(`URL:${event.joinUrl}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
