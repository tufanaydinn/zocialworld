import * as THREE from "three";
import { HALL_STAGE_LEAVE_GRACE_MS, HALL_STAGE_PREPARE_TIMEOUT_MS, MAX_MESSAGE_BYTES, type HallCard, type HallClientMessage, type HallStageState } from "@project/shared";
import type { Interactable } from "../interaction/Interactable.ts";
import type { HallScreenHandle } from "../world/hall/contract.ts";
import type { VoiceConnectionState } from "../voice/VoiceClient.ts";
import type { VoiceSession } from "../voice/VoiceSession.ts";
import { nextInsideHall } from "../voice/hallAudio.ts";
import { browserVoiceEnvironment, classifyVoiceFailure, voiceFailureMessage } from "../voice/voiceErrors.ts";
import { STAGE_SHARE_MODES, readShareMode, writeShareMode, type StageShareMode } from "../voice/stageShareQuality.ts";
import { injectUiStyles } from "../ui/styles.ts";
import { ZCASH_NETWORK } from "../zcash/core/wallet-types.ts";
import type { HallStore, HallStoreEvent } from "./HallStore.ts";
import { validateHallCard } from "./hallCard.ts";
import {
  localShareAction,
  localStagePhase,
  stageErrorText,
  stageScreenMessage,
  stageVoiceNotice,
  talkNeeds,
  watchBannerVisible,
  type LocalStagePhase,
  type ScreenMessage,
} from "./stageState.ts";

/**
 * The Watch Hall stage on the client (docs/architecture/WATCH_HALL.md, ADR-014
 * §§ 3–5).
 *
 *  - **Screen:** the big screen (`world.watchHall.screen`) shows the server-named holder's video
 *    (VoiceSession subscribes to nobody else), the holder's own local preview, or an idle face
 *    from the stage state. A LIVE pill while the stage is live. A full-size viewer overlay opens
 *    from the podium or the `wh-screen` interactable in front of the stage.
 *  - **Holder flow:** when the server makes this player the holder, the stage widget
 *    (StageWidget.ts) offers "Start sharing". The click opens a confirm dialog (everyone in the
 *    hall sees AND hears it; never show a seed; optional computer sound), then the browser picker.
 *    Live and ended come from LiveKit events (`hall_stage_live`), never from the game
 *    loop, which pauses when the presenter switches to the tab they share. Losing the holder role
 *    stops the share.
 *  - **Watch mode:** inside the hall with voice off, the widget's "▶ Watch the stage (audio +
 *    video)" calls `startWatching()`: a listen-only connection (no wallet). That is
 *    also (ADR-015) a guest's general voice mode, so it keeps hearing nearby voices after
 *    leaving the hall (only the stage stops).
 *  - **API** for the stage widget: thin wrappers over HallStore + NetworkClient.sendHall, and
 *    `state` / `subscribe` for everything it shows. The idle face's "Up next: …" comes from the
 *    hall boards (`setUpNext`), so this class stays the only writer of the screen's idle text.
 *
 * Nothing here logs chat, reactions, keys or tracks; hall state is never persisted.
 */

/** What StageSystem needs from VoiceSession. */
export type StageVoice = Pick<
  VoiceSession,
  "connectionState" | "connectionMode" | "startScreenShare" | "stopScreenShare" | "localScreenTrack" | "hasLocalScreenAudio" | "setIncomingMuted" | "disableVoice"
>;

export interface StageSystemOptions {
  readonly container: HTMLElement;
  /** The hall's big screen (null in ?world=prototype). */
  readonly screen: HallScreenHandle | null;
  readonly hall: HallStore;
  readonly voice: StageVoice;
  /** NetworkClient.sendHall. */
  readonly send: (message: HallClientMessage) => void;
  readonly register: (interactable: Interactable) => void;
  readonly unregister: (id: string) => void;
  /** A remote player's nickname from presence. */
  readonly nicknameOf: (playerId: string) => string | undefined;
  readonly isBlocked: (playerId: string) => boolean;
  readonly announce: (text: string) => void;
  /** Starts watch mode from a click (listen-only voice). Rejects when it failed — after telling the player why (App's voice error card). */
  readonly enableListening: () => Promise<void>;
  /** From a click in the share dialog: enable full voice if the wallet allows it, else open the wallet. */
  readonly requestVoice: () => void;
  /** Whether the wallet allows talking (participation capability canVoice). */
  readonly canTalk: () => boolean;
  /** A wallet holder (a locked wallet) rather than a guest — "unlock your wallet" vs "connect a wallet". */
  readonly isHolder?: () => boolean;
  /**
   * Whether the server runs a name registry (then presenting, the floor, voting and talking need a
   * confirmed name — the server checks) and whether this player has one. Default: no registry.
   */
  readonly identity?: () => { readonly namesRequired: boolean; readonly hasName: boolean };
  /** From a click: open the name confirmation (Profile → Change name). */
  readonly requestName?: () => void;
  /**
   * Called right before a share with the computer's sound starts (ADR-014 § 4): App closes the
   * personal YouTube player there, since system audio would capture it.
   */
  readonly beforeComputerSound?: () => void;
}

