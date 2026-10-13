import * as THREE from "three";
import type { LocationModule } from "../../world/LocationModule.ts";
import { DiscussionBoard, LiveNowBoard, SpeakerCardBoard, hallTextMaterial } from "../../world/hall/boardFaces.ts";
import type { WatchHallHandles } from "../../world/hall/contract.ts";
import { HALL_ORIGIN, hallToWorld, type HallBoardPlacement, type HallPanel } from "../../world/hall/hallGeometry.ts";
import { HallScreen } from "../../world/hall/screen.ts";
import { SAMPLE_WALLS, sampleHallLayout as layout } from "./hallLayout.ts";

/**
 * The sample Watch Hall in the hall slot: a box room of primitives (no external assets) built around the sample
 * layout, with the real screen, board faces and interactables, so the stage, seats, boards, voice and the
 * performance scene all run on it.
 */
export const sampleHallLocation: LocationModule = {
  id: "hall",
  build(context) {
    const group = new THREE.Group();
    group.name = "SampleHall";
    // Materials are made per build, not at import: importing the module has no side effects.
    const floorMaterial = new THREE.MeshStandardMaterial({ color: 0x6b5442, roughness: 0.9 });
    const wallMaterial = new THREE.MeshStandardMaterial({ color: 0xb8a284, roughness: 0.95 });
    const stageMaterial = new THREE.MeshStandardMaterial({ color: 0x8a5a36, roughness: 0.8 });
    const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x2a1c12, roughness: 0.85 });
    const seatMaterial = new THREE.MeshStandardMaterial({ color: 0x7a2e2a, roughness: 0.9 });
    const cameraObstacles: THREE.Object3D[] = [];
    const { side, stage: stageWall, entrance, height } = SAMPLE_WALLS;
    /** A box between hall-local bounds; walls and the ceiling also stop the camera. */
    const box = (material: THREE.Material, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, obstacle = false): void => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), material);
      mesh.position.copy(hallToWorld((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2));
      group.add(mesh);
      if (obstacle) {
        mesh.updateMatrixWorld(true);
        cameraObstacles.push(mesh);
      }
    };
    /** A hall-local floor point at its walkable height. */
    const at = (x: number, z: number): THREE.Vector3 => {
      const point = hallToWorld(x, 0, z);
      point.y = layout.heightAt(point.x, point.z);
      return point;
    };

    // Floor, walls, ceiling, the stage and the exit door in the entrance wall.
    box(floorMaterial, -side - 0.4, side + 0.4, -0.3, 0, stageWall - 0.4, entrance + 0.4);
    box(wallMaterial, -side - 0.4, -side, 0, height, stageWall - 0.4, entrance + 0.4, true);
    box(wallMaterial, side, side + 0.4, 0, height, stageWall - 0.4, entrance + 0.4, true);
    box(wallMaterial, -side, side, 0, height, stageWall - 0.4, stageWall, true);
    box(wallMaterial, -side, side, 0, height, entrance, entrance + 0.4, true);
    box(wallMaterial, -side - 0.4, side + 0.4, height, height + 0.3, stageWall - 0.4, entrance + 0.4, true);
    const { stage, screen: picture, podium, exit } = layout;
    box(stageMaterial, stage.x0, stage.x1, 0, stage.y, stage.zBack, stage.zFront);
    box(darkMaterial, exit.x - 1, exit.x + 1, 0, 2.6, entrance - 0.06, entrance);

    // The screen in a dark frame, and the speaker-card strip under it.
    const screen = new HallScreen(hallToWorld(picture.x, picture.y, picture.z), 0, picture.width, picture.height);
    group.add(screen.anchor);
    box(darkMaterial, picture.x - picture.width / 2 - 0.3, picture.x + picture.width / 2 + 0.3, picture.y - picture.height / 2 - 0.3, picture.y + picture.height / 2 + 0.3, stageWall, picture.z - 0.02);
    const speakerCard = new SpeakerCardBoard();
    group.add(panel(layout.speakerCard, speakerCard.texture));

    // The two corner boards.
    const liveNow = new LiveNowBoard();
    const discussion = new DiscussionBoard();
    group.add(board(layout.boards.liveNow, liveNow.texture, darkMaterial), board(layout.boards.discussion, discussion.texture, darkMaterial));

    // The podium on the stage, and a bench under each pair of seats.
    box(stageMaterial, podium.x - 0.45, podium.x + 0.45, podium.y, podium.y + 1.1, podium.z - 0.35, podium.z + 0.35);
    for (const seatSide of ["left", "right"] as const) {
      const seats = layout.seats.filter((seat) => seat.side === seatSide);
      if (seats.length === 0) continue;
      const xs = seats.map((seat) => seat.x - HALL_ORIGIN.x);
      const z = seats[0]!.z - HALL_ORIGIN.z + 0.25;
      box(seatMaterial, Math.min(...xs) - 0.5, Math.max(...xs) + 0.5, 0, 0.45, z - 0.25, z + 0.25);
    }

    // Interactables: boards and doors rank above players' cards; the seat system registers the seats.
    const callbacks = context.watchHall;
    const register = (id: string, label: string, x: number, z: number, interactionRadius: number, interact: () => void): void => {
      context.interactions.register({ id, label, position: at(x, z), interactionRadius, priority: 1, interact });
    };
    register("wh-exit", "Leave the Watch Hall", exit.x, exit.z, 2.0, () => callbacks.onExit());
    register("wh-podium", "Podium — take the stage", podium.use.x, podium.use.z, 1.8, () => callbacks.onPodium());
    register("wh-live-now", "Live Now — open the Watch panel", layout.boards.liveNow.use.x, layout.boards.liveNow.use.z, 3.0, () => callbacks.onOpenWatch());
    register("wh-discussion", "Discussion Corner — chat, takeaways and people", layout.boards.discussion.use.x, layout.boards.discussion.use.z, 3.0, () => callbacks.onOpenDiscussion());
    register("wh-card", "Speaker card — who is on stage", layout.speakerCard.use.x, layout.speakerCard.use.z, 2.5, () => callbacks.onOpenSpeakerCard());
    layout.registerColliders(context.collisions);

    const handles: WatchHallHandles = {
      screen,
      liveNow,
      discussion,
      speakerCard,
      seats: layout.seats,
      podium: hallToWorld(podium.x, podium.y, podium.z),
    };
    return {
      group,
      cameraObstacles,
      spawnPoint: at(layout.arrival.x, layout.arrival.z),
      heightAt: layout.heightAt,
      ready: Promise.resolve(),
      minimap: layout.minimap(),
      interior: true,
      watchHall: handles,
      update: () => screen.update(),
    };
  },
};

