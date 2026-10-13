import { test, expect, type Browser, type Page } from "@playwright/test";

/**
 * Text chat between two real clients through the real
 * server: General reaches others (with a speech bubble), whispers reach
 * only the recipient, a blocked player's lines are hidden, and markup in
 * a message stays inert text.
 *
 * Other e2e tests share the same server, so every assertion looks for a
 * unique token rather than counting lines.
 */

type DevWindow = {
  __localPlayer?: unknown;
  __networkClient?: { sendNickname: (nickname: string) => void; connectionState: string; joined: boolean };
  __identity?: () => { nickname: string; canReceive: boolean };
  __remotePlayers?: { findByNickname: (nickname: string) => { playerId: string } | null };
  __socialStore?: { block: (playerId: string) => void };
};

const opened: Page[] = [];

async function joinAs(browser: Browser, nickname: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  opened.push(page);
  await page.goto("/?quality=low");
  await page.waitForFunction(() => (window as unknown as DevWindow).__networkClient?.joined === true, null, { timeout: 90_000 });
  // ADR-015: only wallet holders choose a name. Flip the participation gate (the wallet "reached ready"),
  // which App sends as set_wallet — then the name can be confirmed.
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
  await page.waitForFunction((name) => (window as unknown as DevWindow).__identity?.().nickname === name, nickname, { timeout: 15_000 });
  return page;
}

async function say(page: Page, text: string): Promise<void> {
  const input = page.locator(".zw-chat-input");
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

function line(page: Page, text: string) {
  return page.locator(".zw-chat-line", { hasText: text });
}

test.describe("Text chat", () => {
  // Several full clients per test on a software renderer: run these one at a time.
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);
  // Each client runs the whole world — close them so the next test isn't starved of CPU.
  test.afterEach(async () => {
    for (const page of opened.splice(0)) await page.context().close();
  });

  test("General chat reaches another player, with a bubble over the speaker", async ({ browser }) => {
    const id = Math.random().toString(36).slice(2, 7);
    const ada = await joinAs(browser, `Ada${id}`);
    const bob = await joinAs(browser, `Bob${id}`);
    const token = `hello-${id}`;
    await say(ada, token);
    await expect(line(bob, token)).toBeVisible({ timeout: 15_000 });
    await expect(line(bob, token)).toContainText(`Ada${id}`);
    await expect(line(ada, token)).toBeVisible(); // the sender sees the server's echo
    await expect(ada.locator(".zw-chat-bubble", { hasText: token })).toBeVisible(); // own bubble
  });

  test("Whispers reach only the recipient; /w and /r work", async ({ browser }) => {
    const id = Math.random().toString(36).slice(2, 7);
    const ada = await joinAs(browser, `Wa${id}`);
    const bob = await joinAs(browser, `Wb${id}`);
    const cem = await joinAs(browser, `Wc${id}`);
    await expect.poll(() => ada.evaluate((n) => Boolean((window as unknown as DevWindow).__remotePlayers?.findByNickname(n)), `Wb${id}`), { timeout: 15_000 }).toBe(true);

    const secret = `secret-${id}`;
    await say(ada, `/w Wb${id} ${secret}`);
    await expect(line(bob, secret)).toContainText(`Wa${id} whispers:`, { timeout: 15_000 });
    await expect(line(ada, secret)).toContainText(`To Wb${id}:`);
    const reply = `reply-${id}`;
    await say(bob, `/r ${reply}`);
    await expect(line(ada, reply)).toBeVisible({ timeout: 15_000 });
    await cem.waitForTimeout(1500);
    await expect(line(cem, secret)).toHaveCount(0);
    await expect(line(cem, reply)).toHaveCount(0);
  });

  test("Blocked players' lines are hidden, and markup stays text", async ({ browser }) => {
    const id = Math.random().toString(36).slice(2, 7);
    const ada = await joinAs(browser, `Ba${id}`);
    const bob = await joinAs(browser, `Bb${id}`);
    const hostile = `<img src=x onerror="window.__pwned=1">x-${id}`;
    await say(ada, hostile);
    await expect(line(bob, `x-${id}`)).toBeVisible({ timeout: 15_000 });
    expect(await bob.evaluate(() => (window as unknown as { __pwned?: number }).__pwned ?? 0)).toBe(0);
    await expect(bob.locator(".zw-chat-log img")).toHaveCount(0);

    await expect.poll(() => bob.evaluate((n) => Boolean((window as unknown as DevWindow).__remotePlayers?.findByNickname(n)), `Ba${id}`), { timeout: 15_000 }).toBe(true);
    await bob.evaluate((n) => {
      const w = window as unknown as DevWindow;
      w.__socialStore!.block(w.__remotePlayers!.findByNickname(n)!.playerId);
    }, `Ba${id}`);
    const after = `after-block-${id}`;
    await say(ada, after);
    await expect(line(ada, after)).toBeVisible({ timeout: 15_000 });
    await bob.waitForTimeout(1500);
    await expect(line(bob, after)).toHaveCount(0);
  });
});
