import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import type { GameAction } from "../input/InputManager.ts";
import type { Interactable } from "./Interactable.ts";
import { InteractionSystem, pickInteractable } from "./InteractionSystem.ts";

// ADR-014 § 9: the highest priority in range wins, ties go to the nearest (docs/protocols/multiplayer-protocol.md § Player selection).

function item(id: string, x: number, radius: number, priority?: number, onInteract: () => void = () => {}): Interactable {
  return { id, label: id, position: new THREE.Vector3(x, 0, 0), interactionRadius: radius, ...(priority === undefined ? {} : { priority }), interact: onInteract };
}

const at = (x: number): THREE.Vector3 => new THREE.Vector3(x, 0, 0);

test("without priorities the nearest in range wins", () => {
  const items = [item("far", 3, 5), item("near", 1, 5), item("out", 0.5, 0.2)];
  assert.equal(pickInteractable(at(0), items)?.id, "near");
  assert.equal(pickInteractable(at(10), items), null);
});

test("a higher priority in range beats a nearer lower one; out of range never counts", () => {
  const player = item("player", 0.3, 5); // a neighbour's 5 m card, right next to us
  const seat = item("seat", 0.8, 0.9, 2);
  const board = item("board", 2, 3, 1);
  assert.equal(pickInteractable(at(0), [player, board, seat])?.id, "seat");
  assert.equal(pickInteractable(at(0), [player, board])?.id, "board");
  // The seat's 0.9 m radius no longer reaches: the board (priority 1) wins over the player.
  assert.equal(pickInteractable(at(-0.5), [player, board, seat])?.id, "board");
});

test("ties at the same priority go to the nearest, whatever the registration order", () => {
  const a = item("a", 0.6, 0.9, 2);
  const b = item("b", -0.4, 0.9, 2);
  assert.equal(pickInteractable(at(0), [a, b])?.id, "b");
  assert.equal(pickInteractable(at(0), [b, a])?.id, "b");
  assert.equal(pickInteractable(at(0.3), [a, b])?.id, "a");
});

test("InteractionSystem.update reports the picked interactable and E acts on it only", () => {
  const system = new InteractionSystem();
  const used: string[] = [];
  system.register(item("player", 0.2, 5, undefined, () => used.push("player")));
  system.register(item("seat", 0.7, 0.9, 2, () => used.push("seat")));
  const changes: (string | null)[] = [];
  system.onNearestChange((nearest) => changes.push(nearest?.id ?? null));
  const pressed = new Set<GameAction>();
  const input = { wasJustPressed: (action: GameAction) => pressed.has(action) };

  system.update(at(0), input);
  assert.equal(system.nearest?.id, "seat");
  pressed.add("interact");
  system.update(at(0), input);
  assert.deepEqual(used, ["seat"]);

  // Seat interactables are unregistered while seated: E then opens the nearest player's card.
  system.unregister("seat");
  system.update(at(0), input);
  assert.deepEqual(used, ["seat", "player"]);
  assert.deepEqual(changes, ["seat", "player"]);
});
