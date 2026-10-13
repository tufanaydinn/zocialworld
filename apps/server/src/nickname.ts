import { MAX_NICKNAME_LENGTH } from "@project/shared";
import { UNSAFE_TEXT_CHARACTERS } from "./chat.js";

/**
 * Nickname validation and conflict resolution (ADR-015 § 9).
 *
 * This is content-safety validation, not moderation: it rejects shapes
 * that are unsafe or meaningless (empty, oversized, control characters,
 * invisible or direction-changing characters, raw markup delimiters), not
 * words or phrases. See docs/protocols/multiplayer-protocol.md § Nickname
 * validation and conflict resolution for the full policy this implements,
 * and docs/privacy/SOCIAL_IDENTITY_THREAT_MODEL.md for why a nickname is
 * never treated as a trustworthy or anonymous identifier.
 *
 * ADR-015: names are NFKC-normalised (so a fullwidth "Ｎａｄｉａ" IS "Nadia"),
 * unique case-insensitively (`nicknameKey`), and the Guest pattern plus a
 * few system words are reserved (`isReservedNickname`) — a chosen name now
 * implies a wallet holder, so nobody may pose as a guest or as the system.
 */

// A deliberately simple denylist, not a markup sanitizer: nicknames are
// always rendered as text (never innerHTML — see
// apps/web/src/ui/Nameplates.ts and apps/web/src/social/PlayerContextCard.ts),
// so this isn't the only thing standing between a hostile nickname and
// the page. It exists so an obviously-markup-shaped nickname (e.g.
// `<script>...</script>`) is rejected outright rather than displayed
// verbatim as inert text, which would still be confusing/spoofable even
// though it can't execute. This is intentionally not a full HTML/JS
// sanitizer, and deliberately not a censorship system.
const DANGEROUS_MARKUP_PATTERN = /[<>]/;

/**
 * Validates and normalizes a raw nickname string. Returns the NFKC-normalised,
 * trimmed nickname, or `null` if it fails validation for any reason — callers
 * must treat `null` as "this nickname is not usable" and fall back to their own
 * context-appropriate policy (a generated Guest-#### on `join`, "leave the
 * existing nickname unchanged" on `set_nickname` — see `WorldServer.ts`).
 *
 * Rejected: empty, longer than MAX_NICKNAME_LENGTH (after normalising),
 * C0/C1 controls and DEL, zero-width characters, bidi overrides and
 * isolates, the BOM (the same class chat.ts strips — UNSAFE_TEXT_CHARACTERS),
 * and `<` / `>`.
 */
export function sanitizeNickname(raw: string): string | null {
  const trimmed = raw.normalize("NFKC").trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_NICKNAME_LENGTH) return null;
  if (UNSAFE_TEXT_CHARACTERS.test(trimmed)) return null;
  if (DANGEROUS_MARKUP_PATTERN.test(trimmed)) return null;
  return trimmed;
}

/**
 * The comparison key for uniqueness (ADR-015 § 9): NFKC plus a case fold.
 * `toUpperCase().toLowerCase()` folds more than `toLowerCase()` alone (e.g.
 * "Straße" and "STRASSE" share a key). Two names with the same key can
 * never be on screen at the same time.
 */
export function nicknameKey(nickname: string): string {
  return nickname.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
}

/**
 * "guest", "Guest-1234", "GUEST 12", "guest_7", "Guest‐1234" (any dash) — the
 * shape of a server-generated guest name and its look-alikes. Matched on the
 * NFKC form, so fullwidth letters, digits and hyphen-minus are caught too.
 */
const GUEST_LOOKALIKE_PATTERN = /^guest[\s\p{Pd}._]*\d*$/iu;

/** System words nobody may take, compared without spaces, dashes, dots or underscores. */
const RESERVED_WORDS = new Set(["system", "admin", "host", "moderator", "zocialworld"]);

/**
 * ADR-015 § 9: names nobody can choose — the Guest pattern and its look-alikes
 * (only the server hands out `Guest-####`), and `system`, `admin`, `host`,
 * `moderator` and `zocial world` in any spacing or case. The server still
 * generates guest names itself; this guards what a CLIENT asks for.
 */
export function isReservedNickname(nickname: string): boolean {
  const key = nicknameKey(nickname).trim();
  if (GUEST_LOOKALIKE_PATTERN.test(key)) return true;
  return RESERVED_WORDS.has(key.replace(/[\s\p{Pd}._]+/gu, ""));
}

/**
 * Resolves a nickname conflict deterministically by appending `-2`,
 * `-3`, … until `isTaken` reports the candidate is free. For prototype
 * clarity two connected sessions should never display the
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
