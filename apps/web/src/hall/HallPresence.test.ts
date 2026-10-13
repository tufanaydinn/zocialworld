import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import type { HallStateMessage } from "@project/shared";
import { HallPresence } from "./HallPresence.ts";
import { HallStore } from "./HallStore.ts";

// WATCH_HALL.md, "Stage moderation and sabotage" (spam and local block): a blocked player's reactions never
// float over the hall, and your own server echo is skipped.

const STATE: HallStateMessage = {
  type: "hall_state",
  stage: { holder: null, status: "idle", since: 0, queue: [], card: null, locked: false, audio: false },
  seats: [],
  hands: [],
  floor: null,
  hosts: [],
  host: false,
  totals: {},
  session: { id: 0, active: false },
  vote: { votes: 0, needed: 0, voted: false },
};

test("floating reactions skip blocked players and the local echo", () => {
  const hall = new HallStore();
  hall.setLocalPlayerId("me");
  hall.apply(STATE);
  const spawned: string[] = [];
  const blocked = new Set(["troll"]);
  const presence = new HallPresence({
    hall,
    seats: [],
    players: { all: () => [][Symbol.iterator](), setBadge: () => undefined, setNameplateCulled: () => undefined, setNameplateDeclutter: () => undefined },
    localAnimation: { setHandRaised: () => undefined },
    localPosition: new THREE.Vector3(),
    reactions: { spawn: (playerId, reaction) => void spawned.push(`${playerId}:${reaction}`) },
    isBlocked: (playerId) => blocked.has(playerId),
  });
  hall.apply({
    type: "hall_reactions",
    counts: { clap: 3, fire: 1 },
    sample: [
      { playerId: "troll", reaction: "clap" },
      { playerId: "me", reaction: "clap" },
      { playerId: "friend", reaction: "fire" },
      { playerId: "troll", reaction: "clap" },
    ],
    totals: {},
    session: { id: 0, active: false },
  });
  assert.deepEqual(spawned, ["friend:fire"]);
  presence.dispose();
});