/** The local share, while LiveKit publishes it. */
interface LocalShare {
  audio: boolean;
  systemAudio: boolean;
}

export interface StageSystemState {
  readonly member: boolean;
  readonly inside: boolean;
  readonly stage: Readonly<HallStageState>;
  readonly phase: LocalStagePhase;
  /** 1-based place in the queue, 0 when not queued. */
  readonly queuePosition: number;
  readonly sharing: boolean;
  readonly sharingAudio: boolean;
  readonly sharingSystemAudio: boolean;
  /** The browser picker / share start is in progress (disable "Start sharing"). */
  readonly starting: boolean;
  /** A video (remote or the local preview) is on the big screen. */
  readonly showingVideo: boolean;
  /** The big screen's idle face (null while a video shows). */
  readonly screenMessage: ScreenMessage | null;
  readonly viewerOpen: boolean;
  /** Offer "▶ Watch the stage (audio + video)": inside the hall with voice off. */
  readonly watchBanner: boolean;
  /** A watch-mode connection is being started. */
  readonly watchStarting: boolean;
}

export type StageSystemListener = (state: StageSystemState) => void;

const SCREEN_INTERACTABLE_ID = "wh-screen";
const NO_AUDIO_HINT = "You're live without sound. Tick 'Share tab audio' (or 'Share system audio') in the browser picker to share sound.";
const STAGE_ERROR_OPS = new Set(["stage", "card", "floor", "lock", "vote"]);
/** Frames between periodic refreshes (nicknames can change without a hall event). */
const REFRESH_EVERY_FRAMES = 30;

interface ShownVideo {
  readonly track: MediaStreamTrack;
  /** playerId, or "local" for the holder's own preview. */
  readonly owner: string;
  readonly video: HTMLVideoElement;
  readonly texture: THREE.VideoTexture;
  frames: number;
}

export class StageSystem {
  private readonly options: StageSystemOptions;
  private readonly listeners = new Set<StageSystemListener>();
  private readonly unsubscribeHall: () => void;
  private insideFlag = false;
  private share: LocalShare | null = null;
  private starting = false;
  private remote: { playerId: string; track: MediaStreamTrack } | null = null;
  private shown: ShownVideo | null = null;
  private screenMessage: ScreenMessage | null = null;
  private dialog: { close: () => void; refresh: () => void } | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPhase: LocalStagePhase = "none";
  private lastQueuePosition = 0;
  private announcedLive: string | null = null;
  /** Whether the local player had the floor at the last hall change (announced on change). */
  private hadFloor = false;
  private screenInteractable = false;
  private dirty = true;
  private frame = 0;
  private watchStarting = false;
  /** "Zcash Arborist Call · Today 15:00" from the hall boards, for the idle face. */
  private upNext: string | null = null;

  private readonly viewer: HTMLDivElement;
  private readonly viewerVideo: HTMLVideoElement;
  private readonly viewerTitle: HTMLDivElement;
  private readonly screenSpot: THREE.Vector3 | null;

  constructor(options: StageSystemOptions) {
    injectUiStyles();
    injectStageStyles();
    this.options = options;

    // Full-size viewer (muted: the stage audio already plays through the hall's stage channel).
    this.viewer = document.createElement("div");
    this.viewer.className = "zw-ui zw-screen-viewer";
    const panel = document.createElement("div");
    panel.className = "zw-panel zw-screen-viewer-panel";
    this.viewerTitle = document.createElement("div");
    this.viewerTitle.className = "zw-screen-viewer-title";
    this.viewerVideo = document.createElement("video");
    this.viewerVideo.muted = true;
    this.viewerVideo.playsInline = true;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "zw-button";
    close.textContent = "Close (Esc)";
    close.addEventListener("click", () => this.closeViewer());
    panel.append(this.viewerTitle, this.viewerVideo, close);
    this.viewer.appendChild(panel);
    this.viewer.addEventListener("click", (event) => {
      if (event.target === this.viewer) this.closeViewer();
    });
    options.container.appendChild(this.viewer);

    // The wh-screen interactable stands in the pit, in front of the stage (registered only while a video shows).
    this.screenSpot = options.screen ? new THREE.Vector3(options.screen.center.x, 0, options.screen.center.z).addScaledVector(options.screen.normal, 6.4) : null;

    this.unsubscribeHall = options.hall.subscribe((event) => this.onHallEvent(event));
    this.refresh();
  }

  // ------------------------------------------------------------------ state

  /** Whether the local player is inside the hall (2 m exit hysteresis, like the server). VoiceSession's stage provider reads it. */
  get insideHall(): boolean {
    return this.insideFlag;
  }

  get isViewerOpen(): boolean {
    return this.viewer.classList.contains("visible");
  }

  /** Whether the share confirm dialog is open (App's Esc chain closes it). */
  get isDialogOpen(): boolean {
    return this.dialog !== null;
  }

  /** Cancels the share confirm dialog, if open. */
  closeDialog(): void {
    this.dialog?.close();
  }

