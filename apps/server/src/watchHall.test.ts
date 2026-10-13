import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import {
  HALL_CARD_LINKS_MAX,
  HALL_HANDS_MAX,
  HALL_HOST_KEY_MAX,
  HALL_HOSTS_MAX,
  HALL_CARD_TITLE_MAX,
  HALL_REACTION_FLUSH_MS,
  HALL_REACTION_SAMPLE_MAX,
  HALL_SEAT_SETTLE_MS,
  HALL_STAGE_LEAVE_GRACE_MS,
  HALL_STAGE_PREPARE_TIMEOUT_MS,
  HALL_STAGE_QUEUE_MAX,
  WATCH_HALL_EXIT_MARGIN_METERS,
  WATCH_HALL_HALF_EXTENTS,
  WATCH_HALL_ORIGIN,
  type HallClientMessage,
  type HallServerMessage,
  type HallStageState,
} from "@project/shared";
import {
  HALL_DEFAULT_MAX_TURN_MS,
  HALL_HAND_BURST,
  HALL_HOST_ATTEMPTS_PER_SESSION,
  HALL_OP_BURST,
  HALL_REACT_BURST,
  WatchHall,
  cleanHallCardUrl,
  hallHostKeyProblem,
  insideWatchHall,
  validateHallCard,
  type HallEffect,
  type HallPose,
  type WatchHallOptions,
} from "./watchHall.js";
import { parseIncomingMessage } from "./protocol.js";
import { WorldServer, type WorldServerOptions } from "./WorldServer.js";
import { CHAT_BURST } from "./chat.js";
import { TokenBucket } from "./tokenBucket.js";

/**
 * The hall rules, pure, with a fake clock (docs/architecture/WATCH_HALL.md),
 * then the wire: parser shapes and real-socket delivery (like payments.test.ts).
 */

const HOST_KEY = "correct-horse-battery-staple-42";
const INSIDE: HallPose = { x: WATCH_HALL_ORIGIN.x, z: WATCH_HALL_ORIGIN.z, animationState: "idle" };
const OUTSIDE: HallPose = { x: 0, z: 0, animationState: "idle" };

function setup(options: WatchHallOptions = {}) {
  let clock = 1_000_000;
  const hall = new WatchHall(() => clock, options);
  const enter = (...ids: string[]): void => {
    for (const id of ids) hall.updatePose(id, INSIDE);
  };
  const send = (id: string, message: HallClientMessage): HallEffect[] => hall.handle(id, message);
  return {
    hall,
    enter,
    send,
    advance: (ms: number) => (clock += ms),
    get now() {
      return clock;
    },
  };
}

const ofType = <T extends HallServerMessage["type"]>(effects: HallEffect[], type: T) =>
  effects.filter((effect): effect is HallEffect & { message: Extract<HallServerMessage, { type: T }> } => effect.message.type === type);
const errorOf = (effects: HallEffect[]): string | null => {
  const error = ofType(effects, "hall_error")[0];
  return error ? `${error.message.op}:${error.message.reason}` : null;
};
const lastStage = (effects: HallEffect[]): HallStageState | undefined => ofType(effects, "hall_stage").at(-1)?.message.stage;

test("membership: enter at the box, leave only beyond the exit margin; hall_state on entry, hall_exit on leaving", () => {
  const { hall } = setup();
  const edgeX = WATCH_HALL_ORIGIN.x + WATCH_HALL_HALF_EXTENTS.x;
  assert.equal(insideWatchHall(edgeX, 0), true);
  assert.equal(insideWatchHall(edgeX + 1, 0), false);
  assert.equal(insideWatchHall(edgeX + 1, 0, WATCH_HALL_EXIT_MARGIN_METERS), true);

  assert.deepEqual(hall.updatePose("A", { ...INSIDE, x: edgeX + 1 }), [], "1 m outside the box is not inside yet");
  assert.equal(hall.isMember("A"), false);
  const entry = hall.updatePose("A", { ...INSIDE, x: edgeX });
  assert.equal(hall.isMember("A"), true);
  assert.equal(entry.length, 1);
  assert.deepEqual(entry[0]!.to, ["A"]);
  assert.equal(entry[0]!.message.type, "hall_state");

  assert.deepEqual(hall.updatePose("A", { ...INSIDE, x: edgeX + WATCH_HALL_EXIT_MARGIN_METERS - 0.1 }), [], "inside the margin: still a member, no flapping");
  assert.equal(hall.isMember("A"), true);
  assert.deepEqual(hall.updatePose("A", INSIDE), [], "moving around inside sends nothing");

  const exit = hall.updatePose("A", { ...INSIDE, x: edgeX + WATCH_HALL_EXIT_MARGIN_METERS + 0.1 });
  assert.equal(hall.isMember("A"), false);
  assert.deepEqual(exit, [{ to: ["A"], message: { type: "hall_exit" } }]);
  assert.deepEqual(hall.updatePose("A", OUTSIDE), []);
});

test("stage: FIFO queue, the head becomes holder (preparing), queue cap, idempotent request, cancel, members only", () => {
  const { hall, enter, send } = setup();
  const ids = Array.from({ length: HALL_STAGE_QUEUE_MAX + 2 }, (_, i) => `P${i}`);
  enter(...ids);
  assert.equal(errorOf(send("outsider", { type: "hall_stage_request" })), "stage:not_in_hall");

  const first = send("P0", { type: "hall_stage_request" });
  assert.deepEqual(lastStage(first), { holder: "P0", status: "preparing", since: hall.stageState().since, queue: [], card: null, locked: false, audio: false });
  assert.deepEqual(first[0]!.to.length, ids.length, "hall_stage goes to every member");
  assert.deepEqual(send("P0", { type: "hall_stage_request" }), [], "the holder asking again changes nothing");

  for (let i = 1; i <= HALL_STAGE_QUEUE_MAX; i++) send(`P${i}`, { type: "hall_stage_request" });
  assert.deepEqual(hall.stageState().queue, ids.slice(1, HALL_STAGE_QUEUE_MAX + 1), "FIFO order");
  assert.deepEqual(send("P1", { type: "hall_stage_request" }), [], "idempotent while queued");
  assert.equal(errorOf(send(`P${HALL_STAGE_QUEUE_MAX + 1}`, { type: "hall_stage_request" })), "stage:queue_full");

  assert.deepEqual(lastStage(send("P2", { type: "hall_stage_cancel" }))?.queue, ids.slice(1, HALL_STAGE_QUEUE_MAX + 1).filter((id) => id !== "P2"));
  assert.equal(errorOf(send("P2", { type: "hall_stage_cancel" })), "stage:not_queued");

  const stopped = send("P0", { type: "hall_stage_stop" });
  assert.equal(lastStage(stopped)?.holder, "P1", "the next in line takes over");
  assert.equal(lastStage(stopped)?.status, "preparing");
  assert.equal(errorOf(send("P3", { type: "hall_stage_stop" })), "stage:not_holder");
});

