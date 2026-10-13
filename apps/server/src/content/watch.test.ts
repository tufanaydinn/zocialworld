import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommunityContentHandler, type Fetcher } from "./communityContent.js";
import { allowedMediaUrl } from "./sources.js";
import {
  calendarToWatchEvents,
  cleanFreeText,
  expandOccurrences,
  FAILURE_BACKOFF_MS,
  filterCalendar,
  mapYoutubeFeed,
  mapYoutubeVideos,
  parseIcs,
  parseIsoDuration,
  parseRrule,
  redactPersonal,
  tidyTitle,
  type WatchListing,
} from "./watch.js";
import { SAMPLE_WATCH_CATALOG, SAMPLE_WATCH_CATALOG_JSON } from "./watchCatalog.sample.js";
import { loadWatchCatalog } from "./watchCatalogFile.js";
import { parseWatchCatalog, type WatchCatalogJson } from "./watchCatalogTypes.js";

// The Watch Hall listings in the content gateway (docs/architecture/WATCH_HALL.md), on a fixture catalogue.

const ORIGIN = "http://127.0.0.1:5173";
const NOW = Date.parse("2026-10-07T12:00:00Z");
const CHANNEL = `UC${"testchannel".padEnd(22, "0")}`;
const OTHER_CHANNEL = `UC${"otherchannel".padEnd(22, "0")}`;
const API = "https://www.googleapis.com/youtube/v3";
const FEEDS = "https://www.youtube.com/feeds/videos.xml";
const CALENDAR_ICS = "https://calendar.example.com/public.ics";
const SERIES_ICS = "https://example.com/calls.ics";

/** Two collections fed by playlists, one by a title filter; a fortnightly call with its own .ics; a public calendar with a rule; an umbrella event. */
const FIXTURE_JSON: WatchCatalogJson = {
  sources: [
    { label: "Schedules", text: "Example Foundation (calls, public calendar)" },
    { label: "Videos", text: "YouTube — Test Channel" },
  ],
  channels: [{ id: CHANNEL, title: "Test Channel" }],
  collections: [
    {
      id: "calls",
      title: "Community Calls",
      channel: CHANNEL,
      description: "Fortnightly community calls.",
      playlistId: "PLtestcalls0000001",
      active: true,
      videos: [
        { id: "callvideo01", title: "Community Call 10-1-2026", publishedAt: "2026-10-02T10:11:57Z", durationSec: 2609 },
        { id: "callvideo02", title: "Community Call 09-17-2026", publishedAt: "2026-09-18T09:33:21Z", durationSec: 1979 },
      ],
    },
    {
      id: "workshops",
      title: "Workshops",
      channel: CHANNEL,
      description: "Hands-on sessions.",
      titleFilter: { pattern: "workshop", flags: "i" },
      active: true,
      videos: [{ id: "workshop001", title: "Workshop: Oct 1, 2026", publishedAt: "2026-10-02T10:14:23Z", durationSec: 5165 }],
    },
    {
      id: "conf-2025",
      title: "Conference 2025",
      channel: CHANNEL,
      description: "Talks from the 2025 conference.",
      playlistId: "PLtestconference25",
      active: false,
      videos: [
        { id: "conftalk001", title: "Opening Keynote - Conf 2025", publishedAt: "2025-03-05T03:34:15Z", durationSec: 1200 },
        { id: "conftalk002", title: "Closing Panel - Conf 2025", publishedAt: "2025-03-06T03:34:15Z", durationSec: 1500 },
      ],
    },
  ],
  recurringEvents: [
    {
      id: "call",
      title: "Community Call",
      summary: "Fortnightly community call. Recordings appear in Community Calls.",
      start: "2025-03-06T15:00:00Z",
      durationMin: 90,
      rrule: "FREQ=WEEKLY;WKST=SU;UNTIL=20281207T235959Z;INTERVAL=2;BYDAY=TH",
      where: "zoom",
      location: "Zoom webinar",
      joinUrl: "https://example.com/join/call",
      infoUrl: "https://example.com/calls/",
      icsUrl: SERIES_ICS,
    },
  ],
  calendars: [
    {
      id: "public",
      url: CALENDAR_ICS,
      rules: [
        {
          title: { pattern: "^Conf ?9:" },
          idPrefix: "conf9",
          where: "in-person",
          location: "In person · replays later",
          infoUrl: "https://example.com/conf9/",
          rename: { pattern: "^Conf 9:", replacement: "Conf9:" },
        },
      ],
    },
  ],
  curatedEvents: [
    {
      id: "conf9",
      title: "Conf9",
      start: "2026-10-27T14:30:00Z",
      end: "2026-10-29T18:20:00Z",
      where: "in-person",
      joinUrl: "https://example.com/conf9/",
      summary: "The annual conference. In person only; recordings follow.",
      location: "In person · replays later",
      fallbackForCalendar: { pattern: "^Conf9:" },
    },
  ],
};
const FIXTURE = parseWatchCatalog(FIXTURE_JSON);
const RULES = FIXTURE.calendars[0]!.rules;

