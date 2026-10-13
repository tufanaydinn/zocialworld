import { injectUiStyles } from "../ui/styles.ts";

export type PresenceState = "online" | "nearby";

export interface PlayerContextCardData {
  playerId: string;
  nickname: string;
  /** The avatar chip's colour (CSS) — the player's avatar palette colour (ADR-015). */
  accentColor: string;
  /**
   * ADR-015: whether this player can receive ZEC privately (a wallet holder). The one
   * wallet-derived bit the server shares; it gates "Send ZEC" and fills the profile row. The
   * address itself is never known to anyone but its owner.
   */
  canReceive: boolean;
  presence: PresenceState;
  /** Whether this player is currently muted — determines whether the action button reads "Mute" or "Unmute". */
  muted: boolean;
  /** Whether the player is talking right now (voice). */
  speaking?: boolean;
  /** This listener's volume for the player's voice (0–2). */
  volume?: number;
  /** The player signed in as a moderator (the "Moderator" tag; moderators can't act on each other). */
  moderator?: boolean;
}

/** What a moderator picked in the menu (the duration or confirmation comes next, in its own dialog). */
export type PlayerModerationVerb = "mute" | "kick" | "ban";

/** Screen position (CSS px, relative to the container) to anchor the menu next to the selected player. */
export interface CardAnchor {
  readonly x: number;
  readonly y: number;
}

/**
 * Player interaction menu — opened when a remote player is selected
 * (E on the nearest player). A compact menu next to the player with the main actions
 * (Whisper · View Profile · Send ZEC) and the safety actions (Mute ·
 * Block · Report). Report works for every player (ADR-019); a moderator also gets Mute… / Kick / Ban… (not on another
 * moderator), and a moderator's menu header shows the "Moderator" tag.
 *
 * Security: the nickname is rendered via `textContent` only, never
 * `innerHTML` — see docs/privacy/SOCIAL_IDENTITY_THREAT_MODEL.md.
 *
 * Privacy: there is no "View Wallet" action and nothing here shows an
 * address, balance or history. "Send ZEC" never reveals
 * either player's address — see docs/decisions/ADR-013-private-player-payments.md.
 *
 * A button that cannot work yet is disabled and says why in its own
 * label (no button that looks functional but does nothing).
 * "Send ZEC" is disabled (ADR-015) for a player who cannot
 * receive ("Send ZEC — this player has no wallet") and follows
 * `can_receive_updated` live while the menu is open; the profile shows
 * "Can receive ZEC privately: Yes/No — address never shown". There is no
 * wallet badge anywhere else (nameplates stay clean).
 */
const NO_WALLET_LABEL = "Send ZEC — this player has no wallet";
const NO_WALLET_TITLE = "This player has no wallet, so there is nowhere to send ZEC.";
const SEND_TITLE = "Send ZEC privately — neither of you sees the other's address";
export class PlayerContextCard {
  private readonly backdrop: HTMLDivElement;
  private readonly menu: HTMLDivElement;
  private readonly avatar: HTMLSpanElement;
  private readonly nicknameHeading: HTMLDivElement;
  private readonly presenceLabel: HTMLDivElement;
  private readonly whisperButton: HTMLButtonElement;
  private readonly profileButton: HTMLButtonElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly muteButton: HTMLButtonElement;
  private readonly blockButton: HTMLButtonElement;
  private readonly reportButton: HTMLButtonElement;
  private readonly moderatorTag: HTMLSpanElement;
  /** The moderator section (hidden unless this session is a moderator and the target isn't one). */
  private readonly moderationSection: HTMLDivElement;
  private moderatorTools = false;
  private onReportCallback: (playerId: string, nickname: string) => void = () => {};
  private onModerateCallback: (verb: PlayerModerationVerb, playerId: string, nickname: string) => void = () => {};
  private readonly profilePane: HTMLDivElement;
  private readonly volumeSlider: HTMLInputElement;
  private readonly volumeValue: HTMLSpanElement;
  private onVolumeCallback: (playerId: string, volume: number) => void = () => {};