test("stage: preparing → live → ended; audio flag; live:false while preparing is ignored; prepare timeout skips the turn", () => {
  const { hall, enter, send, advance } = setup();
  enter("A", "B", "C");
  send("A", { type: "hall_stage_request" });
  send("B", { type: "hall_stage_request" });
  assert.equal(errorOf(send("B", { type: "hall_stage_live", live: true, audio: true })), "stage:not_holder");

  assert.deepEqual(send("A", { type: "hall_stage_live", live: false, audio: false }), [], "a cancelled picker keeps the turn");
  advance(1000);
  const live = lastStage(send("A", { type: "hall_stage_live", live: true, audio: false }));
  assert.equal(live?.status, "live");
  assert.equal(live?.audio, false);
  assert.equal(live?.since, hall.stageState().since);
  assert.equal(lastStage(send("A", { type: "hall_stage_live", live: true, audio: true }))?.audio, true, "audio change is broadcast");
  assert.deepEqual(send("A", { type: "hall_stage_live", live: true, audio: true }), [], "no change, no message");
  advance(HALL_STAGE_PREPARE_TIMEOUT_MS * 2);
  assert.deepEqual(hall.tick(), [], "a live turn has no prepare timeout");

  const ended = lastStage(send("A", { type: "hall_stage_live", live: false, audio: false }));
  assert.equal(ended?.holder, "B");
  assert.equal(ended?.status, "preparing");

  // B never goes live: the turn is skipped after the prepare timeout.
  send("C", { type: "hall_stage_request" });
  const deadline = hall.nextDeadline();
  assert.equal(deadline, hall.stageState().since + HALL_STAGE_PREPARE_TIMEOUT_MS);
  advance(HALL_STAGE_PREPARE_TIMEOUT_MS - 1);
  assert.deepEqual(hall.tick(), []);
  advance(1);
  assert.equal(lastStage(hall.tick())?.holder, "C");
  advance(HALL_STAGE_PREPARE_TIMEOUT_MS);
  const idle = lastStage(hall.tick());
  assert.equal(idle?.holder, null);
  assert.equal(idle?.status, "idle");
  assert.equal(hall.nextDeadline(), null, "nothing left to time");
});

test("stage: a holder who leaves the hall keeps the stage for the grace period; returning in time cancels it", () => {
  const ctx = setup();
  const { hall, enter, send, advance } = ctx;
  enter("A", "B");
  send("A", { type: "hall_stage_request" });
  send("A", { type: "hall_stage_live", live: true, audio: true });
  send("B", { type: "hall_stage_request" });

  hall.updatePose("A", OUTSIDE);
  assert.equal(hall.stageState().holder, "A");
  assert.equal(hall.nextDeadline(), ctx.now + HALL_STAGE_LEAVE_GRACE_MS);
  advance(HALL_STAGE_LEAVE_GRACE_MS - 1);
  assert.deepEqual(hall.tick(), []);
  const back = hall.updatePose("A", INSIDE);
  assert.equal(ofType(back, "hall_state")[0]?.message.stage.holder, "A", "back in time: still the holder");
  advance(HALL_STAGE_LEAVE_GRACE_MS);
  assert.deepEqual(hall.tick(), []);
  assert.equal(hall.stageState().holder, "A");

  hall.updatePose("A", OUTSIDE);
  assert.deepEqual(send("A", { type: "hall_stage_live", live: true, audio: false }).length, 1, "the holder may still report from outside");
  advance(HALL_STAGE_LEAVE_GRACE_MS);
  const after = hall.tick();
  assert.equal(lastStage(after)?.holder, "B");
  assert.deepEqual(ofType(after, "hall_stage")[0]?.to, ["B"], "only members hear about it");
});

test("stage: holder disconnect ends the turn at once and the queue advances; becoming holder lowers the hand", () => {
  const { hall, enter, send } = setup();
  enter("A", "B", "C");
  send("A", { type: "hall_stage_request" });
  send("B", { type: "hall_hand", raised: true });
  send("B", { type: "hall_stage_request" });
  const effects = hall.forget("A");
  assert.equal(lastStage(effects)?.holder, "B");
  assert.deepEqual(ofType(effects, "hall_hands")[0]?.message.hands, [], "B's hand went down when B got the stage");
  assert.deepEqual([...(ofType(effects, "hall_stage")[0]?.to ?? [])].sort(), ["B", "C"]);
  assert.equal(hall.isMember("A"), false);
});

test("handover: only to a queued player (queuing is the consent), by the holder or a host", () => {
  const { enter, send } = setup({ hostKey: HOST_KEY });
  enter("A", "B", "C", "H");
  send("A", { type: "hall_stage_request" });
  send("B", { type: "hall_stage_request" });
  send("C", { type: "hall_stage_request" });
  assert.equal(errorOf(send("A", { type: "hall_stage_handover", to: "H" })), "stage:not_queued", "H never asked");
  assert.equal(errorOf(send("A", { type: "hall_stage_handover", to: "A" })), "stage:not_queued");
  assert.equal(errorOf(send("B", { type: "hall_stage_handover", to: "C" })), "stage:not_holder");
  assert.equal(errorOf(send("H", { type: "hall_stage_handover", to: "C" })), "stage:not_holder", "not a host yet");

  const handed = lastStage(send("A", { type: "hall_stage_handover", to: "C" }));
  assert.equal(handed?.holder, "C");
  assert.equal(handed?.status, "preparing");
  assert.deepEqual(handed?.queue, ["B"], "A's turn ended; A is not re-queued");

  send("H", { type: "hall_host_auth", key: HOST_KEY });
  assert.equal(lastStage(send("H", { type: "hall_stage_handover", to: "B" }))?.holder, "B", "a host grants to a queued player");
});

test("lock: hosts only; a locked queue does not auto-advance; a host grants by handover; unlocking advances", () => {
  const { enter, send } = setup({ hostKey: HOST_KEY });
  enter("A", "B", "H");
  assert.equal(errorOf(send("A", { type: "hall_stage_lock", locked: true })), "lock:not_host");
  send("H", { type: "hall_host_auth", key: HOST_KEY });
  assert.equal(lastStage(send("H", { type: "hall_stage_lock", locked: true }))?.locked, true);
  assert.deepEqual(send("H", { type: "hall_stage_lock", locked: true }), []);

  const queued = lastStage(send("A", { type: "hall_stage_request" }));
  assert.equal(queued?.holder, null, "queuing still works while locked, but nobody is granted");
  assert.deepEqual(queued?.queue, ["A"]);
  send("B", { type: "hall_stage_request" });
  assert.equal(lastStage(send("H", { type: "hall_stage_handover", to: "B" }))?.holder, "B");
  assert.equal(lastStage(send("H", { type: "hall_stage_stop" }))?.holder, null, "force stop while locked leaves the stage idle");
  const unlocked = lastStage(send("H", { type: "hall_stage_lock", locked: false }));
  assert.equal(unlocked?.holder, "A");
  assert.equal(unlocked?.locked, false);
});

