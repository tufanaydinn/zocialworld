import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * Wallet-holder identity (ADR-015) with two real clients through the real server:
 *  - the holder's menu on a guest: Send ZEC disabled, with the reason, and "Can receive ZEC privately: No";
 *  - the guest's menu on the holder: Send ZEC enabled;
 *  - a forged pay_request from the holder to the guest is refused by the server (no_wallet);
 *  - the other client sees the holder's chosen model (high tier), and set_avatar swaps it live;
 *  - on the low tier the guest's placeholder accent is its palette colour.
 * Both clients join through the suite's `autoEnter: "guest"` seed; the holder then flips the
 * participation gate (the wallet "reached ready") and picks a name, like chat.spec.ts.
 */

type DebugWindow = {
  __worldReady?: boolean;
  __networkClient?: { joined: boolean; sendNickname(nickname: string): void; sendAvatar(avatar: { model: string; color: number }): void; sendPayment(message: unknown): void };
  __identity?: () => { nickname: string; canReceive: boolean; avatar: { model: string; color: number } | null };
  __remotePlayers?: {
    findByNickname(nickname: string): { playerId: string } | null;
    getPlayer(playerId: string): { canReceive: boolean; avatar: { model: string; color: number }; loadedModel: string | null; accentColor: { getHexString(): string } | null; headPosition: unknown } | undefined;
  };
  __localPlayer?: { position: { set(x: number, y: number, z: number): void } };
};

const RUN = Math.random().toString(36).slice(2, 6);
const contexts: BrowserContext[] = [];

async function open(browser: Browser, quality: "low" | "high", frames?: string[]): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  contexts.push(context);
  const page = await context.newPage();
  if (frames) page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => frames.push(String(payload))));
  await page.goto(`/?quality=${quality}`);
  // The high-tier observer joins only once its world has loaded and warmed up. On a full-size world with SwiftShader
  // beside two open clients that took 115-136 s on a 4-vCPU machine, so it gets more than the 120 s the
  // low-tier clients need; the test's own 420 s timeout still bounds it.
  await page.waitForFunction(() => (window as DebugWindow).__networkClient?.joined === true, null, { timeout: quality === "high" ? 240_000 : 120_000 });
  return page;
}

async function becomeHolder(page: Page, nickname: string): Promise<void> {
  await page.evaluate(async () => {
    const modulePath = "/src/zcash/participation.ts";
    const participation = (await import(/* @vite-ignore */ modulePath)) as { updateParticipationState(status: string): void };
    participation.updateParticipationState("ready");
  });
  // ADR-016: names are fee-confirmed on the test server — its DEV registry confirms a reservation on
  // its own (nothing is paid); a test name key stands in for the one the wallet derives at unlock.
  await page.evaluate(async (name) => {
    const modulePath = "/src/zcash/nameKey.ts";
    const nameKey = (await import(/* @vite-ignore */ modulePath)) as { activateNameKeyFromSeed(seed: Uint8Array, network: string): Promise<unknown> };
    await nameKey.activateNameKeyFromSeed(crypto.getRandomValues(new Uint8Array(64)), "test");
    await (window as unknown as { __confirmName(nickname: string): Promise<void> }).__confirmName(name);
  }, nickname);
  await page.waitForFunction((name) => (window as DebugWindow).__identity?.().nickname === name && (window as DebugWindow).__identity?.().canReceive === true, nickname, { timeout: 20_000 });
}

/** Opens the player menu on `playerId` through the same path E uses (App.onPlayerSelected via the interactable). */
async function openMenu(page: Page, playerId: string): Promise<void> {
  await page.evaluate((id) => {
    const interactions = (window as unknown as { __interactions: { all: readonly { id: string; interact(): void }[] } }).__interactions;
    const entry = interactions.all.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`no interactable for ${id}`);
    entry.interact();
  }, playerId);
  await expect(page.locator(".zw-player-menu")).toBeVisible();
}

