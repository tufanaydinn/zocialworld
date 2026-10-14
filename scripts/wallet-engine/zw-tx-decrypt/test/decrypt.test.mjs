// Node tests for zw-tx-decrypt 0.2 (ADR-018 § 5/§ 6, Stage 2), run with: node --test test/
// Fixtures (real transactions fetched from a local zebrad regtest chain, NU6.3 active from height 1,
// regtest test keys only):
//   test/fixtures/regtest-ironwood-txs.json  made by the Stage-2 (Ironwood) engine: v6, Ironwood bundles
//   test/fixtures/regtest-txs.json           made by the Stage-1 (Sapling beta) engine: v5, Sapling only
// The server must decrypt both: Stage-1 payments stay valid, Stage-2 payments put the fee output in
// the Ironwood pool when the fee address has an Orchard-family receiver.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const h = require(process.env.ZW_TX_DECRYPT_PKG ?? "../pkg/zw_tx_decrypt.js");
const load = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const iw = load("regtest-ironwood-txs.json"); // Stage 2
const s1 = load("regtest-txs.json"); // Stage 1
const txOf = (fx) => (name) => {
  const t = fx.txs.find((x) => x.name === name);
  assert.ok(t, `fixture ${name}`);
  return t;
};
const tx = txOf(iw);
const tx1 = txOf(s1);
const dec = (fx, t, who) => h.decryptTransaction(t.rawTxHex, t.height, "regtest", fx.ufvks[who]);
const pick = (o) => ({ pool: o.pool, valueZat: o.valueZat, memoText: o.memoText, incoming: o.incoming });
const X = iw.expected;

// ------------------------------------------------------------------------------- Stage 2 (Ironwood)

test("stage 2: every transaction is v6 on the NU6.3 branch, Sapling/Ironwood only, no Orchard or Sprout bundle", () => {
  assert.ok(iw.txs.length >= 10);
  for (const t of iw.txs) {
    const s = h.inspectTransaction(t.rawTxHex, t.height, "regtest");
    assert.equal(s.txid, t.txid, t.name);
    assert.equal(s.version, "V6", t.name);
    assert.equal(s.consensusBranchId, "37a5165b", t.name);
    assert.equal(s.hasOrchardBundle, false, t.name); // no legacy Orchard notes exist on this chain
    assert.equal(s.hasSproutBundle, false, t.name);
    if (t.name !== "texStep2") assert.equal(s.hasIronwoodBundle, true, t.name); // payments always carry Ironwood (change)
  }
});

test("stage 2: transaction shapes (shield, payments, withdrawals, the TEX pair)", () => {
  const shape = (n) => h.inspectTransaction(tx(n).rawTxHex, tx(n).height, "regtest");
  const shield = shape("shield");
  assert.equal(shield.transparentInputs, 3);
  assert.equal(shield.transparentOutputs, 0);
  assert.equal(shield.saplingSpends + shield.saplingOutputs, 0);
  assert.ok(shield.ironwoodActions >= 2);
  const pay = shape("ironwoodPayment");
  assert.equal(pay.transparentInputs + pay.transparentOutputs + pay.saplingSpends + pay.saplingOutputs, 0);
  assert.ok(pay.ironwoodActions >= 2);
  const sfee = shape("paymentSaplingFee");
  assert.ok(sfee.saplingOutputs >= 1 && sfee.ironwoodActions >= 2);
  const w = shape("withdrawalT");
  assert.equal(w.transparentInputs, 0);
  assert.equal(w.transparentOutputs, 1);
  const t1 = shape("texStep1"), t2 = shape("texStep2");
  assert.equal(t1.transparentOutputs, 1); // the one-time ("ephemeral") address of the wallet
  assert.equal(t2.transparentInputs, 1);
  assert.equal(t2.transparentOutputs, 1); // -> the TEX address's P2PKH
  assert.equal(t2.hasIronwoodBundle || t2.saplingSpends > 0 || t2.saplingOutputs > 0, false); // ZIP 320: transparent-only
  assert.equal(tx("texStep1").height, tx("texStep2").height);
});

