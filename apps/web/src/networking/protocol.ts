/**
 * Client-side half of the multiplayer wire protocol.
 *
 * The message *shapes* live in `@project/shared` (activated in the
 * CORE-002 revision — see
 * docs/decisions/ADR-002-shared-multiplayer-protocol-contracts.md) so
 * the client and server can never independently drift on what a
 * message looks like. Import the shapes directly from `@project/shared`
 * wherever you need them (see `NetworkClient.ts`, `RemotePlayer.ts`,
 * `RemotePlayerManager.ts`) — this file only adds the one thing that's
 * genuinely client-specific: runtime validation of data arriving over
 * the wire. CORE-002 has no hostile-server threat model, but
 * malformed/unexpected data (a bug, a protocol mismatch between client
 * and server versions) must never throw deep in rendering code — so
 * this still validates shape before anything downstream touches it.
 */

import { ANIMATION_STATES, type AnimationState, type ServerToClientMessage, type PlayerSummary } from "@project/shared";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isAnimationState(value: unknown): value is AnimationState {
  return typeof value === "string" && (ANIMATION_STATES as readonly string[]).includes(value);
}

function isPlayerSummary(value: unknown): value is PlayerSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.playerId === "string" &&
    typeof v.nickname === "string" &&
    isFiniteNumber(v.colorSeed) &&
    isFiniteNumber(v.x) &&
    isFiniteNumber(v.y) &&
    isFiniteNumber(v.z) &&
    isFiniteNumber(v.rotationY) &&
    isAnimationState(v.animationState)
  );
}

/**
 * Validates and narrows a raw parsed JSON value from the server into a
 * known `ServerToClientMessage`, or `null` if it doesn't match.
 */
export function parseIncomingMessage(raw: unknown): ServerToClientMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const msg = raw as Record<string, unknown>;

  switch (msg.type) {
    case "welcome":
      if (typeof msg.playerId !== "string" || typeof msg.nickname !== "string") return null;
      if (!isFiniteNumber(msg.colorSeed) || !isFiniteNumber(msg.tickRateHz)) return null;
      // CORE-004 security revision: voiceCapability is owner-only data
      // this client needs to actually use voice (see
      // VoiceSession.enableVoice()) — required, not optional, same as
      // every other welcome field.
      if (typeof msg.voiceCapability !== "string") return null;
      return {
        type: "welcome",
        playerId: msg.playerId,
        nickname: msg.nickname,
        colorSeed: msg.colorSeed,
        tickRateHz: msg.tickRateHz,
        voiceCapability: msg.voiceCapability,
      };

    case "player_snapshot": {
      if (!Array.isArray(msg.players)) return null;
      const players = msg.players.filter(isPlayerSummary);
      if (players.length !== msg.players.length) return null;
      return { type: "player_snapshot", players };
    }

    case "player_joined":
      if (!isPlayerSummary(msg)) return null;
      return { ...msg, type: "player_joined" };

    case "player_left":
      if (typeof msg.playerId !== "string") return null;
      return { type: "player_left", playerId: msg.playerId };

    case "player_transform":
      if (typeof msg.playerId !== "string") return null;
      if (!isFiniteNumber(msg.x) || !isFiniteNumber(msg.y) || !isFiniteNumber(msg.z)) return null;
      if (!isFiniteNumber(msg.rotationY) || !isFiniteNumber(msg.seq) || !isFiniteNumber(msg.t)) return null;
      if (!isAnimationState(msg.animationState)) return null;
      return {
        type: "player_transform",
        playerId: msg.playerId,
        x: msg.x,
        y: msg.y,
        z: msg.z,
        rotationY: msg.rotationY,
        animationState: msg.animationState,
        seq: msg.seq,
        t: msg.t,
      };

    case "nickname_updated":
      if (typeof msg.playerId !== "string" || typeof msg.nickname !== "string") return null;
      return { type: "nickname_updated", playerId: msg.playerId, nickname: msg.nickname };

    default:
      return null;
  }
}
