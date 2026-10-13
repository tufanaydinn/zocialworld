import { test, expect as baseExpect, type Browser, type Page } from "@playwright/test";
import { ANCHOR, standAtAnchor } from "./support/anchors.ts";

/**
 * The stage share through a REAL self-hosted LiveKit SFU (opt-in, like
 * tests/e2e/voice-integration.spec.ts; NOT part of the default e2e/CI run).
 *
 * Proves, against real infrastructure:
 *  - the holder (A, wallet gate passed with updateParticipationState('ready') and
 *    a confirmed name from the dev registry, without which the server refuses the full voice grant
 *    and the stage) shares a tab with real browser capture (Chromium's fake display-media device) —
 *    video AND tab audio;
 *  - a viewer inside the hall (B) in WATCH MODE — listen-only, no wallet — subscribes to exactly
 *    the holder's ScreenShare + ScreenShareAudio, plays the audio through the stage channel, and
 *    hears the holder's microphone as a stage mic;
 *  - the stage video keeps advancing for 15 s (the adaptiveStream freeze fix: an off-DOM video
 *    with no attached element would otherwise be paused by the SFU);
 *  - share quality: in each share mode — Slides (1080p30) and Video (1080p60) — the
 *    holder's sender carries the explicit top layer plus the 720p30 / 360p15 simulcast layers, and
 *    the viewer's received frame rate is measured over 10 s with requestVideoFrameCallback (logged,
 *    not asserted beyond "frames advance": SwiftShader and the fake capture device cap it);
 *  - walking out of the hall drops the subscription; the holder's Stop ends the turn.
 *
 * Run (see tests/e2e/README.md): a local `livekit-server --dev` and the game server with
 * LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET and NAME_REGISTRY=dev, then
 *
 *   VOICE_INTEGRATION=1 npx playwright test tests/e2e/watch-stage-integration.spec.ts
 */

const expect = baseExpect.configure({ timeout: 45_000 });

// Real capture: Chromium's fake UI auto-accepts getDisplayMedia and its fake device captures a "browser" surface.
// A local SFU bound to 127.0.0.1 only offers loopback ICE candidates: let Chromium gather loopback candidates and send them
// as plain addresses (not mDNS names, which the SFU cannot resolve). Test-environment switches only.
test.use({
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream=display-media-type=browser",
      "--allow-loopback-in-peer-connection",
      "--disable-features=WebRtcHideLocalIpsWithMdns",
    ],
  },
});

interface ShareStats {
  capture: { width: number | null; height: number | null; frameRate: number | null };
  contentHint: string;
  encodings: { rid: string | null; active: boolean; maxBitrate: number | null; maxFramerate: number | null; scaleResolutionDownBy: number | null }[];
  outbound: { rid: string | null; width: number | null; height: number | null; fps: number | null }[];
}
interface ReceiveStats {
  requestedQuality: number | null;
  inbound: { width: number | null; height: number | null; fps: number | null; framesDecoded: number | null } | null;
}

// An intersection, not `extends Window`: other specs declare narrower shapes of the same globals (see voice-integration.spec.ts).
type DebugWindow = Window & {
  __worldReady?: boolean;
  __localPlayer?: { position: { set(x: number, y: number, z: number): void } };
  __remotePlayers?: { size: number };
  __hallStore?: { member: boolean; localPlayerId: string | null; stage: { holder: string | null; status: string; audio: boolean } };
  __stageSystem?: {
    readonly state: { sharing: boolean; sharingAudio: boolean; showingVideo: boolean };
    videoStats(): { owner: string; width: number; height: number; frames: number } | null;
  };
  __voiceSession?: {
    connectionMode: string;
    getStageTarget(): string | null;
    getStageAudio(): { playing: boolean; gain: number | undefined };
    getSubscribedPlayerIds(): string[];
    getLocalShareStats(): Promise<ShareStats | null>;
    getStageReceiveStats(): Promise<ReceiveStats | null>;
  };
  __identity?: () => { nickname: string };
};

const RUN = Math.random().toString(36).slice(2, 6);

async function openClient(browser: Browser): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?quality=low");
  await page.waitForFunction(() => (window as DebugWindow).__worldReady === true, null, { timeout: 150_000 });
  return { page, errors };
}

const viewer = (page: Page) =>
  page.evaluate(() => {
    const w = window as DebugWindow;
    return {
      mode: w.__voiceSession!.connectionMode,
      target: w.__voiceSession!.getStageTarget(),
      audio: w.__voiceSession!.getStageAudio(),
      mics: w.__voiceSession!.getSubscribedPlayerIds(),
      video: w.__stageSystem!.videoStats(),
    };
  });

