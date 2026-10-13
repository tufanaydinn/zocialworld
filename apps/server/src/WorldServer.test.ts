import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { WorldServer, type WorldServerOptions } from "./WorldServer.js";

/**
 * Each test spins up a real WorldServer on an
 * ephemeral port and drives it with real WebSocket clients (Node's
 * built-in global `WebSocket`) — these are integration tests of the
 * actual wire behavior, not mocks of it.
 */

interface TestClient {
  socket: WebSocket;
  messages: Record<string, unknown>[];
  waitForOpen: () => Promise<void>;
  waitFor: (predicate: (m: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
  send: (message: Record<string, unknown>) => void;
  close: () => void;
}

function createClient(port: number): TestClient {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: Record<string, unknown>[] = [];
  const waiters: {
    predicate: (m: Record<string, unknown>) => boolean;
    resolve: (m: Record<string, unknown>) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];

  socket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data as string) as Record<string, unknown>;
    messages.push(data);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.predicate(data)) {
        clearTimeout(waiters[i]!.timer);
        waiters[i]!.resolve(data);
        waiters.splice(i, 1);
      }
    }
  });

  function waitFor(predicate: (m: Record<string, unknown>) => boolean, timeoutMs = 2000): Promise<Record<string, unknown>> {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
      waiters.push({ predicate, resolve, timer });
    });
  }

  function waitForOpen(): Promise<void> {
    if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve) => socket.addEventListener("open", () => resolve(), { once: true }));
  }

  return {
    socket,
    messages,
    waitForOpen,
    waitFor,
    send: (message) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
  };
}

async function startServer(options: WorldServerOptions = {}): Promise<{ port: number; world: WorldServer; stop: () => Promise<void> }> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const world = new WorldServer(wss, options);

  return {
    port,
    world,
    stop: () =>
      new Promise<void>((resolve) => {
        world.dispose();
        wss.close(() => resolve());
      }),
  };
}

test("client connects and receives a unique temporary playerId", async () => {
  const { port, stop } = await startServer();
  try {
    const client = createClient(port);
    await client.waitForOpen();
    client.send({ type: "join", wallet: true, nickname: "Alice" });

    const welcome = await client.waitFor((m) => m.type === "welcome");
    assert.equal(typeof welcome.playerId, "string");
    assert.ok((welcome.playerId as string).length > 0);
    assert.equal(welcome.nickname, "Alice");

    client.close();
  } finally {
    await stop();
  }
});

test("a second client joining causes the first to receive player_joined", async () => {
  const { port, stop } = await startServer();
  try {
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join", wallet: true, nickname: "A" });
    const aWelcome = await a.waitFor((m) => m.type === "welcome");

    const b = createClient(port);
    await b.waitForOpen();
    b.send({ type: "join", wallet: true, nickname: "B" });

    const joinedEvent = await a.waitFor((m) => m.type === "player_joined");
    assert.equal(joinedEvent.nickname, "B");
    assert.notEqual(joinedEvent.playerId, aWelcome.playerId);

    a.close();
    b.close();
  } finally {
    await stop();
  }
});

test("a transform sent by A is relayed to B (and not echoed back to A)", async () => {
  const { port, stop } = await startServer();
  try {
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join" });
    await a.waitFor((m) => m.type === "welcome");

    const b = createClient(port);
    await b.waitForOpen();
    b.send({ type: "join" });
    await b.waitFor((m) => m.type === "welcome");
    await a.waitFor((m) => m.type === "player_joined"); // A has registered B before we move

    a.send({ type: "player_transform", x: 1, y: 0, z: 2, rotationY: 0.5, animationState: "walk", seq: 1 });

    const relayed = await b.waitFor((m) => m.type === "player_transform");
    assert.equal(relayed.x, 1);
    assert.equal(relayed.z, 2);
    assert.equal(relayed.animationState, "walk");
    assert.equal(relayed.seq, 1);

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(!a.messages.some((m) => m.type === "player_transform"), "sender must not receive its own transform back");

    a.close();
    b.close();
  } finally {
    await stop();
  }
});

test("disconnecting A causes B to receive player_left", async () => {
  const { port, stop } = await startServer();
  try {
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join" });
    const aWelcome = await a.waitFor((m) => m.type === "welcome");

    const b = createClient(port);
    await b.waitForOpen();
    b.send({ type: "join" });
    await b.waitFor((m) => m.type === "welcome");

    a.close();

    const left = await b.waitFor((m) => m.type === "player_left");
    assert.equal(left.playerId, aWelcome.playerId);

    b.close();
  } finally {
    await stop();
  }
});

