import { test } from "node:test";
import assert from "node:assert/strict";
import { MOD_NICKNAME_LABEL_MAX, NAME_CHALLENGE_TTL_MS, NAME_RESERVATION_TTL_MS, parseNameMemo } from "@project/shared";
import { NameRegistry, banLabel, noteHash, type ReceivedNote } from "./nameRegistry.js";
import { MemoryNameStore } from "./nameStore.js";
import { testNameKey } from "./testKeys.js";

/**
 * ADR-016: the registry's pure logic — reservations (TTL, one per session/key, uniqueness against
 * online, reserved and registered names), payment matching (nonce + key-hash prefix + amount ≥ fee, 0-conf, each
 * note once), the store round trip, and claim challenges (good, bad signature, replayed nonce, expired).
 */

const FEE = 1_000_000;
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const ADDRESS = "uregtest1" + "q".repeat(80);

function setup(options: { minConfirmations?: number; random?: (size: number) => Uint8Array; store?: MemoryNameStore; maxPending?: number } = {}) {
  let t = 1_000_000;
  const store = options.store ?? new MemoryNameStore();
  const registry = new NameRegistry({
    now: () => t,
    store,
    address: ADDRESS,
    feeZat: FEE,
    minConfirmations: options.minConfirmations ?? 0,
    ...(options.random ? { randomBytes: options.random } : {}),
    ...(options.maxPending !== undefined ? { maxPending: options.maxPending } : {}),
  });
  return { registry, store, advance: (ms: number) => (t += ms), now: () => t };
}

const nobodyOnline = () => false;

function reserveOk(registry: NameRegistry, session: string, nickname: string, keyHash: string) {
  const outcome = registry.reserve(session, nickname, keyHash, nobodyOnline);
  assert.ok(outcome.ok, `reserve ${nickname} failed: ${outcome.ok ? "" : outcome.status}`);
  return outcome.quote;
}

function payment(memo: string, overrides: Partial<ReceivedNote> = {}): ReceivedNote {
  return { ref: `${"f".repeat(64)}:orchard:0`, memo, amountZat: FEE, confirmations: 0, ...overrides };
}

test("a reservation quotes the registry address, the fee and the memo zw-name:v1:<nonce>:<key prefix>, for 30 minutes", () => {
  const { registry, now } = setup();
  const quote = reserveOk(registry, "s1", "  Nadia ", KEY_A);
  assert.equal(quote.type, "name_quote");
  assert.equal(quote.nickname, "Nadia");
  assert.equal(quote.address, ADDRESS);
  assert.equal(quote.amountZat, FEE);
  assert.equal(quote.expiresAt, now() + NAME_RESERVATION_TTL_MS);
  assert.match(quote.reservationId, /^[A-Za-z0-9_-]{22}$/);
  assert.match(quote.memo, /^zw-name:v1:[0-9a-f]{32}:a{16}$/);
  assert.equal(registry.pendingCount, 1);
  assert.equal(registry.reservationSession(quote.reservationId), "s1");
});

test("uniqueness: another key cannot reserve a reserved name (NFKC, any case); online and invalid names are refused", () => {
  const { registry } = setup();
  reserveOk(registry, "s1", "Nadia", KEY_A);
  assert.deepEqual(registry.reserve("s2", "NADIA", KEY_B, nobodyOnline), { ok: false, status: "taken" });
  assert.deepEqual(registry.reserve("s2", "Ｎａｄｉａ", KEY_B, nobodyOnline), { ok: false, status: "taken" }); // fullwidth
  assert.deepEqual(registry.reserve("s2", "Ada", KEY_B, (key) => key === "ada"), { ok: false, status: "taken" });
  assert.deepEqual(registry.reserve("s2", "Guest-1234", KEY_B, nobodyOnline), { ok: false, status: "invalid" });
  assert.deepEqual(registry.reserve("s2", "admin", KEY_B, nobodyOnline), { ok: false, status: "invalid" });
  assert.deepEqual(registry.reserve("s2", "a‮b", KEY_B, nobodyOnline), { ok: false, status: "invalid" });
  assert.deepEqual(registry.reserve("s2", "Ok", "not-a-hash", nobodyOnline), { ok: false, status: "invalid" });
  assert.equal(registry.isReservedForOther("nadia", "s2"), true);
  assert.equal(registry.isReservedForOther("nadia", "s1"), false);
});

