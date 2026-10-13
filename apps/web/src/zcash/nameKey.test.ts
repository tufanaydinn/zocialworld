import { test } from "node:test";
import assert from "node:assert/strict";
import { mnemonicToSeedSync } from "@scure/bip39";
import { activateNameKeyFromMnemonic, activateNameKeyFromSeed, activeNameKey, clearNameKey, deriveNameKey, nameKeyInfo, subscribeToNameKey } from "./nameKey.ts";

/**
 * ADR-016 § 1: the name key — deterministic from the wallet seed, domain-separated per network (and
 * from every other key), different seeds → different keys, Ed25519 by default with the P-256 fallback, and a key
 * hash that is SHA-256 of the raw public key. Signatures verify with plain WebCrypto (what the server does).
 */

const MNEMONIC_A = "abandon ".repeat(23) + "art";
const MNEMONIC_B = "zoo ".repeat(23) + "vote";
const seedA = mnemonicToSeedSync(MNEMONIC_A);
const seedB = mnemonicToSeedSync(MNEMONIC_B);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))).toString("hex");
}

test("the info string is zocial-world/name-key/v1/<network>", () => {
  assert.equal(nameKeyInfo("test"), "zocial-world/name-key/v1/test");
});

for (const alg of ["ed25519", "p256"] as const) {
  test(`${alg}: the same seed gives the same key (determinism); keyHash = SHA-256(raw public key)`, async () => {
    const a1 = await deriveNameKey(seedA, "test", { alg });
    const a2 = await deriveNameKey(new Uint8Array(seedA), "test", { alg });
    assert.equal(a1.alg, alg);
    assert.equal(a1.publicKey, a2.publicKey);
    assert.equal(a1.keyHash, a2.keyHash);
    const raw = Buffer.from(a1.publicKey, "base64url");
    assert.equal(raw.length, alg === "ed25519" ? 32 : 65);
    assert.equal(a1.keyHash, await sha256Hex(raw));
    assert.match(a1.keyHash, /^[0-9a-f]{64}$/);
  });

  test(`${alg}: domain separation — another network gives another key; different seeds give different keys`, async () => {
    const test = await deriveNameKey(seedA, "test", { alg });
    const main = await deriveNameKey(seedA, "main", { alg });
    const other = await deriveNameKey(seedB, "test", { alg });
    assert.notEqual(test.keyHash, main.keyHash);
    assert.notEqual(test.keyHash, other.keyHash);
  });

  test(`${alg}: signatures verify with WebCrypto against the raw public key (as the server checks them)`, async () => {
    const key = await deriveNameKey(seedA, "test", { alg });
    const message = "zocial-world/name-claim/v1:00112233445566778899aabbccddeeff:Alice";
    const signature = Buffer.from(await key.sign(message), "base64url");
    assert.equal(signature.length, 64);
    const raw = Buffer.from(key.publicKey, "base64url");
    const imported =
      alg === "ed25519"
        ? await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"])
        : await crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const params = alg === "ed25519" ? { name: "Ed25519" } : { name: "ECDSA", hash: "SHA-256" };
    assert.equal(await crypto.subtle.verify(params, imported, signature, new TextEncoder().encode(message)), true);
    assert.equal(await crypto.subtle.verify(params, imported, signature, new TextEncoder().encode(message + "!")), false);
  });
}

test("the two algorithms make different keys from the same seed (a name registered with one is not claimable with the other)", async () => {
  const ed = await deriveNameKey(seedA, "test", { alg: "ed25519" });
  const p = await deriveNameKey(seedA, "test", { alg: "p256" });
  assert.notEqual(ed.keyHash, p.keyHash);
});

test("Ed25519 is the default where WebCrypto supports it (Node 22 does)", async () => {
  assert.equal((await deriveNameKey(seedA, "test")).alg, "ed25519");
});

test("the active key: activated from the mnemonic (same as from its BIP-39 seed), announced, and cleared on lock", async () => {
  clearNameKey();
  const seen: (string | null)[] = [];
  const unsubscribe = subscribeToNameKey((key) => seen.push(key?.keyHash ?? null));
  const fromMnemonic = await activateNameKeyFromMnemonic(`  ${MNEMONIC_A.toUpperCase()} `, "test");
  const fromSeed = await deriveNameKey(seedA, "test");
  assert.equal(fromMnemonic?.keyHash, fromSeed.keyHash, "trimmed and lower-cased like the wallet does");
  assert.equal(activeNameKey()?.keyHash, fromSeed.keyHash);
  clearNameKey();
  assert.equal(activeNameKey(), null);
  assert.deepEqual(seen, [fromSeed.keyHash, null]);
  unsubscribe();
});

test("a lock during a slow activation wins (the late key is discarded)", async () => {
  clearNameKey();
  const pending = activateNameKeyFromSeed(seedB, "test");
  clearNameKey();
  assert.equal(await pending, null);
  assert.equal(activeNameKey(), null);
});
