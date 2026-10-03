import { test, expect, type ConsoleMessage, type Page } from "@playwright/test";

/**
 * CORE-001 acceptance tests, automated per the revision instructions.
 *
 * These read application state through the dev-only debug hooks exposed
 * by `apps/web/src/core/App.ts` (`window.__localPlayer`) rather than
 * pixel-diffing the canvas, which would be slow and flaky. See
 * `playwright.config.ts` for why this suite runs against the Vite dev
 * server (where those hooks are present) rather than a production
 * build.
 *
 * Camera orbit (pointer-lock-driven mouse look) is intentionally NOT
 * automated here — see tests/e2e/README.md for why, and the
 * corresponding MANUAL ACCEPTANCE TEST procedure.
 */

interface PlayerDebugState {
  position: { x: number; y: number; z: number };
}

declare global {
  interface Window {
    __localPlayer?: { position: { x: number; y: number; z: number } };
  }
}

async function readPlayerState(page: Page): Promise<PlayerDebugState> {
  return page.evaluate(() => {
    const player = window.__localPlayer;
    if (!player) throw new Error("window.__localPlayer debug hook not found — is this a DEV build?");
    return { position: { x: player.position.x, y: player.position.y, z: player.position.z } };
  });
}

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err: Error) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

test.describe("CORE-001 acceptance", () => {
  test("A — application loads without fatal console/page errors", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await page.goto("/");
    // `canvas[data-engine]` targets the Three.js render canvas specifically —
    // the dev-only stats.js panel (apps/web/src/ui/DebugStats.ts) also
    // contains several plain <canvas> elements for its FPS/MS/MB panels.
    await expect(page.locator("canvas[data-engine]")).toBeVisible();
    // Give the first few frames (asset-free, so this is fast) a moment to settle.
    await page.waitForTimeout(500);

    expect(errors, `Console/page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("B — player movement changes player position", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__localPlayer));

    const before = await readPlayerState(page);

    // Default camera yaw faces -Z, so holding W should decrease player.z.
    await page.keyboard.down("KeyW");
    await page.waitForTimeout(800);
    await page.keyboard.up("KeyW");
    // Let the velocity smoothing settle to zero so the position reading below is stable.
    await page.waitForTimeout(200);

    const after = await readPlayerState(page);

    expect(after.position.z).toBeLessThan(before.position.z - 0.5);
  });

  test("C — interaction prompt becomes visible near the project board", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__localPlayer));

    const prompt = page.locator(".zw-interaction-prompt");
    await expect(prompt).not.toHaveClass(/visible/);

    // Teleport next to the project board (apps/web/src/world/PrototypePlaza.ts
    // registers it at world position (7, 0, -3.5) with a 2.5m interaction
    // radius) instead of walking there — deterministic and fast.
    await page.evaluate(() => {
      window.__localPlayer!.position.x = 7;
      window.__localPlayer!.position.z = -3.5;
    });

    await expect(prompt).toHaveClass(/visible/);
    await expect(prompt).toContainText("View Projects");
  });

  test("D — pressing E opens the project panel", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__localPlayer));

    await page.evaluate(() => {
      window.__localPlayer!.position.x = 7;
      window.__localPlayer!.position.z = -3.5;
    });
    await expect(page.locator(".zw-interaction-prompt")).toHaveClass(/visible/);

    const panel = page.locator(".zw-modal-backdrop");
    await expect(panel).not.toHaveClass(/visible/);

    await page.keyboard.press("KeyE");

    await expect(panel).toHaveClass(/visible/);
    await expect(panel).toContainText("Builders Hall — Projects");
  });

  test("E — Esc closes the project panel", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__localPlayer));

    await page.evaluate(() => {
      window.__localPlayer!.position.x = 7;
      window.__localPlayer!.position.z = -3.5;
    });
    await page.keyboard.press("KeyE");

    const panel = page.locator(".zw-modal-backdrop");
    await expect(panel).toHaveClass(/visible/);

    await page.keyboard.press("Escape");

    await expect(panel).not.toHaveClass(/visible/);
  });

  test("F — window resize does not break the renderer", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__localPlayer));

    await page.setViewportSize({ width: 900, height: 550 });
    await page.waitForTimeout(300);

    const canvasSize = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>("canvas[data-engine]");
      if (!canvas) throw new Error("render canvas not found");
      return { clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight };
    });

    expect(canvasSize).toEqual({ clientWidth: 900, clientHeight: 550 });
    expect(errors, `Console/page errors after resize:\n${errors.join("\n")}`).toEqual([]);
  });
});
