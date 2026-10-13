import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { WorldServer } from "./WorldServer.js";
import { PaymentRelay, PAY_REQUEST_TTL_MS } from "./payments.js";

/** ADR-013 — the payment relay forwards sealed handshakes only within a request it relayed. */

type Msg = Record<string, unknown>;

test("relay rules: answers go back to the sender, notices only after acceptance, nothing unsolicited", () => {
  let clock = 0;
  const relay = new PaymentRelay(() => clock);
  assert.deepEqual(relay.request("req-00001", "A", "B"), { ok: true, target: "B" });
  assert.deepEqual(relay.answer("req-00001", "C", true), { ok: false, reason: "unknown_request" }, "a third player can't answer");
  assert.deepEqual(relay.notice("req-00001", "A"), { ok: false, reason: "unknown_request" }, "no notice before acceptance");
  assert.deepEqual(relay.answer("req-00001", "B", true), { ok: true, target: "A" });
  assert.deepEqual(relay.answer("req-00001", "B", true), { ok: false, reason: "unknown_request" }, "answer only once");
  assert.deepEqual(relay.notice("req-00001", "B"), { ok: false, reason: "unknown_request" }, "only the sender sends the notice");
  assert.deepEqual(relay.notice("req-00001", "A"), { ok: true, target: "B" });
  assert.equal(relay.size, 0);
  assert.deepEqual(relay.answer("never-seen", "B", true), { ok: false, reason: "unknown_request" });

  relay.request("req-00002", "A", "B");
  clock += PAY_REQUEST_TTL_MS + 1;
  assert.deepEqual(relay.answer("req-00002", "B", true), { ok: false, reason: "unknown_request" }, "expired");
});

test("relay rate-limits new requests per sender and forgets a player who left", () => {
  let clock = 0;
  const relay = new PaymentRelay(() => clock);
  for (let i = 0; i < 3; i++) assert.equal(relay.request(`burst-00${i}x`, "A", "B").ok, true);
  assert.deepEqual(relay.request("burst-004x", "A", "B"), { ok: false, reason: "rate_limited" });
  clock += 10_000;
  assert.equal(relay.request("burst-005x", "A", "B").ok, true);
  relay.forget("B");
  assert.equal(relay.size, 0);
});

test("only the sender cancels (before or after acceptance); forget() returns what it dropped", () => {
  let clock = 0;
  const relay = new PaymentRelay(() => clock);
  relay.request("req-cncl-01", "A", "B");
  assert.deepEqual(relay.cancel("req-cncl-01", "B"), { ok: false, reason: "unknown_request" }, "the recipient cannot cancel");
  assert.deepEqual(relay.cancel("req-cncl-01", "A"), { ok: true, target: "B" });
  assert.deepEqual(relay.answer("req-cncl-01", "B", true), { ok: false, reason: "unknown_request" }, "a late acceptance goes nowhere");
  relay.request("req-cncl-02", "A", "B");
  relay.answer("req-cncl-02", "B", true);
  assert.deepEqual(relay.cancel("req-cncl-02", "A"), { ok: true, target: "B" }, "after the acceptance too");
  assert.deepEqual(relay.notice("req-cncl-02", "A"), { ok: false, reason: "unknown_request" }, "closed");
  clock += 20_000;
  relay.request("req-forg-01", "A", "B");
  relay.request("req-forg-02", "C", "A");
  relay.request("req-forg-03", "C", "B");
  assert.deepEqual(relay.forget("A").map((p) => p.requestId).sort(), ["req-forg-01", "req-forg-02"]);
  assert.equal(relay.size, 1);
});

type Client = { socket: WebSocket; messages: Msg[]; send: (m: Msg) => void; id: string };

/** A real WorldServer on an ephemeral port; `join(name, wallet)` connects a client (a wallet holder unless `wallet` is false). */
async function payWorld(): Promise<{ join: (nickname: string, wallet?: boolean) => Promise<Client>; stop: () => Promise<void> }> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const port = (wss.address() as { port: number }).port;
  const world = new WorldServer(wss);
  const clients: Client[] = [];
  const join = async (nickname: string, wallet = true) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages: Msg[] = [];
    socket.addEventListener("message", (e) => messages.push(JSON.parse(e.data as string) as Msg));
    await new Promise((r) => socket.addEventListener("open", r, { once: true }));
    socket.send(JSON.stringify({ type: "join", nickname, wallet }));
    while (!messages.find((m) => m.type === "welcome")) await new Promise((r) => setTimeout(r, 10));
    const client = { socket, messages, send: (m: Msg) => socket.send(JSON.stringify(m)), id: messages.find((m) => m.type === "welcome")!.playerId as string };
    clients.push(client);
    return client;
  };
  const stop = async () => {
    for (const c of clients) c.socket.close();
    world.dispose();
    await new Promise<void>((r) => wss.close(() => r()));
  };
  return { join, stop };
}

