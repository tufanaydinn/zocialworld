import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHallPeople, hallMemberCount, isInHall, type HallPeopleInput } from "./hallPeople.ts";
import { seatRows } from "../world/hall/hallGeometry.ts";

// "Find Your People" and the boards' member count (docs/architecture/WATCH_HALL.md).

const IN_HALL = { x: -1000, z: 0 };
const OUTSIDE = { x: 0, z: 0 };
/** Three rows of twelve seats, six either side of the aisle (ids 0–35). */
const SEATS = seatRows({
  rows: [0, 1, 2].map((r) => ({ z: -4 + 2 * r, y: 0.4 * (r + 1), standZ: -3.2 + 2 * r })),
  seatsPerBlock: 6,
  firstX: 2,
  pitch: 1.2,
  facing: { x: 0, z: -14 },
});

function input(overrides: Partial<HallPeopleInput> = {}): HallPeopleInput {
  return {
    localPlayerId: "me",
    localNickname: "Me",
    member: true,
    remote: [],
    hallSeats: SEATS,
    seats: new Map(),
    hands: [],
    holder: null,
    floor: null,
    hosts: [],
    isSpeaking: () => false,
    isBlocked: () => false,
    ...overrides,
  };
}

test("a seat id the hall does not have gets no place label", () => {
  const [person] = buildHallPeople(input({ seats: new Map([[59, "me"]]) }));
  assert.equal(person!.seatId, 59);
  assert.equal(person!.place, "");
});

test("membership by position uses the 2 m exit margin; the count adds the local member", () => {
  assert.equal(isInHall(-1000 + 21.5, 0), true, "inside the margin");
  assert.equal(isInHall(-1000 + 22.5, 0), false);
  assert.equal(hallMemberCount([IN_HALL, IN_HALL, OUTSIDE], true), 3);
  assert.equal(hallMemberCount([IN_HALL, OUTSIDE], false), 1);
  assert.equal(hallMemberCount([], true), 1);
});

test("people: presenter, floor, hands in raise order, seated by seat, then the rest by name; blocked and outside players left out", () => {
  const people = buildHallPeople(
    input({
      remote: [
        { playerId: "zed", nickname: "Zed", ...IN_HALL },
        { playerId: "amy", nickname: "amy", ...IN_HALL },
        { playerId: "bob", nickname: "Bob", ...IN_HALL },
        { playerId: "cat", nickname: "Cat", ...IN_HALL },
        { playerId: "dan", nickname: "Dan", ...IN_HALL },
        { playerId: "eve", nickname: "Eve", ...IN_HALL },
        { playerId: "far", nickname: "Far", ...OUTSIDE },
        { playerId: "blk", nickname: "Blocked", ...IN_HALL },
      ],
      seats: new Map([
        [14, "cat"],
        [3, "me"],
        [20, "blk"],
      ]),
      hands: ["eve", "dan"],
      holder: "bob",
      floor: "zed",
      hosts: ["amy"],
      isSpeaking: (id) => id === "zed",
      isBlocked: (id) => id === "blk",
    }),
  );
  assert.deepEqual(
    people.map((person) => person.playerId),
    ["bob", "zed", "eve", "dan", "me", "cat", "amy"],
  );
  const byId = new Map(people.map((person) => [person.playerId, person]));
  assert.equal(byId.get("bob")!.place, "On stage");
  assert.equal(byId.get("bob")!.holder, true);
  assert.equal(byId.get("zed")!.floor, true);
  assert.equal(byId.get("zed")!.speaking, true);
  assert.equal(byId.get("eve")!.hand, 1);
  assert.equal(byId.get("dan")!.hand, 2);
  assert.equal(byId.get("me")!.self, true);
  assert.equal(byId.get("me")!.place, "Row 1 · left 4");
  assert.equal(byId.get("cat")!.place, "Row 2 · left 3");
  assert.equal(byId.get("amy")!.host, true);
  assert.equal(byId.get("amy")!.place, "Standing");
});

test("a player named by hall state counts even before their position reaches the hall", () => {
  const people = buildHallPeople(input({ remote: [{ playerId: "late", nickname: "Late", ...OUTSIDE }], hands: ["late"] }));
  assert.deepEqual(
    people.map((person) => person.playerId),
    ["late", "me"],
  );
});

test("not a member: only remote players inside are listed, and the local nickname falls back to You", () => {
  assert.deepEqual(buildHallPeople(input({ member: false, remote: [{ playerId: "a", nickname: "A", ...IN_HALL }] })).map((person) => person.playerId), ["a"]);
  assert.equal(buildHallPeople(input({ localNickname: "" }))[0]!.nickname, "You");
});
