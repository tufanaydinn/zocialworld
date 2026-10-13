import { MAX_CHAT_LENGTH, NEARBY_CHAT_RADIUS_METERS, type ChatChannel, type ChatRejectReason } from "@project/shared";
import { isTakeaway } from "../hall/boardFeeds.ts";
import { formatClock } from "../moderation/format.ts";

/**
 * Text chat panel — bottom-left of the HUD.
 *
 *  - tabs: General (everyone in this world), Nearby (players within
 *    NEARBY_CHAT_RADIUS_METERS), Hall (Watch Hall members only —
 *    the tab shows only while the server counts this
 *    session as a member, `setHallVisible`; takeaway lines starting
 *    with 💡 are highlighted), Whispers (private 1:1 messages);
 *  - typing goes to the active tab; in Whispers it goes to the selected
 *    partner (chosen from a player's card, a whisper line, or `/w name`);
 *  - commands: `/g text`, `/n text`, `/h text`, `/w name text`, `/r text`
 *    (reply to the last whisper);
 *  - unread counts on inactive tabs.
 *
 * ADR-019 § 3: while a moderator's mute runs
 * (`setMuted`), the input says "Muted by a moderator until 14:32" — the server drops
 * the lines anyway and answers each with the same notice.
 *
 * Every string from the network is rendered with `textContent` only.
 * Nothing is stored beyond the last lines kept in memory for this tab.
 */

export type ChatTarget = { readonly kind: "channel"; readonly channel: ChatChannel } | { readonly kind: "whisper"; readonly playerId: string; readonly nickname: string };

export interface ChatLine {
  readonly channel: ChatChannel | "whisper";
  readonly fromPlayerId: string;
  readonly fromNickname: string;
  readonly toPlayerId?: string;
  readonly toNickname?: string;
  readonly text: string;
  readonly t: number;
  /** True when this client sent it (the server's echo). */
  readonly own: boolean;
}

type Tab = ChatChannel | "whisper";

const TABS: { id: Tab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "nearby", label: "Nearby" },
  { id: "hall", label: "Hall" },
  { id: "whisper", label: "Whispers" },
];

const MAX_LINES_PER_TAB = 120;

const REJECT_TEXT: Record<ChatRejectReason, string> = {
  rate_limited: "Slow down — you're sending messages too fast.",
  empty: "Empty messages aren't sent.",
  too_long: `Messages can be at most ${MAX_CHAT_LENGTH} characters.`,
  unknown_recipient: "That player isn't online any more.",
  self: "You can't whisper to yourself.",
  not_in_hall: "Hall chat works inside the Watch Hall.",
};

export class ChatPanel {
  readonly element: HTMLDivElement;
  private readonly logs = new Map<Tab, HTMLDivElement>();
  private readonly tabButtons = new Map<Tab, HTMLButtonElement>();
  private readonly unread = new Map<Tab, number>();
  private readonly input: HTMLInputElement;
  private readonly targetChip: HTMLButtonElement;
  private active: Tab = "general";
  private whisperTarget: { playerId: string; nickname: string } | null = null;
  private lastWhisperFrom: { playerId: string; nickname: string } | null = null;
  private connected = false;
  /** The Hall tab exists only inside the Watch Hall (HallStore.member). */
  private hallVisible = false;
  /** Until when a moderator muted this session (server time), or null. */
  private mutedUntil: number | null = null;
  private muteTimer: ReturnType<typeof setTimeout> | null = null;

  private onSendCallback: (target: ChatTarget, text: string) => void = () => {};
  private resolveNickname: (nickname: string) => { playerId: string; nickname: string } | null = () => null;

