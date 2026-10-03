/**
 * InputManager is the single place that touches DOM input events.
 *
 * It exposes two kinds of reads:
 *  - continuous state (`isPressed`) for movement keys held down,
 *  - discrete edge events (`wasJustPressed`) for one-shot actions like
 *    "E to interact" or "Esc to open settings",
 * plus pointer-lock-gated mouse deltas and scroll-wheel deltas for the
 * camera.
 *
 * Nothing in here knows about the player or the camera. PlayerController
 * and ThirdPersonCamera poll this class; they never attach their own
 * `addEventListener` calls. This keeps input rebinding / mobile input /
 * push-to-talk all addable later without touching gameplay code.
 */

export type GameAction = "moveForward" | "moveBackward" | "moveLeft" | "moveRight" | "jog" | "interact" | "menu" | "pushToTalk";

const KEY_TO_ACTION: Record<string, GameAction> = {
  KeyW: "moveForward",
  ArrowUp: "moveForward",
  KeyS: "moveBackward",
  ArrowDown: "moveBackward",
  KeyA: "moveLeft",
  ArrowLeft: "moveLeft",
  KeyD: "moveRight",
  ArrowRight: "moveRight",
  ShiftLeft: "jog",
  ShiftRight: "jog",
  KeyE: "interact",
  Escape: "menu",
  // CORE-004 §16: push-to-talk. Gated by the same isTextInputTarget()
  // guard every other key already goes through below — typing "v" into
  // NicknameControls must never transmit voice.
  KeyV: "pushToTalk",
};

export class InputManager {
  private readonly element: HTMLElement;

  private readonly pressed = new Set<GameAction>();
  private readonly justPressed = new Set<GameAction>();

  private mouseDeltaX = 0;
  private mouseDeltaY = 0;
  private wheelDelta = 0;
  private pointerLocked = false;

  constructor(element: HTMLElement) {
    this.element = element;

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);

    this.element.addEventListener("click", this.requestPointerLock);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
    window.addEventListener("mousemove", this.onMouseMove);
    this.element.addEventListener("wheel", this.onWheel, { passive: true });
  }

  /** Is this logical action currently held down? */
  isPressed(action: GameAction): boolean {
    return this.pressed.has(action);
  }

  /** Was this action pressed during the current frame only? Consumed by `endFrame()`. */
  wasJustPressed(action: GameAction): boolean {
    return this.justPressed.has(action);
  }

  get isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  /** Accumulated mouse movement since the last call; resets the accumulator. */
  consumeMouseDelta(): { x: number; y: number } {
    const delta = { x: this.mouseDeltaX, y: this.mouseDeltaY };
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    return delta;
  }

  /** Accumulated wheel scroll since the last call; resets the accumulator. */
  consumeWheelDelta(): number {
    const delta = this.wheelDelta;
    this.wheelDelta = 0;
    return delta;
  }

  /** Call once per frame, after all systems have polled `wasJustPressed`. */
  endFrame(): void {
    this.justPressed.clear();
  }

  exitPointerLock(): void {
    if (document.pointerLockElement === this.element) {
      document.exitPointerLock();
    }
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.element.removeEventListener("click", this.requestPointerLock);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    window.removeEventListener("mousemove", this.onMouseMove);
    this.element.removeEventListener("wheel", this.onWheel);
  }

  private requestPointerLock = (): void => {
    if (document.pointerLockElement !== this.element) {
      this.element.requestPointerLock();
    }
  };

  private onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.element;
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    // CORE-003: typing a nickname must never also move the player /
    // trigger E / start push-to-talk. This guard blocks only NEW
    // activation — see onKeyUp below for why release is never gated
    // the same way.
    if (isTextInputTarget(event.target)) return;
    const action = KEY_TO_ACTION[event.code];
    if (!action) return;
    if (!this.pressed.has(action)) {
      this.justPressed.add(action);
    }
    this.pressed.add(action);

    if (action === "menu") {
      // Esc should always release the pointer, independent of app state.
      this.exitPointerLock();
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    // Deliberately NOT gated by isTextInputTarget (CORE-004 security
    // revision — ): the guard
    // on onKeyDown already stops a NEW activation from starting while a
    // text input has focus, but a key held BEFORE focus moved into a
    // text field must still be releasable — e.g. hold V outside the
    // nickname box (push-to-talk starts), then click into the nickname
    // box while still holding V, then release V: the keyup's target is
    // now the text input, so the old guard here would silently drop the
    // release and leave push-to-talk (or, less dangerously but just as
    // wrongly, movement) stuck "pressed" forever. Clearing an action
    // that was never pressed is a harmless no-op (Set.delete on a
    // missing key), so removing this guard entirely is safe for every
    // action, not just pushToTalk.
    const action = KEY_TO_ACTION[event.code];
    if (!action) return;
    this.pressed.delete(action);
  };

  private onBlur = (): void => {
    this.pressed.clear();
  };

  private onMouseMove = (event: MouseEvent): void => {
    if (!this.pointerLocked) return;
    this.mouseDeltaX += event.movementX;
    this.mouseDeltaY += event.movementY;
  };

  private onWheel = (event: WheelEvent): void => {
    this.wheelDelta += event.deltaY;
  };
}

/** CORE-003: true while the user is typing into a text field (e.g. NicknameControls) — see the keydown/keyup guards above. */
function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}
