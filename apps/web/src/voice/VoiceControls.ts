import { injectUiStyles } from "../ui/styles.ts";
import type { VoiceConnectionState } from "./VoiceClient.ts";
import type { MicMode } from "./VoiceSession.ts";
import type { VoiceConnectionMode } from "./hallAudio.ts";
import { VOICE_RANGES, type VoiceRange } from "./VoiceProximity.ts";
import { subscribeToCapabilities, subscribeToWalletHolder } from "../zcash/participation.ts";
import type { VoiceFailureMessage } from "./voiceErrors.ts";

/**
 * Voice controls (bottom-left, above the chat): join/leave, microphone
 * mode, speaking range and settings.
 *
 *  - "Enable Voice" is the explicit gesture that connects and captures the
 *    microphone MUTED (never on page load).
 *  - Voice gating: Enable Voice is enabled only when the
 *    wallet is ready (participation capability `canVoice`); a guest sees
 *    why it is disabled. No auto-enable on wallet unlock.
 *  - Mic modes: push-to-talk (hold V) or open mic (toggle
 *    with M or the mic button). The mic is never opened by switching mode.
 *  - Range: Whisper / Talk / Shout — how far YOUR voice
 *    carries; listeners apply it.
 *  - Settings: master volume, stage volume (Watch Hall), microphone
 *    device, leave voice.
 *  - Listen mode (watch mode, and every guest's voice — ADR-015: guests may listen, never talk): a listen-only connection shows "Listening: …"
 *    instead of "Voice: …", hides the microphone and range controls, and
 *    keeps Enable Voice available to upgrade when the wallet allows talking.
 *  - Without an unlocked wallet the primary button LISTENS —
 *    a guest's reads "Listen to voices (guests can't talk)" and the hint
 *    says "Connect a wallet to talk"; a wallet holder whose wallet is
 *    locked sees "Listen to voices" and "🔒 Unlock wallet to talk".
 *  - On a name-registry server the server grants
 *    full voice only to a confirmed (owned) name. An unlocked holder without
 *    one gets the same listen button ("Listen to voices") and the hint
 *    "Confirm a name to talk", which opens the name step — listening never
 *    needs the name (the server grants it to everyone).
 *
 * The status labels ("Voice: OFF/READY/CONNECTED/ERROR", "Mic: Muted",
 * "Push-to-talk active") are kept verbatim — e2e tests read them.
 */
const GUEST_LISTEN_LABEL = "Listen to voices (guests can't talk)";
const HOLDER_LISTEN_LABEL = "Listen to voices";
const GUEST_TALK_HINT = "Connect a wallet to talk";
const LOCKED_TALK_HINT = "🔒 Unlock wallet to talk";
const NAME_TALK_HINT = "Confirm a name to talk";
export class VoiceControls {
  private readonly element: HTMLDivElement;
  private readonly enableButton: HTMLButtonElement;
  private readonly statusLabel: HTMLSpanElement;
  private readonly micLabel: HTMLSpanElement;
  private readonly live: HTMLDivElement;
  private readonly micButton: HTMLButtonElement;
  private readonly rangeButtons = new Map<VoiceRange, HTMLButtonElement>();
  private readonly settingsButton: HTMLButtonElement;
  private readonly settings: HTMLDivElement;
  private readonly volumeSlider: HTMLInputElement;
  private readonly volumeValue: HTMLSpanElement;
  private readonly stageVolumeSlider: HTMLInputElement;
  private readonly stageVolumeValue: HTMLSpanElement;
  private readonly ranges: HTMLDivElement;
  /** "Hall-wide": shown while the server makes this player's mic a stage mic (stage holder or the floor). */
  private readonly hallWide: HTMLSpanElement;
  private readonly modeRow: HTMLLabelElement;
  private readonly deviceRow: HTMLLabelElement;
  private readonly leaveButton: HTMLButtonElement;
  private readonly deviceSelect: HTMLSelectElement;
  private readonly modeSelect: HTMLSelectElement;
  private readonly walletHint: HTMLButtonElement;
  /** Why voice failed, in words to act on (above the panel, like the settings popover). */
  private readonly errorBox: HTMLDivElement;
  private readonly errorTitle: HTMLDivElement;
  private readonly errorDetail: HTMLDivElement;
  private readonly errorAction: HTMLButtonElement;
  private errorActionKind: VoiceFailureMessage["action"] = null;
  private onErrorActionCallback: (action: NonNullable<VoiceFailureMessage["action"]>) => void = () => {};
  private onWalletNeededCallback: () => void = () => {};
  private onNameNeededCallback: () => void = () => {};

