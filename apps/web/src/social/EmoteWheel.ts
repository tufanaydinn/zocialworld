import { HALL_REACTIONS, type HallReaction } from "@project/shared";
import type { InputManager } from "../input/InputManager.ts";
import { injectUiStyles } from "../ui/styles.ts";

/**
 * The emote wheel (see docs/architecture/WATCH_HALL.md). Works
 * everywhere; the hall-only slices are greyed outside the Watch Hall.
 *
 *  - Hold **G** for ≥ 180 ms: a radial wheel opens at the screen centre. With pointer lock the
 *    mouse movement is accumulated into a pick direction (and kept from turning the camera);
 *    without it the cursor angle from the centre picks. Releasing G runs the highlighted slice,
 *    a click does too; Esc or releasing in the dead zone cancels. A quick tap of G waves.
 *  - Main slices: 👋 Wave, 💃 Dance, 🙌 Cheer, ⏹ Stop, 😀 Reactions ▸ (a sub-wheel with the eight
 *    hall reactions), ✋ Raise / Lower hand.
 *  - `open("click")` (the 😀 button near the chat) keeps the wheel open until a click, G or Esc.
 *
 * DOM + CSS only (zw- classes). Every label is static or set with textContent. The pure slice
 * math below is unit-tested (EmoteWheel.test.ts).
 */

export type WheelAction =
  | { readonly kind: "emote"; readonly emote: "wave" | "dance" | "cheer" }
  | { readonly kind: "stop" }
  | { readonly kind: "hand" }
  | { readonly kind: "react"; readonly reaction: HallReaction };

/** Hold G at least this long for the wheel; a shorter tap waves. */
export const WHEEL_HOLD_MS = 180;
/** Pick-vector dead zone (px): inside it nothing is highlighted and a release cancels. */
export const WHEEL_DEAD_ZONE_PX = 46;
/** Accumulated pointer-lock movement is clamped to this radius, so turning back is immediate. */
export const WHEEL_POINTER_MAX_PX = 120;

/** Reaction emoji, in HALL_REACTIONS order (keys 1–8). Ƶ is drawn in gold as the ZEC mark. */
export const REACTION_EMOJI: Readonly<Record<HallReaction, string>> = {
  clap: "👏",
  heart: "❤️",
  fire: "🔥",
  laugh: "😂",
  wow: "😮",
  party: "🎉",
  zec: "Ƶ",
  idea: "💡",
};
const REACTION_LABEL: Readonly<Record<HallReaction, string>> = {
  clap: "Clap",
  heart: "Heart",
  fire: "Fire",
  laugh: "Laugh",
  wow: "Wow",
  party: "Party",
  zec: "ZEC",
  idea: "Idea",
};

/**
 * The slice under a pick vector (dx right, dy down, in px from the centre), or -1 inside the dead
 * zone. Slice 0 is centred straight up and indices run clockwise.
 */
export function wheelSliceAt(dx: number, dy: number, count: number, deadZone = WHEEL_DEAD_ZONE_PX): number {
  if (count <= 0 || Math.hypot(dx, dy) < deadZone) return -1;
  const angle = Math.atan2(dx, -dy); // 0 = up, clockwise positive
  const span = (Math.PI * 2) / count;
  const turn = (angle + span / 2 + Math.PI * 4) % (Math.PI * 2);
  return Math.floor(turn / span) % count;
}

/** Centre angle of slice `index` in radians (0 = up, clockwise). */
export function wheelSliceAngle(index: number, count: number): number {
  return (index * Math.PI * 2) / count;
}

/** Adds pointer-lock movement to the pick vector, clamped to `max` px. */
export function accumulatePointer(current: { x: number; y: number }, movementX: number, movementY: number, max = WHEEL_POINTER_MAX_PX): { x: number; y: number } {
  const x = current.x + movementX;
  const y = current.y + movementY;
  const length = Math.hypot(x, y);
  return length > max ? { x: (x / length) * max, y: (y / length) * max } : { x, y };
}

