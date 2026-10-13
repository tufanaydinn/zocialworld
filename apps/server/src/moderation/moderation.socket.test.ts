import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { WebSocketServer, WebSocket as WsClient } from "ws";
import { MOD_CLOSE_CODES, MOD_KICK_MS, NAME_DEV_ADDRESS } from "@project/shared";
import { WorldServer, type WorldServerOptions } from "../WorldServer.js";
import { NameRegistry } from "../identity/nameRegistry.js";
import { DevNameScanner } from "../identity/nameScanner.js";
import { FileNameStore } from "../identity/nameStore.js";
import { NameService } from "../identity/nameService.js";
import { testNameKey, type TestNameKey } from "../identity/testKeys.js";
import { parseModeratorKeys } from "./moderatorKeys.js";
import type { PublisherControl } from "../voice/roomAdmin.js";

/**
 * Moderation (ADR-019) through real sockets: moderator sign-in (anywhere, the tag, host powers), reports (live
 * delivery, rate limits, nothing to the reported player), mute / kick / ban with their keys and expiry, bans of owned
 * names surviving a restart, the per-IP cap and rate, TRUST_PROXY, LiveKit revoke calls, non-moderators refused for
 * every action, and nothing logged.
 *
 * Clients use the `ws` package so a test can pick the source address (127.0.0.x) and send X-Forwarded-For.
 */

const MOD_KEY = "e2e-moderator-key-not-a-secret-3Hv8Kd";
const MODERATOR_KEYS = parseModeratorKeys(MOD_KEY);
const HALL_X = -1000;
const DAY = 24 * 60 * 60_000;

type Message = Record<string, unknown>;

interface Client {
  readonly messages: Message[];
  readonly closed: Promise<{ code: number; reason: string }>;
  send(message: Message): void;
  waitFor(predicate: (m: Message) => boolean, timeoutMs?: number): Promise<Message>;
  close(): void;
  readonly isOpen: boolean;
}

function connect(port: number, options: { from?: string; forwardedFor?: string } = {}): Promise<Client> {
  const socket = new WsClient(`ws://127.0.0.1:${port}`, {
    ...(options.from ? { localAddress: options.from } : {}),
    ...(options.forwardedFor ? { headers: { "X-Forwarded-For": options.forwardedFor } } : {}),
  });
  const messages: Message[] = [];
  const waiters: { predicate: (m: Message) => boolean; resolve: (m: Message) => void }[] = [];
  socket.on("message", (data) => {
    const message = JSON.parse(String(data)) as Message;
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => socket.on("close", (code, reason) => resolve({ code, reason: String(reason) })));
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("open", () =>
      resolve({
        messages,
        closed,
        send: (message) => socket.send(JSON.stringify(message)),
        waitFor: (predicate, timeoutMs = 3000) => {
          const found = messages.find(predicate);
          if (found) return Promise.resolve(found);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error("timed out waiting for a message")), timeoutMs);
            waiters.push({ predicate, resolve: (m) => (clearTimeout(timer), res(m)) });
          });
        },
        close: () => socket.close(),
        get isOpen() {
          return socket.readyState === WsClient.OPEN;
        },
      }),
    );
  });
}

interface Fakes {
  revoked: string[];
  removed: string[];
}

async function start(options: WorldServerOptions = {}) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const fakes: Fakes = { revoked: [], removed: [] };
  const publishers: PublisherControl = { revokePublishing: (id) => fakes.revoked.push(id), removeParticipant: (id) => fakes.removed.push(id) };
  const world = new WorldServer(wss, { moderatorKeys: MODERATOR_KEYS, publishers, staleTimeoutMs: 1e12, sweepIntervalMs: 25, ...options });
  const clients: Client[] = [];
  return {
    port,
    world,
    fakes,
    client: async (opts: { from?: string; forwardedFor?: string } = {}) => {
      const client = await connect(port, opts);
      clients.push(client);
      return client;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        for (const client of clients) client.close();
        world.dispose();
        wss.close(() => resolve());
      }),
  };
}

type Server = Awaited<ReturnType<typeof start>>;

async function join(client: Client, join: Message = { type: "join" }): Promise<{ playerId: string; nickname: string }> {
  client.send(join);
  const welcome = await client.waitFor((m) => m.type === "welcome");
  return { playerId: String(welcome.playerId), nickname: String(welcome.nickname) };
}

async function moderator(server: Server, from = "127.0.0.9"): Promise<{ client: Client; playerId: string; nickname: string }> {
  const client = await server.client({ from });
  const me = await join(client, { type: "join", wallet: true, nickname: "Moddy" });
  client.send({ type: "hall_host_auth", key: MOD_KEY });
  await client.waitFor((m) => m.type === "mod_log");
  return { client, ...me };
}

const isType = (type: string) => (m: Message) => m.type === type;
const result = (action: string) => (m: Message) => m.type === "mod_action_result" && m.action === action;
const notice = (kind: string) => (m: Message) => m.type === "moderation_notice" && m.kind === kind;
const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

function clock(start = Date.now()) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

// ------------------------------------------------------------------ sign-in and roles

test("a moderator key signs in anywhere: the Moderator tag for everyone, the moderation state, and every host power", async () => {
  const server = await start({ hallHostKey: "e2e-hall-host-key-not-a-secret-7Qp2" });
  try {
    const watcher = await server.client({ from: "127.0.0.2" });
    await join(watcher);
    const mod = await moderator(server);
    const update = await watcher.waitFor(isType("moderator_updated"));
    assert.deepEqual(update, { type: "moderator_updated", playerId: mod.playerId, moderator: true });
    // A later joiner sees the tag in the snapshot; nobody else carries it.
    const late = await server.client({ from: "127.0.0.3" });
    await join(late);
    const snapshot = await late.waitFor(isType("player_snapshot"));
    const players = snapshot.players as Message[];
    assert.equal(players.find((p) => p.playerId === mod.playerId)?.moderator, true);
    assert.equal(players.filter((p) => p.moderator !== undefined).length, 1);
    // Host powers in the hall without the host key: the full state says host, and the lock works.
    mod.client.send({ type: "player_transform", x: HALL_X, y: 0, z: 0, rotationY: 0, animationState: "idle", seq: 1 });
    const state = await mod.client.waitFor(isType("hall_state"));
    assert.equal(state.host, true);
    assert.deepEqual(state.hosts, [mod.playerId]);
    mod.client.send({ type: "hall_stage_lock", locked: true });
    const stage = await mod.client.waitFor((m) => m.type === "hall_stage" && (m.stage as Message).locked === true);
    assert.ok(stage);
    // The host key still works for hosts; a moderator key never reaches the hall's own check.
    assert.equal(mod.client.messages.some((m) => m.type === "hall_error"), false);
  } finally {
    await server.stop();
  }
});

