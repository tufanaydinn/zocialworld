import { HALL_CARD_LINK_HOSTS, HALL_CARD_LINKS_MAX, HALL_CARD_NAME_MAX, HALL_CARD_TITLE_MAX, HALL_HOST_KEY_MAX, HALL_LINK_KINDS, type HallErrorReason, type HallLinkKind } from "@project/shared";
import { injectUiStyles } from "../ui/styles.ts";
import type { VoiceConnectionState } from "../voice/VoiceClient.ts";
import type { VoiceConnectionMode } from "../voice/hallAudio.ts";
import { prepareSecondsLeft } from "./boardFeeds.ts";
import { draftFromCard, linkKindLabel, parseCardDraft, suggestLinkKind, type CardDraft, type CardFormErrors } from "./cardForm.ts";
import type { HallStore, HallStoreEvent } from "./HallStore.ts";
import type { StageSystem, StageSystemState } from "./StageSystem.ts";
import { formatCooldown, stageVoiceNotice, stageVoteView, talkNeeds } from "./stageState.ts";

/**
 * The Watch Hall's stage widget (docs/architecture/WATCH_HALL.md): a compact,
 * collapsible wood-and-gold panel at the bottom right, above the nickname box, shown while the
 * player is inside the hall. It replaces StageSystem's temporary top-centre HUD.
 *
 *  - Everyone: who holds the stage and its status (getting ready with a countdown, LIVE with or
 *    without sound), the queue with your place, Request the stage / Leave the queue, raised hands
 *    and the floor, the watch-mode / voice hint and a stage-volume slider.
 *  - The holder: Start sharing, Stop, Hand over (to a queued player — queuing is the consent),
 *    Edit card (validated with cardForm.ts / hallCard.ts before sending; "Pick from catalogue"
 *    opens the Watch panel, whose "Show on the big screen" sets the card), Give the floor (from
 *    raised hands, in order), Take the floor back, Lower hands (one / all).
 *  - Hosts: "Unlock host tools" asks for the key in a password field (never in a URL, not kept
 *    after sending), then Lock / unlock, force Stop, Grant to a queued player, Lower all hands and
 *    the card while the stage is idle ("up next"). ADR-019 § 1: the same field
 *    takes a moderator key (a moderator has every host power, anywhere in the world); Profile →
 *    "Moderator sign-in" opens this same dialog outside the hall.
 *
 * Every action goes through StageSystem / HallStore (the server decides; refusals arrive as
 * `hall_error` and become short chat lines). Names come from presence and are rendered with
 * textContent only. Nothing here is logged or persisted except the collapsed flag (per viewer).
 */

export type StageWidgetStage = Pick<
  StageSystem,
  | "state"
  | "subscribe"
  | "requestStage"
  | "cancel"
  | "stop"
  | "handover"
  | "startSharing"
  | "setCard"
  | "giveFloor"
  | "giveUpFloor"
  | "lowerHands"
  | "lock"
  | "startWatching"
  | "vote"
  | "dequeue"
  | "setCooldown"
  | "needsName"
>;

/** The stage cooldowns a host can pick for a player (0 lifts one). */
export const HOST_COOLDOWN_CHOICES: readonly { readonly ms: number; readonly label: string }[] = [
  { ms: 10 * 60_000, label: "10 min" },
  { ms: 30 * 60_000, label: "30 min" },
  { ms: 60 * 60_000, label: "1 hour" },
  { ms: 0, label: "Lift cooldown" },
];

export interface StageWidgetOptions {
  readonly container: HTMLElement;
  readonly stage: StageWidgetStage;
  readonly hall: HallStore;
  /** A remote player's nickname from presence. */
  readonly nicknameOf: (playerId: string) => string | undefined;
  readonly voice: { readonly connectionMode: VoiceConnectionMode; readonly connectionState: VoiceConnectionState };
  /** Whether the wallet allows talking (participation capability canVoice). */
  readonly canTalk: () => boolean;
  /** A wallet holder (a locked wallet) rather than a guest — "Unlock wallet to talk" vs "Connect a wallet to talk". */
  readonly isHolder?: () => boolean;
  /** "Enable voice to talk" (from a click): full voice when the wallet allows it, else the wallet panel. */
  readonly requestVoice: () => void;
  /** From a click: the name confirmation (on a server with a name registry, presenting needs a confirmed name). */
  readonly requestName?: () => void;
  /** Sends `hall_host_auth`. The key is handed straight through and never kept here. */
  readonly sendHostKey: (key: string) => void;
  /** "Pick from catalogue": the Watch panel (its "Show on the big screen" sets the card). */
  readonly openCatalogue: () => void;
  /** A short chat system line. */
  readonly announce: (text: string) => void;
  readonly now?: () => number;
}

const COLLAPSED_KEY = "watch-hall-stage-widget-collapsed-v1";
const HOST_ANSWER_TIMEOUT_MS = 8000;
const TICK_MS = 250;

const HOST_ERROR_TEXT: Partial<Record<HallErrorReason, string>> = {
  host_disabled: "Host tools are turned off on this server.",
  bad_key: "That key isn't right.",
  rate_limited: "Too many attempts — reconnect to try again.",
  not_in_hall: "Step inside the Watch Hall first.",
  full: "Too many hosts are signed in right now.",
};

export class StageWidget {
  private readonly options: StageWidgetOptions;
  private readonly now: () => number;
  /** The right-hand column below the minimap: an optional slot (the "Now on stage" chip) above the widget. */
  private readonly dock: HTMLDivElement;
  /** Where SpeakerCardPanel puts its HUD chip, so the two stack instead of overlapping (and never cover the minimap). */
  readonly chipSlot: HTMLDivElement;
  private readonly root: HTMLElement;
  private readonly statusText: HTMLSpanElement;
  private readonly toggle: HTMLButtonElement;
  private readonly watchButton: HTMLButtonElement;
  /** The scrolling part: the rebuilt content, then the stage-volume row (so only the header and the watch button are fixed). */
  private readonly body: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly volumeRow: HTMLDivElement;
  private readonly volumeSlider: HTMLInputElement;
  private readonly volumeValue: HTMLSpanElement;
  private readonly unsubscribers: (() => void)[] = [];
  private volumeListener: (volume: number) => void = () => {};
  private collapsed: boolean;
  private bodyKey = "";
  private countdown: HTMLElement | null = null;
  private preparing: { key: string; seenAt: number } | null = null;
  private lastTick = 0;
  private visible = false;
  private keyDialog: KeyDialog | null = null;
  private cardDialog: CardDialog | null = null;
  /** Non-hosts see "Host tools" only after opening it (it never pushes the useful parts out of view). */
  private hostToolsOpen = false;

