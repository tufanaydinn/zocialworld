import { test, expect as baseExpect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ANCHOR, standAtAnchor } from "./support/anchors.ts";

/**
 * The Watch Hall stage (docs/architecture/WATCH_HALL.md, ADR-014 §§ 3–5),
 * against the default e2e server, which has NO LiveKit (voice answers 503):
 *
 *  - two clients walk into the hall; A takes the stage at the podium (E) and the server grants it;
 *  - B sees the holder and joins the queue;
 *  - A's share path: "Start sharing" opens the confirm dialog — it says everyone in the hall sees
 *    AND hears the share, offers the opt-in computer-sound box, and explains that voice (an
 *    unlocked wallet) is needed; nothing is captured (a fake getDisplayMedia counts calls);
 *  - handing on: A leaves the stage, the queue head B becomes holder;
 *  - the watch-mode button appears inside the hall with voice off and goes away outside;
 *  - no screen interactable exists outside the stage; no uncaught page errors.
 *
 * Stage moderation and sabotage (docs/architecture/WATCH_HALL.md). The e2e server runs the dev name
 * registry, so presenting needs a confirmed (owned) name — an unlocked wallet alone gets the
 * "confirm a name" path in the widget, and a hand-made `hall_stage_request` is refused by the
 * server. The share dialog offers Slides (30 fps) / Video (60 fps). A second test: an audience
 * vote — B in the browser plus two raw WebSocket members with dev-registry names — ends A's live
 * share and benches A for 10 minutes; a host (the e2e host key) removes a player from the queue
 * and puts the holder on a cooldown.
 *
 * The real media path (subscriptions, tab audio, frames advancing) is covered by the opt-in
 * tests/e2e/watch-stage-integration.spec.ts against a local livekit-server.
 */

/** The e2e server's WATCH_HALL_HOST_KEY (playwright.config.ts) — a test value, not a secret. Override with E2E_HALL_HOST_KEY. */
const HOST_KEY = process.env.E2E_HALL_HOST_KEY ?? "e2e-hall-host-key-not-a-secret-7Qp2";

// Software rendering with two clients: frames can take seconds, so give every expectation room.
const expect = baseExpect.configure({ timeout: 30_000 });

test.describe.configure({ mode: "serial", timeout: 240_000 });

interface StageDebug {
  requestStage(): void;
  readonly state: { readonly phase: string; readonly queuePosition: number; readonly screenMessage: { title: string; subtitle: string } | null; readonly watchBanner: boolean; readonly inside: boolean };
}
interface HallDebug {
  readonly member: boolean;
  readonly localPlayerId: string | null;
  readonly stage: { holder: string | null; status: string; queue: string[] };
}
type DebugWindow = Window & {
  __worldReady?: boolean;
  __gdmCalls?: number;
  __localPlayer?: { position: { set(x: number, y: number, z: number): void } };
  __remotePlayers?: { size: number };
  __hallStore?: HallDebug;
  __stageSystem?: StageDebug;
  __interactions?: { all: readonly { id: string }[] };
  __networkClient?: { sendHall(message: unknown): void };
  __identity?: () => { nickname: string };
  __onboarding?: { readonly modalKind: string | null; closeModal(): void };
};

const RUN = Math.random().toString(36).slice(2, 6);

/** The game server's Watch Hall box is centred on x = −1000 (WATCH_HALL_ORIGIN, packages/shared). */
const HALL_X = -1000;

/** A stand-in getDisplayMedia (canvas video + oscillator audio) that only counts calls — the share must never start without voice. */
function installFakeDisplayMedia(): void {
  const w = window as unknown as { __gdmCalls: number };
  w.__gdmCalls = 0;
  if (!navigator.mediaDevices) return;
  navigator.mediaDevices.getDisplayMedia = async () => {
    w.__gdmCalls++;
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const g = canvas.getContext("2d")!;
    let n = 0;
    setInterval(() => {
      g.fillStyle = `hsl(${(n++ * 9) % 360} 70% 50%)`;
      g.fillRect(0, 0, canvas.width, canvas.height);
    }, 50);
    const stream = canvas.captureStream(20);
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const destination = audio.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    stream.addTrack(destination.stream.getAudioTracks()[0]!);
    return stream;
  };
}

