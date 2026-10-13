import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { GameAction } from "../input/InputManager.ts";
import { WHEEL_DEAD_ZONE_PX, WHEEL_HOLD_MS, WHEEL_POINTER_MAX_PX, accumulatePointer, wheelSliceAngle, wheelSliceAt, type WheelAction } from "./EmoteWheel.ts";

// The emote wheel's slice math and its G hold / tap / release rules.

/** Screen-space pick vector (dx right, dy down) at `degrees` clockwise from straight up. */
function towards(degrees: number, radius = 100): [number, number] {
  const angle = (degrees * Math.PI) / 180;
  return [Math.sin(angle) * radius, -Math.cos(angle) * radius];
}

test("wheelSliceAt: slice 0 is centred straight up, indices run clockwise, the dead zone picks nothing", () => {
  // Six main slices of 60°: Wave (up), Dance, Cheer, Stop (down), Reactions, Hand.
  const cases: [number, number][] = [[0, 0], [25, 0], [35, 1], [60, 1], [85, 1], [95, 2], [180, 3], [215, 4], [240, 4], [265, 4], [275, 5], [300, 5], [335, 0], [359, 0]];
  for (const [degrees, slice] of cases) assert.equal(wheelSliceAt(...towards(degrees), 6), slice, `${degrees}°`);
  assert.equal(wheelSliceAt(...towards(10, WHEEL_DEAD_ZONE_PX - 1), 6), -1, "inside the dead zone");
  assert.equal(wheelSliceAt(...towards(10, WHEEL_DEAD_ZONE_PX + 1), 6), 0);
  assert.equal(wheelSliceAt(0, -100, 0), -1, "no slices");
  // Eight reaction slices of 45°.
  assert.equal(wheelSliceAt(...towards(44), 8), 1);
  assert.equal(wheelSliceAt(...towards(350), 8), 0);
  assert.equal(wheelSliceAt(...towards(320), 8), 7);
});

test("wheelSliceAt agrees with wheelSliceAngle for every slice of the main wheel and the 8-reaction sub-wheel", () => {
  for (const count of [6, 8]) {
    for (let index = 0; index < count; index++) {
      const angle = wheelSliceAngle(index, count);
      assert.equal(wheelSliceAt(Math.sin(angle) * 90, -Math.cos(angle) * 90, count), index, `slice ${index}/${count}`);
    }
  }
});

test("accumulatePointer adds pointer-lock movement and clamps the pick vector, so turning back is immediate", () => {
  let pick = { x: 0, y: 0 };
  pick = accumulatePointer(pick, 30, 0);
  assert.deepEqual(pick, { x: 30, y: 0 });
  pick = accumulatePointer(pick, 500, 0);
  assert.deepEqual(pick, { x: WHEEL_POINTER_MAX_PX, y: 0 });
  // From the clamp, one opposite flick of the clamp radius crosses back to the other side.
  pick = accumulatePointer(pick, -2 * WHEEL_POINTER_MAX_PX, 0);
  assert.equal(pick.x, -WHEEL_POINTER_MAX_PX);
  pick = accumulatePointer(pick, 0, 12);
  assert.equal(wheelSliceAt(pick.x, pick.y, 6), 4, "left and a little down: Reactions");
});

/** A fake InputManager: `press`/`release` set the state for the next `update`. */
function fakeInput() {
  const pressed = new Set<GameAction>();
  const just = new Set<GameAction>();
  let mouse = { x: 0, y: 0 };
  return {
    locked: false,
    press(action: GameAction) {
      if (!pressed.has(action)) just.add(action);
      pressed.add(action);
    },
    release(action: GameAction) {
      pressed.delete(action);
    },
    move(x: number, y: number) {
      mouse = { x: mouse.x + x, y: mouse.y + y };
    },
    endFrame() {
      just.clear();
    },
    api() {
      return {
        isPressed: (action: GameAction) => pressed.has(action),
        wasJustPressed: (action: GameAction) => just.has(action),
        isPointerLocked: this.locked,
        consumeMouseDelta: () => {
          const delta = mouse;
          mouse = { x: 0, y: 0 };
          return delta;
        },
      };
    },
  };
}

async function withDom<T>(run: (container: HTMLElement) => Promise<T> | T): Promise<T> {
  const dom = new JSDOM("<!DOCTYPE html><html><body><div id=app></div></body></html>", { pretendToBeVisual: true, url: "http://localhost" });
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = { document: globals.document, window: globals.window, requestAnimationFrame: globals.requestAnimationFrame, HTMLElement: globals.HTMLElement };
  globals.document = dom.window.document;
  globals.window = dom.window;
  globals.HTMLElement = dom.window.HTMLElement;
  globals.requestAnimationFrame = (callback: FrameRequestCallback) => dom.window.requestAnimationFrame(callback);
  try {
    return await run(dom.window.document.getElementById("app")!);
  } finally {
    Object.assign(globals, saved);
    dom.window.close();
  }
}

