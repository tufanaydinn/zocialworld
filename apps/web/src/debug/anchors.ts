import { toWorldXZ, type HallLayout } from "../world/hall/hallGeometry.ts";

/**
 * Named world positions that end-to-end tests stand a player at, so a spec never hard-codes the coordinates of one
 * particular world. Locations publish their own (`BuiltLocation.anchors`, e.g. the project board) and the Watch Hall's
 * come from its layout. The app exposes the merged map as `window.__anchors` in DEV and VITE_TEST_HOOKS builds only.
 */

/** A world point (metres): a place on the walkable ground, or, for the view targets below, a point to aim a camera at. */
export interface AnchorPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** What a location declares: a position, with the height taken from the location's ground when it is left out. */
export interface AnchorSpec {
  readonly x: number;
  readonly z: number;
  readonly y?: number;
}

export type AnchorMap = Readonly<Record<string, AnchorPoint>>;

/** The anchor names the specs rely on. A content that lacks the feature simply has no such anchor. */
export const ANCHOR = {
  /** Where a new player appears. */
  spawn: "spawn",
  /** In range of the project board's "View Projects" interaction. */
  projectBoard: "projects.board",
  /** In range of one project booth. */
  projectBooth: "projects.booth",
  /** In range of the door that leads into the Watch Hall. */
  hallDoor: "hall.door",
  /** Where a player arriving in the hall stands. */
  hallArrival: "hall.arrival",
  /** In range of the hall's exit. */
  hallExit: "hall.exit",
  /** An open spot on the hall floor, off the stage and away from the seats (with room to either side). */
  hallFloor: "hall.floor",
  /** In range of the podium (taking the stage). */
  hallPodium: "hall.podium",
  /** In range of the speaker card under the screen. */
  hallSpeakerCard: "hall.speaker-card",
  /** In range of the Discussion Corner board. */
  hallDiscussion: "hall.discussion",
  /** In range of the Live Now board. */
  hallLiveNow: "hall.live-now",
  /** View target: the centre of the hall screen's picture (for screenshot cameras; not a place to stand). */
  hallScreen: "hall.screen",
  /** View target: the centre of the Discussion Corner board's face (for screenshot cameras; not a place to stand). */
  hallDiscussionBoard: "hall.discussion-board",
} as const;

/**
 * The Watch Hall's anchors, from its layout: hall-local positions turned into world positions on the hall floor, plus
 * the view targets at the height of the screen and the Discussion Corner board.
 */
export function hallAnchors(layout: HallLayout): Record<string, AnchorPoint> {
  const at = (x: number, z: number): AnchorPoint => {
    const world = toWorldXZ(x, z);
    return { x: world.x, y: layout.heightAt(world.x, world.z), z: world.z };
  };
  const screen = toWorldXZ(layout.screen.x, layout.screen.z);
  const board = layout.boards.discussion;
  const boardFloor = at(board.x, board.z);
  return {
    [ANCHOR.hallArrival]: at(layout.arrival.x, layout.arrival.z),
    [ANCHOR.hallExit]: at(layout.exit.x, layout.exit.z),
    [ANCHOR.hallFloor]: at(0, layout.crowd.walkway.z),
    [ANCHOR.hallPodium]: at(layout.podium.use.x, layout.podium.use.z),
    [ANCHOR.hallSpeakerCard]: at(layout.speakerCard.use.x, layout.speakerCard.use.z),
    [ANCHOR.hallDiscussion]: at(layout.boards.discussion.use.x, layout.boards.discussion.use.z),
    [ANCHOR.hallLiveNow]: at(layout.boards.liveNow.use.x, layout.boards.liveNow.use.z),
    [ANCHOR.hallScreen]: { x: screen.x, y: layout.screen.y, z: screen.z },
    [ANCHOR.hallDiscussionBoard]: { ...boardFloor, y: boardFloor.y + board.bottom + board.height / 2 },
  };
}

/** Resolves location anchor specs to points, taking a missing height from `heightAt`. */
export function resolveAnchors(specs: Readonly<Record<string, AnchorSpec>>, heightAt: (x: number, z: number) => number): Record<string, AnchorPoint> {
  const out: Record<string, AnchorPoint> = {};
  for (const [name, spec] of Object.entries(specs)) out[name] = { x: spec.x, y: spec.y ?? heightAt(spec.x, spec.z), z: spec.z };
  return out;
}

/** Merges anchor maps; a name defined twice is a content error. */
export function mergeAnchors(...maps: ReadonlyArray<Readonly<Record<string, AnchorPoint>>>): AnchorMap {
  const out: Record<string, AnchorPoint> = {};
  for (const map of maps) {
    for (const [name, point] of Object.entries(map)) {
      if (name in out) throw new Error(`anchor "${name}" is defined twice`);
      out[name] = point;
    }
  }
  return Object.freeze(out);
}