interface Slice {
  readonly icon: string;
  readonly label: string;
  readonly hint?: string;
  readonly hallOnly: boolean;
  /** null: opens the reactions sub-wheel. */
  readonly action: WheelAction | null;
}

export interface EmoteWheelOptions {
  readonly container: HTMLElement;
  /** Whether the hall-only slices work (the server counts this session as a Watch Hall member). */
  readonly inHall: () => boolean;
  readonly handRaised: () => boolean;
  readonly onAction: (action: WheelAction) => void;
  /** The wheel closed (Emotes hands keyboard focus back to the 😀 button when it opened the wheel from the keyboard). */
  readonly onClose?: () => void;
}

/** Keys that turn the highlight while the wheel is open (they never reach the world: no walking off mid-pick). */
const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown"]);
const PREVIOUS_KEYS = new Set(["ArrowLeft", "ArrowUp"]);

type Mode = "hold" | "click";
type Page = "main" | "reactions";

export class EmoteWheel {
  private readonly options: EmoteWheelOptions;
  private readonly root: HTMLDivElement;
  private readonly ring: HTMLDivElement;
  private readonly wedge: HTMLDivElement;
  private readonly pointer: HTMLDivElement;
  private readonly centerTitle: HTMLDivElement;
  private readonly centerHint: HTMLDivElement;
  private buttons: HTMLButtonElement[] = [];
  private slices: Slice[] = [];
  private openFlag = false;
  private mode: Mode = "hold";
  private page: Page = "main";
  private highlighted = -1;
  private pick = { x: 0, y: 0 };
  private gDownAt = -1;
  private pointerLocked = false;

  constructor(options: EmoteWheelOptions) {
    injectUiStyles();
    injectEmoteWheelStyles();
    this.options = options;
    this.root = document.createElement("div");
    this.root.className = "zw-ui zw-emote-wheel";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "Emote wheel");
    this.root.hidden = true;
    this.ring = document.createElement("div");
    this.ring.className = "zw-emote-ring";
    this.wedge = document.createElement("div");
    this.wedge.className = "zw-emote-wedge";
    this.pointer = document.createElement("div");
    this.pointer.className = "zw-emote-pointer";
    const center = document.createElement("div");
    center.className = "zw-emote-center";
    this.centerTitle = document.createElement("div");
    this.centerTitle.className = "zw-emote-center-title";
    this.centerHint = document.createElement("div");
    this.centerHint.className = "zw-emote-center-hint";
    center.append(this.centerTitle, this.centerHint);
    this.ring.append(this.wedge, center, this.pointer);
    this.root.append(this.ring);
    options.container.appendChild(this.root);

    this.root.addEventListener("mousemove", this.onMouseMove);
    this.root.addEventListener("click", this.onBackdropClick);
    window.addEventListener("mousedown", this.onLockedMouseDown, true);
    window.addEventListener("keydown", this.onKey, true);
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  /** The highlighted slice's label ("" when none) — for tests and debugging. */
  get highlightedLabel(): string {
    return this.highlighted >= 0 ? (this.slices[this.highlighted]?.label ?? "") : "";
  }

  get currentPage(): Page {
    return this.page;
  }

