import { test, expect, type Page } from "@playwright/test";

/**
 * CORE-003 §23 Test 10.
 *
 * This drives the client's rendering path directly via the dev-only
 * `window.__remotePlayers` hook (same pattern as CORE-001's e2e suite)
 * rather than going through the real server, because the server already
 * rejects a nickname shaped like this outright (see
 * `apps/server/src/nickname.test.ts` and `WorldServer.test.ts`'s
 * "an invalid set_nickname request is dropped" test) — a malicious
 * nickname could never actually reach a nameplate in the live system.
 * This test instead proves the CLIENT's defense-in-depth half: even if
 * an unexpected/malformed nickname ever did arrive (a bug, a future
 * protocol mismatch), rendering it can never inject markup or execute
 * script — see docs/privacy/SOCIAL_IDENTITY_THREAT_MODEL.md § Security.
 *
 * Deliberately declares its own minimal shape below rather than importing
 * `RemotePlayerManager`/`PlayerSummary` from `apps/web`/`@project/shared`
 * — this file is type-checked under the ROOT tsconfig (see tsconfig.json's
 * `include: ["tests"]`), which lacks `allowImportingTsExtensions`; pulling
 * in apps/web's source graph (which legitimately uses `.ts`-extensioned
 * relative imports under its OWN tsconfig) would fail under the root
 * config. Same reasoning `app.spec.ts` already follows for `__localPlayer`.
 */

interface SpawnablePlayerSummary {
  playerId: string;
  nickname: string;
  colorSeed: number;
  x: number;
  y: number;
  z: number;
  rotationY: number;
  animationState: "idle" | "walk" | "jog" | "sit" | "wave" | "talk";
}

declare global {
  interface Window {
    __remotePlayers?: { spawn: (summary: SpawnablePlayerSummary) => void };
  }
}

async function spawnWithNickname(page: Page, playerId: string, nickname: string): Promise<void> {
  await page.evaluate(
    ({ playerId, nickname }) => {
      const summary: SpawnablePlayerSummary = {
        playerId,
        nickname,
        colorSeed: 120,
        x: 0,
        y: 0,
        z: 0,
        rotationY: 0,
        animationState: "idle",
      };
      window.__remotePlayers!.spawn(summary);
    },
    { playerId, nickname },
  );
}

test.describe("CORE-003 — nickname rendering safety", () => {
  test("a <script> nickname renders as inert text, never as a real <script> element", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__remotePlayers));

    const malicious = "<script>alert(1)</script>";
    await spawnWithNickname(page, "xss-test-script", malicious);

    // Matched by exact text, not the generic `.zw-nameplate` class: this
    // test runs alongside other e2e workers against the same shared dev
    // server, each a real WebSocket client the others can legitimately
    // see as a remote player (with its own Guest-#### nameplate) — exact
    // text matching is what actually identifies *this* test's element.
    const nameplate = page.getByText(malicious, { exact: true });
    await expect(nameplate).toHaveText(malicious);

    const scriptChildCount = await nameplate.evaluate((el) => el.querySelectorAll("script").length);
    expect(scriptChildCount).toBe(0);

    // textContent-based rendering HTML-escapes the string in the DOM —
    // if innerHTML had been used instead, this would contain a literal
    // (if inert) <script> tag rather than its escaped entities.
    const innerHtml = await nameplate.evaluate((el) => el.innerHTML);
    expect(innerHtml).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("an onerror-style markup nickname never executes as a side effect", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__remotePlayers));

    // Unlike a <script> tag (which browsers ignore when inserted via
    // innerHTML), an onerror handler on an <img> DOES execute if a
    // vulnerable implementation ever concatenated this into innerHTML —
    // this is the payload shape that actually proves exploitability.
    const malicious = '<img src=x onerror="window.__xssFired = true">';
    await spawnWithNickname(page, "xss-test-onerror", malicious);

    const nameplate = page.getByText(malicious, { exact: true });
    await expect(nameplate).toHaveText(malicious);

    const imgChildCount = await nameplate.evaluate((el) => el.querySelectorAll("img").length);
    expect(imgChildCount).toBe(0);

    const xssFired = await page.evaluate(() => (window as unknown as { __xssFired?: boolean }).__xssFired);
    expect(xssFired).toBeUndefined();
  });
});
