import { test, expect as baseExpect, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * Seats, the emote wheel and raised hands in the Watch Hall
 * (docs/architecture/WATCH_HALL.md, ADR-014 §§ 9–11), two clients against the e2e game server:
 *
 *  - E at a free seat (the seat outranks the neighbour's player card) → the server seats A, whose
 *    animation stays 'sit' for more than a second at the seat;
 *  - B sees A's remote avatar in 'sit' at that seat;
 *  - B claiming the same seat gets the "taken" chat line;
 *  - WASD stands A up and the seat frees on both clients;
 *  - hold G + pick Dance → A's state is 'dance' and B sees 'dance';
 *  - in the hall, H raises A's hand → a ✋ badge on A's nameplate on B.
 *
 * ?quality=low (placeholder avatars) and software rendering: give every expectation room.
 */

const expect = baseExpect.configure({ timeout: 120_000 });

test.describe.configure({ mode: "serial", timeout: 900_000 });

interface SeatDebug {
  readonly id: number;
  readonly row: number;
  readonly side: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly standX: number;
  readonly standZ: number;
}
interface Vec {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  set(x: number, y: number, z: number): void;
}
type DebugWindow = Window & {
  __worldReady?: boolean;
  __localPlayer?: { position: Vec; animation: { getState(): string } };
  __remotePlayers?: { size: number; getPlayer(id: string): { nickname: string; object: { position: Vec }; animation: { getState(): string } } | undefined };
  __hallStore?: { member: boolean; localPlayerId: string | null; mySeat: number | null; myHandRaised: boolean; occupantOf(seatId: number): string | null };
  __seatSystem?: { claim(seatId: number): void };
  __emotes?: { wheel: { isOpen: boolean; highlightedLabel: string } };
  __interactions?: { nearest: { id: string } | null };
  __watchHall?: { seats: readonly SeatDebug[] };
};

/**
 * The seats the test uses, read from the active hall: A's seat is the first seat with a neighbour in the same row and
 * block, and B waits at that neighbour (within A's 5 m player radius, but farther from A than A's own seat).
 */
async function seatPair(page: Page): Promise<{ seat: number; other: number }> {
  return page.evaluate(() => {
    const seats = (window as DebugWindow).__watchHall!.seats;
    for (const a of seats) {
      const neighbours = seats.filter((b) => b.id !== a.id && b.row === a.row && b.side === a.side);
      if (neighbours.length === 0) continue;
      neighbours.sort((p, q) => Math.hypot(p.x - a.x, p.z - a.z) - Math.hypot(q.x - a.x, q.z - a.z));
      return { seat: a.id, other: neighbours[0]!.id };
    }
    throw new Error("the hall has no two seats side by side");
  });
}

/** Every context the test opens is closed after it, also when it fails (a client left behind would stay in the shared hall). */
const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close().catch(() => undefined);
});

async function openClient(browser: Browser): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  contexts.push(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?quality=low");
  await page.waitForFunction(() => (window as DebugWindow).__worldReady === true, null, { timeout: 300_000 });
  return { page, errors };
}

function seat(page: Page, id: number): Promise<SeatDebug> {
  return page.evaluate((seatId) => {
    const s = (window as DebugWindow).__watchHall!.seats.find((candidate) => candidate.id === seatId)!;
    return { id: s.id, row: s.row, side: s.side, x: s.x, y: s.y, z: s.z, yaw: s.yaw, standX: s.standX, standZ: s.standZ };
  }, id);
}

function localState(page: Page): Promise<string> {
  return page.evaluate(() => (window as DebugWindow).__localPlayer!.animation.getState());
}

function remoteState(page: Page, playerId: string): Promise<string | null> {
  return page.evaluate((id) => (window as DebugWindow).__remotePlayers!.getPlayer(id)?.animation.getState() ?? null, playerId);
}

