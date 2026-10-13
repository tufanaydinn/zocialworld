import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { MAX_CHAT_LENGTH, NEARBY_CHAT_RADIUS_METERS } from "@project/shared";
import { WorldServer } from "./WorldServer.js";
import { CHAT_BURST, ChatRateLimiter, sanitizeChatText } from "./chat.js";

/** Text chat: sanitizing, rate limit, general/nearby/whisper delivery (real sockets, like WorldServer.test.ts). */

type Msg = Record<string, unknown>;

async function setup(): Promise<{ port: number; stop: () => Promise<void> }> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const world = new WorldServer(wss);
  return { port, stop: () => new Promise<void>((resolve) => (world.dispose(), wss.close(() => resolve()))) };
}

async function join(port: number, nickname: string, pose = { x: 0, y: 0, z: 0 }) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: Msg[] = [];
  socket.addEventListener("message", (event) => messages.push(JSON.parse(event.data as string) as Msg));
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  const send = (message: Msg) => socket.send(JSON.stringify(message));
  const waitFor = async (predicate: (m: Msg) => boolean, timeoutMs = 2000): Promise<Msg> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("timed out");
  };
  send({ type: "join", nickname, wallet: true }); // ADR-015: a wallet holder, so the chosen name is kept
  const welcome = await waitFor((m) => m.type === "welcome");
  send({ type: "player_transform", ...pose, rotationY: 0, animationState: "idle", seq: 1 });
  return { socket, messages, send, waitFor, playerId: welcome.playerId as string, close: () => socket.close() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

test("sanitizeChatText trims, collapses whitespace, strips controls/bidi/zero-width and enforces the length cap", () => {
  assert.equal(sanitizeChatText("  hello \n\t world  "), "hello world");
  assert.equal(sanitizeChatText("a‮b​c\u0007d"), "a b c d");
  assert.equal(sanitizeChatText("   ​  "), null);
  assert.equal(sanitizeChatText("x".repeat(MAX_CHAT_LENGTH)), "x".repeat(MAX_CHAT_LENGTH));
  assert.equal(sanitizeChatText("x".repeat(MAX_CHAT_LENGTH + 1)), "too_long");
  assert.equal(sanitizeChatText("<script>alert(1)</script>"), "<script>alert(1)</script>", "markup is kept as text — clients render with textContent");
});

test("chat rate limiter allows a burst, then refills over time", () => {
  let clock = 0;
  const limiter = new ChatRateLimiter(() => clock);
  for (let i = 0; i < CHAT_BURST; i++) assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), false);
  clock += 2000;
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), false);
});

test("general chat reaches everyone, including the sender's own echo", async () => {
  const { port, stop } = await setup();
  try {
    const a = await join(port, "Ada");
    const b = await join(port, "Bob", { x: 500, y: 0, z: 0 });
    a.send({ type: "chat_send", channel: "general", text: "  hi   all " });
    const atB = await b.waitFor((m) => m.type === "chat_message");
    const atA = await a.waitFor((m) => m.type === "chat_message");
    assert.equal(atB.text, "hi all");
    assert.equal(atB.fromNickname, "Ada");
    assert.equal(atB.channel, "general");
    assert.equal(atA.messageId, atB.messageId);
    a.close();
    b.close();
  } finally {
    await stop();
  }
});

test("nearby chat only reaches players within the radius (the Learning Valley at x=1000 is out of range)", async () => {
  const { port, stop } = await setup();
  try {
    const a = await join(port, "Ada");
    const near = await join(port, "Near", { x: NEARBY_CHAT_RADIUS_METERS - 2, y: 0, z: 0 });
    const far = await join(port, "Far", { x: 1000, y: 0, z: 0 });
    await settle();
    a.send({ type: "chat_send", channel: "nearby", text: "psst" });
    await near.waitFor((m) => m.type === "chat_message" && m.text === "psst");
    await settle();
    assert.equal(far.messages.filter((m) => m.type === "chat_message").length, 0);
    for (const c of [a, near, far]) c.close();
  } finally {
    await stop();
  }
});

test("whispers reach only the recipient (plus the sender's echo); unknown recipients and self are rejected", async () => {
  const { port, stop } = await setup();
  try {
    const a = await join(port, "Ada");
    const b = await join(port, "Bob");
    const c = await join(port, "Cem");
    a.send({ type: "whisper_send", to: b.playerId, text: "secret" });
    const atB = await b.waitFor((m) => m.type === "chat_message");
    assert.equal(atB.channel, "whisper");
    assert.equal(atB.toNickname, "Bob");
    await a.waitFor((m) => m.type === "chat_message" && m.channel === "whisper");
    await settle();
    assert.equal(c.messages.filter((m) => m.type === "chat_message").length, 0, "third player never sees the whisper");

    a.send({ type: "whisper_send", to: "nobody", text: "x" });
    await a.waitFor((m) => m.type === "chat_rejected" && m.reason === "unknown_recipient");
    a.send({ type: "whisper_send", to: a.playerId, text: "x" });
    await a.waitFor((m) => m.type === "chat_rejected" && m.reason === "self");
    for (const s of [a, b, c]) s.close();
  } finally {
    await stop();
  }
});

test("flooding is rejected with rate_limited, empty and over-long lines are rejected", async () => {
  const { port, stop } = await setup();
  try {
    const a = await join(port, "Ada");
    for (let i = 0; i < CHAT_BURST + 3; i++) a.send({ type: "chat_send", channel: "general", text: `m${i}` });
    await a.waitFor((m) => m.type === "chat_rejected" && m.reason === "rate_limited");
    await settle();
    assert.equal(a.messages.filter((m) => m.type === "chat_message").length, CHAT_BURST);

    const b = await join(port, "Bob");
    b.send({ type: "chat_send", channel: "general", text: "   " });
    await b.waitFor((m) => m.type === "chat_rejected" && m.reason === "empty");
    b.send({ type: "chat_send", channel: "general", text: "y".repeat(MAX_CHAT_LENGTH + 5) });
    await b.waitFor((m) => m.type === "chat_rejected" && m.reason === "too_long");
    b.send({ type: "chat_send", channel: "shout", text: "bad channel" });
    await settle();
    assert.equal(b.messages.filter((m) => m.type === "chat_rejected").length, 2, "unknown channel is dropped silently");
    a.close();
    b.close();
  } finally {
    await stop();
  }
});
