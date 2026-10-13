import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import {
  HALL_STAGE_COOLDOWN_MAX_MS,
  HALL_STAGE_VOTE_COOLDOWN_MS,
  NAME_DEV_ADDRESS,
  WATCH_HALL_ORIGIN,
  type HallClientMessage,
  type HallServerMessage,
  type HallStageState,
} from "@project/shared";
import {
  HALL_COOLDOWNS_MAX,
  HALL_REACT_BURST,
  HALL_VOTE_BURST,
  WatchHall,
  hallVotesNeeded,
  type HallEffect,
  type HallPose,
  type WatchHallOptions,
} from "./watchHall.js";
import { parseIncomingMessage } from "./protocol.js";
import { CHAT_BURST } from "./chat.js";
import { WorldServer, type WorldServerOptions } from "./WorldServer.js";
import { NameRegistry, noteKeyForViewingKey } from "./identity/nameRegistry.js";
import { DevNameScanner, LightwalletdNameScanner } from "./identity/nameScanner.js";
import { MemoryNameStore } from "./identity/nameStore.js";
import { NameService } from "./identity/nameService.js";
import { testNameKey } from "./identity/testKeys.js";

/**
 * Stage moderation and anti-sabotage (docs/architecture/WATCH_HALL.md): server-verified identity for presenting, the floor and full voice; the audience vote; host queue
 * removal and per-player cooldowns; the default max turn lives in watchHall.test.ts. Pure rules first (fake clock),
 * then the wire with a dev name registry.
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
  /** `holder` takes the stage and goes live. */
  const live = (holder: string): void => {
    send(holder, { type: "hall_stage_request" });
    send(holder, { type: "hall_stage_live", live: true, audio: true });
  };
  return { hall, enter, send, live, advance: (ms: number) => (clock += ms) };
}

const ofType = <T extends HallServerMessage["type"]>(effects: HallEffect[], type: T) =>
  effects.filter((effect): effect is HallEffect & { message: Extract<HallServerMessage, { type: T }> } => effect.message.type === type);
const errorOf = (effects: HallEffect[]): string | null => {
  const error = ofType(effects, "hall_error")[0];
  return error ? `${error.message.op}:${error.message.reason}` : null;
};
const lastStage = (effects: HallEffect[]): HallStageState | undefined => ofType(effects, "hall_stage").at(-1)?.message.stage;
/** The vote broadcast `id` received in these effects. */
const voteFor = (effects: HallEffect[], id: string) => ofType(effects, "hall_vote").find((effect) => effect.to.includes(id))?.message;

test("the vote bar: max(3, ceil(50 % of the other members present))", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 10, 59].map(hallVotesNeeded), [3, 3, 3, 3, 3, 3, 3, 4, 5, 30]);
});

test("verified identity: only mayPresent players request, are granted or get the floor; the queue skips the rest", () => {
  const verified = new Set(["A", "B", "H"]);
  const { hall, enter, send } = setup({ hostKey: HOST_KEY, mayPresent: (id) => verified.has(id) });
  enter("A", "B", "G", "H");
  assert.equal(errorOf(send("G", { type: "hall_stage_request" })), "stage:identity_required", "an unverified player can't queue");
  assert.equal(hall.stageState().queue.length, 0);

  send("A", { type: "hall_stage_request" });
  send("G", { type: "hall_hand", raised: true });
  assert.equal(errorOf(send("A", { type: "hall_floor", playerId: "G" })), "floor:identity_required", "a raised hand is not enough for a hall-wide mic");
  send("H", { type: "hall_host_auth", key: HOST_KEY });
  assert.equal(errorOf(send("H", { type: "hall_stage_handover", to: "G" })), "stage:identity_required", "not even a host grants the stage to an unverified hand");

  // B queues, then loses its verified identity (a forgotten wallet, a name taken over by the owner's newer session).
  send("B", { type: "hall_stage_request" });
  assert.deepEqual(hall.stageState().queue, ["B"]);
  verified.delete("B");
  const dropped = hall.identityChanged("B");
  assert.deepEqual(lastStage(dropped)?.queue, [], "the queue place goes at once");

  // The holder loses it: the turn ends; and the floor goes with an identity.
  send("B", { type: "hall_hand", raised: true });
  verified.add("B");
  send("A", { type: "hall_floor", playerId: "B" });
  assert.equal(hall.stateFor("A").floor, "B");
  verified.delete("B");
  const noFloor = hall.identityChanged("B");
  assert.equal(ofType(noFloor, "hall_floor")[0]?.message.playerId, null);
  verified.delete("A");
  assert.equal(lastStage(hall.identityChanged("A"))?.holder, null, "an unverified holder's turn ends");

  // A queue head that lost its identity without identityChanged (defensive) is skipped by advance().
  verified.add("A");
  verified.add("B");
  send("A", { type: "hall_stage_request" });
  send("B", { type: "hall_stage_request" });
  verified.delete("B");
  send("H", { type: "hall_stage_request" });
  const next = lastStage(send("A", { type: "hall_stage_stop" }));
  assert.equal(next?.holder, "H", "B was skipped and dropped");
  assert.deepEqual(next?.queue, []);
});

