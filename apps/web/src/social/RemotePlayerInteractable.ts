import * as THREE from "three";
import type { Interactable } from "../interaction/Interactable.ts";
import type { RemotePlayer } from "../networking/RemotePlayer.ts";

/**
 * Adapts a `RemotePlayer` into the existing `Interactable` contract so
 * `InteractionSystem` can treat "the nearest remote player" exactly like
 * any other world interactable (CORE-003 §8/§17: "nearest valid
 * interactable wins" — see docs/architecture/OVERVIEW.md §
 * Player selection for the full precedence rule). No changes to
 * `InteractionSystem` itself were needed for this.
 *
 * `position` returns the SAME `THREE.Vector3` instance `RemotePlayer`
 * mutates in place every frame (`object.position.set(...)` in
 * `RemotePlayer.update()`), so this always reflects the player's current
 * interpolated position without needing to be refreshed.
 */
export class RemotePlayerInteractable implements Interactable {
  readonly id: string;
  readonly interactionRadius: number;

  private readonly player: RemotePlayer;
  private readonly onSelect: (playerId: string) => void;

  constructor(player: RemotePlayer, interactionRadius: number, onSelect: (playerId: string) => void) {
    this.player = player;
    this.id = player.playerId;
    this.interactionRadius = interactionRadius;
    this.onSelect = onSelect;
  }

  /** A getter, not a frozen string — reflects the player's current nickname even after a `set_nickname` update. */
  get label(): string {
    return `View ${this.player.nickname}`;
  }

  get position(): THREE.Vector3 {
    return this.player.object.position;
  }

  interact(): void {
    this.onSelect(this.player.playerId);
  }
}