type Body = unknown | Error | ((url: string) => unknown);

function fakeFetcher(routes: Record<string, Body>, calls: string[] = []): Fetcher {
  return async (url) => {
    calls.push(url);
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!key) return { ok: false, status: 404, text: async () => "" };
    let body = routes[key];
    if (typeof body === "function") body = (body as (url: string) => unknown)(url);
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
}

function gateway(options: Partial<Parameters<typeof createCommunityContentHandler>[0]> & { fetcher: Fetcher }): ReturnType<typeof createCommunityContentHandler> {
  return createCommunityContentHandler({ allowedOrigins: [ORIGIN], watchCatalog: FIXTURE, now: () => NOW, ...options });
}

async function serve(handler: ReturnType<typeof createCommunityContentHandler>): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(418).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** Runs `body` with console.warn captured (the gateway logs upstream failures). */
async function withWarnings<T>(body: (lines: string[]) => Promise<T>): Promise<T> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    return await body(lines);
  } finally {
    console.warn = original;
  }
}

// ---------------------------------------------------------------- fixtures

const VIDEOS_LIST = {
  kind: "youtube#videoListResponse",
  items: [
    {
      kind: "youtube#video",
      id: "LIVEvideo01",
      snippet: { title: "Community Call live #crypto #test", channelId: CHANNEL, channelTitle: "Test Channel", publishedAt: "2026-10-07T11:00:00Z", liveBroadcastContent: "live" },
      contentDetails: { duration: "P0D" },
      statistics: { viewCount: "321" },
      liveStreamingDetails: { actualStartTime: "2026-10-07T11:02:00Z", scheduledStartTime: "2026-10-07T11:00:00Z", concurrentViewers: "42" },
    },
    {
      kind: "youtube#video",
      id: "UPCOMING_01",
      snippet: { title: "Upcoming session", channelId: CHANNEL, channelTitle: "Test Channel", publishedAt: "2026-10-06T09:00:00Z", liveBroadcastContent: "upcoming" },
      contentDetails: { duration: "P0D" },
      liveStreamingDetails: { scheduledStartTime: "2026-10-08T16:00:00Z", concurrentViewers: "9" },
    },
    {
      kind: "youtube#video",
      id: "callvideo01",
      snippet: { title: "Community Call 10-1-2026", channelId: CHANNEL, channelTitle: "Test Channel", publishedAt: "2026-10-02T10:11:57Z", liveBroadcastContent: "none" },
      contentDetails: { duration: "PT43M29S" },
      statistics: { viewCount: "193" },
      liveStreamingDetails: { actualStartTime: "2026-10-01T15:00:00Z", actualEndTime: "2026-10-01T15:43:00Z" },
    },
    { kind: "youtube#video", id: "OTHERchan01", snippet: { title: "Gaming", channelId: OTHER_CHANNEL, channelTitle: "Not this one", liveBroadcastContent: "live" } },
    { kind: "youtube#video", id: "bad id!", snippet: { title: "x", channelId: CHANNEL } },
  ],
};

const PLAYLIST_ITEMS = {
  kind: "youtube#playlistItemListResponse",
  items: [
    {
      kind: "youtube#playlistItem",
      snippet: { title: "Community Call 10-1-2026", resourceId: { kind: "youtube#video", videoId: "callvideo01" }, videoOwnerChannelId: CHANNEL, videoOwnerChannelTitle: "Test Channel", publishedAt: "2026-10-03T00:00:00Z" },
      contentDetails: { videoId: "callvideo01", videoPublishedAt: "2026-10-02T10:11:57Z" },
    },
    { kind: "youtube#playlistItem", snippet: { title: "Private video", resourceId: { kind: "youtube#video", videoId: "PRIVATE0001" } }, contentDetails: { videoId: "PRIVATE0001" } },
    {
      kind: "youtube#playlistItem",
      snippet: { title: "Community Call 09-17-2026", resourceId: { videoId: "callvideo02" }, videoOwnerChannelId: CHANNEL, videoOwnerChannelTitle: "Test Channel" },
      contentDetails: { videoId: "callvideo02", videoPublishedAt: "2026-09-18T09:33:21Z" },
    },
  ],
};

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <yt:channelId>${CHANNEL}</yt:channelId>
 <title>Test Channel</title>
 <entry>
  <id>yt:video:callvideo01</id>
  <yt:videoId>callvideo01</yt:videoId>
  <yt:channelId>${CHANNEL}</yt:channelId>
  <title>Community Call 10-1-2026</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=callvideo01"/>
  <author><name>Test Channel</name><uri>https://www.youtube.com/channel/${CHANNEL}</uri></author>
  <published>2026-10-02T10:11:57+00:00</published>
  <media:group>
   <media:title>Community Call 10-1-2026</media:title>
   <media:thumbnail url="https://i4.ytimg.com/vi/callvideo01/hqdefault.jpg" width="480" height="360"/>
   <media:description>Contact someone@example.org</media:description>
   <media:community><media:statistics views="193"/></media:community>
  </media:group>
 </entry>
 <entry>
  <yt:videoId>conftalk001</yt:videoId>
  <yt:channelId>${CHANNEL}</yt:channelId>
  <title>Opening Keynote with Ada &amp; friends - Conf 2025 #crypto</title>
  <author><name>Test Channel</name></author>
  <published>2025-03-05T03:34:15+00:00</published>
 </entry>
 <entry>
  <yt:videoId>OTHERchan01</yt:videoId>
  <yt:channelId>${OTHER_CHANNEL}</yt:channelId>
  <title>Someone else</title>
  <published>2026-10-01T00:00:00+00:00</published>
 </entry>
