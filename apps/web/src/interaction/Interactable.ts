import type * as THREE from "three";

/**
 * Generic contract for anything in the world the player can walk up to
 * and press E on — a project board today, a booth, a bench, a door, a
 * support terminal later (see master spec section 66). InteractionSystem
 * only ever talks to this interface, never to concrete world objects, so
 * new interactable types never require changes to the interaction loop.
 */
export interface Interactable {
  readonly id: string;
  /** Shown in the UI as "[E] <label>". */
  readonly label: string;
  readonly position: THREE.Vector3;
  readonly interactionRadius: number;
  interact(): void;
}
