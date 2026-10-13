import type * as THREE from "three";
import type { RemotePlayerManager } from "../networking/RemotePlayerManager.ts";
import type { PlayerAnimation } from "../player/PlayerAnimation.ts";
import type { FloatingReactions } from "../social/FloatingReactions.ts";
import type { HallSeat } from "../world/hall/hallGeometry.ts";
import type { HallStore } from "./HallStore.ts";
import { HALL_SEATED_SNAP_METERS, hallBadge, hallPlateVisible } from "./nameplatePolicy.ts";

/**
 * Puts the Watch Hall state on the avatars and nameplates (WATCH_HALL.md):
 *
 *  - seated players (HallStore seats) play emotes over the Sit pose;
 *  - raised hands (HallStore.hands) get the arm-up override — remote players and your own avatar;
 *  - nameplate badges: 🎤 stage holder, 🎙 floor, ✋ raised hand;
 *  - the hall nameplate policy (seated and further than 8 m: hidden unless speaking, hand up,
 *    holder or floor — nameplatePolicy.ts);
 *  - floating reactions from the server's reaction batches (your own are shown when sent, so the
 *    echo is skipped; blocked players' are never shown).
 *
 * Reads HallStore only; sends nothing. Outside the hall everything is cleared.
 */

export interface HallPresenceOptions {
  readonly hall: HallStore;
  /** The hall's seats: a player counts as seated while close to the seat HallStore gives them. */
  readonly seats: readonly HallSeat[];
  readonly players: Pick<RemotePlayerManager, "all" | "setBadge" | "setNameplateCulled" | "setNameplateDeclutter">;
  readonly localAnimation: Pick<PlayerAnimation, "setHandRaised">;
  /** The local player's position (live vector). */
  readonly localPosition: THREE.Vector3;
  readonly reactions: Pick<FloatingReactions, "spawn">;
  readonly isBlocked: (playerId: string) => boolean;
  /** Whether the local player is seated (the shorter seated-view plate range). */
  readonly localSeated?: () => boolean;
}

export class HallPresence {
  private readonly options: HallPresenceOptions;
  private readonly seats: ReadonlyMap<number, HallSeat>;
  private readonly unsubscribe: () => void;

  constructor(options: HallPresenceOptions) {
    this.options = options;
    this.seats = new Map(options.seats.map((seat) => [seat.id, seat]));
    this.unsubscribe = options.hall.subscribe((event) => {
      if (event.type !== "reactions") return;
      const local = options.hall.localPlayerId;
      for (const { playerId, reaction } of event.sample) {
        if (playerId === local || options.isBlocked(playerId)) continue;
        options.reactions.spawn(playerId, reaction);
      }
    });
  }

  /** Per frame (cheap: a few map lookups per remote player). */
  update(): void {
    const { hall, players, localPosition } = this.options;
    const member = hall.member;
    const localSeated = member && (this.options.localSeated?.() ?? false);
    this.options.localAnimation.setHandRaised(member && hall.myHandRaised);
    players.setNameplateDeclutter(member);
    for (const player of players.all()) {
      const id = player.playerId;
      const position = player.object.position;
      const seatId = member ? hall.seatOf(id) : null;
      const seat = seatId === null ? undefined : this.seats.get(seatId);
      const seated = seat !== undefined && Math.hypot(position.x - seat.x, position.z - seat.z) <= HALL_SEATED_SNAP_METERS;
      const handRaised = member && hall.hasHandRaised(id);
      const holder = member && hall.isHolder(id);
      const floor = member && hall.isFloor(id);
      player.setSeated(seated);
      player.setHandRaised(handRaised);
      players.setBadge(id, hallBadge({ holder, floor, handRaised }));
      const distance = Math.hypot(position.x - localPosition.x, position.y - localPosition.y, position.z - localPosition.z);
      players.setNameplateCulled(id, !hallPlateVisible({ inHall: member, seated: seatId !== null, localSeated, distance, speaking: player.isSpeaking, handRaised, holder, floor }));
    }
  }

  dispose(): void {
    this.unsubscribe();
  }
}