  private onEnableCallback: () => void = () => {};
  private onListenCallback: () => void = () => {};
  private onLeaveCallback: () => void = () => {};
  private onRangeCallback: (range: VoiceRange) => void = () => {};
  private onModeCallback: (mode: MicMode) => void = () => {};
  private onMicToggleCallback: () => void = () => {};
  private onVolumeCallback: (volume: number) => void = () => {};
  private onStageVolumeCallback: (volume: number) => void = () => {};
  private onDeviceCallback: (deviceId: string) => void = () => {};
  private loadDevices: () => Promise<MediaDeviceInfo[]> = async () => [];
  private unsubscribeFromCapabilities: (() => void) | null = null;
  private unsubscribeFromHolder: (() => void) | null = null;
  private isConnecting = false;
  private canVoiceParticipate = false;
  /** ADR-015: a wallet holder (sticky) — decides the guest vs locked-wallet wording. */
  private holder = false;
  /** A name-registry server and no confirmed name yet: the server refuses full voice (403 name_required) until there is one. */
  private nameRequired = false;
  private mode: MicMode = "push-to-talk";
  private connectionMode: VoiceConnectionMode = "off";

  constructor(container: HTMLElement) {
    injectUiStyles();
    injectVoiceStyles();

    this.element = document.createElement("div");
    this.element.className = "zw-ui zw-panel zw-voice-controls";

    this.enableButton = button("zw-button zw-button-primary", "Enable Voice");
    // ADR-015: talking needs an unlocked wallet; without one the same button starts listen-only voice.
    this.enableButton.addEventListener("click", () => (this.canTalk ? this.onEnableCallback() : this.onListenCallback()));
    // ADR-015: talking needs a wallet — say so and offer the way there (or, on a registry server, the name).
    this.walletHint = button("zw-voice-wallet-hint", GUEST_TALK_HINT);
    this.walletHint.addEventListener("click", () => (this.canVoiceParticipate && this.nameRequired ? this.onNameNeededCallback() : this.onWalletNeededCallback()));

    this.statusLabel = document.createElement("span");
    this.statusLabel.className = "zw-voice-status";
    this.statusLabel.textContent = "Voice: OFF";

    this.micLabel = document.createElement("span");
    this.micLabel.className = "zw-voice-mic";
    this.micLabel.textContent = "Mic: Muted";

    // --- connected-only controls
    this.live = document.createElement("div");
    this.live.className = "zw-voice-live";
    this.micButton = button("zw-voice-mic-button", "🎙");
    this.micButton.title = "Open mic: click or press M to go live / mute";
    this.micButton.addEventListener("click", () => this.onMicToggleCallback());
    const ranges = document.createElement("div");
    this.ranges = ranges;
    ranges.className = "zw-voice-ranges";
    ranges.setAttribute("role", "radiogroup");
    ranges.setAttribute("aria-label", "How far your voice carries");
    const rangeLabels: Record<VoiceRange, string> = { whisper: "Whisper", talk: "Talk", shout: "Shout" };
    for (const range of Object.keys(VOICE_RANGES) as VoiceRange[]) {
      const b = button("zw-voice-range", rangeLabels[range]);
      b.title = `${rangeLabels[range]}: heard up to ${VOICE_RANGES[range].max} m`;
      b.setAttribute("role", "radio");
      b.addEventListener("click", () => this.onRangeCallback(range));
      this.rangeButtons.set(range, b);
      ranges.appendChild(b);
    }
    this.settingsButton = button("zw-voice-gear", "⚙");
    this.settingsButton.title = "Voice settings";
    this.settingsButton.addEventListener("click", () => this.toggleSettings());
    this.hallWide = document.createElement("span");
    this.hallWide.className = "zw-voice-hall-wide";
    this.hallWide.textContent = "🎙 Hall-wide";
    this.hallWide.title = "You're on stage or have the floor: everyone in the Watch Hall hears your microphone, whatever range you picked.";
    this.hallWide.setAttribute("role", "status");
    this.hallWide.hidden = true;
    this.live.append(this.micButton, ranges, this.hallWide, this.settingsButton);

    // --- settings popover
    this.settings = document.createElement("div");
    this.settings.className = "zw-panel zw-voice-settings";
    this.settings.hidden = true;
    const volumeRow = row("Volume");
    this.volumeSlider = document.createElement("input");
    this.volumeSlider.type = "range";
    this.volumeSlider.min = "0";
    this.volumeSlider.max = "200";
    this.volumeSlider.value = "100";
    this.volumeSlider.setAttribute("aria-label", "Voice volume");
    this.volumeValue = document.createElement("span");
    this.volumeValue.textContent = "100%";
    this.volumeSlider.addEventListener("input", () => {
      this.volumeValue.textContent = `${this.volumeSlider.value}%`;
      this.onVolumeCallback(Number(this.volumeSlider.value) / 100);
    });
    volumeRow.append(this.volumeSlider, this.volumeValue);
    // What the stage holder shares on the Watch Hall screen (remembered on this device).
    const stageVolumeRow = row("Stage volume (Watch Hall)");
    this.stageVolumeSlider = document.createElement("input");
    this.stageVolumeSlider.type = "range";
    this.stageVolumeSlider.min = "0";
    this.stageVolumeSlider.max = "200";
    this.stageVolumeSlider.value = "100";
    this.stageVolumeSlider.className = "zw-voice-stage-volume";
    this.stageVolumeSlider.setAttribute("aria-label", "Stage volume");
    this.stageVolumeValue = document.createElement("span");
    this.stageVolumeValue.textContent = "100%";
    this.stageVolumeSlider.addEventListener("input", () => {
      this.stageVolumeValue.textContent = `${this.stageVolumeSlider.value}%`;
      this.onStageVolumeCallback(Number(this.stageVolumeSlider.value) / 100);
    });
    stageVolumeRow.append(this.stageVolumeSlider, this.stageVolumeValue);
    const modeRow = row("Microphone mode");
    this.modeRow = modeRow;
    this.modeSelect = document.createElement("select");
    this.modeSelect.className = "zw-input";
    for (const [value, label] of [
      ["push-to-talk", "Push-to-talk (hold V)"],
      ["open", "Open mic (M to go live)"],
    ] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      this.modeSelect.appendChild(option);
    }
    this.modeSelect.addEventListener("change", () => this.onModeCallback(this.modeSelect.value as MicMode));
    modeRow.appendChild(this.modeSelect);
    const deviceRow = row("Microphone");
    this.deviceRow = deviceRow;
    this.deviceSelect = document.createElement("select");
    this.deviceSelect.className = "zw-input";
    this.deviceSelect.addEventListener("change", () => this.onDeviceCallback(this.deviceSelect.value));
    deviceRow.appendChild(this.deviceSelect);
    const leave = button("zw-button", "Leave voice");
    this.leaveButton = leave;
    leave.addEventListener("click", () => {
      this.settings.hidden = true;
      this.onLeaveCallback();
    });
    const note = document.createElement("div");
    note.className = "zw-voice-note";
    note.textContent = "Mute or block a player from their menu (E). Range: Whisper 4 m · Talk 12 m · Shout 30 m. Stage: what the presenter shares in the Watch Hall.";
    this.settings.append(volumeRow, stageVolumeRow, modeRow, deviceRow, leave, note);

    // A failure says why (no voice server, insecure page, permission, no microphone, guest, network)
    // and offers the next step, instead of a bare "Voice: ERROR".
    this.errorBox = document.createElement("div");
    this.errorBox.className = "zw-panel zw-voice-error";
    this.errorBox.setAttribute("role", "alert");
    this.errorBox.hidden = true;
    this.errorTitle = document.createElement("div");
    this.errorTitle.className = "zw-voice-error-title";
    this.errorDetail = document.createElement("div");
    this.errorDetail.className = "zw-voice-error-detail";
    const errorRow = document.createElement("div");
    errorRow.className = "zw-voice-error-actions";
    // Not `zw-button-primary`: `.zw-voice-controls .zw-button-primary` is the Enable Voice / Listen button.
    this.errorAction = button("zw-button zw-voice-error-action", "Try again");
    this.errorAction.addEventListener("click", () => {
      const action = this.errorActionKind;
      this.setError(null);
      if (action) this.onErrorActionCallback(action);
    });
    const errorClose = button("zw-button", "Dismiss");
    errorClose.addEventListener("click", () => this.setError(null));
    errorRow.append(this.errorAction, errorClose);
    this.errorBox.append(this.errorTitle, this.errorDetail, errorRow);

    const labels = document.createElement("div");
    labels.className = "zw-voice-labels";
    // ADR-015: the wallet hint sits in the label column, in place of the microphone line (which says nothing to someone
    // who cannot talk) — the longer listen label must not push the panel over the action bar's buttons.
    labels.append(this.statusLabel, this.micLabel, this.walletHint);
    this.element.append(this.enableButton, labels, this.live, this.settings, this.errorBox);
    container.appendChild(this.element);
    this.setConnectionState("disconnected");
    this.setRange("talk");

    // Subscribe to participation capabilities to gate Enable Voice
    this.unsubscribeFromHolder = subscribeToWalletHolder((holder) => {
      this.holder = holder;
      this.updateButtonState(this.canVoiceParticipate);
    });
    this.unsubscribeFromCapabilities = subscribeToCapabilities((capabilities) => {
      this.updateButtonState(capabilities.canVoice);
    });
    window.addEventListener("keydown", this.onKey);
  }

