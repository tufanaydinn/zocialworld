import { test, expect as baseExpect, type Browser, type Page } from "@playwright/test";
import { ANCHOR, cameraPoseToward, standAtAnchor } from "./support/anchors.ts";

/**
 * Voice, the microphone and the stage share end to end through a REAL LiveKit (opt-in, like
 * watch-stage-integration.spec.ts). Without an SFU, "Enable Voice" can only fail and nothing reaches the Watch Hall
 * screen, so `npm run dev` starts a local LiveKit (scripts/dev/livekit.mjs) and gives the game
 * server its URL and --dev keys (`--local-livekit`). This spec runs against exactly that setup:
 *
 *   LOCAL_LIVEKIT_PORT=7900 LIVEKIT_NODE_IP=127.0.0.1 node scripts/dev/livekit.mjs        # the local LiveKit
 *   LOCAL_LIVEKIT_PORT=7900 npm run dev:local-voice --workspace apps/server               # the game server
 *   VOICE_INTEGRATION=1 npx playwright test tests/e2e/watch-hall-voice-real.spec.ts
 *
 * It proves:
 *  1. two wallet holders press Enable Voice: both connect, the microphone publishes, and each hears the other
 *     (a subscribed track with gain > 0);
 *  2. A takes the stage and shares a tab WITH audio (Chromium's fake display capture); B, inside the hall, receives
 *     the video (frames keep advancing), plays the stage audio (gain > 0) and hears A's microphone hall-wide;
 *  3. when the microphone can't open — no permission prompt (headless Chromium without the fake-UI switch, like some
 *     in-app browsers), or the site's permission set to Block — Enable Voice still connects for listening and the
 *     voice panel says exactly why the microphone is off, not a bare "Voice: ERROR".
 * For a 127.0.0.1-only SFU Chromium also needs --allow-loopback-in-peer-connection and
 * --disable-features=WebRtcHideLocalIpsWithMdns (test environment only). E2E_SHOTS=<dir> writes screenshots.
 */

const expect = baseExpect.configure({ timeout: 45_000 });
const LOOPBACK_ARGS = ["--allow-loopback-in-peer-connection", "--disable-features=WebRtcHideLocalIpsWithMdns"];
const SHOTS = process.env.E2E_SHOTS ?? "";

test.use({ launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream=display-media-type=browser", ...LOOPBACK_ARGS] } });

type DebugWindow = Window & {
  __worldReady?: boolean;
  __networkClient?: { joined: boolean };
  __localPlayer?: { position: { set(x: number, y: number, z: number): void } };
  __remotePlayers?: { size: number };
  __hallStore?: { member: boolean; localPlayerId: string | null; stage: { holder: string | null; status: string; audio: boolean } };
  __stageSystem?: { readonly state: { sharing: boolean; sharingAudio: boolean }; videoStats(): { owner: string; width: number; height: number; frames: number } | null };
  __voiceSession?: {
    connectionMode: string;
    hasMicrophone: boolean;
    getSubscribedPlayerIds(): string[];
    getGain(playerId: string): number | undefined;
    getStageTarget(): string | null;
    getStageAudio(): { playing: boolean; gain: number | undefined };
  };
};

const RUN = Math.random().toString(36).slice(2, 6);
let holders = 0;

async function openHolder(browser: Browser, options: { blockMicrophone?: boolean } = {}): Promise<{ page: Page; errors: string[] }> {
  // Explicit baseURL and storage: the permission test launches its own browser, which the config's `use` doesn't reach.
  const { baseURL, storageState } = test.info().project.use;
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...(baseURL ? { baseURL } : {}), ...(storageState ? { storageState } : {}) });
  if (options.blockMicrophone) {
    // A site whose microphone permission is set to Block: Chrome rejects getUserMedia with NotAllowedError
    // "Permission denied". Headless Chromium has no permission UI to block it in, so the page is answered exactly so.
    await context.addInitScript(() => {
      const media = navigator.mediaDevices;
      const original = media.getUserMedia.bind(media);
      media.getUserMedia = (constraints?: MediaStreamConstraints) =>
        constraints?.audio ? Promise.reject(new DOMException("Permission denied", "NotAllowedError")) : original(constraints);
    });
  }
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?quality=low");
  await page.waitForFunction(() => (window as DebugWindow).__worldReady === true, null, { timeout: 240_000 });
  await page.waitForFunction(() => (window as DebugWindow).__networkClient?.joined === true, null, { timeout: 60_000 });
  // A wallet reached ready (the participation gate, as the other hall specs flip it): the server gets set_wallet.
  // The e2e server runs the DEV name registry, and while a registry runs talking and presenting need an
  // owned name — confirmed the way names.spec / identity.spec do (a test name key; the dev registry confirms the
  // reservation on its own, nothing is paid). Without it Enable Voice opens the name step instead of connecting.
  const nickname = `Mic${RUN}${++holders}`;
  await page.evaluate(async (name) => {
    const modulePath = "/src/zcash/participation.ts"; // a variable: Vite serves it, tsc must not resolve it
    const participation = (await import(/* @vite-ignore */ modulePath)) as { updateParticipationState(status: string): void };
    participation.updateParticipationState("ready");
    const nameKeyPath = "/src/zcash/nameKey.ts";
    const nameKey = (await import(/* @vite-ignore */ nameKeyPath)) as { activateNameKeyFromSeed(seed: Uint8Array, network: string): Promise<unknown> };
    await nameKey.activateNameKeyFromSeed(crypto.getRandomValues(new Uint8Array(64)), "test");
    await (window as unknown as { __confirmName(nickname: string): Promise<void> }).__confirmName(name);
  }, nickname);
  await page.waitForFunction((name) => (window as unknown as { __identity?: () => { nickname: string } }).__identity?.().nickname === name, nickname, { timeout: 30_000 });
  await expect(page.locator(".zw-voice-controls .zw-button-primary")).toHaveText("Enable Voice");
  return { page, errors };
}

