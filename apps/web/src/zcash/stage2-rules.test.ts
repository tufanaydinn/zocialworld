import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { TEX_SECOND_REFUSED, TEX_SECOND_UNCERTAIN, isBroadcastPhaseError, laterTransactionOfPairFailed, walletErrorMessage } from "./engineErrors.ts";
import { isTexOfTransparent, texPubKeyHash, transparentPubKeyHash } from "./texAddress.ts";
import { SAPLING_CROSSING_WITHDRAW_NOTE, saplingCrossingPaymentNote, saplingOutputCrossesPools } from "./poolCrossing.ts";

/**
 * Stage 2 money and privacy rules on the client side:
 *  - a TEX withdrawal whose SECOND transaction fails after the first left is never "nothing was sent";
 *  - the own-address guard knows the TEX form of the wallet's own t-address;
 *  - "Unlock and upgrade" still shows a wrong passphrase;
 *  - a Sapling output funded from Ironwood makes the amount public — the withdraw Review and the payment confirmation
 *    say so (and the payment card does not say "never the amount").
 * (The address cache before the migration rescan is in stage2.test.ts with the migration tests.)
 */

/** Test TEX addresses of a regtest-only key (never funded), one per network. Only their encodings matter here. */
const ADDRESSES: Record<"main" | "test" | "regtest", { tex: string }> = {
  main: { tex: "tex1qsxle9gn7xt26cmzqvs0xaj6mpdc6a6cnw4jse" },
  test: { tex: "textest1ptc8z4ca3x2t2cnl97a3as9vaj4hfru5cqzdh0" },
  regtest: { tex: "texregtest1ptc8z4ca3x2t2cnl97a3as9vaj4hfru5jkjncm" },
};
/** The t-addresses with the same P2PKH hash as the TEX addresses above (computed independently: base58check). */
const T_OF_MAIN_TEX = "t1JF3TusSHbQytgXaDjWFHHWLpHVRmB69Sp";
const T_OF_TEST_TEX = "tmAiC8LufC7d1jM7nwQnS1BeY2u5paLtaCB";
const TXID = "ab".repeat(32);