test("EmoteWheel: a quick tap of G waves; holding ≥ 180 ms opens the wheel; releasing on a slice runs it", async () => {
  await withDom(async (container) => {
    const { EmoteWheel } = await import("./EmoteWheel.ts");
    const actions: WheelAction[] = [];
    let inHall = false;
    const wheel = new EmoteWheel({ container, inHall: () => inHall, handRaised: () => false, onAction: (action) => actions.push(action) });
    const input = fakeInput();

    // Tap: pressed and released within one frame.
    input.press("emoteWheel");
    input.release("emoteWheel");
    wheel.update(input.api(), 1000);
    input.endFrame();
    assert.deepEqual(actions, [{ kind: "emote", emote: "wave" }]);
    assert.equal(wheel.isOpen, false);

    // Hold: not open before 180 ms, open after.
    input.press("emoteWheel");
    wheel.update(input.api(), 2000);
    input.endFrame();
    wheel.update(input.api(), 2000 + WHEEL_HOLD_MS - 1);
    assert.equal(wheel.isOpen, false);
    wheel.update(input.api(), 2000 + WHEEL_HOLD_MS);
    assert.equal(wheel.isOpen, true);

    // Pointer lock: movement toward the upper right (slice 1) highlights Dance; releasing G dances.
    input.locked = true;
    input.move(60, -35);
    wheel.update(input.api(), 2300);
    assert.equal(wheel.highlightedLabel, "Dance");
    input.release("emoteWheel");
    wheel.update(input.api(), 2350);
    assert.equal(wheel.isOpen, false);
    assert.deepEqual(actions.at(-1), { kind: "emote", emote: "dance" });

    // Releasing in the dead zone cancels.
    input.press("emoteWheel");
    wheel.update(input.api(), 3000);
    input.endFrame();
    wheel.update(input.api(), 3300);
    assert.equal(wheel.isOpen, true);
    input.move(10, 5);
    wheel.update(input.api(), 3320);
    input.release("emoteWheel");
    wheel.update(input.api(), 3340);
    assert.equal(wheel.isOpen, false);
    assert.equal(actions.length, 2);

    // Outside the hall the hand slice is greyed: releasing on it does nothing.
    input.press("emoteWheel");
    wheel.update(input.api(), 4000);
    input.endFrame();
    wheel.update(input.api(), 4300);
    input.move(-60, -35); // upper left: slice 5 (Raise hand)
    wheel.update(input.api(), 4320);
    assert.equal(wheel.highlightedLabel, "Raise hand");
    input.release("emoteWheel");
    wheel.update(input.api(), 4340);
    assert.equal(actions.length, 2);

    // In the hall: Reactions ▸ (lower left, slice 4) turns to the sub-wheel, which waits for a pick.
    inHall = true;
    input.press("emoteWheel");
    wheel.update(input.api(), 5000);
    input.endFrame();
    wheel.update(input.api(), 5300);
    input.move(-60, 35);
    wheel.update(input.api(), 5320);
    assert.equal(wheel.highlightedLabel, "Reactions ▸");
    input.release("emoteWheel");
    wheel.update(input.api(), 5340);
    assert.equal(wheel.isOpen, true);
    assert.equal(wheel.currentPage, "reactions");
    input.move(0, -80); // straight up: the first reaction (clap)
    wheel.update(input.api(), 5400);
    assert.equal(wheel.highlightedLabel, "Clap");
    input.press("emoteWheel"); // G in the sub-wheel sends the highlighted reaction
    wheel.update(input.api(), 5450);
    input.endFrame();
    input.release("emoteWheel");
    wheel.update(input.api(), 5500);
    assert.deepEqual(actions.at(-1), { kind: "react", reaction: "clap" });
    assert.equal(wheel.isOpen, false);
    assert.equal(actions.length, 3, "the release after a sub-wheel pick does not also wave");

    // Esc closes an open wheel.
    wheel.open("click");
    input.press("menu");
    wheel.update(input.api(), 6000);
    input.endFrame();
    assert.equal(wheel.isOpen, false);
    wheel.dispose();
  });
});

