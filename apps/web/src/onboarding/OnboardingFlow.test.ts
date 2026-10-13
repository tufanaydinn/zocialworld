import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { PlayerAvatar } from "@project/shared";
import type { WalletStatus } from "../zcash/WalletTypes.ts";
import type { OnboardingFlow as OnboardingFlowType, OnboardingResult, OnboardingWallet } from "./OnboardingFlow.ts";
import type { PlayerProfile } from "./profileStore.ts";
import { NameConfirmationError, disabledNameConfirmation, immediateNameConfirmation, type NameConfirmation, type NameConfirmationStatus } from "./nameConfirmation.ts";

// ADR-015 § 7: the onboarding flow — guests skip the name, holders need the wallet, returning players,
// Enter waits for the world, Esc never closes it. jsdom, a fake wallet and a stub preview.

let OnboardingFlow: typeof OnboardingFlowType;
const globals = ["window", "document", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "KeyboardEvent", "Event", "Node"] as const;
const saved: Partial<Record<(typeof globals)[number], unknown>> = {};

before(async () => {
  const dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
  for (const key of globals) {
    saved[key] = (globalThis as Record<string, unknown>)[key];
    (globalThis as Record<string, unknown>)[key] = key === "window" ? dom.window : (dom.window as unknown as Record<string, unknown>)[key];
  }
  ({ OnboardingFlow } = await import("./OnboardingFlow.ts"));
});

after(() => {
  for (const key of globals) (globalThis as Record<string, unknown>)[key] = saved[key];
});

class FakeWallet implements OnboardingWallet {
  statusValue: WalletStatus;
  holder = false;
  busy = false;
  opened: (() => void) | null = null;
  closed = 0;
  unlockWith: string | null = null;
  private readonly statusListeners: ((status: WalletStatus) => void)[] = [];
  private readonly holderListeners: ((holder: boolean) => void)[] = [];

  constructor(status: WalletStatus = "idle") {
    this.statusValue = status;
  }
  status(): WalletStatus {
    return this.statusValue;
  }
  subscribe(listener: (status: WalletStatus) => void): () => void {
    this.statusListeners.push(listener);
    return () => undefined;
  }
  isHolder(): boolean {
    return this.holder;
  }
  subscribeHolder(listener: (holder: boolean) => void): () => void {
    this.holderListeners.push(listener);
    listener(this.holder);
    return () => undefined;
  }
  open(onReady: () => void): void {
    this.opened = onReady;
  }
  close(): void {
    this.closed++;
    this.opened = null;
  }
  isBusy(): boolean {
    return this.busy;
  }
  unlock(passphrase: string): Promise<void> {
    this.unlockWith = passphrase;
    if (passphrase !== "correct horse") return Promise.reject(new Error("Wrong passphrase. Wallet data preserved."));
    this.setStatus("ready");
    return Promise.resolve();
  }
  /** What the adapter + participation do: a status change, and the sticky holder flag on ready/syncing. */
  setStatus(status: WalletStatus): void {
    this.statusValue = status;
    for (const listener of this.statusListeners) listener(status);
    if ((status === "ready" || status === "syncing") && !this.holder) {
      this.holder = true;
      for (const listener of this.holderListeners) listener(true);
    }
  }
}