  constructor(options: StageWidgetOptions) {
    injectUiStyles();
    injectStageWidgetStyles();
    this.options = options;
    this.now = options.now ?? Date.now;
    this.collapsed = readCollapsed();

    this.root = el("section", "zw-ui zw-panel zw-stage-widget");
    this.root.setAttribute("aria-label", "Stage");
    this.root.hidden = true;

    const head = el("div", "zw-stage-widget-head");
    const title = el("span", "zw-stage-widget-title");
    title.textContent = "🎬 Stage";
    this.statusText = el("span", "zw-stage-widget-status");
    this.statusText.setAttribute("role", "status");
    this.statusText.setAttribute("aria-live", "polite");
    this.toggle = el("button", "zw-stage-widget-toggle");
    this.toggle.type = "button";
    this.toggle.addEventListener("click", () => this.setCollapsed(!this.collapsed));
    head.append(title, this.statusText, this.toggle);

    this.watchButton = el("button", "zw-stage-watch");
    this.watchButton.type = "button";
    this.watchButton.setAttribute("aria-label", "Watch the stage (audio and video). No wallet needed; nobody hears you.");
    const watchTitle = el("span", "zw-stage-watch-title");
    watchTitle.textContent = "▶ Watch the stage (audio + video)";
    const watchNote = el("span", "zw-stage-watch-note");
    watchNote.textContent = "No wallet needed · nobody hears you";
    this.watchButton.append(watchTitle, watchNote);
    this.watchButton.hidden = true;
    this.watchButton.addEventListener("click", () => {
      this.watchButton.blur();
      void options.stage.startWatching();
    });

    this.body = el("div", "zw-stage-widget-body");
    this.content = el("div", "zw-stage-widget-content");

    this.volumeRow = el("div", "zw-stage-widget-volume");
    const volumeLabel = el("label", "zw-stage-widget-volume-label");
    const volumeText = el("span", "");
    volumeText.textContent = "🔊 Stage volume";
    this.volumeSlider = document.createElement("input");
    this.volumeSlider.type = "range";
    this.volumeSlider.min = "0";
    this.volumeSlider.max = "200";
    this.volumeSlider.step = "5";
    this.volumeSlider.value = "100";
    this.volumeSlider.setAttribute("aria-label", "Stage volume");
    this.volumeValue = el("span", "zw-stage-widget-volume-value");
    this.volumeValue.textContent = "100%";
    this.volumeSlider.addEventListener("input", () => {
      const volume = Number(this.volumeSlider.value) / 100;
      this.volumeValue.textContent = `${this.volumeSlider.value}%`;
      this.volumeListener(volume);
    });
    volumeLabel.append(volumeText, this.volumeSlider);
    this.volumeRow.append(volumeLabel, this.volumeValue);

    this.body.append(this.content, this.volumeRow);
    this.root.append(head, this.watchButton, this.body);
    this.dock = el("div", "zw-ui zw-hall-dock");
    this.chipSlot = el("div", "zw-hall-dock-slot");
    this.dock.append(this.chipSlot, this.root);
    options.container.appendChild(this.dock);
    this.applyCollapsed();

    this.unsubscribers.push(
      options.stage.subscribe(() => this.refresh()),
      options.hall.subscribe((event) => this.onHallEvent(event)),
    );
    this.refresh();
  }

  /** Whether the key prompt or the card editor is open (Esc closes them; the chat's Enter stays out). */
  get isDialogOpen(): boolean {
    return this.keyDialog !== null || this.cardDialog !== null;
  }

  closeDialogs(): void {
    this.keyDialog?.close();
    this.cardDialog?.close();
  }

  /** Shows the remembered stage volume (0–2), e.g. after the voice settings slider changed it. */
  setStageVolume(volume: number): void {
    const percent = String(Math.round(Math.max(0, Math.min(2, volume)) * 100));
    this.volumeSlider.value = percent;
    this.volumeValue.textContent = `${percent}%`;
  }

  /** Subscribe to the slider (0–2). App applies it through VoiceSession.setStageVolume. */
  onStageVolume(listener: (volume: number) => void): void {
    this.volumeListener = listener;
  }

  /** Opens the card editor (holder or host). */
  editCard(): void {
    const hall = this.options.hall;
    if (!hall.member || !(hall.amHolder || hall.isHost)) {
      this.options.announce("Only the presenter or a host can edit the speaker card.");
      return;
    }
    if (this.cardDialog) return;
    this.cardDialog = new CardDialog(this.options.container, {
      draft: draftFromCard(hall.stage.card),
      idle: hall.stage.holder === null,
      canPickFromCatalogue: hall.amHolder,
      hasCard: hall.stage.card !== null,
      save: (card) => this.options.stage.setCard(card),
      clear: () => this.options.stage.setCard(null),
      pick: () => this.options.openCatalogue(),
      onClose: () => {
        this.cardDialog = null;
      },
    });
  }

  /** Opens the host key prompt. */
  unlockHost(): void {
    if (this.keyDialog || this.options.hall.isHost) return;
    this.keyDialog = new KeyDialog(this.options.container, {
      send: (key) => this.options.sendHostKey(key),
      onClose: () => {
        this.keyDialog = null;
      },
    });
  }

  /** Per frame from App (cheap): the preparing countdown and a periodic re-render (nicknames can change without a hall event). */
  update(): void {
    const now = this.now();
    if (now - this.lastTick < TICK_MS) return;
    this.lastTick = now;
    this.refresh();
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.closeDialogs();
    this.dock.remove();
  }

  // ------------------------------------------------------------------ hall events

  private onHallEvent(event: HallStoreEvent): void {
    if (event.type === "change") {
      const hall = this.options.hall;
      if (hall.isHost && this.keyDialog) {
        this.keyDialog.close();
        this.options.announce("Host tools unlocked for this session.");
      }
      if (!hall.member) this.closeDialogs();
      else if (this.cardDialog && !(hall.amHolder || hall.isHost)) this.cardDialog.close();
      this.refresh();
      return;
    }
    if (event.type !== "error") return;
    if (event.op === "host") {
      const text = HOST_ERROR_TEXT[event.reason] ?? "Host tools couldn't be unlocked.";
      if (this.keyDialog) this.keyDialog.fail(text);
      else this.options.announce(text);
    } else if (event.op === "hand" && (event.reason === "not_holder" || event.reason === "not_host")) {
      // Raising a hand never answers these; lowering someone else's does (the emote wheel owns raise errors).
      this.options.announce("Only the presenter or a host can lower hands.");
    } else if (event.op === "hand" && event.reason === "full") {
      this.options.announce("Too many hands are up right now — try again in a bit.");
    }
  }

  // ------------------------------------------------------------------ rendering

  private name(playerId: string): string {
    if (playerId === this.options.hall.localPlayerId) return "You";
    return this.options.nicknameOf(playerId) ?? "Someone";
  }

