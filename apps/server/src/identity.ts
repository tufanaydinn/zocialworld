import { randomUUID } from "node:crypto";

/**
 * Temporary session identity only — see docs/privacy/MULTIPLAYER_THREAT_MODEL.md.
 *
 * `playerId` is a random UUID with no relationship whatsoever to the
 * connecting client: not derived from IP, not derived from any
 * device/browser fingerprint, not persisted across connections. It
 * exists only to key the in-memory player map for the lifetime of one
 * WebSocket connection.
 */
export function generatePlayerId(): string {
  return randomUUID();
}

/** `Guest-####` — used when a client doesn't supply a nickname on `join`. */
export function generateGuestNickname(): string {
  const digits = Math.floor(1000 + Math.random() * 9000);
  return `Guest-${digits}`;
}

/**
 * Deterministic hash of a playerId into a hue (0-359) so each session
 * gets a stable, visually distinct placeholder-character tint for the
 * lifetime of the connection. The result is session-level pseudonymous
 * metadata derived from the temporary playerId and used only for
 * placeholder visual differentiation — it does not directly encode a
 * real-world identity or wallet identity, is not reversible to anything
 * meaningful, and is recomputed fresh for every new connection since
 * playerId itself is not persisted.
 */
export function deriveColorSeed(playerId: string): number {
  let hash = 0;
  for (let i = 0; i < playerId.length; i++) {
    hash = (hash * 31 + playerId.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}
