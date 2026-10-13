import { HALL_REACTIONS, type HallClientMessage, type HallReaction } from "@project/shared";
import { REACTION_ACTIONS, type InputManager } from "../input/InputManager.ts";
import type { Emote } from "../player/PlayerController.ts";
import { injectUiStyles } from "../ui/styles.ts";
import { EmoteWheel, type WheelAction } from "./EmoteWheel.ts";

/**
 * Emotes, raised hands and reactions (docs/architecture/WATCH_HALL.md, ADR-014 § 10).
 *
 *  - The emote wheel (hold G, tap G to wave) and the small 😀 button next to the chat (in the
 *    hall) that opens it for mouse users.
 *  - Wave / Dance / Cheer / Stop are local animation states, sent in `player_transform`.
 *  - In the Watch Hall only: keys 1–8 send the eight reactions (`hall_react`) and H raises or
 *    lowers your hand (`hall_hand`). Never while typing — InputManager's keydown guard.
 *
 * Client-side token buckets mirror the server's (apps/server/src/watchHall.ts), so a reaction is
 * shown over your own head only when the server will accept it. Reactions are never logged.
 */

/** Mirrors HALL_REACT_BURST / HALL_REACT_REFILL_PER_SECOND on the server. */
const REACT_BURST = 8;
const REACT_REFILL_PER_SECOND = 3;
/** Mirrors HALL_HAND_BURST / HALL_HAND_REFILL_PER_SECOND on the server. */
const HAND_BURST = 3;
const HAND_REFILL_PER_SECOND = 0.2;

/** A small token bucket (burst, refill per second) on an injected clock. */
export class LocalBucket {
  private readonly burst: number;
  private readonly refillPerSecond: number;
  private tokens: number;
  private last: number;

  constructor(burst: number, refillPerSecond: number, now: number) {
    this.burst = burst;
    this.refillPerSecond = refillPerSecond;
    this.tokens = burst;
    this.last = now;
  }

  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.refillPerSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export interface EmoteControllerOptions {
  readonly container: HTMLElement;
  /** The server counts this session as a Watch Hall member (HallStore.member). */
  readonly inHall: () => boolean;
  readonly handRaised: () => boolean;
  /** NetworkClient.sendHall. */
  readonly send: (message: HallClientMessage) => void;
  /** PlayerController.playEmote. */
  readonly playEmote: (emote: Emote | null) => void;
  /** Shows your own reaction at once (the server's sample echo of it is skipped). */
  readonly showOwnReaction: (reaction: HallReaction) => void;
  /** A system line in chat. */
  readonly announce: (text: string) => void;
}

export class EmoteController {
  readonly wheel: EmoteWheel;
  private readonly options: EmoteControllerOptions;
  private readonly button: HTMLButtonElement;
  private readonly reactBucket: LocalBucket;
  private readonly handBucket: LocalBucket;
  private handNoticeAt = -Infinity;
  private openedByKeyboard = false;

  constructor(options: EmoteControllerOptions, now = performance.now()) {
    injectUiStyles();
    injectEmoteButtonStyles();
    this.options = options;
    this.reactBucket = new LocalBucket(REACT_BURST, REACT_REFILL_PER_SECOND, now);
    this.handBucket = new LocalBucket(HAND_BURST, HAND_REFILL_PER_SECOND, now);
    this.wheel = new EmoteWheel({
      container: options.container,
      inHall: options.inHall,
      handRaised: options.handRaised,
      onAction: (action) => this.run(action),
      onClose: () => {
        // Opened from the keyboard: focus goes back to the button, never stranded on a hidden slice.
        if (this.openedByKeyboard && !this.button.hidden) this.button.focus({ preventScroll: true });
        this.openedByKeyboard = false;
      },
    });
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "zw-ui zw-emote-button";
    this.button.textContent = "😀";
    this.button.title = "Emotes & reactions (hold G)";
    this.button.setAttribute("aria-label", "Emotes and reactions");
    this.button.hidden = true;
    this.button.addEventListener("click", (event) => {
      // A mouse click hands keyboard focus back to the world (G, E, Esc); Space/Enter on the focused button
      // (event.detail === 0) keeps the keyboard in the wheel, and focus returns to the button when it closes.
      const keyboard = event.detail === 0;
      if (!keyboard) this.button.blur();
      if (this.wheel.isOpen) this.wheel.close();
      else {
        this.openedByKeyboard = keyboard;
        this.wheel.open("click");
      }
    });
    options.container.appendChild(this.button);
  }

