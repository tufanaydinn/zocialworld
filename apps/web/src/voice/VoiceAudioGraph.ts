import * as THREE from "three";

/**
 * Owns the Web Audio graph for remote voice — one `THREE.PositionalAudio`
 * node per remote participant, attached to that player's own
 * `THREE.Object3D` (same attach point `apps/web/src/audio/README.md`
 * already documented as the expected shape for positional audio, before
 * any audio code existed).
 *
 * `THREE.PositionalAudio` wraps a Web Audio `PannerNode`, which gives
 * left/right spatialization "for free" from the node's position alone —
 * CORE-004 §14's preferred spatial audio. Its own built-in distance
 * attenuation is deliberately disabled (`rolloffFactor = 0`) so gain is
 * driven entirely by this project's own curve
 * (`apps/web/src/voice/VoiceProximity.ts`), not the Web Audio API's
 * default linear/inverse/exponential models — see `setGain()`.
 *
 * Never touches the LOCAL participant's own audio — CORE-004 §25, no
 * self-voice playback. Only ever called with remote tracks.
 */
export class VoiceAudioGraph {
  private readonly listener: THREE.AudioListener;
  private readonly entries = new Map<string, { audio: THREE.PositionalAudio; attachedTo: THREE.Object3D }>();

  constructor(camera: THREE.Camera) {
    this.listener = new THREE.AudioListener();
    camera.add(this.listener);
  }

  /**
   * Resumes the underlying Web Audio `AudioContext` if the browser
   * created it in a `"suspended"` state (Chromium's/most browsers'
   * autoplay policy: a *new* `AudioContext` starts suspended until
   * resumed from inside a genuine user-gesture call stack — three.js's
   * own `THREE.AudioContext` singleton does not do this automatically).
   * Call this only from `VoiceSession.enableVoice()`, itself only ever
   * invoked from the "Enable Voice" button's click handler — the real
   * user gesture this needs. Without this, every `setVolume()` call
   * below schedules a Web Audio automation event that a suspended
   * context never actually processes, silently leaving every node's
   * gain stuck at its default (1) regardless of distance/mute/block —
   * this was caught by this task's own real two-client integration test
   * (`tests/e2e/voice-integration.spec.ts`), not by inspection alone.
   */
  async resumeContext(): Promise<void> {
    if (this.listener.context.state === "suspended") await this.listener.context.resume();
  }

  /** Creates (or replaces) the audio node for a remote participant's subscribed track, attached to `attachTo` so its position tracks that object automatically every frame. Starts silent — callers must call `setGain()` to make it audible. */
  addRemoteTrack(playerId: string, mediaStreamTrack: MediaStreamTrack, attachTo: THREE.Object3D): void {
    this.removeRemoteTrack(playerId);

    const positionalAudio = new THREE.PositionalAudio(this.listener);
    // Disable the panner's own distance rolloff — see class docstring.
    positionalAudio.setDistanceModel("linear");
    positionalAudio.setRefDistance(1);
    positionalAudio.setRolloffFactor(0);
    positionalAudio.setMaxDistance(10000);
    positionalAudio.setMediaStreamSource(new MediaStream([mediaStreamTrack]));
    positionalAudio.setVolume(0);

    attachTo.add(positionalAudio);
    this.entries.set(playerId, { audio: positionalAudio, attachedTo: attachTo });
  }

  removeRemoteTrack(playerId: string): void {
    const entry = this.entries.get(playerId);
    if (!entry) return;
    entry.attachedTo.remove(entry.audio);
    entry.audio.disconnect();
    this.entries.delete(playerId);
  }

  /** `gain` is 0–1, the caller's already-computed value (distance attenuation × mute/block suppression) — this class has no opinion on why. */
  setGain(playerId: string, gain: number): void {
    this.entries.get(playerId)?.audio.setVolume(gain);
  }

  has(playerId: string): boolean {
    return this.entries.has(playerId);
  }

  /** Test/debug observability only (see `VoiceSession.getGain()`) — production code only ever writes gain via `setGain()`, never reads it back. */
  getGain(playerId: string): number | undefined {
    return this.entries.get(playerId)?.audio.getVolume();
  }

  dispose(): void {
    for (const playerId of Array.from(this.entries.keys())) this.removeRemoteTrack(playerId);
    this.listener.parent?.remove(this.listener);
  }
}
