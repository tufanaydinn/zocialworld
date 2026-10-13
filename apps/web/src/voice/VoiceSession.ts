import * as THREE from "three";
import { VoiceClient, type LocalShareStats, type StageReceiveStats, type StageShareOptions, type StageVideoQuality, type VoiceConnectionState } from "./VoiceClient.ts";
import { VoiceAudioGraph } from "./VoiceAudioGraph.ts";
import { DEFAULT_VOICE_RANGE, parseVoiceRange, type VoiceRange } from "./VoiceProximity.ts";
import {
  clampStageVolume,
  effectiveSpeakerDistance,
  hasStageMic,
  loadStageVolume,
  resolveMicGain,
  resolveStageGain,
  saveStageVolume,
  shouldSubscribeSpeaker,
  stageSubscriptionTarget,
  type StageAudioContext,
  type VoiceConnectionMode,
} from "./hallAudio.ts";
import { getVoiceTokenUrl } from "./config.ts";
import { VoiceTokenError, readTokenErrorCode } from "./voiceErrors.ts";

export interface VoiceSessionEvents {
  onStateChange?: (state: VoiceConnectionState) => void;
  onSpeakingChanged?: (playerId: string, speaking: boolean) => void;
  /** Mic permission denied/unavailable/getUserMedia failure — voice stays connected (so the user can still hear others) but can never transmit. Never thrown past this boundary. */
  onMicrophoneError?: (error: unknown) => void;
  /** The stage holder's video track arrived (track) or went away (null). Only ever fires for the server-named holder while inside the hall. */
  onStageTrack?: (playerId: string, track: MediaStreamTrack | null) => void;
  /** The local screen share ended (browser "Stop sharing", track end, unpublish) — a LiveKit event, not the game loop. */
  onLocalScreenShareEnded?: () => void;
  /** The local share's audio track ended while the video goes on. */
  onLocalScreenAudioEnded?: () => void;
  /** ADR-019 § 6: the server revoked this participant's publishing (see VoiceClientEvents.onPublishRevoked). */
  onPublishRevoked?: () => void;
}

/** Where VoiceSession reads the hall's state each frame (HallStore + the local inside-hall flag). Server state only, never participant attributes. */
export interface VoiceStageProvider {
  /** The server-named stage holder, or null. */
  holder(): string | null;
  /** The member given the floor, or null. */
  floor(): string | null;
  /** Whether the local player is inside the hall (2 m exit hysteresis). */
  inside(): boolean;
  /** This session's playerId. */
  localPlayerId(): string | null;
}

export interface VoiceSessionOptions {
  camera: THREE.Camera;
  /** Looks up the `THREE.Object3D` a remote participant's audio should be attached to (i.e. the matching `RemotePlayer.object`) — `undefined` if that player isn't currently visible. */
  getRemotePlayerObject: (playerId: string) => THREE.Object3D | undefined;
  isMuted: (playerId: string) => boolean;
  isBlocked: (playerId: string) => boolean;
  /** This listener's per-player volume (0–2, default 1). */
  getPlayerVolume?: (playerId: string) => number;
  /** The hall's stage state. Without it there is no stage (no subscription, no stage mic). */
  stage?: VoiceStageProvider;
  /** The stage video layer to request (by render tier). */
  stageQuality?: () => StageVideoQuality;
  /** Where the stage volume is remembered (default: localStorage, guarded). */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
}

/** Microphone modes. Push-to-talk transmits while V is held; open mic transmits while the mic toggle is on (M). */
export type MicMode = "push-to-talk" | "open";

export type { VoiceConnectionMode } from "./hallAudio.ts";

