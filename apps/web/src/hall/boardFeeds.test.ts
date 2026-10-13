import { test } from "node:test";
import assert from "node:assert/strict";
import type { HallStageState } from "@project/shared";
import type { WatchEvent, WatchListing, WatchVideo } from "../watch/types.ts";
import { formatTime } from "../watch/schedule.ts";
import {
  REACTION_WINDOW_MS,
  ReactionWindow,
  discussionLines,
  isTakeaway,
  liveNowEntries,
  nameColor,
  nextScheduled,
  prepareSecondsLeft,
  reactionTally,
  reactionTallyText,
  speakerCardState,
  stageLiveEntry,
  upNextText,
  type StageView,
} from "./boardFeeds.ts";

// The hall boards' feeds (docs/architecture/WATCH_HALL.md).

const NOW = Date.parse("2026-10-15T15:30:00Z");
const TZ = "UTC";
// Times use the viewer's locale (12 or 24 h), so the expectations are built with the same formatter.
const at = (iso: string): string => formatTime(Date.parse(iso), TZ);
const AT_19 = at("2026-10-15T19:00:00Z");

function stage(overrides: Partial<HallStageState> = {}): HallStageState {
  return { holder: null, status: "idle", since: 0, queue: [], card: null, locked: false, audio: false, ...overrides };
}

function video(id: string, title: string, extra: Partial<WatchVideo> = {}): WatchVideo {
  return {
    id,
    title,
    channel: "Example Foundation",
    channelId: "UC",
    publishedAt: "2026-10-02T10:11:57Z",
    durationSec: 2609,
    views: 193,
    status: "replay",
    scheduledStart: null,
    concurrentViewers: null,
    thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    url: `https://www.youtube.com/watch?v=${id}`,
    ...extra,
  };
}

function event(id: string, title: string, start: string, end: string, extra: Partial<WatchEvent> = {}): WatchEvent {
  return { id, title, start, end, source: "recurring", where: "zoom", joinUrl: "", videoId: null, summary: "", location: "", ...extra };
}

const LISTING: WatchListing = {
  available: true,
  stale: false,
  generatedAt: new Date(NOW).toISOString(),
  live: [video("LIVEvideo01", "Zcash Community Call", { status: "live", concurrentViewers: 1234, durationSec: null })],
  schedule: [
    event("arborist", "Weekly Builders Call", "2026-10-15T15:00:00Z", "2026-10-15T16:30:00Z", { location: "Zoom webinar" }),
    event("early", "Morning sync", "2026-10-15T08:00:00Z", "2026-10-15T09:00:00Z"),
    event("later", "ZecHub Office Hours", "2026-10-15T19:00:00Z", "2026-10-15T20:00:00Z", { where: "youtube" }),
    event("zcon", "Zcon7: Opening", "2026-10-27T14:55:00Z", "2026-10-27T15:55:00Z", { where: "in-person", location: "In person · replays later" }),
  ],
  latest: [video("vidAAAA0001", "Community Update", { durationSec: 5165 }), video("abcdefghijk", "Older replay")],
  collections: [],
};

const thumb = (src: string): string | null => (src.startsWith("https://i.ytimg.com/") ? `/content/media?url=${encodeURIComponent(src)}` : null);

test("reaction tallies sum the batches of the last 60 s and forget older ones", () => {
  const window = new ReactionWindow();
  window.add({ clap: 3, heart: 1 }, 1_000);
  window.add({ clap: 2, zec: 4 }, 20_000);
  window.add({ fire: 0, wow: -2, nope: 5 } as never, 21_000);
  assert.deepEqual(window.totals(30_000), { clap: 5, heart: 1, zec: 4 });
  assert.deepEqual(window.totals(1_000 + REACTION_WINDOW_MS), { clap: 2, zec: 4 }, "the first batch is exactly 60 s old");
  assert.deepEqual(window.totals(20_000 + REACTION_WINDOW_MS + 1), {});
  window.add({ idea: 1.7 }, 100_000);
  assert.deepEqual(window.totals(100_000), { idea: 1 });
  window.clear();
  assert.deepEqual(window.totals(100_000), {});
});