test("host auth: disabled without a usable key; bad key; 5 attempts per session (refused ones count); session-only role", () => {
  for (const hostKey of [undefined, "", "too-short-key", "k".repeat(HALL_HOST_KEY_MAX + 1), "ab".repeat(16)]) {
    const { hall, enter, send } = setup(hostKey === undefined ? {} : { hostKey });
    enter("A");
    assert.equal(hall.hostEnabled, false, String(hostKey));
    assert.equal(errorOf(send("A", { type: "hall_host_auth", key: "anything" })), "host:host_disabled");
  }
  assert.match(hallHostKeyProblem("k".repeat(HALL_HOST_KEY_MAX + 1)) ?? "", /longer than 128/, "a key the sign-in field can't hold fails closed");
  assert.match(hallHostKeyProblem("ab".repeat(16)) ?? "", /distinct/, "a low-variety key fails closed");
  assert.equal(hallHostKeyProblem(HOST_KEY), null);
  assert.ok(!(hallHostKeyProblem("zq9-tiny") ?? "zq9").includes("zq9"), "the reason never contains the key");

  const { hall, enter, send } = setup({ hostKey: HOST_KEY });
  assert.equal(hall.hostEnabled, true);
  assert.equal(errorOf(send("outsider", { type: "hall_host_auth", key: HOST_KEY })), "host:not_in_hall");
  enter("A", "B");
  for (let i = 0; i < HALL_HOST_ATTEMPTS_PER_SESSION; i++) assert.equal(errorOf(send("A", { type: "hall_host_auth", key: `wrong-${i}` })), "host:bad_key");
  assert.equal(errorOf(send("A", { type: "hall_host_auth", key: HOST_KEY })), "host:rate_limited", "the session used up its attempts");

  const ok = send("B", { type: "hall_host_auth", key: HOST_KEY });
  const state = ofType(ok, "hall_state")[0];
  assert.deepEqual(state?.to, ["B"]);
  assert.equal(state?.message.host, true);
  assert.deepEqual(state?.message.hosts, ["B"]);
  assert.deepEqual(ofType(ok, "hall_hosts")[0]?.to, ["A"], "the others learn the host list");
  assert.ok(!JSON.stringify(ok).includes(HOST_KEY), "the key is never echoed");
  assert.equal(ofType(send("B", { type: "hall_host_auth", key: "irrelevant" }), "hall_state")[0]?.message.host, true, "already a host: state resent");

  // Leaving keeps the role for the session; others see the host list change.
  assert.deepEqual(ofType(hall.updatePose("B", OUTSIDE), "hall_hosts")[0]?.message.hosts, []);
  assert.equal(ofType(hall.updatePose("B", INSIDE), "hall_state")[0]?.message.host, true);
});

test("host auth: sessions spamming bad keys (and reconnecting) never lock a real host out", () => {
  const { hall, enter, send, advance } = setup({ hostKey: HOST_KEY });
  // A griefer polls with wrong keys from session after session (a reconnect is a new session).
  for (let session = 0; session < 50; session++) {
    const id = `G${session}`;
    enter(id);
    for (let i = 0; i < HALL_HOST_ATTEMPTS_PER_SESSION + 20; i++) {
      const error = errorOf(send(id, { type: "hall_host_auth", key: `guess-${session}-${i}` }));
      assert.equal(error, i < HALL_HOST_ATTEMPTS_PER_SESSION ? "host:bad_key" : "host:rate_limited");
      advance(100);
    }
    hall.forget(id);
  }
  enter("Real");
  const ok = send("Real", { type: "hall_host_auth", key: HOST_KEY });
  assert.equal(ofType(ok, "hall_state")[0]?.message.host, true, "the correct key still works while others spam bad keys");
});

test("host auth: at most HALL_HOSTS_MAX host sessions; a disconnect frees a place", () => {
  const { hall, enter, send } = setup({ hostKey: HOST_KEY });
  for (let i = 0; i < HALL_HOSTS_MAX; i++) {
    enter(`H${i}`);
    assert.equal(ofType(send(`H${i}`, { type: "hall_host_auth", key: HOST_KEY }), "hall_state")[0]?.message.host, true);
  }
  enter("Late");
  assert.equal(errorOf(send("Late", { type: "hall_host_auth", key: HOST_KEY })), "host:full");
  hall.forget("H0");
  assert.equal(ofType(send("Late", { type: "hall_host_auth", key: HOST_KEY }), "hall_state")[0]?.message.host, true);
});

test("host powers: force stop, card while idle (kept as 'now showing', cleared when the turn ends), floor, lower hands", () => {
  const { enter, send } = setup({ hostKey: HOST_KEY });
  enter("A", "B", "H");
  send("H", { type: "hall_host_auth", key: HOST_KEY });
  assert.equal(errorOf(send("A", { type: "hall_stage_card", card: { title: "Up next" } })), "card:not_holder");
  assert.deepEqual(lastStage(send("H", { type: "hall_stage_card", card: { title: "  Zcon  VI  replay " } }))?.card, { title: "Zcon VI replay" });
  assert.deepEqual(lastStage(send("A", { type: "hall_stage_request" }))?.card, { title: "Zcon VI replay" }, "the idle card stays when a turn starts");
  send("B", { type: "hall_hand", raised: true });
  const floor = send("H", { type: "hall_floor", playerId: "B" });
  assert.equal(ofType(floor, "hall_floor")[0]?.message.playerId, "B");
  assert.deepEqual(ofType(floor, "hall_hands")[0]?.message.hands, [], "getting the floor lowers the hand");
  const stopped = send("H", { type: "hall_stage_stop" });
  assert.equal(lastStage(stopped)?.holder, null);
  assert.equal(lastStage(stopped)?.card, null, "the card is cleared when the turn ends");
  assert.equal(ofType(stopped, "hall_floor")[0]?.message.playerId, null, "so is the floor");
});

test("floor: holder or host; only to a raised hand (consent); null takes it back; the floor member can step down; cleared on leaving", () => {
  const { hall, enter, send } = setup();
  enter("A", "B", "C");
  send("A", { type: "hall_stage_request" });
  assert.equal(errorOf(send("B", { type: "hall_floor", playerId: "C" })), "floor:not_holder");
  assert.equal(errorOf(send("A", { type: "hall_floor", playerId: "nobody" })), "floor:not_found");
  assert.equal(errorOf(send("A", { type: "hall_floor", playerId: "B" })), "floor:not_raised", "B never raised a hand: no hall-wide mic without consent");
  send("B", { type: "hall_hand", raised: true });
  const given = send("A", { type: "hall_floor", playerId: "B" });
  assert.equal(ofType(given, "hall_floor")[0]?.message.playerId, "B");
  assert.deepEqual(ofType(given, "hall_hands")[0]?.message.hands, [], "getting the floor lowers the hand");
  assert.deepEqual(send("A", { type: "hall_floor", playerId: "B" }), [], "same floor, nothing to send");
  assert.equal(ofType(send("A", { type: "hall_floor", playerId: null }), "hall_floor")[0]?.message.playerId, null);

  send("C", { type: "hall_hand", raised: true });
  send("A", { type: "hall_floor", playerId: "C" });
  assert.equal(errorOf(send("B", { type: "hall_floor", playerId: null })), "floor:not_holder", "only the floor member itself (or holder/host) may clear it");
  const steppedDown = send("C", { type: "hall_floor", playerId: null });
  assert.equal(ofType(steppedDown, "hall_floor")[0]?.message.playerId, null, "the floor member gives the floor up");
  assert.equal(errorOf(send("C", { type: "hall_floor", playerId: "C" })), "floor:not_holder", "but can't take it back");

  send("C", { type: "hall_hand", raised: true });
  send("A", { type: "hall_floor", playerId: "C" });
  const left = hall.updatePose("C", OUTSIDE);
  assert.equal(ofType(left, "hall_floor")[0]?.message.playerId, null);
  assert.deepEqual([...(ofType(left, "hall_floor")[0]?.to ?? [])].sort(), ["A", "B"]);
});

