import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { PaymentFlow as PaymentFlowType } from "./PaymentFlow.ts";
import type { WalletPanel as WalletPanelType } from "./WalletPanel.ts";

/**
 * Mainnet wallet and payment rules, client side, on a MAINNET build (jsdom, a stubbed mainnet engine with the Stage 2
 * API, two PaymentFlows wired through a fake relay):
 *  - the recipient seals its shielded-only unified address (an older client: its zs1…), never the full u1 carrying its
 *    exchange receiver;
 *  - Cancel while waiting, a bad acceptance and a fee-less acceptance (when the server advertises a fee) all send
 *    `pay_cancel`; the recipient's card closes on the relayed cancel; "X left";
 *  - an accepted card expires (cancelled) before the server's fee deadline;
 *  - a lost broadcast answer reports the txid (`pay_sent`), tells the recipient it may arrive, offers no retry;
 *  - Withdraw sends exactly what was reviewed (an edit drops the confirmation) and refuses a player's address;
 *  - closing the wallet panel leaves no seed words (backup view, backup quiz) in the DOM;
 *  - a new wallet's "I wrote the words down" tick survives the re-render of its first sync;
 *  - pure helpers: engine error txids, the address check, the withdraw request comparison.
 */

process.env.VITE_ZCASH_NETWORK = "main";

const UNIFIED = "u1" + "w".repeat(100);
const SAPLING = "zs1" + "s".repeat(75);
/** The shielded-only unified address (Orchard-family + Sapling) a recipient seals. */
const SHIELDED_UA = "u1" + "h".repeat(100);
const TRANSPARENT = "t1" + "T".repeat(33);
const TXID = "5e".repeat(32);
const LOST_TXID = "ef".repeat(32);

const globals = ["window", "document", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "KeyboardEvent", "Event", "Node", "navigator"] as const;
const saved: Partial<Record<(typeof globals)[number], unknown>> = {};
let dom: JSDOM;
let PaymentFlow: typeof PaymentFlowType;
let WalletPanel: typeof WalletPanelType;
let adapterMod: typeof import("./ZcashWalletAdapter.ts");
let walletMod: typeof import("./core/wallet.ts");
let engine: { sends: { to: string; amountZat: string; memo?: string; withdrawal?: boolean }[][]; sendError: Error | null; previewError: Error | null };

if (typeof localStorage === "undefined") {
  const store: Record<string, string> = {};
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => void (store[key] = value),
    removeItem: (key: string) => void delete store[key],
    clear: () => {
      for (const key in store) delete store[key];
    },
  };
}

before(async () => {
  dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
  for (const key of globals) {
    saved[key] = (globalThis as Record<string, unknown>)[key];
    Object.defineProperty(globalThis, key, { value: key === "window" ? dom.window : (dom.window as unknown as Record<string, unknown>)[key], configurable: true, writable: true });
  }
  (dom.window.document as unknown as { exitPointerLock: () => void }).exitPointerLock = () => undefined;
  walletMod = await import("./core/wallet.ts");
  adapterMod = await import("./ZcashWalletAdapter.ts");
  ({ PaymentFlow } = await import("./PaymentFlow.ts"));
  ({ WalletPanel } = await import("./WalletPanel.ts"));
  engine = { sends: [], sendError: null, previewError: null };
  walletMod.__testSeam.walletFactory = async () =>
    ({
      accountId: 0,
      createdWithBirthday: 3_510_000,
      address: async () => UNIFIED,
      transparentAddress: async () => TRANSPARENT,
      exportDb: async () => new Uint8Array([1]),
      sync: async () => undefined,
      balances: async () => ({ totalZec: 0.005, pendingZec: 0, transparentZec: 0, shieldableZec: 0, chainTipHeight: 3_510_438, fullyScannedHeight: 3_510_438, raw: null }),
      sendWithMemo: async () => TXID,
      send: async () => TXID,
      shield: async () => true,
      tip: async () => 3_510_438,
      getTransactionHistory: async () => ({ transactions: [] }),
      mainnetEngine: {
        addresses: async () => ({ unified: UNIFIED, unifiedShielded: SHIELDED_UA, unifiedSaplingTransparent: "u1" + "z".repeat(100), sapling: SAPLING, transparent: TRANSPARENT }),
        sendingStatus: async () => ({ allowed: true, expectedBranch: "37a5165b", chainBranch: "37a5165b", code: null, reason: null, pendingUpgrade: null }),
        previewSend: async (outputs: { to: string }[]) => {
          if (engine.previewError) throw engine.previewError;
          return { txids: [], feeZat: 15_000, amountZat: 0, outputs: outputs.map((o) => ({ to: o.to, pool: o.to.startsWith("t1") ? "transparent" : o.to.startsWith("u1") ? "ironwood" : "sapling", amountZat: 0, hasMemo: false, tex: false })) };
        },
        send: async (outputs: { to: string; amountZat: string }[]) => {
          engine.sends.push(outputs);
          if (engine.sendError) throw engine.sendError;
          return { txids: [TXID], feeZat: 15_000, amountZat: 0, outputs: [] };
        },
        previewShield: async () => ({ txid: "", utxos: 0, transparentInZat: 0, feeZat: 0, shieldedZat: 0 }),
        shield: async () => ({ txid: TXID, utxos: 0, transparentInZat: 0, feeZat: 0, shieldedZat: 0 }),
      },
    }) as never;
  await adapterMod.ZcashWalletAdapter.clearAllData();
  await adapterMod.ZcashWalletAdapter.createWallet("a passphrase of length");
  adapterMod.ZcashWalletAdapter.confirmBackup();
  await adapterMod.ZcashWalletAdapter.sync();
});