test("the board's reaction tally is the server's per-turn total — 'This session', then 'Last session'; the last minute only before any turn", () => {
  const lastMinute = { clap: 1 };
  const none = reactionTally({ id: 0, active: false }, {}, lastMinute);
  assert.deepEqual(none, { label: "Last minute", counts: { clap: 1 }, session: 0 });
  assert.equal(reactionTallyText(none), "Last minute: 👏 1");

  const live = reactionTally({ id: 4, active: true }, { clap: 12, heart: 5, zec: 2 }, lastMinute);
  assert.deepEqual(live, { label: "This session", counts: { clap: 12, heart: 5, zec: 2 }, session: 4 }, "the window is ignored once a turn exists");
  assert.equal(reactionTallyText(live), "This session: 👏 12 ❤️ 5 Ƶ 2");

  const idle = reactionTally({ id: 4, active: false }, { clap: 12, heart: 5, zec: 2 }, { fire: 9 });
  assert.equal(idle.label, "Last session");
  assert.deepEqual(idle.counts, { clap: 12, heart: 5, zec: 2 }, "idle reactions don't change the last session's totals");

  assert.equal(reactionTallyText(reactionTally({ id: 5, active: true }, {}, lastMinute)), "This session: no reactions yet", "a new turn starts from zero");
});

test("discussion lines: the last five unblocked lines, takeaways flagged, colours stable per player", () => {
  const entries = [
    { playerId: "a", nickname: "Ada", text: "one" },
    { playerId: "b", nickname: "Bob", text: "two" },
    { playerId: "x", nickname: "Blocked", text: "spam" },
    { playerId: "a", nickname: "Ada", text: "💡 shielded by default" },
    { playerId: "b", nickname: "Bob", text: "<img src=x onerror=alert(1)>" },
    { playerId: "a", nickname: "Ada", text: "four" },
    { playerId: "b", nickname: "Bob", text: "  💡 indented takeaway" },
  ];
  const lines = discussionLines(entries, { isBlocked: (id) => id === "x" });
  assert.deepEqual(
    lines.map((line) => line.text),
    ["two", "💡 shielded by default", "<img src=x onerror=alert(1)>", "four", "  💡 indented takeaway"],
  );
  assert.deepEqual(
    lines.map((line) => Boolean(line.takeaway)),
    [false, true, false, false, true],
  );
  assert.equal(lines[1]!.color, nameColor("a"));
  assert.notEqual(nameColor("a"), nameColor("b"));
  assert.match(nameColor("anything"), /^hsl\(\d+, 80%, 74%\)$/);
  assert.equal(discussionLines(entries, { isBlocked: () => false, max: 2 }).length, 2);
  assert.equal(isTakeaway("💡"), true);
  assert.equal(isTakeaway("idea 💡"), false);
});

test("the in-hall stage leads the Live Now board: LIVE with presenter and members, or starting", () => {
  const live: StageView = { member: true, stage: stage({ holder: "p", status: "live", audio: true, card: { title: "Building Together" } }), holderName: "Luna" };
  assert.deepEqual(stageLiveEntry(live, 23), { kind: "stage", title: "Building Together", subtitle: "Luna · in the Watch Hall now", badge: "Live", meta: "👥 23" });
  const silent = stageLiveEntry({ ...live, stage: stage({ holder: "p", status: "live" }) }, 2);
  assert.equal(silent?.title, "Luna on the big screen");
  assert.match(silent?.subtitle ?? "", /no sound/);
  const preparing = stageLiveEntry({ ...live, stage: stage({ holder: "p", status: "preparing" }) }, 2);
  assert.equal(preparing?.badge, "Starting");
  assert.equal(stageLiveEntry({ ...live, member: false }, 2), null, "hall state reaches members only");
  assert.equal(stageLiveEntry({ member: true, stage: stage(), holderName: null }, 2), null);
});

