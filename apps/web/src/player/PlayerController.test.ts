import { test } from "node:test";
import assert from "node:assert/strict";
import { CollisionSystem } from "../collision/CollisionSystem.ts";
import type { GameAction } from "../input/InputManager.ts";
import { LocalPlayer } from "./LocalPlayer.ts";
import { PlayerController, type SeatPose, type StandReason } from "./PlayerController.ts";

// Seated mode and emotes in the player controller.

const SEAT: SeatPose = { id: 7, x: -1003.55, z: -5.1, yaw: 2.9, standX: -1003.55, standZ: -4.3 };
const FLOOR = 0.4;

function setup() {
  const pressed = new Set<GameAction>();
  const just = new Set<GameAction>();
  const input = { isPressed: (action: GameAction) => pressed.has(action), wasJustPressed: (action: GameAction) => just.has(action) };
  const player = new LocalPlayer();
  player.position.set(SEAT.standX, FLOOR, SEAT.standZ);
  const controller = new PlayerController(input, new CollisionSystem(), player, () => 0, () => FLOOR);
  const stands: [number, StandReason][] = [];
  controller.onStand((seat, reason) => stands.push([seat.id, reason]));
  const frame = (seconds = 1 / 30): void => {
    controller.update(seconds);
    just.clear();
  };
  const press = (action: GameAction): void => {
    pressed.add(action);
    just.add(action);
  };
  const release = (action: GameAction): void => {
    pressed.delete(action);
  };
  return { controller, player, frame, press, release, stands };
}

test("setSeat pins x, z and yaw to the seat, keeps the ground follow and plays 'sit' for as long as it lasts", () => {
  const { controller, player, frame } = setup();
  controller.setSeat(SEAT);
  assert.equal(player.position.x, SEAT.x);
  assert.equal(player.position.z, SEAT.z);
  for (let i = 0; i < 90; i++) frame(); // 3 s
  assert.equal(player.position.x, SEAT.x);
  assert.equal(player.position.z, SEAT.z);
  assert.equal(player.object.rotation.y, SEAT.yaw);
  assert.ok(Math.abs(player.position.y - FLOOR) < 1e-6, "follows the row floor");
  assert.equal(player.animation.getState(), "sit");
  assert.equal(player.animation.isSeated, true);
});

test("a movement key stands up at the seat's stand point and notifies once ('input')", () => {
  const { controller, player, frame, press, release, stands } = setup();
  controller.setSeat(SEAT);
  frame();
  press("moveForward");
  frame();
  release("moveForward");
  assert.equal(controller.seat, null);
  assert.deepEqual(stands, [[7, "input"]]);
  assert.ok(Math.abs(player.position.x - SEAT.standX) < 0.3 && Math.abs(player.position.z - SEAT.standZ) < 0.3, "at (or one step from) the stand point");
  assert.notEqual(player.animation.getState(), "sit");
  assert.equal(player.animation.isSeated, false);
  frame();
  assert.equal(stands.length, 1);
});

test("the jog key alone also stands up", () => {
  const { controller, frame, press, stands } = setup();
  controller.setSeat(SEAT);
  press("jog");
  frame();
  assert.equal(controller.seat, null);
  assert.deepEqual(stands, [[7, "input"]]);
});

test("an external teleport (portal, door, debug hook) drops the seat where the player is ('moved')", () => {
  const { controller, player, frame, stands } = setup();
  controller.setSeat(SEAT);
  frame();
  player.position.set(0, 0, -16.4);
  frame();
  assert.equal(controller.seat, null);
  assert.deepEqual(stands, [[7, "moved"]]);
  assert.ok(Math.abs(player.position.x) < 1e-6 && Math.abs(player.position.z + 16.4) < 1e-6, "not walked back to the seat");
});

test("standUp() and setSeat(null) from the seat system never notify", () => {
  const { controller, player, stands } = setup();
  controller.setSeat(SEAT);
  controller.standUp();
  assert.equal(player.position.z, SEAT.standZ);
  controller.setSeat(SEAT);
  controller.setSeat(null);
  assert.deepEqual(stands, []);
});

test("emotes: dance loops until you move, wave and cheer end by themselves, Stop ends any", () => {
  const { controller, player, frame, press, release } = setup();
  controller.playEmote("dance");
  for (let i = 0; i < 300; i++) frame(); // 10 s
  assert.equal(player.animation.getState(), "dance");
  press("moveLeft");
  frame();
  release("moveLeft");
  assert.equal(controller.emote, null);
  assert.notEqual(player.animation.getState(), "dance");

  for (let i = 0; i < 30; i++) frame(); // come to rest
  controller.playEmote("wave");
  frame();
  assert.equal(player.animation.getState(), "wave");
  for (let i = 0; i < 90; i++) frame(); // 3 s > the wave's 2.6 s
  assert.equal(player.animation.getState(), "idle");

  controller.playEmote("cheer");
  frame();
  assert.equal(player.animation.getState(), "cheer");
  controller.playEmote(null);
  frame();
  assert.equal(player.animation.getState(), "idle");
});

test("an emote while seated keeps the seat and plays over the sit pose; it ends back in 'sit'", () => {
  const { controller, player, frame, stands } = setup();
  controller.setSeat(SEAT);
  controller.playEmote("cheer");
  frame();
  assert.equal(player.animation.getState(), "cheer");
  assert.equal(player.animation.isSeated, true);
  assert.notEqual(controller.seat, null);
  for (let i = 0; i < 120; i++) frame(); // 4 s > the cheer's 3.2 s
  assert.equal(player.animation.getState(), "sit");
  assert.deepEqual(stands, []);
});
