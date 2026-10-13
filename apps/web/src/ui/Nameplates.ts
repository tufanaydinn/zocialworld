import * as THREE from "three";
import { injectUiStyles } from "./styles.ts";

/** A plate further than this from the camera is hidden (its avatar is a few pixels tall by then). */
export const NAMEPLATE_MAX_DISTANCE = 80;
/** A plate's anchor may sit this far (px) outside the viewport and still be shown (the label extends around it). */
const OFFSCREEN_MARGIN = 160;
/** Size assumed for a plate not measured yet (a plate is measured once it is on screen, never while hidden). */
const FALLBACK_SIZE = { w: 80, h: 22 } as const;

interface PlateState {
  shown: boolean;
  /** The last transform written, in half pixels (a move under half a pixel is not written). */
  x: number;
  y: number;
}

interface Placement {
  id: string;
  element: HTMLDivElement;
  x: number;
  y: number;
  distance: number;
  priority: boolean;
}

/**
 * World-space name labels above remote players (a name is enough; no
 * profile UI).
 *
 * Implemented as projected DOM elements rather than
 * CSS2DRenderer/sprite text, consistent with this project's existing
 * "UI is plain DOM, the 3D canvas is just the world" architecture (see
 * `ui/styles.ts`) — no new rendering dependency for a handful of text
 * labels.
 *
 * Performance (a full Watch Hall is 60 plates): a plate's style is written only when it changes (shown/hidden,
 * or moved by half a pixel or more); plates off screen or beyond NAMEPLATE_MAX_DISTANCE are hidden; sizes for the
 * declutter are read before this frame's writes, so the browser never lays out mid-update; nothing is allocated per
 * frame.
 */
export class NameplateManager {
  private readonly container: HTMLElement;
  private readonly elements = new Map<string, HTMLDivElement>();
  /** What each plate shows (label + tag), so an unchanged `set` writes nothing. */
  private readonly contents = new Map<string, string>();
  /** Speech bubbles above heads for General/Nearby chat lines. */
  private readonly bubbles = new Map<string, { element: HTMLDivElement; until: number; shown: boolean }>();
  private readonly ndcScratch = new THREE.Vector3();
  private readonly cameraScratch = new THREE.Vector3();
  /** Plate sizes in px, measured once per label (for the hall's declutter). */
  private readonly sizes = new Map<string, { w: number; h: number }>();
  private readonly states = new Map<string, PlateState>();
  /** Declutter scratch, reused every frame. */
  private readonly placements: Placement[] = [];
  private placementCount = 0;
  private readonly boxes: number[] = [];

  constructor(container: HTMLElement) {
    injectUiStyles();
    this.container = container;
  }

  /**
   * The plate's text, and (ADR-019 § 1) an optional small tag after it — "Moderator" for a player who
   * signed in as one. Both are textContent only.
   */
  set(id: string, label: string, tag: string | null = null): void {
    let element = this.elements.get(id);
    if (!element) {
      element = document.createElement("div");
      element.className = "zw-ui zw-panel zw-nameplate";
      element.style.display = "none"; // placed by the next update
      this.container.appendChild(element);
      this.elements.set(id, element);
      this.states.set(id, { shown: false, x: Number.NaN, y: Number.NaN });
    }
    const content = tag ? `${label}\u0000${tag}` : label;
    if (this.contents.get(id) !== content) {
      this.contents.set(id, content);
      element.textContent = label;
      if (tag) {
        const badge = document.createElement("span");
        badge.className = "zw-nameplate-tag";
        badge.textContent = tag;
        element.appendChild(badge);
      }
      this.sizes.delete(id);
    }
  }

  remove(id: string): void {
    const element = this.elements.get(id);
    if (!element) return;
    element.remove();
    this.elements.delete(id);
    this.contents.delete(id);
    this.sizes.delete(id);
    this.states.delete(id);
  }

  /**
   * ADR-015: the player's avatar colour as a thin underline on the plate (CSS
   * variable `--zw-accent`). Cosmetic only — there is deliberately no wallet badge on nameplates.
   * A no-op for an id without a plate.
   */
  setAccent(id: string, color: string): void {
    this.elements.get(id)?.style.setProperty("--zw-accent", color);
  }

  /** Shows `text` in a bubble above `id`'s head for a few seconds (longer for longer lines). textContent only. */
  say(id: string, text: string): void {
    let bubble = this.bubbles.get(id);
    if (!bubble) {
      const element = document.createElement("div");
      element.className = "zw-ui zw-chat-bubble";
      element.style.display = "none";
      this.container.appendChild(element);
      bubble = { element, until: 0, shown: false };
      this.bubbles.set(id, bubble);
    }
    bubble.element.textContent = text.length > 120 ? `${text.slice(0, 119)}…` : text;
    bubble.until = performance.now() + Math.min(9000, 3500 + text.length * 45);
  }

