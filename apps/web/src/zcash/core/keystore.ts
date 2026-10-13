// At-rest encryption for wallet secrets (optional passphrase protection).
// User can lock their seed behind a passphrase, so localStorage value
// is an AES-GCM ciphertext instead of raw secret. Then even an XSS/malicious-dependency
// that reads localStorage gets only ciphertext — useless without the passphrase.
// Defense-in-depth alongside the page CSP: the deployed game server (apps/server/src/staticSite.ts, buildPageCsp) limits
// connect-src to its own origin and LiveKit, which blocks exfiltration to other origins. The Vite dev server and
// `vite preview` do not send that policy.
//
// Crypto: WebCrypto only (SubtleCrypto). PBKDF2-SHA256 (high iteration) derives an AES-GCM
// key from passphrase + random salt; random IV per encryption. No deps.

export const PBKDF2_ITERS = 310_000; // OWASP floor for PBKDF2-SHA256
// Clamp untrusted iters from storage to prevent KDF downgrade or DoS.
export const MIN_ITERS = 100_000;
export const MAX_ITERS = 5_000_000;
const clampIters = (n: unknown): number => {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return PBKDF2_ITERS;
  return Math.min(MAX_ITERS, Math.max(MIN_ITERS, v));
};
const enc = new TextEncoder();
const dec = new TextDecoder();

/** A versioned, self-describing encrypted envelope (all base64). */
export type KeyEnvelope = { v: 1; kdf: "PBKDF2"; iters: number; salt: string; iv: string; ct: string };

function b64(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  b.forEach((x) => {
    s += String.fromCharCode(x);
  });
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iters: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase) as any,
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as any,
      iterations: iters,
      hash: "SHA-256",
    },
    base,
    { name: "AES-GCM", length: 256 } as any,
    false,
    ["encrypt", "decrypt"]
  );
}

/** Encrypt the secret under a passphrase → a storable envelope. */
export async function encryptSecret(secret: string, passphrase: string): Promise<KeyEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERS);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(secret));
  return { v: 1, kdf: "PBKDF2", iters: PBKDF2_ITERS, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

/** Decrypt an envelope with the passphrase. Throws on a wrong passphrase (GCM auth fails). */
export async function decryptSecret(envelope: KeyEnvelope, passphrase: string): Promise<string> {
  const salt = unb64(envelope.salt);
  const iv = unb64(envelope.iv);
  const key = await deriveKey(passphrase, salt, clampIters(envelope.iters));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as any }, key, unb64(envelope.ct) as any);
  return dec.decode(pt);
}

/** True if a stored value is an encrypted envelope (vs. a raw plaintext secret). */
export function isEnvelope(raw: string): boolean {
  try {
    const o = JSON.parse(raw);
    return o && o.v === 1 && o.kdf === "PBKDF2" && !!o.ct;
  } catch {
    return false;
  }
}