test.describe("wallet holders and guests (ADR-015)", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(420_000);
  test.afterAll(async () => {
    for (const context of contexts.splice(0)) await context.close();
  });

  let holder: Page;
  let guest: Page;
  const holderFrames: string[] = [];
  let holderId = "";
  let guestId = "";
  const holderName = `Holder${RUN}`;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(420_000);
    holder = await open(browser, "low", holderFrames);
    await becomeHolder(holder, holderName);
    guest = await open(browser, "low");
    holderId = await holder.evaluate(() => (window as unknown as { __hallStore: { localPlayerId: string } }).__hallStore.localPlayerId);
    guestId = await guest.evaluate(() => (window as unknown as { __hallStore: { localPlayerId: string } }).__hallStore.localPlayerId);
    const guestName = await guest.evaluate(() => (window as DebugWindow).__identity!().nickname);
    expect(guestName).toMatch(/^Guest-\d{4}$/);
    await holder.waitForFunction((id) => Boolean((window as DebugWindow).__remotePlayers?.getPlayer(id)), guestId, { timeout: 30_000 });
    await guest.waitForFunction((id) => Boolean((window as DebugWindow).__remotePlayers?.getPlayer(id)), holderId, { timeout: 30_000 });
  });

  test("the holder's menu on a guest: Send ZEC is disabled and says why; the profile row says No — address never shown", async () => {
    expect(await holder.evaluate((id) => (window as DebugWindow).__remotePlayers!.getPlayer(id)!.canReceive, guestId)).toBe(false);
    await openMenu(holder, guestId);
    const send = holder.locator(".zw-player-menu-zec");
    await expect(send).toBeDisabled();
    await expect(send).toContainText("Send ZEC — this player has no wallet");
    await holder.locator(".zw-player-menu-item", { hasText: "View Profile" }).click();
    await expect(holder.locator(".zw-player-menu-profile")).toContainText("Can receive ZEC privately");
    await expect(holder.locator(".zw-player-menu-profile")).toContainText("No — address never shown");
    await expect(holder.locator(".zw-nameplate", { hasText: /wallet|ZEC/i })).toHaveCount(0); // no nameplate badge
    await holder.locator(".zw-player-menu-backdrop").click({ position: { x: 5, y: 5 } });
  });

  test("the guest's menu on the holder: Send ZEC is enabled", async () => {
    expect(await guest.evaluate((id) => (window as DebugWindow).__remotePlayers!.getPlayer(id)!.canReceive, holderId)).toBe(true);
    await openMenu(guest, holderId);
    const send = guest.locator(".zw-player-menu-zec");
    await expect(send).toBeEnabled();
    await expect(send).toHaveText(/Send ZEC$/);
    await guest.locator(".zw-player-menu-backdrop").click({ position: { x: 5, y: 5 } });
  });

  test("a forged pay_request from the holder to the guest is refused by the server with no_wallet", async () => {
    await holder.evaluate((to) => (window as DebugWindow).__networkClient!.sendPayment({ type: "pay_request", to, requestId: "req-forged-01", senderKey: "QUJDRA==" }), guestId);
    await expect.poll(() => holderFrames.some((frame) => frame.includes('"pay_error"') && frame.includes('"no_wallet"')), { timeout: 15_000 }).toBe(true);
  });

  test("another client (high tier) sees the holder's chosen model, and set_avatar swaps it live", async ({ browser }) => {
    await holder.evaluate(() => (window as DebugWindow).__networkClient!.sendAvatar({ model: "barbarian", color: 3 }));
    await guest.waitForFunction((id) => (window as DebugWindow).__remotePlayers!.getPlayer(id)?.avatar.model === "barbarian", holderId, { timeout: 20_000 });
    // KayKit models are shown on the high tier only (the low tier keeps the placeholder in the palette colour), and only
    // by content that uses the rigged models (the sample content keeps the placeholder everywhere).
    const observer = await open(browser, "high");
    const rigged = await observer.evaluate(() => (window as unknown as { __riggedAvatars?: boolean }).__riggedAvatars === true);
    test.skip(!rigged, "the content under test shows placeholder avatars");
    const seen = (model: string) =>
      observer.waitForFunction(
        ([name, wanted]) => {
          const remote = (window as DebugWindow).__remotePlayers!;
          const found = remote.findByNickname(name);
          return found !== null && remote.getPlayer(found.playerId)?.loadedModel === wanted;
        },
        [holderName, model] as const,
        { timeout: 180_000 },
      );
    await seen("barbarian");
    await holder.evaluate(() => (window as DebugWindow).__networkClient!.sendAvatar({ model: "mage", color: 6 }));
    await seen("mage");
    // The holder's own client shows the same look (the pre-ADR-015 self/other mismatch is gone).
    expect(await holder.evaluate(() => (window as DebugWindow).__identity!().avatar)).toEqual({ model: "mage", color: 6 });
    await guest.waitForFunction((id) => (window as DebugWindow).__remotePlayers!.getPlayer(id)?.avatar.color === 6, holderId, { timeout: 20_000 });
    await observer.context().close();
  });

  test("on the low tier, the guest's placeholder accent is its palette colour", async () => {
    const result = await holder.evaluate(async (id) => {
      const modulePath = "/src/player/avatarPalette.ts";
      const palette = (await import(/* @vite-ignore */ modulePath)) as { avatarColorCss(color: number): string };
      const player = (window as DebugWindow).__remotePlayers!.getPlayer(id)!;
      return { accent: player.accentColor ? `#${player.accentColor.getHexString()}` : null, expected: palette.avatarColorCss(player.avatar.color) };
    }, guestId);
    expect(result.accent).toBe(result.expected);
  });
});
