import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildNameMemo } from "@project/shared";
import { NameRegistry, noteHash, noteKeyForViewingKey, type NameUpdate } from "./nameRegistry.js";
import { LightwalletdNameScanner } from "./nameScanner.js";
import { MemoryNameStore } from "./nameStore.js";
import { NameService } from "./nameService.js";
import { loadNameRegistryConfig } from "./nameConfig.js";
import type { ReadResult } from "../zcash/shieldedPayments.js";
import { ShieldedPaymentReader, helperDecrypt } from "../zcash/shieldedPayments.js";
import { loadTxDecryptHelper } from "../zcash/txDecrypt.js";

/**
 * ADR-018 § 5: the `lightwalletd` name-registry backend — the paying client reports its txid
 * (`name_payment_sent`), each poll fetches and decrypts the reported transactions with the registry's viewing key, and
 * the registry's ADR-016 rules decide (nonce + key hash, amount ≥ fee, confirmations, each note once). Plus its
 * configuration: the mainnet acknowledgement, and "disabled" with a reason when something is missing.
 */

const FIXTURE = JSON.parse(readFileSync(new URL("../../../../vendor/zcash-tx-decrypt/test/fixtures/regtest-txs.json", import.meta.url), "utf8")) as {
  txs: { name: string; txid: string; height: number; rawTxHex: string }[];
  ufvks: Record<string, string>;
  addresses: Record<string, { unified: string; sapling: string }>;
};
const KEY = "a".repeat(64);
const FEE = 75_000;
const TXID = "4a".repeat(32);
const MAIN_UA = "u1" + "q".repeat(100);

function registry(now: () => number): NameRegistry {
  return new NameRegistry({ now, store: new MemoryNameStore(), address: MAIN_UA, feeZat: FEE, minConfirmations: 1 });
}

test("config: lightwalletd needs address + viewing key + bridge, and on mainnet the operator's acknowledgement", () => {
  const ufvk = FIXTURE.ufvks.PROJECT!;
  const full = { NAME_REGISTRY: "lightwalletd", NAME_REGISTRY_ADDRESS: MAIN_UA, NAME_REGISTRY_UFVK: "uview1" + "q".repeat(200) };
  const noAck = loadNameRegistryConfig(full, { rpcConfigured: false, network: "main", lightwalletd: true });
  assert.ok(noAck.ok && noAck.config.mode === "disabled" && /NAME_REGISTRY_MAINNET_ACK/.test(noAck.config.problem ?? ""));
  const ok = loadNameRegistryConfig({ ...full, NAME_REGISTRY_MAINNET_ACK: "accepted" }, { rpcConfigured: false, network: "main", lightwalletd: true });
  assert.ok(ok.ok && ok.config.mode === "lightwalletd");
  assert.equal(ok.ok && ok.config.feeZat, 75_000, "0.00075 ZEC on mainnet by default (≈ US$1)");
  assert.equal(ok.ok && ok.config.minConfirmations, 1);
  assert.equal(ok.ok && ok.config.file, "./data/names.json");
  const noKey = loadNameRegistryConfig({ NAME_REGISTRY: "lightwalletd", NAME_REGISTRY_ADDRESS: MAIN_UA, NAME_REGISTRY_MAINNET_ACK: "accepted" }, { rpcConfigured: false, network: "main", lightwalletd: true });
  assert.ok(noKey.ok && noKey.config.mode === "disabled" && /UFVK/.test(noKey.config.problem ?? ""));
  const noBridge = loadNameRegistryConfig({ ...full, NAME_REGISTRY_MAINNET_ACK: "accepted" }, { rpcConfigured: false, network: "main", lightwalletd: false });
  assert.ok(noBridge.ok && noBridge.config.mode === "disabled");
  assert.equal(loadNameRegistryConfig({ ...full, NAME_REGISTRY_ADDRESS: FIXTURE.addresses.PROJECT!.unified }, { rpcConfigured: false, network: "main", lightwalletd: true }).ok, false, "a test-chain address on mainnet");
  const test = loadNameRegistryConfig({ NAME_REGISTRY: "lightwalletd", NAME_REGISTRY_ADDRESS: FIXTURE.addresses.PROJECT!.unified, NAME_REGISTRY_UFVK: ufvk }, { rpcConfigured: false, network: "test", lightwalletd: true });
  assert.ok(test.ok && test.config.mode === "lightwalletd", "works on a test chain without an acknowledgement");
  assert.equal(test.ok && test.config.feeZat, 1_000_000, "0.01 on the test chain");
  assert.equal(loadNameRegistryConfig({ ...full, NAME_MIN_CONF: "-1" }, { rpcConfigured: false, network: "main", lightwalletd: true }).ok, false);
  // The other modes are unchanged for the test chain.
  assert.ok(loadNameRegistryConfig({ NAME_REGISTRY: "dev" }, { rpcConfigured: false }).ok);
});