</feed>`;

/** A Google-Calendar-shaped export: an internal meeting (with a Meet link, a dial-in and a LOCATION) and three conference sessions. */
const CALENDAR = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "VERSION:2.0",
  "X-WR-CALNAME:Example Foundation",
  "BEGIN:VEVENT",
  "DTSTART:20261005T150000Z",
  "DTEND:20261005T160000Z",
  "RRULE:FREQ=WEEKLY;BYDAY=MO",
  "UID:internal-sync@google.com",
  "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij",
  "DESCRIPTION:Join with Google Meet: https://meet.google.com/abc-defg-hij\\nOr dial: (US) +1 202-555-0100 P",
  " IN: 000000000#",
  "LOCATION:Secret office\\, Room 4",
  "SUMMARY:Engineering Sync/Planning",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART:20261027T145500Z",
  "DTEND:20261027T155500Z",
  "UID:conf9-consensus@google.com",
  "DESCRIPTION:<b>Panel</b> on consensus. Speakers: Ada (ada@example.org). Chat: <a href=\"https://chat.example.net/room\">Chat</a> or ",
  ` https://social.example.net/conf\\, donate t1Rv4${"x".repeat(30)}`,
  "LOCATION:Venue\\, Some City\\, Some Country",
  "SUMMARY:Conf9: The Future of Consensus Panel",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "SUMMARY:Alarm text that is not the event title",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART:20261029T171000Z",
  "DTEND:20261029T172000Z",
  "UID:conf9-closing@google.com",
  "SUMMARY: Conf9: Closing Address",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART:20261027T201000Z",
  "DTEND:20261027T210000Z",
  "UID:conf9-safety@google.com",
  "SUMMARY:Conf 9: Safety\\, Survival\\, and Sovereignty",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

// ---------------------------------------------------------------- pure mapping

test("videos.list maps live (viewers), upcoming (scheduled start) and replays (duration, views); other channels and bad ids are dropped", () => {
  const videos = mapYoutubeVideos(VIDEOS_LIST, { channelIds: [CHANNEL] });
  assert.deepEqual(
    videos.map((video) => [video.id, video.status]),
    [
      ["LIVEvideo01", "live"],
      ["UPCOMING_01", "upcoming"],
      ["callvideo01", "replay"],
    ],
  );
  const [live, upcoming, replay] = videos;
  assert.equal(live!.concurrentViewers, 42);
  assert.equal(live!.title, "Community Call live", "trailing hashtags are trimmed");
  assert.equal(live!.durationSec, null, "a live stream has no duration yet");
  assert.equal(upcoming!.scheduledStart, "2026-10-08T16:00:00.000Z");
  assert.equal(upcoming!.concurrentViewers, null, "viewer counts only for live streams");
  assert.equal(replay!.durationSec, 43 * 60 + 29);
  assert.equal(replay!.views, 193);
  assert.equal(replay!.scheduledStart, null);
  assert.equal(replay!.thumb, "https://i.ytimg.com/vi/callvideo01/mqdefault.jpg");
  assert.equal(replay!.url, "https://www.youtube.com/watch?v=callvideo01");
});

test("playlistItems.list maps to replays, skipping private/deleted entries", () => {
  const videos = mapYoutubeVideos(PLAYLIST_ITEMS, { collection: "calls" });
  assert.deepEqual(
    videos.map((video) => video.id),
    ["callvideo01", "callvideo02"],
  );
  assert.equal(videos[0]!.publishedAt, "2026-10-02T10:11:57.000Z", "the video's own publish time, not when it was added");
  assert.equal(videos[0]!.collection, "calls");
  assert.ok(videos.every((video) => video.status === "replay" && video.durationSec === null));
});

test("Atom feed fixture maps to replays from allowlisted channels, entities decoded", () => {
  const videos = mapYoutubeFeed(ATOM, { channelIds: [CHANNEL] });
  assert.equal(videos.length, 2);
  assert.equal(videos[0]!.id, "callvideo01");
  assert.equal(videos[0]!.views, 193);
  assert.equal(videos[0]!.publishedAt, "2026-10-02T10:11:57.000Z");
  assert.equal(videos[0]!.thumb, "https://i.ytimg.com/vi/callvideo01/mqdefault.jpg", "thumbnails are rebuilt from the id, never taken from the feed");
  assert.equal(videos[1]!.title, "Opening Keynote with Ada & friends - Conf 2025");
  assert.ok(!JSON.stringify(videos).includes("someone@example.org"), "feed descriptions are never relayed");
  assert.deepEqual(mapYoutubeFeed("<html>404</html>"), []);
});