test("vote: members other than the holder, live and unlocked only; the count (never who) to members; each recipient learns only its own vote", () => {
  const { hall, enter, send } = setup();
  enter("A", "B", "C", "D", "E");
  assert.equal(errorOf(send("B", { type: "hall_stage_vote", end: true })), "vote:not_live", "nothing on stage");
  assert.equal(errorOf(send("outsider", { type: "hall_stage_vote", end: true })), "vote:not_in_hall");
  send("A", { type: "hall_stage_request" });
  assert.equal(errorOf(send("B", { type: "hall_stage_vote", end: true })), "vote:not_live", "preparing is not live (the prepare timeout covers it)");
  const wentLive = send("A", { type: "hall_stage_live", live: true, audio: false });
  assert.deepEqual(voteFor(wentLive, "B"), { type: "hall_vote", votes: 0, needed: 3, voted: false }, "the bar opens with the share");
  assert.equal(hall.stateFor("C").vote.needed, 3);
  assert.equal(errorOf(send("A", { type: "hall_stage_vote", end: true })), "vote:invalid", "the holder can just stop");

  const cast = send("B", { type: "hall_stage_vote", end: true });
  assert.deepEqual(voteFor(cast, "B"), { type: "hall_vote", votes: 1, needed: 3, voted: true });
  assert.deepEqual(voteFor(cast, "C"), { type: "hall_vote", votes: 1, needed: 3, voted: false });
  assert.deepEqual(voteFor(cast, "A"), { type: "hall_vote", votes: 1, needed: 3, voted: false }, "the presenter sees the count too");
  const votedTrue = ofType(cast, "hall_vote").filter((effect) => effect.message.voted);
  assert.deepEqual(votedTrue.flatMap((effect) => effect.to), ["B"], "only the voter is told it voted; the messages name nobody");
  assert.equal(JSON.stringify(ofType(cast, "hall_vote").map((effect) => effect.message)).includes("B"), false);
  assert.deepEqual(send("B", { type: "hall_stage_vote", end: true }), [], "voting twice changes nothing and costs nothing");
  const back = send("B", { type: "hall_stage_vote", end: false });
  assert.deepEqual(voteFor(back, "B"), { type: "hall_vote", votes: 0, needed: 3, voted: false }, "a vote can be taken back");
  assert.deepEqual(send("C", { type: "hall_stage_vote", end: false }), [], "nothing to take back");
  assert.equal(hall.stageState().holder, "A");
});