  /** Fired on an explicit click only — never call this programmatically on load. Full voice (the wallet allows talking). */
  onEnable(callback: () => void): void {
    this.onEnableCallback = callback;
  }
  /** ADR-015: the same button without an unlocked wallet — listen-only voice (guests, locked wallets). An explicit click only. */
  onListen(callback: () => void): void {
    this.onListenCallback = callback;
  }
  /** The guest hint was clicked (open the wallet panel). */
  onWalletNeeded(callback: () => void): void {
    this.onWalletNeededCallback = callback;
  }
  /** The "Confirm a name to talk" hint was clicked (open the name step). */
  onNameNeeded(callback: () => void): void {
    this.onNameNeededCallback = callback;
  }

  /**
   * Whether the server needs a confirmed name before it grants full voice (a name-registry server and this holder still
   * shows a Guest-style name). The button then listens and the hint offers the name step.
   */
  setNameRequired(required: boolean): void {
    if (required === this.nameRequired) return;
    this.nameRequired = required;
    this.updateButtonState(this.canVoiceParticipate);
  }

  /** The error card's button (open the wallet, try again, reload). */
  onErrorAction(callback: (action: NonNullable<VoiceFailureMessage["action"]>) => void): void {
    this.onErrorActionCallback = callback;
  }

  /** Shows why voice failed and what to do (null hides it). Text only, never markup. */
  setError(message: VoiceFailureMessage | null): void {
    this.errorBox.hidden = message === null;
    this.element.dataset.error = message ? "true" : "";
    if (!message) return;
    this.settings.hidden = true;
    this.errorTitle.textContent = message.title;
    this.errorDetail.textContent = message.detail;
    this.errorActionKind = message.action;
    this.errorAction.hidden = message.action === null;
    this.errorAction.textContent = message.action === "open-wallet" ? "Open wallet" : message.action === "reload" ? "Reload" : "Try again";
  }

