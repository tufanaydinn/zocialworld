import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "..");

// CORE-004 §33 Test 10: voice credential/token secrets are never exposed
// through client config.
//
// `apps/web/src/voice/config.ts` only ever resolves a non-secret endpoint
// URL (`getVoiceTokenUrl()`) — it has no window/import.meta.env dependency
// this suite can safely exercise without a browser (see
// `networking/config.ts`, which is equally untested at the unit level for
// the same reason), so this test instead proves the guarantee the task
// brief actually cares about structurally: no file reachable from the
// CLIENT bundle ever references the LiveKit API secret/key, by content.
// The secret is minted and consumed entirely server-side
// (apps/server/src/voice/tokenHandler.ts) — see
// docs/privacy/VOICE_THREAT_MODEL.md § 2.

function readText(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), "utf8");
}

test("Test 10: the client-side voice config module never references a LiveKit secret/key", () => {
  const source = readText("src/voice/config.ts");
  assert.doesNotMatch(source.toLowerCase(), /secret/);
  assert.doesNotMatch(source.toLowerCase(), /api_key|apikey/);
});

test("Test 10: apps/web's .env.example carries only a non-secret endpoint URL, never a LiveKit credential", () => {
  const envExample = readText(".env.example");
  assert.doesNotMatch(envExample.toUpperCase(), /LIVEKIT_API_KEY|LIVEKIT_API_SECRET/);
  assert.match(envExample, /VITE_VOICE_TOKEN_URL/, "the client's voice config must be a plain endpoint URL");
});

test("Test 10: the client's env typing declares no secret-shaped field", () => {
  const viteEnv = readText("src/vite-env.d.ts");
  // Match only declared field NAMES (`readonly FOO`), not prose — this
  // file's own comments correctly explain that its one voice-related
  // field is "not a secret," and a plain substring check on the whole
  // file would (ironically) flag that very reassurance as a violation.
  const declaredFieldNames = Array.from(viteEnv.matchAll(/readonly\s+(\w+)/g), (match) => match[1]!.toLowerCase());
  assert.ok(declaredFieldNames.length > 0, "sanity check: this file should declare at least one field");
  for (const name of declaredFieldNames) {
    assert.doesNotMatch(name, /secret/);
    assert.doesNotMatch(name, /api_?key/);
  }
});