test("vote: reaching the bar ends the turn, the queue moves on and the holder gets a 10-minute cooldown; votes reset each turn", () => {
  const { hall, enter, send, live, advance } = setup();
  enter("A", "B", "C", "D", "E", "F", "G"); // 6 others → bar 3
  live("A");
  send("G", { type: "hall_stage_request" });
  send("B", { type: "hall_stage_vote", end: true });
  send("C", { type: "hall_stage_vote", end: true });
  assert.equal(hall.stageState().holder, "A");
  const ended = send("D", { type: "hall_stage_vote", end: true });
  const stage = lastStage(ended);
  assert.equal(stage?.holder, "G", "the turn ended and the queue head took over");
  assert.equal(stage?.status, "preparing");
  assert.deepEqual(voteFor(ended, "B"), { type: "hall_vote", votes: 0, needed: 0, voted: false }, "votes reset with the turn");

  // The voted-off presenter is benched for HALL_STAGE_VOTE_COOLDOWN_MS.
  const refused = send("A", { type: "hall_stage_request" });
  assert.equal(errorOf(refused), "stage:cooldown");
  assert.equal(ofType(refused, "hall_error")[0]?.message.retryInMs, HALL_STAGE_VOTE_COOLDOWN_MS);
  advance(HALL_STAGE_VOTE_COOLDOWN_MS - 1000);
  assert.equal(ofType(send("A", { type: "hall_stage_request" }), "hall_error")[0]?.message.retryInMs, 1000);
  advance(1000);
  assert.equal(errorOf(send("A", { type: "hall_stage_request" })), null, "the cooldown ran out");
  assert.deepEqual(hall.stageState().queue, ["A"]);

  // The next turn starts with no votes: G goes live, and the old voters' votes don't carry over.
  const next = send("G", { type: "hall_stage_live", live: true, audio: false });
  assert.deepEqual(voteFor(next, "B"), { type: "hall_vote", votes: 0, needed: 3, voted: false });
});

test("vote: a voter who leaves takes the vote along; a departure that lowers the bar can end the share", () => {
  const { hall, enter, send, live } = setup();
  const audience = ["B", "C", "D", "E", "F", "G", "H", "I"]; // 8 others → bar 4
  enter("A", ...audience);
  live("A");
  for (const id of ["B", "C", "D"]) send(id, { type: "hall_stage_vote", end: true });
  const left = hall.updatePose("B", OUTSIDE); // 7 others → bar 4; B's vote goes
  assert.deepEqual(voteFor(left, "C"), { type: "hall_vote", votes: 2, needed: 4, voted: true });
  send("B", { type: "hall_stage_vote", end: true });
  assert.equal(hall.voteStateFor("B").voted, false, "an outsider's vote is refused");
  send("E", { type: "hall_stage_vote", end: true }); // 3 votes of a bar of 4
  assert.equal(hall.stageState().holder, "A");
  const ended = hall.updatePose("I", OUTSIDE); // 6 others → bar 3: the three votes reach it
  assert.equal(lastStage(ended)?.holder, null, "the share ended when the bar came down to the votes");
  assert.ok(hall.cooldownLeft("A") > 0);
});

test("vote: a lock closes the vote and drops the votes; a host can always stop; mayVote decides whose vote counts; votes are rate-limited", () => {
  const voters = new Set(["B", "C", "D", "E"]);
  const { hall, enter, send, live, advance } = setup({ hostKey: HOST_KEY, mayVote: (id) => voters.has(id) });
  enter("A", "B", "C", "D", "E", "G", "H");
  send("H", { type: "hall_host_auth", key: HOST_KEY });
  live("A");
  assert.equal(errorOf(send("G", { type: "hall_stage_vote", end: true })), "vote:identity_required", "a guest's vote doesn't count while a registry runs");
  send("B", { type: "hall_stage_vote", end: true });
  send("C", { type: "hall_stage_vote", end: true });
  const locked = send("H", { type: "hall_stage_lock", locked: true });
  assert.deepEqual(voteFor(locked, "B"), { type: "hall_vote", votes: 0, needed: 0, voted: false }, "the lock closes the vote");
  assert.equal(errorOf(send("D", { type: "hall_stage_vote", end: true })), "vote:locked");
  assert.equal(hall.stageState().holder, "A");
  send("H", { type: "hall_stage_lock", locked: false });
  assert.equal(hall.voteStateFor("B").votes, 0, "unlocking doesn't bring old votes back");

  // A voter who loses its identity loses its vote.
  send("B", { type: "hall_stage_vote", end: true });
  voters.delete("B");
  assert.equal(voteFor(hall.identityChanged("B"), "C")?.votes, 0);

  // Each vote change is broadcast: HALL_VOTE_BURST changes, then one every 10 s.
  // (D's earlier vote on the locked stage was refused before any token was spent.)
  for (let i = 0; i < HALL_VOTE_BURST; i++) assert.equal(errorOf(send("D", { type: "hall_stage_vote", end: i % 2 === 0 })), null);
  assert.equal(hall.voteStateFor("D").voted, true);
  assert.equal(errorOf(send("D", { type: "hall_stage_vote", end: false })), "vote:rate_limited");
  advance(10_000);
  assert.equal(errorOf(send("D", { type: "hall_stage_vote", end: false })), null);

  // The host ends the share whatever the vote says (and without a cooldown).
  assert.equal(lastStage(send("H", { type: "hall_stage_stop" }))?.holder, null);
  assert.equal(hall.cooldownLeft("A"), 0);
});