test("invalid transform payloads are rejected without crashing the server", async () => {
  const { port, world, stop } = await startServer();
  try {
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join" });
    await a.waitFor((m) => m.type === "welcome");

    a.socket.send("not json at all");
    a.socket.send(JSON.stringify({ type: "player_transform", x: "nope", y: 0, z: 0, rotationY: 0, animationState: "walk", seq: 1 }));
    a.socket.send(JSON.stringify({ type: "player_transform", x: Infinity, y: 0, z: 0, rotationY: 0, animationState: "walk", seq: 1 }));
    a.socket.send(JSON.stringify({ type: "player_transform", x: 0, y: 0, z: 0, rotationY: 0, animationState: "not-a-real-state", seq: 1 }));
    a.socket.send(JSON.stringify({ type: "totally_unknown_message_type" }));
    a.socket.send(JSON.stringify({ type: "player_transform" })); // missing fields entirely

    await new Promise((resolve) => setTimeout(resolve, 150));

    // Server is still alive and A is still a counted player — nothing crashed or disconnected A.
    assert.equal(world.playerCount, 1);

    const b = createClient(port);
    await b.waitForOpen();
    b.send({ type: "join" });
    const bWelcome = await b.waitFor((m) => m.type === "welcome");
    assert.ok(bWelcome.playerId);

    a.close();
    b.close();
  } finally {
    await stop();
  }
});

test("the protocol has no block-related message type — a block_player message is silently dropped like any other unknown type", async () => {
  const { port, world, stop } = await startServer();
  try {
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join" });
    await a.waitFor((m) => m.type === "welcome");

    // SocialStore (apps/web/src/social/SocialStore.ts) never sends anything
    // like this — this proves the server-side wire contract has no such
    // message type to begin with, so block state could not reach the
    // server even if a client tried.
    a.socket.send(JSON.stringify({ type: "block_player", playerId: "someone" }));

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(world.playerCount, 1, "an unrecognized block_player message must not crash or disconnect the sender");

    a.close();
  } finally {
    await stop();
  }
});

test("two clients joining with the same nickname get a deterministic conflict-safe result", async () => {
  const { port, stop } = await startServer();
  try {
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join", wallet: true, nickname: "Nadia" });
    const aWelcome = await a.waitFor((m) => m.type === "welcome");
    assert.equal(aWelcome.nickname, "Nadia");

    const b = createClient(port);
    await b.waitForOpen();
    b.send({ type: "join", wallet: true, nickname: "Nadia" });
    const bWelcome = await b.waitFor((m) => m.type === "welcome");
    assert.equal(bWelcome.nickname, "Nadia-2");

    const c = createClient(port);
    await c.waitForOpen();
    c.send({ type: "join", wallet: true, nickname: "Nadia" });
    const cWelcome = await c.waitFor((m) => m.type === "welcome");
    assert.equal(cWelcome.nickname, "Nadia-3");

    a.close();
    b.close();
    c.close();
  } finally {
    await stop();
  }
});

test("an invalid join nickname falls back to a generated Guest-#### rather than erroring", async () => {
  const { port, stop } = await startServer();
  try {
    const whitespace = createClient(port);
    await whitespace.waitForOpen();
    whitespace.send({ type: "join", wallet: true, nickname: "   " });
    const welcome1 = await whitespace.waitFor((m) => m.type === "welcome");
    assert.match(welcome1.nickname as string, /^Guest-\d{4}$/);

    const controlChar = createClient(port);
    await controlChar.waitForOpen();
    controlChar.send({ type: "join", wallet: true, nickname: "Na\u0007dia" });
    const welcome2 = await controlChar.waitFor((m) => m.type === "welcome");
    assert.match(welcome2.nickname as string, /^Guest-\d{4}$/);

    whitespace.close();
    controlChar.close();
  } finally {
    await stop();
  }
});

test("a nickname change (set_nickname) reaches another connected client via nickname_updated", async () => {
  const { port, stop } = await startServer();
  try {
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join", wallet: true, nickname: "Alice" });
    const aWelcome = await a.waitFor((m) => m.type === "welcome");

    const b = createClient(port);
    await b.waitForOpen();
    b.send({ type: "join", wallet: true, nickname: "Bob" });
    await b.waitFor((m) => m.type === "welcome");
    await a.waitFor((m) => m.type === "player_joined"); // A has registered B before the rename

    a.send({ type: "set_nickname", nickname: "Builder" });

    const updateOnB = await b.waitFor((m) => m.type === "nickname_updated");
    assert.equal(updateOnB.playerId, aWelcome.playerId);
    assert.equal(updateOnB.nickname, "Builder");

    // The renaming client itself also receives the server-confirmed value.
    const updateOnA = await a.waitFor((m) => m.type === "nickname_updated");
    assert.equal(updateOnA.playerId, aWelcome.playerId);
    assert.equal(updateOnA.nickname, "Builder");

    a.close();
    b.close();
  } finally {
    await stop();
  }
});