test("small helpers: ISO durations and title tidying", () => {
  assert.equal(parseIsoDuration("PT1H26M5S"), 5165);
  assert.equal(parseIsoDuration("P1DT1S"), 86401);
  assert.equal(parseIsoDuration("P0D"), null);
  assert.equal(parseIsoDuration("1:26:05"), null);
  assert.equal(tidyTitle("Wallet SDKs - Conf 2025 #crypto #test"), "Wallet SDKs - Conf 2025");
  assert.equal(tidyTitle("#crypto"), "#crypto", "a title made only of a hashtag stays");
  assert.equal(tidyTitle("Community Call 10-1-2026"), "Community Call 10-1-2026");
});

// ---------------------------------------------------------------- iCalendar

test("ICS: lines are unfolded, TEXT unescaped, UTC dates parsed and VALARM properties ignored", () => {
  const events = parseIcs(CALENDAR);
  assert.equal(events.length, 4);
  const internal = events[0]!;
  assert.equal(internal.description, "Join with Google Meet: https://meet.google.com/abc-defg-hij\nOr dial: (US) +1 202-555-0100 PIN: 000000000#");
  assert.equal(internal.location, "Secret office, Room 4");
  assert.equal(internal.conference, true);
  const consensus = events[1]!;
  assert.equal(consensus.summary, "Conf9: The Future of Consensus Panel", "the VALARM SUMMARY is not the event's");
  assert.equal(consensus.start, Date.parse("2026-10-27T14:55:00Z"));
  assert.equal(consensus.end, Date.parse("2026-10-27T15:55:00Z"));
  assert.equal(events[3]!.summary, "Conf 9: Safety, Survival, and Sovereignty");
  assert.deepEqual(parseIcs("not a calendar"), []);
});

test("RRULE: a fortnightly Thursday rule gives 2026-10-15 and 2026-10-29 at 15:00 UTC; EXDATE and RECURRENCE-ID are honoured", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "DTSTART:20250306T150000Z",
    "DTEND:20250306T163000Z",
    "RRULE:FREQ=WEEKLY;WKST=SU;UNTIL=20281207T235959Z;INTERVAL=2;BYDAY=TH",
    "EXDATE:20261112T150000Z,20261126T150000Z",
    "UID:call",
    "SUMMARY:Community Call",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART:20261210T170000Z",
    "DTEND:20261210T183000Z",
    "RECURRENCE-ID:20261210T150000Z",
    "UID:call",
    "SUMMARY:Community Call (moved)",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const events = parseIcs(ics);
  const occurrences = expandOccurrences(events, NOW, Date.parse("2026-12-31T00:00:00Z")).map((occurrence) => new Date(occurrence.start).toISOString());
  assert.deepEqual(occurrences, [
    "2026-10-15T15:00:00.000Z",
    "2026-10-29T15:00:00.000Z",
    // 2026-11-12 and 2026-11-26 are EXDATEs
    "2026-12-10T17:00:00.000Z", // the moved instance replaces 15:00
    "2026-12-24T15:00:00.000Z",
  ]);
  const rule = parseRrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=TH;UNTIL=20261020");
  assert.equal(rule?.until, Date.parse("2026-10-20T23:59:59.999Z"), "a DATE UNTIL includes the whole day");
  const counted = parseIcs("BEGIN:VEVENT\nDTSTART:20261001T100000Z\nRRULE:FREQ=WEEKLY;COUNT=2;BYDAY=TH,FR\nUID:c\nSUMMARY:c\nEND:VEVENT");
  assert.equal(expandOccurrences(counted, 0, Date.parse("2027-01-01T00:00:00Z")).length, 2, "COUNT limits the series");
});

test("calendar rules: only matching events are kept, renamed by their rule, with our own location and link", () => {
  const kept = filterCalendar(parseIcs(CALENDAR), RULES);
  assert.deepEqual(
    kept.map((event) => event.summary),
    ["Conf9: The Future of Consensus Panel", "Conf9: Closing Address", "Conf9: Safety, Survival, and Sovereignty"],
  );
  assert.ok(kept.every((event) => event.location === "" && !event.conference));
  const events = calendarToWatchEvents(kept, NOW, Date.parse("2026-11-07T00:00:00Z"), RULES);
  assert.equal(events.length, 3);
  for (const event of events) {
    assert.match(event.id, /^conf9-\d{12}-[0-9a-f]{6}$/);
    assert.equal(event.source, "calendar");
    assert.equal(event.joinUrl, "https://example.com/conf9/");
  }
  assert.deepEqual(filterCalendar(parseIcs(CALENDAR), []), [], "a calendar without rules keeps nothing");
});

