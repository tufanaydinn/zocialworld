import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPayFeeMemo, PAY_FEE_DEADLINE_MS } from "@project/shared";
import { MAX_ENTRIES_PER_SENDER, MAX_UNSETTLED_MS, NU7_TX_EXPIRY_BLOCKS, TX_EXPIRY_BLOCKS, TransferFees, loadTransferFeeConfig, txExpiryBlocks, type TransferFeeConfig } from "../transferFees.js";
import type { ChainSource, RawTransaction } from "./lightwalletdClient.js";
import { ShieldedPaymentReader, helperDecrypt, projectNotes, type ReadResult } from "./shieldedPayments.js";
import { checkAddressAgainstKey, helperNetworkForAddress, loadTxDecryptHelper } from "./txDecrypt.js";

/**
 * ADR-018 § 6: the transfer-fee check.
 *  - REAL decryption: the wallet engine's regtest fixtures (vendor/zcash-tx-decrypt/test/fixtures/regtest-txs.json,
 *    produced by the Sapling-beta engine on a local NU6.3 chain) through the vendored helper and the server's reader —
 *    the project key sees ONLY the fee output of a player payment, never the recipient's.
 *  - The fee ledger with a fake reader: paid, short, wrong nonce, reused note, unmined → confirmed, no pay_sent within
 *    the deadline, cancelled, the verification window, a lightwalletd failure, per-session sanctions.
 */

interface Fixture {
  txs: { name: string; txid: string; height: number; rawTxHex: string }[];
  ufvks: Record<"A" | "B" | "C" | "PROJECT", string>;
  addresses: Record<"A" | "B" | "C" | "PROJECT", { unified: string; sapling: string; transparent: string }>;
}
const FIXTURE = JSON.parse(readFileSync(new URL("../../../../vendor/zcash-tx-decrypt/test/fixtures/regtest-txs.json", import.meta.url), "utf8")) as Fixture;
const tx = (name: string) => FIXTURE.txs.find((t) => t.name === name)!;

/** A chain that knows the fixtures (height as mined) and a tip. */
function fixtureChain(tip: number, overrides: Partial<Record<string, RawTransaction | null>> = {}): ChainSource {
  return {
    tipHeight: async () => tip,
    getTransaction: async (txid) => {
      if (txid in overrides) return overrides[txid] ?? null;
      const found = FIXTURE.txs.find((t) => t.txid === txid);
      return found ? { hex: found.rawTxHex, height: found.height } : null;
    },
  };
}

test("REAL decryption: the project's key sees only the fee output of a player payment (75,000 zat, zw-fee memo)", async () => {
  const helper = loadTxDecryptHelper();
  const payment = tx("payment");
  const reader = new ShieldedPaymentReader(fixtureChain(payment.height + 2), helperDecrypt(helper, "regtest", FIXTURE.ufvks.PROJECT));
  const result = await reader.read(payment.txid);
  assert.equal(result.status, "found");
  if (result.status !== "found") return;
  assert.equal(result.confirmations, 3);
  assert.equal(result.notes.length, 1, "only the fee output — the recipient's output is not decryptable with the project key");
  assert.equal(result.notes[0]!.amountZat, 75_000);
  assert.equal(result.notes[0]!.memo, "zw-fee:v1:n35afdd9d2d56");
  assert.match(result.notes[0]!.ref, new RegExp(`^${payment.txid}:sapling:\\d+$`));
  // The recipient (B) sees its own 100,000 zat output and memo with ITS key — the server never has that key.
  const asB = await new ShieldedPaymentReader(fixtureChain(payment.height), helperDecrypt(helper, "regtest", FIXTURE.ufvks.B)).read(payment.txid);
  assert.ok(asB.status === "found" && asB.notes.some((n) => n.amountZat === 100_000));
});