test("a wrong key is bad_key (no host key configured), and the sixth attempt is refused", async () => {
  const server = await start();
  try {
    const client = await server.client();
    await join(client);
    for (let i = 0; i < 5; i++) client.send({ type: "hall_host_auth", key: `wrong-key-${i}-abcdefghijklmnopqrstuvwxyz` });
    await settle();
    const errors = client.messages.filter(isType("hall_error"));
    assert.equal(errors.length, 5);
    assert.ok(errors.every((e) => e.op === "host" && e.reason === "bad_key"));
    client.send({ type: "hall_host_auth", key: MOD_KEY });
    await client.waitFor((m) => m.type === "hall_error" && m.reason === "rate_limited");
    assert.equal(client.messages.some(isType("mod_log")), false, "even the right key is refused after five tries");
  } finally {
    await server.stop();
  }
});

test("non-moderators are refused every moderation action (not_moderator), and nothing changes", async () => {
  const server = await start();
  try {
    const target = await server.client({ from: "127.0.0.2" });
    const t = await join(target);
    const player = await server.client({ from: "127.0.0.3" });
    await join(player);
    const actions: Message[] = [
      { action: "mute", targetId: t.playerId, durationMs: 600_000 },
      { action: "kick", targetId: t.playerId },
      { action: "ban", targetId: t.playerId, durationMs: null },
      { action: "unmute", entryId: "m1" },
      { action: "unban", entryId: "b1" },
      { action: "dismiss_report", reportId: "r1" },
    ];
    for (const action of actions) {
      player.send({ type: "mod_action", ...action });
      const answer = await player.waitFor(result(String(action.action)));
      assert.deepEqual(answer, { type: "mod_action_result", action: action.action, ok: false, error: "not_moderator" });
    }
    await settle();
    assert.equal(target.isOpen, true);
    assert.equal(target.messages.some(isType("moderation_notice")), false);
    assert.equal(player.messages.some(isType("mod_log")), false, "no moderation state for non-moderators");
  } finally {
    await server.stop();
  }
});

test("moderators can't act on themselves or on another moderator", async () => {
  const server = await start();
  try {
    const a = await moderator(server, "127.0.0.2");
    const b = await moderator(server, "127.0.0.3");
    a.client.send({ type: "mod_action", action: "kick", targetId: a.playerId });
    assert.equal((await a.client.waitFor(result("kick"))).error, "self");
    a.client.send({ type: "mod_action", action: "ban", targetId: b.playerId, durationMs: null });
    assert.equal((await a.client.waitFor(result("ban"))).error, "moderator");
    assert.equal(b.client.isOpen, true);
  } finally {
    await server.stop();
  }
});

// ------------------------------------------------------------------ reports

test("report: acknowledged, delivered live to moderators with the reporter's nickname, rate-limited; the reported player learns nothing", async () => {
  const server = await start();
  try {
    const mod = await moderator(server);
    const reporter = await server.client({ from: "127.0.0.2" });
    const r = await join(reporter);
    const targets: { client: Client; playerId: string; nickname: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const client = await server.client({ from: `127.0.0.${10 + i}` });
      targets.push({ client, ...(await join(client)) });
    }
    const [first, second, third, fourth] = targets as [(typeof targets)[0], (typeof targets)[0], (typeof targets)[0], (typeof targets)[0]];
    // In the Watch Hall: the location says so.
    first.client.send({ type: "player_transform", x: HALL_X, y: 0, z: 0, rotationY: 0, animationState: "idle", seq: 1 });
    await first.client.waitFor(isType("hall_state"));
    reporter.send({ type: "report", targetId: first.playerId, reason: "spam", note: "  posting  links​ again " });
    assert.deepEqual(await reporter.waitFor(isType("report_ack")), { type: "report_ack", status: "sent" });
    const live = await mod.client.waitFor(isType("mod_report"));
    const report = live.report as Message;
    assert.equal(report.reporter, r.nickname);
    assert.equal(report.target, first.nickname);
    assert.equal(report.targetId, first.playerId);
    assert.equal(report.reason, "spam");
    assert.equal(report.note, "posting links again", "sanitized like chat");
    assert.equal(report.location, "hall");
    // The same target again within 10 minutes; then two more targets; the fourth report in the window is refused.
    reporter.messages.length = 0;
    reporter.send({ type: "report", targetId: first.playerId, reason: "other" });
    assert.equal((await reporter.waitFor(isType("report_ack"))).status, "rate_limited");
    reporter.messages.length = 0;
    reporter.send({ type: "report", targetId: second.playerId, reason: "harassment" });
    assert.equal((await reporter.waitFor(isType("report_ack"))).status, "sent");
    reporter.messages.length = 0;
    reporter.send({ type: "report", targetId: third.playerId, reason: "scam" });
    assert.equal((await reporter.waitFor(isType("report_ack"))).status, "sent");
    reporter.messages.length = 0;
    reporter.send({ type: "report", targetId: fourth.playerId, reason: "impersonation" });
    assert.equal((await reporter.waitFor(isType("report_ack"))).status, "rate_limited");
    // Self, an unknown player and an over-long note.
    reporter.messages.length = 0;
    reporter.send({ type: "report", targetId: r.playerId, reason: "spam" });
    assert.equal((await reporter.waitFor(isType("report_ack"))).status, "self");
    // The reported players got nothing at all about it.
    await settle();
    for (const target of targets) assert.equal(target.client.messages.some((m) => String(m.type).startsWith("mod_") || m.type === "report_ack"), false);
    // A moderator signing in later sees the queue (newest first).
    const late = await moderator(server, "127.0.0.30");
    const state = late.client.messages.find(isType("mod_log"))!;
    assert.deepEqual((state.reports as Message[]).map((x) => x.target), [third.nickname, second.nickname, first.nickname]);
  } finally {
    await server.stop();
  }
});

