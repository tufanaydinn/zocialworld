import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

/**
 * Where a connection comes from, as the per-IP limits and guest bans need it (ADR-019 §§ 4–5) — and
 * nothing more.
 *
 *  - The client address is the socket's peer address, unless that peer is one of the proxies named in TRUST_PROXY:
 *    then it is the rightmost address in `X-Forwarded-For` (the one that proxy appended). A client that is not the
 *    named proxy cannot move its address by sending the header.
 *  - The address is reduced to a network key: an IPv4 address as is, an IPv6 address to its /64 (one household or
 *    machine usually holds a whole /64 and could otherwise rotate through it).
 *  - The key is hashed with HMAC-SHA-256 under a random key made at start-up and never stored or logged: the hash
 *    cannot be compared across restarts or servers, and the raw address is never stored, logged or shown.
 */

/** Parses TRUST_PROXY: a comma-separated list of proxy IP addresses (IPv4 or IPv6, exact). Invalid entries are reported. */
export function parseTrustProxy(raw: string | undefined): { readonly proxies: ReadonlySet<string>; readonly invalid: number } {
  const proxies = new Set<string>();
  let invalid = 0;
  for (const entry of (raw ?? "").split(",")) {
    const value = entry.trim();
    if (value.length === 0) continue;
    const normalized = normalizeAddress(value);
    if (normalized === null) invalid++;
    else proxies.add(normalized);
  }
  return { proxies, invalid };
}

/** A canonical form of an IP address (IPv4-mapped IPv6 → IPv4, lower case, zone id dropped), or null if it isn't one. */
export function normalizeAddress(raw: string): string | null {
  let value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) value = mapped[1]!;
  const family = isIP(value);
  if (family === 4) return value;
  if (family === 6) return value.toLowerCase();
  return null;
}

/**
 * The client's address for one request: the peer address, or — only when the peer is a trusted proxy — the rightmost
 * valid entry of `X-Forwarded-For`. Falls back to the peer address when the header is missing or malformed.
 */
export function clientAddress(peer: string | undefined, forwardedFor: string | string[] | undefined, trusted: ReadonlySet<string>): string {
  return clientOrigin(peer, forwardedFor, trusted).address;
}

/** `clientAddress`, and whether the address came from a trusted proxy's `X-Forwarded-For` (`forwarded`). */
export function clientOrigin(peer: string | undefined, forwardedFor: string | string[] | undefined, trusted: ReadonlySet<string>): { readonly address: string; readonly forwarded: boolean } {
  const socketAddress = normalizeAddress(peer ?? "") ?? "unknown";
  const direct = { address: socketAddress, forwarded: false };
  if (trusted.size === 0 || !trusted.has(socketAddress) || forwardedFor === undefined) return direct;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor;
  const entries = header.split(",");
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!.trim();
    if (entry.length === 0) continue;
    const address = normalizeAddress(entry);
    return address === null ? direct : { address, forwarded: true };
  }
  return direct;
}

/** The request's client address (see `clientAddress`). */
export function requestAddress(request: IncomingMessage | undefined, trusted: ReadonlySet<string>): string {
  return requestOrigin(request, trusted).address;
}

/** The request's client address and whether a trusted proxy forwarded it (see `clientOrigin`). */
export function requestOrigin(request: IncomingMessage | undefined, trusted: ReadonlySet<string>): { readonly address: string; readonly forwarded: boolean } {
  return clientOrigin(request?.socket?.remoteAddress, request?.headers["x-forwarded-for"], trusted);
}

/**
 * Whether an address is never a visitor's own on the public internet — private (RFC 1918), loopback,
 * link-local, shared/CGNAT (RFC 6598), IPv6 unique-local or link-local. A trusted proxy forwarding one usually means the
 * proxy itself only sees a relay: Docker's userland proxy hands IPv6 visitors to an IPv4-only container network from the
 * network's gateway, so every one of them would share one per-IP limit, ban and mute.
 */
export function isInternalAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a === 0;
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    const first = Number.parseInt(lower.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

/** The network an address counts as: IPv4 as is, IPv6 reduced to its /64 prefix. */
export function networkKey(address: string): string {
  if (isIP(address) !== 6) return address;
  const [head = "", tail = ""] = address.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = address.includes("::") ? (tail === "" ? [] : tail.split(":")) : [];
  const groups = address.includes("::") ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups
    .slice(0, 4)
    .map((group) => (Number.parseInt(group, 16) || 0).toString(16))
    .join(":")}::/64`;
}

/**
 * HMAC-SHA-256 of a network key under a random per-process key (never stored, never logged). 128 bits, base64url.
 * The same address hashes the same way for the life of the process only.
 */
export class AddressHasher {
  private readonly key: Buffer;

  constructor(key: Buffer = randomBytes(32)) {
    this.key = key;
  }

  hash(address: string): string {
    return createHmac("sha256", this.key).update(`zocial-world/connection/v1:${networkKey(address)}`).digest("base64url").slice(0, 22);
  }
}
