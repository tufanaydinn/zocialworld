import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { PAY_FEE_DEADLINE_MS, buildPayFeeMemo, type PayFeeQuote } from "@project/shared";
import { WorldServer } from "./WorldServer.js";
import { TransferFees } from "./transferFees.js";
import type { ReadResult } from "./zcash/shieldedPayments.js";
import { createVersionHandler, resolveBuildId } from "./buildInfo.js";
import { createFaucetHandler } from "./zcash/faucet.js";
import { parseIncomingMessage } from "./protocol.js";

/**
 * The mainnet payment rules (ADR-018 § 4, § 6, § 7) through a real WorldServer: the payment cap on relayed requests, the transfer-fee
 * quote the relay adds for the sender, `pay_sent` and the `fee_unpaid` sanction, the welcome's build id; plus
 * GET /version, the faucet's refusal on main and the parser's new messages.
 */

type Msg = Record<string, unknown>;
type Client = { messages: Msg[]; send: (m: Msg) => void; id: string; close: () => void };

async function world(options: ConstructorParameters<typeof WorldServer>[1]) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const port = (wss.address() as { port: number }).port;
  const server = new WorldServer(wss, options);
  const clients: Client[] = [];
  const join = async (nickname: string): Promise<Client> => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages: Msg[] = [];
    socket.addEventListener("message", (e) => messages.push(JSON.parse(e.data as string) as Msg));
    await new Promise((r) => socket.addEventListener("open", r, { once: true }));
    socket.send(JSON.stringify({ type: "join", nickname, wallet: true }));
    while (!messages.find((m) => m.type === "welcome")) await new Promise((r) => setTimeout(r, 10));
    const client = { messages, send: (m: Msg) => socket.send(JSON.stringify(m)), id: messages.find((m) => m.type === "welcome")!.playerId as string, close: () => socket.close() };
    clients.push(client);
    return client;
  };
  const stop = async () => {
    for (const c of clients) c.close();
    server.dispose();
    await new Promise<void>((r) => wss.close(() => r()));
  };
  return { join, stop };
}