after(() => {
  walletMod.__testSeam.walletFactory = null;
  for (const key of globals) Object.defineProperty(globalThis, key, { value: saved[key], configurable: true, writable: true });
  dom.window.close();
});

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (condition()) return;
    await tick(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function button(root: Element, label: string): HTMLButtonElement | null {
  return (Array.from(root.querySelectorAll("button")) as HTMLButtonElement[]).find((b) => b.textContent === label) ?? null;
}

type Sent = Record<string, unknown> & { type: string; requestId: string };

/** Two players on one fake relay: the server's routing of pay_* messages (fee quote added to the acceptance). */
function relay(options: { fee?: { address: string; zat: number; nonce: string } | null; advertisedFeeZat?: number | null; feeUsd?: number | null } = {}) {
  const sent: { from: "alice" | "bob"; message: Sent }[] = [];
  const containers = { alice: document.createElement("div"), bob: document.createElement("div") };
  document.body.append(containers.alice, containers.bob);
  let alice: PaymentFlowType;
  let bob: PaymentFlowType;
  const deliver = (from: "alice" | "bob", message: Sent): void => {
    sent.push({ from, message });
    const to = from === "alice" ? bob : alice;
    const fromId = from === "alice" ? "p-alice" : "p-bob";
    switch (message.type) {
      case "pay_request":
        return to.handle({ ...message, from: fromId, fromNickname: from === "alice" ? "Alice" : "Bob" } as never);
      case "pay_accept":
        return to.handle({ ...message, from: fromId, ...(options.fee ? { fee: options.fee } : {}) } as never);
      case "pay_notice":
        return to.handle({ ...message, from: fromId, fromNickname: from === "alice" ? "Alice" : "Bob" } as never);
      case "pay_cancel":
        return to.handle({ type: "pay_cancel", requestId: message.requestId, from: fromId });
      default:
        return; // pay_sent / pay_decline: the server's business
    }
  };
  const common = { openWallet: () => undefined, isBlocked: () => false, announce: () => undefined, advertisedFeeZat: () => options.advertisedFeeZat ?? null, feeUsd: () => options.feeUsd ?? null };
  alice = new PaymentFlow(containers.alice, { ...common, send: (m) => deliver("alice", m as Sent) });
  bob = new PaymentFlow(containers.bob, { ...common, send: (m) => deliver("bob", m as Sent) });
  // The wallet is already ready: replay its state into the new flows.
  adapterMod.ZcashWalletAdapter.confirmBackup();
  return { alice, bob, sent, containers, types: () => sent.map((s) => `${s.from}:${s.message.type}`) };
}

const FEE = { address: "zs1" + "f".repeat(75), zat: 75_000, nonce: "ab".repeat(16) };

/** A wallet panel over the unlocked, synced stub wallet (its initialize() finds the stored seed: unlock again). */
async function readyPanel(container: HTMLElement): Promise<WalletPanelType> {
  const panel = new WalletPanel(container, { openFaucetGuide: () => undefined, getCapability: () => null });
  await panel.initialize();
  if (adapterMod.ZcashWalletAdapter.state.status === "locked") await adapterMod.ZcashWalletAdapter.unlock("a passphrase of length");
  await adapterMod.ZcashWalletAdapter.sync();
  panel.open();
  return panel;
}

async function acceptedPayment(r: ReturnType<typeof relay>): Promise<void> {
  await r.alice.start("p-bob", "Bob");
  await until(() => button(r.containers.bob, "Accept") !== null, "Bob's Accept");
  button(r.containers.bob, "Accept")!.click();
  await until(() => button(r.containers.alice, "Review") !== null, "Alice's Review");
}

test("the payment goes to the shielded-only u1; a lost broadcast answer reports the txid, tells Bob it may arrive, no retry", async () => {
  const r = relay({ fee: FEE, advertisedFeeZat: 75_000 });
  await acceptedPayment(r);
  const amount = r.containers.alice.querySelector("input") as HTMLInputElement;
  amount.value = "0.002";
  button(r.containers.alice, "Review")!.click();
  await until(() => button(r.containers.alice, "Send privately") !== null, "the confirmation");
  engine.sendError = Object.assign(new Error(`broadcast_uncertain: [txid=${LOST_TXID}] lost`), { code: "broadcast_uncertain", txid: LOST_TXID });
  button(r.containers.alice, "Send privately")!.click();
  await until(() => r.containers.alice.textContent!.includes("may have been sent"), "the uncertain card");
  engine.sendError = null;
  assert.equal(engine.sends.at(-1)![0]!.to, SHIELDED_UA, "Bob sealed his shielded-only unified address (no transparent receiver)");
  assert.notEqual(engine.sends.at(-1)![0]!.to, UNIFIED, "never the full u1 with the exchange receiver");
  assert.equal(button(r.containers.alice, "Send privately"), null, "no immediate retry");
  const paySent = r.sent.find((s) => s.message.type === "pay_sent")!;
  assert.equal(paySent.message.txid, LOST_TXID, "the fee check runs on the real transaction");
  await until(() => r.containers.bob.textContent!.includes("may be on its way"), "Bob's notice");
  assert.deepEqual(r.types().filter((t) => t.startsWith("alice:pay_s") || t.startsWith("alice:pay_n")), ["alice:pay_sent", "alice:pay_notice"]);
});

test("the fee's amount before Review; a short balance names the project fee; the fiat label is the operator's", async () => {
  // No label published: ZEC only.
  const plain = relay({ fee: FEE, advertisedFeeZat: 75_000 });
  await acceptedPayment(plain);
  const note = plain.containers.alice.querySelector<HTMLElement>('[data-role="project-fee-note"]');
  assert.equal(note?.textContent, "Project fee: 0.00075 ZEC, on top of the amount (plus the network fee).");
  (plain.containers.alice.querySelector("input") as HTMLInputElement).value = "0.001";
  engine.previewError = Object.assign(new Error("insufficient_funds: needs more"), { code: "insufficient_funds" });
  button(plain.containers.alice, "Review")!.click();
  const status = () => plain.containers.alice.querySelector<HTMLElement>('[data-role="payment-status"]')!.textContent ?? "";
  await until(() => status().startsWith("Not enough"), "the refusal");
  engine.previewError = null;
  assert.equal(status(), "Not enough shielded ZEC for this amount, the project fee (0.00075 ZEC) and the network fee.");
  button(plain.containers.alice, "Review")!.click();
  await until(() => button(plain.containers.alice, "Send privately") !== null, "the confirmation");
  const rows = plain.containers.alice.textContent ?? "";
  assert.match(rows, /Project fee0\.00075 ZEC/);
  assert.doesNotMatch(rows, /US\$/, "no fiat label unless the operator publishes one");
  button(plain.containers.alice, "Cancel")?.click();

  // PAYMENT_FEE_USD=1 on the server: "≈ US$1" next to the amount, the refusal and the confirmation row.
  const labelled = relay({ fee: FEE, advertisedFeeZat: 75_000, feeUsd: 1 });
  await acceptedPayment(labelled);
  assert.equal(labelled.containers.alice.querySelector('[data-role="project-fee-note"]')?.textContent, "Project fee: 0.00075 ZEC ≈ US$1, on top of the amount (plus the network fee).");
  (labelled.containers.alice.querySelector("input") as HTMLInputElement).value = "0.001";
  engine.previewError = Object.assign(new Error("insufficient_funds: needs more"), { code: "insufficient_funds" });
  button(labelled.containers.alice, "Review")!.click();
  const labelledStatus = () => labelled.containers.alice.querySelector<HTMLElement>('[data-role="payment-status"]')!.textContent ?? "";
  await until(() => labelledStatus().startsWith("Not enough"), "the refusal");
  engine.previewError = null;
  assert.equal(labelledStatus(), "Not enough shielded ZEC for this amount, the project fee (0.00075 ZEC ≈ US$1) and the network fee.");
  button(labelled.containers.alice, "Review")!.click();
  await until(() => button(labelled.containers.alice, "Send privately") !== null, "the confirmation");
  assert.match(labelled.containers.alice.textContent ?? "", /Project fee ≈ US\$10\.00075 ZEC/);
  button(labelled.containers.alice, "Cancel")?.click();
});

test("Cancel while waiting sends pay_cancel; Bob's card closes as cancelled", async () => {
  const r = relay();
  await r.alice.start("p-bob", "Bob");
  await until(() => button(r.containers.bob, "Accept") !== null, "Bob's Accept");
  button(r.containers.alice, "Cancel")!.click();
  assert.equal(r.sent.at(-1)!.message.type, "pay_cancel");
  await until(() => r.containers.bob.textContent!.includes("Alice cancelled"), "Bob's cancelled card");
  assert.equal(button(r.containers.bob, "Accept"), null);
});

test("a bad acceptance (a malformed key) cancels at once — no fee can be owed for it", async () => {
  const r = relay({ fee: FEE, advertisedFeeZat: 75_000 });
  await r.alice.start("p-bob", "Bob");
  const request = r.sent.find((s) => s.message.type === "pay_request")!.message;
  r.alice.handle({ type: "pay_accept", requestId: request.requestId, recipientKey: "bm90IGEga2V5", sealed: "c2VhbGVk", iv: "aXZpdml2aXZpdml2", from: "p-bob", fee: FEE });
  await until(() => r.sent.some((s) => s.from === "alice" && s.message.type === "pay_cancel"), "Alice's pay_cancel");
  assert.match(r.containers.alice.textContent!, /isn't a valid shielded address/);
});

test("an acceptance without the fee the server advertises is cancelled, never paid fee-free", async () => {
  const r = relay({ fee: null, advertisedFeeZat: 75_000 });
  await r.alice.start("p-bob", "Bob");
  await until(() => button(r.containers.bob, "Accept") !== null, "Bob's Accept");
  button(r.containers.bob, "Accept")!.click();
  await until(() => r.containers.alice.textContent!.includes("didn't attach its transfer fee"), "the refusal");
  assert.ok(r.sent.some((s) => s.from === "alice" && s.message.type === "pay_cancel"));
  assert.equal(button(r.containers.alice, "Review"), null);
});

test("Bob left after accepting — Alice's card says so (nothing was sent)", async () => {
  const r = relay({ fee: FEE, advertisedFeeZat: 75_000 });
  await acceptedPayment(r);
  const request = r.sent.find((s) => s.message.type === "pay_request")!.message;
  r.alice.handle({ type: "pay_cancel", requestId: request.requestId, from: "p-bob" });
  assert.match(r.containers.alice.textContent!, /Bob left — nothing was sent/);
});

test("an accepted card expires before the server's fee deadline — Send is refused and the request cancelled", async () => {
  const { PAYMENT_CARD_EXPIRY_MS } = await import("./PaymentFlow.ts");
  const r = relay({ fee: FEE, advertisedFeeZat: 75_000 });
  await acceptedPayment(r);
  const amount = r.containers.alice.querySelector("input") as HTMLInputElement;
  amount.value = "0.002";
  button(r.containers.alice, "Review")!.click();
  await until(() => button(r.containers.alice, "Send privately") !== null, "the confirmation");
  const sendsBefore = engine.sends.length;
  const realNow = Date.now();
  const now = mock.method(Date, "now", () => realNow + PAYMENT_CARD_EXPIRY_MS + 1_000);
  try {
    button(r.containers.alice, "Send privately")!.click();
    await tick(20);
  } finally {
    now.mock.restore();
  }
  assert.equal(engine.sends.length, sendsBefore, "nothing was built");
  assert.match(r.containers.alice.textContent!, /expired — nothing was sent/);
  assert.equal(r.sent.at(-1)!.message.type, "pay_cancel");
});

test("Withdraw sends exactly what was reviewed; an edit drops the confirmation; a player's address is refused", async () => {
  const { rememberPlayerAddress } = await import("./playerAddresses.ts");
  const container = document.createElement("div");
  document.body.appendChild(container);
  localStorage.setItem("zw-mainnet-consent-v1", "1");
  const consent = await import("./mainnetConsent.ts");
  consent.giveMainnetConsent();
  const panel = await readyPanel(container);
  panel.open();
  await until(() => container.querySelector('[data-action="withdraw"]') !== null, "the Withdraw button");
  (container.querySelector('[data-action="withdraw"]') as HTMLButtonElement).click();
  // The Withdraw screen pays TEX addresses now (two transactions, public amount).
  assert.match(container.querySelector('[data-view="withdraw"]')?.textContent ?? "", /an exchange's TEX address \(tex1…\)/);
  const fields = () => Array.from(container.querySelectorAll(".zw-wallet-body input.zw-input")) as HTMLInputElement[];
  const type = (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new dom.window.Event("input"));
  };
  type(fields()[0]!, "zs1" + "m".repeat(75));
  type(fields()[1]!, "0.001");
  (container.querySelector('[data-action="withdraw-review"]') as HTMLButtonElement).click();
  await until(() => container.querySelector('[data-role="withdraw-confirm"]') !== null, "the confirmation");
  assert.match(container.querySelector('[data-role="withdraw-confirm"]')!.textContent!, /To.*zs1mmm/);
  // Edit after Review: the confirmation and Send go at once.
  type(fields()[1]!, "0.009");
  assert.equal(container.querySelector('[data-role="withdraw-confirm"]'), null);
  assert.equal(container.querySelector('[data-action="withdraw-send"]'), null);
  assert.ok(container.querySelector('[data-action="withdraw-review"]'));
  (container.querySelector('[data-action="withdraw-review"]') as HTMLButtonElement).click();
  await until(() => container.querySelector('[data-action="withdraw-send"]') !== null, "Send");
  (container.querySelector('[data-action="withdraw-send"]') as HTMLButtonElement).click();
  await until(() => container.textContent!.includes("Sent. Transaction"), "the result");
  assert.deepEqual(engine.sends.at(-1), [{ to: "zs1" + "m".repeat(75), amountZat: "900000", withdrawal: true }], "the reviewed request, exactly");
  // An address another player sealed to this wallet this session is refused.
  rememberPlayerAddress("zs1" + "p".repeat(75));
  type(fields()[0]!, "zs1" + "p".repeat(75));
  type(fields()[1]!, "0.001");
  const before = engine.sends.length;
  (container.querySelector('[data-action="withdraw-review"]') as HTMLButtonElement).click();
  await until(() => container.textContent!.includes("another player's address"), "the refusal");
  assert.equal(container.querySelector('[data-action="withdraw-send"]'), null);
  assert.equal(engine.sends.length, before);
  panel.close();
  panel.dispose();
});

test("closing the panel leaves no seed words — the backup view and the backup quiz", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const panel = await readyPanel(container);
  panel.open();
  await until(() => button(container, "Back up seed…") !== null, "Back up seed…");
  button(container, "Back up seed…")!.click();
  (container.querySelector("input[type=password]") as HTMLInputElement).value = "a passphrase of length";
  button(container, "Show seed phrase")!.click();
  await until(() => container.querySelectorAll(".zw-wallet-words li").length === 24, "the 24 words");
  const words = Array.from(container.querySelectorAll(".zw-wallet-words li")).map((li) => li.textContent!);
  panel.close();
  assert.equal(container.querySelectorAll(".zw-wallet-words li").length, 0, "no words in the hidden DOM");
  assert.equal(words.some((w) => container.innerHTML.includes(`>${w}<`)), false);
  // The backup quiz (onboarding path): the quiz buttons go too, and a stale "Show the words again" does nothing.
  panel.open();
  button(container, "Back up seed…")!.click();
  (container.querySelector("input[type=password]") as HTMLInputElement).value = "a passphrase of length";
  button(container, "Show seed phrase")!.click();
  await until(() => container.querySelectorAll(".zw-wallet-words li").length === 24, "the words again");
  (container.querySelector(".zw-wallet-check input") as HTMLInputElement).click();
  (container.querySelector('[data-action="words-done"]') as HTMLButtonElement).click();
  if (container.querySelector('[data-view="quiz"]')) {
    const again = button(container, "Show the words again")!;
    panel.close();
    assert.equal(container.querySelectorAll("[data-quiz-position]").length, 0, "no quiz buttons in the hidden DOM");
    again.click(); // a reference kept by a script: nothing happens
    assert.equal(container.querySelectorAll(".zw-wallet-words li").length, 0, "a stale button never re-renders the words");
  } else {
    panel.close();
  }
  panel.dispose();
});

test("a new wallet's words view keeps its tick when a sync re-renders it (found under the real engine)", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  await adapterMod.ZcashWalletAdapter.clearAllData();
  const panel = new WalletPanel(container, { openFaucetGuide: () => undefined, getCapability: () => null });
  try {
    await panel.initialize();
    panel.open();
    await until(() => button(container, "Create a new wallet") !== null, "Create a new wallet");
    button(container, "Create a new wallet")!.click();
    const passwords = Array.from(container.querySelectorAll("input[type=password]")) as HTMLInputElement[];
    for (const input of passwords) input.value = "a passphrase of length";
    button(container, "Create wallet")!.click();
    await until(() => container.querySelectorAll(".zw-wallet-words li").length === 24, "the fresh words");
    const box = () => container.querySelector(".zw-wallet-check input") as HTMLInputElement;
    const next = () => container.querySelector('[data-action="words-done"]') as HTMLButtonElement;
    assert.equal(next().disabled, true);
    box().click();
    assert.equal(next().disabled, false);
    const before = box();
    await adapterMod.ZcashWalletAdapter.sync(); // state changes → the panel re-renders the words view
    await until(() => box() !== before, "the re-render");
    assert.equal(box().checked, true, "still ticked");
    assert.equal(next().disabled, false, "Next stays enabled");
  } finally {
    panel.close();
    panel.dispose();
  }
});