test("hands: raise order, idempotent, bucket burst 3 refilling 0.2/s, lowered by holder/host (one or all), on leave", () => {
  const { hall, enter, send, advance } = setup();
  enter("A", "B", "C", "D");
  assert.equal(errorOf(send("outsider", { type: "hall_hand", raised: true })), "hand:not_in_hall");
  send("B", { type: "hall_hand", raised: true });
  assert.deepEqual(ofType(send("C", { type: "hall_hand", raised: true }), "hall_hands")[0]?.message.hands, ["B", "C"]);
  assert.deepEqual(send("C", { type: "hall_hand", raised: true }), [], "already raised");
  send("C", { type: "hall_hand", raised: false });
  assert.equal(errorOf(send("C", { type: "hall_hand", raised: true })), "hand:rate_limited", `burst ${HALL_HAND_BURST}`);
  advance(5000);
  assert.deepEqual(ofType(send("C", { type: "hall_hand", raised: true }), "hall_hands")[0]?.message.hands, ["B", "C"]);
  send("D", { type: "hall_hand", raised: true });

  assert.equal(errorOf(send("B", { type: "hall_hand_lower", playerId: "C" })), "hand:not_holder");
  send("A", { type: "hall_stage_request" });
  assert.deepEqual(ofType(send("A", { type: "hall_hand_lower", playerId: "C" }), "hall_hands")[0]?.message.hands, ["B", "D"]);
  assert.deepEqual(send("A", { type: "hall_hand_lower", playerId: "C" }), [], "lowering a lowered hand is a no-op");
  assert.deepEqual(ofType(hall.updatePose("D", OUTSIDE), "hall_hands")[0]?.message.hands, ["B"], "leaving lowers the hand");
  assert.deepEqual(ofType(send("A", { type: "hall_hand_lower", playerId: "*" }), "hall_hands")[0]?.message.hands, []);
  assert.deepEqual(send("A", { type: "hall_hand_lower", playerId: "*" }), []);
});

test("seats: free seats only (a race: first claim wins), a new claim frees the old seat, release, members only", () => {
  const { hall, enter, send } = setup();
  enter("A", "B");
  assert.equal(errorOf(send("outsider", { type: "hall_seat_claim", seatId: 3 })), "seat:not_in_hall");
  const claimed = send("A", { type: "hall_seat_claim", seatId: 3 });
  assert.deepEqual(claimed.map((e) => e.message), [{ type: "hall_seat", seatId: 3, playerId: "A" }]);
  assert.equal(errorOf(send("B", { type: "hall_seat_claim", seatId: 3 })), "seat:taken", "the second claim of the same seat loses");
  assert.deepEqual(send("A", { type: "hall_seat_claim", seatId: 3 }), [], "re-claiming your own seat is a no-op");
  assert.equal(errorOf(send("A", { type: "hall_seat_claim", seatId: 60 })), "seat:invalid");

  const moved = send("A", { type: "hall_seat_claim", seatId: 4 });
  assert.deepEqual(moved.map((e) => e.message), [
    { type: "hall_seat", seatId: 3, playerId: null },
    { type: "hall_seat", seatId: 4, playerId: "A" },
  ]);
  assert.equal(send("B", { type: "hall_seat_claim", seatId: 3 }).length, 1, "the old seat is free again");
  assert.deepEqual(ofType(hall.updatePose("C", INSIDE), "hall_state")[0]?.message.seats, [
    [3, "B"],
    [4, "A"],
  ]);
  assert.deepEqual(send("A", { type: "hall_seat_release" }).map((e) => e.message), [{ type: "hall_seat", seatId: 4, playerId: null }]);
  assert.deepEqual(send("A", { type: "hall_seat_release" }), []);
});

test("seats: auto-release on a walk/jog pose after the settle time, on leaving and on disconnect", () => {
  const { hall, enter, send, advance } = setup();
  enter("A", "B");
  send("A", { type: "hall_seat_claim", seatId: 0 });
  assert.deepEqual(hall.updatePose("A", { ...INSIDE, animationState: "walk" }), [], "walking onto the seat right after claiming keeps it");
  hall.updatePose("A", { ...INSIDE, animationState: "sit" });
  advance(HALL_SEAT_SETTLE_MS + 1);
  assert.deepEqual(hall.updatePose("A", { ...INSIDE, animationState: "sit" }), [], "sitting (or idle) never releases");
  assert.deepEqual(hall.updatePose("A", { ...INSIDE, animationState: "jog" }).map((e) => e.message), [{ type: "hall_seat", seatId: 0, playerId: null }]);

  send("A", { type: "hall_seat_claim", seatId: 1 });
  const left = hall.updatePose("A", OUTSIDE);
  assert.deepEqual(ofType(left, "hall_seat")[0]?.message, { type: "hall_seat", seatId: 1, playerId: null });
  assert.deepEqual(ofType(left, "hall_seat")[0]?.to, ["B"]);

  hall.updatePose("A", INSIDE);
  send("A", { type: "hall_seat_claim", seatId: 2 });
  assert.deepEqual(ofType(hall.forget("A"), "hall_seat")[0]?.message, { type: "hall_seat", seatId: 2, playerId: null });
});

test("reactions: per-player bucket (burst 8, 3/s), aggregated counts + capped sample, flushed at most every 250 ms", () => {
  const { hall, enter, send, advance, now } = setup();
  enter("A", "B");
  assert.equal(errorOf(send("outsider", { type: "hall_react", reaction: "clap" })), "react:not_in_hall");
  assert.equal(hall.nextDeadline(), null);
  for (let i = 0; i < HALL_REACT_BURST; i++) assert.deepEqual(send("A", { type: "hall_react", reaction: i % 2 ? "heart" : "clap" }), []);
  assert.equal(errorOf(send("A", { type: "hall_react", reaction: "clap" })), "react:rate_limited");
  for (let i = 0; i < HALL_REACT_BURST; i++) send("B", { type: "hall_react", reaction: "zec" });
  assert.equal(hall.nextDeadline(), now, "the first reaction after a quiet spell flushes right away");

  const flushed = ofType(hall.tick(), "hall_reactions")[0]!;
  assert.deepEqual([...flushed.to].sort(), ["A", "B"]);
  assert.deepEqual(flushed.message.counts, { clap: 4, heart: 4, zec: 8 });
  assert.equal(flushed.message.sample.length, HALL_REACTION_SAMPLE_MAX);
  assert.deepEqual(flushed.message.sample[0], { playerId: "A", reaction: "clap" });
  assert.deepEqual(hall.tick(), [], "nothing pending");

  advance(1000); // refills 3 tokens for A
  send("A", { type: "hall_react", reaction: "idea" });
  assert.equal(hall.nextDeadline(), now + 1000);
  hall.tick();
  send("A", { type: "hall_react", reaction: "fire" });
  assert.equal(hall.nextDeadline(), now + 1000 + HALL_REACTION_FLUSH_MS, "at most one flush per window");
  advance(HALL_REACTION_FLUSH_MS - 1);
  assert.deepEqual(hall.tick(), []);
  advance(1);
  assert.deepEqual(ofType(hall.tick(), "hall_reactions")[0]?.message.counts, { fire: 1 });
});