test("set_nickname resolves a conflict with another connected client's current nickname", async () => {
  const { port, stop } = await startServer();
  try {
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join", wallet: true, nickname: "Alice" });
    await a.waitFor((m) => m.type === "welcome");

    const b = createClient(port);
    await b.waitForOpen();
    b.send({ type: "join", wallet: true, nickname: "Bob" });
    const bWelcome = await b.waitFor((m) => m.type === "welcome");
    await a.waitFor((m) => m.type === "player_joined");

    b.send({ type: "set_nickname", nickname: "Alice" }); // collides with A's current nickname

    const updateOnA = await a.waitFor((m) => m.type === "nickname_updated");
    assert.equal(updateOnA.playerId, bWelcome.playerId);
    assert.equal(updateOnA.nickname, "Alice-2");

    a.close();
    b.close();
  } finally {
    await stop();
  }
});

test("an invalid set_nickname request is dropped and the session keeps its current nickname", async () => {
  const { port, stop } = await startServer();
  try {
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join", wallet: true, nickname: "Alice" });
    await a.waitFor((m) => m.type === "welcome");

    a.send({ type: "set_nickname", nickname: "<script>alert(1)</script>" });

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(!a.messages.some((m) => m.type === "nickname_updated"), "an invalid nickname must not produce a nickname_updated broadcast");

    a.close();
  } finally {
    await stop();
  }
});

// --- Nickname trim/length contract -----------------------------------------
// The wire parser must not reject
// based on RAW (untrimmed) nickname length, and conflict-suffix resolution
// must never produce a nickname longer than MAX_NICKNAME_LENGTH.

test("a raw nickname with surrounding whitespace whose TRIMMED value is exactly max-length is accepted and normalized", async () => {
  const { port, stop } = await startServer();
  try {
    const exactly24 = "a".repeat(24);
    const a = createClient(port);
    await a.waitForOpen();
    // Raw length is 28 (2 leading + 24 + 2 trailing spaces) — over
    // MAX_NICKNAME_LENGTH (24) before trimming, but exactly 24 after.
    a.send({ type: "join", wallet: true, nickname: `  ${exactly24}  ` });

    const welcome = await a.waitFor((m) => m.type === "welcome");
    assert.equal(welcome.nickname, exactly24, "the join must succeed with the trimmed, normalized nickname, not fall back to Guest-####");

    a.close();
  } finally {
    await stop();
  }
});

test("a nickname whose TRIMMED value exceeds max-length still falls back to Guest-####", async () => {
  const { port, stop } = await startServer();
  try {
    const tooLongAfterTrim = "a".repeat(25); // 25 > MAX_NICKNAME_LENGTH even after trimming
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join", wallet: true, nickname: `  ${tooLongAfterTrim}  ` });

    const welcome = await a.waitFor((m) => m.type === "welcome");
    assert.match(welcome.nickname as string, /^Guest-\d{4}$/);

    a.close();
  } finally {
    await stop();
  }
});

test("two clients requesting the same exactly-max-length nickname both get a <= max-length, conflict-safe result", async () => {
  const { port, stop } = await startServer();
  try {
    const exactly24 = "a".repeat(24);
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join", wallet: true, nickname: exactly24 });
    const aWelcome = await a.waitFor((m) => m.type === "welcome");
    assert.equal(aWelcome.nickname, exactly24);
    assert.ok((aWelcome.nickname as string).length <= 24);

    const b = createClient(port);
    await b.waitForOpen();
    b.send({ type: "join", wallet: true, nickname: exactly24 });
    const bWelcome = await b.waitFor((m) => m.type === "welcome");
    assert.equal(bWelcome.nickname, "a".repeat(22) + "-2");
    assert.ok((bWelcome.nickname as string).length <= 24, "the conflict-suffixed nickname must still fit MAX_NICKNAME_LENGTH");
    assert.notEqual(bWelcome.nickname, aWelcome.nickname);

    a.close();
    b.close();
  } finally {
    await stop();
  }
});