  private onBlockCallback: (playerId: string) => void = () => {};
  private onMuteToggleCallback: (playerId: string, muted: boolean) => void = () => {};
  private onWhisperCallback: (playerId: string, nickname: string) => void = () => {};
  private onSendZecCallback: ((playerId: string, nickname: string) => void) | null = null;
  private current: PlayerContextCardData | null = null;
  private currentMuted = false;
  private sendZecReason = "Send ZEC isn't available yet";

  constructor(container: HTMLElement) {
    injectUiStyles();
    injectMenuStyles();

    this.backdrop = document.createElement("div");
    this.backdrop.className = "zw-ui zw-player-card-backdrop zw-player-menu-backdrop";

    this.menu = document.createElement("div");
    this.menu.className = "zw-panel zw-player-menu";
    this.menu.setAttribute("role", "menu");

    const header = document.createElement("div");
    header.className = "zw-player-menu-header";
    this.avatar = document.createElement("span");
    this.avatar.className = "zw-player-menu-avatar";
    const names = document.createElement("div");
    this.nicknameHeading = document.createElement("div");
    this.nicknameHeading.className = "zw-player-menu-name";
    this.presenceLabel = document.createElement("div");
    this.presenceLabel.className = "zw-player-menu-presence";
    this.moderatorTag = document.createElement("span");
    this.moderatorTag.className = "zw-moderator-tag";
    this.moderatorTag.textContent = "Moderator";
    this.moderatorTag.title = "This player signed in as a moderator for this session";
    this.moderatorTag.hidden = true;
    names.append(this.nicknameHeading, this.moderatorTag, this.presenceLabel);
    header.append(this.avatar, names);

    this.whisperButton = this.item("💬", "Whisper", "Send a private message");
    this.whisperButton.addEventListener("click", () => {
      if (!this.current) return;
      const { playerId, nickname } = this.current;
      this.close();
      this.onWhisperCallback(playerId, nickname);
    });
    this.profileButton = this.item("👤", "View Profile", "Public profile (nickname and presence only)");
    this.profileButton.addEventListener("click", () => this.toggleProfile());
    this.sendButton = this.item("ⓩ", "Send ZEC", SEND_TITLE);
    this.sendButton.classList.add("zw-player-menu-zec");
    this.sendButton.addEventListener("click", () => {
      if (!this.current || !this.onSendZecCallback || !this.current.canReceive) return;
      const { playerId, nickname } = this.current;
      this.close();
      this.onSendZecCallback(playerId, nickname);
    });

    this.profilePane = document.createElement("div");
    this.profilePane.className = "zw-player-menu-profile";
    this.profilePane.hidden = true;

    const divider = document.createElement("div");
    divider.className = "zw-player-menu-divider";

    // Real mute/unmute toggle — label updated in place.
    this.muteButton = this.item("🔇", "Mute", "Silence this player's voice for you only — they are not notified");
    this.muteButton.addEventListener("click", () => {
      if (!this.current) return;
      this.setMuted(!this.currentMuted);
      this.onMuteToggleCallback(this.current.playerId, this.currentMuted);
    });
    this.blockButton = this.item("⛔", "Block", "Hide this player's name, chat and voice for you — they are not notified");
    this.blockButton.addEventListener("click", () => {
      if (this.current) this.onBlockCallback(this.current.playerId);
    });
    // Report (everyone) — the reason, a note and what moderators see come in the report dialog.
    this.reportButton = this.item("⚑", "Report", "Report this player to the moderators — they see your nickname; the player isn't told who reported them");
    this.reportButton.classList.add("zw-player-menu-report");
    this.reportButton.addEventListener("click", () => {
      if (!this.current) return;
      const { playerId, nickname } = this.current;
      this.close();
      this.onReportCallback(playerId, nickname);
    });
    this.moderationSection = document.createElement("div");
    this.moderationSection.className = "zw-player-menu-moderation";
    this.moderationSection.hidden = true;
    const moderationTitle = document.createElement("div");
    moderationTitle.className = "zw-player-menu-section-title";
    moderationTitle.textContent = "Moderator";
    const moderate = (icon: string, label: string, title: string, verb: PlayerModerationVerb): HTMLButtonElement => {
      const action = this.item(icon, label, title);
      action.classList.add(`zw-player-menu-mod-${verb}`);
      action.addEventListener("click", () => {
        if (!this.current) return;
        const { playerId, nickname } = this.current;
        this.close();
        this.onModerateCallback(verb, playerId, nickname);
      });
      return action;
    };
    this.moderationSection.append(
      moderationTitle,
      moderate("🤐", "Mute…", "Stop this player's chat, whispers and hall chat for a while", "mute"),
      moderate("🚪", "Kick", "Disconnect this player (they can't come back for 10 minutes)", "kick"),
      moderate("⛔", "Ban…", "Disconnect this player and keep them out for a while", "ban"),
    );

    const volume = document.createElement("label");
    volume.className = "zw-player-menu-volume";
    volume.title = "Their voice volume — for you only";
    const volumeIcon = document.createElement("span");
    volumeIcon.textContent = "🔊";
    this.volumeSlider = document.createElement("input");
    this.volumeSlider.type = "range";
    this.volumeSlider.min = "0";
    this.volumeSlider.max = "200";
    this.volumeSlider.setAttribute("aria-label", "Voice volume for this player");
    this.volumeValue = document.createElement("span");
    this.volumeSlider.addEventListener("input", () => {
      this.volumeValue.textContent = `${this.volumeSlider.value}%`;
      if (this.current) this.onVolumeCallback(this.current.playerId, Number(this.volumeSlider.value) / 100);
    });
    volume.append(volumeIcon, this.volumeSlider, this.volumeValue);

    this.menu.append(header, this.whisperButton, this.profileButton, this.sendButton, this.profilePane, divider, volume, this.muteButton, this.blockButton, this.reportButton, this.moderationSection);
    this.backdrop.appendChild(this.menu);
    this.backdrop.addEventListener("click", (event) => {
      if (event.target === this.backdrop) this.close();
    });
    container.appendChild(this.backdrop);
    this.updateSendButton();
  }