test("scanner: only reported txids of PENDING reservations are read; at most three per reservation; malformed refused", async () => {
  const reads: string[] = [];
  const scanner = new LightwalletdNameScanner({ read: async (txid) => (reads.push(txid), { status: "missing" }) });
  assert.equal(scanner.report("r1", "not-a-txid"), false);
  assert.ok(scanner.report("r1", TXID.toUpperCase()));
  assert.ok(scanner.report("r1", TXID), "the same txid again is fine");
  assert.ok(scanner.report("r1", "1b".repeat(32)));
  assert.ok(scanner.report("r1", "1c".repeat(32)));
  assert.equal(scanner.report("r1", "1d".repeat(32)), false, "a fourth is refused");
  assert.ok(scanner.report("r2", "2a".repeat(32)));
  await scanner.scan([{ reservationId: "r1", memo: "m", amountZat: FEE, createdAt: 0 }]);
  assert.deepEqual(reads, [TXID, "1b".repeat(32), "1c".repeat(32)]);
  assert.equal(scanner.reportedCount, 1, "r2 is no longer pending: its txid is dropped");
});

test("a reported payment with the memo and the fee confirms the name: seen at 0 confirmations, confirmed at 1", async () => {
  let t = 0;
  const names = registry(() => t);
  const outcome = names.reserve("s1", "Nadia", KEY, () => false);
  assert.ok(outcome.ok);
  const memo = outcome.ok ? outcome.quote.memo : "";
  let result: ReadResult = { status: "missing" };
  const scanner = new LightwalletdNameScanner({ read: async () => result }, 60_000);
  const service = new NameService({ mode: "lightwalletd", registry: names, scanner });
  const delivered: NameUpdate[] = [];
  service.setListener((updates) => delivered.push(...updates));
  try {
    service.paymentSent("someone-else", outcome.ok ? outcome.quote.reservationId : "", TXID);
    assert.equal(scanner.reportedCount, 0, "only the reservation's own session may report");
    service.paymentSent("s1", outcome.ok ? outcome.quote.reservationId : "", TXID);
    assert.equal(scanner.reportedCount, 1);
    await service.tick();
    assert.equal(delivered.length, 0, "not on the chain yet");
    result = { status: "found", confirmations: 0, notes: [{ ref: `${TXID}:sapling:0`, memo, amountZat: FEE, confirmations: 0 }] };
    t = 1000;
    await service.tick();
    result = { status: "found", confirmations: 1, notes: [{ ref: `${TXID}:sapling:0`, memo, amountZat: FEE, confirmations: 1 }] };
    t = 80_000;
    await service.tick();
    assert.deepEqual(delivered.map((u) => (u.kind === "status" ? u.status : u.kind)), ["seen", "confirmed"]);
    assert.ok(names.isRegistered("nadia"));
  } finally {
    service.dispose();
  }
});

test("a reported txid goes when its reservation ends (confirmed or expired), even with nothing else pending", async () => {
  let t = 0;
  const names = registry(() => t);
  const outcome = names.reserve("s1", "Nadia", KEY, () => false);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  const memo = outcome.quote.memo;
  const scanner = new LightwalletdNameScanner({ read: async () => ({ status: "found", confirmations: 1, notes: [{ ref: `${TXID}:sapling:0`, memo, amountZat: FEE, confirmations: 1 }] }) }, 60_000);
  const service = new NameService({ mode: "lightwalletd", registry: names, scanner });
  try {
    service.paymentSent("s1", outcome.quote.reservationId, TXID);
    assert.equal(scanner.reportedCount, 1);
    await service.tick(); // confirms — and no other reservation is pending, so no later scan would prune
    assert.ok(names.isRegistered("nadia"));
    assert.equal(scanner.reportedCount, 0, "the txid is dropped with the reservation (IDENTITY_THREAT_MODEL § 12)");
    // Expiry: reported, never paid, the reservation runs out.
    const other = names.reserve("s2", "Bravo", "b".repeat(64), () => false);
    assert.ok(other.ok);
    if (!other.ok) return;
    const expiring = new NameService({ mode: "lightwalletd", registry: names, scanner: new LightwalletdNameScanner({ read: async () => ({ status: "missing" }) }, 60_000) });
    const expiringScanner = (expiring as unknown as { scanner: LightwalletdNameScanner }).scanner;
    expiring.paymentSent("s2", other.quote.reservationId, "5b".repeat(32));
    assert.equal(expiringScanner.reportedCount, 1);
    t = other.quote.expiresAt + 1;
    await expiring.tick();
    assert.equal(expiringScanner.reportedCount, 0, "expired: the txid goes too");
    expiring.dispose();
  } finally {
    service.dispose();
  }
});

