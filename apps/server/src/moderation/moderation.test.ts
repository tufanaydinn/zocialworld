import { test } from "node:test";
import assert from "node:assert/strict";
import { MOD_BAN_FOREVER, MOD_KICK_MS, MOD_LOG_MAX, REPORT_QUEUE_MAX, REPORT_TTL_MS, REPORT_WINDOW_MS } from "@project/shared";
import { describeModeratorKeys, isModeratorKey, moderatorKeyProblem, parseModeratorKeys } from "./moderatorKeys.js";
import { AddressHasher, clientAddress, clientOrigin, isInternalAddress, networkKey, normalizeAddress, parseTrustProxy } from "./clientAddress.js";
import { ConnectionLimits, DEFAULT_MAX_SESSIONS_PER_IP, parseMaxSessionsPerIp } from "./connectionLimits.js";
import { MODERATION_ENTRIES_MAX, Moderation, type ModerationKeys } from "./moderation.js";
import { parseIncomingMessage } from "../protocol.js";

/** ADR-019: the pure parts — key checks, client address, the per-IP cap and the moderation state. */

const KEY_A = "moderator-key-A-7Qp2-not-a-secret-xyz";
const KEY_B = "moderator-key-B-9Zr4-not-a-secret-uvw";
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function clock(start = 1_000_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

// ------------------------------------------------------------------ moderator keys

test("moderator keys: SHA-256 digests only; weak keys (short, few distinct characters, too long) fail closed", () => {
  const keys = parseModeratorKeys(` ${KEY_A} ,short-key,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,${"x1".repeat(70)},${KEY_B},${KEY_A},`);
  assert.equal(keys.digests.length, 2, "two usable keys (the duplicate counts once)");
  assert.ok(keys.digests.every((digest) => digest.length === 32));
  assert.deepEqual([...keys.problems].sort(), ["1 fewer than 10 distinct characters", "1 longer than 128 characters", "1 shorter than 24 characters"].sort());
  assert.equal(isModeratorKey(KEY_A, keys), true);
  assert.equal(isModeratorKey(KEY_B, keys), true);
  assert.equal(isModeratorKey(`${KEY_A} `, keys), false);
  assert.equal(isModeratorKey("short-key", keys), false, "a dropped weak key never works");
  assert.equal(isModeratorKey("", keys), false);
  const description = describeModeratorKeys(keys);
  assert.match(description, /^2 moderator keys/);
  for (const secret of [KEY_A, KEY_B, "short-key"]) assert.equal(description.includes(secret), false, "the startup line never contains a key");
  assert.equal(moderatorKeyProblem(KEY_A), null);
});

test("moderator keys: unset or only weak keys disable moderator sign-in", () => {
  for (const raw of [undefined, "", "  ,  ", "too-short"]) {
    const keys = parseModeratorKeys(raw);
    assert.equal(keys.digests.length, 0);
    assert.equal(isModeratorKey(KEY_A, keys), false);
    assert.match(describeModeratorKeys(keys), /^off/);
  }
});

// ------------------------------------------------------------------ client address

test("client address: X-Forwarded-For counts only from a TRUST_PROXY peer, and only its rightmost entry", () => {
  const trusted = parseTrustProxy("10.0.0.10, ::ffff:10.0.0.5, not-an-ip");
  assert.equal(trusted.invalid, 1);
  assert.deepEqual([...trusted.proxies].sort(), ["10.0.0.10", "10.0.0.5"]);
  // A client that is not the proxy cannot move its address with the header.
  assert.equal(clientAddress("203.0.113.9", "198.51.100.1", trusted.proxies), "203.0.113.9");
  assert.equal(clientAddress("::ffff:203.0.113.9", "198.51.100.1", trusted.proxies), "203.0.113.9");
  // From the proxy: the entry the proxy appended (rightmost), whatever the client prepended.
  assert.equal(clientAddress("10.0.0.10", "1.2.3.4, 198.51.100.7", trusted.proxies), "198.51.100.7");
  assert.equal(clientAddress("::ffff:10.0.0.5", ["1.2.3.4", "198.51.100.8"], trusted.proxies), "198.51.100.8");
  // Missing or malformed header: the peer address.
  assert.equal(clientAddress("10.0.0.10", undefined, trusted.proxies), "10.0.0.10");
  assert.equal(clientAddress("10.0.0.10", "garbage", trusted.proxies), "10.0.0.10");
  // No TRUST_PROXY: never the header.
  assert.equal(clientAddress("10.0.0.10", "198.51.100.7", new Set()), "10.0.0.10");
  // Whether the address came from the proxy's header (the internal-forward warning only looks at those).
  assert.deepEqual(clientOrigin("10.0.0.10", "198.51.100.7", trusted.proxies), { address: "198.51.100.7", forwarded: true });
  assert.deepEqual(clientOrigin("10.0.0.10", "garbage", trusted.proxies), { address: "10.0.0.10", forwarded: false });
  assert.deepEqual(clientOrigin("203.0.113.9", "10.0.0.1", trusted.proxies), { address: "203.0.113.9", forwarded: false });
});

test("internal addresses (a Docker gateway, loopback, ULA …) are told apart from visitors' public ones", () => {
  for (const internal of ["172.16.5.1", "10.1.2.3", "192.168.0.7", "127.0.0.1", "169.254.1.1", "100.64.0.1", "::1", "fd00:ab::1", "fe80::1"]) {
    assert.equal(isInternalAddress(internal), true, internal);
  }
  for (const visitor of ["203.0.113.9", "198.51.100.7", "172.32.0.1", "8.8.8.8", "2001:db8::1", "2a00:1450::1"]) {
    assert.equal(isInternalAddress(visitor), false, visitor);
  }
});

test("client address: IPv6 counts by its /64; the keyed hash is stable per process and differs across processes", () => {
  assert.equal(normalizeAddress("::FFFF:192.0.2.1"), "192.0.2.1");
  assert.equal(normalizeAddress("[2001:DB8::1]"), "2001:db8::1");
  assert.equal(normalizeAddress("fe80::1%eth0"), "fe80::1");
  assert.equal(normalizeAddress("nope"), null);
  assert.equal(networkKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(networkKey("2001:db8:1:2::9"), "2001:db8:1:2::/64");
  assert.equal(networkKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(networkKey("192.0.2.1"), "192.0.2.1");
  const hasher = new AddressHasher();
  assert.equal(hasher.hash("2001:db8:1:2::1"), hasher.hash("2001:db8:1:2:ffff::7"), "one /64 is one network");
  assert.notEqual(hasher.hash("2001:db8:1:2::1"), hasher.hash("2001:db8:1:3::1"));
  assert.equal(hasher.hash("192.0.2.1"), hasher.hash("192.0.2.1"));
  assert.notEqual(hasher.hash("192.0.2.1"), new AddressHasher().hash("192.0.2.1"), "a restart (a new key) cannot be compared");
  assert.equal(hasher.hash("192.0.2.1").includes("192"), false);
});

// ------------------------------------------------------------------ connection limits

test("per-IP cap: at most N concurrent sockets and 10 new connections a minute per network; sweep forgets idle networks", () => {
  const time = clock();
  const limits = new ConnectionLimits({ maxSessions: 4, maxNewPerMinute: 10, now: time.now });
  for (let i = 0; i < 4; i++) assert.equal(limits.admit("net-a"), true);
  assert.equal(limits.admit("net-a"), false, "the 5th concurrent socket is refused");
  assert.equal(limits.admit("net-b"), true, "another network is unaffected");
  limits.release("net-a");
  assert.equal(limits.admit("net-a"), true, "a closed socket frees its place");
  // 6 attempts so far on net-a this minute; 4 more fit (each opened and closed at once).
  for (let i = 0; i < 4; i++) {
    limits.release("net-a");
    assert.equal(limits.admit("net-a"), true);
  }
  limits.release("net-a");
  assert.equal(limits.admit("net-a"), false, "the 11th new connection within a minute is refused (with a free place)");
  time.advance(61_000);
  assert.equal(limits.admit("net-a"), true, "a minute later it works again");
  for (let i = 0; i < 4; i++) limits.release("net-a");
  limits.release("net-b");
  time.advance(61_000);
  limits.sweep();
  assert.equal(limits.size, 0, "nothing is kept for idle networks");
});

test("MAX_SESSIONS_PER_IP: default 4, 0 turns the limits off, junk keeps the default with a warning", () => {
  assert.deepEqual(parseMaxSessionsPerIp(undefined), { value: DEFAULT_MAX_SESSIONS_PER_IP, warning: null });
  assert.deepEqual(parseMaxSessionsPerIp(""), { value: 4, warning: null });
  assert.deepEqual(parseMaxSessionsPerIp("8"), { value: 8, warning: null });
  assert.deepEqual(parseMaxSessionsPerIp("0"), { value: 0, warning: null });
  assert.equal(parseMaxSessionsPerIp("-1").value, 4);
  assert.match(parseMaxSessionsPerIp("four").warning ?? "", /keeping the default/);
});

// ------------------------------------------------------------------ moderation state

const guest: ModerationKeys = { connection: "conn-guest" };
const owner: ModerationKeys = { name: "a".repeat(64), connection: "conn-owner" };

test("kick: 10 minutes on every key the target has", () => {
  const time = clock();
  const moderation = new Moderation({ now: time.now });
  const kick = moderation.ban({ nickname: "Spammer", keys: owner }, "kick", null, "Mod");
  assert.equal(kick.until, time.now() + MOD_KICK_MS);
  assert.deepEqual(moderation.banFor({ name: owner.name! }), { kind: "kick", until: kick.until });
  assert.deepEqual(moderation.banFor({ connection: "conn-owner" }), { kind: "kick", until: kick.until });
  assert.equal(moderation.banFor({ connection: "someone-else" }), null);
  time.advance(MOD_KICK_MS);
  assert.equal(moderation.banFor(owner), null, "it runs out");
});

test("ban: the owned name for the chosen time, the connection hash for at most 24 hours; only ≥ 24 h name bans are stored", () => {
  const time = clock();
  const stored: [string, number | null][] = [];
  const moderation = new Moderation({ now: time.now, persistBan: (keyHash, until) => stored.push([keyHash, until]) });
  // A guest banned for 7 days: the connection key is all it has, capped at 24 h.
  const guestBan = moderation.ban({ nickname: "Guest-1234", keys: guest }, "ban", 7 * DAY, "Mod");
  assert.equal(guestBan.until, time.now() + DAY);
  // An owned name banned for 7 days: the name for 7 days (stored), the connection for 24 h.
  const ownerBan = moderation.ban({ nickname: "Owner", keys: owner }, "ban", 7 * DAY, "Mod");
  assert.equal(ownerBan.until, time.now() + 7 * DAY);
  assert.deepEqual(stored, [[owner.name!, time.now() + 7 * DAY]]);
  // A 1-hour ban on an owned name is memory only.
  moderation.ban({ nickname: "Other", keys: { name: "b".repeat(64), connection: "conn-other" } }, "ban", HOUR, "Mod");
  assert.equal(stored.length, 1);
  time.advance(DAY + 1);
  assert.equal(moderation.banFor(guest), null, "the guest's 24-hour cap ran out");
  assert.equal(moderation.banFor({ connection: "conn-owner" }), null, "the owner's connection key ran out at 24 h");
  assert.ok(moderation.banFor({ name: owner.name! }), "the name is still banned");
  // Until lifted: MOD_BAN_FOREVER, stored.
  const forever = moderation.ban({ nickname: "Forever", keys: { name: "c".repeat(64), connection: "conn-f" } }, "ban", null, "Mod");
  assert.equal(forever.until, MOD_BAN_FOREVER);
  assert.deepEqual(stored.at(-1), ["c".repeat(64), MOD_BAN_FOREVER]);
  // Unban clears the stored ban.
  assert.equal(moderation.unban(forever.id, "Mod"), "Forever");
  assert.deepEqual(stored.at(-1), ["c".repeat(64), null]);
  assert.equal(moderation.unban(forever.id, "Mod"), null, "an unknown entry");
});

test("stored bans load at start-up; an expired one is ignored; sweep clears a stored ban that ran out", () => {
  const time = clock();
  const stored: [string, number | null][] = [];
  const moderation = new Moderation({
    now: time.now,
    persistBan: (keyHash, until) => stored.push([keyHash, until]),
    persisted: [
      { keyHash: owner.name!, nickname: "Owner", until: time.now() + DAY },
      { keyHash: "d".repeat(64), nickname: "Old", until: time.now() - 1 },
    ],
  });
  assert.deepEqual(moderation.banFor({ name: owner.name! }), { kind: "ban", until: time.now() + DAY });
  assert.equal(moderation.banFor({ name: "d".repeat(64) }), null);
  const snapshot = moderation.snapshot();
  assert.deepEqual(snapshot.bans.map((ban) => [ban.nickname, ban.byName, ban.byConnection]), [["Owner", true, false]]);
  time.advance(DAY);
  assert.equal(moderation.sweep(), true);
  assert.deepEqual(stored, [[owner.name!, null]]);
  assert.equal(moderation.snapshot().bans.length, 0);
});

test("mute: on every key, until it runs out or is lifted", () => {
  const time = clock();
  const moderation = new Moderation({ now: time.now });
  const mute = moderation.mute({ nickname: "Loud", keys: owner, playerId: "p1" }, 10 * 60_000, "Mod");
  assert.equal(moderation.muteFor({ name: owner.name! }), mute.until);
  assert.equal(moderation.muteFor({ connection: "conn-owner" }), mute.until);
  assert.equal(moderation.muteFor(guest), null);
  assert.deepEqual(moderation.unmute(mute.id, "Mod"), { nickname: "Loud", playerId: "p1", name: owner.name!, connection: "conn-owner" });
  assert.equal(moderation.muteFor(owner), null);
  moderation.mute({ nickname: "Loud", keys: owner }, 60 * 60_000, "Mod");
  time.advance(60 * 60_000);
  assert.equal(moderation.muteFor(owner), null, "it runs out");
});

test("reports: 3 per reporter per 10 minutes, one per reporter–target pair; 100 kept for 24 h; handled ones leave", () => {
  const time = clock();
  const moderation = new Moderation({ now: time.now });
  const reporter = { nickname: "Ann", keys: { connection: "conn-ann" } };
  const target = (n: number) => ({ nickname: `T${n}`, keys: { connection: `conn-t${n}` }, playerId: `t${n}`, moderator: false });
  const report = (n: number) => moderation.report({ reporter, target: target(n), reason: "spam", note: null, location: "district" });
  assert.equal(report(1).ok, true);
  assert.deepEqual(report(1), { ok: false, status: "rate_limited" }, "the same target twice in 10 minutes");
  assert.equal(report(2).ok, true);
  assert.equal(report(3).ok, true);
  assert.deepEqual(report(4), { ok: false, status: "rate_limited" }, "a 4th report in 10 minutes");
  time.advance(REPORT_WINDOW_MS);
  assert.equal(report(1).ok, true, "a new window");
  // The queue keeps the newest REPORT_QUEUE_MAX (different reporters).
  for (let i = 0; i < REPORT_QUEUE_MAX + 5; i++) {
    moderation.report({ reporter: { nickname: `R${i}`, keys: { connection: `conn-r${i}` } }, target: target(9), reason: "other", note: "x", location: "hall" });
  }
  const snapshot = moderation.snapshot();
  assert.equal(snapshot.reports.length, REPORT_QUEUE_MAX);
  assert.equal(snapshot.reports[0]!.reporter, `R${REPORT_QUEUE_MAX + 4}`, "newest first");
  // Handling one removes it; a dismissal is logged.
  assert.equal(moderation.handleReport(snapshot.reports[0]!.id, "Mod"), true);
  assert.equal(moderation.snapshot().reports.length, REPORT_QUEUE_MAX - 1);
  assert.equal(moderation.snapshot().log[0]!.action, "dismiss_report");
  time.advance(REPORT_TTL_MS);
  moderation.sweep();
  assert.equal(moderation.snapshot().reports.length, 0, "reports go after 24 hours");
  assert.equal(moderation.sizes.rateKeys, 0, "rate-limit times go too");
});

test("a report keeps its target's keys (server side only) so a moderator can still act after the target left", () => {
  const time = clock();
  const moderation = new Moderation({ now: time.now });
  const outcome = moderation.report({
    reporter: { nickname: "Ann", keys: { connection: "conn-ann" } },
    target: { nickname: "Troll", keys: owner, playerId: "p9", moderator: false },
    reason: "harassment",
    note: "said rude things",
    location: "valley",
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(Object.keys(outcome.report).sort(), ["id", "location", "note", "reason", "reporter", "t", "target", "targetId"]);
  assert.equal(moderation.targetLeft("p9"), true);
  assert.deepEqual(moderation.reportTarget(outcome.report.id), { nickname: "Troll", keys: owner, targetId: null, moderator: false, t: time.now() });
  assert.equal(JSON.stringify(moderation.snapshot()).includes(owner.name!), false, "keys never reach moderators");
  assert.equal(JSON.stringify(moderation.snapshot()).includes("conn-owner"), false);
});

test("the moderation log keeps the last 200 actions, newest first, with moderator, action, target and duration", () => {
  const time = clock();
  const moderation = new Moderation({ now: time.now });
  for (let i = 0; i < MOD_LOG_MAX + 10; i++) moderation.mute({ nickname: `P${i}`, keys: { connection: `c${i}` } }, 10 * 60_000, "Mod");
  const log = moderation.snapshot().log;
  assert.equal(log.length, MOD_LOG_MAX);
  assert.deepEqual({ ...log[0]!, id: "x" }, { id: "x", t: time.now(), moderator: "Mod", action: "mute", target: `P${MOD_LOG_MAX + 9}`, durationMs: 10 * 60_000 });
});

// ------------------------------------------------------------------ the wire (server parser)

test("parser: report and mod_action keep exactly the fields their shape allows", () => {
  assert.deepEqual(parseIncomingMessage({ type: "report", targetId: "p1", reason: "spam", note: "hi", extra: 1 }), { type: "report", targetId: "p1", reason: "spam", note: "hi" });
  assert.deepEqual(parseIncomingMessage({ type: "report", targetId: "p1", reason: "scam" }), { type: "report", targetId: "p1", reason: "scam" });
  assert.equal(parseIncomingMessage({ type: "report", targetId: "p1", reason: "rude" }), null, "an unknown reason");
  assert.equal(parseIncomingMessage({ type: "report", targetId: "p1", reason: "spam", note: "x".repeat(561) }), null, "a note far over the limit");
  assert.equal(parseIncomingMessage({ type: "report", reason: "spam" }), null);
  assert.deepEqual(parseIncomingMessage({ type: "mod_action", action: "mute", targetId: "p1", durationMs: 600_000 }), { type: "mod_action", action: "mute", targetId: "p1", durationMs: 600_000 });
  assert.equal(parseIncomingMessage({ type: "mod_action", action: "mute", targetId: "p1", durationMs: 1234 }), null, "a duration that isn't offered");
  assert.equal(parseIncomingMessage({ type: "mod_action", action: "mute", durationMs: 600_000 }), null, "no target");
  assert.deepEqual(parseIncomingMessage({ type: "mod_action", action: "kick", reportId: "r7", durationMs: 5 }), { type: "mod_action", action: "kick", reportId: "r7" });
  assert.deepEqual(parseIncomingMessage({ type: "mod_action", action: "ban", targetId: "p1", durationMs: null }), { type: "mod_action", action: "ban", targetId: "p1", durationMs: null });
  assert.equal(parseIncomingMessage({ type: "mod_action", action: "ban", targetId: "p1" }), null, "a ban needs a duration (null: until lifted)");
  assert.equal(parseIncomingMessage({ type: "mod_action", action: "ban", targetId: "p1", durationMs: 30 * DAY }), null);
  assert.deepEqual(parseIncomingMessage({ type: "mod_action", action: "unban", entryId: "b3", targetId: "p1" }), { type: "mod_action", action: "unban", entryId: "b3" });
  assert.equal(parseIncomingMessage({ type: "mod_action", action: "unmute", entryId: "../etc" }), null);
  assert.deepEqual(parseIncomingMessage({ type: "mod_action", action: "dismiss_report", reportId: "r1" }), { type: "mod_action", action: "dismiss_report", reportId: "r1" });
  assert.equal(parseIncomingMessage({ type: "mod_action", action: "promote", targetId: "p1" }), null);
});

// ------------------------------------------------------------------ session coverage, keys and expiry

test("a mute's connection key covers only keys without an owned name; the name key follows the name", () => {
  const time = clock();
  const moderation = new Moderation({ now: time.now });
  // A guest is muted: another guest on the same network is muted too, an owned-name holder there is not.
  const guestMute = moderation.mute({ nickname: "Troll", keys: { connection: "conn-office" }, playerId: "p1" }, 10 * 60_000, "Mod");
  assert.equal(moderation.muteFor({ connection: "conn-office" }), guestMute.until);
  assert.equal(moderation.muteFor({ name: "e".repeat(64), connection: "conn-office" }), null, "Alice (own owned name) keeps chatting");
  // An owned name is muted: by its name anywhere, and its network only for sessions without an owned name.
  moderation.mute({ nickname: "Owner", keys: owner, playerId: "p2" }, 60 * 60_000, "Mod");
  assert.ok(moderation.muteFor({ name: owner.name!, connection: "conn-elsewhere" }), "the owner, from anywhere");
  assert.ok(moderation.muteFor({ connection: "conn-owner" }), "the owner after forgetting the wallet (no name key)");
  assert.equal(moderation.muteFor({ name: "f".repeat(64), connection: "conn-owner" }), null, "another owned name on the owner's network");
  // Who a lifted mute had covered (they are told it was lifted).
  const lifted = { nickname: "Troll", playerId: "p1", name: null, connection: "conn-office" };
  assert.equal(Moderation.covered(lifted, { connection: "conn-office" }), true);
  assert.equal(Moderation.covered(lifted, { name: "e".repeat(64), connection: "conn-office" }), false);
  assert.equal(Moderation.covered(lifted, { connection: "conn-other" }), false);
});

test("a report counts against every key the reporter has; two guests behind one address are two targets", () => {
  const time = clock();
  const moderation = new Moderation({ now: time.now });
  const target = (n: number, connection = `conn-t${n}`) => ({ nickname: `T${n}`, keys: { connection }, playerId: `t${n}`, moderator: false });
  const holder = { nickname: "Rep", keys: { name: "9".repeat(64), connection: "conn-rep" } as ModerationKeys };
  const sameNetworkGuest = { nickname: "Guest-1234", keys: { connection: "conn-rep" } as ModerationKeys };
  const report = (reporter: { nickname: string; keys: ModerationKeys }, n: number, connection?: string) =>
    moderation.report({ reporter, target: target(n, connection), reason: "spam", note: null, location: "district" });
  assert.equal(report(holder, 1).ok, true);
  // The same person without the name (forgot the wallet, or a guest tab on the same network): the same target again …
  assert.deepEqual(report(sameNetworkGuest, 1), { ok: false, status: "rate_limited" }, "no second report per target");
  assert.equal(report(holder, 2).ok, true);
  assert.equal(report(holder, 3).ok, true);
  // … or a 4th report in the window: the connection key was charged too.
  assert.deepEqual(report(sameNetworkGuest, 4), { ok: false, status: "rate_limited" }, "no second budget");
  // And the other way round: a guest's reports count for an owned name later proved on the same connection.
  time.advance(REPORT_WINDOW_MS);
  for (let n = 5; n < 8; n++) assert.equal(report(sameNetworkGuest, n).ok, true);
  assert.deepEqual(report(holder, 8), { ok: false, status: "rate_limited" });
  // Two different guests behind one address: both can be reported (the pair is keyed by the target's session).
  time.advance(REPORT_WINDOW_MS);
  const ann = { nickname: "Ann", keys: { connection: "conn-ann" } };
  assert.equal(moderation.report({ reporter: ann, target: target(20, "conn-cafe"), reason: "spam", note: null, location: "hall" }).ok, true);
  assert.equal(moderation.report({ reporter: ann, target: target(21, "conn-cafe"), reason: "spam", note: null, location: "hall" }).ok, true);
  // An owned-name target is one target across its sessions.
  const named = (playerId: string) => ({ nickname: "Named", keys: { name: "8".repeat(64), connection: "conn-n" }, playerId, moderator: false });
  const bob = { nickname: "Bob", keys: { connection: "conn-bob" } };
  assert.equal(moderation.report({ reporter: bob, target: named("s1"), reason: "spam", note: null, location: "hall" }).ok, true);
  assert.deepEqual(moderation.report({ reporter: bob, target: named("s2"), reason: "spam", note: null, location: "hall" }), { ok: false, status: "rate_limited" });
});

test("a moderator's state leaves out the reports about them (by session or owned name), and their dismissals", () => {
  const time = clock();
  const moderation = new Moderation({ now: time.now });
  const reporter = (n: number) => ({ nickname: `R${n}`, keys: { connection: `conn-r${n}` } });
  const about = (reporterN: number, target: { nickname: string; keys: ModerationKeys; playerId: string; moderator: boolean }): string => {
    const outcome = moderation.report({ reporter: reporter(reporterN), target, reason: "harassment", note: "abusing mod powers", location: "hall" });
    assert.equal(outcome.ok, true);
    return outcome.ok ? outcome.report.id : "";
  };
  const moddy = { nickname: "Moddy", keys: { name: "7".repeat(64), connection: "conn-mod" }, playerId: "mod-1", moderator: true };
  const bySession = about(1, moddy);
  const other = about(2, { nickname: "Troll", keys: { connection: "conn-troll" }, playerId: "p9", moderator: false });
  assert.equal(moderation.isAbout(bySession, { playerId: "mod-1" }), true);
  assert.equal(moderation.isAbout(other, { playerId: "mod-1", name: "7".repeat(64) }), false);
  const moddyView = { playerId: "mod-1", name: "7".repeat(64) };
  assert.deepEqual(
    moderation.snapshot(moddyView).reports.map((r) => r.id),
    [other],
  );
  assert.deepEqual(
    moderation.snapshot({ playerId: "mod-2" }).reports.map((r) => r.id),
    [other, bySession],
    "another moderator sees both",
  );
  // Moddy reconnected (a new session): the report still names the owned name's key.
  moderation.targetLeft("mod-1");
  assert.deepEqual(
    moderation.snapshot({ playerId: "mod-1b", name: "7".repeat(64) }).reports.map((r) => r.id),
    [other],
  );
  // Another moderator dismisses it: the dismissal (it names Moddy) isn't in Moddy's log either.
  assert.equal(moderation.handleReport(bySession, "Other mod"), true);
  assert.equal(moderation.snapshot(moddyView).log.some((entry) => entry.action === "dismiss_report"), false);
  assert.equal(moderation.snapshot({ playerId: "mod-2" }).log[0]!.action, "dismiss_report");
});

test("a connection hash is dropped once its 24 hours end, even when the name ban runs on", () => {
  const time = clock();
  const moderation = new Moderation({ now: time.now });
  moderation.ban({ nickname: "Week", keys: { name: "1".repeat(64), connection: "CONNHASH-IP-1" } }, "ban", 7 * DAY, "Mod");
  moderation.ban({ nickname: "Forever", keys: { name: "2".repeat(64), connection: "CONNHASH-IP-2" } }, "ban", null, "Mod");
  moderation.mute({ nickname: "Loud", keys: { name: "3".repeat(64), connection: "CONNHASH-IP-3" } }, DAY, "Mod");
  assert.equal(moderation.sizes.connectionKeys, 3);
  time.advance(DAY + 1);
  moderation.sweep();
  assert.equal(moderation.sizes.connectionKeys, 0, "no connection hash is held after 24 hours");
  assert.equal(moderation.sizes.bans, 2, "the name bans run on");
  assert.ok(moderation.banFor({ name: "1".repeat(64) }));
  assert.ok(moderation.banFor({ name: "2".repeat(64) }));
  assert.deepEqual(
    moderation.snapshot().bans.map((ban) => [ban.nickname, ban.byName, ban.byConnection]),
    [
      ["Week", true, false],
      ["Forever", true, false],
    ],
  );
});

test("acting on a report ends its connection key 24 hours after the report, not 24 hours after the action", () => {
  const time = clock();
  const moderation = new Moderation({ now: time.now });
  const reportedAt = time.now();
  time.advance(23 * HOUR);
  const ban = moderation.ban({ nickname: "Guest-1234", keys: { connection: "CONNHASH-OLD" }, capturedAt: reportedAt }, "ban", DAY, "Mod");
  assert.equal(ban.until, reportedAt + DAY, "the guest's only key ends 24 h after the report");
  const mute = moderation.mute({ nickname: "Guest-1234", keys: { connection: "CONNHASH-OLD-2" }, capturedAt: reportedAt }, HOUR, "Mod");
  assert.equal(mute.until, reportedAt + DAY);
  // An owned name keeps its full ban; only the connection key is cut short.
  const named = moderation.ban({ nickname: "Named", keys: { name: "4".repeat(64), connection: "CONNHASH-OLD-3" }, capturedAt: reportedAt }, "ban", DAY, "Mod");
  assert.equal(named.until, time.now() + DAY);
  time.advance(HOUR);
  assert.equal(moderation.banFor({ connection: "CONNHASH-OLD" }), null);
  assert.equal(moderation.muteFor({ connection: "CONNHASH-OLD-2" }), null);
  assert.equal(moderation.banFor({ connection: "CONNHASH-OLD-3" }), null);
  assert.ok(moderation.banFor({ name: "4".repeat(64) }));
  moderation.sweep();
  assert.equal(moderation.sizes.connectionKeys, 0);
});

test("a stored ban dropped to keep the list bounded is cleared from names.json too", () => {
  const time = clock();
  const stored = new Map<string, number | null>();
  const moderation = new Moderation({ now: time.now, persistBan: (keyHash, until) => void stored.set(keyHash, until) });
  // The soonest to end: a stored 24-hour ban …
  moderation.ban({ nickname: "Soon", keys: { name: "5".repeat(64), connection: "c-soon" } }, "ban", DAY, "Mod");
  assert.equal(stored.get("5".repeat(64)), time.now() + DAY);
  // … then the list fills with longer ones; the next one pushes it out.
  for (let i = 0; i < MODERATION_ENTRIES_MAX; i++) moderation.ban({ nickname: `L${i}`, keys: { name: i.toString(16).padStart(64, "a") } }, "ban", 7 * DAY, "Mod");
  assert.equal(moderation.sizes.bans, MODERATION_ENTRIES_MAX);
  assert.equal(moderation.banFor({ name: "5".repeat(64) }), null);
  assert.equal(stored.get("5".repeat(64)), null, "names.json no longer says it is banned");
});

test("the log and the result say how long the target is really kept out", () => {
  const time = clock();
  const moderation = new Moderation({ now: time.now });
  assert.equal(moderation.ban({ nickname: "Guest", keys: guest }, "ban", 7 * DAY, "Mod").until, time.now() + DAY);
  assert.equal(moderation.snapshot().log[0]!.durationMs, DAY, "a guest's 7-day ban is 24 hours");
  moderation.ban({ nickname: "Guest2", keys: { connection: "conn-g2" } }, "ban", null, "Mod");
  assert.equal(moderation.snapshot().log[0]!.durationMs, DAY, "and so is a guest's 'until lifted'");
  moderation.ban({ nickname: "Owner", keys: owner }, "ban", 7 * DAY, "Mod");
  assert.equal(moderation.snapshot().log[0]!.durationMs, 7 * DAY);
  moderation.ban({ nickname: "Owner2", keys: { name: "6".repeat(64), connection: "c6" } }, "ban", null, "Mod");
  assert.equal(moderation.snapshot().log[0]!.durationMs, null);
  moderation.ban({ nickname: "Kicked", keys: guest }, "kick", null, "Mod");
  assert.equal(moderation.snapshot().log[0]!.durationMs, MOD_KICK_MS);
});