/** Every context a test opens is closed after it, also when it fails (a client left behind would stay in the shared hall). */
const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close().catch(() => undefined);
});

/** Presenting needs voice, which needs an unlocked wallet. Tests flip the participation gate directly. */
async function setWallet(page: Page, status: "ready" | "locked"): Promise<void> {
  await page.evaluate(async (walletStatus) => {
    const modulePath = "/src/zcash/participation.ts";
    const participation = (await import(/* @vite-ignore */ modulePath)) as { updateParticipationState(status: string): void };
    participation.updateParticipationState(walletStatus);
  }, status);
}

async function openClient(browser: Browser): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  contexts.push(context);
  await context.addInitScript(installFakeDisplayMedia);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?quality=low");
  await page.waitForFunction(() => (window as DebugWindow).__worldReady === true, null, { timeout: 150_000 });
  return { page, errors };
}

function hall(page: Page): Promise<HallDebug & { localPlayerId: string | null }> {
  return page.evaluate(() => {
    const h = (window as DebugWindow).__hallStore!;
    return { member: h.member, localPlayerId: h.localPlayerId, stage: { holder: h.stage.holder, status: h.stage.status, queue: [...h.stage.queue] } };
  });
}

/**
 * ADR-016 on the dev registry: a test name key, then the fee flow (nothing is paid; the dev registry
 * confirms on its own). Only such an owned name may present while a registry runs.
 */
async function confirmName(page: Page, name: string): Promise<void> {
  await page.evaluate(async (nickname) => {
    const modulePath = "/src/zcash/nameKey.ts";
    const nameKey = (await import(/* @vite-ignore */ modulePath)) as { activateNameKeyFromSeed(seed: Uint8Array, network: string): Promise<unknown> };
    await nameKey.activateNameKeyFromSeed(crypto.getRandomValues(new Uint8Array(64)), "test");
    await (window as unknown as { __confirmName(nickname: string): Promise<void> }).__confirmName(nickname);
  }, name);
  await page.waitForFunction((nickname) => (window as DebugWindow).__identity?.().nickname === nickname, name, { timeout: 30_000 });
}

function widget(page: Page) {
  return page.locator(".zw-stage-widget");
}

function chatLine(page: Page, text: string) {
  return page.locator(".zw-chat-line", { hasText: text });
}

type Msg = Record<string, unknown>;

/**
 * A lightweight hall member over a raw WebSocket (no browser, no rendering) — a wallet holder with an
 * owned name from the dev registry, standing in the hall. Two of them plus a browser client make the vote's bar of 3.
 */
async function rawMember(page: Page, nickname: string) {
  const origin = await page.evaluate(async () => {
    const modulePath = "/src/core/serverOrigin.ts";
    return ((await import(/* @vite-ignore */ modulePath)) as { gameServerOrigin(): string }).gameServerOrigin();
  });
  const socket = new WebSocket(origin.replace(/^http/, "ws"));
  const messages: Msg[] = [];
  socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as Msg));
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const send = (message: Msg) => socket.send(JSON.stringify(message));
  const waitFor = async (predicate: (m: Msg) => boolean, timeoutMs = 20_000): Promise<Msg> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`${nickname}: timed out`);
  };
  send({ type: "join", wallet: true });
  const welcome = await waitFor((m) => m.type === "welcome");
  const keyHash = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  send({ type: "name_reserve", nickname, keyHash });
  await waitFor((m) => m.type === "name_status" && m.status === "confirmed");
  send({ type: "player_transform", x: HALL_X + 6, y: 0.4, z: -4, rotationY: 0, animationState: "idle", seq: 1 });
  await waitFor((m) => m.type === "hall_state");
  const heartbeat = setInterval(() => send({ type: "heartbeat" }), 5_000);
  return {
    playerId: welcome.playerId as string,
    messages,
    send,
    waitFor,
    close: () => {
      clearInterval(heartbeat);
      socket.close();
    },
  };
}