test("with a viewing key the store keeps KEYED note hashes (v2), never the unkeyed v1 a public txid reverses", async () => {
  const store = new MemoryNameStore();
  const key = noteKeyForViewingKey("uview1" + "k".repeat(200));
  const names = new NameRegistry({ now: () => 0, store, address: MAIN_UA, feeZat: FEE, minConfirmations: 1, noteKey: key });
  const outcome = names.reserve("s1", "Nadia", KEY, () => false);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  const ref = `${TXID}:sapling:0`;
  names.processNotes([{ ref, memo: outcome.quote.memo, amountZat: FEE, confirmations: 1 }]);
  assert.ok(names.isRegistered("nadia"));
  const saved = store.load().usedNotes;
  assert.deepEqual(saved, [noteHash(ref, key)]);
  assert.notEqual(saved[0], noteHash(ref), "not sha256(prefix + txid:pool:index)");
  assert.notEqual(noteHash(ref, key), noteHash(ref, noteKeyForViewingKey("uview1" + "j".repeat(200))), "the key matters");
  // An old (v1) entry still protects its note from replay after the switch.
  const oldStore = new MemoryNameStore();
  oldStore.save({ names: [], usedNotes: [noteHash(`${"4b".repeat(32)}:sapling:0`)] });
  const upgraded = new NameRegistry({ now: () => 0, store: oldStore, address: MAIN_UA, feeZat: FEE, minConfirmations: 1, noteKey: key });
  const again = upgraded.reserve("s9", "Replay", "e".repeat(64), () => false);
  assert.ok(again.ok);
  if (!again.ok) return;
  upgraded.processNotes([{ ref: `${"4b".repeat(32)}:sapling:0`, memo: again.quote.memo, amountZat: FEE, confirmations: 1 }]);
  assert.equal(upgraded.isRegistered("replay"), false, "a note consumed under v1 is not reused");
});

test("a short payment or another key's memo does not confirm; a reused note confirms nothing twice", async () => {
  let t = 0;
  const names = registry(() => t);
  const a = names.reserve("s1", "Alpha", KEY, () => false);
  const b = names.reserve("s2", "Bravo", "b".repeat(64), () => false);
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  const notes = [
    { ref: `${TXID}:sapling:0`, memo: a.quote.memo, amountZat: FEE - 1, confirmations: 3 },
    { ref: `${TXID}:sapling:1`, memo: buildNameMemo(b.quote.memo.split(":")[2]!, "c".repeat(64)), amountZat: FEE, confirmations: 3 },
  ];
  const scanner = new LightwalletdNameScanner({ read: async () => ({ status: "found", confirmations: 3, notes }) }, 60_000);
  const service = new NameService({ mode: "lightwalletd", registry: names, scanner });
  try {
    service.paymentSent("s1", a.quote.reservationId, TXID);
    service.paymentSent("s2", b.quote.reservationId, TXID);
    await service.tick();
    assert.equal(names.isRegistered("alpha"), false, "74,999 zat < fee");
    assert.equal(names.isRegistered("bravo"), false, "the memo's key hash is not Bravo's");
  } finally {
    service.dispose();
  }
});

test("REAL decryption: the registry key reads the name-fee fixture through the scanner (its memo is the harness's, so no reservation matches)", async () => {
  const fixture = FIXTURE.txs.find((tx) => tx.name === "nameFee")!;
  const reader = new ShieldedPaymentReader(
    { tipHeight: async () => fixture.height + 1, getTransaction: async (txid) => (txid === fixture.txid ? { hex: fixture.rawTxHex, height: fixture.height } : null) },
    helperDecrypt(loadTxDecryptHelper(), "regtest", FIXTURE.ufvks.PROJECT!),
  );
  const scanner = new LightwalletdNameScanner(reader);
  scanner.report("r1", fixture.txid);
  const notes = await scanner.scan([{ reservationId: "r1", memo: "x", amountZat: FEE, createdAt: 0 }]);
  assert.deepEqual(notes.map((n) => [n.amountZat, n.memo, n.confirmations]), [[75_000, "zw-name:v1:me5ba356e62:0123456789abcdef", 2]]);
  const names = registry(() => 0);
  names.reserve("s1", "Nadia", KEY, () => false);
  names.processNotes(notes);
  assert.equal(names.isRegistered("nadia"), false, "the harness memo's nonce is not a server nonce: ignored, never a crash");
});
