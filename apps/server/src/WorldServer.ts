import type { IncomingMessage } from "node:http";
import type { WebSocket, WebSocketServer, RawData } from "ws";
import { parseIncomingFrame } from "./protocol.js";
import { generatePlayerId, generateGuestNickname, deriveColorSeed, defaultAvatar, isGuestNickname } from "./identity.js";
import { sanitizeNickname, resolveUniqueNickname, isReservedNickname, nicknameKey } from "./nickname.js";
import { VoiceCapabilityRegistry } from "./voice/capability.js";
import { ChatRateLimiter, sanitizeChatText } from "./chat.js";
import { PaymentRelay } from "./payments.js";
import { HALL_HOST_ATTEMPTS_PER_SESSION, WatchHall, type HallEffect } from "./watchHall.js";
import { TokenBucket } from "./tokenBucket.js";
import { NameService, type NameRegistryInfo } from "./identity/nameService.js";
import type { TransferFees } from "./transferFees.js";
import type { NameUpdate } from "./identity/nameRegistry.js";
import { Moderation, type LiftedMute, type ModerationKeys, type ModerationViewer } from "./moderation/moderation.js";
import { isModeratorKey, type ModeratorKeySet } from "./moderation/moderatorKeys.js";
import { AddressHasher, isInternalAddress, requestOrigin } from "./moderation/clientAddress.js";
import { ConnectionLimits } from "./moderation/connectionLimits.js";
import type { PublisherControl } from "./voice/roomAdmin.js";
import {
  DEFAULT_TICK_RATE_HZ,
  MOD_CLOSE_CODES,
  NEARBY_CHAT_RADIUS_METERS,
  REPORT_NOTE_MAX,
  type AnimationState,
  type ChatChannel,
  type ChatRejectReason,
  type ClientToServerMessage,
  type HallClientMessage,
  type JoinMessage,
  type ModActionError,
  type ModActionMessage,
  type ModCloseReason,
  type NameClaimProofMessage,
  type NameStatus,
  type NicknameCheckStatus,
  type PayErrorReason,
  type PlayerAvatar,
  type ReportAckStatus,
  type ReportLocation,
  type ReportMessage,
  type ServerToClientMessage,
  type PlayerSummary,
} from "@project/shared";

const RATE_LIMIT_PER_SECOND = 30;
const RATE_LIMIT_WINDOW_MS = 1000;
// 30 s — a client can legitimately stall for >15 s on a slow machine (first visit to
// a location builds its scene on the main thread); dropping it then also ended its voice session.
const DEFAULT_STALE_TIMEOUT_MS = 30000;
const DEFAULT_SWEEP_INTERVAL_MS = 5000;
/** setTimeout clamps longer delays to 1 ms (a busy loop); the hall timer re-arms after an early wake. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * ADR-015 per-session token buckets ([burst, refill per second]). Every accepted rename, wallet
 * flip or avatar change is broadcast to everyone (and an avatar change makes every high-tier
 * client clone a model), so each is limited on its own; a nickname check is answered to the
 * asker only. A refused request is dropped silently, like an invalid one.
 */
export const IDENTITY_LIMITS = {
  rename: [3, 1 / 10],
  wallet: [2, 1 / 60],
  avatar: [3, 1 / 20],
  nicknameCheck: [5, 1],
  // ADR-016: a reservation or a claim challenge (owner-only answers; reservations are also capped globally).
  nameReserve: [3, 1 / 20],
  nameClaim: [5, 1 / 10],
} as const satisfies Record<string, readonly [number, number]>;

/** How many random guest numbers to try before scanning for a free one (9000 exist). */
const GUEST_NAME_ATTEMPTS = 32;
/** ADR-010: x beyond ±this is Learning Valley (+) or the Watch Hall (−) — the web client's LOCATION_SPLIT_X. */
const LOCATION_SPLIT_X = 500;
/** A socket closed on purpose (kick, ban, refusal) is cut off this long after the close frame if the peer never answers. */
const CLOSE_GRACE_MS = 2000;

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
  chatLimiter: ChatRateLimiter;
  /**
   * ADR-015: this session declared an in-game wallet (`join.wallet` / `set_wallet`) — a wallet
   * holder. Client-asserted (honour system until ADR-016); never anything more than this bit.
   */
  canReceive: boolean;
  /** ADR-015: the chosen look (holders), or the colorSeed default (guests). */
  avatar: PlayerAvatar;
  renameLimiter: TokenBucket;
  walletLimiter: TokenBucket;
  avatarLimiter: TokenBucket;
  nicknameCheckLimiter: TokenBucket;
  /**
   * ADR-016: the owned name this connection confirmed (paid) or claimed (proved), applied at join (holders) or at
   * once (joined holders). Null for guests and for holders without an owned name (they keep a Guest-style name).
   */
  ownedName: string | null;
  nameReserveLimiter: TokenBucket;
  nameClaimLimiter: TokenBucket;
  /**
   * ADR-019 §§ 4–5: the keyed hash of this connection's network address (clientAddress.ts) — what the
   * per-IP cap counts and what a guest's kick, ban or mute is keyed by. The address itself is never kept.
   */
  addressHash: string;
  /** Signed in with a MODERATOR_KEYS key this session (ADR-019 § 1). */
  moderator: boolean;
  /** Key sign-ins tried this session (`hall_host_auth` while moderator keys are configured). */
  keyAttempts: number;
  /** Whether the session could publish voice at its last identity change (losing it revokes the LiveKit grant). */
  mayTalk: boolean;
  /** Until when this session was last told it is muted (0: never) — who hears `unmuted` when a mute is lifted. */
  mutedNoticeUntil: number;
  /** Closed on purpose or gone: cleaned up once, and every later message is ignored. */
  removed: boolean;
}

/** What `/voice/token` (and the faucet) may learn about a capability's session — see `resolveVoiceSession`. */
export interface VoiceSessionIdentity {
  playerId: string;
  nickname: string;
  /** ADR-015: full (publishing) voice grants are for wallet holders only; listen-only grants are not gated. */
  canReceive: boolean;
  /**
   * Whether a full (publishing) grant may be minted — the server-verified identity: an owned name while
   * a name registry runs (the client-asserted holder flag alone is not enough), the holder flag otherwise.
   */
  canTalk: boolean;
}

export interface WorldServerOptions {
  /** Connection is closed if idle (no valid message received) longer than this. Default 30000ms. */
  staleTimeoutMs?: number;
  /** How often the stale-connection sweep runs. Default 5000ms. */
  sweepIntervalMs?: number;
  /** Injectable clock, for deterministic tests. Default `Date.now`. */
  now?: () => number;
  /** WATCH_HALL_HOST_KEY. Unset or shorter than 24 characters disables host features. Never logged. */
  hallHostKey?: string;
  /**
   * WATCH_HALL_MAX_TURN_MS: cap on a stage turn while others are queued and no host is present. Unset: 60 minutes
   * 0: no cap.
   */
  hallMaxTurnMs?: number;
  /** ADR-016: the name registry (identity/nameService.ts). Default: none — ADR-015's honour mode. Disposed with the server. */
  names?: NameService;
  /**
   * ADR-018 § 4: the per-transaction cap on relayed payment requests, in zatoshis (PAYMENT_CAP_ZEC).
   * A request whose `capZat` is missing or larger is refused with `over_cap`. Default: none.
   */
  paymentCapZat?: number | null;
  /** ADR-018 § 6: the transfer fee between players (transferFees.ts). Default: none. Disposed with the server. */
  transferFees?: TransferFees | null;
  /** ADR-018 § 7: the id of the web client build this server serves, announced in `welcome`. */
  buildId?: string | null;
  /** ADR-019 § 1: the MODERATOR_KEYS digests (moderatorKeys.ts). Default: none — nobody can sign in as a moderator. */
  moderatorKeys?: ModeratorKeySet;
  /**
   * ADR-019 § 5: the per-IP cap — concurrent sockets and new connections per minute per network. Default: none (the
   * server entry point, index.ts, passes MAX_SESSIONS_PER_IP; 0 there turns it off).
   */
  connectionLimits?: { readonly maxSessionsPerIp: number; readonly maxNewPerMinute: number } | null;
  /** ADR-019 § 5: TRUST_PROXY — peers whose X-Forwarded-For names the client. Default: none (the socket address counts). */
  trustedProxies?: ReadonlySet<string>;
  /** Injectable for tests: the per-process address hasher (default: a random key). */
  addressHasher?: AddressHasher;
  /** ADR-019 § 6: LiveKit publisher revoke and removal (voice/roomAdmin.ts). Default: none (voice unconfigured). */
  publishers?: PublisherControl | null;
}

