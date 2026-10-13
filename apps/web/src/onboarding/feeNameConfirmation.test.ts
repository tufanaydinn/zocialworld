import { test } from "node:test";
import assert from "node:assert/strict";
import { mnemonicToSeedSync } from "@scure/bip39";
import { NAME_DEV_ADDRESS, buildNameMemo, nameClaimMessage, parseNameMemo, type NameQuoteMessage } from "@project/shared";
import { FeeNameConfirmation, formatZat, quoteProblem, type FeeNameDeps } from "./feeNameConfirmation.ts";
import { NameConfirmationError, type NameConfirmationStatus } from "./nameConfirmation.ts";
import { deriveNameKey, type NameKey } from "../zcash/nameKey.ts";

/**
 * ADR-016: the client's confirmation state machine against a scripted server — quote → pay → pending
 * → seen → confirmed; taken → claim; insufficient → faucet → retry without paying twice; expired; timeout; quote
 * checks; the dev placeholder is never paid; and the memo builder/parser shared with the server.
 */

const FEE = 1_000_000;
const ADDRESS = "uregtest1" + "q".repeat(100);
const RESERVATION = "R".repeat(22);
const NONCE = "0123456789abcdef0123456789abcdef";

let key: NameKey;
const ready = deriveNameKey(mnemonicToSeedSync("abandon ".repeat(23) + "art"), "test").then((k) => (key = k));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(overrides: Partial<FeeNameDeps> = {}, wallet: { spendable?: () => number | null; fail?: Error } = {}) {
  const sent: { type: string; [key: string]: unknown }[] = [];
  const payments: { address: string; amount: string; memo: string }[] = [];
  let open = true;
  const store = new Map<string, string>();
  const deps: FeeNameDeps = {
    network: {
      reserve: (nickname, keyHash) => sent.push({ type: "name_reserve", nickname, keyHash }),
      claimRequest: (nickname) => sent.push({ type: "name_claim_request", nickname }),
      claimProof: (proof) => sent.push({ type: "name_claim_proof", ...proof }),
      isOpen: () => open,
    },
    nameKey: () => key,
    subscribeNameKey: () => () => undefined,
    wallet: {
      spendableZat: () => (wallet.spendable ? wallet.spendable() : 5 * FEE),
      sendShielded: async (address, amount, memo) => {
        if (wallet.fail) throw wallet.fail;
        payments.push({ address, amount, memo });
        return "f".repeat(64);
      },
    },
    feeZat: FEE,
    paidStore: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    replyTimeoutMs: 200,
    confirmTimeoutMs: 400,
    ...overrides,
  };
  const flow = new FeeNameConfirmation(deps);
  const statuses: NameConfirmationStatus[] = [];
  const quote = (over: Partial<NameQuoteMessage> = {}): NameQuoteMessage => ({
    type: "name_quote",
    reservationId: RESERVATION,
    nickname: "Alice",
    address: ADDRESS,
    amountZat: FEE,
    memo: buildNameMemo(NONCE, key.keyHash),
    expiresAt: Date.now() + 1_800_000,
    ...over,
  });
  const status = (value: string, reservationId: string | null = RESERVATION, nickname = "Alice") =>
    flow.handle({ type: "name_status", status: value as never, ...(reservationId ? { reservationId } : {}), nickname });
  return { flow, deps, sent, payments, statuses, onStatus: (s: NameConfirmationStatus) => statuses.push(s), quote, status, setOpen: (value: boolean) => (open = value), store };
}

test("memo builder and parser (shared with the server): zw-name:v1:<nonce>:<16 hex of the key hash>, ZIP 302 padding tolerated", async () => {
  await ready;
  const memo = buildNameMemo(NONCE, key.keyHash);
  assert.equal(memo, `zw-name:v1:${NONCE}:${key.keyHash.slice(0, 16)}`);
  assert.ok(Buffer.byteLength(memo) <= 512);
  assert.deepEqual(parseNameMemo(memo + "\u0000\u0000"), { nonce: NONCE, keyHashPrefix: key.keyHash.slice(0, 16) });
  assert.equal(parseNameMemo("zw-name:v1:short:abc"), null);
  assert.equal(parseNameMemo(`zw-name:v2:${NONCE}:${key.keyHash.slice(0, 16)}`), null);
  assert.equal(parseNameMemo(`${memo}:extra`), null);
  assert.equal(formatZat(FEE), "0.01");
  assert.equal(formatZat(1_015_000), "0.01015");
  assert.equal(formatZat(100_000_000), "1");
});

