import { test } from "node:test";
import assert from "node:assert/strict";
import { createPaymentKeys, deriveSealKey, newRequestId, seal, securityCode, unseal } from "./paymentCrypto.ts";

test("both sides derive the same key; the address round-trips sealed", async () => {
  const requestId = newRequestId();
  assert.match(requestId, /^[A-Za-z0-9_-]{8,40}$/);
  const sender = await createPaymentKeys();
  const recipient = await createPaymentKeys();
  const atRecipient = await deriveSealKey(recipient, sender.publicKey, requestId);
  const atSender = await deriveSealKey(sender, recipient.publicKey, requestId);
  const box = await seal(atRecipient, { address: "uregtest1example" });
  assert.ok(!box.sealed.includes("uregtest"), "ciphertext does not contain the address");
  assert.deepEqual(await unseal(atSender, box.sealed, box.iv), { address: "uregtest1example" });
});

test("tampering, a different request id or a third party's key all fail to open", async () => {
  const requestId = newRequestId();
  const sender = await createPaymentKeys();
  const recipient = await createPaymentKeys();
  const eve = await createPaymentKeys();
  const key = await deriveSealKey(recipient, sender.publicKey, requestId);
  const box = await seal(key, { address: "x" });
  // Replace the 4th character from the end with a different one (choosing by that character, so it always changes).
  const flipped = box.sealed.slice(0, -4) + (box.sealed.at(-4) === "A" ? "B" : "A") + box.sealed.slice(-3);
  await assert.rejects(unseal(await deriveSealKey(sender, recipient.publicKey, requestId), flipped, box.iv));
  await assert.rejects(unseal(await deriveSealKey(sender, recipient.publicKey, newRequestId()), box.sealed, box.iv));
  await assert.rejects(unseal(await deriveSealKey(eve, recipient.publicKey, requestId), box.sealed, box.iv));
});

test("security codes match on both sides and differ when a key is swapped", async () => {
  const a = await createPaymentKeys();
  const b = await createPaymentKeys();
  const m = await createPaymentKeys();
  const code = await securityCode(a.publicKey, b.publicKey);
  assert.equal(code, await securityCode(a.publicKey, b.publicKey));
  assert.equal(code.split(" ").length, 4);
  assert.notEqual(code, await securityCode(a.publicKey, m.publicKey));
});

test("regtest addresses from the vendored (regtest) wallet build are recognised as shielded", async () => {
  process.env.VITE_ZCASH_NETWORK ??= "test";
  const { detectAddressKind, isShieldedKind } = await import("./core/wallet-types.ts");
  const ua = "uregtest1" + "q".repeat(120);
  assert.equal(detectAddressKind(ua), "unified");
  assert.ok(isShieldedKind(detectAddressKind("zregtestsapling1" + "q".repeat(70))));
  assert.equal(detectAddressKind("uregtest" + "q".repeat(120)), "unknown", "the separator is required");
});

test("txidToHex prints the transaction id the way explorers and RPC do (bytes reversed)", async () => {
  const { txidToHex } = await import("./core/wallet.ts");
  const raw = new Uint8Array(32);
  raw[0] = 0x90;
  raw[1] = 0x13;
  raw[31] = 0xd6;
  const hex = txidToHex(raw);
  assert.equal(hex.length, 64);
  assert.ok(hex.startsWith("d6"));
  assert.ok(hex.endsWith("1390"));
});