function setup(options: { profile?: PlayerProfile | null; wallet?: FakeWallet; worldReady?: Promise<void>; nameConfirmation?: NameConfirmation } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const wallet = options.wallet ?? new FakeWallet();
  const results: OnboardingResult[] = [];
  const checks: string[] = [];
  const shown: PlayerAvatar[] = [];
  let previews = 0;
  let disposed = 0;
  const flow = new OnboardingFlow({
    container,
    profile: options.profile ?? null,
    wallet,
    checkNickname: (nickname) => checks.push(nickname),
    worldReady: options.worldReady ?? Promise.resolve(),
    createPreview: () => {
      previews++;
      const element = document.createElement("div");
      element.className = "stub-preview";
      return { element, show: (avatar) => shown.push(avatar), dispose: () => (disposed++, element.remove()) };
    },
    nameConfirmation: options.nameConfirmation ?? immediateNameConfirmation(() => undefined),
    onComplete: (result) => results.push(result),
    checkDebounceMs: 0,
  });
  const root = container.querySelector(".zw-onboarding") as HTMLElement;
  const click = (selector: string): void => {
    const element = root.querySelector<HTMLElement>(selector);
    assert.ok(element, `no ${selector} on step ${flow.step}`);
    element.click();
  };
  const clickText = (text: string): void => {
    const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim().startsWith(text));
    assert.ok(button, `no button "${text}" on step ${flow.step}`);
    button.click();
  };
  const type = (value: string): void => {
    const input = root.querySelector<HTMLInputElement>(".zw-onb-nickname");
    assert.ok(input, "no nickname input");
    input.value = value;
    input.dispatchEvent(new window.Event("input"));
  };
  return { flow, wallet, results, checks, shown, root, click, clickText, type, previews: () => previews, disposed: () => disposed, container };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("first visit: Welcome offers 'Connect a wallet' and 'Continue as guest' with a TESTNET chip, as a modal dialog", () => {
  const { flow, root } = setup();
  flow.start();
  assert.equal(flow.isOpen, true);
  assert.equal(flow.step, "welcome");
  assert.equal(root.getAttribute("role"), "dialog");
  assert.equal(root.getAttribute("aria-modal"), "true");
  assert.match(root.textContent ?? "", /TESTNET/);
  assert.ok(root.querySelector('[data-choice="wallet"]'));
  assert.ok(root.querySelector('[data-choice="guest"]'));
  flow.dispose();
});

test("guests skip the wallet, character and nickname steps: Welcome → Enter → { mode: guest }", async () => {
  const { flow, results, click, previews } = setup();
  flow.start();
  click('[data-choice="guest"]');
  assert.equal(flow.step, "enter");
  assert.equal(previews(), 0, "no character choice (and no preview) for guests — ADR-015: guests get the default character");
  await tick();
  click('[data-action="enter-world"]');
  assert.deepEqual(results, [{ mode: "guest", avatar: null, nickname: null }]);
  assert.equal(flow.isOpen, false);
  flow.dispose();
});

test("holders need the wallet ready: the wallet step waits, then character → nickname (checked) → Enter", async () => {
  const { flow, wallet, results, click, checks, type, shown, disposed } = setup();
  flow.start();
  click('[data-choice="wallet"]');
  assert.equal(flow.step, "wallet");
  click('[data-action="open-wallet"]');
  assert.ok(wallet.opened, "the wallet panel was opened above onboarding");
  assert.equal(flow.step, "wallet", "nothing moves on until the wallet is ready");
  wallet.setStatus("ready"); // created / restored / unlocked
  assert.equal(flow.step, "character");
  assert.ok(wallet.closed > 0, "the panel is closed once the wallet is ready");
  click('.zw-onb-model[data-model="knight"]');
  click('.zw-onb-swatch[data-color="6"]');
  assert.deepEqual(shown.at(-1), { model: "knight", color: 6 }, "the live preview follows the choice");
  click('[data-action="character-continue"]');
  assert.equal(flow.step, "nickname");
  type("Alice");
  assert.deepEqual(checks, ["Alice"]);
  flow.handleNicknameCheckResult({ type: "nickname_check_result", nickname: "Alice", status: "taken", suggestion: "Alice-2" });
  assert.match((document.querySelector(".zw-onb-status") as HTMLElement).textContent ?? "", /Alice is taken — Alice-2 is free/);
  click('[data-action="use-suggestion"]');
  flow.handleNicknameCheckResult({ type: "nickname_check_result", nickname: "Alice-2", status: "available" });
  assert.equal((document.querySelector(".zw-onb-status") as HTMLElement).dataset.check, "available");
  click('[data-action="nickname-continue"]');
  assert.equal(flow.step, "enter");
  await tick();
  click('[data-action="enter-world"]');
  assert.deepEqual(results, [{ mode: "holder", avatar: { model: "knight", color: 6 }, nickname: "Alice-2" }]);
  assert.equal(disposed(), 1, "the preview's renderer is released when onboarding closes");
  flow.dispose();
});

