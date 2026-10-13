import { test } from "node:test";
import assert from "node:assert/strict";
import { MOD_BAN_FOREVER, MOD_CLOSE_CODES, MOD_NICKNAME_LABEL_MAX, type ModLogMessage, type ModReport } from "@project/shared";
import { BAN_CHOICES, MUTE_CHOICES, actionDoneText, actionErrorText, formatDuration, formatUntil, mutedRepeatText, mutedText, removedText, reportAckText } from "./format.ts";
import { ModerationStore } from "./ModerationStore.ts";
import { parseIncomingMessage } from "../networking/protocol.ts";

/** ADR-019: the client's wording, its moderation state and the wire parser for the new messages. */

const NOW = new Date(2026, 9, 9, 12, 0, 0).getTime();

test("durations and 'until' read the way the dialogs and notices say them", () => {
  assert.deepEqual(MUTE_CHOICES.map((choice) => choice.label), ["10 min", "1 hour", "24 hours"]);
  assert.deepEqual(BAN_CHOICES.map((choice) => choice.label), ["1 hour", "24 hours", "7 days", "Until lifted"]);
  assert.equal(BAN_CHOICES.at(-1)!.ms, null);
  assert.equal(formatDuration(null), "until lifted");
  assert.match(formatUntil(NOW + 30 * 60_000, NOW), /^until \d{1,2}:\d{2}(\s?[AP]M)?$/);
  assert.match(formatUntil(NOW + 3 * 24 * 60 * 60_000, NOW), /^until \S+ \d{1,2}:\d{2}(\s?[AP]M)?$/, "within a week: the weekday");
  assert.equal(formatUntil(MOD_BAN_FOREVER, NOW), "until a moderator lifts it");
});

