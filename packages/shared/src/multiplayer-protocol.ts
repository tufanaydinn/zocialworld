/**
 * Multiplayer wire protocol contracts, shared verbatim between
 * `apps/server` and `apps/web`.
 *
 * This file is the **compile-time** source of truth, so the client and
 * server cannot declare these shapes independently and drift apart.
 * `docs/protocols/multiplayer-protocol.md` is the *prose* source of truth
 * (message semantics, rates, the interpolation/validation strategy) —
 * this file is its typed, enforced counterpart. See
 * `docs/decisions/ADR-006-shared-multiplayer-protocol-contracts.md`.
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

/**
 * `dance` and `cheer` (ADR-014 § 10) are emote-wheel states: a client older than
 * them drops transforms carrying them, so all clients ship together.
 */
export const ANIMATION_STATES = ["idle", "walk", "jog", "sit", "wave", "talk", "dance", "cheer"] as const;
export type AnimationState = (typeof ANIMATION_STATES)[number];

/** Informational default the server reports in `welcome`; see docs/protocols/multiplayer-protocol.md § Network rate. */
export const DEFAULT_TICK_RATE_HZ = 10;

/** Raw WebSocket text frames larger than this (bytes, UTF-8) are dropped before parsing — enforced server-side, since the server is what a malicious/buggy client could try to flood. */
export const MAX_MESSAGE_BYTES = 2048;

/** Maximum accepted length for a client-supplied `join.nickname`. */
export const MAX_NICKNAME_LENGTH = 24;

/** Text chat: longest accepted message, in characters, after sanitizing. */
export const MAX_CHAT_LENGTH = 200;
/** "Nearby" chat reaches every joined player within this distance (metres, 3D) of the sender's last known position. */
export const NEARBY_CHAT_RADIUS_METERS = 20;
/** `hall` (ADR-014) reaches only Watch Hall members — see § Watch Hall below. */
export const CHAT_CHANNELS = ["general", "nearby", "hall"] as const;
export type ChatChannel = (typeof CHAT_CHANNELS)[number];

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Identity (ADR-015): wallet holders and guests
// ---------------------------------------------------------------------------
//
// A wallet holder is a session whose in-game wallet reached ready/syncing at
// least once this page session (client-asserted, sticky until "Forget this
// wallet"). Everyone else is a guest. The ONLY wallet-derived bit on the wire
// is `canReceive` — never an address, balance, network, lock state or unlock
// time. Guests get a server-assigned `Guest-####`, the default avatar and no
// payments; holders choose a name and a character. Prose:
// docs/protocols/multiplayer-protocol.md § Identity: wallet holders and guests.

/**
 * The characters a wallet holder may choose (wire ids). SAME ORDER as the web
 * client's KayKit `AVATAR_MODELS` (apps/web/src/player/avatarModels.ts): a
 * session's default avatar is derived from its colorSeed by index, and that
 * mapping must stay what every client already showed before ADR-015.
 */
export const PLAYER_AVATAR_MODELS = ["rogue_hooded", "rogue", "knight", "mage", "barbarian"] as const;
export type PlayerAvatarModel = (typeof PLAYER_AVATAR_MODELS)[number];
/** Avatar colours are palette indices 0 .. PLAYER_AVATAR_COLOR_COUNT - 1; the colours themselves live in the web client (player/avatarPalette.ts). */
export const PLAYER_AVATAR_COLOR_COUNT = 8;

/** A player's look: one of the five models and a palette colour (an accent — the model itself is not recoloured). */
export interface PlayerAvatar {
  model: PlayerAvatarModel;
  color: number;
}

/**
 * The avatar of a session that has not chosen one (every guest, ADR-015 § 2): derived from the
 * session's colorSeed, so every client agrees. The model index is the same `colorSeed % 5` the web
 * client used for remote avatars before ADR-015.
 */
export function defaultPlayerAvatar(colorSeed: number): PlayerAvatar {
  const seed = Math.abs(Math.trunc(Number.isFinite(colorSeed) ? colorSeed : 0));
  return { model: PLAYER_AVATAR_MODELS[seed % PLAYER_AVATAR_MODELS.length]!, color: seed % PLAYER_AVATAR_COLOR_COUNT };
}

/** Server-generated guest names only. The server reserves this pattern (and look-alikes): nobody can choose it. */
export const GUEST_NICKNAME_PATTERN = /^Guest-\d{4}$/;

/** `nickname_check` answers: free right now, in use (with a suggestion), not a valid name, or reserved (the Guest pattern, system words). */
export const NICKNAME_CHECK_STATUSES = ["available", "taken", "invalid", "reserved"] as const;
export type NicknameCheckStatus = (typeof NICKNAME_CHECK_STATUSES)[number];

export interface JoinMessage {
  type: "join";
  /**
   * ADR-015: a guest keeps only a server-generated `Guest-####` that is still free (reconnect
   * continuity) — anything else is replaced by a fresh guest number. A holder gets this name
   * (sanitized, conflict-suffixed) unless it is reserved. ADR-016: while the server runs a name
   * registry, a holder's name is the one this connection confirmed or claimed (owned names) —
   * anything else asked for here is replaced by a Guest-style name.
   */
  nickname?: string;
  /** ADR-015: the holder's chosen look. Dropped for guests (they always get the default); an invalid value counts as missing. */
  avatar?: PlayerAvatar;
  /** ADR-015: "this session has an in-game wallet" (client-asserted, honour system). Becomes `canReceive`. */
  wallet?: boolean;
}

/**
 * ADR-015: the session's wallet-holder flag changed. `true` when the wallet first reaches
 * ready/syncing this page session; `false` ONLY on "Forget this wallet" (the session then becomes
 * a guest again, with a fresh `Guest-####` and the default avatar). A boolean and nothing else —
 * never an address, network, balance or lock state. Rate-limited.
 */
export interface SetWalletMessage {
  type: "set_wallet";
  connected: boolean;
}

/** ADR-015: a wallet holder changes character. Dropped for guests; rate-limited; broadcast as `avatar_updated`. */
export interface SetAvatarMessage {
  type: "set_avatar";
  avatar: PlayerAvatar;
}

/**
 * ADR-015: is this nickname free? The one message besides `heartbeat` the server answers BEFORE
 * `join` (onboarding asks while the player types). It reserves nothing and is never logged;
 * rate-limited per connection.
 */
export interface NicknameCheckMessage {
  type: "nickname_check";
  nickname: string;
}

