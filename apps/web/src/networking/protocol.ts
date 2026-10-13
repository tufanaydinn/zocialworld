/**
 * Client-side half of the multiplayer wire protocol.
 *
 * The message *shapes* live in `@project/shared` (see
 * docs/decisions/ADR-006-shared-multiplayer-protocol-contracts.md) so
 * the client and server can never independently drift on what a
 * message looks like. Import the shapes directly from `@project/shared`
 * wherever you need them (see `NetworkClient.ts`, `RemotePlayer.ts`,
 * `RemotePlayerManager.ts`) — this file only adds the one thing that's
 * genuinely client-specific: runtime validation of data arriving over
 * the wire. The client does not model a hostile server, but
 * malformed/unexpected data (a bug, a protocol mismatch between client
 * and server versions) must never throw deep in rendering code — so
 * this still validates shape before anything downstream touches it.
 */

import {
  ANIMATION_STATES,
  CHAT_CHANNELS,
  CHAT_REJECT_REASONS,
  HALL_ERROR_OPS,
  HALL_ERROR_REASONS,
  HALL_HANDS_MAX,
  HALL_HOSTS_MAX,
  HALL_REACTION_SAMPLE_MAX,
  HALL_REACTION_TOTAL_MAX,
  HALL_REACTIONS,
  HALL_STAGE_COOLDOWN_MAX_MS,
  HALL_STAGE_QUEUE_MAX,
  HALL_STAGE_STATUSES,
  MAX_CHAT_LENGTH,
  MAX_NICKNAME_LENGTH,
  MOD_ACTION_ERRORS,
  MOD_ACTIONS,
  MOD_BAN_FOREVER,
  MOD_ID_PATTERN,
  MOD_LOG_MAX,
  MOD_NICKNAME_LABEL_MAX,
  MODERATION_NOTICE_KINDS,
  REPORT_ACK_STATUSES,
  REPORT_LOCATIONS,
  REPORT_NOTE_MAX,
  REPORT_QUEUE_MAX,
  REPORT_REASONS,
  NAME_ADDRESS_MAX,
  NAME_NONCE_PATTERN,
  NAME_RESERVATION_ID_PATTERN,
  NAME_STATUSES,
  NICKNAME_CHECK_STATUSES,
  PAY_DECLINE_REASONS,
  PAY_ERROR_REASONS,
  PAY_FEE_MAX_ZAT,
  PAY_FEE_NONCE_PATTERN,
  PAY_KEY_MAX,
  PAY_SEALED_MAX,
  PLAYER_AVATAR_COLOR_COUNT,
  PLAYER_AVATAR_MODELS,
  WATCH_HALL_SEAT_COUNT,
  defaultPlayerAvatar,
  type NameStatus,
  type NicknameCheckStatus,
  type PayDeclineReason,
  type PayErrorReason,
  type PlayerAvatar,
  type PlayerAvatarModel,
  type AnimationState,
  type ChatChannel,
  type ChatRejectReason,
  type HallErrorOp,
  type HallErrorReason,
  type HallReaction,
  type HallReactionsBroadcast,
  type HallReactionSession,
  type HallStageState,
  type HallStageStatus,
  type HallVoteState,
  type ModAction,
  type ModActionError,
  type ModBanEntry,
  type ModerationNoticeKind,
  type ModLogEntry,
  type ModLogMessage,
  type ModMuteEntry,
  type ModReport,
  type ReportAckStatus,
  type ReportLocation,
  type ReportReason,
  type ServerToClientMessage,
  type PlayerSummary,
} from "@project/shared";
import { validateHallCard } from "../hall/hallCard.ts";

/**
 * Caps on hall arrays: a protocol mismatch must never hand huge arrays to the
 * renderer. The hand and host caps are shared with the server (which refuses a raise or a host
 * sign-in beyond them); the parser truncates rather than drops, so a mismatch can never keep a
 * player out of the hall.
 */
export { HALL_HANDS_MAX, HALL_HOSTS_MAX };
const ID_MAX = 64;
/** A vote count or bar above this is a protocol mismatch (a hall holds far fewer members). */
const HALL_VOTE_COUNT_MAX = 10_000;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isAnimationState(value: unknown): value is AnimationState {
  return typeof value === "string" && (ANIMATION_STATES as readonly string[]).includes(value);
}

