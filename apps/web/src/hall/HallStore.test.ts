import { test } from "node:test";
import assert from "node:assert/strict";
import type { HallReactionsBroadcast, HallStageState, HallStateMessage } from "@project/shared";
import { HallStore, hallStoreFeed, type HallStoreEvent } from "./HallStore.ts";

// The client mirror of the server's hall state (docs/architecture/WATCH_HALL.md).

const STAGE: HallStageState = { holder: "p1", status: "live", since: 1, queue: ["p2", "me"], card: { title: "Talk" }, locked: false, audio: true };

function stateMessage(overrides: Partial<HallStateMessage> = {}): HallStateMessage {
  return { type: "hall_state", stage: STAGE, seats: [[3, "p2"], [10, "me"]], hands: ["p3", "p4"], floor: "p3", hosts: ["p5"], host: false, totals: { clap: 4 }, session: { id: 2, active: true }, vote: { votes: 1, needed: 3, voted: false }, ...overrides };
}
/** A hall_reactions frame with the session fields. */
const batch = (counts: HallReactionsBroadcast["counts"], totals: HallReactionsBroadcast["totals"], session = { id: 2, active: true }): HallReactionsBroadcast => ({
  type: "hall_reactions",
  counts,
  sample: [{ playerId: "p1", reaction: "clap" }],
  totals,
  session,
});

function setup() {
  const store = new HallStore();
  store.setLocalPlayerId("me");
  const events: HallStoreEvent[] = [];
  store.subscribe((event) => events.push(event));
  return { store, events };
}

test("hall_state makes the session a member and fills every part; helpers answer from it", () => {
  const { store, events } = setup();
  assert.equal(store.member, false);
  assert.equal(store.stage.status, "idle");
  store.apply(stateMessage());
  assert.equal(store.member, true);
  assert.deepEqual(events, [{ type: "change", parts: ["member", "stage", "seats", "hands", "floor", "hosts", "vote"] }]);
  assert.deepEqual(store.vote, { votes: 1, needed: 3, voted: false });
  assert.equal(store.isHolder("p1"), true);
  assert.equal(store.amHolder, false);
  assert.equal(store.amQueued, true);
  assert.equal(store.queuePosition("me"), 2);
  assert.equal(store.queuePosition("p9"), 0);
  assert.equal(store.seatOf("me"), 10);
  assert.equal(store.mySeat, 10);
  assert.equal(store.occupantOf(3), "p2");
  assert.equal(store.isSeatFree(4), true);
  assert.equal(store.isFloor("p3"), true);
  assert.equal(store.hasHandRaised("p4"), true);
  assert.equal(store.myHandRaised, false);
  assert.equal(store.isHostPlayer("p5"), true);
  assert.equal(store.isHost, false);
  assert.equal(store.hasStageMic("p1"), true, "holder");
  assert.equal(store.hasStageMic("p3"), true, "floor");
  assert.equal(store.hasStageMic("p2"), false);
  store.apply(stateMessage({ host: true }));
  assert.equal(store.isHost, true);
});

test("seat deltas keep seatId→playerId and playerId→seatId consistent", () => {
  const { store, events } = setup();
  store.apply(stateMessage());
  events.length = 0;
  store.apply({ type: "hall_seat", seatId: 10, playerId: null });
  store.apply({ type: "hall_seat", seatId: 11, playerId: "me" });
  assert.equal(store.seatOf("me"), 11);
  assert.equal(store.isSeatFree(10), true);
  // A move that arrives as a single claim still frees the old seat locally.
  store.apply({ type: "hall_seat", seatId: 12, playerId: "me" });
  assert.equal(store.seatOf("me"), 12);
  assert.equal(store.isSeatFree(11), true);
  // A seat taken over by someone else drops the previous occupant's reverse entry.
  store.apply({ type: "hall_seat", seatId: 3, playerId: "p7" });
  assert.equal(store.seatOf("p2"), null);
  assert.equal(store.occupantOf(3), "p7");
  assert.deepEqual([...store.seats.entries()].sort((a, b) => a[0] - b[0]), [
    [3, "p7"],
    [12, "me"],
  ]);
  assert.ok(events.every((event) => event.type === "change" && event.parts.length === 1 && event.parts[0] === "seats"));
});

test("stage, hands, floor and hosts deltas replace their part and say which part changed", () => {
  const { store, events } = setup();
  store.apply(stateMessage());
  events.length = 0;
  store.apply({ type: "hall_stage", stage: { ...STAGE, holder: "me", status: "preparing", queue: [] } });
  assert.equal(store.amHolder, true);
  store.apply({ type: "hall_hands", hands: ["me"] });
  assert.equal(store.myHandRaised, true);
  store.apply({ type: "hall_floor", playerId: null });
  assert.equal(store.floor, null);
  store.apply({ type: "hall_hosts", hosts: [] });
  assert.deepEqual(store.hosts, []);
  assert.deepEqual(
    events.map((event) => (event.type === "change" ? event.parts : [])),
    [["stage"], ["hands"], ["floor"], ["hosts"]],
  );
});

