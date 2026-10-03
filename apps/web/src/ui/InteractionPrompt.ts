import { injectUiStyles } from "./styles.ts";

/**
 * The floating "[E] <label>" prompt shown when the player is in range of
 * an Interactable. Pure DOM — the 3D scene never needs to know this exists.
 */
export class InteractionPrompt {
  private readonly element: HTMLDivElement;

  constructor(container: HTMLElement) {
    injectUiStyles();

    this.element = document.createElement("div");
    this.element.className = "zw-ui zw-panel zw-interaction-prompt";
    container.appendChild(this.element);
  }

  show(label: string): void {
    this.element.innerHTML = `<kbd>E</kbd>${escapeHtml(label)}`;
    this.element.classList.add("visible");
  }

  hide(): void {
    this.element.classList.remove("visible");
  }

  dispose(): void {
    this.element.remove();
  }
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}