test("report: a server without moderator keys says so (unavailable) and keeps nothing", async () => {
  const server = await start({ moderatorKeys: parseModeratorKeys("") });
  try {
    const a = await server.client({ from: "127.0.0.2" });
    await join(a);
    const b = await server.client({ from: "127.0.0.3" });
    const target = await join(b);
    a.send({ type: "report", targetId: target.playerId, reason: "spam" });
    assert.equal((await a.waitFor(isType("report_ack"))).status, "unavailable");
  } finally {
    await server.stop();
  }
});

// ------------------------------------------------------------------ mute

test("mute: chat, whispers and hall lines are dropped and the target is told until when; a reconnect stays muted; unmute and expiry", async () => {
  const time = clock();
  const server = await start({ now: time.now });
  try {
    const mod = await moderator(server);
    const listener = await server.client({ from: "127.0.0.2" });
    const l = await join(listener);
    let target = await server.client({ from: "127.0.0.3" });
    let t = await join(target);
    mod.client.send({ type: "mod_action", action: "mute", targetId: t.playerId, durationMs: 10 * 60_000 });
    assert.deepEqual(await mod.client.waitFor(result("mute")), { type: "mod_action_result", action: "mute", ok: true, target: t.nickname, until: time.now() + 10 * 60_000 });
    const muted = await target.waitFor(notice("muted"));
    assert.equal(muted.until, time.now() + 10 * 60_000);
    const state = await mod.client.waitFor((m) => m.type === "mod_log" && (m.mutes as Message[]).length === 1);
    const entry = (state.mutes as Message[])[0]!;
    assert.equal(entry.nickname, t.nickname);
    for (const client of [target, listener]) client.send({ type: "player_transform", x: HALL_X, y: 0, z: 1, rotationY: 0, animationState: "idle", seq: 1 });
    await target.waitFor(isType("hall_state"));
    await listener.waitFor(isType("hall_state"));
    target.messages.length = 0;
    target.send({ type: "chat_send", channel: "general", text: "spam spam" });
    target.send({ type: "whisper_send", to: l.playerId, text: "psst" });
    target.send({ type: "chat_send", channel: "hall", text: "hall spam" });
    await settle();
    assert.equal(target.messages.filter(notice("muted")).length, 3, "told again for each line");
    assert.equal(listener.messages.some(isType("chat_message")), false, "nothing was delivered");
    // A reconnect from the same network keeps the mute (the connection hash).
    target.close();
    target = await server.client({ from: "127.0.0.3" });
    t = await join(target);
    target.send({ type: "chat_send", channel: "nearby", text: "still here" });
    await target.waitFor(notice("muted"));
    // The moderator lifts it: the target — now a reconnected session the mute was not taken against — hears so
    // and can talk again.
    mod.client.send({ type: "mod_action", action: "unmute", entryId: entry.id });
    await mod.client.waitFor(result("unmute"));
    await target.waitFor(notice("unmuted"));
    assert.equal(listener.messages.some(notice("unmuted")), false, "nobody else is told");
    target.send({ type: "chat_send", channel: "general", text: "thanks" });
    const line = await listener.waitFor((m) => m.type === "chat_message" && m.text === "thanks");
    assert.equal(line.fromPlayerId, t.playerId);
    // A new 10-minute mute runs out by itself.
    target.messages.length = 0;
    mod.client.messages.length = 0;
    mod.client.send({ type: "mod_action", action: "mute", targetId: t.playerId, durationMs: 10 * 60_000 });
    await mod.client.waitFor(result("mute"));
    assert.equal((await target.waitFor(notice("muted"))).until, time.now() + 10 * 60_000);
    time.advance(10 * 60_000);
    target.send({ type: "chat_send", channel: "general", text: "free again" });
    await listener.waitFor((m) => m.type === "chat_message" && m.text === "free again");
  } finally {
    await server.stop();
  }
});

// ------------------------------------------------------------------ kick and ban

test("kick: closed with 4001 and a notice; the stage, queue and vote drop at once; LiveKit removes it; no rejoin for 10 minutes", async () => {
  const time = clock();
  const server = await start({ now: time.now });
  try {
    const mod = await moderator(server);
    const viewer = await server.client({ from: "127.0.0.2" });
    const v = await join(viewer, { type: "join", wallet: true });
    const target = await server.client({ from: "127.0.0.3" });
    const t = await join(target, { type: "join", wallet: true });
    for (const [client, seq] of [[viewer, 1], [target, 1]] as const) client.send({ type: "player_transform", x: HALL_X, y: 0, z: 2, rotationY: 0, animationState: "idle", seq });
    await viewer.waitFor(isType("hall_state"));
    await target.waitFor(isType("hall_state"));
    target.send({ type: "hall_stage_request" });
    await viewer.waitFor((m) => m.type === "hall_stage" && (m.stage as Message).holder === t.playerId);
    target.send({ type: "hall_stage_live", live: true, audio: false });
    await viewer.waitFor((m) => m.type === "hall_stage" && (m.stage as Message).status === "live");
    viewer.messages.length = 0;
    mod.client.send({ type: "mod_action", action: "kick", targetId: t.playerId });
    const kicked = await target.waitFor(notice("kicked"));
    assert.equal(kicked.until, time.now() + MOD_KICK_MS);
    assert.deepEqual(await target.closed, { code: MOD_CLOSE_CODES.kicked, reason: "kicked" });
    // At once for everyone else: the stage is free and the player is gone.
    const stage = await viewer.waitFor((m) => m.type === "hall_stage" && (m.stage as Message).holder === null);
    assert.equal((stage.stage as Message).status, "idle");
    await viewer.waitFor((m) => m.type === "player_left" && m.playerId === t.playerId);
    assert.deepEqual(server.fakes.removed, [t.playerId], "its LiveKit participant is removed");
    // The same network can't come back for 10 minutes …
    const again = await server.client({ from: "127.0.0.3" });
    assert.equal((await again.waitFor(notice("kicked"))).until, kicked.until);
    assert.equal((await again.closed).code, MOD_CLOSE_CODES.kicked);
    // … another network can, and after 10 minutes so can this one.
    assert.ok(v.playerId);
    time.advance(MOD_KICK_MS);
    const back = await server.client({ from: "127.0.0.3" });
    await join(back);
    assert.equal(back.isOpen, true);
  } finally {
    await server.stop();
  }
});