test("the wallet step does not close a panel that is still showing a new seed phrase; it waits for onReady", () => {
  const { flow, wallet, click } = setup();
  flow.start();
  click('[data-choice="wallet"]');
  click('[data-action="open-wallet"]');
  wallet.busy = true; // created: the 24 words are on screen
  wallet.setStatus("ready");
  assert.equal(flow.step, "wallet", "the player must see their seed words first");
  assert.equal(wallet.closed, 0);
  wallet.busy = false;
  wallet.opened?.(); // "Done" → WalletPanel's onReady
  assert.equal(flow.step, "character");
  flow.dispose();
});

test("nickname rules are applied locally before any check: reserved and invisible-character names block Continue", () => {
  const wallet = new FakeWallet("ready");
  wallet.holder = true;
  const { flow, click, type, checks, root } = setup({ wallet });
  flow.start();
  click('[data-choice="wallet"]');
  assert.equal(flow.step, "character", "an already-unlocked wallet skips the wallet step");
  click('[data-action="character-continue"]');
  const next = () => root.querySelector<HTMLButtonElement>('[data-action="nickname-continue"]')!;
  type("Guest-1234");
  assert.equal(next().disabled, true);
  type("Al\u200bice");
  assert.equal(next().disabled, true);
  assert.deepEqual(checks, [], "nothing invalid is sent to the server");
  type("Ada");
  assert.equal(next().disabled, false);
  flow.handleNicknameCheckResult({ type: "nickname_check_result", nickname: "Ada", status: "reserved" });
  assert.equal(next().disabled, true, "the server's answer wins");
  flow.handleNicknameCheckResult({ type: "nickname_check_result", nickname: "Somebody else", status: "available" });
  assert.equal(next().disabled, true, "an answer for a different input is ignored");
  assert.match(root.textContent ?? "", /never linked to your wallet address/);
  flow.dispose();
});

test("Enter waits for the world: disabled while loading, enabled once worldReady resolves", async () => {
  let ready!: () => void;
  const worldReady = new Promise<void>((resolve) => (ready = resolve));
  const { flow, click, root, results } = setup({ worldReady });
  flow.start();
  click('[data-choice="guest"]');
  const enter = () => root.querySelector<HTMLButtonElement>('[data-action="enter-world"]')!;
  assert.equal(enter().disabled, true);
  assert.match(enter().textContent ?? "", /Loading the world/);
  enter().click();
  assert.deepEqual(results, []);
  ready();
  await tick();
  await tick();
  assert.equal(enter().disabled, false);
  enter().click();
  assert.equal(results.length, 1);
  flow.dispose();
});

test("Escape never closes the start-of-game flow, and keys never reach the game (window)", () => {
  const { flow, root } = setup();
  flow.start();
  let reachedWindow = 0;
  const listener = () => reachedWindow++;
  window.addEventListener("keydown", listener);
  const button = root.querySelector<HTMLButtonElement>('[data-choice="guest"]')!;
  button.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  button.dispatchEvent(new window.KeyboardEvent("keydown", { key: "w", bubbles: true }));
  window.removeEventListener("keydown", listener);
  assert.equal(flow.isOpen, true);
  assert.equal(flow.step, "welcome");
  assert.equal(reachedWindow, 0);
  flow.dispose();
});

