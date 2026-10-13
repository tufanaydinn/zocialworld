import { test } from "node:test";
import assert from "node:assert/strict";
import http2 from "node:http2";
import { createServer as createNetServer, type Socket } from "node:net";
import { GrpcStatusError, LightwalletdClient, decodeBlockHeight, decodeFields, decodeGrpcMessage, decodeRawTransaction, encodeTxFilter, firstGrpcMessage, grpcFrame } from "./lightwalletdClient.js";

/**
 * ADR-018 § 5/§ 6: the server's minimal unary gRPC client — the protobuf pieces, then the client against
 * a fake lightwalletd (an in-process HTTP/2 server speaking gRPC): GetLatestBlock, GetTransaction (mined, mempool,
 * unknown).
 */

const TXID = "4daa65c015d9" + "ab".repeat(26);

function varint(value: bigint): number[] {
  const out: number[] = [];
  let v = value;
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}

function rawTransaction(data: Uint8Array, height: bigint): Uint8Array {
  return Uint8Array.from([0x0a, ...varint(BigInt(data.length)), ...data, 0x10, ...varint(height)]);
}

test("TxFilter carries the txid in internal (reversed) byte order in field 3", () => {
  const filter = encodeTxFilter(TXID);
  assert.equal(filter[0], 0x1a);
  assert.equal(filter[1], 32);
  assert.equal(Buffer.from(filter.subarray(2)).toString("hex"), Buffer.from(TXID, "hex").reverse().toString("hex"));
  assert.throws(() => encodeTxFilter("xyz"));
});

test("RawTransaction: data and height; 0 and 2^64-1 mean unmined", () => {
  const data = Uint8Array.from([5, 0, 0, 128, 10, 39]);
  assert.deepEqual(decodeRawTransaction(rawTransaction(data, 3_510_433n)), { hex: "050000800a27", height: 3_510_433 });
  assert.equal(decodeRawTransaction(rawTransaction(data, 0n)).height, null);
  assert.equal(decodeRawTransaction(rawTransaction(data, (1n << 64n) - 1n)).height, null);
  assert.throws(() => decodeRawTransaction(Uint8Array.from([0x10, 5])), /without data/);
});

test("BlockID height, gRPC framing and unknown fields", () => {
  const block = Uint8Array.from([0x08, ...varint(3_510_438n), 0x12, 2, 0xaa, 0xbb, 0x25, 1, 2, 3, 4]);
  assert.equal(decodeBlockHeight(block), 3_510_438);
  assert.deepEqual(decodeFields(block).get(2), [Uint8Array.from([0xaa, 0xbb])]);
  const framed = grpcFrame(block);
  assert.deepEqual(Uint8Array.from(firstGrpcMessage(framed)!), block);
  assert.equal(firstGrpcMessage(Buffer.alloc(2)), null);
  assert.throws(() => firstGrpcMessage(Buffer.from([1, 0, 0, 0, 0])), /compressed/);
});

