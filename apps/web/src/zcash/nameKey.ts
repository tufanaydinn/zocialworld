import { mnemonicToSeedWebcrypto } from "@scure/bip39";
import type { NameKeyAlg } from "@project/shared";

/**
 * The name-ownership key (ADR-016 § 1): a key pair derived deterministically from the wallet seed,
 * used ONLY to prove a registered name (challenge-response). It is not an address, never touches the chain except
 * as a hash in the registration memo, and is domain-separated from every other key the seed makes (reusing a key
 * another application derives from the same seed could link a nickname to that application's public history):
 *
 *   seed64  = BIP-39 seed of the wallet's mnemonic (empty passphrase)
 *   Ed25519 = HKDF-SHA-256(seed64, salt = "", info = "zocial-world/name-key/v1/<network>", 32 bytes) as the private seed
 *   P-256   = HKDF-SHA-256(seed64, salt = "", info = "zocial-world/name-key/v1/<network>/p256", 48 bytes) mod (n − 1) + 1
 *
 * Ed25519 (WebCrypto, PKCS#8 wrap of the 32-byte seed) where the browser has it; ECDSA P-256 otherwise (the scalar
 * goes in through a PKCS#8 import whose JWK export supplies the public point, then a JWK import of d, x, y). No
 * library: WebCrypto only. The same seed gives the same key on any device that uses the same algorithm (every
 * current browser has Ed25519; a P-256-only browser makes a different key — see IDENTITY_THREAT_MODEL.md).
 *
 * Derived while the wallet is unlocked (the seed is in memory then — ZcashWalletAdapter), kept only as a
 * NON-EXTRACTABLE CryptoKey plus the public key, and forgotten on lock, disconnect or "Forget this wallet".
 */

export interface NameKey {
  readonly alg: NameKeyAlg;
  /** The raw public key, base64url (Ed25519: 32 bytes; P-256: 65-byte uncompressed point). */
  readonly publicKey: string;
  /** SHA-256 of the raw public key, lowercase hex — what a registration binds to. */
  readonly keyHash: string;
  /** Signs the UTF-8 `message`; base64url signature (64 bytes). */
  sign(message: string): Promise<string>;
}

/** The HKDF info string: one key per app, version and network. */
export function nameKeyInfo(network: string): string {
  return `zocial-world/name-key/v1/${network}`;
}

const ED25519_PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
/** PKCS#8 for a P-256 ECPrivateKey without the optional public key (the browser computes it). */
const P256_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03,
  0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20,
]);
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function subtle(): SubtleCrypto {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) throw new Error("WebCrypto is unavailable (a secure context is required)");
  return crypto.subtle;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hkdf(seed: Uint8Array, info: string, bits: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await subtle().importKey("raw", new Uint8Array(seed), "HKDF", false, ["deriveBits"]);
  const out = await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(info) }, key, bits);
  return new Uint8Array(out);
}

let ed25519Probe: Promise<boolean> | null = null;

/** Whether this browser's WebCrypto can import an Ed25519 private key (probed once). */
export function supportsEd25519(): Promise<boolean> {
  if (!ed25519Probe) {
    ed25519Probe = subtle()
      .importKey("pkcs8", concat(ED25519_PKCS8_PREFIX, new Uint8Array(32).fill(1)), { name: "Ed25519" }, false, ["sign"])
      .then(
        () => true,
        () => false,
      );
  }
  return ed25519Probe;
}

async function finish(alg: NameKeyAlg, privateKey: CryptoKey, raw: Uint8Array<ArrayBuffer>): Promise<NameKey> {
  const keyHash = toHex(new Uint8Array(await subtle().digest("SHA-256", raw)));
  const params: AlgorithmIdentifier | EcdsaParams = alg === "ed25519" ? { name: "Ed25519" } : { name: "ECDSA", hash: "SHA-256" };
  return {
    alg,
    publicKey: toBase64Url(raw),
    keyHash,
    sign: async (message) => toBase64Url(new Uint8Array(await subtle().sign(params, privateKey, new TextEncoder().encode(message)))),
  };
}

