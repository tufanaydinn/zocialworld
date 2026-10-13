import { test, expect } from "@playwright/test";

/**
 * The in-game Community Hub (ZecHub bounties/wiki, forum,
 * GitHub). These tests do not depend on the upstream sites being
 * reachable: the panel must open/close regardless (showing a retry state
 * when the content gateway can't reach a source), and the sanitizer that
 * renders third-party HTML is exercised directly with hostile input.
 */

declare global {
  interface Window {
    __localPlayer?: { position: { x: number; y: number; z: number } };
  }
}

test.describe("Community Hub", () => {
  test("opens from the action bar and closes with Esc", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__localPlayer));

    const panel = page.locator(".zw-community-backdrop");
    await expect(panel).not.toHaveClass(/visible/);
    await page.locator(".zw-action", { hasText: "Community" }).click();
    await expect(panel).toHaveClass(/visible/);
    await expect(panel).toContainText("Bounties");
    await expect(panel).toContainText("Open Source");

    await page.keyboard.press("Escape");
    await expect(panel).not.toHaveClass(/visible/);
  });

  test("Z.cash Learn tab lists articles as explicit new-tab links to z.cash", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__localPlayer));
    await page.locator(".zw-action", { hasText: "Community" }).click();
    const panel = page.locator(".zw-community-backdrop");
    await expect(panel).toContainText("Forum & Grants");
    await panel.locator(".zw-community-tab", { hasText: "Z.cash Learn" }).click();
    const cards = panel.locator("a.zw-external-card");
    await expect(cards.first()).toBeVisible({ timeout: 20000 });
    expect(await cards.count()).toBeGreaterThanOrEqual(20);
    const links = await cards.evaluateAll((anchors) => anchors.map((a) => ({ href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel") })));
    for (const link of links) {
      expect(link.href).toMatch(/^https:\/\/z\.cash\/learn\/[a-z0-9-]+\/$/);
      expect(link.target).toBe("_blank");
      expect(link.rel).toContain("noopener");
    }
  });

  test("third-party HTML is sanitized: no scripts, handlers, remote media or non-https links", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__localPlayer));

    const result = await page.evaluate(async () => {
      const modulePath = "/src/community/safeHtml.ts";
      const { sanitizeHtml, renderMarkdown } = (await import(/* @vite-ignore */ modulePath)) as {
        sanitizeHtml: (html: string) => string;
        renderMarkdown: (markdown: string) => string;
      };
      const hostile =
        '<p>hi</p><script>window.__pwned=1</script><img src="https://tracker.example/p.gif" onerror="window.__pwned=2">' +
        '<a href="javascript:window.__pwned=3">x</a><a href="https://zechub.wiki">ok</a><iframe src="https://evil.example"></iframe>' +
        '<div onclick="window.__pwned=4" style="position:fixed">y</div>';
      const html = sanitizeHtml(hostile) + renderMarkdown("![t](https://tracker.example/i.png) [rel](/relative) <script>x</script>");
      const host = document.createElement("div");
      host.innerHTML = html;
      document.body.appendChild(host);
      const links = Array.from(host.querySelectorAll("a"));
      const summary = {
        scripts: host.querySelectorAll("script").length,
        media: host.querySelectorAll("img, iframe, video, audio, svg").length,
        handlers: host.querySelectorAll("[onclick], [onerror], [style]").length,
        badLinks: links.filter((a) => a.hasAttribute("href") && !a.getAttribute("href")!.startsWith("https://")).length,
        httpsLinksSafe: links.filter((a) => a.getAttribute("href")?.startsWith("https://")).every((a) => a.target === "_blank" && a.rel.includes("noopener")),
        pwned: (window as unknown as { __pwned?: number }).__pwned ?? 0,
      };
      host.remove();
      return summary;
    });

    expect(result).toEqual({ scripts: 0, media: 0, handlers: 0, badLinks: 0, httpsLinksSafe: true, pwned: 0 });
  });
});
