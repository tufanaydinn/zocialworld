import type * as THREE from "three";
import type { InputManager } from "../input/InputManager.ts";
import type { Interactable } from "./Interactable.ts";

export type NearestChangeListener = (nearest: Interactable | null) => void;

/**
 * Finds the in-range Interactable the player would act on each frame —
 * the highest `priority` first, then the closest (see `pickInteractable`)
 * — and fires `interact()` when the player presses E while one is in range.
 *
 * This is the only system that knows about "being near something and
 * pressing a button" — world objects just register an Interactable, the
 * player controller never needs to know interaction exists.
 */
export class InteractionSystem {
  private readonly interactables: Interactable[] = [];
  private readonly listeners = new Set<NearestChangeListener>();
  private current: Interactable | null = null;

  register(interactable: Interactable): void {
    this.interactables.push(interactable);
  }

  /** Everything currently registered (read-only view, for tooling and tests). */
  get all(): readonly Interactable[] {
    return this.interactables;
  }

  /** The interactable E would act on right now (as of the last `update`), or null. */
  get nearest(): Interactable | null {
    return this.current;
  }

  unregister(id: string): void {
    const index = this.interactables.findIndex((item) => item.id === id);
    if (index !== -1) this.interactables.splice(index, 1);
  }

  /** Called whenever the nearest-in-range interactable changes (including becoming null). */
  onNearestChange(listener: NearestChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(playerPosition: THREE.Vector3, input: Pick<InputManager, "wasJustPressed">): void {
    const nearest = pickInteractable(playerPosition, this.interactables);

    if (nearest !== this.current) {
      this.current = nearest;
      this.listeners.forEach((listener) => listener(nearest));
    }

    if (this.current && input.wasJustPressed("interact")) {
      this.current.interact();
    }
  }
}

/**
 * The interactable E acts on (ADR-014 § 9): among those whose radius reaches `position`, the
 * highest `priority` (default 0) wins and the nearest breaks a tie. Null when none is in range.
 */
export function pickInteractable(position: THREE.Vector3, interactables: readonly Interactable[]): Interactable | null {
  let best: Interactable | null = null;
  let bestPriority = -Infinity;
  let bestDistSq = Infinity;
  for (const item of interactables) {
    const distSq = position.distanceToSquared(item.position);
    if (distSq > item.interactionRadius * item.interactionRadius) continue;
    const priority = item.priority ?? 0;
    if (priority > bestPriority || (priority === bestPriority && distSq < bestDistSq)) {
      best = item;
      bestPriority = priority;
      bestDistSq = distSq;
    }
  }
  return best;
}
