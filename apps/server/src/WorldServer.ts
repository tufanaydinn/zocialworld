import type { WebSocket, WebSocketServer, RawData } from "ws";
import { parseIncomingFrame } from "./protocol.js";
import { generatePlayerId, generateGuestNickname, deriveColorSeed } from "./identity.js";
import { sanitizeNickname, resolveUniqueNickname } from "./nickname.js";
import { VoiceCapabilityRegistry } from "./voice/capability.js";
import { DEFAULT_TICK_RATE_HZ, type AnimationState, type ServerToClientMessage, type PlayerSummary } from "@project/shared";

const RATE_LIMIT_PER_SECOND = 30;
const RATE_LIMIT_WINDOW_MS = 1000;
const DEFAULT_STALE_TIMEOUT_MS = 15000;
const DEFAULT_SWEEP_INTERVAL_MS = 5000;

interface Pose {
  x: number;
  y: number;
  z: number;
  rotationY: number;
  animationState: AnimationState;
}

const ORIGIN_POSE: Pose = { x: 0, y: 0, z: 0, rotationY: 0, animationState: "idle" };

interface Session {
  ws: WebSocket;
  playerId: string;
  nickname: string;
  colorSeed: number;
  joined: boolean;
  lastSeenAt: number;
  pose: Pose;
  rateWindowStart: number;
  rateCount: number;
}

export interface WorldServerOptions {
  /** Connection is closed if idle (no valid message received) longer than this. Default 15000ms. */
  staleTimeoutMs?: number;
  /** How often the stale-connection sweep runs. Default 5000ms. */
  sweepIntervalMs?: number;
  /** Injectable clock, for deterministic tests. Default `Date.now`. */
  now?: () => number;
}

/**
 * Owns connection lifecycle, temporary player identity, join/leave
 * broadcast, transform relay, and stale-connection cleanup for one
 * prototype world instance.
 *
 * Deliberately NOT owned here (see CORE-002 §6 / docs/protocols):
 * wallet identity, authentication, persistent accounts, chat, voice,
 * projects, any database. This class is relay + sanity validation only
 * — see docs/decisions/ADR-001-client-authoritative-movement.md for why
 * it doesn't simulate or correct player positions.
 */
export class WorldServer {
  private readonly sessions = new Map<WebSocket, Session>();
  /** Secondary index for O(1) playerId -> Session lookup — see `resolveVoiceSession()`. Kept in sync with `sessions` on join/close only (never on rename — nickname lives on the Session object itself, read fresh). */
  private readonly sessionsByPlayerId = new Map<string, Session>();
  /** CORE-004 security revision: issues/resolves/revokes ephemeral voice capabilities — see `apps/server/src/voice/capability.ts`. */
  private readonly voiceCapabilities = new VoiceCapabilityRegistry();
  private readonly staleTimeoutMs: number;
  private readonly now: () => number;
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(wss: WebSocketServer, options: WorldServerOptions = {}) {
    this.staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());

    wss.on("connection", (ws: WebSocket) => this.handleConnection(ws));