test("returning holder with a locked wallet: 'Welcome back, Alice', inline unlock, 'Enter now — unlock later', 'Enter as guest', 'Change character'", async () => {
  const wallet = new FakeWallet("locked");
  const profile: PlayerProfile = { v: 1, lastMode: "holder", avatar: { model: "mage", color: 2 }, nickname: "Alice" };
  const { flow, root, click, results } = setup({ wallet, profile });
  flow.start();
  assert.equal(flow.step, "returning");
  assert.match(root.querySelector(".zw-onb-title")?.textContent ?? "", /Welcome back, Alice/);
  for (const action of ["unlock", "enter-later"]) assert.ok(root.querySelector(`[data-action="${action}"]`), action);
  assert.match(root.textContent ?? "", /Enter as guest/);
  assert.match(root.textContent ?? "", /Change character/);
  const input = root.querySelector<HTMLInputElement>('input[type="password"]')!;
  input.value = "wrong";
  click('[data-action="unlock"]');
  await tick();
  assert.match(root.textContent ?? "", /Wrong passphrase/);
  root.querySelector<HTMLInputElement>('input[type="password"]')!.value = "correct horse";
  click('[data-action="unlock"]');
  await tick();
  assert.equal(flow.step, "enter");
  click('[data-action="enter-world"]');
  assert.deepEqual(results, [{ mode: "holder", avatar: { model: "mage", color: 2 }, nickname: "Alice" }]);
  flow.dispose();
});

test("returning holder: 'Enter now — unlock later' enters as a guest (the remembered name comes back after unlocking)", () => {
  const wallet = new FakeWallet("locked");
  const { flow, click, results } = setup({ wallet, profile: { v: 1, lastMode: "holder", nickname: "Alice" } });
  flow.start();
  click('[data-action="enter-later"]');
  assert.deepEqual(results, [{ mode: "guest", avatar: null, nickname: null }]);
  flow.dispose();
});

test("a remembered holder whose wallet is gone (idle) is treated as a guest and the name is dropped", () => {
  const { flow, root } = setup({ wallet: new FakeWallet("idle"), profile: { v: 1, lastMode: "holder", nickname: "Alice" } });
  flow.start();
  assert.equal(flow.step, "returning");
  assert.doesNotMatch(root.querySelector(".zw-onb-title")?.textContent ?? "", /Alice/);
  assert.ok(root.querySelector('[data-action="enter-guest"]'));
  flow.dispose();
});

test("returning guest: 'Welcome back' with Enter as a guest / Connect a wallet", () => {
  const { flow, root, click, results } = setup({ profile: { v: 1, lastMode: "guest" } });
  flow.start();
  assert.equal(flow.step, "returning");
  assert.equal(root.querySelector(".zw-onb-title")?.textContent, "Welcome back");
  click('[data-action="enter-guest"]');
  assert.equal(flow.step, "enter");
  flow.dispose();
  void results;
});

test("the wallet check runs first: while the wallet is initializing the flow waits, then picks Welcome back", () => {
  const wallet = new FakeWallet("initializing");
  const { flow } = setup({ wallet, profile: { v: 1, lastMode: "holder", nickname: "Alice" } });
  flow.start();
  assert.equal(flow.step, "checking");
  wallet.setStatus("locked");
  assert.equal(flow.step, "returning");
  flow.dispose();
});

test("mid-session modals: Change character returns the new avatar; Change name applies through NameConfirmation; Escape cancels a modal", async () => {
  const sent: string[] = [];
  const { flow, click, type } = setup({ nameConfirmation: immediateNameConfirmation((nickname) => sent.push(nickname)) });
  const chosen: PlayerAvatar[] = [];
  flow.openCharacter({ model: "rogue", color: 1 }, (avatar) => chosen.push(avatar));
  assert.equal(flow.modalKind, "character");
  assert.equal(flow.isOnboarding, false);
  click('.zw-onb-model[data-model="barbarian"]');
  click('[data-action="save-character"]');
  assert.deepEqual(chosen, [{ model: "barbarian", color: 1 }]);
  assert.equal(flow.isOpen, false);

  const named: string[] = [];
  flow.openNickname("", (nickname) => named.push(nickname));
  type("Ada");
  click('[data-action="nickname-continue"]');
  await tick();
  assert.deepEqual(sent, ["Ada"], "immediateNameConfirmation sends set_nickname (the honour system until ADR-016)");
  assert.deepEqual(named, ["Ada"]);
  assert.equal(flow.isOpen, false);

  flow.openNickname("", () => undefined);
  (document.activeElement as HTMLElement).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(flow.isOpen, false, "Escape cancels a mid-session modal");
  flow.dispose();
});