test("host extras: remove a player from the queue; a stage cooldown ends the turn, drops the queue place, 0 lifts it; hosts only", () => {
  const { hall, enter, send, live, advance } = setup({ hostKey: HOST_KEY });
  enter("A", "B", "C", "H");
  send("H", { type: "hall_host_auth", key: HOST_KEY });
  live("A");
  send("B", { type: "hall_stage_request" });
  send("C", { type: "hall_stage_request" });

  assert.equal(errorOf(send("A", { type: "hall_stage_dequeue", playerId: "B" })), "stage:not_host", "the holder can hand over, not remove");
  assert.equal(errorOf(send("H", { type: "hall_stage_dequeue", playerId: "A" })), "stage:not_queued");
  assert.deepEqual(lastStage(send("H", { type: "hall_stage_dequeue", playerId: "B" }))?.queue, ["C"]);
  assert.equal(errorOf(send("B", { type: "hall_stage_request" })), null, "removal is not a ban: B may queue again");

  // A 30-minute cooldown on the holder ends the turn (C is next; B is behind it).
  assert.equal(errorOf(send("C", { type: "hall_stage_cooldown", playerId: "A", ms: 60_000 })), "stage:not_host");
  const benched = send("H", { type: "hall_stage_cooldown", playerId: "A", ms: 30 * 60_000 });
  assert.equal(lastStage(benched)?.holder, "C");
  assert.equal(errorOf(send("A", { type: "hall_stage_request" })), "stage:cooldown");
  // A cooldown on a queued player drops the queue place.
  assert.deepEqual(lastStage(send("H", { type: "hall_stage_cooldown", playerId: "B", ms: 60_000 }))?.queue, []);
  // A benched player can't queue, so the holder can never pass the turn to one; a host may grant it deliberately (here
  // to B's raised hand) — a trusted role overrides a cooldown.
  send("B", { type: "hall_hand", raised: true });
  assert.equal(errorOf(send("C", { type: "hall_stage_handover", to: "B" })), "stage:not_queued");
  assert.equal(lastStage(send("H", { type: "hall_stage_handover", to: "B" }))?.holder, "B", "a host overrides a cooldown");
  // 0 lifts a cooldown; limits are checked.
  advance(1000);
  assert.deepEqual(send("H", { type: "hall_stage_cooldown", playerId: "A", ms: 0 }), []);
  assert.equal(hall.cooldownLeft("A"), 0);
  assert.equal(errorOf(send("H", { type: "hall_stage_cooldown", playerId: "nobody", ms: 60_000 })), "stage:not_found");
  assert.equal(errorOf(send("H", { type: "hall_stage_cooldown", playerId: "A", ms: HALL_STAGE_COOLDOWN_MAX_MS + 1 })), "stage:invalid");
  assert.equal(errorOf(send("H", { type: "hall_stage_cooldown", playerId: "A", ms: 1.5 })), "stage:invalid");
  assert.equal(errorOf(send("A", { type: "hall_stage_request" })), null);
});