  /** The error card's current text (title + detail), or "" — e2e and screenshots only. */
  get errorText(): string {
    return this.errorBox.hidden ? "" : `${this.errorTitle.textContent ?? ""} ${this.errorDetail.textContent ?? ""}`.trim();
  }
  onLeave(callback: () => void): void {
    this.onLeaveCallback = callback;
  }
  onRange(callback: (range: VoiceRange) => void): void {
    this.onRangeCallback = callback;
  }
  onMode(callback: (mode: MicMode) => void): void {
    this.onModeCallback = callback;
  }
  onMicToggle(callback: () => void): void {
    this.onMicToggleCallback = callback;
  }
  onVolume(callback: (volume: number) => void): void {
    this.onVolumeCallback = callback;
  }
  /** The stage volume slider moved (0–2). */
  onStageVolume(callback: (volume: number) => void): void {
    this.onStageVolumeCallback = callback;
  }
  /** Shows the remembered stage volume (0–2). */
  setStageVolume(volume: number): void {
    const percent = String(Math.round(Math.max(0, Math.min(2, volume)) * 100));
    this.stageVolumeSlider.value = percent;
    this.stageVolumeValue.textContent = `${percent}%`;
  }
  onDevice(callback: (deviceId: string) => void, loadDevices: () => Promise<MediaDeviceInfo[]>): void {
    this.onDeviceCallback = callback;
    this.loadDevices = loadDevices;
  }