  private item(icon: string, label: string, title: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "zw-player-menu-item";
    button.setAttribute("role", "menuitem");
    button.title = title;
    const glyph = document.createElement("span");
    glyph.className = "zw-player-menu-icon";
    glyph.textContent = icon;
    const text = document.createElement("span");
    text.className = "zw-player-menu-label";
    text.textContent = label;
    button.append(glyph, text);
    return button;
  }

  private setLabel(button: HTMLButtonElement, label: string): void {
    (button.querySelector(".zw-player-menu-label") as HTMLSpanElement).textContent = label;
  }

  onBlock(callback: (playerId: string) => void): void {
    this.onBlockCallback = callback;
  }

  /** `muted` is the NEW desired state (the toggle has already flipped by the time this fires). */
  onMuteToggle(callback: (playerId: string, muted: boolean) => void): void {
    this.onMuteToggleCallback = callback;
  }

  /** Per-player voice volume (local only). */
  onVolumeChange(callback: (playerId: string, volume: number) => void): void {
    this.onVolumeCallback = callback;
  }

  onWhisper(callback: (playerId: string, nickname: string) => void): void {
    this.onWhisperCallback = callback;
  }

  /** "Report" was chosen (the report dialog opens next). */
  onReport(callback: (playerId: string, nickname: string) => void): void {
    this.onReportCallback = callback;
  }

  /** A moderator chose Mute… / Kick / Ban… (the duration or confirmation dialog opens next). */
  onModerate(callback: (verb: PlayerModerationVerb, playerId: string, nickname: string) => void): void {
    this.onModerateCallback = callback;
  }

  /** This session is (or stopped being) a moderator — the Mute… / Kick / Ban… section follows. */
  setModeratorTools(enabled: boolean): void {
    this.moderatorTools = enabled;
    this.updateModeration();
  }

  /** `moderator_updated` while the menu may be open: the tag (and the moderator section) follow. */
  setModerator(playerId: string, moderator: boolean): void {
    if (!this.current || this.current.playerId !== playerId) return;
    this.current.moderator = moderator;
    this.updateModeration();
  }

  /**
   * Enables "Send ZEC" (null disables it); `unavailableReason` is shown in
   * the button when disabled (e.g. "set up your wallet first").
   */
  setSendZec(callback: ((playerId: string, nickname: string) => void) | null, unavailableReason = "Send ZEC isn't available yet"): void {
    this.onSendZecCallback = callback;
    this.sendZecReason = unavailableReason;
    this.updateSendButton();
  }