/** A face facing +z, just in front of the wall behind it. */
function panel(placement: HallPanel, texture: THREE.Texture): THREE.Mesh {
  const face = new THREE.Mesh(new THREE.PlaneGeometry(placement.width, placement.height), hallTextMaterial(texture));
  face.position.copy(hallToWorld(placement.x, placement.y, placement.z + 0.01));
  return face;
}

/** A board on a dark backing and two posts, turned toward the audience. */
function board(placement: HallBoardPlacement, texture: THREE.Texture, backingMaterial: THREE.Material): THREE.Group {
  const { width, height, bottom } = placement;
  const frame = new THREE.Group();
  frame.position.copy(hallToWorld(placement.x, 0, placement.z));
  frame.rotation.y = placement.yaw;
  const backing = new THREE.Mesh(new THREE.BoxGeometry(width + 0.4, height + 0.4, 0.12), backingMaterial);
  backing.position.set(0, bottom + height / 2, -0.08);
  frame.add(backing);
  for (const end of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.24, bottom + height + 0.2, 0.24), backingMaterial);
    post.position.set(end * (width / 2 + 0.3), (bottom + height + 0.2) / 2, -0.08);
    frame.add(post);
  }
  const face = new THREE.Mesh(new THREE.PlaneGeometry(width, height), hallTextMaterial(texture));
  face.position.set(0, bottom + height / 2, 0.01);
  frame.add(face);
  return frame;
}