  /**
   * `mode` is the connection's mode: "listen" shows watch mode ("Watching: …",
   * no microphone controls, Enable Voice still offered to upgrade). Without it a connected
   * session counts as full voice.
   */
  setConnectionState(state: VoiceConnectionState, mode: VoiceConnectionMode = state === "connected" || state === "connecting" ? "full" : "off"): void {
    this.connectionMode = state === "connected" || state === "connecting" ? mode : "off";
    const watching = this.connectionMode === "listen";
    this.element.dataset.state = state;
    this.element.dataset.mode = this.connectionMode;
    const label = state === "connecting" ? "READY" : state === "connected" ? "CONNECTED" : state === "error" ? "ERROR" : "OFF";
    this.statusLabel.textContent = `${watching ? "Listening" : "Voice"}: ${label}`;
    // Listen mode can always be upgraded to full voice (wallet permitting); full voice cannot be enabled twice.
    this.isConnecting = state === "connecting" || (state === "connected" && !watching);
    this.live.hidden = state !== "connected";
    this.ranges.hidden = watching;
    this.modeRow.hidden = watching;
    this.deviceRow.hidden = watching;
    this.leaveButton.textContent = watching ? "Stop listening" : "Leave voice";
    if (state !== "connected") this.settings.hidden = true;
    if (state === "connecting") this.setError(null); // a new attempt: the old reason no longer applies
    this.micButton.hidden = this.mode !== "open" || watching;
    this.updateButtonDisabledState();
    this.setMicStatus(false);
  }

  /** Whether everyone in the hall hears this player's microphone right now (stage holder or floor, inside the hall). */
  setHallWide(on: boolean): void {
    if (this.hallWide.hidden === !on) return;
    this.hallWide.hidden = !on;
    this.ranges.classList.toggle("overridden", on);
  }

  setRange(range: VoiceRange): void {
    for (const [id, b] of this.rangeButtons) {
      b.classList.toggle("active", id === range);
      b.setAttribute("aria-checked", String(id === range));
    }
  }

  setMode(mode: MicMode): void {
    this.mode = mode;
    this.modeSelect.value = mode;
    this.micButton.hidden = mode !== "open" || this.connectionMode === "listen";
    this.setMicStatus(false);
  }

  /** `active` = push-to-talk is currently transmitting (V held down). */
  setMicActive(active: boolean): void {
    this.setMicStatus(active);
  }

