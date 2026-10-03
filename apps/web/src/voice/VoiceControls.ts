import { injectUiStyles } from "../ui/styles.ts";
import type { VoiceConnectionState } from "./VoiceClient.ts";

/**
 * Prototype-level voice status/controls widget (CORE-004 §29/§30) — not
 * final HUD design, just enough to see and test voice state at a glance:
 * an explicit "Enable Voice" button (the required user gesture — see
 * `VoiceSession.enableVoice()`'s docstring for why this can never be
 * wired to run automatically), a connection-state label, and a mic-mode
 * label (muted vs. push-to-talk active).
 *
 * `VoiceConnectionState` maps directly onto the brief's four required
 * labels: "disconnected" before Enable Voice is pressed (or after a
 * clean disconnect) reads OFF, "connecting" reads READY, "connected"
 * reads CONNECTED, "error" reads ERROR.
 */
export class VoiceControls {
  private readonly element: HTMLDivElement;
  private readonly enableButton: HTMLButtonElement;
  private readonly statusLabel: HTMLSpanElement;
  private readonly micLabel: HTMLSpanElement;

  private onEnableCallback: () => void = () => {};

  constructor(container: HTMLElement) {
    injectUiStyles();

    this.element = document.createElement("div");
    this.element.className = "zw-ui zw-panel zw-voice-controls";

    this.enableButton = document.createElement("button");
    this.enableButton.type = "button";
    this.enableButton.className = "zw-button zw-button-primary";
    this.enableButton.textContent = "Enable Voice";
    this.enableButton.addEventListener("click", () => this.onEnableCallback());
    this.element.appendChild(this.enableButton);

    this.statusLabel = document.createElement("span");
    this.statusLabel.textContent = "Voice: OFF";
    this.element.appendChild(this.statusLabel);

    this.micLabel = document.createElement("span");
    this.micLabel.textContent = "Mic: Muted";
    this.element.appendChild(this.micLabel);

    container.appendChild(this.element);
  }

  /** Fired on an explicit click only — never call this programmatically on load, see class docstring. */
  onEnable(callback: () => void): void {
    this.onEnableCallback = callback;
  }

  setConnectionState(state: VoiceConnectionState): void {
    this.element.dataset.state = state;
    const label = state === "connecting" ? "READY" : state === "connected" ? "CONNECTED" : state === "error" ? "ERROR" : "OFF";
    this.statusLabel.textContent = `Voice: ${label}`;
    // Once voice has ever been enabled there's no "disable" path back to
    // the button in CORE-004's prototype scope — disabling it just avoids
    // a confusing double-click while a connection attempt is in flight.
    this.enableButton.disabled = state === "connecting" || state === "connected";
  }

  /** `active` = push-to-talk is currently transmitting (V held down). */
  setMicActive(active: boolean): void {
    this.micLabel.textContent = active ? "Mic: Push-to-talk active" : "Mic: Muted";
  }

  dispose(): void {
    this.element.remove();
  }
}
