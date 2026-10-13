import * as THREE from "three";
import Stats from "stats.js";
import { injectUiStyles } from "./styles.ts";

/**
 * Development-only performance overlay: FPS (via stats.js) plus triangle
 * count / draw calls read from `renderer.info`.
 *
 * Only ever constructed when `import.meta.env.DEV` is true (see
 * `App.ts`) so it never ships in a production build.
 */
export class DebugStats {
  private readonly stats: Stats;
  private readonly infoElement: HTMLDivElement;

  constructor(container: HTMLElement) {
    injectUiStyles();

    this.stats = new Stats();
    this.stats.showPanel(0);
    // Top-left under the HUD corner — the top-right belongs to the world minimap.
    this.stats.dom.style.position = "absolute";
    this.stats.dom.style.top = "72px";
    this.stats.dom.style.left = "12px";
    container.appendChild(this.stats.dom);

    this.infoElement = document.createElement("div");
    this.infoElement.className = "zw-ui zw-panel";
    this.infoElement.style.position = "absolute";
    this.infoElement.style.top = "124px";
    this.infoElement.style.left = "12px";
    this.infoElement.style.padding = "8px 12px";
    this.infoElement.style.fontSize = "11px";
    this.infoElement.style.lineHeight = "1.6";
    this.infoElement.style.whiteSpace = "pre";
    container.appendChild(this.infoElement);

    // `?stats=0` hides the overlay (clean screenshots) while keeping the measurement running.
    if (new URLSearchParams(window.location.search).get("stats") === "0") {
      this.stats.dom.style.display = "none";
      this.infoElement.style.display = "none";
    }
  }

  beginFrame(): void {
    this.stats.begin();
  }

  endFrame(renderer: THREE.WebGLRenderer): void {
    this.stats.end();
    const info = renderer.info;
    this.infoElement.textContent =
      `triangles: ${info.render.triangles.toLocaleString()}\n` +
      `draw calls: ${info.render.calls}\n` +
      `geometries: ${info.memory.geometries}\n` +
      `textures: ${info.memory.textures}`;
  }

  dispose(): void {
    this.stats.dom.remove();
    this.infoElement.remove();
  }
}