test("pure helpers: engine error txids, the payment address check, the withdraw comparison, player addresses", async () => {
  const { engineErrorTxid, isBroadcastPhaseError, walletErrorMessage } = await import("./engineErrors.ts");
  const { acceptableAddress } = await import("./PaymentFlow.ts");
  const { sameWithdrawRequest, shortAddress } = await import("./WalletPanel.ts");
  const { rememberPlayerAddress, isKnownPlayerAddress, forgetPlayerAddresses } = await import("./playerAddresses.ts");
  assert.equal(engineErrorTxid({ code: "broadcast_uncertain", txid: LOST_TXID }), LOST_TXID);
  assert.equal(engineErrorTxid(new Error(`broadcast_failed: [txid=${LOST_TXID}] refused`)), LOST_TXID);
  assert.equal(engineErrorTxid(new Error("transaction_build_failed: x")), null);
  assert.equal(isBroadcastPhaseError({ code: "broadcast_uncertain" }), true);
  assert.equal(isBroadcastPhaseError({ code: "insufficient_funds" }), false);
  assert.match(walletErrorMessage({ code: "broadcast_uncertain" }), /may have been sent/);
  assert.doesNotMatch(walletErrorMessage({ code: "broadcast_uncertain" }), /Nothing was sent/);
  assert.match(walletErrorMessage({ code: "recipient_unsupported" }, { context: "withdrawal" }), /t1… or tex1… address/);
  assert.match(walletErrorMessage({ code: "recipient_no_sapling_receiver" }), /unified address/, "retired code, still mapped");
  assert.match(walletErrorMessage({ code: "nothing_to_shield" }), /more than the network fee/);
  // A mainnet wallet (u1) accepts the recipient's zs1 or u1 on mainnet, nothing else.
  assert.equal(acceptableAddress(SHIELDED_UA, UNIFIED), true);
  assert.equal(acceptableAddress(SAPLING, UNIFIED), true);
  assert.equal(acceptableAddress(UNIFIED, UNIFIED), true);
  assert.equal(acceptableAddress(TRANSPARENT, UNIFIED), false);
  assert.equal(acceptableAddress("utest1" + "q".repeat(100), UNIFIED), false);
  assert.equal(acceptableAddress("zregtestsapling1" + "q".repeat(70), "uregtest1" + "q".repeat(100)), false, "test chains keep the same format on both sides");
  assert.equal(sameWithdrawRequest({ purpose: "withdrawal", to: "a", amountZat: 1n }, { purpose: "withdrawal", to: "a", amountZat: 1n, memo: "" }), true);
  assert.equal(sameWithdrawRequest({ purpose: "withdrawal", to: "a", amountZat: 1n }, { purpose: "withdrawal", to: "a", amountZat: 2n }), false);
  assert.equal(shortAddress("zs1" + "x".repeat(75)).length, 25);
  forgetPlayerAddresses();
  rememberPlayerAddress(" ZS1ABC ");
  assert.equal(isKnownPlayerAddress(null, "zs1abc"), true);
  assert.equal(isKnownPlayerAddress("zs1other"), false);
});
