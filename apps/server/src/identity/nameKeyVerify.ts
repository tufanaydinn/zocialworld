import { webcrypto } from "node:crypto";
import type { NameKeyAlg } from "@project/shared";

/**
 * Name-key cryptography on the server (ADR-016): the key hash a registration binds to, and the
 * verification of a returning player's challenge signature. WebCrypto in Node — the same primitives the browser uses
 * (apps/web/src/zcash/nameKey.ts), so nothing has to agree byte-for-byte beyond the raw key and signature formats:
 *  - Ed25519: 32-byte raw public key, 64-byte signature;
 *  - ECDSA P-256 with SHA-256: 65-byte uncompressed point (0x04 ‖ x ‖ y), 64-byte IEEE P1363 signature (r ‖ s).
 * Every function returns false/null on malformed input — never throws.
 */

const subtle = webcrypto.subtle;

const RAW_KEY_LENGTH: Record<NameKeyAlg, number> = { ed25519: 32, p256: 65 };
const SIGNATURE_LENGTH = 64;

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  return new Uint8Array(Buffer.from(text, "base64url"));
}

/** The raw public key bytes if `publicKey` (base64url) has the right length (and point prefix) for `alg`. */
function rawKey(alg: NameKeyAlg, publicKey: string): Uint8Array | null {
  const bytes = fromBase64Url(publicKey);
  if (!bytes || bytes.length !== RAW_KEY_LENGTH[alg]) return null;
  if (alg === "p256" && bytes[0] !== 0x04) return null;
  return bytes;
}

/** SHA-256 of the raw public key, lowercase hex — the `keyHash` a registration binds to. Null for a malformed key. */
export async function nameKeyHash(alg: NameKeyAlg, publicKey: string): Promise<string | null> {
  const bytes = rawKey(alg, publicKey);
  if (!bytes) return null;
  return Buffer.from(await subtle.digest("SHA-256", bytes)).toString("hex");
}

/** Verifies `signature` (base64url) over the UTF-8 `message` with the raw public key. */
export async function verifyNameSignature(alg: NameKeyAlg, publicKey: string, message: string, signature: string): Promise<boolean> {
  const bytes = rawKey(alg, publicKey);
  const sig = fromBase64Url(signature);
  if (!bytes || !sig || sig.length !== SIGNATURE_LENGTH) return false;
  try {
    const data = new TextEncoder().encode(message);
    if (alg === "ed25519") {
      const key = await subtle.importKey("raw", bytes, { name: "Ed25519" }, false, ["verify"]);
      return await subtle.verify({ name: "Ed25519" }, key, sig, data);
    }
    const key = await subtle.importKey("raw", bytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, data);
  } catch {
    return false; // not a point on the curve, unsupported algorithm, …
  }
}
