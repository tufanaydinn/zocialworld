// Address helpers for the harness (TESTING ONLY): base58check decode of a t-address and bech32m
// encoding of the matching TEX address (ZIP 320).
import { createHash } from "node:crypto";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58checkDecode(s) {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = "0" + hex;
  let bytes = Buffer.from(hex, "hex");
  const zeros = s.match(/^1*/)[0].length;
  bytes = Buffer.concat([Buffer.alloc(zeros), bytes]);
  const payload = bytes.subarray(0, -4), check = bytes.subarray(-4);
  const h = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest();
  if (!h.subarray(0, 4).equals(check)) throw new Error("bad checksum");
  return payload;
}
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) { const b = chk >> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i]; }
  return chk;
}
const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
function convertBits(data, from, to) {
  let acc = 0, bits = 0; const out = []; const maxv = (1 << to) - 1;
  for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); } }
  if (bits > 0) out.push((acc << (to - bits)) & maxv);
  return out;
}
export function bech32mEncode(hrp, bytes) {
  const data = convertBits([...bytes], 8, 5);
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 0x2bc830a3;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >> (5 * (5 - i))) & 31);
  return hrp + "1" + [...data, ...checksum].map((d) => CHARSET[d]).join("");
}
/** The TEX address with the same P2PKH hash as a t-address (2-byte version prefix + 20-byte hash). */
export function texOf(taddr, hrp) {
  const payload = base58checkDecode(taddr);
  if (payload.length !== 22) throw new Error("not a t-address");
  return bech32mEncode(hrp, payload.subarray(2));
}
