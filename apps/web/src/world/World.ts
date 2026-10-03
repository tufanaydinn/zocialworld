import * as THREE from "three";
import { createSky } from "./Sky.ts";
import { buildPrototypePlaza } from "./PrototypePlaza.ts";
import type { CollisionSystem } from "../collision/CollisionSystem.ts";
import type { InteractionSystem } from "../interaction/InteractionSystem.ts";

export interface WorldOptions {
  readonly collisions: CollisionSystem;
  readonly interactions: InteractionSystem;
  readonly onOpenProjectBoard: () => void;
  /** CORE-005: forwarded to the prototype plaza's project booths — see PrototypePlazaOptions. */
  readonly onSelectProject: (projectId: string) => void;
}

/**
 * Owns the THREE.Scene: lighting, sky, fog and the active location
 * (currently just the prototype plaza). Later locations (Tavern
 * interior, Builders Hall interior — master spec sections 11/12) would
 * be swapped in here behind the same `scene` without other systems
 * needing to change.
 */
export class World {
  readonly scene = new THREE.Scene();
  readonly cameraObstacles: THREE.Object3D[];
  readonly spawnPoint: THREE.Vector3;

  constructor(options: WorldOptions) {
    this.setupLighting();
    this.setupSkyAndFog();

    const plaza = buildPrototypePlaza(options);
    this.scene.add(plaza.group);
    this.cameraObstacles = plaza.cameraObstacles;
    this.spawnPoint = plaza.spawnPoint;
  }

  private setupLighting(): void {
    // Warm low-angle "golden hour" sun — the one directional light the
    // whole scene relies on (master spec section 27: one primary light).
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
    this.scene.add(sun);
    this.scene.add(sun.target);

    const sky = new THREE.HemisphereLight(0x5b5470, 0x3a2f28, 0.9);
    this.scene.add(sky);

    const fill = new THREE.AmbientLight(0x6b5a4a, 0.25);
    this.scene.add(fill);
  }

  private setupSkyAndFog(): void {
    this.scene.add(createSky());
    this.scene.fog = new THREE.FogExp2(0x6b5a52, 0.018);
  }
}