// ---------------------------------------------------------------- redaction

test("redaction removes e-mails, phone numbers and Zcash/Bitcoin addresses but keeps dates and ordinary numbers", () => {
  const text = [
    "Mail ada@example.org or ops@example.net.",
    "Call +1 202-555-0100, (555) 123-4567 or PIN 000000000.",
    `t1: t1Rv4${"x".repeat(30)} t3: t3Vz22${"y".repeat(29)}`,
    `zs: zs1${"q".repeat(10)}${"z".repeat(65)}`,
    `u: u1${"x".repeat(100)}`,
    "btc: 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    "Conf9 runs 2026-10-27 to 2026-10-29, 1,000 builders, 90 minutes, room 12.",
  ].join(" ");
  const redacted = redactPersonal(text);
  for (const secret of ["ada@example.org", "ops@example.net", "202-555-0100", "123-4567", "000000000", "t1Rv4", "t3Vz22", "zs1qq", "u1xx", "1A1zP1", "bc1qar0"]) {
    assert.ok(!redacted.includes(secret), `${secret} leaked: ${redacted}`);
  }
  assert.ok(redacted.includes("2026-10-27 to 2026-10-29") && redacted.includes("1,000 builders") && redacted.includes("room 12"), redacted);
  assert.equal(cleanFreeText("<p>Hi <b>there</b></p><br>see https://evil.example/x and www.example.com &amp; more"), "Hi there see and & more");
});

test("calendar text: scheme-less conference links and meeting credentials never survive; titles are redacted too", () => {
  const description = "Passcode: 942817 Join with Google Meet: meet.google.com/abc-defg-hij zoom.us/j/1234567?pwd=SecretXY Meeting ID: 123 456 7890 Agenda follows.";
  const clean = cleanFreeText(description);
  for (const secret of ["942817", "meet.google.com", "abc-defg-hij", "zoom.us", "SecretXY", "1234567", "123 456 7890"]) assert.ok(!clean.includes(secret), `${secret} leaked: ${clean}`);
  assert.ok(clean.includes("Agenda follows."), clean);

  const start = Date.UTC(2026, 9, 27, 15);
  const events = parseIcs(
    ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:x1", "DTSTART:20261027T150000Z", "DTEND:20261027T160000Z", "SUMMARY:Conf9: prep call alice@example.org +1 650 555 1234 meet.google.com/abc-defg-hij", "END:VEVENT", "END:VCALENDAR"].join("\r\n"),
  );
  const [event] = calendarToWatchEvents(events, start - 3_600_000, start + 3_600_000, RULES);
  assert.ok(event, "the event a rule names is kept");
  for (const secret of ["alice@example.org", "650 555 1234", "meet.google.com"]) assert.ok(!event.title.includes(secret), `${secret} leaked: ${event.title}`);
  assert.ok(event.title.startsWith("Conf9: prep call"), event.title);
});

// ---------------------------------------------------------------- media allowlist

test("media allowlist: YouTube thumbnails by exact path only", () => {
  assert.equal(allowedMediaUrl("https://i.ytimg.com/vi/callvideo01/mqdefault.jpg"), "https://i.ytimg.com/vi/callvideo01/mqdefault.jpg");
  assert.equal(allowedMediaUrl("https://i.ytimg.com/vi/callvideo01/hqdefault.jpg"), "https://i.ytimg.com/vi/callvideo01/hqdefault.jpg");
  for (const rejected of [
    "https://i.ytimg.com/vi/callvideo01/maxresdefault.jpg",
    "https://i.ytimg.com/vi/callvideo01/hqdefault_live.jpg",
    "https://i.ytimg.com/vi_webp/callvideo01/hqdefault.webp",
    "https://i.ytimg.com/vi/callvideo0/mqdefault.jpg",
    "https://i.ytimg.com/vi/callvideo01/mqdefault.jpg?x=1",
    "https://i.ytimg.com/vi/../vi/callvideo01/mqdefault.jpg",
    "https://i.ytimg.com/vi/%2E%2E/mqdefault.jpg",
    "https://i.ytimg.com/an_webp/callvideo01/mqdefault.jpg",
    "http://i.ytimg.com/vi/callvideo01/mqdefault.jpg",
    "https://i.ytimg.com:8443/vi/callvideo01/mqdefault.jpg",
    "https://i4.ytimg.com/vi/callvideo01/hqdefault.jpg",
    "https://img.youtube.com/vi/callvideo01/mqdefault.jpg",
    "https://www.youtube.com/vi/callvideo01/mqdefault.jpg",
  ]) {
    assert.equal(allowedMediaUrl(rejected), null, rejected);
  }
});

// ---------------------------------------------------------------- the catalogue