test("stage 2 player payment: the project key decrypts ONLY the fee output — an IRONWOOD output with amount and nonce memo", () => {
  const outs = dec(iw, tx("ironwoodPayment"), "PROJECT");
  assert.deepEqual(outs.map(pick), [{ pool: "ironwood", valueZat: X.ironwoodPayment.fee, memoText: X.ironwoodPayment.memoFee, incoming: true }]);
  assert.equal(outs[0].transferType, "incoming");
  assert.match(outs[0].memoText, /^zw-fee:v1:[0-9a-z]+$/);
  assert.equal(Buffer.from(outs[0].memoHex, "hex").toString("utf8"), outs[0].memoText);
  assert.ok(Number.isInteger(outs[0].outputIndex) && outs[0].outputIndex >= 0);
});

test("stage 2 player payment: the recipient sees its Ironwood output and memo; the project cannot", () => {
  const t = tx("ironwoodPayment");
  const a = dec(iw, t, "A").filter((o) => o.incoming);
  assert.deepEqual(a.map(pick), [{ pool: "ironwood", valueZat: X.ironwoodPayment.toA, memoText: X.ironwoodPayment.memoA, incoming: true }]);
  const project = dec(iw, t, "PROJECT");
  assert.ok(!project.some((o) => o.valueZat === X.ironwoodPayment.toA), "project must not see A's output");
  assert.ok(!project.some((o) => o.outputIndex === a[0].outputIndex), "different action");
  assert.deepEqual(dec(iw, t, "C"), []);
});

test("stage 2: the payer's own key sees both payments as outgoing and its change as internal, never incoming", () => {
  const b = dec(iw, tx("ironwoodPayment"), "B");
  assert.ok(b.some((o) => o.transferType === "outgoing" && o.valueZat === X.ironwoodPayment.toA && o.pool === "ironwood"));
  assert.ok(b.some((o) => o.transferType === "outgoing" && o.valueZat === X.ironwoodPayment.fee && o.memoText === X.ironwoodPayment.memoFee));
  assert.ok(b.some((o) => o.transferType === "internal" && o.pool === "ironwood"));
  assert.ok(b.every((o) => !o.incoming));
});

test("stage 2 payment to the Stage-1 registry address (Sapling + t UA): the fee output is a SAPLING output", () => {
  const t = tx("paymentSaplingFee");
  assert.deepEqual(dec(iw, t, "PROJECT").map(pick), [{ pool: "sapling", valueZat: X.paymentSaplingFee.fee, memoText: X.paymentSaplingFee.memoFee, incoming: true }]);
  assert.ok(dec(iw, t, "A").some((o) => o.incoming && o.pool === "ironwood" && o.valueZat === X.paymentSaplingFee.toA));
});

test("stage 2 name fee: one Ironwood output to the registry, decrypted with the registry key", () => {
  const outs = dec(iw, tx("nameFee"), "PROJECT");
  assert.deepEqual(outs.map(pick), [{ pool: "ironwood", valueZat: X.nameFee.toProject, memoText: X.nameFee.memo, incoming: true }]);
  assert.match(outs[0].memoText, /^zw-name:v1:[0-9a-z]+:[0-9a-f]{16}$/);
});

test("stage 2: a payment to an Orchard-only u1 arrives as Ironwood", () => {
  assert.deepEqual(dec(iw, tx("orchardOnlyUa"), "PROJECT").map(pick), [{ pool: "ironwood", valueZat: X.orchardOnlyUa.toProject, memoText: X.orchardOnlyUa.memo, incoming: true }]);
});