test("set_nickname with harmless surrounding whitespace is normalized correctly before conflict resolution", async () => {
  const { port, stop } = await startServer();
  try {
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join", wallet: true, nickname: "Alice" });
    await a.waitFor((m) => m.type === "welcome");

    const exactly24 = "b".repeat(24);
    a.send({ type: "set_nickname", nickname: `  ${exactly24}  ` });

    const update = await a.waitFor((m) => m.type === "nickname_updated");
    assert.equal(update.nickname, exactly24, "the rename must be trimmed/normalized, not dropped for raw length or left un-trimmed");

    a.close();
  } finally {
    await stop();
  }
});

test("existing control-character / markup rejection still holds at join (unaffected by the trim-order fix)", async () => {
  const { port, stop } = await startServer();
  try {
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join", wallet: true, nickname: "<script>alert(1)</script>" });

    const welcome = await a.waitFor((m) => m.type === "welcome");
    assert.match(welcome.nickname as string, /^Guest-\d{4}$/, "a markup-shaped nickname must still fall back to Guest-####, never be accepted as-is");

    a.close();
  } finally {
    await stop();
  }
});

test("a stale connection (no messages) is cleaned up and others are notified", async () => {
  const { port, stop } = await startServer({ staleTimeoutMs: 100, sweepIntervalMs: 30 });
  try {
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join" });
    const aWelcome = await a.waitFor((m) => m.type === "welcome");

    const b = createClient(port);
    await b.waitForOpen();
    b.send({ type: "join" });
    await b.waitFor((m) => m.type === "welcome");

    // B keeps itself alive with heartbeats (well under staleTimeoutMs) while
    // A sends nothing at all and goes stale.
    const heartbeat = setInterval(() => b.send({ type: "heartbeat" }), 40);
    try {
      const left = await b.waitFor((m) => m.type === "player_left", 2000);
      assert.equal(left.playerId, aWelcome.playerId);
    } finally {
      clearInterval(heartbeat);
    }

    b.close();
  } finally {
    await stop();
  }
});

// ---------------------------------------------------------------------------
// Voice capability issuance/resolution/invalidation: the server never trusts
// a client-supplied playerId for voice. See
// apps/server/src/voice/capability.ts and WorldServer.resolveVoiceSession().
// ---------------------------------------------------------------------------

test("welcome carries a voiceCapability string, owner-only", async () => {
  const { port, stop } = await startServer();
  try {
    const client = createClient(port);
    await client.waitForOpen();
    client.send({ type: "join" });
    const welcome = await client.waitFor((m) => m.type === "welcome");
    assert.equal(typeof welcome.voiceCapability, "string");
    assert.ok((welcome.voiceCapability as string).length > 0);
    client.close();
  } finally {
    await stop();
  }
});

test("a valid current-session capability resolves to that session's own playerId and nickname", async () => {
  const { port, world, stop } = await startServer();
  try {
    const client = createClient(port);
    await client.waitForOpen();
    client.send({ type: "join", wallet: true, nickname: "Builder" });
    const welcome = await client.waitFor((m) => m.type === "welcome");

    const resolved = world.resolveVoiceSession(welcome.voiceCapability as string);
    // Without a name registry the holder flag also decides canTalk (ADR-015's honour mode).
    assert.deepEqual(resolved, { playerId: welcome.playerId, nickname: "Builder", canReceive: true, canTalk: true });
    client.close();
  } finally {
    await stop();
  }
});

test("an unknown/random capability is rejected (resolves to null)", async () => {
  const { port, world, stop } = await startServer();
  try {
    assert.equal(world.resolveVoiceSession("completely-made-up-value"), null);
    assert.equal(world.resolveVoiceSession(""), null);
  } finally {
    await stop();
  }
});

test("player A's capability cannot resolve to player B's identity, and vice versa", async () => {
  const { port, world, stop } = await startServer();
  try {
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join", wallet: true, nickname: "Alice" });
    const aWelcome = await a.waitFor((m) => m.type === "welcome");

    const b = createClient(port);
    await b.waitForOpen();
    b.send({ type: "join", wallet: true, nickname: "Bob" });
    const bWelcome = await b.waitFor((m) => m.type === "welcome");

    const resolvedA = world.resolveVoiceSession(aWelcome.voiceCapability as string);
    const resolvedB = world.resolveVoiceSession(bWelcome.voiceCapability as string);
    assert.equal(resolvedA?.playerId, aWelcome.playerId);
    assert.equal(resolvedB?.playerId, bWelcome.playerId);
    assert.notEqual(resolvedA?.playerId, resolvedB?.playerId);
    // The actual impersonation attempt this closes: A's capability must
    // never resolve to B's playerId, under any circumstance.
    assert.notEqual(resolvedA?.playerId, bWelcome.playerId);
    assert.notEqual(resolvedB?.playerId, aWelcome.playerId);

    a.close();
    b.close();
  } finally {
    await stop();
  }
});

