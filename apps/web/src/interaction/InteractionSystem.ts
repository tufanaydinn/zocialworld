import * as THREE from "three";
import type { InputManager } from "../input/InputManager.ts";
import type { Interactable } from "./Interactable.ts";

export type NearestChangeListener = (nearest: Interactable | null) => void;

/**
 * Finds the closest in-range Interactable to the player each frame and
 * fires `interact()` when the player presses E while one is in range.
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

  unregister(id: string): void {
    const index = this.interactables.findIndex((item) => item.id === id);
    if (index !== -1) this.interactables.splice(index, 1);
  }

  /** Called whenever the nearest-in-range interactable changes (including becoming null). */
  onNearestChange(listener: NearestChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(playerPosition: THREE.Vector3, input: InputManager): void {
    let nearest: Interactable | null = null;
    let nearestDistSq = Infinity;

    for (const item of this.interactables) {
      const distSq = playerPosition.distanceToSquared(item.position);
      if (distSq <= item.interactionRadius * item.interactionRadius && distSq < nearestDistSq) {
        nearest = item;
        nearestDistSq = distSq;
      }
    }

    if (nearest !== this.current) {
      this.current = nearest;
      this.listeners.forEach((listener) => listener(nearest));
    }

    if (this.current && input.wasJustPressed("interact")) {
      this.current.interact();
    }
  }
}