/**
 * The voice orchestration layer — ties `VoiceClient` (SFU connection),
 * `VoiceAudioGraph` (Web Audio spatialization), `VoiceProximity`
 * (distance → gain) and the `SocialStore` mute/block state together.
 *
 * Speaking ranges and subscriptions:
 *  - each speaker publishes a range (whisper / talk / shout) as a LiveKit
 *    participant attribute; listeners apply the SPEAKER's range;
 *  - audio is subscribed only while the listener is within that range
 *    (+ margin) — far voices are never downloaded;
 *  - a speaker whose world presence is gone (no avatar) is silenced and
 *    unsubscribed instead of keeping their last gain;
 *  - master and per-player volume; open-mic mode; microphone selection.
 *
 * Connection modes and the Watch Hall stage (ADR-014 §§ 3–5, docs/architecture/WATCH_HALL.md):
 *  - connection modes `off` / `listen` / `full`: listen mode is a
 *    listen-only connection (no wallet, no microphone, nothing published —
 *    ADR-015: a guest's voice mode, hearing nearby voices too);
 *    `enableVoice()` upgrades it by reconnecting with the full grant
 *    (wallet holders only — the server refuses guests with 403);
 *  - the stage: only the server-named holder's ScreenShare +
 *    ScreenShareAudio are subscribed, only while inside the hall and not
 *    blocked; the audio plays through a non-positional stage entry at
 *    stageVolume × master × duck;
 *  - the holder's and the floor's microphones are heard at distance 0 by
 *    listeners inside the hall (server state only);
 *  - incoming audio can be muted as a whole while the local player shares
 *    their computer's sound (ADR-014 § 4).
 */
export class VoiceSession {
  private readonly client: VoiceClient;
  private readonly audioGraph: VoiceAudioGraph;
  private readonly options: VoiceSessionOptions;
  private readonly events: VoiceSessionEvents;
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | null;
  private readonly speakingPlayerIds = new Set<string>();
  private readonly subscribedPlayerIds = new Set<string>();
  private readonly remoteRanges = new Map<string, VoiceRange>();
  private transmitting = false;
  private ownRange: VoiceRange = DEFAULT_VOICE_RANGE;
  private masterVolume = 1;
  private micMode: MicMode = "push-to-talk";
  private openMicLive = false;
  private pushToTalkHeld = false;
  private modeValue: VoiceConnectionMode = "off";
  /** Set while enableVoice() drops a watch-mode connection to reconnect with the full grant. */
  private switchingMode = false;
  /** Bumped by every enableVoice / enableListening / disableVoice: a connect whose token arrives after a newer call is dropped. */
  private connectGeneration = 0;
  private stageVolumeValue: number;
  private ducked = false;
  private incomingMuted = false;
  /** The holder whose stage share this client subscribed to, and their video track once it arrived. */
  private stageTargetId: string | null = null;
  private stageVideo: MediaStreamTrack | null = null;

  constructor(options: VoiceSessionOptions, events: VoiceSessionEvents) {
    this.options = options;
    this.events = events;
    this.storage = options.storage !== undefined ? options.storage : safeLocalStorage();
    this.stageVolumeValue = loadStageVolume(this.storage);
    this.audioGraph = new VoiceAudioGraph(options.camera);
    this.client = new VoiceClient({
      onStateChange: (state) => {
        if (state === "disconnected" || state === "error") {
          this.resetMediaState();
          if (!this.switchingMode) this.modeValue = "off";
        }
        if (state === "connected" && this.modeValue === "full") void this.client.setOwnAttributes({ voiceRange: this.ownRange }).catch(() => undefined);
        this.events.onStateChange?.(state);
      },
      onParticipantDisconnected: (playerId) => this.handleParticipantLeft(playerId),
      onTrackSubscribed: (playerId, track) => this.handleTrackSubscribed(playerId, track),
      onTrackUnsubscribed: (playerId) => this.handleTrackUnsubscribed(playerId),
      onSpeakingChanged: (playerId, speaking) => {
        if (speaking) this.speakingPlayerIds.add(playerId);
        else this.speakingPlayerIds.delete(playerId);
        this.events.onSpeakingChanged?.(playerId, speaking);
      },
      onAttributesChanged: (playerId, attributes) => {
        this.remoteRanges.set(playerId, parseVoiceRange(attributes.voiceRange));
      },
      onScreenTrack: (playerId, track) => this.handleScreenTrack(playerId, track),
      onScreenAudioTrack: (playerId, track) => this.handleScreenAudioTrack(playerId, track),
      onLocalScreenShareEnded: () => this.events.onLocalScreenShareEnded?.(),
      onLocalScreenAudioEnded: () => this.events.onLocalScreenAudioEnded?.(),
      onPublishRevoked: () => this.events.onPublishRevoked?.(),
    });
  }

  get connectionState(): VoiceConnectionState {
    return this.client.connectionState;
  }