  /** Whether the microphone is transmitting right now, in the current mode's words. */
  setMicStatus(live: boolean, noMicrophone = false): void {
    this.element.classList.toggle("zw-voice-is-live", live);
    this.micButton.classList.toggle("live", live);
    // ADR-015: a guest trying to talk (V in listen mode) reads why it can't, and the hint offers the wallet.
    if (this.connectionMode === "listen") this.micLabel.textContent = this.holder ? "Mic: off — listening only" : `Mic: off — ${GUEST_TALK_HINT.toLowerCase()}`;
    else if (noMicrophone) this.micLabel.textContent = "Mic: unavailable (listening only)";
    else if (this.mode === "open") this.micLabel.textContent = live ? "Mic: LIVE — M to mute" : "Mic: Muted — M to go live";
    else this.micLabel.textContent = live ? "Mic: Push-to-talk active" : "Mic: Muted — hold V to talk";
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKey);
    if (this.unsubscribeFromCapabilities) {
      this.unsubscribeFromCapabilities();
      this.unsubscribeFromCapabilities = null;
    }
    this.unsubscribeFromHolder?.();
    this.unsubscribeFromHolder = null;
    this.element.remove();
  }

  // ------------------------------------------------------------------

  private onKey = (event: KeyboardEvent): void => {
    if (event.code !== "KeyM" || event.repeat || this.mode !== "open" || this.live.hidden || this.connectionMode === "listen") return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
    this.onMicToggleCallback();
  };

  private toggleSettings(): void {
    this.settings.hidden = !this.settings.hidden;
    if (this.settings.hidden) return;
    void this.loadDevices()
      .then((devices) => {
        const current = this.deviceSelect.value;
        this.deviceSelect.replaceChildren();
        devices.forEach((device, index) => {
          const option = document.createElement("option");
          option.value = device.deviceId;
          option.textContent = device.label || `Microphone ${index + 1}`;
          this.deviceSelect.appendChild(option);
        });
        if (current) this.deviceSelect.value = current;
        this.deviceSelect.disabled = devices.length === 0;
      })
      .catch(() => {
        this.deviceSelect.disabled = true;
      });
  }

  /** Whether Enable Voice can open a microphone: an unlocked wallet and, on a registry server, a confirmed name. */
  private get canTalk(): boolean {
    return this.canVoiceParticipate && !this.nameRequired;
  }

  /** Update button state based on participation capability (ADR-015: without it the button listens). */
  private updateButtonState(canVoice: boolean): void {
    this.canVoiceParticipate = canVoice;
    if (this.canTalk) {
      this.enableButton.textContent = "Enable Voice";
      this.enableButton.title = "Enable voice chat";
      this.enableButton.setAttribute("data-participation", "ready");
    } else if (canVoice) {
      // Unlocked, but the server wants a confirmed name first: listening still works.
      this.enableButton.textContent = HOLDER_LISTEN_LABEL;
      this.enableButton.title = "Hear nearby voices and the Watch Hall stage. Talking on this server needs a confirmed name.";
      this.enableButton.setAttribute("data-participation", "name");
    } else {
      this.enableButton.textContent = this.holder ? HOLDER_LISTEN_LABEL : GUEST_LISTEN_LABEL;
      this.enableButton.title = this.holder
        ? "Hear nearby voices and the Watch Hall stage. Unlock your wallet to talk."
        : "Hear nearby voices and the Watch Hall stage. Guests can't open a microphone — they can write in chat.";
      this.enableButton.setAttribute("data-participation", this.holder ? "locked" : "guest");
    }
    this.walletHint.textContent = canVoice ? NAME_TALK_HINT : this.holder ? LOCKED_TALK_HINT : GUEST_TALK_HINT;
    this.updateButtonDisabledState();
    if (this.connectionMode === "listen") this.setMicStatus(false);
  }

  /** Compose connection state and capability state to compute final button disabled state */
  private updateButtonDisabledState(): void {
    const listening = this.connectionMode === "listen";
    // Already listening without a wallet (or a name) to talk: nothing to upgrade to, so the button goes away; the hint stays.
    this.enableButton.hidden = (this.element.dataset.state === "connected" && !listening) || (listening && !this.canTalk);
    this.enableButton.disabled = this.isConnecting;
    this.walletHint.hidden = this.canTalk || (this.isConnecting && !listening);
    this.micLabel.hidden = !this.walletHint.hidden;
  }
}

function button(className: string, text: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = text;
  return b;
}

function row(label: string): HTMLLabelElement {
  const element = document.createElement("label");
  element.className = "zw-voice-row";
  const text = document.createElement("span");
  text.textContent = label;
  element.appendChild(text);
  return element;
}

