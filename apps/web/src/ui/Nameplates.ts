import * as THREE from "three";
import { injectUiStyles } from "./styles.ts";

/**
 * World-space name labels above remote players (CORE-002 §20 —
 * "Guest-XXXX is enough, do not build profile UI").
 *
 * Implemented as projected DOM elements rather than
 * CSS2DRenderer/sprite text, consistent with this project's existing
 * "UI is plain DOM, the 3D canvas is just the world" architecture (see
 * `ui/styles.ts`) — no new rendering dependency for a handful of text
 * labels.
 */
export class NameplateManager {
  private readonly container: HTMLElement;
  private readonly elements = new Map<string, HTMLDivElement>();
  private readonly ndcScratch = new THREE.Vector3();

  constructor(container: HTMLElement) {
    injectUiStyles();
    this.container = container;
  }

  set(id: string, label: string): void {
    let element = this.elements.get(id);
    if (!element) {
      element = document.createElement("div");
      element.className = "zw-ui zw-panel zw-nameplate";
      this.container.appendChild(element);
      this.elements.set(id, element);
    }
    if (element.textContent !== label) element.textContent = label;
  }

  remove(id: string): void {
    const element = this.elements.get(id);
    if (!element) return;
    element.remove();
    this.elements.delete(id);
  }

  /** Call once per frame, after the camera's matrices are up to date, for every currently tracked id. */
  update(entries: ReadonlyArray<{ id: string; headPosition: THREE.Vector3 }>, camera: THREE.Camera, viewportWidth: number, viewportHeight: number): void {
    for (const { id, headPosition } of entries) {
      const element = this.elements.get(id);
      if (!element) continue;

      this.ndcScratch.copy(headPosition).project(camera);

      if (this.ndcScratch.z > 1) {
        element.style.display = "none"; // behind the camera
        continue;
      }

      const x = (this.ndcScratch.x * 0.5 + 0.5) * viewportWidth;
      const y = (1 - (this.ndcScratch.y * 0.5 + 0.5)) * viewportHeight;
      element.style.display = "";
      element.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
    }
  }

  dispose(): void {
    for (const element of this.elements.values()) element.remove();
    this.elements.clear();
  }
}