    const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.sweepTimer = setInterval(() => this.sweepStaleConnections(), sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /** Number of connections that have completed `join` (i.e. count as a visible player). */
  get playerCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) if (session.joined) count++;
    return count;
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
  }

  private handleConnection(ws: WebSocket): void {
    const session: Session = {
      ws,
      playerId: generatePlayerId(),
      nickname: "",
      colorSeed: 0,
      joined: false,
      lastSeenAt: this.now(),
      pose: { ...ORIGIN_POSE },
      rateWindowStart: this.now(),
      rateCount: 0,
    };
    this.sessions.set(ws, session);

    ws.on("message", (data: RawData) => this.handleMessage(session, data));
    ws.on("close", () => this.handleClose(session));
    ws.on("error", () => {
      /* 'close' always follows 'error' for ws sockets — cleanup happens there. */
    });
  }

  private handleMessage(session: Session, data: RawData): void {
    if (!this.consumeRateLimitToken(session)) return;

    const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : "";
    const message = parseIncomingFrame(text);
    if (!message) return; // unknown type, malformed JSON, oversized, or failed field validation — drop silently

    session.lastSeenAt = this.now();

    switch (message.type) {
      case "join":
        this.handleJoin(session, message.nickname);
        return;
      case "player_transform":
        this.handlePlayerTransform(session, message);
        return;
      case "set_nickname":
        this.handleSetNickname(session, message.nickname);
        return;
      case "heartbeat":
        return; // lastSeenAt already updated above
    }
  }

  private consumeRateLimitToken(session: Session): boolean {
    const now = this.now();
    if (now - session.rateWindowStart >= RATE_LIMIT_WINDOW_MS) {
      session.rateWindowStart = now;
      session.rateCount = 0;
    }
    session.rateCount++;
    return session.rateCount <= RATE_LIMIT_PER_SECOND;
  }

  private handleJoin(session: Session, requestedNickname: string | undefined): void {
    if (session.joined) return; // a second join on the same connection is a no-op, not an error

    // An invalid/missing requested nickname falls back to a generated
    // Guest-#### — see docs/protocols/multiplayer-protocol.md § Nickname
    // validation and conflict resolution. A *valid* candidate still goes
    // through conflict resolution below, same as any other join.
    const sanitized = requestedNickname !== undefined ? sanitizeNickname(requestedNickname) : null;
    const candidate = sanitized ?? generateGuestNickname();
    session.nickname = this.resolveUniqueNicknameFor(candidate, session);
    session.colorSeed = deriveColorSeed(session.playerId);
    session.joined = true;
    this.sessionsByPlayerId.set(session.playerId, session);

    this.send(session, {
      type: "welcome",
      playerId: session.playerId,
      nickname: session.nickname,
      colorSeed: session.colorSeed,
      tickRateHz: DEFAULT_TICK_RATE_HZ,
      // Owner-only — see WelcomeMessage.voiceCapability's docstring.
      // Issued once per join; a reconnect (a brand-new playerId) always
      // gets a fresh one via this same call, never a reused value.
      voiceCapability: this.voiceCapabilities.issue(session.playerId),
    });

    this.send(session, {
      type: "player_snapshot",
      players: this.collectSummaries(session),
    });

    this.broadcastExcept(session, {
      type: "player_joined",
      playerId: session.playerId,
      nickname: session.nickname,
      colorSeed: session.colorSeed,
      ...session.pose,
    });
  }

  private handlePlayerTransform(
    session: Session,
    message: { x: number; y: number; z: number; rotationY: number; animationState: AnimationState; seq: number },
  ): void {
    if (!session.joined) return; // transforms from a connection that hasn't joined yet are ignored

    session.pose = {
      x: message.x,
      y: message.y,
      z: message.z,
      rotationY: message.rotationY,
      animationState: message.animationState,
    };

    this.broadcastExcept(session, {
      type: "player_transform",
      playerId: session.playerId,
      x: message.x,
      y: message.y,
      z: message.z,
      rotationY: message.rotationY,
      animationState: message.animationState,
      seq: message.seq,
      t: this.now(),
    });
  }

  /**
   * CORE-003: renames an already-joined session. An invalid nickname is
   * dropped silently — the session keeps its current nickname, no error
   * is sent back (consistent with how a malformed `player_transform` is
   * handled). A valid nickname that collides with another session's
   * current nickname is resolved the same deterministic way as a join
   * conflict (§ resolveUniqueNicknameFor).
   */
  private handleSetNickname(session: Session, requestedNickname: string): void {
    if (!session.joined) return; // can't rename a connection that hasn't completed join

    const sanitized = sanitizeNickname(requestedNickname);
    if (!sanitized) return;

    const resolved = this.resolveUniqueNicknameFor(sanitized, session);
    if (resolved === session.nickname) return; // no-op — nothing changed, nothing to broadcast

    session.nickname = resolved;
    this.broadcastAll({ type: "nickname_updated", playerId: session.playerId, nickname: resolved });
  }

  /** True if some *other* joined session is currently showing this nickname. */
  private isNicknameTaken(nickname: string, exclude: Session): boolean {
    for (const session of this.sessions.values()) {
      if (session === exclude || !session.joined) continue;
      if (session.nickname === nickname) return true;
    }
    return false;
  }

  private resolveUniqueNicknameFor(candidate: string, exclude: Session): string {
    return resolveUniqueNickname(candidate, (name) => this.isNicknameTaken(name, exclude));
  }

  private handleClose(session: Session): void {
    const wasJoined = session.joined;
    this.sessions.delete(session.ws);
    this.sessionsByPlayerId.delete(session.playerId);
    // CORE-004 security revision: a disconnect (clean close OR the stale
    // sweep's ws.terminate(), which triggers this same 'close' handler —
    // see sweepStaleConnections) immediately invalidates this session's
    // voice capability. There is no separate "disconnected but capability
    // still works" window.
    this.voiceCapabilities.revoke(session.playerId);
    if (wasJoined) {
      this.broadcastExcept(session, { type: "player_left", playerId: session.playerId });
    }
  }

  /**
   * CORE-004 security revision: the ONLY way `/voice/token` (see
   * `apps/server/src/voice/tokenHandler.ts`) learns a caller's identity
   * — resolves an opaque capability (see `VoiceCapabilityRegistry`) to
   * the authoritative `{ playerId, nickname }` of the session it was
   * issued to, reading the CURRENT nickname fresh from live session
   * state so a post-join `set_nickname` is always reflected. Returns
   * `null` for an unknown, revoked, or superseded capability — the
   * caller must treat that as "reject this request", never as "fall
   * back to a browser-supplied value" (there is no such fallback;
   * nothing browser-supplied is ever trusted here). This is the one
   * narrow lookup the voice module is allowed to call on `WorldServer` —
   * nothing else about session internals is exposed.
   */
  resolveVoiceSession(capability: string): { playerId: string; nickname: string } | null {
    const playerId = this.voiceCapabilities.resolve(capability);
    if (!playerId) return null;
    const session = this.sessionsByPlayerId.get(playerId);
    if (!session) return null; // defensive — shouldn't happen, since revoke() always runs alongside session removal
    return { playerId: session.playerId, nickname: session.nickname };
  }

  private sweepStaleConnections(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (now - session.lastSeenAt > this.staleTimeoutMs) {
        session.ws.terminate(); // triggers 'close', which performs removal + player_left broadcast
      }
    }
  }

  private collectSummaries(exclude: Session): PlayerSummary[] {
    const summaries: PlayerSummary[] = [];
    for (const session of this.sessions.values()) {
      if (session === exclude || !session.joined) continue;
      summaries.push({
        playerId: session.playerId,
        nickname: session.nickname,
        colorSeed: session.colorSeed,
        ...session.pose,
      });
    }
    return summaries;
  }

  private broadcastExcept(exclude: Session, message: ServerToClientMessage): void {
    const payload = JSON.stringify(message);
    for (const session of this.sessions.values()) {
      if (session === exclude || !session.joined) continue;
      if (session.ws.readyState === session.ws.OPEN) session.ws.send(payload);
    }
  }

  private send(session: Session, message: ServerToClientMessage): void {
    if (session.ws.readyState === session.ws.OPEN) session.ws.send(JSON.stringify(message));
  }

  /** Sends to every joined session, including one that caused the message (e.g. the renaming client itself needs to see the server-resolved nickname). */
  private broadcastAll(message: ServerToClientMessage): void {
    const payload = JSON.stringify(message);
    for (const session of this.sessions.values()) {
      if (!session.joined) continue;
      if (session.ws.readyState === session.ws.OPEN) session.ws.send(payload);
    }
  }
}