test("REAL decryption: the name fee decrypts with the registry key; a withdrawal or a shield shows nothing", async () => {
  const helper = loadTxDecryptHelper();
  const decrypt = helperDecrypt(helper, "regtest", FIXTURE.ufvks.PROJECT);
  const reader = new ShieldedPaymentReader(fixtureChain(200), decrypt);
  const nameFee = await reader.read(tx("nameFee").txid);
  assert.ok(nameFee.status === "found");
  assert.deepEqual(nameFee.notes.map((n) => [n.amountZat, n.memo]), [[75_000, "zw-name:v1:me5ba356e62:0123456789abcdef"]]);
  for (const other of ["withdrawal", "shield", "legacyPayment"]) {
    const result = await reader.read(tx(other).txid);
    assert.ok(result.status === "found" && result.notes.length === 0, other);
  }
  assert.deepEqual(await reader.read("00".repeat(32)), { status: "missing", tip: 200 }, "missing carries the tip");
  // A transaction the helper cannot decrypt is an answer ("no project note"), never an outage.
  const throwing = new ShieldedPaymentReader(fixtureChain(200), () => {
    throw new Error("malformed transaction");
  });
  assert.deepEqual(await throwing.read(tx("payment").txid), { status: "found", confirmations: 200 - tx("payment").height + 1, notes: [] });
});

test("REAL decryption: an unmined (mempool) transaction decrypts as of the next block with 0 confirmations", async () => {
  const payment = tx("payment");
  const chain = fixtureChain(150, { [payment.txid]: { hex: payment.rawTxHex, height: null } });
  const result = await new ShieldedPaymentReader(chain, helperDecrypt(loadTxDecryptHelper(), "regtest", FIXTURE.ufvks.PROJECT)).read(payment.txid);
  assert.ok(result.status === "found");
  assert.equal(result.confirmations, 0);
  assert.equal(result.notes.length, 1);
});

test("REAL decryption: the fee ledger sanctions a mined payment whose fee memo carries another nonce", async () => {
  const payment = tx("payment");
  const reader = new ShieldedPaymentReader(fixtureChain(payment.height + 1), helperDecrypt(loadTxDecryptHelper(), "regtest", FIXTURE.ufvks.PROJECT));
  const fees = new TransferFees({ config: { feeZat: 75_000, address: FIXTURE.addresses.PROJECT.unified, ufvk: FIXTURE.ufvks.PROJECT, minConfirmations: 1 }, reader, now: () => 0 });
  try {
    fees.quote("req-real-01", "sender");
    assert.ok(fees.reportSent("req-real-01", "sender", payment.txid));
    await fees.check();
    assert.equal(fees.isSanctioned("sender"), true, "the fixture's memo nonce is not this request's nonce");
  } finally {
    fees.dispose();
  }
});

test("startup check: an address must belong to its viewing key and have a Sapling receiver", () => {
  const helper = loadTxDecryptHelper();
  assert.equal(helperNetworkForAddress(FIXTURE.addresses.PROJECT.unified), "regtest");
  assert.equal(helperNetworkForAddress("u1" + "q".repeat(60)), "main");
  assert.equal(checkAddressAgainstKey(FIXTURE.addresses.PROJECT.unified, FIXTURE.ufvks.PROJECT, helper), null);
  assert.equal(checkAddressAgainstKey(FIXTURE.addresses.PROJECT.sapling, FIXTURE.ufvks.PROJECT, helper), null);
  assert.match(checkAddressAgainstKey(FIXTURE.addresses.B.unified, FIXTURE.ufvks.PROJECT, helper) ?? "", /does not belong/);
  assert.match(checkAddressAgainstKey(FIXTURE.addresses.PROJECT.transparent, FIXTURE.ufvks.PROJECT, helper) ?? "", /not a shielded/);
  assert.match(checkAddressAgainstKey(FIXTURE.addresses.PROJECT.unified, "uviewregtest1" + "q".repeat(120), helper) ?? "", /viewing key/);
});

// ------------------------------------------------------------------ the ledger with a fake reader

const CONFIG: TransferFeeConfig = { feeZat: 75_000, address: "zs1fee", ufvk: "uview1fee", minConfirmations: 1 };

function ledger(results: Map<string, ReadResult | Error>) {
  let t = 0;
  let tip = 1_000;
  const reads: string[] = [];
  let counter = 0;
  const fees = new TransferFees({
    config: CONFIG,
    reader: {
      read: async (txid) => {
        reads.push(txid);
        const result = results.get(txid) ?? { status: "missing", tip };
        if (result instanceof Error) throw result;
        return result;
      },
    },
    now: () => t,
    // Deterministic nonces: 16 bytes of the counter.
    randomBytes: (size) => new Uint8Array(size).fill(++counter),
    pollMs: 60_000,
  });
  // A block every 75 s, as on mainnet.
  return { fees, reads, advance: (ms: number) => ((t += ms), (tip += Math.floor(ms / 75_000))) };
}

