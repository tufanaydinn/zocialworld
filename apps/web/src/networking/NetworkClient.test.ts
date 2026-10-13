import { test } from "node:test";
import assert from "node:assert/strict";
import type { HallServerMessage } from "@project/shared";
import { NetworkClient, type PublishedPose } from "./NetworkClient.ts";

// Unchanged poses are not re-sent (heartbeats prove liveness), hall messages reach
// onHall, and sendHall puts a typed hall request on the wire. Runs against a fake WebSocket.

type Listener = (event: { data?: unknown }) => void;

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  readonly sent: Record<string, unknown>[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor() {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.fire("close", {});
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.fire("open", {});
  }

  receive(message: unknown): void {
    this.fire("message", { data: JSON.stringify(message) });
  }

  transforms(): Record<string, unknown>[] {
    return this.sent.filter((message) => message.type === "player_transform");
  }

  private fire(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function withFakeSocket(run: () => void): void {
  const original = globalThis.WebSocket;
  FakeSocket.instances = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  try {
    run();
  } finally {
    globalThis.WebSocket = original;
  }
}

const POSE: PublishedPose = { x: -1000, y: 0.4, z: -2.1, rotationY: 1.25, animationState: "sit" };

test("sendTransform skips a pose identical to the last one sent, sends any change, and always sends the first after (re)connecting", () => {
  withFakeSocket(() => {
    const client = new NetworkClient("ws://test", {});
    client.connect();
    client.join({ wallet: false });
    const first = FakeSocket.instances[0]!;
    assert.equal(client.sendTransform(POSE, 1), false, "nothing is sent (or remembered) before the socket opens");
    first.open();
    assert.deepEqual(first.sent[0], { type: "join", wallet: false });

    assert.equal(client.sendTransform(POSE, 2), true);
    assert.equal(client.sendTransform({ ...POSE }, 3), false, "unchanged: skipped");
    assert.equal(client.sendTransform({ ...POSE }, 4), false);
    assert.equal(client.sendTransform({ ...POSE, rotationY: 1.3 }, 5), true, "a turn is a change");
    assert.equal(client.sendTransform({ ...POSE, rotationY: 1.3, animationState: "walk" }, 6), true, "standing up (walk) is sent at once");
    assert.equal(client.sendTransform({ ...POSE, rotationY: 1.3, animationState: "walk", y: 0.5 }, 7), true);
    assert.deepEqual(
      first.transforms().map((message) => message.seq),
      [2, 5, 6, 7],
    );
    assert.deepEqual(first.transforms()[0], { type: "player_transform", ...POSE, seq: 2 });

    // A reconnect is a new session that starts at the server's origin pose: the same pose is sent again.
    client.disconnect();
    client.connect();
    const second = FakeSocket.instances[1]!;
    second.open();
    assert.equal(client.sendTransform({ ...POSE, rotationY: 1.3, animationState: "walk", y: 0.5 }, 8), true);
    assert.equal(second.transforms().length, 1);
    client.disconnect();
  });
});

test("hall messages are parsed and handed to onHall; malformed ones are dropped; sendHall sends the typed request", () => {
  withFakeSocket(() => {
    const received: HallServerMessage[] = [];
    const client = new NetworkClient("ws://test", { onHall: (message) => received.push(message) });
    client.connect();
    client.join({ wallet: true });
    const socket = FakeSocket.instances[0]!;
    socket.open();
    socket.receive({ type: "hall_seat", seatId: 4, playerId: "p1" });
    socket.receive({ type: "hall_seat", seatId: 400, playerId: "p1" });
    socket.receive({ type: "hall_exit" });
    socket.receive({ type: "hall_error", op: "host", reason: "bad_key" });
    assert.deepEqual(received, [
      { type: "hall_seat", seatId: 4, playerId: "p1" },
      { type: "hall_exit" },
      { type: "hall_error", op: "host", reason: "bad_key" },
    ]);

    client.sendHall({ type: "hall_seat_claim", seatId: 4 });
    client.sendHall({ type: "hall_react", reaction: "zec" });
    assert.deepEqual(socket.sent.slice(1), [
      { type: "hall_seat_claim", seatId: 4 },
      { type: "hall_react", reaction: "zec" },
    ]);
    client.disconnect();
  });
});

// ADR-015: the join waits for onboarding; a reconnect rejoins as the same identity.
const WELCOME = (playerId: string, nickname: string) => ({ type: "welcome", playerId, nickname, colorSeed: 7, avatar: { model: "mage", color: 2 }, canReceive: true, tickRateHz: 10, voiceCapability: "cap" });

test("ADR-015: connect() opens the socket but sends no join until join(); join() before the socket opens is sent on open", () => {
  withFakeSocket(() => {
    const client = new NetworkClient("ws://test", {});
    client.connect();
    const socket = FakeSocket.instances[0]!;
    socket.open();
    assert.equal(client.connectionState, "connected");
    assert.equal(socket.sent.filter((m) => m.type === "join").length, 0, "no join while onboarding is open");
    assert.equal(client.sendTransform(POSE, 1), false, "no transforms before the join either");
    client.join({ wallet: true, avatar: { model: "knight", color: 3 } });
    assert.deepEqual(socket.sent.find((m) => m.type === "join"), { type: "join", avatar: { model: "knight", color: 3 }, wallet: true });
    client.join({ wallet: true }); // a second call sends nothing more (one join per socket)
    assert.equal(socket.sent.filter((m) => m.type === "join").length, 1);
    client.disconnect();

    const late = new NetworkClient("ws://test", {});
    late.connect();
    late.join({ wallet: false });
    const lateSocket = FakeSocket.instances[1]!;
    assert.equal(lateSocket.sent.length, 0, "nothing goes out before the socket opens");
    lateSocket.open();
    assert.deepEqual(lateSocket.sent[0], { type: "join", wallet: false });
    late.disconnect();
  });
});

test("ADR-015: a rejoin after a reconnect carries the wallet flag, the avatar and the last accepted name", async () => {
  const original = globalThis.WebSocket;
  const originalRandom = Math.random;
  FakeSocket.instances = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  Math.random = () => 0; // the shortest reconnect backoff
  const client = new NetworkClient("ws://test", {});
  try {
    client.connect();
    client.join({ wallet: false });
    const first = FakeSocket.instances[0]!;
    first.open();
    first.receive(WELCOME("p1", "Guest-4321"));
    assert.equal(client.joined, true);
    client.sendWallet(true); // the wallet reached ready: sent at once…
    assert.deepEqual(first.sent.at(-1), { type: "set_wallet", connected: true });
    client.sendAvatar({ model: "rogue", color: 6 });
    assert.deepEqual(first.sent.at(-1), { type: "set_avatar", avatar: { model: "rogue", color: 6 } });
    first.receive({ type: "nickname_updated", playerId: "p1", nickname: "Alice" });
    first.close(); // an unexpected drop → reconnect
    assert.equal(client.joined, false);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const second = FakeSocket.instances[1];
    assert.ok(second, "reconnected");
    second.open();
    assert.deepEqual(second.sent[0], { type: "join", nickname: "Alice", avatar: { model: "rogue", color: 6 }, wallet: true }, "…and remembered for the rejoin");
  } finally {
    client.disconnect();
    globalThis.WebSocket = original;
    Math.random = originalRandom;
  }
});

test("ADR-015: checkNickname works before join; sendWallet/sendAvatar before join only update what the join will carry", () => {
  withFakeSocket(() => {
    const results: unknown[] = [];
    const client = new NetworkClient("ws://test", { onNicknameCheckResult: (message) => results.push(message) });
    client.connect();
    const socket = FakeSocket.instances[0]!;
    socket.open();
    client.checkNickname("Alice");
    assert.deepEqual(socket.sent, [{ type: "nickname_check", nickname: "Alice" }]);
    socket.receive({ type: "nickname_check_result", nickname: "Alice", status: "taken", suggestion: "Alice-2" });
    assert.deepEqual(results, [{ type: "nickname_check_result", nickname: "Alice", status: "taken", suggestion: "Alice-2" }]);
    client.disconnect();

    const early = new NetworkClient("ws://test", {});
    early.connect();
    early.join({ wallet: false });
    early.sendWallet(true); // flipped while the socket was still opening
    early.sendAvatar({ model: "barbarian", color: 1 });
    const earlySocket = FakeSocket.instances[1]!;
    earlySocket.open();
    assert.deepEqual(earlySocket.sent, [{ type: "join", avatar: { model: "barbarian", color: 1 }, wallet: true }], "no set_wallet / set_avatar before the join — the join carries them");
    early.disconnect();
  });
});

test("ADR-015: avatar_updated and can_receive_updated reach their handlers", () => {
  withFakeSocket(() => {
    const seen: string[] = [];
    const client = new NetworkClient("ws://test", {
      onAvatarUpdated: (message) => seen.push(`avatar:${message.playerId}:${message.avatar.model}`),
      onCanReceiveUpdated: (message) => seen.push(`receive:${message.playerId}:${message.canReceive}`),
    });
    client.connect();
    client.join({ wallet: true });
    const socket = FakeSocket.instances[0]!;
    socket.open();
    socket.receive({ type: "avatar_updated", playerId: "p9", avatar: { model: "knight", color: 1 } });
    socket.receive({ type: "can_receive_updated", playerId: "p9", canReceive: false });
    socket.receive({ type: "can_receive_updated", playerId: "p9", canReceive: "no" });
    assert.deepEqual(seen, ["avatar:p9:knight", "receive:p9:false"]);
    client.disconnect();
  });
});
