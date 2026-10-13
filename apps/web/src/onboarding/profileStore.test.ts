import { test } from "node:test";
import assert from "node:assert/strict";
import { PROFILE_STORAGE_KEY, clearProfile, loadProfile, parseProfile, profileAfterEntering, saveProfile, type ProfileStorage } from "./profileStore.ts";

// ADR-015 § 7: what the device remembers — the character, and a name for holders only — behind try/catch.

function memoryStorage(initial: Record<string, string> = {}): ProfileStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

const throwing: ProfileStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

test("a saved holder profile loads back (avatar + name); a guest profile never keeps a name", () => {
  const storage = memoryStorage();
  assert.equal(saveProfile({ v: 1, lastMode: "holder", avatar: { model: "mage", color: 3 }, nickname: "Alice" }, storage), true);
  assert.deepEqual(loadProfile(storage), { v: 1, lastMode: "holder", avatar: { model: "mage", color: 3 }, nickname: "Alice" });
  saveProfile({ v: 1, lastMode: "guest", nickname: "Sneaky" }, storage);
  assert.deepEqual(loadProfile(storage), { v: 1, lastMode: "guest" }, "names are a holder thing");
  assert.ok(!JSON.stringify(storage.data).includes("Sneaky"));
});

test("corrupt, foreign or wrong-version data reads as no profile (the first-visit flow)", () => {
  for (const text of ["not json", "null", "[]", "42", JSON.stringify({ v: 2, lastMode: "guest" }), JSON.stringify({ v: 1, lastMode: "admin" }), JSON.stringify({ v: 1 })]) {
    assert.equal(loadProfile(memoryStorage({ [PROFILE_STORAGE_KEY]: text })), null, text);
  }
  assert.equal(loadProfile(memoryStorage()), null);
});

test("invalid optional fields are dropped, not fatal: a bad avatar or a reserved/markup name is forgotten", () => {
  assert.deepEqual(parseProfile({ v: 1, lastMode: "holder", avatar: { model: "dragon", color: 1 }, nickname: "Guest-1234" }), { v: 1, lastMode: "holder" });
  assert.deepEqual(parseProfile({ v: 1, lastMode: "holder", nickname: "<b>hi</b>" }), { v: 1, lastMode: "holder" });
  assert.deepEqual(parseProfile({ v: 1, lastMode: "holder", nickname: "  Ａｌｉｃｅ  " }), { v: 1, lastMode: "holder", nickname: "Alice" }, "stored as the server would store it");
});

test("storage that throws (private mode, blocked site data) never breaks anything", () => {
  assert.equal(loadProfile(throwing), null);
  assert.equal(saveProfile({ v: 1, lastMode: "guest" }, throwing), false);
  assert.doesNotThrow(() => clearProfile(throwing));
  assert.equal(loadProfile(null), null);
  assert.equal(saveProfile({ v: 1, lastMode: "guest" }, null), false);
});

test("the e2e seed { autoEnter: 'guest' } is a valid profile; anything else in autoEnter is ignored", () => {
  assert.deepEqual(parseProfile({ autoEnter: "guest" }), { v: 1, lastMode: "guest", autoEnter: "guest" });
  assert.equal(parseProfile({ autoEnter: "holder" }), null);
  assert.deepEqual(parseProfile({ v: 1, lastMode: "guest", autoEnter: "always" }), { v: 1, lastMode: "guest" });
});

test("profileAfterEntering: a holder's choice is kept; 'Enter as guest' keeps a remembered holder; forgetting the wallet drops the name", () => {
  const holder = profileAfterEntering(null, { mode: "holder", avatar: { model: "knight", color: 1 }, nickname: "Ada" });
  assert.deepEqual(holder, { v: 1, lastMode: "holder", avatar: { model: "knight", color: 1 }, nickname: "Ada" });
  assert.deepEqual(profileAfterEntering(holder, { mode: "holder", nickname: "Ada2" }), { v: 1, lastMode: "holder", avatar: { model: "knight", color: 1 }, nickname: "Ada2" }, "a later rename keeps the avatar");
  assert.deepEqual(profileAfterEntering(holder, { mode: "guest" }), holder, "Welcome back → Enter as guest: still remembered for next time");
  assert.deepEqual(profileAfterEntering(holder, { mode: "guest" }, false), { v: 1, lastMode: "guest", avatar: { model: "knight", color: 1 } }, "Forget this wallet: the name goes");
  assert.deepEqual(profileAfterEntering(null, { mode: "guest" }), { v: 1, lastMode: "guest" });
  assert.deepEqual(profileAfterEntering({ v: 1, lastMode: "guest", autoEnter: "guest" }, { mode: "holder", nickname: "T" }), { v: 1, lastMode: "holder", nickname: "T", autoEnter: "guest" }, "the test seed survives");
});
