import { injectUiStyles } from "./styles.ts";

const DEFAULT_TITLE = "Zocial World — preview";
const DEFAULT_SUBTITLE = "WASD move · Shift jog · Mouse look (click to lock) · E interact";

/**
 * Always-on HUD chrome: the bottom-left location label and the top-left
 * "what is this build" info corner (no
 * health bars, no minimap yet, just enough to orient a new visitor).
 * Some locations retitle the corner (the Watch Hall: "WATCH HALL — Zocial World").
 */
export class HUD {
  private readonly locationElement: HTMLDivElement;
  private readonly titleElement: HTMLDivElement;
  private readonly subtitleElement: HTMLDivElement;

  constructor(container: HTMLElement) {
    injectUiStyles();

    const infoCorner = document.createElement("div");
    infoCorner.className = "zw-ui zw-panel zw-hud-corner";
    this.titleElement = document.createElement("div");
    this.titleElement.className = "zw-title";
    this.subtitleElement = document.createElement("div");
    infoCorner.append(this.titleElement, this.subtitleElement);
    this.setTitleCard(null);
    container.appendChild(infoCorner);

    this.locationElement = document.createElement("div");
    this.locationElement.className = "zw-ui zw-panel zw-location-label";
    container.appendChild(this.locationElement);
    this.setLocation("Prototype Plaza");
  }

  setLocation(name: string): void {
    this.locationElement.innerHTML = `Location: <span class="zw-location-name">${escapeHtml(name)}</span>`;
  }

  /** Retitles the top-left card for a location, or restores the default (controls hint) with null. */
  setTitleCard(card: { readonly title: string; readonly subtitle: string } | null): void {
    this.titleElement.textContent = card?.title ?? DEFAULT_TITLE;
    this.subtitleElement.textContent = card?.subtitle ?? DEFAULT_SUBTITLE;
  }
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}