  private refresh(): void {
    const state = this.options.stage.state;
    const hall = this.options.hall;
    const visible = state.inside || hall.member;
    if (visible !== this.visible) {
      this.visible = visible;
      this.root.hidden = !visible;
      if (!visible) this.closeDialogs();
    }
    if (!visible) return;

    const stage = state.stage;
    const preparingKey = stage.holder !== null && stage.status === "preparing" ? `${stage.holder}|${stage.since}` : null;
    if (preparingKey === null) this.preparing = null;
    else if (this.preparing?.key !== preparingKey) this.preparing = { key: preparingKey, seenAt: this.now() };

    // The presenter needs full voice to share (the widget's voice hint says so), not watch mode.
    this.watchButton.hidden = !state.watchBanner || hall.amHolder;
    this.watchButton.disabled = state.watchStarting;
    // Write only on change: the header is a polite live region, and a rewrite re-announces it.
    const line = this.statusLine(state);
    if (this.statusText.textContent !== line) this.statusText.textContent = line;

    const key = JSON.stringify(this.model(state));
    if (key !== this.bodyKey) {
      this.bodyKey = key;
      this.renderBody(state);
    }
    if (this.countdown && this.preparing) {
      const left = formatSeconds(prepareSecondsLeft(this.preparing.seenAt, this.now()));
      if (this.countdown.textContent !== left) this.countdown.textContent = left;
    }
  }

  private secondsLeft(): string {
    return this.preparing ? formatSeconds(prepareSecondsLeft(this.preparing.seenAt, this.now())) : "";
  }

  /** The one-line status in the header (kept while collapsed; a polite live region, so no ticking countdown here). */
  private statusLine(state: StageSystemState): string {
    const stage = state.stage;
    if (!state.member) return "Joining the hall…";
    // The floor makes your microphone hall-wide: keep saying so, also while collapsed.
    const floor = this.options.hall.floor !== null && this.options.hall.floor === this.options.hall.localPlayerId ? "🎙 You have the floor · " : "";
    if (stage.holder === null) return floor + (stage.locked ? "🔒 Locked" : stage.card ? "Up next" : "Open stage");
    const name = this.name(stage.holder);
    if (stage.status === "live") return `${floor}LIVE · ${name} ${stage.audio ? "🔊" : "· no sound"}`;
    return `${floor}${name} · getting ready`;
  }

  /** Everything the body shows, as data (the body is rebuilt only when this changes). */
  private model(state: StageSystemState): unknown {
    const hall = this.options.hall;
    const voice = this.options.voice;
    return {
      member: state.member,
      phase: state.phase,
      position: state.queuePosition,
      sharing: [state.sharingAudio, state.sharingSystemAudio, state.starting],
      stage: [state.stage.holder && this.name(state.stage.holder), state.stage.status, state.stage.audio, state.stage.locked, state.stage.card?.title ?? null],
      queue: state.stage.queue.map((id) => [id, this.name(id)]),
      hands: hall.hands.map((id) => [id, this.name(id)]),
      floor: hall.floor && [hall.floor, this.name(hall.floor)],
      host: hall.isHost,
      holder: hall.amHolder,
      voice: [voice.connectionMode, voice.connectionState, state.watchBanner, this.options.canTalk(), this.options.stage.needsName],
      vote: [hall.vote.votes, hall.vote.needed, hall.vote.voted],
      hostToolsOpen: this.hostToolsOpen,
    };
  }

  /** The audience vote row — the count for everyone, the button for those whose vote counts. */
  private voteRow(state: StageSystemState): HTMLElement | null {
    const hall = this.options.hall;
    const view = stageVoteView({ member: state.member, stage: state.stage, vote: hall.vote, localPlayerId: hall.localPlayerId, needsName: this.options.stage.needsName });
    if (!view.open) return null;
    const row = el("div", "zw-stage-widget-vote");
    const count = el("span", "zw-stage-widget-vote-count");
    count.textContent = `🗳 ${view.countText}`;
    count.setAttribute("aria-label", view.countText);
    row.appendChild(count);
    if (view.canVote) {
      row.appendChild(
        view.voted
          ? button("Take back my vote", "Take back my vote to end this share", () => this.options.stage.vote(false), false, true)
          : button("End this share", "Vote to end this share (the hall decides together; nobody sees who voted)", () => this.options.stage.vote(true), false, true),
      );
    }
    if (view.note) row.appendChild(note(view.note));
    else if (view.canVote && !view.voted) row.appendChild(note("Anonymous: only the count is shown."));
    return row;
  }

  /** Host tool: a compact "Cooldown…" menu that keeps `playerId` off the stage for a while (or lifts it). */
  private cooldownMenu(playerId: string): HTMLSelectElement {
    const name = this.name(playerId);
    const select = el("select", "zw-input zw-stage-widget-cooldown");
    select.setAttribute("aria-label", `Stage cooldown for ${name}`);
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Cooldown…";
    select.appendChild(placeholder);
    for (const choice of HOST_COOLDOWN_CHOICES) {
      const option = document.createElement("option");
      option.value = String(choice.ms);
      option.textContent = choice.label;
      select.appendChild(option);
    }
    select.addEventListener("change", () => {
      const value = select.value;
      select.value = "";
      select.blur();
      if (value === "") return;
      const ms = Number(value);
      this.options.stage.setCooldown(playerId, ms);
      this.options.announce(ms > 0 ? `${name} can't take the stage for ${formatCooldown(ms)}.` : `${name}'s stage cooldown is lifted.`);
    });
    return select;
  }

