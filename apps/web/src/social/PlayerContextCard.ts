import { injectUiStyles } from "../ui/styles.ts";

export type PresenceState = "online" | "nearby";

export interface PlayerContextCardData {
  playerId: string;
  nickname: string;
  colorSeed: number;
  presence: PresenceState;
  /** CORE-004 §19: whether this player is currently muted — determines whether the action button reads "Mute" or "Unmute". */
  muted: boolean;
}

/**
 * Prototype-level player context card (CORE-003 §9) — opened when a
 * remote player is selected via `RemotePlayerInteractable`. Deliberately
 * minimal: this is a systems/contract foundation for future chat/voice
 * features, not the final social UI (see CORE-003 §22/§28 — no final
 * visual pass here).
 *
 * Security: the nickname is rendered via `textContent` only, never
 * `innerHTML` — see docs/privacy/SOCIAL_IDENTITY_THREAT_MODEL.md §
 * Security / nickname rendering. A malicious nickname (e.g.
 * `<script>...</script>`) displays as inert text, nothing more — and the
 * server already rejects that shape outright (`apps/server/src/nickname.ts`).
 *
 * Action buttons: Block (CORE-003) and Mute (CORE-004 §19) have real
 * behavior. Report and Whisper remain disabled stubs with an explicit
 * "not yet implemented"/"coming later" label/tooltip — CORE-003 §9
 * explicitly forbids a button that looks functional but silently does
 * nothing.
 */
export class PlayerContextCard {
  private readonly backdrop: HTMLDivElement;
  private readonly swatch: HTMLSpanElement;
  private readonly nicknameHeading: HTMLHeadingElement;
  private readonly presenceLabel: HTMLParagraphElement;
  private readonly blockButton: HTMLButtonElement;
  private readonly muteButton: HTMLButtonElement;

  private onBlockCallback: (playerId: string) => void = () => {};
  private onMuteToggleCallback: (playerId: string, muted: boolean) => void = () => {};
  private currentPlayerId: string | null = null;
  private currentMuted = false;

  constructor(container: HTMLElement) {
    injectUiStyles();

    this.backdrop = document.createElement("div");
    this.backdrop.className = "zw-ui zw-player-card-backdrop";

    const modal = document.createElement("div");
    modal.className = "zw-panel zw-modal";

    const header = document.createElement("div");
    header.className = "zw-player-context-header";

    this.swatch = document.createElement("span");
    this.swatch.className = "zw-player-context-swatch";
    header.appendChild(this.swatch);

    this.nicknameHeading = document.createElement("h2");
    header.appendChild(this.nicknameHeading);
    modal.appendChild(header);

    this.presenceLabel = document.createElement("p");
    this.presenceLabel.className = "zw-modal-subtitle";
    modal.appendChild(this.presenceLabel);

    const actions = document.createElement("div");
    actions.className = "zw-player-context-actions";

    this.blockButton = this.buildActionButton("Block", true, "Hide this player locally — does not disconnect or notify them");
    this.blockButton.addEventListener("click", () => {
      if (this.currentPlayerId) this.onBlockCallback(this.currentPlayerId);
    });
    actions.appendChild(this.blockButton);

    // CORE-004 §19: real mute/unmute toggle — unlike Block, this never
    // hides the nameplate or closes the card, so the button's own label
    // is updated in place (see setMuted()) rather than always closing on
    // click the way Block does.
    this.muteButton = this.buildActionButton("Mute", true, "Suppress this player's voice locally — does not affect block, nameplate, or notify them");
    this.muteButton.addEventListener("click", () => {
      if (!this.currentPlayerId) return;
      this.setMuted(!this.currentMuted);
      this.onMuteToggleCallback(this.currentPlayerId, this.currentMuted);
    });
    actions.appendChild(this.muteButton);

    actions.appendChild(this.buildActionButton("Report", false, "Not yet implemented"));
    actions.appendChild(this.buildActionButton("Whisper", false, "Coming later"));

    modal.appendChild(actions);

    const closeHint = document.createElement("div");
    closeHint.className = "zw-modal-close-hint";
    closeHint.textContent = "Press Esc or click outside to close";
    modal.appendChild(closeHint);

    this.backdrop.appendChild(modal);
    this.backdrop.addEventListener("click", (event) => {
      if (event.target === this.backdrop) this.close();
    });

    container.appendChild(this.backdrop);
  }

  private buildActionButton(label: string, enabled: boolean, title: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "zw-button";
    // Stub actions are labeled in their own text, not just via a tooltip,
    // so their state is visible without hovering — CORE-003 §9.
    button.textContent = enabled ? label : `${label} — ${title}`;
    button.title = title;
    button.disabled = !enabled;
    return button;
  }

  onBlock(callback: (playerId: string) => void): void {
    this.onBlockCallback = callback;
  }

  /** `muted` is the NEW desired state (the toggle has already flipped by the time this fires) — see the click handler above. */
  onMuteToggle(callback: (playerId: string, muted: boolean) => void): void {
    this.onMuteToggleCallback = callback;
  }

  open(data: PlayerContextCardData): void {
    this.currentPlayerId = data.playerId;
    this.nicknameHeading.textContent = data.nickname; // textContent ONLY — see class docstring
    this.presenceLabel.textContent = data.presence === "nearby" ? "Nearby" : "Online";
    this.swatch.style.background = `hsl(${data.colorSeed}, 55%, 50%)`;
    this.setMuted(data.muted);
    this.backdrop.classList.add("visible");
  }

  private setMuted(muted: boolean): void {
    this.currentMuted = muted;
    this.muteButton.textContent = muted ? "Unmute" : "Mute";
  }

  close(): void {
    this.backdrop.classList.remove("visible");
    this.currentPlayerId = null;
  }

  get isOpen(): boolean {
    return this.backdrop.classList.contains("visible");
  }

  dispose(): void {
    this.backdrop.remove();
  }
}
