import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { VoiceControls as VoiceControlsType } from "./VoiceControls.ts";
import type * as Participation from "../zcash/participation.ts";

// ADR-015: the voice panel's primary button and hint — guests and locked wallets
// listen; an unlocked holder on a name-registry server without a confirmed name also listens, and the hint offers the
// name step instead of leaving voice off.

let VoiceControls: typeof VoiceControlsType;
let participation: typeof Participation;
const globals = ["window", "document", "HTMLElement", "HTMLButtonElement", "HTMLDivElement", "HTMLSpanElement", "HTMLInputElement", "HTMLSelectElement", "KeyboardEvent", "Event"] as const;
const saved: Partial<Record<(typeof globals)[number], unknown>> = {};

before(async () => {
  const dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
  for (const key of globals) {
    saved[key] = (globalThis as Record<string, unknown>)[key];
    (globalThis as Record<string, unknown>)[key] = key === "window" ? dom.window : (dom.window as unknown as Record<string, unknown>)[key];
  }
  ({ VoiceControls } = await import("./VoiceControls.ts"));
  participation = await import("../zcash/participation.ts");
});

after(() => {
  for (const key of globals) (globalThis as Record<string, unknown>)[key] = saved[key];
});

beforeEach(() => {
  participation.__testSeam.clearAllListeners();
  participation.resetParticipationState();
  participation.__testSeam.resetWalletHolder();
});

function panel() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const controls = new VoiceControls(container);
  const calls: string[] = [];
  controls.onEnable(() => calls.push("enable"));
  controls.onListen(() => calls.push("listen"));
  controls.onWalletNeeded(() => calls.push("wallet"));
  controls.onNameNeeded(() => calls.push("name"));
  const primary = () => container.querySelector<HTMLButtonElement>(".zw-voice-controls > .zw-button-primary")!;
  const hint = () => container.querySelector<HTMLButtonElement>(".zw-voice-wallet-hint")!;
  return { controls, container, calls, primary, hint };
}

test("a guest listens: 'Listen to voices (guests can't talk)', and the hint offers a wallet", () => {
  const { controls, calls, primary, hint } = panel();
  assert.equal(primary().textContent, "Listen to voices (guests can't talk)");
  assert.equal(primary().dataset.participation, "guest");
  assert.equal(hint().hidden, false);
  assert.equal(hint().textContent, "Connect a wallet to talk");
  primary().click();
  hint().click();
  assert.deepEqual(calls, ["listen", "wallet"]);
  controls.dispose();
});

test("an unlocked holder without a name gate gets Enable Voice (full voice)", () => {
  const { controls, calls, primary, hint } = panel();
  participation.updateParticipationState("ready");
  assert.equal(primary().textContent, "Enable Voice");
  assert.equal(primary().dataset.participation, "ready");
  assert.equal(hint().hidden, true);
  primary().click();
  assert.deepEqual(calls, ["enable"]);
  controls.dispose();
});

test("an unlocked holder who still needs a confirmed name listens, and the hint opens the name step", () => {
  const { controls, calls, primary, hint } = panel();
  participation.updateParticipationState("ready");
  controls.setNameRequired(true);
  assert.equal(primary().textContent, "Listen to voices");
  assert.equal(primary().dataset.participation, "name");
  assert.match(primary().title, /confirmed name/);
  assert.equal(hint().hidden, false);
  assert.equal(hint().textContent, "Confirm a name to talk");
  primary().click();
  hint().click();
  assert.deepEqual(calls, ["listen", "name"], "the button listens (no 403 name_required attempt); the hint asks for the name");

  // Listening: nothing to upgrade to yet, so the button goes away and the hint stays.
  controls.setConnectionState("connected", "listen");
  assert.equal(primary().hidden, true);
  assert.equal(hint().hidden, false);

  // The name is confirmed: Enable Voice comes back to upgrade the listen-only connection.
  controls.setNameRequired(false);
  assert.equal(primary().hidden, false);
  assert.equal(primary().textContent, "Enable Voice");
  assert.equal(hint().hidden, true);
  primary().click();
  assert.deepEqual(calls, ["listen", "name", "enable"]);
  controls.dispose();
});

test("a locked holder listens and is told to unlock — the name gate does not change that wording", () => {
  const { controls, calls, primary, hint } = panel();
  participation.updateParticipationState("ready");
  participation.updateParticipationState("locked");
  controls.setNameRequired(true);
  assert.equal(primary().textContent, "Listen to voices");
  assert.equal(primary().dataset.participation, "locked");
  assert.equal(hint().textContent, "🔒 Unlock wallet to talk");
  hint().click();
  assert.deepEqual(calls, ["wallet"]);
  controls.dispose();
});
