import {
  AudioPresets,
  Room,
  RoomEvent,
  Track,
  VideoPreset,
  VideoQuality,
  type LocalTrackPublication,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";
import { stageShareQuality, type StageShareMode } from "./stageShareQuality.ts";

export type VoiceConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** Requested layer for the stage video, by render tier (WATCH_HALL.md): the low tier asks the SFU for a smaller layer. */
export type StageVideoQuality = "high" | "medium";

/** Stage share capture choices (ADR-014 § 4). */
export interface StageShareOptions {
  /** The holder ticked "Share my computer's sound": ask for system audio (Windows/ChromeOS Chrome/Edge only). Default: excluded. */
  readonly systemAudio: boolean;
  /**
   * "slides" (sharp text, 30 fps — the default) or "video" (smooth, 60 fps when the capture supports it).
   * Sets the content hint, the capture frame rate, the top layer's bitrate and frame rate, and what the encoder gives up
   * first — see stageShareQuality.ts.
   */
  readonly mode?: StageShareMode;
}

/** Debug observability: the local share as captured and as encoded. */
export interface LocalShareStats {
  readonly capture: { readonly width: number | null; readonly height: number | null; readonly frameRate: number | null };
  readonly contentHint: string;
  readonly encodings: readonly { rid: string | null; active: boolean; maxBitrate: number | null; maxFramerate: number | null; scaleResolutionDownBy: number | null }[];
  readonly outbound: { rid: string | null; width: number | null; height: number | null; fps: number | null }[];
}

/** Debug observability: the stage video as a viewer receives it. */
export interface StageReceiveStats {
  /** The layer this viewer asked for (VideoQuality: 0 low, 1 medium, 2 high), if any. */
  readonly requestedQuality: number | null;
  readonly inbound: { width: number | null; height: number | null; fps: number | null; framesDecoded: number | null } | null;
}

export interface VoiceClientEvents {
  onStateChange?: (state: VoiceConnectionState) => void;
  /** `playerId` — LiveKit's `identity` field, which this app always sets to the multiplayer playerId (never the nickname, never a wallet identifier). See apps/server/src/voice/tokenHandler.ts. */
  onParticipantConnected?: (playerId: string) => void;
  onParticipantDisconnected?: (playerId: string) => void;
  onTrackSubscribed?: (playerId: string, track: MediaStreamTrack) => void;
  onTrackUnsubscribed?: (playerId: string) => void;
  /** Fires for every tracked participant (including the local one) whenever the active-speaker set changes. */
  onSpeakingChanged?: (playerId: string, speaking: boolean) => void;
  /** A participant's attributes changed (only `voiceRange` is read). */
  onAttributesChanged?: (playerId: string, attributes: Readonly<Record<string, string>>) => void;
  /** A remote screen-share video track became available (track) or went away (null). Only ever subscribed for the stage holder. */
  onScreenTrack?: (playerId: string, track: MediaStreamTrack | null) => void;
  /** A remote screen-share AUDIO track (tab or system audio) became available (track) or went away (null). */
  onScreenAudioTrack?: (playerId: string, track: MediaStreamTrack | null) => void;
  /** The local screen share stopped (the browser's own "Stop sharing", track end or unpublish) — a LiveKit event, never the game loop. */
  onLocalScreenShareEnded?: () => void;
  /** The local share's audio track ended while its video goes on. */
  onLocalScreenAudioEnded?: () => void;
  /**
   * ADR-019 § 6: the game server told LiveKit to stop this participant publishing (`canPublish` went
   * false — a stage turn taken by a host, a moderator or the audience vote, or a lost identity). LiveKit has already
   * unpublished the microphone and any share.
   */
  onPublishRevoked?: () => void;
}

/**
 * Owns the LiveKit `Room` connection and nothing else — no scene access,
 * no proximity/attenuation logic, no DOM. See `VoiceSession.ts` for the
 * orchestration layer that reacts to this class's events.
 *
 * Never attaches/plays back the local participant's own
 * audio track.
 *
 * Push-to-talk / open mic are mute/unmute on an already-published track
 * (instant), never publish/unpublish per key press.
 *
 * Subscriptions are manual (`autoSubscribe: false`). The
 * session subscribes to a speaker's audio only while the listener is
 * within that speaker's range (plus a margin), so far-away voices are
 * never downloaded.
 *
 * ADR-014: screen shares (video + tab audio) are
 * subscribed only for the server-named stage holder, only while the
 * listener is inside the Watch Hall. A listen-only connection (watch
 * mode, `connect(…, { listenOnly: true })`) never captures or publishes
 * anything — its token cannot publish either.
 *
 * Events of a room this client already left are ignored, so a quick
 * disconnect + reconnect (watch mode → full voice) never tears down the
 * new room.
 */
export class VoiceClient {
  private room: Room | null = null;
  private state: VoiceConnectionState = "disconnected";
  private readonly events: VoiceClientEvents;
  private readonly knownSpeakers = new Set<string>();
  private listenOnly = false;

  constructor(events: VoiceClientEvents) {
    this.events = events;
  }

  get connectionState(): VoiceConnectionState {
    return this.state;
  }

  /** True once the local microphone track has been captured and published (muted or not) — see `setTransmitting`. */
  get hasMicrophoneTrack(): boolean {
    return Boolean(this.room?.localParticipant.getTrackPublication(Track.Source.Microphone));
  }

  /** Whether the current connection is listen-only (watch mode). */
  get isListenOnly(): boolean {
    return this.room !== null && this.listenOnly;
  }

  async connect(url: string, token: string, options: { listenOnly?: boolean } = {}): Promise<void> {
    if (this.room) return; // already connecting/connected

    this.listenOnly = options.listenOnly === true;
    this.setState("connecting");
    const room = new Room({ adaptiveStream: true, dynacast: true });
    this.room = room;
    const current = (): boolean => this.room === room;

    room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
      if (!current()) return;
      this.events.onParticipantConnected?.(participant.identity);
      if (Object.keys(participant.attributes).length) this.events.onAttributesChanged?.(participant.identity, participant.attributes);
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      if (!current()) return;
      this.knownSpeakers.delete(participant.identity);
      this.events.onParticipantDisconnected?.(participant.identity);
    });
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (!current()) return;
      if (track.kind === Track.Kind.Audio && publication.source === Track.Source.Microphone) {
        this.events.onTrackSubscribed?.(participant.identity, track.mediaStreamTrack);
      } else if (track.kind === Track.Kind.Video && publication.source === Track.Source.ScreenShare) {
        this.events.onScreenTrack?.(participant.identity, track.mediaStreamTrack);
      } else if (track.kind === Track.Kind.Audio && publication.source === Track.Source.ScreenShareAudio) {
        this.events.onScreenAudioTrack?.(participant.identity, track.mediaStreamTrack);
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (!current()) return;
      if (track.kind === Track.Kind.Audio && publication.source === Track.Source.Microphone) this.events.onTrackUnsubscribed?.(participant.identity);
      else if (publication.source === Track.Source.ScreenShare) this.events.onScreenTrack?.(participant.identity, null);
      else if (publication.source === Track.Source.ScreenShareAudio) this.events.onScreenAudioTrack?.(participant.identity, null);
    });
    room.on(RoomEvent.TrackUnpublished, (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (!current()) return;
      if (publication.source === Track.Source.ScreenShare) this.events.onScreenTrack?.(participant.identity, null);
      else if (publication.source === Track.Source.ScreenShareAudio) this.events.onScreenAudioTrack?.(participant.identity, null);
    });
    room.on(RoomEvent.ParticipantAttributesChanged, (_changed: Record<string, string>, participant: Participant) => {
      if (!current()) return;
      if (participant.identity !== room.localParticipant.identity) this.events.onAttributesChanged?.(participant.identity, participant.attributes);
    });
    room.on(RoomEvent.LocalTrackUnpublished, (publication: LocalTrackPublication) => {
      if (!current()) return;
      if (publication.source === Track.Source.ScreenShare) {
        // The video went (browser "Stop sharing", track end, our own stop): take the tab audio down with it.
        const audio = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
        if (audio?.track) void room.localParticipant.unpublishTrack(audio.track).catch(() => undefined);
        this.events.onLocalScreenShareEnded?.();
      } else if (publication.source === Track.Source.ScreenShareAudio && room.localParticipant.getTrackPublication(Track.Source.ScreenShare)) {
        this.events.onLocalScreenAudioEnded?.();
      }
    });
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      if (!current()) return;
      const currentlySpeaking = new Set(speakers.map((p) => p.identity));
      for (const identity of currentlySpeaking) {
        if (!this.knownSpeakers.has(identity)) this.events.onSpeakingChanged?.(identity, true);
      }
      for (const identity of this.knownSpeakers) {
        if (!currentlySpeaking.has(identity)) this.events.onSpeakingChanged?.(identity, false);
      }
      this.knownSpeakers.clear();
      for (const identity of currentlySpeaking) this.knownSpeakers.add(identity);
    });
    room.on(RoomEvent.ParticipantPermissionsChanged, (previous: { readonly canPublish?: boolean } | undefined, participant: Participant) => {
      if (!current() || participant !== room.localParticipant) return;
      if (previous?.canPublish === true && participant.permissions?.canPublish === false) this.events.onPublishRevoked?.();
    });
    room.on(RoomEvent.Disconnected, () => {
      if (current()) this.teardown();
    });

    try {
      await room.connect(url, token, { autoSubscribe: false });
      if (!current()) return; // left (or switched mode) while connecting
      this.setState("connected");
      for (const participant of room.remoteParticipants.values()) {
        this.events.onParticipantConnected?.(participant.identity);
        if (Object.keys(participant.attributes).length) this.events.onAttributesChanged?.(participant.identity, participant.attributes);
      }
    } catch (error) {
      if (!current()) return;
      this.teardown();
      this.setState("error");
      throw error;
    }
  }

  disconnect(): void {
    this.room?.disconnect();
    this.teardown();
  }

  /**
   * The server revoked publishing (`canPublish` false; `canSubscribe` stays). The room is
   * kept — nearby voices and the stage go on playing — but it is listen-only from now on: the microphone and any share
   * are stopped (the device is released even if the SFU already dropped the publication) and unpublished, and nothing
   * can be published on it again. Talking again takes a new full grant (a reconnect).
   */
  async dropToListenOnly(): Promise<void> {
    const room = this.room;
    if (!room) return;
    this.listenOnly = true;
    for (const source of [Track.Source.ScreenShare, Track.Source.ScreenShareAudio, Track.Source.Microphone]) {
      const track = room.localParticipant.getTrackPublication(source)?.track;
      if (!track) continue;
      track.stop();
      await room.localParticipant.unpublishTrack(track, true).catch(() => undefined);
    }
  }

  /** Identities of remote participants currently publishing a microphone track. */
  remoteSpeakers(): string[] {
    if (!this.room) return [];
    const ids: string[] = [];
    for (const participant of this.room.remoteParticipants.values()) {
      if (participant.getTrackPublication(Track.Source.Microphone)) ids.push(participant.identity);
    }
    return ids;
  }

  isAudioSubscribed(playerId: string): boolean {
    return Boolean(this.publication(playerId, Track.Source.Microphone)?.isSubscribed);
  }

  setAudioSubscribed(playerId: string, subscribed: boolean): void {
    const publication = this.publication(playerId, Track.Source.Microphone);
    if (publication && publication.isDesired !== subscribed) publication.setSubscribed(subscribed);
  }

  /** Identities of remote participants currently sharing a screen. */
  remoteScreens(): string[] {
    if (!this.room) return [];
    const ids: string[] = [];
    for (const participant of this.room.remoteParticipants.values()) {
      if (participant.getTrackPublication(Track.Source.ScreenShare)) ids.push(participant.identity);
    }
    return ids;
  }

  /**
   * (un)subscribes ONE publisher's screen share — its video and its tab audio
   * together. The caller decides who (only ever the server-named stage holder).
   *
   * After subscribing, the video publication is explicitly enabled: with `adaptiveStream` and no
   * attached element (the stage feeds a raw MediaStreamTrack into a VideoTexture), LiveKit would
   * otherwise report the track invisible and the SFU would stop forwarding it — a frozen first
   * frame. The requested layer follows the render tier.
   */
  setScreenSubscribed(playerId: string, subscribed: boolean, quality: StageVideoQuality = "high"): void {
    const video = this.publication(playerId, Track.Source.ScreenShare);
    if (video && video.isDesired !== subscribed) video.setSubscribed(subscribed);
    if (video && subscribed) {
      // Every call (both are no-ops when unchanged): a new publication, or a render tier switched mid-share, gets the
      // layer its tier asks for — the full 1080p layer on the high tier, 720p30 on the low tier.
      video.setEnabled(true);
      video.setVideoQuality(quality === "high" ? VideoQuality.HIGH : VideoQuality.MEDIUM);
    }
    const audio = this.publication(playerId, Track.Source.ScreenShareAudio);
    if (audio && audio.isDesired !== subscribed) audio.setSubscribed(subscribed);
  }

  /** Whether this client requested `playerId`'s screen-share video. Test/debug observability. */
  isScreenSubscribed(playerId: string): boolean {
    return Boolean(this.publication(playerId, Track.Source.ScreenShare)?.isDesired);
  }

  /** Publishes this participant's own app attributes (e.g. `{ voiceRange: "shout" }`). A listen-only token cannot, so it is skipped there. */
  async setOwnAttributes(attributes: Record<string, string>): Promise<void> {
    if (this.listenOnly) return;
    await this.room?.localParticipant.setAttributes(attributes);
  }

  /**
   * Captures and publishes the local microphone track if not already
   * done (the ONE point a real `getUserMedia` prompt can occur after
   * `connect()` — callers must only call this from a user gesture),
   * muted by default. Never on a listen-only connection.
   */
  async enableMicrophone(deviceId?: string): Promise<void> {
    if (!this.room) throw new Error("VoiceClient.enableMicrophone() called before connect()");
    if (this.listenOnly) throw new Error("VoiceClient.enableMicrophone() called on a listen-only connection");
    await this.room.localParticipant.setMicrophoneEnabled(true, {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId ? { deviceId } : {}),
    });
    await this.setTransmitting(false); // muted by default — see class docstring
  }

  /** Push-to-talk / open mic: mute/unmute the already-published microphone track. A no-op if the mic was never enabled. */
  async setTransmitting(transmitting: boolean): Promise<void> {
    const publication = this.room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (!publication) return;
    if (transmitting) await publication.unmute();
    else await publication.mute();
  }

  /** Available microphones (labels appear once microphone permission was granted). */
  async listMicrophones(): Promise<MediaDeviceInfo[]> {
    return Room.getLocalDevices("audioinput", false);
  }

  async switchMicrophone(deviceId: string): Promise<void> {
    await this.room?.switchActiveDevice("audioinput", deviceId);
  }

  /**
   * Shares a browser tab, a window or the whole screen onto the Watch Hall stage, WITH its audio
   * (WATCH_HALL.md, ADR-014 § 4). The browser shows its own picker and "sharing" indicator;
   * nothing is captured without that explicit choice, and callers only call this from the
   * holder's click. `displaySurface: "browser"` only pre-selects the picker's tab list — tabs,
   * windows and the screen all stay selectable.
   *
   *  - Tab audio is captured raw (no echo cancellation / noise suppression / AGC — it is music
   *    and speech from a video, not a microphone) and published as ScreenShareAudio in stereo
   *    at the music preset, without DTX.
   *  - System audio is excluded unless the holder ticked "Share my computer's sound" —
   *    otherwise the game's own playback of other players' voices would be re-broadcast.
   *  - Quality: the share mode sets an explicit top layer (slides 1080p30 at up to
   *    3.5 Mbps, video 1080p60 at up to 7 Mbps — LiveKit's default was 1080p15 at 2.5 Mbps), the
   *    capture frame rate, the content hint, and simulcast layers at 720p30 and 360p15 for weak links
   *    and the low render tier (stageShareQuality.ts).
   *
   * Returns false if the user cancelled the picker.
   */
  async startScreenShare(options: StageShareOptions = { systemAudio: false }): Promise<boolean> {
    if (!this.room) throw new Error("not connected to voice");
    if (this.listenOnly) throw new Error("cannot share from a listen-only connection");
    const quality = stageShareQuality(options.mode ?? "slides");
    try {
      const publication = await this.room.localParticipant.setScreenShareEnabled(
        true,
        {
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          systemAudio: options.systemAudio ? "include" : "exclude",
          selfBrowserSurface: "exclude",
          surfaceSwitching: "include",
          video: { displaySurface: "browser" },
          contentHint: quality.contentHint,
          resolution: { ...quality.capture },
        },
        {
          audioPreset: AudioPresets.musicHighQualityStereo,
          dtx: false,
          forceStereo: true,
          screenShareEncoding: { ...quality.encoding, priority: "high" },
          screenShareSimulcastLayers: quality.layers.map((layer) => new VideoPreset(layer.width, layer.height, layer.maxBitrate, layer.maxFramerate)),
          degradationPreference: quality.degradationPreference,
        },
      );
      return Boolean(publication);
    } catch (error) {
      // The picker was cancelled. An operating-system block ("Permission denied by system", macOS Screen
      // Recording) is not a cancel — it is thrown so the player is told where to allow it.
      if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError") && !/system/i.test(error.message)) return false;
      throw error;
    }
  }

  async stopScreenShare(): Promise<void> {
    await this.room?.localParticipant.setScreenShareEnabled(false);
  }

  /** The local screen-share track (for a preview on the sharer's own screen), if sharing. */
  get localScreenTrack(): MediaStreamTrack | null {
    return this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track?.mediaStreamTrack ?? null;
  }

  /** Whether the local share carries an audio track (the holder ticked "Share tab audio" / system audio in the picker). */
  get hasLocalScreenAudio(): boolean {
    return Boolean(this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)?.track);
  }

  /**
   * Test/debug observability: what the browser actually captures (settings) and what each simulcast
   * encoding is limited to (RTCRtpSender parameters), plus the outbound frame rate per layer from getStats.
   */
  async localShareStats(): Promise<LocalShareStats | null> {
    const track = this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
    if (!track) return null;
    const settings = track.mediaStreamTrack.getSettings();
    const sender = track.sender;
    const encodings = (sender?.getParameters().encodings ?? []).map((encoding) => ({
      rid: encoding.rid ?? null,
      active: encoding.active !== false,
      maxBitrate: encoding.maxBitrate ?? null,
      maxFramerate: encoding.maxFramerate ?? null,
      scaleResolutionDownBy: encoding.scaleResolutionDownBy ?? null,
    }));
    const outbound: LocalShareStats["outbound"] = [];
    const report = sender ? await sender.getStats() : null;
    report?.forEach((stat: { type: string; rid?: string; frameWidth?: number; frameHeight?: number; framesPerSecond?: number }) => {
      if (stat.type === "outbound-rtp") outbound.push({ rid: stat.rid ?? null, width: stat.frameWidth ?? null, height: stat.frameHeight ?? null, fps: stat.framesPerSecond ?? null });
    });
    return {
      capture: { width: settings.width ?? null, height: settings.height ?? null, frameRate: settings.frameRate ?? null },
      contentHint: track.mediaStreamTrack.contentHint,
      encodings,
      outbound,
    };
  }

  /** Test/debug observability: the stage video this viewer receives from `playerId` (inbound-rtp). */
  async screenReceiveStats(playerId: string): Promise<StageReceiveStats | null> {
    const publication = this.publication(playerId, Track.Source.ScreenShare);
    const track = publication?.track;
    if (!publication || !track) return null;
    let inbound: StageReceiveStats["inbound"] = null;
    const report = await track.receiver?.getStats();
    report?.forEach((stat: { type: string; kind?: string; frameWidth?: number; frameHeight?: number; framesPerSecond?: number; framesDecoded?: number }) => {
      if (stat.type === "inbound-rtp" && stat.kind === "video") {
        inbound = { width: stat.frameWidth ?? null, height: stat.frameHeight ?? null, fps: stat.framesPerSecond ?? null, framesDecoded: stat.framesDecoded ?? null };
      }
    });
    return { requestedQuality: publication.videoQuality ?? null, inbound };
  }

  private publication(playerId: string, source: Track.Source): RemoteTrackPublication | undefined {
    return this.room?.remoteParticipants.get(playerId)?.getTrackPublication(source) as RemoteTrackPublication | undefined;
  }

  private teardown(): void {
    this.knownSpeakers.clear();
    this.room = null;
    this.listenOnly = false;
    this.setState("disconnected");
  }

  private setState(state: VoiceConnectionState): void {
    this.state = state;
    this.events.onStateChange?.(state);
  }
}
