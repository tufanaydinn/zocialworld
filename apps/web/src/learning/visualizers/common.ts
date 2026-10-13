import type { CommunityClient } from "../../community/CommunityClient.ts";

export type CommunityView = "bounties" | "wiki" | "forum" | "learn" | "github";

export interface VisualizerContext {
  readonly host: HTMLElement;
  /** Reports the interactive task as done (counts as SIMULATION VERIFIED when the lesson's proof is a simulation). */
  complete(): void;
  readonly client: CommunityClient;
  readonly openCommunity: (view: CommunityView) => void;
  /** Whether the lesson was already completed (lets visualizers offer free review). */
  readonly reviewing: boolean;
  /** Pedestal the player used to open the lesson (shielded transaction lab), 1-based. */
  readonly startStep?: number;
  /** Saved, device-local state for this lesson's visualizer (lab step reached, mission checklist…). */
  readonly state: { get<T>(): T | undefined; set(value: unknown): void };
}

export type Visualizer = (context: VisualizerContext) => void;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function button(label: string, onClick: () => void, className = "zw-button"): HTMLButtonElement {
  const element = el("button", className, label);
  element.type = "button";
  element.addEventListener("click", onClick);
  return element;
}

/** A small status line under a task ("✓ done", hints, errors). */
export function feedback(): { element: HTMLDivElement; ok(text: string): void; bad(text: string): void; info(text: string): void } {
  const element = el("div", "lv-feedback");
  const set = (kind: string, text: string): void => {
    element.className = `lv-feedback lv-feedback-${kind}`;
    element.textContent = text;
  };
  return { element, ok: (text) => set("ok", text), bad: (text) => set("bad", text), info: (text) => set("info", text) };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexBitDistance(a: string, b: string): number {
  let bits = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (x) {
      bits += x & 1;
      x >>= 1;
    }
  }
  return bits;
}

/** Shuffle a copy (Fisher–Yates) — used so multiple-choice positions don't become memorized. */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}