  open(data: PlayerContextCardData, anchor?: CardAnchor): void {
    this.current = { ...data };
    this.nicknameHeading.textContent = data.nickname; // textContent ONLY
    this.presenceLabel.textContent = `${data.presence === "nearby" ? "Nearby" : "Online"}${data.speaking ? " · speaking" : ""}`;
    this.avatar.style.background = data.accentColor;
    this.avatar.textContent = data.nickname.charAt(0).toUpperCase();
    this.updateModeration();
    this.setMuted(data.muted);
    this.updateSendButton();
    const percent = Math.round((data.volume ?? 1) * 100);
    this.volumeSlider.value = String(percent);
    this.volumeValue.textContent = `${percent}%`;
    this.profilePane.hidden = true;
    this.setLabel(this.profileButton, "View Profile");
    this.backdrop.classList.add("visible");
    this.place(anchor);
    this.whisperButton.focus({ preventScroll: true });
  }

  private place(anchor?: CardAnchor): void {
    if (!anchor) {
      this.menu.style.left = "50%";
      this.menu.style.top = "50%";
      this.menu.style.transform = "translate(-50%, -50%)";
      return;
    }
    const bounds = this.backdrop.getBoundingClientRect();
    const width = this.menu.offsetWidth || 220;
    const height = this.menu.offsetHeight || 300;
    // Beside the player (right of their head), kept on screen.
    const x = Math.min(Math.max(12, anchor.x + 24), bounds.width - width - 12);
    const y = Math.min(Math.max(12, anchor.y - 20), bounds.height - height - 12);
    this.menu.style.transform = "none";
    this.menu.style.left = `${x}px`;
    this.menu.style.top = `${y}px`;
  }

  /**
   * ADR-015 `can_receive_updated` while the menu may be open: if it shows `playerId`, the Send ZEC
   * button and the profile row follow at once. Ignored for anyone else.
   */
  setCanReceive(playerId: string, canReceive: boolean): void {
    if (!this.current || this.current.playerId !== playerId || this.current.canReceive === canReceive) return;
    this.current.canReceive = canReceive;
    this.updateSendButton();
    if (!this.profilePane.hidden) this.renderProfile();
  }

  /** Which player the menu shows (null when closed). */
  get playerId(): string | null {
    return this.current?.playerId ?? null;
  }

  private toggleProfile(): void {
    if (!this.current) return;
    const show = this.profilePane.hidden;
    this.profilePane.hidden = !show;
    this.setLabel(this.profileButton, show ? "Hide Profile" : "View Profile");
    if (!show) return;
    this.renderProfile();
    this.place(this.menu.style.transform === "none" ? { x: this.menu.offsetLeft - 24, y: this.menu.offsetTop + 20 } : undefined);
  }

  private renderProfile(): void {
    if (!this.current) return;
    this.profilePane.replaceChildren();
    const rows: [string, string][] = [
      ["Nickname", this.current.nickname],
      ["Status", this.current.presence === "nearby" ? "Nearby you" : "Online"],
      ["Voice", this.currentMuted ? "Muted by you" : this.current.speaking ? "Speaking" : "—"],
      // ADR-015 § 4: the one wallet-derived fact anyone learns about another player — never the address.
      ["Can receive ZEC privately", `${this.current.canReceive ? "Yes" : "No"} — address never shown`],
    ];
    for (const [key, value] of rows) {
      const row = document.createElement("div");
      const k = document.createElement("span");
      k.textContent = key;
      const v = document.createElement("span");
      v.textContent = value; // textContent ONLY
      row.append(k, v);
      this.profilePane.appendChild(row);
    }
  }

  private updateSendButton(): void {
    const available = this.onSendZecCallback !== null;
    const receiver = this.current?.canReceive ?? true;
    this.sendButton.disabled = !available || !receiver;
    if (!available) {
      this.setLabel(this.sendButton, `Send ZEC — ${this.sendZecReason}`);
      this.sendButton.title = SEND_TITLE;
    } else if (!receiver) {
      // A disabled button says why in its own label (tooltips on disabled buttons are unreliable).
      this.setLabel(this.sendButton, NO_WALLET_LABEL);
      this.sendButton.title = NO_WALLET_TITLE;
    } else {
      this.setLabel(this.sendButton, "Send ZEC");
      this.sendButton.title = SEND_TITLE;
    }
  }

