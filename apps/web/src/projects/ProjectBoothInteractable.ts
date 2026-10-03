import * as THREE from "three";
import type { Interactable } from "../interaction/Interactable.ts";
import { getProjectById } from "./ProjectRegistry.ts";
import { PROJECT_STATUS_LABELS } from "./ProjectTypes.ts";

export interface ProjectBoothInteractableOptions {
  readonly projectId: string;
  readonly position: THREE.Vector3;
  readonly interactionRadius?: number;
  readonly onSelect: (projectId: string) => void;
}

const DEFAULT_INTERACTION_RADIUS = 2.2;

/**
 * Adapts a world project booth into the existing `Interactable` contract
 * (CORE-005 § 11) — the same "nearest in-range wins, press E" model
 * `RemotePlayerInteractable` (CORE-003) already reuses for player
 * selection. No second interaction framework.
 *
 * References a `projectId` only (task brief § 38) — name/description/
 * category/etc. are never duplicated here; they come from
 * `ProjectRegistry` exactly once, at construction, purely to build the
 * `[E] <label>` prompt text.
 *
 * CORE-005 § 30 Test 12: an unknown `projectId` throws immediately,
 * loudly, at construction — a booth with a broken reference is a data
 * bug, never a silently-dead interaction.
 */
export class ProjectBoothInteractable implements Interactable {
  readonly id: string;
  readonly label: string;
  readonly position: THREE.Vector3;
  readonly interactionRadius: number;
  readonly projectId: string;

  private readonly onSelect: (projectId: string) => void;

  constructor(options: ProjectBoothInteractableOptions) {
    const project = getProjectById(options.projectId);
    if (!project) {
      throw new Error(`ProjectBoothInteractable: no project registered with id "${options.projectId}"`);
    }

    this.projectId = options.projectId;
    this.id = `project-booth-${options.projectId}`;
    this.label = `${project.name} — ${PROJECT_STATUS_LABELS[project.status]}`;
    this.position = options.position;
    this.interactionRadius = options.interactionRadius ?? DEFAULT_INTERACTION_RADIUS;
    this.onSelect = options.onSelect;
  }

  interact(): void {
    this.onSelect(this.projectId);
  }
}
