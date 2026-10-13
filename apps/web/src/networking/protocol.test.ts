import { test } from "node:test";
import assert from "node:assert/strict";
import { HALL_CARD_LINKS_MAX, HALL_REACTION_SAMPLE_MAX, HALL_STAGE_QUEUE_MAX, WATCH_HALL_SEAT_COUNT } from "@project/shared";
import { HALL_HANDS_MAX, HALL_HOSTS_MAX, parseIncomingMessage } from "./protocol.ts";
import { validateHallCard } from "../hall/hallCard.ts";

// The client parser validates and rebuilds every server message (docs/protocols/multiplayer-protocol.md).
// The hall_* family, with capped arrays and a re-validated speaker card.

const STAGE = { holder: "p1", status: "live", since: 1700000000000, queue: ["p2", "p3"], card: null, locked: false, audio: true };
/** The reaction session fields every hall_state and hall_reactions carries. */
const SESSION = { totals: { clap: 12, heart: 5 }, session: { id: 3, active: true } };

test("existing messages: welcome needs the owner-only voiceCapability; a malformed transform is dropped", () => {
  const welcome = { type: "welcome", playerId: "p1", nickname: "Ada", colorSeed: 12, avatar: { model: "mage", color: 3 }, canReceive: true, tickRateHz: 10, voiceCapability: "cap" };
  assert.deepEqual(parseIncomingMessage({ ...welcome, extra: "x" }), welcome);
  const { voiceCapability: _omit, ...withoutCapability } = welcome;
  assert.equal(parseIncomingMessage(withoutCapability), null);
  assert.equal(parseIncomingMessage({ type: "player_transform", playerId: "p1", x: Number.NaN, y: 0, z: 0, rotationY: 0, animationState: "idle", seq: 1, t: 0 }), null);
  assert.equal(parseIncomingMessage({ type: "player_transform", playerId: "p1", x: 0, y: 0, z: 0, rotationY: 0, animationState: "fly", seq: 1, t: 0 }), null);
  assert.equal(parseIncomingMessage({ type: "no_such_message" }), null);
  assert.equal(parseIncomingMessage(null), null);
});

// ADR-015: avatar + canReceive in presence, defaults for missing fields, the new messages and pay errors.
test("ADR-015: missing or malformed avatar / canReceive get defaults instead of dropping the frame (a snapshot is never lost for one entry)", () => {
  const base = { playerId: "p2", nickname: "Bob", colorSeed: 13, x: 1, y: 0, z: 2, rotationY: 0, animationState: "idle" };
  const defaults = { avatar: { model: "mage", color: 5 }, canReceive: false }; // 13 % 5 = 3 → mage, 13 % 8 = 5
  assert.deepEqual(parseIncomingMessage({ type: "player_joined", ...base }), { type: "player_joined", ...base, ...defaults });
  assert.deepEqual(parseIncomingMessage({ type: "player_joined", ...base, avatar: { model: "dragon", color: 1 }, canReceive: "yes" }), { type: "player_joined", ...base, ...defaults });
  const snapshot = parseIncomingMessage({
    type: "player_snapshot",
    players: [
      { ...base, avatar: { model: "mage", color: 7 }, canReceive: true },
      { ...base, playerId: "p3", avatar: { model: "mage", color: 8 } },
    ],
  });
  assert.ok(snapshot && snapshot.type === "player_snapshot");
  if (snapshot?.type === "player_snapshot") {
    assert.equal(snapshot.players.length, 2, "the entry with a bad colour is kept, with the default look");
    assert.deepEqual(snapshot.players[0]!.avatar, { model: "mage", color: 7 });
    assert.equal(snapshot.players[0]!.canReceive, true);
    assert.deepEqual(snapshot.players[1]!.avatar, defaults.avatar);
    assert.equal(snapshot.players[1]!.canReceive, false);
  }
  const welcome = parseIncomingMessage({ type: "welcome", playerId: "p1", nickname: "Guest-1234", colorSeed: 4, tickRateHz: 10, voiceCapability: "cap" });
  assert.ok(welcome && welcome.type === "welcome");
  if (welcome?.type === "welcome") {
    assert.deepEqual(welcome.avatar, { model: "barbarian", color: 4 });
    assert.equal(welcome.canReceive, false);
  }
});