test("one per session: a new name replaces the unpaid reservation; the same key + name from a new session is the SAME reservation", () => {
  const { registry } = setup();
  const first = reserveOk(registry, "s1", "Nadia", KEY_A);
  const second = reserveOk(registry, "s1", "Ada", KEY_A);
  assert.notEqual(second.reservationId, first.reservationId);
  assert.equal(registry.pendingCount, 1);
  assert.equal(registry.isReservedForOther("nadia", "s9"), false, "the replaced name is free again");
  // A reload: a new connection asks for the same name with the same key — same reservation, same memo (pay once).
  const again = reserveOk(registry, "s2", "ada", KEY_A);
  assert.equal(again.reservationId, second.reservationId);
  assert.equal(again.memo, second.memo);
  assert.equal(registry.reservationSession(second.reservationId), "s2");
});

test("a reservation expires after 30 minutes (expired update), and the name is free again", () => {
  const { registry, advance } = setup();
  const quote = reserveOk(registry, "s1", "Nadia", KEY_A);
  advance(NAME_RESERVATION_TTL_MS - 1);
  registry.expireDue();
  assert.deepEqual(registry.takeUpdates(), []);
  advance(1);
  registry.expireDue();
  assert.deepEqual(registry.takeUpdates(), [{ kind: "status", sessionId: "s1", reservationId: quote.reservationId, nickname: "Nadia", status: "expired" }]);
  assert.equal(registry.pendingCount, 0);
  assert.ok(registry.reserve("s2", "Nadia", KEY_B, nobodyOnline).ok);
});

test("the global cap on pending reservations answers rate_limited", () => {
  const { registry } = setup({ maxPending: 2 });
  reserveOk(registry, "s1", "One", "1".repeat(64));
  reserveOk(registry, "s2", "Two", "2".repeat(64));
  assert.deepEqual(registry.reserve("s3", "Three", "3".repeat(64), nobodyOnline), { ok: false, status: "rate_limited" });
});

test("a matching 0-conf payment confirms at once (seen, then confirmed) and registers the name — the record holds no address or txid", () => {
  const { registry, store } = setup();
  const quote = reserveOk(registry, "s1", "Nadia", KEY_A);
  registry.processNotes([payment(quote.memo)]);
  const updates = registry.takeUpdates();
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[0], { kind: "status", sessionId: "s1", reservationId: quote.reservationId, nickname: "Nadia", status: "seen" });
  assert.equal(updates[1]!.kind, "confirmed");
  assert.equal(registry.isRegistered("nadia"), true);
  assert.equal(registry.pendingCount, 0);
  const saved = store.load();
  assert.equal(saved.names.length, 1);
  assert.deepEqual(Object.keys(saved.names[0]!).sort(), ["alg", "avatar", "createdAt", "displayName", "keyHash", "lastSeen", "nameKey", "publicKey"]);
  assert.equal(JSON.stringify(saved).includes("f".repeat(64)), false, "no txid in the store");
  assert.equal(JSON.stringify(saved).includes(ADDRESS), false, "no address in the store");
  assert.deepEqual(saved.usedNotes, [noteHash(`${"f".repeat(64)}:orchard:0`)]);
  // Registered names are taken for everyone — the owner claims instead of paying again.
  assert.deepEqual(registry.reserve("s2", "nadia", KEY_A, nobodyOnline), { ok: false, status: "taken" });
});

test("with one confirmation required, a 0-conf payment is only seen; it confirms when it has the confirmation", () => {
  const { registry } = setup({ minConfirmations: 1 });
  const quote = reserveOk(registry, "s1", "Nadia", KEY_A);
  registry.processNotes([payment(quote.memo, { confirmations: 0 })]);
  assert.deepEqual(registry.takeUpdates().map((u) => (u.kind === "status" ? u.status : u.kind)), ["seen"]);
  registry.processNotes([payment(quote.memo, { confirmations: 0 })]);
  assert.deepEqual(registry.takeUpdates(), [], "seen once");
  registry.processNotes([payment(quote.memo, { confirmations: 1 })]);
  assert.deepEqual(registry.takeUpdates().map((u) => u.kind), ["confirmed"]);
});