  private renderBody(state: StageSystemState): void {
    const hall = this.options.hall;
    const stage = state.stage;
    const localId = hall.localPlayerId;
    const amHolder = hall.amHolder;
    const isHost = hall.isHost;
    const canModerate = amHolder || isHost;
    this.countdown = null;
    const body = this.content;
    body.replaceChildren();

    if (!state.member) {
      body.appendChild(note("Joining the hall… the stage appears in a moment."));
      return;
    }

    // --- who is on stage
    const now = el("div", "zw-stage-widget-now");
    const pill = el("span", "zw-stage-widget-pill");
    const holderLine = el("div", "zw-stage-widget-holder");
    if (stage.holder === null) {
      pill.textContent = stage.locked ? "LOCKED" : stage.card ? "UP NEXT" : "OPEN";
      pill.dataset.kind = stage.locked ? "locked" : "idle";
      holderLine.textContent = stage.locked ? "Locked — a host hands the stage on" : "Nobody on stage";
    } else if (stage.status === "live") {
      pill.textContent = stage.audio ? "LIVE 🔊" : "LIVE · no sound";
      pill.dataset.kind = "live";
      holderLine.textContent = `${this.name(stage.holder)} ${stage.holder === localId ? "are" : "is"} presenting`;
    } else {
      pill.dataset.kind = "preparing";
      pill.textContent = "STARTING";
      holderLine.textContent = `${this.name(stage.holder)} ${stage.holder === localId ? "are" : "is"} getting ready · `;
      const countdown = el("span", "zw-stage-widget-countdown");
      countdown.textContent = this.secondsLeft();
      countdown.setAttribute("aria-label", "seconds left to start sharing");
      holderLine.appendChild(countdown);
      this.countdown = countdown;
    }
    now.append(pill, holderLine);
    if (stage.card) {
      const card = el("div", "zw-stage-widget-card");
      card.textContent = `${stage.holder === null ? "Up next: " : ""}“${stage.card.title}”`;
      now.appendChild(card);
    }
    body.appendChild(now);
    // The audience vote, right under who is on stage.
    const vote = this.voteRow(state);
    if (vote) body.appendChild(vote);

    // --- your place
    const you = el("div", "zw-stage-widget-you");
    const youText = el("div", "zw-stage-widget-you-text");
    const actions = el("div", "zw-stage-widget-actions");
    // The presenter's blocker (voice off / wallet locked) sits right under "Start sharing", never below the fold.
    const holderNotice = amHolder ? this.voiceHint(state) : null;
    if (state.phase === "preparing") {
      youText.textContent = "You're on stage — Start sharing";
      // Labelled (not disabled) while voice is missing: the notice sits right under it, and the dialog explains again.
      const start = button("Start sharing", holderNotice ? "Start sharing (needs voice first — see below)" : "Start sharing on the big screen", () => void this.options.stage.startSharing(), true);
      start.disabled = state.starting;
      actions.append(start, button("Leave the stage", "Leave the stage", () => this.options.stage.stop()));
    } else if (state.phase === "sharing") {
      youText.textContent = state.sharingSystemAudio
        ? "You're live with your computer's sound (you won't hear the hall)"
        : state.sharingAudio
          ? "You're live on the big screen (with sound)"
          : "You're live on the big screen (no sound)";
      actions.append(button("Stop sharing", "Stop sharing and end your turn", () => this.options.stage.stop(), true));
    } else if (state.phase === "queued") {
      youText.textContent = `You're #${state.queuePosition} in the stage queue`;
      actions.append(button("Leave the queue", "Leave the queue for the stage", () => this.options.stage.cancel()));
    } else if (!this.options.canTalk()) {
      // Presenting rides on full voice, which needs an unlocked wallet: say so before
      // anyone takes a turn they can't use (the hall would wait 45 s for nothing). A guest needs a wallet at all.
      const needs = talkNeeds(this.options.isHolder?.() === true);
      youText.textContent = `Presenting needs voice — voice needs ${needs.need}.`;
      const request = button("Request the stage", `Request the stage (needs ${needs.need})`, () => this.options.stage.requestStage());
      request.disabled = true;
      actions.append(button(needs.open, needs.open === "Open wallet" ? "Open wallet to unlock voice" : "Connect a wallet to talk and present", () => this.options.requestVoice(), true), request);
    } else if (this.options.stage.needsName) {
      // With a name registry the server checks a confirmed name, not the wallet flag — say so up front.
      youText.textContent = "On this server presenting needs a confirmed name.";
      const request = button("Request the stage", "Request the stage (needs a confirmed name)", () => this.options.stage.requestStage());
      request.disabled = true;
      actions.append(button("Confirm a name", "Confirm a name (Profile → Change name)", () => this.options.requestName?.(), true), request);
    } else {
      actions.append(button("Request the stage", "Request the stage (join the queue)", () => this.options.stage.requestStage(), stage.holder === null));
    }
    if (youText.textContent) you.appendChild(youText);
    you.appendChild(actions);
    if (holderNotice) you.appendChild(holderNotice);
    body.appendChild(you);

    // --- queue
    if (stage.queue.length > 0) {
      const section = this.section(`Queue · ${stage.queue.length}`);
      const list = el("ol", "zw-stage-widget-list");
      stage.queue.forEach((playerId) => {
        const row = el("li", "zw-stage-widget-row");
        const name = el("span", "zw-stage-widget-name");
        name.textContent = this.name(playerId);
        row.appendChild(name);
        if (canModerate && playerId !== localId) {
          const verb = amHolder ? "Hand over" : "Grant";
          row.appendChild(button(verb, `${verb} the stage to ${this.name(playerId)}`, () => this.options.stage.handover(playerId), false, true));
        }
        // Host extras: take a squatter out of the queue, or bench them for a while (the name gets its own
        // line, so it is never cut down to an initial by the controls).
        if (isHost && playerId !== localId) {
          row.classList.add("zw-stage-widget-row-host");
          row.append(button("Remove", `Remove ${this.name(playerId)} from the queue`, () => this.options.stage.dequeue(playerId), false, true), this.cooldownMenu(playerId));
        }
        list.appendChild(row);
      });
      section.appendChild(list);
      if (amHolder) section.appendChild(note("Hand over passes your turn to someone in the queue."));
      if (isHost) section.appendChild(note("Remove takes a player out of the queue; a cooldown also keeps them from queueing again."));
      body.appendChild(section);
    }

    // --- raised hands and the floor
    if (hall.hands.length > 0 || hall.floor !== null) {
      const section = this.section(hall.hands.length > 0 ? `Raised hands · ${hall.hands.length}` : "The floor");
      if (hall.floor !== null) {
        const floor = el("div", "zw-stage-widget-row zw-stage-widget-floor");
        const name = el("span", "zw-stage-widget-name");
        const mine = hall.floor === localId;
        name.textContent = `🎙 ${this.name(hall.floor)} ${mine ? "have" : "has"} the floor`;
        name.title = "Heard by everyone in the hall";
        floor.appendChild(name);
        if (mine) floor.appendChild(button("Give up the floor", "Give up the floor (your microphone goes back to your own range)", () => this.options.stage.giveUpFloor(), false, true));
        else if (canModerate) floor.appendChild(button("Take back", "Take back the floor", () => this.options.stage.giveFloor(null), false, true));
        section.appendChild(floor);
        if (mine) section.appendChild(note("Everyone in the hall hears your microphone, whatever range you picked."));
      }
      if (hall.hands.length > 0) {
        const list = el("ol", "zw-stage-widget-list zw-stage-widget-hands");
        for (const playerId of hall.hands) {
          const row = el("li", "zw-stage-widget-row");
          const name = el("span", "zw-stage-widget-name");
          name.textContent = `✋ ${this.name(playerId)}`;
          row.appendChild(name);
          if (canModerate) {
            row.append(
              button("Give the floor", `Give the floor to ${this.name(playerId)}`, () => this.options.stage.giveFloor(playerId), false, true),
              button("Lower", `Lower ${this.name(playerId)}'s hand`, () => this.options.stage.lowerHands(playerId), false, true),
            );
          }
          // A host may grant the stage to a raised hand (raising it is the consent), so a full queue can't block a presenter.
          if (isHost && playerId !== stage.holder) row.append(button("Grant", `Grant the stage to ${this.name(playerId)}`, () => this.options.stage.handover(playerId), false, true));
          list.appendChild(row);
        }
        section.appendChild(list);
        if (canModerate && hall.hands.length > 1) section.appendChild(button("Lower all hands", "Lower all hands", () => this.options.stage.lowerHands("*")));
      }
      body.appendChild(section);
    }

    // --- the presenter's tools
    if (amHolder) {
      const section = this.section("Your turn");
      const row = el("div", "zw-stage-widget-actions");
      row.append(button("Edit card", "Edit card (the speaker card under the screen)", () => this.editCard()));
      section.appendChild(row);
      body.appendChild(section);
    }

    // --- viewer voice hint (the presenter's notice is under "Start sharing")
    const hint = amHolder ? null : this.voiceHint(state);
    if (hint) body.appendChild(hint);

    // --- host tools (last; behind a small toggle for non-hosts)
    const host = this.section(isHost ? "Host tools" : "");
    if (!isHost) {
      const toggle = button(this.hostToolsOpen ? "⋯ Host ▾" : "⋯ Host", this.hostToolsOpen ? "Hide host tools" : "Show host tools", () => {
        this.hostToolsOpen = !this.hostToolsOpen;
        this.refresh();
      }, false, true);
      toggle.classList.add("zw-stage-widget-host-toggle");
      toggle.setAttribute("aria-expanded", String(this.hostToolsOpen));
      host.appendChild(toggle);
      if (this.hostToolsOpen) host.appendChild(button("Unlock host tools", "Unlock host tools with the host key", () => this.unlockHost(), false, true));
    } else {
      // The presenter, with Stop and a cooldown, on their own row.
      if (stage.holder !== null && stage.holder !== localId) {
        const presenter = el("div", "zw-stage-widget-row zw-stage-widget-row-host");
        const name = el("span", "zw-stage-widget-name");
        name.textContent = `🎤 ${this.name(stage.holder)}`;
        presenter.append(name, button("Stop presenter", `Stop presenter: end ${this.name(stage.holder)}'s turn`, () => this.options.stage.stop(), false, true), this.cooldownMenu(stage.holder));
        host.appendChild(presenter);
      }
      const row = el("div", "zw-stage-widget-actions");
      row.append(button(stage.locked ? "Unlock the stage" : "Lock the stage", stage.locked ? "Unlock the stage queue" : "Lock the stage queue", () => this.options.stage.lock(!stage.locked)));
      if (!amHolder) row.append(button(stage.holder === null ? "Up-next card" : "Edit card", stage.holder === null ? "Up-next card: what shows while nobody presents" : "Edit card (the speaker card under the screen)", () => this.editCard()));
      if (hall.hands.length === 1) row.append(button("Lower all hands", "Lower all hands", () => this.options.stage.lowerHands("*")));
      host.appendChild(row);
      if (stage.locked) host.appendChild(note("Locked: the queue waits — grant the stage to someone in it, or to a raised hand. The audience vote is off."));
    }
    body.appendChild(host);
  }

