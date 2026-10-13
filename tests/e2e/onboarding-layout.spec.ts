import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * The onboarding dialog fits every common screen: no step's content may spill out of the card's frame.
 *
 * One page per device scale factor walks Welcome → wallet (with the wallet panel open) → character → name (the fee box,
 * then the confirmed status) → Enter, and at every step checks five window sizes — 1280×720, 1366×768, 1536×864 (a
 * 1920×1080 screen at 125 %), 1920×1080 and 2560×1440 — and three real browser viewports (1366×657, 1536×730,
 * 1280×600), plus 1536×864 and 1280×720 at device scale factor 1.25.
 *  - the card lies inside the viewport, and so do its pinned header (the steps) and footer (the buttons);
 *  - only the body scrolls, and nothing overflows sideways;
 *  - every step pill, every footer button and link stays on one line (pills may wrap as a group, never inside);
 *  - the character preview keeps its 4:5 shape and fits.
 * With E2E_SHOTS=<dir>, it also writes a PNG per step and size there.
 */

const SIZES = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  // Real browser viewports — a 1366×768 laptop (≈ 1366×657 inside Chrome), a 1920×1080 screen at
  // 125 % (≈ 1536×730) and a short 1280×600 window.
  { width: 1366, height: 657 },
  { width: 1536, height: 730 },
  { width: 1280, height: 600 },
] as const;
const HIDPI_SIZES = [
  { width: 1536, height: 864 },
  { width: 1280, height: 720 },
] as const;
const RUN = Math.random().toString(36).slice(2, 6);
const SHOTS = process.env.E2E_SHOTS ?? "";

test.use({ storageState: { cookies: [], origins: [] } });

interface Box {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

interface Layout {
  readonly viewport: { width: number; height: number };
  readonly card: Box;
  readonly head: Box | null;
  readonly footer: Box | null;
  readonly bodyOverflowX: boolean;
  readonly bodyScrollable: boolean;
  readonly bodyOverflowY: string;
  readonly multiLine: string[];
  readonly preview: { width: number; height: number } | null;
}

/** Measures the open onboarding card (or any `.zw-onb-card`-like selector) in the page. */
function measure(page: Page): Promise<Layout> {
  return page.evaluate(() => {
    const box = (element: Element | null) => {
      if (!element || (element as HTMLElement).offsetParent === null) return null;
      const r = element.getBoundingClientRect();
      return { top: r.top, left: r.left, bottom: r.bottom, right: r.right };
    };
    const card = document.querySelector(".zw-onboarding.visible .zw-onb-card")!;
    const body = card.querySelector(".zw-onb-body") as HTMLElement;
    const lineHeight = (element: HTMLElement) => Number.parseFloat(getComputedStyle(element).lineHeight) || Number.parseFloat(getComputedStyle(element).fontSize) * 1.3;
    const multiLine: string[] = [];
    const singleLine = [...card.querySelectorAll<HTMLElement>(".zw-onb-steps li, .zw-onb-footer .zw-onb-button, .zw-onb-footer .zw-onb-link, .zw-onb-model")].filter((element) => element.offsetParent !== null);
    for (const element of singleLine) {
      const style = getComputedStyle(element);
      const inner = element.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
      // A link may wrap as a whole onto its own row, but a button or pill must never break inside.
      if (!element.classList.contains("zw-onb-link") && inner > lineHeight(element) * 1.5) multiLine.push(`${element.className}: ${element.textContent}`);
      // …and never cut its label short with an ellipsis either.
      if (element.scrollWidth > element.clientWidth + 1) multiLine.push(`${element.className} (truncated): ${element.textContent}`);
    }
    const preview = card.querySelector<HTMLElement>(".zw-onb-preview");
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      card: box(card)!,
      head: box(card.querySelector(".zw-onb-head")),
      footer: box(card.querySelector(".zw-onb-footer")),
      bodyOverflowX: body.scrollWidth > body.clientWidth + 1,
      bodyScrollable: body.scrollHeight > body.clientHeight + 1,
      bodyOverflowY: getComputedStyle(body).overflowY,
      multiLine,
      preview: preview && preview.offsetParent !== null ? { width: preview.clientWidth, height: preview.clientHeight } : null,
    };
  });
}

function inside(box: Box, viewport: { width: number; height: number }): boolean {
  return box.top >= -0.5 && box.left >= -0.5 && box.bottom <= viewport.height + 0.5 && box.right <= viewport.width + 0.5;
}