test("stage 2: Ironwood -> zs1 is a Sapling output; Sapling notes -> u1 is an Ironwood output with Ironwood change", () => {
  assert.deepEqual(dec(iw, tx("ironwoodToSapling"), "C").map(pick), [{ pool: "sapling", valueZat: X.ironwoodToSapling.toC, memoText: X.ironwoodToSapling.memo, incoming: true }]);
  const s2i = tx("saplingToIronwood");
  assert.deepEqual(dec(iw, s2i, "A").map(pick), [{ pool: "ironwood", valueZat: X.saplingToIronwood.toA, memoText: X.saplingToIronwood.memo, incoming: true }]);
  const c = dec(iw, s2i, "C");
  assert.ok(c.length > 0 && c.every((o) => o.pool === "ironwood" && o.transferType === "internal"));
  assert.ok(h.inspectTransaction(s2i.rawTxHex, s2i.height, "regtest").saplingSpends >= 1);
});

test("stage 2 shielding: the wallet's own key sees the shielded value as internal Ironwood notes", () => {
  const a = dec(iw, tx("shield"), "A");
  assert.ok(a.length > 0);
  assert.ok(a.every((o) => o.pool === "ironwood" && o.transferType === "internal" && !o.incoming));
});

test("stage 2: withdrawals, the shielding and the legacy path pay the registry nothing", () => {
  for (const name of ["shield", "withdrawalT", "texStep1", "texStep2", "legacyPayment", "ironwoodToSapling", "saplingToIronwood"]) {
    assert.deepEqual(dec(iw, tx(name), "PROJECT"), [], name);
  }
  assert.deepEqual(dec(iw, tx("legacyPayment"), "B").filter((o) => o.incoming).map(pick), [{ pool: "ironwood", valueZat: X.legacyPayment.toB, memoText: X.legacyPayment.memo, incoming: true }]);
});

test("registry keys: the engine's five encodings — full UA, shielded UA, Stage-1 UA, zs1, t-address", () => {
  // The fixture's project key yields exactly the addresses the Stage-2 engine showed for that account.
  const p = h.addressesFromUfvk(iw.ufvks.PROJECT, "regtest");
  const e = iw.addresses.PROJECT;
  assert.deepEqual(p, { unifiedAddress: e.unified, unifiedShieldedAddress: e.unifiedShielded, unifiedSaplingTransparentAddress: e.unifiedSaplingTransparent, saplingAddress: e.sapling, transparentAddress: e.transparent, diversifierIndex: e.diversifierIndex });
  for (const who of ["A", "B", "C"]) {
    const k = h.addressesFromUfvk(iw.ufvks[who], "regtest");
    assert.equal(k.unifiedAddress, iw.addresses[who].unified, who);
    assert.equal(k.unifiedShieldedAddress, iw.addresses[who].unifiedShielded, who);
    assert.equal(k.unifiedSaplingTransparentAddress, iw.addresses[who].unifiedSaplingTransparent, who);
  }
  // Throwaway BIP-39 test vector (all-zero entropy); holds no funds.
  const seed = "abandon ".repeat(23) + "art";
  for (const [net, ua, zs, t] of [["main", "u1", "zs1", "t1"], ["test", "utest1", "ztestsapling1", "tm"], ["regtest", "uregtest1", "zregtestsapling1", "tm"]]) {
    const k = h.registryKeysFromSeed(seed, net, 0);
    assert.ok(k.unifiedAddress.startsWith(ua) && k.unifiedShieldedAddress.startsWith(ua) && k.unifiedSaplingTransparentAddress.startsWith(ua), net);
    assert.ok(k.saplingAddress.startsWith(zs) && k.transparentAddress.startsWith(t), net);
    assert.ok(k.ufvk.startsWith(net === "main" ? "uview1" : net === "test" ? "uviewtest1" : "uviewregtest1"), net);
    const recv = (a) => { const i = h.describeAddress(a); assert.equal(i.network, net); assert.equal(i.kind, "unified"); return [...i.receivers].sort(); };
    assert.deepEqual(recv(k.unifiedAddress), ["orchard", "p2pkh", "sapling"], net);
    assert.deepEqual(recv(k.unifiedShieldedAddress), ["orchard", "sapling"], net);
    assert.deepEqual(recv(k.unifiedSaplingTransparentAddress), ["p2pkh", "sapling"], net);
    const full = h.describeAddress(k.unifiedAddress);
    assert.ok(full.hasOrchard && full.hasSapling && full.hasTransparent, net);
    const { ufvk, ...addrs } = k;
    assert.deepEqual(h.addressesFromUfvk(ufvk, net), addrs, net);
  }
});

