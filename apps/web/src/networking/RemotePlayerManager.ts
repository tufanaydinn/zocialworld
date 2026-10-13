import * as THREE from "three";
import { RemotePlayer } from "./RemotePlayer.ts";
import type { RemoteAvatarLibrary } from "./remoteAvatars.ts";
import { PlaceholderCrowd } from "../player/PlaceholderCrowd.ts";
import type { NameplateManager } from "../ui/Nameplates.ts";
import type { InteractionSystem } from "../interaction/InteractionSystem.ts";
import { RemotePlayerInteractable } from "../social/RemotePlayerInteractable.ts";
import { isWithinRadius, type Point3, type PositionedPlayer } from "../social/nearby.ts";
import { avatarColorCss } from "../player/avatarPalette.ts";
import type { PlayerAvatar, PlayerSummary, PlayerTransformBroadcastMessage } from "@project/shared";

export interface RemotePlayerManagerOptions {
  scene: THREE.Scene;
  nameplates: NameplateManager;
  /** So each spawned remote player can be selected via the existing "[E] nearest interactable" flow — see RemotePlayerInteractable. */
  interactions: InteractionSystem;
  /** The single source of truth for "how close counts as socially interactable" — see apps/web/src/social/nearby.ts. */
  interactionRadius: number;
  /** Fired when the player's own interactable is interacted with (E while nearest, or whatever InteractionSystem decides "interact" means). */
  onPlayerSelected: (playerId: string) => void;
  /** ADR-014 § 11: KayKit avatars for remote players — high tier only; null keeps the placeholder (low tier, ADR-008). */
  avatars?: RemoteAvatarLibrary | null;
}

/** What `update` needs to cull work: the camera (frustum) and whether a point is in the active location (ADR-010). */
export interface RemotePlayerView {
  readonly camera: THREE.Camera;
  readonly inActiveLocation: (x: number) => boolean;
}

/** The nameplate tag of a moderator. */
const MODERATOR_TAG = "Moderator";

/** Bounding sphere for a standing character (skinned bounds are bind-pose, so players are culled whole). */
const CULL_RADIUS = 1.4;

interface PlateEntry {
  readonly id: string;
  readonly headPosition: THREE.Vector3;
  hidden: boolean;
  priority: boolean;
}

