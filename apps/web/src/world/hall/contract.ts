import type * as THREE from "three";
import type { HallReaction } from "@project/shared";
import type { HallSeat } from "./hallGeometry.ts";

export type { HallSeat } from "./hallGeometry.ts";

/**
 * What a Watch Hall location hands to the rest of the client
 * (docs/architecture/WATCH_HALL.md). The hall builder owns the meshes; the
 * stage, seat, chat and watch systems only talk to these interfaces. World
 * exposes them as `world.watchHall` (null when the content has no hall).
 */

/** Destination ids the app travels to: into the hall (the Watch panel, the performance scenes) and out of its exit door. */
export const HALL_DESTINATION_ID = "watch-hall";
export const HALL_EXIT_DESTINATION_ID = "watch-hall-exit";

/** The big screen. The stage system puts the holder's video here; null restores the idle face. */
export interface HallScreenHandle {
  /** Parent inside the hall group (hidden with the location, shader-warmed with it). */
  readonly anchor: THREE.Object3D;
  /** World-space picture centre and outward normal (+z in hall space). */
  readonly center: THREE.Vector3;
  readonly normal: THREE.Vector3;
  readonly width: number;
  readonly height: number;
  /**
   * Shows a video (or any) texture on the picture, or the idle face when null. Material stays unlit, brightness ≤ 0.8,
   * fog off. A VideoTexture gets trilinear mipmaps and anisotropic filtering here, so text stays legible from the back.
   */
  setTexture(texture: THREE.Texture | null): void;
  /** Idle-face text (e.g. "Nobody on stage — request it at the podium" / "Up next: …"). */
  setIdleMessage(title: string, subtitle: string): void;
  /** Small LIVE pill in the screen's top-right corner. */
  setLive(live: boolean): void;
}

export type LiveNowKind = "stage" | "live" | "today" | "upcoming" | "replay";
export interface LiveNowEntry {
  kind: LiveNowKind;
  title: string;
  subtitle: string;
  /** "LIVE", "TODAY 15:00", "OCT 27", "REPLAY" … */
  badge: string;
  /** Right-hand chip, e.g. "👥 23" or "1:26:05". */
  meta?: string;
  /** Same-origin image URL (always the gateway media proxy) or undefined. */
  thumbUrl?: string;
}
export interface LiveNowBoardApi {
  setEntries(entries: LiveNowEntry[]): void;
  setOffline(message?: string): void;
}

export interface DiscussionLine {
  nickname: string;
  text: string;
  /** CSS colour for the nickname. */
  color: string;
  takeaway?: boolean;
}
export interface DiscussionBoardApi {
  /** `reactionLabel` names whose counts these are ("This session", "Last session" or "Last minute"). */
  setLines(lines: DiscussionLine[], reactions: Partial<Record<HallReaction, number>>, members: number, reactionLabel?: string): void;
}

export interface SpeakerCardState {
  mode: "idle" | "preparing" | "live" | "next";
  title: string;
  presenter?: string;
  speaker?: string;
  project?: string;
  /** Link kinds present on the card (drawn as icons/labels; the DOM card has the real links). */
  links?: string[];
  note?: string;
}
export interface SpeakerCardBoardApi {
  set(state: SpeakerCardState): void;
}

export interface WatchHallHandles {
  readonly screen: HallScreenHandle;
  readonly liveNow: LiveNowBoardApi;
  readonly discussion: DiscussionBoardApi;
  readonly speakerCard: SpeakerCardBoardApi;
  readonly seats: readonly HallSeat[];
  /** World position of the podium (stage). */
  readonly podium: THREE.Vector3;
}

/** Callbacks the hall builder wires into its own interactables (`wh-*`). Seats are registered by the seat system, not the builder. */
export interface WatchHallCallbacks {
  onOpenWatch(): void;
  onOpenDiscussion(): void;
  onOpenSpeakerCard(): void;
  onPodium(): void;
  onExit(): void;
  onOpenPortal(): void;
}