test("after set_nickname, the capability resolves to the CURRENT server-authoritative nickname, not the stale join-time one", async () => {
  const { port, world, stop } = await startServer();
  try {
    const client = createClient(port);
    await client.waitForOpen();
    client.send({ type: "join", wallet: true, nickname: "OldName" });
    const welcome = await client.waitFor((m) => m.type === "welcome");

    client.send({ type: "set_nickname", nickname: "NewName" });
    await client.waitFor((m) => m.type === "nickname_updated");

    const resolved = world.resolveVoiceSession(welcome.voiceCapability as string);
    assert.equal(resolved?.nickname, "NewName");
    client.close();
  } finally {
    await stop();
  }
});

test("after disconnect, that session's capability no longer resolves", async () => {
  const { port, world, stop } = await startServer();
  try {
    const client = createClient(port);
    await client.waitForOpen();
    client.send({ type: "join" });
    const welcome = await client.waitFor((m) => m.type === "welcome");
    assert.ok(world.resolveVoiceSession(welcome.voiceCapability as string));

    const closed = new Promise<void>((resolve) => client.socket.addEventListener("close", () => resolve(), { once: true }));
    client.close();
    await closed;
    // The 'close' event firing client-side doesn't guarantee the
    // server has finished processing its own 'close' handler yet —
    // give the event loop one more turn.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(world.resolveVoiceSession(welcome.voiceCapability as string), null);
  } finally {
    await stop();
  }
});

test("after stale-session cleanup, that capability no longer resolves", async () => {
  const { port, world, stop } = await startServer({ staleTimeoutMs: 100, sweepIntervalMs: 30 });
  try {
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join" });
    const aWelcome = await a.waitFor((m) => m.type === "welcome");

    const b = createClient(port);
    await b.waitForOpen();
    b.send({ type: "join" });
    await b.waitFor((m) => m.type === "welcome");

    const heartbeat = setInterval(() => b.send({ type: "heartbeat" }), 40);
    try {
      await b.waitFor((m) => m.type === "player_left" && m.playerId === aWelcome.playerId, 2000);
    } finally {
      clearInterval(heartbeat);
    }

    assert.equal(world.resolveVoiceSession(aWelcome.voiceCapability as string), null);
    b.close();
  } finally {
    await stop();
  }
});

test("a reconnect receives a different capability, and the previous session's capability stays invalid", async () => {
  const { port, world, stop } = await startServer();
  try {
    const first = createClient(port);
    await first.waitForOpen();
    first.send({ type: "join" });
    const firstWelcome = await first.waitFor((m) => m.type === "welcome");

    const closed = new Promise<void>((resolve) => first.socket.addEventListener("close", () => resolve(), { once: true }));
    first.close();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 50));

    // A "reconnect" in this protocol is a brand-new WebSocket connection
    // (the identity model has no session resumption) —
    // it gets a fresh playerId and, now, a fresh capability.
    const second = createClient(port);
    await second.waitForOpen();
    second.send({ type: "join" });
    const secondWelcome = await second.waitFor((m) => m.type === "welcome");

    assert.notEqual(secondWelcome.voiceCapability, firstWelcome.voiceCapability);
    assert.equal(world.resolveVoiceSession(firstWelcome.voiceCapability as string), null);
    assert.ok(world.resolveVoiceSession(secondWelcome.voiceCapability as string));

    second.close();
  } finally {
    await stop();
  }
});

// ---------------------------------------------------------------------------
// ADR-015: wallet holders and guests — names, avatars,
// set_wallet, set_avatar, nickname_check and the per-session limiters.
// ---------------------------------------------------------------------------

const GUEST = /^Guest-\d{4}$/;
const pause = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

/** Opens a client and joins with `join` (any extra join fields); resolves with the client and its welcome. */
async function joinWith(port: number, join: Record<string, unknown>): Promise<{ client: TestClient; welcome: Record<string, unknown> }> {
  const client = createClient(port);
  await client.waitForOpen();
  client.send({ type: "join", ...join });
  const welcome = await client.waitFor((m) => m.type === "welcome");
  return { client, welcome };
}

