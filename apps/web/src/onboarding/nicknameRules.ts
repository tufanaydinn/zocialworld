import { MAX_NICKNAME_LENGTH } from "@project/shared";

/**
 * Client-side copy of the server's nickname rules (apps/server/src/nickname.ts, ADR-015 § 9), so
 * the onboarding nickname step can answer instantly while the player types. The SERVER stays the
 * authority — it re-checks everything, and `nickname_check` / `nickname_updated` say what really
 * happened. Keep the two in step (nicknameRules.test.ts mirrors the server's nickname.test.ts cases).
 */

/** C0/C1 controls and DEL, zero-width characters, bidi overrides/isolates and the BOM (server: chat.ts UNSAFE_TEXT_CHARACTERS). */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const MARKUP = /[<>]/;
const GUEST_LOOKALIKE = /^guest[\s\p{Pd}._]*\d*$/iu;
const RESERVED_WORDS = new Set(["system", "admin", "host", "moderator", "zocialworld"]);

export type NicknameProblem = "empty" | "too_long" | "characters" | "markup" | "reserved";

export type NicknameRuleResult = { readonly ok: true; readonly nickname: string } | { readonly ok: false; readonly problem: NicknameProblem };

/** The comparison key: NFKC plus a case fold (server: nicknameKey). */
export function nicknameKey(nickname: string): string {
  return nickname.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
}

/** The Guest pattern and its look-alikes, and the system words (server: isReservedNickname). */
export function isReservedNickname(nickname: string): boolean {
  const key = nicknameKey(nickname).trim();
  if (GUEST_LOOKALIKE.test(key)) return true;
  return RESERVED_WORDS.has(key.replace(/[\s\p{Pd}._]+/gu, ""));
}

/** NFKC, trim, then the server's shape rules and the reserved names. `nickname` is what the server would store. */
export function checkNicknameLocally(raw: string): NicknameRuleResult {
  const nickname = raw.normalize("NFKC").trim();
  if (nickname.length === 0) return { ok: false, problem: "empty" };
  if (nickname.length > MAX_NICKNAME_LENGTH) return { ok: false, problem: "too_long" };
  if (UNSAFE_CHARACTERS.test(nickname)) return { ok: false, problem: "characters" };
  if (MARKUP.test(nickname)) return { ok: false, problem: "markup" };
  if (isReservedNickname(nickname)) return { ok: false, problem: "reserved" };
  return { ok: true, nickname };
}

/** One plain sentence per problem, for the nickname step's status line. */
export function nicknameProblemText(problem: NicknameProblem): string {
  switch (problem) {
    case "empty":
      return "Type a name.";
    case "too_long":
      return `At most ${MAX_NICKNAME_LENGTH} characters.`;
    case "characters":
      return "Invisible or direction-changing characters aren't allowed.";
    case "markup":
      return "The characters < and > aren't allowed.";
    case "reserved":
      return "That name is reserved (Guest names and system words can't be chosen).";
  }
}
