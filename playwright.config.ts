import { defineConfig, devices } from "@playwright/test";

/**
 * Root-level Playwright config — the e2e suite drives the whole running
 * app, not just `apps/web` in isolation, so it lives at the repository
 * root (`tests/e2e/`) per the CORE-001 revision instructions, not inside
 * the app workspace.
 *
 * The web server runs the Vite DEV server (not the production preview
 * build) specifically so `import.meta.env.DEV`-gated debug hooks
 * (`window.__localPlayer`, `window.__assetManager` — see
 * `apps/web/src/core/App.ts`) are available for tests to read state
 * through. Production build correctness is covered separately by
 * `npm run build` in CI, not by this suite.
 *
 * As of CORE-002, `apps/web` auto-connects to the multiplayer server on
 * load (`App.ts` calls `NetworkClient.connect()` in its constructor),
 * so `apps/server` must also be running during e2e tests — otherwise a
 * WebSocket connection-refused error shows up as a console error and
 * fails the CORE-001 "no console/page errors" tests. No `url` readiness
 * check for the server entry: the `ws` package's underlying HTTP server
 * doesn't answer plain GET requests the way Playwright's HTTP-based
 * probe expects, and the server binds its port fast enough (well under
 * Vite's own ~250ms startup) that omitting the probe is reliable here —
 * see https://playwright.dev/docs/test-webserver (a webServer entry
 * with no `url` is considered ready as soon as the command is launched).
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "npm run dev --workspace apps/server",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "npm run dev --workspace apps/web -- --port 5173 --strictPort --host 127.0.0.1",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