/**
 * ADR-015 avatar: a known model id and an integer palette index, or null. Callers fall back to
 * `defaultPlayerAvatar(colorSeed)` — a missing or malformed avatar never drops a frame (a
 * `player_snapshot` with one bad entry would otherwise lose the whole roster).
 */
export function parseAvatar(value: unknown): PlayerAvatar | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.model !== "string" || !(PLAYER_AVATAR_MODELS as readonly string[]).includes(v.model)) return null;
  if (typeof v.color !== "number" || !Number.isInteger(v.color) || v.color < 0 || v.color >= PLAYER_AVATAR_COLOR_COUNT) return null;
  return { model: v.model as PlayerAvatarModel, color: v.color };
}

/**
 * A player entry rebuilt from known fields only. ADR-015 fields get defaults rather than failing
 * the entry: a missing/invalid `avatar` is the colorSeed default, a missing `canReceive` is false
 * (no Send ZEC — the safe side).
 */
function parsePlayerSummary(value: unknown): PlayerSummary | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.playerId !== "string" || typeof v.nickname !== "string" || !isFiniteNumber(v.colorSeed)) return null;
  if (!isFiniteNumber(v.x) || !isFiniteNumber(v.y) || !isFiniteNumber(v.z) || !isFiniteNumber(v.rotationY) || !isAnimationState(v.animationState)) return null;
  return {
    playerId: v.playerId,
    nickname: v.nickname,
    colorSeed: v.colorSeed,
    avatar: parseAvatar(v.avatar) ?? defaultPlayerAvatar(v.colorSeed),
    canReceive: v.canReceive === true,
    // The Moderator tag — only an explicit true counts.
    ...(v.moderator === true ? { moderator: true } : {}),
    x: v.x,
    y: v.y,
    z: v.z,
    rotationY: v.rotationY,
    animationState: v.animationState,
  };
}

/**
 * Validates and narrows a raw parsed JSON value from the server into a
 * known `ServerToClientMessage`, or `null` if it doesn't match.
 */