test("wrong amount, wrong memo and a wrong key-hash prefix never confirm", () => {
  const { registry } = setup();
  const quote = reserveOk(registry, "s1", "Nadia", KEY_A);
  const memo = parseNameMemo(quote.memo)!;
  registry.processNotes([
    payment(quote.memo, { ref: "1".repeat(64) + ":orchard:0", amountZat: FEE - 1 }),
    payment("thanks for the tour!", { ref: "2".repeat(64) + ":orchard:0" }),
    payment(`zw-name:v1:${"0".repeat(32)}:${"a".repeat(16)}`, { ref: "3".repeat(64) + ":orchard:0" }), // unknown nonce
    payment(`zw-name:v1:${memo.nonce}:${"b".repeat(16)}`, { ref: "4".repeat(64) + ":orchard:0" }), // another key
  ]);
  assert.deepEqual(registry.takeUpdates(), []);
  assert.equal(registry.isRegistered("nadia"), false);
  // An over-payment is accepted (the fee is a minimum).
  registry.processNotes([payment(quote.memo, { ref: "5".repeat(64) + ":orchard:1", amountZat: FEE * 3 })]);
  assert.equal(registry.isRegistered("nadia"), true);
});

test("a replayed note cannot confirm a second reservation, even one with the same nonce", () => {
  // A fixed random source makes the second reservation reuse the first nonce — exactly what replay protection must survive.
  const random = (size: number) => new Uint8Array(size).fill(7);
  const { registry } = setup({ random });
  const first = reserveOk(registry, "s1", "Nadia", KEY_A);
  const note = payment(first.memo);
  registry.processNotes([note]);
  assert.equal(registry.takeUpdates().at(-1)?.kind, "confirmed");
  const second = reserveOk(registry, "s2", "Ada", KEY_A);
  assert.equal(second.memo, first.memo, "same nonce by construction");
  registry.processNotes([note]);
  assert.deepEqual(registry.takeUpdates(), []);
  assert.equal(registry.isRegistered("ada"), false);
});

test("used notes survive a restart (store round trip), so an old payment is never reused", () => {
  const random = (size: number) => new Uint8Array(size).fill(9);
  const store = new MemoryNameStore();
  const a = setup({ random, store });
  const quote = reserveOk(a.registry, "s1", "Nadia", KEY_A);
  a.registry.processNotes([payment(quote.memo)]);
  const b = setup({ random, store });
  assert.equal(b.registry.isRegistered("nadia"), true);
  assert.equal(b.registry.record("nadia")?.displayName, "Nadia");
  const again = reserveOk(b.registry, "s2", "Other", KEY_A);
  assert.equal(again.memo, quote.memo);
  b.registry.processNotes([payment(quote.memo)]);
  assert.equal(b.registry.isRegistered("other"), false);
});

test("a payment that arrives after its reservation expired is consumed and reported as expired, never confirmed", () => {
  const { registry, advance } = setup();
  const quote = reserveOk(registry, "s1", "Nadia", KEY_A);
  advance(NAME_RESERVATION_TTL_MS);
  registry.expireDue();
  registry.takeUpdates();
  registry.processNotes([payment(quote.memo)]);
  assert.deepEqual(registry.takeUpdates(), [{ kind: "status", sessionId: "s1", reservationId: quote.reservationId, nickname: "Nadia", status: "expired" }]);
  assert.equal(registry.isRegistered("nadia"), false);
  // A fresh reservation for the same name cannot use that payment either.
  const fresh = reserveOk(registry, "s1", "Nadia", KEY_A);
  registry.processNotes([payment(quote.memo)]);
  assert.deepEqual(registry.takeUpdates(), []);
  assert.notEqual(fresh.memo, quote.memo);
});

