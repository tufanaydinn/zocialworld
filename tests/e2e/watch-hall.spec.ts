import { test, expect as baseExpect, type Browser, type Page } from "@playwright/test";
import { ANCHOR, standAtAnchor } from "./support/anchors.ts";

/**
 * The Watch Hall's social UI and board feeds (docs/architecture/WATCH_HALL.md), with three real clients through the real server (no LiveKit needed):
 *
 *  - A walks through the door into the hall: zone label "WATCH HALL · …", the
 *    hall title card, the Hall chat tab and the stage widget — none of which C (outside) gets;
 *  - hall chat and reactions reach B inside but never C outside; a takeaway shared from the
 *    Discussion Corner menu is highlighted in chat and on the board; the member count;
 *  - a blocked player's lines vanish from chat and the board; hostile markup stays inert text;
 *  - the stage widget: A requests the stage (preparing, countdown; then A's client reports the
 *    share live as StageSystem would after a LiveKit publish, so the prepare timeout can't end the
 *    turn mid-test), B queues, B's raised hand shows in A's widget — give the floor, take it
 *    back, lower the hand;
 *  - A edits the speaker card in the widget (validated before sending); B opens it from the HUD
 *    "Now on stage" chip: hostile strings render as text, links are https / _blank / noopener;
 *  - A's browser closes while holding the stage → the server promotes B from the queue.
 *
 * Serial and on ?quality=low: three full clients on a software renderer are slow.
 */

const expect = baseExpect.configure({ timeout: 45_000 });

test.describe.configure({ mode: "serial", timeout: 420_000 });

interface HallDebug {
  readonly member: boolean;
  readonly localPlayerId: string | null;
  readonly hands: readonly string[];
  readonly floor: string | null;
  readonly stage: { holder: string | null; status: string; queue: string[]; card: { title: string } | null };
  subscribe(listener: (event: { type: string; counts?: Record<string, number> }) => void): () => void;
}
interface BoardsDebug {
  snapshot(): {
    discussion: { lines: { nickname: string; text: string; takeaway?: boolean }[]; reactions: Record<string, number>; tally: { label: string }; members: number } | null;
    speakerCard: { mode: string; title: string } | null;
  };
}
type DebugWindow = Window & {
  __worldReady?: boolean;
  __localPlayer?: { position: { x: number; y: number; z: number; set(x: number, y: number, z: number): void } };
  __remotePlayers?: { size: number };
  __networkClient?: { connectionState: string; joined: boolean; sendNickname(nickname: string): void; sendHall(message: unknown): void };
  __identity?: () => { nickname: string; canReceive: boolean };
  __hallStore?: HallDebug;
  __hallBoards?: BoardsDebug;
  __socialStore?: { block(playerId: string): void; unblock(playerId: string): void };
  __rx?: Record<string, number>[];
  __pwned?: number;
};

interface Client {
  readonly page: Page;
  readonly nickname: string;
  readonly errors: string[];
  id: string;
}

const RUN = Math.random().toString(36).slice(2, 6);
const HOSTILE_LINE = `<img src=x onerror="window.__pwned=1">hostile-${RUN}`;
const HOSTILE_TITLE = `<img src=x onerror="window.__pwned=2">Talk ${RUN}`;

let a: Client;
let b: Client;
let c: Client;

async function openClient(browser: Browser, nickname: string): Promise<Client> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?quality=low");
  await page.waitForFunction(() => (window as DebugWindow).__worldReady === true, null, { timeout: 240_000 });
  await page.waitForFunction(() => (window as DebugWindow).__networkClient?.joined === true, null, { timeout: 60_000 });
  // ADR-015: only wallet holders choose a name — the player becomes one (set_wallet) before renaming.
  await unlockWallet(page);
  // ADR-016: names are fee-confirmed on the test server — its DEV registry confirms a reservation on
  // its own (nothing is paid); a test name key stands in for the one the wallet derives at unlock.
  await page.evaluate(async (name) => {
    const modulePath = "/src/zcash/nameKey.ts";
    const nameKey = (await import(/* @vite-ignore */ modulePath)) as { activateNameKeyFromSeed(seed: Uint8Array, network: string): Promise<unknown> };
    await nameKey.activateNameKeyFromSeed(crypto.getRandomValues(new Uint8Array(64)), "test");
    await (window as unknown as { __confirmName(nickname: string): Promise<void> }).__confirmName(name);
  }, nickname);
  await page.waitForFunction((name) => (window as DebugWindow).__identity?.().nickname === name, nickname, { timeout: 15_000 });
  return { page, nickname, errors, id: "" };
}