test.describe("Watch Hall seats, emote wheel and raised hands", () => {
  test("two clients: sit with E, seen seated, taken seat, WASD stands up, dance from the wheel, H raises a hand", async ({ browser }) => {
    const a = await openClient(browser);
    const b = await openClient(browser);
    const pageA = a.page;
    const pageB = b.page;
    await pageA.waitForFunction(() => ((window as DebugWindow).__remotePlayers?.size ?? 0) >= 1, null, { timeout: 120_000 });
    await pageB.waitForFunction(() => ((window as DebugWindow).__remotePlayers?.size ?? 0) >= 1, null, { timeout: 120_000 });

    // Both walk into the hall: A behind its seat, B behind the neighbouring seat in the same lane.
    const { seat: SEAT_ID, other: B_SEAT_ID } = await seatPair(pageA);
    const target = await seat(pageA, SEAT_ID);
    const other = await seat(pageB, B_SEAT_ID);
    await pageA.evaluate((s) => (window as DebugWindow).__localPlayer!.position.set(s.standX, s.y, s.standZ), target);
    await pageB.evaluate((s) => (window as DebugWindow).__localPlayer!.position.set(s.standX, s.y, s.standZ), other);
    await expect.poll(() => pageA.evaluate(() => (window as DebugWindow).__hallStore!.member)).toBe(true);
    await expect.poll(() => pageB.evaluate(() => (window as DebugWindow).__hallStore!.member)).toBe(true);
    const aId = (await pageA.evaluate(() => (window as DebugWindow).__hallStore!.localPlayerId))!;

    // The seat (priority 2) outranks B's player card (priority 0, 5 m) for E.
    await expect.poll(() => pageA.evaluate(() => (window as DebugWindow).__interactions!.nearest?.id ?? null)).toBe(`wh-seat-${SEAT_ID}`);
    await expect(pageA.locator(".zw-interaction-prompt")).toContainText("Sit down");
    await pageA.keyboard.press("KeyE");
    await expect.poll(() => pageA.evaluate(() => (window as DebugWindow).__hallStore!.mySeat)).toBe(SEAT_ID);
    await expect.poll(() => localState(pageA)).toBe("sit");
    await pageA.waitForTimeout(1500);
    expect(await localState(pageA)).toBe("sit");
    const pinned = await pageA.evaluate(() => {
      const p = (window as DebugWindow).__localPlayer!.position;
      return { x: p.x, z: p.z };
    });
    expect(Math.hypot(pinned.x - target.x, pinned.z - target.z)).toBeLessThan(0.05);

    // B sees A's avatar sitting at the seat.
    await expect.poll(() => remoteState(pageB, aId)).toBe("sit");
    await expect
      .poll(() =>
        pageB.evaluate(
          ([id, s]) => {
            const p = (window as DebugWindow).__remotePlayers!.getPlayer(id)!.object.position;
            return Math.hypot(p.x - s.x, p.z - s.z);
          },
          [aId, target] as const,
        ),
      )
      .toBeLessThan(0.3);
    expect(await pageB.evaluate((id) => (window as DebugWindow).__hallStore!.occupantOf(id), SEAT_ID)).toBe(aId);

    // A second claimer gets the "taken" line.
    await pageB.evaluate((id) => (window as DebugWindow).__seatSystem!.claim(id), SEAT_ID);
    await expect(pageB.locator(".zw-chat-system", { hasText: "That seat was just taken" })).toHaveCount(1);

    // WASD stands A up at the stand point, and the seat frees on both clients.
    await pageA.keyboard.down("KeyW");
    await expect.poll(() => pageA.evaluate(() => (window as DebugWindow).__hallStore!.mySeat)).toBe(null);
    await pageA.keyboard.up("KeyW");
    await expect.poll(() => localState(pageA)).not.toBe("sit");
    await expect.poll(() => pageB.evaluate((id) => (window as DebugWindow).__hallStore!.occupantOf(id), SEAT_ID)).toBe(null);
    await expect.poll(() => remoteState(pageB, aId)).not.toBe("sit");
    await expect.poll(() => localState(pageA)).toBe("idle");

    // Hold G: the wheel opens; the cursor up and to the right picks Dance; releasing G dances.
    const centre = { x: 480, y: 270 };
    await pageA.mouse.move(centre.x, centre.y);
    await pageA.keyboard.down("KeyG");
    await expect.poll(() => pageA.evaluate(() => (window as DebugWindow).__emotes!.wheel.isOpen)).toBe(true);
    await pageA.mouse.move(centre.x + 90, centre.y - 55, { steps: 4 });
    await expect.poll(() => pageA.evaluate(() => (window as DebugWindow).__emotes!.wheel.highlightedLabel)).toBe("Dance");
    await pageA.keyboard.up("KeyG");
    await expect.poll(() => pageA.evaluate(() => (window as DebugWindow).__emotes!.wheel.isOpen)).toBe(false);
    await expect.poll(() => localState(pageA)).toBe("dance");
    await expect.poll(() => remoteState(pageB, aId)).toBe("dance");

    // In the hall, H raises A's hand: B's nameplate for A gets the ✋ badge.
    await pageA.keyboard.press("KeyH");
    await expect.poll(() => pageA.evaluate(() => (window as DebugWindow).__hallStore!.myHandRaised)).toBe(true);
    const aNickname = await pageB.evaluate((id) => (window as DebugWindow).__remotePlayers!.getPlayer(id)!.nickname, aId);
    const plate = pageB.locator(".zw-nameplate", { hasText: "✋" });
    await expect(plate).toHaveCount(1);
    await expect(plate).toContainText(aNickname);

    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  });
});