  /**
   * Opens the wheel (the main page unless told otherwise). "hold": G is held (release picks). "click": stays open for a
   * click (the 😀 button, or the Discussion Corner's Live Chat & Reactions, which opens the reactions page directly).
   */
  open(mode: Mode, page: Page = "main"): void {
    this.mode = mode;
    this.openFlag = true;
    this.root.hidden = false;
    this.root.classList.toggle("zw-emote-click", mode === "click");
    this.showPage(page);
    // A click-mode wheel (the 😀 button, also from the keyboard) takes focus, so arrows and Enter work.
    if (mode === "click") this.focusSlice(this.firstEnabled());
    // Next frame, so the scale-in transition runs from the closed state.
    requestAnimationFrame(() => {
      if (this.openFlag) this.root.classList.add("visible");
    });
  }

  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    this.root.classList.remove("visible");
    this.root.hidden = true;
    this.highlighted = -1;
    // Only a NEW G press may open the wheel again (a click-run while G is still held must not reopen it).
    this.gDownAt = -1;
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.root.contains(active)) active.blur();
    this.options.onClose?.();
  }

  /**
   * Per frame, BEFORE the camera reads the mouse: G hold/tap/release, Esc, and the pointer-lock
   * pick vector (consumed here while open so the camera does not turn).
   */
  update(input: Pick<InputManager, "isPressed" | "wasJustPressed" | "isPointerLocked" | "consumeMouseDelta">, now = performance.now()): void {
    this.pointerLocked = input.isPointerLocked;
    if (this.openFlag && input.wasJustPressed("menu")) {
      this.close();
      this.gDownAt = -1;
      return;
    }
    const held = input.isPressed("emoteWheel");
    if (input.wasJustPressed("emoteWheel")) {
      if (this.openFlag && this.mode === "click") {
        // G while a click-mode wheel (the button, or the reactions sub-wheel) is open runs the highlighted slice.
        this.runHighlighted();
        return;
      }
      this.gDownAt = now;
    }
    if (this.gDownAt >= 0) {
      if (held) {
        if (!this.openFlag && now - this.gDownAt >= WHEEL_HOLD_MS) this.open("hold");
      } else {
        this.gDownAt = -1;
        if (!this.openFlag) this.options.onAction({ kind: "emote", emote: "wave" }); // a quick tap waves
        else if (this.mode === "hold") this.runHighlighted();
      }
    }
    if (this.openFlag && input.isPointerLocked) {
      const delta = input.consumeMouseDelta();
      if (delta.x !== 0 || delta.y !== 0) {
        this.pick = accumulatePointer(this.pick, delta.x, delta.y);
        this.setHighlight(wheelSliceAt(this.pick.x, this.pick.y, this.slices.length));
      }
    }
    if (this.openFlag) this.renderPointer();
  }

  dispose(): void {
    this.root.removeEventListener("mousemove", this.onMouseMove);
    this.root.removeEventListener("click", this.onBackdropClick);
    window.removeEventListener("mousedown", this.onLockedMouseDown, true);
    window.removeEventListener("keydown", this.onKey, true);
    this.root.remove();
  }

  private showPage(page: Page): void {
    this.page = page;
    this.slices = page === "main" ? this.mainSlices() : this.reactionSlices();
    this.pick = { x: 0, y: 0 };
    this.highlighted = -1;
    for (const button of this.buttons) button.remove();
    this.buttons = this.slices.map((slice, index) => this.sliceButton(slice, index));
    this.ring.classList.toggle("zw-emote-sub", page === "reactions");
    this.root.setAttribute("aria-label", page === "main" ? "Emote wheel" : "Reactions");
    this.setHighlight(-1);
  }

  private mainSlices(): Slice[] {
    const raised = this.options.handRaised();
    return [
      { icon: "👋", label: "Wave", hint: "tap G", hallOnly: false, action: { kind: "emote", emote: "wave" } },
      { icon: "💃", label: "Dance", hallOnly: false, action: { kind: "emote", emote: "dance" } },
      { icon: "🙌", label: "Cheer", hallOnly: false, action: { kind: "emote", emote: "cheer" } },
      { icon: "⏹", label: "Stop", hallOnly: false, action: { kind: "stop" } },
      { icon: "😀", label: "Reactions ▸", hint: "1–8", hallOnly: true, action: null },
      { icon: "✋", label: raised ? "Lower hand" : "Raise hand", hint: "H", hallOnly: true, action: { kind: "hand" } },
    ];
  }

  private reactionSlices(): Slice[] {
    return HALL_REACTIONS.map((reaction, index) => ({
      icon: REACTION_EMOJI[reaction],
      label: REACTION_LABEL[reaction],
      hint: String(index + 1),
      hallOnly: true,
      action: { kind: "react", reaction },
    }));
  }

  private sliceButton(slice: Slice, index: number): HTMLButtonElement {
    const enabled = !slice.hallOnly || this.options.inHall();
    const button = document.createElement("button");
    button.type = "button";
    button.className = `zw-emote-slice${enabled ? "" : " zw-emote-disabled"}${slice.icon === "Ƶ" ? " zw-emote-zec" : ""}`;
    const angle = wheelSliceAngle(index, this.slices.length);
    const radius = this.page === "main" ? 108 : 112;
    button.style.left = `calc(50% + ${(Math.sin(angle) * radius).toFixed(1)}px)`;
    button.style.top = `calc(50% - ${(Math.cos(angle) * radius).toFixed(1)}px)`;
    const icon = document.createElement("span");
    icon.className = "zw-emote-icon";
    icon.textContent = slice.icon;
    const label = document.createElement("span");
    label.className = "zw-emote-label";
    label.textContent = slice.label;
    button.append(icon, label);
    if (slice.hint) {
      const hint = document.createElement("span");
      hint.className = "zw-emote-key";
      hint.textContent = slice.hint;
      button.append(hint);
    }
    button.setAttribute("aria-label", enabled ? slice.label.replace(" ▸", "") : `${slice.label.replace(" ▸", "")} (only inside the Watch Hall)`);
    if (!enabled) {
      button.setAttribute("aria-disabled", "true");
      button.title = "Only inside the Watch Hall";
    }
    button.addEventListener("mouseenter", () => this.setHighlight(index));
    button.addEventListener("focus", () => this.setHighlight(index));
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setHighlight(index);
      this.runHighlighted();
    });
    this.ring.appendChild(button);
    return button;
  }

  private setHighlight(index: number): void {
    this.highlighted = index;
    this.buttons.forEach((button, i) => button.classList.toggle("active", i === index));
    const slice = index >= 0 ? this.slices[index] : undefined;
    if (slice) {
      const span = 360 / this.slices.length;
      this.wedge.style.setProperty("--zw-from", `${(index * span - span / 2).toFixed(2)}deg`);
      this.wedge.style.setProperty("--zw-span", `${span.toFixed(2)}deg`);
      this.wedge.classList.add("visible");
      const enabled = !slice.hallOnly || this.options.inHall();
      this.wedge.classList.toggle("zw-emote-wedge-off", !enabled);
      this.centerTitle.textContent = slice.label.replace(" ▸", "");
      this.centerHint.textContent = enabled ? (slice.action === null ? "Open the reactions" : this.mode === "hold" ? "Release G" : "Click") : "Only in the Watch Hall";
    } else {
      this.wedge.classList.remove("visible");
      this.centerTitle.textContent = this.page === "main" ? "Emotes" : "Reactions";
      this.centerHint.textContent = this.page === "reactions" ? "Pick one · Esc to close" : this.mode === "hold" ? "Move the mouse · release G" : "Pick one · Esc to close";
    }
  }

  private renderPointer(): void {
    const visible = this.pointerLocked && Math.hypot(this.pick.x, this.pick.y) > 4;
    this.pointer.classList.toggle("visible", visible);
    if (visible) this.pointer.style.transform = `translate(calc(-50% + ${this.pick.x.toFixed(1)}px), calc(-50% + ${this.pick.y.toFixed(1)}px))`;
  }

  /** Runs the highlighted slice: an action closes the wheel, "Reactions ▸" turns the page, none (dead zone) or a greyed slice cancels. */
  private runHighlighted(): void {
    const slice = this.highlighted >= 0 ? this.slices[this.highlighted] : undefined;
    if (!slice || (slice.hallOnly && !this.options.inHall())) {
      this.close();
      return;
    }
    if (slice.action === null) {
      this.mode = "click"; // the sub-wheel waits for a click (or G, or 1–8)
      this.root.classList.add("zw-emote-click");
      this.showPage("reactions");
      this.focusSlice(this.firstEnabled());
      return;
    }
    const action = slice.action;
    this.close();
    this.options.onAction(action);
  }

  /** Arrow keys turn the highlight (clockwise: Right/Down), Home/End jump; in click mode the focus follows, so Enter/Space run it. */
  private onKey = (event: KeyboardEvent): void => {
    if (!this.openFlag || this.slices.length === 0) return;
    const count = this.slices.length;
    let next: number;
    if (NEXT_KEYS.has(event.key)) next = this.highlighted < 0 ? 0 : (this.highlighted + 1) % count;
    else if (PREVIOUS_KEYS.has(event.key)) next = this.highlighted < 0 ? count - 1 : (this.highlighted - 1 + count) % count;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    else return;
    event.preventDefault();
    event.stopPropagation(); // captured at window: InputManager never sees it, so the player doesn't walk (and end the emote)
    if (this.mode === "click") this.focusSlice(next);
    else this.setHighlight(next);
  };

  private firstEnabled(): number {
    const index = this.slices.findIndex((slice) => !slice.hallOnly || this.options.inHall());
    return index < 0 ? 0 : index;
  }

  private focusSlice(index: number): void {
    const button = this.buttons[index];
    if (!button) return;
    button.focus({ preventScroll: true });
    this.setHighlight(index);
  }

  private onMouseMove = (event: MouseEvent): void => {
    if (!this.openFlag || this.pointerLocked) return;
    const rect = this.ring.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    const index = wheelSliceAt(dx, dy, this.slices.length);
    if (index !== this.highlighted) this.setHighlight(index);
  };

  /** A click outside the slices: the dead zone or the backdrop cancels. */
  private onBackdropClick = (event: MouseEvent): void => {
    if (!this.openFlag || this.pointerLocked) return;
    const rect = this.ring.getBoundingClientRect();
    const index = wheelSliceAt(event.clientX - (rect.left + rect.width / 2), event.clientY - (rect.top + rect.height / 2), this.slices.length);
    if (index < 0 || Math.hypot(event.clientX - (rect.left + rect.width / 2), event.clientY - (rect.top + rect.height / 2)) > rect.width / 2 + 24) {
      this.close();
      return;
    }
    this.setHighlight(index);
    this.runHighlighted();
  };

  /** Under pointer lock the cursor is hidden and clicks land on the canvas: a click runs the highlighted slice. */
  private onLockedMouseDown = (event: MouseEvent): void => {
    if (!this.openFlag || !this.pointerLocked || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.runHighlighted();
  };
}