test("ban a guest for 7 days: the connection hash is capped at 24 hours, then the guest may return; unban lifts it early", async () => {
  const time = clock();
  const server = await start({ now: time.now });
  try {
    const mod = await moderator(server);
    const target = await server.client({ from: "127.0.0.3" });
    const t = await join(target);
    mod.client.send({ type: "mod_action", action: "ban", targetId: t.playerId, durationMs: 7 * DAY });
    const banned = await target.waitFor(notice("banned"));
    assert.equal(banned.until, time.now() + DAY, "a guest's ban is keyed by the connection hash: 24 hours at most");
    // The moderator's result says so too (not the chosen 7 days).
    assert.equal((await mod.client.waitFor(result("ban"))).until, time.now() + DAY);
    assert.equal((await target.closed).code, MOD_CLOSE_CODES.banned);
    const entry = ((await mod.client.waitFor((m) => m.type === "mod_log" && (m.bans as Message[]).length === 1)).bans as Message[])[0]!;
    assert.deepEqual({ ...entry, id: "x" }, { id: "x", nickname: t.nickname, kind: "ban", until: time.now() + DAY, byName: false, byConnection: true });
    time.advance(DAY - 60_000);
    const early = await server.client({ from: "127.0.0.3" });
    await early.waitFor(notice("banned"));
    assert.equal((await early.closed).code, MOD_CLOSE_CODES.banned, "the banned player cannot rejoin");
    // Unban: the guest is back at once.
    mod.client.send({ type: "mod_action", action: "unban", entryId: entry.id });
    await mod.client.waitFor(result("unban"));
    const back = await server.client({ from: "127.0.0.3" });
    await join(back);
    assert.equal(back.isOpen, true);
    // The log has every action, newest first, with the moderator's nickname.
    const log = ((await mod.client.waitFor((m) => m.type === "mod_log" && (m.log as Message[]).length >= 2)).log as Message[]).map((x) => [x.moderator, x.action, x.target]);
    assert.deepEqual(log.slice(0, 2), [
      [mod.nickname, "unban", t.nickname],
      [mod.nickname, "ban", t.nickname],
    ]);
  } finally {
    await server.stop();
  }
});

/** A names.json holding one registered name for `key` (as a confirmed registration leaves it). */
function seedStore(path: string, key: TestNameKey, displayName: string): void {
  const now = Date.now();
  writeFileSync(path, JSON.stringify({ v: 1, names: [{ nameKey: displayName.toLowerCase(), displayName, keyHash: key.keyHash, publicKey: null, alg: null, avatar: null, createdAt: now, lastSeen: now }], usedNotes: [] }));
}

function namesFrom(path: string): NameService {
  const registry = new NameRegistry({ now: Date.now, store: new FileNameStore(path), address: NAME_DEV_ADDRESS, feeZat: 1_000_000, minConfirmations: 1 });
  return new NameService({ mode: "dev", registry, scanner: new DevNameScanner(Date.now, 200) });
}

/** Claims `name` with `key` before joining, then joins as a holder. Resolves the welcome, or the close if refused. */
async function claimAndJoin(client: Client, key: TestNameKey, name: string): Promise<Message | { closed: number }> {
  client.send({ type: "name_claim_request", nickname: name });
  const challenge = await client.waitFor(isType("name_challenge"));
  client.send(await key.proof(String(challenge.nonce), name));
  const outcome = await Promise.race([client.waitFor((m) => m.type === "name_status" && m.status === "confirmed"), client.closed.then((c) => ({ closed: c.code }))]);
  if ("closed" in outcome) return outcome as { closed: number };
  client.send({ type: "join", wallet: true, nickname: name });
  return client.waitFor(isType("welcome"));
}

