import { test, expect, type ConsoleMessage, type Page } from "@playwright/test";

/**
 * CORE-005 §§ 31 (Tests 13, 14) and 32 (E2E A-I).
 *
 * Same dev-hook pattern as app.spec.ts/social.spec.ts: drive real
 * application state through `window.__localPlayer` (teleport instead of
 * walk — deterministic and fast) and the dev-only `window.__projectDiscoveryPanel`
 * hook (see App.ts), rather than pixel-diffing the canvas.
 *
 * Deliberately declares its own minimal `TestProject` shape below rather
 * than importing from `apps/web` — this file type-checks under the ROOT
 * tsconfig, which lacks `allowImportingTsExtensions` (same reasoning
 * social.spec.ts already documents for `SpawnablePlayerSummary`).
 */

interface TestProject {
  id: string;
  slug: string;
  name: string;
  shortDescription: string;
  description: string;
  category: string;
  status: string;
  tags: string[];
  featured: boolean;
  websiteUrl?: string;
  repositoryUrl?: string;
  socialUrl?: string;
}

declare global {
  interface Window {
    __localPlayer?: { position: { x: number; y: number; z: number } };
    __projectDiscoveryPanel?: {
      open: () => void;
      openProject: (projectId: string) => void;
      showDetailForTesting: (project: TestProject) => void;
      close: () => void;
      isOpen: boolean;
    };
  }
}

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err: Error) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

/** Teleports next to the project board (PrototypePlaza.ts: (7, 0, -3.5), 2.5m radius) and opens it with E. */
async function openDiscoveryViaBoard(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__localPlayer!.position.x = 7;
    window.__localPlayer!.position.z = -3.5;
  });
  await expect(page.locator(".zw-interaction-prompt")).toHaveClass(/visible/);
  await page.keyboard.press("KeyE");
  await expect(page.locator(".zw-modal-backdrop")).toHaveClass(/visible/);
}

