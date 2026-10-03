import type {
  AnimationState,
  WelcomeMessage,
  PlayerSnapshotMessage,
  PlayerJoinedMessage,
  PlayerLeftMessage,
  PlayerTransformBroadcastMessage,
  NicknameUpdatedMessage,
} from "@project/shared";
import { parseIncomingMessage } from "./protocol.ts";

export type ConnectionState = "disconnected" | "connecting" | "connected";

const HEARTBEAT_INTERVAL_MS = 5000;

export interface NetworkClientEvents {
  onStateChange?: (state: ConnectionState) => void;
  onWelcome?: (message: WelcomeMessage) => void;
  onSnapshot?: (message: PlayerSnapshotMessage) => void;
  onPlayerJoined?: (message: PlayerJoinedMessage) => void;
  onPlayerLeft?: (message: PlayerLeftMessage) => void;
  onPlayerTransform?: (message: PlayerTransformBroadcastMessage) => void;
  /** CORE-003: fires for ANY session's nickname change, including this client's own — check `message.playerId`. */
  onNicknameUpdated?: (message: NicknameUpdatedMessage) => void;
}

/**
 * Owns the WebSocket connection to apps/server and nothing else — no
 * scene access, no player objects. `App.ts` wires its callbacks to
 * whatever needs to react (spawning/removing RemotePlayers, publishing
 * LocalPlayer's own transform).
 *
 * No automatic reconnection in CORE-002: on close/error the state simply
 * becomes "disconnected" and stays there until `connect()` is called
 * again. A reconnect-with-backoff policy is reasonable future work but
 * isn't required by CORE-002's acceptance criteria, and guessing at a
 * backoff policy here would be scope creep — see
 * packages/multiplayer/README.md "Known limitations".
 */
export class NetworkClient {
  private socket: WebSocket | null = null;
  private state: ConnectionState = "disconnected";
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private readonly url: string;
  private readonly nickname: string | undefined;
  private readonly events: NetworkClientEvents;

  constructor(url: string, events: NetworkClientEvents, nickname?: string) {
    this.url = url;
    this.events = events;
    this.nickname = nickname;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  connect(): void {
    if (this.socket) return; // already connecting/connected

    this.setState("connecting");
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.setState("connected");
      this.send({ type: "join", nickname: this.nickname });
      this.heartbeatTimer = setInterval(() => this.send({ type: "heartbeat" }), HEARTBEAT_INTERVAL_MS);
    });

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        return;
      }
      this.dispatchIncoming(parseIncomingMessage(raw));
    });

    socket.addEventListener("close", () => this.teardown());
    socket.addEventListener("error", () => this.teardown());
  }

  disconnect(): void {
    this.socket?.close();
    this.teardown();
  }

  /** Publishes this client's own transform. Never used for any other player — see RemotePlayer for how remote transforms are applied. */
  sendTransform(
    transform: { x: number; y: number; z: number; rotationY: number; animationState: AnimationState },
    seq: number,
  ): void {
    this.send({ type: "player_transform", ...transform, seq });
  }

  /**
   * Requests a nickname change for this client's own session (CORE-003).
   * The server is authoritative — the accepted value (possibly
   * conflict-suffixed, or unchanged if this request was invalid) arrives
   * back via `onNicknameUpdated`, not as a return value here. A no-op if
   * not currently connected (same silent-drop behavior as any other send
   * while disconnected — see `send()`).
   */
  sendNickname(nickname: string): void {
    this.send({ type: "set_nickname", nickname });
  }

  private dispatchIncoming(message: ReturnType<typeof parseIncomingMessage>): void {
    if (!message) return;

    switch (message.type) {
      case "welcome":
        this.events.onWelcome?.(message);
        return;
      case "player_snapshot":
        this.events.onSnapshot?.(message);
        return;
      case "player_joined":
        this.events.onPlayerJoined?.(message);
        return;
      case "player_left":
        this.events.onPlayerLeft?.(message);
        return;
      case "player_transform":
        this.events.onPlayerTransform?.(message);
        return;
      case "nickname_updated":
        this.events.onNicknameUpdated?.(message);
        return;
    }
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private teardown(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.socket = null;
    this.setState("disconnected");
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.events.onStateChange?.(state);
  }
}
