import { test } from "node:test";
import assert from "node:assert/strict";
import http2 from "node:http2";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLightwalletdProxy, encodeTrailerFrame } from "./lwdProxy.js";

const ORIGIN = "http://127.0.0.1:5174";
const SERVICE = "cash.z.wallet.sdk.rpc.CompactTxStreamer";

/** A tiny cleartext HTTP/2 gRPC server standing in for lightwalletd. */
async function fakeLightwalletd(): Promise<{ url: string; calls: string[]; close: () => void }> {
  const calls: string[] = [];
  const server = http2.createServer();
  server.on("stream", (stream, headers) => {
    calls.push(String(headers[":path"]));
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => {
      const path = String(headers[":path"]);
      if (path.endsWith("/GetLatestBlock")) {
        stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
        stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0", "grpc-message": "" }));
        stream.end(Buffer.from([0, 0, 0, 0, 2, 8, 42])); // one message frame
      } else if (path.endsWith("/GetBlockRange")) {
        stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
        stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
        stream.write(Buffer.from([0, 0, 0, 0, 1, 1]));
        stream.write(Buffer.from([0, 0, 0, 0, 1, 2]));
        stream.end(Buffer.from([0, 0, 0, 0, 1, 3]));
      } else {
        // trailers-only error
        stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "12", "grpc-message": "unimplemented" }, { endStream: true });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => server.close() };

}

async function bridge(upstream: string): Promise<{ base: string; server: { close: () => void } }> {
  const sessions: http2.ClientHttp2Session[] = [];
  const handler = createLightwalletdProxy({
    allowedOrigins: [ORIGIN],
    upstream,
    connect: async () => {
      const session = http2.connect(upstream);
      sessions.push(session);
      return session;
    },
  });
  const server: Server = createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(418).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server: {
      close: () => {
        for (const session of sessions) session.destroy();
        server.closeAllConnections();
        server.close();
      },
    },
  };
}