function stageState(page: Page): Promise<StageDebug["state"]> {
  return page.evaluate(() => {
    const s = (window as DebugWindow).__stageSystem!.state;
    return { phase: s.phase, queuePosition: s.queuePosition, screenMessage: s.screenMessage, watchBanner: s.watchBanner, inside: s.inside };
  });
}

test.describe("the Watch Hall stage", () => {
  test("two clients: request, queue, the share dialog without voice, hand-on, watch-mode button, no lodge screen", async ({ browser }) => {
    const a = await openClient(browser);
    const b = await openClient(browser);
    const pageA = a.page;
    const pageB = b.page;

    await pageA.waitForFunction(() => ((window as DebugWindow).__remotePlayers?.size ?? 0) >= 1, null, { timeout: 30_000 });
    await pageB.waitForFunction(() => ((window as DebugWindow).__remotePlayers?.size ?? 0) >= 1, null, { timeout: 30_000 });

    // No screen interactable exists without a stage video.
    const ids = await pageA.evaluate(() => (window as DebugWindow).__interactions!.all.map((item) => item.id));
    expect(ids).not.toContain("screen-lodge");
    expect(ids.filter((id) => id.startsWith("screen-"))).toEqual([]);
    expect(ids).not.toContain("wh-screen");
    expect(ids).toContain("wh-podium");

    // Both walk into the hall; the server makes them members from their poses.
    await standAtAnchor(pageA, ANCHOR.hallFloor);
    await standAtAnchor(pageB, ANCHOR.hallFloor, { x: 3 });
    await expect.poll(async () => (await hall(pageA)).member).toBe(true);
    await expect.poll(async () => (await hall(pageB)).member).toBe(true);
    const aId = (await hall(pageA)).localPlayerId!;
    const bId = (await hall(pageB)).localPlayerId!;

    // Watch mode is offered inside the hall while voice is off.
    await expect(pageB.locator(".zw-stage-watch")).toBeVisible();
    await expect(pageB.locator(".zw-stage-watch")).toContainText("Watch the stage (audio + video)");
    expect((await stageState(pageB)).screenMessage?.title).toBe("Nobody on stage — request it at the podium");

    // Without an unlocked wallet the podium does not take the stage (the hall would wait 45 s for a share that can't
    // start): it says why and opens the wallet. The widget says the same before anyone asks.
    await standAtAnchor(pageA, ANCHOR.hallPodium);
    await expect(pageA.getByText("Podium — take the stage")).toBeVisible();
    await expect(pageA.locator(".zw-stage-widget")).toContainText("Presenting needs voice");
    // A is a guest here (no wallet on this device yet), so the widget asks for a wallet, not an unlock.
    await expect(pageA.locator(".zw-stage-widget")).toContainText("Presenting needs voice — voice needs a wallet.");
    await expect(pageA.locator(".zw-stage-widget").getByRole("button", { name: "Request the stage (needs a wallet)" })).toBeDisabled();
    await expect(pageA.locator(".zw-stage-widget").getByRole("button", { name: "Connect a wallet to talk and present" })).toBeVisible();
    await pageA.keyboard.press("e");
    await expect(pageA.locator(".zw-chat-line", { hasText: "To present, you need voice" })).toBeVisible();
    await pageA.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // out of the wallet panel's field
    await pageA.keyboard.press("Escape"); // closes the wallet panel it opened
    expect((await hall(pageA)).stage).toEqual({ holder: null, status: "idle", queue: [] });

    // The e2e server runs a name registry, so an unlocked wallet alone isn't a verified identity. The
    // widget says so before anyone asks and offers "Confirm a name" (it opens the name step); the podium explains; and a
    // hand-made request is refused by the server (identity_required), whatever the client claims.
    await setWallet(pageA, "ready");
    await setWallet(pageB, "ready");
    await expect(widget(pageA)).toContainText("On this server presenting needs a confirmed name.");
    await expect(widget(pageA).getByRole("button", { name: "Request the stage (needs a confirmed name)" })).toBeDisabled();
    await widget(pageA).getByRole("button", { name: "Confirm a name (Profile → Change name)" }).click();
    await expect.poll(() => pageA.evaluate(() => (window as DebugWindow).__onboarding!.modalKind)).toBe("nickname");
    await pageA.evaluate(() => (window as DebugWindow).__onboarding!.closeModal());
    await pageA.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await pageA.keyboard.press("e");
    await expect(chatLine(pageA, "presenting needs a confirmed name — press “Confirm a name”")).toBeVisible();
    await pageA.evaluate(() => (window as DebugWindow).__networkClient!.sendHall({ type: "hall_stage_request" }));
    await expect(chatLine(pageA, "confirm one in Profile → Change name")).toBeVisible();
    expect((await hall(pageA)).stage).toEqual({ holder: null, status: "idle", queue: [] });

    // With a confirmed name, A takes the stage at the podium (E): the stage is free, so the server grants it at once.
    await confirmName(pageA, `Ada${RUN}`);
    await confirmName(pageB, `Bea${RUN}`);
    await pageA.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // keys back to the world
    await pageA.keyboard.press("e");
    await expect.poll(async () => (await hall(pageA)).stage).toEqual({ holder: aId, status: "preparing", queue: [] });
    await expect(pageA.locator(".zw-stage-widget")).toContainText("You're on stage — Start sharing");

    // B sees the holder, and queues up behind A.
    await expect.poll(async () => (await hall(pageB)).stage.holder).toBe(aId);
    await expect.poll(async () => (await stageState(pageB)).screenMessage?.title ?? "").toMatch(/is getting ready…$/);
    await pageB.evaluate(() => (window as DebugWindow).__stageSystem!.requestStage());
    await expect.poll(async () => (await hall(pageB)).stage.queue).toEqual([bId]);
    await expect.poll(async () => (await hall(pageA)).stage.queue).toEqual([bId]);
    await expect(pageB.locator(".zw-stage-widget")).toContainText("You're #1 in the stage queue");

    // A's wallet locks again: the presenter's voice notice sits right under "Start sharing" in the widget.
    await setWallet(pageA, "locked");
    await expect(pageA.locator(".zw-stage-widget-you .zw-stage-widget-voice")).toContainText("unlocked wallet");
    // A's share path: the confirm dialog warns about video AND audio, offers computer sound, and explains voice is needed.
    await pageA.locator(".zw-stage-widget").getByRole("button", { name: "Start sharing" }).click();
    const dialog = pageA.locator(".zw-stage-confirm");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Everyone in the Watch Hall will see what you share");
    await expect(dialog).toContainText("hear its audio");
    await expect(dialog).toContainText("Never show a seed phrase");
    // The share mode — Slides (sharp text, 30 fps) by default, or Video (smooth, 60 fps); the device remembers it.
    const slides = dialog.getByRole("radio", { name: /Slides — sharp text, 30 fps/ });
    const video = dialog.getByRole("radio", { name: /Video — smooth, 60 fps/ });
    await expect(slides).toBeChecked();
    await expect(video).not.toBeChecked();
    await video.check();
    await expect(slides).not.toBeChecked();
    expect(await pageA.evaluate(() => localStorage.getItem("watch-hall-share-mode-v1"))).toBe("video");
    await slides.check();
    const computerSound = dialog.getByLabel("Share my computer's sound (whole screen or window; Windows/ChromeOS)");
    await expect(computerSound).not.toBeChecked();
    await expect(dialog.locator(".zw-stage-confirm-warn")).toContainText("notifications and other apps' sound");
    await computerSound.check();
    await expect(dialog.locator(".zw-stage-confirm-warn")).toHaveClass(/active/);
    const notice = dialog.locator(".zw-stage-voice-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Voice is off");
    await expect(notice).toContainText("unlocked wallet");
    await expect(notice.getByRole("button", { name: "Open wallet" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Choose what to share" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    // Nothing was ever captured.
    expect(await pageA.evaluate(() => (window as DebugWindow).__gdmCalls)).toBe(0);
    expect((await hall(pageA)).stage.status).toBe("preparing");

    // A gives the stage up: the queue head (B) becomes the holder.
    await pageA.locator(".zw-stage-widget").getByRole("button", { name: "Leave the stage" }).click();
    await expect.poll(async () => (await hall(pageB)).stage).toEqual({ holder: bId, status: "preparing", queue: [] });
    await expect(pageB.locator(".zw-stage-widget")).toContainText("You're on stage — Start sharing");
    await expect(pageA.locator(".zw-stage-widget")).not.toContainText("You're on stage");
    await expect(pageA.locator(".zw-stage-widget")).toContainText("is getting ready");
    await pageB.locator(".zw-stage-widget").getByRole("button", { name: "Leave the stage" }).click();
    await expect.poll(async () => (await hall(pageA)).stage.holder).toBe(null);
    await expect.poll(async () => (await stageState(pageA)).screenMessage?.title).toBe("Nobody on stage — request it at the podium");

    // Leaving the hall drops the hall state and the watch-mode button.
    await standAtAnchor(pageB, ANCHOR.spawn);
    await expect.poll(async () => (await hall(pageB)).member).toBe(false);
    await expect(pageB.locator(".zw-stage-watch")).toBeHidden();
    await expect(pageB.locator(".zw-stage-widget")).toBeHidden();
    expect((await stageState(pageB)).inside).toBe(false);

    expect(a.errors, `page errors on A:\n${a.errors.join("\n")}`).toEqual([]);
    expect(b.errors, `page errors on B:\n${b.errors.join("\n")}`).toEqual([]);
  });

  test("stage moderation: an audience vote ends a live share and benches the presenter; a host removes from the queue and sets a cooldown", async ({ browser }) => {
    const a = await openClient(browser);
    const b = await openClient(browser);
    const pageA = a.page;
    const pageB = b.page;
    const voters: Awaited<ReturnType<typeof rawMember>>[] = [];
    try {
      await setWallet(pageA, "ready");
      await setWallet(pageB, "ready");
      await confirmName(pageA, `Ari${RUN}`);
      await confirmName(pageB, `Bo${RUN}`);
      await standAtAnchor(pageA, ANCHOR.hallPodium);
      await standAtAnchor(pageB, ANCHOR.hallFloor);
      await expect.poll(async () => (await hall(pageA)).member).toBe(true);
      await expect.poll(async () => (await hall(pageB)).member).toBe(true);
      const aId = (await hall(pageA)).localPlayerId!;

      // A takes the stage and reports a live share, as StageSystem does after a LiveKit publish (no SFU in this suite).
      await widget(pageA).getByRole("button", { name: /^Request the stage/ }).click();
      await expect.poll(async () => (await hall(pageA)).stage.holder).toBe(aId);
      await pageA.evaluate(() => (window as DebugWindow).__networkClient!.sendHall({ type: "hall_stage_live", live: true, audio: true }));

      // The vote opens with the share. Two members (B and A) → the bar is the minimum, 3. The presenter sees the count too.
      await expect(widget(pageB).locator(".zw-stage-widget-vote")).toContainText("0 of 3 votes to end this share");
      await expect(widget(pageA).locator(".zw-stage-widget-vote")).toContainText("0 of 3 votes to end your share");
      await expect(widget(pageA).getByRole("button", { name: /Vote to end this share/ })).toHaveCount(0);
      await widget(pageB).getByRole("button", { name: /Vote to end this share/ }).click();
      await expect(widget(pageB).locator(".zw-stage-widget-vote")).toContainText("1 of 3 votes to end this share");
      await expect(widget(pageB).getByRole("button", { name: "Take back my vote to end this share" })).toBeVisible();
      await expect(widget(pageA).locator(".zw-stage-widget-vote")).toContainText("1 of 3 votes to end your share");

      // Two more members with owned names join; their arrival keeps the bar at 3 (4 others → 50 % is 2, the minimum is 3).
      voters.push(await rawMember(pageA, `Vee${RUN}`), await rawMember(pageA, `Wes${RUN}`));
      await expect(widget(pageB).locator(".zw-stage-widget-vote")).toContainText("1 of 3 votes");
      voters[0]!.send({ type: "hall_stage_vote", end: true });
      await expect(widget(pageA).locator(".zw-stage-widget-vote")).toContainText("2 of 3 votes to end your share");
      // Nobody is told who voted: the raw member's copy carries only the counts and its own flag.
      const seen = await voters[1]!.waitFor((m) => m.type === "hall_vote" && m.votes === 2);
      expect(Object.keys(seen).sort()).toEqual(["needed", "type", "voted", "votes"]);
      expect(seen.voted).toBe(false);
      voters[1]!.send({ type: "hall_stage_vote", end: true });

      // The bar is reached: the share ends for everyone, and A is benched for 10 minutes (the server refuses a new request).
      await expect.poll(async () => (await hall(pageB)).stage.holder).toBe(null);
      await expect(widget(pageB).locator(".zw-stage-widget-vote")).toHaveCount(0);
      await widget(pageA).getByRole("button", { name: /^Request the stage/ }).click();
      await expect(chatLine(pageA, "You can't take the stage for another 10 min")).toBeVisible();
      expect((await hall(pageA)).stage.queue).toEqual([]);

      // Host tools (the e2e host key): B unlocks them.
      await widget(pageB).getByRole("button", { name: "Show host tools" }).click();
      await widget(pageB).getByRole("button", { name: "Unlock host tools with the host key" }).click();
      const keyField = pageB.locator('input[type="password"][aria-label="Host key"]');
      await keyField.fill(HOST_KEY);
      await keyField.press("Enter");
      await expect(chatLine(pageB, "Host tools unlocked for this session.")).toBeVisible();

      // A raw member takes the stage, another queues: B's queue row offers Remove and a cooldown menu.
      voters[0]!.send({ type: "hall_stage_request" });
      voters[0]!.send({ type: "hall_stage_live", live: true, audio: false }); // live, so the 45 s prepare timeout can't end it mid-test
      voters[1]!.send({ type: "hall_stage_request" });
      await expect.poll(async () => (await hall(pageB)).stage.queue).toEqual([voters[1]!.playerId]);
      const queueRow = widget(pageB).locator(".zw-stage-widget-list li", { hasText: `Wes${RUN}` });
      await expect(queueRow.getByRole("button", { name: `Remove Wes${RUN} from the queue` })).toBeVisible();
      await expect(queueRow.getByLabel(`Stage cooldown for Wes${RUN}`)).toBeVisible();
      await queueRow.getByRole("button", { name: `Remove Wes${RUN} from the queue` }).click();
      await expect.poll(async () => (await hall(pageB)).stage.queue).toEqual([]);

      // A 10-minute cooldown on the holder ends that turn; the benched member can't queue again.
      await widget(pageB).getByLabel(`Stage cooldown for Vee${RUN}`).selectOption({ label: "10 min" });
      await expect(chatLine(pageB, `Vee${RUN} can't take the stage for 10 min.`)).toBeVisible();
      await expect.poll(async () => (await hall(pageB)).stage.holder).toBe(null);
      voters[0]!.send({ type: "hall_stage_request" });
      const refused = await voters[0]!.waitFor((m) => m.type === "hall_error" && m.reason === "cooldown");
      expect(refused.retryInMs).toBeGreaterThan(9 * 60_000);

      expect(a.errors, `page errors on A:\n${a.errors.join("\n")}`).toEqual([]);
      expect(b.errors, `page errors on B:\n${b.errors.join("\n")}`).toEqual([]);
    } finally {
      for (const voter of voters) voter.close();
    }
  });
});