test("catalogue files: the sample parses, and a broken file is refused with every problem named", () => {
  assert.equal(SAMPLE_WATCH_CATALOG.collections.length, 1);
  assert.equal(SAMPLE_WATCH_CATALOG.collections[0]!.videos.length, 2);
  assert.equal(SAMPLE_WATCH_CATALOG.recurringEvents.length, 1);
  assert.equal(SAMPLE_WATCH_CATALOG.curatedEvents.length, 0);
  const broken = {
    ...FIXTURE_JSON,
    channels: [{ id: "not-a-channel", title: "" }],
    collections: [{ ...FIXTURE_JSON.collections[0]!, id: "Bad Id", channel: OTHER_CHANNEL, titleFilter: { pattern: "(", flags: "g" }, videos: [{ id: "short", title: "x", publishedAt: "yesterday", durationSec: 0 }] }],
    recurringEvents: [{ ...FIXTURE_JSON.recurringEvents![0]!, rrule: "INTERVAL=2", joinUrl: "http://example.com", where: "moon" }],
    calendars: [{ ...FIXTURE_JSON.calendars![0]!, id: "call" }],
  };
  assert.throws(
    () => parseWatchCatalog(broken),
    (error: Error) => {
      for (const expected of [
        "channels[0].id",
        "channels[0].title",
        "collections[0].id",
        `collections[0].channel: ${OTHER_CHANNEL} is not in channels`,
        "collections[0].titleFilter.flags",
        "collections[0].videos[0].id",
        "collections[0].videos[0].publishedAt",
        "collections[0].videos[0].durationSec",
        "recurringEvents[0].rrule",
        "recurringEvents[0].joinUrl",
        "recurringEvents[0].where",
        "duplicate recurring event or calendar id call",
      ]) {
        assert.ok(error.message.includes(expected), `missing "${expected}" in:\n${error.message}`);
      }
      return true;
    },
  );
});

