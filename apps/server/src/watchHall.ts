import { createHash, timingSafeEqual } from "node:crypto";
import {
  HALL_CARD_LINK_HOSTS,
  HALL_CARD_LINKS_MAX,
  HALL_CARD_NAME_MAX,
  HALL_CARD_TITLE_MAX,
  HALL_CARD_URL_MAX,
  HALL_EVENT_ID_PATTERN,
  HALL_HANDS_MAX,
  HALL_HOST_KEY_MAX,
  HALL_HOSTS_MAX,
  HALL_LINK_KINDS,
  HALL_REACTION_FLUSH_MS,
  HALL_REACTION_SAMPLE_MAX,
  HALL_REACTION_TOTAL_MAX,
  HALL_SEAT_SETTLE_MS,
  HALL_STAGE_COOLDOWN_MAX_MS,
  HALL_STAGE_LEAVE_GRACE_MS,
  HALL_STAGE_PREPARE_TIMEOUT_MS,
  HALL_STAGE_QUEUE_MAX,
  HALL_STAGE_VOTE_COOLDOWN_MS,
  HALL_VIDEO_ID_PATTERN,
  HALL_VOTE_FRACTION,
  HALL_VOTE_MIN,
  WATCH_HALL_EXIT_MARGIN_METERS,
  WATCH_HALL_HALF_EXTENTS,
  WATCH_HALL_ORIGIN,
  WATCH_HALL_SEAT_COUNT,
  type AnimationState,
  type HallCard,
  type HallCardLink,
  type HallClientMessage,
  type HallErrorOp,
  type HallErrorReason,
  type HallReaction,
  type HallReactionsBroadcast,
  type HallReactionSession,
  type HallServerMessage,
  type HallStageState,
  type HallStageStatus,
  type HallStateMessage,
  type HallVoteState,
} from "@project/shared";
import { sanitizeChatText } from "./chat.js";
import { TokenBucket } from "./tokenBucket.js";

/**
 * Watch Hall rules (ADR-014, docs/architecture/WATCH_HALL.md).
 *
 * A pure class with an injected clock, like PaymentRelay: no sockets and
 * no timers. Every call returns the messages to deliver as `HallEffect`s
 * (recipients already resolved), and `nextDeadline()` / `tick()` let the
 * owner (WorldServer) run the prepare timeout, the leave grace, the
 * optional max turn and the reaction flush with one lazy timer.
 *
 * Membership is derived from each session's last pose, with hysteresis
 * (enter at the interior box, leave only WATCH_HALL_EXIT_MARGIN_METERS
 * beyond it). It is a social scope, not access control: positions are
 * client-authoritative (ADR-005).
 *
 * Privacy: everything here is in memory, keyed by session playerId,
 * never logged or persisted, and dropped by `forget()` on disconnect. The
 * host key is kept only as a SHA-256 digest and never echoed.
 *
 * Stage moderation: who may present, take the floor and vote is decided by the
 * owner (`mayPresent` / `mayVote` — an owned name while a name registry
 * runs, the wallet-holder flag otherwise), never by anything a client says
 * here. An audience vote can end a live share; a stage cooldown (after a
 * vote, or set by a host) is keyed by `identityOf` (the owned name, so a
 * reconnect does not escape it) and is the one thing kept after a
 * disconnect — in memory, until it runs out. Who voted is never sent.
 */

export const HALL_REACT_BURST = 8;
export const HALL_REACT_REFILL_PER_SECOND = 3;
export const HALL_HAND_BURST = 3;
export const HALL_HAND_REFILL_PER_SECOND = 0.2;
/** A WATCH_HALL_HOST_KEY shorter than this disables host features (fail closed). */
export const HALL_HOST_KEY_MIN_LENGTH = 24;
/** A WATCH_HALL_HOST_KEY with fewer distinct characters than this is too weak and disables host features. */
export const HALL_HOST_KEY_MIN_DISTINCT = 10;
/**
 * Host sign-in attempts per session, counted on every call (a refused one too). There is no
 * process-wide budget on purpose: anyone can open sessions, so a shared bucket could be kept
 * empty by a griefer and lock every real host out. Key strength
 * (≥ 24 characters, ≥ 10 distinct; `openssl rand -base64 32` recommended) carries the
 * brute-force bound, and the per-connection message limit slows guessing further.
 */
export const HALL_HOST_ATTEMPTS_PER_SESSION = 5;
/** Per-session budget for the hall operations that make the server broadcast to every member (stage, card, lock, floor, lower hands, seat claims). */
export const HALL_OP_BURST = 8;
export const HALL_OP_REFILL_PER_SECOND = 2;
/** Per-session budget for casting or taking back a vote to end the share (each change is broadcast to every member). */
export const HALL_VOTE_BURST = 3;
export const HALL_VOTE_REFILL_PER_SECOND = 0.1;
/**
 * WATCH_HALL_MAX_TURN_MS unset: a turn ends after an hour while the stage is unlocked, others are queued and no host is
 * in the hall. 0 turns the cap off.
 */
export const HALL_DEFAULT_MAX_TURN_MS = 60 * 60_000;
/** At most this many stage cooldowns are remembered; expired ones go first, then the ones ending soonest. */
export const HALL_COOLDOWNS_MAX = 4096;

/** Votes that end a live share when `otherMembers` hall members besides the holder are present. */
export function hallVotesNeeded(otherMembers: number): number {
  return Math.max(HALL_VOTE_MIN, Math.ceil(HALL_VOTE_FRACTION * Math.max(0, otherMembers)));
}