/**
 * Owns the `Map<playerId, RemotePlayer>` and keeps it in sync with the
 * scene graph, nameplates, and the interaction system and
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
  private readonly avatars: RemoteAvatarLibrary | null;

  private readonly players = new Map<string, RemotePlayer>();
  private readonly interactables = new Map<string, RemotePlayerInteractable>();
  /** Players whose nameplate is suppressed (currently: blocked players — see `setBlocked`). Keyed by playerId, not tied to WHY, to keep this a generic presentation hook. */
  private readonly hiddenNameplateIds = new Set<string>();
  /** Nameplate badges (✋ raised hand, 🎤 stage holder, 🎙 floor), prefixed to the nickname. */
  private readonly badges = new Map<string, string>();
  /** ADR-019 § 1: players who signed in as moderators — a small "Moderator" tag on their plate. */
  private readonly moderators = new Set<string>();
  /** Plates culled by the hall policy this frame (seated and far, see hall/nameplatePolicy.ts). Unlike blocking, the plate comes back by itself. */
  private readonly culledNameplateIds = new Set<string>();
  private declutterNameplates = false;

  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly cullSphere = new THREE.Sphere(new THREE.Vector3(), CULL_RADIUS);
  private readonly cameraPosition = new THREE.Vector3();
  /** Every placeholder (low tier; high tier until the model loads) in six instanced draws. */
  readonly crowd = new PlaceholderCrowd();
  /** One reusable nameplate entry (with its own head vector) per player: no per-frame allocation. */
  private readonly plateEntries = new Map<string, PlateEntry>();
  private readonly plateList: PlateEntry[] = [];
  private reducedDetail = false;

  constructor(options: RemotePlayerManagerOptions) {
    this.scene = options.scene;
    this.nameplates = options.nameplates;
    this.interactions = options.interactions;
    this.interactionRadius = options.interactionRadius;
    this.onPlayerSelected = options.onPlayerSelected;
    this.avatars = options.avatars ?? null;
    this.scene.add(this.crowd.object);
    // The crowd copies the placeholders' part matrices after three's matrix update and before it culls and draws.
    const scene = this.scene;
    const previous = scene.onBeforeRender.bind(scene);
    const crowd = this.crowd;
    scene.onBeforeRender = (...args: Parameters<THREE.Object3D["onBeforeRender"]>): void => {
      previous(...args);
      crowd.sync();
    };
  }

  /** Online player whose nickname matches (case-insensitive) — for `/w name`. */
  findByNickname(nickname: string): { playerId: string; nickname: string } | null {
    const wanted = nickname.trim().toLowerCase();
    if (!wanted) return null;
    for (const player of this.players.values()) if (player.nickname.toLowerCase() === wanted) return { playerId: player.playerId, nickname: player.nickname };
    return null;
  }

  /** A remote player's speech bubble (General/Nearby chat). */
  say(playerId: string, text: string): void {
    if (this.players.has(playerId) && !this.hiddenNameplateIds.has(playerId)) this.nameplates.say(playerId, text);
  }

  get size(): number {
    return this.players.size;
  }

  spawn(summary: PlayerSummary): void {
    if (this.players.has(summary.playerId)) return; // already know about this player — ignore a duplicate join/snapshot entry

    const player = new RemotePlayer(summary.playerId, summary.nickname, summary.colorSeed, summary, summary.avatar, summary.canReceive, { crowd: this.crowd });
    this.players.set(summary.playerId, player);
    this.scene.add(player.object);
    if (summary.moderator === true) this.moderators.add(summary.playerId);
    this.nameplates.set(summary.playerId, summary.nickname, summary.moderator === true ? MODERATOR_TAG : null);
    this.nameplates.setAccent(summary.playerId, avatarColorCss(summary.avatar.color));

    const interactable = new RemotePlayerInteractable(player, this.interactionRadius, this.onPlayerSelected);
    this.interactables.set(summary.playerId, interactable);
    this.interactions.register(interactable);

    // High tier: the placeholder shows until the player's KayKit model is ready.
    this.loadModel(player);
  }

  /**
   * ADR-015 `avatar_updated`: the new colour at once (placeholder accent + hall glow, nameplate
   * underline); on the high tier the new model replaces the old one when it has loaded.
   */
  updateAvatar(playerId: string, avatar: PlayerAvatar): void {
    const player = this.players.get(playerId);
    if (!player) return;
    const modelChanged = player.avatar.model !== avatar.model;
    player.setAvatar(avatar);
    if (!this.hiddenNameplateIds.has(playerId)) this.nameplates.setAccent(playerId, avatarColorCss(avatar.color));
    if (modelChanged) this.loadModel(player);
  }

  /** ADR-015 `can_receive_updated`: stored for the player menu (Send ZEC, "Can receive ZEC privately"). Never shown on the nameplate. */
  updateCanReceive(playerId: string, canReceive: boolean): void {
    const player = this.players.get(playerId);
    if (player) player.canReceive = canReceive;
  }

  /**
   * Loads `player.avatar.model` (high tier only) and swaps it in — unless the player left, or
   * changed character again, while it loaded (a later call wins).
   */
  private loadModel(player: RemotePlayer): void {
    const wanted = player.avatar.model;
    this.avatars
      ?.instantiate({ model: wanted })
      .then((avatar) => {
        if (this.players.get(player.playerId) !== player || player.avatar.model !== wanted || player.loadedModel === wanted) return;
        player.setModel(avatar.model, avatar.clips, wanted);
      })
      .catch((error: unknown) => console.warn("[players] remote avatar unavailable:", error));
  }

  despawn(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player) return;

    this.scene.remove(player.object);
    player.dispose();
    this.nameplates.remove(playerId);
    this.players.delete(playerId);

    this.interactions.unregister(playerId);
    this.interactables.delete(playerId);
    this.hiddenNameplateIds.delete(playerId);
    this.badges.delete(playerId);
    this.moderators.delete(playerId);
    this.culledNameplateIds.delete(playerId);
    this.plateEntries.delete(playerId);
  }

  receiveTransform(message: PlayerTransformBroadcastMessage): void {
    this.players.get(message.playerId)?.receiveTransform(message);
  }

  /** Applies a server-confirmed `nickname_updated` to the player's model and (unless currently hidden — see `setBlocked`) its nameplate. */
  updateNickname(playerId: string, nickname: string): void {
    const player = this.players.get(playerId);
    if (!player) return;

    player.setNickname(nickname);
    this.refreshNameplate(playerId);
  }

  /** Speaking state feeds both the talk-animation override (see RemotePlayer.effectiveAnimationState) and a lightweight nameplate indicator — no final nameplate redesign, just appending a marker while speaking. */
  setSpeaking(playerId: string, speaking: boolean): void {
    const player = this.players.get(playerId);
    if (!player) return;

    player.setSpeaking(speaking);
    this.refreshNameplate(playerId);
  }

  /** The nameplate badge ("" for none) — ✋ raised hand, 🎤 stage holder, 🎙 floor. */
  setBadge(playerId: string, badge: string): void {
    if (!this.players.has(playerId) || (this.badges.get(playerId) ?? "") === badge) return;
    if (badge) this.badges.set(playerId, badge);
    else this.badges.delete(playerId);
    this.refreshNameplate(playerId);
  }

  /** `moderator_updated`: the player's "Moderator" tag on or off. */
  setModerator(playerId: string, moderator: boolean): void {
    if (!this.players.has(playerId) || this.moderators.has(playerId) === moderator) return;
    if (moderator) this.moderators.add(playerId);
    else this.moderators.delete(playerId);
    this.refreshNameplate(playerId);
  }

  /** Whether the player carries the Moderator tag (the player menu shows it too). */
  isModerator(playerId: string): boolean {
    return this.moderators.has(playerId);
  }

  /** Hides (culls) or shows a nameplate by the hall's distance policy. Blocked players stay hidden either way. */
  /** In the hall, overlapping plates are thinned out (nearest and badged/speaking first). */
  setNameplateDeclutter(on: boolean): void {
    this.declutterNameplates = on;
  }

  setNameplateCulled(playerId: string, culled: boolean): void {
    if (culled) this.culledNameplateIds.add(playerId);
    else this.culledNameplateIds.delete(playerId);
  }

  private refreshNameplate(playerId: string): void {
    if (this.hiddenNameplateIds.has(playerId)) return;
    const player = this.players.get(playerId);
    if (!player) return;
    const badge = this.badges.get(playerId);
    this.nameplates.set(playerId, `${badge ? `${badge} ` : ""}${player.nickname}${player.isSpeaking ? " 🔊" : ""}`, this.moderators.has(playerId) ? MODERATOR_TAG : null);
  }

  /**
   * Applies local block/unblock presentation — hides the
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
      const player = this.players.get(playerId);
      if (player) this.nameplates.setAccent(playerId, avatarColorCss(player.avatar.color));
      const interactable = this.interactables.get(playerId);
      if (interactable) this.interactions.register(interactable);
    }
  }

  getPlayer(playerId: string): RemotePlayer | undefined {
    return this.players.get(playerId);
  }

  /** Every tracked remote player (read-only use: the Watch Hall presence sync). */
  all(): IterableIterator<RemotePlayer> {
    return this.players.values();
  }

  /** A snapshot of every tracked remote player's current world position, for `getNearbyPlayers()` — see apps/web/src/social/nearby.ts. */
  getPositions(): PositionedPlayer[] {
    return Array.from(this.players.values(), (player) => ({
      playerId: player.playerId,
      x: player.object.position.x,
      y: player.object.position.y,
      z: player.object.position.z,
    }));
  }

  /**
   * Moves every remote player along its interpolation buffer. With a `view`, a
   * player outside the active location is hidden and not animated (ADR-010: only the active
   * location renders), and one outside the camera frustum is hidden and its animation deferred —
   * KayKit avatars are skinned with frustum culling off, so this is their culling.
   */
  update(deltaSeconds: number, view?: RemotePlayerView): void {
    const now = performance.now();
    if (!view) {
      for (const player of this.players.values()) player.update(deltaSeconds, true, 0, now);
      return;
    }
    view.camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(this.viewProjection.multiplyMatrices(view.camera.projectionMatrix, view.camera.matrixWorldInverse));
    const camera = this.cameraPosition.setFromMatrixPosition(view.camera.matrixWorld);
    for (const player of this.players.values()) {
      const position = player.object.position;
      const here = view.inActiveLocation(position.x);
      let visible = here;
      if (here) {
        this.cullSphere.center.set(position.x, position.y + 0.9, position.z);
        visible = this.frustum.intersectsSphere(this.cullSphere);
      }
      player.object.visible = visible;
      // The distance picks the animation rate (animationLod.ts); a frame-old position is close enough.
      player.update(deltaSeconds, visible, visible ? position.distanceTo(camera) : 0, now, this.reducedDetail);
    }
  }

  /** The frame-pacing guard's crowd lever (core/framePacing.ts `crowdReduced`): halves every animation rate. */
  setReducedDetail(reduced: boolean): void {
    this.reducedDetail = reduced;
  }

  /**
   * `extra`: additional bubble anchors (the local player's own head), positioned by the same projection.
   * One entry object and head vector per player, reused every frame.
   */
  updateNameplates(camera: THREE.Camera, viewportWidth: number, viewportHeight: number, extra: ReadonlyArray<{ id: string; headPosition: THREE.Vector3 }> = []): void {
    const list = this.plateList;
    list.length = 0;
    for (const player of this.players.values()) {
      let entry = this.plateEntries.get(player.playerId);
      if (!entry) {
        entry = { id: player.playerId, headPosition: new THREE.Vector3(), hidden: false, priority: false };
        this.plateEntries.set(player.playerId, entry);
      }
      player.headPositionInto(entry.headPosition);
      entry.hidden = this.culledNameplateIds.has(player.playerId);
      entry.priority = this.badges.has(player.playerId) || player.isSpeaking;
      list.push(entry);
    }
    for (const anchor of extra) list.push({ id: anchor.id, headPosition: anchor.headPosition, hidden: false, priority: false });
    this.nameplates.update(list, camera, viewportWidth, viewportHeight, this.declutterNameplates);
  }

  /** Ids of the players within `radius` metres of `point`, written into `into` (cleared first) — the per-frame nearby set without allocating. */
  nearbyIds(point: Point3, radius: number, into: Set<string>): Set<string> {
    into.clear();
    for (const player of this.players.values()) if (isWithinRadius(point, player.object.position, radius)) into.add(player.playerId);
    return into;
  }

  /** Removes every tracked remote player — used on disconnect so a stale roster doesn't survive a reconnect. */
  clear(): void {
    for (const playerId of Array.from(this.players.keys())) this.despawn(playerId);
  }
}
