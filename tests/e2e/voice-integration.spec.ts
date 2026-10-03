import { test, expect, type Browser, type Page } from "@playwright/test";

/**
 * CORE-004 §33 — real two-client voice verification against a real
 * self-hosted LiveKit server (NOT run as part of the default `npm run
 * test:e2e` / CI suite — see `tests/e2e/README.md` and the CORE-004
 * delivery report's "Two-client real voice test" section for exactly
 * why, and the manual procedure that covers what this file cannot).
 *
 * What this test DOES prove, automatically, against real infrastructure
 * (not mocks): two independent real Chromium browser contexts each
 * capture a (fake, OS-less) microphone device, request a real
 * server-minted voice token, negotiate a real WebRTC connection to a
 * real self-hosted `livekit-server` instance, and each successfully
 * SUBSCRIBES to the other's published audio track through that SFU —
 * i.e. the full connection/signaling/media-negotiation pipeline this
 * task built, end to end, with no browser-to-browser P2P topology at
 * any point (see ADR-003).
 *
 * What this test does NOT and CANNOT prove, and why (see the delivery
 * report's ENVIRONMENT-LIMITED section for the full statement): this
 * sandbox has no real microphone or speaker hardware. Chromium's
 * `--use-fake-device-for-media-stream` substitutes a synthetic signal
 * for `getUserMedia()`, which is sufficient to exercise the real
 * WebRTC/SFU pipeline (connection, publish, subscribe) but is NOT
 * evidence that a human would perceive audible sound, that distance
 * attenuation is perceptually correct, or that LiveKit's active-speaker
 * (voice-activity) detection reacts to a synthetic tone the same way it
 * would to real speech — asserting on `isSpeaking` here would be
 * asserting on an environment-specific implementation detail of
 * Chromium's fake audio device, not on this application's own code, so
 * this file deliberately does not attempt that assertion.
 *
 * Requires a real `livekit-server --dev` instance reachable at
 * `ws://127.0.0.1:7880` and `apps/server/.env` configured with its
 * `devkey`/`secret` placeholder credentials (see
 * `apps/server/README.md` § Voice (CORE-004)) — this is NOT the default
 * CI environment, which runs with no `.env` and therefore no voice
 * backend at all (see `tests/e2e/voice.spec.ts`'s Test 8, which
 * specifically covers that no-voice-backend path). Run manually:
 *
 *   livekit-server --dev --bind 0.0.0.0 &
 *   cp apps/server/.env.example apps/server/.env   # then fill in the
 *                                                   # printed devkey/secret
 *   npx playwright test tests/e2e/voice-integration.spec.ts
 */

const FAKE_MEDIA_ARGS = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];

// Deliberately NOT a `declare global` augmentation here (unlike
// app.spec.ts/social.spec.ts) — those two files already declare
// `window.__localPlayer`/`window.__remotePlayers` with narrower shapes
// for their own needs, and since every file under `tests/` compiles as
// one program (see social.spec.ts's own comment on this), a second,
// wider redeclaration of the same global property would conflict. Casts
// inside each `page.evaluate` sidestep that without touching the
// existing declarations.
interface DebugRemotePlayerManager {
  size: number;
  getPositions(): Array<{ playerId: string }>;
}
interface DebugVoiceSession {
  getSubscribedPlayerIds(): string[];
  getGain(playerId: string): number | undefined;
}
interface DebugSocialStore {
  mute(playerId: string): void;
  unmute(playerId: string): void;
  block(playerId: string): void;
  unblock(playerId: string): void;
}

async function waitForGainZero(page: Page, playerId: string): Promise<void> {
  await page.waitForFunction(
    (id) => {
      const session = (window as unknown as { __voiceSession?: DebugVoiceSession }).__voiceSession;
      return (session?.getGain(id) ?? -1) === 0;
    },
    playerId,
    { timeout: 10_000 },
  );
}

async function waitForGainAboveZero(page: Page, playerId: string): Promise<void> {
  await page.waitForFunction(
    (id) => {
      const session = (window as unknown as { __voiceSession?: DebugVoiceSession }).__voiceSession;
      return (session?.getGain(id) ?? 0) > 0;
    },
    playerId,
    { timeout: 10_000 },
  );
}

async function newVoiceTestPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

async function waitForLocalPlayer(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as { __localPlayer?: unknown }).__localPlayer));
}

async function waitForRemotePlayerCount(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const manager = (window as unknown as { __remotePlayers?: DebugRemotePlayerManager }).__remotePlayers;
      return (manager?.size ?? 0) >= expected;
    },
    count,
    { timeout: 15_000 },
  );
}

function otherPlayerId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const manager = (window as unknown as { __remotePlayers?: DebugRemotePlayerManager }).__remotePlayers;
    const positions = manager?.getPositions() ?? [];
    if (positions.length === 0) throw new Error("no remote player known yet");
    return positions[0]!.playerId;
  });
}

