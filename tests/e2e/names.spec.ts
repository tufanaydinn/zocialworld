import { test, expect, type Browser, type BrowserContext, type BrowserContextOptions, type ConsoleMessage, type Page } from "@playwright/test";

/**
 * ADR-016 — fee-confirmed owned names, end to end against the test server's DEV registry
 * (playwright.config.ts starts it with NAME_REGISTRY=dev: every reservation is "paid" and confirmed after ~2 s, and
 * its quote carries a placeholder address the client never pays):
 *  - a wallet holder confirms a name in onboarding through the fee step (Confirm & pay → pending → seen →
 *    confirmed), before joining, and enters with it;
 *  - a second visitor is told the name is taken — even when it tries to confirm it (its claim fails: other key);
 *  - the returning player (same storage, same wallet seed) gets the name back by a signed claim, without paying.
 * No real wallet: the participation gate is flipped and a test name key is derived from a fixed test seed through
 * the same module the wallet uses at unlock (apps/web/src/zcash/nameKey.ts).
 */

type IdentityWindow = {
  __networkClient?: { joined: boolean };
  __identity?: () => { nickname: string; canReceive: boolean };
};

test.use({ storageState: { cookies: [], origins: [] } });

const RUN = Math.random().toString(36).slice(2, 6);
const NAME = `Zed${RUN}`;
/** Two test wallets' BIP-39 seeds (64 bytes, hex) — a fixed seed per run, so the returning player has the same key. */
const SEED_A = Array.from({ length: 64 }, (_, i) => ((i * 7 + RUN.charCodeAt(i % 4)) & 0xff).toString(16).padStart(2, "0")).join("");
const SEED_B = Array.from({ length: 64 }, (_, i) => ((i * 13 + 5 + RUN.charCodeAt(i % 4)) & 0xff).toString(16).padStart(2, "0")).join("");
const opened: BrowserContext[] = [];
let savedStorage: Awaited<ReturnType<BrowserContext["storageState"]>> | null = null;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text());
  });
  return errors;
}

/** Frames this page sent and received, as parsed JSON. */
function recordFrames(page: Page): { sent: Record<string, unknown>[]; received: Record<string, unknown>[] } {
  const frames = { sent: [] as Record<string, unknown>[], received: [] as Record<string, unknown>[] };
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => frames.sent.push(JSON.parse(String(payload)) as Record<string, unknown>));
    socket.on("framereceived", ({ payload }) => frames.received.push(JSON.parse(String(payload)) as Record<string, unknown>));
  });
  return frames;
}

async function open(browser: Browser, storageState?: BrowserContextOptions["storageState"]): Promise<Page> {
  const context = await browser.newContext(storageState ? { storageState } : {});
  opened.push(context);
  const page = await context.newPage();
  return page;
}

/** What a wallet reaching ready does: the sticky holder flag, and the name key derived from the seed. */
async function unlockTestWallet(page: Page, seedHex: string): Promise<void> {
  await page.evaluate(async (hex) => {
    const participationPath = "/src/zcash/participation.ts";
    const nameKeyPath = "/src/zcash/nameKey.ts";
    const participation = (await import(/* @vite-ignore */ participationPath)) as { updateParticipationState(status: string): void };
    const nameKey = (await import(/* @vite-ignore */ nameKeyPath)) as { activateNameKeyFromSeed(seed: Uint8Array, network: string): Promise<unknown> };
    await nameKey.activateNameKeyFromSeed(Uint8Array.from(hex.match(/../g)!.map((byte) => parseInt(byte, 16))), "test");
    participation.updateParticipationState("ready");
  }, seedHex);
}