function hall(page: Page): Promise<{ member: boolean; localPlayerId: string | null; hands: string[]; floor: string | null; holder: string | null; status: string; queue: string[]; card: string | null }> {
  return page.evaluate(() => {
    const h = (window as DebugWindow).__hallStore!;
    return { member: h.member, localPlayerId: h.localPlayerId, hands: [...h.hands], floor: h.floor, holder: h.stage.holder, status: h.stage.status, queue: [...h.stage.queue], card: h.stage.card?.title ?? null };
  });
}

function boards(page: Page): Promise<ReturnType<BoardsDebug["snapshot"]>> {
  return page.evaluate(() => (window as DebugWindow).__hallBoards!.snapshot());
}

function hallTab(page: Page) {
  return page.locator(".zw-chat-tab", { hasText: /^Hall/ });
}

function chatLine(page: Page, text: string) {
  return page.locator(".zw-chat-line", { hasText: text });
}

async function sayInHall(page: Page, text: string): Promise<void> {
  await hallTab(page).click();
  const input = page.locator(".zw-chat-input");
  await input.click();
  await input.fill(text);
  await input.press("Enter");
  await input.press("Escape"); // back to the world: E / WASD must not type into the chat
}

/** Records hall reaction batches this client receives (members only). */
async function collectReactions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as DebugWindow;
    w.__rx = [];
    w.__hallStore!.subscribe((event) => {
      if (event.type === "reactions" && event.counts) w.__rx!.push(event.counts);
    });
  });
}

function widget(page: Page) {
  return page.locator(".zw-stage-widget");
}

/** Presenting needs voice, which needs an unlocked wallet. The test flips the participation gate directly. */
async function unlockWallet(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const modulePath = "/src/zcash/participation.ts";
    const participation = (await import(/* @vite-ignore */ modulePath)) as { updateParticipationState(status: string): void };
    participation.updateParticipationState("ready");
  });
}

