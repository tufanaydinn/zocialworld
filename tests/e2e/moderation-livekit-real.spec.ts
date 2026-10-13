import { test, expect as baseExpect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { RoomServiceClient } from "livekit-server-sdk";
import { useClientAddress } from "./support/clientAddress.ts";
import { ANCHOR, standAtAnchor } from "./support/anchors.ts";

/**
 * Moderation (ADR-019 § 6) against a REAL LiveKit (opt-in, like watch-hall-voice-real.spec.ts): a publisher the
 * server benches or kicks really stops being published at the SFU — checked from outside the game, through LiveKit's
 * own RoomService `ListParticipants` API:
 *
 *   1. a wallet holder with an owned name enables voice and presents on the Watch Hall stage (microphone + a tab
 *      share): ListParticipants shows it with `canPublish: true` and its tracks;
 *   2. a moderator puts the presenter on a stage cooldown (a host power): the server revokes the publish permission —
 *      ListParticipants shows `canPublish: false` and no published tracks, and the presenter's client says why;
 *   3. the honest client drops to listening on the SAME room (it stays in ListParticipants, still
 *      unable to publish) instead of leaving voice; Enable Voice (still allowed to talk) gets a new grant and it is
 *      published again; the moderator kicks them — the participant is gone from ListParticipants.
 *
 * Run it against the local LiveKit and a game server with a moderator key:
 *
 *   LOCAL_LIVEKIT_PORT=7900 LIVEKIT_NODE_IP=127.0.0.1 node scripts/dev/livekit.mjs
 *   LOCAL_LIVEKIT_PORT=7900 NAME_REGISTRY=dev MODERATOR_KEYS=e2e-moderator-key-not-a-secret-3Hv8Kd \
 *     TRUST_PROXY=127.0.0.1 npm run dev:local-voice --workspace apps/server
 *   VOICE_INTEGRATION=1 E2E_LIVEKIT_HTTP=http://127.0.0.1:7900 npx playwright test tests/e2e/moderation-livekit-real.spec.ts
 *
 * The local LiveKit runs with its --dev keys (devkey / secret). For a 127.0.0.1-only SFU Chromium also needs
 * --allow-loopback-in-peer-connection and --disable-features=WebRtcHideLocalIpsWithMdns (test environment only).
 * Each browser gets its own client address (support/clientAddress.ts; start the game server with TRUST_PROXY=127.0.0.1
 * as playwright.config.ts does), so the kick at the end never keeps 127.0.0.1 out for 10 minutes.
 */

const expect = baseExpect.configure({ timeout: 45_000 });
const LOOPBACK_ARGS = ["--allow-loopback-in-peer-connection", "--disable-features=WebRtcHideLocalIpsWithMdns"];
const MOD_KEY = process.env.E2E_MODERATOR_KEY ?? "e2e-moderator-key-not-a-secret-3Hv8Kd";
const LIVEKIT_HTTP = process.env.E2E_LIVEKIT_HTTP ?? "http://127.0.0.1:7880";
const ROOM = process.env.LIVEKIT_ROOM_NAME || "public-world";
const SHOTS = process.env.MODERATION_SHOTS ?? "";
const GAME_SERVER_WS = process.env.E2E_GAME_SERVER_WS ?? "ws://127.0.0.1:8787";

test.use({ launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream=display-media-type=browser", ...LOOPBACK_ARGS] } });

type DebugWindow = Window & {
  __worldReady?: boolean;
  __networkClient?: { joined: boolean; sendHall(message: unknown): void; sendModAction(message: unknown): void };
  __localPlayer?: { position: { set(x: number, y: number, z: number): void } };
  __remotePlayers?: { size: number };
  __hallStore?: { member: boolean; localPlayerId: string | null; isHost: boolean; stage: { holder: string | null; status: string } };
  __moderationStore?: { isModerator: boolean };
  __voiceSession?: { connectionMode: string; hasMicrophone: boolean };
};

const RUN = Math.random().toString(36).slice(2, 6);
const contexts: BrowserContext[] = [];
let holders = 0;

const rooms = new RoomServiceClient(LIVEKIT_HTTP, "devkey", "secret");

/** What LiveKit itself says about one participant (null: not in the room). */
async function participant(identity: string): Promise<{ canPublish: boolean; tracks: number } | null> {
  const list = await rooms.listParticipants(ROOM).catch(() => []);
  const found = list.find((p) => p.identity === identity);
  if (!found) return null;
  return { canPublish: found.permission?.canPublish === true, tracks: found.tracks.length };
}

async function openHolder(browser: Browser): Promise<Page> {
  const { baseURL, storageState } = test.info().project.use;
  const address = `198.18.${Math.floor(Math.random() * 250) + 1}.${contexts.length + 10}`;
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    ...(baseURL ? { baseURL } : {}),
    ...(storageState ? { storageState } : {}),
  });
  contexts.push(context);
  await useClientAddress(context, GAME_SERVER_WS, address, baseURL ? new URL(baseURL).origin : undefined);
  const page = await context.newPage();
  await page.goto("/?quality=low");
  await page.waitForFunction(() => (window as DebugWindow).__worldReady === true, null, { timeout: 240_000 });
  await page.waitForFunction(() => (window as DebugWindow).__networkClient?.joined === true, null, { timeout: 60_000 });
  // A wallet holder with an owned name (the dev registry confirms it; nothing is paid) — talking and presenting need it.
  const nickname = `Lk${RUN}${++holders}`;
  await page.evaluate(async (name) => {
    const participationPath = "/src/zcash/participation.ts";
    const participation = (await import(/* @vite-ignore */ participationPath)) as { updateParticipationState(status: string): void };
    participation.updateParticipationState("ready");
    const nameKeyPath = "/src/zcash/nameKey.ts";
    const nameKey = (await import(/* @vite-ignore */ nameKeyPath)) as { activateNameKeyFromSeed(seed: Uint8Array, network: string): Promise<unknown> };
    await nameKey.activateNameKeyFromSeed(crypto.getRandomValues(new Uint8Array(64)), "test");
    await (window as unknown as { __confirmName(nickname: string): Promise<void> }).__confirmName(name);
  }, nickname);
  await page.waitForFunction((name) => (window as unknown as { __identity?: () => { nickname: string } }).__identity?.().nickname === name, nickname, { timeout: 30_000 });
  return page;
}


async function enableVoice(page: Page): Promise<void> {
  await page.locator(".zw-voice-controls .zw-button-primary", { hasText: "Enable Voice" }).click();
  await expect(page.locator(".zw-voice-controls")).toContainText("Voice: CONNECTED");
  await expect.poll(() => page.evaluate(() => (window as DebugWindow).__voiceSession!.hasMicrophone), { message: "the microphone track is published" }).toBe(true);
}

async function present(page: Page): Promise<void> {
  await standAtAnchor(page, ANCHOR.hallPodium);
  await expect(page.getByText("Podium — take the stage")).toBeVisible();
  await page.keyboard.press("e");
  await page.locator(".zw-stage-widget").getByRole("button", { name: "Start sharing" }).click();
  await page.locator(".zw-stage-confirm").getByRole("button", { name: "Choose what to share" }).click();
  await expect.poll(() => page.evaluate(() => (window as DebugWindow).__hallStore!.stage.status)).toBe("live");
}

test.describe("moderation — a benched or kicked publisher stops at the SFU (real LiveKit, opt-in)", () => {
  test.skip(!process.env.VOICE_INTEGRATION, "Set VOICE_INTEGRATION=1 and run the local LiveKit + game server first — see this file's header.");
  test.describe.configure({ mode: "serial", timeout: 900_000 });
  test.afterAll(async () => {
    for (const context of contexts.splice(0)) await context.close();
  });

  test("bench → canPublish false and no tracks in ListParticipants; kick → the participant is gone", async ({ browser }) => {
    const presenter = await openHolder(browser);
    const moderator = await openHolder(browser);
    await standAtAnchor(presenter, ANCHOR.hallFloor, { x: 2 });
    await standAtAnchor(moderator, ANCHOR.hallFloor, { x: 3.5 });
    for (const page of [presenter, moderator]) await expect.poll(() => page.evaluate(() => (window as DebugWindow).__hallStore!.member)).toBe(true);
    const presenterId = await presenter.evaluate(() => (window as DebugWindow).__hallStore!.localPlayerId!);

    // The moderator signs in (the host-key field takes the moderator key) and has host powers in the hall.
    await moderator.evaluate((key) => (window as DebugWindow).__networkClient!.sendHall({ type: "hall_host_auth", key }), MOD_KEY);
    await expect.poll(() => moderator.evaluate(() => (window as DebugWindow).__moderationStore!.isModerator)).toBe(true);
    await expect.poll(() => moderator.evaluate(() => (window as DebugWindow).__hallStore!.isHost)).toBe(true);

    // 1. The presenter talks and shares: LiveKit lists it publishing.
    await enableVoice(presenter);
    await present(presenter);
    await expect.poll(async () => (await participant(presenterId))?.canPublish, { message: "published at the SFU" }).toBe(true);
    await expect.poll(async () => (await participant(presenterId))?.tracks ?? 0, { message: "microphone + screen share (+ tab audio)" }).toBeGreaterThanOrEqual(2);
    console.log(`[moderation-livekit-real] before the bench: ${JSON.stringify(await participant(presenterId))}`);

    // 2. The moderator benches the presenter: the turn ends and the server revokes the publish permission at LiveKit.
    // The presenter plays a client that ignores the server: it keeps its microphone published (an honest client drops
    // its microphone and share itself on the revoke, which would hide whether the server's revoke worked). Its stage
    // widget still ends the share — so only the server's revoke can make LiveKit report canPublish false and nothing
    // published.
    await presenter.evaluate(() => {
      const session = (window as unknown as { __voiceSession: { downgradeToListen(): Promise<boolean> } }).__voiceSession;
      (window as unknown as { __realDowngrade: () => Promise<boolean> }).__realDowngrade = session.downgradeToListen.bind(session);
      session.downgradeToListen = async () => true;
    });
    await moderator.evaluate((id) => (window as DebugWindow).__networkClient!.sendHall({ type: "hall_stage_cooldown", playerId: id, ms: 600_000 }), presenterId);
    await expect.poll(() => presenter.evaluate(() => (window as DebugWindow).__hallStore!.stage.holder)).toBe(null);
    await expect.poll(async () => (await participant(presenterId))?.canPublish, { message: "LiveKit: canPublish is false" }).toBe(false);
    await expect.poll(async () => (await participant(presenterId))?.tracks ?? -1, { message: "LiveKit: nothing is published any more" }).toBe(0);
    console.log(`[moderation-livekit-real] after the bench: ${JSON.stringify(await participant(presenterId))}`);
    // The client's own reaction: the chat line, and the voice panel now says it is listening.
    await expect(presenter.locator(".zw-chat-line", { hasText: "The server stopped your microphone and screen share" })).toBeVisible();
    await expect(presenter.locator(".zw-voice-controls")).toContainText("Listening: CONNECTED");
    if (SHOTS) await presenter.screenshot({ path: `${SHOTS}/livekit-revoked-presenter.jpg`, type: "jpeg", quality: 88 });

    // 3. The honest client's own downgrade: it releases its microphone and stays in the room, listening.
    await presenter.evaluate(async () => {
      const real = (window as unknown as { __realDowngrade: () => Promise<boolean> }).__realDowngrade;
      (window as unknown as { __voiceSession: { downgradeToListen(): Promise<boolean> } }).__voiceSession.downgradeToListen = real;
      await real();
    });
    await expect.poll(() => presenter.evaluate(() => (window as DebugWindow).__voiceSession!.connectionMode)).toBe("listen");
    await expect.poll(() => presenter.evaluate(() => (window as DebugWindow).__voiceSession!.hasMicrophone), { message: "the microphone is released" }).toBe(false);
    await expect.poll(async () => (await participant(presenterId))?.canPublish, { message: "still in the room, listening (canPublish false)" }).toBe(false);
    // Still allowed to talk: Enable Voice (a new grant) — published again. Then a kick removes the participant.
    await enableVoice(presenter);
    await expect.poll(async () => (await participant(presenterId))?.canPublish, { message: "published again after a new grant" }).toBe(true);
    await moderator.evaluate((id) => (window as DebugWindow).__networkClient!.sendModAction({ action: "kick", targetId: id }), presenterId);
    await expect(presenter.locator(".zw-removed")).toContainText("A moderator removed you from Zocial World");
    await expect.poll(async () => await participant(presenterId), { message: "LiveKit: the kicked participant is gone" }).toBe(null);
    console.log("[moderation-livekit-real] after the kick: not in ListParticipants");
  });
});