  /** `off`, `listen` (watch mode) or `full` — the mode of the current (or connecting) connection. */
  get connectionMode(): VoiceConnectionMode {
    return this.modeValue;
  }

  get isTransmitting(): boolean {
    return this.transmitting;
  }

  get range(): VoiceRange {
    return this.ownRange;
  }

  get mode(): MicMode {
    return this.micMode;
  }

  get isOpenMicLive(): boolean {
    return this.openMicLive;
  }

  get volume(): number {
    return this.masterVolume;
  }

  get hasMicrophone(): boolean {
    return this.client.hasMicrophoneTrack;
  }

  /** The listener's stage volume (0–2), remembered on this device. */
  get stageVolume(): number {
    return this.stageVolumeValue;
  }

  /** Whether incoming audio is muted because the local player shares their computer's sound. */
  get isIncomingMuted(): boolean {
    return this.incomingMuted;
  }

  isSpeaking(playerId: string): boolean {
    return this.speakingPlayerIds.has(playerId);
  }

  /** A remote speaker's chosen range (talk until they publish one). */
  rangeOf(playerId: string): VoiceRange {
    return this.remoteRanges.get(playerId) ?? DEFAULT_VOICE_RANGE;
  }

  /** Which remote participants currently have a subscribed, gain-controlled audio track attached. Test/debug observability (`window.__voiceSession`). */
  getSubscribedPlayerIds(): string[] {
    return Array.from(this.subscribedPlayerIds);
  }

  /** The last gain value `update()` applied for this remote participant, if subscribed. Test/debug observability only. */
  getGain(playerId: string): number | undefined {
    return this.audioGraph.getGain(playerId);
  }

  /** Whose stage share this client is subscribed to (null if none). Test/debug observability. */
  getStageTarget(): string | null {
    return this.stageTargetId;
  }

  /** Whether the stage audio track is playing, and its gain target. Test/debug observability. */
  getStageAudio(): { playing: boolean; gain: number | undefined } {
    return { playing: this.audioGraph.hasStage, gain: this.audioGraph.getStageGain() };
  }

  /** The stage holder's video track, once subscribed. */
  get stageVideoTrack(): MediaStreamTrack | null {
    return this.stageVideo;
  }

  /** The local share's capture settings and the encodings it is sent with (null when not sharing). Test/debug observability. */
  getLocalShareStats(): Promise<LocalShareStats | null> {
    return this.client.localShareStats();
  }

  /** What this viewer receives of the stage video — size, frame rate, layer request (null when none). Test/debug observability. */
  getStageReceiveStats(): Promise<StageReceiveStats | null> {
    return this.stageTargetId === null ? Promise.resolve(null) : this.client.screenReceiveStats(this.stageTargetId);
  }

  /**
   * Explicit user-gesture entry point — must only be
   * called from a click handler, never automatically on load. Requests a
   * scoped voice token (the owner-only capability is the only thing
   * sent), connects to the SFU, then captures the microphone MUTED.
   *
   * From watch mode it upgrades: the full token is fetched
   * first, while the listen-only connection keeps playing, so a failed
   * token request leaves watch mode running; only then is the listen-only
   * connection dropped and the full one made. If that connect fails, watch
   * mode is started again.
   */
  async enableVoice(capability: string): Promise<void> {
    // Must happen inside this same user-gesture call stack — see VoiceAudioGraph.resumeContext().
    await this.audioGraph.resumeContext();

    const generation = ++this.connectGeneration;
    // Upgrading a running watch-mode room (a listen token still on its way doesn't count: it is dropped).
    const fromListen = this.modeValue === "listen" && this.client.connectionState === "connected";
    if (!fromListen) this.modeValue = "full";
    let grant: { token: string; url: string };
    try {
      grant = await this.requestToken(capability, false);
    } catch (error) {
      if (!fromListen && generation === this.connectGeneration && this.connectionState !== "connected") this.modeValue = "off";
      throw error; // from watch mode: still watching
    }
    if (generation !== this.connectGeneration) return; // a newer enable/disable took over
    if (fromListen) {
      this.switchingMode = true;
      try {
        this.client.disconnect();
      } finally {
        this.switchingMode = false;
      }
    }
    this.modeValue = "full";
    try {
      await this.client.connect(grant.url, grant.token);
    } catch (error) {
      if (this.connectionState !== "connected") {
        this.modeValue = "off";
        if (fromListen) void this.enableListening(capability).catch(() => undefined); // back to watching rather than silence
      }
      throw error;
    }
    // The room can close by itself while connecting (e.g. ICE never completes): report it, never "succeed" silently.
    if (this.connectionState !== "connected") throw new Error("voice connection closed while connecting");

    try {
      await this.client.enableMicrophone();
    } catch (error) {
      // Mic denied/unavailable: stay connected (the user can still hear others) but never transmit.
      this.events.onMicrophoneError?.(error);
    }
  }

