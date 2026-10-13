import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeNickname, resolveUniqueNickname, isReservedNickname, nicknameKey } from "./nickname.js";
import { defaultAvatar, isGuestNickname } from "./identity.js";

// --- ADR-015 § 9: normalisation, invisible characters, reserved names, the case-insensitive key

test("ADR-015: nicknames are NFKC-normalised (fullwidth letters and digits become plain ones)", () => {
  assert.equal(sanitizeNickname("Ｎａｄｉａ"), "Nadia");
  assert.equal(sanitizeNickname("  Ada１２  "), "Ada12");
  assert.equal(sanitizeNickname("＜b＞"), null, "fullwidth angle brackets normalise to markup and are rejected");
});

test("ADR-015: zero-width, bidi-control, C1 and BOM characters are rejected, not stripped", () => {
  for (const sneaky of ["Na\u200bdia", "Nadia\u200d", "\u202eNadia", "Na\u2066dia\u2069", "Na\ufeffdia", "Na\u0085dia", "Nadia\u200f"]) {
    assert.equal(sanitizeNickname(sneaky), null, JSON.stringify(sneaky));
  }
  assert.equal(sanitizeNickname("Nadia Núñez"), "Nadia Núñez", "ordinary non-ASCII letters and spaces stay allowed");
});

test("ADR-015: the Guest pattern and its look-alikes are reserved, and so are the system words", () => {
  const reserved = [
    "Guest-1234",
    "guest-1234",
    "GUEST 12",
    "guest",
    "Guest_7",
    "guest.0001",
    "Guest‐1234", // U+2010 HYPHEN
    "Guest–1234", // U+2013 EN DASH
    "Ｇｕｅｓｔ－１２３４", // fullwidth letters, hyphen-minus and digits (NFKC)
    "Guest﹣1234", // U+FE63 SMALL HYPHEN-MINUS (NFKC → "-")
    "system",
    "Admin",
    "HOST",
    "moderator",
    "Zocial World",
    "zocial_world",
    "ZocialWorld",
  ];
  for (const name of reserved) assert.equal(isReservedNickname(sanitizeNickname(name) ?? name), true, name);
  for (const name of ["Nadia", "Guestbook", "The Guest", "Hosted", "Admiral", "Zocial", "guest of honour"]) assert.equal(isReservedNickname(name), false, name);
});

test("ADR-015: nicknameKey is case-insensitive after NFKC", () => {
  assert.equal(nicknameKey("Nadia"), nicknameKey("nadia"));
  assert.equal(nicknameKey("NADIA"), nicknameKey("ｎａｄｉａ"));
  assert.equal(nicknameKey("Straße"), nicknameKey("STRASSE"));
  assert.notEqual(nicknameKey("Nadia"), nicknameKey("Nadia2"));
});

test("ADR-015: isGuestNickname matches only the exact server-generated shape", () => {
  assert.equal(isGuestNickname("Guest-1234"), true);
  for (const name of ["guest-1234", "Guest-123", "Guest-12345", "Guest 1234", "Guest-1234-2"]) assert.equal(isGuestNickname(name), false, name);
});

test("ADR-015: defaultAvatar matches the pre-ADR-015 remote-avatar mapping (colorSeed % 5 in AVATAR_MODELS order) and colour colorSeed % 8", () => {
  const order = ["rogue_hooded", "rogue", "knight", "mage", "barbarian"];
  for (const seed of [0, 1, 2, 3, 4, 5, 7, 8, 123, 359]) assert.deepEqual(defaultAvatar(seed), { model: order[seed % 5], color: seed % 8 });
});

// --- sanitizeNickname ----------------------------------------------------

test("a valid nickname is accepted, trimmed", () => {
  assert.equal(sanitizeNickname("Nadia"), "Nadia");
  assert.equal(sanitizeNickname("  Nadia  "), "Nadia");
});

test("an empty or whitespace-only nickname is rejected", () => {
  assert.equal(sanitizeNickname(""), null);
  assert.equal(sanitizeNickname("   "), null);
  assert.equal(sanitizeNickname("\t\n"), null);
});