test("ADR-015: avatar_updated, can_receive_updated and nickname_check_result are parsed and rebuilt; malformed ones are dropped", () => {
  assert.deepEqual(parseIncomingMessage({ type: "avatar_updated", playerId: "p1", avatar: { model: "rogue", color: 0 }, junk: 1 }), { type: "avatar_updated", playerId: "p1", avatar: { model: "rogue", color: 0 } });
  assert.equal(parseIncomingMessage({ type: "avatar_updated", playerId: "p1", avatar: { model: "rogue", color: -1 } }), null);
  assert.equal(parseIncomingMessage({ type: "avatar_updated", playerId: "", avatar: { model: "rogue", color: 0 } }), null);
  assert.deepEqual(parseIncomingMessage({ type: "can_receive_updated", playerId: "p1", canReceive: true }), { type: "can_receive_updated", playerId: "p1", canReceive: true });
  assert.equal(parseIncomingMessage({ type: "can_receive_updated", playerId: "p1", canReceive: 1 }), null);
  assert.deepEqual(parseIncomingMessage({ type: "nickname_check_result", nickname: "alice", status: "taken", suggestion: "alice-2" }), {
    type: "nickname_check_result",
    nickname: "alice",
    status: "taken",
    suggestion: "alice-2",
  });
  assert.deepEqual(parseIncomingMessage({ type: "nickname_check_result", nickname: "Ada", status: "available" }), { type: "nickname_check_result", nickname: "Ada", status: "available" });
  assert.equal(parseIncomingMessage({ type: "nickname_check_result", nickname: "Ada", status: "maybe" }), null);
  assert.equal(parseIncomingMessage({ type: "nickname_check_result", nickname: "Ada", status: "taken", suggestion: 5 }), null);
});

test("ADR-015: pay_error accepts the shared reasons, including no_wallet and sender_no_wallet", () => {
  for (const reason of ["unknown_recipient", "self", "rate_limited", "unknown_request", "no_wallet", "sender_no_wallet"]) {
    assert.deepEqual(parseIncomingMessage({ type: "pay_error", requestId: "req-00001", reason }), { type: "pay_error", requestId: "req-00001", reason });
  }
  assert.equal(parseIncomingMessage({ type: "pay_error", requestId: "req-00001", reason: "broke" }), null);
});

test("the relayed acceptance's fee quote, the new pay_error reasons and welcome.build are validated", () => {
  const base = { type: "pay_accept", from: "p1", requestId: "req-00001", recipientKey: "QUJD", sealed: "c2Vh", iv: "aXY=" };
  const fee = { address: "zs1" + "a".repeat(75), zat: 75_000, nonce: "ab".repeat(16) };
  assert.deepEqual(parseIncomingMessage({ ...base, fee }), { ...base, fee });
  assert.deepEqual(parseIncomingMessage(base), base, "no fee on a server that charges none");
  assert.equal(parseIncomingMessage({ ...base, fee: { ...fee, zat: 1_000_001 } }), null, "above PAY_FEE_MAX_ZAT: the whole acceptance is dropped");
  assert.equal(parseIncomingMessage({ ...base, fee: { ...fee, nonce: "short" } }), null);
  assert.equal(parseIncomingMessage({ ...base, fee: "zs1x" }), null);
  for (const reason of ["over_cap", "fee_unpaid"]) assert.deepEqual(parseIncomingMessage({ type: "pay_error", requestId: "req-00001", reason }), { type: "pay_error", requestId: "req-00001", reason });
  const welcome = { type: "welcome", playerId: "p1", nickname: "Guest-0001", colorSeed: 7, tickRateHz: 10, voiceCapability: "cap" };
  assert.equal((parseIncomingMessage({ ...welcome, build: "20261008-ab12cd" }) as { build?: string }).build, "20261008-ab12cd");
  assert.equal("build" in (parseIncomingMessage({ ...welcome, build: "bad build id" }) as object), false, "a malformed build id is ignored, the welcome kept");
});