test("Live Now order: stage, YouTube live, today's events (live, then later), latest replays — four rows, proxied thumbnails", () => {
  const stageEntry = stageLiveEntry({ member: true, stage: stage({ holder: "p", status: "live", audio: true }), holderName: "Luna" }, 5);
  const all = liveNowEntries({ stage: stageEntry, listing: LISTING, now: NOW, thumb, timeZone: TZ, max: 10 });
  assert.deepEqual(
    all.map((entry) => [entry.kind, entry.title, entry.badge]),
    [
      ["stage", "Luna on the big screen", "Live"],
      ["live", "Zcash Community Call", "Live"],
      ["live", "Weekly Builders Call", "Live"],
      ["today", "ZecHub Office Hours", `Today ${AT_19}`],
      ["replay", "Community Update", "Replay"],
      ["replay", "Older replay", "Replay"],
    ],
  );
  assert.equal(all[1]!.meta, "👁 1.2K");
  assert.equal(all[1]!.thumbUrl, `/content/media?url=${encodeURIComponent("https://i.ytimg.com/vi/LIVEvideo01/mqdefault.jpg")}`);
  assert.equal(all[2]!.subtitle, `Zoom webinar · until ${at("2026-10-15T16:30:00Z")}`);
  assert.equal(all[3]!.subtitle, "YouTube");
  assert.equal(all[4]!.meta, "1:26:05");
  assert.ok(!all.some((entry) => entry.title === "Morning sync"), "ended today: not on the board");
  assert.equal(liveNowEntries({ stage: stageEntry, listing: LISTING, now: NOW, thumb, timeZone: TZ }).length, 4);

  const refused = liveNowEntries({ stage: null, listing: LISTING, now: NOW, thumb: () => null, timeZone: TZ });
  assert.ok(refused.every((entry) => entry.thumbUrl === undefined), "no thumbnail outside the media proxy");
  assert.deepEqual(liveNowEntries({ stage: null, listing: null, now: NOW, thumb, timeZone: TZ }), []);
});

test("up next: the next event or premiere that has not started", () => {
  assert.deepEqual(nextScheduled(LISTING, NOW, TZ), { title: "ZecHub Office Hours", when: `Today ${AT_19}` });
  assert.equal(upNextText(nextScheduled(LISTING, NOW, TZ)), `ZecHub Office Hours · Today ${AT_19}`);
  const evening = Date.parse("2026-10-15T21:00:00Z");
  assert.equal(nextScheduled(LISTING, evening, TZ)?.title, "Zcon7: Opening");
  assert.equal(nextScheduled(null, NOW, TZ), null);
  assert.equal(upNextText(null), null);
});

test("speaker card strip: presenter and card, a host's up-next card, the locked stage, the next event, the open stage", () => {
  const card = { title: "Building Together", speaker: "Luna & Orion", project: "Zocial World", links: [{ kind: "github" as const, url: "https://github.com/x/y" }] };
  const next = { title: "ZecHub Office Hours", when: "Today 19:00" };
  assert.deepEqual(speakerCardState({ member: true, stage: stage({ holder: "p", status: "live", audio: true, card }), holderName: "Luna" }, next), {
    mode: "live",
    title: "Building Together",
    presenter: "Luna",
    speaker: "Luna & Orion",
    project: "Zocial World",
    links: ["github"],
  });
  const preparing = speakerCardState({ member: true, stage: stage({ holder: "p", status: "preparing" }), holderName: "Luna" }, next);
  assert.equal(preparing.mode, "preparing");
  assert.equal(preparing.title, "Luna is getting ready");
  assert.match(preparing.note ?? "", /start sharing/);
  assert.equal(speakerCardState({ member: true, stage: stage({ holder: "me", status: "live" }), holderName: "You" }, next).title, "You are presenting");
  assert.equal(stageLiveEntry({ member: true, stage: stage({ holder: "me", status: "preparing" }), holderName: "You" }, 1)?.title, "You are getting ready");
  const upNextCard = speakerCardState({ member: true, stage: stage({ card }), holderName: null }, next);
  assert.equal(upNextCard.mode, "next");
  assert.equal(upNextCard.title, "Building Together");
  assert.equal(speakerCardState({ member: true, stage: stage({ locked: true }), holderName: null }, next).title, "The stage is locked");
  assert.deepEqual(speakerCardState({ member: true, stage: stage(), holderName: null }, next), { mode: "next", title: "ZecHub Office Hours", note: "Today 19:00 · see the Watch panel for the schedule" });
  assert.equal(speakerCardState({ member: false, stage: stage({ card }), holderName: null }, null).mode, "idle", "outside the hall nothing about the stage is known");
});

test("the preparing countdown runs from when this client saw the turn start", () => {
  assert.equal(prepareSecondsLeft(1_000, 1_000), 45);
  assert.equal(prepareSecondsLeft(1_000, 1_001), 45);
  assert.equal(prepareSecondsLeft(1_000, 31_000), 15);
  assert.equal(prepareSecondsLeft(1_000, 90_000), 0);
});