const T1 = "a1".repeat(32);
const note = (memo: string, amountZat: number, ref = `${T1}:sapling:1`) => ({ ref, memo, amountZat, confirmations: 1 });

test("quote: one nonce per request; the same request asks again → the same quote; only its sender reports", () => {
  const { fees } = ledger(new Map());
  try {
    const quote = fees.quote("req-0001", "alice")!;
    assert.equal(quote.address, "zs1fee");
    assert.equal(quote.zat, 75_000);
    assert.match(quote.nonce, /^[0-9a-f]{32}$/);
    assert.deepEqual(fees.quote("req-0001", "alice"), quote);
    assert.equal(fees.quote("req-0001", "mallory"), null);
    assert.equal(fees.reportSent("req-0001", "mallory", T1), false, "only the request's sender");
    assert.equal(fees.reportSent("req-0001", "alice", "not-a-txid"), false);
    assert.equal(fees.reportSent("req-unknown", "alice", T1), false);
    assert.equal(fees.reportSent("req-0001", "alice", T1.toUpperCase()), true);
    assert.equal(fees.reportSent("req-0001", "alice", T1), false, "once");
  } finally {
    fees.dispose();
  }
});

test("a confirmed fee output with the nonce and at least the fee is accepted; the txid is dropped", async () => {
  const results = new Map<string, ReadResult | Error>();
  const { fees, reads } = ledger(results);
  try {
    const quote = fees.quote("req-0001", "alice")!;
    results.set(T1, { status: "found", confirmations: 1, notes: [note(buildPayFeeMemo(quote.nonce), 80_000)] });
    fees.reportSent("req-0001", "alice", T1);
    await fees.check();
    assert.equal(fees.isSanctioned("alice"), false);
    assert.equal(fees.pendingCount, 0, "settled: nothing (and no txid) is kept");
    await fees.check();
    assert.equal(reads.length, 1, "never read again");
  } finally {
    fees.dispose();
  }
});

test("a short fee, a wrong nonce, or a reused note → fee_unpaid for that sender only", async () => {
  const results = new Map<string, ReadResult | Error>();
  const { fees } = ledger(results);
  try {
    const q1 = fees.quote("req-0001", "short")!;
    const T2 = "b2".repeat(32);
    results.set(T2, { status: "found", confirmations: 3, notes: [note(buildPayFeeMemo(q1.nonce), 74_999, `${T2}:sapling:0`)] });
    fees.reportSent("req-0001", "short", T2);

    fees.quote("req-0002", "wrong")!;
    const T3 = "c3".repeat(32);
    results.set(T3, { status: "found", confirmations: 3, notes: [note(buildPayFeeMemo("ff".repeat(16)), 75_000, `${T3}:sapling:0`)] });
    fees.reportSent("req-0002", "wrong", T3);

    // The same fee note can settle one request only.
    const q3 = fees.quote("req-0003", "honest")!;
    const q4 = fees.quote("req-0004", "replayer")!;
    const T4 = "d4".repeat(32);
    results.set(T4, { status: "found", confirmations: 3, notes: [note(buildPayFeeMemo(q3.nonce), 75_000, `${T4}:sapling:0`), note(buildPayFeeMemo(q4.nonce), 75_000, `${T4}:sapling:0`)] });
    fees.reportSent("req-0003", "honest", T4);
    fees.reportSent("req-0004", "replayer", T4);

    await fees.check();
    assert.equal(fees.isSanctioned("short"), true);
    assert.equal(fees.isSanctioned("wrong"), true);
    assert.equal(fees.isSanctioned("honest"), false);
    assert.equal(fees.isSanctioned("replayer"), true, "a note already used is not accepted again");
  } finally {
    fees.dispose();
  }
});