  private voiceHint(state: StageSystemState): HTMLElement | null {
    const voice = this.options.voice;
    const box = el("div", "zw-stage-widget-voice");
    if (this.options.hall.amHolder) {
      // The presenter shares over full voice (an unlocked wallet): say what is still missing.
      const holder = this.options.isHolder?.() === true;
      const notice = stageVoiceNotice({ mode: voice.connectionMode, state: voice.connectionState, canTalk: this.options.canTalk(), needsName: this.options.stage.needsName, holder });
      if (!notice) return null;
      const text = el("span", "");
      text.textContent = notice.text;
      box.appendChild(text);
      const open = talkNeeds(holder).open;
      if (notice.action === "confirm-name") box.appendChild(button("Confirm a name", "Confirm a name (Profile → Change name)", () => this.options.requestName?.(), false, true));
      else if (notice.action) box.appendChild(button(notice.action === "open-wallet" ? open : "Enable voice", notice.action === "open-wallet" ? (holder ? "Open wallet to unlock voice" : "Connect a wallet to talk and present") : "Enable voice to share", () => this.options.requestVoice(), false, true));
      return box;
    }
    if (state.watchBanner) return null; // the ▶ Watch button says it
    if (voice.connectionState === "connecting") {
      box.textContent = "Connecting to the stage…";
      return box;
    }
    if (voice.connectionMode === "listen" && voice.connectionState === "connected") {
      const text = el("span", "");
      text.textContent = "Watch mode — you see and hear the stage; nobody hears you.";
      // The next step in this player's words — a guest connects a wallet, a locked holder unlocks it, an
      // unnamed holder on a registry server confirms a name.
      const needs = talkNeeds(this.options.isHolder?.() === true);
      const talk = !this.options.canTalk()
        ? button(needs.talk, needs.talk, () => this.options.requestVoice(), false, true)
        : this.options.stage.needsName
          ? button("Confirm a name to talk", "Confirm a name to talk (Profile → Change name)", () => this.options.requestName?.(), false, true)
          : button("Enable voice to talk", "Enable voice to talk", () => this.options.requestVoice(), false, true);
      box.append(text, talk);
      return box;
    }
    if (voice.connectionMode === "full" && voice.connectionState === "connected") {
      box.textContent = "🎙 Voice on — the presenter and the floor are heard hall-wide.";
      return box;
    }
    return null;
  }

  private section(title: string): HTMLDivElement {
    const section = el("div", "zw-stage-widget-section");
    if (title) {
      const heading = el("div", "zw-stage-widget-heading");
      heading.textContent = title;
      section.appendChild(heading);
    }
    return section;
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    writeCollapsed(collapsed);
    this.applyCollapsed();
  }

  private applyCollapsed(): void {
    this.root.classList.toggle("collapsed", this.collapsed);
    this.dock.classList.toggle("expanded", !this.collapsed);
    this.body.hidden = this.collapsed;
    this.toggle.textContent = this.collapsed ? "▴" : "▾";
    this.toggle.setAttribute("aria-expanded", String(!this.collapsed));
    this.toggle.setAttribute("aria-label", this.collapsed ? "Expand the stage panel" : "Collapse the stage panel");
  }
}

// ---------------------------------------------------------------- dialogs

interface DialogParts {
  readonly backdrop: HTMLDivElement;
  readonly panel: HTMLFormElement;
  close(): void;
}