test("chat: the hall channel and the not_in_hall rejection are accepted; unknown channels are not", () => {
  const line = { type: "chat_message", channel: "hall", messageId: "m1", fromPlayerId: "p1", fromNickname: "Ada", text: "hi", t: 1 };
  assert.deepEqual(parseIncomingMessage(line), line);
  assert.equal(parseIncomingMessage({ ...line, channel: "shout" }), null);
  assert.deepEqual(parseIncomingMessage({ type: "chat_rejected", reason: "not_in_hall" }), { type: "chat_rejected", reason: "not_in_hall" });
  assert.equal(parseIncomingMessage({ type: "chat_rejected", reason: "banned" }), null);
});

test("hall_state is rebuilt from known fields", () => {
  const state = { type: "hall_state", stage: STAGE, seats: [[0, "p1"], [59, "p2"]], hands: ["p3"], floor: "p3", hosts: ["p4"], host: false, ...SESSION, vote: { votes: 2, needed: 3, voted: true } };
  assert.deepEqual(parseIncomingMessage({ ...state, junk: true, stage: { ...STAGE, junk: 1 }, vote: { ...state.vote, who: ["p9"] } }), state);
  // A missing or malformed vote is "no vote open", never a dropped hall_state.
  for (const vote of [undefined, null, { votes: -1, needed: 3, voted: false }, { votes: 1, needed: 3 }, { votes: 1.5, needed: 3, voted: false }]) {
    assert.deepEqual((parseIncomingMessage({ ...state, vote }) as { vote?: unknown } | null)?.vote, { votes: 0, needed: 0, voted: false }, JSON.stringify(vote));
  }
  assert.equal(parseIncomingMessage({ ...state, host: "no" }), null);
  assert.equal(parseIncomingMessage({ ...state, floor: 5 }), null);
  assert.equal(parseIncomingMessage({ ...state, seats: [[60, "p1"]] }), null, "seat id out of range");
  assert.equal(parseIncomingMessage({ ...state, seats: [[1.5, "p1"]] }), null);
  assert.equal(parseIncomingMessage({ ...state, seats: [[1, "p1"], [1, "p2"]] }), null, "one entry per seat");
  assert.equal(parseIncomingMessage({ ...state, seats: [[1, ""]] }), null);
  assert.equal(parseIncomingMessage({ ...state, stage: { ...STAGE, status: "paused" } }), null);
  assert.equal(parseIncomingMessage({ ...state, stage: { ...STAGE, since: "now" } }), null);
  assert.equal(parseIncomingMessage({ ...state, stage: { ...STAGE, locked: undefined } }), null);
  // The session totals and marker are required and validated.
  assert.equal(parseIncomingMessage({ ...state, totals: undefined }), null);
  assert.equal(parseIncomingMessage({ ...state, session: { id: -1, active: true } }), null);
  assert.equal(parseIncomingMessage({ ...state, session: { id: 1 } }), null);
  assert.deepEqual((parseIncomingMessage({ ...state, totals: { clap: 2, rocket: 1 } }) as { totals: unknown }).totals, { clap: 2 }, "unknown reactions are skipped");
});