async function waitFor(c: Client, predicate: (m: Msg) => boolean): Promise<Msg> {
  for (let i = 0; i < 300; i++) {
    const found = c.messages.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
}
const settle = () => new Promise((r) => setTimeout(r, 120));
const KEY = "QUJDRA==";
const SEALED = { sealed: "c2VhbGVk", iv: "aXZpdml2aXZpdml2" };

test("ADR-018 § 4: with a cap, a request without capZat or above it is refused with over_cap; at the cap it is relayed (without capZat)", async () => {
  const { join, stop } = await world({ paymentCapZat: 1_000_000 });
  try {
    const alice = await join("Alice");
    const bob = await join("Bob");
    alice.send({ type: "pay_request", to: bob.id, requestId: "req-cap-001", senderKey: KEY });
    assert.equal((await waitFor(alice, (m) => m.type === "pay_error")).reason, "over_cap");
    alice.send({ type: "pay_request", to: bob.id, requestId: "req-cap-002", senderKey: KEY, capZat: 1_000_001 });
    await waitFor(alice, (m) => m.type === "pay_error" && m.requestId === "req-cap-002" && m.reason === "over_cap");
    alice.send({ type: "pay_request", to: bob.id, requestId: "req-cap-003", senderKey: KEY, capZat: 1_000_000 });
    const relayed = await waitFor(bob, (m) => m.type === "pay_request");
    assert.equal(relayed.requestId, "req-cap-003");
    assert.equal("capZat" in relayed, false, "the recipient never sees the sender's cap");
    await settle();
    assert.equal(bob.messages.filter((m) => m.type === "pay_request").length, 1, "nothing of the refused requests reached Bob");
  } finally {
    await stop();
  }
});

test("without a cap (test chain), requests are relayed with or without capZat — unchanged", async () => {
  const { join, stop } = await world({});
  try {
    const alice = await join("Alice");
    const bob = await join("Bob");
    alice.send({ type: "pay_request", to: bob.id, requestId: "req-free-01", senderKey: KEY });
    await waitFor(bob, (m) => m.type === "pay_request");
  } finally {
    await stop();
  }
});

/** A fee ledger whose reader answers from a map (txid → result). */
function feeLedger(results: Map<string, ReadResult>, now: () => number) {
  return new TransferFees({
    config: { feeZat: 75_000, address: "zs1projectfee", ufvk: "uview1projectfee", minConfirmations: 1 },
    reader: { read: async (txid) => results.get(txid) ?? { status: "missing" } },
    now,
    pollMs: 3_600_000,
  });
}

test("ADR-018 § 6: the acceptance relayed to the SENDER carries the server's fee quote; pay_sent with the fee settles it", async () => {
  const results = new Map<string, ReadResult>();
  const fees = feeLedger(results, Date.now);
  const { join, stop } = await world({ transferFees: fees });
  try {
    const alice = await join("Alice");
    const bob = await join("Bob");
    alice.send({ type: "pay_request", to: bob.id, requestId: "req-fee-001", senderKey: KEY });
    await waitFor(bob, (m) => m.type === "pay_request");
    // Bob's acceptance must not be able to carry a fee of its own: the server ignores unknown fields and adds its own.
    bob.send({ type: "pay_accept", requestId: "req-fee-001", recipientKey: KEY, ...SEALED, fee: { address: "zs1evil", zat: 1, nonce: "00".repeat(16) } });
    const accept = await waitFor(alice, (m) => m.type === "pay_accept");
    const fee = accept.fee as PayFeeQuote;
    assert.equal(fee.address, "zs1projectfee");
    assert.equal(fee.zat, 75_000);
    assert.match(fee.nonce, /^[0-9a-f]{32}$/);
    const txid = "ab".repeat(32);
    results.set(txid, { status: "found", confirmations: 1, notes: [{ ref: `${txid}:sapling:1`, memo: buildPayFeeMemo(fee.nonce), amountZat: 75_000, confirmations: 1 }] });
    alice.send({ type: "pay_sent", requestId: "req-fee-001", txid });
    alice.send({ type: "pay_notice", requestId: "req-fee-001", ...SEALED });
    await waitFor(bob, (m) => m.type === "pay_notice");
    await settle();
    await fees.check();
    assert.equal(fees.isSanctioned(alice.id), false);
    assert.equal(fees.pendingCount, 0);
    alice.send({ type: "pay_request", to: bob.id, requestId: "req-fee-002", senderKey: KEY });
    await waitFor(bob, (m) => m.type === "pay_request" && m.requestId === "req-fee-002");
  } finally {
    await stop();
  }
});

test("ADR-018 § 6: a transaction without the fee → fee_unpaid; further requests are refused for the session only", async () => {
  const results = new Map<string, ReadResult>();
  const fees = feeLedger(results, Date.now);
  const { join, stop } = await world({ transferFees: fees });
  try {
    const alice = await join("Alice");
    const bob = await join("Bob");
    alice.send({ type: "pay_request", to: bob.id, requestId: "req-skip-01", senderKey: KEY });
    await waitFor(bob, (m) => m.type === "pay_request");
    bob.send({ type: "pay_accept", requestId: "req-skip-01", recipientKey: KEY, ...SEALED });
    await waitFor(alice, (m) => m.type === "pay_accept");
    const txid = "cd".repeat(32);
    results.set(txid, { status: "found", confirmations: 2, notes: [] });
    alice.send({ type: "pay_sent", requestId: "req-skip-01", txid });
    await settle();
    await fees.check();
    assert.equal(fees.isSanctioned(alice.id), true);
    alice.send({ type: "pay_request", to: bob.id, requestId: "req-skip-02", senderKey: KEY });
    assert.equal((await waitFor(alice, (m) => m.type === "pay_error" && m.requestId === "req-skip-02")).reason, "fee_unpaid");
    // Bob was never sanctioned.
    bob.send({ type: "pay_request", to: alice.id, requestId: "req-skip-03", senderKey: KEY });
    await waitFor(alice, (m) => m.type === "pay_request" && m.requestId === "req-skip-03");
  } finally {
    await stop();
  }
});

test("ADR-018 § 6: no pay_sent within 30 minutes of the acceptance → fee_unpaid; a cancelled request owes nothing", async () => {
  let clock = 1_000_000;
  const fees = feeLedger(new Map(), () => clock);
  const { join, stop } = await world({ transferFees: fees, now: () => clock });
  try {
    const alice = await join("Alice");
    const bob = await join("Bob");
    const carol = await join("Carol");
    for (const [sender, id] of [
      [alice, "req-late-01"],
      [carol, "req-cncl-01"],
    ] as const) {
      sender.send({ type: "pay_request", to: bob.id, requestId: id, senderKey: KEY });
      await waitFor(bob, (m) => m.type === "pay_request" && m.requestId === id);
      bob.send({ type: "pay_accept", requestId: id, recipientKey: KEY, ...SEALED });
      await waitFor(sender, (m) => m.type === "pay_accept" && m.requestId === id);
    }
    carol.send({ type: "pay_notice", requestId: "req-cncl-01", ...SEALED }); // a sealed "cancelled" — no pay_sent before it
    await waitFor(bob, (m) => m.type === "pay_notice");
    clock += PAY_FEE_DEADLINE_MS + 1;
    await fees.check();
    assert.equal(fees.isSanctioned(alice.id), true);
    assert.equal(fees.isSanctioned(carol.id), false);
  } finally {
    await stop();
  }
});

/** Sends a request from `sender` to `recipient` and returns once the recipient has it. */
async function requestTo(sender: Client, recipient: Client, requestId: string): Promise<void> {
  sender.send({ type: "pay_request", to: recipient.id, requestId, senderKey: KEY });
  await waitFor(recipient, (m) => m.type === "pay_request" && m.requestId === requestId);
}

test("the sender cancels while waiting; the recipient's late Accept goes nowhere and owes no fee", async () => {
  let clock = 1_000_000;
  const fees = feeLedger(new Map(), () => clock);
  const { join, stop } = await world({ transferFees: fees, now: () => clock });
  try {
    const alice = await join("Alice");
    const bob = await join("Bob");
    await requestTo(alice, bob, "req-cancel-001");
    alice.send({ type: "pay_cancel", requestId: "req-cancel-001" });
    const cancel = await waitFor(bob, (m) => m.type === "pay_cancel");
    assert.deepEqual(cancel, { type: "pay_cancel", requestId: "req-cancel-001", from: alice.id }, "Bob's card closes");
    bob.send({ type: "pay_accept", requestId: "req-cancel-001", recipientKey: KEY, ...SEALED }); // a stale Accept
    assert.equal((await waitFor(bob, (m) => m.type === "pay_error")).reason, "unknown_request");
    await settle();
    assert.equal(alice.messages.some((m) => m.type === "pay_accept"), false);
    assert.equal(fees.pendingCount, 0, "no fee entry for a cancelled request");
    clock += PAY_FEE_DEADLINE_MS + 60_000;
    await fees.check();
    assert.equal(fees.isSanctioned(alice.id), false);
    await requestTo(alice, bob, "req-cancel-002");
    // Only the sender may cancel: Bob's pay_cancel is ignored.
    bob.send({ type: "pay_cancel", requestId: "req-cancel-002" });
    await settle();
    assert.equal(alice.messages.some((m) => m.type === "pay_cancel"), false);
  } finally {
    await stop();
  }
});

test("a cancel AFTER the acceptance (a bad or late acceptance) drops the fee entry — no sanction", async () => {
  let clock = 1_000_000;
  const fees = feeLedger(new Map(), () => clock);
  const { join, stop } = await world({ transferFees: fees, now: () => clock });
  try {
    const alice = await join("Alice");
    const bob = await join("Bob");
    await requestTo(alice, bob, "req-postaccept-01");
    bob.send({ type: "pay_accept", requestId: "req-postaccept-01", recipientKey: KEY, ...SEALED });
    await waitFor(alice, (m) => m.type === "pay_accept");
    assert.equal(fees.pendingCount, 1, "the acceptance opened a fee entry");
    alice.send({ type: "pay_cancel", requestId: "req-postaccept-01" }); // e.g. Bob sealed an invalid address
    await waitFor(bob, (m) => m.type === "pay_cancel");
    await settle();
    assert.equal(fees.pendingCount, 0);
    clock += PAY_FEE_DEADLINE_MS + 60_000;
    await fees.check();
    assert.equal(fees.isSanctioned(alice.id), false);
  } finally {
    await stop();
  }
});

test("the recipient leaves after accepting — the sender is told, its fee entry goes, no sanction", async () => {
  let clock = 1_000_000;
  const fees = feeLedger(new Map(), () => clock);
  const { join, stop } = await world({ transferFees: fees, now: () => clock });
  try {
    const alice = await join("Alice");
    const bob = await join("Bob");
    await requestTo(alice, bob, "req-leave-001");
    bob.send({ type: "pay_accept", requestId: "req-leave-001", recipientKey: KEY, ...SEALED });
    await waitFor(alice, (m) => m.type === "pay_accept");
    bob.close();
    const gone = await waitFor(alice, (m) => m.type === "pay_cancel");
    assert.deepEqual(gone, { type: "pay_cancel", requestId: "req-leave-001", from: bob.id });
    assert.equal(fees.pendingCount, 0, "an unpaid request to a player who left owes nothing");
    // Alice's cancelling notice after Bob left: refused by the relay, still clears nothing twice and sanctions nothing.
    alice.send({ type: "pay_notice", requestId: "req-leave-001", ...SEALED });
    assert.equal((await waitFor(alice, (m) => m.type === "pay_error")).reason, "unknown_request");
    clock += PAY_FEE_DEADLINE_MS + 60_000;
    await fees.check();
    assert.equal(fees.isSanctioned(alice.id), false);
  } finally {
    await stop();
  }
});

test("a sender's notice clears its unreported fee entry even when the relay already forgot the request", async () => {
  let clock = 1_000_000;
  const fees = feeLedger(new Map(), () => clock);
  const { join, stop } = await world({ transferFees: fees, now: () => clock });
  try {
    const alice = await join("Alice");
    const bob = await join("Bob");
    await requestTo(alice, bob, "req-forgot-001");
    bob.send({ type: "pay_accept", requestId: "req-forgot-001", recipientKey: KEY, ...SEALED });
    await waitFor(alice, (m) => m.type === "pay_accept");
    // The relay's notice window ends (30 minutes) a moment before the fee deadline check runs.
    clock += PAY_FEE_DEADLINE_MS - 1_000;
    alice.send({ type: "pay_notice", requestId: "req-forgot-001", ...SEALED });
    await settle();
    clock += 2_000;
    await fees.check();
    assert.equal(fees.isSanctioned(alice.id), false);
  } finally {
    await stop();
  }
});

test("a fee-charging server that cannot quote refuses the acceptance instead of relaying it fee-free", async () => {
  const fees = feeLedger(new Map(), Date.now);
  const { join, stop } = await world({ transferFees: fees });
  try {
    const alice = await join("Alice");
    const bob = await join("Bob");
    // Fill Alice's own allowance through the ledger directly (the relay rate limit would make this slow).
    for (let i = 0; i < 20; i++) fees.quote(`req-alice-${String(i).padStart(3, "0")}`, alice.id);
    await requestTo(alice, bob, "req-noquote-001");
    bob.send({ type: "pay_accept", requestId: "req-noquote-001", recipientKey: KEY, ...SEALED });
    assert.equal((await waitFor(bob, (m) => m.type === "pay_error" && m.requestId === "req-noquote-001")).reason, "rate_limited");
    assert.equal((await waitFor(alice, (m) => m.type === "pay_error" && m.requestId === "req-noquote-001")).reason, "rate_limited");
    await settle();
    assert.equal(alice.messages.some((m) => m.type === "pay_accept"), false, "never relayed without its fee");
    // The request is over for both: a later notice is refused.
    alice.send({ type: "pay_notice", requestId: "req-noquote-001", ...SEALED });
    await waitFor(alice, (m) => m.type === "pay_error" && m.requestId === "req-noquote-001" && m.reason === "unknown_request");
  } finally {
    await stop();
  }
});

test("the parser accepts pay_cancel {requestId} only", () => {
  assert.deepEqual(parseIncomingMessage({ type: "pay_cancel", requestId: "req-parse-01", extra: 1 }), { type: "pay_cancel", requestId: "req-parse-01" });
  assert.equal(parseIncomingMessage({ type: "pay_cancel" }), null);
  assert.equal(parseIncomingMessage({ type: "pay_cancel", requestId: "x".repeat(200) }), null);
});

test("ADR-018 § 7: the welcome carries the served client's build id when the server knows it", async () => {
  const a = await world({ buildId: "20261008-abc123" });
  try {
    const alice = await a.join("Alice");
    assert.equal(alice.messages.find((m) => m.type === "welcome")!.build, "20261008-abc123");
  } finally {
    await a.stop();
  }
  const b = await world({});
  try {
    const bob = await b.join("Bob");
    assert.equal("build" in bob.messages.find((m) => m.type === "welcome")!, false);
  } finally {
    await b.stop();
  }
});

test("resolveBuildId: BUILD_ID, else WEB_DIST/build-id.txt, else null; GET /version answers it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zw-build-"));
  try {
    writeFileSync(join(dir, "build-id.txt"), "20261008083000-k3j2h1\n");
    assert.equal(resolveBuildId({}, dir), "20261008083000-k3j2h1");
    assert.equal(resolveBuildId({ BUILD_ID: "release-7" }, dir), "release-7");
    assert.equal(resolveBuildId({ BUILD_ID: "bad id with spaces" }, dir), null);
    assert.equal(resolveBuildId({}, null), null);
    assert.equal(resolveBuildId({}, join(dir, "missing")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const handler = createVersionHandler({ allowedOrigins: ["http://127.0.0.1:5194"], build: () => "b-1" });
  const server: Server = createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const ok = await fetch(`${base}/version`, { headers: { origin: "http://127.0.0.1:5194" } });
    assert.deepEqual(await ok.json(), { build: "b-1" });
    assert.equal(ok.headers.get("access-control-allow-origin"), "http://127.0.0.1:5194");
    assert.equal((await fetch(`${base}/version`, { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await fetch(`${base}/other`)).status, 404);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("the faucet refuses on main: /zcash/info says faucet false, a claim is 403 faucet_disabled", async () => {
  let rpcCalls = 0;
  const handler = createFaucetHandler({
    allowedOrigins: [],
    network: "main",
    rpc: async () => (rpcCalls++, null as never),
    resolveSession: () => "player",
    info: () => ({ network: "main", payments: { feeZat: 75_000, capZat: 1_000_000 } }),
  });
  const server: Server = createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const info = (await (await fetch(`${base}/zcash/info`)).json()) as Record<string, unknown>;
    assert.equal(info.faucet, false);
    assert.equal(info.network, "main");
    assert.deepEqual(info.payments, { feeZat: 75_000, capZat: 1_000_000 });
    const claim = await fetch(`${base}/zcash/faucet`, { method: "POST", body: JSON.stringify({ capability: "x", address: "u1" + "q".repeat(60) }) });
    assert.equal(claim.status, 403);
    assert.deepEqual(await claim.json(), { error: "faucet_disabled" });
    assert.equal(rpcCalls, 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("parser: pay_request capZat, pay_sent and name_payment_sent are validated; anything else is dropped", () => {
  const txid = "ab".repeat(32);
  assert.deepEqual(parseIncomingMessage({ type: "pay_request", to: "p1", requestId: "req-00001", senderKey: KEY, capZat: 1_000_000 }), { type: "pay_request", to: "p1", requestId: "req-00001", senderKey: KEY, capZat: 1_000_000 });
  assert.equal(parseIncomingMessage({ type: "pay_request", to: "p1", requestId: "req-00001", senderKey: KEY, capZat: -1 }), null);
  assert.equal(parseIncomingMessage({ type: "pay_request", to: "p1", requestId: "req-00001", senderKey: KEY, capZat: "1" }), null);
  assert.deepEqual(parseIncomingMessage({ type: "pay_sent", requestId: "req-00001", txid }), { type: "pay_sent", requestId: "req-00001", txid });
  assert.equal(parseIncomingMessage({ type: "pay_sent", requestId: "req-00001", txid: txid.toUpperCase() }), null);
  assert.equal(parseIncomingMessage({ type: "pay_sent", requestId: "req-00001", txid: "ab" }), null);
  assert.deepEqual(parseIncomingMessage({ type: "name_payment_sent", reservationId: "A".repeat(22), txid }), { type: "name_payment_sent", reservationId: "A".repeat(22), txid });
  assert.equal(parseIncomingMessage({ type: "name_payment_sent", reservationId: "short", txid }), null);
});
