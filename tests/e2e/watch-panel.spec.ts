import { test, expect, type Page } from "@playwright/test";

/**
 * The Watch panel and the opt-in personal YouTube player
 * (docs/architecture/WATCH_HALL.md). Offline: `/content/watch*` and
 * `/content/media` are answered from fixtures, and youtube-nocookie.com is a
 * route stub, so nothing here depends on (or contacts) a third party. The
 * clock is fixed to Thursday 2026-10-15 15:30 UTC, half-way through an
 * Builders Call.
 */

declare global {
  interface Window {
    __localPlayer?: { position: { x: number; y: number; z: number } };
    __opened?: unknown[][];
  }
}

const NOW = new Date("2026-10-15T15:30:00Z");
const CHANNEL = `UC${"testchannel".padEnd(22, "0")}`;

function video(id: string, title: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title,
    channel: "Example Foundation",
    channelId: CHANNEL,
    publishedAt: "2026-10-02T10:11:57Z",
    durationSec: 2609,
    views: 193,
    status: "replay",
    scheduledStart: null,
    concurrentViewers: null,
    thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    url: `https://www.youtube.com/watch?v=${id}`,
    ...extra,
  };
}

const LISTING = {
  available: true,
  stale: false,
  generatedAt: NOW.toISOString(),
  live: [video("LIVEvideo01", "Zcash Community Call", { status: "live", durationSec: null, views: null, scheduledStart: "2026-10-15T15:00:00Z", concurrentViewers: 42 })],
  schedule: [
    {
      id: "builders-20261015",
      title: "Weekly Builders Call",
      start: "2026-10-15T15:00:00Z",
      end: "2026-10-15T16:30:00Z",
      source: "recurring",
      where: "zoom",
      joinUrl: "https://example.com/join/call",
      videoId: null,
      summary: "Bi-weekly Zcash protocol development call.",
      location: "Zoom webinar",
    },
    {
      id: "conf-202610271455-44a0e5",
      title: "Example Conference: Consensus Panel",
      start: "2026-10-27T14:55:00Z",
      end: "2026-10-27T15:55:00Z",
      source: "calendar",
      where: "in-person",
      joinUrl: "https://example.com/conference/",
      videoId: null,
      summary: "A candid conversation about the choices facing Zcash.",
      location: "In person · replays later",
    },
    {
      id: "builders-20261029",
      title: "Weekly Builders Call",
      start: "2026-10-29T15:00:00Z",
      end: "2026-10-29T16:30:00Z",
      source: "recurring",
      where: "zoom",
      joinUrl: "https://example.com/join/call",
      videoId: null,
      summary: "",
      location: "Zoom webinar",
    },
  ],
  latest: [
    video("vidAAAA0001", "Protocol Workshop: Oct 1, 2026", { channel: "Example Labs", collection: "protocol-workshops", durationSec: 5165 }),
    video("vidBBBB0002", "Builders Call 10-1-2026", { collection: "builders-calls" }),
    video("vidCCCC0003", "Community Updates | September 15, 2026", { channel: "Community Channel", collection: "community-updates", durationSec: 1931 }),
  ],
  collections: [
    { id: "builders-calls", title: "Builders Calls", channel: "Example Foundation", count: 15 },
    { id: "conf-2025", title: "Conference 2025", channel: "Example Foundation", count: 2 },
  ],
  notice: "Live YouTube status needs an API key on the server — showing the schedule and replays.",
  sources: [
    { label: "Schedules", text: "Example Foundation (Builders Calls, public calendar)" },
    { label: "Videos", text: "YouTube — Example Foundation, Community Channel, Example Labs" },
  ],
};

const ZCON_VI = {
  available: true,
  stale: false,
  collection: { id: "conf-2025", title: "Conference 2025", channel: "Example Foundation", count: 2 },
  videos: [video("vidDDDD0004", "State of the Project - Conference 2025", { collection: "conf-2025" }), video("-vidEEE0005", "Scaling Talk - Conference 2025", { collection: "conf-2025" })],
  page: 0,
  pages: 1,
};

// A 1×1 transparent PNG for proxied thumbnails.
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function stubGateway(page: Page): Promise<void> {
  const cors = { "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin" };
  await page.route("**/content/watch**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith("/content/watch") ? LISTING : path.endsWith("/content/watch/collection/conf-2025") ? ZCON_VI : null;
    await route.fulfill(body ? { status: 200, contentType: "application/json", headers: cors, body: JSON.stringify(body) } : { status: 404, contentType: "application/json", headers: cors, body: '{"error":"not_found"}' });
  });
  await page.route("**/content/media?**", (route) => route.fulfill({ status: 200, contentType: "image/png", headers: cors, body: PIXEL }));
}

