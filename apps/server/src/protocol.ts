/**
 * Server-side half of the multiplayer wire protocol.
 *
 * The message *shapes* live in `@project/shared` (see
 * docs/decisions/ADR-006-shared-multiplayer-protocol-contracts.md) so
 * the client and server can never independently drift on what a
 * message looks like. What stays here is environment-specific: raw
 * frame parsing (uses Node's `Buffer`, unavailable in a browser) and
 * runtime validation of untrusted client input — nothing here assumes
 * a well-behaved client, see `parseIncomingFrame`.
 */

import {
  ANIMATION_STATES,
  CHAT_CHANNELS,
  HALL_CARD_LINKS_MAX,
  HALL_CARD_NAME_MAX,
  HALL_CARD_TITLE_MAX,
  HALL_CARD_URL_MAX,
  HALL_EVENT_ID_PATTERN,
  HALL_HOST_KEY_MAX,
  HALL_LINK_KINDS,
  HALL_REACTIONS,
  HALL_STAGE_COOLDOWN_MAX_MS,
  HALL_VIDEO_ID_PATTERN,
  MAX_MESSAGE_BYTES,
  MOD_ACTIONS,
  MOD_BAN_DURATIONS_MS,
  MOD_ID_PATTERN,
  MOD_MUTE_DURATIONS_MS,
  REPORT_NOTE_MAX,
  REPORT_REASONS,
  type ModAction,
  type ModActionMessage,
  type ReportReason,
  NAME_KEY_ALGS,
  NAME_KEY_HASH_PATTERN,
  NAME_PUBLIC_KEY_MAX,
  NAME_SIGNATURE_MAX,
  NAME_RESERVATION_ID_PATTERN,
  type NameKeyAlg,
  PAY_CAP_MAX_ZAT,
  PAY_DECLINE_REASONS,
  PAY_KEY_MAX,
  PAY_SEALED_MAX,
  TXID_PATTERN,
  MAX_NICKNAME_LENGTH,
  PLAYER_AVATAR_COLOR_COUNT,
  PLAYER_AVATAR_MODELS,
  WATCH_HALL_SEAT_COUNT,
  type AnimationState,
  type PlayerAvatar,
  type PlayerAvatarModel,
  type ClientToServerMessage,
  type HallCard,
  type HallCardLink,
  type HallLinkKind,
  type HallReaction,
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
      // ADR-015: `wallet` must be a boolean if present. An invalid `avatar` is treated as missing —
      // a join never fails because of a cosmetic field (the server falls back to the default).
      if (msg.wallet !== undefined && typeof msg.wallet !== "boolean") return null;
      const avatar = parseAvatar(msg.avatar);
      return {
        type: "join",
        nickname: msg.nickname as string | undefined,
        ...(avatar ? { avatar } : {}),
        ...(msg.wallet !== undefined ? { wallet: msg.wallet as boolean } : {}),
      };
    }

    // ADR-015 identity messages — shape only. Who may do what (holders only for set_avatar and
    // set_nickname, rate limits, reserved names) lives in WorldServer and nickname.ts.
    case "set_wallet":
      if (typeof msg.connected !== "boolean") return null;
      return { type: "set_wallet", connected: msg.connected };
    case "set_avatar": {
      const avatar = parseAvatar(msg.avatar);
      return avatar ? { type: "set_avatar", avatar } : null;
    }
    case "nickname_check":
      // Same as set_nickname: type only; sanitizeNickname() decides (the frame is size-bounded).
      if (typeof msg.nickname !== "string") return null;
      return { type: "nickname_check", nickname: msg.nickname };

    // ADR-016 owned names — shape only: the key hash, key and signature formats, the algorithm id and a bounded
    // nickname string. Name rules, holder-only, rate limits and the cryptography live in identity/nameRegistry.ts.
    case "name_reserve":
      if (!isNameText(msg.nickname) || typeof msg.keyHash !== "string" || !NAME_KEY_HASH_PATTERN.test(msg.keyHash)) return null;
      return { type: "name_reserve", nickname: msg.nickname, keyHash: msg.keyHash };
    case "name_claim_request":
      if (!isNameText(msg.nickname)) return null;
      return { type: "name_claim_request", nickname: msg.nickname };
    case "name_claim_proof":
      if (!isNameText(msg.nickname) || !isB64Url(msg.publicKey, NAME_PUBLIC_KEY_MAX) || !isB64Url(msg.signature, NAME_SIGNATURE_MAX)) return null;
      if (typeof msg.alg !== "string" || !(NAME_KEY_ALGS as readonly string[]).includes(msg.alg)) return null;
      return { type: "name_claim_proof", nickname: msg.nickname, publicKey: msg.publicKey, signature: msg.signature, alg: msg.alg as NameKeyAlg };

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

    case "chat_send": {
      // Type safety only — content rules live in chat.ts's sanitizeChatText(), called by WorldServer.
      if (typeof msg.text !== "string") return null;
      if (typeof msg.channel !== "string" || !(CHAT_CHANNELS as readonly string[]).includes(msg.channel)) return null;
      return { type: "chat_send", channel: msg.channel as (typeof CHAT_CHANNELS)[number], text: msg.text };
    }

    case "whisper_send": {
      if (typeof msg.text !== "string" || typeof msg.to !== "string" || msg.to.length > 64) return null;
      return { type: "whisper_send", to: msg.to, text: msg.text };
    }

    // ADR-013 payment relay — opaque base64 fields, shape and size only.
    case "pay_request":
      if (!isId(msg.to) || !isRequestId(msg.requestId) || !isB64(msg.senderKey, PAY_KEY_MAX)) return null;
      // ADR-018 § 4: the cap the sender's wallet enforces (optional; a capped server requires it).
      if (msg.capZat !== undefined && !(Number.isSafeInteger(msg.capZat) && (msg.capZat as number) >= 0 && (msg.capZat as number) <= PAY_CAP_MAX_ZAT)) return null;
      return { type: "pay_request", to: msg.to, requestId: msg.requestId, senderKey: msg.senderKey, ...(msg.capZat !== undefined ? { capZat: msg.capZat as number } : {}) };
    case "pay_accept":
      if (!isRequestId(msg.requestId) || !isB64(msg.recipientKey, PAY_KEY_MAX) || !isB64(msg.sealed, PAY_SEALED_MAX) || !isB64(msg.iv, 32)) return null;
      return { type: "pay_accept", requestId: msg.requestId, recipientKey: msg.recipientKey, sealed: msg.sealed, iv: msg.iv };
    case "pay_decline":
      if (!isRequestId(msg.requestId) || typeof msg.reason !== "string" || !(PAY_DECLINE_REASONS as readonly string[]).includes(msg.reason)) return null;
      return { type: "pay_decline", requestId: msg.requestId, reason: msg.reason as (typeof PAY_DECLINE_REASONS)[number] };
    case "pay_notice":
      if (!isRequestId(msg.requestId) || !isB64(msg.sealed, PAY_SEALED_MAX) || !isB64(msg.iv, 32)) return null;
      return { type: "pay_notice", requestId: msg.requestId, sealed: msg.sealed, iv: msg.iv };
    // ADR-018 § 6: the sender's txid for the transfer-fee check (64 lowercase hex).
    case "pay_sent":
      if (!isRequestId(msg.requestId) || !isTxid(msg.txid)) return null;
      return { type: "pay_sent", requestId: msg.requestId, txid: msg.txid };
    // The sender withdraws its own request (no key, no content).
    case "pay_cancel":
      if (!isRequestId(msg.requestId)) return null;
      return { type: "pay_cancel", requestId: msg.requestId };
    // ADR-018 § 5: the name-fee payment's txid for the lightwalletd registry backend.
    case "name_payment_sent":
      if (typeof msg.reservationId !== "string" || !NAME_RESERVATION_ID_PATTERN.test(msg.reservationId) || !isTxid(msg.txid)) return null;
      return { type: "name_payment_sent", reservationId: msg.reservationId, txid: msg.txid };

    // Watch Hall (ADR-014) — shape and size only. Membership, roles and the
    // card's content rules (sanitizing, link hosts) live in watchHall.ts, called by WorldServer.
    case "hall_stage_request":
    case "hall_stage_cancel":
    case "hall_stage_stop":
    case "hall_seat_release":
      return { type: msg.type };
    case "hall_stage_handover":
      if (!isId(msg.to)) return null;
      return { type: "hall_stage_handover", to: msg.to };
    case "hall_stage_live":
      if (typeof msg.live !== "boolean" || typeof msg.audio !== "boolean") return null;
      return { type: "hall_stage_live", live: msg.live, audio: msg.audio };
    case "hall_stage_card": {
      if (msg.card === null) return { type: "hall_stage_card", card: null };
      const card = parseHallCard(msg.card);
      return card ? { type: "hall_stage_card", card } : null;
    }
    case "hall_stage_lock":
      if (typeof msg.locked !== "boolean") return null;
      return { type: "hall_stage_lock", locked: msg.locked };
    case "hall_floor":
      if (msg.playerId !== null && !isId(msg.playerId)) return null;
      return { type: "hall_floor", playerId: msg.playerId };
    case "hall_react":
      if (typeof msg.reaction !== "string" || !(HALL_REACTIONS as readonly string[]).includes(msg.reaction)) return null;
      return { type: "hall_react", reaction: msg.reaction as HallReaction };
    case "hall_hand":
      if (typeof msg.raised !== "boolean") return null;
      return { type: "hall_hand", raised: msg.raised };
    case "hall_hand_lower":
      if (msg.playerId !== "*" && !isId(msg.playerId)) return null;
      return { type: "hall_hand_lower", playerId: msg.playerId };
    case "hall_seat_claim":
      if (!Number.isInteger(msg.seatId) || (msg.seatId as number) < 0 || (msg.seatId as number) >= WATCH_HALL_SEAT_COUNT) return null;
      return { type: "hall_seat_claim", seatId: msg.seatId as number };
    case "hall_host_auth":
      // Never logged or echoed. Compared (as a digest, in constant time) only in watchHall.ts.
      if (typeof msg.key !== "string" || msg.key.length === 0 || msg.key.length > HALL_HOST_KEY_MAX) return null;
      return { type: "hall_host_auth", key: msg.key };
    // Stage moderation — shape only; who may vote, dequeue or bench is decided in watchHall.ts.
    case "hall_stage_vote":
      if (typeof msg.end !== "boolean") return null;
      return { type: "hall_stage_vote", end: msg.end };
    case "hall_stage_dequeue":
      if (!isId(msg.playerId)) return null;
      return { type: "hall_stage_dequeue", playerId: msg.playerId };
    case "hall_stage_cooldown":
      if (!isId(msg.playerId) || !Number.isInteger(msg.ms) || (msg.ms as number) < 0 || (msg.ms as number) > HALL_STAGE_COOLDOWN_MAX_MS) return null;
      return { type: "hall_stage_cooldown", playerId: msg.playerId, ms: msg.ms as number };

    // Moderation (ADR-019) — shape only: a known reason, a bounded note (sanitized in WorldServer like chat), a known
    // action with the fields it needs and an allowed duration. Who may act (moderators) is decided in WorldServer.
    case "report":
      if (!isId(msg.targetId) || typeof msg.reason !== "string" || !(REPORT_REASONS as readonly string[]).includes(msg.reason)) return null;
      if (msg.note !== undefined && !isText(msg.note, REPORT_NOTE_MAX * 2)) return null;
      return { type: "report", targetId: msg.targetId, reason: msg.reason as ReportReason, ...(typeof msg.note === "string" ? { note: msg.note } : {}) };
    case "mod_action":
      return parseModAction(msg);

    default:
      return null;
  }
}