let voiceStylesInjected = false;
function injectVoiceStyles(): void {
  if (voiceStylesInjected) return;
  voiceStylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.zw-voice-controls { flex-wrap: wrap; align-items: center; gap: 8px; }
/* .zw-button's display: inline-block beat the hidden attribute, so the greyed Enable Voice button stayed
   on screen while connected and pushed the panel into the action bar at 1280 px. */
.zw-voice-controls .zw-button[hidden] { display: none; }
.zw-voice-labels { display: flex; flex-direction: column; gap: 1px; font-size: 11px; }
.zw-voice-status { font-weight: 700; }
.zw-voice-controls.zw-voice-is-live { box-shadow: 0 0 0 2px rgba(255,80,80,0.75); }
.zw-voice-live { display: flex; align-items: center; gap: 6px; }
.zw-voice-live[hidden], .zw-voice-ranges[hidden], .zw-voice-row[hidden] { display: none; }
.zw-voice-wallet-hint { all: unset; cursor: pointer; font: 600 11px "Segoe UI", system-ui, sans-serif; color: #ffd36a; text-decoration: underline dotted; max-width: 150px; }
.zw-voice-wallet-hint[hidden], .zw-voice-mic[hidden] { display: none; }
/* ADR-015: the guest's longer label wraps onto two lines, so the panel stays clear of the action bar at 1280 px. */
.zw-voice-controls .zw-button-primary[data-participation="guest"] { max-width: 132px; padding: 4px 8px; font-size: 11px; line-height: 1.2; text-align: left; }
.zw-voice-ranges { display: flex; border-radius: 8px; overflow: hidden; border: 1px solid rgba(255,255,255,0.14); }
.zw-voice-range { all: unset; cursor: pointer; padding: 4px 8px; font: 600 11px "Segoe UI", system-ui, sans-serif; color: #d8d2e4; }
.zw-voice-range.active { background: rgba(120,200,255,0.28); color: #fff; }
.zw-voice-ranges.overridden { opacity: 0.5; }
.zw-voice-hall-wide { padding: 3px 8px; border-radius: 999px; background: rgba(240,195,94,0.22); border: 1px solid rgba(240,195,94,0.6); color: #ffe2a0; font: 700 11px "Segoe UI", system-ui, sans-serif; white-space: nowrap; }
.zw-voice-hall-wide[hidden] { display: none; }
.zw-voice-mic-button, .zw-voice-gear { all: unset; cursor: pointer; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; background: rgba(255,255,255,0.08); font-size: 14px; }
.zw-voice-mic-button[hidden] { display: none; }
.zw-voice-mic-button.live { background: #e0443e; box-shadow: 0 0 10px rgba(224,68,62,0.8); }
.zw-voice-settings { position: absolute; left: 0; bottom: calc(100% + 8px); width: 260px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.zw-voice-settings[hidden] { display: none; }
/* The failure card sits above the panel like the settings popover, and never wider than the screen. */
.zw-voice-error { position: absolute; left: 0; bottom: calc(100% + 8px); width: min(340px, calc(100vw - 32px)); box-sizing: border-box; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px;
  border: 1px solid rgba(255,140,120,0.55); background: rgba(40,16,18,0.94); }
.zw-voice-error[hidden] { display: none; }
.zw-voice-error-title { font: 700 12px "Segoe UI", system-ui, sans-serif; color: #ffc2b8; line-height: 1.35; }
.zw-voice-error-detail { font-size: 11px; line-height: 1.45; color: #ead9d2; overflow-wrap: anywhere; }
.zw-voice-error-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.zw-voice-error-actions .zw-button { padding: 4px 10px; font-size: 11px; }
.zw-voice-error-actions .zw-button[hidden] { display: none; }
.zw-voice-error-action { background: #c98a3c; border-color: #c98a3c; color: #1a1206; font-weight: 600; }
.zw-voice-error-action:hover:not(:disabled) { background: #d99a4c; }
.zw-voice-row { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: #c9c2d6; }
.zw-voice-row input[type=range] { width: 100%; }
.zw-voice-note { font-size: 11px; color: #9a93a8; line-height: 1.35; }
/* Last, so it wins: at 1280–1440 px the connected panel must stay clear of the centred action bar
   (compacted in WorldHud) and low enough for the chat above it — smaller status text that wraps at most once, tighter
   range buttons, and while the mic is hall-wide the (then inactive) ranges give their place to the pill. */
@media (max-width: 1440px) {
  .zw-voice-labels { max-width: 140px; font-size: 10px; line-height: 1.15; }
  .zw-voice-range { padding: 3px 5px; font-size: 10px; }
  .zw-voice-ranges.overridden { display: none; }
}
`;
  document.head.appendChild(style);
}
