import { test } from "node:test";
import assert from "node:assert/strict";
import { embedUrl, parseVideoId, supportsCredentialless, watchUrl } from "./youtube.ts";

test("parseVideoId accepts bare ids, youtube.com and youtu.be links only", () => {
  assert.equal(parseVideoId("vidBBBB0002"), "vidBBBB0002");
  assert.equal(parseVideoId(" -vidEEE0005 "), "-vidEEE0005");
  assert.equal(parseVideoId("https://www.youtube.com/watch?v=vidBBBB0002"), "vidBBBB0002");
  assert.equal(parseVideoId("https://youtube.com/watch?feature=share&v=vidBBBB0002&t=30"), "vidBBBB0002");
  assert.equal(parseVideoId("https://m.youtube.com/watch?v=vidBBBB0002"), "vidBBBB0002");
  assert.equal(parseVideoId("https://youtu.be/vidBBBB0002?t=12"), "vidBBBB0002");
  assert.equal(parseVideoId("https://www.youtube.com/live/vidBBBB0002"), "vidBBBB0002");
  assert.equal(parseVideoId("https://www.youtube.com/embed/vidBBBB0002"), "vidBBBB0002");
  for (const rejected of [
    "gJA1brRxnf",
    "vidBBBB00024",
    "gJA1brRx f4",
    "http://www.youtube.com/watch?v=vidBBBB0002",
    "https://www.youtube.com.evil.example/watch?v=vidBBBB0002",
    "https://evil.example/watch?v=vidBBBB0002",
    "https://www.youtube-nocookie.com/embed/vidBBBB0002",
    "https://www.youtube.com/watch?v=vidBBBB0002%22",
    "https://www.youtube.com/playlist?list=PLtestplaylist00000000000000000000",
    "https://user@www.youtube.com/watch?v=vidBBBB0002",
    "javascript:alert(1)",
    "",
  ]) {
    assert.equal(parseVideoId(rejected), null, rejected);
  }
});

test("embed and watch URLs are built from validated ids only", () => {
  assert.equal(embedUrl("vidBBBB0002"), "https://www.youtube-nocookie.com/embed/vidBBBB0002?autoplay=1&rel=0");
  assert.equal(watchUrl("vidBBBB0002"), "https://www.youtube.com/watch?v=vidBBBB0002");
  assert.throws(() => embedUrl("../../evil"), TypeError);
  assert.throws(() => watchUrl("x\"onload=1"), TypeError);
});

test("supportsCredentialless reflects HTMLIFrameElement.prototype.credentialless", () => {
  const scope = globalThis as unknown as { HTMLIFrameElement?: unknown };
  const original = scope.HTMLIFrameElement;
  try {
    delete scope.HTMLIFrameElement;
    assert.equal(supportsCredentialless(), false, "no DOM at all");
    class WithoutFlag {}
    scope.HTMLIFrameElement = WithoutFlag;
    assert.equal(supportsCredentialless(), false);
    class WithFlag {
      credentialless = false;
    }
    Object.defineProperty(WithFlag.prototype, "credentialless", { value: false, configurable: true });
    scope.HTMLIFrameElement = WithFlag;
    assert.equal(supportsCredentialless(), true);
  } finally {
    if (original === undefined) delete scope.HTMLIFrameElement;
    else scope.HTMLIFrameElement = original;
  }
});