// `test.use` must be top-level (not inside `describe`) — a describe-scoped
// `launchOptions` override forces a new worker, which Playwright refuses.
test.use({ launchOptions: { args: FAKE_MEDIA_ARGS } });

test.describe("CORE-004 — two-client voice (real LiveKit SFU, not part of default CI)", () => {
  test.skip(
    !process.env.VOICE_INTEGRATION,
    "Set VOICE_INTEGRATION=1 and run a local `livekit-server --dev` first — see this file's header comment. Skipped by default so the normal e2e/CI run never depends on infrastructure outside the sandbox.",
  );

  test("two real browsers each subscribe to the other's published audio track through the SFU", async ({ browser }) => {
    test.setTimeout(90_000); // real WebRTC/SFU negotiation + several sequential mute/block round-trips, well beyond the suite's default 30s

    const pageA = await newVoiceTestPage(browser);
    const pageB = await newVoiceTestPage(browser);

    await pageA.goto("/");
    await pageB.goto("/");
    await waitForLocalPlayer(pageA);
    await waitForLocalPlayer(pageB);

    // Multiplayer presence first (CORE-002) — voice needs each side to
    // already know the other as a RemotePlayer, see VoiceSession's
    // getRemotePlayerObject() dependency.
    await waitForRemotePlayerCount(pageA, 1);
    await waitForRemotePlayerCount(pageB, 1);

    const bIdOnA = await otherPlayerId(pageA);
    const aIdOnB = await otherPlayerId(pageB);

    await pageA.locator(".zw-voice-controls button", { hasText: "Enable Voice" }).click();
    await pageB.locator(".zw-voice-controls button", { hasText: "Enable Voice" }).click();

    await expect(pageA.locator(".zw-voice-controls")).toContainText("Voice: CONNECTED", { timeout: 20_000 });
    await expect(pageB.locator(".zw-voice-controls")).toContainText("Voice: CONNECTED", { timeout: 20_000 });

    // The real assertion: each browser's VoiceSession has a live,
    // gain-controlled subscription to the OTHER's published track —
    // proof the real WebRTC negotiation through the real SFU completed
    // on both sides, not just that each independently reached
    // "connected" to the server.
    await pageA.waitForFunction(
      (id) => {
        const session = (window as unknown as { __voiceSession?: DebugVoiceSession }).__voiceSession;
        return session?.getSubscribedPlayerIds().includes(id) ?? false;
      },
      bIdOnA,
      { timeout: 20_000 },
    );
    await pageB.waitForFunction(
      (id) => {
        const session = (window as unknown as { __voiceSession?: DebugVoiceSession }).__voiceSession;
        return session?.getSubscribedPlayerIds().includes(id) ?? false;
      },
      aIdOnB,
      { timeout: 20_000 },
    );

    // Both players spawn at the same world position (CORE-002's
    // World.spawnPoint), so distance ≈ 0 → full gain — a non-zero
    // baseline here is what makes the mute/block assertions below mean
    // something (going to exactly 0 is the suppression taking effect,
    // not just "always zero").
    await waitForGainAboveZero(pageA, bIdOnA);
    await waitForGainAboveZero(pageB, aIdOnB);

    // CORE-004 §22 — mute: B mutes A → A's gain on B's client drops to 0
    // immediately, via the REAL subscribed track's real gain node, not a
    // unit-tested stand-in. A is never notified (no message exists for
    // it — see docs/privacy/VOICE_THREAT_MODEL.md § 16) and stays fully
    // connected throughout, which the gain check on A's own side proves:
    // A's view of the connection, and of B's gain, is untouched by B's
    // local-only mute.
    await pageB.evaluate((id) => {
      (window as unknown as { __socialStore?: DebugSocialStore }).__socialStore?.mute(id);
    }, aIdOnB);
    await waitForGainZero(pageB, aIdOnB);
    await expect(pageA.locator(".zw-voice-controls")).toContainText("Voice: CONNECTED"); // A's own connection is completely unaffected
    await waitForGainAboveZero(pageA, bIdOnA); // A still hears B exactly as before — mute is one-directional, local to B

    await pageB.evaluate((id) => {
      (window as unknown as { __socialStore?: DebugSocialStore }).__socialStore?.unmute(id);
    }, aIdOnB);
    await waitForGainAboveZero(pageB, aIdOnB);

    // CORE-004 §23 — block: same shape, reusing CORE-003's existing local
    // block state. A must remain connected and receive no signal.
    await pageB.evaluate((id) => {
      (window as unknown as { __socialStore?: DebugSocialStore }).__socialStore?.block(id);
    }, aIdOnB);
    await waitForGainZero(pageB, aIdOnB);
    await expect(pageA.locator(".zw-voice-controls")).toContainText("Voice: CONNECTED");
    await waitForGainAboveZero(pageA, bIdOnA);

    await pageA.close();
    await pageB.close();
  });
});