describe("the second transaction of a TEX pair failed after the first left", () => {
  const failed2 = new Error(`broadcast_failed: [txid=${TXID}] the network rejected the transaction (code 18): bad-txns-inputs-missingorspent (transaction 2 of 2; transaction 1 ${"cd".repeat(32)} was sent)`);
  const uncertain2 = new Error(`broadcast_uncertain: [txid=${TXID}] the transaction was built but the network's answer to sending it was lost (gRPC status Unavailable (transaction 2 of 2; transaction 1 ${"cd".repeat(32)} was sent)); it may have been sent - check the wallet history before trying again`);
  const failed1 = new Error(`broadcast_failed: [txid=${TXID}] the network rejected the transaction (code 16): bad-txns (transaction 1 of 2)`);
  const single = new Error(`broadcast_failed: [txid=${TXID}] the network rejected the transaction (code 16): bad-txns`);

  it("is recognised from the engine's marker (and only for transaction 2 or later)", () => {
    assert.equal(laterTransactionOfPairFailed(failed2), true);
    assert.equal(laterTransactionOfPairFailed(uncertain2), true);
    assert.equal(laterTransactionOfPairFailed(failed1), false);
    assert.equal(laterTransactionOfPairFailed(single), false);
    assert.equal(laterTransactionOfPairFailed(Object.assign(new Error("insufficient_funds: (transaction 2 of 2; x)"), { code: "insufficient_funds" })), false, "only broadcast errors");
    assert.equal(isBroadcastPhaseError(failed2), true, "the withdraw form is cleared (no immediate resend)");
  });

  it("never says 'nothing was sent': where the ZEC is, not to withdraw again, and how Shield brings it back", () => {
    for (const [error, expected] of [[failed2, TEX_SECOND_REFUSED], [uncertain2, TEX_SECOND_UNCERTAIN]] as const) {
      const text = walletErrorMessage(error, { context: "withdrawal" });
      assert.equal(text, expected);
      assert.doesNotMatch(text, /nothing was sent/i);
      assert.match(text, /first of the two TEX transactions was sent/);
      assert.match(text, /one-time transparent address of this wallet/);
      assert.match(text, /don't withdraw again/i);
      assert.match(text, /Waiting to be shielded/);
      assert.match(text, /Shield/);
      assert.doesNotMatch(text, new RegExp(TXID), "never repeats a txid");
    }
  });

  it("a failure of the FIRST transaction (or a single one) keeps the plain 'nothing was sent' sentence", () => {
    assert.match(walletErrorMessage(failed1, { context: "withdrawal" }), /nothing was sent/i);
    assert.match(walletErrorMessage(single, { context: "withdrawal" }), /nothing was sent/i);
  });
});

describe("the TEX form of the wallet's own t-address", () => {
  it("decodes a TEX's P2PKH hash and a t-address's hash (independently computed pairs)", () => {
    const tex = texPubKeyHash(ADDRESSES.main.tex);
    const t = transparentPubKeyHash(T_OF_MAIN_TEX);
    assert.ok(tex && t);
    assert.equal(Buffer.from(tex).toString("hex"), "040dfc9513f196ad63620320f3765ad85b8d7758");
    assert.deepEqual(t, tex);
    assert.equal(isTexOfTransparent(ADDRESSES.main.tex, T_OF_MAIN_TEX), true);
    assert.equal(isTexOfTransparent(ADDRESSES.test.tex, T_OF_TEST_TEX), true, "testnet tm…");
    assert.equal(isTexOfTransparent(ADDRESSES.regtest.tex, T_OF_TEST_TEX), true, "regtest uses the testnet t-prefix");
    assert.equal(isTexOfTransparent(ADDRESSES.main.tex, "t1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU"), false, "another t-address");
    assert.equal(transparentPubKeyHash("t3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd"), null, "P2SH is not a P2PKH hash");
    assert.equal(transparentPubKeyHash("not base58 0OIl"), null);
    assert.equal(texPubKeyHash(ADDRESSES.main.tex.slice(0, -1)), null, "a broken TEX");
  });

  it("the withdraw guard refuses the TEX form of the own t-address; another TEX still passes", async () => {
    const { isOwnWithdrawAddress } = await import("./WalletPanel.ts");
    const own = { unified: "u1own", unifiedShielded: "u1ownshielded", unifiedSaplingTransparent: "u1ownst", sapling: "zs1own", transparent: T_OF_MAIN_TEX };
    assert.equal(isOwnWithdrawAddress(own, [ADDRESSES.main.tex, null]), true, "typed");
    assert.equal(isOwnWithdrawAddress(own, ["typed something", ADDRESSES.main.tex]), true, "as the engine resolved it");
    assert.equal(isOwnWithdrawAddress(own, [ADDRESSES.main.tex.toUpperCase(), null]), true, "upper-case bech32");
    assert.equal(isOwnWithdrawAddress(own, [` ${T_OF_MAIN_TEX} `, null]), true, "the t-address itself");
    assert.equal(isOwnWithdrawAddress(own, ["U1OWN", null]), true, "the own UA, any case");
    const other = { ...own, transparent: "t1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU" };
    assert.equal(isOwnWithdrawAddress(other, [ADDRESSES.main.tex, ADDRESSES.main.tex]), false, "an exchange's TEX is fine");
  });
});

describe("'Unlock and upgrade' shows a wrong passphrase", () => {
  it("hides only the date question (the screen's own note replaces it)", async () => {
    const { unlockErrorText } = await import("./WalletPanel.ts");
    const dateQuestion = walletErrorMessage({ code: "migration_birthday_unknown" });
    assert.equal(unlockErrorText(dateQuestion, true), "");
    assert.equal(unlockErrorText("Wrong passphrase. Wallet data preserved.", true), "Wrong passphrase. Wallet data preserved.");
    assert.equal(unlockErrorText("Wrong passphrase. Wallet data preserved.", false), "Wrong passphrase. Wallet data preserved.");
    assert.equal(unlockErrorText(dateQuestion, false), dateQuestion, "without the picker the question is the message");
    assert.equal(unlockErrorText(null, true), "");
  });
});

describe("a Sapling output paid from Ironwood funds makes the amount public", () => {
  const pools = (saplingZec: number) => ({ ironwoodZec: 0.05, saplingZec, orchardZec: 0 });

  it("crosses pools when the Sapling funds don't cover it (or are unknown); never for Ironwood or transparent outputs", () => {
    assert.equal(saplingOutputCrossesPools("sapling", 520_000n, pools(0)), true, "all funds in Ironwood: the usual case");
    assert.equal(saplingOutputCrossesPools("sapling", 520_000n, pools(0.005)), true, "500,000 zat of Sapling do not cover 520,000");
    assert.equal(saplingOutputCrossesPools("sapling", 520_000n, pools(0.0052)), false, "Sapling notes cover it: no crossing for the amount");
    assert.equal(saplingOutputCrossesPools("sapling", 520_000n, undefined), true, "unknown → warn");
    assert.equal(saplingOutputCrossesPools("ironwood", 520_000n, pools(0)), false);
    assert.equal(saplingOutputCrossesPools("transparent", 520_000n, pools(0)), false, "the t1/TEX note covers that case");
    assert.equal(saplingOutputCrossesPools(null, 520_000n, pools(0)), false);
  });

  it("the notes say the amount becomes public and how to avoid it", () => {
    assert.match(SAPLING_CROSSING_WITHDRAW_NOTE, /amount becomes public/);
    assert.match(SAPLING_CROSSING_WITHDRAW_NOTE, /full unified address/);
    const note = saplingCrossingPaymentNote("bob");
    assert.match(note, /^bob's wallet gave a Sapling address/);
    assert.match(note, /amount becomes public/);
    assert.match(note, /game server can read it/);
  });

  it("the payment card drops 'never the amount' when the payment crosses pools", async () => {
    const { paymentPrivacyLine } = await import("./PaymentFlow.ts");
    assert.match(paymentPrivacyLine(true, false), /never the amount/);
    assert.match(paymentPrivacyLine(false, false), /never sees the amount/);
    for (const withFee of [true, false]) {
      const line = paymentPrivacyLine(withFee, true);
      assert.doesNotMatch(line, /never (sees )?the amount/);
      assert.match(line, /amount/);
    }
  });
});
