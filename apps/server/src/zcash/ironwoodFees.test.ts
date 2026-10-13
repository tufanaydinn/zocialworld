import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPayFeeMemo } from "@project/shared";
import { TransferFees } from "../transferFees.js";
import type { ChainSource } from "./lightwalletdClient.js";
import { PROJECT_NOTE_POOLS, ShieldedPaymentReader, helperDecrypt, projectNotes, type ReadResult } from "./shieldedPayments.js";
import { checkAddressAgainstKey, keyShieldedAddresses, loadTxDecryptHelper, type DecryptedOutput } from "./txDecrypt.js";

/**
 * ADR-018 § 3, Stage 2: the server's fee and name checks with the Stage 2 wallet.
 *  - REAL decryption of transactions the Stage-2 (Ironwood) engine produced on a local NU6.3 chain
 *    (vendor/zcash-tx-decrypt/test/fixtures/regtest-ironwood-txs.json, regtest keys only) through the vendored
 *    zw-tx-decrypt 0.2 and the server's reader: a fee or name-fee output paid to the registry's shielded or full
 *    unified address is an IRONWOOD output, and it counts (a reader that accepted Sapling only would never see a fee
 *    paid that way);
 *  - the startup check accepts every one of the key's shielded addresses (the full UA scripts/tools/registry-keys.mjs
 *    prints, the shielded UA, the Stage 1 UA, the zs1) and still refuses the t1 and another key's address.
 */

interface IronwoodFixture {
  txs: { name: string; txid: string; height: string; rawTxHex: string }[];
  ufvks: Record<"A" | "B" | "C" | "PROJECT", string>;
  addresses: Record<"A" | "B" | "C" | "PROJECT", { unified: string; unifiedShielded: string; unifiedSaplingTransparent: string; sapling: string; transparent: string }>;
  feeNonce: string;
  nameMemo: string;
  expected: Record<string, Record<string, unknown>>;
}
const IW = JSON.parse(readFileSync(new URL("../../../../vendor/zcash-tx-decrypt/test/fixtures/regtest-ironwood-txs.json", import.meta.url), "utf8")) as IronwoodFixture;
const iw = (name: string) => {
  const found = IW.txs.find((t) => t.name === name);
  assert.ok(found, `fixture transaction ${name}`);
  return { ...found, height: Number(found.height) };
};

function chain(tip: number): ChainSource {
  return {
    tipHeight: async () => tip,
    getTransaction: async (txid) => {
      const found = IW.txs.find((t) => t.txid === txid);
      return found ? { hex: found.rawTxHex, height: Number(found.height) } : null;
    },
  };
}

const projectReader = (tip: number) => new ShieldedPaymentReader(chain(tip), helperDecrypt(loadTxDecryptHelper(), "regtest", IW.ufvks.PROJECT));

