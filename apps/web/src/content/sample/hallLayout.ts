import type { CollisionSystem } from "../../collision/CollisionSystem.ts";
import type { MinimapData } from "../../ui/minimapTypes.ts";
import { HALL_ORIGIN, hallToWorld, seatRows, type HallBoardPlacement, type HallLayout } from "../../world/hall/hallGeometry.ts";

/**
 * The sample Watch Hall layout (hall-local metres): a plain room filling the shared hall box, a low stage with the
 * screen, the speaker-card strip and a podium, the Live Now and Discussion Corner boards in the front corners, and one
 * row of four seats facing the screen. Enough for every hall system to run; `hall.ts` builds it.
 */

/** Inner faces of the walls (the membership box is |x| ≤ 20, |z| ≤ 15). */
export const SAMPLE_WALLS = { side: 19.6, stage: -14.6, entrance: 14.6, height: 8 } as const;
const STAGE = { x0: -8, x1: 8, zBack: SAMPLE_WALLS.stage, zFront: -10, y: 0.4 } as const;
const SCREEN = { x: 0, y: 4.4, z: -14.5, width: 9.6, height: 5.4 } as const;
const towardAudience = (x: number, z: number): number => Math.atan2(0 - x, 1.5 - z);
const board = (x: number, useX: number): HallBoardPlacement => ({ x, z: -11.5, yaw: towardAudience(x, -11.5), width: 6.4, height: 3.6, bottom: 3.2, use: { x: useX, z: -8.6 } });

function isOnStage(x: number, z: number): boolean {
  const lx = x - HALL_ORIGIN.x;
  const lz = z - HALL_ORIGIN.z;
  return lx >= STAGE.x0 && lx <= STAGE.x1 && lz >= STAGE.zBack && lz <= STAGE.zFront;
}

function heightAt(x: number, z: number): number {
  return isOnStage(x, z) ? STAGE.y : 0;
}

/** The four walls and the podium; the stage has no lip, so players walk straight up onto it. */
function registerColliders(collisions: CollisionSystem): void {
  const box = (x0: number, z0: number, x1: number, z1: number): void => {
    collisions.addBox(hallToWorld((x0 + x1) / 2, 0, (z0 + z1) / 2), Math.abs(x1 - x0) / 2, Math.abs(z1 - z0) / 2);
  };
  const { side, stage, entrance } = SAMPLE_WALLS;
  box(-side - 1, stage - 1, -side, entrance + 1);
  box(side, stage - 1, side + 1, entrance + 1);
  box(-side - 1, stage - 1, side + 1, stage);
  box(-side - 1, entrance, side + 1, entrance + 1);
  collisions.addBox(hallToWorld(sampleHallLayout.podium.x, 0, sampleHallLayout.podium.z), 0.45, 0.35);
}

function minimap(): MinimapData {
  const ox = HALL_ORIGIN.x;
  const oz = HALL_ORIGIN.z;
  const { side, stage, entrance } = SAMPLE_WALLS;
  const { liveNow, discussion } = sampleHallLayout.boards;
  return {
    title: "Watch Hall",
    background: "#16110d",
    bounds: { minX: ox - 24, maxX: ox + 24, minZ: oz - 19, maxZ: oz + 19 },
    areas: [
      { x0: ox - side, z0: oz + stage, x1: ox + side, z1: oz + entrance, color: "#4a382b" },
      { x0: ox + STAGE.x0, z0: oz + STAGE.zBack, x1: ox + STAGE.x1, z1: oz + STAGE.zFront, color: "#8a6440" },
      { x0: ox - SCREEN.width / 2, z0: oz + STAGE.zBack, x1: ox + SCREEN.width / 2, z1: oz + STAGE.zBack + 0.6, color: "#d9b56a" },
    ],
    circles: [],
    buildings: [],
    trees: [],
    paths: [],
    markers: [
      { label: "Stage", x: ox, z: oz - 12, color: "#f2c45a", icon: "stage" },
      { label: "Live Now", x: ox + liveNow.x, z: oz + liveNow.z, color: "#ff6a5a", icon: "board" },
      { label: "Discussion", x: ox + discussion.x, z: oz + discussion.z, color: "#9b7cf0", icon: "board" },
      { label: "Exit", x: ox + sampleHallLayout.exit.x, z: oz + sampleHallLayout.exit.z, color: "#e8a050", icon: "builders" },
    ],
    regions: [
      { name: "Watch Hall · Stage", x: ox, z: oz - 12, radius: 5 },
      { name: "Watch Hall · Seating", x: ox, z: oz - 2, radius: 8 },
      { name: "Watch Hall · Entrance", x: ox, z: oz + 11, radius: 5 },
    ],
  };
}

export const sampleHallLayout: HallLayout = {
  seats: seatRows({ rows: [{ z: -2, y: 0, standZ: -1.2 }], seatsPerBlock: 2, firstX: 1.6, pitch: 1.2, facing: { x: SCREEN.x, z: SCREEN.z } }),
  stage: STAGE,
  screen: SCREEN,
  speakerCard: { x: 0, y: 0.95, z: -14.45, width: 6.4, height: 0.8, use: { x: 0, z: -9.2 } },
  podium: { x: -5.5, y: STAGE.y, z: -11.6, use: { x: -5.3, z: -10.7 } },
  boards: { liveNow: board(-13.5, -12), discussion: board(13.5, 12) },
  arrival: { x: 0, z: 11 },
  exit: { x: 0, z: 13.8 },
  crowd: {
    standing: [
      { x: -3, z: -8.2, yaw: Math.PI * 0.85 },
      { x: 3, z: -8.2, yaw: -Math.PI * 0.8 },
      { x: -9, z: -3, yaw: Math.PI },
      { x: 9, z: 1, yaw: Math.PI },
    ],
    walkway: { z: 5, laneSpacing: 0.9, length: 14 },
    freeSeat: 3,
  },
  isOnStage,
  heightAt,
  registerColliders,
  minimap,
};