// ---------------------------------------------------------------------------
// Owned names (ADR-016): fee-confirmed registration, test chain only
// ---------------------------------------------------------------------------
//
// A wallet holder confirms a name with a small SHIELDED payment to the game's
// name registry, carrying a ZIP 302 text memo that binds the payment to a
// reservation and to the holder's name key (a key pair derived from the wallet
// seed, domain-separated: "zocial-world/name-key/v1/<network>" — never an
// address). Flow: name_reserve → name_quote (owner-only) → the wallet pays →
// name_status pending/seen/confirmed → the existing nickname_updated broadcast.
// A returning player proves the key instead of paying again:
// name_claim_request → name_challenge → name_claim_proof → name_status.
// All of these are owner-only replies; none is broadcast. They are answered
// before join too (onboarding runs before the player exists for anyone).
// Prose: docs/protocols/multiplayer-protocol.md § Owned names.

/** SHA-256 of a name key's raw public key, lowercase hex. */
export const NAME_KEY_HASH_PATTERN = /^[0-9a-f]{64}$/;
/** How many hex characters of the key hash the payment memo carries. */
export const NAME_MEMO_KEY_PREFIX_LENGTH = 16;
/** Reservation ids are 16 random bytes, base64url (owner-only: never broadcast, never logged). */
export const NAME_RESERVATION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** Memo and challenge nonces are 16 random bytes, lowercase hex. */
export const NAME_NONCE_PATTERN = /^[0-9a-f]{32}$/;
/** Name-key algorithms: WebCrypto Ed25519 where the browser has it, ECDSA P-256 (SHA-256) otherwise. */
export const NAME_KEY_ALGS = ["ed25519", "p256"] as const;
export type NameKeyAlg = (typeof NAME_KEY_ALGS)[number];
/** Longest accepted base64url public key (Ed25519 raw: 43 characters; P-256 uncompressed point: 87). */
export const NAME_PUBLIC_KEY_MAX = 96;
/** Longest accepted base64url signature (both algorithms sign 64 bytes: 86 characters). */
export const NAME_SIGNATURE_MAX = 96;
/** Longest registry address a quote may carry (a unified address with every receiver is ~ 220 characters). */
export const NAME_ADDRESS_MAX = 512;
/** A reservation holds a name for this long; a payment must arrive before it expires. */
export const NAME_RESERVATION_TTL_MS = 30 * 60 * 1000;
/** A claim challenge is valid for this long, once, for the session that asked. */
export const NAME_CHALLENGE_TTL_MS = 2 * 60 * 1000;
/**
 * What a client may be quoted at most (0.1 ZEC). The registry's fee is far below this; a client refuses a larger
 * quote rather than paying it (a misconfigured or hostile server cannot make it pay more).
 */
export const NAME_FEE_MAX_ZAT = 10_000_000;
/**
 * The `dev` registry backend (local development and tests only — it refuses to start with NODE_ENV=production)
 * quotes this placeholder unless NAME_REGISTRY_ADDRESS is set. It is not an address: the client pays nothing for
 * it, and the server confirms on its own after ~2 s.
 */
export const NAME_DEV_ADDRESS = "zw-dev-registry";

/**
 * `name_status` values:
 *  - answers to `name_reserve`: `taken`, `invalid`, `disabled` (no registration on this server, or a guest asked),
 *    `rate_limited`;
 *  - progress of a reservation: `pending` (quoted, waiting for the payment), `seen` (a matching payment arrived and
 *    waits for its confirmations), `confirmed` (the name is now owned by the key), `expired` (no matching payment
 *    within NAME_RESERVATION_TTL_MS — a later payment is consumed and cannot be reused);
 *  - answers to `name_claim_proof`: `confirmed` or `failed`.
 */
export const NAME_STATUSES = ["pending", "seen", "confirmed", "expired", "disabled", "taken", "invalid", "rate_limited", "failed"] as const;
export type NameStatus = (typeof NAME_STATUSES)[number];

const NAME_MEMO_PREFIX = "zw-name:v1:";

/** The registration memo (ZIP 302 text): `zw-name:v1:<nonce>:<first 16 hex of the key hash>` — 60 ASCII bytes. */
export function buildNameMemo(nonce: string, keyHash: string): string {
  return `${NAME_MEMO_PREFIX}${nonce}:${keyHash.slice(0, NAME_MEMO_KEY_PREFIX_LENGTH)}`;
}

/** Parses a registration memo (trailing NULs and whitespace, which ZIP 302 padding can leave, are ignored); null if it is not one. */
export function parseNameMemo(memo: string): { nonce: string; keyHashPrefix: string } | null {
  const text = memo.replace(/[\u0000\s]+$/u, "");
  if (!text.startsWith(NAME_MEMO_PREFIX)) return null;
  const [nonce, keyHashPrefix, ...rest] = text.slice(NAME_MEMO_PREFIX.length).split(":");
  if (rest.length > 0 || nonce === undefined || keyHashPrefix === undefined) return null;
  if (!NAME_NONCE_PATTERN.test(nonce) || !new RegExp(`^[0-9a-f]{${NAME_MEMO_KEY_PREFIX_LENGTH}}$`).test(keyHashPrefix)) return null;
  return { nonce, keyHashPrefix };
}

/**
 * What a returning player's name key signs (UTF-8): the server's single-use nonce and the nickname exactly as sent
 * in `name_claim_proof`. The nonce is bound to the asking session server-side, so a signature cannot be replayed
 * into another session.
 */
export function nameClaimMessage(nonce: string, nickname: string): string {
  return `zocial-world/name-claim/v1:${nonce}:${nickname}`;
}

/**
 * ADR-018 § 5: the paying wallet hands the server the transaction id of its name-fee payment. Used by
 * the `lightwalletd` registry backend (mainnet: zcashd no longer follows mainnet), which fetches that transaction and
 * trial-decrypts it with the registry's viewing key; progress comes back as `name_status` (seen / confirmed). Other
 * backends ignore it. The txid is not stored (only a one-way note hash, as ADR-016).
 */
export interface NamePaymentSentMessage {
  type: "name_payment_sent";
  reservationId: string;
  txid: string;
}

/** Reserve `nickname` for the key with this hash (a wallet holder, or a connection still in onboarding). */
export interface NameReserveMessage {
  type: "name_reserve";
  nickname: string;
  keyHash: string;
}

/** A returning player asks to prove a name it registered earlier. The answer is a `name_challenge`. */
export interface NameClaimRequestMessage {
  type: "name_claim_request";
  nickname: string;
}