function str(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function parseIncomingMessage(raw: unknown): ServerToClientMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const msg = raw as Record<string, unknown>;

  switch (msg.type) {
    case "welcome":
      if (typeof msg.playerId !== "string" || typeof msg.nickname !== "string") return null;
      if (!isFiniteNumber(msg.colorSeed) || !isFiniteNumber(msg.tickRateHz)) return null;
      // voiceCapability is owner-only data
      // this client needs to actually use voice (see
      // VoiceSession.enableVoice()) — required, not optional, same as
      // every other welcome field.
      if (typeof msg.voiceCapability !== "string") return null;
      return {
        type: "welcome",
        playerId: msg.playerId,
        nickname: msg.nickname,
        colorSeed: msg.colorSeed,
        // ADR-015: defaults, never a dropped welcome (the server's accepted values when present).
        avatar: parseAvatar(msg.avatar) ?? defaultPlayerAvatar(msg.colorSeed),
        canReceive: msg.canReceive === true,
        tickRateHz: msg.tickRateHz,
        voiceCapability: msg.voiceCapability,
        // ADR-018: the served client's build id; anything malformed is ignored (no update prompt).
        ...(typeof msg.build === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(msg.build) ? { build: msg.build } : {}),
      };

    case "player_snapshot": {
      if (!Array.isArray(msg.players)) return null;
      const players: PlayerSummary[] = [];
      for (const entry of msg.players as unknown[]) {
        const player = parsePlayerSummary(entry);
        if (!player) return null;
        players.push(player);
      }
      return { type: "player_snapshot", players };
    }

    case "player_joined": {
      const player = parsePlayerSummary(msg);
      return player ? { type: "player_joined", ...player } : null;
    }

    // ADR-015 identity updates and the pre-join nickname check.
    case "avatar_updated": {
      const avatar = parseAvatar(msg.avatar);
      if (!isId(msg.playerId) || !avatar) return null;
      return { type: "avatar_updated", playerId: msg.playerId, avatar };
    }
    case "can_receive_updated":
      if (!isId(msg.playerId) || typeof msg.canReceive !== "boolean") return null;
      return { type: "can_receive_updated", playerId: msg.playerId, canReceive: msg.canReceive };
    case "nickname_check_result": {
      if (typeof msg.nickname !== "string" || msg.nickname.length > MAX_NICKNAME_LENGTH * 4) return null;
      if (typeof msg.status !== "string" || !(NICKNAME_CHECK_STATUSES as readonly string[]).includes(msg.status)) return null;
      if (msg.suggestion !== undefined && !str(msg.suggestion, MAX_NICKNAME_LENGTH * 2)) return null;
      return {
        type: "nickname_check_result",
        nickname: msg.nickname,
        status: msg.status as NicknameCheckStatus,
        ...(typeof msg.suggestion === "string" ? { suggestion: msg.suggestion } : {}),
      };
    }

    // ADR-016 owned names — owner-only answers. Ids and nonces must match their shapes; the quote's amount must be a
    // positive integer of zatoshi (the fee flow also checks it against the advertised fee and NAME_FEE_MAX_ZAT, and
    // the memo against its own key, before the wallet pays anything).
    case "name_quote": {
      if (!isReservationId(msg.reservationId) || !isNameText(msg.nickname) || !str(msg.address, NAME_ADDRESS_MAX) || !str(msg.memo, 512)) return null;
      if (typeof msg.amountZat !== "number" || !Number.isSafeInteger(msg.amountZat) || msg.amountZat <= 0 || !isFiniteNumber(msg.expiresAt)) return null;
      return { type: "name_quote", reservationId: msg.reservationId, nickname: msg.nickname, address: msg.address, amountZat: msg.amountZat, memo: msg.memo, expiresAt: msg.expiresAt };
    }
    case "name_status": {
      if (typeof msg.status !== "string" || !(NAME_STATUSES as readonly string[]).includes(msg.status)) return null;
      if (msg.reservationId !== undefined && !isReservationId(msg.reservationId)) return null;
      if (msg.nickname !== undefined && !isNameText(msg.nickname)) return null;
      return {
        type: "name_status",
        status: msg.status as NameStatus,
        ...(typeof msg.reservationId === "string" ? { reservationId: msg.reservationId } : {}),
        ...(typeof msg.nickname === "string" ? { nickname: msg.nickname } : {}),
      };
    }
    case "name_challenge":
      if (typeof msg.nonce !== "string" || !NAME_NONCE_PATTERN.test(msg.nonce) || !isNameText(msg.nickname)) return null;
      return { type: "name_challenge", nonce: msg.nonce, nickname: msg.nickname };

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

    case "chat_message": {
      const channel = msg.channel;
      if (channel !== "whisper" && !(typeof channel === "string" && (CHAT_CHANNELS as readonly string[]).includes(channel))) return null;
      if (typeof msg.messageId !== "string" || typeof msg.fromPlayerId !== "string" || typeof msg.fromNickname !== "string") return null;
      if (typeof msg.text !== "string" || msg.text.length > MAX_CHAT_LENGTH * 2 || !isFiniteNumber(msg.t)) return null;
      if (channel === "whisper" && (typeof msg.toPlayerId !== "string" || typeof msg.toNickname !== "string")) return null;
      return {
        type: "chat_message",
        channel: channel as ChatChannel | "whisper",
        messageId: msg.messageId,
        fromPlayerId: msg.fromPlayerId,
        fromNickname: msg.fromNickname,
        ...(channel === "whisper" ? { toPlayerId: msg.toPlayerId as string, toNickname: msg.toNickname as string } : {}),
        text: msg.text,
        t: msg.t,
      };
    }

    case "chat_rejected":
      if (typeof msg.reason !== "string" || !(CHAT_REJECT_REASONS as readonly string[]).includes(msg.reason)) return null;
      return { type: "chat_rejected", reason: msg.reason as ChatRejectReason };

    // ADR-013 payment relay — opaque base64 fields; the payment flow validates content after unsealing.
    case "pay_request":
      if (!str(msg.from, 64) || !str(msg.fromNickname, 64) || !str(msg.requestId, 40) || !str(msg.senderKey, PAY_KEY_MAX) || !str(msg.to, 64)) return null;
      return { type: "pay_request", from: msg.from, fromNickname: msg.fromNickname, to: msg.to, requestId: msg.requestId, senderKey: msg.senderKey };
    case "pay_accept": {
      if (!str(msg.from, 64) || !str(msg.requestId, 40) || !str(msg.recipientKey, PAY_KEY_MAX) || !str(msg.sealed, PAY_SEALED_MAX) || !str(msg.iv, 32)) return null;
      // ADR-018: the server's transfer-fee quote. A malformed one drops the whole acceptance (the
      // sender must never pay without the fee the server asked for, nor pay a fee it cannot check).
      let fee: { address: string; zat: number; nonce: string } | undefined;
      if (msg.fee !== undefined) {
        const quote = msg.fee as Record<string, unknown> | null;
        if (typeof quote !== "object" || quote === null || !str(quote.address, NAME_ADDRESS_MAX) || typeof quote.nonce !== "string" || !PAY_FEE_NONCE_PATTERN.test(quote.nonce)) return null;
        if (typeof quote.zat !== "number" || !Number.isSafeInteger(quote.zat) || quote.zat <= 0 || quote.zat > PAY_FEE_MAX_ZAT) return null;
        fee = { address: quote.address, zat: quote.zat, nonce: quote.nonce };
      }
      return { type: "pay_accept", from: msg.from, requestId: msg.requestId, recipientKey: msg.recipientKey, sealed: msg.sealed, iv: msg.iv, ...(fee ? { fee } : {}) };
    }
    case "pay_decline":
      if (!str(msg.from, 64) || !str(msg.requestId, 40) || typeof msg.reason !== "string" || !(PAY_DECLINE_REASONS as readonly string[]).includes(msg.reason)) return null;
      return { type: "pay_decline", from: msg.from, requestId: msg.requestId, reason: msg.reason as PayDeclineReason };
    case "pay_notice":
      if (!str(msg.from, 64) || !str(msg.fromNickname, 64) || !str(msg.requestId, 40) || !str(msg.sealed, PAY_SEALED_MAX) || !str(msg.iv, 32)) return null;
      return { type: "pay_notice", from: msg.from, fromNickname: msg.fromNickname, requestId: msg.requestId, sealed: msg.sealed, iv: msg.iv };
    // The request is over — the sender cancelled, or the other side left.
    case "pay_cancel":
      if (!str(msg.from, 64) || !str(msg.requestId, 40)) return null;
      return { type: "pay_cancel", from: msg.from, requestId: msg.requestId };
    case "pay_error":
      // ADR-015: the shared list (incl. no_wallet / sender_no_wallet) — a reason missing here would leave the sender's card on "Waiting…".
      if (!str(msg.requestId, 40) || typeof msg.reason !== "string" || !(PAY_ERROR_REASONS as readonly string[]).includes(msg.reason)) return null;
      return { type: "pay_error", requestId: msg.requestId, reason: msg.reason as PayErrorReason };

    case "nickname_updated":
      if (typeof msg.playerId !== "string" || typeof msg.nickname !== "string") return null;
      return { type: "nickname_updated", playerId: msg.playerId, nickname: msg.nickname };

    // Watch Hall (ADR-014): validated and rebuilt; every array is capped and the
    // speaker card is re-validated like the server does (an invalid card becomes null).
    case "hall_state": {
      const stage = parseHallStage(msg.stage);
      const seats = parseHallSeats(msg.seats);
      const hands = truncatedIdList(msg.hands, HALL_HANDS_MAX);
      const hosts = truncatedIdList(msg.hosts, HALL_HOSTS_MAX);
      const totals = parseReactionCounts(msg.totals);
      const session = parseReactionSession(msg.session);
      if (!stage || !seats || !hands || !hosts || !totals || !session || !isIdOrNull(msg.floor) || typeof msg.host !== "boolean") return null;
      // A missing or malformed vote is "no vote open" — it must never keep a player out of the hall.
      const vote = parseHallVote(msg.vote) ?? { votes: 0, needed: 0, voted: false };
      return { type: "hall_state", stage, seats, hands, floor: msg.floor, hosts, host: msg.host, totals, session, vote };
    }
    case "hall_vote": {
      const vote = parseHallVote(msg);
      return vote ? { type: "hall_vote", ...vote } : null;
    }
    case "hall_exit":
      return { type: "hall_exit" };
    case "hall_stage": {
      const stage = parseHallStage(msg.stage);
      return stage ? { type: "hall_stage", stage } : null;
    }
    case "hall_seat":
      if (!isSeatId(msg.seatId) || !isIdOrNull(msg.playerId)) return null;
      return { type: "hall_seat", seatId: msg.seatId, playerId: msg.playerId };
    case "hall_hands": {
      const hands = truncatedIdList(msg.hands, HALL_HANDS_MAX);
      return hands ? { type: "hall_hands", hands } : null;
    }
    case "hall_floor":
      if (!isIdOrNull(msg.playerId)) return null;
      return { type: "hall_floor", playerId: msg.playerId };
    case "hall_hosts": {
      const hosts = truncatedIdList(msg.hosts, HALL_HOSTS_MAX);
      return hosts ? { type: "hall_hosts", hosts } : null;
    }
    case "hall_reactions":
      return parseHallReactions(msg);
    // ADR-019: validated and rebuilt from known fields; lists are capped (a mismatch can't flood the UI).
    case "report_ack":
      if (!isOneOf(msg.status, REPORT_ACK_STATUSES)) return null;
      return { type: "report_ack", status: msg.status as ReportAckStatus };
    case "mod_report": {
      const report = parseModReport(msg.report);
      return report ? { type: "mod_report", report } : null;
    }
    case "mod_action_result":
      if (!isOneOf(msg.action, MOD_ACTIONS) || typeof msg.ok !== "boolean") return null;
      if (msg.error !== undefined && !isOneOf(msg.error, MOD_ACTION_ERRORS)) return null;
      if (msg.target !== undefined && !isName(msg.target)) return null;
      return {
        type: "mod_action_result",
        action: msg.action as ModAction,
        ok: msg.ok,
        ...(msg.error !== undefined ? { error: msg.error as ModActionError } : {}),
        ...(typeof msg.target === "string" ? { target: msg.target } : {}),
        // When the action really ends (kept only when it is a sane server time).
        ...(isTime(msg.until) ? { until: msg.until } : {}),
      };
    case "mod_log":
      return parseModLog(msg);
    case "moderation_notice":
      if (!isOneOf(msg.kind, MODERATION_NOTICE_KINDS)) return null;
      return { type: "moderation_notice", kind: msg.kind as ModerationNoticeKind, ...(isTime(msg.until) ? { until: msg.until } : {}) };
    case "moderator_updated":
      if (!isId(msg.playerId) || typeof msg.moderator !== "boolean") return null;
      return { type: "moderator_updated", playerId: msg.playerId, moderator: msg.moderator };

    case "hall_error":
      if (typeof msg.op !== "string" || !(HALL_ERROR_OPS as readonly string[]).includes(msg.op)) return null;
      if (typeof msg.reason !== "string" || !(HALL_ERROR_REASONS as readonly string[]).includes(msg.reason)) return null;
      // `retryInMs` (a cooldown's remaining time) is kept only when it is a sane number of milliseconds.
      return {
        type: "hall_error",
        op: msg.op as HallErrorOp,
        reason: msg.reason as HallErrorReason,
        ...(isFiniteNumber(msg.retryInMs) && msg.retryInMs >= 0 && msg.retryInMs <= HALL_STAGE_COOLDOWN_MAX_MS ? { retryInMs: msg.retryInMs } : {}),
      };

    default:
      return null;
  }
}