test("buildInfo names the Stage-2 engine and the pinned revisions", () => {
  const b = h.buildInfo();
  assert.match(b, /Stage 2/);
  assert.match(b, /librustzcash 0a2c6d1ae6274e6af2291e312f7b7459516882f2/);
  assert.match(b, /orchard 3bd2b736d1273226595773265313fc3f3428af16/);
  assert.match(b, /37a5165b/);
});

// ------------------------------------------------------------------------- Stage 1 (still accepted)

test("stage 1 transactions (v5, Sapling only) still parse and decrypt", () => {
  assert.ok(s1.txs.length >= 4);
  for (const t of s1.txs) {
    const s = h.inspectTransaction(t.rawTxHex, t.height, "regtest");
    assert.equal(s.txid, t.txid, t.name);
    assert.equal(s.version, "V5", t.name);
    assert.equal(s.consensusBranchId, "37a5165b", t.name);
    assert.equal(s.hasOrchardBundle || s.hasIronwoodBundle || s.hasSproutBundle, false, t.name);
  }
  const outs = dec(s1, tx1("payment"), "PROJECT");
  assert.deepEqual(outs.map(pick), s1.expected.payment.projectSees);
  assert.equal(outs[0].pool, "sapling");
  assert.deepEqual(dec(s1, tx1("payment"), "B").filter((o) => o.incoming).map(pick), s1.expected.payment.bSees);
  assert.deepEqual(dec(s1, tx1("nameFee"), "PROJECT").map(pick), s1.expected.nameFee.projectSees);
  for (const name of ["withdrawal", "shield"]) assert.deepEqual(dec(s1, tx1(name), "PROJECT"), [], name);
  // The Stage-1 fixture's registry address is the key's Sapling + transparent UA.
  assert.equal(h.addressesFromUfvk(s1.ufvks.PROJECT, "regtest").unifiedSaplingTransparentAddress, s1.addresses.PROJECT.unified);
});

// ---------------------------------------------------------------------------------------- errors

test("errors carry stable codes and never echo a seed", () => {
  const t = tx("ironwoodPayment");
  const code = (fn) => { try { fn(); return null; } catch (e) { return [e.code, e.message]; } };
  assert.equal(code(() => h.registryKeysFromSeed("correct horse battery staple", "main", 0))[0], "invalid_seed_phrase");
  assert.ok(!code(() => h.registryKeysFromSeed("correct horse battery staple", "main", 0))[1].includes("horse"));
  assert.equal(code(() => h.registryKeysFromSeed("abandon ".repeat(23) + "art", "main", 2 ** 31))[0], "invalid_account");
  assert.equal(code(() => h.decryptTransaction("zz", 1, "regtest", iw.ufvks.PROJECT))[0], "invalid_hex");
  assert.equal(code(() => h.decryptTransaction(t.rawTxHex, 0, "regtest", iw.ufvks.PROJECT))[0], "invalid_height");
  assert.equal(code(() => h.decryptTransaction(t.rawTxHex + "00", t.height, "regtest", iw.ufvks.PROJECT))[0], "invalid_transaction");
  assert.equal(code(() => h.decryptTransaction(t.rawTxHex, t.height, "regtest", "uview1xyz"))[0], "invalid_ufvk");
  assert.equal(code(() => h.decryptTransaction(t.rawTxHex, t.height, "mainnet2", iw.ufvks.PROJECT))[0], "invalid_network");
  // A regtest key does not decode as a mainnet key.
  assert.equal(code(() => h.decryptTransaction(t.rawTxHex, t.height, "main", iw.ufvks.PROJECT))[0], "invalid_ufvk");
  assert.equal(code(() => h.describeAddress("u1notanaddress"))[0], "invalid_address");
});