async function waitForType(c: { messages: Msg[] }, type: string): Promise<Msg> {
  for (let i = 0; i < 200; i++) {
    const found = c.messages.find((m) => m.type === type);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no ${type}`);
}

const settle = () => new Promise((r) => setTimeout(r, 150));

test("ADR-015: a request to a guest is refused with no_wallet — nothing is relayed and the sender's rate bucket is untouched", async () => {
  const { join, stop } = await payWorld();
  try {
    const ada = await join("Ada");
    const guest = await join("ignored", false);
    const bob = await join("Bob");
    ada.send({ type: "pay_request", to: guest.id, requestId: "req-guest-01", senderKey: "QUJDRA==" });
    assert.equal((await waitForType(ada, "pay_error")).reason, "no_wallet");
    await settle();
    assert.equal(guest.messages.filter((m) => String(m.type).startsWith("pay_")).length, 0, "the guest never sees the request");
    // The burst is 3: three requests to a holder still go through, so the refused one spent no token.
    for (let i = 1; i <= 3; i++) ada.send({ type: "pay_request", to: bob.id, requestId: `req-holder-0${i}`, senderKey: "QUJDRA==" });
    await settle();
    assert.equal(bob.messages.filter((m) => m.type === "pay_request").length, 3);
    assert.equal(ada.messages.filter((m) => m.type === "pay_error").length, 1, "only the guest request was refused");
  } finally {
    await stop();
  }
});

test("ADR-015: a guest cannot send — sender_no_wallet, and the holder never sees the request", async () => {
  const { join, stop } = await payWorld();
  try {
    const guest = await join("ignored", false);
    const bob = await join("Bob");
    guest.send({ type: "pay_request", to: bob.id, requestId: "req-from-guest", senderKey: "QUJDRA==" });
    assert.equal((await waitForType(guest, "pay_error")).reason, "sender_no_wallet");
    await settle();
    assert.equal(bob.messages.filter((m) => m.type === "pay_request").length, 0);
  } finally {
    await stop();
  }
});

test("ADR-015: after set_wallet true a former guest can be paid; after set_wallet false it cannot", async () => {
  const { join, stop } = await payWorld();
  try {
    const ada = await join("Ada");
    const cem = await join("ignored", false);
    cem.send({ type: "set_wallet", connected: true });
    await waitForType(ada, "can_receive_updated");
    ada.send({ type: "pay_request", to: cem.id, requestId: "req-after-wallet", senderKey: "QUJDRA==" });
    assert.equal((await waitForType(cem, "pay_request")).from, ada.id);
    cem.send({ type: "set_wallet", connected: false });
    await settle();
    ada.send({ type: "pay_request", to: cem.id, requestId: "req-after-forget", senderKey: "QUJDRA==" });
    assert.equal((await waitForType(ada, "pay_error")).reason, "no_wallet");
  } finally {
    await stop();
  }
});

test("over the wire: request → accept → notice between two clients; a third sees nothing; bad shapes are dropped", async () => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const port = (wss.address() as { port: number }).port;
  const world = new WorldServer(wss);
  const clients: { socket: WebSocket; messages: Msg[]; send: (m: Msg) => void; id: string }[] = [];
  const join = async (nickname: string, wallet = true) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages: Msg[] = [];
    socket.addEventListener("message", (e) => messages.push(JSON.parse(e.data as string) as Msg));
    await new Promise((r) => socket.addEventListener("open", r, { once: true }));
    socket.send(JSON.stringify({ type: "join", nickname, wallet })); // ADR-015: payments travel between wallet holders only
    while (!messages.find((m) => m.type === "welcome")) await new Promise((r) => setTimeout(r, 10));
    const client = { socket, messages, send: (m: Msg) => socket.send(JSON.stringify(m)), id: messages.find((m) => m.type === "welcome")!.playerId as string };
    clients.push(client);
    return client;
  };
  const waitFor = async (c: { messages: Msg[] }, type: string) => {
    for (let i = 0; i < 200; i++) {
      const found = c.messages.find((m) => m.type === type);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no ${type}`);
  };
  try {
    const ada = await join("Ada");
    const bob = await join("Bob");
    const cem = await join("Cem");
    ada.send({ type: "pay_request", to: bob.id, requestId: "req-wire-01", senderKey: "QUJDRA==" });
    const req = await waitFor(bob, "pay_request");
    assert.equal(req.from, ada.id);
    assert.equal(req.fromNickname, "Ada");
    bob.send({ type: "pay_accept", requestId: "req-wire-01", recipientKey: "RUZHSA==", sealed: "c2VhbGVk", iv: "aXY=" });
    const accept = await waitFor(ada, "pay_accept");
    assert.equal(accept.sealed, "c2VhbGVk");
    ada.send({ type: "pay_notice", requestId: "req-wire-01", sealed: "bm90aWNl", iv: "aXY=" });
    assert.equal((await waitFor(bob, "pay_notice")).sealed, "bm90aWNl");

    cem.send({ type: "pay_accept", requestId: "req-wire-01", recipientKey: "RUZHSA==", sealed: "eA==", iv: "aXY=" });
    assert.equal((await waitFor(cem, "pay_error")).reason, "unknown_request");
    ada.send({ type: "pay_request", to: ada.id, requestId: "req-wire-02", senderKey: "QQ==" });
    assert.equal((await waitFor(ada, "pay_error")).reason, "self");
    ada.send({ type: "pay_request", to: bob.id, requestId: "x", senderKey: "QQ==" }); // bad request id → dropped silently
    ada.send({ type: "pay_request", to: bob.id, requestId: "req-wire-03", senderKey: "<script>" }); // not base64 → dropped
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(bob.messages.filter((m) => m.type === "pay_request").length, 1);
    assert.equal(cem.messages.filter((m) => String(m.type).startsWith("pay_") && m.type !== "pay_error").length, 0, "the third player never sees the payment");
  } finally {
    for (const c of clients) c.socket.close();
    world.dispose();
    await new Promise<void>((r) => wss.close(() => r()));
  }
});