test("hall arrays are capped (queue, seats, hands, hosts, reaction sample)", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
  assert.ok(parseIncomingMessage({ type: "hall_stage", stage: { ...STAGE, queue: ids(HALL_STAGE_QUEUE_MAX) } }));
  assert.equal(parseIncomingMessage({ type: "hall_stage", stage: { ...STAGE, queue: ids(HALL_STAGE_QUEUE_MAX + 1) } }), null);
  assert.ok(parseIncomingMessage({ type: "hall_hands", hands: ids(HALL_HANDS_MAX) }));
  // Hands and hosts beyond the shared cap are truncated, never a dropped frame (a dropped
  // hall_state would keep a newcomer out of the hall).
  assert.deepEqual(parseIncomingMessage({ type: "hall_hands", hands: ids(HALL_HANDS_MAX + 2) }), { type: "hall_hands", hands: ids(HALL_HANDS_MAX) });
  assert.deepEqual(parseIncomingMessage({ type: "hall_hosts", hosts: ids(HALL_HOSTS_MAX + 1) }), { type: "hall_hosts", hosts: ids(HALL_HOSTS_MAX) });
  const crowded = parseIncomingMessage({ type: "hall_state", stage: STAGE, seats: [], hands: ids(HALL_HANDS_MAX + 2), floor: null, hosts: [], host: false, ...SESSION });
  assert.equal(crowded?.type === "hall_state" ? crowded.hands.length : -1, HALL_HANDS_MAX);
  const seats = Array.from({ length: WATCH_HALL_SEAT_COUNT + 1 }, (_, i) => [i % WATCH_HALL_SEAT_COUNT, `p${i}`]);
  assert.equal(parseIncomingMessage({ type: "hall_state", stage: STAGE, seats, hands: [], floor: null, hosts: [], host: false, ...SESSION }), null);
  const sample = Array.from({ length: HALL_REACTION_SAMPLE_MAX + 1 }, () => ({ playerId: "p1", reaction: "clap" }));
  assert.equal(parseIncomingMessage({ type: "hall_reactions", counts: {}, sample, ...SESSION }), null);
  assert.equal(parseIncomingMessage({ type: "hall_hands", hands: ["x".repeat(65)] }), null, "ids are capped too");
});

test("hall_vote and the cooldown's retryInMs are validated", () => {
  assert.deepEqual(parseIncomingMessage({ type: "hall_vote", votes: 2, needed: 3, voted: false, voters: ["p1"] }), { type: "hall_vote", votes: 2, needed: 3, voted: false });
  for (const bad of [{ votes: -1, needed: 3, voted: false }, { votes: 2, needed: "3", voted: false }, { votes: 2, needed: 3 }, { votes: 1e9, needed: 3, voted: true }]) {
    assert.equal(parseIncomingMessage({ type: "hall_vote", ...bad }), null, JSON.stringify(bad));
  }
  assert.deepEqual(parseIncomingMessage({ type: "hall_error", op: "stage", reason: "cooldown", retryInMs: 600_000 }), { type: "hall_error", op: "stage", reason: "cooldown", retryInMs: 600_000 });
  assert.deepEqual(parseIncomingMessage({ type: "hall_error", op: "vote", reason: "identity_required", retryInMs: "soon" }), { type: "hall_error", op: "vote", reason: "identity_required" });
  assert.deepEqual(parseIncomingMessage({ type: "hall_error", op: "vote", reason: "not_live", retryInMs: -5 }), { type: "hall_error", op: "vote", reason: "not_live" });
});

test("the deltas, hall_exit and hall_error", () => {
  assert.deepEqual(parseIncomingMessage({ type: "hall_exit", x: 1 }), { type: "hall_exit" });
  assert.deepEqual(parseIncomingMessage({ type: "hall_stage", stage: STAGE }), { type: "hall_stage", stage: STAGE });
  assert.deepEqual(parseIncomingMessage({ type: "hall_seat", seatId: 7, playerId: null }), { type: "hall_seat", seatId: 7, playerId: null });
  assert.deepEqual(parseIncomingMessage({ type: "hall_seat", seatId: 7, playerId: "p1" }), { type: "hall_seat", seatId: 7, playerId: "p1" });
  assert.equal(parseIncomingMessage({ type: "hall_seat", seatId: -1, playerId: "p1" }), null);
  assert.equal(parseIncomingMessage({ type: "hall_seat", seatId: 7 }), null);
  assert.deepEqual(parseIncomingMessage({ type: "hall_floor", playerId: null }), { type: "hall_floor", playerId: null });
  assert.equal(parseIncomingMessage({ type: "hall_floor", playerId: 3 }), null);
  assert.deepEqual(parseIncomingMessage({ type: "hall_hosts", hosts: [] }), { type: "hall_hosts", hosts: [] });
  assert.deepEqual(parseIncomingMessage({ type: "hall_error", op: "seat", reason: "taken" }), { type: "hall_error", op: "seat", reason: "taken" });
  assert.equal(parseIncomingMessage({ type: "hall_error", op: "seat", reason: "nope" }), null);
  assert.equal(parseIncomingMessage({ type: "hall_error", op: "dance", reason: "taken" }), null);
});