  /**
   * Listen mode — watch mode (ADR-014 § 5) and every guest's voice (ADR-015:
   * guests may listen, never talk): a listen-only connection that needs no wallet. It hears
   * nearby voices by the normal proximity rules, the stage/floor microphones and the stage, never
   * captures the microphone and cannot publish anything (the server mints `canPublish:false`).
   * Call it only from a click: the AudioContext resumes inside that gesture. A no-op when already
   * connected in any mode.
   */
  async enableListening(capability: string): Promise<void> {
    await this.audioGraph.resumeContext();
    if (this.client.connectionState === "connected" || this.client.connectionState === "connecting") return;
    const generation = ++this.connectGeneration;
    this.modeValue = "listen";
    try {
      const { token, url } = await this.requestToken(capability, true);
      // Enable Voice was clicked while this token was on its way: that call connects with the
      // full grant; a stale listen-only room must never win the race (it would be a
      // canPublish:false room shown as full voice).
      if (generation !== this.connectGeneration || this.modeValue !== "listen") return;
      await this.client.connect(url, token, { listenOnly: true });
    } catch (error) {
      if (generation === this.connectGeneration && this.modeValue === "listen" && this.connectionState !== "connected") this.modeValue = "off";
      throw error;
    }
    // Closed by itself while connecting — unless enableVoice() took over meanwhile (then that call reports).
    if (this.modeValue === "listen" && this.connectionState !== "connected") throw new Error("voice connection closed while connecting");
  }

  /**
   * The server stopped this participant publishing (a stage turn taken by a host, a
   * moderator or the vote; a lost identity). Voice drops to listen mode on the same room instead of switching off: the
   * microphone and any share are stopped and released, push-to-talk and open mic reset, and nearby voices and the
   * stage keep playing. `enableVoice()` from here asks for a new full grant (the server decides whether it may talk).
   * Returns false when there was no connected room to keep.
   */
  async downgradeToListen(): Promise<boolean> {
    if (this.client.connectionState !== "connected") return false;
    this.modeValue = "listen";
    this.transmitting = false;
    this.openMicLive = false;
    this.pushToTalkHeld = false;
    await this.client.dropToListenOnly();
    return true;
  }

  disableVoice(): void {
    this.connectGeneration++;
    this.modeValue = "off";
    this.client.disconnect();
    this.resetMediaState();
    this.transmitting = false;
    this.openMicLive = false;
    this.pushToTalkHeld = false;
  }

  /** Leaves voice and releases the audio listener (App teardown). */
  dispose(): void {
    this.disableVoice();
    this.audioGraph.dispose();
  }

  /** Push-to-talk key state (V). Transmits while held in push-to-talk mode; ignored in open-mic mode. */
  async setPushToTalk(held: boolean): Promise<void> {
    this.pushToTalkHeld = held;
    await this.applyTransmitting();
  }

  /** Push-to-talk press/release. */
  async setTransmitting(transmitting: boolean): Promise<void> {
    await this.setPushToTalk(transmitting);
  }

  /** Switches microphone mode; switching always starts with the mic closed (never silently opens it). */
  async setMicMode(mode: MicMode): Promise<void> {
    this.micMode = mode;
    this.openMicLive = false;
    await this.applyTransmitting();
  }

  /** Open-mic toggle (M or the mic button). Returns the new state. */
  async toggleOpenMic(): Promise<boolean> {
    if (this.micMode !== "open" || !this.client.hasMicrophoneTrack) return false;
    this.openMicLive = !this.openMicLive;
    await this.applyTransmitting();
    return this.openMicLive;
  }

