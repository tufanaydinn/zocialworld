import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeNickname, resolveUniqueNickname } from "./nickname.js";

// --- sanitizeNickname ----------------------------------------------------
// CORE-003 §23 Tests 1-4.

test("Test 1: a valid nickname is accepted, trimmed", () => {
  assert.equal(sanitizeNickname("Tufan"), "Tufan");
  assert.equal(sanitizeNickname("  Tufan  "), "Tufan");
});

test("Test 2: an empty or whitespace-only nickname is rejected", () => {
  assert.equal(sanitizeNickname(""), null);
  assert.equal(sanitizeNickname("   "), null);
  assert.equal(sanitizeNickname("\t\n"), null);
});

test("Test 3: an over-length nickname is rejected", () => {
  const tooLong = "a".repeat(25); // MAX_NICKNAME_LENGTH is 24
  assert.equal(sanitizeNickname(tooLong), null);

  const exactly24 = "a".repeat(24);
  assert.equal(sanitizeNickname(exactly24), exactly24);
});

test("Test 4: a nickname containing control characters is rejected", () => {
  assert.equal(sanitizeNickname("Tufan\u0007"), null); // bell
  assert.equal(sanitizeNickname("Tufan\u0000"), null); // NUL
  assert.equal(sanitizeNickname("Tu\nfan"), null); // embedded newline
  assert.equal(sanitizeNickname("Tufan\u007F"), null); // DEL
});

test("a nickname resembling a markup/script payload is rejected", () => {
  assert.equal(sanitizeNickname("<script>alert(1)</script>"), null);
  assert.equal(sanitizeNickname("<img src=x onerror=alert(1)>"), null);
  assert.equal(sanitizeNickname("Tufan<b>"), null);
});

// --- resolveUniqueNickname -------------------------------------------------
// CORE-003 §23 Test 5 (pure-function half; the integration half lives in
// WorldServer.test.ts, which drives this through real `join`/`set_nickname`
// messages across real connections).

test("Test 5: a free nickname is returned unchanged", () => {
  const result = resolveUniqueNickname("Tufan", () => false);
  assert.equal(result, "Tufan");
});

test("Test 5: a taken nickname is resolved with a deterministic -2 suffix", () => {
  const taken = new Set(["Tufan"]);
  const result = resolveUniqueNickname("Tufan", (name) => taken.has(name));
  assert.equal(result, "Tufan-2");
});

test("Test 5: repeated conflicts increment the suffix predictably", () => {
  const taken = new Set(["Tufan", "Tufan-2", "Tufan-3"]);
  const result = resolveUniqueNickname("Tufan", (name) => taken.has(name));
  assert.equal(result, "Tufan-4");
});

// --- Max-length conflict resolution (CORE-003 merge-gate fix) -------------
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