test("a seen payment keeps its reservation past the TTL while it collects confirmations", () => {
  const { registry, advance } = setup({ minConfirmations: 1 });
  const quote = reserveOk(registry, "s1", "Nadia", KEY_A);
  registry.processNotes([payment(quote.memo, { confirmations: 0 })]);
  registry.takeUpdates();
  advance(NAME_RESERVATION_TTL_MS + 1000);
  registry.expireDue();
  assert.deepEqual(registry.takeUpdates(), []);
  assert.deepEqual(registry.reserve("s1", "Other", KEY_A, nobodyOnline), { ok: false, status: "rate_limited" }, "no second name while a payment is on its way");
  registry.processNotes([payment(quote.memo, { confirmations: 1 })]);
  assert.equal(registry.isRegistered("nadia"), true);
});

async function registered(alg: "ed25519" | "p256" = "ed25519") {
  const ctx = setup();
  const key = await testNameKey(alg);
  const quote = reserveOk(ctx.registry, "s1", "Nadia", key.keyHash);
  ctx.registry.processNotes([payment(quote.memo)]);
  ctx.registry.takeUpdates();
  return { ...ctx, key };
}

test("claim: a good Ed25519 proof returns the record and remembers the public key", async () => {
  const { registry, key } = await registered();
  const nonce = registry.issueChallenge("s7", "nadia")!;
  assert.match(nonce, /^[0-9a-f]{32}$/);
  const record = await registry.verifyClaim("s7", await key.proof(nonce, "nadia"));
  assert.equal(record?.displayName, "Nadia");
  assert.equal(registry.record("nadia")?.publicKey, key.publicKey);
  assert.equal(registry.record("nadia")?.alg, "ed25519");
});

test("claim: a good P-256 proof works too", async () => {
  const { registry, key } = await registered("p256");
  const nonce = registry.issueChallenge("s7", "Nadia")!;
  assert.equal((await registry.verifyClaim("s7", await key.proof(nonce, "Nadia")))?.displayName, "Nadia");
});

test("claim: a bad signature, another key, another name and another session all fail", async () => {
  const { registry, key } = await registered();
  const other = await testNameKey();
  let nonce = registry.issueChallenge("s7", "Nadia")!;
  const proof = await key.proof(nonce, "Nadia");
  assert.equal(await registry.verifyClaim("s7", { ...proof, signature: await key.sign("something else") }), null);
  nonce = registry.issueChallenge("s7", "Nadia")!;
  assert.equal(await registry.verifyClaim("s7", await other.proof(nonce, "Nadia")), null, "a key that does not hash to the record");
  nonce = registry.issueChallenge("s7", "Nadia")!;
  assert.equal(await registry.verifyClaim("s8", await key.proof(nonce, "Nadia")), null, "the nonce belongs to s7");
  nonce = registry.issueChallenge("s7", "Ada")!;
  assert.equal(await registry.verifyClaim("s7", await key.proof(nonce, "Ada")), null, "not registered");
});

test("claim: a nonce is single use (a replayed proof fails) and expires after 2 minutes", async () => {
  const { registry, key, advance } = await registered();
  const nonce = registry.issueChallenge("s7", "Nadia")!;
  const proof = await key.proof(nonce, "Nadia");
  assert.ok(await registry.verifyClaim("s7", proof));
  assert.equal(await registry.verifyClaim("s7", proof), null, "replayed");
  const late = registry.issueChallenge("s7", "Nadia")!;
  advance(NAME_CHALLENGE_TTL_MS);
  assert.equal(await registry.verifyClaim("s7", await key.proof(late, "Nadia")), null, "expired");
  // A failed proof consumes the challenge too: the right proof afterwards needs a new nonce.
  const fresh = registry.issueChallenge("s7", "Nadia")!;
  assert.equal(await registry.verifyClaim("s7", { ...(await key.proof(fresh, "Nadia")), signature: "A".repeat(86) }), null);
  assert.equal(await registry.verifyClaim("s7", await key.proof(fresh, "Nadia")), null);
});