/** Starts a share from the widget in `mode` and waits until the server reports it live. */
async function share(pageA: Page, mode: "Slides" | "Video"): Promise<void> {
  await pageA.locator(".zw-stage-widget").getByRole("button", { name: "Start sharing" }).click();
  const dialog = pageA.locator(".zw-stage-confirm");
  await expect(dialog.locator(".zw-stage-voice-notice")).toBeHidden();
  await dialog.getByRole("radio", { name: new RegExp(`^${mode} —`) }).check();
  await dialog.getByRole("button", { name: "Choose what to share" }).click();
  await expect.poll(() => pageA.evaluate(() => (window as DebugWindow).__hallStore!.stage.status)).toBe("live");
}

/**
 * The viewer's stage frame rate over `ms`: distinct frames presented on the big screen (requestVideoFrameCallback's
 * presentedFrames) and frames decoded (inbound-rtp framesDecoded), per second.
 */
async function measureFps(pageB: Page, ms: number): Promise<{ presented: number; decoded: number }> {
  const decoded = async () => (await pageB.evaluate(() => (window as DebugWindow).__voiceSession!.getStageReceiveStats()))?.inbound?.framesDecoded ?? 0;
  const start = (await viewer(pageB)).video!.frames;
  const startDecoded = await decoded();
  const startAt = Date.now();
  await pageB.waitForTimeout(ms);
  const seconds = (Date.now() - startAt) / 1000;
  return { presented: ((await viewer(pageB)).video!.frames - start) / seconds, decoded: ((await decoded()) - startDecoded) / seconds };
}