async function checkAllSizes(page: Page, step: string, sizes: readonly { width: number; height: number }[], dpr: number): Promise<void> {
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.waitForTimeout(250); // a resize settles (layout + the turntable's next frame)
    const layout = await measure(page);
    const where = `${step} @ ${size.width}×${size.height} dpr ${dpr}`;
    expect(inside(layout.card, layout.viewport), `${where}: card ${JSON.stringify(layout.card)}`).toBe(true);
    if (layout.head) expect(inside(layout.head, layout.viewport), `${where}: header`).toBe(true);
    if (layout.footer) expect(inside(layout.footer, layout.viewport), `${where}: footer`).toBe(true);
    expect(layout.bodyOverflowX, `${where}: horizontal overflow`).toBe(false);
    expect(layout.bodyOverflowY, `${where}: only the body scrolls`).toBe("auto");
    expect(layout.multiLine, `${where}: broken lines`).toEqual([]);
    if (layout.preview) {
      expect(Math.abs(layout.preview.width / layout.preview.height - 0.8), `${where}: preview ratio ${JSON.stringify(layout.preview)}`).toBeLessThan(0.03);
      expect(layout.preview.height).toBeGreaterThanOrEqual(150);
    }
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/onb-${step}-${size.width}x${size.height}${dpr !== 1 ? `@${dpr}` : ""}.png` });
  }
}

async function becomeHolder(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // Paths in variables: Vite serves them; tsc must not try to resolve them (as chat.spec.ts does).
    const participationPath = "/src/zcash/participation.ts";
    const nameKeyPath = "/src/zcash/nameKey.ts";
    const participation = (await import(/* @vite-ignore */ participationPath)) as { updateParticipationState(status: string): void };
    const nameKey = (await import(/* @vite-ignore */ nameKeyPath)) as { activateNameKeyFromSeed(seed: Uint8Array, network: string): Promise<unknown> };
    await nameKey.activateNameKeyFromSeed(crypto.getRandomValues(new Uint8Array(64)), "test");
    participation.updateParticipationState("ready");
  });
}

/** The panel at `selector` lies inside the viewport and doesn't scroll sideways. */
async function panelFits(page: Page, selector: string): Promise<{ ok: boolean; detail: string }> {
  return page.evaluate((sel) => {
    const element = document.querySelector<HTMLElement>(sel);
    if (!element || element.offsetParent === null) return { ok: false, detail: `${sel} not visible` };
    const r = element.getBoundingClientRect();
    const ok = r.top >= -0.5 && r.left >= -0.5 && r.bottom <= window.innerHeight + 0.5 && r.right <= window.innerWidth + 0.5 && element.scrollWidth <= element.clientWidth + 1;
    return { ok, detail: `${sel} ${JSON.stringify({ top: r.top, left: r.left, bottom: r.bottom, right: r.right, vw: window.innerWidth, vh: window.innerHeight, sw: element.scrollWidth, cw: element.clientWidth })}` };
  }, selector);
}

async function walk(browser: Browser, dpr: number, sizes: readonly { width: number; height: number }[]): Promise<void> {
  const context: BrowserContext = await browser.newContext({ viewport: sizes[0], deviceScaleFactor: dpr, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto("/?quality=low");
    const dialog = page.locator(".zw-onboarding");
    await expect(dialog).toBeVisible({ timeout: 90_000 });
    await expect(dialog).toHaveAttribute("data-step", "welcome");
    await checkAllSizes(page, "1-welcome", sizes, dpr);

    await dialog.locator('[data-choice="wallet"]').click();
    await expect(dialog).toHaveAttribute("data-step", "wallet");
    await checkAllSizes(page, "2-wallet", sizes, dpr);
    // The wallet panel opens above onboarding (create / restore): it must fit too.
    await dialog.locator('[data-action="open-wallet"]').click();
    const walletPanel = page.locator(".zw-wallet-backdrop.visible .zw-wallet");
    await expect(walletPanel).toBeVisible();
    for (const size of sizes) {
      await page.setViewportSize(size);
      const fit = await panelFits(page, ".zw-wallet-backdrop.visible .zw-wallet");
      expect(fit.ok, fit.detail).toBe(true);
    }
    await page.locator(".zw-wallet-backdrop.visible .zw-wallet-header .zw-button").click(); // "Back"
    await expect(walletPanel).toBeHidden();

    await becomeHolder(page);
    await expect(dialog).toHaveAttribute("data-step", "character");
    if (SHOTS) await page.waitForTimeout(10_000); // the turntable's model loads (SwiftShader) before the screenshots
    await checkAllSizes(page, "3-character", sizes, dpr);
    await dialog.locator('[data-action="character-continue"]').click();

    await expect(dialog).toHaveAttribute("data-step", "nickname");
    const input = dialog.locator(".zw-onb-nickname");
    await input.fill(`Lay${RUN}${dpr === 1 ? "a" : "b"}`);
    await expect(dialog.locator(".zw-onb-status").first()).toHaveAttribute("data-check", "available", { timeout: 15_000 });
    await checkAllSizes(page, "4-name-fee", sizes, dpr);
    await dialog.locator('[data-action="nickname-continue"]').click();
    await expect(dialog.locator('[data-action="nickname-continue"]')).toHaveAttribute("data-state", "confirmed", { timeout: 30_000 });
    await checkAllSizes(page, "5-name-confirmed", sizes, dpr);
    await dialog.locator('[data-action="nickname-continue"]').click();

    await expect(dialog).toHaveAttribute("data-step", "enter");
    await expect(dialog.locator('[data-action="enter-world"]')).toBeEnabled({ timeout: 240_000 });
    await checkAllSizes(page, "6-enter", sizes, dpr);
    expect(errors, errors.join("\n")).toEqual([]);
  } finally {
    await context.close();
  }
}

test.describe("the onboarding dialog fits", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(600_000);

  test("every step at 1280×720 … 2560×1440: inside the viewport, pinned header and footer, only the body scrolls, no broken lines", async ({ browser }) => {
    await walk(browser, 1, SIZES);
  });

  test("the same at device scale factor 1.25 (1536×864, 1280×720)", async ({ browser }) => {
    await walk(browser, 1.25, HIDPI_SIZES);
  });
});
