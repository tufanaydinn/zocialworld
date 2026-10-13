import type {
  AnimationState,
  WelcomeMessage,
  PlayerSnapshotMessage,
  PlayerJoinedMessage,
  PlayerLeftMessage,
  PlayerTransformBroadcastMessage,
  NicknameUpdatedMessage,
  ChatChannel,
  ChatMessageBroadcast,
  ChatRejectedMessage,
  PayRequestRelay,
  PayAcceptRelay,
  PayDeclineRelay,
  PayNoticeRelay,
  PayErrorMessage,
  PayRequestMessage,
  PayAcceptMessage,
  PayDeclineMessage,
  PayNoticeMessage,
  PaySentMessage,
  PayCancelMessage,
  PayCancelRelay,
  HallClientMessage,
  HallServerMessage,
  AvatarUpdatedMessage,
  CanReceiveUpdatedMessage,
  NicknameCheckResultMessage,
  NameQuoteMessage,
  NameStatusMessage,
  NameChallengeMessage,
  NameKeyAlg,
  PlayerAvatar,
  ModActionMessage,
  ModCloseReason,
  ModerationNoticeMessage,
  ModerationServerMessage,
  ReportReason,
} from "@project/shared";
import { MOD_CLOSE_CODES } from "@project/shared";
import { parseIncomingMessage } from "./protocol.ts";

export type ConnectionState = "disconnected" | "connecting" | "connected";

/**
 * ADR-015: who this client joins as. Kept for every (re)join of this page session:
 * a reconnect sends the same `wallet` flag and `avatar`, plus the last nickname the server accepted.
 */
export interface JoinIdentity {
  /** The wallet-holder flag (client-asserted). */
  wallet: boolean;
  /** A holder's chosen look; omitted for guests (the server gives them the default anyway). */
  avatar?: PlayerAvatar;
  /** A name to ask for on the first join (a reconnect uses the last accepted one instead). */
  nickname?: string;
}

/** The pose fields of a published transform (what the unchanged-pose skip compares). */
export interface PublishedPose {
  x: number;
  y: number;
  z: number;
  rotationY: number;
  animationState: AnimationState;
}

const HEARTBEAT_INTERVAL_MS = 5000;
/** Reconnect backoff: 1 s, 2 s, 4 s … capped, with ±25 % jitter so a server restart isn't hit by every client at once. */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

export interface NetworkClientEvents {
  onStateChange?: (state: ConnectionState) => void;
  onWelcome?: (message: WelcomeMessage) => void;
  onSnapshot?: (message: PlayerSnapshotMessage) => void;
  onPlayerJoined?: (message: PlayerJoinedMessage) => void;
  onPlayerLeft?: (message: PlayerLeftMessage) => void;
  onPlayerTransform?: (message: PlayerTransformBroadcastMessage) => void;
  /** Fires for ANY session's nickname change, including this client's own — check `message.playerId`. */
  onNicknameUpdated?: (message: NicknameUpdatedMessage) => void;
  /** An accepted chat line (including this client's own, echoed back). */
  onChatMessage?: (message: ChatMessageBroadcast) => void;
  onChatRejected?: (message: ChatRejectedMessage) => void;
  /** ADR-013: one handler for every relayed payment message. */
  onPayment?: (message: PayRequestRelay | PayAcceptRelay | PayDeclineRelay | PayNoticeRelay | PayCancelRelay | PayErrorMessage) => void;
  /** One handler for every Watch Hall message (members only, plus hall_error to the sender) — see apps/web/src/hall/HallStore.ts. */
  onHall?: (message: HallServerMessage) => void;
  /** ADR-015: any player's avatar changed (including this client's own — check `message.playerId`). */
  onAvatarUpdated?: (message: AvatarUpdatedMessage) => void;
  /** ADR-015: any player's wallet-holder flag changed (including this client's own). */
  onCanReceiveUpdated?: (message: CanReceiveUpdatedMessage) => void;
  /** ADR-015: the answer to `checkNickname` (works before join). */
  onNicknameCheckResult?: (message: NicknameCheckResultMessage) => void;
  /** ADR-016: owner-only answers about owned names (quote, status, claim challenge) — works before join. */
  onName?: (message: NameQuoteMessage | NameStatusMessage | NameChallengeMessage) => void;
  /** ADR-019: report acks, moderator state and results, notices to a target, the Moderator tag. */
  onModeration?: (message: ModerationServerMessage) => void;
  /**
   * The server closed this socket on purpose — kicked, banned, or too many connections from this network
   * (MOD_CLOSE_CODES) — with the notice it sent just before (null if none arrived). The client does NOT reconnect on its
   * own after this; `reconnect()` tries again when the player asks.
   */
  onClosedByServer?: (reason: ModCloseReason, notice: ModerationNoticeMessage | null) => void;
}

