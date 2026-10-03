import { injectUiStyles } from "./styles.ts";
import type { ConnectionState } from "../networking/NetworkClient.ts";

/**
 * Minimal dev-oriented multiplayer connection indicator (CORE-002 §21).
 * Not the final HUD — just enough to see at a glance during testing
 * whether the socket is up and how many players the server currently
 * reports. Dev-only (gated by `import.meta.env.DEV` at the call site in
 * App.ts), same pattern as DebugStats.
 */
export class ConnectionStatus {
  private readonly element: HTMLDivElement;
  private readonly label: HTMLSpanElement;
  private readonly countLabel: HTMLSpanElement;

  constructor(container: HTMLElement) {
    injectUiStyles();

    this.element = document.createElement("div");
    this.element.className = "zw-ui zw-panel zw-connection-status";
    this.element.dataset.state = "disconnected";

    const dot = document.createElement("span");
    dot.className = "zw-status-dot";
    this.element.appendChild(dot);

    this.label = document.createElement("span");
    this.label.textContent = "Disconnected";
    this.element.appendChild(this.label);

    this.countLabel = document.createElement("span");
    this.element.appendChild(this.countLabel);

    container.appendChild(this.element);
  }

  setState(state: ConnectionState): void {
    this.element.dataset.state = state;
    this.label.textContent = state === "connected" ? "Connected" : state === "connecting" ? "Connecting…" : "Disconnected";
  }

  /** Total players currently visible in the world, including the local player. */
  setPlayerCount(count: number): void {
    this.countLabel.textContent = `· Players: ${count}`;
  }

  dispose(): void {
    this.element.remove();
  }
}