test("EmoteController.openReactions (Discussion Corner → Live Chat & Reactions): the reactions sub-wheel for a click, in the hall only", async () => {
  await withDom(async (container) => {
    const { EmoteController } = await import("./Emotes.ts");
    let inHall = false;
    const sent: unknown[] = [];
    const emotes = new EmoteController({
      container,
      inHall: () => inHall,
      handRaised: () => false,
      send: (message) => sent.push(message),
      playEmote: () => undefined,
      showOwnReaction: () => undefined,
      announce: () => undefined,
    });
    emotes.openReactions();
    assert.equal(emotes.wheel.isOpen, false, "outside the hall nothing opens");

    inHall = true;
    emotes.openReactions();
    assert.equal(emotes.wheel.isOpen, true);
    assert.equal(emotes.wheel.currentPage, "reactions");
    const root = container.querySelector(".zw-emote-wheel")!;
    assert.equal(root.getAttribute("aria-label"), "Reactions");
    assert.ok(root.classList.contains("zw-emote-click"), "waits for a click (no G held)");
    assert.equal(container.querySelectorAll(".zw-emote-wheel button").length, 8);
    emotes.dispose();
  });
});

test("EmoteWheel keyboard: a click-mode wheel takes focus, arrows turn it (never reaching the world), Enter runs; hold-mode arrows pick for the G release", async () => {
  await withDom(async (container) => {
    const { EmoteWheel } = await import("./EmoteWheel.ts");
    const actions: WheelAction[] = [];
    let closed = 0;
    const wheel = new EmoteWheel({ container, inHall: () => false, handRaised: () => false, onAction: (action) => actions.push(action), onClose: () => closed++ });
    const worldKeys: string[] = [];
    window.addEventListener("keydown", (event) => worldKeys.push(event.key)); // InputManager listens here (bubble phase)
    const key = (name: string) => document.activeElement!.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));

    wheel.open("click");
    assert.equal(document.activeElement?.getAttribute("aria-label"), "Wave", "focus moves to the first slice");
    assert.equal(wheel.highlightedLabel, "Wave");
    key("ArrowRight");
    assert.equal(document.activeElement?.getAttribute("aria-label"), "Dance");
    key("ArrowRight");
    key("ArrowLeft");
    assert.equal(wheel.highlightedLabel, "Dance");
    key("End");
    assert.equal(wheel.highlightedLabel, "Raise hand");
    key("Home");
    key("ArrowDown");
    assert.equal(wheel.highlightedLabel, "Dance");
    assert.deepEqual(worldKeys, [], "arrow keys never reach the world while the wheel is open");
    (document.activeElement as HTMLButtonElement).click(); // Enter / Space on a focused button
    assert.deepEqual(actions, [{ kind: "emote", emote: "dance" }]);
    assert.equal(wheel.isOpen, false);
    assert.equal(closed, 1, "onClose fires (Emotes returns focus to the 😀 button)");

    // Hold mode: arrows move the highlight, releasing G runs it.
    const input = fakeInput();
    input.press("emoteWheel");
    wheel.update(input.api(), 1000);
    input.endFrame();
    wheel.update(input.api(), 1000 + WHEEL_HOLD_MS);
    assert.equal(wheel.isOpen, true);
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    assert.equal(wheel.highlightedLabel, "Dance");
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    assert.equal(wheel.highlightedLabel, "Cheer");
    input.release("emoteWheel");
    wheel.update(input.api(), 1400);
    assert.deepEqual(actions.at(-1), { kind: "emote", emote: "cheer" });
    wheel.dispose();
  });
});

test("EmoteWheel: picking a slice by click while G is still held never reopens the wheel (only a new G press does)", async () => {
  await withDom(async (container) => {
    const { EmoteWheel } = await import("./EmoteWheel.ts");
    const actions: WheelAction[] = [];
    const wheel = new EmoteWheel({ container, inHall: () => false, handRaised: () => false, onAction: (action) => actions.push(action) });
    const input = fakeInput();
    input.locked = true;
    input.press("emoteWheel");
    wheel.update(input.api(), 1000);
    input.endFrame();
    wheel.update(input.api(), 1000 + WHEEL_HOLD_MS);
    input.move(60, -35); // Dance
    wheel.update(input.api(), 1250);
    window.dispatchEvent(new window.MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true })); // the locked click runs it
    assert.deepEqual(actions, [{ kind: "emote", emote: "dance" }]);
    assert.equal(wheel.isOpen, false);
    wheel.update(input.api(), 1600); // G still held
    assert.equal(wheel.isOpen, false, "no reopen while the same G press is held");
    input.release("emoteWheel");
    wheel.update(input.api(), 1700);
    assert.equal(actions.length, 1, "and the release neither waves nor runs anything");
    wheel.dispose();
  });
});
