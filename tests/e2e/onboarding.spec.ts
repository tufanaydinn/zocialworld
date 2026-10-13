import { test, expect, type Browser, type BrowserContext, type BrowserContextOptions, type ConsoleMessage, type Page } from "@playwright/test";

/**
 * ADR-015 § 7 — the start-of-game flow, from empty storage (the suite's default
 * `autoEnter: "guest"` seed is switched off here):
 *  - first visit as a guest: Welcome → Enter, a server-assigned Guest-#### name, the name control disabled;
 *  - first visit as a wallet holder (the participation gate is flipped, as watch-hall.spec.ts does):
 *    wallet → character → nickname (checked live) → Enter; a second client is told the name is taken;
 *  - a returning holder sees "Welcome back, <name>" with the inline unlock;
 *  - Escape never closes onboarding; no page errors along the way.
 */

type IdentityWindow = {
  __worldReady?: boolean;
  __networkClient?: { joined: boolean; connectionState: string };
  __identity?: () => { nickname: string; canReceive: boolean; avatar: { model: string; color: number } | null };
};

test.use({ storageState: { cookies: [], origins: [] } });

const RUN = Math.random().toString(36).slice(2, 6);
const opened: BrowserContext[] = [];

/** Page errors and console errors — minus the browser's own network-panel lines for failed fetches (the content gateway can't reach the internet here). */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text());
  });
  return errors;
}

async function open(browser: Browser, storageState?: BrowserContextOptions["storageState"]): Promise<Page> {
  const context = await browser.newContext(storageState ? { storageState } : {});
  opened.push(context);
  const page = await context.newPage();
  await page.goto("/?quality=low");
  await expect(page.locator(".zw-onboarding")).toBeVisible({ timeout: 90_000 });
  return page;
}

/**
 * What a wallet reaching ready does to the client: participation's sticky holder flag, and (ADR-016) the name key the
 * wallet derives from its seed — here a random test key (no real wallet needed).
 */
async function becomeHolder(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const modulePath = "/src/zcash/participation.ts";
    const nameKeyPath = "/src/zcash/nameKey.ts";
    const participation = (await import(/* @vite-ignore */ modulePath)) as { updateParticipationState(status: string): void };
    const nameKey = (await import(/* @vite-ignore */ nameKeyPath)) as { activateNameKeyFromSeed(seed: Uint8Array, network: string): Promise<unknown> };
    await nameKey.activateNameKeyFromSeed(crypto.getRandomValues(new Uint8Array(64)), "test");
    participation.updateParticipationState("ready");
  });
}

