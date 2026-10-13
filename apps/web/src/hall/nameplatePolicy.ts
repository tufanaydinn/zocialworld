/**
 * Watch Hall nameplate policy (WATCH_HALL.md). Pure, unit-tested in
 * nameplatePolicy.test.ts; HallPresence applies it every frame.
 *
 * A full hall is 60 plates over the big screen. Inside the hall, a seated player's plate is hidden
 * beyond HALL_PLATE_RANGE_METERS (HALL_SEATED_VIEW_PLATE_RANGE_METERS while you are seated too)
 * unless they are speaking, have a hand raised, hold the stage or have the floor — the people the
 * room is paying attention to stay labelled. Overlapping plates are thinned out on screen
 * (NameplateManager's declutter).
 */

export const HALL_PLATE_RANGE_METERS = 8;
/**
 * While the local player is seated, the seated crowd around them would put 15–20 plates in a band under the screen:
 * seated plates are kept only this close (the people labelled for attention still show at any distance).
 */
export const HALL_SEATED_VIEW_PLATE_RANGE_METERS = 4;
/** A remote player counts as sitting on their seat within this distance of it (their 'sit' transform may lag the seat message). */
export const HALL_SEATED_SNAP_METERS = 0.75;

export interface HallPlateFacts {
  /** The local player is inside the hall (a member). Outside, the policy does nothing. */
  readonly inHall: boolean;
  /** The plate's player sits on a hall seat. */
  readonly seated: boolean;
  /** The local player is seated too (the shorter range applies). */
  readonly localSeated?: boolean;
  /** Metres from the local player. */
  readonly distance: number;
  readonly speaking: boolean;
  readonly handRaised: boolean;
  readonly holder: boolean;
  readonly floor: boolean;
}

export function hallPlateVisible(facts: HallPlateFacts): boolean {
  const range = facts.localSeated ? HALL_SEATED_VIEW_PLATE_RANGE_METERS : HALL_PLATE_RANGE_METERS;
  if (!facts.inHall || !facts.seated || facts.distance <= range) return true;
  return facts.speaking || facts.handRaised || facts.holder || facts.floor;
}

/** Nameplate badges: 🎤 the stage holder, 🎙 the floor (a hall-wide mic), ✋ a raised hand. */
export function hallBadge(facts: { readonly holder: boolean; readonly floor: boolean; readonly handRaised: boolean }): string {
  return `${facts.holder ? "🎤" : ""}${facts.floor ? "🎙" : ""}${facts.handRaised ? "✋" : ""}`;
}