/** Why a WATCH_HALL_HOST_KEY disables host features (fail closed), or null when it is usable. Never includes the key. */
export function hallHostKeyProblem(key: string | undefined): string | null {
  if (key === undefined || key.length === 0) return "WATCH_HALL_HOST_KEY unset";
  if (key.length < HALL_HOST_KEY_MIN_LENGTH) return `WATCH_HALL_HOST_KEY shorter than ${HALL_HOST_KEY_MIN_LENGTH} characters`;
  if (key.length > HALL_HOST_KEY_MAX) return `WATCH_HALL_HOST_KEY longer than ${HALL_HOST_KEY_MAX} characters (the sign-in field and the protocol cap it there)`;
  if (new Set(key).size < HALL_HOST_KEY_MIN_DISTINCT) return `WATCH_HALL_HOST_KEY has fewer than ${HALL_HOST_KEY_MIN_DISTINCT} distinct characters`;
  return null;
}

/** Interior box around WATCH_HALL_ORIGIN, grown by `margin` metres (the server's copy of the shared predicate, ADR-006). */
export function insideWatchHall(x: number, z: number, margin = 0): boolean {
  return Math.abs(x - WATCH_HALL_ORIGIN.x) <= WATCH_HALL_HALF_EXTENTS.x + margin && Math.abs(z - WATCH_HALL_ORIGIN.z) <= WATCH_HALL_HALF_EXTENTS.z + margin;
}

/** One message and who gets it (session playerIds; members for a broadcast, the sender for hall_state / hall_exit / hall_error). */
export interface HallEffect {
  readonly to: readonly string[];
  readonly message: HallServerMessage;
}

export interface WatchHallOptions {
  /** WATCH_HALL_HOST_KEY. Unset or weak (see hallHostKeyProblem) disables host features. Only its digest is kept. */
  hostKey?: string;
  /**
   * WATCH_HALL_MAX_TURN_MS: ends a turn after this long while the stage is unlocked, others are queued and no host is
   * in the hall. Unset: HALL_DEFAULT_MAX_TURN_MS. 0 (or anything not a positive number): no cap.
   */
  maxTurnMs?: number;
  /**
   * Server-verified permission to present: request the stage, be granted it and take the floor.
   * WorldServer: an owned name while a name registry runs, the wallet-holder flag otherwise. Default: everyone.
   */
  mayPresent?: (playerId: string) => boolean;
  /** Whose vote to end a share counts. WorldServer: owned names while a name registry runs, every member otherwise. Default: everyone. */
  mayVote?: (playerId: string) => boolean;
  /** A key that survives a reconnect where possible (the owned name), for stage cooldowns. Default: the playerId. */
  identityOf?: (playerId: string) => string;
  /**
   * ADR-019 § 6: a turn was taken from its holder — a host's (or moderator's) stop or grant to someone
   * else, an audience vote, or a cooldown. WorldServer revokes the holder's LiveKit publish permission. A turn the holder
   * ends itself (Stop, the share ending, a handover, leaving, disconnecting) and the timeouts don't call it.
   */
  revokePublisher?: (playerId: string) => void;
}

/** A refused request: the op, the reason and (for a cooldown) how long is left. */
type HallRefusal = readonly [HallErrorOp, HallErrorReason, number?];

export interface HallPose {
  x: number;
  z: number;
  animationState: AnimationState;
}

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/**
 * Validates a client-supplied link: `https://` on exactly one of HALL_CARD_LINK_HOSTS, no
 * credentials, no port, at most HALL_CARD_URL_MAX characters. Returns the normalised URL or null.
 */
