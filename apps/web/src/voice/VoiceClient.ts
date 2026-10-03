import { Room, RoomEvent, Track, type RemoteParticipant, type RemoteTrack } from "livekit-client";

export type VoiceConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface VoiceClientEvents {
  onStateChange?: (state: VoiceConnectionState) => void;
  /** `playerId` — LiveKit's `identity` field, which this app always sets to the multiplayer playerId (never the nickname, never a wallet identifier). See apps/server/src/voice/tokenHandler.ts. */
  onParticipantConnected?: (playerId: string) => void;
  onParticipantDisconnected?: (playerId: string) => void;
  onTrackSubscribed?: (playerId: string, track: MediaStreamTrack) => void;
  onTrackUnsubscribed?: (playerId: string) => void;
  /** Fires for every tracked participant (including the local one) whenever the active-speaker set changes. */
  onSpeakingChanged?: (playerId: string, speaking: boolean) => void;
}

/**
 * Owns the LiveKit `Room` connection and nothing else — no scene access,
 * no proximity/attenuation logic, no DOM. Same separation
 * `NetworkClient` keeps from the rest of the app (CORE-002) — see
 * `VoiceSession.ts` for the orchestration layer that reacts to this
 * class's events.
 *
 * CORE-004 §25: never attaches/plays back the local participant's own
 * audio track — only ever reads its mute state, never its audio.
 *
 * Push-to-talk is implemented as mute/unmute on an already-published
 * track (not publish/unpublish per key press) — muting just stops
 * sending RTP packets and is effectively instant, whereas publishing
 * a fresh track on every "V" press would re-negotiate media each time.
 */
export class VoiceClient {
  private room: Room | null = null;
  private state: VoiceConnectionState = "disconnected";
  private readonly events: VoiceClientEvents;
  private readonly knownSpeakers = new Set<string>();

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

  async connect(url: string, token: string): Promise<void> {
    if (this.room) return; // already connecting/connected

    this.setState("connecting");
    const room = new Room();
    this.room = room;

    room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
      this.events.onParticipantConnected?.(participant.identity);
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      this.knownSpeakers.delete(participant.identity);
      this.events.onParticipantDisconnected?.(participant.identity);
    });
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _publication, participant: RemoteParticipant) => {
      if (track.kind !== Track.Kind.Audio) return;
      this.events.onTrackSubscribed?.(participant.identity, track.mediaStreamTrack);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _publication, participant: RemoteParticipant) => {
      if (track.kind !== Track.Kind.Audio) return;
      this.events.onTrackUnsubscribed?.(participant.identity);
    });
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
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
    room.on(RoomEvent.Disconnected, () => this.teardown());

    try {
      await room.connect(url, token, { autoSubscribe: true });
      this.setState("connected");
    } catch (error) {
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
   * Captures and publishes the local microphone track if not already
   * done (this is the ONE point a real `getUserMedia` prompt can occur
   * after `connect()` — CORE-004 §18 callers must only call this from a
   * user gesture), muted by default — satisfies "microphone OFF until
   * explicit user action" even in push-to-talk mode, where the track
   * then exists but stays muted until a push-to-talk press.
   */
  async enableMicrophone(): Promise<void> {
    if (!this.room) throw new Error("VoiceClient.enableMicrophone() called before connect()");
    await this.room.localParticipant.setMicrophoneEnabled(true, {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    await this.setTransmitting(false); // muted by default — see class docstring
  }

  /** Push-to-talk: mute/unmute the already-published microphone track. A no-op if the mic was never enabled. */
  async setTransmitting(transmitting: boolean): Promise<void> {
    const publication = this.room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (!publication) return;
    if (transmitting) await publication.unmute();
    else await publication.mute();
  }

  private teardown(): void {
    this.knownSpeakers.clear();
    this.room = null;
    this.setState("disconnected");
  }

  private setState(state: VoiceConnectionState): void {
    this.state = state;
    this.events.onStateChange?.(state);
  }
}
