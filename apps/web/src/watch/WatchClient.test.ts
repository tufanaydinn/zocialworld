import { test } from "node:test";
import assert from "node:assert/strict";
import { WatchClient } from "./WatchClient.ts";

const BASE = "http://127.0.0.1:8787/content";

function listing(tag: string, available = true): unknown {
  return { available, stale: false, generatedAt: tag, live: [], schedule: [], latest: [], collections: [] };
}

function fakeFetch(responses: (() => { status: number; body: unknown })[], calls: string[]) {
  return async (url: string): Promise<Response> => {
    calls.push(url);
    const next = responses.shift();
    if (!next) throw new Error("offline");
    const { status, body } = next();
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
}

test("the listing is reused for ~60 s, then refetched; fresh=true skips the window", async () => {
  let clock = 0;
  const calls: string[] = [];
  const client = new WatchClient({
    base: `${BASE}/`,
    now: () => clock,
    fetch: fakeFetch(
      [() => ({ status: 200, body: listing("a") }), () => ({ status: 200, body: listing("b") }), () => ({ status: 200, body: listing("c") })],
      calls,
    ),
  });
  const before = client.lastListing;
  assert.equal(before, null, "nothing loaded yet");
  const [first, shared] = await Promise.all([client.listing(), client.listing()]);
  assert.equal(first.generatedAt, "a");
  assert.equal(shared.generatedAt, "a", "concurrent callers share one request");
  assert.deepEqual(calls, [`${BASE}/watch`]);
  clock = 59_000;
  assert.equal((await client.listing()).generatedAt, "a", "within the window");
  clock = 61_000;
  assert.equal((await client.listing()).generatedAt, "b", "after the window");
  assert.equal((await client.listing(true)).generatedAt, "c", "the panel's poll asks for a fresh copy");
  assert.equal(client.lastListing?.generatedAt, "c");
  assert.equal(calls.length, 3);
});

test("failures and available:false are not cached (Retry really retries)", async () => {
  const calls: string[] = [];
  const client = new WatchClient({
    base: BASE,
    now: () => 0,
    fetch: fakeFetch(
      [() => ({ status: 502, body: { error: "upstream_unavailable" } }), () => ({ status: 200, body: listing("x", false) }), () => ({ status: 200, body: listing("ok") })],
      calls,
    ),
  });
  await assert.rejects(client.listing(), /502/);
  await assert.rejects(client.listing(), /unavailable/);
  assert.equal((await client.listing()).generatedAt, "ok");
  assert.equal(client.lastListing?.generatedAt, "ok");
  assert.equal(calls.length, 3);
});

test("collection pages: encoded ids, page query only when > 0, reused longer than the listing", async () => {
  let clock = 0;
  const calls: string[] = [];
  const page = { available: true, stale: false, collection: { id: "zcon-vi", title: "ZconVI (2025)", channel: "Zcash Foundation", count: 12 }, videos: [], page: 0, pages: 1 };
  const client = new WatchClient({ base: BASE, now: () => clock, fetch: fakeFetch([() => ({ status: 200, body: page }), () => ({ status: 200, body: { ...page, page: 1 } })], calls) });
  await client.collection("zcon-vi");
  clock = 5 * 60_000;
  await client.collection("zcon-vi");
  await client.collection("zcon-vi", 1.7);
  assert.deepEqual(calls, [`${BASE}/watch/collection/zcon-vi`, `${BASE}/watch/collection/zcon-vi?page=1`]);
});