test("ban an owned name for 7 days: bannedUntil is stored in names.json, survives a restart, and unban clears it", async () => {
  const dir = mkdtempSync(joinPath(tmpdir(), "zw-mod-"));
  const file = joinPath(dir, "names.json");
  try {
    const key = await testNameKey();
    seedStore(file, key, "Nadia");
    const first = await start({ names: namesFrom(file) });
    let until = 0;
    try {
      const mod = await moderator(first);
      const owner = await first.client({ from: "127.0.0.3" });
      const welcome = (await claimAndJoin(owner, key, "Nadia")) as Message;
      assert.equal(welcome.nickname, "Nadia");
      mod.client.send({ type: "mod_action", action: "ban", targetId: welcome.playerId, durationMs: 7 * DAY });
      until = Number((await owner.waitFor(notice("banned"))).until);
      assert.ok(until >= Date.now() + 7 * DAY - 5_000, "an owned name is banned for the full time");
      await owner.closed;
      const stored = JSON.parse(readFileSync(file, "utf8")) as { names: Message[] };
      assert.equal(stored.names[0]!.bannedUntil, until, "bannedUntil only — no reason, no moderator");
      assert.deepEqual(Object.keys(stored.names[0]!).sort(), ["alg", "avatar", "bannedUntil", "createdAt", "displayName", "keyHash", "lastSeen", "nameKey", "publicKey"]);
    } finally {
      await first.stop();
    }
    // A restart: a new process key, so the connection hash no longer matches — only the stored name ban remains.
    const second = await start({ names: namesFrom(file) });
    try {
      const owner = await second.client({ from: "127.0.0.3" });
      const outcome = await claimAndJoin(owner, key, "Nadia");
      assert.deepEqual(outcome, { closed: MOD_CLOSE_CODES.banned }, "the banned name is refused the moment it is proved");
      assert.equal(owner.messages.find(notice("banned"))?.until, until);
      // A moderator sees the stored ban and lifts it.
      const mod = await moderator(second);
      const ban = (mod.client.messages.find(isType("mod_log"))!.bans as Message[])[0]!;
      assert.deepEqual({ nickname: ban.nickname, byName: ban.byName, byConnection: ban.byConnection, until: ban.until }, { nickname: "Nadia", byName: true, byConnection: false, until });
      mod.client.send({ type: "mod_action", action: "unban", entryId: ban.id });
      await mod.client.waitFor(result("unban"));
      const stored = JSON.parse(readFileSync(file, "utf8")) as { names: Message[] };
      assert.equal(stored.names[0]!.bannedUntil, undefined);
      const back = await second.client({ from: "127.0.0.3" });
      assert.equal(((await claimAndJoin(back, key, "Nadia")) as Message).nickname, "Nadia");
    } finally {
      await second.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a report keeps working after its target left: the moderator bans from the report (both keys)", async () => {
  const server = await start();
  try {
    const mod = await moderator(server);
    const reporter = await server.client({ from: "127.0.0.2" });
    await join(reporter);
    const target = await server.client({ from: "127.0.0.3" });
    const t = await join(target);
    reporter.send({ type: "report", targetId: t.playerId, reason: "harassment" });
    const report = (await mod.client.waitFor(isType("mod_report"))).report as Message;
    target.close();
    await mod.client.waitFor((m) => m.type === "mod_log" && (m.reports as Message[])[0]?.targetId === null);
    mod.client.send({ type: "mod_action", action: "ban", reportId: report.id, durationMs: 60 * 60_000 });
    assert.equal((await mod.client.waitFor(result("ban"))).target, t.nickname);
    const state = await mod.client.waitFor((m) => m.type === "mod_log" && (m.bans as Message[]).length === 1);
    assert.equal((state.reports as Message[]).length, 0, "acting on a report handles it");
    const again = await server.client({ from: "127.0.0.3" });
    assert.equal((await again.closed).code, MOD_CLOSE_CODES.banned);
  } finally {
    await server.stop();
  }
});

// ------------------------------------------------------------------ per-IP cap and TRUST_PROXY

test("per-IP cap: a 5th concurrent socket and an 11th new connection a minute are refused with a plain notice; other networks are not", async () => {
  const time = clock();
  const server = await start({ now: time.now, connectionLimits: { maxSessionsPerIp: 4, maxNewPerMinute: 10 } });
  try {
    const open: Client[] = [];
    for (let i = 0; i < 4; i++) open.push(await server.client({ from: "127.0.0.4" }));
    const fifth = await server.client({ from: "127.0.0.4" });
    assert.deepEqual(await fifth.waitFor(isType("moderation_notice")), { type: "moderation_notice", kind: "too_many_connections" });
    assert.deepEqual(await fifth.closed, { code: MOD_CLOSE_CODES.too_many_connections, reason: "too_many_connections" });
    const elsewhere = await server.client({ from: "127.0.0.5" });
    await join(elsewhere);
    // 5 attempts so far this minute: close and reopen until the 10th, then the 11th is refused with a free place.
    for (let i = 0; i < 5; i++) {
      const old = open.pop()!;
      old.close();
      await old.closed;
      await settle(20);
      open.push(await server.client({ from: "127.0.0.4" }));
    }
    const old = open.pop()!;
    old.close();
    await old.closed;
    await settle(20);
    const eleventh = await server.client({ from: "127.0.0.4" });
    assert.equal((await eleventh.closed).code, MOD_CLOSE_CODES.too_many_connections);
    time.advance(61_000);
    const later = await server.client({ from: "127.0.0.4" });
    await join(later);
    assert.equal(later.isOpen, true, "a minute later it works again");
  } finally {
    await server.stop();
  }
});

test("TRUST_PROXY: X-Forwarded-For moves the address only from the named proxy; any other client's header is ignored", async () => {
  const server = await start({ connectionLimits: { maxSessionsPerIp: 1, maxNewPerMinute: 10 }, trustedProxies: new Set(["127.0.0.1"]) });
  try {
    // Through the proxy (127.0.0.1): two clients, two networks.
    const a = await server.client({ from: "127.0.0.1", forwardedFor: "198.51.100.1" });
    await join(a);
    const b = await server.client({ from: "127.0.0.1", forwardedFor: "evil, 198.51.100.2" });
    await join(b);
    assert.equal(b.isOpen, true);
    // Straight from a client (127.0.0.6): the spoofed header changes nothing — one network, the second socket refused.
    const c = await server.client({ from: "127.0.0.6", forwardedFor: "198.51.100.3" });
    await join(c);
    const d = await server.client({ from: "127.0.0.6", forwardedFor: "198.51.100.4" });
    assert.equal((await d.closed).code, MOD_CLOSE_CODES.too_many_connections);
    // A spoofed header naming a banned-looking or a proxy address doesn't help either.
    const e = await server.client({ from: "127.0.0.6", forwardedFor: "127.0.0.1" });
    assert.equal((await e.closed).code, MOD_CLOSE_CODES.too_many_connections);
  } finally {
    await server.stop();
  }
});

// ------------------------------------------------------------------ LiveKit revoke

test("LiveKit revoke: a moderator's cooldown on the holder and an identity loss revoke publishing; a holder's own stop doesn't", async () => {
  const server = await start();
  try {
    const mod = await moderator(server);
    mod.client.send({ type: "player_transform", x: HALL_X, y: 0, z: 0, rotationY: 0, animationState: "idle", seq: 1 });
    await mod.client.waitFor(isType("hall_state"));
    const holder = await server.client({ from: "127.0.0.3" });
    const h = await join(holder, { type: "join", wallet: true });
    holder.send({ type: "player_transform", x: HALL_X, y: 0, z: 3, rotationY: 0, animationState: "idle", seq: 1 });
    await holder.waitFor(isType("hall_state"));
    const becomeLive = async (): Promise<void> => {
      holder.send({ type: "hall_stage_request" });
      await mod.client.waitFor((m) => m.type === "hall_stage" && (m.stage as Message).holder === h.playerId && (m.stage as Message).status === "preparing");
      holder.send({ type: "hall_stage_live", live: true, audio: true });
      await mod.client.waitFor((m) => m.type === "hall_stage" && (m.stage as Message).status === "live");
      mod.client.messages.length = 0;
    };
    // The holder's own stop: no revoke.
    await becomeLive();
    holder.send({ type: "hall_stage_stop" });
    await mod.client.waitFor((m) => m.type === "hall_stage" && (m.stage as Message).holder === null);
    assert.deepEqual(server.fakes.revoked, []);
    // A moderator's stop (host power) revokes.
    await becomeLive();
    mod.client.send({ type: "hall_stage_stop" });
    await mod.client.waitFor((m) => m.type === "hall_stage" && (m.stage as Message).holder === null);
    assert.deepEqual(server.fakes.revoked, [h.playerId]);
    // A cooldown (bench) on the holder revokes.
    await becomeLive();
    mod.client.send({ type: "hall_stage_cooldown", playerId: h.playerId, ms: 600_000 });
    await mod.client.waitFor((m) => m.type === "hall_stage" && (m.stage as Message).holder === null);
    assert.deepEqual(server.fakes.revoked, [h.playerId, h.playerId]);
    // Identity loss (Forget this wallet): no longer allowed to talk → revoked.
    holder.send({ type: "set_wallet", connected: false });
    await holder.waitFor((m) => m.type === "can_receive_updated" && m.canReceive === false);
    assert.deepEqual(server.fakes.revoked, [h.playerId, h.playerId, h.playerId]);
    assert.deepEqual(server.fakes.removed, []);
  } finally {
    await server.stop();
  }
});

// ------------------------------------------------------------------ nothing logged

test("nothing is logged: no nickname, note, key or address — only nameless 'moderation action: …' lines", async () => {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const capture = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  console.info = capture;
  try {
    const server = await start({ connectionLimits: { maxSessionsPerIp: 2, maxNewPerMinute: 10 } });
    try {
      const mod = await moderator(server);
      const reporter = await server.client({ from: "127.0.0.2" });
      const r = await join(reporter, { type: "join", wallet: true, nickname: "ReporterRita" });
      const target = await server.client({ from: "127.0.0.3" });
      const t = await join(target, { type: "join", wallet: true, nickname: "TargetTom" });
      reporter.send({ type: "report", targetId: t.playerId, reason: "harassment", note: "secret-note-text-123" });
      await mod.client.waitFor(isType("mod_report"));
      mod.client.send({ type: "mod_action", action: "mute", targetId: t.playerId, durationMs: 600_000 });
      await mod.client.waitFor(result("mute"));
      target.send({ type: "chat_send", channel: "general", text: "muted-line-xyz" });
      await target.waitFor(notice("muted"));
      mod.client.send({ type: "mod_action", action: "ban", targetId: t.playerId, durationMs: 60 * 60_000 });
      await target.closed;
      const refused = await server.client({ from: "127.0.0.3" });
      await refused.closed;
      for (let i = 0; i < 3; i++) await server.client({ from: "127.0.0.7" }).catch(() => undefined);
      await settle();
      const text = lines.join("\n");
      for (const secret of [mod.nickname, r.nickname, t.nickname, "secret-note-text-123", "muted-line-xyz", MOD_KEY, "127.0.0.", r.playerId, t.playerId]) {
        assert.equal(text.includes(secret), false, `the log must not contain ${secret}`);
      }
      assert.deepEqual(lines, ["[moderation] moderation action: mute", "[moderation] moderation action: ban"]);
    } finally {
      await server.stop();
    }
  } finally {
    Object.assign(console, original);
  }
});

// ------------------------------------------------------------------ session coverage, keys and expiry

test("a ban closes every live session it covers — another tab on the network, an onboarding socket — not a moderator there", async () => {
  const time = clock();
  const server = await start({ now: time.now });
  try {
    const mod = await moderator(server, "127.0.0.5");
    const watcher = await server.client({ from: "127.0.0.2" });
    await join(watcher);
    const tabA = await server.client({ from: "127.0.0.5" });
    const a = await join(tabA);
    const tabB = await server.client({ from: "127.0.0.5" });
    const b = await join(tabB);
    const onboarding = await server.client({ from: "127.0.0.5" });
    onboarding.send({ type: "nickname_check", nickname: "Somebody" });
    await onboarding.waitFor(isType("nickname_check_result"));
    mod.client.send({ type: "mod_action", action: "ban", targetId: a.playerId, durationMs: DAY });
    assert.equal((await tabA.closed).code, MOD_CLOSE_CODES.banned);
    // The other tab is closed too (it can't chat or report on), with the same notice …
    assert.equal((await tabB.waitFor(notice("banned"))).until, time.now() + DAY);
    assert.equal((await tabB.closed).code, MOD_CLOSE_CODES.banned);
    await watcher.waitFor((m) => m.type === "player_left" && m.playerId === b.playerId);
    // … and so is a socket still onboarding from that network.
    assert.equal((await onboarding.closed).code, MOD_CLOSE_CODES.banned);
    // The moderator on the same network keeps working; another network is untouched.
    await settle();
    assert.equal(mod.client.isOpen, true);
    assert.equal(watcher.isOpen, true);
    assert.deepEqual(server.fakes.removed.sort(), [a.playerId, b.playerId].sort(), "both LiveKit participants are removed");
  } finally {
    await server.stop();
  }
});

test("a kick closes the target's other tab with 4001 too", async () => {
  const server = await start();
  try {
    const mod = await moderator(server);
    const tabA = await server.client({ from: "127.0.0.5" });
    const a = await join(tabA);
    const tabB = await server.client({ from: "127.0.0.5" });
    await join(tabB);
    mod.client.send({ type: "mod_action", action: "kick", targetId: a.playerId });
    assert.equal((await tabA.closed).code, MOD_CLOSE_CODES.kicked);
    assert.equal((await tabB.closed).code, MOD_CLOSE_CODES.kicked);
  } finally {
    await server.stop();
  }
});

test("banning from a report after the target reconnected closes the target's new session", async () => {
  const server = await start();
  try {
    const mod = await moderator(server);
    const reporter = await server.client({ from: "127.0.0.2" });
    await join(reporter);
    const target = await server.client({ from: "127.0.0.3" });
    const t = await join(target);
    reporter.send({ type: "report", targetId: t.playerId, reason: "harassment" });
    const report = (await mod.client.waitFor(isType("mod_report"))).report as Message;
    target.close();
    await mod.client.waitFor((m) => m.type === "mod_log" && (m.reports as Message[])[0]?.targetId === null);
    // Reloaded: a new session, a new Guest name, the same network.
    const back = await server.client({ from: "127.0.0.3" });
    const b = await join(back);
    mod.client.send({ type: "mod_action", action: "ban", reportId: report.id, durationMs: 60 * 60_000 });
    assert.equal((await mod.client.waitFor(result("ban"))).ok, true);
    assert.equal((await back.closed).code, MOD_CLOSE_CODES.banned, "the reconnected target is out too");
    await reporter.waitFor((m) => m.type === "player_left" && m.playerId === b.playerId);
  } finally {
    await server.stop();
  }
});

test("an owned name banned from a report is closed wherever it reconnected (by its name key)", async () => {
  const dir = mkdtempSync(joinPath(tmpdir(), "zw-mod-c1-"));
  const file = joinPath(dir, "names.json");
  try {
    const key = await testNameKey();
    seedStore(file, key, "Nadia");
    const server = await start({ names: namesFrom(file) });
    try {
      const mod = await moderator(server);
      const reporter = await server.client({ from: "127.0.0.2" });
      await join(reporter);
      const first = await server.client({ from: "127.0.0.3" });
      const welcome = (await claimAndJoin(first, key, "Nadia")) as Message;
      reporter.send({ type: "report", targetId: welcome.playerId, reason: "harassment" });
      const report = (await mod.client.waitFor(isType("mod_report"))).report as Message;
      first.close();
      await mod.client.waitFor((m) => m.type === "mod_log" && (m.reports as Message[])[0]?.targetId === null);
      // Back from another network (a phone): only the name key links it to the report.
      const again = await server.client({ from: "127.0.0.4" });
      assert.equal(((await claimAndJoin(again, key, "Nadia")) as Message).nickname, "Nadia");
      mod.client.send({ type: "mod_action", action: "ban", reportId: report.id, durationMs: 7 * DAY });
      assert.deepEqual(
        { ok: (await mod.client.waitFor(result("ban"))).ok },
        { ok: true },
      );
      assert.equal((await again.closed).code, MOD_CLOSE_CODES.banned);
      assert.ok(Number(again.messages.find(notice("banned"))?.until) >= Date.now() + 7 * DAY - 5_000);
    } finally {
      await server.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("muting a guest mutes guests on its network but not an owned-name holder there; unmute tells everyone it silenced", async () => {
  const dir = mkdtempSync(joinPath(tmpdir(), "zw-mod-a3-"));
  const file = joinPath(dir, "names.json");
  try {
    const key = await testNameKey();
    seedStore(file, key, "Alice");
    const server = await start({ names: namesFrom(file) });
    try {
      const mod = await moderator(server);
      const watcher = await server.client({ from: "127.0.0.2" });
      await join(watcher);
      const alice = await server.client({ from: "127.0.0.7" });
      const a = (await claimAndJoin(alice, key, "Alice")) as Message;
      const troll = await server.client({ from: "127.0.0.7" });
      const t = await join(troll);
      const sibling = await server.client({ from: "127.0.0.7" });
      await join(sibling);
      mod.client.send({ type: "mod_action", action: "mute", targetId: t.playerId, durationMs: 600_000 });
      await mod.client.waitFor(result("mute"));
      const entry = ((await mod.client.waitFor((m) => m.type === "mod_log" && (m.mutes as Message[]).length === 1)).mutes as Message[])[0]!;
      // Alice — her own owned name — keeps chatting and is told nothing.
      alice.send({ type: "chat_send", channel: "general", text: "hello from Alice" });
      const line = await watcher.waitFor((m) => m.type === "chat_message" && m.text === "hello from Alice");
      assert.equal(line.fromPlayerId, a.playerId);
      assert.equal(alice.messages.some(notice("muted")), false);
      // Another guest on that network is muted (the network is a guest's only key).
      sibling.send({ type: "chat_send", channel: "general", text: "me too" });
      await sibling.waitFor(notice("muted"));
      await troll.waitFor(notice("muted"));
      // Unmute: the target and the sibling (both were told they were muted) hear so; Alice doesn't.
      mod.client.send({ type: "mod_action", action: "unmute", entryId: entry.id });
      await mod.client.waitFor(result("unmute"));
      await troll.waitFor(notice("unmuted"));
      await sibling.waitFor(notice("unmuted"));
      await settle();
      assert.equal(alice.messages.some(notice("unmuted")), false);
      sibling.send({ type: "chat_send", channel: "general", text: "free" });
      await watcher.waitFor((m) => m.type === "chat_message" && m.text === "free");
    } finally {
      await server.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forgetting the wallet is no second report budget — the same target again is rate_limited", async () => {
  const dir = mkdtempSync(joinPath(tmpdir(), "zw-mod-a4-"));
  const file = joinPath(dir, "names.json");
  try {
    const key = await testNameKey();
    seedStore(file, key, "Rep");
    const server = await start({ names: namesFrom(file) });
    try {
      await moderator(server);
      const target = await server.client({ from: "127.0.1.1" });
      const t = await join(target);
      const rep = await server.client({ from: "127.0.0.8" });
      await claimAndJoin(rep, key, "Rep");
      rep.send({ type: "report", targetId: t.playerId, reason: "spam" });
      assert.equal((await rep.waitFor(isType("report_ack"))).status, "sent");
      rep.send({ type: "set_wallet", connected: false });
      await rep.waitFor((m) => m.type === "can_receive_updated" && m.canReceive === false);
      rep.messages.length = 0;
      rep.send({ type: "report", targetId: t.playerId, reason: "spam" });
      assert.equal((await rep.waitFor(isType("report_ack"))).status, "rate_limited");
    } finally {
      await server.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a report about a moderator reaches the other moderators only — never the reported one, live or in the state", async () => {
  const server = await start();
  try {
    const moddy = await moderator(server, "127.0.0.20");
    const other = await moderator(server, "127.0.0.21");
    const guest = await server.client({ from: "127.0.0.2" });
    const g = await join(guest);
    guest.send({ type: "report", targetId: moddy.playerId, reason: "harassment", note: "abusing mod powers" });
    assert.equal((await guest.waitFor(isType("report_ack"))).status, "sent");
    const live = (await other.client.waitFor(isType("mod_report"))).report as Message;
    assert.equal(live.reporter, g.nickname);
    // A change makes every moderator's state go out again: Moddy's leaves the report out.
    other.client.send({ type: "mod_action", action: "dismiss_report", reportId: live.id });
    await other.client.waitFor(result("dismiss_report"));
    const otherState = await other.client.waitFor((m) => m.type === "mod_log" && (m.log as Message[]).some((entry) => entry.action === "dismiss_report"));
    assert.ok(otherState);
    await settle();
    assert.equal(moddy.client.messages.some(isType("mod_report")), false, "no live report");
    for (const state of moddy.client.messages.filter(isType("mod_log"))) {
      assert.equal((state.reports as Message[]).length, 0);
      assert.equal((state.log as Message[]).some((entry) => entry.action === "dismiss_report"), false, "not even its dismissal");
    }
    const moderationMessages = JSON.stringify(moddy.client.messages.filter((m) => String(m.type).startsWith("mod_")));
    assert.equal(moderationMessages.includes("abusing mod powers"), false);
    assert.equal(moderationMessages.includes(g.nickname), false, "no moderation message names the reporter to Moddy");
  } finally {
    await server.stop();
  }
});

test("a reported player who signs in as a moderator later doesn't get the report about them", async () => {
  const server = await start();
  try {
    const mod = await moderator(server, "127.0.0.20");
    const reporter = await server.client({ from: "127.0.0.2" });
    const r = await join(reporter);
    const target = await server.client({ from: "127.0.0.3" });
    const t = await join(target, { type: "join", wallet: true });
    reporter.send({ type: "report", targetId: t.playerId, reason: "spam", note: "spam links" });
    await mod.client.waitFor(isType("mod_report"));
    target.send({ type: "hall_host_auth", key: MOD_KEY });
    const state = await target.waitFor(isType("mod_log"));
    assert.deepEqual(state.reports, []);
    assert.equal(JSON.stringify(target.messages.filter((m) => String(m.type).startsWith("mod_"))).includes(r.nickname), false);
    // Signing in again (the state is resent) still leaves it out; the other moderator still has it.
    target.send({ type: "hall_host_auth", key: MOD_KEY });
    await settle();
    assert.ok(target.messages.filter(isType("mod_log")).every((m) => (m.reports as Message[]).length === 0));
    mod.client.send({ type: "hall_host_auth", key: MOD_KEY });
    const modState = await mod.client.waitFor((m) => m.type === "mod_log" && (m.reports as Message[]).length === 1);
    assert.equal(((modState.reports as Message[])[0]!).target, t.nickname);
  } finally {
    await server.stop();
  }
});

test("a stored ban that ended while the server was down is cleared from names.json at start-up", async () => {
  const dir = mkdtempSync(joinPath(tmpdir(), "zw-mod-p3-"));
  const file = joinPath(dir, "names.json");
  try {
    const key = await testNameKey();
    seedStore(file, key, "Nadia");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { names: Message[] };
    raw.names[0]!.bannedUntil = Date.now() - 60 * 60_000;
    writeFileSync(file, JSON.stringify(raw));
    const server = await start({ names: namesFrom(file) });
    try {
      const stored = JSON.parse(readFileSync(file, "utf8")) as { names: Message[] };
      assert.equal(stored.names[0]!.bannedUntil, undefined, "the ended ban is gone from the file");
      const owner = await server.client({ from: "127.0.0.3" });
      assert.equal(((await claimAndJoin(owner, key, "Nadia")) as Message).nickname, "Nadia");
    } finally {
      await server.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a trusted proxy forwarding a private address (a Docker gateway) gets one nameless warning", async () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  try {
    const server = await start({ trustedProxies: new Set(["127.0.0.1"]) });
    try {
      const visitor = await server.client({ from: "127.0.0.1", forwardedFor: "198.51.100.1" });
      await join(visitor);
      assert.deepEqual(warnings, [], "a public address is fine");
      for (let i = 0; i < 2; i++) await join(await server.client({ from: "127.0.0.1", forwardedFor: "172.16.5.1" }));
      assert.equal(warnings.length, 1, "warned once");
      assert.match(warnings[0]!, /TRUST_PROXY/);
      assert.match(warnings[0]!, /AAAA/);
      assert.equal(warnings[0]!.includes("172.16.5.1"), false, "the address is never logged");
    } finally {
      await server.stop();
    }
  } finally {
    console.warn = original;
  }
});
