import { randomUUID } from "node:crypto";
import { GUEST_NICKNAME_PATTERN, defaultPlayerAvatar, type PlayerAvatar } from "@project/shared";

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

/** `Guest-####` — every guest's name (ADR-015), and a holder's until they choose one. Callers pick a free one (WorldServer). */
export function generateGuestNickname(): string {
  const digits = Math.floor(1000 + Math.random() * 9000);
  return `Guest-${digits}`;
}

/** ADR-015: whether `nickname` has the exact shape of a server-generated guest name. */
export function isGuestNickname(nickname: string): boolean {
  return GUEST_NICKNAME_PATTERN.test(nickname);
}

/**
 * ADR-015: the avatar of a session that has not chosen one — every guest's. Derived from
 * colorSeed exactly as the web client's remote avatars were before ADR-015 (model index
 * `colorSeed % 5`, in AVATAR_MODELS order), so nobody's default look changes.
 */
export function defaultAvatar(colorSeed: number): PlayerAvatar {
  return defaultPlayerAvatar(colorSeed);
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