test("an over-length nickname is rejected", () => {
  const tooLong = "a".repeat(25); // MAX_NICKNAME_LENGTH is 24
  assert.equal(sanitizeNickname(tooLong), null);

  const exactly24 = "a".repeat(24);
  assert.equal(sanitizeNickname(exactly24), exactly24);
});

test("a nickname containing control characters is rejected", () => {
  assert.equal(sanitizeNickname("Nadia\u0007"), null); // bell
  assert.equal(sanitizeNickname("Nadia\u0000"), null); // NUL
  assert.equal(sanitizeNickname("Tu\nfan"), null); // embedded newline
  assert.equal(sanitizeNickname("Nadia\u007F"), null); // DEL
});

test("a nickname resembling a markup/script payload is rejected", () => {
  assert.equal(sanitizeNickname("<script>alert(1)</script>"), null);
  assert.equal(sanitizeNickname("<img src=x onerror=alert(1)>"), null);
  assert.equal(sanitizeNickname("Nadia<b>"), null);
});

// --- resolveUniqueNickname -------------------------------------------------
// The pure-function half; the integration half lives in
// WorldServer.test.ts, which drives this through real `join`/`set_nickname`
// messages across real connections).

test("a free nickname is returned unchanged", () => {
  const result = resolveUniqueNickname("Nadia", () => false);
  assert.equal(result, "Nadia");
});

test("a taken nickname is resolved with a deterministic -2 suffix", () => {
  const taken = new Set(["Nadia"]);
  const result = resolveUniqueNickname("Nadia", (name) => taken.has(name));
  assert.equal(result, "Nadia-2");
});

test("repeated conflicts increment the suffix predictably", () => {
  const taken = new Set(["Nadia", "Nadia-2", "Nadia-3"]);
  const result = resolveUniqueNickname("Nadia", (name) => taken.has(name));
  assert.equal(result, "Nadia-4");
});

// --- Max-length conflict resolution ---------------------------------------
// The suffix must never push the result past MAX_NICKNAME_LENGTH (24) —
// the base is truncated as needed instead, and the suffix itself is
// always kept intact.

test("an exactly-max-length nickname with no conflict is returned unchanged", () => {
  const exactly24 = "a".repeat(24);
  const result = resolveUniqueNickname(exactly24, () => false);
  assert.equal(result, exactly24);
  assert.equal(result.length, 24);
});

test("an exactly-max-length nickname with a -2 conflict is truncated to fit, keeping the full suffix", () => {
  const exactly24 = "a".repeat(24);
  const taken = new Set([exactly24]);
  const result = resolveUniqueNickname(exactly24, (name) => taken.has(name));
  assert.equal(result, "a".repeat(22) + "-2");
  assert.equal(result.length, 24);
  assert.ok(result.endsWith("-2"), "the numeric suffix must be intact, never truncated");
});

test("a max-length conflict that reaches a multi-digit suffix (-10) still fits and keeps the suffix intact", () => {
  const exactly24 = "a".repeat(24);
  // Occupy the base and every suffixed variant from -2 through -9 so
  // resolution is forced to continue to the 3-character "-10" suffix.
  const taken = new Set([exactly24, ...Array.from({ length: 8 }, (_, i) => `${"a".repeat(22)}-${i + 2}`)]);
  const result = resolveUniqueNickname(exactly24, (name) => taken.has(name));
  assert.equal(result, "a".repeat(21) + "-10");
  assert.equal(result.length, 24);
  assert.ok(result.endsWith("-10"), "the multi-digit suffix must be intact, never truncated");
});

test("every resolved result stays within MAX_NICKNAME_LENGTH regardless of how many conflicts are simulated", () => {
  const exactly24 = "a".repeat(24);
  const taken = new Set<string>();
  for (let i = 0; i < 12; i++) {
    const resolved = resolveUniqueNickname(exactly24, (name) => taken.has(name));
    assert.ok(resolved.length <= 24, `resolved "${resolved}" (length ${resolved.length}) exceeds MAX_NICKNAME_LENGTH`);
    taken.add(resolved);
  }
});