/**
 * A `mod_action` with exactly the fields its action uses. mute: a target (player or report) and one of
 * MOD_MUTE_DURATIONS_MS; kick: a target; ban: a target and one of MOD_BAN_DURATIONS_MS or null (until lifted);
 * unmute / unban: an entry id; dismiss_report: a report id. Rebuilt from known fields only.
 */
function parseModAction(msg: Record<string, unknown>): ModActionMessage | null {
  if (typeof msg.action !== "string" || !(MOD_ACTIONS as readonly string[]).includes(msg.action)) return null;
  const action = msg.action as ModAction;
  if (msg.targetId !== undefined && !isId(msg.targetId)) return null;
  if (msg.reportId !== undefined && !isModId(msg.reportId)) return null;
  if (msg.entryId !== undefined && !isModId(msg.entryId)) return null;
  const target = {
    ...(typeof msg.targetId === "string" ? { targetId: msg.targetId } : {}),
    ...(typeof msg.reportId === "string" ? { reportId: msg.reportId } : {}),
  };
  const hasTarget = msg.targetId !== undefined || msg.reportId !== undefined;
  switch (action) {
    case "mute":
      if (!hasTarget || !(MOD_MUTE_DURATIONS_MS as readonly unknown[]).includes(msg.durationMs)) return null;
      return { type: "mod_action", action, ...target, durationMs: msg.durationMs as number };
    case "kick":
      if (!hasTarget) return null;
      return { type: "mod_action", action, ...target };
    case "ban":
      if (!hasTarget || !(msg.durationMs === null || (MOD_BAN_DURATIONS_MS as readonly unknown[]).includes(msg.durationMs))) return null;
      return { type: "mod_action", action, ...target, durationMs: msg.durationMs as number | null };
    case "unmute":
    case "unban":
      if (typeof msg.entryId !== "string") return null;
      return { type: "mod_action", action, entryId: msg.entryId };
    case "dismiss_report":
      if (typeof msg.reportId !== "string") return null;
      return { type: "mod_action", action, reportId: msg.reportId };
    default:
      action satisfies never;
      return null;
  }
}