test("unmined → waits; confirmed later → accepted. Never confirmed within the window → sanctioned", async () => {
  const results = new Map<string, ReadResult | Error>();
  const { fees, advance } = ledger(results);
  try {
    const quote = fees.quote("req-0001", "alice")!;
    results.set(T1, { status: "found", confirmations: 0, notes: [note(buildPayFeeMemo(quote.nonce), 75_000)] });
    fees.reportSent("req-0001", "alice", T1);
    await fees.check();
    assert.equal(fees.pendingCount, 1, "0 confirmations: still waiting");
    results.set(T1, { status: "found", confirmations: 1, notes: [note(buildPayFeeMemo(quote.nonce), 75_000)] });
    advance(75_000);
    await fees.check();
    assert.equal(fees.pendingCount, 0);
    assert.equal(fees.isSanctioned("alice"), false);

    fees.quote("req-0002", "bob");
    fees.reportSent("req-0002", "bob", "e5".repeat(32)); // a txid nobody knows
    await fees.check(); // the first "missing" answer records the tip
    advance(59 * 60_000);
    await fees.check();
    assert.equal(fees.isSanctioned("bob"), false, "inside the window");
    advance(2 * 60_000);
    await fees.check();
    assert.equal(fees.isSanctioned("bob"), true, "never found within 60 minutes, and the chain passed its expiry height");
  } finally {
    fees.dispose();
  }
});

test("'missing' from a stuck backend (the tip does not move past the expiry height) never sanctions", async () => {
  let t = 0;
  const fees = new TransferFees({ config: CONFIG, reader: { read: async () => ({ status: "missing", tip: 5_000 }) }, now: () => t, pollMs: 60_000 });
  try {
    fees.quote("req-stuck-01", "alice");
    fees.reportSent("req-stuck-01", "alice", T1);
    for (let minutes = 0; minutes < 5 * 60; minutes += 15) {
      t += 15 * 60_000;
      await fees.check();
    }
    assert.equal(fees.isSanctioned("alice"), false, "the backend never moved: no definitive answer");
    t += 2 * 60 * 60_000;
    await fees.check();
    assert.equal(fees.pendingCount, 0, "dropped without a sanction after MAX_UNSETTLED_MS");
    assert.equal(fees.isSanctioned("alice"), false);
  } finally {
    fees.dispose();
  }
});

test("no pay_sent within 30 minutes of acceptance → sanctioned; a cancelling notice owes nothing", async () => {
  const { fees, advance } = ledger(new Map());
  try {
    fees.quote("req-0001", "silent");
    fees.quote("req-0002", "canceller");
    fees.noticeRelayed("req-0002", "canceller");
    advance(PAY_FEE_DEADLINE_MS - 1);
    await fees.check();
    assert.equal(fees.isSanctioned("silent"), false);
    advance(2);
    await fees.check();
    assert.equal(fees.isSanctioned("silent"), true);
    assert.equal(fees.isSanctioned("canceller"), false);
    assert.equal(fees.pendingCount, 1, "the late entry is kept for the grace window");
    advance(61 * 60_000);
    await fees.check();
    assert.equal(fees.pendingCount, 0, "the grace window ended");
    assert.equal(fees.isSanctioned("silent"), true, "never paid: the sanction stays");
  } finally {
    fees.dispose();
  }
});

test("a valid fee reported AFTER the deadline lifts that request's sanction; another unpaid one keeps it", async () => {
  const results = new Map<string, ReadResult | Error>();
  const { fees, advance } = ledger(results);
  try {
    const late = fees.quote("req-late-01", "alice")!;
    fees.quote("req-late-02", "alice");
    advance(PAY_FEE_DEADLINE_MS + 15_000);
    await fees.check();
    assert.equal(fees.isSanctioned("alice"), true);
    // The send was started just before the deadline; pay_sent arrives after it.
    results.set(T1, { status: "found", confirmations: 1, notes: [note(buildPayFeeMemo(late.nonce), 75_000)] });
    assert.equal(fees.reportSent("req-late-01", "alice", T1), true, "a late pay_sent is still accepted for checking");
    await fees.check();
    assert.equal(fees.isSanctioned("alice"), true, "req-late-02 is still unpaid");
    fees.cancel("req-late-02", "alice"); // a late cancel owes nothing either
    assert.equal(fees.isSanctioned("alice"), false, "both lifted: one paid, one cancelled");
    assert.equal(fees.pendingCount, 0);
  } finally {
    fees.dispose();
  }
});

