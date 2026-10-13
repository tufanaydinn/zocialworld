import { test } from "node:test";
import assert from "node:assert/strict";
import { UpdateGate, shouldOfferUpdate } from "./updatePrompt.ts";

/** "Update ready — reload" (ADR-018), only between actions. */

test("an update is offered only when both builds are known and differ", () => {
  assert.equal(shouldOfferUpdate("b1", "b2"), true);
  assert.equal(shouldOfferUpdate("b1", "b1"), false);
  assert.equal(shouldOfferUpdate("b1", null), false, "a server that doesn't know (development)");
  assert.equal(shouldOfferUpdate(null, "b2"), false);
  assert.equal(shouldOfferUpdate("dev", "b2"), false);
  assert.equal(shouldOfferUpdate("b1", ""), false);
});

test("reload at once when idle; while busy (a send, onboarding) it waits for the first idle moment", () => {
  let busy = true;
  let reloads = 0;
  const scheduled: (() => void)[] = [];
  const gate = new UpdateGate({ isBusy: () => busy, reload: () => reloads++, schedule: (fn) => scheduled.push(fn) });
  assert.equal(gate.request(), false, "busy: not now");
  assert.equal(gate.waiting, true);
  assert.equal(reloads, 0);
  assert.equal(gate.request(), false, "asking again does not stack timers");
  assert.equal(scheduled.length, 1);
  scheduled.shift()!(); // still busy: re-armed
  assert.equal(reloads, 0);
  assert.equal(scheduled.length, 1);
  busy = false;
  scheduled.shift()!();
  assert.equal(reloads, 1, "reloaded once the action finished");
  assert.equal(gate.waiting, false);
  assert.equal(gate.request(), true, "idle: at once");
  assert.equal(reloads, 2);
});

test("a cancelled wait never reloads", () => {
  let reloads = 0;
  const scheduled: (() => void)[] = [];
  const gate = new UpdateGate({ isBusy: () => true, reload: () => reloads++, schedule: (fn) => scheduled.push(fn) });
  gate.request();
  gate.cancel();
  scheduled.shift()!();
  assert.equal(reloads, 0);
});