  /** Per frame, before the camera reads the mouse (the open wheel consumes pointer-lock movement). */
  update(input: Pick<InputManager, "isPressed" | "wasJustPressed" | "isPointerLocked" | "consumeMouseDelta">, now = performance.now()): void {
    this.wheel.update(input, now);
    const inHall = this.options.inHall();
    if (this.button.hidden === inHall) this.button.hidden = !inHall;
    if (!inHall) return;
    REACTION_ACTIONS.forEach((action, index) => {
      if (input.wasJustPressed(action)) {
        if (this.wheel.isOpen && this.wheel.currentPage === "reactions") this.wheel.close();
        this.react(HALL_REACTIONS[index]!, now);
      }
    });
    if (input.wasJustPressed("raiseHand")) this.toggleHand(now);
  }

  /** Runs one wheel slice. */
  run(action: WheelAction, now = performance.now()): void {
    switch (action.kind) {
      case "emote":
        this.options.playEmote(action.emote);
        return;
      case "stop":
        this.options.playEmote(null);
        return;
      case "hand":
        this.toggleHand(now);
        return;
      case "react":
        this.react(action.reaction, now);
        return;
      default:
        action satisfies never;
    }
  }

  /** Sends one reaction (hall only) and shows it over your own head — unless the server's bucket would drop it. */
  react(reaction: HallReaction, now = performance.now()): void {
    if (!this.options.inHall() || !this.reactBucket.take(now)) return;
    this.options.send({ type: "hall_react", reaction });
    this.options.showOwnReaction(reaction);
  }

  /** Opens the reactions sub-wheel for a click (hall only) — the Discussion Corner's Live Chat & Reactions. */
  openReactions(): void {
    if (!this.options.inHall()) return;
    this.wheel.open("click", "reactions");
  }

  /** Raises or lowers your hand (hall only). */
  toggleHand(now = performance.now()): void {
    if (!this.options.inHall()) return;
    if (!this.handBucket.take(now)) {
      if (now - this.handNoticeAt > 4000) {
        this.handNoticeAt = now;
        this.options.announce("Hand changes are limited — wait a few seconds.");
      }
      return;
    }
    this.options.send({ type: "hall_hand", raised: !this.options.handRaised() });
  }

  dispose(): void {
    this.wheel.dispose();
    this.button.remove();
  }
}

let stylesInjected = false;

function injectEmoteButtonStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.zw-emote-button {
  position: absolute; left: calc(12px + min(380px, 42vw) + 8px); bottom: 66px; z-index: 5;
  width: 40px; height: 40px; border-radius: 50%; padding: 0; cursor: pointer;
  font: 21px/1 "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif;
  color: #f4e3c1; background: radial-gradient(circle at 50% 35%, rgba(74,46,26,0.94), rgba(30,18,10,0.94));
  border: 1.5px solid rgba(232,176,80,0.85); box-shadow: 0 0 0 3px rgba(36,22,12,0.5), 0 6px 16px rgba(0,0,0,0.45);
  transition: transform 0.12s ease, box-shadow 0.12s ease;
}
.zw-emote-button:hover { transform: scale(1.08); box-shadow: 0 0 0 3px rgba(36,22,12,0.5), 0 0 14px rgba(255,200,110,0.5); }
.zw-emote-button:focus-visible { outline: 2px solid #ffd27a; outline-offset: 2px; }
@media (max-width: 720px) { .zw-emote-button { left: 12px; bottom: 70px; } }
@media (prefers-reduced-motion: reduce) { .zw-emote-button, .zw-emote-button:hover { transition: none; transform: none; } }
`;
  document.head.appendChild(style);
}
