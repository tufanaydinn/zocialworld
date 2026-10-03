import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { WorldServer, type WorldServerOptions } from "./WorldServer.js";

/**
 * CORE-002 §25 Tests 1-6. Each test spins up a real WorldServer on an
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

test("Test 1: client connects and receives a unique temporary playerId", async () => {
  const { port, stop } = await startServer();
  try {
    const client = createClient(port);
    await client.waitForOpen();
    client.send({ type: "join", nickname: "Alice" });

    const welcome = await client.waitFor((m) => m.type === "welcome");
    assert.equal(typeof welcome.playerId, "string");
    assert.ok((welcome.playerId as string).length > 0);
    assert.equal(welcome.nickname, "Alice");

    client.close();
  } finally {
    await stop();
  }
});

test("Test 2: a second client joining causes the first to receive player_joined", async () => {
  const { port, stop } = await startServer();
  try {
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join", nickname: "A" });
    const aWelcome = await a.waitFor((m) => m.type === "welcome");

    const b = createClient(port);
    await b.waitForOpen();
    b.send({ type: "join", nickname: "B" });

    const joinedEvent = await a.waitFor((m) => m.type === "player_joined");
    assert.equal(joinedEvent.nickname, "B");
    assert.notEqual(joinedEvent.playerId, aWelcome.playerId);

    a.close();
    b.close();
  } finally {
    await stop();
  }
});

test("Test 3: a transform sent by A is relayed to B (and not echoed back to A)", async () => {
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

test("Test 4: disconnecting A causes B to receive player_left", async () => {
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

test("Test 5: invalid transform payloads are rejected without crashing the server", async () => {
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

test("CORE-003 Test 9: the protocol has no block-related message type — a block_player message is silently dropped like any other unknown type", async () => {
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

test("CORE-003 Test 5: two clients joining with the same nickname get a deterministic conflict-safe result", async () => {
  const { port, stop } = await startServer();
  try {
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join", nickname: "Tufan" });
    const aWelcome = await a.waitFor((m) => m.type === "welcome");
    assert.equal(aWelcome.nickname, "Tufan");

    const b = createClient(port);
    await b.waitForOpen();
    b.send({ type: "join", nickname: "Tufan" });
    const bWelcome = await b.waitFor((m) => m.type === "welcome");
    assert.equal(bWelcome.nickname, "Tufan-2");

    const c = createClient(port);
    await c.waitForOpen();
    c.send({ type: "join", nickname: "Tufan" });
    const cWelcome = await c.waitFor((m) => m.type === "welcome");
    assert.equal(cWelcome.nickname, "Tufan-3");

    a.close();
    b.close();
    c.close();
  } finally {
    await stop();
  }
});

test("CORE-003 Test 2/4 (integration): an invalid join nickname falls back to a generated Guest-#### rather than erroring", async () => {
  const { port, stop } = await startServer();
  try {
    const whitespace = createClient(port);
    await whitespace.waitForOpen();
    whitespace.send({ type: "join", nickname: "   " });
    const welcome1 = await whitespace.waitFor((m) => m.type === "welcome");
    assert.match(welcome1.nickname as string, /^Guest-\d{4}$/);

    const controlChar = createClient(port);
    await controlChar.waitForOpen();
    controlChar.send({ type: "join", nickname: "Tu\u0007fan" });
    const welcome2 = await controlChar.waitFor((m) => m.type === "welcome");
    assert.match(welcome2.nickname as string, /^Guest-\d{4}$/);

    whitespace.close();
    controlChar.close();
  } finally {
    await stop();
  }
});

test("CORE-003 Test 6: a nickname change (set_nickname) reaches another connected client via nickname_updated", async () => {
  const { port, stop } = await startServer();
  try {
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join", nickname: "Alice" });
    const aWelcome = await a.waitFor((m) => m.type === "welcome");

    const b = createClient(port);
    await b.waitForOpen();
    b.send({ type: "join", nickname: "Bob" });
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

test("CORE-003: set_nickname resolves a conflict with another connected client's current nickname", async () => {
  const { port, stop } = await startServer();
  try {
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join", nickname: "Alice" });
    await a.waitFor((m) => m.type === "welcome");

    const b = createClient(port);
    await b.waitForOpen();
    b.send({ type: "join", nickname: "Bob" });
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

test("CORE-003: an invalid set_nickname request is dropped and the session keeps its current nickname", async () => {
  const { port, stop } = await startServer();
  try {
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join", nickname: "Alice" });
    await a.waitFor((m) => m.type === "welcome");

    a.send({ type: "set_nickname", nickname: "<script>alert(1)</script>" });

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(!a.messages.some((m) => m.type === "nickname_updated"), "an invalid nickname must not produce a nickname_updated broadcast");

    a.close();
  } finally {
    await stop();
  }
});

// --- Nickname trim/length contract fix (merge-gate revision) --------------
// CORE-003 final revision Tests A, B, C, E: the wire parser must not reject
// based on RAW (untrimmed) nickname length, and conflict-suffix resolution
// must never produce a nickname longer than MAX_NICKNAME_LENGTH.

test("Test A: a raw nickname with surrounding whitespace whose TRIMMED value is exactly max-length is accepted and normalized", async () => {
  const { port, stop } = await startServer();
  try {
    const exactly24 = "a".repeat(24);
    const a = createClient(port);
    await a.waitForOpen();
    // Raw length is 28 (2 leading + 24 + 2 trailing spaces) — over
    // MAX_NICKNAME_LENGTH (24) before trimming, but exactly 24 after.
    a.send({ type: "join", nickname: `  ${exactly24}  ` });

    const welcome = await a.waitFor((m) => m.type === "welcome");
    assert.equal(welcome.nickname, exactly24, "the join must succeed with the trimmed, normalized nickname, not fall back to Guest-####");

    a.close();
  } finally {
    await stop();
  }
});

test("Test B: a nickname whose TRIMMED value exceeds max-length still falls back to Guest-####", async () => {
  const { port, stop } = await startServer();
  try {
    const tooLongAfterTrim = "a".repeat(25); // 25 > MAX_NICKNAME_LENGTH even after trimming
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join", nickname: `  ${tooLongAfterTrim}  ` });

    const welcome = await a.waitFor((m) => m.type === "welcome");
    assert.match(welcome.nickname as string, /^Guest-\d{4}$/);

    a.close();
  } finally {
    await stop();
  }
});

test("Test C: two clients requesting the same exactly-max-length nickname both get a <= max-length, conflict-safe result", async () => {
  const { port, stop } = await startServer();
  try {
    const exactly24 = "a".repeat(24);
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join", nickname: exactly24 });
    const aWelcome = await a.waitFor((m) => m.type === "welcome");
    assert.equal(aWelcome.nickname, exactly24);
    assert.ok((aWelcome.nickname as string).length <= 24);

    const b = createClient(port);
    await b.waitForOpen();
    b.send({ type: "join", nickname: exactly24 });
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

test("Test E: set_nickname with harmless surrounding whitespace is normalized correctly before conflict resolution", async () => {
  const { port, stop } = await startServer();
  try {
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join", nickname: "Alice" });
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

test("Test F: existing control-character / markup rejection still holds at join (unaffected by the trim-order fix)", async () => {
  const { port, stop } = await startServer();
  try {
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join", nickname: "<script>alert(1)</script>" });

    const welcome = await a.waitFor((m) => m.type === "welcome");
    assert.match(welcome.nickname as string, /^Guest-\d{4}$/, "a markup-shaped nickname must still fall back to Guest-####, never be accepted as-is");

    a.close();
  } finally {
    await stop();
  }
});

test("Test 6: a stale connection (no messages) is cleaned up and others are notified", async () => {
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
// CORE-004 security revision ():
// voice capability issuance/resolution/invalidation, replacing the original
// (vulnerable) client-supplied-playerId trust model. See
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

test("Test A: a valid current-session capability resolves to that session's own playerId and nickname", async () => {
  const { port, world, stop } = await startServer();
  try {
    const client = createClient(port);
    await client.waitForOpen();
    client.send({ type: "join", nickname: "Builder" });
    const welcome = await client.waitFor((m) => m.type === "welcome");

    const resolved = world.resolveVoiceSession(welcome.voiceCapability as string);
    assert.deepEqual(resolved, { playerId: welcome.playerId, nickname: "Builder" });
    client.close();
  } finally {
    await stop();
  }
});

test("Test B: an unknown/random capability is rejected (resolves to null)", async () => {
  const { port, world, stop } = await startServer();
  try {
    assert.equal(world.resolveVoiceSession("completely-made-up-value"), null);
    assert.equal(world.resolveVoiceSession(""), null);
  } finally {
    await stop();
  }
});

test("Test C: player A's capability cannot resolve to player B's identity, and vice versa", async () => {
  const { port, world, stop } = await startServer();
  try {
    const a = createClient(port);
    await a.waitForOpen();
    a.send({ type: "join", nickname: "Alice" });
    const aWelcome = await a.waitFor((m) => m.type === "welcome");

    const b = createClient(port);
    await b.waitForOpen();
    b.send({ type: "join", nickname: "Bob" });
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

test("Test F: after set_nickname, the capability resolves to the CURRENT server-authoritative nickname, not the stale join-time one", async () => {
  const { port, world, stop } = await startServer();
  try {
    const client = createClient(port);
    await client.waitForOpen();
    client.send({ type: "join", nickname: "OldName" });
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

test("Test G: after disconnect, that session's capability no longer resolves", async () => {
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

test("Test H: after stale-session cleanup, that capability no longer resolves", async () => {
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

test("Test I: a reconnect receives a different capability, and the previous session's capability stays invalid", async () => {
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
    // (CORE-002's existing identity model has no session resumption) —
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