// ---------------------------------------------------------------------------- ADR-016: fee-confirmed names

type ConfirmFn = (nickname: string, onStatus?: (status: NameConfirmationStatus) => void) => Promise<void>;

/** A fee-mode NameConfirmation (the real one is FeeNameConfirmation, tested on its own) that records what onboarding asks. */
function fakeFee(options: { confirm?: ConfirmFn; claim?: (nickname: string) => Promise<boolean> } = {}) {
  const calls = { confirm: [] as string[], claim: [] as string[], coins: 0 };
  const nameConfirmation: NameConfirmation = {
    requiresFee: true,
    confirmLabel: "Confirm & pay",
    feeText: "Confirm with a small fee: 0.01 TAZ + network fee",
    explanation: "Why a fee? It stops bots. It is not a purchase, and there are no refunds.",
    unavailable: null,
    canClaim: () => true,
    confirm: (nickname, onStatus) => {
      calls.confirm.push(nickname);
      return options.confirm ? options.confirm(nickname, onStatus) : Promise.resolve();
    },
    claim: (nickname) => {
      calls.claim.push(nickname);
      return options.claim ? options.claim(nickname) : Promise.resolve(true);
    },
    getTestCoins: () => {
      calls.coins++;
      return Promise.resolve("Sent 1 test coin — it arrives with the next block.");
    },
    subscribe: () => () => undefined,
  };
  return { nameConfirmation, calls };
}

function holderAtNickname(nameConfirmation: NameConfirmation) {
  const wallet = new FakeWallet("ready");
  wallet.holder = true;
  const ctx = setup({ wallet, nameConfirmation });
  ctx.flow.start();
  ctx.click('[data-choice="wallet"]');
  ctx.click('[data-action="character-continue"]');
  assert.equal(ctx.flow.step, "nickname");
  return ctx;
}

test("fee mode: the nickname step shows the fee, why and no refunds, 'Confirm & pay', and a skip — never an address", () => {
  const { nameConfirmation } = fakeFee();
  const { flow, root } = holderAtNickname(nameConfirmation);
  const text = root.textContent ?? "";
  assert.match(text, /Confirm with a small fee: 0\.01 TAZ \+ network fee/);
  assert.match(text, /stops bots/);
  assert.match(text, /no refunds/);
  assert.match(text, /payment address is never shown/);
  assert.doesNotMatch(text, /uregtest|utest1/);
  assert.equal(root.querySelector('[data-action="nickname-continue"]')?.textContent, "Confirm & pay");
  assert.ok(root.querySelector('[data-action="skip-name"]'));
  flow.dispose();
});

