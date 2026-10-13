/**
 * End-to-end sealing for private player payments (ADR-013).
 *
 * Each side makes a fresh ECDH P-256 key pair per payment (the private
 * half is non-extractable and never leaves the browser). Both derive the
 * same AES-GCM-256 key with HKDF-SHA-256 (salt = the request id), and the
 * recipient's address / the sender's payment notice travel sealed. The game
 * server relays only public keys and ciphertext.
 *
 * A relay that swapped keys could read the address (a man-in-the-middle),
 * so both players see a short security code derived from the two public
 * keys; matching codes (compare by voice or chat) rule that out.
 */

const INFO = new TextEncoder().encode("project-world/pay/v1");
const EMOJI = ["🦊", "🍀", "🚀", "🎈", "🐢", "🌙", "🔥", "🍉", "🎲", "🐝", "⚡", "🌵", "🎧", "🦉", "🍄", "⛵"];

export interface PaymentKeys {
  readonly privateKey: CryptoKey;
  readonly publicKey: string; // base64 raw (65 bytes uncompressed)
}

export async function createPaymentKeys(): Promise<PaymentKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: toB64(raw) };
}

export async function deriveSealKey(own: PaymentKeys, peerPublicKey: string, requestId: string): Promise<CryptoKey> {
  const peer = await crypto.subtle.importKey("raw", fromB64(peerPublicKey) as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, own.privateKey, 256);
  const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode(requestId), info: INFO },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function seal(key: CryptoKey, value: unknown): Promise<{ sealed: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  return { sealed: toB64(sealed), iv: toB64(iv) };
}

/** Throws if the ciphertext was tampered with or the key is wrong. */
export async function unseal<T>(key: CryptoKey, sealed: string, iv: string): Promise<T> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) as BufferSource }, key, fromB64(sealed) as BufferSource);
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

/** Four emoji from SHA-256(senderKey ‖ recipientKey) — identical on both sides unless a relay swapped keys. */
export async function securityCode(senderKey: string, recipientKey: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${senderKey}|${recipientKey}`)));
  return Array.from(digest.slice(0, 4), (byte) => EMOJI[byte % EMOJI.length]).join(" ");
}

export function newRequestId(): string {
  return toB64(crypto.getRandomValues(new Uint8Array(15))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromB64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
