import { test } from "node:test";
import assert from "node:assert/strict";
import { WATCH_HALL_ORIGIN, type HallClientMessage, type HallServerMessage } from "@project/shared";
import { WatchHall, type HallEffect, type HallPose } from "../watchHall.js";

/**
 * Moderation (ADR-019 §§ 1, 6) in the Watch Hall rules: a moderator has every host power without the host key, and a
 * turn taken from its holder (a host's or moderator's stop or grant, an audience vote, a cooldown) revokes the holder's
 * LiveKit publishing; a turn the holder ends itself does not.
 */

const INSIDE: HallPose = { x: WATCH_HALL_ORIGIN.x, z: WATCH_HALL_ORIGIN.z, animationState: "idle" };

function setup() {
  const revoked: string[] = [];
  let clock = 1_000_000;
  const hall = new WatchHall(() => clock, { revokePublisher: (id) => revoked.push(id) });
  // Every request moves the clock on 10 s, so the per-session op budget never runs dry in these sequences.
  const send = (id: string, message: HallClientMessage): HallEffect[] => {
    clock += 10_000;
    return hall.handle(id, message);
  };
  const enter = (...ids: string[]) => ids.forEach((id) => hall.updatePose(id, INSIDE));
  const live = (id: string) => {
    send(id, { type: "hall_stage_request" });
    send(id, { type: "hall_stage_live", live: true, audio: false });
    assert.equal(hall.stageState().status, "live");
  };
  return { hall, send, enter, live, revoked };
}

const errorOf = (effects: HallEffect[]): string | null => {
  const error = effects.find((effect) => effect.message.type === "hall_error")?.message as Extract<HallServerMessage, { type: "hall_error" }> | undefined;
  return error ? `${error.op}:${error.reason}` : null;
};

test("a moderator has every host power (lock, stop, dequeue, cooldown) without the host key, and is listed as a host", () => {
  const { hall, send, enter } = setup();
  enter("mod", "A", "B");
  assert.equal(errorOf(send("mod", { type: "hall_stage_lock", locked: true })), "lock:not_host", "not yet a moderator");
  const signedIn = hall.setModerator("mod", true);
  const state = signedIn.find((effect) => effect.message.type === "hall_state" && effect.to.includes("mod"))?.message as Extract<HallServerMessage, { type: "hall_state" }>;
  assert.equal(state.host, true);
  assert.ok(signedIn.some((effect) => effect.message.type === "hall_hosts" && effect.to.includes("A")), "members see the host list change");
  assert.equal(errorOf(send("mod", { type: "hall_stage_lock", locked: true })), null);
  assert.equal(hall.stageState().locked, true);
  send("A", { type: "hall_stage_request" });
  send("B", { type: "hall_stage_request" });
  assert.equal(errorOf(send("mod", { type: "hall_stage_dequeue", playerId: "B" })), null);
  assert.deepEqual(hall.stageState().queue, ["A"]);
  assert.equal(errorOf(send("mod", { type: "hall_stage_handover", to: "A" })), null, "a moderator grants a locked stage");
  assert.equal(hall.stageState().holder, "A");
  assert.equal(errorOf(send("mod", { type: "hall_stage_cooldown", playerId: "A", ms: 60_000 })), null);
  assert.equal(hall.stageState().holder, null);
  // The lock dies with the last host or moderator session.
  hall.forget("mod");
  assert.equal(hall.stageState().locked, false);
});

test("revoke: a host's stop, a host's grant over a live holder, a cooldown and a vote revoke the holder; the holder's own stop doesn't", () => {
  const { hall, send, enter, live, revoked } = setup();
  enter("mod", "A", "B", "v1", "v2", "v3");
  hall.setModerator("mod", true);
  // The holder's own stop and its own live:false: no revoke.
  live("A");
  send("A", { type: "hall_stage_stop" });
  live("A");
  send("A", { type: "hall_stage_live", live: false, audio: false });
  assert.deepEqual(revoked, []);
  // A moderator's stop.
  live("A");
  send("mod", { type: "hall_stage_stop" });
  assert.deepEqual(revoked, ["A"]);
  // A moderator granting the stage to a raised hand while A is live.
  live("A");
  send("B", { type: "hall_hand", raised: true });
  send("mod", { type: "hall_stage_handover", to: "B" });
  assert.equal(hall.stageState().holder, "B");
  assert.deepEqual(revoked, ["A", "A"]);
  // A holder handing over to the queue is its own choice: no revoke.
  send("A", { type: "hall_stage_request" });
  send("B", { type: "hall_stage_handover", to: "A" });
  assert.equal(hall.stageState().holder, "A");
  assert.deepEqual(revoked, ["A", "A"]);
  // A cooldown on the holder.
  send("A", { type: "hall_stage_live", live: true, audio: false });
  send("mod", { type: "hall_stage_cooldown", playerId: "A", ms: 60_000 });
  assert.deepEqual(revoked, ["A", "A", "A"]);
  // An audience vote (bar 3 with 5 others present).
  live("B");
  for (const voter of ["v1", "v2", "v3"]) send(voter, { type: "hall_stage_vote", end: true });
  assert.equal(hall.stageState().holder, null);
  assert.deepEqual(revoked, ["A", "A", "A", "B"]);
});