function isId(value: unknown): value is string {
  return str(value, ID_MAX);
}

function isOneOf(value: unknown, list: readonly string[]): value is string {
  return typeof value === "string" && list.includes(value);
}

/** A server time in ms (MOD_BAN_FOREVER at most). */
function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MOD_BAN_FOREVER;
}

function isModId(value: unknown): value is string {
  return typeof value === "string" && MOD_ID_PATTERN.test(value);
}

/** A nickname shown in the moderation UI (textContent only; bounded by MOD_NICKNAME_LABEL_MAX). */
function isName(value: unknown): value is string {
  return str(value, MOD_NICKNAME_LABEL_MAX);
}

/** One report as moderators see it, rebuilt from known fields. */
function parseModReport(value: unknown): ModReport | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!isModId(v.id) || !isTime(v.t) || !isName(v.reporter) || !isName(v.target) || !(v.targetId === null || isId(v.targetId))) return null;
  if (!isOneOf(v.reason, REPORT_REASONS) || !isOneOf(v.location, REPORT_LOCATIONS)) return null;
  if (v.note !== undefined && !str(v.note, REPORT_NOTE_MAX * 2)) return null;
  return {
    id: v.id,
    t: v.t,
    reporter: v.reporter,
    target: v.target,
    targetId: v.targetId,
    reason: v.reason as ReportReason,
    ...(typeof v.note === "string" ? { note: v.note } : {}),
    location: v.location as ReportLocation,
  };
}