  get state(): StageSystemState {
    const hall = this.options.hall;
    const voice = this.options.voice;
    const localId = hall.localPlayerId;
    return {
      member: hall.member,
      inside: this.insideFlag,
      stage: hall.stage,
      phase: localStagePhase({ member: hall.member, stage: hall.stage, localPlayerId: localId, sharing: this.share !== null }),
      queuePosition: localId ? hall.queuePosition(localId) : 0,
      sharing: this.share !== null,
      sharingAudio: this.share?.audio ?? false,
      sharingSystemAudio: this.share?.systemAudio ?? false,
      starting: this.starting,
      showingVideo: this.shown !== null,
      screenMessage: this.screenMessage,
      viewerOpen: this.isViewerOpen,
      watchBanner: watchBannerVisible({ inside: this.insideFlag, mode: voice.connectionMode, state: voice.connectionState }),
      watchStarting: this.watchStarting,
    };
  }

  subscribe(listener: StageSystemListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Debug/e2e: the stage video on the big screen — its size and how many frames were presented so far. */
  videoStats(): { owner: string; width: number; height: number; frames: number } | null {
    if (!this.shown) return null;
    return { owner: this.shown.owner, width: this.shown.video.videoWidth, height: this.shown.video.videoHeight, frames: this.shown.frames };
  }

  // ------------------------------------------------------------------ API for the stage widget

  /**
   * Join the stage queue (the server grants it at once when the stage is free). Presenting needs
   * full voice, which needs an unlocked wallet (ADR-014 § 2): without it the turn would
   * only time out while the hall waits, so the request is not sent and the wallet opens instead.
   */
  requestStage(): void {
    if (!this.options.canTalk()) {
      const needs = talkNeeds(this.options.isHolder?.() === true);
      this.options.announce(`To present, you need voice, and voice needs ${needs.need}. ${needs.step}, then request the stage.`);
      this.options.requestVoice();
      return;
    }
    if (this.needsName) {
      // The server would refuse (identity_required) — say why. The name step opens from the Stage panel's
      // "Confirm a name" button (a click), never from here: this also runs on the podium's E keydown, and a modal opened
      // in a keydown swallows that key's keyup (OnboardingFlow stops it), leaving E stuck "pressed" for the game.
      this.options.announce("On this server presenting needs a confirmed name — press “Confirm a name” in the Stage panel, then request the stage.");
      return;
    }
    this.options.send({ type: "hall_stage_request" });
  }

  /** The server runs a name registry and this player has no confirmed name (presenting, talking and voting are refused). */
  get needsName(): boolean {
    const identity = this.options.identity?.();
    return identity !== undefined && identity.namesRequired && !identity.hasName;
  }

  /** Vote to end the live share, or take the vote back. The server counts it (and never says who voted). */
  vote(end: boolean): void {
    this.options.send({ type: "hall_stage_vote", end });
  }

  /** Host: take a player out of the stage queue (not a ban — they may queue again). */
  dequeue(playerId: string): void {
    this.options.send({ type: "hall_stage_dequeue", playerId });
  }

  /** Host: keep a player off the stage for `ms` (0 lifts it); also ends their turn and drops their queue place. */
  setCooldown(playerId: string, ms: number): void {
    this.options.send({ type: "hall_stage_cooldown", playerId, ms });
  }

  /** Leave the stage queue. */
  cancel(): void {
    this.options.send({ type: "hall_stage_cancel" });
  }

  /**
   * End the turn. While sharing, stopping the share is enough: LiveKit's unpublish event reports
   * `hall_stage_live{false}` and the server ends the turn. Otherwise (preparing, a share that
   * already ended without an unpublish event, or a host force-stopping the holder)
   * `hall_stage_stop`, so the stage can never stay stuck "live".
   */
  stop(): void {
    const hall = this.options.hall;
    if (this.share && hall.amHolder && this.options.voice.localScreenTrack) {
      this.stopLocalShare();
      return;
    }
    if (this.share) {
      // A stale share (no publication left, so no unpublish event will come): clear it. Its
      // live:false ends a live turn; otherwise (still preparing, or a host stopping someone
      // else) hall_stage_stop does.
      const endsTurn = hall.amHolder && hall.stage.status === "live";
      this.localShareEnded();
      if (endsTurn) return;
    }
    this.options.send({ type: "hall_stage_stop" });
  }

  /** The floor member gives the floor up (their microphone goes back to their own range). */
  giveUpFloor(): void {
    this.options.send({ type: "hall_floor", playerId: null });
  }

  /** Hand the stage to a queued player (holder or host). Losing the role stops the local share. */
  handover(playerId: string): void {
    this.options.send({ type: "hall_stage_handover", to: playerId });
  }

  /** The holder's click: confirm dialog, then the browser picker. Call only from a user gesture. */
  async startSharing(): Promise<void> {
    const hall = this.options.hall;
    if (!hall.amHolder) {
      this.options.announce("You're not on stage — request it at the podium.");
      return;
    }
    if (this.share || this.starting || this.dialog) return;
    const choice = await this.confirm();
    if (choice) await this.beginShare(choice.systemAudio, choice.mode);
  }

  /** Set (or clear) the speaker / project card. Re-validated here like the server does; false when the card is invalid or too big. */
  setCard(card: HallCard | null): boolean {
    const clean = card === null ? null : validateHallCard(card);
    if (card !== null && clean === null) return false;
    const message: HallClientMessage = { type: "hall_stage_card", card: clean };
    if (new TextEncoder().encode(JSON.stringify(message)).length > MAX_MESSAGE_BYTES) return false;
    this.options.send(message);
    return true;
  }

  /** Give one member (who raised a hand — the server checks) a hall-wide microphone, or take it back (null). */
  giveFloor(playerId: string | null): void {
    this.options.send({ type: "hall_floor", playerId });
  }

  /** Lower one raised hand, or all of them ("*"). */
  lowerHands(playerId: string | "*"): void {
    this.options.send({ type: "hall_hand_lower", playerId });
  }

  /** Host: lock or unlock the stage queue. */
  lock(locked: boolean): void {
    this.options.send({ type: "hall_stage_lock", locked });
  }

  /** How this player gets to talk, after watch mode starts. */
  private watchTalkHint(): string {
    if (!this.options.canTalk()) {
      return this.options.isHolder?.() === true ? "To talk, unlock your wallet, then press Enable Voice (bottom-left)." : "To talk, connect a wallet (Profile) — guests can listen and chat.";
    }
    if (this.needsName) return "To talk, confirm a name first (Profile → Change name), then press Enable Voice (bottom-left).";
    return "To talk, press Enable Voice (bottom-left).";
  }

  /** "▶ Watch the stage (audio + video)": starts watch mode (a listen-only connection, no wallet). Call only from a click (it resumes audio). */
  startWatching(): Promise<void> {
    if (this.watchStarting) return Promise.resolve();
    this.watchStarting = true;
    this.refresh();
    return this.options
      .enableListening()
      .then(() => this.options.announce(`Watch mode is on: you see and hear the stage and the presenter. ${this.watchTalkHint()}`))
      // enableListening already said exactly why (no voice server, unreachable, network…).
      .catch(() => undefined)
      .finally(() => {
        this.watchStarting = false;
        this.refresh();
      });
  }

  /** The next scheduled event ("Zcash Arborist Call · Today 15:00") for the idle face, or null. From the hall boards (≤ 1 Hz). */
  setUpNext(text: string | null): void {
    if (text === this.upNext) return;
    this.upNext = text;
    this.refresh();
  }

  /** The podium (`wh-podium`): holder → share; someone live → viewer; queued → position; else request the stage. */
  podium(): void {
    const hall = this.options.hall;
    if (!hall.member) {
      this.options.announce("Step inside the Watch Hall to use the stage.");
      return;
    }
    if (hall.amHolder) {
      if (this.share) this.options.announce("You're live — stop with “Stop sharing” in the Stage panel or the browser's own button.");
      else void this.startSharing();
      return;
    }
    if (this.shown && hall.stage.status === "live") {
      this.openViewer();
      return;
    }
    if (hall.amQueued) {
      this.options.announce(`You're #${hall.queuePosition(hall.localPlayerId ?? "")} in the stage queue.`);
      return;
    }
    this.requestStage();
  }

  /** Opens the full-size viewer of the video on the big screen. Returns false when nothing shows. */
  openViewer(): boolean {
    const shown = this.shown;
    if (!shown) return false;
    const holder = this.options.hall.stage.holder;
    const name = shown.owner === "local" ? "You are" : `${(holder && this.options.nicknameOf(holder)) ?? "Someone"} is`;
    this.viewerTitle.textContent = `${name} on the big screen`;
    this.viewerVideo.srcObject = shown.video.srcObject;
    void this.viewerVideo.play().catch(() => undefined);
    document.exitPointerLock();
    this.viewer.classList.add("visible");
    this.emit();
    return true;
  }

  closeViewer(): void {
    if (!this.isViewerOpen) return;
    this.viewer.classList.remove("visible");
    this.viewerVideo.srcObject = null;
    this.emit();
  }

  // ------------------------------------------------------------------ inputs from App / VoiceSession

  /** Per frame: the inside-hall flag (with hysteresis), the screen and the HUD. */
  update(position: THREE.Vector3): void {
    const inside = nextInsideHall(this.insideFlag, position.x, position.z);
    if (inside !== this.insideFlag) {
      this.insideFlag = inside;
      this.dirty = true;
    }
    if (this.dirty || ++this.frame >= REFRESH_EVERY_FRAMES) {
      this.frame = 0;
      this.refresh();
    }
  }

  /** VoiceSession → the holder's stage video arrived (or went). */
  setStageTrack(playerId: string, track: MediaStreamTrack | null): void {
    if (track) this.remote = { playerId, track };
    else if (this.remote?.playerId === playerId) this.remote = null;
    this.refresh();
  }

  /** VoiceSession → the local share ended (LiveKit: browser "Stop sharing", track end, unpublish). */
  localShareEnded(): void {
    const share = this.share;
    if (!share) return;
    this.share = null;
    this.clearGraceTimer();
    if (share.systemAudio) this.options.voice.setIncomingMuted(false);
    const hall = this.options.hall;
    if (hall.member && hall.amHolder) this.options.send({ type: "hall_stage_live", live: false, audio: false });
    this.options.announce("You stopped sharing — your turn on the stage is over.");
    this.refresh();
  }

  /** VoiceSession → the local share's audio ended while the video goes on. */
  localScreenAudioEnded(): void {
    const share = this.share;
    if (!share || !share.audio) return;
    if (share.systemAudio) this.options.voice.setIncomingMuted(false);
    share.audio = false;
    share.systemAudio = false;
    if (this.options.hall.amHolder) this.options.send({ type: "hall_stage_live", live: true, audio: false });
    this.options.announce("Your share's sound stopped.");
    this.refresh();
  }

  /** App → the voice connection state or mode changed. */
  onVoiceChange(state: VoiceConnectionState): void {
    // The room went away, and LiveKit stopped the capture with it.
    if (this.share && state !== "connected") this.localShareEnded();
    this.dialog?.refresh();
    this.refresh();
  }

  dispose(): void {
    this.unsubscribeHall();
    this.clearGraceTimer();
    this.dialog?.close();
    this.detach();
    if (this.screenInteractable) this.options.unregister(SCREEN_INTERACTABLE_ID);
    this.viewer.remove();
    this.listeners.clear();
  }

  // ------------------------------------------------------------------ hall events

  private onHallEvent(event: HallStoreEvent): void {
    if (event.type === "change") {
      this.onHallChange();
      return;
    }
    if (event.type === "error" && STAGE_ERROR_OPS.has(event.op)) {
      const namesRequired = this.options.identity?.().namesRequired ?? false;
      const text = stageErrorText(event.reason, { op: event.op, namesRequired, ...(event.retryInMs !== undefined ? { retryInMs: event.retryInMs } : {}) });
      if (text) this.options.announce(text);
    }
  }

  private onHallChange(): void {
    const hall = this.options.hall;
    const action = localShareAction({ member: hall.member, amHolder: hall.amHolder, sharing: this.share !== null });
    if (action === "stop") this.endLocalShare();
    else if (action === "grace") this.startGraceTimer();
    else this.clearGraceTimer();
    if (this.dialog && !hall.amHolder) this.dialog.close();

    const localId = hall.localPlayerId;
    const phase = localStagePhase({ member: hall.member, stage: hall.stage, localPlayerId: localId, sharing: this.share !== null });
    const queuePosition = localId ? hall.queuePosition(localId) : 0;
    if (phase === "preparing" && this.lastPhase !== "preparing" && this.lastPhase !== "sharing") {
      this.options.announce(
        `You're on stage! Everyone in the hall now hears your microphone (when it's on), whatever range you picked. Press “Start sharing” in the Stage panel within ${Math.round(HALL_STAGE_PREPARE_TIMEOUT_MS / 1000)} seconds.`,
      );
    } else if (phase === "queued" && queuePosition !== this.lastQueuePosition) {
      this.options.announce(`You're #${queuePosition} in the stage queue.`);
    }
    this.lastPhase = phase;
    this.lastQueuePosition = queuePosition;

    // The floor makes the local microphone hall-wide: always say so (it was given on a raised hand).
    const hasFloor = hall.member && localId !== null && hall.floor === localId;
    if (hasFloor && !this.hadFloor) {
      this.options.announce("You have the floor — everyone in the hall hears your microphone, whatever range you picked. “Give up the floor” in the Stage panel ends it.");
    } else if (!hasFloor && this.hadFloor && hall.member) {
      this.options.announce("You no longer have the floor — your microphone is back to your own range.");
    }
    this.hadFloor = hasFloor;

    const stage = hall.stage;
    if (hall.member && stage.status === "live" && stage.holder !== null && stage.holder !== localId) {
      if (stage.holder !== this.announcedLive) {
        this.announcedLive = stage.holder;
        const name = this.options.nicknameOf(stage.holder) ?? "Someone";
        this.options.announce(`${name} is live on the big screen${stage.audio ? " — with sound" : ""}.`);
      }
    } else {
      this.announcedLive = null;
    }
    this.refresh();
  }

  // ------------------------------------------------------------------ sharing

  private async beginShare(systemAudio: boolean, mode: StageShareMode): Promise<void> {
    const voice = this.options.voice;
    const notice = stageVoiceNotice({ mode: voice.connectionMode, state: voice.connectionState, canTalk: this.options.canTalk(), needsName: this.needsName, holder: this.options.isHolder?.() === true });
    if (notice) {
      this.options.announce(notice.text);
      return;
    }
    this.starting = true;
    this.refresh();
    if (systemAudio) {
      // ADR-014 § 4 (the computer-sound option): the personal YouTube player closes first, and the hall is
      // muted BEFORE the capture starts, so neither it nor the game's own playback is ever captured.
      this.options.beforeComputerSound?.();
      voice.setIncomingMuted(true);
    }
    let started = false;
    try {
      started = await voice.startScreenShare({ systemAudio, mode });
    } catch (error) {
      console.warn("[stage] share failed:", error);
      // The precise reason — an insecure page, no getDisplayMedia, an OS block, a capture that didn't start.
      const message = voiceFailureMessage(classifyVoiceFailure(error, "screen", browserVoiceEnvironment()), { dev: import.meta.env.DEV, host: window.location.host, attempt: "share", mainnet: ZCASH_NETWORK === "main" });
      this.options.announce(`${message.title} ${message.detail}`);
    } finally {
      this.starting = false;
    }
    if (!started) {
      if (systemAudio) voice.setIncomingMuted(false);
      this.refresh();
      return;
    }
    if (!this.options.hall.amHolder) {
      // The turn passed (prepare timeout, a host) while the picker was open.
      if (systemAudio) voice.setIncomingMuted(false);
      void voice.stopScreenShare().catch(() => undefined);
      this.options.announce("Your turn on the stage passed before you picked something — request it again at the podium.");
      this.refresh();
      return;
    }
    const track = voice.localScreenTrack;
    if (!track || track.readyState !== "live") {
      // The share ended (tab closed, the browser's "Stop sharing") while LiveKit was still publishing:
      // its unpublish event came before this await returned, so nothing would ever report it.
      if (systemAudio) voice.setIncomingMuted(false);
      void voice.stopScreenShare().catch(() => undefined); // drop a publication left with an ended track
      this.options.announce("The share ended before it started — press “Start sharing” to try again.");
      this.refresh();
      return;
    }
    const audio = voice.hasLocalScreenAudio;
    this.share = { audio, systemAudio: systemAudio && audio };
    if (systemAudio && !audio) voice.setIncomingMuted(false);
    this.options.send({ type: "hall_stage_live", live: true, audio });
    if (!audio) this.options.announce(NO_AUDIO_HINT);
    else if (systemAudio) this.options.announce("You're live on the big screen with your computer's sound. You won't hear the hall until you stop.");
    else this.options.announce("You're live on the big screen, with sound. Stop with “Stop sharing” in the Stage panel or the browser's own button.");
    this.refresh();
  }

  /** Stops the local share; LiveKit's unpublish event (localShareEnded) reports the rest. */
  private stopLocalShare(): void {
    this.clearGraceTimer();
    void this.options.voice.stopScreenShare().catch((error) => console.warn("[stage] stop failed:", error));
  }

  /** Ends the local share whether or not a publication is left (no publication → no unpublish event to wait for). */
  private endLocalShare(): void {
    if (!this.share) return;
    if (this.options.voice.localScreenTrack) this.stopLocalShare();
    else this.localShareEnded();
  }

  private startGraceTimer(): void {
    if (this.graceTimer) return;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      const hall = this.options.hall;
      if (this.share && !(hall.member && hall.amHolder)) this.endLocalShare();
    }, HALL_STAGE_LEAVE_GRACE_MS + 1000);
  }

  private clearGraceTimer(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  // ADR-015: guests may listen, never talk. A listen-only connection is also a guest's proximity voice everywhere,
  // so it does not end when the player leaves the hall (outside, the stage simply stops being downloaded — stageSubscriptionTarget).

  // ------------------------------------------------------------------ screen

  private refresh(): void {
    this.dirty = false;
    this.refreshScreen();
    this.emit();
  }

  private refreshScreen(): void {
    const hall = this.options.hall;
    const voice = this.options.voice;
    const stage = hall.stage;
    let next: { track: MediaStreamTrack; owner: string } | null = null;
    if (this.share) {
      const track = voice.localScreenTrack;
      if (track) next = { track, owner: "local" };
    } else if (hall.member && this.remote && this.remote.playerId === stage.holder && !this.options.isBlocked(this.remote.playerId)) {
      next = { track: this.remote.track, owner: this.remote.playerId };
    }
    if ((next?.track ?? null) !== (this.shown?.track ?? null)) {
      this.detach();
      if (next) this.attach(next.track, next.owner);
    }

    const holderBlocked = stage.holder !== null && this.options.isBlocked(stage.holder);
    this.screenMessage = stageScreenMessage({
      member: hall.member,
      stage,
      localPlayerId: hall.localPlayerId,
      nameOf: this.options.nicknameOf,
      showingVideo: this.shown !== null,
      voiceMode: voice.connectionMode,
      voiceState: voice.connectionState,
      holderBlocked,
      upNext: this.upNext,
    });
    const screen = this.options.screen;
    if (screen) {
      if (this.screenMessage) screen.setIdleMessage(this.screenMessage.title, this.screenMessage.subtitle);
      screen.setLive(hall.member && stage.status === "live");
    }

    const wantInteractable = this.screenSpot !== null && this.shown !== null && this.shown.owner !== "local";
    if (wantInteractable !== this.screenInteractable) {
      this.screenInteractable = wantInteractable;
      if (wantInteractable && this.screenSpot) {
        this.options.register({
          id: SCREEN_INTERACTABLE_ID,
          label: "Big screen — watch full size",
          position: this.screenSpot.clone(),
          interactionRadius: 2.6,
          interact: () => void this.openViewer(),
        });
      } else {
        this.options.unregister(SCREEN_INTERACTABLE_ID);
      }
    }
  }

  private attach(track: MediaStreamTrack, owner: string): void {
    // A raw MediaStreamTrack into a muted, playsInline, off-DOM <video> (never LiveKit's attach(): adaptiveStream would pause it).
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = new MediaStream([track]);
    void video.play().catch(() => undefined);
    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace;
    const shown: ShownVideo = { track, owner, video, texture, frames: 0 };
    this.shown = shown;
    if ("requestVideoFrameCallback" in video) {
      // Distinct presented frames (metadata.presentedFrames), not callbacks: an off-DOM video can call back more often
      // than it gets new frames, which would overstate the stage's frame rate.
      const count = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
        if (this.shown !== shown) return;
        shown.frames = metadata.presentedFrames;
        video.requestVideoFrameCallback(count);
      };
      video.requestVideoFrameCallback(count);
    }
    this.options.screen?.setTexture(texture);
  }

  private detach(): void {
    const shown = this.shown;
    if (!shown) return;
    this.shown = null;
    this.options.screen?.setTexture(null);
    shown.texture.dispose();
    shown.video.pause();
    shown.video.srcObject = null;
    if (this.isViewerOpen) this.closeViewer();
  }

  private button(text: string, primary: boolean, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = primary ? "zw-button zw-button-primary" : "zw-button";
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const state = this.state;
    for (const listener of [...this.listeners]) listener(state);
  }

  // ------------------------------------------------------------------ confirm dialog

  /** The share confirm dialog (WATCH_HALL.md). Resolves with the holder's choice, or null when cancelled. */
  private confirm(): Promise<{ systemAudio: boolean; mode: StageShareMode } | null> {
    return new Promise((resolve) => {
      const backdrop = document.createElement("div");
      backdrop.className = "zw-ui zw-stage-confirm";
      backdrop.setAttribute("role", "dialog");
      backdrop.setAttribute("aria-modal", "true");
      backdrop.setAttribute("aria-labelledby", "zw-stage-confirm-title");
      const panel = document.createElement("div");
      panel.className = "zw-panel zw-stage-confirm-panel";
      const title = document.createElement("h3");
      title.id = "zw-stage-confirm-title";
      title.textContent = "Share on the big screen?";
      const text = document.createElement("p");
      text.textContent =
        "Everyone in the Watch Hall will see what you share — a browser tab, a window or your whole screen — and hear its audio. Your browser asks what to share next and shows that you're sharing. Never show a seed phrase, passwords or a wallet while sharing.";
      const tip = document.createElement("p");
      tip.className = "zw-stage-confirm-tip";
      tip.textContent = "For a tab's sound, tick “Share tab audio” in the browser's picker.";

      // What is shared decides the encoding — sharp text at 30 fps, or smooth motion at 60 fps.
      const modes = document.createElement("fieldset");
      modes.className = "zw-stage-confirm-modes";
      const legend = document.createElement("legend");
      legend.textContent = "What are you sharing?";
      modes.appendChild(legend);
      let mode: StageShareMode = readShareMode();
      const modeChoices: Record<StageShareMode, { title: string; note: string }> = {
        slides: { title: "Slides — sharp text, 30 fps", note: "Slides, code, documents and websites: the text stays crisp (about 3–4 Mbps)." },
        video: { title: "Video — smooth, 60 fps", note: "Videos and demos with motion: up to 60 fps when your browser captures it (about 6–8 Mbps)." },
      };
      for (const value of STAGE_SHARE_MODES) {
        const option = document.createElement("label");
        option.className = "zw-stage-confirm-mode";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "share-mode";
        radio.value = value;
        radio.checked = value === mode;
        radio.addEventListener("change", () => {
          if (!radio.checked) return;
          mode = value;
          writeShareMode(value);
        });
        const text = document.createElement("span");
        const strong = document.createElement("strong");
        strong.textContent = modeChoices[value].title;
        const small = document.createElement("small");
        small.textContent = modeChoices[value].note;
        text.append(strong, small);
        option.append(radio, text);
        modes.appendChild(option);
      }

      const check = document.createElement("label");
      check.className = "zw-stage-confirm-check";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.name = "share-computer-sound";
      const boxText = document.createElement("span");
      boxText.textContent = "Share my computer's sound (whole screen or window; Windows/ChromeOS)";
      check.append(box, boxText);
      const warn = document.createElement("p");
      warn.className = "zw-stage-confirm-warn";
      warn.textContent =
        "With this on, everything your computer plays is shared too — notifications and other apps' sound (for example another call). While you share it you won't hear the hall, so the game's own sound is never shared back.";
      box.addEventListener("change", () => warn.classList.toggle("active", box.checked));

      const notice = document.createElement("div");
      notice.className = "zw-stage-voice-notice";
      notice.setAttribute("role", "status");
      const noticeText = document.createElement("span");
      const noticeAction = document.createElement("button");
      noticeAction.type = "button";
      noticeAction.className = "zw-button";
      let noticeKind: "enable-voice" | "open-wallet" | "confirm-name" | null = null;
      noticeAction.addEventListener("click", () => {
        if (noticeKind === "confirm-name") this.options.requestName?.();
        else this.options.requestVoice();
      });
      notice.append(noticeText, noticeAction);

      const actions = document.createElement("div");
      actions.className = "zw-stage-confirm-actions";
      let settled = false;
      const done = (value: { systemAudio: boolean; mode: StageShareMode } | null): void => {
        if (settled) return;
        settled = true;
        backdrop.remove();
        if (this.dialog === handle) this.dialog = null;
        resolve(value);
      };
      const yes = this.button("Choose what to share", true, () => done({ systemAudio: box.checked, mode }));
      const no = this.button("Cancel", false, () => done(null));
      actions.append(yes, no);
      panel.append(title, text, modes, tip, check, warn, notice, actions);
      backdrop.appendChild(panel);
      backdrop.addEventListener("keydown", (event) => {
        // Keep Enter/Escape inside the dialog (the chat opens on a global Enter).
        if (event.key === "Escape") done(null);
        if (event.key === "Enter" || event.key === "Escape") event.stopPropagation();
      });

      const refresh = (): void => {
        const voice = this.options.voice;
        const state = stageVoiceNotice({ mode: voice.connectionMode, state: voice.connectionState, canTalk: this.options.canTalk(), needsName: this.needsName, holder: this.options.isHolder?.() === true });
        notice.hidden = state === null;
        noticeText.textContent = state?.text ?? "";
        noticeKind = state?.action ?? null;
        noticeAction.hidden = !state?.action;
        noticeAction.textContent = state?.action === "open-wallet" ? talkNeeds(this.options.isHolder?.() === true).open : state?.action === "confirm-name" ? "Confirm a name" : "Enable voice";
        yes.disabled = state !== null;
      };
      const handle = { close: () => done(null), refresh };
      this.dialog = handle;
      refresh();
      document.exitPointerLock();
      this.options.container.appendChild(backdrop);
      (yes.disabled ? (noticeAction.hidden ? no : noticeAction) : yes).focus();
    });
  }
}