const CLOSE_REASONS = new Map<number, ModCloseReason>(Object.entries(MOD_CLOSE_CODES).map(([reason, code]) => [code, reason as ModCloseReason]));

/**
 * Owns the WebSocket connection to apps/server and nothing else — no
 * scene access, no player objects. `App.ts` wires its callbacks to
 * whatever needs to react (spawning/removing RemotePlayers, publishing
 * LocalPlayer's own transform).
 *
 * Deferred join (ADR-015): `connect()` only opens the socket
 * and starts heartbeats, so onboarding can run (and ask `nickname_check`)
 * before the player exists for anyone. `join(identity)` sends the join —
 * at once if the socket is open, otherwise as soon as it opens. Until
 * then the player is invisible to others and transforms are not sent.
 *
 * Automatic reconnection: after an unexpected close the
 * client retries with exponential backoff (1 s → 15 s, jittered) and,
 * once `join()` was called, rejoins with the same identity (wallet flag,
 * avatar) and the last nickname the server accepted. Every reconnect is
 * a NEW session (new playerId, fresh voice capability) — the server keeps
 * no state for dropped sessions. `disconnect()` stops retrying.
 *
 * Unchanged poses are not re-sent (ADR-014): heartbeats
 * prove liveness, so a seated audience sends almost nothing. The first
 * transform of every (re)connected session is always sent.
 */
export class NetworkClient {
  private socket: WebSocket | null = null;
  private state: ConnectionState = "disconnected";
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private wantConnection = false;

  private readonly url: string;
  /** Last nickname the server accepted for this client (or the one first asked for) — reused when rejoining after a reconnect. */
  private nickname: string | undefined;
  /** ADR-015: who to join as — null until `join()` (onboarding still open). */
  private identity: { wallet: boolean; avatar?: PlayerAvatar } | null = null;
  /** Whether `join` has been sent on the current socket. */
  private joinSent = false;
  private ownPlayerId: string | null = null;
  /** The last transform this session actually sent (null until the first one after connecting). */
  private lastSentPose: PublishedPose | null = null;
  /** The last moderation_notice on the current socket (a kick/ban/refusal close carries its details). */
  private lastNotice: ModerationNoticeMessage | null = null;
  private readonly events: NetworkClientEvents;