/**
 * The moderation state: every list capped. A malformed entry is skipped, not the whole frame (one bad
 * entry must not cost a moderator the role — the store only becomes a moderator from a mod_log); a malformed frame
 * (a list missing) is dropped.
 */
function parseModLog(msg: Record<string, unknown>): ModLogMessage | null {
  if (!Array.isArray(msg.reports) || !Array.isArray(msg.log) || !Array.isArray(msg.bans) || !Array.isArray(msg.mutes)) return null;
  const reports: ModReport[] = [];
  for (const entry of (msg.reports as unknown[]).slice(0, REPORT_QUEUE_MAX)) {
    const report = parseModReport(entry);
    if (report) reports.push(report);
  }
  const log: ModLogEntry[] = [];
  for (const entry of (msg.log as unknown[]).slice(0, MOD_LOG_MAX)) {
    if (typeof entry !== "object" || entry === null) continue;
    const v = entry as Record<string, unknown>;
    if (!isModId(v.id) || !isTime(v.t) || !isName(v.moderator) || !isOneOf(v.action, MOD_ACTIONS)) continue;
    if (v.target !== undefined && !isName(v.target)) continue;
    if (v.durationMs !== undefined && v.durationMs !== null && !isTime(v.durationMs)) continue;
    log.push({
      id: v.id,
      t: v.t,
      moderator: v.moderator,
      action: v.action as ModAction,
      ...(typeof v.target === "string" ? { target: v.target } : {}),
      ...(v.durationMs !== undefined ? { durationMs: v.durationMs as number | null } : {}),
    });
  }
  const bans: ModBanEntry[] = [];
  for (const entry of (msg.bans as unknown[]).slice(0, 1000)) {
    if (typeof entry !== "object" || entry === null) continue;
    const v = entry as Record<string, unknown>;
    if (!isModId(v.id) || !isName(v.nickname) || (v.kind !== "kick" && v.kind !== "ban") || !isTime(v.until) || typeof v.byName !== "boolean" || typeof v.byConnection !== "boolean") continue;
    bans.push({ id: v.id, nickname: v.nickname, kind: v.kind, until: v.until, byName: v.byName, byConnection: v.byConnection });
  }
  const mutes: ModMuteEntry[] = [];
  for (const entry of (msg.mutes as unknown[]).slice(0, 1000)) {
    if (typeof entry !== "object" || entry === null) continue;
    const v = entry as Record<string, unknown>;
    if (!isModId(v.id) || !isName(v.nickname) || !isTime(v.until)) continue;
    mutes.push({ id: v.id, nickname: v.nickname, until: v.until });
  }
  return { type: "mod_log", reports, log, bans, mutes };
}