const call = (base: string, method: string, init: RequestInit = {}) =>
  fetch(`${base}/zcash/lwd/${SERVICE}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/grpc-web+proto", "x-grpc-web": "1", origin: ORIGIN },
    body: Buffer.from([0, 0, 0, 0, 0]),
    ...init,
  });

test("trailer frames are grpc-web encoded (0x80 + length + header lines)", () => {
  const frame = encodeTrailerFrame({ "grpc-status": "0", "grpc-message": "" });
  assert.equal(frame[0], 0x80);
  assert.equal(frame.readUInt32BE(1), frame.length - 5);
  assert.equal(frame.subarray(5).toString(), "grpc-status: 0\r\ngrpc-message: \r\n");
});

test("unary and server-streaming calls are bridged with a trailing grpc-web trailer frame", async () => {
  const lwd = await fakeLightwalletd();
  const { base, server } = await bridge(lwd.url);
  try {
    const unary = await call(base, "GetLatestBlock");
    assert.equal(unary.status, 200);
    assert.equal(unary.headers.get("content-type"), "application/grpc-web+proto");
    assert.equal(unary.headers.get("access-control-allow-origin"), ORIGIN);
    const bytes = Buffer.from(await unary.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 7)], [0, 0, 0, 0, 2, 8, 42]);
    assert.equal(bytes[7], 0x80, "trailer frame follows the message");
    assert.match(bytes.subarray(12).toString(), /grpc-status: 0/);

    const streamed = Buffer.from(await (await call(base, "GetBlockRange")).arrayBuffer());
    assert.deepEqual([...streamed.subarray(0, 18)], [0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0, 1, 3]);
    assert.equal(streamed[18], 0x80);

    const failed = Buffer.from(await (await call(base, "GetMempoolTx")).arrayBuffer());
    assert.equal(failed[0], 0x80, "a trailers-only gRPC error becomes a trailer frame");
    assert.match(failed.subarray(5).toString(), /grpc-status: 12/);
    assert.deepEqual(lwd.calls, [`/${SERVICE}/GetLatestBlock`, `/${SERVICE}/GetBlockRange`, `/${SERVICE}/GetMempoolTx`]);
  } finally {
    server.close();
    lwd.close();
  }
});

test("only CompactTxStreamer methods, binary grpc-web, POST and allowed origins are accepted", async () => {
  const lwd = await fakeLightwalletd();
  const { base, server } = await bridge(lwd.url);
  try {
    assert.equal((await fetch(`${base}/zcash/lwd/other.Service/Do`, { method: "POST", headers: { "content-type": "application/grpc-web+proto" } })).status, 404);
    assert.equal((await fetch(`${base}/zcash/lwd/${SERVICE}/GetLatestBlock`)).status, 405);
    assert.equal((await call(base, "GetLatestBlock", { headers: { "content-type": "application/grpc-web-text", origin: ORIGIN } })).status, 415);
    assert.equal((await call(base, "GetLatestBlock", { headers: { "content-type": "application/grpc-web+proto", origin: "https://evil.example" } })).status, 403);
    const preflight = await fetch(`${base}/zcash/lwd/${SERVICE}/GetLatestBlock`, { method: "OPTIONS", headers: { origin: ORIGIN } });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /x-grpc-web/);
    assert.equal(lwd.calls.length, 0, "nothing reached the upstream");
    assert.equal((await fetch(`${base}/voice/token`)).status, 418, "other paths fall through");
  } finally {
    server.close();
    lwd.close();
  }
});

test("an unreachable lightwalletd answers grpc-status 14 instead of hanging", async () => {
  const handler = createLightwalletdProxy({ allowedOrigins: [ORIGIN], upstream: "http://127.0.0.1:1", connect: async () => Promise.reject(new Error("refused")) });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await call(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "GetLatestBlock");
    assert.equal(response.headers.get("grpc-status"), "14");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

/** A lightwalletd whose backend is down: every call is a trailers-only gRPC UNAVAILABLE. */
async function downLightwalletd(): Promise<{ url: string; calls: string[]; close: () => void }> {
  const calls: string[] = [];
  const server = http2.createServer();
  server.on("stream", (stream, headers) => {
    calls.push(String(headers[":path"]));
    stream.on("data", () => undefined);
    stream.on("end", () => stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "14", "grpc-message": "backend down" }, { endStream: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => server.close() };
}

async function failoverBridge(upstreams: string[], cooldownMs: number) {
  const sessions: http2.ClientHttp2Session[] = [];
  const connects: string[] = [];
  const handler = createLightwalletdProxy({
    allowedOrigins: [ORIGIN],
    upstream: upstreams,
    upstreamCooldownMs: cooldownMs,
    connect: async (url) => {
      connects.push(url.origin);
      if (url.port === "1") throw new Error("connect ECONNREFUSED");
      const session = http2.connect(url.origin);
      sessions.push(session);
      return session;
    },
  });
  const server: Server = createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(418).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    connects,
    close: () => {
      for (const session of sessions) session.destroy();
      server.closeAllConnections();
      server.close();
    },
  };
}

test("an unreachable primary fails over to the next upstream, which then serves while the primary cools down", async () => {
  const lwd = await fakeLightwalletd();
  const b = await failoverBridge(["http://127.0.0.1:1", lwd.url], 60_000);
  try {
    const first = Buffer.from(await (await call(b.base, "GetLatestBlock")).arrayBuffer());
    assert.deepEqual([...first.subarray(0, 7)], [0, 0, 0, 0, 2, 8, 42], "answered by the second upstream");
    assert.match(first.subarray(12).toString(), /grpc-status: 0/);
    const streamed = Buffer.from(await (await call(b.base, "GetBlockRange")).arrayBuffer());
    assert.deepEqual([...streamed.subarray(0, 6)], [0, 0, 0, 0, 1, 1]);
    assert.deepEqual(b.connects, ["http://127.0.0.1:1", lwd.url], "the cooling primary is not retried on every call; one session to the mirror");
    assert.deepEqual(lwd.calls, [`/${SERVICE}/GetLatestBlock`, `/${SERVICE}/GetBlockRange`]);
  } finally {
    b.close();
    lwd.close();
  }
});

test("a trailers-only UNAVAILABLE (backend down) is replayed on the next upstream; other gRPC errors are answers", async () => {
  const down = await downLightwalletd();
  const lwd = await fakeLightwalletd();
  const b = await failoverBridge([down.url, lwd.url], 60_000);
  try {
    const ok = Buffer.from(await (await call(b.base, "GetLatestBlock")).arrayBuffer());
    assert.deepEqual([...ok.subarray(0, 7)], [0, 0, 0, 0, 2, 8, 42]);
    assert.deepEqual(down.calls, [`/${SERVICE}/GetLatestBlock`]);
    // An application error from the healthy upstream (UNIMPLEMENTED) is passed through, not failed over.
    const failed = Buffer.from(await (await call(b.base, "GetMempoolTx")).arrayBuffer());
    assert.match(failed.subarray(5).toString(), /grpc-status: 12/);
    assert.deepEqual(down.calls, [`/${SERVICE}/GetLatestBlock`], "the down primary is cooling: not asked again");
  } finally {
    b.close();
    down.close();
    lwd.close();
  }
});

test("after the cooldown the primary is tried first again; with every upstream down the answer is grpc-status 14", async () => {
  const down = await downLightwalletd();
  const lwd = await fakeLightwalletd();
  const b = await failoverBridge([lwd.url.replace(/:\d+$/, ":1"), down.url], 30);
  try {
    // Both down: the primary cannot connect, the mirror answers UNAVAILABLE — passed on as such.
    const failed = Buffer.from(await (await call(b.base, "GetLatestBlock")).arrayBuffer());
    assert.match(failed.subarray(5).toString(), /grpc-status: 14/);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await call(b.base, "GetLatestBlock");
    assert.equal(b.connects.filter((origin) => origin.endsWith(":1")).length, 2, "the primary was retried after its cooldown");
  } finally {
    b.close();
    down.close();
    lwd.close();
  }
});
