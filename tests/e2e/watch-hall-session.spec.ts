import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ANCHOR, cameraPoseToward, standAtAnchor } from "./support/anchors.ts";

/**
 * Watch Hall reaction sessions and panel layout, against the default server (no LiveKit):
 *
 *  - Reaction sessions: the Discussion Corner counter resets with every stage turn. A takes the stage → both boards
 *    show "This session" from zero; reactions from both add up to the same server totals on both clients; A stops →
 *    "Last session" with the totals kept (idle reactions don't change them); A takes the stage again → zero.
 *  - Layout: the Watch panel, the stage widget and the speaker card stay inside the window at 1280×720 … 2560×1440.
 *
 * In the single-worker `hall` project (the file name matches HALL_SPECS): it uses the server's one stage.
 * The e2e server runs the DEV name registry, so presenting needs an owned name (ADR-015/016
 * amendments): A unlocks a wallet and confirms a name before taking the stage; B stays a guest.
 * E2E_SHOTS=<dir> writes screenshots of the board and the panels.
 */

type HallWindow = {
  __worldReady?: boolean;
  __networkClient?: { joined: boolean; sendHall(message: unknown): void };
  __hallStore?: { member: boolean; amHolder: boolean; localPlayerId: string | null; reactionSession: { id: number; active: boolean }; reactionTotals: Record<string, number>; stage: { holder: string | null; card: unknown } };
  __hallBoards?: { snapshot(): { discussion: { tally: { label: string; counts: Record<string, number>; session: number }; tallyText: string } | null } };
  __localPlayer?: { position: { set(x: number, y: number, z: number): void } };
  __identity?: () => { nickname: string };
  __setPhotoCamera?: (pose: { position: [number, number, number]; target: [number, number, number]; fov?: number } | null) => void;
};

const SIZES = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
] as const;
const SHOTS = process.env.E2E_SHOTS ?? "";
const RUN = Math.random().toString(36).slice(2, 6);

const contexts: BrowserContext[] = [];

/** A wallet holder with an owned name from the DEV registry — what the stage needs on this server. */
async function confirmName(page: Page, name: string): Promise<void> {
  await page.evaluate(async (nickname) => {
    const participationPath = "/src/zcash/participation.ts";
    const participation = (await import(/* @vite-ignore */ participationPath)) as { updateParticipationState(status: string): void };
    participation.updateParticipationState("ready");
    const nameKeyPath = "/src/zcash/nameKey.ts";
    const nameKey = (await import(/* @vite-ignore */ nameKeyPath)) as { activateNameKeyFromSeed(seed: Uint8Array, network: string): Promise<unknown> };
    await nameKey.activateNameKeyFromSeed(crypto.getRandomValues(new Uint8Array(64)), "test");
    await (window as unknown as { __confirmName(nickname: string): Promise<void> }).__confirmName(nickname);
  }, name);
  await page.waitForFunction((nickname) => (window as HallWindow).__identity?.().nickname === nickname, name, { timeout: 30_000 });
}

async function openClient(browser: Browser, name?: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto("/?quality=low");
  await page.waitForFunction(() => (window as HallWindow).__worldReady === true, null, { timeout: 240_000 });
  await page.waitForFunction(() => (window as HallWindow).__networkClient?.joined === true, null, { timeout: 60_000 });
  if (name) await confirmName(page, name);
  await standAtAnchor(page, ANCHOR.hallFloor, { x: 3 });
  await page.waitForFunction(() => (window as HallWindow).__hallStore?.member === true, null, { timeout: 30_000 });
  return page;
}

const send = (page: Page, message: unknown) => page.evaluate((m) => (window as HallWindow).__networkClient!.sendHall(m), message);
const session = (page: Page) => page.evaluate(() => ({ ...(window as HallWindow).__hallStore!.reactionSession, totals: { ...(window as HallWindow).__hallStore!.reactionTotals } }));
const tally = (page: Page) => page.evaluate(() => (window as HallWindow).__hallBoards!.snapshot().discussion?.tallyText ?? "");

async function react(page: Page, reactions: string[]): Promise<void> {
  for (const reaction of reactions) await send(page, { type: "hall_react", reaction });
}

async function panelFits(page: Page, selector: string): Promise<{ ok: boolean; detail: string }> {
  return page.evaluate((sel) => {
    const element = document.querySelector<HTMLElement>(sel);
    if (!element || element.offsetParent === null) return { ok: false, detail: `${sel} not visible` };
    const r = element.getBoundingClientRect();
    const ok = r.top >= -0.5 && r.left >= -0.5 && r.bottom <= window.innerHeight + 0.5 && r.right <= window.innerWidth + 0.5 && element.scrollWidth <= element.clientWidth + 1;
    return { ok, detail: `${sel} ${JSON.stringify({ top: r.top, left: r.left, bottom: r.bottom, right: r.right, vw: window.innerWidth, vh: window.innerHeight, sw: element.scrollWidth, cw: element.clientWidth })}` };
  }, selector);
}

