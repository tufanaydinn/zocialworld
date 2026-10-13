import { MAX_CHAT_LENGTH } from "@project/shared";
import { TokenBucket } from "./tokenBucket.js";

/**
 * Text chat rules — the server's single content authority
 * for chat, like nickname.ts is for nicknames.
 *
 * Messages are relayed and forgotten: nothing here stores or logs text
 * (docs/privacy/CHAT_THREAT_MODEL.md).
 */

/** Burst of messages a session may send, refilled at CHAT_REFILL_PER_SECOND. */
export const CHAT_BURST = 5;
export const CHAT_REFILL_PER_SECOND = 0.5;

/**
 * Characters that can spoof or break a line of text: C0/C1 controls and DEL, zero-width spaces,
 * joiners and marks (U+200B–200F), bidi overrides and isolates (U+202A–202E, U+2066–2069) and the
 * BOM. Chat replaces them with spaces; nicknames (nickname.ts, ADR-015) are rejected outright.
 */
// eslint-disable-next-line no-control-regex
export const UNSAFE_TEXT_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const UNSAFE_TEXT_CHARACTERS_GLOBAL = new RegExp(UNSAFE_TEXT_CHARACTERS.source, "g");

/**
 * Collapses whitespace to single spaces, trims, and strips characters
 * that can spoof or break the chat log (UNSAFE_TEXT_CHARACTERS: C0/C1
 * controls, bidi overrides and isolates, zero-width joiners/spaces and
 * the BOM). Returns `null` for an empty result, `"too_long"` above
 * `maxLength` characters (default MAX_CHAT_LENGTH; the Watch Hall's
 * speaker card reuses it with its own field limits).
 */
export function sanitizeChatText(raw: string, maxLength: number = MAX_CHAT_LENGTH): string | null | "too_long" {
  const cleaned = raw
    .replace(UNSAFE_TEXT_CHARACTERS_GLOBAL, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  if ([...cleaned].length > maxLength) return "too_long";
  return cleaned;
}

/** Token bucket per session: CHAT_BURST messages, refilling at CHAT_REFILL_PER_SECOND. */
export class ChatRateLimiter {
  private readonly bucket: TokenBucket;

  constructor(now: () => number) {
    this.bucket = new TokenBucket(CHAT_BURST, CHAT_REFILL_PER_SECOND, now);
  }

  take(): boolean {
    return this.bucket.take();
  }
}