test.describe("CORE-005 — project discovery", () => {
  test("A — open discovery panel through world/project interaction", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__localPlayer));

    await openDiscoveryViaBoard(page);
    await expect(page.locator(".zw-modal-backdrop")).toContainText("Builders Hall — Projects");

    expect(errors, `Console/page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("B — see multiple projects", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__localPlayer));
    await openDiscoveryViaBoard(page);

    const cards = page.locator(".zw-project-card-button");
    await expect(cards).toHaveCount(7); // fixture dataset: projectData.ts (CORE-005 § 8)
    await expect(cards.first()).toBeVisible();
  });

  test("C — search for a project", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__localPlayer));
    await openDiscoveryViaBoard(page);

    const search = page.locator(".zw-project-discovery-list-view .zw-input");
    await search.fill("ShieldKit");

    const cards = page.locator(".zw-project-card-button");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("ShieldKit");
  });

  test("D — filter by category or featured", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__localPlayer));
    await openDiscoveryViaBoard(page);

    await page.getByRole("button", { name: "Featured", exact: true }).click();
    const cards = page.locator(".zw-project-card-button");
    const featuredCount = await cards.count();
    expect(featuredCount).toBeGreaterThan(0);
    expect(featuredCount).toBeLessThan(7);

    // Search composes with the active filter (task brief § 18).
    const search = page.locator(".zw-project-discovery-list-view .zw-input");
    await search.fill("this-will-match-nothing-xyz");
    await expect(page.locator(".zw-project-discovery-cards")).toContainText("No projects match");
  });

  test("E/F — select a project; detail panel shows the correct project", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__localPlayer));
    await openDiscoveryViaBoard(page);

    const search = page.locator(".zw-project-discovery-list-view .zw-input");
    await search.fill("PrivatePay");
    await page.locator(".zw-project-card-button").first().click();

    await expect(page.locator(".zw-project-detail")).toBeVisible();
    await expect(page.locator(".zw-project-detail h2")).toHaveText("PrivatePay");
    await expect(page.locator(".zw-project-detail")).toContainText("Beta");
    await expect(page.locator(".zw-project-detail")).toContainText("Payments");
  });

  test("G — close detail and return to discovery", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__localPlayer));
    await openDiscoveryViaBoard(page);

    await page.locator(".zw-project-card-button").first().click();
    await expect(page.locator(".zw-project-detail")).toBeVisible();

    await page.getByRole("button", { name: "← Back to projects" }).click();

    await expect(page.locator(".zw-project-discovery-list-view")).toBeVisible();
    await expect(page.locator(".zw-project-detail")).toHaveClass(/zw-project-discovery-hidden/);

    // The board path still works after a full open/select/back cycle.
    await page.keyboard.press("Escape");
    await expect(page.locator(".zw-modal-backdrop")).not.toHaveClass(/visible/);
  });

  test("booth-direct path: interacting with a booth opens the correct project's detail view", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__localPlayer));

    // PrototypePlaza.ts projectBoothPlacements(): "zk-forge" booth at (16, 0, -6), default 2.2m radius.
    await page.evaluate(() => {
      window.__localPlayer!.position.x = 16;
      window.__localPlayer!.position.z = -6;
    });
    await expect(page.locator(".zw-interaction-prompt")).toHaveClass(/visible/);
    await expect(page.locator(".zw-interaction-prompt")).toContainText("ZK Forge");

    await page.keyboard.press("KeyE");

    await expect(page.locator(".zw-modal-backdrop")).toHaveClass(/visible/);
    await expect(page.locator(".zw-project-detail")).toBeVisible();
    await expect(page.locator(".zw-project-detail h2")).toHaveText("ZK Forge");
    // The list view underneath must be hidden, not just visually behind it.
    await expect(page.locator(".zw-project-discovery-list-view")).toHaveClass(/zw-project-discovery-hidden/);
  });

  test("H — existing player interaction (project board text) still works", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__localPlayer));

    await page.evaluate(() => {
      window.__localPlayer!.position.x = 7;
      window.__localPlayer!.position.z = -3.5;
    });
    await expect(page.locator(".zw-interaction-prompt")).toHaveClass(/visible/);
    await expect(page.locator(".zw-interaction-prompt")).toContainText("View Projects");
  });

  test("I — voice controls still exist and the app does not crash", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__localPlayer));

    await expect(page.locator(".zw-voice-controls")).toBeVisible();
    await openDiscoveryViaBoard(page);
    await page.keyboard.press("Escape");

    expect(errors, `Console/page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("Test 13 — project detail renders hostile project text safely (no injected <script>/<img onerror>)", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__projectDiscoveryPanel));

    const malicious: TestProject = {
      id: "xss-test",
      slug: "xss-test",
      name: '<img src=x onerror="window.__xssFired = true">',
      shortDescription: "<script>alert(1)</script>",
      description: "<script>alert(2)</script>",
      category: "other",
      status: "active",
      tags: ["<script>alert(3)</script>"],
      featured: false,
    };

    await page.evaluate((project) => {
      window.__projectDiscoveryPanel!.showDetailForTesting(project);
    }, malicious);

    const detail = page.locator(".zw-project-detail");
    await expect(detail).toBeVisible();
    await expect(detail.locator("h2")).toHaveText(malicious.name);

    const imgCount = await detail.evaluate((el) => el.querySelectorAll("img").length);
    expect(imgCount).toBe(0);
    const scriptCount = await detail.evaluate((el) => el.querySelectorAll("script").length);
    expect(scriptCount).toBe(0);

    const xssFired = await page.evaluate(() => (window as unknown as { __xssFired?: boolean }).__xssFired);
    expect(xssFired).toBeUndefined();
  });

  test("Test 14 — a project with no optional external URLs renders zero link buttons", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__projectDiscoveryPanel));

    // "lantern-relay" in projectData.ts has no websiteUrl/repositoryUrl/socialUrl.
    await page.evaluate(() => {
      window.__projectDiscoveryPanel!.openProject("lantern-relay");
    });

    await expect(page.locator(".zw-project-detail h2")).toHaveText("Lantern Relay");
    await expect(page.locator(".zw-project-detail-links")).toBeEmpty();
  });
});