test.describe("onboarding (ADR-015)", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(300_000);
  test.afterEach(async () => {
    for (const context of opened.splice(0)) await context.close();
  });

  test("first visit as a guest: Welcome → Enter gives a Guest-#### name; the name control is disabled; Esc does not close onboarding", async ({ browser }) => {
    const page = await open(browser);
    const errors = collectErrors(page);
    const dialog = page.locator(".zw-onboarding");
    await expect(dialog).toHaveAttribute("role", "dialog");
    await expect(dialog).toContainText("TESTNET");
    await expect(dialog.locator('[data-choice="wallet"]')).toContainText("Connect a wallet");
    expect(await page.evaluate(() => (window as IdentityWindow).__networkClient?.joined)).toBe(false); // nobody sees us yet

    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("data-step", "welcome");

    await dialog.locator('[data-choice="guest"]').click();
    await expect(dialog).toHaveAttribute("data-step", "enter");
    const enter = dialog.locator('[data-action="enter-world"]');
    await expect(enter).toBeEnabled({ timeout: 240_000 }); // waits for the world (worldReadyAndWarm)
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await enter.click();
    await expect(dialog).toBeHidden();
    await page.waitForFunction(() => (window as IdentityWindow).__networkClient?.joined === true, null, { timeout: 30_000 });
    const identity = await page.evaluate(() => (window as IdentityWindow).__identity!());
    expect(identity.nickname).toMatch(/^Guest-\d{4}$/);
    expect(identity.canReceive).toBe(false);

    const controls = page.locator(".zw-nickname-controls");
    await expect(controls.locator("input")).toHaveAttribute("readonly", "");
    await expect(controls.getByRole("button", { name: "Connect a wallet to choose a name" })).toBeVisible();
    await expect(page.locator(".zw-voice-controls .zw-button-primary")).toHaveText("Listen to voices (guests can't talk)");
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("first visit as a wallet holder: wallet → character → nickname → Enter; a second client is told the name is taken", async ({ browser }) => {
    const name = `Ana${RUN}`;
    const ana = await open(browser);
    const errors = collectErrors(ana);
    const dialog = ana.locator(".zw-onboarding");
    await dialog.locator('[data-choice="wallet"]').click();
    await expect(dialog).toHaveAttribute("data-step", "wallet");
    await expect(dialog).toContainText("Continue as guest instead");
    await becomeHolder(ana); // the wallet reached ready
    await expect(dialog).toHaveAttribute("data-step", "character");
    await dialog.locator('.zw-onb-model[data-model="knight"]').click();
    await dialog.locator('.zw-onb-swatch[data-color="6"]').click();
    await expect(dialog.locator('.zw-onb-model[data-model="knight"]')).toHaveAttribute("aria-checked", "true");
    // Arrow keys move inside the radio group.
    await dialog.locator('.zw-onb-model[data-model="knight"]').focus();
    await ana.keyboard.press("ArrowRight");
    await expect(dialog.locator('.zw-onb-model[data-model="mage"]')).toHaveAttribute("aria-checked", "true");
    await ana.keyboard.press("ArrowLeft");
    await expect(dialog.locator('.zw-onb-model[data-model="knight"]')).toHaveAttribute("aria-checked", "true");
    await dialog.locator('[data-action="character-continue"]').click();

    await expect(dialog).toHaveAttribute("data-step", "nickname");
    await expect(dialog).toContainText("Your name is public. It is never linked to your wallet address.");
    const input = dialog.locator(".zw-onb-nickname");
    await input.fill("Guest-1234");
    await expect(dialog.locator(".zw-onb-status").first()).toContainText("reserved");
    await expect(dialog.locator('[data-action="nickname-continue"]')).toBeDisabled();
    await input.fill(name);
    await expect(dialog.locator(".zw-onb-status").first()).toHaveAttribute("data-check", "available", { timeout: 15_000 });
    // ADR-016: the test server's DEV registry — "Confirm & pay" confirms before the join (nothing is paid), then Continue.
    await dialog.locator('[data-action="nickname-continue"]').click();
    await expect(dialog.locator('[data-action="nickname-continue"]')).toHaveAttribute("data-state", "confirmed", { timeout: 30_000 });
    await dialog.locator('[data-action="nickname-continue"]').click();
    const enter = dialog.locator('[data-action="enter-world"]');
    await expect(enter).toBeEnabled({ timeout: 240_000 });
    await enter.click();
    await expect(dialog).toBeHidden();
    await ana.waitForFunction((wanted) => (window as IdentityWindow).__identity?.().nickname === wanted, name, { timeout: 30_000 });
    const identity = await ana.evaluate(() => (window as IdentityWindow).__identity!());
    expect(identity.canReceive).toBe(true);
    expect(identity.avatar).toEqual({ model: "knight", color: 6 });
    await expect(ana.locator(".zw-nickname-controls").getByRole("button", { name: "Set" })).toBeVisible();

    // A second visitor asks for the same name (any case): taken, with the server's suggestion.
    const ben = await open(browser);
    const benDialog = ben.locator(".zw-onboarding");
    await benDialog.locator('[data-choice="wallet"]').click();
    await becomeHolder(ben);
    await benDialog.locator('[data-action="character-continue"]').click();
    await benDialog.locator(".zw-onb-nickname").fill(name.toLowerCase());
    await expect(benDialog.locator(".zw-onb-status").first()).toHaveAttribute("data-check", "taken", { timeout: 15_000 });
    await expect(benDialog.locator(".zw-onb-status").first()).toContainText(`${name.toLowerCase()}-2 is free`);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("a returning wallet holder sees 'Welcome back, <name>' with the inline unlock, and can enter now as a guest", async ({ browser }) => {
    const origin = new URL(test.info().project.use.baseURL ?? "http://127.0.0.1:5173").origin;
    const page = await open(browser, {
      cookies: [],
      origins: [
        {
          origin,
          localStorage: [
            { name: "player-profile-v1", value: JSON.stringify({ v: 1, lastMode: "holder", avatar: { model: "mage", color: 2 }, nickname: `Cem${RUN}` }) },
            // A locked wallet on this device (presence is what the wallet checks at startup; it is never unlocked here).
            { name: "zw.wallet.seed.v1", value: JSON.stringify({ test: true }) },
          ],
        },
      ],
    });
    const dialog = page.locator(".zw-onboarding");
    await expect(dialog).toHaveAttribute("data-step", "returning");
    await expect(dialog.locator(".zw-onb-title")).toHaveText(`Welcome back, Cem${RUN}`);
    await expect(dialog.locator('[data-action="unlock"]')).toHaveText(`Unlock & enter as Cem${RUN}`);
    await expect(dialog.locator('input[type="password"]')).toBeVisible();
    await expect(dialog).toContainText("Change character");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-action="enter-later"]').click();
    await expect(dialog).toBeHidden();
    await page.waitForFunction(() => (window as IdentityWindow).__networkClient?.joined === true, null, { timeout: 60_000 });
    const identity = await page.evaluate(() => (window as IdentityWindow).__identity!());
    expect(identity.nickname).toMatch(/^Guest-\d{4}$/);
    expect(identity.canReceive).toBe(false);
    // The remembered name stays on this device for next time (never sent while a guest).
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem("player-profile-v1"))) ?? "{}").nickname).toBe(`Cem${RUN}`);
  });
});