test("a sender session holds at most MAX_ENTRIES_PER_SENDER unsettled fee entries", () => {
  const { fees } = ledger(new Map());
  try {
    for (let i = 0; i < MAX_ENTRIES_PER_SENDER; i++) assert.ok(fees.quote(`req-many-${String(i).padStart(3, "0")}`, "mallory"));
    assert.equal(fees.quote("req-many-999", "mallory"), null, "no quote: the relay refuses the acceptance");
    assert.ok(fees.quote("req-other-01", "alice"), "other senders are unaffected");
    assert.ok(fees.quote("req-many-000", "mallory"), "asking again for an existing request still answers");
    fees.cancel("req-many-000", "mallory");
    assert.ok(fees.quote("req-many-998", "mallory"), "a cancel frees a slot");
  } finally {
    fees.dispose();
  }
});

test("a pay_notice after pay_sent does not cancel the check; a session that leaves takes its sanction with it", async () => {
  const results = new Map<string, ReadResult | Error>([[T1, { status: "found", confirmations: 2, notes: [] }]]);
  const { fees } = ledger(results);
  try {
    fees.quote("req-0001", "alice");
    fees.reportSent("req-0001", "alice", T1);
    fees.noticeRelayed("req-0001", "alice");
    assert.equal(fees.pendingCount, 1);
    await fees.check();
    assert.equal(fees.isSanctioned("alice"), true, "mined without any fee output");
    fees.forgetSession("alice");
    assert.equal(fees.isSanctioned("alice"), false, "per session: a new session starts clean");
  } finally {
    fees.dispose();
  }
});

test("a lightwalletd outage is retried (logged without the txid) and NEVER sanctions; a later confirmed read still accepts the fee", async () => {
  const results = new Map<string, ReadResult | Error>([[T1, new Error(`lightwalletd status 14: unavailable for ${T1}`)]]);
  const { fees, advance } = ledger(results);
  const logged: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => logged.push(args.join(" "));
  try {
    const quote = fees.quote("req-0001", "alice")!;
    fees.reportSent("req-0001", "alice", T1);
    await fees.check();
    assert.equal(fees.isSanctioned("alice"), false);
    assert.equal(logged.length, 1);
    assert.equal(logged[0]!.includes(T1), false, "the txid is never logged");
    advance(90 * 60_000); // an outage longer than the verification window
    await fees.check();
    assert.equal(fees.isSanctioned("alice"), false, "the server's outage is not the sender's fault");
    results.set(T1, { status: "found", confirmations: 40, notes: [note(buildPayFeeMemo(quote.nonce), 75_000)] });
    await fees.check();
    assert.equal(fees.pendingCount, 0, "the fee is accepted once lightwalletd answers");
    assert.equal(fees.isSanctioned("alice"), false);
    // An outage that never ends: dropped without a sanction after MAX_UNSETTLED_MS.
    fees.quote("req-0002", "bob");
    fees.reportSent("req-0002", "bob", "f6".repeat(32));
    results.set("f6".repeat(32), new Error("lightwalletd status 8: RESOURCE_EXHAUSTED"));
    advance(MAX_UNSETTLED_MS + 60_000);
    await fees.check();
    assert.equal(fees.pendingCount, 0);
    assert.equal(fees.isSanctioned("bob"), false);
  } finally {
    console.warn = warn;
    fees.dispose();
  }
});

test("projectNotes keeps incoming Sapling outputs with a text memo only", () => {
  const notes = projectNotes("AB".repeat(32), [
    { pool: "sapling", outputIndex: 0, valueZat: 75_000, memoText: "zw-fee:v1:x", memoHex: "", incoming: true, transferType: "incoming" },
    { pool: "sapling", outputIndex: 1, valueZat: 10, memoText: null, memoHex: "f6", incoming: true, transferType: "incoming" },
    { pool: "sapling", outputIndex: 2, valueZat: 5_000, memoText: "change", memoHex: "", incoming: false, transferType: "internal" },
    { pool: "orchard", outputIndex: 0, valueZat: 75_000, memoText: "zw-fee:v1:x", memoHex: "", incoming: true, transferType: "incoming" },
  ], 0);
  assert.deepEqual(notes, [{ ref: `${"ab".repeat(32)}:sapling:0`, memo: "zw-fee:v1:x", amountZat: 75_000, confirmations: 0 }]);
});