test("cooldowns follow identityOf (an owned name survives a reconnect) and the map stays bounded", () => {
  const identity = new Map<string, string>([
    ["A1", "name:ana"],
    ["A2", "name:ana"],
  ]);
  const { hall, enter, send, live, advance } = setup({ identityOf: (id) => identity.get(id) ?? `session:${id}` });
  enter("A1", "B", "C", "D");
  live("A1");
  for (const id of ["B", "C", "D"]) send(id, { type: "hall_stage_vote", end: true });
  assert.equal(hall.stageState().holder, null);
  hall.forget("A1"); // Ana reconnects as a new session with the same owned name
  enter("A2");
  assert.equal(errorOf(send("A2", { type: "hall_stage_request" })), "stage:cooldown", "a reconnect does not escape the cooldown");
  advance(HALL_STAGE_VOTE_COOLDOWN_MS);
  assert.equal(errorOf(send("A2", { type: "hall_stage_request" })), null);

  // Bounded: a flood of cooldowns never grows the map past HALL_COOLDOWNS_MAX — the ones ending soonest go first.
  const bounded = setup({ hostKey: HOST_KEY });
  bounded.enter("H");
  bounded.send("H", { type: "hall_host_auth", key: HOST_KEY });
  const total = HALL_COOLDOWNS_MAX + 10;
  for (let i = 0; i < total; i++) {
    bounded.enter(`P${i}`);
    bounded.advance(500); // the host's broadcast budget refills (2/s)
    assert.equal(errorOf(bounded.send("H", { type: "hall_stage_cooldown", playerId: `P${i}`, ms: HALL_STAGE_COOLDOWN_MAX_MS })), null);
  }
  const kept = Array.from({ length: total }, (_, i) => bounded.hall.cooldownLeft(`P${i}`) > 0);
  assert.equal(kept.filter(Boolean).length, HALL_COOLDOWNS_MAX);
  assert.deepEqual(kept.slice(0, 10), Array(10).fill(false), "the ten ending soonest were dropped");
  assert.equal(kept[total - 1], true, "the newest cooldown is kept");
});

test("parser: hall_stage_vote / hall_stage_dequeue / hall_stage_cooldown are rebuilt from checked fields", () => {
  assert.deepEqual(parseIncomingMessage({ type: "hall_stage_vote", end: true, who: "x" }), { type: "hall_stage_vote", end: true });
  assert.deepEqual(parseIncomingMessage({ type: "hall_stage_vote", end: false }), { type: "hall_stage_vote", end: false });
  for (const end of [undefined, 1, "true", null]) assert.equal(parseIncomingMessage({ type: "hall_stage_vote", end }), null, String(end));
  assert.deepEqual(parseIncomingMessage({ type: "hall_stage_dequeue", playerId: "p1" }), { type: "hall_stage_dequeue", playerId: "p1" });
  for (const playerId of ["", "x".repeat(65), 5, null]) assert.equal(parseIncomingMessage({ type: "hall_stage_dequeue", playerId }), null, String(playerId));
  assert.deepEqual(parseIncomingMessage({ type: "hall_stage_cooldown", playerId: "p1", ms: 600_000 }), { type: "hall_stage_cooldown", playerId: "p1", ms: 600_000 });
  assert.deepEqual(parseIncomingMessage({ type: "hall_stage_cooldown", playerId: "p1", ms: 0 }), { type: "hall_stage_cooldown", playerId: "p1", ms: 0 });
  for (const ms of [-1, 1.5, HALL_STAGE_COOLDOWN_MAX_MS + 1, "60000", null]) {
    assert.equal(parseIncomingMessage({ type: "hall_stage_cooldown", playerId: "p1", ms }), null, String(ms));
  }
});

// ---------------------------------------------------------------------------------------------- the wire

type Msg = Record<string, unknown>;
const HALL_POS = { x: WATCH_HALL_ORIGIN.x, y: 0, z: WATCH_HALL_ORIGIN.z };

/** What the fake lightwalletd reader returns for a txid the test "broadcast" (memo and amount of the paid quote). */
type FakeChain = Map<string, { memo: string; amountZat: number }>;

/**
 * `registry`: true — the dev backend (test chain); "lightwalletd" — the mainnet backend (ADR-018 § 5): the paying
 * client reports its txid (`name_payment_sent`) and a reader (here a fake chain, already confirmed) returns its notes.
 */