  /**
   * Call once per frame, after the camera's matrices are up to date, for every currently tracked id.
   * `hidden` (the hall's distance policy for seated players) hides the plate but not a speech bubble.
   * `declutter` (in the hall): plates are placed nearest first — `priority` ones (a badge, speaking)
   * before everyone — and a plate whose box would overlap one already placed is skipped this frame, so a seated
   * crowd never piles its names on top of each other.
   */
  update(
    entries: ReadonlyArray<{ id: string; headPosition: THREE.Vector3; hidden?: boolean; priority?: boolean }>,
    camera: THREE.Camera,
    viewportWidth: number,
    viewportHeight: number,
    declutter = false,
  ): void {
    const now = performance.now();
    camera.getWorldPosition(this.cameraScratch);
    for (const [id, bubble] of this.bubbles) {
      if (bubble.until < now) {
        bubble.element.remove();
        this.bubbles.delete(id);
      }
    }
    // Reads before writes: measure plates that are on screen but not measured yet (a label changed, or it just
    // appeared) while the layout from the last frame is still valid.
    if (declutter) {
      for (const { id } of entries) {
        const element = this.elements.get(id);
        if (element && !this.sizes.has(id) && this.states.get(id)?.shown) this.sizes.set(id, { w: element.offsetWidth || FALLBACK_SIZE.w, h: element.offsetHeight || FALLBACK_SIZE.h });
      }
    }
    this.placementCount = 0;
    for (const { id, headPosition, hidden, priority } of entries) {
      const bubble = this.bubbles.get(id);
      const element = this.elements.get(id);
      if (!element && !bubble) continue;

      this.ndcScratch.copy(headPosition).project(camera);
      const inFront = this.ndcScratch.z <= 1;
      const x = (this.ndcScratch.x * 0.5 + 0.5) * viewportWidth;
      const y = (1 - (this.ndcScratch.y * 0.5 + 0.5)) * viewportHeight;
      const onScreen = inFront && x > -OFFSCREEN_MARGIN && x < viewportWidth + OFFSCREEN_MARGIN && y > -OFFSCREEN_MARGIN && y < viewportHeight + OFFSCREEN_MARGIN;
      const distance = headPosition.distanceTo(this.cameraScratch);

      if (bubble) {
        const showBubble = onScreen && distance < 40;
        if (showBubble !== bubble.shown) {
          bubble.shown = showBubble;
          bubble.element.style.display = showBubble ? "" : "none";
        }
        if (showBubble) bubble.element.style.transform = `translate(-50%, -100%) translate(${x}px, ${y - (element && !hidden ? 30 : 8)}px)`;
      }
      if (!element) continue;

      if (hidden || !onScreen || distance > NAMEPLATE_MAX_DISTANCE) {
        this.show(id, element, false);
        continue;
      }
      if (declutter) this.queue(id, element, x, y, distance, priority === true);
      else this.place(id, element, x, y);
    }
    if (declutter) this.declutter();
  }

  /** Writes display only when it changes. */
  private show(id: string, element: HTMLDivElement, shown: boolean): void {
    const state = this.states.get(id);
    if (!state || state.shown === shown) return;
    state.shown = shown;
    element.style.display = shown ? "" : "none";
  }

  /** Shows the plate at (x, y), writing the transform only when it moved by half a pixel or more. */
  private place(id: string, element: HTMLDivElement, x: number, y: number): void {
    this.show(id, element, true);
    const state = this.states.get(id);
    if (!state) return;
    const hx = Math.round(x * 2);
    const hy = Math.round(y * 2);
    if (hx === state.x && hy === state.y) return;
    state.x = hx;
    state.y = hy;
    element.style.transform = `translate(-50%, -100%) translate(${hx / 2}px, ${hy / 2}px)`;
  }

  private queue(id: string, element: HTMLDivElement, x: number, y: number, distance: number, priority: boolean): void {
    let placement = this.placements[this.placementCount];
    if (!placement) {
      placement = { id, element, x, y, distance, priority };
      this.placements.push(placement);
    } else {
      placement.id = id;
      placement.element = element;
      placement.x = x;
      placement.y = y;
      placement.distance = distance;
      placement.priority = priority;
    }
    this.placementCount++;
  }

  /** Places the queued plates nearest (and higher-priority) first; a plate overlapping one already placed is hidden. */
  private declutter(): void {
    const count = this.placementCount;
    const plates = this.placements;
    // Insertion sort over the live prefix: no allocation, and the order barely changes between frames.
    for (let i = 1; i < count; i++) {
      const plate = plates[i]!;
      let j = i - 1;
      while (j >= 0 && comparePlacements(plates[j]!, plate) > 0) {
        plates[j + 1] = plates[j]!;
        j--;
      }
      plates[j + 1] = plate;
    }
    const boxes = this.boxes;
    boxes.length = 0;
    for (let i = 0; i < count; i++) {
      const plate = plates[i]!;
      const size = this.sizes.get(plate.id) ?? FALLBACK_SIZE;
      const l = plate.x - size.w / 2 - 2;
      const t = plate.y - size.h - 2;
      const r = plate.x + size.w / 2 + 2;
      const b = plate.y + 2;
      let overlaps = false;
      for (let k = 0; k < boxes.length; k += 4) {
        if (l < boxes[k + 2]! && r > boxes[k]! && t < boxes[k + 3]! && b > boxes[k + 1]!) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) {
        this.show(plate.id, plate.element, false);
        continue;
      }
      boxes.push(l, t, r, b);
      this.place(plate.id, plate.element, plate.x, plate.y);
    }
  }

  dispose(): void {
    for (const element of this.elements.values()) element.remove();
    this.elements.clear();
    this.contents.clear();
    this.sizes.clear();
    this.states.clear();
    for (const bubble of this.bubbles.values()) bubble.element.remove();
    this.bubbles.clear();
  }
}

function comparePlacements(a: Placement, b: Placement): number {
  return Number(b.priority) - Number(a.priority) || a.distance - b.distance;
}