test("reaction sessions: totals count per stage turn, reset at each new turn, stay as 'last session' while idle, same for every member", () => {
  const { hall, enter, send, advance } = setup();
  enter("A", "B", "C");
  const flush = () => {
    advance(HALL_REACTION_FLUSH_MS);
    return ofType(hall.tick(), "hall_reactions")[0];
  };
  // Before any turn: reactions still float (counts/sample), but no session counts them.
  send("C", { type: "hall_react", reaction: "clap" });
  let batch = flush()!;
  assert.deepEqual(batch.message.counts, { clap: 1 });
  assert.deepEqual(batch.message.totals, {});
  assert.deepEqual(batch.message.session, { id: 0, active: false });

  // A turn starts → session 1, announced to every member at once with an empty batch.
  const started = send("A", { type: "hall_stage_request" });
  const announce = ofType(started, "hall_reactions")[0]!;
  assert.deepEqual([...announce.to].sort(), ["A", "B", "C"]);
  assert.deepEqual(announce.message, { type: "hall_reactions", counts: {}, sample: [], totals: {}, session: { id: 1, active: true } });
  advance(1000);
  send("B", { type: "hall_react", reaction: "clap" });
  send("C", { type: "hall_react", reaction: "clap" });
  send("C", { type: "hall_react", reaction: "heart" });
  batch = flush()!;
  assert.deepEqual(batch.message.totals, { clap: 2, heart: 1 });
  assert.deepEqual(batch.message.session, { id: 1, active: true });
  advance(1000);
  send("B", { type: "hall_react", reaction: "heart" });
  assert.deepEqual(flush()!.message.totals, { clap: 2, heart: 2 }, "totals accumulate across flush windows (the counts are per window)");

  // A newcomer gets the same numbers in hall_state.
  const entry = hall.updatePose("D", INSIDE);
  const state = ofType(entry, "hall_state")[0]!.message;
  assert.deepEqual(state.totals, { clap: 2, heart: 2 });
  assert.deepEqual(state.session, { id: 1, active: true });

  // The turn ends → the totals stay, marked inactive ("Last session"); idle reactions don't change them.
  const ended = send("A", { type: "hall_stage_stop" });
  assert.deepEqual(ofType(ended, "hall_reactions")[0]?.message, { type: "hall_reactions", counts: {}, sample: [], totals: { clap: 2, heart: 2 }, session: { id: 1, active: false } });
  advance(1000);
  send("C", { type: "hall_react", reaction: "fire" });
  batch = flush()!;
  assert.deepEqual(batch.message.counts, { fire: 1 });
  assert.deepEqual(batch.message.totals, { clap: 2, heart: 2 });
  assert.deepEqual(batch.message.session, { id: 1, active: false });

  // The next turn (here a handover from a queue) is a new session from zero.
  send("B", { type: "hall_stage_request" });
  send("C", { type: "hall_stage_request" });
  assert.deepEqual(hall.reactionSession(), { id: 2, active: true });
  advance(1000);
  send("A", { type: "hall_react", reaction: "zec" });
  assert.deepEqual(flush()!.message.totals, { zec: 1 });
  const handover = send("B", { type: "hall_stage_handover", to: "C" });
  assert.deepEqual(ofType(handover, "hall_reactions")[0]?.message.session, { id: 3, active: true }, "a handover is a new turn");
  assert.deepEqual(ofType(handover, "hall_reactions")[0]?.message.totals, {});
  // The holder disconnecting ends the session too.
  assert.deepEqual(ofType(hall.forget("C"), "hall_reactions")[0]?.message.session, { id: 3, active: false });
});

test("card: sanitised text, https links on the allowlisted hosts only (no credentials, no port), id patterns, link cap", () => {
  assert.deepEqual(validateHallCard({ title: " Arborist‮ call​ #92 ", speaker: "  ", project: "Zebra" }), { title: "Arborist call #92", project: "Zebra" });
  assert.equal(validateHallCard({ title: "   " }), null);
  assert.equal(validateHallCard({ title: "x".repeat(HALL_CARD_TITLE_MAX + 1) }), null);
  assert.equal(validateHallCard({ title: "ok", speaker: "y".repeat(49) }), null);
  assert.deepEqual(validateHallCard({ title: "ok", eventId: "zcon-vi-day-1", videoId: "dQw4w9WgXcQ" }), { title: "ok", eventId: "zcon-vi-day-1", videoId: "dQw4w9WgXcQ" });
  assert.equal(validateHallCard({ title: "ok", videoId: "short" }), null);
  assert.equal(validateHallCard({ title: "ok", eventId: "Upper-Case" }), null);

  assert.equal(cleanHallCardUrl("https://github.com/zcash/zcash"), "https://github.com/zcash/zcash");
  assert.equal(cleanHallCardUrl("https://forum.zcashcommunity.com/t/1"), "https://forum.zcashcommunity.com/t/1");
  for (const bad of [
    "http://github.com/zcash",
    "https://user:pass@github.com/zcash",
    "https://github.com:8443/zcash",
    "https://github.com.evil.example/",
    "https://evil.example/?https://github.com",
    "https://gist.github.com/x",
    "javascript:alert(1)",
    "https://git hub.com/",
    "https://github.com/\nzcash",
    `https://github.com/${"a".repeat(200)}`,
  ]) {
    assert.equal(cleanHallCardUrl(bad), null, bad);
  }
  const links = Array.from({ length: HALL_CARD_LINKS_MAX }, () => ({ kind: "github" as const, url: "https://github.com/zcash" }));
  assert.equal(validateHallCard({ title: "ok", links })?.links?.length, HALL_CARD_LINKS_MAX);
  assert.equal(validateHallCard({ title: "ok", links: [...links, links[0]!] }), null);
  assert.equal(validateHallCard({ title: "ok", links: [{ kind: "github", url: "https://evil.example/" }] }), null, "one bad link rejects the card");

  const { enter, send } = setup();
  enter("A");
  send("A", { type: "hall_stage_request" });
  assert.equal(errorOf(send("A", { type: "hall_stage_card", card: { title: "ok", links: [{ kind: "web", url: "http://z.cash" }] } })), "card:invalid");
  assert.deepEqual(lastStage(send("A", { type: "hall_stage_card", card: { title: "ok", links: [{ kind: "web", url: "https://z.cash" }] } }))?.card, {
    title: "ok",
    links: [{ kind: "web", url: "https://z.cash/" }],
  });
  assert.equal(lastStage(send("A", { type: "hall_stage_card", card: null }))?.card, null);
});

test("max turn: ends a turn only while others are queued and no host is in the hall", () => {
  const MAX = 60_000;
  const { hall, enter, send, advance } = setup({ maxTurnMs: MAX, hostKey: HOST_KEY });
  enter("A", "B", "H");
  send("A", { type: "hall_stage_request" });
  send("A", { type: "hall_stage_live", live: true, audio: true });
  advance(MAX * 2);
  assert.deepEqual(hall.tick(), [], "nobody waiting: no cap");
  assert.equal(hall.nextDeadline(), null);

  send("H", { type: "hall_host_auth", key: HOST_KEY });
  send("B", { type: "hall_stage_request" });
  assert.equal(hall.nextDeadline(), null, "a host is present: no cap");
  hall.updatePose("H", OUTSIDE);
  assert.ok(hall.nextDeadline() !== null, "host gone and someone waiting: the cap applies (already overdue)");
  assert.equal(lastStage(hall.tick())?.holder, "B");

  // Unset means the 60-minute default; 0 turns the cap off.
  const plain = setup();
  plain.enter("A", "B");
  plain.send("A", { type: "hall_stage_request" });
  plain.send("A", { type: "hall_stage_live", live: true, audio: false });
  plain.send("B", { type: "hall_stage_request" });
  assert.equal(plain.hall.nextDeadline(), plain.now + HALL_DEFAULT_MAX_TURN_MS, "no WATCH_HALL_MAX_TURN_MS: the 60-minute default");
  plain.advance(HALL_DEFAULT_MAX_TURN_MS - 1);
  assert.equal(lastStage(plain.hall.tick()), undefined, "not yet");
  plain.advance(1);
  assert.equal(lastStage(plain.hall.tick())?.holder, "B", "an hour on, the waiting presenter gets the stage");
  const off = setup({ maxTurnMs: 0 });
  off.enter("A", "B");
  off.send("A", { type: "hall_stage_request" });
  off.send("A", { type: "hall_stage_live", live: true, audio: false });
  off.send("B", { type: "hall_stage_request" });
  assert.equal(off.hall.nextDeadline(), null, "WATCH_HALL_MAX_TURN_MS=0: no cap");
});

