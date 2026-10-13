import { WATCH_HALL_EXIT_MARGIN_METERS } from "@project/shared";
import { hallContains, seatLabel, type HallSeat } from "../world/hall/hallGeometry.ts";

/**
 * Who is in the Watch Hall, as this client sees it (docs/architecture/WATCH_HALL.md
 * "Find Your People" and the boards' member count). Membership on the server is derived from
 * poses (a social scope, not access control — ADR-005); here a remote player counts when their
 * last known position is inside the hall box (with the 2 m exit margin), or when hall state names
 * them (seat, hand, stage, floor). Seats, hands, stage and floor come from HallStore (playerIds
 * only); nicknames from presence. Pure: no DOM, no three.js scene.
 */

export interface HallPresence {
  readonly playerId: string;
  readonly nickname: string;
  readonly x: number;
  readonly z: number;
}

export interface HallPerson {
  readonly playerId: string;
  readonly nickname: string;
  readonly self: boolean;
  readonly seatId: number | null;
  /** "On stage", "Row 2 · left 3" or "Standing". */
  readonly place: string;
  /** 1-based place in the raise order, 0 when the hand is down. */
  readonly hand: number;
  readonly holder: boolean;
  readonly floor: boolean;
  readonly host: boolean;
  readonly speaking: boolean;
}

export interface HallPeopleInput {
  readonly localPlayerId: string | null;
  readonly localNickname: string;
  /** The server counts this session as a hall member. */
  readonly member: boolean;
  readonly remote: readonly HallPresence[];
  /** The hall's seats (they name a seated player's place). */
  readonly hallSeats: readonly HallSeat[];
  readonly seats: ReadonlyMap<number, string>;
  readonly hands: readonly string[];
  readonly holder: string | null;
  readonly floor: string | null;
  readonly hosts: readonly string[];
  readonly isSpeaking: (playerId: string) => boolean;
  /** Blocked players are left out (their nameplates and lines are hidden too). */
  readonly isBlocked: (playerId: string) => boolean;
}

/** Whether a remote position is inside the hall (the same box and exit margin the server uses). */
export function isInHall(x: number, z: number): boolean {
  return hallContains(x, z, WATCH_HALL_EXIT_MARGIN_METERS);
}

/** Players this client sees inside the hall, plus itself when it is a member (the boards' "in the hall" count). */
export function hallMemberCount(remote: readonly Pick<HallPresence, "x" | "z">[], member: boolean): number {
  let count = member ? 1 : 0;
  for (const player of remote) if (isInHall(player.x, player.z)) count++;
  return count;
}

/** The "Find Your People" list: presenter first, then the floor, raised hands in order, seated by seat, then everyone else by name. */
export function buildHallPeople(input: HallPeopleInput): HallPerson[] {
  const seatOf = new Map<string, number>();
  for (const [seatId, playerId] of input.seats) seatOf.set(playerId, seatId);
  const seatById = new Map(input.hallSeats.map((seat) => [seat.id, seat]));
  const placeOf = (seatId: number): string => {
    const seat = seatById.get(seatId);
    return seat ? seatLabel(seat) : "";
  };
  const named = new Set<string>([...input.seats.values(), ...input.hands, ...(input.holder ? [input.holder] : []), ...(input.floor ? [input.floor] : [])]);

  const people: HallPerson[] = [];
  const add = (playerId: string, nickname: string, self: boolean): void => {
    const seatId = seatOf.get(playerId) ?? null;
    const holder = input.holder === playerId;
    people.push({
      playerId,
      nickname,
      self,
      seatId,
      place: holder ? "On stage" : seatId !== null ? placeOf(seatId) : "Standing",
      hand: input.hands.indexOf(playerId) + 1,
      holder,
      floor: input.floor === playerId,
      host: input.hosts.includes(playerId),
      speaking: input.isSpeaking(playerId),
    });
  };
  if (input.member && input.localPlayerId) add(input.localPlayerId, input.localNickname || "You", true);
  for (const player of input.remote) {
    if (player.playerId === input.localPlayerId || input.isBlocked(player.playerId)) continue;
    if (!isInHall(player.x, player.z) && !named.has(player.playerId)) continue;
    add(player.playerId, player.nickname, false);
  }

  const rank = (person: HallPerson): number => (person.holder ? 0 : person.floor ? 1 : person.hand > 0 ? 2 : person.seatId !== null ? 3 : 4);
  return people.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (rank(a) === 2 ? a.hand - b.hand : 0) ||
      (rank(a) === 3 ? (a.seatId ?? 0) - (b.seatId ?? 0) : 0) ||
      a.nickname.localeCompare(b.nickname, undefined, { sensitivity: "base" }) ||
      a.playerId.localeCompare(b.playerId),
  );
}
