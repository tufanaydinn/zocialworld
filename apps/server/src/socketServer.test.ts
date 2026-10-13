import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MAX_MESSAGE_BYTES } from "./protocol.js";
import { WorldServer } from "./WorldServer.js";
import { createGameSocketServer, WS_MAX_PAYLOAD_BYTES } from "./socketServer.js";

/**
 * The frame-size cap of the real gameplay socket server (index.ts builds it with
 * createGameSocketServer). Driven with Node's built-in WebSocket client against a real
 * WorldServer, like WorldServer.test.ts.
 */

type Message = Record<string, unknown>;

interface Client {
  socket: WebSocket;
  messages: Message[];
  waitFor: (predicate: (m: Message) => boolean, timeoutMs?: number) => Promise<Message>;
  closed: Promise<{ code: number }>;
  send: (message: Message) => void;
}

async function connect(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: Message[] = [];
  const waiters: { predicate: (m: Message) => boolean; resolve: (m: Message) => void }[] = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data as string) as Message;
    messages.push(message);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.predicate(message)) {
        waiters[i]!.resolve(message);
        waiters.splice(i, 1);
      }
    }
  });
  const closed = new Promise<{ code: number }>((resolve) => socket.addEventListener("close", (event) => resolve({ code: event.code }), { once: true }));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("socket error before open")), { once: true });
  });
  return {
    socket,
    messages,
    closed,
    send: (message) => socket.send(JSON.stringify(message)),
    waitFor: (predicate, timeoutMs = 2000) => {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
        waiters.push({ predicate, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      });
    },
  };
}

async function join(client: Client): Promise<string> {
  client.send({ type: "join" });
  const welcome = await client.waitFor((m) => m.type === "welcome");
  return welcome.playerId as string;
}

function within<T>(promise: Promise<T>, timeoutMs = 2000): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), timeoutMs).unref())]);
}

function transform(seq: number, extra: Message = {}): Message {
  return { type: "player_transform", x: seq, y: 0, z: 0, rotationY: 0, animationState: "idle", seq, ...extra };
}

test("the cap sits above the protocol's own frame limit", () => {
  assert.equal(WS_MAX_PAYLOAD_BYTES, 4096);
  assert.ok(WS_MAX_PAYLOAD_BYTES >= 2 * MAX_MESSAGE_BYTES, "a legitimate frame never reaches the socket cap");
});

test("a frame over WS_MAX_PAYLOAD_BYTES closes that connection with 1009; others and the server carry on", async () => {
  const httpServer = createServer();
  const wss = createGameSocketServer(httpServer, []);
  const world = new WorldServer(wss);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;
  const clients: Client[] = [];
  try {
    const watcher = await connect(port);
    const sender = await connect(port);
    clients.push(watcher, sender);
    await join(watcher);
    const senderId = await join(sender);

    // Over the protocol limit but under the socket cap: dropped silently, the connection stays open.
    const padded = JSON.stringify(transform(1, { pad: "x".repeat(MAX_MESSAGE_BYTES + 500) }));
    assert.ok(padded.length > MAX_MESSAGE_BYTES && padded.length < WS_MAX_PAYLOAD_BYTES);
    sender.socket.send(padded);
    sender.send(transform(2));
    const relayed = await watcher.waitFor((m) => m.type === "player_transform" && m.playerId === senderId);
    assert.equal(relayed.seq, 2, "the padded frame was dropped, the next one relayed");
    assert.equal(sender.socket.readyState, WebSocket.OPEN);

    // Over the socket cap: ws refuses the frame and closes with 1009 (Message Too Big).
    sender.socket.send("x".repeat(WS_MAX_PAYLOAD_BYTES + 1));
    assert.equal((await within(sender.closed)).code, 1009);
    await watcher.waitFor((m) => m.type === "player_left" && m.playerId === senderId);

    // The server is still up and accepting players.
    const late = await connect(port);
    clients.push(late);
    assert.equal(typeof (await join(late)), "string");
    assert.equal(world.playerCount, 2);
  } finally {
    for (const client of clients) client.socket.close();
    world.dispose();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});
