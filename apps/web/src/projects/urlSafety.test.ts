import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeExternalUrl } from "./urlSafety.ts";

// `createSafeExternalLink()` touches `document.createElement` and is
// exercised by the real-browser e2e suite instead (tests/e2e/projects.spec.ts)
// — this Node test runner has no DOM, same reasoning every other
// DOM-rendering-safety test in this codebase already follows (see
// tests/e2e/social.spec.ts's own header comment).

// Unsafe external URLs are rejected.
test("Test 10: unsafe URL schemes are rejected", () => {
  assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
  assert.equal(isSafeExternalUrl("data:text/html,<script>alert(1)</script>"), false);
  assert.equal(isSafeExternalUrl("vbscript:msgbox(1)"), false);
});

test("Test 10b: malformed/missing URLs are rejected, not thrown", () => {
  assert.equal(isSafeExternalUrl("not a url"), false);
  assert.equal(isSafeExternalUrl("example.com"), false); // no protocol — new URL() throws, treated as unsafe
  assert.equal(isSafeExternalUrl(""), false);
  assert.equal(isSafeExternalUrl(undefined), false);
  assert.equal(isSafeExternalUrl(null), false);
});

// Safe https URLs are accepted.
test("Test 11: a well-formed https URL is accepted", () => {
  assert.equal(isSafeExternalUrl("https://example.com"), true);
  assert.equal(isSafeExternalUrl("https://example.com/path?query=1"), true);
});

test("a well-formed http URL is also accepted (http or https)", () => {
  assert.equal(isSafeExternalUrl("http://example.com"), true);
});