test("fee mode: Confirm & pay confirms BEFORE the join (live status), then Continue → Enter joins with the confirmed name", async () => {
  let finish!: () => void;
  let report!: (status: NameConfirmationStatus) => void;
  const { nameConfirmation, calls } = fakeFee({
    confirm: (_nickname, onStatus) =>
      new Promise<void>((resolve) => {
        report = (status) => onStatus?.(status);
        finish = resolve;
      }),
  });
  const { flow, root, type, click, results } = holderAtNickname(nameConfirmation);
  type("Alice");
  click('[data-action="nickname-continue"]');
  assert.deepEqual(calls.confirm, ["Alice"]);
  assert.equal(flow.step, "nickname", "still on the nickname step while confirming");
  const next = root.querySelector<HTMLButtonElement>('[data-action="nickname-continue"]')!;
  assert.equal(next.disabled, true);
  assert.equal(root.querySelector<HTMLInputElement>(".zw-onb-nickname")!.disabled, true);
  const slot = root.querySelector<HTMLElement>(".zw-onb-confirm")!;
  for (const [step, text, width] of [
    ["paying", "Paying 0.01 TAZ from your wallet…", undefined],
    ["pending", "Payment sent — waiting for the game server to see it…", 0.55],
    ["seen", "Payment seen — confirming your name…", 0.8],
  ] as const) {
    report({ phase: "working", step, text, ...(width !== undefined ? { progress: width } : {}) });
    assert.equal(slot.dataset.step, step);
    assert.match(slot.textContent ?? "", new RegExp(text.slice(0, 12)));
  }
  assert.equal((slot.querySelector(".zw-onb-confirm-fill") as HTMLElement).style.width, "80%");
  finish();
  await tick();
  assert.equal(slot.dataset.phase, "done");
  assert.match(slot.textContent ?? "", /Alice is yours/);
  assert.equal(next.textContent, "Continue");
  click('[data-action="nickname-continue"]');
  assert.equal(flow.step, "enter");
  assert.match(root.textContent ?? "", /Name confirmed/);
  assert.match(root.querySelector(".zw-onb-can")?.textContent ?? "", /Talk in voice \(Whisper, Talk, Shout\) and present on the Watch Hall stage/);
  await tick();
  click('[data-action="enter-world"]');
  assert.equal(results.at(-1)?.nickname, "Alice");
  assert.deepEqual(calls.confirm, ["Alice"], "Continue does not confirm (or pay) again");
  flow.dispose();
});

test("fee mode: not enough coins → 'Get test coins' (the faucet), then 'Try again' runs the confirmation again", async () => {
  let attempt = 0;
  const { nameConfirmation, calls } = fakeFee({
    confirm: () =>
      ++attempt === 1
        ? Promise.reject(new NameConfirmationError("insufficient", "Your wallet needs about 0.01015 TAZ for this.", { faucet: true, retry: true }))
        : Promise.resolve(),
  });
  const { flow, root, type, click } = holderAtNickname(nameConfirmation);
  type("Alice");
  click('[data-action="nickname-continue"]');
  await tick();
  const slot = root.querySelector<HTMLElement>(".zw-onb-confirm")!;
  assert.equal(slot.dataset.phase, "failed");
  assert.equal(slot.dataset.step, "insufficient");
  click('[data-action="get-test-coins"]');
  await tick();
  await tick();
  assert.equal(calls.coins, 1);
  assert.match(slot.textContent ?? "", /Sent 1 test coin/);
  click('[data-action="retry-name"]');
  await tick();
  assert.deepEqual(calls.confirm, ["Alice", "Alice"]);
  assert.equal(root.querySelector('[data-action="nickname-continue"]')?.textContent, "Continue");
  flow.dispose();
});

