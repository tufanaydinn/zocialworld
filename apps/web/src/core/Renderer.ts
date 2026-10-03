import * as THREE from "three";

/**
 * Thin wrapper around THREE.WebGLRenderer.
 *
 * Owns the canvas, pixel-ratio policy and resize handling so no other
 * module needs to touch `window.innerWidth/innerHeight` or renderer
 * settings directly. Performance-sensitive defaults (capped pixel ratio,
 * no unnecessary antialiasing cost on high-DPI screens) live here.
 */
export class Renderer {
  readonly webgl: THREE.WebGLRenderer;
  readonly domElement: HTMLCanvasElement;

  constructor(container: HTMLElement) {
    this.webgl = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });

    // Capping DPR keeps retina/4K displays from tanking fill-rate.
    this.webgl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.webgl.shadowMap.enabled = true;
    this.webgl.shadowMap.type = THREE.PCFShadowMap;
    this.webgl.outputColorSpace = THREE.SRGBColorSpace;
    this.webgl.toneMapping = THREE.ACESFilmicToneMapping;
    this.webgl.toneMappingExposure = 1.05;

    this.domElement = this.webgl.domElement;
    container.appendChild(this.domElement);

    this.resize(container.clientWidth, container.clientHeight);
  }

  resize(width: number, height: number): void {
    this.webgl.setSize(width, height, false);
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.webgl.render(scene, camera);
  }

  dispose(): void {
    this.webgl.dispose();
    this.domElement.remove();
  }
}
