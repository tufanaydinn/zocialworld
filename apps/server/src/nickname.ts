import { MAX_NICKNAME_LENGTH } from "@project/shared";

/**
 * Nickname validation and conflict resolution (CORE-003).
 *
 * This is content-safety validation, not moderation: it rejects shapes
 * that are unsafe or meaningless (empty, oversized, control characters,
 * raw markup delimiters), not words or phrases. See
 * docs/protocols/multiplayer-protocol.md § Nickname validation and
 * conflict resolution for the full policy this implements, and
 * docs/privacy/SOCIAL_IDENTITY_THREAT_MODEL.md for why a nickname is
 * never treated as a trustworthy or anonymous identifier.
 */

// C0 controls (U+0000–U+001F) and DEL (U+007F) — covers things like
// embedded newlines, bell characters, etc. that have no business in a
// one-line display label.
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;

// A deliberately simple denylist, not a markup sanitizer: nicknames are
// always rendered as text (never innerHTML — see
// apps/web/src/ui/Nameplates.ts and apps/web/src/social/PlayerContextCard.ts),
// so this isn't the only thing standing between a hostile nickname and
// the page. It exists so an obviously-markup-shaped nickname (e.g.
// `<script>...</script>`) is rejected outright rather than displayed
// verbatim as inert text, which would still be confusing/spoofable even
// though it can't execute. This is intentionally not a full HTML/JS
// sanitizer — see CORE-003 §20 ("do not overbuild a censorship system").
const DANGEROUS_MARKUP_PATTERN = /[<>]/;

/**
 * Validates and normalizes a raw nickname string. Returns the trimmed,
 * accepted nickname, or `null` if it fails validation for any reason —
 * callers must treat `null` as "this nickname is not usable" and fall
 * back to their own context-appropriate policy (Guest-#### generation on
 * `join`, "leave the existing nickname unchanged" on `set_nickname` — see
 * `WorldServer.ts`).
 */
export function sanitizeNickname(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_NICKNAME_LENGTH) return null;
  if (CONTROL_CHAR_PATTERN.test(trimmed)) return null;
  if (DANGEROUS_MARKUP_PATTERN.test(trimmed)) return null;
  return trimmed;
}

/**
 * Resolves a nickname conflict deterministically by appending `-2`,
 * `-3`, … until `isTaken` reports the candidate is free. For prototype
 * clarity (CORE-003 §5) two connected sessions should never display the
 * same visible nickname; a conflict is resolved with a suffix rather
 * than rejecting the join/rename outright.
 *
 * The result is always `<= MAX_NICKNAME_LENGTH`: the suffix itself is
 * never truncated (a result like `abc-2` always keeps its full `-2`),
 * but the base is truncated as needed to make room for it, recomputed
 * on every attempt since the suffix grows a character at `-10`, `-100`,
 * etc. `candidate` is assumed to already be `<= MAX_NICKNAME_LENGTH`
 * (callers pass a `sanitizeNickname()`-approved value) but is truncated
 * defensively here too, so this function's own contract — "the result
 * fits" — holds regardless of what a future caller passes in.
 */
export function resolveUniqueNickname(candidate: string, isTaken: (nickname: string) => boolean): string {
  const base = candidate.length > MAX_NICKNAME_LENGTH ? candidate.slice(0, MAX_NICKNAME_LENGTH) : candidate;
  if (!isTaken(base)) return base;

  for (let suffixNumber = 2; ; suffixNumber++) {
    const suffix = `-${suffixNumber}`;
    const maxBaseLength = MAX_NICKNAME_LENGTH - suffix.length;
    const truncatedBase = base.length > maxBaseLength ? base.slice(0, maxBaseLength) : base;
    const result = `${truncatedBase}${suffix}`;
    if (!isTaken(result)) return result;
  }
}
