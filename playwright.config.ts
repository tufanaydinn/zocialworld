import { defineConfig, devices } from "@playwright/test";

/**
 * Root-level Playwright config — the e2e suite drives the whole running
 * app, not just `apps/web` in isolation, so it lives at the repository
 * root (`tests/e2e/`), not inside the app workspace.
 *
 * The web server runs the Vite DEV server (not the production preview
 * build) specifically so `import.meta.env.DEV`-gated debug hooks
 * (`window.__localPlayer`, `window.__assetManager` — see
 * `apps/web/src/core/App.ts`) are available for tests to read state
 * through. Production build correctness is covered separately by
 * `npm run build` in CI, not by this suite.
 *
 * `apps/web` auto-connects to the multiplayer server on
 * load (`App.ts` calls `NetworkClient.connect()` in its constructor),
 * so `apps/server` must also be running during e2e tests — otherwise a
 * WebSocket connection-refused error shows up as a console error and
 * fails the "no console/page errors" tests. No `url` readiness
 * check for the server entry: the `ws` package's underlying HTTP server
 * doesn't answer plain GET requests the way Playwright's HTTP-based
 * probe expects, and the server binds its port fast enough (well under
 * Vite's own ~250ms startup) that omitting the probe is reliable here —
 * see https://playwright.dev/docs/test-webserver (a webServer entry
 * with no `url` is considered ready as soon as the command is launched).
 */
/** Specs that put clients into the shared Watch Hall (watch-panel.spec.ts doesn't: it never enters the hall). */
const HALL_SPECS = /watch-(hall|stage)[\w-]*\.spec\.ts/;
/**
 * identity.spec.ts runs in the same single-worker project as the hall specs (it never enters the hall).
 * Its high-tier observer is the heaviest page in the suite: a third browser context that loads the world and the KayKit
 * avatars on SwiftShader while the holder and the guest stay open. In the 2-worker full run it shared the CPU with
 * chat.spec.ts's three clients and could miss its 120 s join wait; alone in one worker it passes (2.5 min). The project
 * runs one file at a time and is queued behind the parallel chromium files, so the observer gets most of the machine.
 */
/**
 * moderation-livekit-real.spec.ts (opt-in, VOICE_INTEGRATION=1) takes the Watch Hall stage too (a
 * presenter at the podium, benched by a moderator), so it joins the hall project; in the parallel chromium project it
 * would race watch-hall-voice-real / watch-stage-integration for the one stage when the real-LiveKit specs run together.
 */
const SINGLE_WORKER_SPECS = [HALL_SPECS, /(^|[\\/])identity\.spec\.ts$/, /(^|[\\/])moderation-livekit-real\.spec\.ts$/];

const BASE_URL = "http://127.0.0.1:5173";

/**
 * ADR-015: the app shows onboarding before joining. Every context starts with a
 * `player-profile-v1` of `{ autoEnter: "guest" }`, which the app honours ONLY in DEV or
 * VITE_TEST_HOOKS builds: it joins at once as a guest, so the existing `goto("/")` specs keep
 * working. Specs about onboarding itself use an empty storageState (see onboarding.spec.ts).
 */
export function guestStorageState(origin: string) {
  return {
    cookies: [],
    origins: [{ origin, localStorage: [{ name: "player-profile-v1", value: JSON.stringify({ autoEnter: "guest" }) }] }],
  };
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  timeout: 30_000,
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    storageState: guestStorageState(BASE_URL),
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: SINGLE_WORKER_SPECS,
    },
    {
      // The server has ONE Watch Hall (one stage, one member list). `mode: "serial"` only orders the
      // tests inside one file, so these specs would race each other across files on the shared hall (one client
      // takes the stage first, another spec's players are counted as members). They run one file at a time, in
      // their own single-worker project, alongside the rest of the suite. identity.spec.ts runs here too (see
      // SINGLE_WORKER_SPECS above).
      name: "hall",
      use: { ...devices["Desktop Chrome"] },
      testMatch: SINGLE_WORKER_SPECS,
      fullyParallel: false,
      workers: 1,
    },
  ],
  webServer: [
    {
      command: "npm run dev --workspace apps/server",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      // ADR-016: the DEV name registry — reservations confirm after ~2 s without any payment (it
      // refuses to start with NODE_ENV=production). Specs that choose a name go through it (names.spec.ts).
      // A test-only Watch Hall host key, so watch-stage.spec.ts can exercise the host tools (queue removal,
      // cooldowns). Not a secret; a deployment's keys are set by the operator.
      // ADR-019: a test-only moderator key (moderation.spec.ts); MAX_SESSIONS_PER_IP=0 because every
      // client of the suite connects from 127.0.0.1 (the per-IP cap and rate are covered by the server tests); and
      // TRUST_PROXY=127.0.0.1 so a spec can give each browser context its own client address with X-Forwarded-For (the
      // game socket relayed by tests/e2e/support/clientAddress.ts) — a ban keyed by the connection hash then never locks
      // the rest of the suite out.
      env: {
        ...process.env,
        NAME_REGISTRY: "dev",
        WATCH_HALL_HOST_KEY: process.env.E2E_HALL_HOST_KEY ?? "e2e-hall-host-key-not-a-secret-7Qp2",
        MODERATOR_KEYS: process.env.E2E_MODERATOR_KEY ?? "e2e-moderator-key-not-a-secret-3Hv8Kd",
        MAX_SESSIONS_PER_IP: "0",
        TRUST_PROXY: "127.0.0.1",
      },
    },
    {
      command: "npm run dev --workspace apps/web -- --port 5173 --strictPort --host 127.0.0.1",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        ...process.env,
        VITE_ZCASH_NETWORK: "test",
        // The suite runs on the sample content (the prototype plaza and the sample hall) in every checkout; specs find
        // their positions through the app's named anchors (tests/e2e/support/anchors.ts).
        ZW_CONTENT: "sample",
      },
    },
  ],
});