test("ADR-015 (a): a guest asking for a name gets Guest-#### and canReceive false — in welcome, in the snapshot and in player_joined", async () => {
  const { port, stop } = await startServer();
  try {
    const observer = await joinWith(port, { nickname: "Watcher", wallet: true });
    const guest = await joinWith(port, { nickname: "Nadia", avatar: { model: "knight", color: 3 } });
    assert.match(guest.welcome.nickname as string, GUEST);
    assert.equal(guest.welcome.canReceive, false);
    const joined = await observer.client.waitFor((m) => m.type === "player_joined");
    assert.equal(joined.nickname, guest.welcome.nickname);
    assert.equal(joined.canReceive, false);
    assert.deepEqual(joined.avatar, guest.welcome.avatar, "a guest's join avatar is dropped: everyone sees the default");

    const late = await joinWith(port, { wallet: true, nickname: "Late" });
    const snapshot = await late.client.waitFor((m) => m.type === "player_snapshot");
    const entry = (snapshot.players as Record<string, unknown>[]).find((p) => p.playerId === guest.welcome.playerId)!;
    assert.equal(entry.canReceive, false);
    assert.equal(entry.nickname, guest.welcome.nickname);
    const holderEntry = (snapshot.players as Record<string, unknown>[]).find((p) => p.playerId === observer.welcome.playerId)!;
    assert.equal(holderEntry.canReceive, true);
    for (const c of [observer, guest, late]) c.client.close();
  } finally {
    await stop();
  }
});

test("ADR-015 (b): a holder's name and avatar are accepted, canReceive true", async () => {
  const { port, stop } = await startServer();
  try {
    const holder = await joinWith(port, { nickname: "Nadia", wallet: true, avatar: { model: "mage", color: 6 } });
    assert.equal(holder.welcome.nickname, "Nadia");
    assert.equal(holder.welcome.canReceive, true);
    assert.deepEqual(holder.welcome.avatar, { model: "mage", color: 6 });
    holder.client.close();
  } finally {
    await stop();
  }
});

test("ADR-015 (c): a guest's set_nickname and set_avatar are dropped silently", async () => {
  const { port, stop } = await startServer();
  try {
    const guest = await joinWith(port, {});
    guest.client.send({ type: "set_nickname", nickname: "Builder" });
    guest.client.send({ type: "set_avatar", avatar: { model: "knight", color: 1 } });
    await pause();
    assert.ok(!guest.client.messages.some((m) => m.type === "nickname_updated" || m.type === "avatar_updated"));
    guest.client.close();
  } finally {
    await stop();
  }
});

test("ADR-015 (d): set_wallet true broadcasts can_receive_updated to everyone; then a rename works", async () => {
  const { port, world, stop } = await startServer();
  try {
    const other = await joinWith(port, { nickname: "Other", wallet: true });
    const guest = await joinWith(port, {});
    guest.client.send({ type: "set_wallet", connected: true });
    for (const c of [other.client, guest.client]) {
      const update = await c.waitFor((m) => m.type === "can_receive_updated");
      assert.deepEqual(update, { type: "can_receive_updated", playerId: guest.welcome.playerId, canReceive: true });
    }
    assert.equal(world.resolveVoiceSession(guest.welcome.voiceCapability as string)?.canReceive, true);
    guest.client.send({ type: "set_wallet", connected: true }); // the same value again: nothing happens
    guest.client.send({ type: "set_nickname", nickname: "Builder" });
    const renamed = await other.client.waitFor((m) => m.type === "nickname_updated");
    assert.equal(renamed.nickname, "Builder");
    await pause();
    assert.equal(other.client.messages.filter((m) => m.type === "can_receive_updated").length, 1);
    other.client.close();
    guest.client.close();
  } finally {
    await stop();
  }
});

test("ADR-015 (e): set_wallet false gives a fresh Guest name and the default avatar, then can_receive_updated false", async () => {
  const { port, world, stop } = await startServer();
  try {
    const other = await joinWith(port, { nickname: "Other", wallet: true });
    const holder = await joinWith(port, { nickname: "Nadia", wallet: true, avatar: { model: "barbarian", color: 7 } });
    holder.client.send({ type: "set_wallet", connected: false });
    const rename = await other.client.waitFor((m) => m.type === "nickname_updated");
    assert.match(rename.nickname as string, GUEST);
    const avatar = await other.client.waitFor((m) => m.type === "avatar_updated");
    const seed = holder.welcome.colorSeed as number;
    assert.deepEqual(avatar.avatar, { model: ["rogue_hooded", "rogue", "knight", "mage", "barbarian"][seed % 5], color: seed % 8 });
    const flag = await other.client.waitFor((m) => m.type === "can_receive_updated");
    assert.equal(flag.canReceive, false);
    // Order: the new name, the avatar, then the flag (so no client ever shows a guest with a chosen name).
    const order = other.client.messages.map((m) => m.type).filter((t) => t === "nickname_updated" || t === "avatar_updated" || t === "can_receive_updated");
    assert.deepEqual(order, ["nickname_updated", "avatar_updated", "can_receive_updated"]);
    await holder.client.waitFor((m) => m.type === "can_receive_updated");
    assert.equal(world.resolveVoiceSession(holder.welcome.voiceCapability as string)?.canReceive, false);
    other.client.close();
    holder.client.close();
  } finally {
    await stop();
  }
});