/** A small modal form over the game (Esc / backdrop click closes it; Enter and Esc never reach the game or the chat). */
function openDialog(container: HTMLElement, className: string, titleText: string, onClose: () => void): DialogParts {
  const backdrop = el("div", `zw-ui zw-hall-dialog-backdrop visible ${className}`);
  const panel = el("form", "zw-panel zw-hall-dialog");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  const titleId = `zw-hall-dialog-${Math.random().toString(36).slice(2, 8)}`;
  panel.setAttribute("aria-labelledby", titleId);
  panel.noValidate = true;
  const title = el("h3", "zw-hall-dialog-title");
  title.id = titleId;
  title.textContent = titleText;
  panel.appendChild(title);
  backdrop.appendChild(panel);
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    const active = document.activeElement;
    if (active instanceof HTMLElement && backdrop.contains(active)) active.blur();
    onClose();
  };
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  backdrop.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    if (event.key === "Enter" || event.key === "Escape") event.stopPropagation();
  });
  document.exitPointerLock?.();
  container.appendChild(backdrop);
  return { backdrop, panel, close };
}

/** What the key dialog says: the Watch Hall's "Unlock host tools" (default), or Profile → "Moderator sign-in". */
export interface KeyDialogText {
  readonly title: string;
  readonly intro: string;
  readonly label: string;
  /** The field's accessible name (kept "Host key" for the hall dialog, which tests and screen readers know). */
  readonly ariaLabel: string;
  readonly submit: string;
}

export const HOST_KEY_TEXT: KeyDialogText = {
  title: "Unlock host tools",
  intro:
    "Hosts can lock the stage, grant it, stop a presenter, give the floor and set the card. A moderator key works here too. The server checks the key; it is never shown, stored or put in a link.",
  label: "Host or moderator key",
  ariaLabel: "Host key",
  submit: "Unlock",
};

export const MODERATOR_KEY_TEXT: KeyDialogText = {
  title: "Moderator sign-in",
  intro:
    "Moderators can mute, kick and ban, see reports and the moderation log, and use every Watch Hall host tool — for this session only. Everyone sees a small Moderator tag on your nameplate. The server checks the key; it is never shown, stored or put in a link.",
  label: "Moderator key",
  ariaLabel: "Moderator key",
  submit: "Sign in",
};

/**
 * "Unlock host tools" / "Moderator sign-in": the key goes to the server in hall_host_auth (the same field takes a host
 * key or a moderator key) and is cleared from the field at once.
 */
export class KeyDialog {
  private readonly parts: DialogParts;
  private readonly error: HTMLParagraphElement;
  private readonly submit: HTMLButtonElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(container: HTMLElement, options: { readonly send: (key: string) => void; readonly onClose: () => void; readonly text?: KeyDialogText }) {
    const copy = options.text ?? HOST_KEY_TEXT;
    injectStageWidgetStyles();
    this.parts = openDialog(container, "zw-hall-key-backdrop", copy.title, () => {
      if (this.timer) clearTimeout(this.timer);
      options.onClose();
    });
    const text = el("p", "zw-hall-dialog-text");
    text.textContent = copy.intro;
    const label = el("label", "zw-hall-dialog-field");
    const labelText = el("span", "");
    labelText.textContent = copy.label;
    const input = document.createElement("input");
    input.type = "password";
    input.className = "zw-input";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.maxLength = HALL_HOST_KEY_MAX;
    input.setAttribute("aria-label", copy.ariaLabel);
    label.append(labelText, input);
    this.error = el("p", "zw-hall-dialog-error");
    this.error.setAttribute("role", "alert");
    const actions = el("div", "zw-hall-dialog-actions");
    this.submit = el("button", "zw-button zw-button-primary");
    this.submit.type = "submit";
    this.submit.textContent = copy.submit;
    this.submit.setAttribute("aria-label", copy.title);
    const cancel = button("Cancel", "Cancel", () => this.close());
    actions.append(this.submit, cancel);
    this.parts.panel.append(text, label, this.error, actions);
    this.parts.panel.addEventListener("submit", (event) => {
      event.preventDefault();
      // Read and clear in one step: the key lives only in this call, then in the WebSocket frame.
      const key = input.value;
      input.value = "";
      if (!key.trim()) {
        this.fail("Enter the key.");
        return;
      }
      options.send(key);
      this.error.textContent = "Checking…";
      this.error.classList.remove("bad");
      this.submit.disabled = true;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.fail("No answer from the server — try again."), HOST_ANSWER_TIMEOUT_MS);
    });
    input.focus();
  }

  fail(text: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.error.textContent = text;
    this.error.classList.add("bad");
    this.submit.disabled = false;
  }

  close(): void {
    this.parts.close();
  }
}

interface CardDialogOptions {
  readonly draft: CardDraft;
  /** Nobody holds the stage: a host edits the "up next" card. */
  readonly idle: boolean;
  readonly canPickFromCatalogue: boolean;
  readonly hasCard: boolean;
  readonly save: (card: Parameters<StageSystem["setCard"]>[0]) => boolean;
  readonly clear: () => void;
  readonly pick: () => void;
  readonly onClose: () => void;
}

/** "Edit card": title, speaker, project and up to four links, validated before anything is sent. */
class CardDialog {
  private readonly parts: DialogParts;
  private readonly errors = new Map<string, HTMLElement>();

  constructor(container: HTMLElement, options: CardDialogOptions) {
    this.parts = openDialog(container, "zw-hall-card-backdrop", options.idle ? "Up-next card" : "Speaker card", options.onClose);
    const panel = this.parts.panel;
    panel.classList.add("zw-hall-card-form");
    const intro = el("p", "zw-hall-dialog-text");
    intro.textContent = options.idle
      ? "Shown under the big screen and on the screen while nobody presents; it stays when the next turn starts. Everyone in the hall sees it."
      : "Shown under the big screen and in the speaker card for everyone in the hall. It is cleared when your turn ends.";
    panel.appendChild(intro);

    const title = this.field("title", "Title", options.draft.title, HALL_CARD_TITLE_MAX, "What's on the big screen");
    const speaker = this.field("speaker", "Speaker", options.draft.speaker, HALL_CARD_NAME_MAX, "Who is talking (optional)");
    const project = this.field("project", "Project", options.draft.project, HALL_CARD_NAME_MAX, "Project (optional)");

    const linksBox = el("fieldset", "zw-hall-card-links");
    const legend = el("legend", "");
    legend.textContent = `Links (up to ${HALL_CARD_LINKS_MAX})`;
    linksBox.appendChild(legend);
    const rows: { kind: HTMLSelectElement; url: HTMLInputElement }[] = [];
    for (let i = 0; i < HALL_CARD_LINKS_MAX; i++) {
      const existing = options.draft.links[i];
      const row = el("div", "zw-hall-card-link");
      const kind = document.createElement("select");
      kind.className = "zw-input";
      kind.setAttribute("aria-label", `Link ${i + 1} kind`);
      for (const value of HALL_LINK_KINDS) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = linkKindLabel(value);
        kind.appendChild(option);
      }
      kind.value = existing?.kind ?? "web";
      let kindTouched = existing !== undefined;
      kind.addEventListener("change", () => {
        kindTouched = true;
      });
      const url = document.createElement("input");
      url.className = "zw-input";
      url.type = "url";
      url.inputMode = "url";
      url.spellcheck = false;
      url.autocomplete = "off";
      url.placeholder = i === 0 ? "https://github.com/…" : "https://…";
      url.value = existing?.url ?? "";
      url.setAttribute("aria-label", `Link ${i + 1} URL`);
      url.addEventListener("input", () => {
        if (!kindTouched) kind.value = suggestLinkKind(url.value);
      });
      const error = el("div", "zw-hall-dialog-error");
      error.setAttribute("role", "alert");
      this.errors.set(`link${i}`, error);
      row.append(kind, url, error);
      linksBox.appendChild(row);
      rows.push({ kind, url });
    }
    const linksError = el("div", "zw-hall-dialog-error");
    linksError.setAttribute("role", "alert");
    this.errors.set("links", linksError);
    const hosts = el("p", "zw-hall-dialog-note");
    hosts.textContent = `https only, on: ${HALL_CARD_LINK_HOSTS.filter((host) => !host.startsWith("www.")).join(", ")}.`;
    linksBox.append(linksError, hosts);
    panel.appendChild(linksBox);