test("hall_vote updates the vote (members only); hall_exit and a disconnect clear it; a cooldown refusal carries retryInMs", () => {
  const { store, events } = setup();
  store.apply({ type: "hall_vote", votes: 2, needed: 3, voted: true });
  assert.deepEqual(store.vote, { votes: 0, needed: 0, voted: false }, "ignored while not a member");
  store.apply(stateMessage());
  events.length = 0;
  store.apply({ type: "hall_vote", votes: 2, needed: 3, voted: true });
  assert.deepEqual(store.vote, { votes: 2, needed: 3, voted: true });
  assert.deepEqual(events, [{ type: "change", parts: ["vote"] }]);
  store.apply({ type: "hall_error", op: "stage", reason: "cooldown", retryInMs: 540_000 });
  assert.deepEqual(events.at(-1), { type: "error", op: "stage", reason: "cooldown", retryInMs: 540_000 });
  store.apply({ type: "hall_exit" });
  assert.deepEqual(store.vote, { votes: 0, needed: 0, voted: false });
});

test("reaction batches and refusals are forwarded as events", () => {
  const { store, events } = setup();
  store.apply({ type: "hall_error", op: "stage", reason: "not_in_hall" });
  assert.deepEqual(events, [{ type: "error", op: "stage", reason: "not_in_hall" }], "refusals arrive even outside the hall");
  store.apply(batch({ clap: 2 }, { clap: 2 }));
  assert.equal(events.length, 1, "reactions are ignored while not a member");
  assert.deepEqual(store.reactionTotals, {});
  store.apply(stateMessage());
  store.apply(batch({ clap: 2 }, { clap: 6 }));
  assert.deepEqual(events.at(-1), { type: "reactions", counts: { clap: 2 }, sample: [{ playerId: "p1", reaction: "clap" }] });
});

test("the session's reaction totals come from the server and are replaced, never summed; hall_exit drops them", () => {
  const { store } = setup();
  assert.deepEqual(store.reactionSession, { id: 0, active: false });
  store.apply(stateMessage());
  assert.deepEqual(store.reactionTotals, { clap: 4 });
  assert.deepEqual(store.reactionSession, { id: 2, active: true });
  store.apply(batch({ clap: 1 }, { clap: 5, heart: 1 }));
  assert.deepEqual(store.reactionTotals, { clap: 5, heart: 1 }, "the server's totals, not 4 + 1");
  store.apply(batch({}, { clap: 5, heart: 1 }, { id: 2, active: false }));
  assert.deepEqual(store.reactionSession, { id: 2, active: false }, "the turn ended: the last session's totals stay");
  store.apply(batch({}, {}, { id: 3, active: true }));
  assert.deepEqual(store.reactionTotals, {}, "a new turn starts from zero");
  store.apply({ type: "hall_exit" });
  assert.deepEqual(store.reactionTotals, {});
  assert.deepEqual(store.reactionSession, { id: 0, active: false });
});

test("hall_exit drops everything; deltas after it are ignored; unsubscribe stops events", () => {
  const { store, events } = setup();
  store.apply(stateMessage({ host: true }));
  store.apply({ type: "hall_exit" });
  assert.equal(store.member, false);
  assert.equal(store.stage.holder, null);
  assert.deepEqual(store.stage.queue, []);
  assert.equal(store.seats.size, 0);
  assert.equal(store.seatOf("me"), null);
  assert.deepEqual(store.hands, []);
  assert.equal(store.floor, null);
  assert.equal(store.isHost, false);
  assert.equal(store.localPlayerId, "me", "the session id survives hall_exit");
  const count = events.length;
  store.apply({ type: "hall_seat", seatId: 1, playerId: "p1" });
  store.apply({ type: "hall_stage", stage: STAGE });
  assert.equal(store.seats.size, 0);
  assert.equal(store.stage.holder, null);
  assert.equal(events.length, count);
  store.apply({ type: "hall_exit" });
  assert.equal(events.length, count, "a second exit with nothing to drop is silent");

  const other = new HallStore();
  let heard = 0;
  const unsubscribe = other.subscribe(() => heard++);
  other.apply(stateMessage());
  unsubscribe();
  other.apply({ type: "hall_exit" });
  assert.equal(heard, 1);
});

test("hallStoreFeed: welcome sets the session id, a dropped connection clears the store and the id", () => {
  const store = new HallStore();
  const feed = hallStoreFeed(store);
  feed.onStateChange("connecting");
  feed.onStateChange("connected");
  feed.onWelcome({ playerId: "me" });
  feed.onHall(stateMessage());
  assert.equal(store.member, true);
  assert.equal(store.mySeat, 10);
  feed.onStateChange("connected");
  assert.equal(store.member, true, "staying connected changes nothing");
  feed.onStateChange("disconnected");
  assert.equal(store.member, false);
  assert.equal(store.seats.size, 0);
  assert.equal(store.localPlayerId, null);
});