/** Records every data-step the confirmation slot passes through (the dev registry moves fast). */
async function recordSteps(page: Page): Promise<void> {
  await page.evaluate(() => {
    const steps: string[] = [];
    (window as unknown as { __confirmSteps: string[] }).__confirmSteps = steps;
    new MutationObserver(() => {
      const slot = document.querySelector<HTMLElement>(".zw-onb-confirm");
      const step = slot && !slot.hidden ? (slot.dataset.step ?? "") : "";
      if (step && steps.at(-1) !== step) steps.push(step);
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-step", "hidden"] });
  });
}

test.describe("fee-confirmed names (ADR-016, dev registry)", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(300_000);
  test.afterEach(async () => {
    for (const context of opened.splice(0)) await context.close();
  });

  test("a holder confirms a name in onboarding through the fee step (Confirm & pay → pending → seen → confirmed) and enters with it", async ({ browser }) => {
    const page = await open(browser);
    const errors = collectErrors(page);
    const frames = recordFrames(page);
    await page.goto("/?quality=low");
    const dialog = page.locator(".zw-onboarding");
    await expect(dialog).toBeVisible({ timeout: 90_000 });
    await dialog.locator('[data-choice="wallet"]').click();
    await unlockTestWallet(page, SEED_A);
    await expect(dialog).toHaveAttribute("data-step", "character");
    await dialog.locator('.zw-onb-model[data-model="mage"]').click();
    await dialog.locator('[data-action="character-continue"]').click();
    await expect(dialog).toHaveAttribute("data-step", "nickname");

    // The fee step: the fee, why, no refunds — and never an address.
    const confirm = dialog.locator('[data-action="nickname-continue"]');
    await expect(confirm).toHaveText("Confirm & pay", { timeout: 30_000 });
    await expect(dialog.locator(".zw-onb-fee")).toContainText("Confirm with a small fee: 0.01 TAZ + network fee");
    await expect(dialog.locator(".zw-onb-fee")).toContainText("stops bots");
    await expect(dialog.locator(".zw-onb-fee")).toContainText("no refunds");
    await dialog.locator(".zw-onb-nickname").fill(NAME);
    await expect(dialog.locator(".zw-onb-status").first()).toHaveAttribute("data-check", "available", { timeout: 15_000 });
    await recordSteps(page);
    await confirm.click();
    await expect(dialog.locator(".zw-onb-confirm")).toHaveAttribute("data-phase", "done", { timeout: 30_000 });
    await expect(dialog.locator(".zw-onb-confirm")).toContainText(`${NAME} is yours`);
    const steps = await page.evaluate(() => (window as unknown as { __confirmSteps: string[] }).__confirmSteps);
    expect(steps).toEqual(expect.arrayContaining(["reserving", "pending", "seen", "confirmed"]));
    expect(await page.evaluate(() => (window as IdentityWindow).__networkClient?.joined)).toBe(false); // confirmed before the join
    expect(await dialog.textContent()).not.toMatch(/uregtest|zw-dev-registry/);

    await expect(confirm).toHaveText("Continue");
    await confirm.click();
    await expect(dialog).toHaveAttribute("data-step", "enter");
    await expect(dialog).toContainText("Name confirmed");
    const enter = dialog.locator('[data-action="enter-world"]');
    await expect(enter).toBeEnabled({ timeout: 240_000 });
    await enter.click();
    await page.waitForFunction((wanted) => (window as IdentityWindow).__identity?.().nickname === wanted, NAME, { timeout: 30_000 });

    // The quote went to this client only and named the dev placeholder (never paid); the reservation was made once.
    const quotes = frames.received.filter((frame) => frame.type === "name_quote");
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.address).toBe("zw-dev-registry");
    expect(quotes[0]!.memo).toMatch(/^zw-name:v1:[0-9a-f]{32}:[0-9a-f]{16}$/);
    expect(frames.sent.filter((frame) => frame.type === "name_reserve")).toHaveLength(1);
    expect(frames.sent.some((frame) => frame.type === "set_nickname")).toBe(false);
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem("player-profile-v1"))) ?? "{}").nickname).toBe(NAME);
    savedStorage = await page.context().storageState();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("a second visitor is told the name is taken — and confirming it anyway fails (its key is not the owner's)", async ({ browser }) => {
    const page = await open(browser);
    const frames = recordFrames(page);
    await page.goto("/?quality=low");
    const dialog = page.locator(".zw-onboarding");
    await expect(dialog).toBeVisible({ timeout: 90_000 });
    await dialog.locator('[data-choice="wallet"]').click();
    await unlockTestWallet(page, SEED_B);
    await dialog.locator('[data-action="character-continue"]').click();
    await expect(dialog.locator('[data-action="nickname-continue"]')).toHaveText("Confirm & pay", { timeout: 30_000 });
    await dialog.locator(".zw-onb-nickname").fill(NAME.toUpperCase());
    await expect(dialog.locator(".zw-onb-status").first()).toHaveAttribute("data-check", "taken", { timeout: 15_000 });
    await dialog.locator('[data-action="nickname-continue"]').click();
    await expect(dialog.locator(".zw-onb-confirm")).toHaveAttribute("data-step", "taken", { timeout: 30_000 });
    await expect(dialog.locator(".zw-onb-confirm")).toContainText("is taken");
    expect(frames.received.some((frame) => frame.type === "name_quote")).toBe(false);
    expect(frames.sent.some((frame) => frame.type === "name_claim_proof")).toBe(true); // it tried — the server said no
  });

  test("the returning player (same storage, same wallet) gets the name back by a signed claim — no payment", async ({ browser }) => {
    expect(savedStorage, "the first test saved its storage").not.toBeNull();
    const origin = new URL(test.info().project.use.baseURL ?? "http://127.0.0.1:5173").origin;
    const storage = {
      cookies: [],
      origins: [
        {
          origin,
          localStorage: [
            ...(savedStorage!.origins.find((entry) => entry.origin === origin)?.localStorage ?? []),
            // A locked wallet on this device (what the wallet checks at startup); "unlocking" it is simulated below.
            { name: "zw.wallet.seed.v1", value: JSON.stringify({ test: true }) },
          ],
        },
      ],
    };
    const page = await open(browser, storage);
    const errors = collectErrors(page);
    const frames = recordFrames(page);
    await page.goto("/?quality=low");
    const dialog = page.locator(".zw-onboarding");
    await expect(dialog).toHaveAttribute("data-step", "returning", { timeout: 90_000 });
    await expect(dialog.locator(".zw-onb-title")).toHaveText(`Welcome back, ${NAME}`);
    await unlockTestWallet(page, SEED_A); // the same seed → the same name key
    await expect(dialog).toContainText(`${NAME} is yours`, { timeout: 30_000 });
    await expect(dialog.locator(".zw-onb-title")).toHaveText(`Welcome back, ${NAME}`);
    await dialog.locator('[data-action="enter-holder"]').click();
    const enter = dialog.locator('[data-action="enter-world"]');
    await expect(enter).toBeEnabled({ timeout: 240_000 });
    await enter.click();
    await page.waitForFunction((wanted) => (window as IdentityWindow).__identity?.().nickname === wanted, NAME, { timeout: 30_000 });
    expect(frames.sent.some((frame) => frame.type === "name_reserve")).toBe(false); // never reserved, never quoted: nothing to pay
    expect(frames.received.some((frame) => frame.type === "name_quote")).toBe(false);
    expect(frames.sent.filter((frame) => frame.type === "name_claim_proof")).toHaveLength(1);
    const welcome = frames.received.find((frame) => frame.type === "welcome");
    expect(welcome?.nickname).toBe(NAME); // claimed before the join: the welcome already carries it
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
