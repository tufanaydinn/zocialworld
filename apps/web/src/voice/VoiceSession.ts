import * as THREE from "three";
import { VoiceClient, type VoiceConnectionState } from "./VoiceClient.ts";
import { VoiceAudioGraph } from "./VoiceAudioGraph.ts";
import { resolveVoiceGain } from "./VoiceProximity.ts";
import { getVoiceTokenUrl } from "./config.ts";

export interface VoiceSessionEvents {
  onStateChange?: (state: VoiceConnectionState) => void;
  onSpeakingChanged?: (playerId: string, speaking: boolean) => void;
  /** Mic permission denied/unavailable/getUserMedia failure — voice stays connected (so the user can still hear others) but can never transmit. Never thrown past this boundary — see CORE-004 §28. */
  onMicrophoneError?: (error: unknown) => void;
}

export interface VoiceSessionOptions {
  camera: THREE.Camera;
  /** Looks up the `THREE.Object3D` a remote participant's audio should be attached to (i.e. the matching `RemotePlayer.object`) — `undefined` if that player isn't currently visible. */
  getRemotePlayerObject: (playerId: string) => THREE.Object3D | undefined;
  isMuted: (playerId: string) => boolean;
  isBlocked: (playerId: string) => boolean;
}

/**
 * The voice orchestration layer — ties `VoiceClient` (SFU connection),
 * `VoiceAudioGraph` (Web Audio spatialization), `VoiceProximity`
 * (distance → gain), and the existing `SocialStore` mute/block state
 * together. `App.ts` only ever talks to this class, the same way it
 * only ever talks to `RemotePlayerManager` rather than individual
 * `RemotePlayer`s (CORE-002/003's established composition pattern).
 */
export class VoiceSession {
  private readonly client: VoiceClient;
  private readonly audioGraph: VoiceAudioGraph;
  private readonly options: VoiceSessionOptions;
  private readonly events: VoiceSessionEvents;
  private readonly speakingPlayerIds = new Set<string>();
  private readonly subscribedPlayerIds = new Set<string>();
  private transmitting = false;

  constructor(options: VoiceSessionOptions, events: VoiceSessionEvents) {
    this.options = options;
    this.events = events;
    this.audioGraph = new VoiceAudioGraph(options.camera);
    this.client = new VoiceClient({
      onStateChange: (state) => this.events.onStateChange?.(state),
      onParticipantDisconnected: (playerId) => this.handleParticipantLeft(playerId),
      onTrackSubscribed: (playerId, track) => this.handleTrackSubscribed(playerId, track),
      onTrackUnsubscribed: (playerId) => this.handleTrackUnsubscribed(playerId),
      onSpeakingChanged: (playerId, speaking) => {
        if (speaking) this.speakingPlayerIds.add(playerId);
        else this.speakingPlayerIds.delete(playerId);
        this.events.onSpeakingChanged?.(playerId, speaking);
      },
    });
  }

  get connectionState(): VoiceConnectionState {
    return this.client.connectionState;
  }

  get isTransmitting(): boolean {
    return this.transmitting;
  }

  isSpeaking(playerId: string): boolean {
    return this.speakingPlayerIds.has(playerId);
  }

  /** Which remote participants currently have a subscribed, gain-controlled audio track attached. Primarily a test/debug observability hook (see `window.__voiceSession` in dev builds, `tests/e2e/voice.spec.ts`) — production code has no need to enumerate this itself. */
  getSubscribedPlayerIds(): string[] {
    return Array.from(this.subscribedPlayerIds);
  }

  /** The last gain value `update()` applied for this remote participant, if subscribed. Test/debug observability only — see `VoiceAudioGraph.getGain()`. */
  getGain(playerId: string): number | undefined {
    return this.audioGraph.getGain(playerId);
  }

  /**
   * Explicit user-gesture entry point (CORE-004 §18) — must only be
   * called from a click handler or equivalent, never automatically on
   * load (CORE-004 §17: "Do NOT request microphone permission
   * immediately on page load"). Requests a scoped voice token from the
   * application server, connects to the SFU, then captures (muted) the
   * microphone — see `VoiceClient.enableMicrophone()`.
   *
   * `capability` is the opaque, owner-only value `WelcomeMessage`
   * carries (CORE-004 security revision) — this is the ONLY thing sent
   * to `/voice/token`. There is no `playerId`/nickname parameter here
   * on purpose: the server resolves the authoritative identity from the
   * capability itself (`WorldServer.resolveVoiceSession`), so a
   * compromised or modified client has nothing to lie about — there is
   * no client-asserted identity field left for it to lie *in*. See
   * `docs/privacy/VOICE_THREAT_MODEL.md` § Voice capability authentication.
   */
  async enableVoice(capability: string): Promise<void> {
    // Must happen inside this same user-gesture call stack — see
    // VoiceAudioGraph.resumeContext()'s docstring for why a suspended
    // AudioContext silently breaks every gain change.
    await this.audioGraph.resumeContext();

    const response = await fetch(getVoiceTokenUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability }),
    });
    if (!response.ok) throw new Error(`voice token request failed: HTTP ${response.status}`);
    const { token, url } = (await response.json()) as { token: string; url: string };

    await this.client.connect(url, token);

    try {
      await this.client.enableMicrophone();
    } catch (error) {
      // Mic denied/unavailable: stay connected (the user can still hear
      // others) but transmitting is simply never possible. Must never
      // break voice-connected state or the rest of the app.
      this.events.onMicrophoneError?.(error);
    }
  }

  disableVoice(): void {
    this.client.disconnect();
    this.audioGraph.dispose();
    this.speakingPlayerIds.clear();
    this.subscribedPlayerIds.clear();
    this.transmitting = false;
  }

  /** Push-to-talk — hold to transmit, release to stop. A no-op if the mic was never successfully captured (e.g. permission was denied). */
  async setTransmitting(transmitting: boolean): Promise<void> {
    if (this.transmitting === transmitting) return;
    this.transmitting = transmitting;
    await this.client.setTransmitting(transmitting);
  }

  /**
   * Call once per render frame with the local player's current world
   * position — recomputes every subscribed remote participant's gain
   * from distance (CORE-004 §13) and applies mute/block suppression
   * (CORE-004 §22/§23). Mute/block are checked here, every frame,
   * rather than once at subscribe time, so a block/mute/unmute applied
   * mid-conversation takes effect immediately without needing to
   * re-subscribe.
   */
  update(localPosition: THREE.Vector3): void {
    for (const playerId of this.subscribedPlayerIds) {
      const remoteObject = this.options.getRemotePlayerObject(playerId);
      if (!remoteObject) continue; // player not currently visible — leave its gain as-is, it'll be cleaned up on participantDisconnected

      const distance = localPosition.distanceTo(remoteObject.position);
      const suppression = { muted: this.options.isMuted(playerId), blocked: this.options.isBlocked(playerId) };
      this.audioGraph.setGain(playerId, resolveVoiceGain(distance, suppression));
    }
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
  }
}