test("leaving the hall drops queue place, seat, hand and floor in one batch of deltas to the remaining members", () => {
  const { hall, enter, send } = setup();
  enter("A", "B", "C");
  send("A", { type: "hall_stage_request" });
  send("B", { type: "hall_stage_request" });
  send("B", { type: "hall_seat_claim", seatId: 7 });
  send("B", { type: "hall_hand", raised: true });
  send("A", { type: "hall_floor", playerId: "B" });
  send("B", { type: "hall_hand", raised: true });
  const effects = hall.updatePose("B", OUTSIDE);
  assert.deepEqual(
    effects.map((e) => e.message.type),
    ["hall_exit", "hall_seat", "hall_stage", "hall_hands", "hall_floor"],
  );
  assert.deepEqual(effects[0]!.to, ["B"]);
  for (const effect of effects.slice(1)) assert.deepEqual([...effect.to].sort(), ["A", "C"]);
  assert.deepEqual(lastStage(effects)?.queue, []);
});

test("lock: released when the last host session disconnects (the queue advances); a host merely outside keeps it", () => {
  const { hall, enter, send } = setup({ hostKey: HOST_KEY });
  enter("H", "H2", "a", "b");
  send("H", { type: "hall_host_auth", key: HOST_KEY });
  send("H2", { type: "hall_host_auth", key: HOST_KEY });
  send("H", { type: "hall_stage_lock", locked: true });
  send("a", { type: "hall_stage_request" });
  send("b", { type: "hall_stage_request" });
  hall.forget("H");
  hall.updatePose("H2", OUTSIDE);
  assert.equal(hall.stageState().locked, true, "H2 is still connected (outside the hall): the lock stays");
  assert.equal(hall.stageState().holder, null);
  const released = hall.forget("H2");
  assert.equal(lastStage(released)?.locked, false, "no host session left: the lock is released");
  assert.equal(lastStage(released)?.holder, "a", "and the queue advances");
  assert.deepEqual(lastStage(released)?.queue, ["b"]);
});

test("max turn never applies to a locked stage (a host's chosen speaker is not cut off)", () => {
  const MAX = 60_000;
  const { hall, enter, send, advance } = setup({ maxTurnMs: MAX, hostKey: HOST_KEY });
  enter("H", "A", "B");
  send("H", { type: "hall_host_auth", key: HOST_KEY });
  send("H", { type: "hall_stage_lock", locked: true });
  send("A", { type: "hall_stage_request" });
  send("B", { type: "hall_stage_request" });
  send("H", { type: "hall_stage_handover", to: "A" });
  send("A", { type: "hall_stage_live", live: true, audio: true });
  hall.updatePose("H", OUTSIDE);
  assert.equal(hall.nextDeadline(), null, "locked: no cap deadline");
  advance(MAX + 1);
  hall.tick();
  assert.equal(hall.stageState().holder, "A");
  assert.equal(hall.stageState().status, "live");
});

test("hands: at most HALL_HANDS_MAX raised; further raises get hand:full", () => {
  const { hall, enter, send } = setup();
  const ids = Array.from({ length: HALL_HANDS_MAX + 1 }, (_, i) => `M${i}`);
  enter(...ids);
  for (const id of ids.slice(0, HALL_HANDS_MAX)) assert.equal(errorOf(send(id, { type: "hall_hand", raised: true })), null);
  assert.equal(errorOf(send(ids.at(-1)!, { type: "hall_hand", raised: true })), "hand:full");
  assert.equal(hall.stateFor("M0").hands.length, HALL_HANDS_MAX);
});

test("broadcast ops have a per-session budget; resending the same card or live report costs nothing", () => {
  const { enter, send, advance } = setup();
  enter("A", "B");
  send("A", { type: "hall_stage_request" }); // 1 token
  const spent: (string | null)[] = [];
  for (let i = 0; i < HALL_OP_BURST + 4; i++) spent.push(errorOf(send("A", { type: "hall_stage_card", card: { title: `Slide ${i}` } })));
  assert.deepEqual(spent.slice(0, HALL_OP_BURST - 1), Array(HALL_OP_BURST - 1).fill(null));
  assert.ok(spent.slice(HALL_OP_BURST - 1).every((e) => e === "card:rate_limited"), "changing cards 30×/s is refused once the burst is spent");
  advance(1000);
  assert.equal(errorOf(send("A", { type: "hall_stage_card", card: { title: "Same" } })), null);
  assert.deepEqual(send("A", { type: "hall_stage_card", card: { title: "Same" } }), [], "the same card again: no broadcast, no token");
  send("A", { type: "hall_stage_live", live: true, audio: true });
  assert.deepEqual(send("A", { type: "hall_stage_live", live: true, audio: true }), [], "an unchanged live report is free");
  // Ending a turn is never limited.
  for (let i = 0; i < HALL_OP_BURST; i++) send("A", { type: "hall_stage_card", card: { title: `Again ${i}` } });
  assert.equal(lastStage(send("A", { type: "hall_stage_live", live: false, audio: false }))?.holder, null);
  // Seat flapping is limited too.
  const seatErrors = Array.from({ length: HALL_OP_BURST + 2 }, (_, i) => errorOf(send("B", { type: "hall_seat_claim", seatId: i % 2 })));
  assert.ok(seatErrors.includes("seat:rate_limited"));
});

test("a present host can hand a full, locked stage to a member with a raised hand (squatted queue)", () => {
  const { enter, send } = setup({ hostKey: HOST_KEY });
  const squatters = Array.from({ length: 13 }, (_, i) => `S${i}`);
  enter(...squatters, "H", "P");
  for (const id of squatters) send(id, { type: "hall_stage_request" });
  send("H", { type: "hall_host_auth", key: HOST_KEY });
  assert.equal(errorOf(send("P", { type: "hall_stage_request" })), "stage:queue_full");
  assert.equal(errorOf(send("H", { type: "hall_stage_handover", to: "P" })), "stage:not_queued", "P hasn't consented (no queue place, no raised hand)");
  send("H", { type: "hall_stage_lock", locked: true });
  send("P", { type: "hall_hand", raised: true });
  assert.equal(errorOf(send("S0", { type: "hall_stage_handover", to: "P" })), "stage:not_queued", "a plain holder still needs a queued target");
  const granted = send("H", { type: "hall_stage_handover", to: "P" });
  assert.equal(lastStage(granted)?.holder, "P");
  assert.equal(lastStage(granted)?.queue.length, 12, "the queue is untouched");
  assert.deepEqual(ofType(granted, "hall_hands")[0]?.message.hands, [], "becoming holder lowers the hand");
});

test("TokenBucket: a wall clock stepping backwards never drains the bucket", () => {
  let clock = 1_000_000;
  const bucket = new TokenBucket(3, 0.2, () => clock);
  assert.equal(bucket.take(), true);
  clock -= 3_600_000; // an NTP step back of an hour
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), false);
  clock += 5_000;
  assert.equal(bucket.take(), true, "refills normally from the stepped clock");
});