const voice = (page: Page) =>
  page.evaluate(() => {
    const v = (window as DebugWindow).__voiceSession!;
    return { mode: v.connectionMode, mic: v.hasMicrophone, subscribed: v.getSubscribedPlayerIds(), stage: v.getStageTarget(), stageAudio: v.getStageAudio() };
  });
const gainOf = (page: Page, playerId: string) => page.evaluate((id) => (window as DebugWindow).__voiceSession!.getGain(id) ?? 0, playerId);

test.describe("voice, microphone and stage share through a real LiveKit (opt-in)", () => {
  test.skip(!process.env.VOICE_INTEGRATION, "Set VOICE_INTEGRATION=1 and run the local LiveKit + game server first — see this file's header.");
  test.describe.configure({ mode: "serial", timeout: 420_000 });

  test("Enable Voice → mic publishes → the other player hears it (gain > 0) → a tab shared with audio reaches the viewer's screen", async ({ browser }) => {
    const a = await openHolder(browser);
    const b = await openHolder(browser);
    await standAtAnchor(a.page, ANCHOR.hallFloor, { x: 2 });
    await standAtAnchor(b.page, ANCHOR.hallFloor, { x: 3.5 });
    for (const { page } of [a, b]) await expect.poll(() => page.evaluate(() => (window as DebugWindow).__hallStore!.member)).toBe(true);
    for (const { page } of [a, b]) await page.waitForFunction(() => ((window as DebugWindow).__remotePlayers?.size ?? 0) >= 1, null, { timeout: 30_000 });
    const aId = await a.page.evaluate(() => (window as DebugWindow).__hallStore!.localPlayerId!);
    const bId = await b.page.evaluate(() => (window as DebugWindow).__hallStore!.localPlayerId!);

    // 1. Both talk: connected, the microphone published, each hears the other.
    for (const { page } of [a, b]) {
      await page.locator(".zw-voice-controls .zw-button-primary", { hasText: "Enable Voice" }).click();
      await expect(page.locator(".zw-voice-controls")).toContainText("Voice: CONNECTED");
      await expect.poll(async () => (await voice(page)).mic, { message: "the microphone track is published" }).toBe(true);
    }
    await expect.poll(async () => (await voice(b.page)).subscribed).toContain(aId);
    await expect.poll(async () => (await voice(a.page)).subscribed).toContain(bId);
    await expect.poll(() => gainOf(b.page, aId), { message: "B hears A" }).toBeGreaterThan(0);
    await expect.poll(() => gainOf(a.page, bId), { message: "A hears B" }).toBeGreaterThan(0);
    await expect(a.page.locator(".zw-voice-error")).toBeHidden();
    // The connected voice panel stays clear of the action bar and of the chat above it at 1280×720 (it used to run
    // under the bar: the hidden Enable Voice button still took space).
    const clear = await a.page.evaluate(() => {
      const panel = document.querySelector(".zw-voice-controls")!.getBoundingClientRect();
      const bar = document.querySelector(".zw-action-bar")!.getBoundingClientRect();
      const chat = document.querySelector(".zw-chat")?.getBoundingClientRect();
      return { enableHidden: document.querySelector<HTMLElement>(".zw-voice-controls .zw-button-primary")!.offsetParent === null, bar: panel.right <= bar.left, chat: !chat || panel.top >= chat.bottom };
    });
    expect(clear).toEqual({ enableHidden: true, bar: true, chat: true });

    // 2. A presents: the podium, Start sharing, a tab with its audio.
    await standAtAnchor(a.page, ANCHOR.hallPodium);
    await expect(a.page.getByText("Podium — take the stage")).toBeVisible();
    await a.page.keyboard.press("e");
    await expect(a.page.locator(".zw-stage-widget")).toContainText("Start sharing");
    await a.page.locator(".zw-stage-widget").getByRole("button", { name: "Start sharing" }).click();
    const dialog = a.page.locator(".zw-stage-confirm");
    await dialog.getByRole("button", { name: "Choose what to share" }).click();
    await expect.poll(() => a.page.evaluate(() => (window as DebugWindow).__hallStore!.stage.status)).toBe("live");
    expect(await a.page.evaluate(() => (window as DebugWindow).__stageSystem!.state.sharingAudio), "the share carries tab audio").toBe(true);

    // B (full voice, in the hall) receives the video and the audio, and hears A's microphone hall-wide.
    await expect.poll(async () => (await voice(b.page)).stage).toBe(aId);
    await expect.poll(() => b.page.evaluate(() => (window as DebugWindow).__stageSystem!.videoStats()?.width ?? 0)).toBeGreaterThan(0);
    await expect.poll(async () => (await voice(b.page)).stageAudio.playing).toBe(true);
    await expect.poll(async () => (await voice(b.page)).stageAudio.gain ?? 0).toBeGreaterThan(0);
    await expect.poll(() => gainOf(b.page, aId), { message: "A's microphone is a stage mic for B" }).toBeGreaterThan(0);
    const start = (await b.page.evaluate(() => (window as DebugWindow).__stageSystem!.videoStats()))!.frames;
    let last = start;
    for (let i = 0; i < 4; i++) {
      await b.page.waitForTimeout(3_000);
      const frames = (await b.page.evaluate(() => (window as DebugWindow).__stageSystem!.videoStats()?.frames)) ?? 0;
      expect(frames, `stage frames advanced during interval ${i + 1}`).toBeGreaterThan(last);
      last = frames;
    }
    console.log(`[watch-hall-voice-real] the viewer presented ${last - start} stage frames in 12 s`);
    if (SHOTS) {
      const pose = await cameraPoseToward(b.page, ANCHOR.hallScreen, ANCHOR.hallFloor, 18.6, -2.2, 55);
      await b.page.evaluate((p) => (window as unknown as { __setPhotoCamera(p: unknown): void }).__setPhotoCamera(p), pose);
      await b.page.waitForTimeout(2000);
      await b.page.screenshot({ path: `${SHOTS}/voice-stage-share-viewer.png` });
      await b.page.evaluate(() => (window as unknown as { __setPhotoCamera(p: unknown): void }).__setPhotoCamera(null));
    }

    await a.page.locator(".zw-stage-widget").getByRole("button", { name: "Stop sharing" }).click();
    await expect.poll(() => a.page.evaluate(() => (window as DebugWindow).__hallStore!.stage.holder)).toBe(null);
    expect(a.errors, a.errors.join("\n")).toEqual([]);
    expect(b.errors, b.errors.join("\n")).toEqual([]);
    await a.page.context().close();
    await b.page.context().close();
  });

  test("a microphone that can't open: voice still connects for listening and the panel says exactly why", async ({ playwright }) => {
    // A browser WITHOUT --use-fake-ui-for-media-stream.
    const browser = await playwright.chromium.launch({ args: ["--use-fake-device-for-media-stream", ...LOOPBACK_ARGS] });
    try {
      const cases = [
        // Headless Chromium has no permission prompt at all: getUserMedia answers NotSupportedError (as some in-app browsers do).
        { blockMicrophone: false, title: "This browser can't open a microphone here.", detail: "still hear others", shot: "voice-error-no-microphone" },
        // The site's microphone permission is set to Block.
        { blockMicrophone: true, title: "Microphone access is blocked for this site.", detail: "allow the microphone", shot: "voice-error-permission" },
      ];
      for (const c of cases) {
        const { page, errors } = await openHolder(browser, { blockMicrophone: c.blockMicrophone });
        await page.locator(".zw-voice-controls .zw-button-primary", { hasText: "Enable Voice" }).click();
        await expect(page.locator(".zw-voice-controls")).toContainText("Voice: CONNECTED");
        const card = page.locator(".zw-voice-error");
        await expect(card).toBeVisible();
        await expect(card.locator(".zw-voice-error-title")).toHaveText(c.title);
        await expect(card).toContainText(c.detail);
        await expect(page.locator(".zw-voice-mic")).toHaveText("Mic: unavailable (listening only)");
        await expect(page.locator(".zw-chat-line", { hasText: c.title })).toBeVisible();
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/${c.shot}.png` });
        expect(errors, errors.join("\n")).toEqual([]);
        await page.context().close();
      }
    } finally {
      await browser.close();
    }
  });
});
