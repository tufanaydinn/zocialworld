import { WATCH_HALL_EXIT_MARGIN_METERS } from "@project/shared";
import { hallContains } from "../world/hall/hallGeometry.ts";
import { resolveSpeakerGain, shouldSubscribe, type VoiceRange } from "./VoiceProximity.ts";

/**
 * Watch Hall audio policy (ADR-014 §§ 3–5, docs/architecture/WATCH_HALL.md).
 *
 * Pure and engine-agnostic like VoiceProximity.ts: VoiceSession applies these decisions to the
 * LiveKit room and the Web Audio graph every frame, and VoiceProximity.test.ts-style unit tests
 * cover them without a browser.
 *
 *  - Stage share (ScreenShare + ScreenShareAudio): subscribed ONLY for the server-named holder,
 *    only while the local player is inside the hall and has not blocked that player. Any other
 *    screen publication in the room is never downloaded.
 *  - Stage mic: the holder's and the floor holder's microphones are heard at distance 0 by
 *    listeners inside the hall. The holder and floor come from server state (HallStore), never
 *    from a participant attribute.
 *  - Listen mode ("listen"): a listen-only connection (ADR-015: guests may listen,
 *    never talk; every guest's voice mode, and the Watch Hall's watch mode) hears nearby voices
 *    by the normal proximity rules, the stage mics and the stage — it just never publishes anything.
 */

/**
 * Voice connection modes: off, listen-only (no wallet: guests, and watch mode — ADR-014 § 5,
 * ADR-015) or full voice (wallet holders with an unlocked wallet: ADR-015, "speaking needs a
 * wallet").
 */
export type VoiceConnectionMode = "off" | "listen" | "full";

/** Stage volume is a per-device listener preference, 0–200 %. */
export const STAGE_VOLUME_DEFAULT = 1;
export const STAGE_VOLUME_MAX = 2;
/** Stage audio gain factor while the viewer's own personal player is open (ducking). */
export const STAGE_DUCK_GAIN = 0.2;
/** localStorage key for the stage volume. */
export const STAGE_VOLUME_STORAGE_KEY = "watch-hall-stage-volume-v1";

export function clampStageVolume(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) return STAGE_VOLUME_DEFAULT;
  return Math.max(0, Math.min(STAGE_VOLUME_MAX, number));
}

type VolumeStorage = Pick<Storage, "getItem" | "setItem">;

/** Reads the remembered stage volume; any storage failure (private mode, blocked storage) falls back to the default. */
export function loadStageVolume(storage: VolumeStorage | null): number {
  try {
    return clampStageVolume(storage?.getItem(STAGE_VOLUME_STORAGE_KEY) ?? undefined);
  } catch {
    return STAGE_VOLUME_DEFAULT;
  }
}

/** Remembers the stage volume on this device; failures are ignored (the value then lasts for the session). */
export function saveStageVolume(storage: VolumeStorage | null, volume: number): void {
  try {
    storage?.setItem(STAGE_VOLUME_STORAGE_KEY, String(clampStageVolume(volume)));
  } catch {
    // Storage unavailable — keep the volume for this session only.
  }
}

/**
 * Local "inside the hall" flag with the same hysteresis the server uses for membership: entered
 * at the interior box, left only beyond WATCH_HALL_EXIT_MARGIN_METERS (2 m), so standing in the
 * doorway never flaps subscriptions.
 */
export function nextInsideHall(wasInside: boolean, x: number, z: number): boolean {
  return hallContains(x, z, wasInside ? WATCH_HALL_EXIT_MARGIN_METERS : 0);
}

/** What the voice layer needs to know about the hall each frame (from HallStore + the local inside flag). */
export interface StageAudioContext {
  /** The server-named stage holder, or null. */
  readonly holder: string | null;
  /** The member given the floor (hall-wide mic), or null. */
  readonly floor: string | null;
  /** Whether the local player is inside the hall (with hysteresis). */
  readonly inside: boolean;
}

/**
 * Whether `playerId`'s microphone is heard hall-wide by this listener: the stage holder or the
 * floor, only while the listener is inside the hall, and only while the speaker's avatar is inside
 * too (`speaker`: its world x/z, null when unknown). A holder who walks out — or teleports away —
 * keeps the turn for the leave grace, but a conversation outside must never play hall-wide.
 */
export function hasStageMic(playerId: string, stage: StageAudioContext, speaker: { readonly x: number; readonly z: number } | null): boolean {
  if (!stage.inside || speaker === null || (playerId !== stage.holder && playerId !== stage.floor)) return false;
  return hallContains(speaker.x, speaker.z, WATCH_HALL_EXIT_MARGIN_METERS);
}

/** Listener-to-speaker distance used for subscription and gain: 0 for a stage mic, else the real distance. */
export function effectiveSpeakerDistance(realDistance: number, stageMic: boolean): number {
  return stageMic ? 0 : realDistance;
}

/** Subscription decision for one remote microphone. Blocked always loses; stage mics always win; otherwise proximity — in listen mode too (ADR-015). */
export function shouldSubscribeSpeaker(input: {
  readonly mode: VoiceConnectionMode;
  readonly stageMic: boolean;
  readonly blocked: boolean;
  /** Effective distance (see effectiveSpeakerDistance). Infinity when the speaker has no avatar. */
  readonly distance: number;
  readonly range: VoiceRange;
  /** Whether the track is subscribed now (hysteresis). */
  readonly currently: boolean;
}): boolean {
  if (input.blocked || input.mode === "off") return false;
  if (input.stageMic) return true;
  return shouldSubscribe(input.distance, input.range, input.currently);
}

/** Final gain for one subscribed remote microphone (0–2): the same in listen and full mode (ADR-015); mute/block always win. */
export function resolveMicGain(input: {
  readonly mode: VoiceConnectionMode;
  readonly stageMic: boolean;
  /** Effective distance (see effectiveSpeakerDistance). */
  readonly distance: number;
  readonly muted: boolean;
  readonly blocked: boolean;
  readonly range: VoiceRange;
  readonly playerVolume: number;
  readonly masterVolume: number;
}): number {
  if (input.mode === "off") return 0;
  return resolveSpeakerGain(input.distance, { muted: input.muted, blocked: input.blocked }, input.range, input.playerVolume, input.masterVolume);
}

/**
 * Which remote player's stage share this client should download: the server-named holder only,
 * while connected and inside the hall, never a blocked player and never ourselves (the holder
 * previews their own local track).
 */
export function stageSubscriptionTarget(input: {
  readonly holder: string | null;
  readonly localPlayerId: string | null;
  readonly inside: boolean;
  readonly connected: boolean;
  readonly blocked: boolean;
}): string | null {
  if (!input.connected || !input.inside || input.holder === null || input.blocked) return null;
  if (input.holder === input.localPlayerId) return null;
  return input.holder;
}

/** Stage audio gain: stageVolume × master × duck × (holder muted ? 0 : 1), clamped to 0–2. */
export function resolveStageGain(input: {
  readonly stageVolume: number;
  readonly masterVolume: number;
  readonly ducked: boolean;
  /** The listener muted the stage holder locally (SocialStore). */
  readonly holderMuted: boolean;
}): number {
  if (input.holderMuted) return 0;
  const gain = clampStageVolume(input.stageVolume) * input.masterVolume * (input.ducked ? STAGE_DUCK_GAIN : 1);
  return Math.max(0, Math.min(2, gain));
}