/** Every request this page makes to YouTube/Google hosts. */
function trackThirdParty(page: Page): string[] {
  const hits: string[] = [];
  page.on("request", (request) => {
    const host = new URL(request.url()).hostname;
    if (/(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|ytimg\.com|googlevideo\.com|google\.com|doubleclick\.net)$/.test(host)) hits.push(request.url());
  });
  return hits;
}

async function openWatch(page: Page): Promise<ReturnType<Page["locator"]>> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__localPlayer));
  const panel = page.locator(".zw-watch-backdrop");
  await expect(panel).not.toHaveClass(/visible/);
  await page.locator(".zw-action", { hasText: "Watch" }).click();
  await expect(panel).toHaveClass(/visible/);
  return panel;
}

test.describe("Watch panel", () => {
  test.use({ timezoneId: "UTC" });

  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(NOW);
    await stubGateway(page);
  });

  test("opens from the action bar with four tabs; the Replays filter works; external links are https new tabs; Esc closes", async ({ page }) => {
    const thirdParty = trackThirdParty(page);
    const panel = await openWatch(page);
    await expect(panel.locator(".zw-watch-title")).toHaveText("Watch Hall");
    const tabs = panel.locator(".zw-watch-tab");
    await expect(tabs).toHaveCount(4);
    await expect(tabs.nth(0)).toContainText("Live");
    await expect(tabs.nth(1)).toContainText("Today");
    await expect(tabs.nth(2)).toContainText("Upcoming");
    await expect(tabs.nth(3)).toContainText("Replays");

    // Live: the YouTube stream (LIVE badge, viewers) and the Builders Call on Zoom.
    const body = panel.locator(".zw-watch-body");
    await expect(body).toContainText("Zcash Community Call");
    await expect(body).toContainText("Weekly Builders Call");
    await expect(body.locator(".zw-watch-viewers")).toHaveText("👥 42");
    await expect(tabs.nth(0).locator(".zw-watch-count")).toHaveText("2");
    await expect(body.locator("a", { hasText: "Join on Zoom ↗" })).toHaveAttribute("href", "https://example.com/join/call");
    // The footer credits come from the listing.
    await expect(panel.locator(".zw-watch-attribution")).toHaveText(
      "Schedules: Example Foundation (Builders Calls, public calendar) · Videos: YouTube — Example Foundation, Community Channel, Example Labs. Relayed by the Zocial World server.",
    );

    await tabs.nth(2).click();
    await expect(body).toContainText("Example Conference: Consensus Panel");
    await expect(body).toContainText("In person · replays later");

    await tabs.nth(3).click();
    const cards = body.locator(".zw-watch-grid .zw-watch-video");
    await expect(cards).toHaveCount(3);
    await expect(cards.first().locator("img")).toHaveAttribute("src", /\/content\/media\?url=https%3A%2F%2Fi\.ytimg\.com%2Fvi%2FvidAAAA0001%2Fmqdefault\.jpg$/);
    await expect(cards.first().locator("img")).toHaveAttribute("referrerpolicy", "no-referrer");
    const filter = body.locator(".zw-watch-filter");
    await filter.fill("protocol");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("Protocol Workshop: Oct 1, 2026");
    await filter.fill("");
    await expect(cards).toHaveCount(3);
    await body.locator(".zw-watch-chip-button", { hasText: "Conference 2025" }).click();
    await expect(cards).toHaveCount(2);
    await expect(cards.first()).toContainText("State of the Project");

    const links = await panel.locator("a.zw-watch-external").evaluateAll((anchors) => anchors.map((a) => ({ href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel") })));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.href).toMatch(/^https:\/\//);
      expect(link.target).toBe("_blank");
      expect(link.rel).toContain("noopener");
      expect(link.rel).toContain("noreferrer");
    }

    await filter.focus();
    await page.keyboard.press("Escape"); // leaves the filter
    await page.keyboard.press("Escape"); // closes the panel
    await expect(panel).not.toHaveClass(/visible/);
    expect(thirdParty, "the panel never contacts YouTube").toEqual([]);
  });

  test("YouTube opt-in: no YouTube request before consent; after it a credentialless nocookie iframe, closed with its button", async ({ page }) => {
    // Two players and two iframe loads on a loaded SwiftShader machine: the 30 s default was hit once in a full run.
    test.setTimeout(90_000);
    const thirdParty = trackThirdParty(page);
    await page.route("https://www.youtube-nocookie.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>player stub</title><script>window.__ytStub = true;</script><p>stub</p>" }),
    );
    const panel = await openWatch(page);
    await panel.locator(".zw-watch-here").first().click();

    const consent = page.locator(".zw-watch-consent-backdrop");
    await expect(consent).toHaveClass(/visible/);
    await expect(consent).toContainText("Watching here connects your browser to YouTube (Google): it sees your IP address and that you are watching from Zocial World.");
    await expect(panel).not.toHaveClass(/visible/);
    await page.waitForTimeout(300);
    expect(thirdParty, "nothing reaches YouTube before consent").toEqual([]);
    expect(await page.evaluate(() => document.querySelectorAll("iframe").length)).toBe(0);

    await consent.locator(".zw-watch-consent-accept").click();
    const frame = page.locator(".zw-watch-player.visible iframe");
    await expect(frame).toHaveCount(1);
    await expect(frame).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/LIVEvideo01?autoplay=1&rel=0");
    await expect(frame).toHaveAttribute("credentialless", "");
    await expect(frame).toHaveAttribute("referrerpolicy", "strict-origin");
    await expect(frame).toHaveAttribute("allow", "autoplay; encrypted-media; picture-in-picture; fullscreen");
    expect(await frame.evaluate((element) => (element as HTMLIFrameElement & { credentialless?: boolean }).credentialless)).toBe(true);
    await expect.poll(() => thirdParty.some((url) => url.startsWith("https://www.youtube-nocookie.com/embed/LIVEvideo01"))).toBe(true);
    await expect.poll(async () => page.frame({ url: /youtube-nocookie\.com\/embed\// })?.evaluate(() => (window as unknown as { __ytStub?: boolean }).__ytStub === true) ?? false).toBe(true);
    expect(thirdParty.every((url) => url.startsWith("https://www.youtube-nocookie.com/")), `only the embed: ${thirdParty.join(", ")}`).toBe(true);
    expect(await page.evaluate(() => document.querySelectorAll('script[src*="iframe_api"], script[src*="youtube"]').length)).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem("zocial-world.watch.youtube-consent"))).toBe("granted");

    await page.locator(".zw-watch-player-close").click();
    await expect(page.locator(".zw-watch-player")).not.toHaveClass(/visible/);
    expect(await page.evaluate(() => document.querySelectorAll("iframe").length)).toBe(0);

    // Remembered: the next "Watch here" plays without asking.
    await page.locator(".zw-action", { hasText: "Watch" }).click();
    await page.locator(".zw-watch-tab", { hasText: "Replays" }).click();
    await page.locator(".zw-watch-grid .zw-watch-here").first().click();
    await expect(consent).not.toHaveClass(/visible/);
    await expect(page.locator(".zw-watch-player.visible iframe")).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/vidAAAA0001?autoplay=1&rel=0");
    await page.keyboard.press("Escape");
    // Esc is read once per rendered frame (InputManager.wasJustPressed → App's per-frame menu handling). In the full
    // suite the hall project renders a crowded Watch Hall on SwiftShader at the same time and this page can drop to
    // 0–2 FPS, so give the close a few frames' worth of time rather than the default 5 s.
    await expect(page.locator(".zw-watch-player")).not.toHaveClass(/visible/, { timeout: 20_000 });
  });

  test("browsers without credentialless iframes get no 'Watch here' (it would only open youtube.com): just the labelled new-tab link, no iframe", async ({ page }) => {
    await page.addInitScript(() => {
      delete (HTMLIFrameElement.prototype as unknown as { credentialless?: boolean }).credentialless;
      window.__opened = [];
      window.open = ((...args: unknown[]) => {
        window.__opened!.push(args);
        return null;
      }) as typeof window.open;
    });
    const thirdParty = trackThirdParty(page);
    const panel = await openWatch(page);
    // No button that promises "asks first" / "plays in the game": only the honest new-tab link.
    await expect(panel.locator(".zw-watch-here")).toHaveCount(0);
    const open = panel.locator("a", { hasText: "Open on YouTube ↗" }).first();
    await expect(open).toHaveAttribute("href", "https://www.youtube.com/watch?v=LIVEvideo01");
    await expect(open).toHaveAttribute("rel", /noopener/);
    await expect(open).toHaveAttribute("rel", /noreferrer/);
    await expect(open).toHaveAttribute("title", /YouTube cookies/);
    await expect(page.locator(".zw-watch-consent-backdrop")).not.toHaveClass(/visible/);
    expect(await page.evaluate(() => document.querySelectorAll("iframe").length)).toBe(0);
    expect(thirdParty).toEqual([]);
  });
});