test.describe("stage share through a real LiveKit SFU (not part of default CI)", () => {
  test.skip(!process.env.VOICE_INTEGRATION, "Set VOICE_INTEGRATION=1 and run a local livekit-server --dev first — see this file's header comment.");
  test.describe.configure({ timeout: 480_000 });

  test("a watch-mode viewer inside the hall receives the holder's ScreenShare + ScreenShareAudio; slides and video modes are encoded as asked and measured at the viewer", async ({ browser }) => {
    const a = await openClient(browser);
    const b = await openClient(browser);
    const pageA = a.page;
    const pageB = b.page;
    await pageA.waitForFunction(() => ((window as DebugWindow).__remotePlayers?.size ?? 0) >= 1, null, { timeout: 30_000 });
    await pageB.waitForFunction(() => ((window as DebugWindow).__remotePlayers?.size ?? 0) >= 1, null, { timeout: 30_000 });

    // A passes the wallet gate and confirms a name on the dev registry; B stays a guest —
    // watching needs no wallet.
    const name = `Pres${RUN}`;
    await pageA.evaluate(async (nickname) => {
      // Module paths in variables: they resolve in the browser (Vite), not in this file's type check.
      const participationPath = "/src/zcash/participation.ts";
      const nameKeyPath = "/src/zcash/nameKey.ts";
      const participation = (await import(/* @vite-ignore */ participationPath)) as { updateParticipationState(status: string): void };
      participation.updateParticipationState("ready");
      const nameKey = (await import(/* @vite-ignore */ nameKeyPath)) as { activateNameKeyFromSeed(seed: Uint8Array, network: string): Promise<unknown> };
      await nameKey.activateNameKeyFromSeed(crypto.getRandomValues(new Uint8Array(64)), "test");
      await (window as unknown as { __confirmName(nickname: string): Promise<void> }).__confirmName(nickname);
    }, name);
    await pageA.waitForFunction((nickname) => (window as DebugWindow).__identity?.().nickname === nickname, name, { timeout: 30_000 });

    await standAtAnchor(pageB, ANCHOR.hallFloor, { x: 2 });
    await standAtAnchor(pageA, ANCHOR.hallPodium);
    await expect.poll(() => pageA.evaluate(() => (window as DebugWindow).__hallStore!.member)).toBe(true);
    await expect.poll(() => pageB.evaluate(() => (window as DebugWindow).__hallStore!.member)).toBe(true);
    const aId = await pageA.evaluate(() => (window as DebugWindow).__hallStore!.localPlayerId!);

    // A: full voice, then the stage.
    await pageA.locator(".zw-voice-controls button", { hasText: "Enable Voice" }).click();
    await expect(pageA.locator(".zw-voice-controls")).toContainText("Voice: CONNECTED");
    await expect(pageA.getByText("Podium — take the stage")).toBeVisible();
    await pageA.keyboard.press("e");
    await expect(pageA.locator(".zw-stage-widget")).toContainText("You're on stage — Start sharing");
    await share(pageA, "Slides");
    const holderShare = await pageA.evaluate(() => (window as DebugWindow).__stageSystem!.state);
    expect(holderShare.sharing).toBe(true);
    expect(holderShare.sharingAudio, "the fake browser capture carries tab audio").toBe(true);
    expect(await pageA.evaluate(() => (window as DebugWindow).__hallStore!.stage.audio)).toBe(true);

    // B: watch mode (listen-only, no wallet) from the hall button.
    await pageB.locator(".zw-stage-watch").click();
    await expect(pageB.locator(".zw-voice-controls")).toContainText("Listening: CONNECTED");
    await expect.poll(async () => (await viewer(pageB)).target).toBe(aId);
    await expect.poll(async () => (await viewer(pageB)).video?.width ?? 0).toBeGreaterThan(0);
    await expect.poll(async () => (await viewer(pageB)).audio.playing, { message: "ScreenShareAudio subscribed and playing" }).toBe(true);
    await expect.poll(async () => (await viewer(pageB)).audio.gain ?? 0).toBeGreaterThan(0);
    await expect.poll(async () => (await viewer(pageB)).mics, { message: "the holder's mic is a stage mic, heard in watch mode" }).toContain(aId);

    // Frames keep advancing for 15 s.
    const start = (await viewer(pageB)).video!.frames;
    let last = start;
    for (let i = 0; i < 5; i++) {
      await pageB.waitForTimeout(3_000);
      const frames = (await viewer(pageB)).video?.frames ?? 0;
      expect(frames, `stage video frames advanced during interval ${i + 1}`).toBeGreaterThan(last);
      last = frames;
    }
    console.log(`[watch-stage-integration] stage frames presented on the viewer over 15 s: ${last - start}`);

    // Slides — the explicit top layer (30 fps, 3.5 Mbps) and the 360p15 / 720p30 layers; the received rate.
    const slides = (await pageA.evaluate(() => (window as DebugWindow).__voiceSession!.getLocalShareStats()))!;
    expect(slides.contentHint).toBe("detail");
    expect(slides.encodings.at(-1)!.maxFramerate).toBe(30);
    expect(slides.encodings.at(-1)!.maxBitrate).toBe(3_500_000);
    const slidesFps = await measureFps(pageB, 10_000);
    const slidesIn = await pageB.evaluate(() => (window as DebugWindow).__voiceSession!.getStageReceiveStats());
    console.log(`[watch-stage-integration] SLIDES capture ${JSON.stringify(slides.capture)} encodings ${JSON.stringify(slides.encodings)} outbound ${JSON.stringify(slides.outbound)}`);
    console.log(`[watch-stage-integration] SLIDES viewer: ${slidesFps.presented.toFixed(1)} fps presented (rVFC), ${slidesFps.decoded.toFixed(1)} fps decoded, over 10 s; inbound ${JSON.stringify(slidesIn)}`);
    expect(slidesFps.presented).toBeGreaterThan(0);

    // Stop, take the stage again and share in Video mode (60 fps, 7 Mbps).
    await pageA.locator(".zw-stage-widget").getByRole("button", { name: "Stop sharing" }).click();
    await expect.poll(() => pageA.evaluate(() => (window as DebugWindow).__hallStore!.stage.holder)).toBe(null);
    await pageA.locator(".zw-stage-widget").getByRole("button", { name: /^Request the stage/ }).click();
    await expect(pageA.locator(".zw-stage-widget")).toContainText("You're on stage — Start sharing");
    await share(pageA, "Video");
    await expect.poll(async () => (await viewer(pageB)).video?.width ?? 0).toBeGreaterThan(0);
    const video = (await pageA.evaluate(() => (window as DebugWindow).__voiceSession!.getLocalShareStats()))!;
    expect(video.contentHint).toBe("motion");
    expect(video.encodings.at(-1)!.maxFramerate).toBe(60);
    expect(video.encodings.at(-1)!.maxBitrate).toBe(7_000_000);
    await pageB.waitForTimeout(3_000); // let the new track settle
    const videoFps = await measureFps(pageB, 10_000);
    const videoIn = await pageB.evaluate(() => (window as DebugWindow).__voiceSession!.getStageReceiveStats());
    console.log(`[watch-stage-integration] VIDEO capture ${JSON.stringify(video.capture)} encodings ${JSON.stringify(video.encodings)} outbound ${JSON.stringify(video.outbound)}`);
    console.log(`[watch-stage-integration] VIDEO viewer: ${videoFps.presented.toFixed(1)} fps presented (rVFC), ${videoFps.decoded.toFixed(1)} fps decoded, over 10 s; inbound ${JSON.stringify(videoIn)}`);
    expect(videoFps.presented).toBeGreaterThan(0);

    // Outside the hall nothing is downloaded.
    await standAtAnchor(pageB, ANCHOR.spawn);
    await expect.poll(async () => (await viewer(pageB)).target).toBe(null);
    await expect.poll(async () => (await viewer(pageB)).video).toBe(null);

    // The holder's Stop ends the turn (LiveKit unpublish → hall_stage_live{false}).
    await pageA.locator(".zw-stage-widget").getByRole("button", { name: "Stop sharing" }).click();
    await expect.poll(() => pageA.evaluate(() => (window as DebugWindow).__hallStore!.stage.holder)).toBe(null);

    expect(a.errors, `page errors on A:\n${a.errors.join("\n")}`).toEqual([]);
    expect(b.errors, `page errors on B:\n${b.errors.join("\n")}`).toEqual([]);
    await pageA.context().close();
    await pageB.context().close();
  });
});