/**
 * Derives the name key for `network` from a BIP-39 seed (64 bytes). `alg` forces an algorithm (tests); by default
 * Ed25519 where supported. Intermediate secret bytes are zeroed; only the non-extractable key is kept.
 */
export async function deriveNameKey(seed: Uint8Array, network: string, options: { readonly alg?: NameKeyAlg } = {}): Promise<NameKey> {
  const alg = options.alg ?? ((await supportsEd25519()) ? "ed25519" : "p256");
  const info = nameKeyInfo(network);
  if (alg === "ed25519") {
    const secret = await hkdf(seed, info, 256);
    const der = concat(ED25519_PKCS8_PREFIX, secret);
    try {
      const exportable = await subtle().importKey("pkcs8", der, { name: "Ed25519" }, true, ["sign"]);
      const jwk = await subtle().exportKey("jwk", exportable);
      const privateKey = await subtle().importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
      return await finish("ed25519", privateKey, fromBase64Url(jwk.x!));
    } finally {
      secret.fill(0);
      der.fill(0);
    }
  }
  const material = await hkdf(seed, `${info}/p256`, 384);
  let c = 0n;
  for (const byte of material) c = (c << 8n) | BigInt(byte);
  material.fill(0);
  let d = (c % (P256_ORDER - 1n)) + 1n;
  const scalar = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    scalar[i] = Number(d & 0xffn);
    d >>= 8n;
  }
  const der = concat(P256_PKCS8_PREFIX, scalar);
  try {
    const exportable = await subtle().importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const jwk = await subtle().exportKey("jwk", exportable);
    const privateKey = await subtle().importKey("jwk", { kty: "EC", crv: "P-256", d: jwk.d!, x: jwk.x!, y: jwk.y!, ext: false }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const raw = new Uint8Array(65);
    raw[0] = 0x04;
    raw.set(fromBase64Url(jwk.x!), 1);
    raw.set(fromBase64Url(jwk.y!), 33);
    return await finish("p256", privateKey, raw);
  } finally {
    scalar.fill(0);
    der.fill(0);
  }
}

// ---------------------------------------------------------------------------------- the active key (this page)

let active: NameKey | null = null;
let generation = 0;
const listeners = new Set<(key: NameKey | null) => void>();

function setActive(key: NameKey | null): void {
  active = key;
  for (const listener of [...listeners]) listener(key);
}

/** The name key of the unlocked wallet, or null (locked, no wallet, or still deriving). */
export function activeNameKey(): NameKey | null {
  return active;
}

export function subscribeToNameKey(listener: (key: NameKey | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Derives and activates the key for a BIP-39 seed. A later activate/clear wins over a slower earlier one. */
export async function activateNameKeyFromSeed(seed: Uint8Array, network: string): Promise<NameKey | null> {
  const mine = ++generation;
  try {
    const key = await deriveNameKey(seed, network);
    if (mine !== generation) return null;
    setActive(key);
    return key;
  } catch (error) {
    if (mine === generation && active) setActive(null);
    console.warn("[names] name key unavailable:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** The wallet's unlock path: the mnemonic → its BIP-39 seed (WebCrypto PBKDF2) → the name key. The seed bytes are zeroed after. */
export async function activateNameKeyFromMnemonic(mnemonic: string, network: string): Promise<NameKey | null> {
  let seed: Uint8Array;
  try {
    seed = await mnemonicToSeedWebcrypto(mnemonic.trim().toLowerCase());
  } catch (error) {
    // Never breaks the wallet: without a name key a holder simply cannot confirm or claim a name.
    console.warn("[names] name key unavailable:", error instanceof Error ? error.message : error);
    return null;
  }
  try {
    return await activateNameKeyFromSeed(seed, network);
  } finally {
    seed.fill(0);
  }
}

/** Lock, disconnect, "Forget this wallet": the key is dropped (an activation still running is discarded). */
export function clearNameKey(): void {
  generation++;
  if (active) setActive(null);
}
