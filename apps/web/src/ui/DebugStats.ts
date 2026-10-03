import * as THREE from "three";
import Stats from "stats.js";
import { injectUiStyles } from "./styles.ts";

/**
 * Development-only performance overlay: FPS (via stats.js) plus triangle
 * count / draw calls read from `renderer.info`.
 *
 * Only ever constructed when `import.meta.env.DEV` is true (see
 * `App.ts`) so it never ships in a production build — per master spec
 * section 17 ("easy to disable in production").
 */
export class DebugStats {
  private readonly stats: Stats;
  private readonly infoElement: HTMLDivElement;

  constructor(container: HTMLElement) {
    injectUiStyles();

    this.stats = new Stats();
    this.stats.showPanel(0);
    this.stats.dom.style.position = "absolute";
    this.stats.dom.style.top = "12px";
    this.stats.dom.style.right = "12px";
    this.stats.dom.style.left = "auto";
    container.appendChild(this.stats.dom);

    this.infoElement = document.createElement("div");
    this.infoElement.className = "zw-ui zw-panel";
    this.infoElement.style.position = "absolute";
    this.infoElement.style.top = "64px";
    this.infoElement.style.right = "12px";
    this.infoElement.style.padding = "8px 12px";
    this.infoElement.style.fontSize = "11px";
    this.infoElement.style.lineHeight = "1.6";
    this.infoElement.style.whiteSpace = "pre";
    container.appendChild(this.infoElement);
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
