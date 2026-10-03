/**
 * Multiplayer wire protocol contracts, shared verbatim between
 * `apps/server` and `apps/web`.
 *
 * This file is the **compile-time** source of truth the Project
 * Director required in the CORE-002 review: before this package was
 * activated, these shapes were declared independently in
 * `apps/server/src/protocol.ts` and `apps/web/src/networking/protocol.ts`,
 * kept in sync only by `docs/protocols/multiplayer-protocol.md` and
 * convention. That document is still the *prose* source of truth
 * (message semantics, rates, the interpolation/validation strategy) —
 * this file is its typed, enforced counterpart. See
 * `docs/decisions/ADR-002-shared-multiplayer-protocol-contracts.md`.
 *
 * What belongs here: wire message shapes, the enum of valid animation
 * states, and protocol-level constants both sides must agree on (frame
 * size limit, nickname length limit, default tick rate). What does
 * NOT belong here: WebSocket connection handling, JSON
 * parsing/validation logic, `Buffer`-based frame-size checks (Node-only,
 * not available in a browser), or anything environment-specific — each
 * app keeps that itself (`protocol.ts` in each app validates raw input
 * against these types and stays local).
 */

export const ANIMATION_STATES = ["idle", "walk", "jog", "sit", "wave", "talk"] as const;
export type AnimationState = (typeof ANIMATION_STATES)[number];

/** Informational default the server reports in `welcome`; see docs/protocols/multiplayer-protocol.md § Network rate. */
export const DEFAULT_TICK_RATE_HZ = 10;

/** Raw WebSocket text frames larger than this (bytes, UTF-8) are dropped before parsing — enforced server-side, since the server is what a malicious/buggy client could try to flood. */
export const MAX_MESSAGE_BYTES = 2048;

/** Maximum accepted length for a client-supplied `join.nickname`. */
export const MAX_NICKNAME_LENGTH = 24;

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export interface JoinMessage {
  type: "join";
  nickname?: string;
}

/** The sender's own transform. The server relays this to everyone else — it is never used to move another player. */
export interface PlayerTransformMessage {
  type: "player_transform";
  x: number;
  y: number;
  z: number;
  /** Radians, yaw only — a third-person character never needs pitch/roll networked. */
  rotationY: number;
  animationState: AnimationState;
  /** Monotonically increasing per-client sequence number. */
  seq: number;
}

export interface HeartbeatMessage {
  type: "heartbeat";
}

/**
 * Requests a nickname change for the sender's own session (CORE-003).
 * The server is authoritative: it validates and may resolve a conflict
 * by appending a suffix (see docs/protocols/multiplayer-protocol.md §
 * Nickname validation and conflict resolution) before broadcasting the
 * accepted value back as `NicknameUpdatedMessage`. An invalid request is
 * dropped silently — the session's nickname is left unchanged.
 */
export interface SetNicknameMessage {
  type: "set_nickname";
  nickname: string;
}

export type ClientToServerMessage = JoinMessage | PlayerTransformMessage | HeartbeatMessage | SetNicknameMessage;

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export interface PlayerSummary {
  playerId: string;
  nickname: string;
  colorSeed: number;
  x: number;
  y: number;
  z: number;
  rotationY: number;
  animationState: AnimationState;
}

export interface WelcomeMessage {
  type: "welcome";
  playerId: string;
  nickname: string;
  colorSeed: number;
  tickRateHz: number;
  /**
   * CORE-004 revision: a cryptographically random, ephemeral, session-
   * scoped credential this session's owner can exchange (via the
   * application server's `/voice/token` HTTP endpoint, see
   * `apps/server/src/voice/`) for a LiveKit voice token minted with the
   * server's own authoritative `playerId`/current nickname — never a
   * client-supplied one. **Owner-only — this field must NEVER appear in
   * any broadcast or peer-visible message** (`player_snapshot`,
   * `player_joined`, `player_transform`, `nickname_updated`, or any
   * future one). `welcome` is already sent only to the connecting
   * session itself (see `WorldServer.handleJoin`), which is exactly why
   * it's the right carrier for this value — never add a second field
   * carrying it anywhere else. Invalidated on disconnect/stale cleanup;
   * a reconnect gets a fresh one. See
   * `docs/privacy/VOICE_THREAT_MODEL.md` § Voice capability authentication.
   */
  voiceCapability: string;
}

/** Sent once, right after `welcome`, listing every player already in the world. */
export interface PlayerSnapshotMessage {
  type: "player_snapshot";
  players: PlayerSummary[];
}

export interface PlayerJoinedMessage extends PlayerSummary {
  type: "player_joined";
}

export interface PlayerLeftMessage {
  type: "player_left";
  playerId: string;
}

/** The relay of another player's `PlayerTransformMessage` — same fields, plus who sent it and when the server received it. */
export interface PlayerTransformBroadcastMessage {
  type: "player_transform";
  playerId: string;
  x: number;
  y: number;
  z: number;
  rotationY: number;
  animationState: AnimationState;
  seq: number;
  /**
   * Server receive time, ms since epoch. NOT currently used by the
   * client's interpolation buffer — CORE-002 does no clock
   * synchronization, so mixing this server-clock value with the
   * client's own `performance.now()` timeline would be meaningless.
   * `apps/web/src/networking/RemotePlayer.ts` keys its interpolation
   * samples by local receive time instead (see
   * `apps/web/src/networking/interpolation.ts`). This field is kept for
   * diagnostics and potential future clock-sync work; it is not an
   * implicit claim that the client interpolates against server time.
   */
  t: number;
}

/**
 * Broadcast to every joined client (including the renaming client itself)
 * whenever a session's nickname changes — the initial `join` nickname
 * accepted into `welcome`/`player_snapshot`/`player_joined` does not
 * trigger this; only a later `set_nickname` does. `nickname` is the
 * server-accepted value, which may differ from what was requested (see
 * `SetNicknameMessage`).
 */
export interface NicknameUpdatedMessage {
  type: "nickname_updated";
  playerId: string;
  nickname: string;
}

export type ServerToClientMessage =
  | WelcomeMessage
  | PlayerSnapshotMessage
  | PlayerJoinedMessage
  | PlayerLeftMessage
  | PlayerTransformBroadcastMessage
  | NicknameUpdatedMessage;
