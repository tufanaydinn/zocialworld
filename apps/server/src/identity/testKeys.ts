import { webcrypto } from "node:crypto";
import { nameClaimMessage, type NameKeyAlg } from "@project/shared";

/**
 * Test helper (not used by the server): a name key like the browser derives (apps/web/src/zcash/nameKey.ts) —
 * raw public key and signatures in the same formats — generated at random.
 */
export interface TestNameKey {
  readonly alg: NameKeyAlg;
  readonly publicKey: string;
  readonly keyHash: string;
  sign(message: string): Promise<string>;
  /** Signs the claim message for a challenge nonce. */
  proof(nonce: string, nickname: string): Promise<{ type: "name_claim_proof"; nickname: string; publicKey: string; signature: string; alg: NameKeyAlg }>;
}

export async function testNameKey(alg: NameKeyAlg = "ed25519"): Promise<TestNameKey> {
  const subtle = webcrypto.subtle;
  const params = alg === "ed25519" ? { name: "Ed25519" } : { name: "ECDSA", namedCurve: "P-256" };
  const pair = (await subtle.generateKey(params, true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const publicKey = Buffer.from(raw).toString("base64url");
  const keyHash = Buffer.from(await subtle.digest("SHA-256", raw)).toString("hex");
  const signParams = alg === "ed25519" ? { name: "Ed25519" } : { name: "ECDSA", hash: "SHA-256" };
  const sign = async (message: string): Promise<string> => Buffer.from(await subtle.sign(signParams, pair.privateKey, new TextEncoder().encode(message))).toString("base64url");
  return {
    alg,
    publicKey,
    keyHash,
    sign,
    proof: async (nonce, nickname) => ({ type: "name_claim_proof", nickname, publicKey, signature: await sign(nameClaimMessage(nonce, nickname)), alg }),
  };
}