test("the happy path: reserve → pay the quote (address, 0.01, memo) → pending → seen → confirmed", async () => {
  await ready;
  const h = harness();
  assert.equal(h.flow.feeText, "Confirm with a small fee: 0.01 TAZ + network fee");
  const done = h.flow.confirm("Alice", h.onStatus);
  assert.deepEqual(h.sent, [{ type: "name_reserve", nickname: "Alice", keyHash: key.keyHash }]);
  h.flow.handle(h.quote());
  h.status("pending");
  await tick();
  assert.deepEqual(h.payments, [{ address: ADDRESS, amount: "0.01", memo: buildNameMemo(NONCE, key.keyHash) }]);
  assert.equal(h.statuses.at(-1)?.phase === "working" && h.statuses.at(-1)?.phase === "working" ? (h.statuses.at(-1) as { step?: string }).step : null, "pending");
  h.status("seen");
  assert.equal((h.statuses.at(-1) as { step?: string }).step, "seen");
  h.status("confirmed");
  await done;
  assert.deepEqual(
    h.statuses.map((s) => (s.phase === "working" ? s.step : s.phase)),
    ["reserving", "paying", "pending", "seen", "done"],
  );
});

test("taken → a claim with the name key (it may be ours) → confirmed without paying", async () => {
  await ready;
  const h = harness();
  const done = h.flow.confirm("Alice", h.onStatus);
  h.status("taken", null);
  await tick();
  assert.equal(h.sent.at(-1)?.type, "name_claim_request");
  h.flow.handle({ type: "name_challenge", nonce: NONCE, nickname: "Alice" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const proof = h.sent.at(-1)!;
  assert.equal(proof.type, "name_claim_proof");
  assert.equal(proof.publicKey, key.publicKey);
  assert.equal(proof.alg, key.alg);
  const raw = Buffer.from(key.publicKey, "base64url");
  const imported = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  assert.ok(await crypto.subtle.verify({ name: "Ed25519" }, imported, Buffer.from(String(proof.signature), "base64url"), new TextEncoder().encode(nameClaimMessage(NONCE, "Alice"))));
  h.status("confirmed", null, "Alice");
  await done;
  assert.deepEqual(h.payments, []);
  assert.match((h.statuses.at(-1) as { text?: string }).text ?? "", /no fee/);
});

test("taken and not ours → rejects with taken", async () => {
  await ready;
  const h = harness();
  const done = h.flow.confirm("Alice", h.onStatus);
  h.status("taken", null);
  await tick();
  h.flow.handle({ type: "name_challenge", nonce: NONCE, nickname: "Alice" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  h.status("failed", null);
  await assert.rejects(done, (error: NameConfirmationError) => error.reason === "taken");
});

test("not enough coins → insufficient (faucet + retry); the retry pays the SAME reservation once", async () => {
  await ready;
  let spendable: number | null = 1000;
  const faucetCalls: (string | null)[] = [];
  const h = harness({ faucet: async (credential) => (faucetCalls.push(credential), "Sent 1 test coin.") }, { spendable: () => spendable });
  const first = h.flow.confirm("Alice", h.onStatus);
  h.flow.handle(h.quote());
  await assert.rejects(first, (error: NameConfirmationError) => error.reason === "insufficient" && error.faucet && error.retry);
  assert.deepEqual(h.payments, []);
  // The faucet before join: the pending reservation id is the credential (a joined session uses its capability).
  // "Get test coins": before join, the pending reservation proves the live connection to the faucet.
  assert.equal(await h.flow.getTestCoins(), "Sent 1 test coin.");
  assert.deepEqual(faucetCalls, [RESERVATION]);
  spendable = 3 * FEE; // the coins arrived
  const third = h.flow.confirm("Alice", h.onStatus);
  h.flow.handle(h.quote());
  h.status("pending");
  await tick();
  assert.equal(h.payments.length, 1);
  h.status("confirmed");
  await third;
  // Asking again for the same reservation (a reload, "Check again") never pays it twice.
  const again = new FeeNameConfirmation({ ...h.deps });
  const fourth = again.confirm("Alice");
  again.handle(h.quote());
  again.handle({ type: "name_status", status: "confirmed", reservationId: RESERVATION, nickname: "Alice" });
  await fourth;
  assert.equal(h.payments.length, 1, "remembered as paid in (session) storage");
});

test("a wallet error that says insufficient funds is reported as insufficient; other errors say nothing was paid", async () => {
  await ready;
  const poor = harness({}, { spendable: () => null, fail: new Error("Insufficient balance (have 0, need 1010000)") });
  const a = poor.flow.confirm("Alice");
  poor.flow.handle(poor.quote());
  await assert.rejects(a, (error: NameConfirmationError) => error.reason === "insufficient" && error.faucet);
  const broken = harness({}, { fail: new Error("proving failed") });
  const b = broken.flow.confirm("Alice");
  broken.flow.handle(broken.quote());
  await assert.rejects(b, (error: NameConfirmationError) => error.reason === "wallet" && /nothing was paid/.test(error.message));
});

test("expired → rejects with retry; no confirmation in time → timeout with retry (no second payment on retry)", async () => {
  await ready;
  const h = harness();
  const expired = h.flow.confirm("Alice");
  h.flow.handle(h.quote());
  await tick();
  h.status("expired");
  await assert.rejects(expired, (error: NameConfirmationError) => error.reason === "expired" && error.retry);
  const other = harness();
  const slow = other.flow.confirm("Alice");
  other.flow.handle(other.quote({ reservationId: "S".repeat(22) }));
  await assert.rejects(slow, (error: NameConfirmationError) => error.reason === "timeout" && error.retry);
  assert.equal(other.payments.length, 1);
});

test("refusals: invalid, disabled, rate_limited; no answer → offline; no name key → wallet", async () => {
  await ready;
  for (const status of ["invalid", "disabled", "rate_limited"]) {
    const h = harness();
    const run = h.flow.confirm("Alice");
    h.status(status, null);
    await assert.rejects(run, (error: NameConfirmationError) => error.reason === status);
  }
  const silent = harness();
  await assert.rejects(silent.flow.confirm("Alice"), (error: NameConfirmationError) => error.reason === "offline");
  const locked = harness({ nameKey: () => null });
  await assert.rejects(locked.flow.confirm("Alice"), (error: NameConfirmationError) => error.reason === "wallet");
});

test("quote checks: another key's memo, a different or excessive amount, a transparent address — nothing is paid", async () => {
  await ready;
  assert.equal(quoteProblem({ type: "name_quote", reservationId: RESERVATION, nickname: "T", address: ADDRESS, amountZat: FEE, memo: buildNameMemo(NONCE, key.keyHash), expiresAt: 0 }, key.keyHash, FEE), null);
  assert.equal(quoteProblem({ type: "name_quote", reservationId: RESERVATION, nickname: "T", address: ADDRESS, amountZat: FEE, memo: buildNameMemo(NONCE, "b".repeat(64)), expiresAt: 0 }, key.keyHash, FEE), "memo");
  assert.equal(quoteProblem({ type: "name_quote", reservationId: RESERVATION, nickname: "T", address: ADDRESS, amountZat: 2 * FEE, memo: buildNameMemo(NONCE, key.keyHash), expiresAt: 0 }, key.keyHash, FEE), "amount");
  assert.equal(quoteProblem({ type: "name_quote", reservationId: RESERVATION, nickname: "T", address: ADDRESS, amountZat: 50_000_000, memo: buildNameMemo(NONCE, key.keyHash), expiresAt: 0 }, key.keyHash, 0), "amount");
  assert.equal(quoteProblem({ type: "name_quote", reservationId: RESERVATION, nickname: "T", address: "tmXYZ" + "a".repeat(30), amountZat: FEE, memo: buildNameMemo(NONCE, key.keyHash), expiresAt: 0 }, key.keyHash, FEE), "address");
  assert.equal(quoteProblem({ type: "name_quote", reservationId: RESERVATION, nickname: "T", address: "u1" + "a".repeat(80), amountZat: FEE, memo: buildNameMemo(NONCE, key.keyHash), expiresAt: 0 }, key.keyHash, FEE), "address", "mainnet");
  // ADR-018 § 5: a mainnet build pays only a mainnet Sapling-capable registry, never the dev placeholder or a test-chain address.
  const quoteTo = (address: string) => ({ type: "name_quote" as const, reservationId: RESERVATION, nickname: "T", address, amountZat: 75_000, memo: buildNameMemo(NONCE, key.keyHash), expiresAt: 0 });
  assert.equal(quoteProblem(quoteTo("u1" + "a".repeat(80)), key.keyHash, 75_000, "main"), null);
  assert.equal(quoteProblem(quoteTo("zs1" + "a".repeat(75)), key.keyHash, 75_000, "main"), null);
  assert.equal(quoteProblem(quoteTo(ADDRESS), key.keyHash, 75_000, "main"), "address", "a test-chain address on mainnet");
  assert.equal(quoteProblem(quoteTo("zw-dev-registry"), key.keyHash, 75_000, "main"), "address", "the dev placeholder is never accepted on mainnet");
  assert.equal(quoteProblem(quoteTo("t1" + "a".repeat(33)), key.keyHash, 75_000, "main"), "address");
  const h = harness();
  const run = h.flow.confirm("Alice");
  h.flow.handle(h.quote({ memo: buildNameMemo(NONCE, "c".repeat(64)) }));
  await assert.rejects(run, /nothing was paid/);
  assert.deepEqual(h.payments, []);
});

test("the dev registry's placeholder address is never paid: the flow waits for the server's own confirmation", async () => {
  await ready;
  const h = harness();
  const run = h.flow.confirm("Alice", h.onStatus);
  h.flow.handle(h.quote({ address: NAME_DEV_ADDRESS }));
  h.status("pending");
  await tick();
  h.status("seen");
  h.status("confirmed");
  await run;
  assert.deepEqual(h.payments, []);
});

test("the same name again while confirming follows the running flow; another name is refused (busy)", async () => {
  await ready;
  const h = harness();
  const first = h.flow.confirm("Alice");
  const same = h.flow.confirm("alice");
  assert.equal(same, first);
  await assert.rejects(h.flow.confirm("Ada"), (error: NameConfirmationError) => error.reason === "busy");
  h.flow.handle(h.quote());
  await tick();
  h.status("confirmed");
  await first;
});

test("claim (a returning player): challenge → signed proof → confirmed, never a payment; failure resolves false", async () => {
  await ready;
  const h = harness();
  const ok = h.flow.claim("Alice", h.onStatus);
  await tick();
  h.flow.handle({ type: "name_challenge", nonce: NONCE, nickname: "Alice" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  h.status("confirmed", null, "Alice");
  assert.equal(await ok, true);
  const no = h.flow.claim("Ada");
  await tick();
  h.flow.handle({ type: "name_challenge", nonce: NONCE, nickname: "Ada" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  h.status("failed", null, "Ada");
  assert.equal(await no, false);
  assert.equal(h.sent.some((m) => m.type === "name_reserve"), false);
  assert.deepEqual(h.payments, []);
});

test("a reconnect while waiting re-binds the reservation (no second payment); confirmed meanwhile → taken → claim → done", async () => {
  await ready;
  const h = harness();
  const run = h.flow.confirm("Alice", h.onStatus);
  h.flow.handle(h.quote());
  h.status("pending");
  await tick();
  assert.equal(h.payments.length, 1);
  // The socket reconnects: the reservation's updates now go to a dead session, so ask again with the same key.
  h.flow.resume();
  assert.deepEqual(h.sent.at(-1), { type: "name_reserve", nickname: "Alice", keyHash: key.keyHash });
  // It was confirmed while we were away: registered now, so "taken" — and the claim proves it is ours.
  h.status("taken", null);
  await tick();
  assert.equal(h.sent.at(-1)?.type, "name_claim_request");
  h.flow.handle({ type: "name_challenge", nonce: NONCE, nickname: "Alice" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  h.status("confirmed", null, "Alice");
  await run;
  assert.equal(h.payments.length, 1, "never paid twice");
});

test("the mainnet fee text shows the operator's fiat label only when the server publishes one", () => {
  const plain = harness({ chain: "main", feeZat: 75_000 });
  assert.equal(plain.flow.feeText, "Confirm with a small fee: 0.00075 ZEC + network fee");
  const labelled = harness({ chain: "main", feeZat: 75_000, feeUsd: 1 });
  assert.equal(labelled.flow.feeText, "Confirm with a small fee: 0.00075 ZEC (≈ US$1) + network fee");
  const test = harness({ feeUsd: 1 });
  assert.equal(test.flow.feeText, "Confirm with a small fee: 0.01 TAZ + network fee", "test coins never get a fiat label");
});
