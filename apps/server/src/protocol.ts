/**
 * Server-side half of the multiplayer wire protocol.
 *
 * The message *shapes* live in `@project/shared` (activated in the
 * CORE-002 revision — see
 * docs/decisions/ADR-002-shared-multiplayer-protocol-contracts.md) so
 * the client and server can never independently drift on what a
 * message looks like. What stays here is environment-specific: raw
 * frame parsing (uses Node's `Buffer`, unavailable in a browser) and
 * runtime validation of untrusted client input — nothing here assumes
 * a well-behaved client, see `parseIncomingFrame`.
 */

import {
  ANIMATION_STATES,
  MAX_MESSAGE_BYTES,
  MAX_NICKNAME_LENGTH,
  type AnimationState,
  type ClientToServerMessage,
} from "@project/shared";

export { MAX_MESSAGE_BYTES, MAX_NICKNAME_LENGTH };
export type { ClientToServerMessage as IncomingMessage };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isAnimationState(value: unknown): value is AnimationState {
  return typeof value === "string" && (ANIMATION_STATES as readonly string[]).includes(value);
}

/**
 * Validates and narrows a raw parsed JSON value into a known
 * `ClientToServerMessage`, or returns `null` if it doesn't match any
 * known, well-formed message shape. Callers must treat `null` as "drop
 * silently" — see docs/protocols/multiplayer-protocol.md § Server-side
 * validation.
 */
export function parseIncomingMessage(raw: unknown): ClientToServerMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const msg = raw as Record<string, unknown>;

  switch (msg.type) {
    case "join": {
      // Structural/type safety only — NOT a length/content check. Semantic
      // nickname rules (trim, empty, max length, control chars, markup)
      // live solely in apps/server/src/nickname.ts's sanitizeNickname(),
      // called downstream in WorldServer.handleJoin(). Rejecting here on
      // raw (untrimmed) length would create a second, subtly different
      // validation policy — e.g. "  <24-char-name>  " has a raw length
      // over MAX_NICKNAME_LENGTH but a valid trimmed value. The overall
      // frame is already size-bounded by MAX_MESSAGE_BYTES in
      // parseIncomingFrame, so there's no DoS concern in deferring here.
      if (msg.nickname !== undefined && typeof msg.nickname !== "string") return null;
      return { type: "join", nickname: msg.nickname as string | undefined };
    }

    case "player_transform": {
      if (!isFiniteNumber(msg.x) || !isFiniteNumber(msg.y) || !isFiniteNumber(msg.z)) return null;
      if (!isFiniteNumber(msg.rotationY)) return null;
      if (!isAnimationState(msg.animationState)) return null;
      if (!isFiniteNumber(msg.seq)) return null;
      return {
        type: "player_transform",
        x: msg.x,
        y: msg.y,
        z: msg.z,
        rotationY: msg.rotationY,
        animationState: msg.animationState,
        seq: msg.seq,
      };
    }

    case "heartbeat":
      return { type: "heartbeat" };

    case "set_nickname": {
      // Same reasoning as "join" above: type safety only, no length/
      // content check — sanitizeNickname() is the sole semantic authority,
      // called downstream in WorldServer.handleSetNickname().
      if (typeof msg.nickname !== "string") return null;
      return { type: "set_nickname", nickname: msg.nickname };
    }

    default:
      return null;
  }
}

/** Parses a raw WebSocket text frame into a validated message, or `null` on any failure (bad size, bad JSON, unknown shape). */
export function parseIncomingFrame(data: string): ClientToServerMessage | null {
  if (Buffer.byteLength(data, "utf8") > MAX_MESSAGE_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  return parseIncomingMessage(parsed);
}