test("catalogue files: WATCH_CATALOG_FILE wins, then the deployment's default file, then the sample; a bad file stops the start", () => {
  const dir = mkdtempSync(join(tmpdir(), "watch-catalog-"));
  try {
    const configured = join(dir, "configured.json");
    const fallback = join(dir, "default.json");
    writeFileSync(configured, JSON.stringify(FIXTURE_JSON));
    writeFileSync(fallback, JSON.stringify(SAMPLE_WATCH_CATALOG_JSON));
    assert.equal(loadWatchCatalog(configured, fallback).catalog.collections.length, 3);
    assert.equal(loadWatchCatalog(undefined, fallback).origin, fallback);
    const sample = loadWatchCatalog("", join(dir, "missing.json"));
    assert.equal(sample.origin, "sample catalogue");
    assert.equal(sample.catalog, SAMPLE_WATCH_CATALOG);
    writeFileSync(configured, "{ not json");
    assert.throws(() => loadWatchCatalog(configured, fallback), /watch catalogue .*configured\.json/);
    assert.throws(() => loadWatchCatalog(join(dir, "nowhere.json"), fallback), /watch catalogue .*nowhere\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the gateway

test("everything offline: the listing degrades to the catalogue's replays and the rule in the catalogue (HTTP 200, max-age=30)", async () => {
  const calls: string[] = [];
  const { server, base } = await serve(gateway({ fetcher: fakeFetcher({ "https://": new Error("offline") }, calls) }));
  try {
    const response = await withWarnings(() => fetch(`${base}/content/watch`, { headers: { Origin: ORIGIN } }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=30");
    const listing = (await response.json()) as WatchListing;
    assert.equal(listing.available, true);
    assert.deepEqual(listing.live, []);
    assert.match(listing.notice ?? "", /API key/);
    assert.equal(listing.generatedAt, new Date(NOW).toISOString());
    assert.deepEqual(
      listing.collections.map((collection) => [collection.id, collection.count]),
      [
        ["calls", 2],
        ["workshops", 1],
        ["conf-2025", 2],
      ],
    );
    assert.deepEqual(listing.sources, FIXTURE_JSON.sources, "the panel credits come from the catalogue");
    assert.deepEqual(
      listing.latest.map((video) => [video.id, video.collection]),
      [
        ["workshop001", "workshops"],
        ["callvideo01", "calls"],
        ["callvideo02", "calls"],
      ],
      "latest falls back to the active collections' replays, newest first",
    );
    const series = listing.schedule.filter((event) => event.source === "recurring").map((event) => [event.id, event.start, event.end]);
    assert.deepEqual(series.slice(0, 2), [
      ["call-20261015", "2026-10-15T15:00:00.000Z", "2026-10-15T16:30:00.000Z"],
      ["call-20261029", "2026-10-29T15:00:00.000Z", "2026-10-29T16:30:00.000Z"],
    ]);
    const first = listing.schedule.find((event) => event.id === "call-20261015")!;
    assert.equal(first.joinUrl, "https://example.com/join/call");
    assert.equal(first.where, "zoom");
    assert.equal(first.location, "Zoom webinar");
    assert.deepEqual(first.links, [{ kind: "web", url: "https://example.com/calls/" }]);
    const umbrella = listing.schedule.find((event) => event.id === "conf9");
    assert.equal(umbrella?.location, "In person · replays later", "the umbrella entry stands in while the calendar is down");
  } finally {
    server.close();
  }
});

test("the sample catalogue serves its weekly meetup in the hall and its two replays", async () => {
  const { server, base } = await serve(createCommunityContentHandler({ allowedOrigins: [ORIGIN], fetcher: fakeFetcher({ "https://": new Error("offline") }), now: () => NOW }));
  try {
    const listing = (await withWarnings(async () => (await fetch(`${base}/content/watch`)).json())) as WatchListing;
    assert.deepEqual(
      listing.latest.map((video) => video.collection),
      ["zechub-updates", "zechub-updates"],
    );
    const meetups = listing.schedule.filter((event) => event.where === "hall");
    assert.equal(meetups[0]?.id, "hall-meetup-20261010");
    assert.equal(meetups[0]?.joinUrl, "");
    assert.equal(meetups[0]?.links, undefined, "no info link in the catalogue, none in the listing");
    assert.ok(listing.sources?.length);
  } finally {
    server.close();
  }
});

test("if the listing cannot be built at all, the route still answers 200 with available:false and empty lists", async () => {
  let explode = true;
  const handler = gateway({
    fetcher: fakeFetcher({ "https://": new Error("offline") }),
    // The first clock read is the listing's own; failing it makes the whole build throw.
    now: () => {
      if (explode) {
        explode = false;
        throw new Error("clock failure");
      }
      return NOW;
    },
  });
  const { server, base } = await serve(handler);
  try {
    const response = await withWarnings(() => fetch(`${base}/content/watch`));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { available: false, stale: false, generatedAt: new Date(NOW).toISOString(), live: [], schedule: [], latest: [], collections: [] });
  } finally {
    server.close();
  }
});

test("public calendar: only sessions a rule names are relayed, never LOCATION, conference data or links; a captcha page instead of the series .ics falls back to the catalogue's rule", async () => {
  const handler = gateway({
    fetcher: fakeFetcher({
      [CALENDAR_ICS]: CALENDAR,
      // What some organisers answer automated clients with: a captcha page with status 2xx.
      [SERIES_ICS]: '<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/"></head></html>',
      "https://": new Error("offline"),
    }),
  });
  const { server, base } = await serve(handler);
  try {
    const listing = (await withWarnings(async () => (await fetch(`${base}/content/watch`)).json())) as WatchListing;
    const fromCalendar = listing.schedule.filter((event) => event.source === "calendar");
    assert.deepEqual(
      fromCalendar.map((event) => event.title),
      ["Conf9: The Future of Consensus Panel", "Conf9: Safety, Survival, and Sovereignty", "Conf9: Closing Address"],
    );
    for (const event of fromCalendar) {
      assert.match(event.id, /^conf9-\d{12}-[0-9a-f]{6}$/);
      assert.equal(event.where, "in-person");
      assert.equal(event.location, "In person · replays later");
      assert.equal(event.joinUrl, "https://example.com/conf9/");
    }
    assert.equal(fromCalendar[0]!.summary, "Panel on consensus. Speakers: Ada ([email]). Chat: Chat or donate [address]");
    const json = JSON.stringify(listing);
    for (const leaked of ["Engineering Sync", "meet.google.com", "202-555-0100", "Secret office", "Venue", "Some City", "chat.example.net", "social.example.net", "ada@example.org", "t1Rv4"]) {
      assert.ok(!json.includes(leaked), `${leaked} leaked`);
    }
    assert.ok(!listing.schedule.some((event) => event.id === "conf9"), "the umbrella entry is dropped while the calendar lists sessions");
    assert.ok(listing.schedule.some((event) => event.id === "call-20261015"), "a captcha page is not a calendar: the catalogue's rule");
  } finally {
    server.close();
  }
});

test("a real series .ics wins over the catalogue's rule (its EXDATEs apply), but never its LOCATION", async () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "DTSTART:20250306T150000Z",
    "DTEND:20250306T163000Z",
    "RRULE:FREQ=WEEKLY;WKST=SU;UNTIL=20281207T235959Z;INTERVAL=2;BYDAY=TH",
    "EXDATE:20261015T150000Z",
    "LOCATION:https://example.zoom.us/j/1",
    "UID:call",
    "SUMMARY:Community Call",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const { server, base } = await serve(gateway({ fetcher: fakeFetcher({ [SERIES_ICS]: ics, "https://": new Error("offline") }) }));
  try {
    const listing = (await withWarnings(async () => (await fetch(`${base}/content/watch`)).json())) as WatchListing;
    const series = listing.schedule.filter((event) => event.source === "recurring");
    assert.equal(series[0]!.id, "call-20261029");
    assert.ok(!JSON.stringify(listing).includes("example.zoom.us"));
    assert.equal(series[0]!.joinUrl, "https://example.com/join/call");
  } finally {
    server.close();
  }
});

test("with an API key: live and upcoming streams with viewer counts; the key never appears in responses or logs", async () => {
  const KEY = "TESTKEY-secret-key-value-123";
  const calls: string[] = [];
  const handler = gateway({
    youtubeApiKey: KEY,
    fetcher: fakeFetcher(
      {
        [`${API}/playlistItems`]: PLAYLIST_ITEMS,
        [`${API}/videos`]: VIDEOS_LIST,
        // A transport error whose message carries the URL (and so the key) must not be logged verbatim.
        "https://": (url: string) => new Error(`connect ECONNREFUSED ${url}`),
      },
      calls,
    ),
  });
  const { server, base } = await serve(handler);
  try {
    await withWarnings(async (warnings) => {
      const response = await fetch(`${base}/content/watch`);
      const text = await response.text();
      const listing = JSON.parse(text) as WatchListing;
      assert.deepEqual(
        listing.live.map((video) => [video.id, video.status, video.concurrentViewers]),
        [
          ["LIVEvideo01", "live", 42],
          ["UPCOMING_01", "upcoming", null],
        ],
      );
      assert.equal(listing.notice, undefined);
      assert.equal(listing.latest[0]!.id, "callvideo01");
      assert.equal(listing.latest[0]!.collection, "calls");
      assert.ok(calls.some((url) => url.includes(`key=${KEY}`)), "the key is used upstream");
      assert.ok(!calls.some((url) => url.includes("/search")), "search.list is never called");
      const collection = await (await fetch(`${base}/content/watch/collection/conf-2025`)).text();
      for (const body of [text, collection]) assert.ok(!body.includes(KEY), "key leaked into a response");
      assert.ok(warnings.length > 0, "the failing sources were reported");
      assert.ok(!warnings.some((line) => line.includes(KEY) || line.includes("googleapis")), `key or upstream URL logged: ${warnings.join(" | ")}`);
    });
  } finally {
    server.close();
  }
});

test("a failing Atom feed is not asked again for 5 minutes (negative cache), then retried", async () => {
  let clock = NOW;
  const calls: string[] = [];
  const { server, base } = await serve(gateway({ fetcher: fakeFetcher({}, calls), now: () => clock, ttlMs: 1000 }));
  try {
    await withWarnings(async () => {
      const feedCalls = (): number => calls.filter((url) => url.startsWith(`${FEEDS}?channel_id=`)).length;
      await fetch(`${base}/content/watch`);
      const first = feedCalls();
      assert.equal(first, FIXTURE.channels.length, "one request per allowlisted channel");
      clock += 60_000;
      await fetch(`${base}/content/watch`);
      assert.equal(feedCalls(), first, "within the backoff nothing is fetched");
      clock += FAILURE_BACKOFF_MS;
      await fetch(`${base}/content/watch`);
      assert.equal(feedCalls(), first * 2, "after the backoff the feeds are tried again");
    });
  } finally {
    server.close();
  }
});

test("Atom feeds feed the latest replays when there is no API key", async () => {
  const { server, base } = await serve(gateway({ fetcher: fakeFetcher({ [`${FEEDS}?channel_id=${CHANNEL}`]: ATOM, "https://": new Error("offline") }) }));
  try {
    const listing = (await withWarnings(async () => (await fetch(`${base}/content/watch`)).json())) as WatchListing;
    assert.deepEqual(
      listing.latest.map((video) => video.id),
      ["callvideo01", "conftalk001"],
    );
    assert.equal(listing.latest[0]!.durationSec, 2609, "durations are filled in from the catalogue");
    assert.equal(listing.latest[1]!.collection, "conf-2025");
  } finally {
    server.close();
  }
});

test("collections: only listed ids (404 otherwise, nothing fetched), paged, from the catalogue when offline", async () => {
  const calls: string[] = [];
  const { server, base } = await serve(gateway({ fetcher: fakeFetcher({ "https://": new Error("offline") }, calls) }));
  try {
    await withWarnings(async () => {
      for (const path of ["/content/watch/collection/not-a-collection", "/content/watch/collection/PLtestcalls0000001", "/content/watch/collection/../wiki"]) {
        assert.equal((await fetch(`${base}${path}`)).status, 404, path);
      }
      assert.equal(calls.length, 0, "unlisted ids never reach an upstream");
      const response = await fetch(`${base}/content/watch/collection/calls?page=7`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "public, max-age=120");
      const page = (await response.json()) as { available: boolean; collection: { id: string; count: number }; videos: { id: string; collection: string }[]; page: number; pages: number };
      assert.equal(page.available, true);
      assert.equal(page.collection.id, "calls");
      assert.equal(page.page, 0, "out-of-range pages clamp to the last page");
      assert.equal(page.pages, 1);
      assert.equal(page.videos[0]!.id, "callvideo01");
      assert.ok(page.videos.every((video) => video.collection === "calls"));
    });
  } finally {
    server.close();
  }
});