  async setRange(range: VoiceRange): Promise<void> {
    this.ownRange = range;
    if (this.client.connectionState === "connected") await this.client.setOwnAttributes({ voiceRange: range });
  }

  setMasterVolume(volume: number): void {
    this.masterVolume = Math.max(0, Math.min(2, volume));
  }

  /** Stage volume 0–2, remembered per device. */
  setStageVolume(volume: number): void {
    this.stageVolumeValue = clampStageVolume(volume);
    saveStageVolume(this.storage, this.stageVolumeValue);
  }

  /** Lowers the stage audio while the viewer's own personal player is open. */
  duck(on: boolean): void {
    this.ducked = on;
  }

  /** ADR-014 § 4: mutes every incoming sound (voices and stage) while the local player shares their computer's sound. Applied at once, not on the next frame. */
  setIncomingMuted(muted: boolean): void {
    this.incomingMuted = muted;
    this.audioGraph.setIncomingMuted(muted);
  }

  listMicrophones(): Promise<MediaDeviceInfo[]> {
    return this.client.listMicrophones();
  }

  switchMicrophone(deviceId: string): Promise<void> {
    return this.client.switchMicrophone(deviceId);
  }

  // ---- stage share — publishing; the StageSystem decides when

  /** Shares a tab/window/screen with its audio onto the stage (from the holder's click only). Returns false if the picker was cancelled. */
  startScreenShare(options: StageShareOptions): Promise<boolean> {
    return this.client.startScreenShare(options);
  }

  async stopScreenShare(): Promise<void> {
    await this.client.stopScreenShare();
  }

  get localScreenTrack(): MediaStreamTrack | null {
    return this.client.localScreenTrack;
  }

  /** Whether the local share carries an audio track. */
  get hasLocalScreenAudio(): boolean {
    return this.client.hasLocalScreenAudio;
  }

  remoteScreens(): string[] {
    return this.client.remoteScreens();
  }

  /**
   * Call once per render frame with the local player's world position:
   * subscribes/unsubscribes speakers by distance (stage mics at distance 0
   * inside the hall), recomputes every subscribed speaker's gain (range ×
   * volumes, mute/block win), and keeps the stage subscription on the
   * server-named holder.
   */
  update(localPosition: THREE.Vector3): void {
    if (this.client.connectionState !== "connected") return;
    const stage = this.stageContext();
    const mode = this.modeValue;
    for (const playerId of this.client.remoteSpeakers()) {
      const remoteObject = this.options.getRemotePlayerObject(playerId);
      // No avatar (left the world, blocked from view, or not spawned yet): never keep playing them.
      const realDistance = remoteObject ? localPosition.distanceTo(remoteObject.position) : Number.POSITIVE_INFINITY;
      const stageMic = remoteObject !== undefined && hasStageMic(playerId, stage, remoteObject.position);
      this.client.setAudioSubscribed(
        playerId,
        shouldSubscribeSpeaker({
          mode,
          stageMic,
          blocked: this.options.isBlocked(playerId),
          distance: effectiveSpeakerDistance(realDistance, stageMic),
          range: this.rangeOf(playerId),
          currently: this.client.isAudioSubscribed(playerId),
        }),
      );
    }
    for (const playerId of this.subscribedPlayerIds) {
      const remoteObject = this.options.getRemotePlayerObject(playerId);
      if (!remoteObject) {
        this.audioGraph.setGain(playerId, 0);
        continue;
      }
      const stageMic = hasStageMic(playerId, stage, remoteObject.position);
      this.audioGraph.setGain(
        playerId,
        resolveMicGain({
          mode,
          stageMic,
          distance: effectiveSpeakerDistance(localPosition.distanceTo(remoteObject.position), stageMic),
          muted: this.options.isMuted(playerId),
          blocked: this.options.isBlocked(playerId),
          range: this.rangeOf(playerId),
          playerVolume: this.options.getPlayerVolume?.(playerId) ?? 1,
          masterVolume: this.masterVolume,
        }),
      );
    }
    this.updateStage(stage);
  }

  private stageContext(): StageAudioContext {
    const provider = this.options.stage;
    if (!provider) return { holder: null, floor: null, inside: false };
    return { holder: provider.holder(), floor: provider.floor(), inside: provider.inside() };
  }