    const general = el("p", "zw-hall-dialog-error");
    general.setAttribute("role", "alert");
    this.errors.set("general", general);
    panel.appendChild(general);

    const actions = el("div", "zw-hall-dialog-actions");
    const save = el("button", "zw-button zw-button-primary");
    save.type = "submit";
    save.textContent = "Save card";
    save.setAttribute("aria-label", "Save the card");
    actions.appendChild(save);
    if (options.canPickFromCatalogue) {
      actions.appendChild(
        button("Pick from catalogue", "Pick from catalogue (the Watch panel)", () => {
          this.close();
          options.pick();
        }),
      );
    }
    if (options.hasCard) {
      actions.appendChild(
        button("Clear card", "Clear card", () => {
          options.clear();
          this.close();
        }),
      );
    }
    actions.appendChild(button("Cancel", "Cancel", () => this.close()));
    panel.appendChild(actions);

    panel.addEventListener("submit", (event) => {
      event.preventDefault();
      const draft: CardDraft = {
        title: title.value,
        speaker: speaker.value,
        project: project.value,
        links: rows.map((row) => ({ kind: row.kind.value as HallLinkKind, url: row.url.value })),
        ...(options.draft.videoId ? { videoId: options.draft.videoId } : {}),
        ...(options.draft.eventId ? { eventId: options.draft.eventId } : {}),
      };
      const result = parseCardDraft(draft);
      if (!result.ok) {
        this.showErrors(result.errors);
        return;
      }
      if (!options.save(result.card)) {
        this.showErrors({ general: "The card is too big — shorten the text or remove a link." });
        return;
      }
      this.close();
    });
    title.focus();
  }

  close(): void {
    this.parts.close();
  }

  private field(id: string, labelText: string, value: string, max: number, placeholder: string): HTMLInputElement {
    const label = el("label", "zw-hall-dialog-field");
    const text = el("span", "");
    text.textContent = labelText;
    const input = document.createElement("input");
    input.className = "zw-input";
    input.type = "text";
    input.name = `card-${id}`;
    input.autocomplete = "off";
    input.maxLength = max * 2; // UTF-16 units; the code-point limit is checked on save
    input.value = value;
    input.placeholder = placeholder;
    input.setAttribute("aria-label", labelText);
    const error = el("div", "zw-hall-dialog-error");
    error.setAttribute("role", "alert");
    this.errors.set(id, error);
    label.append(text, input, error);
    this.parts.panel.appendChild(label);
    return input;
  }

  private showErrors(errors: CardFormErrors): void {
    for (const [id, element] of this.errors) element.textContent = errors[id] ?? "";
  }
}

// ---------------------------------------------------------------- helpers

/** 45 → "0:45". */
function formatSeconds(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Private mode / blocked storage: the panel just starts expanded next time.
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

function button(text: string, label: string, onClick: () => void, primary = false, small = false): HTMLButtonElement {
  const b = el("button", `zw-button${primary ? " zw-button-primary" : ""}${small ? " zw-stage-widget-small" : ""}`);
  b.type = "button";
  b.textContent = text;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", (event) => {
    event.preventDefault();
    b.blur(); // E / Esc / WASD belong to the world again
    onClick();
  });
  return b;
}

function note(text: string): HTMLParagraphElement {
  const p = el("p", "zw-stage-widget-note");
  p.textContent = text;
  return p;
}

let stylesInjected = false;
function injectStageWidgetStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
/* The right column under the minimap cluster (it ends near 470 px, like WorldHud's featured panel), above the nickname box. */
.zw-hall-dock { position: absolute; right: 12px; bottom: 58px; top: min(476px, calc(100% - 258px)); width: 304px; display: flex; flex-direction: column; justify-content: flex-end; gap: 8px; pointer-events: none; z-index: 6; }
.zw-hall-dock > * { pointer-events: auto; }
.zw-hall-dock-slot { display: contents; }
.zw-stage-widget { position: relative; flex: 0 1 auto; min-height: 0; max-height: 100%; display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; backdrop-filter: none;
  background: linear-gradient(180deg, rgba(62,40,22,0.95), rgba(32,21,12,0.95)); border: 2px solid rgba(166,112,52,0.92); box-shadow: 0 8px 24px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(240,195,94,0.16); font-size: 12px; }
