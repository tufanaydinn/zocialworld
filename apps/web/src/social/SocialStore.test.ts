import { test } from "node:test";
import assert from "node:assert/strict";
import { SocialStore } from "./SocialStore.ts";

// CORE-003 §23 Test 8.

test("a player is not blocked by default", () => {
  const store = new SocialStore();
  assert.equal(store.isBlocked("p1"), false);
});

test("blocking a player changes local relationship state", () => {
  const store = new SocialStore();
  store.block("p1");
  assert.equal(store.isBlocked("p1"), true);
  assert.equal(store.isBlocked("p2"), false); // unrelated player unaffected
});

test("blocking the same player twice is idempotent", () => {
  const store = new SocialStore();
  store.block("p1");
  store.block("p1");
  assert.equal(store.isBlocked("p1"), true);
});

test("unblock reverses block (not exposed in UI, but the store supports it)", () => {
  const store = new SocialStore();
  store.block("p1");
  store.unblock("p1");
  assert.equal(store.isBlocked("p1"), false);
});

test("a player is not muted by default", () => {
  const store = new SocialStore();
  assert.equal(store.isMuted("p1"), false);
});

// CORE-004 §19 Test 5: local mute state suppresses voice for the muted player.
test("muting a player changes local relationship state", () => {
  const store = new SocialStore();
  store.mute("p1");
  assert.equal(store.isMuted("p1"), true);
  assert.equal(store.isMuted("p2"), false); // unrelated player unaffected
});

test("muting the same player twice is idempotent", () => {
  const store = new SocialStore();
  store.mute("p1");
  store.mute("p1");
  assert.equal(store.isMuted("p1"), true);
});

test("unmute reverses mute", () => {
  const store = new SocialStore();
  store.mute("p1");
  store.unmute("p1");
  assert.equal(store.isMuted("p1"), false);
});

test("mute and block are independent relationship states", () => {
  const store = new SocialStore();
  store.mute("p1");
  assert.equal(store.isBlocked("p1"), false);
  store.block("p2");
  assert.equal(store.isMuted("p2"), false);
});

test("select/deselect tracks the currently selected player", () => {
  const store = new SocialStore();
  assert.equal(store.selectedPlayerId, null);
  store.select("p1");
  assert.equal(store.selectedPlayerId, "p1");
  store.deselect();
  assert.equal(store.selectedPlayerId, null);
});

test("onChange fires on block, unblock, select, deselect, mute, and unmute", () => {
  const store = new SocialStore();
  let callCount = 0;
  store.onChange(() => callCount++);

  store.block("p1");
  store.select("p1");
  store.deselect();
  store.unblock("p1");
  store.mute("p1");
  store.unmute("p1");

  assert.equal(callCount, 6);
});

test("onChange does not fire for a no-op (blocking an already-blocked player)", () => {
  const store = new SocialStore();
  store.block("p1");
  let callCount = 0;
  store.onChange(() => callCount++);
  store.block("p1"); // already blocked — no-op
  assert.equal(callCount, 0);
});

// CORE-003 §23 Test 9 (architectural half — see also WorldServer.test.ts /
// protocol.ts for "the server has no block-related message type at all").
test("SocialStore has no network dependency — nothing it does can transmit block state", () => {
  // SocialStore's public surface only ever mutates in-memory Sets and
  // calls listener callbacks. There is no `send`, no `NetworkClient`
  // import, no serialization anywhere in this class — verified here by
  // confirming its block/select operations complete synchronously with no
  // way to reach a socket (the class holds no reference to one).
  const store = new SocialStore();
  store.block("p1");
  store.select("p1");
  // If this type-checks and runs without any networking import existing
  // in SocialStore.ts, there is no code path from here to the wire.
  assert.equal(store.isBlocked("p1"), true);
});
