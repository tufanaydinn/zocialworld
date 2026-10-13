import { test } from "node:test";
import assert from "node:assert/strict";
import { LIVEKIT_DEV_KEY, LIVEKIT_DEV_SECRET, LOCAL_LIVEKIT_FLAG, loadVoiceConfig, localDevVoiceConfig } from "./config.js";

// `npm run dev` gives working voice out of the box — a local LiveKit (scripts/dev/livekit.mjs) and this
// server started with --local-livekit. Development only, opt-out, and a real LIVEKIT_* configuration always wins.

const ARGV = ["node", "src/index.ts", LOCAL_LIVEKIT_FLAG];

test("--local-livekit gives the --dev keys at ws://127.0.0.1:7880 in development", () => {
  assert.deepEqual(localDevVoiceConfig({}, ARGV), { apiKey: LIVEKIT_DEV_KEY, apiSecret: LIVEKIT_DEV_SECRET, url: "ws://127.0.0.1:7880", roomName: "public-world" });
  assert.deepEqual(localDevVoiceConfig({ NODE_ENV: "development", LOCAL_LIVEKIT_PORT: "7900", LIVEKIT_ROOM_NAME: "test-room" }, ARGV), {
    apiKey: "devkey",
    apiSecret: "secret",
    url: "ws://127.0.0.1:7900",
    roomName: "test-room",
  });
});

test("never without the flag, never in production, never with SKIP_LOCAL_LIVEKIT, never on a bad port", () => {
  assert.equal(localDevVoiceConfig({}, ["node", "src/index.ts"]), null, "plain `npm run dev:server` (and the e2e suite) keeps voice off");
  assert.equal(localDevVoiceConfig({ NODE_ENV: "production" }, ARGV), null);
  for (const skip of ["1", "true", "YES"]) assert.equal(localDevVoiceConfig({ SKIP_LOCAL_LIVEKIT: skip }, ARGV), null);
  assert.ok(localDevVoiceConfig({ SKIP_LOCAL_LIVEKIT: "0" }, ARGV), "only a truthy value opts out");
  for (const port of ["80", "65535", "abc", "7880.5"]) assert.equal(localDevVoiceConfig({ LOCAL_LIVEKIT_PORT: port }, ARGV), null, port);
});

test("a complete LIVEKIT_* configuration is read as before (the server prefers it over the local one)", () => {
  assert.equal(loadVoiceConfig({ LIVEKIT_URL: "ws://localhost:7880", LIVEKIT_API_KEY: "", LIVEKIT_API_SECRET: "" }), null, ".env.example's empty keys mean unconfigured");
  assert.deepEqual(loadVoiceConfig({ LIVEKIT_URL: "wss://voice.example", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" }), { apiKey: "k", apiSecret: "s", url: "wss://voice.example", roomName: "public-world" });
});
