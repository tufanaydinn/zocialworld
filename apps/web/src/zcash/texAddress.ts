/**
 * ADR-018 § 3, Stage 2: TEX addresses (ZIP 320, "transparent-source-only" exchange addresses, `tex1…`).
 *
 * A TEX address is the bech32m encoding of a 20-byte P2PKH hash under the HRP `tex` (mainnet), `textest` (testnet) or
 * `texregtest` (regtest). Some exchanges require one for deposits: the payment must come from a transaction whose
 * inputs are all transparent. The Stage-2 engine pays it only as a withdrawal, in two transactions (shielded → a one-time
 * transparent address of the wallet, then that output → the TEX's P2PKH), so the amount becomes public like any
 * transparent withdrawal.
 *
 * This is a real check (bech32m checksum, BIP-350; 20-byte payload), not a prefix match, so a mistyped TEX address is
 * refused before the engine is asked. Pure: no DOM, no wallet engine.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3] as const;

export type TexNetwork = "main" | "test" | "regtest";
const HRP_NETWORK: Readonly<Record<string, TexNetwork>> = { tex: "main", textest: "test", texregtest: "regtest" };

function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i]!;
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const high: number[] = [];
  const low: number[] = [];
  for (let i = 0; i < hrp.length; i++) {
    high.push(hrp.charCodeAt(i) >> 5);
    low.push(hrp.charCodeAt(i) & 31);
  }
  return [...high, 0, ...low];
}

/** 5-bit groups → bytes; null when the padding is not zero (BIP-173 rules). */
function fromWords(words: readonly number[]): Uint8Array | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const word of words) {
    acc = (acc << 5) | word;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits >= 5 || acc !== 0) return null;
  return Uint8Array.from(out);
}

/** The network of a valid TEX address (`tex1…` main, `textest1…` test, `texregtest1…` regtest), or null. */
export function texAddressNetwork(raw: string): TexNetwork | null {
  return decodeTex(raw)?.network ?? null;
}

/** The 20-byte P2PKH hash a valid TEX address pays, or null. */
export function texPubKeyHash(raw: string): Uint8Array | null {
  return decodeTex(raw)?.hash ?? null;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Two-byte version prefixes of P2PKH t-addresses: `t1…` (mainnet), `tm…` (testnet and regtest). */
const P2PKH_PREFIXES: readonly (readonly [number, number])[] = [
  [0x1c, 0xb8],
  [0x1d, 0x25],
];

/**
 * The 20-byte hash of a P2PKH transparent address (`t1…`, `tm…`), or null (not base58, not P2PKH, wrong length). Used
 * to compare with addresses the wallet itself produced, so the base58check checksum is not verified here (the engine
 * validates every address it pays).
 */
export function transparentPubKeyHash(raw: string): Uint8Array | null {
  const text = raw.trim();
  if (text.length < 30 || text.length > 40) return null;
  let value = 0n;
  for (const char of text) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  for (const char of text) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  // version (2) + hash (20) + checksum (4)
  if (bytes.length !== 26) return null;
  if (!P2PKH_PREFIXES.some(([a, b]) => bytes[0] === a && bytes[1] === b)) return null;
  return Uint8Array.from(bytes.slice(2, 22));
}

/**
 * Whether `tex` is the TEX form of the transparent address `transparent` (the same 20-byte P2PKH
 * hash under the `tex` HRP). A withdrawal to it would leave the shielded balance and come straight back, public, to the
 * wallet's own t-address.
 */
export function isTexOfTransparent(tex: string, transparent: string): boolean {
  const a = texPubKeyHash(tex);
  const b = transparentPubKeyHash(transparent);
  return a !== null && b !== null && a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** A valid TEX address's network and 20-byte P2PKH hash, or null. */
function decodeTex(raw: string): { readonly network: TexNetwork; readonly hash: Uint8Array } | null {
  const trimmed = raw.trim();
  if (trimmed.length < 8 || trimmed.length > 90) return null;
  // bech32: one case only.
  if (trimmed !== trimmed.toLowerCase() && trimmed !== trimmed.toUpperCase()) return null;
  const address = trimmed.toLowerCase();
  const separator = address.lastIndexOf("1");
  if (separator < 1) return null;
  const hrp = address.slice(0, separator);
  const network = HRP_NETWORK[hrp];
  if (!network) return null;
  const words: number[] = [];
  for (const char of address.slice(separator + 1)) {
    const value = CHARSET.indexOf(char);
    if (value < 0) return null;
    words.push(value);
  }
  if (words.length < 7) return null;
  if (polymod([...hrpExpand(hrp), ...words]) !== BECH32M_CONST) return null;
  const payload = fromWords(words.slice(0, -6));
  return payload !== null && payload.length === 20 ? { network, hash: payload } : null;
}

/** Whether `raw` is a valid TEX address (any network). */
export function isTexAddress(raw: string): boolean {
  return texAddressNetwork(raw) !== null;
}