// ---------------------------------------------------------------------------
// The wire: strict shapes (protocol.ts) and real sockets (WorldServer).
// ---------------------------------------------------------------------------

test("parser: every hall_* shape is rebuilt from checked fields; anything else is dropped", () => {
  assert.deepEqual(parseIncomingMessage({ type: "hall_stage_request", extra: 1 }), { type: "hall_stage_request" });
  assert.deepEqual(parseIncomingMessage({ type: "hall_seat_release" }), { type: "hall_seat_release" });
  assert.deepEqual(parseIncomingMessage({ type: "hall_stage_handover", to: "p-1" }), { type: "hall_stage_handover", to: "p-1" });
  assert.equal(parseIncomingMessage({ type: "hall_stage_handover", to: "" }), null);
  assert.equal(parseIncomingMessage({ type: "hall_stage_handover", to: "x".repeat(65) }), null);
  assert.deepEqual(parseIncomingMessage({ type: "hall_stage_live", live: true, audio: false }), { type: "hall_stage_live", live: true, audio: false });
  assert.equal(parseIncomingMessage({ type: "hall_stage_live", live: true }), null);
  assert.equal(parseIncomingMessage({ type: "hall_stage_live", live: "true", audio: false }), null);
  assert.deepEqual(parseIncomingMessage({ type: "hall_stage_lock", locked: false }), { type: "hall_stage_lock", locked: false });
  assert.deepEqual(parseIncomingMessage({ type: "hall_floor", playerId: null }), { type: "hall_floor", playerId: null });
  assert.equal(parseIncomingMessage({ type: "hall_floor" }), null);
  assert.deepEqual(parseIncomingMessage({ type: "hall_react", reaction: "zec" }), { type: "hall_react", reaction: "zec" });
  assert.equal(parseIncomingMessage({ type: "hall_react", reaction: "💩" }), null);
  assert.deepEqual(parseIncomingMessage({ type: "hall_hand", raised: false }), { type: "hall_hand", raised: false });
  assert.deepEqual(parseIncomingMessage({ type: "hall_hand_lower", playerId: "*" }), { type: "hall_hand_lower", playerId: "*" });
  assert.equal(parseIncomingMessage({ type: "hall_hand_lower", playerId: "" }), null);
  for (const seatId of [0, 59]) assert.deepEqual(parseIncomingMessage({ type: "hall_seat_claim", seatId }), { type: "hall_seat_claim", seatId });
  for (const seatId of [-1, 60, 1.5, "3", null]) assert.equal(parseIncomingMessage({ type: "hall_seat_claim", seatId }), null, String(seatId));
  assert.deepEqual(parseIncomingMessage({ type: "hall_host_auth", key: "k" }), { type: "hall_host_auth", key: "k" });
  assert.equal(parseIncomingMessage({ type: "hall_host_auth", key: "" }), null);
  assert.equal(parseIncomingMessage({ type: "hall_host_auth", key: "k".repeat(HALL_HOST_KEY_MAX + 1) }), null);

  assert.deepEqual(parseIncomingMessage({ type: "hall_stage_card", card: null }), { type: "hall_stage_card", card: null });
  assert.deepEqual(
    parseIncomingMessage({ type: "hall_stage_card", card: { title: "T", speaker: "S", links: [{ kind: "github", url: "https://github.com/zcash", x: 1 }], videoId: "dQw4w9WgXcQ", evil: "<b>" } }),
    { type: "hall_stage_card", card: { title: "T", speaker: "S", links: [{ kind: "github", url: "https://github.com/zcash" }], videoId: "dQw4w9WgXcQ" } },
  );
  for (const card of [
    undefined,
    "title",
    [],
    { title: 5 },
    { title: "x".repeat(HALL_CARD_TITLE_MAX * 2 + 1) },
    { title: "T", links: "https://github.com" },
    { title: "T", links: [{ kind: "ftp", url: "https://github.com" }] },
    { title: "T", links: Array.from({ length: HALL_CARD_LINKS_MAX + 1 }, () => ({ kind: "web", url: "https://z.cash" })) },
    { title: "T", eventId: "Bad Id" },
    { title: "T", videoId: "x" },
  ]) {
    assert.equal(parseIncomingMessage({ type: "hall_stage_card", card }), null, JSON.stringify(card));
  }
});

type Msg = Record<string, unknown>;
const HALL_POS = { x: WATCH_HALL_ORIGIN.x, y: 0, z: WATCH_HALL_ORIGIN.z };
const PLAZA_POS = { x: 0, y: 0, z: 0 };

async function startHallServer(options: WorldServerOptions = {}): Promise<{ port: number; stop: () => Promise<void> }> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const world = new WorldServer(wss, options);
  return { port, stop: () => new Promise<void>((resolve) => (world.dispose(), wss.close(() => resolve()))) };
}