  private updateModeration(): void {
    const targetIsModerator = this.current?.moderator === true;
    this.moderatorTag.hidden = !targetIsModerator;
    this.moderationSection.hidden = !this.moderatorTools || targetIsModerator;
  }

  private setMuted(muted: boolean): void {
    this.currentMuted = muted;
    this.setLabel(this.muteButton, muted ? "Unmute" : "Mute");
  }

  close(): void {
    this.backdrop.classList.remove("visible");
    this.current = null;
  }

  get isOpen(): boolean {
    return this.backdrop.classList.contains("visible");
  }

  dispose(): void {
    this.backdrop.remove();
  }
}

let menuStylesInjected = false;
function injectMenuStyles(): void {
  if (menuStylesInjected) return;
  menuStylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.zw-player-menu-backdrop { background: rgba(5,6,9,0.18); display: block; }
.zw-player-menu { position: absolute; width: 228px; padding: 8px; border-radius: 14px; background: rgba(22,22,34,0.94); border: 1px solid rgba(255,255,255,0.10);
  box-shadow: 0 10px 30px rgba(0,0,0,0.45); display: flex; flex-direction: column; gap: 2px; }
.zw-player-menu-header { display: flex; align-items: center; gap: 10px; padding: 4px 6px 8px; }
.zw-player-menu-avatar { width: 34px; height: 34px; border-radius: 50%; flex: none; display: grid; place-items: center; color: #fff; font: 700 15px "Segoe UI", system-ui, sans-serif;
  box-shadow: inset 0 0 0 2px rgba(255,255,255,0.35); }
.zw-player-menu-name { font: 700 15px "Segoe UI", system-ui, sans-serif; color: #fff; overflow-wrap: anywhere; }
.zw-player-menu-presence { font-size: 11px; color: #9be8b4; }
.zw-player-menu-item { all: unset; display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 9px; cursor: pointer; color: #ece8f2;
  font: 600 13px "Segoe UI", system-ui, sans-serif; }
.zw-player-menu-item:hover:not(:disabled), .zw-player-menu-item:focus-visible { background: rgba(255,255,255,0.09); }
.zw-player-menu-item:disabled { cursor: default; color: #8e8a99; }
.zw-player-menu-icon { width: 20px; text-align: center; font-size: 15px; }
.zw-player-menu-zec .zw-player-menu-icon { width: 20px; height: 20px; line-height: 20px; border-radius: 50%; background: #f4b728; color: #241a05; font-weight: 800; font-size: 13px; }
.zw-player-menu-zec:disabled .zw-player-menu-icon { filter: grayscale(0.7); opacity: 0.6; }
.zw-player-menu-volume { display: flex; align-items: center; gap: 8px; padding: 4px 10px; font-size: 12px; color: #c9c2d6; }
.zw-player-menu-volume input { flex: 1; min-width: 0; }
.zw-player-menu-volume span:last-child { width: 38px; text-align: right; }
.zw-player-menu-divider { height: 1px; margin: 4px 6px; background: rgba(255,255,255,0.10); }
.zw-player-menu-profile { margin: 2px 6px 4px; padding: 8px; border-radius: 9px; background: rgba(255,255,255,0.05); display: flex; flex-direction: column; gap: 5px; }
.zw-player-menu-profile div { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; }
.zw-player-menu-profile div span:first-child { color: #9b95aa; } .zw-player-menu-profile div span:last-child { color: #ece8f2; text-align: right; }
.zw-moderator-tag { display: inline-block; margin: 2px 0; padding: 1px 7px; border-radius: 999px; background: #2f6fb0; color: #fff; font: 700 10px "Segoe UI", system-ui, sans-serif; letter-spacing: 0.04em; text-transform: uppercase; }
.zw-moderator-tag[hidden] { display: none; }
.zw-player-menu-moderation { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; padding-top: 6px; border-top: 1px solid rgba(120,170,255,0.25); }
.zw-player-menu-moderation[hidden] { display: none; }
.zw-player-menu-section-title { padding: 0 10px 2px; font: 700 10px "Segoe UI", system-ui, sans-serif; color: #9cc3ff; letter-spacing: 0.06em; text-transform: uppercase; }
`;
  document.head.appendChild(style);
}