let stageStylesInjected = false;
function injectStageStyles(): void {
  if (stageStylesInjected) return;
  stageStylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.zw-screen-viewer, .zw-stage-confirm { position: absolute; inset: 0; z-index: 23; display: none; align-items: center; justify-content: center; background: rgba(4,5,10,0.7); }
.zw-screen-viewer.visible, .zw-stage-confirm { display: flex; }
.zw-screen-viewer-panel { width: min(1200px, 94vw); display: flex; flex-direction: column; gap: 10px; padding: 12px; align-items: flex-end; }
.zw-screen-viewer-title { align-self: flex-start; font: 700 15px "Segoe UI", system-ui, sans-serif; color: #f2e9d8; }
.zw-screen-viewer-panel video { width: 100%; max-height: 76vh; background: #000; border-radius: 8px; }
.zw-stage-confirm-panel { width: min(500px, 92vw); max-height: 92vh; overflow-y: auto; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; }
.zw-stage-confirm-modes { margin: 0; padding: 6px 10px 8px; border: 1px solid rgba(240,195,94,0.28); border-radius: 8px; display: flex; flex-direction: column; gap: 6px; }
.zw-stage-confirm-modes legend { padding: 0 4px; font: 700 12px "Segoe UI", system-ui, sans-serif; color: #d9b77a; }
.zw-stage-confirm-mode { display: flex; gap: 8px; align-items: flex-start; cursor: pointer; color: #f1e9dd; font-size: 13px; }
.zw-stage-confirm-mode input { margin-top: 3px; accent-color: #d9a441; }
.zw-stage-confirm-mode span { display: flex; flex-direction: column; gap: 1px; }
.zw-stage-confirm-mode small { color: #b9ae9c; font-size: 11.5px; line-height: 1.4; }
.zw-stage-confirm-panel h3 { margin: 0; font: 700 17px Georgia, serif; color: #f4e3c1; }
.zw-stage-confirm-panel p { margin: 0; font-size: 13px; line-height: 1.5; color: #e6dccb; }
.zw-stage-confirm-panel .zw-stage-confirm-tip { color: #c9bfae; font-size: 12px; }
.zw-stage-confirm-check { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; color: #f1e9dd; cursor: pointer; }
.zw-stage-confirm-check input { margin-top: 2px; }
.zw-stage-confirm-panel .zw-stage-confirm-warn { font-size: 12px; color: #b9ae9c; padding-left: 22px; }
.zw-stage-confirm-panel .zw-stage-confirm-warn.active { color: #ffd36a; }
.zw-stage-voice-notice { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 8px 10px; border-radius: 8px; background: rgba(224,120,40,0.16); border: 1px solid rgba(224,140,60,0.45); font-size: 12px; line-height: 1.45; color: #ffd9a8; }
.zw-stage-voice-notice[hidden], .zw-stage-voice-notice button[hidden] { display: none; }
.zw-stage-confirm-actions { display: flex; gap: 8px; }
`;
  document.head.appendChild(style);
}