test("acks, results, refusals and the removed notice say what happened", () => {
  assert.equal(reportAckText("sent", "Bob"), "Thanks — moderators were notified.");
  assert.match(reportAckText("rate_limited", "Bob"), /wait/);
  assert.match(reportAckText("unavailable", "Bob"), /no moderators/);
  assert.equal(actionDoneText("mute", "Bob", 10 * 60_000), "Muted Bob for 10 min.");
  assert.equal(actionDoneText("ban", "Bob", null), "Banned Bob until a moderator lifts it.");
  assert.match(actionDoneText("kick", "Bob"), /10 min/);
  assert.match(actionErrorText("moderator", "Mia"), /Mia is a moderator/);
  assert.match(actionErrorText("not_moderator"), /Only moderators/);
  const kicked = removedText("kicked", NOW + 10 * 60_000, NOW);
  assert.equal(kicked.title, "A moderator removed you from Zocial World");
  assert.match(kicked.detail, /^You can come back at \d{1,2}:\d{2}(\s?[AP]M)?\.$/);
  assert.equal(removedText("banned", MOD_BAN_FOREVER, NOW).detail, "The ban lasts until a moderator lifts it.");
  assert.match(removedText("banned", NOW + 60 * 60_000, NOW).detail, /^The ban lasts until \d{1,2}:\d{2}(\s?[AP]M)?\.$/);
  assert.equal(removedText("too_many_connections", null).title, "Too many connections from your network");
  assert.match(mutedText(NOW + 10 * 60_000, NOW), /^A moderator muted you until \d{1,2}:\d{2}(\s?[AP]M)? — your chat, whispers and hall chat aren't delivered\. Voice still works\.$/);
  assert.match(mutedRepeatText(NOW + 10 * 60_000, NOW), /^Not sent — you're muted until \d{1,2}:\d{2}(\s?[AP]M)?\.$/);
});

const REPORT: ModReport = { id: "r1", t: NOW, reporter: "Ann", target: "Troll", targetId: "p9", reason: "spam", note: "links", location: "hall" };
const STATE: ModLogMessage = { type: "mod_log", reports: [REPORT], log: [], bans: [], mutes: [] };

test("the store: a mod_log makes this session a moderator; live reports count as unseen until the panel opens", () => {
  const store = new ModerationStore(() => NOW);
  const events: string[] = [];
  store.subscribe((event) => events.push(event.type));
  assert.equal(store.isModerator, false);
  store.handle({ type: "mod_report", report: REPORT });
  assert.equal(store.reports.length, 0, "a report means nothing before the moderator state");
  store.handle(STATE);
  assert.equal(store.isModerator, true);
  assert.equal(store.unseenReports, 1);
  store.handle({ type: "mod_report", report: { ...REPORT, id: "r2", target: "Spammer" } });
  assert.deepEqual(store.reports.map((report) => report.id), ["r2", "r1"], "newest first");
  assert.equal(store.unseenReports, 2);
  store.handle({ type: "mod_report", report: { ...REPORT, id: "r2" } });
  assert.equal(store.reports.length, 2, "a repeat is ignored");
  store.markSeen();
  assert.equal(store.unseenReports, 0);
  store.handle({ ...STATE, reports: [{ ...REPORT, id: "r3" }, { ...REPORT, id: "r2" }, REPORT] });
  assert.equal(store.unseenReports, 1, "only reports this client hadn't seen");
  assert.ok(events.includes("report"));
  store.reset();
  assert.equal(store.isModerator, false);
  assert.equal(store.reports.length, 0);
});

test("the store: Moderator tags from presence and updates; this session's mute runs out", () => {
  let now = NOW;
  const store = new ModerationStore(() => now);
  store.setLocalPlayerId("me");
  store.setTagged("p1", true);
  store.handle({ type: "moderator_updated", playerId: "p2", moderator: true });
  assert.equal(store.isTagged("p1"), true);
  assert.equal(store.isTagged("p2"), true);
  store.forget("p1");
  assert.equal(store.isTagged("p1"), false);
  store.handle({ type: "moderation_notice", kind: "muted", until: NOW + 60_000 });
  assert.equal(store.mutedUntil, NOW + 60_000);
  store.handle({ type: "moderation_notice", kind: "unmuted" });
  assert.equal(store.mutedUntil, null);
  store.handle({ type: "moderation_notice", kind: "muted", until: NOW + 60_000 });
  now += 60_000;
  assert.equal(store.mutedUntil, null, "it runs out by itself");
});

test("parser: the moderation messages are rebuilt from known fields; anything malformed is dropped", () => {
  assert.deepEqual(parseIncomingMessage({ type: "report_ack", status: "sent", extra: 1 }), { type: "report_ack", status: "sent" });
  assert.equal(parseIncomingMessage({ type: "report_ack", status: "maybe" }), null);
  assert.deepEqual(parseIncomingMessage({ type: "mod_report", report: { ...REPORT, ip: "1.2.3.4" } }), { type: "mod_report", report: REPORT });
  assert.equal(parseIncomingMessage({ type: "mod_report", report: { ...REPORT, reason: "rude" } }), null);
  assert.deepEqual(parseIncomingMessage({ type: "mod_action_result", action: "ban", ok: false, error: "moderator", target: "Mia" }), { type: "mod_action_result", action: "ban", ok: false, error: "moderator", target: "Mia" });
  assert.equal(parseIncomingMessage({ type: "mod_action_result", action: "promote", ok: true }), null);
  const log = parseIncomingMessage({
    type: "mod_log",
    reports: [REPORT],
    log: [{ id: "l1", t: NOW, moderator: "Mod", action: "ban", target: "Troll", durationMs: null }],
    bans: [{ id: "b1", nickname: "Troll", kind: "ban", until: MOD_BAN_FOREVER, byName: true, byConnection: false }],
    mutes: [{ id: "m1", nickname: "Loud", until: NOW + 1 }],
  });
  assert.equal(log?.type, "mod_log");
  // A malformed entry is skipped, not the whole frame (one bad entry must not cost a moderator the role).
  assert.deepEqual(parseIncomingMessage({ type: "mod_log", reports: [], log: [], bans: [{ id: "b1", nickname: "x", kind: "jail", until: 1, byName: true, byConnection: true }], mutes: [] }), {
    type: "mod_log",
    reports: [],
    log: [],
    bans: [],
    mutes: [],
  });
  assert.equal(parseIncomingMessage({ type: "mod_log", reports: [], log: [], bans: "nope", mutes: [] }), null, "a missing list still drops the frame");
  assert.deepEqual(parseIncomingMessage({ type: "moderation_notice", kind: "banned", until: NOW }), { type: "moderation_notice", kind: "banned", until: NOW });
  assert.deepEqual(parseIncomingMessage({ type: "moderation_notice", kind: "too_many_connections" }), { type: "moderation_notice", kind: "too_many_connections" });
  assert.equal(parseIncomingMessage({ type: "moderation_notice", kind: "jailed" }), null);
  assert.deepEqual(parseIncomingMessage({ type: "moderator_updated", playerId: "p1", moderator: true }), { type: "moderator_updated", playerId: "p1", moderator: true });
  // The tag in presence: only an explicit true.
  const summary = { playerId: "p1", nickname: "Mod", colorSeed: 1, x: 0, y: 0, z: 0, rotationY: 0, animationState: "idle" };
  const joined = parseIncomingMessage({ type: "player_joined", ...summary, moderator: true });
  assert.equal(joined?.type === "player_joined" && joined.moderator, true);
  const plain = parseIncomingMessage({ type: "player_joined", ...summary, moderator: "yes" });
  assert.equal(plain?.type === "player_joined" && "moderator" in plain, false);
  assert.equal(MOD_CLOSE_CODES.banned, 4002);
});

// ------------------------------------------------------------------ edge cases

test("a stored ban's long label (several owned names) is kept; one entry over the limit leaves the rest of the state", () => {
  const label = `${"A".repeat(24)}, ${"B".repeat(24)}, ${"C".repeat(24)} +2 more`;
  assert.ok(label.length <= MOD_NICKNAME_LABEL_MAX);
  const state = parseIncomingMessage({
    type: "mod_log",
    reports: [REPORT],
    log: [{ id: "l1", t: NOW, moderator: "Mod", action: "ban", target: label, durationMs: null }],
    bans: [
      { id: "b1", nickname: label, kind: "ban", until: MOD_BAN_FOREVER, byName: true, byConnection: false },
      { id: "b2", nickname: "x".repeat(MOD_NICKNAME_LABEL_MAX + 6), kind: "ban", until: MOD_BAN_FOREVER, byName: true, byConnection: false },
    ],
    mutes: [],
  });
  assert.equal(state?.type, "mod_log");
  if (state?.type !== "mod_log") return;
  assert.deepEqual(state.bans.map((ban) => ban.id), ["b1"], "the over-long entry alone is dropped");
  assert.equal(state.reports.length, 1);
  // The store still becomes a moderator from it.
  const store = new ModerationStore(() => NOW);
  store.handle(state);
  assert.equal(store.isModerator, true);
});

test("mod_action_result carries when the action really ends, and the confirmation says a guest's cap", () => {
  const DAY = 24 * 60 * 60_000;
  assert.deepEqual(parseIncomingMessage({ type: "mod_action_result", action: "ban", ok: true, target: "Guest-1234", until: NOW + DAY }), {
    type: "mod_action_result",
    action: "ban",
    ok: true,
    target: "Guest-1234",
    until: NOW + DAY,
  });
  assert.deepEqual(parseIncomingMessage({ type: "mod_action_result", action: "ban", ok: true, until: "soon" }), { type: "mod_action_result", action: "ban", ok: true }, "a bad until is dropped");
  // A guest banned for 7 days, or until lifted: the line says until when, and why not 7 days.
  for (const chosen of [7 * DAY, null]) {
    const line = actionDoneText("ban", "Guest-1234", chosen, NOW + DAY, NOW);
    assert.match(line, /^Banned Guest-1234 until \S+ \d{1,2}:\d{2}(\s?[AP]M)? — without an owned name, a player is kept out by their network for at most 24 hours\.$/);
    assert.equal(line.includes("7 days"), false);
    assert.equal(line.includes("lifts it"), false);
  }
  // An owned name banned for 7 days, or until lifted: no cap note.
  assert.doesNotMatch(actionDoneText("ban", "Alice", 7 * DAY, NOW + 7 * DAY, NOW), /24 hours/);
  assert.equal(actionDoneText("ban", "Alice", null, MOD_BAN_FOREVER, NOW), "Banned Alice until a moderator lifts it.");
  // A short ban: plainly until when.
  assert.match(actionDoneText("ban", "Bob", 60 * 60_000, NOW + 60 * 60_000, NOW), /^Banned Bob until \d{1,2}:\d{2}(\s?[AP]M)?\.$/);
  assert.match(actionDoneText("mute", "Bob", 10 * 60_000, NOW + 10 * 60_000, NOW), /^Muted Bob until \d{1,2}:\d{2}(\s?[AP]M)?\.$/);
  // Without `until` (an older server): the chosen length, as before.
  assert.equal(actionDoneText("ban", "Bob", null), "Banned Bob until a moderator lifts it.");
});
