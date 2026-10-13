import * as THREE from "three";

/** Seconds: how long a stage entry fades out before its nodes are disconnected (click-free removal). */
const STAGE_FADE_OUT_SECONDS = 0.08;

/**
 * Owns the Web Audio graph for remote voice — one `THREE.PositionalAudio`
 * node per remote participant, attached to that player's own
 * `THREE.Object3D` (same attach point `apps/web/src/audio/README.md`
 * already documented as the expected shape for positional audio, before
 * any audio code existed).
 *
 * `THREE.PositionalAudio` wraps a Web Audio `PannerNode`, which gives
 * left/right spatialization "for free" from the node's position alone.
 * Its own built-in distance
 * attenuation is deliberately disabled (`rolloffFactor = 0`) so gain is
 * driven entirely by this project's own curve
 * (`apps/web/src/voice/VoiceProximity.ts`), not the Web Audio API's
 * default linear/inverse/exponential models — see `setGain()`.
 *
 * The stage holder's tab audio plays
 * through ONE separate, non-positional entry (`THREE.Audio`, stereo kept),
 * not keyed by playerId — so it never collides with the holder's own
 * microphone node. Gain changes ramp (THREE's setTargetAtTime), and the
 * stage entry fades out before it is disconnected, so nothing clicks.
 *
 * Chromium only feeds a remote WebRTC stream into Web Audio while the
 * stream is also attached to a media element; every entry therefore keeps
 * a muted, off-DOM `<audio>` element playing the same stream (it outputs
 * nothing itself).
 *
 * Never touches the LOCAL participant's own audio — no self-voice
 * playback. Only ever called with remote tracks.
 */
export class VoiceAudioGraph {
  private readonly listener: THREE.AudioListener;
  private readonly entries = new Map<string, { audio: THREE.PositionalAudio; attachedTo: THREE.Object3D; element: HTMLAudioElement | null; gain: number }>();
  private stage: { audio: THREE.Audio; element: HTMLAudioElement | null; track: MediaStreamTrack; gain: number } | null = null;

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
   * Call this only from `VoiceSession.enableVoice()` / `enableListening()`,
   * themselves only ever invoked from a click handler ("Enable Voice",
   * "Watch the stage") — the real user gesture this needs. Without this,
   * every `setVolume()` call below schedules a Web Audio automation event
   * that a suspended context never actually processes, silently leaving
   * every node's gain stuck at its default (1) regardless of
   * distance/mute/block. `tests/e2e/voice-integration.spec.ts` covers this.
   */
  async resumeContext(): Promise<void> {
    if (this.listener.context.state === "suspended") await this.listener.context.resume();
  }

  /** Creates (or replaces) the audio node for a remote participant's subscribed track, attached to `attachTo` so its position tracks that object automatically every frame. Starts silent — callers must call `setGain()` to make it audible. */
  addRemoteTrack(playerId: string, mediaStreamTrack: MediaStreamTrack, attachTo: THREE.Object3D): void {
    this.removeRemoteTrack(playerId);

    const stream = new MediaStream([mediaStreamTrack]);
    const positionalAudio = new THREE.PositionalAudio(this.listener);
    // Disable the panner's own distance rolloff — see class docstring.
    positionalAudio.setDistanceModel("linear");
    positionalAudio.setRefDistance(1);
    positionalAudio.setRolloffFactor(0);
    positionalAudio.setMaxDistance(10000);
    positionalAudio.setMediaStreamSource(stream);
    positionalAudio.setVolume(0);

    attachTo.add(positionalAudio);
    this.entries.set(playerId, { audio: positionalAudio, attachedTo: attachTo, element: keepStreamFlowing(stream), gain: 0 });
  }

  removeRemoteTrack(playerId: string): void {
    const entry = this.entries.get(playerId);
    if (!entry) return;
    entry.attachedTo.remove(entry.audio);
    entry.audio.disconnect();
    releaseElement(entry.element);
    this.entries.delete(playerId);
  }

  /** `gain` is 0–1, the caller's already-computed value (distance attenuation × mute/block suppression) — this class has no opinion on why. */
  setGain(playerId: string, gain: number): void {
    const entry = this.entries.get(playerId);
    // VoiceSession recomputes every speaker's gain every frame; each setVolume schedules a Web Audio
    // ramp (setTargetAtTime), so a voice-connected hall queued ~60 automation events per frame for gains that had not
    // changed. Only a real change is sent (starts at 0: addRemoteTrack starts silent).
    if (!entry || Math.abs(entry.gain - gain) < 1e-4) return;
    entry.gain = gain;
    entry.audio.setVolume(gain);
  }

  has(playerId: string): boolean {
    return this.entries.has(playerId);
  }

  /** Test/debug observability only (see `VoiceSession.getGain()`) — production code only ever writes gain via `setGain()`, never reads it back. */
  getGain(playerId: string): number | undefined {
    return this.entries.get(playerId)?.audio.getVolume();
  }

  /**
   * Plays the stage holder's tab audio (non-positional, stereo), or removes it
   * (null). A new track replaces the old one. Starts silent; `setStageGain()` fades it in.
   */
  setStageTrack(track: MediaStreamTrack | null): void {
    if (this.stage?.track === track) return;
    this.removeStage();
    if (!track) return;
    const stream = new MediaStream([track]);
    const audio = new THREE.Audio(this.listener);
    audio.setMediaStreamSource(stream);
    audio.gain.gain.value = 0;
    this.stage = { audio, element: keepStreamFlowing(stream), track, gain: 0 };
  }

  /** Stage gain (0–2), already computed by the caller (stage volume × master × duck × mute). Only a changed value schedules a ramp. */
  setStageGain(gain: number): void {
    if (!this.stage || Math.abs(this.stage.gain - gain) < 1e-4) return;
    this.stage.gain = gain;
    this.stage.audio.setVolume(gain);
  }

  get hasStage(): boolean {
    return this.stage !== null;
  }

  /** The stage gain last requested (the ramp target). Test/debug observability only. */
  getStageGain(): number | undefined {
    return this.stage?.gain;
  }

  /**
   * ADR-014 § 4: while the local player shares with their computer's sound, every incoming hall
   * sound (voices and the stage) is muted at the listener, so nothing the game plays is captured
   * back into the share.
   */
  setIncomingMuted(muted: boolean): void {
    this.listener.setMasterVolume(muted ? 0 : 1);
  }

  /** Removes every remote entry and the stage, keeping the listener (voice can be enabled again). */
  clear(): void {
    for (const playerId of Array.from(this.entries.keys())) this.removeRemoteTrack(playerId);
    this.removeStage();
  }

  dispose(): void {
    this.clear();
    this.listener.parent?.remove(this.listener);
  }

  private removeStage(): void {
    const stage = this.stage;
    if (!stage) return;
    this.stage = null;
    stage.audio.setVolume(0);
    setTimeout(() => {
      stage.audio.disconnect();
      releaseElement(stage.element);
    }, STAGE_FADE_OUT_SECONDS * 1000);
  }
}

/** The muted `<audio>` element workaround (see the class docstring). Null outside a DOM. */
function keepStreamFlowing(stream: MediaStream): HTMLAudioElement | null {
  if (typeof document === "undefined") return null;
  const element = document.createElement("audio");
  element.muted = true;
  element.autoplay = true;
  element.srcObject = stream;
  void element.play().catch(() => undefined);
  return element;
}

function releaseElement(element: HTMLAudioElement | null): void {
  if (!element) return;
  element.pause();
  element.srcObject = null;
}
