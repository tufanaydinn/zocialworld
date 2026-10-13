export type SocialStoreListener = () => void;

/**
 * Client-side-only, session-scoped social relationship state.
 *
 * Deliberately has NO reference to `NetworkClient` or any networking
 * type — that is an architectural guarantee, not just a convention, that
 * nothing in this class can ever transmit block state to the server. See
 * `docs/privacy/SOCIAL_IDENTITY_THREAT_MODEL.md` § Block privacy: the
 * server does not need to, and must not, know about local block state.
 *
 * Lost on page reload / tab close — no persistence by design (block
 * state does not need to survive a browser restart).
 *
 * `mute`/`unmute` suppress a player's voice. Mute is deliberately local-session-only and is never transmitted to
 * the remote player or the server — same "client-local-only" guarantee
 * as block, see the class doc above. Unlike block, mute does NOT hide
 * the nameplate or remove the player from `InteractionSystem` — it only
 * suppresses that player's voice (see VoiceSession, which reads
 * `isMuted()` alongside `isBlocked()` every frame).
 */
export class SocialStore {
  private readonly blockedPlayerIds = new Set<string>();
  private readonly mutedPlayerIds = new Set<string>();
  /** Per-player voice volume (0–2), local only — never sent anywhere. */
  private readonly volumes = new Map<string, number>();
  private selected: string | null = null;
  private readonly listeners = new Set<SocialStoreListener>();

  isBlocked(playerId: string): boolean {
    return this.blockedPlayerIds.has(playerId);
  }

  block(playerId: string): void {
    if (this.blockedPlayerIds.has(playerId)) return;
    this.blockedPlayerIds.add(playerId);
    this.notify();
  }

  /** Not exposed in the UI (no "Unblock" button) — kept for completeness/testability of the store itself. */
  unblock(playerId: string): void {
    if (!this.blockedPlayerIds.has(playerId)) return;
    this.blockedPlayerIds.delete(playerId);
    this.notify();
  }

  isMuted(playerId: string): boolean {
    return this.mutedPlayerIds.has(playerId);
  }

  /** Local-only voice suppression — never sent to the server or the muted player. See class doc above. */
  mute(playerId: string): void {
    if (this.mutedPlayerIds.has(playerId)) return;
    this.mutedPlayerIds.add(playerId);
    this.notify();
  }

  unmute(playerId: string): void {
    if (!this.mutedPlayerIds.has(playerId)) return;
    this.mutedPlayerIds.delete(playerId);
    this.notify();
  }

  getVolume(playerId: string): number {
    return this.volumes.get(playerId) ?? 1;
  }

  setVolume(playerId: string, volume: number): void {
    const clamped = Math.max(0, Math.min(2, volume));
    if (clamped === 1) this.volumes.delete(playerId);
    else this.volumes.set(playerId, clamped);
  }

  get selectedPlayerId(): string | null {
    return this.selected;
  }

  select(playerId: string): void {
    if (this.selected === playerId) return;
    this.selected = playerId;
    this.notify();
  }

  deselect(): void {
    if (this.selected === null) return;
    this.selected = null;
    this.notify();
  }

  /** Fires after any block/unblock/select/deselect. Does not say which changed — callers that care read the relevant getter. */
  onChange(listener: SocialStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }
}
