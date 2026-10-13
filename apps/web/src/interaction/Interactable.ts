import type * as THREE from "three";

/**
 * Generic contract for anything in the world the player can walk up to
 * and press E on — a project board today, a booth, a bench, a door, a
 * support terminal later. InteractionSystem
 * only ever talks to this interface, never to concrete world objects, so
 * new interactable types never require changes to the interaction loop.
 */
export interface Interactable {
  readonly id: string;
  /** Shown in the UI as "[E] <label>". */
  readonly label: string;
  readonly position: THREE.Vector3;
  readonly interactionRadius: number;
  /**
   * Higher wins when several interactables are in range; ties go to the nearest (ADR-014 § 9).
   * Defaults to 0 (players, most world objects). Watch Hall boards and doors use 1 and seats 2,
   * so a neighbour's 5 m player card never captures E in a full hall.
   */
  readonly priority?: number;
  interact(): void;
}
