import * as THREE from "three";
import { RemotePlayer } from "./RemotePlayer.ts";
import type { NameplateManager } from "../ui/Nameplates.ts";
import type { InteractionSystem } from "../interaction/InteractionSystem.ts";
import { RemotePlayerInteractable } from "../social/RemotePlayerInteractable.ts";
import type { PositionedPlayer } from "../social/nearby.ts";
import type { PlayerSummary, PlayerTransformBroadcastMessage } from "@project/shared";

export interface RemotePlayerManagerOptions {
  scene: THREE.Scene;
  nameplates: NameplateManager;
  /** CORE-003: so each spawned remote player can be selected via the existing "[E] nearest interactable" flow — see RemotePlayerInteractable. */
  interactions: InteractionSystem;
  /** CORE-003: the single source of truth for "how close counts as socially interactable" — see apps/web/src/social/nearby.ts. */
  interactionRadius: number;
  /** CORE-003: fired when the player's own interactable is interacted with (E while nearest, or whatever InteractionSystem decides "interact" means). */
  onPlayerSelected: (playerId: string) => void;
}

/**
 * Owns the `Map<playerId, RemotePlayer>` and keeps it in sync with the
 * scene graph, nameplates, and (CORE-003) the interaction system and
 * nameplate-visibility-on-block. `App.ts` only ever calls this — it never
 * touches `RemotePlayer` instances directly, the same separation
 * `InteractionSystem` keeps from world objects.
 */
export class RemotePlayerManager {
  private readonly scene: THREE.Scene;
  private readonly nameplates: NameplateManager;
  private readonly interactions: InteractionSystem;
  private readonly interactionRadius: number;
  private readonly onPlayerSelected: (playerId: string) => void;

  private readonly players = new Map<string, RemotePlayer>();
  private readonly interactables = new Map<string, RemotePlayerInteractable>();
  /** CORE-003: players whose nameplate is suppressed (currently: blocked players — see `setBlocked`). Keyed by playerId, not tied to WHY, to keep this a generic presentation hook. */
  private readonly hiddenNameplateIds = new Set<string>();

  constructor(options: RemotePlayerManagerOptions) {
    this.scene = options.scene;
    this.nameplates = options.nameplates;
    this.interactions = options.interactions;
    this.interactionRadius = options.interactionRadius;
    this.onPlayerSelected = options.onPlayerSelected;
  }

  get size(): number {
    return this.players.size;
  }

  spawn(summary: PlayerSummary): void {
    if (this.players.has(summary.playerId)) return; // already know about this player — ignore a duplicate join/snapshot entry

    const player = new RemotePlayer(summary.playerId, summary.nickname, summary.colorSeed, summary);
    this.players.set(summary.playerId, player);
    this.scene.add(player.object);
    this.nameplates.set(summary.playerId, summary.nickname);

    const interactable = new RemotePlayerInteractable(player, this.interactionRadius, this.onPlayerSelected);
    this.interactables.set(summary.playerId, interactable);
    this.interactions.register(interactable);
  }

  despawn(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player) return;

    this.scene.remove(player.object);
    this.nameplates.remove(playerId);
    this.players.delete(playerId);

    this.interactions.unregister(playerId);
    this.interactables.delete(playerId);
    this.hiddenNameplateIds.delete(playerId);
  }

  receiveTransform(message: PlayerTransformBroadcastMessage): void {
    this.players.get(message.playerId)?.receiveTransform(message);
  }

  /** CORE-003: applies a server-confirmed `nickname_updated` to the player's model and (unless currently hidden — see `setBlocked`) its nameplate. */
  updateNickname(playerId: string, nickname: string): void {
    const player = this.players.get(playerId);
    if (!player) return;

    player.setNickname(nickname);
    this.refreshNameplate(playerId);
  }

  /** CORE-004 §20: speaking state feeds both the talk-animation override (see RemotePlayer.effectiveAnimationState) and a lightweight nameplate indicator — no final nameplate redesign, just appending a marker while speaking. */
  setSpeaking(playerId: string, speaking: boolean): void {
    const player = this.players.get(playerId);
    if (!player) return;

    player.setSpeaking(speaking);
    this.refreshNameplate(playerId);
  }

  private refreshNameplate(playerId: string): void {
    if (this.hiddenNameplateIds.has(playerId)) return;
    const player = this.players.get(playerId);
    if (!player) return;
    this.nameplates.set(playerId, player.isSpeaking ? `${player.nickname} 🔊` : player.nickname);
  }

  /**
   * CORE-003: applies local block/unblock presentation — hides the
   * nameplate and removes the player from `InteractionSystem` (so they
   * can never become the "nearest interactable" and the "[E] View X"
   * prompt never appears for them) without disconnecting them or
   * affecting anyone else's view. See
   * docs/privacy/SOCIAL_IDENTITY_THREAT_MODEL.md § What does blocking do?
   */
  setBlocked(playerId: string, blocked: boolean): void {
    if (blocked) {
      this.hiddenNameplateIds.add(playerId);
      this.nameplates.remove(playerId);
      this.interactions.unregister(playerId);
    } else {
      this.hiddenNameplateIds.delete(playerId);
      this.refreshNameplate(playerId);
      const interactable = this.interactables.get(playerId);
      if (interactable) this.interactions.register(interactable);
    }
  }

  getPlayer(playerId: string): RemotePlayer | undefined {
    return this.players.get(playerId);
  }

  /** CORE-003: a snapshot of every tracked remote player's current world position, for `getNearbyPlayers()` — see apps/web/src/social/nearby.ts. */
  getPositions(): PositionedPlayer[] {
    return Array.from(this.players.values(), (player) => ({
      playerId: player.playerId,
      x: player.object.position.x,
      y: player.object.position.y,
      z: player.object.position.z,
    }));
  }

  update(deltaSeconds: number): void {
    for (const player of this.players.values()) player.update(deltaSeconds);
  }

  updateNameplates(camera: THREE.Camera, viewportWidth: number, viewportHeight: number): void {
    const entries = Array.from(this.players.values(), (player) => ({ id: player.playerId, headPosition: player.headPosition }));
    this.nameplates.update(entries, camera, viewportWidth, viewportHeight);
  }

  /** Removes every tracked remote player — used on disconnect so a stale roster doesn't survive a reconnect. */
  clear(): void {
    for (const playerId of Array.from(this.players.keys())) this.despawn(playerId);
  }
}