/**
 * Owns connection lifecycle, temporary player identity, join/leave
 * broadcast, transform relay, and stale-connection cleanup for one
 * prototype world instance.
 *
 * Deliberately NOT owned here (see docs/protocols):
 * wallet identity, authentication, persistent accounts, voice media,
 * projects, any database. ADR-015 adds exactly one wallet-derived bit per
 * session, `canReceive` (client-asserted: "I have an in-game wallet"),
 * which decides guest vs wallet-holder rules (names, avatars, payments,
 * full voice) — never an address, balance or lock state. Text chat is relay-only: lines
 * are sanitized, rate-limited, delivered and forgotten — never stored
 * or logged. The Watch Hall's rules (ADR-014) live in
 * `watchHall.ts`; this class only routes its messages, delivers the
 * effects it returns and runs its one timer. This class is relay + sanity validation only
 * — see docs/decisions/ADR-005-client-authoritative-movement.md for why
 * it doesn't simulate or correct player positions.
 */
export class WorldServer {
  private readonly sessions = new Map<WebSocket, Session>();
  /** Secondary index for O(1) playerId -> Session lookup — see `resolveVoiceSession()`. Kept in sync with `sessions` on join/close only (never on rename — nickname lives on the Session object itself, read fresh). */
  private readonly sessionsByPlayerId = new Map<string, Session>();
  /** ADR-016: every connection by playerId, joined or not — name requests are answered before join (onboarding). */
  private readonly connectionsById = new Map<string, Session>();
  /** Issues, resolves and revokes ephemeral voice capabilities — see `apps/server/src/voice/capability.ts`. */
  private readonly voiceCapabilities = new VoiceCapabilityRegistry();
  private readonly staleTimeoutMs: number;
  private readonly now: () => number;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private chatSequence = 0;
  /** ADR-013: relays sealed payment handshakes between two sessions (never sees addresses or amounts). */
  private readonly payments: PaymentRelay;
  /** Hall membership, stage, seats, hands, floor, reactions, host role — in memory only. */
  private readonly hall: WatchHall;
  /** One lazy timer for the hall's deadlines (prepare timeout, leave grace, max turn, reaction flush). */
  private hallTimer: ReturnType<typeof setTimeout> | null = null;
  private hallTimerAt: number | null = null;
  /** ADR-016: owned names — reservations, fee payments, claims (identity/). */
  private readonly names: NameService;
  /** ADR-018 § 4: the payment cap (zatoshis) or null. */
  private readonly paymentCapZat: number | null;
  /** ADR-018 § 6: the transfer fee, or null when this server charges none. */
  private readonly fees: TransferFees | null;
  /** ADR-018 § 7: the served client's build id (welcome.build), or null. */
  private readonly buildId: string | null;
  /** ADR-019: reports, mutes, kicks, bans and the moderation log — in memory (long name bans in names.json). */
  private readonly moderation: Moderation;
  private readonly moderatorKeys: ModeratorKeySet;
  private readonly connectionLimits: ConnectionLimits | null;
  private readonly trustedProxies: ReadonlySet<string>;
  private readonly addressHasher: AddressHasher;
  private readonly publishers: PublisherControl | null;
  /** The trusted proxy forwarded an internal address once — warned (once per process, never the address). */
  private warnedInternalForward = false;
  private disposed = false;

  constructor(wss: WebSocketServer, options: WorldServerOptions = {}) {
    this.staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.payments = new PaymentRelay(this.now);
    this.hall = new WatchHall(this.now, {
      ...(options.hallHostKey !== undefined ? { hostKey: options.hallHostKey } : {}),
      ...(options.hallMaxTurnMs !== undefined ? { maxTurnMs: options.hallMaxTurnMs } : {}),
      // The hall never trusts a client about who may present, talk hall-wide or vote — it asks here.
      mayPresent: (playerId) => this.mayPresent(this.sessionsByPlayerId.get(playerId)),
      mayVote: (playerId) => this.mayVote(this.sessionsByPlayerId.get(playerId)),
      identityOf: (playerId) => this.stageIdentityOf(playerId),
      // ADR-019 § 6: a turn taken by a host, a vote or a cooldown also stops the holder's publishing at LiveKit.
      revokePublisher: (playerId) => this.publishers?.revokePublishing(playerId),
    });
    this.names = options.names ?? NameService.off();
    this.names.setListener((updates) => this.deliverNameUpdates(updates));
    this.paymentCapZat = options.paymentCapZat ?? null;
    this.fees = options.transferFees ?? null;
    this.buildId = options.buildId ?? null;
    this.moderatorKeys = options.moderatorKeys ?? { digests: [], problems: [] };
    this.trustedProxies = options.trustedProxies ?? new Set();
    this.addressHasher = options.addressHasher ?? new AddressHasher();
    this.publishers = options.publishers ?? null;
    const limits = options.connectionLimits ?? null;
    this.connectionLimits =
      limits && limits.maxSessionsPerIp > 0 ? new ConnectionLimits({ maxSessions: limits.maxSessionsPerIp, maxNewPerMinute: limits.maxNewPerMinute, now: this.now }) : null;
    const registry = this.names.registry;
    // A stored ban that ended while the server was down is cleared from names.json now (no sweep sees it).
    registry?.clearEndedBans();
    this.moderation = new Moderation({
      now: this.now,
      // ADR-019 § 4: a ban of 24 h or more on an owned name lives in its names.json record (bannedUntil only).
      persistBan: (keyHash, until) => registry?.setBannedUntil(keyHash, until),
      persisted: registry?.activeBans() ?? [],
    });

    wss.on("connection", (ws: WebSocket, request?: IncomingMessage) => this.handleConnection(ws, request));

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

  /** ADR-016: what clients may know about names on this server (GET /zcash/info) — the mode and the fee, never the address. */
  get nameInfo(): NameRegistryInfo {
    return this.names.info();
  }

  /** Whether Watch Hall host features are enabled (WATCH_HALL_HOST_KEY set and long enough) — never the key. */
  get hallHostEnabled(): boolean {
    return this.hall.hostEnabled;
  }

  /** Whether anyone can sign in as a moderator (MODERATOR_KEYS has a usable key) — never a key. */
  get moderationEnabled(): boolean {
    return this.moderatorKeys.digests.length > 0;
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.sweepTimer);
    this.names.dispose();
    this.fees?.dispose();
    if (this.hallTimer) clearTimeout(this.hallTimer);
    this.hallTimer = null;
    this.hallTimerAt = null;
  }

