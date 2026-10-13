import { test, expect as baseExpect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { WebSocket as WsClient } from "ws";
import { useClientAddress } from "./support/clientAddress.ts";

/**
 * Moderation (ADR-019) end to end, three real clients through the real server:
 *
 *   report → the moderator sees it → mute → kick → ban → the banned player cannot rejoin → unban
 *
 * Every client gets its own address through X-Forwarded-For (the e2e server trusts 127.0.0.1 — TRUST_PROXY; the game
 * socket is relayed by support/clientAddress.ts, since Chromium sends no extra headers on WebSocket upgrades), so a ban
 * keyed by the connection hash (a guest has no owned name) never locks out the rest of the suite. The moderator signs
 * in with the e2e server's test-only key (playwright.config.ts) through Profile → "Moderator sign-in".
 * MODERATION_SHOTS=<dir> writes screenshots (1600×900 JPEG, quality 88). The pages otherwise run at the
 * usual 1280×720 (three software-rendered worlds at once are slow), and the reporter's page closes once its report is in.
 */

const expect = baseExpect.configure({ timeout: 30_000 });
const MOD_KEY = process.env.E2E_MODERATOR_KEY ?? "e2e-moderator-key-not-a-secret-3Hv8Kd";
const GAME_SERVER_WS = process.env.E2E_GAME_SERVER_WS ?? "ws://127.0.0.1:8787";
const SHOTS = process.env.MODERATION_SHOTS ?? "";
const RUN = Math.floor(Math.random() * 200) + 20;
const ADDRESS = { moderator: `203.0.113.${RUN}`, reporter: `203.0.113.${RUN + 1}`, player: `203.0.113.${RUN + 2}`, other: `198.51.100.${RUN}` };

type DebugWindow = Window & {
  __networkClient?: { joined: boolean; connectionState: string };
  __identity?: () => { nickname: string };
  __hallStore?: { localPlayerId: string | null };
  __remotePlayers?: { getPlayer(id: string): unknown; isModerator(id: string): boolean };
  __moderationStore?: { isModerator: boolean; reports: readonly { id: string; target: string; reporter: string }[]; bans: readonly { id: string; nickname: string; kind: string }[]; mutes: readonly unknown[]; mutedUntil: number | null };
  __interactions?: { all: readonly { id: string; interact(): void }[] };
};

const contexts: BrowserContext[] = [];
const WORK_VIEWPORT = { width: 1280, height: 720 }; // the usual e2e size (smaller ones crowd the HUD)
const SHOT_VIEWPORT = { width: 1600, height: 900 };

async function open(browser: Browser, address: string): Promise<Page> {
  const { baseURL, storageState } = test.info().project.use;
  const context = await browser.newContext({
    viewport: WORK_VIEWPORT,
    ...(baseURL ? { baseURL } : {}),
    ...(storageState ? { storageState } : {}),
  });
  contexts.push(context);
  await useClientAddress(context, GAME_SERVER_WS, address, baseURL ? new URL(baseURL).origin : undefined);
  const page = await context.newPage();
  await page.goto("/?quality=low");
  await page.waitForFunction(() => (window as DebugWindow).__networkClient?.joined === true, null, { timeout: 180_000 });
  return page;
}

const idOf = (page: Page) => page.evaluate(() => (window as DebugWindow).__hallStore!.localPlayerId!);
const nameOf = (page: Page) => page.evaluate(() => (window as DebugWindow).__identity!().nickname);
const store = (page: Page) => page.evaluate(() => {
  const s = (window as DebugWindow).__moderationStore!;
  return { isModerator: s.isModerator, reports: s.reports.map((r) => ({ ...r })), bans: s.bans.map((b) => ({ ...b })), mutes: s.mutes.length, mutedUntil: s.mutedUntil };
});

async function waitForRemote(page: Page, playerId: string): Promise<void> {
  await page.waitForFunction((id) => Boolean((window as DebugWindow).__remotePlayers?.getPlayer(id)), playerId, { timeout: 60_000 });
}

/** The player menu on `playerId`, through the same path E uses. */
async function openMenu(page: Page, playerId: string): Promise<void> {
  await page.evaluate((id) => {
    const entry = (window as DebugWindow).__interactions!.all.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`no interactable for ${id}`);
    entry.interact();
  }, playerId);
  await expect(page.locator(".zw-player-menu")).toBeVisible();
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.setViewportSize(SHOT_VIEWPORT);
  await page.waitForTimeout(2500); // a few software-rendered frames at the new size
  await page.screenshot({ path: `${SHOTS}/${name}.jpg`, type: "jpeg", quality: 88 });
  await page.setViewportSize(WORK_VIEWPORT);
}