test("hall_reactions keeps known reactions, skips unknown ids, rejects malformed counts", () => {
  assert.deepEqual(
    parseIncomingMessage({ type: "hall_reactions", counts: { clap: 3, zec: 1, rocket: 9 }, sample: [{ playerId: "p1", reaction: "clap" }, { playerId: "p2", reaction: "rocket" }], ...SESSION }),
    { type: "hall_reactions", counts: { clap: 3, zec: 1 }, sample: [{ playerId: "p1", reaction: "clap" }], ...SESSION },
  );
  assert.equal(parseIncomingMessage({ type: "hall_reactions", counts: { clap: -1 }, sample: [], ...SESSION }), null);
  assert.equal(parseIncomingMessage({ type: "hall_reactions", counts: { clap: 1.5 }, sample: [], ...SESSION }), null);
  assert.equal(parseIncomingMessage({ type: "hall_reactions", counts: [], sample: [], ...SESSION }), null);
  assert.equal(parseIncomingMessage({ type: "hall_reactions", counts: {}, sample: [{ reaction: "clap" }], ...SESSION }), null);
  // Totals and the session marker are validated the same way.
  assert.equal(parseIncomingMessage({ type: "hall_reactions", counts: {}, sample: [] }), null, "an old server's frame without totals is dropped");
  assert.equal(parseIncomingMessage({ type: "hall_reactions", counts: {}, sample: [], totals: { clap: -2 }, session: { id: 1, active: true } }), null);
  assert.equal(parseIncomingMessage({ type: "hall_reactions", counts: {}, sample: [], totals: {}, session: { id: 1.5, active: true } }), null);
  assert.equal(parseIncomingMessage({ type: "hall_reactions", counts: {}, sample: [], totals: {}, session: { id: 1, active: "yes" } }), null);
  assert.deepEqual(
    parseIncomingMessage({ type: "hall_reactions", counts: {}, sample: [], totals: { fire: 5_000_000 }, session: { id: 2, active: false } }),
    { type: "hall_reactions", counts: {}, sample: [], totals: { fire: 999_999 }, session: { id: 2, active: false } },
    "a huge total is clamped to HALL_REACTION_TOTAL_MAX",
  );
});

test("the stage card is re-validated like the server does; an invalid card becomes null", () => {
  const card = { title: "Community call", speaker: "Ada", links: [{ kind: "github", url: "https://github.com/zcash/zcash" }], eventId: "event-92", videoId: "dQw4w9WgXcQ" };
  assert.deepEqual((parseIncomingMessage({ type: "hall_stage", stage: { ...STAGE, card } }) as { stage: { card: unknown } }).stage.card, card);
  for (const bad of [
    { title: "x", links: [{ kind: "web", url: "http://z.cash/" }] },
    { title: "x", links: [{ kind: "web", url: "https://evil.example/" }] },
    { title: "x", links: [{ kind: "web", url: "https://user:pw@github.com/" }] },
    { title: "x", links: [{ kind: "web", url: "https://github.com:444/" }] },
    { title: "x", links: Array.from({ length: HALL_CARD_LINKS_MAX + 1 }, () => ({ kind: "web", url: "https://z.cash/" })) },
    { title: "x", videoId: "../../etc" },
    { title: "" },
    { title: 7 },
  ]) {
    assert.equal((parseIncomingMessage({ type: "hall_stage", stage: { ...STAGE, card: bad } }) as { stage: { card: unknown } }).stage.card, null, JSON.stringify(bad));
  }
  assert.deepEqual(validateHallCard({ title: " a‮b ", project: "" }), { title: "a b" }, "text is cleaned with the chat sanitizer's rules");
});
