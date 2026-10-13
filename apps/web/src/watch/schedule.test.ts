import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketWatch, eventToIcs, formatCount, formatCountdown, formatDuration, formatEventWhen, formatTime, groupByDay, localDateKey, matchesFilter } from "./schedule.ts";
import type { WatchEvent, WatchVideo } from "./types.ts";

const NOW = Date.parse("2026-10-15T15:30:00Z"); // a fortnightly call is on air (15:00–16:30 UTC)

function event(id: string, start: string, end: string, extra: Partial<WatchEvent> = {}): WatchEvent {
  return { id, title: id, start, end, source: "recurring", where: "zoom", joinUrl: "https://example.com/join/call", videoId: null, summary: "", location: "Zoom webinar", ...extra };
}

function stream(id: string, status: WatchVideo["status"], scheduledStart: string | null): WatchVideo {
  return {
    id,
    title: id,
    channel: "Test Channel",
    channelId: `UC${"testchannel".padEnd(22, "0")}`,
    publishedAt: null,
    durationSec: null,
    views: null,
    status,
    scheduledStart,
    concurrentViewers: status === "live" ? 12 : null,
    thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

const SCHEDULE: WatchEvent[] = [
  event("yesterday", "2026-10-14T15:00:00Z", "2026-10-14T16:30:00Z"),
  event("earlier-today", "2026-10-15T08:00:00Z", "2026-10-15T09:00:00Z"),
  event("call-20261015", "2026-10-15T15:00:00Z", "2026-10-15T16:30:00Z"),
  event("late-utc", "2026-10-15T23:30:00Z", "2026-10-16T00:30:00Z"),
  event("next-utc-day", "2026-10-16T02:00:00Z", "2026-10-16T03:00:00Z"),
  event("call-20261029", "2026-10-29T15:00:00Z", "2026-10-29T16:30:00Z"),
];
const LIVE: WatchVideo[] = [stream("LIVEvideo01", "live", "2026-10-15T15:00:00Z"), stream("UPCOMING_01", "upcoming", "2026-10-15T18:00:00Z"), stream("UPCOMING_02", "upcoming", "2026-10-20T18:00:00Z")];

const ids = (items: ReturnType<typeof bucketWatch>["live"]): string[] => items.map((item) => (item.kind === "event" ? item.event.id : item.video.id));

test("Live / Today / Upcoming in UTC: live streams first, today's ended events kept, past days dropped", () => {
  const buckets = bucketWatch({ live: LIVE, schedule: SCHEDULE }, NOW, "UTC");
  assert.deepEqual(ids(buckets.live), ["LIVEvideo01", "call-20261015"]);
  assert.deepEqual(ids(buckets.today), ["earlier-today", "UPCOMING_01", "late-utc"]);
  assert.deepEqual(ids(buckets.upcoming), ["next-utc-day", "UPCOMING_02", "call-20261029"]);
  const ended = buckets.today[0]!;
  assert.ok(ended.kind === "event" && ended.ended);
});

test("Today follows the viewer's local date, not UTC", () => {
  // Tokyo (UTC+9): it is already 00:30 on the 16th. This morning's 08:00Z event was "yesterday" there;
  // 23:30Z and 02:00Z (the 16th, 08:30 and 11:00 local) are both today.
  const tokyo = bucketWatch({ live: [], schedule: SCHEDULE }, NOW, "Asia/Tokyo");
  assert.deepEqual(ids(tokyo.today), ["late-utc", "next-utc-day"]);
  assert.deepEqual(ids(tokyo.upcoming), ["call-20261029"]);
  // Los Angeles (UTC−7): 08:30 on the 15th. 08:00Z was 01:00 today; 02:00Z on the 16th is 19:00 today.
  const la = bucketWatch({ live: [], schedule: SCHEDULE }, NOW, "America/Los_Angeles");
  assert.deepEqual(ids(la.today), ["earlier-today", "late-utc", "next-utc-day"]);
  assert.equal(localDateKey(NOW, "Asia/Tokyo"), "2026-10-16");
  assert.equal(localDateKey(NOW, "America/Los_Angeles"), "2026-10-15");
  assert.equal(localDateKey(NOW, "UTC"), "2026-10-15");
});

test("groupByDay labels Today / Tomorrow / dates", () => {
  const buckets = bucketWatch({ live: [], schedule: SCHEDULE }, NOW, "UTC");
  const groups = groupByDay(buckets.upcoming, NOW, "UTC");
  assert.deepEqual(
    groups.map((group) => [group.key, group.items.length]),
    [
      ["2026-10-16", 1],
      ["2026-10-29", 1],
    ],
  );
  assert.equal(groups[0]!.label, "Tomorrow");
  assert.match(groups[1]!.label, /29/);
  assert.equal(groupByDay(buckets.today, NOW, "UTC")[0]!.label, "Today");
});

test("formatting: durations, counts, countdowns and event times", () => {
  assert.equal(formatDuration(5165), "1:26:05");
  assert.equal(formatDuration(2609), "43:29");
  assert.equal(formatDuration(59), "0:59");
  assert.equal(formatDuration(null), "");
  assert.equal(formatCount(42), "42");
  assert.equal(formatCount(1234), "1.2K");
  assert.equal(formatCount(15_000), "15K");
  assert.equal(formatCount(3_400_000), "3.4M");
  assert.equal(formatCount(null), "");
  assert.equal(formatCountdown(NOW + 25 * 60_000, NOW), "in 25 min");
  assert.equal(formatCountdown(NOW + 3 * 3600_000, NOW), "in 3 h");
  assert.equal(formatCountdown(NOW + 2 * 86400_000, NOW), "in 2 days");
  assert.equal(formatCountdown(NOW - 1, NOW), "");
  // Times use the viewer's locale (12 or 24 h), so the expectations are built with the same formatter.
  const at = (iso: string): string => formatTime(Date.parse(iso), "UTC");
  assert.equal(formatEventWhen(SCHEDULE[2]!, NOW, "UTC"), `Live now · until ${at("2026-10-15T16:30:00Z")}`);
  assert.equal(formatEventWhen(SCHEDULE[1]!, NOW, "UTC"), `Ended at ${at("2026-10-15T09:00:00Z")}`);
  assert.equal(formatEventWhen(SCHEDULE[3]!, NOW, "UTC"), `Today · ${at("2026-10-15T23:30:00Z")}–Tomorrow ${at("2026-10-16T00:30:00Z")} (in 8 h)`);
  assert.match(formatEventWhen(SCHEDULE[5]!, NOW, "UTC"), /29/);
});

test("the Replays filter matches every word, ignoring case and accents", () => {
  assert.ok(matchesFilter("Threshold Signing Updates - Café Session", "cafe threshold"));
  assert.ok(matchesFilter("Community Call 08-06-2026", "  community  "));
  assert.ok(!matchesFilter("Community Call 08-06-2026", "community conference"));
  assert.ok(matchesFilter("anything", ""));
});

test("eventToIcs builds an escaped, folded single-event calendar", () => {
  const ics = eventToIcs(
    event("conf9-202610271455-44a0e5", "2026-10-27T14:55:00Z", "2026-10-27T15:55:00Z", {
      title: "Conf9: Vision, Narrative; and Value",
      summary: `${"A long summary ".repeat(10)}with a line\nbreak`,
      where: "in-person",
      location: "In person · replays later",
      joinUrl: "https://example.com/conf9/",
    }),
    NOW,
  );
  const lines = ics.split("\r\n");
  assert.equal(lines[0], "BEGIN:VCALENDAR");
  assert.ok(lines.includes("DTSTART:20261027T145500Z"));
  assert.ok(lines.includes("DTEND:20261027T155500Z"));
  assert.ok(lines.includes("DTSTAMP:20261015T153000Z"));
  assert.ok(lines.includes("SUMMARY:Conf9: Vision\\, Narrative\\; and Value"));
  assert.ok(lines.includes("URL:https://example.com/conf9/"));
  assert.ok(lines.every((line) => new TextEncoder().encode(line).length <= 75), "folded at 75 octets");
  assert.ok(ics.replace(/\r\n /g, "").includes("with a line\\nbreak"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
});