/** The signed answer to `name_challenge`: `signature` over `nameClaimMessage(nonce, nickname)`, base64url. */
export interface NameClaimProofMessage {
  type: "name_claim_proof";
  nickname: string;
  /** Raw public key, base64url (Ed25519: 32 bytes; P-256: the 65-byte uncompressed point). */
  publicKey: string;
  signature: string;
  alg: NameKeyAlg;
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
 * Requests a nickname change for the sender's own session.
 * The server is authoritative: it validates and may resolve a conflict
 * by appending a suffix (see docs/protocols/multiplayer-protocol.md §
 * Nickname validation and conflict resolution) before broadcasting the
 * accepted value back as `NicknameUpdatedMessage`. An invalid request is
 * dropped silently — the session's nickname is left unchanged.
 *
 * ADR-016: honoured only while the server runs NO name registry
 * (`NAME_REGISTRY=off`, ADR-015's honour mode). With a registry, a holder's
 * name changes only through a confirmed registration or a claim, and this
 * request is dropped like an invalid one.
 */
export interface SetNicknameMessage {
  type: "set_nickname";
  nickname: string;
}

/**
 * Text chat. `general` reaches everyone in this world
 * instance, `nearby` only players within NEARBY_CHAT_RADIUS_METERS, and
 * `hall` only Watch Hall members — a sender outside the
 * hall gets `chat_rejected{not_in_hall}`. The server sanitizes,
 * rate-limits and relays; it never stores or logs message text
 * (docs/privacy/CHAT_THREAT_MODEL.md).
 */
export interface ChatSendMessage {
  type: "chat_send";
  channel: ChatChannel;
  text: string;
}

/** A private message to one player, relayed only to that player (and echoed to the sender). */
export interface WhisperSendMessage {
  type: "whisper_send";
  /** Recipient's session playerId. */
  to: string;
  text: string;
}

/**
 * Private player-to-player payments (ADR-013). The server only
 * RELAYS these between two sessions; the recipient's address travels
 * end-to-end encrypted (ECDH P-256 + AES-GCM between the two browsers), so
 * the server never sees an address, amount or memo. Every field is opaque
 * base64 to the server.
 *
 * Flow: pay_request (sender → recipient, sender's public key) →
 * pay_accept (recipient → sender, recipient's public key + sealed address)
 * or pay_decline → after broadcasting, pay_notice (sender → recipient,
 * sealed amount/txid). The server forwards accept/decline/notice only
 * within a request it relayed, between the same two sessions.
 */
export const PAY_KEY_MAX = 120;
export const PAY_SEALED_MAX = 1600;
export const PAY_DECLINE_REASONS = ["declined", "no_wallet", "busy", "expired", "failed"] as const;
export type PayDeclineReason = (typeof PAY_DECLINE_REASONS)[number];
/**
 * Why the server refused to relay a pay_* message (sent back to the sender as `pay_error`).
 * ADR-015 adds `no_wallet` (the recipient is a guest: there is nowhere for the money to go) and
 * `sender_no_wallet` (guests cannot send) — both checked before a request spends a rate token.
 */
export const PAY_ERROR_REASONS = ["unknown_recipient", "self", "rate_limited", "unknown_request", "no_wallet", "sender_no_wallet", "over_cap", "fee_unpaid"] as const;
export type PayErrorReason = (typeof PAY_ERROR_REASONS)[number];

// ADR-018 § 4 (payment cap) and § 6 (transfer fee). Mainnet only unless a test server configures them.
//  - `over_cap`: the server has a per-transaction cap (PAYMENT_CAP_ZEC) and the request's `capZat` is missing or
//    above it. The amount itself stays sealed between the two browsers (ADR-013): the server checks the cap the
//    sender's client enforces, the client's wallet adapter refuses a larger amount.
//  - `fee_unpaid`: this session accepted a fee-bearing payment and then did not pay the project fee (no `pay_sent`
//    or `pay_cancel` within PAY_FEE_DEADLINE_MS of the acceptance, or its transaction was mined without a matching
//    fee output): its further payment requests are refused for the rest of the session. A late `pay_sent` that
//    verifies lifts it; a lightwalletd error never causes it (docs/protocols/multiplayer-protocol.md).
/** The project's transfer fee memo (ZIP 302 text): `zw-fee:v1:<nonce>` — the nonce is issued per payment request by the server. */
export const PAY_FEE_MEMO_PREFIX = "zw-fee:v1:";
/** Fee nonces are 16 random bytes, lowercase hex. */
export const PAY_FEE_NONCE_PATTERN = /^[0-9a-f]{32}$/;
/** A client refuses a fee quote above this (0.01 ZEC): a hostile or misconfigured server cannot make it pay more. */
export const PAY_FEE_MAX_ZAT = 1_000_000;
/** After an acceptance carrying a fee, the sender has this long to report its transaction (`pay_sent`) or cancel. */
export const PAY_FEE_DEADLINE_MS = 30 * 60 * 1000;
/** A transaction id as explorers print it (64 lowercase hex characters). */
export const TXID_PATTERN = /^[0-9a-f]{64}$/;
/** A request's `capZat` may not exceed this (21 million ZEC, the supply). */
export const PAY_CAP_MAX_ZAT = 2_100_000_000_000_000;

/** The transfer-fee memo for a nonce. */
export function buildPayFeeMemo(nonce: string): string {
  return `${PAY_FEE_MEMO_PREFIX}${nonce}`;
}

export interface PayRequestMessage {
  type: "pay_request";
  to: string;
  requestId: string;
  senderKey: string;
  /**
   * ADR-018 § 4: the per-transaction cap the sender's wallet enforces, in zatoshis (what the recipient
   * may get at most; the transfer fee comes on top). Required by a server with a cap, which refuses a missing or
   * larger value with `over_cap`. Never the amount itself.
   */
  capZat?: number;
}
export interface PayAcceptMessage {
  type: "pay_accept";
  requestId: string;
  recipientKey: string;
  sealed: string;
  iv: string;
}
export interface PayDeclineMessage {
  type: "pay_decline";
  requestId: string;
  reason: PayDeclineReason;
}
export interface PayNoticeMessage {
  type: "pay_notice";
  requestId: string;
  sealed: string;
  iv: string;
}
/**
 * ADR-018 § 6: after broadcasting a payment whose acceptance carried a `fee`, the sender reports the
 * transaction id (before its `pay_notice`). The server fetches that transaction through its own lightwalletd
 * connection, decrypts ONLY the fee output with the project's viewing key, checks the amount and the nonce, and
 * then discards the txid (never stored, logged or shown). Sent only for fee-bearing payments; nothing is answered.
 */
export interface PaySentMessage {
  type: "pay_sent";
  requestId: string;
  txid: string;
}
/**
 * The SENDER withdraws its own request — while waiting for the acceptance, after
 * a bad or late acceptance, or instead of paying. No key is needed, so it works before the two sides share one. The
 * server drops the request (whether or not it was accepted, and even when the recipient already left) together with
 * any fee entry that has no reported transaction (no fee is owed), and relays it to the recipient if it is still
 * there. Only the request's sender may cancel; never answered.
 */
export interface PayCancelMessage {
  type: "pay_cancel";
  requestId: string;
}


// ---------------------------------------------------------------------------
// Watch Hall (ADR-014) — constants and client -> server
// ---------------------------------------------------------------------------
//
// The server derives hall membership from each session's last pose (an AABB
// around WATCH_HALL_ORIGIN, entered at the box and left only beyond
// WATCH_HALL_EXIT_MARGIN_METERS). Hall messages reach members only. All hall
// state is in memory, never logged, and dropped on disconnect. Membership is
// a social scope, not access control (positions are client-authoritative,
// ADR-005). Prose: docs/protocols/multiplayer-protocol.md § Watch Hall and
// docs/architecture/WATCH_HALL.md.

/** World-space centre of the Watch Hall location (ADR-010 shared coordinates). */
export const WATCH_HALL_ORIGIN = { x: -1000, z: 0 } as const;
/** Interior half extents (metres) around WATCH_HALL_ORIGIN. */
export const WATCH_HALL_HALF_EXTENTS = { x: 20, z: 15 } as const;
/** A member stops being a member only this far outside the interior box (hysteresis). */
export const WATCH_HALL_EXIT_MARGIN_METERS = 2;
/** Seat ids are 0 .. WATCH_HALL_SEAT_COUNT - 1. */
export const WATCH_HALL_SEAT_COUNT = 60;

export const HALL_STAGE_QUEUE_MAX = 12;
/** A granted holder must report `hall_stage_live{live:true}` within this time or the turn passes on. */
export const HALL_STAGE_PREPARE_TIMEOUT_MS = 45_000;
/** A holder who walks out of the hall keeps the stage this long before the turn ends. */
export const HALL_STAGE_LEAVE_GRACE_MS = 15_000;
/** Reactions are aggregated and flushed to members at most this often. */
export const HALL_REACTION_FLUSH_MS = 250;
/** A seat is released by a walk/jog transform arriving later than this after the claim. */
export const HALL_SEAT_SETTLE_MS = 1_500;

/** Reaction ids (never raw emoji on the wire). Client keys 1–8 in this order. */
export const HALL_REACTIONS = ["clap", "heart", "fire", "laugh", "wow", "party", "zec", "idea"] as const;
export type HallReaction = (typeof HALL_REACTIONS)[number];

export const HALL_STAGE_STATUSES = ["idle", "preparing", "live"] as const;
export type HallStageStatus = (typeof HALL_STAGE_STATUSES)[number];

/** Speaker / project card limits (the whole client frame must stay under MAX_MESSAGE_BYTES). */
export const HALL_CARD_TITLE_MAX = 80;
export const HALL_CARD_NAME_MAX = 48;
export const HALL_CARD_LINKS_MAX = 4;
export const HALL_CARD_URL_MAX = 200;
export const HALL_LINK_KINDS = ["github", "docs", "zechub", "forum", "web"] as const;
export type HallLinkKind = (typeof HALL_LINK_KINDS)[number];
/**
 * Card links must be `https://` URLs (no credentials, no port) on exactly one
 * of these hosts. Both apps validate; clients still render them as text and
 * route them through the in-game link router.
 */
export const HALL_CARD_LINK_HOSTS = [
  "github.com",
  "zechub.wiki",
  "www.zechub.wiki",
  "forum.zcashcommunity.com",
  "z.cash",
  "zips.z.cash",
  "zcash.readthedocs.io",
  "zfnd.org",
  "electriccoin.co",
  "zcashcommunitygrants.org",
  "shieldedlabs.net",
] as const;
/** A YouTube video id (what the opt-in personal player may open). */
export const HALL_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
/** A watch-catalogue event or replay id. */
export const HALL_EVENT_ID_PATTERN = /^[a-z0-9-]{1,48}$/;
export const HALL_HOST_KEY_MAX = 128;
/** At most this many raised hands at once; the server refuses further raises with `hand:full`. */
export const HALL_HANDS_MAX = 128;
/** At most this many host sessions at once; further host sign-ins get `host:full`. */
export const HALL_HOSTS_MAX = 32;

// Stage moderation (docs/architecture/WATCH_HALL.md).
/**
 * An audience vote ends a live share at max(HALL_VOTE_MIN, ceil(HALL_VOTE_FRACTION × the other members present))
 * votes. "The other members" are every hall member except the holder; while a name registry runs only owned names
 * may vote, so guests make the bar higher, never lower.
 */
export const HALL_VOTE_MIN = 3;
export const HALL_VOTE_FRACTION = 0.5;
/** A turn ended by an audience vote keeps its holder off the stage this long. */
export const HALL_STAGE_VOTE_COOLDOWN_MS = 10 * 60_000;
/** The longest stage cooldown a host may set for one player (0 clears one). */
export const HALL_STAGE_COOLDOWN_MAX_MS = 24 * 60 * 60_000;

export interface HallCardLink {
  kind: HallLinkKind;
  url: string;
}

/** What is on the big screen right now (or up next). Text only — clients render with textContent. */
export interface HallCard {
  title: string;
  speaker?: string;
  project?: string;
  links?: HallCardLink[];
  /** Id from the /content/watch catalogue (display/linking only). */
  eventId?: string;
  /** YouTube id viewers may open in their opt-in personal player. */
  videoId?: string;
}

/** Join the stage queue (members only, idempotent). */
export interface HallStageRequestMessage {
  type: "hall_stage_request";
}
/** Leave the stage queue. */
export interface HallStageCancelMessage {
  type: "hall_stage_cancel";
}
/** The holder ends their turn; from a host, force-stops the current holder. */
export interface HallStageStopMessage {
  type: "hall_stage_stop";
}
/**
 * Holder or host passes the stage to a player who is already queued (queuing is the consent).
 * A host inside the hall may also pass it to a member whose hand is raised (raising a hand is
 * the consent), so a full queue can never keep a presenter off a locked stage.
 */
export interface HallStageHandoverMessage {
  type: "hall_stage_handover";
  to: string;
}
/** Holder only: its LiveKit screen publication started/ended, and whether tab audio is included. */
export interface HallStageLiveMessage {
  type: "hall_stage_live";
  live: boolean;
  audio: boolean;
}
/** Holder or host sets (or clears) the speaker / project card. */
export interface HallStageCardMessage {
  type: "hall_stage_card";
  card: HallCard | null;
}
/** Host only: while locked the queue does not auto-advance. */
export interface HallStageLockMessage {
  type: "hall_stage_lock";
  locked: boolean;
}
/**
 * Holder or host gives one member a hall-wide microphone (null takes it back). The member must
 * have raised a hand (raising a hand is the consent) unless it is the sender. The member who has
 * the floor may give it up with `playerId: null`.
 */
export interface HallFloorMessage {
  type: "hall_floor";
  playerId: string | null;
}
export interface HallReactMessage {
  type: "hall_react";
  reaction: HallReaction;
}
export interface HallHandMessage {
  type: "hall_hand";
  raised: boolean;
}
/** Holder or host lowers one raised hand, or every hand with "*". */
export interface HallHandLowerMessage {
  type: "hall_hand_lower";
  playerId: string;
}
export interface HallSeatClaimMessage {
  type: "hall_seat_claim";
  seatId: number;
}
export interface HallSeatReleaseMessage {
  type: "hall_seat_release";
}
/** Session-scoped host authentication against WATCH_HALL_HOST_KEY. Never echoed, never logged. */
export interface HallHostAuthMessage {
  type: "hall_host_auth";
  key: string;
}
/**
 * Vote to end the live share (`end: true`) or take the vote back. Members other than the holder, while
 * the stage is live and unlocked; only owned names while a name registry runs. Who voted is never sent to anyone.
 */
export interface HallStageVoteMessage {
  type: "hall_stage_vote";
  end: boolean;
}
/** Host only: take a player out of the stage queue. */
export interface HallStageDequeueMessage {
  type: "hall_stage_dequeue";
  playerId: string;
}
/**
 * Host only: keep a player off the stage for `ms` (0 clears it; at most HALL_STAGE_COOLDOWN_MAX_MS).
 * It also ends that player's turn and drops their queue place.
 */
export interface HallStageCooldownMessage {
  type: "hall_stage_cooldown";
  playerId: string;
  ms: number;
}

export type HallClientMessage =
  | HallStageRequestMessage
  | HallStageCancelMessage
  | HallStageStopMessage
  | HallStageHandoverMessage
  | HallStageLiveMessage
  | HallStageCardMessage
  | HallStageLockMessage
  | HallFloorMessage
  | HallReactMessage
  | HallHandMessage
  | HallHandLowerMessage
  | HallSeatClaimMessage
  | HallSeatReleaseMessage
  | HallHostAuthMessage
  | HallStageVoteMessage
  | HallStageDequeueMessage
  | HallStageCooldownMessage;

// ---------------------------------------------------------------------------
// Moderation (ADR-019) — constants and client -> server
// ---------------------------------------------------------------------------
//
// Everyone may report a player; moderators (a session that signed in with one
// of the operator's MODERATOR_KEYS, through the same `hall_host_auth` field as
// the Watch Hall host key — it works anywhere in the world) may mute, kick and
// ban, and see the reports, the moderation log and the active bans and mutes.
// Reports, the log, mutes and short bans are kept in memory only and never
// logged; a ban of 24 h or more on an owned name is stored as `bannedUntil` in
// that name's record (ADR-016's names.json). Guests and holders without an
// owned name are keyed by a per-process keyed hash of their connection's IP
// address (at most 24 h, memory only). Prose:
// docs/protocols/multiplayer-protocol.md § Moderation.

/** Why a player is reported (the reporter picks one). */
export const REPORT_REASONS = ["spam", "harassment", "impersonation", "scam", "inappropriate_share", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
/** The reporter's optional note, at most this many characters after sanitizing. */
export const REPORT_NOTE_MAX = 280;
/** Where the reported player was when the report arrived (ADR-010 locations). */
export const REPORT_LOCATIONS = ["district", "valley", "hall"] as const;
export type ReportLocation = (typeof REPORT_LOCATIONS)[number];
/** At most this many reports per reporter per REPORT_WINDOW_MS, and one per reporter–target pair per window. */
export const REPORTS_PER_WINDOW = 3;
export const REPORT_WINDOW_MS = 10 * 60_000;
/** The report queue keeps the last REPORT_QUEUE_MAX reports, each for at most REPORT_TTL_MS (or until handled). */
export const REPORT_QUEUE_MAX = 100;
export const REPORT_TTL_MS = 24 * 60 * 60_000;
/** The moderation log keeps the last MOD_LOG_MAX actions (memory only). */
export const MOD_LOG_MAX = 200;

/** The chat mutes a moderator may choose. */
export const MOD_MUTE_DURATIONS_MS = [10 * 60_000, 60 * 60_000, 24 * 60 * 60_000] as const;
/** A kick keeps the same identity out for this long. */
export const MOD_KICK_MS = 10 * 60_000;
/** The bans a moderator may choose; `durationMs: null` is "until a moderator lifts it". */
export const MOD_BAN_DURATIONS_MS = [60 * 60_000, 24 * 60 * 60_000, 7 * 24 * 60 * 60_000] as const;
/** `until` of a ban that lasts until a moderator lifts it (the largest JavaScript date). */
export const MOD_BAN_FOREVER = 8_640_000_000_000_000;
/** Entries keyed by the connection hash last at most this long (longer bans are capped there for that key). */
export const MOD_CONNECTION_KEY_MAX_MS = 24 * 60 * 60_000;
/** A ban at least this long on an owned name is stored in names.json (survives a restart). */
export const MOD_PERSIST_MIN_MS = 24 * 60 * 60_000;
/** Report and entry ids: a letter and a counter (`r12`, `b3`, `m7`, `l40`). */
export const MOD_ID_PATTERN = /^[a-z][0-9]{1,12}$/;
/**
 * The longest nickname label a moderation message carries (reports, the log, bans, mutes, `mod_action_result.target`).
 * A stored ban on a key that owns several names is labelled "A, B +N more" within it.
 */
export const MOD_NICKNAME_LABEL_MAX = MAX_NICKNAME_LENGTH * 4;

/**
 * WebSocket close codes (application range) for a socket the server closes on purpose. The close reason is the
 * key (`kicked`, `banned`, `too_many_connections`); a `moderation_notice` with the details comes just before the close.
 * A client never reconnects on its own after one of these.
 */
export const MOD_CLOSE_CODES = { kicked: 4001, banned: 4002, too_many_connections: 4003 } as const;
export type ModCloseReason = keyof typeof MOD_CLOSE_CODES;

export const MOD_ACTIONS = ["mute", "unmute", "kick", "ban", "unban", "dismiss_report"] as const;
export type ModAction = (typeof MOD_ACTIONS)[number];
/**
 * Why a `mod_action` was refused: not a moderator; the target or the entry is gone; a duration or field that isn't
 * allowed; acting on yourself; acting on another moderator (rotate MODERATOR_KEYS to remove one).
 */
export const MOD_ACTION_ERRORS = ["not_moderator", "unknown_player", "unknown_entry", "invalid", "self", "moderator"] as const;
export type ModActionError = (typeof MOD_ACTION_ERRORS)[number];
/**
 * `report_ack`: `sent` (queued, and delivered live to every online moderator), `rate_limited`, `unknown_player` (gone),
 * `self`, `invalid` (a note too long), `unavailable` (this server has no MODERATOR_KEYS: nobody would read it, so it
 * isn't kept).
 */
export const REPORT_ACK_STATUSES = ["sent", "rate_limited", "unknown_player", "self", "invalid", "unavailable"] as const;
export type ReportAckStatus = (typeof REPORT_ACK_STATUSES)[number];
/** What the target of a moderation action (or a refused connection) is told. */
export const MODERATION_NOTICE_KINDS = ["muted", "unmuted", "kicked", "banned", "too_many_connections"] as const;
export type ModerationNoticeKind = (typeof MODERATION_NOTICE_KINDS)[number];

/**
 * Report a player (joined sessions, guests included). The reporter is answered with `report_ack`; online moderators
 * get `mod_report`. The reported player is never told who reported them. Rate-limited (REPORTS_PER_WINDOW).
 */
export interface ReportMessage {
  type: "report";
  /** The reported player's session playerId. */
  targetId: string;
  reason: ReportReason;
  /** Optional, at most REPORT_NOTE_MAX characters (sanitized like chat). */
  note?: string;
}

/**
 * A moderator's action. `mute` (`durationMs` one of MOD_MUTE_DURATIONS_MS), `kick` and `ban` (`durationMs` one of
 * MOD_BAN_DURATIONS_MS, or null until lifted) name an online player (`targetId`) or a report (`reportId`: the
 * report's target, also after they left). With `targetId`, an optional `reportId` marks that report handled.
 * `unmute` / `unban` name an active entry (`entryId`); `dismiss_report` a report. Answered with `mod_action_result`;
 * a non-moderator gets `not_moderator` for every action.
 */
export interface ModActionMessage {
  type: "mod_action";
  action: ModAction;
  targetId?: string;
  reportId?: string;
  entryId?: string;
  durationMs?: number | null;
}

export type ModerationClientMessage = ReportMessage | ModActionMessage;

export type ClientToServerMessage =
  | HallClientMessage
  | ModerationClientMessage
  | JoinMessage
  | PlayerTransformMessage
  | HeartbeatMessage
  | SetNicknameMessage
  | SetWalletMessage
  | SetAvatarMessage
  | NicknameCheckMessage
  | NameReserveMessage
  | NameClaimRequestMessage
  | NameClaimProofMessage
  | NamePaymentSentMessage
  | ChatSendMessage
  | WhisperSendMessage
  | PayRequestMessage
  | PayAcceptMessage
  | PayDeclineMessage
  | PayNoticeMessage
  | PaySentMessage
  | PayCancelMessage;

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export interface PlayerSummary {
  playerId: string;
  nickname: string;
  colorSeed: number;
  /** ADR-015: the player's look (a guest's is always `defaultPlayerAvatar(colorSeed)`). */
  avatar: PlayerAvatar;
  /**
   * ADR-015: whether this player can receive ZEC privately (a wallet holder). The ONLY
   * wallet-derived bit any peer receives — no address, balance, network or lock state. Clients
   * show it only in the player menu ("Can receive ZEC privately"), never as a nameplate badge.
   */
  canReceive: boolean;
  /**
   * ADR-019 § 1: present (true) when this player signed in as a moderator this session — clients show
   * a small "Moderator" tag on the nameplate. Never inferred from anything else; absent for everyone else.
   */
  moderator?: boolean;
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
  /** ADR-015: the server-accepted avatar (the default for a guest, whatever the join asked for). */
  avatar: PlayerAvatar;
  /** ADR-015: the server-accepted wallet-holder flag (`join.wallet === true`). */
  canReceive: boolean;
  tickRateHz: number;
  /**
   * ADR-018 § 7: the id of the web client build this server serves (also `GET /version`). A client
   * running another build offers "Update ready — reload" and reloads only between actions. Absent when the server
   * does not know it (development, or a client hosted elsewhere without BUILD_ID).
   */
  build?: string;
  /**
   * A cryptographically random, ephemeral, session-
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
   * client's interpolation buffer — the protocol does no clock
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
 * trigger this; only a later `set_nickname` does (ADR-016: or a confirmed
 * registration / successful claim of an owned name). `nickname` is the
 * server-accepted value, which may differ from what was requested (see
 * `SetNicknameMessage`).
 */
export interface NicknameUpdatedMessage {
  type: "nickname_updated";
  playerId: string;
  nickname: string;
}

/**
 * A chat line accepted by the server. The sender receives its own
 * messages too (same messageId), so a client shows exactly what the
 * server accepted. For whispers, `toPlayerId`/`toNickname` name the
 * recipient (the sender's echo needs them).
 */
export interface ChatMessageBroadcast {
  type: "chat_message";
  channel: ChatChannel | "whisper";
  messageId: string;
  fromPlayerId: string;
  fromNickname: string;
  toPlayerId?: string;
  toNickname?: string;
  text: string;
  /** Server receive time, ms since epoch (display only). */
  t: number;
}

/** `not_in_hall`: a `hall` line from a session that is not a Watch Hall member (checked before the chat rate limit is spent). */
export const CHAT_REJECT_REASONS = ["rate_limited", "empty", "too_long", "unknown_recipient", "self", "not_in_hall"] as const;
export type ChatRejectReason = (typeof CHAT_REJECT_REASONS)[number];

/** Sent only to the sender when a chat_send/whisper_send was not relayed. */
export interface ChatRejectedMessage {
  type: "chat_rejected";
  reason: ChatRejectReason;
}

/** Relayed payment messages carry the counterpart's session id and current nickname. */
export interface PayRequestRelay extends PayRequestMessage {
  from: string;
  fromNickname: string;
}
/**
 * ADR-018 § 6: the project's transfer fee for this payment, added by the SERVER to the acceptance it
 * relays to the sender (never content from the recipient): a second shielded output to `address` of `zat` zatoshis
 * with the memo `buildPayFeeMemo(nonce)`, in the same transaction. Present only when the server charges the fee.
 */
export interface PayFeeQuote {
  address: string;
  zat: number;
  nonce: string;
}
export interface PayAcceptRelay extends PayAcceptMessage {
  from: string;
  fee?: PayFeeQuote;
}
export interface PayDeclineRelay extends PayDeclineMessage {
  from: string;
}
export interface PayNoticeRelay extends PayNoticeMessage {
  from: string;
  fromNickname: string;
}
/**
 * The request is over because `from` ended it — to the recipient when the sender cancelled
 * (`pay_cancel`) or left the world, to the sender when the recipient left. Nothing was paid through this request
 * unless its sealed notice already said so.
 */
export interface PayCancelRelay extends PayCancelMessage {
  from: string;
}
/** To the sender of a pay_* message the server refused to relay. */
export interface PayErrorMessage {
  type: "pay_error";
  requestId: string;
  reason: PayErrorReason;
}

/** ADR-015: a player's avatar changed (`set_avatar`, or the default again after "Forget this wallet"). To every joined client, including that player. */
export interface AvatarUpdatedMessage {
  type: "avatar_updated";
  playerId: string;
  avatar: PlayerAvatar;
}

/** ADR-015: a player's wallet-holder flag changed (`set_wallet`). To every joined client, including that player. */
export interface CanReceiveUpdatedMessage {
  type: "can_receive_updated";
  playerId: string;
  canReceive: boolean;
}

/**
 * ADR-015: the answer to `nickname_check`, to the asking connection only. `nickname` echoes the
 * request so the client can match it to what is in its input now. `suggestion` (for `taken`) is
 * the name the server would give right now (e.g. "Nadia-2") — nothing is reserved.
 */
export interface NicknameCheckResultMessage {
  type: "nickname_check_result";
  nickname: string;
  status: NicknameCheckStatus;
  suggestion?: string;
}

/**
 * ADR-016: the answer to `name_reserve`, to the asking session only. The wallet pays `amountZat` to `address` with
 * `memo` (shielded); the address is used by the wallet and never displayed. `expiresAt` is server time (ms since
 * epoch). Asking again for the same name with the same key returns the same reservation (never pay it twice).
 */
export interface NameQuoteMessage {
  type: "name_quote";
  reservationId: string;
  nickname: string;
  address: string;
  amountZat: number;
  memo: string;
  expiresAt: number;
}

/**
 * ADR-016: the state of a name request, to the asking session only. `reservationId` is present for reservation
 * progress (`pending`/`seen`/`confirmed`/`expired`); `nickname` echoes the request (or, on `confirmed`, the owned
 * display name).
 */
export interface NameStatusMessage {
  type: "name_status";
  status: NameStatus;
  reservationId?: string;
  nickname?: string;
}

/** ADR-016: a fresh, single-use nonce for `name_claim_proof` (bound to this session, valid NAME_CHALLENGE_TTL_MS). */
export interface NameChallengeMessage {
  type: "name_challenge";
  nonce: string;
  nickname: string;
}


// ---------------------------------------------------------------------------
// Watch Hall (ADR-014) — server -> client (members only,
// except hall_error, which goes to the sender). PlayerIds, never nicknames:
// clients resolve names from presence, so hall state can't go stale after a
// rename.
// ---------------------------------------------------------------------------

export interface HallStageState {
  holder: string | null;
  status: HallStageStatus;
  /** Server time (ms since epoch) of the last status change. */
  since: number;
  queue: string[];
  card: HallCard | null;
  locked: boolean;
  /** The holder reported tab audio in its share. */
  audio: boolean;
}

/**
 * Which reaction session the totals belong to. A session is one stage turn: it starts when a player
 * becomes holder (the totals reset to zero) and ends with the turn (the totals stay, shown as "Last session", until
 * the next turn starts). `id` counts turns since the server started; 0 means no turn yet (the totals are empty).
 */
export interface HallReactionSession {
  id: number;
  /** The turn is still on the stage (false: the totals are the last session's). */
  active: boolean;
}
/** A per-session reaction total stops counting at this value. */
export const HALL_REACTION_TOTAL_MAX = 999_999;

/** Full hall state, sent when a session enters the hall and after a host auth. */
export interface HallStateMessage {
  type: "hall_state";
  stage: HallStageState;
  /** Occupied seats only, as [seatId, playerId]. */
  seats: [number, string][];
  /** Raised hands in raise order. */
  hands: string[];
  floor: string | null;
  hosts: string[];
  /** Whether the recipient itself is a host. */
  host: boolean;
  /** The reaction totals of the current (or last) session — the same numbers for every member. */
  totals: Partial<Record<HallReaction, number>>;
  session: HallReactionSession;
  /** The audience vote on the current share, as the recipient sees it. */
  vote: HallVoteState;
}
/**
 * The audience vote to end the live share. `needed` is 0 while voting is closed (nothing live, or the
 * stage is locked). `voted` is whether the recipient's own vote is counted; nobody learns who else voted.
 */
export interface HallVoteState {
  votes: number;
  needed: number;
  voted: boolean;
}
/** The vote count or the bar changed (members only; `voted` differs per recipient). */
export interface HallVoteBroadcast extends HallVoteState {
  type: "hall_vote";
}
/** The recipient left the hall: drop all hall state. */
export interface HallExitMessage {
  type: "hall_exit";
}
export interface HallStageBroadcast {
  type: "hall_stage";
  stage: HallStageState;
}
export interface HallSeatBroadcast {
  type: "hall_seat";
  seatId: number;
  playerId: string | null;
}
export interface HallHandsBroadcast {
  type: "hall_hands";
  hands: string[];
}
export interface HallFloorBroadcast {
  type: "hall_floor";
  playerId: string | null;
}
export interface HallHostsBroadcast {
  type: "hall_hosts";
  hosts: string[];
}
export const HALL_REACTION_SAMPLE_MAX = 16;
export interface HallReactionsBroadcast {
  type: "hall_reactions";
  counts: Partial<Record<HallReaction, number>>;
  /** Who reacted with what in this flush window (at most HALL_REACTION_SAMPLE_MAX). */
  sample: { playerId: string; reaction: HallReaction }[];
  /**
   * The session's totals after this window. Authoritative: clients show them and never add batches up.
   * A session start or end also sends a hall_reactions with empty `counts` and `sample`, so every board resets together.
   */
  totals: Partial<Record<HallReaction, number>>;
  session: HallReactionSession;
}

export const HALL_ERROR_OPS = ["stage", "card", "floor", "react", "hand", "seat", "host", "lock", "vote"] as const;
export type HallErrorOp = (typeof HALL_ERROR_OPS)[number];
export const HALL_ERROR_REASONS = [
  "not_in_hall",
  "rate_limited",
  "taken",
  "queue_full",
  "not_holder",
  "not_queued",
  "not_host",
  "locked",
  "invalid",
  "host_disabled",
  "bad_key",
  "not_found",
  /** hall_floor to a member who has not raised a hand. */
  "not_raised",
  /** HALL_HANDS_MAX hands are already up, or HALL_HOSTS_MAX hosts are signed in. */
  "full",
  /**
   * Presenting, the floor and (with a name registry) voting need a server-verified identity — an owned
   * name while a name registry runs, the wallet-holder flag otherwise.
   */
  "identity_required",
  /** This player is on a stage cooldown (an audience vote or a host); `retryInMs` says for how long. */
  "cooldown",
  /** A vote while nothing is live. */
  "not_live",
] as const;
export type HallErrorReason = (typeof HALL_ERROR_REASONS)[number];
export interface HallErrorMessage {
  type: "hall_error";
  op: HallErrorOp;
  reason: HallErrorReason;
  /** With `cooldown`, how long until the stage may be requested again. */
  retryInMs?: number;
}

export type HallServerMessage =
  | HallStateMessage
  | HallExitMessage
  | HallStageBroadcast
  | HallSeatBroadcast
  | HallHandsBroadcast
  | HallFloorBroadcast
  | HallHostsBroadcast
  | HallReactionsBroadcast
  | HallVoteBroadcast
  | HallErrorMessage;

// ---------------------------------------------------------------------------
// Moderation (ADR-019) — server -> client
// ---------------------------------------------------------------------------

/** The answer to `report`, to the reporter only. `sent`: "Thanks — moderators were notified". */
export interface ReportAckMessage {
  type: "report_ack";
  status: ReportAckStatus;
}

/**
 * One report as moderators see it: who was reported, why, the note, when and where — and the reporter's nickname, so a
 * false report can be judged. `targetId` is the reported session while it is still online (null once it left).
 */
export interface ModReport {
  id: string;
  /** Server time (ms since epoch) the report arrived. */
  t: number;
  reporter: string;
  target: string;
  targetId: string | null;
  reason: ReportReason;
  note?: string;
  location: ReportLocation;
}

/** A new report, live, to every online moderator (also kept in the queue `mod_log` carries). */
export interface ModReportMessage {
  type: "mod_report";
  report: ModReport;
}

/**
 * The answer to `mod_action`, to the acting session only. `target` is the target's nickname when there was one. `until`
 * (a successful mute, kick or ban): server time it really ends — MOD_BAN_FOREVER for "until lifted" — which is earlier
 * than the chosen duration when the target has only the connection key (capped at 24 hours).
 */
export interface ModActionResultMessage {
  type: "mod_action_result";
  action: ModAction;
  ok: boolean;
  error?: ModActionError;
  target?: string;
  until?: number;
}

/** One moderation log line: who did what to whom, for how long (null: until lifted), when. Moderators only. */
export interface ModLogEntry {
  id: string;
  t: number;
  moderator: string;
  action: ModAction;
  target?: string;
  durationMs?: number | null;
}

/**
 * An active kick or ban. `byName`: the owned name (its key) is blocked; `byConnection`: the connection hash is (at
 * most 24 h). Never the hash itself, never an address.
 */
export interface ModBanEntry {
  id: string;
  nickname: string;
  kind: "kick" | "ban";
  /** Server time it ends; MOD_BAN_FOREVER: until a moderator lifts it. */
  until: number;
  byName: boolean;
  byConnection: boolean;
}

/** An active chat mute. */
export interface ModMuteEntry {
  id: string;
  nickname: string;
  until: number;
}

/**
 * The moderation state, to moderators only: on sign-in and after every change. The report queue (newest first), the
 * log (newest first) and the active bans and mutes.
 */
export interface ModLogMessage {
  type: "mod_log";
  reports: ModReport[];
  log: ModLogEntry[];
  bans: ModBanEntry[];
  mutes: ModMuteEntry[];
}

/**
 * To the target of an action, or a refused connection: `muted` / `kicked` / `banned` with `until` (server time;
 * MOD_BAN_FOREVER for "until lifted"), `unmuted`, or `too_many_connections` ("Too many connections from your network").
 * `kicked`, `banned` and `too_many_connections` are followed by a close with MOD_CLOSE_CODES. A muted session gets
 * `muted` again for every chat line, whisper or hall line it sends (none is delivered).
 */
export interface ModerationNoticeMessage {
  type: "moderation_notice";
  kind: ModerationNoticeKind;
  until?: number;
}

/** A player signed in as a moderator (presence): to every joined client, including that player. */
export interface ModeratorUpdatedMessage {
  type: "moderator_updated";
  playerId: string;
  moderator: boolean;
}

export type ModerationServerMessage =
  | ReportAckMessage
  | ModReportMessage
  | ModActionResultMessage
  | ModLogMessage
  | ModerationNoticeMessage
  | ModeratorUpdatedMessage;

export type ServerToClientMessage =
  | HallServerMessage
  | ModerationServerMessage
  | PayRequestRelay
  | PayAcceptRelay
  | PayDeclineRelay
  | PayNoticeRelay
  | PayCancelRelay
  | PayErrorMessage
  | ChatMessageBroadcast
  | ChatRejectedMessage
  | WelcomeMessage
  | PlayerSnapshotMessage
  | PlayerJoinedMessage
  | PlayerLeftMessage
  | PlayerTransformBroadcastMessage
  | NicknameUpdatedMessage
  | AvatarUpdatedMessage
  | CanReceiveUpdatedMessage
  | NicknameCheckResultMessage
  | NameQuoteMessage
  | NameStatusMessage
  | NameChallengeMessage;