test.describe("the Watch Hall's social UI", () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(900_000);
    a = await openClient(browser, `Ana${RUN}`);
    b = await openClient(browser, `Ben${RUN}`);
    c = await openClient(browser, `Cy${RUN}`);
    for (const client of [a, b, c]) {
      await client.page.waitForFunction(() => ((window as DebugWindow).__remotePlayers?.size ?? 0) >= 2, null, { timeout: 60_000 });
      client.id = (await hall(client.page)).localPlayerId!;
    }
  });

  test.afterAll(async () => {
    for (const client of [a, b, c]) await client?.page.context().close().catch(() => undefined);
  });

  test("the hall door leads into the hall: zone label, title card, Hall tab and stage widget only inside", async () => {
    await standAtAnchor(a.page, ANCHOR.hallDoor);
    await expect(a.page.locator(".zw-interaction-prompt.visible")).toContainText("Enter the Watch Hall");
    await a.page.keyboard.press("e");
    await expect.poll(() => a.page.evaluate(() => (window as DebugWindow).__localPlayer!.position.x)).toBeLessThan(-900);
    await expect(a.page.locator(".zw-zone-label")).toHaveText(/^Watch Hall · /);
    await expect(a.page.locator(".zw-zone-label")).toHaveCSS("text-transform", "uppercase"); // shown as "WATCH HALL · …"
    await expect(a.page.locator(".zw-hud-corner")).toContainText("WATCH HALL — Zocial World");
    await expect(a.page.locator(".zw-hud-corner")).toContainText("Hold G: emotes · H: raise hand · 1–8: react"); // the hall's keys, in plain words
    await expect.poll(async () => (await hall(a.page)).member).toBe(true);
    await expect(hallTab(a.page)).toBeVisible();
    await expect(widget(a.page)).toBeVisible();
    await expect(widget(a.page).locator(".zw-stage-widget-status")).toHaveText("Open stage");

    await standAtAnchor(b.page, ANCHOR.hallFloor);
    await expect.poll(async () => (await hall(b.page)).member).toBe(true);
    await expect(hallTab(b.page)).toBeVisible();

    // C stays outside: no hall state, no Hall tab, no widget.
    expect((await hall(c.page)).member).toBe(false);
    await expect(hallTab(c.page)).toBeHidden();
    await expect(widget(c.page)).toBeHidden();
  });

  test("hall chat and reactions reach a member inside but not a player outside; takeaways are highlighted", async () => {
    await collectReactions(b.page);
    await collectReactions(c.page);

    const token = `hall-${RUN}`;
    await sayInHall(a.page, token);
    // B is on General: the Hall tab counts the unread line.
    await expect(hallTab(b.page)).toHaveText("Hall · 1");
    await hallTab(b.page).click();
    await expect(chatLine(b.page, token)).toBeVisible();
    await expect(chatLine(b.page, token)).toContainText(a.nickname);
    await expect(hallTab(b.page)).toHaveText("Hall");

    // A takeaway from the Discussion Corner menu (E at the board → Share Takeaways prefills "💡 ").
    await standAtAnchor(a.page, ANCHOR.hallDiscussion);
    await expect(a.page.locator(".zw-interaction-prompt.visible")).toContainText("Discussion Corner");
    await a.page.keyboard.press("e");
    const menu = a.page.locator(".zw-hall-menu-backdrop.visible");
    await expect(menu).toBeVisible();
    await expect(menu.locator(".zw-hall-menu-action")).toHaveCount(4);
    await menu.getByRole("button", { name: /^Share Takeaways/ }).click();
    await expect(menu).toBeHidden();
    const input = a.page.locator(".zw-chat-input");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("💡 ");
    await a.page.keyboard.type(`takeaway-${RUN}`);
    await a.page.keyboard.press("Enter");
    await input.press("Escape");
    await expect(chatLine(b.page, `takeaway-${RUN}`)).toHaveClass(/zw-chat-takeaway/);
    await expect.poll(async () => (await boards(b.page)).discussion?.lines.find((line) => line.text.includes(`takeaway-${RUN}`))?.takeaway ?? false).toBe(true);

    // Reactions: aggregated batches reach B (and the board's tallies), never C. The board counts per stage
    // turn, so A takes the stage first (a new session from zero, whatever earlier specs left on this server).
    await a.page.evaluate(() => (window as DebugWindow).__networkClient!.sendHall({ type: "hall_stage_request" }));
    await expect.poll(async () => (await boards(b.page)).discussion?.tally.label).toBe("This session");
    for (const reaction of ["clap", "clap", "clap", "zec"]) await a.page.evaluate((r) => (window as DebugWindow).__networkClient!.sendHall({ type: "hall_react", reaction: r }), reaction);
    await expect.poll(async () => (await boards(b.page)).discussion?.reactions.clap ?? 0).toBe(3);
    // The zec reaction may land in the next 250 ms flush (and the board feed is ≤ 1 Hz): poll for it too.
    await expect.poll(async () => (await boards(b.page)).discussion?.reactions.zec ?? 0).toBe(1);
    expect(await b.page.evaluate(() => (window as DebugWindow).__rx!.length)).toBeGreaterThan(0);
    await a.page.evaluate(() => (window as DebugWindow).__networkClient!.sendHall({ type: "hall_stage_stop" }));
    await expect.poll(async () => (await hall(b.page)).holder).toBeNull();
    await expect.poll(async () => (await boards(b.page)).discussion?.members ?? 0).toBe(2);

    await c.page.waitForTimeout(2500);
    await expect(chatLine(c.page, token)).toHaveCount(0);
    await expect(chatLine(c.page, `takeaway-${RUN}`)).toHaveCount(0);
    expect(await c.page.evaluate(() => (window as DebugWindow).__rx!.length)).toBe(0);
    expect((await boards(c.page)).discussion).toBeNull(); // C's boards never ran: the hall isn't C's location
  });

  test("hostile markup stays inert text; a blocked player's lines are hidden in chat and on the board", async () => {
    await sayInHall(a.page, HOSTILE_LINE);
    const hostile = chatLine(b.page, `hostile-${RUN}`);
    await expect(hostile).toBeVisible();
    await expect(hostile.locator(".zw-chat-text")).toHaveText(HOSTILE_LINE);
    await expect(b.page.locator(".zw-chat-log img")).toHaveCount(0);
    await expect.poll(async () => (await boards(b.page)).discussion?.lines.some((line) => line.text === HOSTILE_LINE) ?? false).toBe(true);
    expect(await b.page.evaluate(() => (window as DebugWindow).__pwned)).toBeUndefined();

    await b.page.evaluate((id) => (window as DebugWindow).__socialStore!.block(id), a.id);
    await sayInHall(a.page, `after-block-${RUN}`);
    await expect(chatLine(a.page, `after-block-${RUN}`)).toBeVisible(); // the server echoed it
    await b.page.waitForTimeout(2500);
    await expect(chatLine(b.page, `after-block-${RUN}`)).toHaveCount(0);
    // Blocking also hides what A said before from B's Discussion Corner board.
    await expect.poll(async () => (await boards(b.page)).discussion?.lines.filter((line) => line.nickname === a.nickname).length ?? -1).toBe(0);
    await b.page.evaluate((id) => (window as DebugWindow).__socialStore!.unblock(id), a.id);
  });

  test("stage widget: request and queue, a raised hand, the floor, and the speaker card editor; the card renders hostile text safely", async () => {
    // Presenting needs an unlocked wallet: A and B pass the gate; then A requests the stage from the
    // widget: the stage is free, so A holds it, preparing.
    await unlockWallet(a.page);
    await unlockWallet(b.page);
    await widget(a.page).getByRole("button", { name: /^Request the stage/ }).click();
    await expect.poll(async () => ({ holder: (await hall(a.page)).holder, status: (await hall(a.page)).status })).toEqual({ holder: a.id, status: "preparing" });
    await expect(widget(a.page)).toContainText("You're on stage — Start sharing");
    await expect(widget(a.page).locator(".zw-stage-widget-countdown")).toHaveText(/^0:[0-4]\d$/);
    // No LiveKit here: report the share as live the way StageSystem does after a real publish, so the 45 s prepare
    // timeout can't pass the turn on while this slow, software-rendered test is still using it.
    await a.page.evaluate(() => (window as DebugWindow).__networkClient!.sendHall({ type: "hall_stage_live", live: true, audio: false }));
    await expect(widget(b.page).locator(".zw-stage-widget-status")).toHaveText(`LIVE · ${a.nickname} · no sound`);
    await expect(widget(b.page)).toContainText(`${a.nickname} is presenting`);

    // The audience vote opens with the live share (C is outside, so B is the only other member: the bar
    // is the minimum, 3). B votes and takes it back; A, the presenter, sees the count but has no vote.
    await expect(widget(b.page).locator(".zw-stage-widget-vote")).toContainText("0 of 3 votes to end this share");
    await widget(b.page).getByRole("button", { name: /Vote to end this share/ }).click();
    await expect(widget(a.page).locator(".zw-stage-widget-vote")).toContainText("1 of 3 votes to end your share");
    await expect(widget(a.page).getByRole("button", { name: /Vote to end this share/ })).toHaveCount(0);
    await widget(b.page).getByRole("button", { name: "Take back my vote to end this share" }).click();
    await expect(widget(a.page).locator(".zw-stage-widget-vote")).toContainText("0 of 3 votes to end your share");

    // B queues; A sees B in the queue with a Hand over button.
    await widget(b.page).getByRole("button", { name: /^Request the stage/ }).click();
    await expect.poll(async () => (await hall(a.page)).queue).toEqual([b.id]);
    await expect(widget(b.page)).toContainText("You're #1 in the stage queue");
    await expect(widget(a.page).getByRole("button", { name: `Hand over the stage to ${b.nickname}` })).toBeVisible();

    // B raises a hand: it shows in A's widget; A gives B the floor, takes it back, then lowers B's next hand.
    await b.page.evaluate(() => (window as DebugWindow).__networkClient!.sendHall({ type: "hall_hand", raised: true }));
    await expect(widget(a.page).locator(".zw-stage-widget-hands")).toContainText(b.nickname);
    await expect(widget(b.page).locator(".zw-stage-widget-hands")).toContainText("✋ You");
    await widget(a.page).getByRole("button", { name: `Give the floor to ${b.nickname}` }).click();
    await expect.poll(async () => (await hall(a.page)).floor).toBe(b.id);
    expect((await hall(a.page)).hands).toEqual([]);
    await expect(widget(a.page)).toContainText(`🎙 ${b.nickname} has the floor`);
    await expect(widget(b.page)).toContainText("🎙 You have the floor");
    await expect(widget(b.page).getByRole("button", { name: /^Give up the floor/ })).toBeVisible();
    await expect(chatLine(b.page, "You have the floor — everyone in the hall hears your microphone")).toBeVisible();
    await widget(a.page).getByRole("button", { name: "Take back the floor" }).click();
    await expect.poll(async () => (await hall(b.page)).floor).toBe(null);

    await b.page.evaluate(() => (window as DebugWindow).__networkClient!.sendHall({ type: "hall_hand", raised: true }));
    await expect(widget(a.page).locator(".zw-stage-widget-hands")).toContainText(b.nickname);
    await widget(a.page).getByRole("button", { name: `Lower ${b.nickname}'s hand` }).click();
    await expect.poll(async () => (await hall(b.page)).hands).toEqual([]);
    await expect(widget(a.page).locator(".zw-stage-widget-hands")).toHaveCount(0);
    await expect(widget(b.page).locator(".zw-stage-widget-hands")).toHaveCount(0);

    // A edits the speaker card; bad links are refused in the form, before anything is sent.
    await widget(a.page).getByRole("button", { name: /^Edit card/ }).click();
    const editor = a.page.locator(".zw-hall-card-backdrop");
    await expect(editor).toBeVisible();
    await editor.getByRole("textbox", { name: "Title", exact: true }).fill(HOSTILE_TITLE);
    await editor.getByRole("textbox", { name: "Speaker", exact: true }).fill("<b>Eve</b>");
    await editor.getByRole("textbox", { name: "Project", exact: true }).fill("Zebra");
    await editor.getByLabel("Link 1 URL").fill("github.com/ZcashFoundation/zebra");
    await expect(editor.getByLabel("Link 1 kind")).toHaveValue("github");
    await editor.getByLabel("Link 2 URL").fill("http://evil.example/phish");
    await editor.getByRole("button", { name: /^Save/ }).click();
    await expect(editor).toContainText("Links must start with https://");
    expect((await hall(a.page)).card).toBe(null);
    await editor.getByLabel("Link 2 URL").fill("https://forum.zcashcommunity.com/t/some-topic/12345");
    await editor.getByLabel("Link 3 URL").fill("https://z.cash/");
    await editor.getByRole("button", { name: /^Save/ }).click();
    await expect(editor).toHaveCount(0);
    await expect.poll(async () => (await hall(b.page)).card).toBe(HOSTILE_TITLE);

    // B opens the card from the HUD chip: text stays text, links are https new tabs with noopener. On this 720-px-tall
    // window the chip gives its height to the expanded stage panel, so B collapses the panel first.
    await widget(b.page).locator(".zw-stage-widget-toggle").click();
    const chip = b.page.locator(".zw-now-on-stage.visible");
    await expect(chip).toContainText(HOSTILE_TITLE);
    await chip.click();
    const card = b.page.locator(".zw-speaker-card-backdrop.visible");
    await expect(card).toBeVisible();
    await expect(card.locator(".zw-speaker-card-title")).toHaveText(HOSTILE_TITLE);
    await expect(card.locator(".zw-speaker-card-facts")).toContainText("<b>Eve</b>");
    await expect(card.locator(".zw-speaker-card-facts")).toContainText(a.nickname);
    await expect(card.locator("img, b, script")).toHaveCount(0);
    const links = card.locator("a");
    await expect(links).toHaveCount(3);
    for (const link of await links.all()) {
      expect(await link.getAttribute("href")).toMatch(/^https:\/\//);
      expect(await link.getAttribute("target")).toBe("_blank");
      expect(await link.getAttribute("rel")).toContain("noopener");
      expect(await link.getAttribute("rel")).toContain("noreferrer");
    }
    expect(await b.page.evaluate(() => (window as DebugWindow).__pwned)).toBeUndefined();
    await expect.poll(async () => (await boards(b.page)).speakerCard?.title).toBe(HOSTILE_TITLE);
    await card.getByRole("button", { name: /^Close/ }).click();
    await expect(card).toBeHidden();
    await widget(b.page).locator(".zw-stage-widget-toggle").click(); // expanded again
    await expect(widget(b.page).locator(".zw-stage-widget-body")).toBeVisible();
  });

  test("the holder's browser closes → the queued player is promoted; the Hall tab goes away outside", async () => {
    await a.page.context().close();
    await expect.poll(async () => ({ holder: (await hall(b.page)).holder, status: (await hall(b.page)).status }), { timeout: 60_000 }).toEqual({ holder: b.id, status: "preparing" });
    await expect(widget(b.page)).toContainText("You're on stage — Start sharing");
    await widget(b.page).getByRole("button", { name: "Leave the stage" }).click();
    await expect.poll(async () => (await hall(b.page)).holder).toBe(null);

    // Leaving the hall drops the Hall tab and the widget.
    await standAtAnchor(b.page, ANCHOR.spawn);
    await expect.poll(async () => (await hall(b.page)).member).toBe(false);
    await expect(hallTab(b.page)).toBeHidden();
    await expect(widget(b.page)).toBeHidden();

    expect(a.errors, `page errors on A:\n${a.errors.join("\n")}`).toEqual([]);
    expect(b.errors, `page errors on B:\n${b.errors.join("\n")}`).toEqual([]);
    expect(c.errors, `page errors on C:\n${c.errors.join("\n")}`).toEqual([]);
  });
});
