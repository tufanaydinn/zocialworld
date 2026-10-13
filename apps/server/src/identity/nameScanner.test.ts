import { test } from "node:test";
import assert from "node:assert/strict";
import { NAME_DEV_ADDRESS } from "@project/shared";
import type { RpcFn } from "../zcash/faucet.js";
import { NameRegistry, type NameUpdate } from "./nameRegistry.js";
import { DevNameScanner, ZcashdNameScanner, decodeTextMemo, parseReceivedNotes } from "./nameScanner.js";
import { MemoryNameStore } from "./nameStore.js";
import { NameService, createNameService } from "./nameService.js";
import { loadNameRegistryConfig, parseZecToZat } from "./nameConfig.js";

/**
 * ADR-016: the zcashd scanner against a fake RPC (z_listreceivedbyaddress rows as zcashd v6 prints
 * them — match, wrong amount, wrong memo, replayed note, 0-conf), the dev scanner, the poll loop (only while a
 * reservation is pending) and the configuration (dev refuses NODE_ENV=production).
 */

const ADDRESS = "uregtest1" + "q".repeat(80);
const FEE = 1_000_000;
const KEY = "a".repeat(64);
const TXID = "e".repeat(64);

function memoHex(text: string): string {
  return Buffer.concat([Buffer.from(text, "utf8"), Buffer.alloc(512 - Buffer.byteLength(text))]).toString("hex");
}

/** A row of `z_listreceivedbyaddress` for an Orchard note (zcashd v6: memo hex + memoStr, outindex = action index). */
function row(memo: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pool: "orchard",
    txid: TXID,
    amount: FEE / 1e8,
    amountZat: FEE,
    memo: memoHex(memo),
    memoStr: memo,
    outindex: 1,
    confirmations: 0,
    blockheight: -1,
    blockindex: -1,
    blocktime: 0,
    change: false,
    ...overrides,
  };
}

function fakeRpc(rows: () => unknown[]): { rpc: RpcFn; calls: { method: string; params: unknown[] }[] } {
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc = (async (method: string, params: unknown[]) => {
    calls.push({ method, params });
    return rows();
  }) as RpcFn;
  return { rpc, calls };
}

function registry(minConfirmations = 0): NameRegistry {
  return new NameRegistry({ now: () => 1000, store: new MemoryNameStore(), address: ADDRESS, feeZat: FEE, minConfirmations });
}

test("zcashd: asks z_listreceivedbyaddress(<registry address>, 0) and maps rows to notes (memoStr, or the hex memo)", async () => {
  const { rpc, calls } = fakeRpc(() => [row("hello"), row("", { memoStr: undefined, memo: memoHex("from hex"), outindex: 2 })]);
  const notes = await new ZcashdNameScanner(rpc, ADDRESS).scan();
  assert.deepEqual(calls, [{ method: "z_listreceivedbyaddress", params: [ADDRESS, 0] }]);
  assert.deepEqual(notes, [
    { ref: `${TXID}:orchard:1`, memo: "hello", amountZat: FEE, confirmations: 0 },
    { ref: `${TXID}:orchard:2`, memo: "from hex", amountZat: FEE, confirmations: 0 },
  ]);
});

test("zcashd rows: transparent, change, conflicted and malformed rows are skipped; a non-array answer throws", () => {
  assert.deepEqual(
    parseReceivedNotes([
      row("t", { pool: "transparent" }),
      row("c", { change: true }),
      row("x", { confirmations: -1 }),
      row("y", { txid: "nope" }),
      row("z", { outindex: undefined }),
      row("ok", { amountZat: undefined, amount: 0.02 }),
    ]),
    [{ ref: `${TXID}:orchard:1`, memo: "ok", amountZat: 2_000_000, confirmations: 0 }],
  );
  assert.throws(() => parseReceivedNotes({ error: "boom" }));
});