test("ADR-015 (f): a holder asking for a Guest-style or system name is refused — at join and with set_nickname", async () => {
  const { port, stop } = await startServer();
  try {
    const fakeGuest = await joinWith(port, { nickname: "guest 12", wallet: true });
    assert.match(fakeGuest.welcome.nickname as string, GUEST, "a look-alike at join falls back to a real guest number");
    const holder = await joinWith(port, { nickname: "Ada", wallet: true });
    for (const name of ["Guest-1234", "guest 12", "GUEST_77", "admin", "Zocial World"]) holder.client.send({ type: "set_nickname", nickname: name });
    await pause();
    assert.ok(!holder.client.messages.some((m) => m.type === "nickname_updated"), "every reserved rename was dropped");
    fakeGuest.client.close();
    holder.client.close();
  } finally {
    await stop();
  }
});

test("ADR-015 (g): a guest rejoining with a free Guest number keeps it; a taken one is replaced by another number, never suffixed", async () => {
  const { port, stop } = await startServer();
  try {
    const first = await joinWith(port, { nickname: "Guest-4321" });
    assert.equal(first.welcome.nickname, "Guest-4321", "a free server-style guest name is kept (reconnect continuity)");
    const second = await joinWith(port, { nickname: "Guest-4321" });
    assert.match(second.welcome.nickname as string, GUEST);
    assert.notEqual(second.welcome.nickname, "Guest-4321");
    const holder = await joinWith(port, { nickname: "Guest-4321", wallet: true });
    assert.match(holder.welcome.nickname as string, GUEST, "a holder without a chosen name keeps a guest-style name too");
    assert.notEqual(holder.welcome.nickname, "Guest-4321");
    for (const c of [first, second, holder]) c.client.close();
  } finally {
    await stop();
  }
});

test("ADR-015 (h): avatars — a valid one is kept, an invalid one becomes the colorSeed default; set_avatar is broadcast to all and rate-limited", async () => {
  let clock = 1_000_000;
  const { port, stop } = await startServer({ now: () => clock, staleTimeoutMs: 10 ** 9 });
  try {
    const order = ["rogue_hooded", "rogue", "knight", "mage", "barbarian"];
    for (const bad of [{ model: "dragon", color: 1 }, { model: "knight", color: 8 }, { model: "knight", color: 1.5 }, "knight", null]) {
      const joined = await joinWith(port, { wallet: true, avatar: bad });
      const seed = joined.welcome.colorSeed as number;
      assert.deepEqual(joined.welcome.avatar, { model: order[seed % 5], color: seed % 8 }, JSON.stringify(bad));
      joined.client.close();
    }
    const other = await joinWith(port, { nickname: "Other", wallet: true });
    const holder = await joinWith(port, { nickname: "Ada", wallet: true, avatar: { model: "rogue", color: 0 } });
    const avatars = [
      { model: "knight", color: 1 },
      { model: "mage", color: 2 },
      { model: "barbarian", color: 3 },
      { model: "rogue_hooded", color: 4 },
    ];
    for (const avatar of avatars) holder.client.send({ type: "set_avatar", avatar });
    holder.client.send({ type: "set_avatar", avatar: { model: "knight", color: 99 } }); // malformed: dropped by the parser
    await pause();
    const seen = () => other.client.messages.filter((m) => m.type === "avatar_updated");
    assert.equal(seen().length, 3, "burst of 3, then the limiter drops the 4th");
    assert.deepEqual(seen()[0], { type: "avatar_updated", playerId: holder.welcome.playerId, avatar: { model: "knight", color: 1 } });
    assert.equal(holder.client.messages.filter((m) => m.type === "avatar_updated").length, 3, "the sender gets its own update too");
    clock += 20_000; // one token refills every 20 s
    holder.client.send({ type: "set_avatar", avatar: avatars[3] });
    await other.client.waitFor(() => seen().length === 4);
    other.client.close();
    holder.client.close();
  } finally {
    await stop();
  }
});

