import { test } from "node:test";
import assert from "node:assert/strict";
import { checkNicknameLocally, isReservedNickname, nicknameKey } from "./nicknameRules.ts";

// The client copy of the server's nickname rules (apps/server/src/nickname.ts) — same cases as nickname.test.ts.

test("valid names are NFKC-normalised and trimmed, exactly as the server stores them", () => {
  assert.deepEqual(checkNicknameLocally("  Alice  "), { ok: true, nickname: "Alice" });
  assert.deepEqual(checkNicknameLocally("Ａｌｉｃｅ"), { ok: true, nickname: "Alice" });
  assert.deepEqual(checkNicknameLocally("Alice Müller"), { ok: true, nickname: "Alice Müller" });
});

test("shape problems: empty, too long, invisible/bidi characters, markup", () => {
  assert.deepEqual(checkNicknameLocally("   "), { ok: false, problem: "empty" });
  assert.deepEqual(checkNicknameLocally("a".repeat(25)), { ok: false, problem: "too_long" });
  assert.deepEqual(checkNicknameLocally("a".repeat(24)), { ok: true, nickname: "a".repeat(24) });
  for (const sneaky of ["Al\u200bice", "\u202eAlice", "Al\u2066ice", "Al\ufeffice", "Al\u0007ice"]) assert.deepEqual(checkNicknameLocally(sneaky), { ok: false, problem: "characters" }, JSON.stringify(sneaky));
  assert.deepEqual(checkNicknameLocally("<script>"), { ok: false, problem: "markup" });
});

test("the Guest pattern, its look-alikes and the system words are reserved", () => {
  for (const name of ["Guest-1234", "guest 12", "GUEST_7", "Guest–1234", "Ｇｕｅｓｔ－１", "admin", "Zocial World", "zocial-world"]) {
    assert.equal(isReservedNickname(name.normalize("NFKC")), true, name);
    assert.deepEqual(checkNicknameLocally(name), { ok: false, problem: "reserved" }, name);
  }
  for (const name of ["Guestbook", "Hosted", "Alice"]) assert.equal(isReservedNickname(name), false, name);
});

test("nicknameKey folds case after NFKC", () => {
  assert.equal(nicknameKey("Alice"), nicknameKey("ALICE"));
  assert.equal(nicknameKey("ａｌｉｃｅ"), nicknameKey("Alice"));
});