test("helper 0.2 is vendored: Stage-2 build info, five addresses per key", () => {
  const helper = loadTxDecryptHelper();
  assert.match(helper.buildInfo(), /^zw-tx-decrypt 0\.2\.0 \(Stage 2/);
  const own = helper.addressesFromUfvk(IW.ufvks.PROJECT, "regtest");
  assert.equal(own.unifiedAddress, IW.addresses.PROJECT.unified, "unifiedAddress is the FULL UA (= the engine's get_addresses().unified)");
  assert.equal(own.unifiedShieldedAddress, IW.addresses.PROJECT.unifiedShielded);
  assert.equal(own.unifiedSaplingTransparentAddress, IW.addresses.PROJECT.unifiedSaplingTransparent);
  assert.equal(own.saplingAddress, IW.addresses.PROJECT.sapling);
  const full = helper.describeAddress(own.unifiedAddress);
  assert.ok(full.hasOrchard && full.hasSapling && full.hasTransparent, "full UA: orchard + sapling + p2pkh");
  const shielded = helper.describeAddress(own.unifiedShieldedAddress);
  assert.ok(shielded.hasOrchard && shielded.hasSapling && !shielded.hasTransparent, "shielded UA: no transparent receiver");
});

test("REAL Ironwood fee output: the project key reads ONLY the fee output of a Stage-2 player payment, pool ironwood", async () => {
  const payment = iw("ironwoodPayment");
  const expected = IW.expected.ironwoodPayment!;
  const result = await projectReader(payment.height + 1).read(payment.txid);
  assert.equal(result.status, "found");
  if (result.status !== "found") return;
  assert.equal(result.confirmations, 2);
  assert.equal(result.notes.length, 1, "the recipient's Ironwood output is not decryptable with the project key");
  assert.equal(result.notes[0]!.amountZat, expected.fee);
  assert.equal(result.notes[0]!.memo, expected.memoFee);
  assert.equal(result.notes[0]!.memo, buildPayFeeMemo(IW.feeNonce));
  assert.match(result.notes[0]!.ref, new RegExp(`^${payment.txid}:ironwood:\\d+$`), "the note's pool is part of its single-use key");
});

test("REAL Ironwood name fee: the registry key reads the name-fee memo and amount from an Ironwood output", async () => {
  const nameFee = iw("nameFee");
  const result = await projectReader(nameFee.height).read(nameFee.txid);
  assert.ok(result.status === "found");
  assert.deepEqual(result.notes.map((n) => [n.amountZat, n.memo, n.ref.split(":")[1]]), [[IW.expected.nameFee!.toProject, IW.nameMemo, "ironwood"]]);
});

test("REAL mixed policy: a Sapling fee output (Stage-1 registry address) still counts; withdrawals, TEX and shields pay the project nothing", async () => {
  const reader = projectReader(200);
  const saplingFee = await reader.read(iw("paymentSaplingFee").txid);
  assert.ok(saplingFee.status === "found" && saplingFee.notes.length === 1 && saplingFee.notes[0]!.ref.includes(":sapling:"), "Sapling fee output");
  for (const name of ["shield", "withdrawalT", "texStep1", "texStep2", "ironwoodToSapling", "saplingToIronwood", "smallShield"]) {
    const result = await reader.read(iw(name).txid);
    assert.ok(result.status === "found" && result.notes.length === 0, name);
  }
  // The Orchard-only UA case (the project paid on its Orchard-only address): Ironwood, counted.
  const orchardOnly = await reader.read(iw("orchardOnlyUa").txid);
  assert.ok(orchardOnly.status === "found" && orchardOnly.notes.length === 1 && orchardOnly.notes[0]!.ref.includes(":ironwood:"));
});

test("projectNotes: incoming Sapling and Ironwood notes with a memo; never outgoing/internal views or legacy Orchard", () => {
  assert.deepEqual([...PROJECT_NOTE_POOLS].sort(), ["ironwood", "sapling"]);
  const out = (pool: DecryptedOutput["pool"], extra: Partial<DecryptedOutput> = {}): DecryptedOutput => ({ pool, outputIndex: 1, valueZat: 75_000, memoText: "zw-fee:v1:x", memoHex: "", incoming: true, transferType: "incoming", ...extra });
  const txid = "ab".repeat(32);
  const notes = projectNotes(txid, [
    out("ironwood"),
    out("sapling", { outputIndex: 2 }),
    out("orchard", { outputIndex: 3 }), // withdraw-only pool since NU6.3: nothing new arrives there
    out("ironwood", { outputIndex: 4, incoming: false, transferType: "outgoing" }),
    out("ironwood", { outputIndex: 5, incoming: false, transferType: "internal" }),
    out("ironwood", { outputIndex: 6, memoText: null }),
    out("ironwood", { outputIndex: 7, valueZat: 0 }),
  ], 3);
  assert.deepEqual(notes.map((n) => n.ref), [`${txid}:ironwood:1`, `${txid}:sapling:2`]);
});

test("the fee ledger accepts an Ironwood fee note with the request's nonce (and only once)", async () => {
  const txid = "c3".repeat(32);
  const results = new Map<string, ReadResult>();
  let counter = 0;
  const fees = new TransferFees({
    config: { feeZat: 75_000, address: IW.addresses.PROJECT.unified, ufvk: IW.ufvks.PROJECT, minConfirmations: 1 },
    reader: { read: async (t) => results.get(t) ?? { status: "missing", tip: 1 } },
    now: () => 0,
    randomBytes: (size) => new Uint8Array(size).fill(++counter),
    pollMs: 60_000,
  });
  try {
    const quote = fees.quote("req-iw-0001", "alice")!;
    assert.equal(quote.address, IW.addresses.PROJECT.unified, "the quote carries the registry's FULL unified address");
    results.set(txid, { status: "found", confirmations: 1, notes: [{ ref: `${txid}:ironwood:4`, memo: buildPayFeeMemo(quote.nonce), amountZat: 75_000, confirmations: 1 }] });
    assert.ok(fees.reportSent("req-iw-0001", "alice", txid));
    await fees.check();
    assert.equal(fees.isSanctioned("alice"), false);
    assert.equal(fees.pendingCount, 0);
    // The same Ironwood note reported for another request is a reuse: sanctioned.
    const second = fees.quote("req-iw-0002", "alice")!;
    results.set(txid, { status: "found", confirmations: 1, notes: [{ ref: `${txid}:ironwood:4`, memo: buildPayFeeMemo(second.nonce), amountZat: 75_000, confirmations: 1 }] });
    assert.ok(fees.reportSent("req-iw-0002", "alice", txid));
    await fees.check();
    assert.equal(fees.isSanctioned("alice"), true, "each note is accepted once");
  } finally {
    fees.dispose();
  }
});

test("startup check (helper 0.2): every one of the key's shielded addresses is accepted; t1 and other keys are refused", () => {
  const helper = loadTxDecryptHelper();
  const p = IW.addresses.PROJECT;
  assert.deepEqual(keyShieldedAddresses(helper.addressesFromUfvk(IW.ufvks.PROJECT, "regtest")).sort(), [p.unified, p.unifiedShielded, p.unifiedSaplingTransparent, p.sapling].sort());
  for (const address of [p.unified, p.unifiedShielded, p.unifiedSaplingTransparent, p.sapling]) {
    assert.equal(checkAddressAgainstKey(address, IW.ufvks.PROJECT, helper), null, address.slice(0, 12));
  }
  assert.match(checkAddressAgainstKey(p.transparent, IW.ufvks.PROJECT, helper) ?? "", /not a shielded/);
  assert.match(checkAddressAgainstKey(IW.addresses.B.unified, IW.ufvks.PROJECT, helper) ?? "", /does not belong/);
  assert.match(checkAddressAgainstKey(IW.addresses.B.unifiedShielded, IW.ufvks.PROJECT, helper) ?? "", /does not belong/);
});