async function startServer(options: WorldServerOptions & { registry?: boolean | "lightwalletd" } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const chain: FakeChain = new Map();
  const names =
    options.registry === "lightwalletd"
      ? new NameService({
          mode: "lightwalletd",
          registry: new NameRegistry({ now: Date.now, store: new MemoryNameStore(), address: "u1" + "q".repeat(100), feeZat: 1_000_000, minConfirmations: 1, noteKey: noteKeyForViewingKey("uview1" + "x".repeat(80)) }),
          scanner: new LightwalletdNameScanner(
            {
              read: async (txid) => {
                const paid = chain.get(txid);
                return paid ? { status: "found", confirmations: 1, notes: [{ ref: `${txid}:sapling:0`, memo: paid.memo, amountZat: paid.amountZat, confirmations: 1 }] } : { status: "missing" };
              },
            },
            50,
          ),
        })
      : options.registry
        ? new NameService({
            mode: "dev",
            registry: new NameRegistry({ now: Date.now, store: new MemoryNameStore(), address: NAME_DEV_ADDRESS, feeZat: 1_000_000, minConfirmations: 1 }),
            scanner: new DevNameScanner(Date.now, 100),
          })
        : NameService.off();
  const world = new WorldServer(wss, { ...options, names });
  const sockets: WebSocket[] = [];
  return {
    port,
    world,
    sockets,
    chain,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.close();
        world.dispose();
        wss.close(() => resolve());
      }),
  };
}

async function join(server: { port: number; sockets: WebSocket[]; chain: FakeChain }, options: { wallet: boolean; ownedName?: string }) {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  server.sockets.push(socket);
  const messages: Msg[] = [];
  socket.addEventListener("message", (event) => messages.push(JSON.parse(event.data as string) as Msg));
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  const send = (message: Msg) => socket.send(JSON.stringify(message));
  const waitFor = async (predicate: (m: Msg) => boolean, timeoutMs = 4000): Promise<Msg> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("timed out");
  };
  send({ type: "join", wallet: options.wallet });
  const welcome = await waitFor((m) => m.type === "welcome");
  if (options.ownedName) {
    // ADR-016 dev registry: the reservation confirms on its own after a short delay (nothing is paid).
    const key = await testNameKey();
    send({ type: "name_reserve", nickname: options.ownedName, keyHash: key.keyHash });
    if (server.world.nameInfo.mode === "fee" && !messages.some((m) => m.type === "name_status" && m.status === "confirmed")) {
      const quote = await waitFor((m) => m.type === "name_quote");
      if (quote.address !== NAME_DEV_ADDRESS) {
        // The lightwalletd backend: the wallet pays the quote and reports the txid (ADR-018 § 5).
        const txid = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
        server.chain.set(txid, { memo: quote.memo as string, amountZat: quote.amountZat as number });
        send({ type: "name_payment_sent", reservationId: quote.reservationId, txid });
      }
    }
    await waitFor((m) => m.type === "name_status" && m.status === "confirmed");
  }
  send({ type: "player_transform", ...HALL_POS, rotationY: 0, animationState: "idle", seq: 1 });
  await waitFor((m) => m.type === "hall_state");
  return { messages, send, waitFor, playerId: welcome.playerId as string, capability: welcome.voiceCapability as string };
}

const hallError = (op: string, reason: string) => (m: Msg) => m.type === "hall_error" && m.op === op && m.reason === reason;

test("wire, name registry on: a holder without an owned name can't present, take the floor, vote or get a full voice grant; an owned name can", async () => {
  const server = await startServer({ registry: true });
  try {
    const named = await join(server, { wallet: true, ownedName: "Presenter" });
    const unnamed = await join(server, { wallet: true }); // the client-asserted holder flag alone
    const guest = await join(server, { wallet: false });

    assert.deepEqual(
      { canReceive: server.world.resolveVoiceSession(unnamed.capability)?.canReceive, canTalk: server.world.resolveVoiceSession(unnamed.capability)?.canTalk },
      { canReceive: true, canTalk: false },
      "the holder flag without an owned name gets no full voice grant",
    );
    assert.equal(server.world.resolveVoiceSession(named.capability)?.canTalk, true);
    assert.equal(server.world.resolveVoiceSession(guest.capability)?.canTalk, false);

    unnamed.send({ type: "hall_stage_request" });
    await unnamed.waitFor(hallError("stage", "identity_required"));
    named.send({ type: "hall_stage_request" });
    await named.waitFor((m) => m.type === "hall_stage" && (m.stage as { holder: string }).holder === named.playerId);
    unnamed.send({ type: "hall_hand", raised: true });
    await named.waitFor((m) => m.type === "hall_hands" && (m.hands as string[]).includes(unnamed.playerId));
    named.send({ type: "hall_floor", playerId: unnamed.playerId });
    await named.waitFor(hallError("floor", "identity_required"));

    named.send({ type: "hall_stage_live", live: true, audio: false });
    await guest.waitFor((m) => m.type === "hall_vote" && m.needed === 3);
    guest.send({ type: "hall_stage_vote", end: true });
    await guest.waitFor(hallError("vote", "identity_required"));
    unnamed.send({ type: "hall_stage_vote", end: true });
    await unnamed.waitFor(hallError("vote", "identity_required"));
  } finally {
    await server.stop();
  }
});