test.describe("Watch Hall: per-session reactions and panel layout", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(600_000);
  let a: Page;
  let b: Page;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(600_000);
    a = await openClient(browser, `Pia${RUN}`);
    b = await openClient(browser);
  });

  test.afterAll(async () => {
    for (const context of contexts.splice(0)) await context.close().catch(() => undefined);
  });

  test("the reaction counter resets with every stage turn; 'Last session' while idle; both clients show the same numbers", async () => {
    // A turn starts: a new session from zero on both clients.
    const before = (await session(a)).id;
    await send(a, { type: "hall_stage_request" });
    await a.waitForFunction(() => (window as HallWindow).__hallStore!.amHolder, null, { timeout: 10_000 });
    for (const page of [a, b]) {
      await expect.poll(() => session(page)).toEqual({ id: before + 1, active: true, totals: {} });
      await expect.poll(() => tally(page)).toBe("This session: no reactions yet");
    }
    // Reactions from both players add up to the same server totals everywhere.
    await react(b, ["clap", "clap", "clap", "heart"]);
    await react(a, ["clap", "zec"]);
    for (const page of [a, b]) {
      await expect.poll(() => session(page)).toEqual({ id: before + 1, active: true, totals: { clap: 4, heart: 1, zec: 1 } });
      await expect.poll(() => tally(page)).toBe("This session: 👏 4 ❤️ 1 Ƶ 1");
    }
    if (SHOTS) {
      await b.setViewportSize({ width: 1600, height: 900 });
      const pose = await cameraPoseToward(b, ANCHOR.hallDiscussionBoard, ANCHOR.hallFloor, 9, 1, 48);
      await b.evaluate((p) => (window as HallWindow).__setPhotoCamera!(p), pose);
      await b.waitForTimeout(2500); // the board redraws at most once a second
      await b.screenshot({ path: `${SHOTS}/discussion-this-session.png` });
    }

    // The turn ends: the totals stay, labelled "Last session"; reactions while idle don't change them.
    await send(a, { type: "hall_stage_stop" });
    for (const page of [a, b]) await expect.poll(() => tally(page)).toBe("Last session: 👏 4 ❤️ 1 Ƶ 1");
    await react(b, ["fire", "fire"]);
    await b.waitForTimeout(1500);
    expect(await tally(a)).toBe("Last session: 👏 4 ❤️ 1 Ƶ 1");
    expect(await tally(b)).toBe("Last session: 👏 4 ❤️ 1 Ƶ 1");
    if (SHOTS) {
      await b.waitForTimeout(1000);
      await b.screenshot({ path: `${SHOTS}/discussion-last-session.png` });
    }

    // The next turn starts from zero again.
    await send(a, { type: "hall_stage_request" });
    for (const page of [a, b]) await expect.poll(() => tally(page)).toBe("This session: no reactions yet");
    expect((await session(b)).id).toBe(before + 2);
    await send(a, { type: "hall_stage_stop" });
    await b.evaluate(() => (window as HallWindow).__setPhotoCamera!(null));
    await b.setViewportSize({ width: 1280, height: 720 });
  });

  test("the Watch panel, the stage widget and the speaker card fit 1280×720 … 2560×1440", async () => {
    await expect(a.locator(".zw-stage-widget")).toBeVisible();
    for (const size of SIZES) {
      await a.setViewportSize(size);
      await a.waitForTimeout(200);
      const fit = await panelFits(a, ".zw-stage-widget");
      expect(fit.ok, fit.detail).toBe(true);
    }
    await a.setViewportSize(SIZES[0]);
    await a.locator(".zw-action", { hasText: "Watch" }).click();
    await expect(a.locator(".zw-watch")).toBeVisible();
    for (const size of SIZES) {
      await a.setViewportSize(size);
      const fit = await panelFits(a, ".zw-watch");
      expect(fit.ok, fit.detail).toBe(true);
    }
    await a.keyboard.press("Escape");
    await expect(a.locator(".zw-watch")).toBeHidden();

    await a.setViewportSize(SIZES[0]);
    await send(a, { type: "hall_stage_request" });
    await a.waitForFunction(() => (window as HallWindow).__hallStore!.amHolder, null, { timeout: 10_000 });
    await send(a, {
      type: "hall_stage_card",
      card: { title: "A long presentation title that tests how the card wraps on every screen size", speaker: "Speaker Name", project: "Project", links: [{ kind: "github", url: "https://github.com/zcash/zcash" }, { kind: "docs", url: "https://zcash.readthedocs.io/en/latest/" }] },
    });
    await a.waitForFunction(() => (window as HallWindow).__hallStore!.stage.card !== null, null, { timeout: 10_000 });
    // The "Now on stage" chip hides on viewports up to 820 px tall while the stage panel is open.
    await a.setViewportSize(SIZES[3]);
    await a.locator(".zw-now-on-stage.visible").click();
    const card = ".zw-speaker-card-backdrop.visible .zw-speaker-card";
    await expect(a.locator(card)).toBeVisible();
    for (const size of SIZES) {
      await a.setViewportSize(size);
      const fit = await panelFits(a, card);
      expect(fit.ok, fit.detail).toBe(true);
    }
    await a.keyboard.press("Escape");
    await send(a, { type: "hall_stage_stop" });
  });
});