function isReservationId(value: unknown): value is string {
  return typeof value === "string" && NAME_RESERVATION_ID_PATTERN.test(value);
}

/** A nickname echoed in a name_* answer (the server echoes what was asked, at most 4x the name limit). */
function isNameText(value: unknown): value is string {
  return str(value, MAX_NICKNAME_LENGTH * 4);
}

function isIdOrNull(value: unknown): value is string | null {
  return value === null || isId(value);
}

function isSeatId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < WATCH_HALL_SEAT_COUNT;
}

/** A copy of an array of playerIds, or null if it isn't one or has more than `max` entries. */
function idList(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length > max || !value.every(isId)) return null;
  return [...(value as string[])];
}

/** The first `max` playerIds of an array (extra entries are dropped, not the frame), or null if it isn't an array of ids. */
function truncatedIdList(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value)) return null;
  const list = (value as unknown[]).slice(0, max);
  return list.every(isId) ? (list as string[]) : null;
}

function parseHallStage(value: unknown): HallStageState | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const queue = idList(v.queue, HALL_STAGE_QUEUE_MAX);
  if (!queue || !isIdOrNull(v.holder) || !isFiniteNumber(v.since)) return null;
  if (typeof v.status !== "string" || !(HALL_STAGE_STATUSES as readonly string[]).includes(v.status)) return null;
  if (typeof v.locked !== "boolean" || typeof v.audio !== "boolean") return null;
  return {
    holder: v.holder,
    status: v.status as HallStageStatus,
    since: v.since,
    queue,
    card: v.card === null || v.card === undefined ? null : validateHallCard(v.card),
    locked: v.locked,
    audio: v.audio,
  };
}