test("wire: the mainnet lightwalletd registry is a live registry — the stage, the floor, the vote and full voice need an owned name", async () => {
  const server = await startServer({ registry: "lightwalletd" });
  try {
    assert.equal(server.world.nameInfo.mode, "fee", "clients are told names are fee-confirmed (the client's own gate keys off this)");
    const named = await join(server, { wallet: true, ownedName: "Mainnet" });
    const unnamed = await join(server, { wallet: true });
    const guest = await join(server, { wallet: false });
    assert.equal(server.world.resolveVoiceSession(named.capability)?.canTalk, true, "a name confirmed by a reported mainnet payment talks");
    assert.deepEqual(
      { canReceive: server.world.resolveVoiceSession(unnamed.capability)?.canReceive, canTalk: server.world.resolveVoiceSession(unnamed.capability)?.canTalk },
      { canReceive: true, canTalk: false },
      "the client-asserted holder flag alone gets no full voice grant on mainnet either",
    );

    unnamed.send({ type: "hall_stage_request" });
    await unnamed.waitFor(hallError("stage", "identity_required"));
    named.send({ type: "hall_stage_request" });
    await named.waitFor((m) => m.type === "hall_stage" && (m.stage as { holder: string }).holder === named.playerId);
    unnamed.send({ type: "hall_hand", raised: true });
    await named.waitFor((m) => m.type === "hall_hands" && (m.hands as string[]).includes(unnamed.playerId));
    named.send({ type: "hall_floor", playerId: unnamed.playerId });
    await named.waitFor(hallError("floor", "identity_required"));
    named.send({ type: "hall_stage_live", live: true, audio: false });
    await unnamed.waitFor((m) => m.type === "hall_vote");
    unnamed.send({ type: "hall_stage_vote", end: true });
    await unnamed.waitFor(hallError("vote", "identity_required"));
    guest.send({ type: "hall_stage_vote", end: true });
    await guest.waitFor(hallError("vote", "identity_required"));
  } finally {
    await server.stop();
  }
});

test("wire, registry off: the honour-system holder flag presents; a guest can't; three votes end a share and bench the presenter", async () => {
  const server = await startServer();
  try {
    const holder = await join(server, { wallet: true });
    const guest = await join(server, { wallet: false });
    const v1 = await join(server, { wallet: false });
    const v2 = await join(server, { wallet: false });
    assert.equal(server.world.resolveVoiceSession(holder.capability)?.canTalk, true, "registry off: the holder flag decides");

    guest.send({ type: "hall_stage_request" });
    await guest.waitFor(hallError("stage", "identity_required"));
    holder.send({ type: "hall_stage_request" });
    holder.send({ type: "hall_stage_live", live: true, audio: true });
    await guest.waitFor((m) => m.type === "hall_vote" && m.needed === 3);

    guest.send({ type: "hall_stage_vote", end: true });
    await guest.waitFor((m) => m.type === "hall_vote" && m.votes === 1 && m.voted === true);
    await v1.waitFor((m) => m.type === "hall_vote" && m.votes === 1 && m.voted === false);
    v1.send({ type: "hall_stage_vote", end: true });
    await holder.waitFor((m) => m.type === "hall_vote" && m.votes === 2);
    v2.send({ type: "hall_stage_vote", end: true });
    await holder.waitFor((m) => m.type === "hall_stage" && (m.stage as { holder: unknown }).holder === null);
    assert.ok(!holder.messages.some((m) => m.type === "hall_vote" && JSON.stringify(m).includes(guest.playerId)), "nobody learns who voted");

    holder.send({ type: "hall_stage_request" });
    const refused = await holder.waitFor(hallError("stage", "cooldown"));
    assert.ok(typeof refused.retryInMs === "number" && refused.retryInMs > HALL_STAGE_VOTE_COOLDOWN_MS - 5000 && refused.retryInMs <= HALL_STAGE_VOTE_COOLDOWN_MS);
  } finally {
    await server.stop();
  }
});