/** A raw game socket from the test runner with the given client address: refused (close code) or admitted (null). */
function probe(address: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const socket = new WsClient(GAME_SERVER_WS, { headers: { "X-Forwarded-For": address } });
    const timer = setTimeout(() => {
      socket.close();
      resolve(null);
    }, 1500);
    socket.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 1005 || code === 1000 ? null : code);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test.describe("moderation — report, mute, kick, ban, unban (ADR-019)", () => {
  test.describe.configure({ mode: "serial" });
  test.afterAll(async () => {
    for (const context of contexts.splice(0)) await context.close();
  });

  test("report → the moderator sees it → mute → kick → ban → the banned player cannot rejoin → unban", async ({ browser }) => {
    test.setTimeout(1_800_000);
    const moderator = await open(browser, ADDRESS.moderator);
    const reporter = await open(browser, ADDRESS.reporter);
    const player = await open(browser, ADDRESS.player);
    const [modId, reporterId, playerId] = await Promise.all([idOf(moderator), idOf(reporter), idOf(player)]);
    const [reporterName, playerName] = await Promise.all([nameOf(reporter), nameOf(player)]);
    for (const [page, ids] of [
      [moderator, [reporterId, playerId]],
      [reporter, [modId, playerId]],
      [player, [modId]],
    ] as const) {
      for (const id of ids) await waitForRemote(page, id);
    }

    // 1. The moderator signs in from Profile (anywhere — the same field as the Watch Hall host key).
    await moderator.locator(".zw-action", { hasText: "Profile" }).click();
    await moderator.locator(".zw-profile-moderator-signin").click();
    const keyField = moderator.locator('input[type="password"][aria-label="Moderator key"]');
    await keyField.fill(MOD_KEY);
    await moderator.locator(".zw-hall-key-backdrop button[type=submit]").click();
    await expect.poll(async () => (await store(moderator)).isModerator).toBe(true);
    await expect(moderator.locator(".zw-action-moderation")).toBeVisible();
    await expect(moderator.locator(".zw-chat-line", { hasText: "signed in as a moderator" })).toBeVisible();
    // Everyone sees the Moderator tag.
    await expect.poll(() => reporter.evaluate((id) => (window as DebugWindow).__remotePlayers!.isModerator(id), modId)).toBe(true);
    await expect(reporter.locator(".zw-nameplate .zw-nameplate-tag", { hasText: "Moderator" })).toHaveCount(1);

    // 2. Report: the reporter opens the player's menu → Report → a reason and a note; the dialog says moderators see the nickname.
    await openMenu(reporter, playerId);
    await reporter.locator(".zw-player-menu-report").click();
    const dialog = reporter.locator(".zw-report-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".zw-report-privacy")).toContainText("Moderators will see your nickname with this report");
    await dialog.locator(".zw-mod-choice", { hasText: "Spam" }).click();
    await dialog.locator(".zw-report-note").fill("Posting the same link over and over in General.");
    await shot(reporter, "report-dialog");
    await dialog.locator("button[type=submit]").click();
    await expect(reporter.locator(".zw-chat-line", { hasText: "Thanks — moderators were notified." })).toBeVisible();
    await expect(dialog).toBeHidden();
    // The reporter's part is done: one software-rendered world fewer for the rest of the run.
    await reporter.context().close();

    // 3. The moderator sees it: live (a chat line, the badge) and in the Moderation panel, with the reporter's nickname.
    await expect(moderator.locator(".zw-chat-line", { hasText: `${reporterName} reported ${playerName}` })).toBeVisible();
    await expect(moderator.locator(".zw-action-moderation .zw-action-badge")).toHaveText("1");
    await moderator.locator(".zw-action-moderation").click();
    const panel = moderator.locator(".zw-moderation-panel");
    const reportRow = panel.locator(".zw-mod-report", { hasText: playerName });
    await expect(reportRow).toContainText(`Reported by ${reporterName}`);
    await expect(reportRow).toContainText("Spam");
    await expect(reportRow).toContainText("Posting the same link");
    await shot(moderator, "moderator-panel");
    // The reported player was told nothing.
    expect(await player.locator(".zw-chat-line", { hasText: /report/i }).count()).toBe(0);

    // 4. Mute (from the report): the player's chat is dropped and it says until when.
    await reportRow.getByRole("button", { name: "Mute…" }).click();
    const muteDialog = moderator.locator(".zw-mod-action-mute");
    await muteDialog.locator(".zw-mod-choice", { hasText: "10 min" }).click();
    await muteDialog.locator("button[type=submit]").click();
    await expect(moderator.locator(".zw-chat-line", { hasText: `Muted ${playerName} until` })).toBeVisible();
    await expect(player.locator(".zw-chat-line", { hasText: "A moderator muted you until" })).toBeVisible();
    await expect.poll(async () => (await store(player)).mutedUntil !== null).toBe(true);
    await player.locator(".zw-chat-input").fill("can anyone hear me?");
    await player.locator(".zw-chat-input").press("Enter");
    await expect(player.locator(".zw-chat-input")).toHaveAttribute("placeholder", /Muted by a moderator until/);
    await expect(player.locator(".zw-chat-line", { hasText: "Not sent — you're muted until" })).toBeVisible();
    expect(await moderator.locator(".zw-chat-line", { hasText: "can anyone hear me?" }).count(), "the muted line reached nobody").toBe(0);
    await player.locator(".zw-chat-input").fill("");
    await shot(player, "muted-chat");
    await moderator.locator(".zw-moderation-panel button", { hasText: "Close" }).click();

    // 5. Kick (from the player menu): the player sees a clear message, and can't come back for 10 minutes.
    await openMenu(moderator, playerId);
    await moderator.locator(".zw-player-menu-mod-kick").click();
    await moderator.locator(".zw-mod-action-kick button[type=submit]").click();
    const removed = player.locator(".zw-removed");
    await expect(removed).toBeVisible();
    await expect(removed).toContainText("A moderator removed you from Zocial World");
    await expect(removed).toContainText("You can come back at");
    await shot(player, "kicked-message");
    await expect.poll(() => moderator.evaluate((id) => Boolean((window as DebugWindow).__remotePlayers!.getPlayer(id)), playerId), { message: "gone for everyone at once" }).toBe(false);
    await removed.getByRole("button", { name: "Try again" }).click();
    await expect(removed).toContainText("A moderator removed you from Zocial World", { timeout: 15_000 });
    expect(await player.evaluate(() => (window as DebugWindow).__networkClient!.joined)).toBe(false);

    // The moderator lifts the kick early (Bans & mutes); the player comes back with a new session.
    await moderator.locator(".zw-action-moderation").click();
    await panel.locator('[data-tab="active"]').click();
    await panel.locator(".zw-mod-ban", { hasText: playerName }).getByRole("button", { name: "Lift kick" }).click();
    await expect(moderator.locator(".zw-chat-line", { hasText: `${playerName} may come back now.` })).toBeVisible();
    await moderator.locator(".zw-moderation-panel button", { hasText: "Close" }).click();
    await removed.getByRole("button", { name: "Try again" }).click();
    await player.waitForFunction(() => (window as DebugWindow).__networkClient?.joined === true, null, { timeout: 30_000 });
    await expect(removed).toBeHidden();
    const playerId2 = await idOf(player);
    const playerName2 = await nameOf(player);
    await waitForRemote(moderator, playerId2);

    // 6. Ban for an hour: the banned player cannot rejoin — not with Try again, not with a reload.
    await openMenu(moderator, playerId2);
    await moderator.locator(".zw-player-menu-mod-ban").click();
    const banDialog = moderator.locator(".zw-mod-action-ban");
    await expect(banDialog).toContainText("at most 24 hours");
    await banDialog.locator(".zw-mod-choice", { hasText: "1 hour" }).click();
    await banDialog.locator("button[type=submit]").click();
    await expect(removed).toContainText("You're banned from this server");
    await expect(removed).toContainText("The ban lasts until");
    await shot(player, "banned-message");
    await removed.getByRole("button", { name: "Try again" }).click();
    await expect(removed).toContainText("You're banned from this server", { timeout: 15_000 });
    await player.reload();
    await expect(player.locator(".zw-removed")).toContainText("You're banned from this server", { timeout: 180_000 });
    expect(await probe(ADDRESS.player), "a new connection from the banned network is refused (4002)").toBe(4002);
    expect(await probe(ADDRESS.other), "another network is not").toBe(null);

    // 7. Unban: the player is back.
    await moderator.locator(".zw-action-moderation").click();
    await panel.locator('[data-tab="active"]').click();
    const banRow = panel.locator(".zw-mod-ban", { hasText: playerName2 });
    await expect(banRow).toContainText("by network");
    // The same line already followed "Lift kick" when the guest kept its name: count the new one.
    const comeBack = moderator.locator(".zw-chat-line", { hasText: `${playerName2} may come back now.` });
    const comeBackBefore = await comeBack.count();
    await banRow.getByRole("button", { name: "Unban" }).click();
    await expect(comeBack).toHaveCount(comeBackBefore + 1);
    await panel.locator('[data-tab="log"]').click();
    await expect(panel.locator(".zw-mod-log-line").first()).toContainText("lifted the ban on");
    await expect(panel.locator(".zw-mod-log-line", { hasText: "kicked" })).toHaveCount(1);
    await expect(panel.locator(".zw-mod-log-line", { hasText: "muted" })).toHaveCount(1);
    await moderator.locator(".zw-moderation-panel button", { hasText: "Close" }).click();
    await player.locator(".zw-removed").getByRole("button", { name: "Try again" }).click();
    await player.waitForFunction(() => (window as DebugWindow).__networkClient?.joined === true, null, { timeout: 30_000 });
    expect(await probe(ADDRESS.player)).toBe(null);
  });
});