/** chat.test.ts's join(port, nick, pose): joins and publishes one transform at `pose`. */
async function join(port: number, nickname: string, pose: { x: number; y: number; z: number }) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: Msg[] = [];
  socket.addEventListener("message", (event) => messages.push(JSON.parse(event.data as string) as Msg));
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  const send = (message: Msg) => socket.send(JSON.stringify(message));
  const waitFor = async (predicate: (m: Msg) => boolean, timeoutMs = 2000): Promise<Msg> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`${nickname}: timed out`);
  };
  let seq = 0;
  const move = (to: { x: number; y: number; z: number }, animationState = "idle") => send({ type: "player_transform", ...to, rotationY: 0, animationState, seq: ++seq });
  send({ type: "join", nickname, wallet: true }); // ADR-015: a wallet holder, so the chosen name is kept
  const welcome = await waitFor((m) => m.type === "welcome");
  move(pose);
  const count = (type: string) => messages.filter((m) => m.type === type).length;
  return { socket, messages, send, move, waitFor, count, playerId: welcome.playerId as string, close: () => socket.close() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

test("wire: hall_state on entry; hall chat, reactions and stage reach members only; not_in_hall spends no chat token; hall_exit on leaving", async () => {
  const { port, stop } = await startHallServer();
  try {
    const a = await join(port, "Ada", HALL_POS);
    const b = await join(port, "Bob", { ...HALL_POS, x: HALL_POS.x + 5 });
    const c = await join(port, "Cem", PLAZA_POS);
    const stateA = await a.waitFor((m) => m.type === "hall_state");
    assert.deepEqual(stateA, {
      type: "hall_state",
      stage: { holder: null, status: "idle", since: (stateA.stage as { since: number }).since, queue: [], card: null, locked: false, audio: false },
      seats: [],
      hands: [],
      floor: null,
      hosts: [],
      host: false,
      totals: {},
      session: { id: 0, active: false },
      vote: { votes: 0, needed: 0, voted: false },
    });
    await b.waitFor((m) => m.type === "hall_state");
    await settle();
    assert.equal(c.count("hall_state"), 0, "the plaza player is not a member");

    a.send({ type: "chat_send", channel: "hall", text: "  welcome   to the hall " });
    const line = await b.waitFor((m) => m.type === "chat_message" && m.channel === "hall");
    assert.equal(line.text, "welcome to the hall");
    await a.waitFor((m) => m.type === "chat_message" && m.channel === "hall");

    c.send({ type: "chat_send", channel: "hall", text: "let me in" });
    await c.waitFor((m) => m.type === "chat_rejected" && m.reason === "not_in_hall");
    for (let i = 0; i < CHAT_BURST; i++) c.send({ type: "chat_send", channel: "general", text: `g${i}` });
    await settle();
    assert.equal(c.messages.filter((m) => m.type === "chat_message" && m.channel === "general").length, CHAT_BURST, "the refused hall line spent no chat token");
    assert.equal(c.count("chat_rejected"), 1);

    a.send({ type: "hall_react", reaction: "clap" });
    a.send({ type: "hall_react", reaction: "clap" });
    b.send({ type: "hall_react", reaction: "fire" });
    const reactions = await b.waitFor((m) => m.type === "hall_reactions");
    assert.ok((reactions.sample as unknown[]).length >= 1);
    // One or two flushes (at most one per HALL_REACTION_FLUSH_MS) — the counts add up either way.
    const reacted = (s: { messages: Msg[] }) =>
      s.messages.filter((m) => m.type === "hall_reactions").reduce((sum, m) => sum + Object.values(m.counts as Record<string, number>).reduce((n, k) => n + k, 0), 0);
    for (const s of [a, b]) await s.waitFor(() => reacted(s) === 3);
    assert.ok(a.count("hall_reactions") <= 2, "batched, not one frame per reaction");

    a.send({ type: "hall_stage_request" });
    const stage = await b.waitFor((m) => m.type === "hall_stage");
    assert.equal((stage.stage as { holder: string }).holder, a.playerId);
    c.send({ type: "hall_stage_request" });
    await c.waitFor((m) => m.type === "hall_error" && m.op === "stage" && m.reason === "not_in_hall");
    await settle();
    for (const type of ["chat_message", "hall_reactions", "hall_stage", "hall_seat"]) {
      assert.equal(c.messages.filter((m) => m.type === type && (type !== "chat_message" || m.channel === "hall")).length, 0, `outsider got no ${type}`);
    }

    b.move(PLAZA_POS);
    await b.waitFor((m) => m.type === "hall_exit");
    a.send({ type: "chat_send", channel: "hall", text: "bye Bob" });
    await a.waitFor((m) => m.type === "chat_message" && m.text === "bye Bob");
    await settle();
    assert.equal(b.messages.filter((m) => m.type === "chat_message" && m.text === "bye Bob").length, 0, "a former member hears nothing");
    for (const s of [a, b, c]) s.close();
  } finally {
    await stop();
  }
});

test("wire: a disconnect frees the stage and the seat and advances the queue", async () => {
  const { port, stop } = await startHallServer();
  try {
    const a = await join(port, "Ada", HALL_POS);
    const b = await join(port, "Bob", HALL_POS);
    const c = await join(port, "Cem", HALL_POS);
    await c.waitFor((m) => m.type === "hall_state");
    a.send({ type: "hall_stage_request" });
    await c.waitFor((m) => m.type === "hall_stage" && (m.stage as { holder: string }).holder === a.playerId);
    b.send({ type: "hall_stage_request" });
    await c.waitFor((m) => m.type === "hall_stage" && (m.stage as { queue: string[] }).queue.includes(b.playerId));
    a.send({ type: "hall_seat_claim", seatId: 5 });
    await c.waitFor((m) => m.type === "hall_seat" && m.seatId === 5 && m.playerId === a.playerId);
    b.send({ type: "hall_seat_claim", seatId: 5 });
    await b.waitFor((m) => m.type === "hall_error" && m.op === "seat" && m.reason === "taken");

    a.close();
    const next = await c.waitFor((m) => m.type === "hall_stage" && (m.stage as { holder: string }).holder === b.playerId);
    assert.equal((next.stage as { status: string }).status, "preparing");
    await c.waitFor((m) => m.type === "hall_seat" && m.seatId === 5 && m.playerId === null);
    await c.waitFor((m) => m.type === "player_left" && m.playerId === a.playerId);
    const order = c.messages.map((m) => m.type);
    assert.ok(order.lastIndexOf("hall_seat") < order.indexOf("player_left"), "hall deltas arrive before player_left");
    b.close();
    c.close();
  } finally {
    await stop();
  }
});

test("wire: host auth — disabled without a key; bad key; the right key gives hall_state{host} and hall_hosts; the key is never echoed", async () => {
  const disabled = await startHallServer();
  try {
    const a = await join(disabled.port, "Ada", HALL_POS);
    await a.waitFor((m) => m.type === "hall_state");
    a.send({ type: "hall_host_auth", key: HOST_KEY });
    await a.waitFor((m) => m.type === "hall_error" && m.op === "host" && m.reason === "host_disabled");
    a.close();
  } finally {
    await disabled.stop();
  }

  const { port, stop } = await startHallServer({ hallHostKey: HOST_KEY });
  try {
    const a = await join(port, "Ada", HALL_POS);
    const b = await join(port, "Bob", HALL_POS);
    await b.waitFor((m) => m.type === "hall_state");
    a.send({ type: "hall_host_auth", key: "not-the-key-but-long-enough-0000" });
    await a.waitFor((m) => m.type === "hall_error" && m.reason === "bad_key");
    a.send({ type: "hall_stage_lock", locked: true });
    await a.waitFor((m) => m.type === "hall_error" && m.op === "lock" && m.reason === "not_host");
    a.send({ type: "hall_host_auth", key: HOST_KEY });
    await a.waitFor((m) => m.type === "hall_state" && m.host === true);
    const hosts = await b.waitFor((m) => m.type === "hall_hosts");
    assert.deepEqual(hosts.hosts, [a.playerId]);
    a.send({ type: "hall_stage_lock", locked: true });
    await b.waitFor((m) => m.type === "hall_stage" && (m.stage as { locked: boolean }).locked === true);
    await settle();
    for (const s of [a, b]) assert.ok(!JSON.stringify(s.messages).includes(HOST_KEY), "the key never comes back");
    a.close();
    b.close();
  } finally {
    await stop();
  }
});

test("wire: transform-skip compatibility — a seated client that only heartbeats stays connected, a member and seated; a later walk frees the seat", async () => {
  let clock = 1_000_000;
  const { port, stop } = await startHallServer({ now: () => clock, staleTimeoutMs: 30_000, sweepIntervalMs: 20 });
  try {
    const a = await join(port, "Ada", HALL_POS);
    const b = await join(port, "Bob", HALL_POS);
    await a.waitFor((m) => m.type === "hall_state");
    await b.waitFor((m) => m.type === "hall_state");
    a.send({ type: "hall_seat_claim", seatId: 0 });
    await b.waitFor((m) => m.type === "hall_seat" && m.seatId === 0 && m.playerId === a.playerId);
    a.move(HALL_POS, "sit");
    // The client now skips its unchanged pose: only heartbeats, for two stale-timeouts' worth of time.
    for (let i = 0; i < 3; i++) {
      clock += 20_000;
      a.send({ type: "heartbeat" });
      b.send({ type: "heartbeat" });
      await settle();
    }
    assert.equal(a.socket.readyState, WebSocket.OPEN, "heartbeats keep the seated client alive");
    assert.equal(b.messages.filter((m) => m.type === "hall_seat" && m.playerId === null).length, 0, "the seat is kept");
    a.send({ type: "chat_send", channel: "hall", text: "still here" });
    await b.waitFor((m) => m.type === "chat_message" && m.text === "still here");

    a.move({ ...HALL_POS, z: HALL_POS.z + 1 }, "walk");
    await b.waitFor((m) => m.type === "hall_seat" && m.seatId === 0 && m.playerId === null);
    a.close();
    b.close();
  } finally {
    await stop();
  }
});