test("config: mainnet default fee needs the acknowledgement; the test chain is off unless set; limits and key files", () => {
  const base = { NAME_REGISTRY_ADDRESS: FIXTURE.addresses.PROJECT.unified, NAME_REGISTRY_UFVK: FIXTURE.ufvks.PROJECT };
  const noAck = loadTransferFeeConfig({ ...base }, { network: "main", lightwalletd: true });
  assert.ok(noAck.ok && noAck.config === null && /PAYMENT_FEE_MAINNET_ACK/.test(noAck.problem ?? ""));
  const main = loadTransferFeeConfig({ ...base, PAYMENT_FEE_MAINNET_ACK: "accepted" }, { network: "main", lightwalletd: true });
  assert.ok(main.ok && main.config !== null);
  assert.equal(main.ok && main.config?.feeZat, 75_000, "0.00075 ZEC ≈ US$1 (ADR-018 § 6)");
  assert.equal(main.ok && main.config?.address, FIXTURE.addresses.PROJECT.unified, "defaults to the registry's address");
  const test = loadTransferFeeConfig({ ...base }, { network: "test", lightwalletd: true });
  assert.ok(test.ok && test.config === null, "off on the test chain unless configured");
  const testOn = loadTransferFeeConfig({ ...base, PAYMENT_FEE_ZEC: "0.0001" }, { network: "test", lightwalletd: true });
  assert.ok(testOn.ok && testOn.config?.feeZat === 10_000);
  assert.equal(loadTransferFeeConfig({ ...base, PAYMENT_FEE_ZEC: "0.02" }, { network: "test", lightwalletd: true }).ok, false, "above PAY_FEE_MAX_ZAT");
  assert.equal(loadTransferFeeConfig({ ...base, PAYMENT_FEE_ZEC: "0.0001", PAYMENT_FEE_UFVK: "nope" }, { network: "test", lightwalletd: true }).ok, false);
  const noBridge = loadTransferFeeConfig({ ...base, PAYMENT_FEE_MAINNET_ACK: "accepted" }, { network: "main", lightwalletd: false });
  assert.ok(noBridge.ok && noBridge.config === null && /bridge/.test(noBridge.problem ?? ""));
  const off = loadTransferFeeConfig({ ...base, PAYMENT_FEE_ZEC: "off", PAYMENT_FEE_MAINNET_ACK: "accepted" }, { network: "main", lightwalletd: true });
  assert.ok(off.ok && off.config === null);
  const missingFile = loadTransferFeeConfig({ PAYMENT_FEE_ZEC: "0.0001", PAYMENT_FEE_ADDRESS: "zs1x", PAYMENT_FEE_UFVK_FILE: "/nonexistent/ufvk" }, { network: "test", lightwalletd: true });
  assert.ok(!missingFile.ok && /PAYMENT_FEE_UFVK_FILE/.test(missingFile.error) && !missingFile.error.includes("uview"));
});

test("the expiry wait is NU7-aware — 41 blocks before NU7, 121 near and after a known activation height", async () => {
  assert.equal(txExpiryBlocks(3_000_000, null), TX_EXPIRY_BLOCKS, "no NU7 height known: the pre-NU7 delta + 1");
  assert.equal(txExpiryBlocks(3_000_000, 3_100_000), TX_EXPIRY_BLOCKS, "far before activation");
  assert.equal(txExpiryBlocks(3_099_959, 3_100_000), NU7_TX_EXPIRY_BLOCKS, "within 41 blocks of activation: may carry the NU7 delta");
  assert.equal(txExpiryBlocks(3_100_500, 3_100_000), NU7_TX_EXPIRY_BLOCKS, "after activation");

  // A missing transaction after NU7 is not sanctioned when the tip has moved only past the OLD expiry.
  let t = 0;
  let tip = 3_200_000;
  const fees = new TransferFees({ config: CONFIG, reader: { read: async () => ({ status: "missing", tip }) }, now: () => t, pollMs: 60_000, nu7ActivationHeight: 3_100_000 });
  try {
    fees.quote("req-nu7-001", "alice");
    fees.reportSent("req-nu7-001", "alice", T1);
    await fees.check(); // first tip recorded: 3,200,000
    t += 61 * 60_000;
    tip = 3_200_000 + 60; // past 41, not past 121
    await fees.check();
    assert.equal(fees.isSanctioned("alice"), false, "NU7 expiry (120 blocks) not reached yet");
    tip = 3_200_000 + 121;
    t += 15 * 60_000;
    await fees.check();
    assert.equal(fees.isSanctioned("alice"), true, "past the NU7 expiry and the window: definitive");
  } finally {
    fees.dispose();
  }
});