function isModId(value: unknown): value is string {
  return typeof value === "string" && MOD_ID_PATTERN.test(value);
}

/**
 * Card shape: a title, optional speaker/project, up to HALL_CARD_LINKS_MAX `{kind, url}` links and
 * the optional ids. Raw text may be up to twice its limit (the sanitizer collapses whitespace
 * first and then measures — see validateHallCard in watchHall.ts); ids must match their patterns.
 * Rebuilt from known fields only.
 */
function parseHallCard(raw: unknown): HallCard | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!isText(value.title, HALL_CARD_TITLE_MAX * 2)) return null;
  const card: HallCard = { title: value.title };
  for (const field of ["speaker", "project"] as const) {
    const text = value[field];
    if (text === undefined) continue;
    if (!isText(text, HALL_CARD_NAME_MAX * 2)) return null;
    card[field] = text;
  }
  if (value.links !== undefined) {
    if (!Array.isArray(value.links) || value.links.length > HALL_CARD_LINKS_MAX) return null;
    const links: HallCardLink[] = [];
    for (const entry of value.links as unknown[]) {
      if (typeof entry !== "object" || entry === null) return null;
      const link = entry as Record<string, unknown>;
      if (typeof link.kind !== "string" || !(HALL_LINK_KINDS as readonly string[]).includes(link.kind)) return null;
      if (!isText(link.url, HALL_CARD_URL_MAX)) return null;
      links.push({ kind: link.kind as HallLinkKind, url: link.url });
    }
    card.links = links;
  }
  if (value.eventId !== undefined) {
    if (typeof value.eventId !== "string" || !HALL_EVENT_ID_PATTERN.test(value.eventId)) return null;
    card.eventId = value.eventId;
  }
  if (value.videoId !== undefined) {
    if (typeof value.videoId !== "string" || !HALL_VIDEO_ID_PATTERN.test(value.videoId)) return null;
    card.videoId = value.videoId;
  }
  return card;
}

/** ADR-015: `{model, color}` with a known model id and an integer palette index; rebuilt from those two fields only. */
export function parseAvatar(raw: unknown): PlayerAvatar | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.model !== "string" || !(PLAYER_AVATAR_MODELS as readonly string[]).includes(value.model)) return null;
  if (typeof value.color !== "number" || !Number.isInteger(value.color) || value.color < 0 || value.color >= PLAYER_AVATAR_COLOR_COUNT) return null;
  return { model: value.model as PlayerAvatarModel, color: value.color };
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

/** A nickname field of a name_* message: a string of bounded raw length (NFKC can grow text; sanitizeNickname decides). */
function isNameText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_NICKNAME_LENGTH * 4;
}

function isB64Url(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}
function isRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,40}$/.test(value);
}
function isTxid(value: unknown): value is string {
  return typeof value === "string" && TXID_PATTERN.test(value);
}
function isB64(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[A-Za-z0-9+/=_-]+$/.test(value);
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