test("claim: once a public key is remembered, a different key with a forged hash cannot take over", async () => {
  const { registry, key } = await registered();
  const n1 = registry.issueChallenge("s7", "Nadia")!;
  assert.ok(await registry.verifyClaim("s7", await key.proof(n1, "Nadia")));
  const p256 = await testNameKey("p256");
  const n2 = registry.issueChallenge("s7", "Nadia")!;
  assert.equal(await registry.verifyClaim("s7", await p256.proof(n2, "Nadia")), null);
});

test("a reservation replaced by the same key's newer request is retired: its session hears expired, and its late payment is consumed", () => {
  const { registry } = setup();
  const first = reserveOk(registry, "s1", "Nadia", KEY_A);
  registry.takeUpdates();
  reserveOk(registry, "s2", "Ada", KEY_A); // another tab with the same wallet asks for another name
  assert.deepEqual(registry.takeUpdates(), [{ kind: "status", sessionId: "s1", reservationId: first.reservationId, nickname: "Nadia", status: "expired" }]);
  registry.processNotes([payment(first.memo)]);
  assert.deepEqual(registry.takeUpdates().map((u) => (u.kind === "status" ? u.status : u.kind)), ["expired"]);
  assert.equal(registry.isRegistered("nadia"), false);
});

// ------------------------------------------------------------------ moderation: stored bans

/** A registered record as the store holds it (no claim yet), optionally banned. */
function storedName(displayName: string, keyHash: string, bannedUntil?: number) {
  return {
    nameKey: displayName.toLowerCase(),
    displayName,
    keyHash,
    publicKey: null,
    alg: null,
    avatar: null,
    createdAt: 1,
    lastSeen: 1,
    ...(bannedUntil !== undefined ? { bannedUntil } : {}),
  };
}

test("a stored ban on a key with many long names is labelled within MOD_NICKNAME_LABEL_MAX", () => {
  const names = ["A".repeat(23) + "1", "B".repeat(23) + "2", "C".repeat(23) + "3", "D".repeat(23) + "4", "E".repeat(23) + "5"];
  const store = new MemoryNameStore({ names: names.map((name) => storedName(name, KEY_A, 9_000_000)), usedNotes: [] });
  const { registry } = setup({ store });
  const [ban] = registry.activeBans();
  assert.ok(ban);
  assert.ok(ban.nickname.length <= MOD_NICKNAME_LABEL_MAX, `label length ${ban.nickname.length}`);
  assert.ok(ban.nickname.startsWith(names[0]!), "the first name is shown in full");
  assert.match(ban.nickname, / \+\d more$/, "the rest is counted");
  assert.equal(ban.until, 9_000_000);
  // Short lists stay as they were.
  assert.equal(banLabel(["Ann", "Bea"]), "Ann, Bea");
  assert.equal(banLabel(["Ann"]), "Ann");
  for (let n = 1; n <= 12; n++) assert.ok(banLabel(Array.from({ length: n }, (_, i) => `${"x".repeat(22)}${i.toString().padStart(2, "0")}`)).length <= MOD_NICKNAME_LABEL_MAX);
});

test("clearEndedBans drops a bannedUntil that ended (e.g. while the server was down) and saves the store", () => {
  const store = new MemoryNameStore({
    names: [storedName("Ended", KEY_A, 999_000), storedName("Running", KEY_B, 5_000_000)],
    usedNotes: [],
  });
  const { registry } = setup({ store });
  assert.deepEqual(
    registry.activeBans().map((ban) => ban.nickname),
    ["Running"],
  );
  const savesBefore = store.saves;
  assert.equal(registry.clearEndedBans(), true);
  assert.equal(store.saves, savesBefore + 1);
  const saved = store.load().names;
  assert.equal(saved.find((record) => record.displayName === "Ended")!.bannedUntil, undefined, "the ended ban is gone from the store");
  assert.equal(saved.find((record) => record.displayName === "Running")!.bannedUntil, 5_000_000, "a running one stays");
  assert.equal(registry.clearEndedBans(), false, "nothing more to clear (no save)");
  assert.equal(store.saves, savesBefore + 1);
});