  constructor(url: string, events: NetworkClientEvents, nickname?: string) {
    this.url = url;
    this.events = events;
    this.nickname = nickname;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  /** Whether this socket's session has been welcomed (joined): the player exists for others. */
  get joined(): boolean {
    return this.ownPlayerId !== null;
  }

  /** Whether `join()` was called this page session (the player left onboarding). */
  get joinRequested(): boolean {
    return this.identity !== null;
  }

  /**
   * ADR-015: joins the world as `identity` — now if the socket is open, else when it opens. Later
   * calls only update the identity used by reconnects (a session joins once).
   */
  join(identity: JoinIdentity): void {
    this.identity = { wallet: identity.wallet, ...(identity.avatar ? { avatar: { ...identity.avatar } } : {}) };
    if (identity.nickname !== undefined) this.nickname = identity.nickname;
    if (this.socket?.readyState === WebSocket.OPEN) this.sendJoin();
  }

  connect(): void {
    this.wantConnection = true;
    if (this.socket) return; // already connecting/connected
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.setState("connecting");
    const socket = new WebSocket(this.url);
    this.socket = socket;

    this.lastNotice = null;
    socket.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      this.lastSentPose = null; // a new session starts at the server's origin pose: always send the first transform
      this.joinSent = false;
      this.setState("connected");
      // ADR-015: no join until onboarding is done (join()); a reconnect rejoins with the same identity.
      if (this.identity) this.sendJoin();
      this.heartbeatTimer = setInterval(() => this.send({ type: "heartbeat" }), HEARTBEAT_INTERVAL_MS);
    });

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || typeof event.data !== "string") return;
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        return;
      }
      this.dispatchIncoming(parseIncomingMessage(raw));
    });

    // A late event from an old socket must never tear down its replacement.
    socket.addEventListener("close", (event: { code?: number }) => {
      if (this.socket !== socket) return;
      // Kicked, banned or refused — say so and stay disconnected (an automatic retry would only be refused).
      const reason = typeof event?.code === "number" ? CLOSE_REASONS.get(event.code) : undefined;
      if (reason) {
        this.wantConnection = false;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        // Before the state change, so the app shows this instead of "reconnecting…".
        this.events.onClosedByServer?.(reason, this.lastNotice);
      }
      this.teardown();
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket) this.teardown();
    });
  }

  /** After a kick/ban/refusal close, the player asks to try again (the server decides). */
  reconnect(): void {
    this.reconnectAttempts = 0;
    this.connect();
  }

  disconnect(): void {
    this.wantConnection = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.teardown();
  }

  /**
   * Publishes this client's own transform. Never used for any other player — see RemotePlayer for
   * how remote transforms are applied. Skipped (returns false) when x/y/z/rotationY/animationState
   * equal the last transform sent on this connection: heartbeats keep the session
   * alive, and the server keeps the last pose for hall membership and seats. Any change — including
   * a walk/jog animation that releases a seat — is sent at once.
   */
  sendTransform(transform: PublishedPose, seq: number): boolean {
    // Before join the server ignores transforms — and the skip below would then hold back the first real one.
    if (this.socket?.readyState !== WebSocket.OPEN || !this.joinSent) return false;
    const last = this.lastSentPose;
    if (
      last &&
      last.x === transform.x &&
      last.y === transform.y &&
      last.z === transform.z &&
      last.rotationY === transform.rotationY &&
      last.animationState === transform.animationState
    ) {
      return false;
    }
    this.lastSentPose = { x: transform.x, y: transform.y, z: transform.z, rotationY: transform.rotationY, animationState: transform.animationState };
    this.send({ type: "player_transform", ...this.lastSentPose, seq });
    return true;
  }

  /**
   * Requests a nickname change for this client's own session.
   * The server is authoritative — the accepted value (possibly
   * conflict-suffixed, or unchanged if this request was invalid) arrives
   * back via `onNicknameUpdated`, not as a return value here. A no-op if
   * not currently connected (same silent-drop behavior as any other send
   * while disconnected — see `send()`).
   */
  sendNickname(nickname: string): void {
    this.send({ type: "set_nickname", nickname });
  }

  /**
   * ADR-015: the wallet-holder flag changed (true on the wallet's first ready/syncing this page
   * session, false only on "Forget this wallet"). Remembered for every later (re)join; sent as
   * `set_wallet` once joined. Only the boolean ever leaves the browser.
   */
  sendWallet(connected: boolean): void {
    if (this.identity) this.identity.wallet = connected;
    if (!connected && this.identity) delete this.identity.avatar; // a guest always has the default look
    if (this.joinSent) this.send({ type: "set_wallet", connected });
  }

  /** ADR-015: a wallet holder's new look — remembered for rejoins, sent as `set_avatar` once joined. The server answers with `avatar_updated`. */
  sendAvatar(avatar: PlayerAvatar): void {
    if (this.identity) this.identity.avatar = { ...avatar };
    if (this.joinSent) this.send({ type: "set_avatar", avatar: { ...avatar } });
  }

  /** ADR-015: asks whether a nickname is free right now (works before join; nothing is reserved). The answer arrives via `onNicknameCheckResult`. */
  checkNickname(nickname: string): void {
    this.send({ type: "nickname_check", nickname });
  }

  /**
   * ADR-016: reserve `nickname` for the name key with this hash (works before join). The answer is a `name_quote`
   * (pay it with the wallet) or a `name_status` refusal, via `onName`.
   */
  sendNameReserve(nickname: string, keyHash: string): void {
    this.send({ type: "name_reserve", nickname, keyHash });
  }

  /** ADR-016: ask for a challenge to prove an owned name (a returning player; works before join). */
  sendNameClaimRequest(nickname: string): void {
    this.send({ type: "name_claim_request", nickname });
  }

  /** ADR-018: the txid of this connection's name-fee payment (the lightwalletd registry backend reads it; works before join). */
  sendNamePaymentSent(reservationId: string, txid: string): void {
    this.send({ type: "name_payment_sent", reservationId, txid });
  }

  /** ADR-016: the signed answer to `name_challenge` (raw public key and signature, base64url). */
  sendNameClaimProof(proof: { nickname: string; publicKey: string; signature: string; alg: NameKeyAlg }): void {
    this.send({ type: "name_claim_proof", ...proof });
  }

  /** Whether the socket is open (name requests and checks can be sent, before or after join). */
  get socketOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Sends a chat line to a channel; the accepted line comes back via `onChatMessage`. */
  sendChat(channel: ChatChannel, text: string): void {
    this.send({ type: "chat_send", channel, text });
  }

  /** A private message to one player (by session playerId). */
  sendWhisper(to: string, text: string): void {
    this.send({ type: "whisper_send", to, text });
  }

  /** ADR-013: sends one payment handshake message (the server relays it; fields are sealed/opaque). */
  sendPayment(message: PayRequestMessage | PayAcceptMessage | PayDeclineMessage | PayNoticeMessage | PaySentMessage | PayCancelMessage): void {
    this.send({ ...message });
  }

  /** One Watch Hall request (stage, card, floor, reaction, hand, seat, host auth). Results arrive via `onHall`. */
  sendHall(message: HallClientMessage): void {
    this.send({ ...message });
  }

  /** Report a player (the answer is a `report_ack` via `onModeration`). */
  sendReport(targetId: string, reason: ReportReason, note?: string): void {
    this.send({ type: "report", targetId, reason, ...(note ? { note } : {}) });
  }

  /** A moderator's action (the answer is a `mod_action_result` via `onModeration`). */
  sendModAction(message: Omit<ModActionMessage, "type">): void {
    this.send({ type: "mod_action", ...message });
  }

  private dispatchIncoming(message: ReturnType<typeof parseIncomingMessage>): void {
    if (!message) return;

    switch (message.type) {
      case "welcome":
        this.ownPlayerId = message.playerId;
        this.nickname = message.nickname;
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
        if (message.playerId === this.ownPlayerId) this.nickname = message.nickname;
        this.events.onNicknameUpdated?.(message);
        return;
      case "avatar_updated":
        if (message.playerId === this.ownPlayerId && this.identity?.wallet) this.identity.avatar = { ...message.avatar };
        this.events.onAvatarUpdated?.(message);
        return;
      case "can_receive_updated":
        this.events.onCanReceiveUpdated?.(message);
        return;
      case "nickname_check_result":
        this.events.onNicknameCheckResult?.(message);
        return;
      case "name_quote":
      case "name_status":
      case "name_challenge":
        this.events.onName?.(message);
        return;
      case "chat_message":
        this.events.onChatMessage?.(message);
        return;
      case "chat_rejected":
        this.events.onChatRejected?.(message);
        return;
      case "pay_request":
      case "pay_accept":
      case "pay_decline":
      case "pay_notice":
      case "pay_cancel":
      case "pay_error":
        this.events.onPayment?.(message);
        return;
      case "hall_state":
      case "hall_exit":
      case "hall_stage":
      case "hall_seat":
      case "hall_hands":
      case "hall_floor":
      case "hall_hosts":
      case "hall_reactions":
      case "hall_vote":
      case "hall_error":
        this.events.onHall?.(message);
        return;
      case "moderation_notice":
        this.lastNotice = message;
        this.events.onModeration?.(message);
        return;
      case "report_ack":
      case "mod_report":
      case "mod_action_result":
      case "mod_log":
      case "moderator_updated":
        this.events.onModeration?.(message);
        return;
      default:
        message satisfies never; // a new ServerToClientMessage without a case fails to compile
        return;
    }
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  /** The join for the current socket: identity + the last accepted (or first requested) nickname. Once per socket. */
  private sendJoin(): void {
    if (this.joinSent || !this.identity) return;
    this.joinSent = true;
    this.send({
      type: "join",
      ...(this.nickname !== undefined ? { nickname: this.nickname } : {}),
      ...(this.identity.avatar ? { avatar: { ...this.identity.avatar } } : {}),
      wallet: this.identity.wallet,
    });
  }

  private teardown(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const hadSocket = this.socket !== null;
    this.socket = null;
    this.ownPlayerId = null;
    this.joinSent = false;
    this.lastSentPose = null;
    if (hadSocket || this.state !== "disconnected") this.setState("disconnected");
    if (this.wantConnection && !this.reconnectTimer) {
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts) * (0.75 + Math.random() * 0.5);
      this.reconnectAttempts++;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.wantConnection) this.connect();
      }, delay);
    }
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.events.onStateChange?.(state);
  }
}