  /** Keeps the stage subscription on the server-named holder only (never any other screen publication) and sets the stage gain. */
  private updateStage(stage: StageAudioContext): void {
    const target = stageSubscriptionTarget({
      holder: stage.holder,
      localPlayerId: this.options.stage?.localPlayerId() ?? null,
      inside: stage.inside,
      connected: this.client.connectionState === "connected",
      blocked: stage.holder !== null && this.options.isBlocked(stage.holder),
    });
    if (target !== this.stageTargetId) {
      const previous = this.stageTargetId;
      this.stageTargetId = target;
      if (previous) {
        this.client.setScreenSubscribed(previous, false);
        this.clearStageTracks(previous);
      }
    }
    if (target) this.client.setScreenSubscribed(target, true, this.options.stageQuality?.() ?? "high");
    if (target && this.audioGraph.hasStage) {
      this.audioGraph.setStageGain(
        resolveStageGain({ stageVolume: this.stageVolumeValue, masterVolume: this.masterVolume, ducked: this.ducked, holderMuted: this.options.isMuted(target) }),
      );
    }
  }

  private handleScreenTrack(playerId: string, track: MediaStreamTrack | null): void {
    if (playerId !== this.stageTargetId) {
      // Not the holder: never keep a screen track (a rogue publisher is never downloaded on purpose).
      if (track) this.client.setScreenSubscribed(playerId, false);
      return;
    }
    if (this.stageVideo === track) return;
    this.stageVideo = track;
    this.events.onStageTrack?.(playerId, track);
  }

  private handleScreenAudioTrack(playerId: string, track: MediaStreamTrack | null): void {
    if (playerId !== this.stageTargetId) {
      if (track) this.client.setScreenSubscribed(playerId, false);
      return;
    }
    this.audioGraph.setStageTrack(track);
  }

  private clearStageTracks(playerId: string): void {
    this.audioGraph.setStageTrack(null);
    if (this.stageVideo) {
      this.stageVideo = null;
      this.events.onStageTrack?.(playerId, null);
    }
  }

  /** Drops everything that belonged to the (old) room: remote audio, the stage, speaking and ranges. */
  private resetMediaState(): void {
    this.audioGraph.clear();
    this.subscribedPlayerIds.clear();
    this.speakingPlayerIds.clear();
    this.remoteRanges.clear();
    const previous = this.stageTargetId;
    this.stageTargetId = null;
    if (previous) this.clearStageTracks(previous);
  }

  private async requestToken(capability: string, listenOnly: boolean): Promise<{ token: string; url: string }> {
    const response = await fetch(getVoiceTokenUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The owner-only capability is the only credential sent; listenOnly can only narrow the grant (ADR-014 § 5).
      body: JSON.stringify(listenOnly ? { capability, listenOnly: true } : { capability }),
    });
    // The status and the server's error code (voice_unconfigured, wallet_required) say exactly why.
    if (!response.ok) throw new VoiceTokenError(response.status, await readTokenErrorCode(response));
    return (await response.json()) as { token: string; url: string };
  }

  private async applyTransmitting(): Promise<void> {
    const want = this.micMode === "open" ? this.openMicLive : this.pushToTalkHeld;
    if (this.transmitting === want) return;
    this.transmitting = want;
    await this.client.setTransmitting(want);
  }

  private handleTrackSubscribed(playerId: string, track: MediaStreamTrack): void {
    const remoteObject = this.options.getRemotePlayerObject(playerId);
    if (!remoteObject) return; // RemotePlayer doesn't exist (yet, or anymore) on this client — nothing to attach the audio to
    this.audioGraph.addRemoteTrack(playerId, track, remoteObject);
    this.subscribedPlayerIds.add(playerId);
  }

  private handleTrackUnsubscribed(playerId: string): void {
    this.audioGraph.removeRemoteTrack(playerId);
    this.subscribedPlayerIds.delete(playerId);
  }

  private handleParticipantLeft(playerId: string): void {
    this.handleTrackUnsubscribed(playerId);
    this.speakingPlayerIds.delete(playerId);
    this.remoteRanges.delete(playerId);
    if (playerId === this.stageTargetId) {
      this.stageTargetId = null;
      this.clearStageTracks(playerId);
    }
  }
}

function safeLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}