let stylesInjected = false;

function injectEmoteWheelStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.zw-emote-wheel { position: absolute; inset: 0; z-index: 25; pointer-events: auto; }
.zw-emote-ring {
  position: absolute; left: 50%; top: 50%; width: 300px; height: 300px; border-radius: 50%;
  transform: translate(-50%, -50%) scale(0.86); opacity: 0;
  transition: transform 0.16s cubic-bezier(.2,.9,.3,1.25), opacity 0.12s ease;
  background:
    radial-gradient(circle at 50% 50%, transparent 0 61px, rgba(232,176,80,0.55) 62px 63px, transparent 64px),
    repeating-radial-gradient(circle at 38% 30%, rgba(255,214,150,0.035) 0 3px, rgba(0,0,0,0.04) 3px 7px),
    radial-gradient(circle at 50% 40%, rgba(74,46,26,0.9), rgba(30,18,10,0.92) 70%);
  border: 2px solid rgba(232,176,80,0.85);
  box-shadow: 0 0 0 5px rgba(36,22,12,0.55), 0 0 0 6px rgba(232,176,80,0.35), 0 18px 48px rgba(0,0,0,0.55), inset 0 0 28px rgba(0,0,0,0.55);
  backdrop-filter: blur(8px);
  color: #f4e3c1; font-family: "Segoe UI", system-ui, sans-serif;
}
.zw-emote-wheel.visible .zw-emote-ring { transform: translate(-50%, -50%) scale(1); opacity: 1; }
.zw-emote-ring.zw-emote-sub { width: 320px; height: 320px; }
.zw-emote-wedge {
  position: absolute; inset: 0; border-radius: 50%; opacity: 0; transition: opacity 0.1s ease;
  background: conic-gradient(from var(--zw-from, 0deg), rgba(255,196,96,0.42) 0 var(--zw-span, 60deg), transparent var(--zw-span, 60deg));
  -webkit-mask: radial-gradient(circle, transparent 0 63px, #000 64px);
  mask: radial-gradient(circle, transparent 0 63px, #000 64px);
}
.zw-emote-wedge.visible { opacity: 1; }
.zw-emote-wedge.zw-emote-wedge-off { background: conic-gradient(from var(--zw-from, 0deg), rgba(160,150,140,0.25) 0 var(--zw-span, 60deg), transparent var(--zw-span, 60deg)); }
.zw-emote-center {
  position: absolute; left: 50%; top: 50%; width: 118px; height: 118px; transform: translate(-50%, -50%);
  border-radius: 50%; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;
  background: radial-gradient(circle at 50% 35%, rgba(58,38,22,0.96), rgba(22,14,8,0.96));
  box-shadow: inset 0 0 0 1px rgba(232,176,80,0.4), inset 0 0 18px rgba(0,0,0,0.6);
  pointer-events: none;
}
.zw-emote-center-title { font: 700 17px Georgia, "Times New Roman", serif; color: #ffe2a8; text-shadow: 0 1px 2px #000; padding: 0 8px; }
.zw-emote-center-hint { margin-top: 3px; font-size: 10.5px; color: #cbb592; padding: 0 12px; line-height: 1.25; }
.zw-emote-slice {
  position: absolute; transform: translate(-50%, -50%); width: 74px; height: 64px; padding: 0; border: 0; border-radius: 14px;
  background: transparent; color: inherit; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
  font: 600 11px "Segoe UI", system-ui, sans-serif; text-shadow: 0 1px 2px #000; transition: transform 0.1s ease, color 0.1s ease;
}
.zw-emote-sub .zw-emote-slice { width: 62px; height: 58px; }
.zw-emote-slice:focus-visible { outline: 2px solid #ffd27a; outline-offset: 2px; }
.zw-emote-slice.active { color: #fff6e0; transform: translate(-50%, -50%) scale(1.12); }
.zw-emote-icon { font-size: 27px; line-height: 1.1; filter: drop-shadow(0 2px 3px rgba(0,0,0,0.6)); font-family: "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif; }
.zw-emote-sub .zw-emote-icon { font-size: 25px; }
.zw-emote-zec .zw-emote-icon { font: 700 27px Georgia, "Times New Roman", serif; color: #f2c35e; text-shadow: 0 0 8px rgba(242,195,94,0.55), 0 1px 2px #000; filter: none; }
.zw-emote-label { white-space: nowrap; }
.zw-emote-key { font-size: 9.5px; color: #c9a86a; letter-spacing: 0.04em; }
.zw-emote-disabled { color: rgba(220,205,185,0.38); cursor: not-allowed; }
.zw-emote-disabled .zw-emote-icon { filter: grayscale(1) opacity(0.45); }
.zw-emote-disabled.active { color: rgba(220,205,185,0.55); }
.zw-emote-pointer {
  position: absolute; left: 50%; top: 50%; width: 10px; height: 10px; border-radius: 50%; opacity: 0;
  background: #ffd27a; box-shadow: 0 0 10px rgba(255,200,110,0.9); pointer-events: none;
}
.zw-emote-pointer.visible { opacity: 0.9; }
@media (prefers-reduced-motion: reduce) {
  .zw-emote-ring { transition: opacity 0.12s ease; transform: translate(-50%, -50%); }
  .zw-emote-wheel.visible .zw-emote-ring { transform: translate(-50%, -50%); }
  .zw-emote-slice, .zw-emote-slice.active { transition: none; transform: translate(-50%, -50%); }
}
`;
  document.head.appendChild(style);
}
