import { test, expect, type Browser, type Page } from "@playwright/test";

/**
 * Real two-client voice verification against a real
 * self-hosted LiveKit server (NOT run as part of the default `npm run
 * test:e2e` / CI suite — see `tests/e2e/README.md` for exactly why, and
 * the manual procedure that covers what this file cannot).
 *
 * What this test DOES prove, automatically, against real infrastructure
 * (not mocks): two independent real Chromium browser contexts each
 * capture a (fake, OS-less) microphone device, request a real
 * server-minted voice token, negotiate a real WebRTC connection to a
 * real self-hosted `livekit-server` instance, and each successfully
 * SUBSCRIBES to the other's published audio track through that SFU —
 * i.e. the full connection/signaling/media-negotiation pipeline, end to end, with no browser-to-browser P2P topology at
 * any point (see ADR-007).
 *
 * What this test does NOT and CANNOT prove, and why: a test
 * environment has no real microphone or speaker hardware. Chromium's
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
 * `apps/server/README.md`) — this is NOT the default
 * CI environment, which runs with no `.env` and therefore no voice
 * backend at all (see `tests/e2e/voice.spec.ts`'s Test 8, which
 * specifically covers that no-voice-backend path). Run manually:
 *
 *   livekit-server --dev --bind 0.0.0.0 &
 *   cp apps/server/.env.example apps/server/.env   # then fill in the
 *                                                   # printed devkey/secret
 *   npx playwright test tests/e2e/voice-integration.spec.ts
 *
 * Or, without a .env, the local LiveKit `npm run dev` uses and the LIVEKIT_* variables passed through the Playwright
 * config's game server (which runs the DEV name registry, so both players confirm a name first):
 *
 *   LIVEKIT_NODE_IP=127.0.0.1 node scripts/dev/livekit.mjs &
 *   VOICE_INTEGRATION=1 LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret \
 *     npx playwright test tests/e2e/voice-integration.spec.ts
 */

// The local LiveKit that `npm run dev` starts (scripts/dev/livekit.mjs) binds 127.0.0.1 only, and
// headless Chromium refuses loopback ICE candidates without these two switches (test environment only) — without them
// the voice panel correctly reports "Connected to the voice server, but the audio connection couldn't be made."
const FAKE_MEDIA_ARGS = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--allow-loopback-in-peer-connection", "--disable-features=WebRtcHideLocalIpsWithMdns"];

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

/**
 * The page's own session joined the world: its playerId (from `welcome`, which the hall store records for every
 * session, in the hall or not). Generous: two default-quality worlds load at once on SwiftShader.
 */
async function waitForOwnPlayerId(page: Page): Promise<string> {
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __networkClient?: { joined: boolean }; __hallStore?: { localPlayerId: string | null } };
      return w.__networkClient?.joined === true && Boolean(w.__hallStore?.localPlayerId);
    },
    null,
    { timeout: 120_000 },
  );
  return page.evaluate(() => (window as unknown as { __hallStore: { localPlayerId: string } }).__hallStore.localPlayerId);
}

/**
 * Presence of ONE specific player. Not "any remote player": the game server is shared — with the other
 * real-LiveKit specs (they run in parallel in the `hall` project), with other testers on a dev server, or with sessions
 * still inside their stale timeout — so the first remote player a page knows is not necessarily the partner. (This
 * spec used to wait for `size >= 1` and take `getPositions()[0]`; next to the hall specs it picked a hall player and
 * then waited forever for a subscription to someone who never published nearby.)
 */
async function waitForRemotePlayer(page: Page, playerId: string): Promise<void> {
  await page.waitForFunction(
    (id) => {
      const manager = (window as unknown as { __remotePlayers?: DebugRemotePlayerManager }).__remotePlayers;
      return manager?.getPositions().some((player) => player.playerId === id) ?? false;
    },
    playerId,
    { timeout: 30_000 },
  );
}

const RUN = Math.random().toString(36).slice(2, 6);

// `test.use` must be top-level (not inside `describe`) — a describe-scoped
// `launchOptions` override forces a new worker, which Playwright refuses.
test.use({ launchOptions: { args: FAKE_MEDIA_ARGS } });

test.describe("two-client voice (real LiveKit SFU, not part of default CI)", () => {
  test.skip(
    !process.env.VOICE_INTEGRATION,
    "Set VOICE_INTEGRATION=1 and run a local `livekit-server --dev` first — see this file's header comment. Skipped by default so the normal e2e/CI run never depends on infrastructure outside the sandbox.",
  );

  test("two real browsers each subscribe to the other's published audio track through the SFU", async ({ browser }) => {
    // Real WebRTC/SFU negotiation + several sequential mute/block round-trips, well beyond the suite's default 30 s —
    // and, next to the hall specs, two world loads on a shared CPU.
    test.setTimeout(240_000);

    const pageA = await newVoiceTestPage(browser);
    const pageB = await newVoiceTestPage(browser);

    await pageA.goto("/");
    await pageB.goto("/");
    const aId = await waitForOwnPlayerId(pageA);
    const bId = await waitForOwnPlayerId(pageB);

    // Multiplayer presence first — voice needs each side to
    // already know the other as a RemotePlayer, see VoiceSession's
    // getRemotePlayerObject() dependency. Each waits for the OTHER test page by id.
    await waitForRemotePlayer(pageA, bId);
    await waitForRemotePlayer(pageB, aId);

    const bIdOnA = bId;
    const aIdOnB = aId;

    // ADR-015: talking needs a wallet — both become wallet holders (the participation gate, as the hall
    // specs flip it), so the primary voice button reads "Enable Voice".
    // The e2e server runs the DEV name registry, and while a registry runs the full voice grant needs an
    // owned name — both confirm one the way names.spec / identity.spec do (a test name key, then the dev registry's
    // reservation confirms on its own; nothing is paid). Without it Enable Voice asks for the name instead of talking.
    for (const [page, name] of [[pageA, `VoxA${RUN}`], [pageB, `VoxB${RUN}`]] as const) {
      await page.evaluate(async (nickname) => {
        const modulePath = "/src/zcash/participation.ts"; // a variable: Vite serves it, tsc must not resolve it
        const participation = (await import(/* @vite-ignore */ modulePath)) as { updateParticipationState(status: string): void };
        participation.updateParticipationState("ready");
        const nameKeyPath = "/src/zcash/nameKey.ts";
        const nameKey = (await import(/* @vite-ignore */ nameKeyPath)) as { activateNameKeyFromSeed(seed: Uint8Array, network: string): Promise<unknown> };
        await nameKey.activateNameKeyFromSeed(crypto.getRandomValues(new Uint8Array(64)), "test");
        await (window as unknown as { __confirmName(nickname: string): Promise<void> }).__confirmName(nickname);
      }, name);
      await page.waitForFunction((nickname) => (window as unknown as { __identity?: () => { nickname: string } }).__identity?.().nickname === nickname, name, { timeout: 30_000 });
    }

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

    // Both players spawn at the same world position
    // (World.spawnPoint), so distance ≈ 0 → full gain — a non-zero
    // baseline here is what makes the mute/block assertions below mean
    // something (going to exactly 0 is the suppression taking effect,
    // not just "always zero").
    await waitForGainAboveZero(pageA, bIdOnA);
    await waitForGainAboveZero(pageB, aIdOnB);

    // Mute: B mutes A → A's gain on B's client drops to 0
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

    // Block: same shape, reusing the existing local
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