  private handleConnection(ws: WebSocket, request?: IncomingMessage): void {
    // ADR-019 §§ 4–5: the network's keyed hash (the raw address goes no further than this line), the per-IP cap (every
    // attempt counts) and a ban on the connection key — all before any session exists.
    const origin = requestOrigin(request, this.trustedProxies);
    if (origin.forwarded && !this.warnedInternalForward && isInternalAddress(origin.address)) {
      this.warnedInternalForward = true;
      console.warn(
        "[moderation] TRUST_PROXY: the trusted proxy forwarded a private network address as the client's — if that is its own network's gateway (IPv6 visitors relayed by Docker's userland proxy), all of them share one per-IP limit, ban and mute. Publish no AAAA record until the proxy sees real IPv6 addresses.",
      );
    }
    const addressHash = this.addressHasher.hash(origin.address);
    const admitted = this.connectionLimits ? this.connectionLimits.admit(addressHash) : true;
    const ban = this.moderation.banFor({ connection: addressHash });
    if (ban) {
      if (admitted) this.connectionLimits?.release(addressHash);
      this.refuseSocket(ws, ban.kind === "kick" ? "kicked" : "banned", ban.until);
      return;
    }
    if (!admitted) {
      this.refuseSocket(ws, "too_many_connections");
      return;
    }
    const bucket = ([burst, refill]: readonly [number, number]): TokenBucket => new TokenBucket(burst, refill, this.now);
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
      chatLimiter: new ChatRateLimiter(this.now),
      canReceive: false,
      avatar: defaultAvatar(0),
      renameLimiter: bucket(IDENTITY_LIMITS.rename),
      walletLimiter: bucket(IDENTITY_LIMITS.wallet),
      avatarLimiter: bucket(IDENTITY_LIMITS.avatar),
      nicknameCheckLimiter: bucket(IDENTITY_LIMITS.nicknameCheck),
      ownedName: null,
      nameReserveLimiter: bucket(IDENTITY_LIMITS.nameReserve),
      nameClaimLimiter: bucket(IDENTITY_LIMITS.nameClaim),
      addressHash,
      moderator: false,
      keyAttempts: 0,
      mayTalk: false,
      mutedNoticeUntil: 0,
      removed: false,
    };
    this.sessions.set(ws, session);
    this.connectionsById.set(session.playerId, session);