test("ZIP 302 memo decoding: text memos only, trailing zero padding removed", () => {
  assert.equal(decodeTextMemo(memoHex("zw-name:v1:x")), "zw-name:v1:x");
  assert.equal(decodeTextMemo("f6" + "00".repeat(511)), null, "0xF6 = no memo");
  assert.equal(decodeTextMemo("ff01"), null, "arbitrary data");
  assert.equal(decodeTextMemo("c3"), null, "invalid UTF-8");
});

test("zcashd scan → registry: a matching 0-conf note confirms; wrong amount, wrong memo and a replayed note do not", async () => {
  const names = registry(0);
  const quote = names.reserve("s1", "Nadia", KEY, () => false);
  assert.ok(quote.ok);
  let rows: unknown[] = [
    row(quote.quote.memo, { txid: "1".repeat(64), amountZat: FEE - 1 }), // wrong amount
    row("zw-name:v1:" + "0".repeat(32) + ":" + "a".repeat(16), { txid: "2".repeat(64) }), // wrong memo (unknown nonce)
  ];
  const scanner = new ZcashdNameScanner(fakeRpc(() => rows).rpc, ADDRESS);
  names.processNotes(await scanner.scan());
  assert.deepEqual(names.takeUpdates(), []);
  rows = [...rows, row(quote.quote.memo, { txid: "3".repeat(64), confirmations: 0 })]; // the real payment, 0-conf
  names.processNotes(await scanner.scan());
  assert.deepEqual(names.takeUpdates().map((u) => (u.kind === "status" ? u.status : u.kind)), ["seen", "confirmed"]);
  // The same note again (every poll returns every note) — and for a new reservation of the same key: nothing.
  const next = names.reserve("s1", "Ada", KEY, () => false);
  assert.ok(next.ok);
  names.processNotes(await scanner.scan());
  assert.deepEqual(names.takeUpdates(), []);
  assert.equal(names.isRegistered("ada"), false);
});

test("dev scanner: seen after half the delay, one confirmation after the full delay", async () => {
  let t = 0;
  const scanner = new DevNameScanner(() => t, 2000);
  const pending = [{ reservationId: "r".repeat(22), memo: "m", amountZat: FEE, createdAt: 0 }];
  assert.deepEqual(await scanner.scan(pending), []);
  t = 1000;
  assert.equal((await scanner.scan(pending))[0]?.confirmations, 0);
  t = 2000;
  assert.equal((await scanner.scan(pending))[0]?.confirmations, 1);
});

test("the poll loop scans only while a reservation is pending, and delivers seen → confirmed", async () => {
  let t = 0;
  const names = new NameRegistry({ now: () => t, store: new MemoryNameStore(), address: NAME_DEV_ADDRESS, feeZat: FEE, minConfirmations: 1 });
  let scans = 0;
  const scanner = new DevNameScanner(() => t, 2000);
  const counting = { kind: "dev" as const, pollMs: 60_000, scan: (pending: Parameters<DevNameScanner["scan"]>[0]) => (scans++, scanner.scan(pending)) };
  const service = new NameService({ mode: "dev", registry: names, scanner: counting });
  const delivered: NameUpdate[] = [];
  service.setListener((updates) => delivered.push(...updates));
  try {
    await service.tick();
    assert.equal(scans, 0, "nothing pending: no scan");
    service.kick();
    assert.equal((service as unknown as { timer: unknown }).timer, null, "kick without a reservation arms nothing");
    assert.ok(names.reserve("s1", "Nadia", KEY, () => false).ok);
    t = 1000;
    await service.tick();
    t = 2000;
    await service.tick();
    assert.equal(scans, 2);
    assert.deepEqual(delivered.map((u) => (u.kind === "status" ? u.status : u.kind)), ["seen", "confirmed"]);
    await service.tick();
    assert.equal(scans, 2, "nothing pending any more: no scan");
  } finally {
    service.dispose();
  }
});