test("wire: hall chat spends the same per-session chat bucket as every other channel (no escape by switching channels); reactions have their own", async () => {
  const server = await startServer();
  try {
    const spammer = await join(server, { wallet: false });
    const listener = await join(server, { wallet: false });
    for (let i = 0; i < CHAT_BURST; i++) spammer.send({ type: "chat_send", channel: "hall", text: `spam ${i}` });
    await listener.waitFor((m) => m.type === "chat_message" && m.text === `spam ${CHAT_BURST - 1}`);
    spammer.send({ type: "chat_send", channel: "hall", text: "one more" });
    await spammer.waitFor((m) => m.type === "chat_rejected" && m.reason === "rate_limited");
    spammer.send({ type: "chat_send", channel: "general", text: "elsewhere" });
    await spammer.waitFor((m) => m.type === "chat_rejected" && m.reason === "rate_limited" && spammer.messages.filter((x) => x.type === "chat_rejected").length === 2);
    for (let i = 0; i < HALL_REACT_BURST + 4; i++) spammer.send({ type: "hall_react", reaction: "clap" });
    await spammer.waitFor(hallError("react", "rate_limited"));
    assert.equal(listener.messages.filter((m) => m.type === "chat_message" && (m.text === "one more" || m.text === "elsewhere")).length, 0);
  } finally {
    await server.stop();
  }
});

test("wire: forgetting the wallet mid-turn ends the turn (the honour flag is the identity while no registry runs)", async () => {
  const server = await startServer();
  try {
    const holder = await join(server, { wallet: true });
    const viewer = await join(server, { wallet: false });
    holder.send({ type: "hall_stage_request" });
    await viewer.waitFor((m) => m.type === "hall_stage" && (m.stage as { holder: string }).holder === holder.playerId);
    holder.send({ type: "set_wallet", connected: false });
    await viewer.waitFor((m) => m.type === "hall_stage" && (m.stage as { holder: unknown }).holder === null);
  } finally {
    await server.stop();
  }
});

test("wire: host queue removal and cooldown reach the hall; the max turn defaults to 60 minutes", async () => {
  let clock = Date.now();
  // The fake clock jumps 15 minutes: keep the stale sweep (which reads the same clock) out of it.
  const server = await startServer({ hallHostKey: HOST_KEY, now: () => clock, staleTimeoutMs: 24 * 60 * 60_000 });
  try {
    const host = await join(server, { wallet: true });
    const a = await join(server, { wallet: true });
    const b = await join(server, { wallet: true });
    host.send({ type: "hall_host_auth", key: HOST_KEY });
    await host.waitFor((m) => m.type === "hall_state" && m.host === true);
    a.send({ type: "hall_stage_request" });
    b.send({ type: "hall_stage_request" });
    await host.waitFor((m) => m.type === "hall_stage" && (m.stage as { queue: string[] }).queue.includes(b.playerId));
    host.send({ type: "hall_stage_dequeue", playerId: b.playerId });
    await b.waitFor((m) => m.type === "hall_stage" && (m.stage as { queue: string[] }).queue.length === 0 && (m.stage as { holder: string }).holder === a.playerId);
    host.send({ type: "hall_stage_cooldown", playerId: a.playerId, ms: 15 * 60_000 });
    await b.waitFor((m) => m.type === "hall_stage" && (m.stage as { holder: unknown }).holder === null);
    const refused = await (async () => {
      a.send({ type: "hall_stage_request" });
      return a.waitFor(hallError("stage", "cooldown"));
    })();
    assert.equal(refused.retryInMs, 15 * 60_000);
    clock += 15 * 60_000; // the cooldown runs out
    a.send({ type: "hall_stage_request" });
    await b.waitFor((m) => m.type === "hall_stage" && (m.stage as { holder: string }).holder === a.playerId);
    // The default max turn (60 minutes, WATCH_HALL_MAX_TURN_MS unset) is covered with a fake clock in watchHall.test.ts.
  } finally {
    await server.stop();
  }
});