export function cleanHallCardUrl(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (raw.length > HALL_CARD_URL_MAX || /[\s\u0000-\u001f\u007f-\u009f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return null;
  if (!(HALL_CARD_LINK_HOSTS as readonly string[]).includes(url.hostname)) return null;
  return url.href.length <= HALL_CARD_URL_MAX ? url.href : null;
}

/**
 * The speaker / project card's content rules (the parser in protocol.ts only checks shape):
 * text goes through the chat sanitizer with the card's own limits (an empty optional field is
 * dropped), links through cleanHallCardUrl, ids through their patterns. Any violation rejects
 * the whole card. Returns a fresh object holding only known fields.
 */
export function validateHallCard(raw: HallCard): HallCard | null {
  const title = sanitizeChatText(raw.title, HALL_CARD_TITLE_MAX);
  if (title === null || title === "too_long") return null;
  const card: HallCard = { title };
  for (const field of ["speaker", "project"] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    const clean = sanitizeChatText(value, HALL_CARD_NAME_MAX);
    if (clean === "too_long") return null;
    if (clean !== null) card[field] = clean;
  }
  if (raw.links !== undefined) {
    if (raw.links.length > HALL_CARD_LINKS_MAX) return null;
    const links: HallCardLink[] = [];
    for (const link of raw.links) {
      const url = cleanHallCardUrl(link.url);
      if (url === null || !(HALL_LINK_KINDS as readonly string[]).includes(link.kind)) return null;
      links.push({ kind: link.kind, url });
    }
    if (links.length > 0) card.links = links;
  }
  if (raw.eventId !== undefined) {
    if (!HALL_EVENT_ID_PATTERN.test(raw.eventId)) return null;
    card.eventId = raw.eventId;
  }
  if (raw.videoId !== undefined) {
    if (!HALL_VIDEO_ID_PATTERN.test(raw.videoId)) return null;
    card.videoId = raw.videoId;
  }
  return card;
}

export class WatchHall {
  private readonly now: () => number;
  private readonly hostKeyDigest: Buffer | null;
  private readonly maxTurnMs: number | null;
  private readonly mayPresent: (playerId: string) => boolean;
  private readonly mayVote: (playerId: string) => boolean;
  private readonly identityOf: (playerId: string) => string;
  private readonly revokePublisher: (playerId: string) => void;

  private readonly members = new Set<string>();
  /** Sessions holding the host role (kept while they step outside; host powers need membership). */
  private readonly hosts = new Set<string>();
  /**
   * ADR-019 § 1: moderator sessions, which have every host power without the host key (and don't count
   * toward HALL_HOSTS_MAX). Session-only, like the host role.
   */
  private readonly moderators = new Set<string>();
  private readonly hostAttempts = new Map<string, number>();
  private readonly opBuckets = new Map<string, TokenBucket>();
  private readonly reactBuckets = new Map<string, TokenBucket>();
  private readonly handBuckets = new Map<string, TokenBucket>();
  private readonly voteBuckets = new Map<string, TokenBucket>();
  /** Members whose vote to end the current share counts (reset every turn; never sent to anyone). */
  private readonly votes = new Set<string>();
  /** The vote count and bar members were last told (a change in either is broadcast). */
  private lastVote = { votes: 0, needed: 0 };
  /** Stage cooldowns: identityOf(playerId) → when it ends. Kept after a disconnect, until it runs out. */
  private readonly cooldowns = new Map<string, number>();

  // Stage.
  private holder: string | null = null;
  private status: HallStageStatus = "idle";
  private since: number;
  private turnStartedAt = 0;
  /** When the holder walked out of the hall (the leave grace runs from here), or null. */
  private holderLeftAt: number | null = null;
  private readonly queue: string[] = [];
  private card: HallCard | null = null;
  private locked = false;
  private audio = false;

  private readonly seatOccupant = new Map<number, string>();
  private readonly seatByPlayer = new Map<string, { seatId: number; claimedAt: number }>();
  /** Raised hands in raise order. */
  private readonly hands: string[] = [];
  private floor: string | null = null;

  private pendingCounts: Partial<Record<HallReaction, number>> = {};
  private pendingSample: { playerId: string; reaction: HallReaction }[] = [];
  private flushAt: number | null = null;
  private lastFlushAt = Number.NEGATIVE_INFINITY;
  /**
   * Reaction totals per session. A session is one stage turn (it starts in grant(), ends in clearTurn());
   * reactions count only while one is active, and the last session's totals stay until the next turn starts.
   */
  private sessionTotals: Partial<Record<HallReaction, number>> = {};
  private sessionId = 0;
  private sessionActive = false;

  // Per-call batch: what changed, turned into effects by finish().
  private seatDeltas: [number, string | null][] = [];
  private dirty = { stage: false, hands: false, floor: false, hosts: false, session: false, vote: false };
  /** Members who get a full hall_state at the end of this call (and so skip its deltas). */
  private fresh = new Set<string>();
  private direct: HallEffect[] = [];
  private reactions: HallServerMessage | null = null;

  constructor(now: () => number, options: WatchHallOptions = {}) {
    this.now = now;
    this.since = now();
    this.hostKeyDigest = hallHostKeyProblem(options.hostKey) === null ? sha256(options.hostKey!) : null;
    const maxTurnMs = options.maxTurnMs ?? HALL_DEFAULT_MAX_TURN_MS;
    this.maxTurnMs = Number.isFinite(maxTurnMs) && maxTurnMs > 0 ? maxTurnMs : null;
    this.mayPresent = options.mayPresent ?? (() => true);
    this.mayVote = options.mayVote ?? (() => true);
    this.identityOf = options.identityOf ?? ((playerId) => playerId);
    this.revokePublisher = options.revokePublisher ?? (() => undefined);
  }

  /** Whether WATCH_HALL_HOST_KEY is configured (never the key itself). */
  get hostEnabled(): boolean {
    return this.hostKeyDigest !== null;
  }

  get memberCount(): number {
    return this.members.size;
  }

  isMember(playerId: string): boolean {
    return this.members.has(playerId);
  }

  /** The public stage state (also the payload of hall_stage). */
  stageState(): HallStageState {
    return {
      holder: this.holder,
      status: this.status,
      since: this.since,
      queue: [...this.queue],
      card: this.card,
      locked: this.locked,
      audio: this.audio,
    };
  }

  /** Full state for one member (sent on entering the hall and after host auth). */
  stateFor(playerId: string): HallStateMessage {
    return {
      type: "hall_state",
      stage: this.stageState(),
      seats: [...this.seatOccupant].sort((a, b) => a[0] - b[0]),
      hands: [...this.hands],
      floor: this.floor,
      hosts: this.presentHosts(),
      host: this.isHost(playerId),
      totals: { ...this.sessionTotals },
      session: this.reactionSession(),
      vote: this.voteStateFor(playerId),
    };
  }

  /** The current (or last) reaction session's marker. */
  reactionSession(): HallReactionSession {
    return { id: this.sessionId, active: this.sessionActive };
  }

  /** The audience vote as `playerId` sees it (only its own vote, never anyone else's). */
  voteStateFor(playerId: string): HallVoteState {
    return { votes: this.votes.size, needed: this.voteNeeded(), voted: this.votes.has(playerId) };
  }

  /** How long `playerId` must still wait before requesting the stage (0: no cooldown). */
  cooldownLeft(playerId: string): number {
    const key = this.identityOf(playerId);
    const until = this.cooldowns.get(key);
    if (until === undefined) return 0;
    const left = until - this.now();
    if (left > 0) return left;
    this.cooldowns.delete(key);
    return 0;
  }

  /**
   * WorldServer: what `playerId` may do changed (a wallet forgotten, an owned name taken over by the owner's newer
   * session, or a name confirmed). Whatever it may no longer hold goes: its queue place, its turn, the floor and its
   * vote — with the usual deltas to the members.
   */
  identityChanged(playerId: string): HallEffect[] {
    this.begin();
    if (!this.mayPresent(playerId)) {
      const index = this.queue.indexOf(playerId);
      if (index >= 0) {
        this.queue.splice(index, 1);
        this.dirty.stage = true;
      }
      if (this.floor === playerId) {
        this.floor = null;
        this.dirty.floor = true;
      }
      if (this.holder === playerId) this.endTurn();
    }
    if (!this.mayVote(playerId) && this.votes.delete(playerId)) this.dirty.vote = true;
    return this.finish();
  }

  /**
   * `playerId` signed in as a moderator (true) — every host power, anywhere in the hall — or stopped
   * being one. Members see the host list change; the moderator, if in the hall, gets a full state (host: true).
   */
  setModerator(playerId: string, moderator: boolean): HallEffect[] {
    this.begin();
    if (moderator === this.moderators.has(playerId)) return this.finish();
    if (moderator) this.moderators.add(playerId);
    else this.moderators.delete(playerId);
    if (this.members.has(playerId)) {
      this.dirty.hosts = true;
      this.fresh.add(playerId);
    }
    if (!moderator && this.locked && !this.anyHostConnected()) {
      this.locked = false;
      this.dirty.stage = true;
      this.advance();
    }
    return this.finish();
  }

  /**
   * Call after every accepted player_transform. Handles entering / leaving the hall (hall_state /
   * hall_exit plus the deltas a departure causes) and the walk/jog seat auto-release.
   */
  updatePose(playerId: string, pose: HallPose): HallEffect[] {
    this.begin();
    const wasMember = this.members.has(playerId);
    const inside = insideWatchHall(pose.x, pose.z, wasMember ? WATCH_HALL_EXIT_MARGIN_METERS : 0);
    if (inside && !wasMember) this.enter(playerId);
    else if (!inside && wasMember) this.leave(playerId);
    if (inside && (pose.animationState === "walk" || pose.animationState === "jog")) {
      const seat = this.seatByPlayer.get(playerId);
      if (seat && this.now() - seat.claimedAt > HALL_SEAT_SETTLE_MS) this.releaseSeat(playerId);
    }
    return this.finish();
  }

  /** One hall_* request from a joined session. */
  handle(playerId: string, message: HallClientMessage): HallEffect[] {
    this.begin();
    const error = this.apply(playerId, message);
    if (error) {
      this.begin(); // a refused request changes nothing
      const [op, reason, retryInMs] = error;
      return [{ to: [playerId], message: { type: "hall_error", op, reason, ...(retryInMs !== undefined ? { retryInMs: Math.ceil(retryInMs) } : {}) } }];
    }
    return this.finish();
  }

  /**
   * A session disconnected: drop everything about it. A holder's turn ends at once (a reconnect is
   * a new session). The host role is session-only (ADR-014 § 6), so a lock never outlives the last
   * connected host session: it is released and the queue advances.
   */
  forget(playerId: string): HallEffect[] {
    this.begin();
    if (this.members.delete(playerId)) this.dropMemberState(playerId);
    this.hosts.delete(playerId);
    this.moderators.delete(playerId);
    if (this.locked && !this.anyHostConnected()) {
      this.locked = false;
      this.dirty.stage = true;
    }
    if (this.holder === playerId) this.endTurn();
    else this.advance(); // a no-op unless the stage is idle and unlocked
    this.hostAttempts.delete(playerId);
    this.opBuckets.delete(playerId);
    this.reactBuckets.delete(playerId);
    this.handBuckets.delete(playerId);
    this.voteBuckets.delete(playerId);
    return this.finish();
  }

  /** The earliest time `tick()` has work to do, or null. */
  nextDeadline(): number | null {
    let next: number | null = this.flushAt;
    const consider = (at: number): void => {
      if (next === null || at < next) next = at;
    };
    if (this.holder !== null) {
      if (this.status === "preparing") consider(this.turnStartedAt + HALL_STAGE_PREPARE_TIMEOUT_MS);
      if (this.holderLeftAt !== null) consider(this.holderLeftAt + HALL_STAGE_LEAVE_GRACE_MS);
      if (this.maxTurnApplies()) consider(this.turnStartedAt + this.maxTurnMs!);
    }
    return next;
  }

  /** Runs whatever is due: prepare timeout, leave grace, max turn, reaction flush. */
  tick(): HallEffect[] {
    this.begin();
    const now = this.now();
    if (this.holder !== null) {
      const prepareExpired = this.status === "preparing" && now >= this.turnStartedAt + HALL_STAGE_PREPARE_TIMEOUT_MS;
      const graceExpired = this.holderLeftAt !== null && now >= this.holderLeftAt + HALL_STAGE_LEAVE_GRACE_MS;
      const turnTooLong = this.maxTurnApplies() && now >= this.turnStartedAt + this.maxTurnMs!;
      if (prepareExpired || graceExpired || turnTooLong) this.endTurn();
    }
    if (this.flushAt !== null && now >= this.flushAt) {
      this.reactions = this.reactionsMessage(this.pendingCounts, this.pendingSample);
      this.pendingCounts = {};
      this.pendingSample = [];
      this.flushAt = null;
      this.lastFlushAt = now;
    }
    return this.finish();
  }

  // ------------------------------------------------------------------

  /** Applies one request; returns [op, reason, retryInMs?] when it is refused (before anything changed). */
  private apply(id: string, message: HallClientMessage): HallRefusal | null {
    const member = this.members.has(id);
    const holderOrHost = this.holder === id || this.isPresentHost(id);
    switch (message.type) {
      case "hall_stage_request": {
        if (!member) return ["stage", "not_in_hall"];
        if (this.holder === id || this.queue.includes(id)) return null; // idempotent
        // Presenting needs a server-verified identity, and a cooldown keeps a voted-off (or host-benched)
        // presenter off the stage — checked before anything is spent.
        if (!this.mayPresent(id)) return ["stage", "identity_required"];
        const wait = this.cooldownLeft(id);
        if (wait > 0) return ["stage", "cooldown", wait];
        if (this.queue.length >= HALL_STAGE_QUEUE_MAX) return ["stage", "queue_full"];
        if (!this.opAllowed(id)) return ["stage", "rate_limited"];
        this.queue.push(id);
        this.dirty.stage = true;
        this.advance();
        return null;
      }
      case "hall_stage_cancel": {
        const index = this.queue.indexOf(id);
        if (index < 0) return ["stage", "not_queued"];
        this.queue.splice(index, 1);
        this.dirty.stage = true;
        return null;
      }
      case "hall_stage_stop":
        // The holder may stop from outside the hall (during the leave grace); a host only from inside.
        if (this.holder === null || !holderOrHost) return ["stage", "not_holder"];
        // ADR-019 § 6: a host's (or moderator's) stop takes the turn — its publisher loses the publish permission.
        if (this.holder !== id) this.revokePublisher(this.holder);
        this.endTurn();
        return null;
      case "hall_stage_handover": {
        if (!holderOrHost) return ["stage", "not_holder"];
        const index = this.queue.indexOf(message.to);
        // Queuing is the consent. A host inside the hall may also grant a member whose hand is up
        // (raising a hand is the consent), so a queue full of squatters can't keep a presenter off
        // the stage: lock, then hand over to the raised hand.
        const toRaisedHand = index < 0 && this.isPresentHost(id) && message.to !== this.holder && this.hands.includes(message.to);
        if (index < 0 && !toRaisedHand) return ["stage", "not_queued"];
        // Only a verified identity is ever granted the stage. A host may override a cooldown (a
        // deliberate choice by a trusted role); the holder may not pass the turn to a benched player.
        if (!this.mayPresent(message.to)) return ["stage", "identity_required"];
        if (!this.isPresentHost(id) && this.cooldownLeft(message.to) > 0) return ["stage", "cooldown"];
        if (!this.opAllowed(id)) return ["stage", "rate_limited"];
        if (index >= 0) this.queue.splice(index, 1);
        if (this.holder !== null) {
          // ADR-019 § 6: a host granting the stage to someone else takes the current holder's turn (a stop).
          if (this.holder !== id) this.revokePublisher(this.holder);
          this.clearTurn();
        }
        this.grant(message.to); // also while locked: that is how a host grants a locked stage
        return null;
      }
      case "hall_stage_live":
        if (this.holder !== id) return ["stage", "not_holder"];
        if (message.live) {
          if (this.status === "live" && this.audio === message.audio) return null; // nothing changed
          // live:false (ending the turn) is never limited; a live:true that changes something is.
          if (!this.opAllowed(id)) return ["stage", "rate_limited"];
          if (this.status === "preparing") {
            this.status = "live";
            this.since = this.now();
            this.audio = message.audio;
            this.dirty.stage = true;
          } else if (this.audio !== message.audio) {
            this.audio = message.audio;
            this.dirty.stage = true;
          }
        } else if (this.status === "live") {
          this.endTurn();
        }
        // live:false while preparing (the picker was cancelled) changes nothing; the prepare timeout still runs.
        return null;
      case "hall_stage_card": {
        if (!member) return ["card", "not_in_hall"];
        if (!holderOrHost) return ["card", "not_holder"];
        if (message.card === null) {
          if (this.card === null) return null;
          if (!this.opAllowed(id)) return ["card", "rate_limited"];
          this.card = null;
          this.dirty.stage = true;
          return null;
        }
        const card = validateHallCard(message.card);
        if (!card) return ["card", "invalid"];
        if (this.card !== null && JSON.stringify(this.card) === JSON.stringify(card)) return null; // a resend costs nothing
        if (!this.opAllowed(id)) return ["card", "rate_limited"];
        this.card = card;
        this.dirty.stage = true;
        return null;
      }
      case "hall_stage_lock":
        if (!member) return ["lock", "not_in_hall"];
        if (!this.isHost(id)) return ["lock", "not_host"];
        if (this.locked !== message.locked) {
          if (!this.opAllowed(id)) return ["lock", "rate_limited"];
          this.locked = message.locked;
          this.dirty.stage = true;
          // A lock is the host's call — it closes the audience vote and drops the votes cast so far.
          if (this.locked) this.clearVotes();
          this.advance();
        }
        return null;
      case "hall_floor":
        if (!member) return ["floor", "not_in_hall"];
        if (message.playerId === null && this.floor === id) {
          // The member who has the floor may always give it up.
          this.floor = null;
          this.dirty.floor = true;
          return null;
        }
        if (!holderOrHost) return ["floor", "not_holder"];
        if (message.playerId === this.floor) return null; // unchanged
        if (message.playerId !== null) {
          if (!this.members.has(message.playerId)) return ["floor", "not_found"];
          // Consent: the floor makes a microphone hall-wide, so it goes only to a member who raised
          // a hand (or to the sender itself) — like queuing is the consent for a handover.
          if (message.playerId !== id && !this.hands.includes(message.playerId)) return ["floor", "not_raised"];
          // A hall-wide microphone needs the same verified identity as the stage.
          if (!this.mayPresent(message.playerId)) return ["floor", "identity_required"];
        }
        if (!this.opAllowed(id)) return ["floor", "rate_limited"];
        this.floor = message.playerId;
        this.dirty.floor = true;
        if (message.playerId !== null) this.lowerHand(message.playerId);
        return null;
      case "hall_react":
        if (!member) return ["react", "not_in_hall"];
        if (!this.bucket(this.reactBuckets, id, HALL_REACT_BURST, HALL_REACT_REFILL_PER_SECOND).take()) return ["react", "rate_limited"];
        this.pendingCounts[message.reaction] = (this.pendingCounts[message.reaction] ?? 0) + 1;
        if (this.pendingSample.length < HALL_REACTION_SAMPLE_MAX) this.pendingSample.push({ playerId: id, reaction: message.reaction });
        // Only a running session counts; an idle stage keeps the last session's totals as they were.
        if (this.sessionActive) this.sessionTotals[message.reaction] = Math.min(HALL_REACTION_TOTAL_MAX, (this.sessionTotals[message.reaction] ?? 0) + 1);
        if (this.flushAt === null) this.flushAt = Math.max(this.now(), this.lastFlushAt + HALL_REACTION_FLUSH_MS);
        return null;
      case "hall_hand":
        if (!member) return ["hand", "not_in_hall"];
        if (!this.bucket(this.handBuckets, id, HALL_HAND_BURST, HALL_HAND_REFILL_PER_SECOND).take()) return ["hand", "rate_limited"];
        if (!message.raised) this.lowerHand(id);
        else if (!this.hands.includes(id)) {
          if (this.hands.length >= HALL_HANDS_MAX) return ["hand", "full"];
          this.hands.push(id);
          this.dirty.hands = true;
        }
        return null;
      case "hall_hand_lower":
        if (!member) return ["hand", "not_in_hall"];
        if (!holderOrHost) return ["hand", "not_holder"];
        if (message.playerId === "*" ? this.hands.length === 0 : !this.hands.includes(message.playerId)) return null; // nothing to lower
        if (!this.opAllowed(id)) return ["hand", "rate_limited"];
        if (message.playerId !== "*") this.lowerHand(message.playerId);
        else {
          this.hands.length = 0;
          this.dirty.hands = true;
        }
        return null;
      case "hall_seat_claim": {
        if (!member) return ["seat", "not_in_hall"];
        if (!Number.isInteger(message.seatId) || message.seatId < 0 || message.seatId >= WATCH_HALL_SEAT_COUNT) return ["seat", "invalid"];
        const occupant = this.seatOccupant.get(message.seatId);
        if (occupant === id) {
          this.seatByPlayer.get(id)!.claimedAt = this.now(); // a repeated claim restarts the settle window
          return null;
        }
        if (occupant !== undefined) return ["seat", "taken"];
        if (!this.opAllowed(id)) return ["seat", "rate_limited"];
        this.releaseSeat(id); // a new claim frees the old seat
        this.seatOccupant.set(message.seatId, id);
        this.seatByPlayer.set(id, { seatId: message.seatId, claimedAt: this.now() });
        this.seatDeltas.push([message.seatId, id]);
        return null;
      }
      case "hall_seat_release":
        this.releaseSeat(id);
        return null;
      case "hall_host_auth": {
        if (!this.hostKeyDigest) return ["host", "host_disabled"];
        if (!member) return ["host", "not_in_hall"];
        if (this.isHost(id)) {
          this.fresh.add(id); // already a host: just resend the state
          return null;
        }
        // Every attempt counts against this session's budget, a refused one too. No process-wide
        // bucket: one could be drained by anyone and lock the real hosts out (see the constant).
        const attempts = this.hostAttempts.get(id) ?? 0;
        this.hostAttempts.set(id, attempts + 1);
        if (attempts >= HALL_HOST_ATTEMPTS_PER_SESSION) return ["host", "rate_limited"];
        // Constant-time comparison of fixed-length digests; the key itself is never stored, logged or echoed.
        if (!timingSafeEqual(sha256(message.key), this.hostKeyDigest)) return ["host", "bad_key"];
        if (this.hosts.size >= HALL_HOSTS_MAX) return ["host", "full"];
        this.hosts.add(id);
        this.dirty.hosts = true;
        this.fresh.add(id);
        return null;
      }
      case "hall_stage_vote": {
        // Audience vote. The count (never who) goes to members; finish() ends the turn at the bar.
        if (!member) return ["vote", "not_in_hall"];
        if (message.end) {
          if (this.holder === null || this.status !== "live") return ["vote", "not_live"];
          if (this.locked) return ["vote", "locked"];
          if (this.holder === id) return ["vote", "invalid"];
          if (!this.mayVote(id)) return ["vote", "identity_required"];
          if (this.votes.has(id)) return null; // unchanged
        } else if (!this.votes.has(id)) {
          return null; // nothing to take back
        }
        if (!this.bucket(this.voteBuckets, id, HALL_VOTE_BURST, HALL_VOTE_REFILL_PER_SECOND).take()) return ["vote", "rate_limited"];
        if (message.end) this.votes.add(id);
        else this.votes.delete(id);
        this.dirty.vote = true;
        return null;
      }
      case "hall_stage_dequeue": {
        // Host extra: take a squatter (or anyone) out of the queue.
        if (!member) return ["stage", "not_in_hall"];
        if (!this.isHost(id)) return ["stage", "not_host"];
        const index = this.queue.indexOf(message.playerId);
        if (index < 0) return ["stage", "not_queued"];
        if (!this.opAllowed(id)) return ["stage", "rate_limited"];
        this.queue.splice(index, 1);
        this.dirty.stage = true;
        return null;
      }
      case "hall_stage_cooldown": {
        // Host extra: bench a player for a while (0 lifts it). A cooldown also ends their turn and drops
        // their queue place; it follows their owned name across reconnects while a registry runs.
        if (!member) return ["stage", "not_in_hall"];
        if (!this.isHost(id)) return ["stage", "not_host"];
        const target = message.playerId;
        if (!Number.isInteger(message.ms) || message.ms < 0 || message.ms > HALL_STAGE_COOLDOWN_MAX_MS) return ["stage", "invalid"];
        if (!this.members.has(target) && this.holder !== target && !this.queue.includes(target)) return ["stage", "not_found"];
        if (!this.opAllowed(id)) return ["stage", "rate_limited"];
        this.setCooldown(target, message.ms);
        if (message.ms > 0) {
          const index = this.queue.indexOf(target);
          if (index >= 0) {
            this.queue.splice(index, 1);
            this.dirty.stage = true;
          }
          if (this.holder === target) {
            this.revokePublisher(target); // ADR-019 § 6: a benched holder stops publishing
            this.endTurn();
          }
        }
        return null;
      }
      default:
        message satisfies never;
        return null;
    }
  }

  private enter(id: string): void {
    this.members.add(id);
    this.fresh.add(id);
    if (this.holder === id) this.holderLeftAt = null; // back within the leave grace
    if (this.isHost(id)) this.dirty.hosts = true;
  }

  private leave(id: string): void {
    this.members.delete(id);
    this.direct.push({ to: [id], message: { type: "hall_exit" } });
    this.dropMemberState(id);
    if (this.holder === id) this.holderLeftAt = this.now();
  }

  /** Queue place, seat, hand, floor and presence as a host — everything that needs membership. */
  private dropMemberState(id: string): void {
    const index = this.queue.indexOf(id);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.dirty.stage = true;
    }
    this.releaseSeat(id);
    this.lowerHand(id);
    if (this.floor === id) {
      this.floor = null;
      this.dirty.floor = true;
    }
    if (this.isHost(id)) this.dirty.hosts = true;
    // Only the members present vote (a departure can also lower the bar enough to end the share — see settleVote).
    if (this.votes.delete(id)) this.dirty.vote = true;
  }

  /** The current turn ends; the queue head (if unlocked) takes over. */
  private endTurn(): void {
    this.clearTurn();
    this.advance();
  }

  private clearTurn(): void {
    this.holder = null;
    this.status = "idle";
    this.since = this.now();
    this.holderLeftAt = null;
    this.card = null;
    this.audio = false;
    if (this.floor !== null) {
      this.floor = null;
      this.dirty.floor = true;
    }
    this.clearVotes(); // votes belong to one turn
    this.dirty.stage = true;
    // The reaction session ends with the turn; its totals stay as "Last session".
    if (this.sessionActive) {
      this.sessionActive = false;
      this.dirty.session = true;
    }
  }

  /** The queue head (if unlocked) takes over. A head that may no longer present, or is benched, is dropped (defensive: identityChanged and a cooldown already remove them). */
  private advance(): void {
    if (this.holder !== null || this.locked) return;
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.dirty.stage = true;
      if (!this.mayPresent(next) || this.cooldownLeft(next) > 0) continue;
      this.grant(next);
      return;
    }
  }

  private clearVotes(): void {
    if (this.votes.size === 0) return;
    this.votes.clear();
    this.dirty.vote = true;
  }

  /** The votes that end the share now, or 0 while voting is closed (nothing live, or a locked stage). */
  private voteNeeded(): number {
    if (this.holder === null || this.status !== "live" || this.locked) return 0;
    return hallVotesNeeded(this.members.size - (this.members.has(this.holder) ? 1 : 0));
  }

  /** At the bar, the share ends and its holder gets HALL_STAGE_VOTE_COOLDOWN_MS (by identity, so a reconnect doesn't escape it). */
  private settleVote(): void {
    const needed = this.voteNeeded();
    if (needed === 0 || this.votes.size < needed) return;
    this.setCooldown(this.holder!, HALL_STAGE_VOTE_COOLDOWN_MS);
    this.revokePublisher(this.holder!); // ADR-019 § 6: voted off — the share stops at the SFU too
    this.endTurn();
  }

  /** Benches `playerId`'s identity for `ms` (0 lifts it). The map stays bounded: expired entries go first, then the soonest to end. */
  private setCooldown(playerId: string, ms: number): void {
    const key = this.identityOf(playerId);
    if (ms <= 0) {
      this.cooldowns.delete(key);
      return;
    }
    this.cooldowns.set(key, this.now() + ms);
    if (this.cooldowns.size <= HALL_COOLDOWNS_MAX) return;
    const now = this.now();
    for (const [other, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(other);
    while (this.cooldowns.size > HALL_COOLDOWNS_MAX) {
      let soonest: string | null = null;
      let soonestAt = Infinity;
      for (const [other, until] of this.cooldowns) {
        if (other !== key && until < soonestAt) {
          soonest = other;
          soonestAt = until;
        }
      }
      if (soonest === null) break;
      this.cooldowns.delete(soonest);
    }
  }

  /** `id` (already removed from the queue) becomes holder, preparing. A card a host set while idle stays as "now showing". */
  private grant(id: string): void {
    const now = this.now();
    this.holder = id;
    this.status = "preparing";
    this.since = now;
    this.turnStartedAt = now;
    this.holderLeftAt = null;
    this.audio = false;
    this.lowerHand(id);
    this.dirty.stage = true;
    // Every turn is a new reaction session, counted from zero.
    this.sessionId++;
    this.sessionActive = true;
    this.sessionTotals = {};
    this.dirty.session = true;
  }

  /** A hall_reactions frame: this window's counts and sample plus the session's totals (copies, never live state). */
  private reactionsMessage(counts: Partial<Record<HallReaction, number>>, sample: { playerId: string; reaction: HallReaction }[]): HallReactionsBroadcast {
    return { type: "hall_reactions", counts, sample, totals: { ...this.sessionTotals }, session: this.reactionSession() };
  }

  /** A locked stage is host-managed (the queue can't take over), so the cap never applies to it. */
  private maxTurnApplies(): boolean {
    return this.maxTurnMs !== null && !this.locked && this.queue.length > 0 && this.presentHosts().length === 0;
  }

  private releaseSeat(id: string): void {
    const seat = this.seatByPlayer.get(id);
    if (!seat) return;
    this.seatByPlayer.delete(id);
    this.seatOccupant.delete(seat.seatId);
    this.seatDeltas.push([seat.seatId, null]);
  }

  private lowerHand(id: string): void {
    const index = this.hands.indexOf(id);
    if (index < 0) return;
    this.hands.splice(index, 1);
    this.dirty.hands = true;
  }

  /** A host by key, or a moderator (ADR-019 § 1). */
  private isHost(id: string): boolean {
    return this.hosts.has(id) || this.moderators.has(id);
  }

  /** Whether any host or moderator session is connected (the lock never outlives the last one). */
  private anyHostConnected(): boolean {
    return this.hosts.size > 0 || this.moderators.size > 0;
  }

  private isPresentHost(id: string): boolean {
    return this.isHost(id) && this.members.has(id);
  }

  private presentHosts(): string[] {
    return [...new Set([...this.hosts, ...this.moderators])].filter((id) => this.members.has(id));
  }

  /** Spends one of `id`'s broadcast-op tokens (HALL_OP_BURST, HALL_OP_REFILL_PER_SECOND). */
  private opAllowed(id: string): boolean {
    return this.bucket(this.opBuckets, id, HALL_OP_BURST, HALL_OP_REFILL_PER_SECOND).take();
  }

  private bucket(buckets: Map<string, TokenBucket>, id: string, burst: number, refillPerSecond: number): TokenBucket {
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = new TokenBucket(burst, refillPerSecond, this.now);
      buckets.set(id, bucket);
    }
    return bucket;
  }

  private begin(): void {
    this.seatDeltas = [];
    this.dirty = { stage: false, hands: false, floor: false, hosts: false, session: false, vote: false };
    this.fresh = new Set();
    this.direct = [];
    this.reactions = null;
  }

  /** Turns this call's changes into effects: deltas to members (minus those getting a full state), then the full states. */
  private finish(): HallEffect[] {
    // A vote, a departure or a lock may have reached (or moved) the bar: settle it before anything is sent.
    this.settleVote();
    const effects: HallEffect[] = [...this.direct];
    const recipients = [...this.members].filter((id) => !this.fresh.has(id));
    const broadcast = (message: HallServerMessage): void => {
      if (recipients.length > 0) effects.push({ to: recipients, message });
    };
    for (const [seatId, playerId] of this.seatDeltas) broadcast({ type: "hall_seat", seatId, playerId });
    if (this.dirty.stage) broadcast({ type: "hall_stage", stage: this.stageState() });
    if (this.dirty.hands) broadcast({ type: "hall_hands", hands: [...this.hands] });
    if (this.dirty.floor) broadcast({ type: "hall_floor", playerId: this.floor });
    if (this.dirty.hosts) broadcast({ type: "hall_hosts", hosts: this.presentHosts() });
    // A session started or ended without a flush in this call: an empty batch carries the new totals and marker,
    // so every board resets at the same moment. Pending counts keep their own flush window.
    if (!this.reactions && this.dirty.session) this.reactions = this.reactionsMessage({}, []);
    // The vote count and its bar (the bar moves with the audience size): voters and the rest get their own `voted`.
    const vote = { votes: this.votes.size, needed: this.voteNeeded() };
    if (this.dirty.vote || vote.votes !== this.lastVote.votes || vote.needed !== this.lastVote.needed) {
      this.lastVote = vote;
      const voters = recipients.filter((id) => this.votes.has(id));
      const others = recipients.filter((id) => !this.votes.has(id));
      if (voters.length > 0) effects.push({ to: voters, message: { type: "hall_vote", ...vote, voted: true } });
      if (others.length > 0) effects.push({ to: others, message: { type: "hall_vote", ...vote, voted: false } });
    }
    // Reactions go to everyone in the hall, including members who just received a full state.
    if (this.reactions && this.members.size > 0) effects.push({ to: [...this.members], message: this.reactions });
    for (const id of this.fresh) if (this.members.has(id)) effects.push({ to: [id], message: this.stateFor(id) });
    this.begin();
    return effects;
  }
}
