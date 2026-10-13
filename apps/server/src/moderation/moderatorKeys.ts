import { createHash, timingSafeEqual } from "node:crypto";
import { HALL_HOST_KEY_MAX } from "@project/shared";
import { HALL_HOST_KEY_MIN_DISTINCT, HALL_HOST_KEY_MIN_LENGTH } from "../watchHall.js";

/**
 * MODERATOR_KEYS (ADR-019 § 1): the operator's moderator secrets, a comma-separated list.
 *
 * Each key follows the Watch Hall host key's rules (ADR-014): at least 24 characters, at most 128 (the sign-in field and
 * `hall_host_auth` cap it there), at least 10 distinct characters. A key that breaks a rule is dropped — fail closed:
 * it never works — and the startup log says how many were dropped and why, never the key. Only SHA-256 digests are
 * kept; a presented key is hashed and compared with every digest in constant time (no early exit), so the comparison
 * takes the same time whichever key matched, if any.
 */

export interface ModeratorKeySet {
  /** SHA-256 digests of the usable keys (never the keys). */
  readonly digests: readonly Buffer[];
  /** Why keys were dropped, for the startup log ("1 shorter than 24 characters"). Never contains a key. */
  readonly problems: readonly string[];
}

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/** Why one key is unusable, or null. Never includes the key. */
export function moderatorKeyProblem(key: string): string | null {
  if (key.length < HALL_HOST_KEY_MIN_LENGTH) return `shorter than ${HALL_HOST_KEY_MIN_LENGTH} characters`;
  if (key.length > HALL_HOST_KEY_MAX) return `longer than ${HALL_HOST_KEY_MAX} characters`;
  if (new Set(key).size < HALL_HOST_KEY_MIN_DISTINCT) return `fewer than ${HALL_HOST_KEY_MIN_DISTINCT} distinct characters`;
  return null;
}

/** Parses MODERATOR_KEYS (entries are trimmed; empty entries are ignored). Duplicates count once. */
export function parseModeratorKeys(raw: string | undefined): ModeratorKeySet {
  const digests: Buffer[] = [];
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const entry of (raw ?? "").split(",")) {
    const key = entry.trim();
    if (key.length === 0) continue;
    const problem = moderatorKeyProblem(key);
    if (problem) {
      counts.set(problem, (counts.get(problem) ?? 0) + 1);
      continue;
    }
    const digest = sha256(key);
    const hex = digest.toString("hex");
    if (seen.has(hex)) continue;
    seen.add(hex);
    digests.push(digest);
  }
  return { digests, problems: [...counts].map(([problem, count]) => `${count} ${problem}`) };
}

/** Whether `key` is one of the moderator keys: every digest is compared (constant time), whichever matches. */
export function isModeratorKey(key: string, keys: ModeratorKeySet): boolean {
  if (keys.digests.length === 0 || key.length === 0 || key.length > HALL_HOST_KEY_MAX) return false;
  const presented = sha256(key);
  let match = false;
  for (const digest of keys.digests) {
    if (timingSafeEqual(presented, digest)) match = true;
  }
  return match;
}

/** For the startup log: how many moderator keys work, and why others were dropped. Never a key. */
export function describeModeratorKeys(keys: ModeratorKeySet): string {
  const usable = keys.digests.length;
  const dropped = keys.problems.length > 0 ? ` (ignored: ${keys.problems.join(", ")})` : "";
  if (usable === 0) return `off — MODERATOR_KEYS has no usable key${dropped}`;
  return `${usable} moderator key${usable === 1 ? "" : "s"}${dropped}`;
}