    ws.on("message", (data: RawData) => this.handleMessage(session, data));
    ws.on("close", () => this.handleClose(session));
    ws.on("error", () => {
      /* 'close' always follows 'error' for ws sockets — cleanup happens there. */
    });
  }

  private handleMessage(session: Session, data: RawData): void {
    if (session.removed) return; // kicked, banned or refused: nothing it sends counts any more
    if (!this.consumeRateLimitToken(session)) return;

    const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : "";
    const message = parseIncomingFrame(text);
    if (!message) return; // unknown type, malformed JSON, oversized, or failed field validation — drop silently

    session.lastSeenAt = this.now();

    switch (message.type) {
      case "join":
        this.handleJoin(session, message);
        return;
      case "player_transform":
        this.handlePlayerTransform(session, message);
        return;
      case "set_nickname":
        this.handleSetNickname(session, message.nickname);
        return;
      // ADR-015: the only request (besides heartbeat) answered before join — onboarding asks while the player types.
      case "nickname_check":
        this.handleNicknameCheck(session, message.nickname);
        return;
      case "set_wallet":
        this.handleSetWallet(session, message.connected);
        return;
      // ADR-016 owned names: answered before join too (onboarding confirms or claims a name before the player exists).
      case "name_reserve":
        this.handleNameReserve(session, message.nickname, message.keyHash);
        return;
      case "name_claim_request":
        this.handleNameClaimRequest(session, message.nickname);
        return;
      case "name_claim_proof":
        this.handleNameClaimProof(session, message);
        return;
      // ADR-018 § 5: the paying wallet's txid for the lightwalletd registry backend (before join too — onboarding).
      case "name_payment_sent":
        this.names.paymentSent(session.playerId, message.reservationId, message.txid);
        return;
      case "set_avatar":
        this.handleSetAvatar(session, message.avatar);
        return;
      case "chat_send":
        this.handleChat(session, message.channel, message.text);
        return;
      case "whisper_send":
        this.handleWhisper(session, message.to, message.text);
        return;
      case "pay_request":
      case "pay_accept":
      case "pay_decline":
      case "pay_notice":
        this.handlePayment(session, message);
        return;
      // ADR-018 § 6: the sender's transaction for a fee-bearing payment (checked, then the txid is dropped).
      case "pay_sent":
        if (session.joined) this.fees?.reportSent(message.requestId, session.playerId, message.txid);
        return;
      // The sender withdraws its request; never answered.
      case "pay_cancel":
        this.handlePayCancel(session, message.requestId);
        return;
      case "hall_stage_request":
      case "hall_stage_cancel":
      case "hall_stage_stop":
      case "hall_stage_handover":
      case "hall_stage_live":
      case "hall_stage_card":
      case "hall_stage_lock":
      case "hall_floor":
      case "hall_react":
      case "hall_hand":
      case "hall_hand_lower":
      case "hall_seat_claim":
      case "hall_seat_release":
      case "hall_host_auth":
      case "hall_stage_vote":
      case "hall_stage_dequeue":
      case "hall_stage_cooldown":
        this.handleHall(session, message);
        return;
      // ADR-019: reports from anyone joined; actions from moderators only.
      case "report":
        this.handleReport(session, message);
        return;
      case "mod_action":
        this.handleModAction(session, message);
        return;
      case "heartbeat":
        return; // lastSeenAt already updated above
      default:
        message satisfies never; // a new ClientToServerMessage without a case fails to compile
        return;
    }
  }

  // ------------------------------------------------------------------ server-verified identity

  /**
   * The session shows the owned name it confirmed (paid) or claimed (proved with its name key) — something the server
   * checked itself, unlike the client-asserted holder flag (ADR-015 § 6, ADR-016).
   */
  private hasOwnedName(session: Session): boolean {
    return session.joined && session.canReceive && session.ownedName !== null && nicknameKey(session.nickname) === nicknameKey(session.ownedName);
  }

  /**
   * Who may present on the stage, take the floor and get a full (publishing) voice grant: an owned name while a name
   * registry runs (dev / zcashd / lightwalletd — the mainnet backend is a live registry too); without one,
   * ADR-015's honour-system holder flag.
   */
  private mayPresent(session: Session | undefined): boolean {
    if (!session?.joined) return false;
    return this.names.enabled ? this.hasOwnedName(session) : session.canReceive;
  }

  /** Whose vote to end a share counts: owned names while a name registry runs, every member otherwise. */
  private mayVote(session: Session | undefined): boolean {
    if (!session?.joined) return false;
    return this.names.enabled ? this.hasOwnedName(session) : true;
  }

  /** The key a stage cooldown follows: the owned name while a registry runs (a reconnect keeps it), else this session. */
  private stageIdentityOf(playerId: string): string {
    const session = this.sessionsByPlayerId.get(playerId);
    if (session && this.names.enabled && this.hasOwnedName(session)) return `name:${nicknameKey(session.ownedName!)}`;
    return `session:${playerId}`;
  }

  /** The session's identity changed: the hall drops whatever it may no longer hold (queue place, turn, floor, vote). */
  private hallIdentityChanged(session: Session): void {
    if (session.joined) this.applyHall(this.hall.identityChanged(session.playerId));
    this.refreshTalk(session);
  }

  /**
   * ADR-019 § 6 (identity loss): a session that could publish voice and no longer may — a forgotten wallet, its owned
   * name taken over by the owner's newer session — loses its LiveKit publish permission at once, instead of keeping a
   * token minted earlier until it reconnects.
   */
  private refreshTalk(session: Session): void {
    const mayTalk = this.mayPresent(session);
    if (session.mayTalk && !mayTalk) this.publishers?.revokePublishing(session.playerId);
    session.mayTalk = mayTalk;
  }

  /** Every hall_* request goes to WatchHall; its effects say who gets what. Nothing is logged. */
  private handleHall(session: Session, message: HallClientMessage): void {
    if (!session.joined) return;
    // ADR-019 § 1: the host-key field takes a moderator key too — anywhere in the world.
    if (message.type === "hall_host_auth" && this.moderatorKeys.digests.length > 0 && this.handleModeratorSignIn(session, message.key)) return;
    this.applyHall(this.hall.handle(session.playerId, message));
  }

  /**
   * A key from the host-key field while moderator keys are configured. Returns true when it was handled here: a
   * moderator key (the session becomes a moderator), a refused attempt (HALL_HOST_ATTEMPTS_PER_SESSION, every try
   * counted), or a wrong key on a server without a host key. Otherwise the hall checks it as a host key. The key is
   * never stored, logged or echoed.
   */
  private handleModeratorSignIn(session: Session, key: string): boolean {
    const refuse = (reason: "rate_limited" | "bad_key"): true => {
      this.send(session, { type: "hall_error", op: "host", reason });
      return true;
    };
    session.keyAttempts++;
    if (session.keyAttempts > HALL_HOST_ATTEMPTS_PER_SESSION) return refuse("rate_limited");
    if (isModeratorKey(key, this.moderatorKeys)) {
      if (!session.moderator) this.becomeModerator(session);
      else this.send(session, this.moderation.snapshot(this.viewerOf(session)));
      return true;
    }
    return this.hall.hostEnabled ? false : refuse("bad_key");
  }

  /** The session is a moderator from now on (this session only): the tag for everyone, the moderation state, host powers. */
  private becomeModerator(session: Session): void {
    session.moderator = true;
    this.broadcastAll({ type: "moderator_updated", playerId: session.playerId, moderator: true });
    this.send(session, this.moderation.snapshot(this.viewerOf(session)));
    this.applyHall(this.hall.setModerator(session.playerId, true));
  }

  // ------------------------------------------------------------------ moderation (ADR-019)

  /** The keys a kick, ban, mute or report follows (§ 4): the owned name's key hash (if any) and the connection hash. */
  private moderationKeysOf(session: Session): ModerationKeys {
    const record = session.ownedName !== null ? (this.names.registry?.record(nicknameKey(session.ownedName)) ?? null) : null;
    return { connection: session.addressHash, ...(record ? { name: record.keyHash } : {}) };
  }

  /** Where a reported player is (ADR-010): the Watch Hall (a member, or west of the split), Learning Valley, or the district. */
  private locationOf(session: Session): ReportLocation {
    if (this.hall.isMember(session.playerId) || session.pose.x < -LOCATION_SPLIT_X) return "hall";
    if (session.pose.x > LOCATION_SPLIT_X) return "valley";
    return "district";
  }

  /** Joined moderator sessions (they get reports live and the moderation state after every change). */
  private moderatorSessions(): Session[] {
    return [...this.sessions.values()].filter((session) => session.joined && session.moderator && !session.removed);
  }

  /** Who a moderator is, for leaving out the reports about them: the session and its owned name's key. */
  private viewerOf(session: Session): ModerationViewer {
    const name = this.moderationKeysOf(session).name;
    return { playerId: session.playerId, ...(name !== undefined ? { name } : {}) };
  }

  /** Every moderator gets the state as they may see it (without the reports about themselves). */
  private broadcastModerationState(): void {
    for (const moderator of this.moderatorSessions()) this.send(moderator, this.moderation.snapshot(this.viewerOf(moderator)));
  }

  /**
   * A muted session's chat line, whisper or hall line is dropped (§ 3), and the sender is told until when. Moderators
   * are never muted (a muted connection hash can be shared with one).
   */
  private isMuted(session: Session): boolean {
    if (session.moderator) return false;
    const until = this.moderation.muteFor(this.moderationKeysOf(session));
    if (until === null) return false;
    this.tellMuted(session, until);
    return true;
  }

  private tellMuted(session: Session, until: number): void {
    session.mutedNoticeUntil = until;
    this.send(session, { type: "moderation_notice", kind: "muted", until });
  }

  /**
   * A mute was lifted: every session it had silenced and that was told so — the one it was taken against,
   * a reconnect of it, another tab on the same network — hears `unmuted`, unless another mute still holds it.
   */
  private tellUnmuted(lifted: LiftedMute): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (!session.joined || session.removed || session.moderator || session.mutedNoticeUntil <= now) continue;
      const keys = this.moderationKeysOf(session);
      if (session.playerId !== lifted.playerId && !Moderation.covered(lifted, keys)) continue;
      if (this.moderation.muteFor(keys) !== null) continue;
      session.mutedNoticeUntil = 0;
      this.send(session, { type: "moderation_notice", kind: "unmuted" });
    }
  }

  /**
   * After a kick or ban: every session the bans now cover is closed — the target, a reconnect of it
   * (also when the action came from a report after the target left), another tab, and everyone else on a kicked or
   * guest-banned network (who could not connect again anyway), onboarding sessions included. Moderators stay: one who
   * shares the network keeps working (but can't reconnect until the connection key ends or another moderator lifts it).
   */
  private removeBannedSessions(): void {
    for (const session of [...this.sessions.values()]) {
      if (session.removed || session.moderator) continue;
      this.refuseIfBanned(session);
    }
  }

  /** A banned (or kicked) identity is closed at once with the reason and until when. Returns true if it was. */
  private refuseIfBanned(session: Session): boolean {
    const ban = this.moderation.banFor(this.moderationKeysOf(session));
    if (!ban) return false;
    this.removeSession(session, ban.kind === "kick" ? "kicked" : "banned", ban.until);
    return true;
  }

  /** A connection refused before it became a session: the notice, then the close (MOD_CLOSE_CODES); cut off if it never answers. */
  private refuseSocket(ws: WebSocket, reason: ModCloseReason, until?: number): void {
    ws.on("error", () => undefined);
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "moderation_notice", kind: reason, ...(until !== undefined ? { until } : {}) } satisfies ServerToClientMessage));
    ws.close(MOD_CLOSE_CODES[reason], reason);
    setTimeout(() => ws.terminate(), CLOSE_GRACE_MS).unref?.();
  }

  /**
   * Kick or ban (§ 3): the session is told why and until when, its LiveKit participant is removed (§ 6), and everything
   * it held goes at once — the stage, the floor, its queue place and vote, its seat, its voice capability, its presence —
   * without waiting for the socket's close handshake. Then the socket is closed (and cut off if it never answers).
   */
  private removeSession(session: Session, reason: "kicked" | "banned", until: number): void {
    if (session.removed) return;
    this.send(session, { type: "moderation_notice", kind: reason, until });
    if (session.joined) this.publishers?.removeParticipant(session.playerId);
    const ws = session.ws;
    this.handleClose(session);
    ws.close(MOD_CLOSE_CODES[reason], reason);
    setTimeout(() => ws.terminate(), CLOSE_GRACE_MS).unref?.();
  }

  /**
   * `report` (§ 2): from any joined session about another joined one. Rate-limited per reporter and per pair; queued in
   * memory and sent live to every online moderator; never stored or logged. The reported player is told nothing.
   */
  private handleReport(session: Session, message: ReportMessage): void {
    if (!session.joined) return;
    const ack = (status: ReportAckStatus): void => this.send(session, { type: "report_ack", status });
    if (this.moderatorKeys.digests.length === 0) return ack("unavailable");
    const target = this.sessionsByPlayerId.get(message.targetId);
    if (!target?.joined || target.removed) return ack("unknown_player");
    if (target === session) return ack("self");
    let note: string | null = null;
    if (message.note !== undefined) {
      const clean = sanitizeChatText(message.note, REPORT_NOTE_MAX);
      if (clean === "too_long") return ack("invalid");
      note = clean;
    }
    const outcome = this.moderation.report({
      reporter: { nickname: session.nickname, keys: this.moderationKeysOf(session) },
      target: { nickname: target.nickname, keys: this.moderationKeysOf(target), playerId: target.playerId, moderator: target.moderator },
      reason: message.reason,
      note,
      location: this.locationOf(target),
    });
    if (!outcome.ok) return ack("rate_limited");
    ack("sent");
    // A report about a moderator goes to the other moderators only — never to the reported one.
    const payload = JSON.stringify({ type: "mod_report", report: outcome.report } satisfies ServerToClientMessage);
    for (const moderator of this.moderatorSessions()) {
      if (this.moderation.isAbout(outcome.report.id, this.viewerOf(moderator))) continue;
      if (moderator.ws.readyState === moderator.ws.OPEN) moderator.ws.send(payload);
    }
  }

  /** Who a mute/kick/ban is about: an online player, or a report's target (also after they left). */
  private resolveModerationTarget(
    actor: Session,
    message: ModActionMessage,
  ):
    | { readonly session: Session | null; readonly nickname: string; readonly keys: ModerationKeys; readonly capturedAt?: number }
    | { readonly error: ModActionError; readonly nickname?: string } {
    const live = (candidate: Session | undefined) => {
      if (!candidate?.joined || candidate.removed) return null;
      if (candidate === actor) return { error: "self" as const };
      if (candidate.moderator) return { error: "moderator" as const, nickname: candidate.nickname };
      return { session: candidate, nickname: candidate.nickname, keys: this.moderationKeysOf(candidate) };
    };
    if (message.targetId !== undefined) {
      const found = live(this.sessionsByPlayerId.get(message.targetId));
      if (found) return found;
    }
    if (message.reportId !== undefined) {
      const reported = this.moderation.reportTarget(message.reportId);
      if (!reported) return { error: "unknown_entry" };
      const online = live(reported.targetId !== null ? this.sessionsByPlayerId.get(reported.targetId) : undefined);
      if (online) return online;
      if (reported.moderator) return { error: "moderator", nickname: reported.nickname };
      // The keys the report kept, seen when it was made: their connection key ends 24 h after that.
      return { session: null, nickname: reported.nickname, keys: reported.keys, capturedAt: reported.t };
    }
    return { error: "unknown_player" };
  }

  /**
   * `mod_action` (§ 3): moderators only — everyone else gets `not_moderator` for every action. The acting moderator gets
   * `mod_action_result`, every online moderator the new state, the target its notice; the server log gets one nameless
   * line ("moderation action: kick").
   */
  private handleModAction(session: Session, message: ModActionMessage): void {
    if (!session.joined) return;
    const result = (ok: boolean, extra: { error?: ModActionError; target?: string; until?: number } = {}): void =>
      this.send(session, { type: "mod_action_result", action: message.action, ok, ...extra });
    if (!session.moderator) return result(false, { error: "not_moderator" });
    const moderator = session.nickname;
    let target: string | undefined;
    let actionUntil: number | undefined;
    switch (message.action) {
      case "unmute": {
        const lifted = this.moderation.unmute(message.entryId!, moderator);
        if (!lifted) return result(false, { error: "unknown_entry" });
        target = lifted.nickname;
        this.tellUnmuted(lifted);
        break;
      }
      case "unban": {
        const lifted = this.moderation.unban(message.entryId!, moderator);
        if (lifted === null) return result(false, { error: "unknown_entry" });
        target = lifted;
        break;
      }
      case "dismiss_report": {
        const reported = this.moderation.reportTarget(message.reportId!);
        if (!reported || !this.moderation.handleReport(message.reportId!, moderator)) return result(false, { error: "unknown_entry" });
        target = reported.nickname;
        break;
      }
      case "mute":
      case "kick":
      case "ban": {
        const resolved = this.resolveModerationTarget(session, message);
        if ("error" in resolved) return result(false, { error: resolved.error, ...(resolved.nickname !== undefined ? { target: resolved.nickname } : {}) });
        target = resolved.nickname;
        const subject = {
          nickname: resolved.nickname,
          keys: resolved.keys,
          playerId: resolved.session?.playerId ?? null,
          ...(resolved.capturedAt !== undefined ? { capturedAt: resolved.capturedAt } : {}),
        };
        if (message.action === "mute") {
          const { until } = this.moderation.mute(subject, message.durationMs!, moderator);
          actionUntil = until;
          if (resolved.session) this.tellMuted(resolved.session, until);
        } else {
          const kind = message.action === "kick" ? "kick" : "ban";
          const { until } = this.moderation.ban(subject, kind, message.action === "ban" ? (message.durationMs ?? null) : null, moderator);
          actionUntil = until;
          if (resolved.session) this.removeSession(resolved.session, kind === "kick" ? "kicked" : "banned", until);
          // Not only the one session — every live session the new entry covers goes too.
          this.removeBannedSessions();
        }
        // Acting on a report handles it.
        if (message.reportId !== undefined) this.moderation.handleReport(message.reportId, null);
        break;
      }
      default:
        message.action satisfies never;
        return;
    }
    console.log(`[moderation] moderation action: ${message.action}`);
    // `until` says how long it really lasts (a guest's ban is capped at 24 hours on its only key).
    result(true, { ...(target !== undefined ? { target } : {}), ...(actionUntil !== undefined ? { until: actionUntil } : {}) });
    this.broadcastModerationState();
  }

  /** Delivers hall effects (recipients are playerIds the hall already resolved), then re-arms the hall timer. */
  private applyHall(effects: HallEffect[]): void {
    for (const effect of effects) {
      const payload = JSON.stringify(effect.message satisfies ServerToClientMessage);
      for (const playerId of effect.to) {
        const target = this.sessionsByPlayerId.get(playerId);
        if (target?.joined && target.ws.readyState === target.ws.OPEN) target.ws.send(payload);
      }
    }
    this.armHallTimer();
  }

  /** Keeps exactly one timeout pending, at the hall's next deadline (none while nothing is due). */
  private armHallTimer(): void {
    if (this.disposed) return; // sockets closing after dispose() must not start a new timer
    const at = this.hall.nextDeadline();
    if (at === this.hallTimerAt) return;
    if (this.hallTimer) clearTimeout(this.hallTimer);
    this.hallTimer = null;
    this.hallTimerAt = at;
    if (at === null) return;
    this.hallTimer = setTimeout(() => {
      this.hallTimer = null;
      this.hallTimerAt = null;
      this.applyHall(this.hall.tick());
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, at - this.now())));
    this.hallTimer.unref?.();
  }

  /** Validates one chat line from `session`; returns the clean text, or null after telling the sender why it was dropped. */
  private acceptChatText(session: Session, raw: string): string | null {
    if (!session.joined) return null;
    const text = sanitizeChatText(raw);
    const reject = (reason: ChatRejectReason): null => {
      this.send(session, { type: "chat_rejected", reason });
      return null;
    };
    if (text === null) return reject("empty");
    if (text === "too_long") return reject("too_long");
    if (!session.chatLimiter.take()) return reject("rate_limited");
    return text;
  }

  private handleChat(session: Session, channel: ChatChannel, raw: string): void {
    if (!session.joined) return;
    // Hall lines need membership, checked before the line spends a chat token.
    if (channel === "hall" && !this.hall.isMember(session.playerId)) {
      this.send(session, { type: "chat_rejected", reason: "not_in_hall" });
      return;
    }
    // ADR-019 § 3: a muted session's lines are dropped (and it is told until when).
    if (this.isMuted(session)) return;
    const text = this.acceptChatText(session, raw);
    if (text === null) return;
    const payload = JSON.stringify({
      type: "chat_message",
      channel,
      messageId: `m${++this.chatSequence}`,
      fromPlayerId: session.playerId,
      fromNickname: session.nickname,
      text,
      t: this.now(),
    } satisfies ServerToClientMessage);
    const radiusSq = NEARBY_CHAT_RADIUS_METERS * NEARBY_CHAT_RADIUS_METERS;
    for (const other of this.sessions.values()) {
      if (!other.joined || other.ws.readyState !== other.ws.OPEN) continue;
      if (channel === "hall" && !this.hall.isMember(other.playerId)) continue;
      if (channel === "nearby" && other !== session) {
        const dx = other.pose.x - session.pose.x;
        const dy = other.pose.y - session.pose.y;
        const dz = other.pose.z - session.pose.z;
        if (dx * dx + dy * dy + dz * dz > radiusSq) continue;
      }
      other.ws.send(payload);
    }
  }

  private handlePayment(
    session: Session,
    message: Extract<ClientToServerMessage, { type: "pay_request" | "pay_accept" | "pay_decline" | "pay_notice" }>,
  ): void {
    if (!session.joined) return;
    const fail = (reason: PayErrorReason): void => this.send(session, { type: "pay_error", requestId: message.requestId, reason });
    if (message.type === "pay_request") {
      // ADR-015 § 5: payments travel only between wallet holders. Checked before the relay, so a
      // refused request spends no rate token and nothing reaches the other player.
      if (!session.canReceive) return fail("sender_no_wallet");
      // ADR-018 § 6: a session that skipped a transfer fee sends no more requests this session.
      if (this.fees?.isSanctioned(session.playerId)) return fail("fee_unpaid");
      // ADR-018 § 4: the amount stays sealed (ADR-013); the server checks the cap the sender's wallet enforces.
      if (this.paymentCapZat !== null && (message.capZat === undefined || message.capZat > this.paymentCapZat)) return fail("over_cap");
      const recipient = this.sessionsByPlayerId.get(message.to);
      if (!recipient || !recipient.joined) return fail("unknown_recipient");
      if (recipient === session) return fail("self");
      if (!recipient.canReceive) return fail("no_wallet");
      const decision = this.payments.request(message.requestId, session.playerId, recipient.playerId);
      if (!decision.ok) return fail(decision.reason);
      this.send(recipient, { type: "pay_request", to: message.to, requestId: message.requestId, senderKey: message.senderKey, from: session.playerId, fromNickname: session.nickname });
      return;
    }
    // A sender's notice clears its unreported fee entry even when the relay already forgot
    // the request (the recipient left, or it expired) — before the relay decision can fail. Only the entry's own
    // sender can do this, exactly as when the notice is relayed.
    if (message.type === "pay_notice") this.fees?.noticeRelayed(message.requestId, session.playerId);
    const decision =
      message.type === "pay_notice"
        ? this.payments.notice(message.requestId, session.playerId)
        : this.payments.answer(message.requestId, session.playerId, message.type === "pay_accept");
    if (!decision.ok) return fail(decision.reason);
    const target = this.sessionsByPlayerId.get(decision.target);
    if (!target) return fail("unknown_recipient");
    if (message.type === "pay_notice") {
      this.send(target, { ...message, from: session.playerId, fromNickname: session.nickname });
    } else if (message.type === "pay_accept") {
      // ADR-018 § 6: the server's own fee quote for the sender (not content from the recipient).
      const fee = this.fees?.quote(message.requestId, target.playerId) ?? null;
      if (this.fees && !fee) {
        // A fee-charging server never relays an acceptance without its fee. The request ends for both sides.
        this.payments.cancel(message.requestId, target.playerId);
        fail("rate_limited");
        this.send(target, { type: "pay_error", requestId: message.requestId, reason: "rate_limited" });
        return;
      }
      this.send(target, { ...message, from: session.playerId, ...(fee ? { fee } : {}) });
    } else {
      this.send(target, { ...message, from: session.playerId });
    }
  }

  /**
   * The sender withdraws its request — waiting for the acceptance, after a bad
   * acceptance, or instead of paying. Its unreported fee entry goes first (no fee is owed, even when the relay already
   * forgot the request), then the recipient, if still here, is told. Never answered.
   */
  private handlePayCancel(session: Session, requestId: string): void {
    if (!session.joined) return;
    this.fees?.cancel(requestId, session.playerId);
    const decision = this.payments.cancel(requestId, session.playerId);
    if (!decision.ok) return;
    const target = this.sessionsByPlayerId.get(decision.target);
    if (target) this.send(target, { type: "pay_cancel", requestId, from: session.playerId });
  }

  private handleWhisper(session: Session, to: string, raw: string): void {
    if (!session.joined) return;
    const recipient = this.sessionsByPlayerId.get(to);
    if (!recipient || !recipient.joined) {
      this.send(session, { type: "chat_rejected", reason: "unknown_recipient" });
      return;
    }
    if (recipient === session) {
      this.send(session, { type: "chat_rejected", reason: "self" });
      return;
    }
    if (this.isMuted(session)) return;
    const text = this.acceptChatText(session, raw);
    if (text === null) return;
    const message: ServerToClientMessage = {
      type: "chat_message",
      channel: "whisper",
      messageId: `m${++this.chatSequence}`,
      fromPlayerId: session.playerId,
      fromNickname: session.nickname,
      toPlayerId: recipient.playerId,
      toNickname: recipient.nickname,
      text,
      t: this.now(),
    };
    this.send(recipient, message);
    this.send(session, message);
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

  /**
   * ADR-015 join rules (docs/protocols/multiplayer-protocol.md § Identity):
   *  - `canReceive` is `join.wallet === true` (client-asserted);
   *  - a requested `Guest-####` that is still free is kept by anyone (reconnect continuity);
   *  - otherwise a holder gets their requested name — sanitized, not reserved, with today's `-2`
   *    suffix on a (case-insensitive) collision — and a guest gets a fresh, free guest number
   *    (never `Guest-1234-2`); an invalid or reserved request falls back to a guest number too;
   *  - a holder's valid `avatar` is kept; every guest gets `defaultAvatar(colorSeed)`.
   * ADR-016, with a name registry: a holder's name is the owned name this connection confirmed or claimed before
   * joining (taken over from the owner's other session if one still shows it); without one, a holder keeps a
   * Guest-style name like a guest — a requested name alone is never granted. A guest loses any owned name.
   */
  private handleJoin(session: Session, message: JoinMessage): void {
    if (session.joined) return; // a second join on the same connection is a no-op, not an error

    session.canReceive = message.wallet === true;
    if (!session.canReceive) session.ownedName = null;
    // ADR-019 § 4: a ban added while this connection was still onboarding (its network, or the owned name it proved).
    if (this.refuseIfBanned(session)) return;
    session.colorSeed = deriveColorSeed(session.playerId);
    session.avatar = session.canReceive && message.avatar ? { ...message.avatar } : defaultAvatar(session.colorSeed);
    const requested = message.nickname !== undefined ? sanitizeNickname(message.nickname) : null;
    if (this.names.enabled && session.canReceive && session.ownedName !== null) {
      this.takeOwnedName(session, session.ownedName);
      session.nickname = session.ownedName;
      this.names.registry?.touch(nicknameKey(session.ownedName), session.avatar);
    } else if (requested !== null && isGuestNickname(requested) && !this.isNicknameTaken(requested, session)) {
      session.nickname = requested;
    } else if (this.names.honourMode && session.canReceive && requested !== null && !isReservedNickname(requested)) {
      session.nickname = this.resolveUniqueNicknameFor(requested, session);
    } else {
      session.nickname = this.freeGuestNickname(session);
    }
    session.joined = true;
    this.sessionsByPlayerId.set(session.playerId, session);

    this.send(session, {
      type: "welcome",
      playerId: session.playerId,
      nickname: session.nickname,
      colorSeed: session.colorSeed,
      avatar: { ...session.avatar },
      canReceive: session.canReceive,
      tickRateHz: DEFAULT_TICK_RATE_HZ,
      ...(this.buildId ? { build: this.buildId } : {}),
      // Owner-only — see WelcomeMessage.voiceCapability's docstring.
      // Issued once per join; a reconnect (a brand-new playerId) always
      // gets a fresh one via this same call, never a reused value.
      voiceCapability: this.voiceCapabilities.issue(session.playerId),
    });

    this.send(session, {
      type: "player_snapshot",
      players: this.collectSummaries(session),
    });

    this.broadcastExcept(session, { type: "player_joined", ...this.summaryOf(session) });
    session.mayTalk = this.mayPresent(session);
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

    // Membership follows the pose (hall_state on entry, hall_exit + deltas on leaving,
    // walk/jog seat release). Clients may skip unchanged transforms; the last pose stays valid meanwhile.
    this.applyHall(this.hall.updatePose(session.playerId, session.pose));
  }

  /**
   * Renames an already-joined session. An invalid nickname is
   * dropped silently — the session keeps its current nickname, no error
   * is sent back (consistent with how a malformed `player_transform` is
   * handled). A valid nickname that collides with another session's
   * current nickname is resolved the same deterministic way as a join
   * conflict (§ resolveUniqueNicknameFor).
   */
  private handleSetNickname(session: Session, requestedNickname: string): void {
    if (!session.joined) return; // can't rename a connection that hasn't completed join
    // ADR-015: choosing a name is a wallet-holder feature — a guest's request is dropped silently.
    if (!session.canReceive) return;
    // ADR-016: honoured only without a name registry (honour mode). With one, a holder's name changes only through a
    // confirmed registration or a claim (and a disabled registry leaves holders with Guest-style names).
    if (!this.names.honourMode) return;

    const sanitized = sanitizeNickname(requestedNickname);
    if (!sanitized || isReservedNickname(sanitized)) return;
    if (!session.renameLimiter.take()) return; // every accepted rename is broadcast to everyone

    const resolved = this.resolveUniqueNicknameFor(sanitized, session);
    if (resolved === session.nickname) return; // no-op — nothing changed, nothing to broadcast

    session.nickname = resolved;
    this.broadcastAll({ type: "nickname_updated", playerId: session.playerId, nickname: resolved });
  }

  /**
   * ADR-015 `nickname_check` (allowed before join): is this name free right now? Answers the asker
   * only, reserves nothing, and is never logged. `taken` comes with the name the server would give
   * instead (today's `-2` rule). Rate-limited; a refused check gets no answer.
   */
  private handleNicknameCheck(session: Session, requestedNickname: string): void {
    if (!session.nicknameCheckLimiter.take()) return;
    const sanitized = sanitizeNickname(requestedNickname);
    let status: NicknameCheckStatus = "available";
    let suggestion: string | undefined;
    if (sanitized === null) status = "invalid";
    else if (isReservedNickname(sanitized)) status = "reserved";
    else if (this.isNicknameTaken(sanitized, session)) {
      status = "taken";
      suggestion = this.resolveUniqueNicknameFor(sanitized, session);
    }
    this.send(session, { type: "nickname_check_result", nickname: requestedNickname, status, ...(suggestion !== undefined ? { suggestion } : {}) });
  }

  /**
   * ADR-015 `set_wallet`: false → true makes the session a wallet holder (`can_receive_updated` to
   * everyone). true → false ("Forget this wallet") makes it a guest again: a fresh `Guest-####`
   * (`nickname_updated`), the default avatar (`avatar_updated`, if it changed), then
   * `can_receive_updated`. The same value again does nothing. Pending payment requests are left to
   * expire — `payments.forget()` would also reset this sender's payment rate limit.
   */
  private handleSetWallet(session: Session, connected: boolean): void {
    if (!session.joined || connected === session.canReceive) return;
    if (!session.walletLimiter.take()) return;
    session.canReceive = connected;
    if (!connected) {
      session.ownedName = null; // ADR-016: the owned name stays registered to the key — claim it again after reconnecting the wallet
      session.nickname = this.freeGuestNickname(session);
      this.broadcastAll({ type: "nickname_updated", playerId: session.playerId, nickname: session.nickname });
      const avatar = defaultAvatar(session.colorSeed);
      if (avatar.model !== session.avatar.model || avatar.color !== session.avatar.color) {
        session.avatar = avatar;
        this.broadcastAll({ type: "avatar_updated", playerId: session.playerId, avatar: { ...avatar } });
      }
    }
    this.broadcastAll({ type: "can_receive_updated", playerId: session.playerId, canReceive: connected });
    // A forgotten wallet (a guest again) can't keep the stage, the floor or a counted vote.
    // ADR-019 § 6: nor publish voice — its LiveKit grant is revoked.
    this.hallIdentityChanged(session);
  }

  /** ADR-015 `set_avatar`: wallet holders only (guests keep the default), rate-limited, broadcast to everyone including the sender. */
  private handleSetAvatar(session: Session, avatar: PlayerAvatar): void {
    if (!session.joined || !session.canReceive) return;
    if (avatar.model === session.avatar.model && avatar.color === session.avatar.color) return;
    if (!session.avatarLimiter.take()) return;
    session.avatar = { ...avatar };
    this.broadcastAll({ type: "avatar_updated", playerId: session.playerId, avatar: { ...avatar } });
    // ADR-016: an owner's record remembers its last look.
    if (session.ownedName !== null && session.nickname === session.ownedName) this.names.registry?.touch(nicknameKey(session.ownedName), session.avatar);
  }

  /**
   * True if `nickname` is not free for `exclude`: some *other* joined session shows it (NFKC, case-insensitive —
   * ADR-015 § 9) or, with a name registry (ADR-016), it is registered (to anyone) or reserved by another session.
   */
  private isNicknameTaken(nickname: string, exclude: Session): boolean {
    const key = nicknameKey(nickname);
    if (this.isNameOnlineElsewhere(key, exclude)) return true;
    const registry = this.names.registry;
    return registry !== null && (registry.isRegistered(key) || registry.isReservedForOther(key, exclude.playerId));
  }

  /** Whether another joined session currently shows the name with this key. */
  private isNameOnlineElsewhere(key: string, exclude: Session): boolean {
    for (const session of this.sessions.values()) {
      if (session === exclude || !session.joined) continue;
      if (nicknameKey(session.nickname) === key) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ owned names (ADR-016)

  /**
   * `name_reserve`: holders only once joined (a connection still in onboarding may ask — the payment is the proof of
   * a funded wallet, and a guest join drops the result). The quote and the reservation's status go to the asker
   * only. Nothing is logged.
   */
  private handleNameReserve(session: Session, nickname: string, keyHash: string): void {
    const refuse = (status: NameStatus): void => this.send(session, { type: "name_status", status, nickname });
    const registry = this.names.registry;
    if (!registry || (session.joined && !session.canReceive)) return refuse("disabled");
    if (!session.nameReserveLimiter.take()) return refuse("rate_limited");
    const outcome = registry.reserve(session.playerId, nickname, keyHash, (key) => this.isNameOnlineElsewhere(key, session));
    if (!outcome.ok) {
      refuse(outcome.status);
    } else {
      this.send(session, outcome.quote);
      this.send(session, { type: "name_status", status: outcome.seen ? "seen" : "pending", reservationId: outcome.quote.reservationId, nickname: outcome.quote.nickname });
    }
    this.names.flush(); // expiries the reservation step queued, and the poll loop
  }

  /** `name_claim_request`: a fresh single-use challenge for this session (holders once joined; before join, anyone). */
  private handleNameClaimRequest(session: Session, nickname: string): void {
    const refuse = (status: NameStatus): void => this.send(session, { type: "name_status", status, nickname });
    const registry = this.names.registry;
    if (!registry || (session.joined && !session.canReceive)) return refuse("disabled");
    if (!session.nameClaimLimiter.take()) return refuse("rate_limited");
    const nonce = registry.issueChallenge(session.playerId, nickname);
    if (nonce === null) return refuse("invalid");
    this.send(session, { type: "name_challenge", nonce, nickname });
  }

  /** `name_claim_proof`: verified against the session's challenge (consumed either way); success applies the owned name. */
  private handleNameClaimProof(session: Session, proof: NameClaimProofMessage): void {
    const registry = this.names.registry;
    if (!registry || (session.joined && !session.canReceive)) {
      this.send(session, { type: "name_status", status: "disabled", nickname: proof.nickname });
      return;
    }
    void registry.verifyClaim(session.playerId, proof).then((record) => {
      if (this.disposed || this.sessions.get(session.ws) !== session) return; // the connection went away meanwhile
      if (!record || (session.joined && !session.canReceive)) {
        this.send(session, { type: "name_status", status: "failed", nickname: proof.nickname });
        return;
      }
      this.applyOwnedName(session, record.displayName);
      this.send(session, { type: "name_status", status: "confirmed", nickname: record.displayName });
    });
  }

  /** Scanner results: progress to the reserving session, and a confirmed name applied (with the nickname_updated broadcast). */
  private deliverNameUpdates(updates: NameUpdate[]): void {
    for (const update of updates) {
      const session = this.connectionsById.get(update.sessionId);
      if (!session) continue; // gone: the name stays registered to the key and can be claimed on the next visit
      if (update.kind === "status") {
        this.send(session, { type: "name_status", status: update.status, reservationId: update.reservationId, nickname: update.nickname });
        continue;
      }
      this.applyOwnedName(session, update.record.displayName);
      this.send(session, { type: "name_status", status: "confirmed", reservationId: update.reservationId, nickname: update.record.displayName });
    }
  }

  /**
   * The session now owns `displayName`. Before join it is applied by the join (holders); a joined holder shows it at
   * once (`nickname_updated` to everyone). A joined guest keeps its Guest name — the name stays registered to the key.
   */
  private applyOwnedName(session: Session, displayName: string): void {
    if (session.joined && !session.canReceive) return;
    session.ownedName = displayName;
    // ADR-019 § 4: a banned name (its key) is refused the moment it is proved — before join or after.
    if (this.refuseIfBanned(session)) return;
    if (!session.joined) return;
    this.takeOwnedName(session, displayName);
    this.names.registry?.touch(nicknameKey(displayName), session.avatar);
    if (session.nickname === displayName) return;
    session.nickname = displayName;
    this.broadcastAll({ type: "nickname_updated", playerId: session.playerId, nickname: displayName });
    this.refreshTalk(session);
  }

  /**
   * Only the owner can hold an owned name, so another session showing it is the owner's older session (another tab, a
   * connection the sweep has not dropped yet): it gets a fresh Guest name — the newest proof wins.
   */
  private takeOwnedName(session: Session, displayName: string): void {
    const key = nicknameKey(displayName);
    for (const other of this.sessions.values()) {
      if (other === session || !other.joined || nicknameKey(other.nickname) !== key) continue;
      other.ownedName = null;
      other.nickname = this.freeGuestNickname(other);
      this.broadcastAll({ type: "nickname_updated", playerId: other.playerId, nickname: other.nickname });
      this.hallIdentityChanged(other); // the older session loses what the name allowed
    }
  }

  /**
   * The faucet's proof of a live connection BEFORE join (ADR-016): a pending reservation id (owner-only, random) is
   * resolved to its connection's playerId — so a new player can get test coins for the fee during onboarding.
   */
  resolveNameReservationSession(reservationId: string): string | null {
    const sessionId = this.names.registry?.reservationSession(reservationId) ?? null;
    return sessionId !== null && this.connectionsById.has(sessionId) ? sessionId : null;
  }

  private resolveUniqueNicknameFor(candidate: string, exclude: Session): string {
    return resolveUniqueNickname(candidate, (name) => this.isNicknameTaken(name, exclude));
  }

  /**
   * A free `Guest-####` (ADR-015: a taken guest number is replaced by another number, never
   * suffixed). Random first; if the space is crowded, the first free number in order. With all
   * 9000 in use (not a realistic world size) the numeric `-N` suffix is the last resort.
   */
  private freeGuestNickname(exclude: Session): string {
    for (let attempt = 0; attempt < GUEST_NAME_ATTEMPTS; attempt++) {
      const candidate = generateGuestNickname();
      if (!this.isNicknameTaken(candidate, exclude)) return candidate;
    }
    for (let digits = 1000; digits <= 9999; digits++) {
      const candidate = `Guest-${digits}`;
      if (!this.isNicknameTaken(candidate, exclude)) return candidate;
    }
    return this.resolveUniqueNicknameFor(generateGuestNickname(), exclude);
  }

  private handleClose(session: Session): void {
    if (session.removed) return; // a kick/ban/refusal already cleaned up; this is its socket's own close event
    session.removed = true;
    const wasJoined = session.joined;
    this.connectionLimits?.release(session.addressHash);
    this.sessions.delete(session.ws);
    this.sessionsByPlayerId.delete(session.playerId);
    this.connectionsById.delete(session.playerId);
    // ADR-016: the claim challenge goes; a reservation stays until it expires (its payment may still arrive).
    this.names.registry?.forgetSession(session.playerId);
    // A disconnect (clean close OR the stale
    // sweep's ws.terminate(), which triggers this same 'close' handler —
    // see sweepStaleConnections) immediately invalidates this session's
    // voice capability. There is no separate "disconnected but capability
    // still works" window.
    this.voiceCapabilities.revoke(session.playerId);
    // The open requests of a leaving player end for the other side too. A sender whose
    // recipient left can no longer pay or cancel through the relay, so its unreported fee entry goes (no fee is owed),
    // and each counterpart still here is told (`pay_cancel` from the leaver).
    for (const pending of this.payments.forget(session.playerId)) {
      if (pending.to === session.playerId) this.fees?.cancel(pending.requestId, pending.from);
      const other = this.sessionsByPlayerId.get(pending.from === session.playerId ? pending.to : pending.from);
      if (other?.joined) this.send(other, { type: "pay_cancel", requestId: pending.requestId, from: session.playerId });
    }
    this.fees?.forgetSession(session.playerId);
    // Frees the stage (the queue advances), the seat, the hand and the floor, and
    // tells the remaining members — before player_left, so no hall state names a departed player.
    this.applyHall(this.hall.forget(session.playerId));
    if (wasJoined) {
      this.broadcastExcept(session, { type: "player_left", playerId: session.playerId });
    }
    // ADR-019 § 2: a reported player left — moderators can still act on the report (by the keys it kept).
    if (this.moderation.targetLeft(session.playerId)) this.broadcastModerationState();
  }

  /**
   * The ONLY way `/voice/token` (see
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
  resolveVoiceSession(capability: string): VoiceSessionIdentity | null {
    const playerId = this.voiceCapabilities.resolve(capability);
    if (!playerId) return null;
    const session = this.sessionsByPlayerId.get(playerId);
    if (!session) return null; // defensive — shouldn't happen, since revoke() always runs alongside session removal
    // ADR-015: canReceive (read fresh, like the nickname) says whether the session is a wallet holder at all.
    // canTalk (also fresh) decides whether a full voice grant may be minted — an owned name while a
    // name registry runs, so a modified client claiming the holder flag gets only the listen-only grant.
    return { playerId: session.playerId, nickname: session.nickname, canReceive: session.canReceive, canTalk: this.mayPresent(session) };
  }

  private sweepStaleConnections(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (now - session.lastSeenAt > this.staleTimeoutMs) {
        session.ws.terminate(); // triggers 'close', which performs removal + player_left broadcast
      }
    }
    // ADR-019: what ran out goes (bans, mutes, 24-hour-old reports, rate-limit times, idle networks).
    if (this.moderation.sweep()) this.broadcastModerationState();
    this.connectionLimits?.sweep();
  }

  private collectSummaries(exclude: Session): PlayerSummary[] {
    const summaries: PlayerSummary[] = [];
    for (const session of this.sessions.values()) {
      if (session === exclude || !session.joined) continue;
      summaries.push(this.summaryOf(session));
    }
    return summaries;
  }

  /** What every peer may know about a session (ADR-015: plus its avatar and the one wallet-derived bit, canReceive). */
  private summaryOf(session: Session): PlayerSummary {
    return {
      playerId: session.playerId,
      nickname: session.nickname,
      colorSeed: session.colorSeed,
      avatar: { ...session.avatar },
      canReceive: session.canReceive,
      ...(session.moderator ? { moderator: true } : {}),
      ...session.pose,
    };
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