test("a failing scan is retried on the next poll and logged without the address", async () => {
  const names = registry(0);
  assert.ok(names.reserve("s1", "Nadia", KEY, () => false).ok);
  const failing = { kind: "zcashd" as const, pollMs: 60_000, scan: async () => Promise.reject(new Error(`zcashd z_listreceivedbyaddress: no such address ${ADDRESS}`)) };
  const service = new NameService({ mode: "zcashd", registry: names, scanner: failing });
  const logged: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => logged.push(args.join(" "));
  try {
    await service.tick();
  } finally {
    console.warn = warn;
    service.dispose();
  }
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.includes(ADDRESS), false);
  assert.match(logged[0]!, /<address>/);
  assert.equal(names.pendingCount, 1);
});

test("config: off by default; dev REFUSES NODE_ENV=production; zcashd without address or RPC is disabled; mainnet addresses are refused", () => {
  const off = loadNameRegistryConfig({}, { rpcConfigured: false });
  assert.ok(off.ok && off.config.mode === "off");
  const prod = loadNameRegistryConfig({ NAME_REGISTRY: "dev", NODE_ENV: "production" }, { rpcConfigured: true });
  assert.ok(!prod.ok && /refusing to start/.test(prod.error));
  const dev = loadNameRegistryConfig({ NAME_REGISTRY: "dev" }, { rpcConfigured: false });
  assert.ok(dev.ok && dev.config.mode === "dev" && dev.config.address === NAME_DEV_ADDRESS && dev.config.file === null && dev.config.feeZat === 1_000_000);
  const noAddress = loadNameRegistryConfig({ NAME_REGISTRY: "zcashd" }, { rpcConfigured: true });
  assert.ok(noAddress.ok && noAddress.config.mode === "disabled" && noAddress.config.problem?.includes("NAME_REGISTRY_ADDRESS"));
  const noRpc = loadNameRegistryConfig({ NAME_REGISTRY: "zcashd", NAME_REGISTRY_ADDRESS: ADDRESS }, { rpcConfigured: false });
  assert.ok(noRpc.ok && noRpc.config.mode === "disabled");
  const full = loadNameRegistryConfig({ NAME_REGISTRY: "zcashd", NAME_REGISTRY_ADDRESS: ADDRESS, NAME_FEE_ZEC: "0.02" }, { rpcConfigured: true });
  assert.ok(full.ok && full.config.mode === "zcashd" && full.config.file === "./data/names.json" && full.config.feeZat === 2_000_000);
  assert.ok(!loadNameRegistryConfig({ NAME_REGISTRY: "zcashd", NAME_REGISTRY_ADDRESS: "u1" + "q".repeat(80) }, { rpcConfigured: true }).ok, "mainnet UA");
  assert.ok(!loadNameRegistryConfig({ NAME_REGISTRY: "yes" }, { rpcConfigured: true }).ok);
  assert.ok(!loadNameRegistryConfig({ NAME_REGISTRY: "dev", NAME_FEE_ZEC: "1" }, { rpcConfigured: true }).ok, "above the 0.1 ZEC cap");
  assert.equal(parseZecToZat("0.01"), 1_000_000);
  assert.equal(parseZecToZat("0.00000001"), 1);
  assert.equal(parseZecToZat("1e-2"), null);
});

test("createNameService: off and disabled have no registry; the service reports mode and fee, never the address", () => {
  const off = createNameService({ mode: "off", address: null, feeZat: FEE, file: null, devConfirmMs: 2000 }, { rpc: null });
  assert.deepEqual(off.info(), { mode: "off", feeZat: 0 });
  assert.equal(off.honourMode, true);
  const disabled = createNameService({ mode: "disabled", address: null, feeZat: FEE, file: null, devConfirmMs: 2000 }, { rpc: null });
  assert.deepEqual(disabled.info(), { mode: "disabled", feeZat: 0 });
  assert.equal(disabled.honourMode, false);
  const dev = createNameService({ mode: "dev", address: NAME_DEV_ADDRESS, feeZat: FEE, file: null, devConfirmMs: 2000 }, { rpc: null });
  assert.deepEqual(dev.info(), { mode: "fee", feeZat: FEE });
  assert.equal(JSON.stringify(dev.info()).includes(NAME_DEV_ADDRESS), false);
  dev.dispose();
});
