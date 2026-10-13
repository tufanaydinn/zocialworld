import type { Page } from "@playwright/test";

/**
 * Named positions of the world under test, read from the app's `window.__anchors` (DEV and VITE_TEST_HOOKS builds;
 * the names are defined in apps/web/src/debug/anchors.ts). Specs stand players at anchors instead of hard-coding the
 * coordinates of one world, so the same spec runs on the sample content and on any other content that publishes them.
 */
export const ANCHOR = {
  spawn: "spawn",
  projectBoard: "projects.board",
  projectBooth: "projects.booth",
  hallDoor: "hall.door",
  hallArrival: "hall.arrival",
  hallExit: "hall.exit",
  hallFloor: "hall.floor",
  hallPodium: "hall.podium",
  hallSpeakerCard: "hall.speaker-card",
  hallDiscussion: "hall.discussion",
  hallLiveNow: "hall.live-now",
  hallScreen: "hall.screen",
  hallDiscussionBoard: "hall.discussion-board",
} as const;

export interface Point {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

type AnchorWindow = Window & {
  __anchors?: Record<string, Point>;
  __localPlayer?: { position: { set(x: number, y: number, z: number): void } };
};

/** The world position of `name` (waits until the app has published its anchors; fails if the content lacks it). */
export async function anchor(page: Page, name: string): Promise<Point> {
  await page.waitForFunction(() => (window as AnchorWindow).__anchors !== undefined, null, { timeout: 120_000 });
  const point = await page.evaluate((key) => (window as AnchorWindow).__anchors![key] ?? null, name);
  if (!point) throw new Error(`the world under test has no "${name}" anchor`);
  return point;
}

/**
 * A screenshot camera pose that frames the view target `target` from `distance` metres away, `rise` metres above it,
 * looking along the horizontal direction from `from` to the target (for example from the open hall floor toward a board).
 */
export async function cameraPoseToward(page: Page, target: string, from: string, distance: number, rise: number, fov: number) {
  const aim = await anchor(page, target);
  const start = await anchor(page, from);
  const dx = start.x - aim.x;
  const dz = start.z - aim.z;
  const length = Math.hypot(dx, dz) || 1;
  return {
    position: [aim.x + (dx / length) * distance, aim.y + rise, aim.z + (dz / length) * distance] as [number, number, number],
    target: [aim.x, aim.y, aim.z] as [number, number, number],
    fov,
  };
}

/** Teleports the local player to `name`, moved by `offset` metres (x and z) when given. */
export async function standAtAnchor(page: Page, name: string, offset: { x?: number; z?: number } = {}): Promise<Point> {
  const point = await anchor(page, name);
  const at = { x: point.x + (offset.x ?? 0), y: point.y, z: point.z + (offset.z ?? 0) };
  await page.evaluate((p) => (window as AnchorWindow).__localPlayer!.position.set(p.x, p.y, p.z), at);
  return at;
}