/** A fake lightwalletd: answers by method, records the requests. */
async function fakeLightwalletd(transactions: Map<string, { data: Uint8Array; height: bigint }>, tip: bigint) {
  const requests: { path: string; body: Buffer }[] = [];
  const server = http2.createServer();
  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      const path = String(headers[":path"]);
      const body = Buffer.concat(chunks);
      requests.push({ path, body });
      const reply = (message: Uint8Array | null, status = 0, text = ""): void => {
        stream.respond({ ":status": 200, "content-type": "application/grpc+proto" }, { waitForTrailers: true });
        stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": String(status), ...(text ? { "grpc-message": encodeURIComponent(text) } : {}) }));
        if (message) stream.write(grpcFrame(message));
        stream.end();
      };
      if (path.endsWith("/GetLatestBlock")) return reply(Uint8Array.from([0x08, ...varint(tip)]));
      if (path.endsWith("/GetTransaction")) {
        const filter = decodeFields(firstGrpcMessage(body)!);
        const hash = Buffer.from(filter.get(3)![0] as Uint8Array).reverse().toString("hex");
        const tx = transactions.get(hash);
        if (!tx) return reply(null, 2, "-5: No information available about transaction");
        return reply(rawTransaction(tx.data, tx.height));
      }
      reply(null, 12, "unimplemented");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("the client against a fake lightwalletd: tip, a mined and a mempool transaction, an unknown one", async () => {
  const mempool = "cd".repeat(32);
  const fake = await fakeLightwalletd(
    new Map([
      [TXID, { data: Uint8Array.from([1, 2, 3]), height: 112n }],
      [mempool, { data: Uint8Array.from([4, 5]), height: 0n }],
    ]),
    120n,
  );
  const client = new LightwalletdClient({ upstream: fake.url, timeoutMs: 5_000 });
  try {
    assert.equal(await client.tipHeight(), 120);
    assert.deepEqual(await client.getTransaction(TXID), { hex: "010203", height: 112 });
    assert.deepEqual(await client.getTransaction(mempool), { hex: "0405", height: null });
    assert.equal(await client.getTransaction("ef".repeat(32)), null, "unknown → null, not an error");
    assert.deepEqual(
      fake.requests.map((r) => r.path),
      [
        "/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestBlock",
        "/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetTransaction",
        "/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetTransaction",
        "/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetTransaction",
      ],
    );
  } finally {
    client.close();
    await fake.close();
  }
});

test("an unreachable lightwalletd rejects (the fee check retries) instead of hanging", async () => {
  const client = new LightwalletdClient({ upstream: "http://127.0.0.1:9", timeoutMs: 2_000 });
  await assert.rejects(client.tipHeight());
  client.close();
});

/** A fake upstream that answers every call with a RAW (not percent-encoded) grpc-message — in trailers, or trailers-only. */
async function rawStatusServer(trailersOnly: boolean) {
  const server = http2.createServer();
  server.on("stream", (stream) => {
    stream.on("data", () => undefined);
    stream.on("end", () => {
      if (trailersOnly) {
        stream.respond({ ":status": 200, "content-type": "application/grpc+proto", "grpc-status": "13", "grpc-message": "disk 100% full" }, { endStream: true });
        return;
      }
      stream.respond({ ":status": 200, "content-type": "application/grpc+proto" }, { waitForTrailers: true });
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "13", "grpc-message": "disk 100% full" }));
      stream.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("a malformed grpc-message (raw '%') rejects the call instead of crashing the server", async () => {
  assert.equal(decodeGrpcMessage("disk 100% full"), "disk 100% full");
  assert.equal(decodeGrpcMessage("disk%20full"), "disk full");
  assert.equal(decodeGrpcMessage("x".repeat(900)).length, 500);
  assert.equal(decodeGrpcMessage(undefined), "");
  for (const trailersOnly of [false, true]) {
    const fake = await rawStatusServer(trailersOnly);
    const client = new LightwalletdClient({ upstream: fake.url, timeoutMs: 5_000 });
    try {
      await assert.rejects(client.getTransaction(TXID), (error: unknown) => error instanceof GrpcStatusError && error.status === 13 && /disk 100% full/.test(error.message));
    } finally {
      client.close();
      await fake.close();
    }
  }
});

test("a proxy that accepts TCP and never answers CONNECT fails the call within the timeout; the next call tries a new session", async () => {
  const sockets: Socket[] = [];
  const proxy = createNetServer((socket) => void sockets.push(socket)); // accepts, never answers
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
  process.env.HTTPS_PROXY = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  delete process.env.https_proxy;
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  const client = new LightwalletdClient({ upstream: "https://lightwalletd.invalid:443", timeoutMs: 400 });
  try {
    const started = Date.now();
    await assert.rejects(client.tipHeight(), /timed out/);
    assert.ok(Date.now() - started < 3_000, "bounded by the call timeout, not forever");
    const before = sockets.length;
    await assert.rejects(client.tipHeight(), /timed out/);
    assert.ok(sockets.length > before, "a new connection attempt — not the same stuck session");
  } finally {
    client.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});

test("an unreachable primary fails over to the mirror; a NOT_FOUND from a working upstream is an answer, not a failover", async () => {
  const mirror = await fakeLightwalletd(new Map([[TXID, { data: Uint8Array.from([7]), height: 200n }]]), 210n);
  const second = await fakeLightwalletd(new Map(), 999n);
  const client = new LightwalletdClient({ upstream: ["http://127.0.0.1:9", mirror.url, second.url], timeoutMs: 2_000, upstreamCooldownMs: 60_000 });
  try {
    assert.equal(await client.tipHeight(), 210, "the first reachable upstream in order answers");
    assert.deepEqual(await client.getTransaction(TXID), { hex: "07", height: 200 });
    assert.equal(await client.getTransaction("ef".repeat(32)), null, "unknown on the mirror: null (not asked of the next one)");
    assert.equal(second.requests.length, 0, "the third upstream was never needed");
  } finally {
    client.close();
    await mirror.close();
    await second.close();
  }
});

test("gRPC UNAVAILABLE fails over; after the cooldown the primary is asked again", async () => {
  // The primary's backend is down (UNAVAILABLE); the mirror works.
  const down = http2.createServer();
  let downCalls = 0;
  down.on("stream", (stream) => {
    downCalls++;
    stream.on("data", () => undefined);
    stream.on("end", () => stream.respond({ ":status": 200, "content-type": "application/grpc+proto", "grpc-status": "14", "grpc-message": "backend down" }, { endStream: true }));
  });
  await new Promise<void>((resolve) => down.listen(0, "127.0.0.1", resolve));
  const downUrl = `http://127.0.0.1:${(down.address() as { port: number }).port}`;
  const mirror = await fakeLightwalletd(new Map(), 321n);
  const client = new LightwalletdClient({ upstream: [downUrl, mirror.url], timeoutMs: 2_000, upstreamCooldownMs: 40 });
  try {
    assert.equal(await client.tipHeight(), 321);
    assert.equal(await client.tipHeight(), 321);
    assert.equal(downCalls, 1, "the failed primary cools down instead of being asked on every call");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(await client.tipHeight(), 321);
    assert.equal(downCalls, 2, "after the cooldown it is tried first again");
  } finally {
    client.close();
    await mirror.close();
    await new Promise<void>((resolve) => down.close(() => resolve()));
  }
});
