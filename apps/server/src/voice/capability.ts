import { randomBytes } from "node:crypto";

/**
 * Ephemeral per-session voice capability registry (CORE-004 security
 * revision — ).
 *
 * Problem this fixes: the original `/voice/token` endpoint trusted a
 * client-supplied `{ playerId, nickname }` directly. Every connected
 * client already learns every other player's `playerId` through the
 * ordinary multiplayer protocol (`player_snapshot`/`player_joined`), so
 * a malicious client could request a LiveKit token *as* another visible
 * player — LiveKit participant identity is a routing/security identity,
 * so this was a real voice-identity-impersonation vulnerability, not a
 * cosmetic one.
 *
 * Fix: `WorldServer` issues one cryptographically random, single-use-
 * per-session capability per joined connection (see `issue()`), sends
 * it ONLY to that connection via the owner-only `welcome` message (never
 * broadcast — see `WelcomeMessage.voiceCapability`'s own docstring), and
 * the voice-token HTTP handler now requires that capability and
 * resolves the authoritative identity server-side (see
 * `apps/server/src/voice/tokenHandler.ts`) instead of trusting anything
 * the browser claims about its own identity.
 *
 * Deliberately NOT the multiplayer `playerId` encoded differently — a
 * capability reveals nothing about which player it belongs to on its
 * own, and knowing a `playerId` (which every client already does, for
 * every player) grants no ability to forge or guess another session's
 * capability.
 *
 * No persistence of any kind: entirely in-memory, process-lifetime only,
 * exactly like the rest of `WorldServer`'s session state (CORE-002 §6).
 */
export class VoiceCapabilityRegistry {
  private readonly playerIdByCapability = new Map<string, string>();
  private readonly capabilityByPlayerId = new Map<string, string>();

  /**
   * Issues a fresh capability bound to `playerId`, invalidating any
   * capability previously issued to that same `playerId` first — at
   * most one live capability per session at a time. Called once per
   * successful `join` (never on `set_nickname` — nickname changes are
   * resolved fresh, server-side, at the moment a capability is
   * exchanged for a token; see `resolve()`'s own docstring and
   * `WorldServer.resolveVoiceSession()`).
   */
  issue(playerId: string): string {
    this.revoke(playerId);
    const capability = randomBytes(32).toString("base64url");
    this.playerIdByCapability.set(capability, playerId);
    this.capabilityByPlayerId.set(playerId, capability);
    return capability;
  }

  /**
   * Resolves a capability to the `playerId` it was issued to, or `null`
   * if the capability is unknown, was revoked (disconnect/stale
   * cleanup), or was replaced by a newer one for the same session
   * (`issue()` invalidates the previous one). Never throws — an invalid
   * capability is an ordinary, expected input here (a stale tab, a
   * replayed value, a guess), not an error condition.
   *
   * Intentionally returns only `playerId`, never a nickname — the
   * caller (`WorldServer.resolveVoiceSession()`) is responsible for
   * looking up the CURRENT nickname from live session state, since a
   * nickname can change after `join` via `set_nickname` and this
   * registry has no session-nickname mapping of its own to go stale.
   */
  resolve(capability: string): string | null {
    return this.playerIdByCapability.get(capability) ?? null;
  }

  /**
   * Invalidates `playerId`'s current capability, if any. Called on
   * disconnect (`WorldServer.handleClose`) and stale-connection cleanup
   * (`WorldServer.sweepStaleConnections`) — a reconnect is always a
   * fresh `playerId` (CORE-002's existing identity model), so this
   * alone is sufficient to guarantee a capability never survives past
   * the session it was issued to, and a reconnect always gets a new one
   * via a fresh `issue()` call, never the old value.
   */
  revoke(playerId: string): void {
    const existing = this.capabilityByPlayerId.get(playerId);
    if (existing) this.playerIdByCapability.delete(existing);
    this.capabilityByPlayerId.delete(playerId);
  }
}
