import * as THREE from "three";
import { PLAZA_HALL_DOOR, PLAZA_PROJECT_BOARD, PLAZA_PROJECT_BOOTH, buildPrototypePlaza } from "../../world/PrototypePlaza.ts";
import { createSky } from "../../world/Sky.ts";
import type { LocationModule, WorldAtmosphere } from "../../world/LocationModule.ts";
import { HALL_DESTINATION_ID } from "../../world/hall/contract.ts";
import { ANCHOR } from "../../debug/anchors.ts";

/** The prototype plaza in the central slot: flat ground, no minimap, no streamed assets; the left-hand door leads into the hall. */
export const plazaLocation: LocationModule = {
  id: "district",
  build(context) {
    const plaza = buildPrototypePlaza({ ...context, onEnterWatchHall: () => context.onTravel(HALL_DESTINATION_ID) });
    return {
      group: plaza.group,
      cameraObstacles: plaza.cameraObstacles,
      spawnPoint: plaza.spawnPoint,
      heightAt: () => 0,
      ready: Promise.resolve(),
      minimap: null,
      anchors: {
        [ANCHOR.projectBoard]: PLAZA_PROJECT_BOARD,
        [ANCHOR.projectBooth]: PLAZA_PROJECT_BOOTH,
        [ANCHOR.hallDoor]: PLAZA_HALL_DOOR,
      },
    };
  },
};

/**
 * The plaza's golden-hour look: one warm low-angle sun (the only shadow caster), a hemisphere and a little
 * ambient fill, the gradient sky dome and warm exponential fog. It does not follow the active location.
 */
export function createPlazaAtmosphere(scene: THREE.Scene): WorldAtmosphere {
  const sun = new THREE.DirectionalLight(0xffc488, 1.6);
  sun.position.set(-18, 22, 14);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -30;
  sun.shadow.camera.right = 30;
  sun.shadow.camera.top = 30;
  sun.shadow.camera.bottom = -30;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 60;
  sun.shadow.bias = -0.0015;
  scene.add(sun);
  scene.add(sun.target);

  scene.add(new THREE.HemisphereLight(0x5b5470, 0x3a2f28, 0.9));
  scene.add(new THREE.AmbientLight(0x6b5a4a, 0.25));
  scene.add(createSky());
  scene.fog = new THREE.FogExp2(0x6b5a52, 0.018);
  return { setFocus: () => {}, setInterior: () => {}, update: () => {} };
}
