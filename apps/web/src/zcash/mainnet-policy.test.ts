import { test } from "node:test";
import assert from "node:assert/strict";
import { CapExceededError, DEFAULT_MAINNET_CAP_ZAT, capForNetwork, capProblem, formatZatBig, parseZecAmount } from "./txCap.ts";
import { SENDING_PAUSED, engineErrorCode, isSendingPaused, walletErrorMessage } from "./engineErrors.ts";
import { MAINNET_CONSENT_KEY, giveMainnetConsent, hasMainnetConsent, resetMainnetConsentForTests } from "./mainnetConsent.ts";
import { buildBackupQuiz, checkBackupQuiz } from "./backupQuiz.ts";
import { faucetPlan, walletChain } from "./testChain.ts";

/** ADR-018 § 1, § 4: the cap, the error wording, the consent state, the backup check, the network config. */

test("cap: 0.01 ZEC on main by default; `off` removes it; a bad value keeps the default; the test chain has none", () => {
  assert.equal(capForNetwork("main", undefined), DEFAULT_MAINNET_CAP_ZAT);
  assert.equal(capForNetwork("main", ""), 1_000_000n);
  assert.equal(capForNetwork("main", "0.005"), 500_000n);
  assert.equal(capForNetwork("main", "OFF"), null);
  assert.equal(capForNetwork("main", "lots"), DEFAULT_MAINNET_CAP_ZAT, "fail safe");
  assert.equal(capForNetwork("test", "0.005"), null);
});

test("cap: applies to the recipient amount of a payment, a withdrawal and the name fee — shielding is exempt", () => {
  const cap = 1_000_000n;
  assert.equal(capProblem(1_000_000n, "payment", cap), null, "exactly the cap is fine");
  assert.ok(capProblem(1_000_001n, "payment", cap) instanceof CapExceededError);
  assert.ok(capProblem(2_000_000n, "withdrawal", cap) instanceof CapExceededError);
  assert.ok(capProblem(2_000_000n, "name_fee", cap) instanceof CapExceededError);
  assert.equal(capProblem(50_000_000n, "shield", cap), null, "shielding one's own funds is exempt");
  assert.equal(capProblem(50_000_000n, "payment", null), null);
  const error = capProblem(2_000_000n, "payment", cap)!;
  assert.equal(error.code, "over_cap");
  assert.match(error.message, /^over_cap: the beta limit is 0\.01 ZEC per transaction$/);
});

test("amounts: exact decimal parsing and formatting", () => {
  assert.equal(parseZecAmount("0.00075"), 75_000n);
  assert.equal(parseZecAmount(" 0.01 "), 1_000_000n);
  assert.equal(parseZecAmount("0"), null);
  assert.equal(parseZecAmount("0.123456789"), null);
  assert.equal(parseZecAmount("1e-3"), null);
  assert.equal(formatZatBig(75_000n), "0.00075");
  assert.equal(formatZatBig(100_000_000n), "1");
  assert.equal(formatZatBig(1_015_000n), "0.01015");
});

test("engine errors become plain sentences (never the engine's raw text, which can carry addresses)", () => {
  const coded = (code: string) => Object.assign(new Error(`${code}: output 0: u1secretaddress…`), { code });
  // Retired in Stage 2 (an Orchard-only u1 is payable), still mapped to a sentence.
  assert.match(walletErrorMessage(coded("recipient_no_sapling_receiver")), /can't pay that address/);
  assert.match(walletErrorMessage(coded("recipient_unsupported")), /not supported/);
  assert.equal(walletErrorMessage(coded("consensus_branch_mismatch")), SENDING_PAUSED);
  assert.equal(walletErrorMessage(coded("consensus_upgrade_pending")), SENDING_PAUSED);
  assert.match(SENDING_PAUSED, /paused until the game updates for the network upgrade — your balance is safe/);
  assert.match(walletErrorMessage(coded("insufficient_funds")), /Not enough shielded ZEC/);
  assert.match(walletErrorMessage(coded("insufficient_funds"), { transparentWaiting: true }), /shielded first/);
  assert.match(walletErrorMessage(coded("broadcast_failed")), /about 50 minutes/);
  assert.equal(walletErrorMessage(new CapExceededError(1_000_000n, "ZEC")), "The beta limit is 0.01 ZEC per transaction.");
  for (const code of ["recipient_no_sapling_receiver", "insufficient_funds", "broadcast_failed"]) assert.equal(walletErrorMessage(coded(code)).includes("u1secret"), false);
  assert.equal(walletErrorMessage(new Error("something odd with u1secretaddress")).includes("u1secret"), false);
  assert.equal(engineErrorCode(new Error("nothing_to_shield: no confirmed transparent funds")), "nothing_to_shield");
  assert.equal(engineErrorCode(new Error("plain failure")), null);
  assert.ok(isSendingPaused(coded("consensus_upgrade_pending")));
  assert.ok(!isSendingPaused(coded("insufficient_funds")));
});

test("consent: per device, remembered in storage; a storage failure keeps it for this page only", () => {
  const memory = new Map<string, string>();
  const store = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) };
  resetMainnetConsentForTests(store);
  assert.equal(hasMainnetConsent(store), false);
  giveMainnetConsent(store, 1_000);
  assert.equal(hasMainnetConsent(store), true);
  assert.deepEqual(JSON.parse(memory.get(MAINNET_CONSENT_KEY)!), { v: 1, at: 1_000 });
  resetMainnetConsentForTests(store);
  memory.set(MAINNET_CONSENT_KEY, JSON.stringify({ v: 0 }));
  assert.equal(hasMainnetConsent(store), false, "an older wording asks again");
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
  resetMainnetConsentForTests(broken);
  assert.equal(hasMainnetConsent(broken), false);
  giveMainnetConsent(broken);
  assert.equal(hasMainnetConsent(broken), true, "this page remembers it");
  resetMainnetConsentForTests(store);
});

test("backup check: three positions, four distinct options from the phrase, one right; all three must be right", () => {
  const words = Array.from({ length: 24 }, (_, i) => `word${i + 1}`);
  let seed = 7;
  const random = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const quiz = buildBackupQuiz(words, random);
  assert.equal(quiz.length, 3);
  assert.deepEqual([...quiz.map((q) => q.index)].sort((a, b) => a - b), quiz.map((q) => q.index), "in phrase order");
  for (const question of quiz) {
    assert.equal(question.options.length, 4);
    assert.equal(new Set(question.options).size, 4);
    assert.ok(question.options.includes(words[question.index]!));
    for (const option of question.options) assert.ok(words.includes(option), "decoys come from the phrase itself");
  }
  const right = quiz.map((q) => words[q.index]!);
  assert.equal(checkBackupQuiz(words, quiz, right), true);
  assert.equal(checkBackupQuiz(words, quiz, [right[0]!, right[1]!, null]), false);
  assert.equal(checkBackupQuiz(words, quiz, [right[0]!, right[1]!, quiz[2]!.options.find((o) => o !== right[2])!]), false);
});

test("network config: mainnet wallets get no faucet of any kind", () => {
  assert.equal(walletChain("main"), "mainnet");
  const plan = faucetPlan("mainnet", { available: true });
  assert.equal(plan.show, false);
  assert.deepEqual(plan.publicFaucets, []);
});
