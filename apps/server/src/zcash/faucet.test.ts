import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createFaucetHandler, type RpcFn } from "./faucet.js";

const ADDR = "uregtest1" + "q".repeat(100);

function fakeRpc(calls: string[]): RpcFn {
  return (async (method: string) => {
    calls.push(method);
    switch (method) {
      case "z_listaddresses": return ["zregtestsapling1miner"];
      case "z_getbalance": return 100;
      case "z_sendmany": return "opid-1";
      case "z_getoperationstatus": return [{ status: "success" }];
      case "z_getoperationresult": return [{ status: "success", result: { txid: "ab".repeat(32) } }];
      default: throw new Error(method);
    }
  }) as RpcFn;
}

async function serve(handler: ReturnType<typeof createFaucetHandler>) {
  const server = createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(418).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const claim = (base: string, body: unknown) => fetch(`${base}/zcash/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("faucet: needs a live session and a shielded test address; sends via z_sendmany; cools down per session and address", async () => {
  let clock = 1_000_000;
  const calls: string[] = [];
  const handler = createFaucetHandler({ allowedOrigins: [], resolveSession: (c) => (c === "cap-a" ? "A" : c === "cap-b" ? "B" : null), rpc: fakeRpc(calls), now: () => clock, amountZec: 2 });
  const { server, base } = await serve(handler);
  try {
    assert.deepEqual(await (await fetch(`${base}/zcash/info`)).json(), { faucet: true, amount: 2 });
    assert.equal((await claim(base, { capability: "nope", address: ADDR })).status, 403);
    assert.equal((await claim(base, { capability: "cap-a", address: "tmTransparentAddr123456789" })).status, 400);
    const ok = await claim(base, { capability: "cap-a", address: ADDR });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).amount, 2);
    assert.ok(calls.includes("z_sendmany"));
    assert.equal((await claim(base, { capability: "cap-a", address: "uregtest1" + "w".repeat(100) })).status, 429, "session cooldown");
    assert.equal((await claim(base, { capability: "cap-b", address: ADDR })).status, 429, "address cooldown");
    clock += 11 * 60 * 1000;
    assert.equal((await claim(base, { capability: "cap-a", address: "uregtest1" + "w".repeat(100) })).status, 200);
  } finally {
    server.close();
  }
});

test("faucet is disabled without zcashd configuration", async () => {
  delete process.env.ZCASHD_RPC_URL;
  const handler = createFaucetHandler({ allowedOrigins: [], resolveSession: () => "A" });
  const { server, base } = await serve(handler);
  try {
    assert.deepEqual(await (await fetch(`${base}/zcash/info`)).json(), { faucet: false, amount: 0 });
    assert.equal((await claim(base, { capability: "x", address: ADDR })).status, 503);
  } finally {
    server.close();
  }
});
