import { injectUiStyles } from "./styles.ts";

/**
 * Always-on HUD chrome: the bottom-left location label and the top-left
 * "what is this build" info corner (master spec section 24/68 — no
 * health bars, no minimap yet, just enough to orient a new visitor).
 */
export class HUD {
  private readonly locationElement: HTMLDivElement;

  constructor(container: HTMLElement) {
    injectUiStyles();

    const infoCorner = document.createElement("div");
    infoCorner.className = "zw-ui zw-panel zw-hud-corner";
    infoCorner.innerHTML = `
      <div class="zw-title">ZocialWorld — prototype</div>
      <div>WASD move · Shift jog · Mouse look (click to lock) · E interact</div>
    `;
    container.appendChild(infoCorner);

    this.locationElement = document.createElement("div");
    this.locationElement.className = "zw-ui zw-panel zw-location-label";
    container.appendChild(this.locationElement);
    this.setLocation("Prototype Plaza");
  }

  setLocation(name: string): void {
    this.locationElement.innerHTML = `Location: <span class="zw-location-name">${escapeHtml(name)}</span>`;
  }
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}
