import { test } from "node:test";
import assert from "node:assert/strict";
import { VoiceCapabilityRegistry } from "./capability.ts";

// CORE-004 security revision ().
// Pure unit tests for the registry itself — see WorldServer.test.ts for
// the integration-level tests (A, B, C, F, G, H, I) that exercise it
// through real join/set_nickname/disconnect/stale-cleanup/reconnect flows.

test("issue() returns a non-empty string, distinct across different playerIds", () => {
  const registry = new VoiceCapabilityRegistry();
  const a = registry.issue("player-a");
  const b = registry.issue("player-b");
  assert.ok(a.length > 0);
  assert.ok(b.length > 0);
  assert.notEqual(a, b);
});

test("resolve() returns the playerId a capability was issued to", () => {
  const registry = new VoiceCapabilityRegistry();
  const capability = registry.issue("player-a");
  assert.equal(registry.resolve(capability), "player-a");
});

test("resolve() returns null for an unknown capability", () => {
  const registry = new VoiceCapabilityRegistry();
  registry.issue("player-a");
  assert.equal(registry.resolve("not-a-real-capability"), null);
  assert.equal(registry.resolve(""), null);
});

test("issuing a second capability for the same playerId invalidates the first (at most one live capability per session)", () => {
  const registry = new VoiceCapabilityRegistry();
  const first = registry.issue("player-a");
  const second = registry.issue("player-a");
  assert.notEqual(first, second);
  assert.equal(registry.resolve(first), null, "the superseded capability must no longer resolve");
  assert.equal(registry.resolve(second), "player-a");
});

test("revoke() invalidates a playerId's current capability", () => {
  const registry = new VoiceCapabilityRegistry();
  const capability = registry.issue("player-a");
  registry.revoke("player-a");
  assert.equal(registry.resolve(capability), null);
});

test("revoke() on a playerId with no capability is a harmless no-op", () => {
  const registry = new VoiceCapabilityRegistry();
  assert.doesNotThrow(() => registry.revoke("never-issued"));
});

test("two different playerIds' capabilities never collide or cross-resolve", () => {
  const registry = new VoiceCapabilityRegistry();
  const a = registry.issue("player-a");
  const b = registry.issue("player-b");
  assert.equal(registry.resolve(a), "player-a");
  assert.equal(registry.resolve(b), "player-b");
  registry.revoke("player-a");
  assert.equal(registry.resolve(a), null);
  assert.equal(registry.resolve(b), "player-b", "revoking A's capability must never affect B's");
});
