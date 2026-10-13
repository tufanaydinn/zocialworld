import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { PlayerContextCard as PlayerContextCardType, PlayerContextCardData } from "./PlayerContextCard.ts";

// ADR-015 § 4–5: Send ZEC only to players who can receive; the profile row; live updates.

let PlayerContextCard: typeof PlayerContextCardType;
const globals = ["window", "document", "HTMLElement", "HTMLButtonElement", "HTMLDivElement", "HTMLSpanElement", "HTMLInputElement", "Event"] as const;
const saved: Partial<Record<(typeof globals)[number], unknown>> = {};

before(async () => {
  const dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
  for (const key of globals) {
    saved[key] = (globalThis as Record<string, unknown>)[key];
    (globalThis as Record<string, unknown>)[key] = key === "window" ? dom.window : (dom.window as unknown as Record<string, unknown>)[key];
  }
  ({ PlayerContextCard } = await import("./PlayerContextCard.ts"));
});

after(() => {
  for (const key of globals) (globalThis as Record<string, unknown>)[key] = saved[key];
});

const DATA: PlayerContextCardData = { playerId: "p2", nickname: "Guest-1234", accentColor: "#bf4040", canReceive: false, presence: "nearby", muted: false };

function card() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const menu = new PlayerContextCard(container);
  const sent: string[] = [];
  menu.setSendZec((playerId) => sent.push(playerId));
  const send = () => [...container.querySelectorAll<HTMLButtonElement>(".zw-player-menu-item")].find((button) => button.classList.contains("zw-player-menu-zec"))!;
  const label = () => send().querySelector(".zw-player-menu-label")!.textContent;
  const profile = () => container.querySelector<HTMLElement>(".zw-player-menu-profile")!;
  const profileButton = () => [...container.querySelectorAll<HTMLButtonElement>(".zw-player-menu-item")].find((button) => button.textContent?.includes("Profile"))!;
  return { menu, container, sent, send, label, profile, profileButton };
}

test("a player who cannot receive: Send ZEC is disabled and says why in its label and title", () => {
  const { menu, send, label, sent, container } = card();
  menu.open(DATA);
  assert.equal(send().disabled, true);
  assert.equal(label(), "Send ZEC — this player has no wallet");
  assert.match(send().title, /no wallet/);
  send().click();
  assert.deepEqual(sent, [], "a disabled Send never starts a payment");
  assert.equal((container.querySelector(".zw-player-menu-avatar") as HTMLElement).style.background, "rgb(191, 64, 64)", "the chip is the avatar colour");
  menu.dispose();
});

test("a wallet holder: Send ZEC is enabled and starts the payment flow", () => {
  const { menu, send, label, sent } = card();
  menu.open({ ...DATA, nickname: "Alice", canReceive: true });
  assert.equal(send().disabled, false);
  assert.equal(label(), "Send ZEC");
  send().click();
  assert.deepEqual(sent, ["p2"]);
  menu.dispose();
});

test("can_receive_updated while the menu is open flips the button and the profile row live — only for that player", () => {
  const { menu, send, label, profile, profileButton } = card();
  menu.open(DATA);
  profileButton().click();
  assert.match(profile().textContent ?? "", /Can receive ZEC privately\s*No — address never shown/);
  menu.setCanReceive("someone-else", true);
  assert.equal(send().disabled, true, "another player's update changes nothing");
  menu.setCanReceive("p2", true);
  assert.equal(send().disabled, false);
  assert.equal(label(), "Send ZEC");
  assert.match(profile().textContent ?? "", /Can receive ZEC privately\s*Yes — address never shown/);
  menu.setCanReceive("p2", false);
  assert.equal(label(), "Send ZEC — this player has no wallet");
  menu.close();
  assert.doesNotThrow(() => menu.setCanReceive("p2", true), "ignored while closed");
  menu.dispose();
});

test("the profile never shows a wallet, an address or a balance — only the one capability bit", () => {
  const { menu, profile, profileButton } = card();
  menu.open({ ...DATA, canReceive: true });
  profileButton().click();
  const text = profile().textContent ?? "";
  assert.doesNotMatch(text, /View Wallet|balance|utest|u1/i);
  assert.match(text, /address never shown/);
  menu.dispose();
});

test("with no Send ZEC callback at all, the reason given to setSendZec wins over the wallet state", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const menu = new PlayerContextCard(container);
  menu.setSendZec(null, "set up your wallet first");
  menu.open({ ...DATA, canReceive: true });
  const send = container.querySelector<HTMLButtonElement>(".zw-player-menu-zec")!;
  assert.equal(send.disabled, true);
  assert.equal(send.querySelector(".zw-player-menu-label")!.textContent, "Send ZEC — set up your wallet first");
  menu.dispose();
});