.zw-stage-widget[hidden], .zw-stage-widget [hidden] { display: none !important; }
.zw-stage-widget-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.zw-stage-widget-title { font: 700 15px Georgia, "Times New Roman", serif; color: #f4e3c1; white-space: nowrap; }
.zw-stage-widget-status { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #f0c35e; font-weight: 700; }
.zw-stage-widget-toggle { all: unset; cursor: pointer; padding: 0 6px; border-radius: 6px; color: #f4e3c1; font-size: 14px; line-height: 22px; }
.zw-stage-widget-toggle:hover, .zw-stage-widget-toggle:focus-visible { background: rgba(240,195,94,0.2); }
.zw-stage-widget-body { display: flex; flex-direction: column; gap: 8px; overflow-y: auto; min-height: 0; padding-right: 2px; scrollbar-width: thin; scrollbar-color: rgba(240,195,94,0.55) transparent; scrollbar-gutter: stable; }
.zw-stage-widget-content { display: flex; flex-direction: column; gap: 8px; }
.zw-button.zw-stage-widget-host-toggle { align-self: flex-start; background: transparent; border-color: transparent; color: #b9ae9c; }
.zw-stage-widget-now { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; padding: 6px 8px; border-radius: 8px; background: rgba(10,6,2,0.35); }
.zw-stage-widget-pill { padding: 2px 8px; border-radius: 6px; font: 800 11px "Segoe UI", system-ui, sans-serif; letter-spacing: 0.04em; background: #5d6b8a; color: #fff; }
.zw-stage-widget-pill[data-kind="live"] { background: #d8323a; }
.zw-stage-widget-pill[data-kind="preparing"] { background: #e39a2d; color: #24170b; }
.zw-stage-widget-pill[data-kind="locked"] { background: #6b5a48; }
.zw-stage-widget-holder { color: #f1e9dd; font-weight: 600; }
.zw-stage-widget-countdown { color: #ffd36a; font-variant-numeric: tabular-nums; }
.zw-stage-widget-card { flex-basis: 100%; color: #e6d3b0; font-style: italic; overflow-wrap: anywhere; }
.zw-stage-widget-you { display: flex; flex-direction: column; gap: 6px; }
.zw-stage-widget-you-text { font-weight: 700; color: #f6deb0; }
.zw-stage-widget-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.zw-stage-widget-actions .zw-button { padding: 5px 10px; }
.zw-stage-widget-section { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid rgba(240,195,94,0.18); padding-top: 6px; }
.zw-stage-widget-heading { font: 700 11px "Segoe UI", system-ui, sans-serif; color: #d9b77a; letter-spacing: 0.06em; text-transform: uppercase; }
.zw-stage-widget-list { margin: 0; padding: 0 0 0 18px; display: flex; flex-direction: column; gap: 3px; color: #f1e9dd; }
.zw-stage-widget-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.zw-stage-widget-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zw-stage-widget-floor .zw-stage-widget-name { color: #9be8b4; font-weight: 600; }
.zw-button.zw-stage-widget-small { padding: 2px 8px; font-size: 11px; }
.zw-stage-widget-vote { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; padding: 5px 8px; border-radius: 8px; background: rgba(216,50,58,0.12); border: 1px solid rgba(216,50,58,0.35); }
.zw-stage-widget-vote-count { flex: 1; min-width: 0; color: #ffd9c8; font-weight: 700; font-variant-numeric: tabular-nums; }
.zw-stage-widget-vote .zw-stage-widget-note { flex-basis: 100%; }
.zw-input.zw-stage-widget-cooldown { width: auto; margin: 0; padding: 1px 4px; font-size: 11px; height: 22px; }
.zw-stage-widget-row-host .zw-stage-widget-name { flex-basis: 100%; }
.zw-stage-widget-note { margin: 0; color: #b9ae9c; font-size: 11px; line-height: 1.4; }
.zw-stage-widget-voice { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 6px 8px; border-radius: 8px; background: rgba(240,195,94,0.1); color: #e6dccb; line-height: 1.4; }
.zw-stage-widget-volume { display: flex; align-items: center; gap: 8px; border-top: 1px solid rgba(240,195,94,0.18); padding-top: 6px; }
.zw-stage-widget-volume-label { flex: 1; display: flex; align-items: center; gap: 8px; color: #e6dccb; white-space: nowrap; }
.zw-stage-widget-volume-label input { flex: 1; min-width: 0; accent-color: #d9a441; }
.zw-stage-widget-volume-value { width: 38px; text-align: right; color: #f4e3c1; font-variant-numeric: tabular-nums; }
.zw-stage-watch { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 7px 12px; cursor: pointer; border-radius: 8px; background: rgba(20,12,4,0.55); border: 1px solid rgba(244,183,40,0.75); box-shadow: 0 0 14px rgba(244,183,40,0.22); font-family: inherit; }
.zw-stage-watch:hover:not(:disabled) { background: rgba(60,40,16,0.85); }
.zw-stage-watch:disabled { opacity: 0.6; cursor: progress; }
.zw-stage-watch-title { font: 700 13px "Segoe UI", system-ui, sans-serif; color: #f6deb0; }
.zw-stage-watch-note { font: 500 11px "Segoe UI", system-ui, sans-serif; color: #b9ae9c; }
.zw-hall-dialog-backdrop { position: absolute; inset: 0; z-index: 22; display: flex; align-items: center; justify-content: center; background: rgba(4,5,10,0.6); }
.zw-hall-dialog { width: min(460px, 92vw); max-height: 88vh; overflow-y: auto; padding: 16px 18px; display: flex; flex-direction: column; gap: 8px; backdrop-filter: none;
  background: linear-gradient(180deg, rgba(58,38,22,0.97), rgba(30,20,12,0.97)); border: 2px solid rgba(166,112,52,0.92); }
.zw-hall-dialog-title { margin: 0; font: 700 18px Georgia, serif; color: #f4e3c1; }
.zw-hall-dialog-text { margin: 0; font-size: 13px; line-height: 1.5; color: #e6dccb; }
.zw-hall-dialog-note { margin: 4px 0 0; font-size: 11px; color: #b9ae9c; line-height: 1.4; }
.zw-hall-dialog-field { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: #d9b77a; font-weight: 600; }
.zw-hall-dialog-field .zw-input { margin: 0; }
.zw-hall-dialog-error { min-height: 0; font-size: 12px; color: #ffb38a; }
.zw-hall-dialog-error:empty { display: none; }
.zw-hall-dialog-error.bad { color: #ff8f7a; }
.zw-hall-card-links { border: 1px solid rgba(240,195,94,0.22); border-radius: 8px; padding: 6px 8px 8px; margin: 0; display: flex; flex-direction: column; gap: 6px; }
.zw-hall-card-links legend { padding: 0 4px; font-size: 12px; color: #d9b77a; font-weight: 600; }
.zw-hall-card-link { display: grid; grid-template-columns: 96px 1fr; gap: 6px; }
.zw-hall-card-link .zw-input { margin: 0; }
.zw-hall-card-link .zw-hall-dialog-error { grid-column: 1 / -1; }
.zw-hall-dialog-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
@media (max-width: 720px) { .zw-hall-dock { width: min(304px, calc(100vw - 24px)); } }
/* Viewports up to 760 px tall: the minimap shrinks to 240 px (WorldHud), so the column starts right under it and
   never overlaps it (the cluster ends near 316 px). */
@media (max-height: 760px) {
  .zw-hall-dock { top: 324px; }
}
/* Short viewports (laptops): the "Now on stage" chip and the long notes give their height to the panel body. */
@media (max-height: 820px) {
  .zw-hall-dock.expanded .zw-now-on-stage { display: none; }
  .zw-stage-watch-note, .zw-stage-widget-content .zw-stage-widget-note { display: none; }
  .zw-stage-watch { padding: 5px 10px; }
}
`;
  document.head.appendChild(style);
}