  constructor() {
    this.element = el("div", "zw-panel zw-chat");
    const tabs = el("div", "zw-chat-tabs");
    for (const tab of TABS) {
      const button = el("button", "zw-chat-tab");
      button.type = "button";
      button.addEventListener("click", () => this.showTab(tab.id));
      this.tabButtons.set(tab.id, button);
      tabs.appendChild(button);
      const log = el("div", "zw-chat-log");
      log.setAttribute("role", "log");
      log.setAttribute("aria-live", "polite");
      this.logs.set(tab.id, log);
    }

    const form = document.createElement("form");
    form.className = "zw-chat-form";
    this.targetChip = el("button", "zw-chat-target");
    this.targetChip.type = "button";
    this.targetChip.title = "Stop whispering (back to General)";
    this.targetChip.addEventListener("click", () => this.showTab("general"));
    this.input = document.createElement("input");
    this.input.className = "zw-input zw-chat-input";
    this.input.maxLength = MAX_CHAT_LENGTH;
    this.input.setAttribute("aria-label", "Chat message");
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.input.blur();
    });
    const send = el("button", "zw-chat-send");
    send.type = "submit";
    send.title = "Send (Enter)";
    send.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M3 20l18-8L3 4l3 8z M6 12h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
    form.append(this.targetChip, this.input, send);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.submit();
    });

    this.element.append(tabs, ...this.logs.values(), form);
    this.system("Welcome! General reaches everyone, Nearby only people around you. Press Enter to chat, /w name to whisper.", "general");
    this.system(`Nearby messages reach players within ${NEARBY_CHAT_RADIUS_METERS} m.`, "nearby");
    this.system("Hall chat reaches everyone inside the Watch Hall.", "hall");
    this.system("Whispers are private 1:1 messages. Open a player's card (E) → Whisper, or type /w name message.", "whisper");
    this.tabButtons.get("hall")!.hidden = true;
    this.showTab("general");

    // Enter anywhere in the game (not while typing elsewhere) opens the chat input.
    window.addEventListener("keydown", this.onGlobalKey);
  }

  onSend(callback: (target: ChatTarget, text: string) => void): void {
    this.onSendCallback = callback;
  }

  /** Lets `/w name` find a player by (case-insensitive) nickname. */
  setNicknameResolver(resolver: (nickname: string) => { playerId: string; nickname: string } | null): void {
    this.resolveNickname = resolver;
  }

  setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.updatePlaceholder();
    if (!connected) this.system("Disconnected — messages can't be sent until the connection is back.", this.active);
  }

  focus(): void {
    document.exitPointerLock();
    this.input.focus();
  }

  /** A moderator muted this session until `until` (null: unmuted). The placeholder says so until it runs out. */
  setMuted(until: number | null): void {
    if (this.muteTimer) clearTimeout(this.muteTimer);
    this.muteTimer = null;
    this.mutedUntil = until !== null && until > Date.now() ? until : null;
    this.element.classList.toggle("zw-chat-muted", this.mutedUntil !== null);
    if (this.mutedUntil !== null) {
      // setTimeout clamps delays above ~24.8 days; a mute never lasts that long (at most 24 h).
      this.muteTimer = setTimeout(() => this.setMuted(null), Math.min(2_147_483_647, this.mutedUntil - Date.now() + 250));
    }
    this.updatePlaceholder();
  }

  /** Whether a moderator's mute is running (the chat line still goes to the server, which drops it and says so). */
  get muted(): boolean {
    return this.mutedUntil !== null;
  }

  get isTyping(): boolean {
    return document.activeElement === this.input;
  }

  /** Shows the Hall tab while the server counts this session as a hall member; hiding it leaves the tab for General. */
  setHallVisible(visible: boolean): void {
    if (this.hallVisible === visible) return;
    this.hallVisible = visible;
    this.tabButtons.get("hall")!.hidden = !visible;
    if (!visible) {
      this.unread.set("hall", 0);
      if (this.active === "hall") this.showTab("general");
      else this.updateTabLabels();
    }
  }

  /**
   * Discussion Corner: switches to the Hall tab and (by default) focuses the input,
   * optionally prefilled (e.g. "💡 " for a takeaway). False when the Hall tab is not available
   * (outside the hall).
   */
  showHall(options: { readonly prefill?: string; readonly focus?: boolean } = {}): boolean {
    if (!this.hallVisible) {
      this.system(REJECT_TEXT.not_in_hall, this.active);
      return false;
    }
    this.showTab("hall");
    const prefill = options.prefill;
    if (prefill !== undefined && !this.input.value.startsWith(prefill)) this.input.value = prefill + this.input.value;
    if (options.focus === false) return true;
    this.focus();
    const end = this.input.value.length;
    this.input.setSelectionRange(end, end);
    return true;
  }

  /** Switches to Whispers with `playerId` as the partner and focuses the input. */
  startWhisper(playerId: string, nickname: string): void {
    this.whisperTarget = { playerId, nickname };
    this.showTab("whisper");
    this.focus();
  }

  add(line: ChatLine): void {
    const tab: Tab = line.channel;
    const takeaway = line.channel === "hall" && isTakeaway(line.text);
    const row = el("div", `zw-chat-line zw-chat-${line.channel}${line.own ? " zw-chat-own" : ""}${takeaway ? " zw-chat-takeaway" : ""}`);
    const time = el("span", "zw-chat-time");
    time.textContent = new Date(line.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const who = el("button", "zw-chat-name");
    who.type = "button";
    if (line.channel === "whisper") {
      const partner = line.own ? { playerId: line.toPlayerId ?? "", nickname: line.toNickname ?? "" } : { playerId: line.fromPlayerId, nickname: line.fromNickname };
      who.textContent = line.own ? `To ${partner.nickname}:` : `${partner.nickname} whispers:`;
      who.title = `Whisper to ${partner.nickname}`;
      who.addEventListener("click", () => this.startWhisper(partner.playerId, partner.nickname));
      if (!line.own) this.lastWhisperFrom = partner;
      if (!this.whisperTarget && partner.playerId) this.whisperTarget = partner;
    } else {
      who.textContent = `${line.fromNickname}:`;
      if (!line.own) {
        who.title = `Whisper to ${line.fromNickname}`;
        who.addEventListener("click", () => this.startWhisper(line.fromPlayerId, line.fromNickname));
      } else {
        who.disabled = true;
      }
    }
    const text = el("span", "zw-chat-text");
    text.textContent = line.text; // textContent ONLY
    row.append(time, who, text);
    this.append(tab, row);
    if (tab !== this.active && !line.own) {
      this.unread.set(tab, (this.unread.get(tab) ?? 0) + 1);
      this.updateTabLabels();
    }
  }

  rejected(reason: ChatRejectReason): void {
    this.system(REJECT_TEXT[reason], this.active);
  }

  system(text: string, tab: Tab = this.active): void {
    const row = el("div", "zw-chat-line zw-chat-system");
    row.textContent = text;
    this.append(tab, row);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onGlobalKey);
    if (this.muteTimer) clearTimeout(this.muteTimer);
    this.element.remove();
  }

  // ------------------------------------------------------------------

  private onGlobalKey = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" || event.repeat) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    // Enter on the focused 😀 emote button presses it (opens the wheel) — it doesn't open the chat.
    if (target && target.classList.contains("zw-emote-button")) return;
    // Don't steal Enter while a full-screen panel (Community Hub, lessons, the Watch Hall's dialogs, …) is open.
    if (
      document.querySelector(
        ".zw-community-backdrop.visible, .lv-backdrop.visible, .zw-player-card-backdrop.visible, .zw-modal-backdrop.visible, .zw-portal-backdrop.visible, .zw-watch-backdrop.visible, .zw-watch-consent-backdrop.visible, .zw-screen-viewer.visible, .zw-stage-confirm, .zw-hall-menu-backdrop.visible, .zw-speaker-card-backdrop.visible, .zw-hall-dialog-backdrop.visible, .zw-emote-wheel:not([hidden])",
      )
    )
      return;
    event.preventDefault();
    this.focus();
  };

  private submit(): void {
    const raw = this.input.value.trim();
    if (!raw) {
      this.input.blur();
      return;
    }
    const command = /^\/(\w+)\s*(.*)$/.exec(raw);
    let target: ChatTarget | null = this.currentTarget();
    let text = raw;
    if (command) {
      const [, name, rest] = command;
      const verb = name!.toLowerCase();
      if (verb === "g" || verb === "general") {
        this.showTab("general");
        target = { kind: "channel", channel: "general" };
        text = rest!;
      } else if (verb === "n" || verb === "nearby") {
        this.showTab("nearby");
        target = { kind: "channel", channel: "nearby" };
        text = rest!;
      } else if (verb === "h" || verb === "hall") {
        if (!this.hallVisible) {
          this.system(REJECT_TEXT.not_in_hall, this.active);
          return;
        }
        this.showTab("hall");
        target = { kind: "channel", channel: "hall" };
        text = rest!;
      } else if (verb === "w" || verb === "whisper" || verb === "msg") {
        const [nickname = "", ...words] = rest!.split(" ");
        const player = this.resolveNickname(nickname);
        if (!player) {
          this.system(nickname ? `No player called "${nickname}" is online.` : "Usage: /w name message", "whisper");
          this.showTab("whisper");
          return;
        }
        this.whisperTarget = player;
        this.showTab("whisper");
        target = { kind: "whisper", ...player };
        text = words.join(" ");
      } else if (verb === "r" || verb === "reply") {
        if (!this.lastWhisperFrom) {
          this.system("Nobody has whispered to you yet.", "whisper");
          return;
        }
        this.whisperTarget = this.lastWhisperFrom;
        this.showTab("whisper");
        target = { kind: "whisper", ...this.lastWhisperFrom };
        text = rest!;
      } else {
        this.system("Commands: /g, /n, /h, /w name, /r", this.active);
        return;
      }
    }
    if (!target) {
      this.system("Choose who to whisper to: click a name, open a player's card (E), or type /w name message.", "whisper");
      return;
    }
    if (!text.trim()) return;
    if (!this.connected) {
      this.system("Not connected — your message was not sent.", this.active);
      return;
    }
    this.onSendCallback(target, text);
    this.input.value = "";
  }

  private currentTarget(): ChatTarget | null {
    if (this.active === "whisper") return this.whisperTarget ? { kind: "whisper", ...this.whisperTarget } : null;
    return { kind: "channel", channel: this.active };
  }

  private showTab(tab: Tab): void {
    this.active = tab;
    this.unread.set(tab, 0);
    for (const [id, log] of this.logs) log.style.display = id === tab ? "" : "none";
    for (const [id, button] of this.tabButtons) button.classList.toggle("active", id === tab);
    this.updateTabLabels();
    this.updatePlaceholder();
    const log = this.logs.get(tab)!;
    log.scrollTop = log.scrollHeight;
  }

  private updateTabLabels(): void {
    for (const tab of TABS) {
      const count = this.unread.get(tab.id) ?? 0;
      this.tabButtons.get(tab.id)!.textContent = count > 0 ? `${tab.label} · ${count > 99 ? "99+" : count}` : tab.label;
    }
  }

  private updatePlaceholder(): void {
    const whisper = this.active === "whisper" && this.whisperTarget;
    this.targetChip.style.display = whisper ? "" : "none";
    if (whisper) this.targetChip.textContent = `→ ${this.whisperTarget!.nickname} ✕`;
    this.input.placeholder = !this.connected
      ? "Offline…"
      : this.mutedUntil !== null
        ? `Muted by a moderator until ${formatClock(this.mutedUntil)}`
        : this.active === "general"
        ? "Message everyone… (Enter)"
        : this.active === "nearby"
          ? "Message people near you…"
          : this.active === "hall"
            ? "Message the Watch Hall…"
            : whisper
            ? `Whisper to ${this.whisperTarget!.nickname}…`
            : "/w name message";
  }

  private append(tab: Tab, row: HTMLElement): void {
    const log = this.logs.get(tab)!;
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
    log.appendChild(row);
    while (log.childElementCount > MAX_LINES_PER_TAB) log.firstElementChild!.remove();
    if (stick || tab === this.active) log.scrollTop = log.scrollHeight;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}
