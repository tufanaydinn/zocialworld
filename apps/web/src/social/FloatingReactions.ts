import * as THREE from "three";
import type { HallReaction } from "@project/shared";
import { injectUiStyles } from "../ui/styles.ts";
import { REACTION_EMOJI } from "./EmoteWheel.ts";

/**
 * Floating hall reactions: an emoji rises and fades over the
 * reacting player's head — from HallStore's reaction batches (the server's `sample`) and from this
 * player's own sends. DOM elements projected like the nameplates; at most 24 live (the oldest goes
 * first). Under prefers-reduced-motion they fade in place instead of rising.
 *
 * Nothing is logged or kept: an element lives for its animation and is removed.
 */

export const MAX_FLOATING_REACTIONS = 24;
const LIFETIME_MS = 2300;
/** Metres above the head anchor (the nameplate point) where the emoji starts. */
const HEAD_CLEARANCE = 0.25;

interface Floating {
  readonly element: HTMLDivElement;
  readonly playerId: string;
  readonly born: number;
  /** Small sideways jitter (px) so a burst from one player does not stack into one glyph. */
  readonly jitter: number;
}

export class FloatingReactions {
  private readonly container: HTMLElement;
  private readonly live: Floating[] = [];
  private readonly ndc = new THREE.Vector3();

  constructor(container: HTMLElement) {
    injectUiStyles();
    injectFloatingReactionStyles();
    this.container = container;
  }

  /** How many are on screen (tests, debugging). */
  get count(): number {
    return this.live.length;
  }

  spawn(playerId: string, reaction: HallReaction, now = performance.now()): void {
    while (this.live.length >= MAX_FLOATING_REACTIONS) this.live.shift()!.element.remove();
    const element = document.createElement("div");
    element.className = "zw-ui zw-float-reaction";
    element.setAttribute("aria-hidden", "true");
    const glyph = document.createElement("span");
    glyph.className = reaction === "zec" ? "zw-float-glyph zw-float-zec" : "zw-float-glyph";
    glyph.textContent = REACTION_EMOJI[reaction];
    element.appendChild(glyph);
    element.style.display = "none"; // placed on the next update
    this.container.appendChild(element);
    this.live.push({ element, playerId, born: now, jitter: (Math.random() - 0.5) * 34 });
  }

  /** Per frame, after the camera moved: places each reaction over its player's head (`anchorOf` → head position, or null when unknown). */
  update(camera: THREE.Camera, viewportWidth: number, viewportHeight: number, anchorOf: (playerId: string) => THREE.Vector3 | null, now = performance.now()): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const item = this.live[i]!;
      // Expired, or its player is gone: remove it.
      const anchor = now - item.born > LIFETIME_MS ? null : anchorOf(item.playerId);
      if (!anchor) {
        item.element.remove();
        this.live.splice(i, 1);
        continue;
      }
      this.ndc.copy(anchor).setY(anchor.y + HEAD_CLEARANCE).project(camera);
      if (this.ndc.z > 1 || Math.abs(this.ndc.x) > 1.2 || Math.abs(this.ndc.y) > 1.2) {
        item.element.style.display = "none";
        continue;
      }
      const x = (this.ndc.x * 0.5 + 0.5) * viewportWidth + item.jitter;
      const y = (1 - (this.ndc.y * 0.5 + 0.5)) * viewportHeight;
      item.element.style.display = "";
      item.element.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }

  dispose(): void {
    for (const item of this.live) item.element.remove();
    this.live.length = 0;
  }
}

let stylesInjected = false;

function injectFloatingReactionStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.zw-float-reaction { position: absolute; top: 0; left: 0; pointer-events: none; will-change: transform; z-index: 3; }
.zw-float-glyph {
  display: block; font-size: 30px; line-height: 1;
  font-family: "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif;
  filter: drop-shadow(0 2px 3px rgba(0,0,0,0.55));
  animation: zw-float-rise ${LIFETIME_MS}ms cubic-bezier(.2,.7,.3,1) forwards;
}
.zw-float-zec { font: 700 30px Georgia, "Times New Roman", serif; color: #f2c35e; text-shadow: 0 0 10px rgba(242,195,94,0.7), 0 1px 2px #000; filter: none; }
@keyframes zw-float-rise {
  0% { transform: translateY(6px) scale(0.55); opacity: 0; }
  12% { transform: translateY(0) scale(1.12); opacity: 1; }
  22% { transform: translateY(-8px) scale(1); opacity: 1; }
  75% { opacity: 0.95; }
  100% { transform: translateY(-84px) scale(0.95); opacity: 0; }
}
@keyframes zw-float-fade {
  0% { opacity: 0; }
  12% { opacity: 1; }
  70% { opacity: 1; }
  100% { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .zw-float-glyph { animation-name: zw-float-fade; animation-timing-function: linear; }
}
`;
  document.head.appendChild(style);
}