test("ADR-015 (i): before join, nickname_check is answered while chat, transform, pay and identity requests are ignored", async () => {
  const { port, world, stop } = await startServer();
  try {
    const taken = await joinWith(port, { nickname: "Nadia", wallet: true });
    const early = createClient(port);
    await early.waitForOpen();
    early.send({ type: "chat_send", channel: "general", text: "hello?" });
    early.send({ type: "player_transform", x: 1, y: 0, z: 1, rotationY: 0, animationState: "walk", seq: 1 });
    early.send({ type: "pay_request", to: taken.welcome.playerId, requestId: "req-early-01", senderKey: "QUJDRA==" });
    early.send({ type: "set_wallet", connected: true });
    early.send({ type: "set_avatar", avatar: { model: "knight", color: 1 } });
    early.send({ type: "nickname_check", nickname: "nadia" });
    const result = await early.waitFor((m) => m.type === "nickname_check_result");
    assert.deepEqual(result, { type: "nickname_check_result", nickname: "nadia", status: "taken", suggestion: "nadia-2" });
    early.send({ type: "nickname_check", nickname: "Ada" });
    early.send({ type: "nickname_check", nickname: "Guest-1234" });
    early.send({ type: "nickname_check", nickname: "<b>" });
    await early.waitFor(() => early.messages.filter((m) => m.type === "nickname_check_result").length === 4);
    const statuses = early.messages.filter((m) => m.type === "nickname_check_result").map((m) => [m.nickname, m.status]);
    assert.deepEqual(statuses.slice(1), [["Ada", "available"], ["Guest-1234", "reserved"], ["<b>", "invalid"]]);
    await pause();
    assert.equal(world.playerCount, 1, "the early connection never joined");
    assert.ok(!taken.client.messages.some((m) => m.type === "chat_message" || m.type === "player_transform" || m.type === "pay_request" || m.type === "can_receive_updated"));
    assert.ok(!early.messages.some((m) => m.type !== "nickname_check_result"), "nothing but check results reach a connection that has not joined");
    // A check reserves nothing: the name is still free for whoever joins first.
    const ada = await joinWith(port, { nickname: "Ada", wallet: true });
    assert.equal(ada.welcome.nickname, "Ada");
    taken.client.close();
    early.close();
    ada.client.close();
  } finally {
    await stop();
  }
});

test("ADR-015 (j): uniqueness is case-insensitive — Nadia, then nadia, gives nadia-2 (join and set_nickname)", async () => {
  const { port, stop } = await startServer();
  try {
    const a = await joinWith(port, { nickname: "Nadia", wallet: true });
    const b = await joinWith(port, { nickname: "nadia", wallet: true });
    assert.equal(b.welcome.nickname, "nadia-2");
    const c = await joinWith(port, { nickname: "Cem", wallet: true });
    c.client.send({ type: "set_nickname", nickname: "NADIA" });
    const update = await c.client.waitFor((m) => m.type === "nickname_updated");
    assert.equal(update.nickname, "NADIA-3");
    for (const client of [a, b, c]) client.client.close();
  } finally {
    await stop();
  }
});

test("ADR-015 (k): the rename, wallet and nickname-check limiters drop requests beyond their burst until tokens refill", async () => {
  let clock = 5_000_000;
  const { port, stop } = await startServer({ now: () => clock, staleTimeoutMs: 10 ** 9 });
  try {
    const holder = await joinWith(port, { nickname: "Ada", wallet: true });
    for (let i = 1; i <= 5; i++) holder.client.send({ type: "set_nickname", nickname: `Ada${i}` });
    await pause();
    assert.equal(holder.client.messages.filter((m) => m.type === "nickname_updated").length, 3, "rename: burst 3");
    clock += 10_000;
    holder.client.send({ type: "set_nickname", nickname: "Ada9" });
    await holder.client.waitFor((m) => m.type === "nickname_updated" && m.nickname === "Ada9");

    const flipper = await joinWith(port, {});
    for (const connected of [true, false, true, false]) flipper.client.send({ type: "set_wallet", connected });
    await pause();
    assert.equal(flipper.client.messages.filter((m) => m.type === "can_receive_updated").length, 2, "wallet: burst 2");
    clock += 60_000;
    flipper.client.send({ type: "set_wallet", connected: true });
    await flipper.client.waitFor(() => flipper.client.messages.filter((m) => m.type === "can_receive_updated").length === 3);

    const checker = createClient(port);
    await checker.waitForOpen();
    for (let i = 0; i < 8; i++) checker.send({ type: "nickname_check", nickname: `Name${i}` });
    await pause();
    assert.equal(checker.messages.filter((m) => m.type === "nickname_check_result").length, 5, "nickname_check: burst 5");
    clock += 1_000;
    checker.send({ type: "nickname_check", nickname: "Again" });
    await checker.waitFor((m) => m.type === "nickname_check_result" && m.nickname === "Again");
    holder.client.close();
    flipper.client.close();
    checker.close();
  } finally {
    await stop();
  }
});