test("fee mode: an expired reservation offers 'Try again'; Skip enters with a guest name (no nickname)", async () => {
  const { nameConfirmation } = fakeFee({ confirm: () => Promise.reject(new NameConfirmationError("expired", "The reservation expired before a payment arrived.", { retry: true })) });
  const { flow, root, type, click, results } = holderAtNickname(nameConfirmation);
  type("Alice");
  click('[data-action="nickname-continue"]');
  await tick();
  assert.equal(root.querySelector<HTMLElement>(".zw-onb-confirm")!.dataset.step, "expired");
  assert.ok(root.querySelector('[data-action="retry-name"]'));
  assert.equal(root.querySelector('[data-action="nickname-continue"]')?.textContent, "Try again");
  click('[data-action="skip-name"]');
  assert.equal(flow.step, "enter");
  assert.match(root.textContent ?? "", /Guest-#### for now/);
  // Without a confirmed name the server refuses the microphone and the stage — the list must not promise them.
  const can = root.querySelector(".zw-onb-can")?.textContent ?? "";
  assert.match(can, /Listen to voices nearby and the Watch Hall stage — talking and presenting need a confirmed name \(a small test-coin fee\)/);
  assert.doesNotMatch(can, /Talk in voice \(Whisper/);
  await tick();
  click('[data-action="enter-world"]');
  assert.equal(results.at(-1)?.mode, "holder");
  assert.equal(results.at(-1)?.nickname, null);
  flow.dispose();
});

test("fee mode, returning holder: after the unlock the remembered name is claimed automatically — 'Welcome back, Alice', no fee", async () => {
  const wallet = new FakeWallet("locked");
  const { nameConfirmation, calls } = fakeFee();
  const profile: PlayerProfile = { v: 1, lastMode: "holder", avatar: { model: "mage", color: 2 }, nickname: "Alice" };
  const { flow, root, click, results } = setup({ wallet, profile, nameConfirmation });
  flow.start();
  root.querySelector<HTMLInputElement>('input[type="password"]')!.value = "correct horse";
  click('[data-action="unlock"]');
  await tick();
  assert.equal(flow.step, "returning", "the card stays while the name is claimed");
  await tick();
  assert.deepEqual(calls.claim, ["Alice"]);
  assert.deepEqual(calls.confirm, [], "no payment");
  assert.match(root.querySelector(".zw-onb-title")?.textContent ?? "", /Welcome back, Alice/);
  assert.match(root.textContent ?? "", /Alice is yours/);
  click('[data-action="enter-holder"]');
  await tick();
  click('[data-action="enter-world"]');
  assert.deepEqual(results.at(-1), { mode: "holder", avatar: { model: "mage", color: 2 }, nickname: "Alice" });
  flow.dispose();
});

test("fee mode, returning holder whose name is not registered here: confirm it with the fee, or enter with a guest name", async () => {
  const wallet = new FakeWallet("ready");
  wallet.holder = true;
  const { nameConfirmation } = fakeFee({ claim: () => Promise.resolve(false) });
  const { flow, root, click } = setup({ wallet, profile: { v: 1, lastMode: "holder", nickname: "Alice" }, nameConfirmation });
  flow.start();
  await tick();
  await tick();
  assert.equal(root.querySelector(".zw-onb-title")?.textContent, "Welcome back");
  assert.match(root.textContent ?? "", /isn't confirmed on this server yet/);
  assert.ok(root.querySelector('[data-action="enter-unconfirmed"]'));
  click('[data-action="confirm-remembered"]');
  assert.equal(flow.step, "nickname");
  assert.equal(root.querySelector<HTMLInputElement>(".zw-onb-nickname")!.value, "Alice");
  flow.dispose();
});

test("registration disabled on the server: the step says why and the holder continues with a guest name", async () => {
  const { flow, root, click, results } = holderAtNickname(disabledNameConfirmation());
  assert.match(root.textContent ?? "", /Name registration is unavailable on this server right now/);
  click('[data-action="nickname-continue"]');
  assert.equal(flow.step, "enter");
  await tick();
  click('[data-action="enter-world"]');
  assert.equal(results.at(-1)?.nickname, null);
  flow.dispose();
});

test("fee mode, mid-session Change name: the modal confirms with progress and closes when confirmed", async () => {
  let finish!: () => void;
  const { nameConfirmation } = fakeFee({
    confirm: (_nickname, onStatus) =>
      new Promise<void>((resolve) => {
        onStatus?.({ phase: "working", step: "paying", text: "Paying 0.01 TAZ…", progress: 0.4 });
        finish = resolve;
      }),
  });
  const named: string[] = [];
  const { flow, type, click, root } = setup({ nameConfirmation });
  flow.openNickname("", (nickname) => named.push(nickname), "Change your name");
  assert.equal(root.querySelector('[data-action="nickname-continue"]')?.textContent, "Confirm & pay");
  assert.match(root.textContent ?? "", /Confirm with a small fee/);
  type("Ada");
  click('[data-action="nickname-continue"]');
  const slot = root.querySelector<HTMLElement>(".zw-onb-confirm")!;
  assert.equal(slot.hidden, false);
  assert.equal((slot.querySelector(".zw-onb-confirm-fill") as HTMLElement).style.width, "40%");
  finish();
  await tick();
  assert.equal(flow.isOpen, false);
  assert.deepEqual(named, ["Ada"]);
  flow.dispose();
});