/** The hall vote state: two small non-negative integer counts and the recipient's own flag, or null. */
function parseHallVote(value: unknown): HallVoteState | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const count = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= HALL_VOTE_COUNT_MAX;
  if (!count(v.votes) || !count(v.needed) || typeof v.voted !== "boolean") return null;
  return { votes: v.votes, needed: v.needed, voted: v.voted };
}

/** Occupied seats as [seatId, playerId] pairs; at most one entry per seat. */
function parseHallSeats(value: unknown): [number, string][] | null {
  if (!Array.isArray(value) || value.length > WATCH_HALL_SEAT_COUNT) return null;
  const seats: [number, string][] = [];
  const seen = new Set<number>();
  for (const entry of value as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isSeatId(entry[0]) || !isId(entry[1]) || seen.has(entry[0])) return null;
    seen.add(entry[0]);
    seats.push([entry[0], entry[1]]);
  }
  return seats;
}

function isReaction(value: unknown): value is HallReaction {
  return typeof value === "string" && (HALL_REACTIONS as readonly string[]).includes(value);
}

/** Per-reaction counts (a window's, or the session totals): unknown reaction ids are skipped, a malformed value rejects. */
function parseReactionCounts(value: unknown): Partial<Record<HallReaction, number>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const counts: Partial<Record<HallReaction, number>> = {};
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    if (!isReaction(key)) continue;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return null;
    counts[key] = Math.min(count, HALL_REACTION_TOTAL_MAX);
  }
  return counts;
}

/** The reaction session marker `{ id ≥ 0 (integer), active }`. */
function parseReactionSession(value: unknown): HallReactionSession | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, active } = value as Record<string, unknown>;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0 || typeof active !== "boolean") return null;
  return { id, active };
}

/** Counts and sample entries for unknown reaction ids are skipped (a newer server may add one); malformed values reject the frame. */
function parseHallReactions(msg: Record<string, unknown>): HallReactionsBroadcast | null {
  const counts = parseReactionCounts(msg.counts);
  const totals = parseReactionCounts(msg.totals);
  const session = parseReactionSession(msg.session);
  if (!counts || !totals || !session) return null;
  if (!Array.isArray(msg.sample) || msg.sample.length > HALL_REACTION_SAMPLE_MAX) return null;
  const sample: { playerId: string; reaction: HallReaction }[] = [];
  for (const entry of msg.sample as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const { playerId, reaction } = entry as Record<string, unknown>;
    if (!isId(playerId)) return null;
    if (isReaction(reaction)) sample.push({ playerId, reaction });
  }
  return { type: "hall_reactions", counts, sample, totals, session };
}
