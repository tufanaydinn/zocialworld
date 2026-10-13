import type { HallErrorOp, HallErrorReason, HallReaction, HallReactionSession, HallServerMessage, HallStageState, HallVoteState } from "@project/shared";
import type { ConnectionState } from "../networking/NetworkClient.ts";

/**
 * Client-side Watch Hall state (docs/architecture/WATCH_HALL.md), fed by
 * NetworkClient's `onHall`. The server is authoritative: this only mirrors what it sent to this
 * session — whether it is a member, the stage, seats, raised hands, the floor and hosts — and
 * forwards reaction batches and refusals as events. The stage, seat, voice and UI systems read
 * it and subscribe to it; none of them talks to the hall messages directly.
 *
 * Pure TypeScript (no DOM, no three.js). Everything is dropped on `hall_exit` and on disconnect;
 * nothing is persisted. Player ids, never nicknames: resolve names from presence.
 */

export type HallPart = "member" | "stage" | "seats" | "hands" | "floor" | "hosts" | "vote";
const ALL_PARTS: readonly HallPart[] = ["member", "stage", "seats", "hands", "floor", "hosts", "vote"];

export interface HallReactionSample {
  readonly playerId: string;
  readonly reaction: HallReaction;
}

export type HallStoreEvent =
  /** Some of the mirrored state changed. */
  | { readonly type: "change"; readonly parts: readonly HallPart[] }
  /** One aggregated batch (at most every HALL_REACTION_FLUSH_MS). */
  | { readonly type: "reactions"; readonly counts: Readonly<Partial<Record<HallReaction, number>>>; readonly sample: readonly HallReactionSample[] }
  /** The server refused one of this client's hall requests. */
  | { readonly type: "error"; readonly op: HallErrorOp; readonly reason: HallErrorReason; readonly retryInMs?: number };

export type HallStoreListener = (event: HallStoreEvent) => void;

function idleStage(): HallStageState {
  return { holder: null, status: "idle", since: 0, queue: [], card: null, locked: false, audio: false };
}

const NO_SESSION: HallReactionSession = { id: 0, active: false };
const NO_VOTE: HallVoteState = { votes: 0, needed: 0, voted: false };

export class HallStore {
  private memberFlag = false;
  private stageState: HallStageState = idleStage();
  private readonly seatToPlayer = new Map<number, string>();
  private readonly playerToSeat = new Map<string, number>();
  private handList: string[] = [];
  private floorId: string | null = null;
  private hostList: string[] = [];
  private hostFlag = false;
  private voteState: HallVoteState = NO_VOTE;
  private localId: string | null = null;
  private totals: Readonly<Partial<Record<HallReaction, number>>> = {};
  private session: HallReactionSession = NO_SESSION;
  private readonly listeners = new Set<HallStoreListener>();

  /**
   * The server's reaction totals for the current stage turn (`reactionSession.active`) or the last one —
   * the same numbers for every member. Replaced (never summed) by each hall_state / hall_reactions.
   */
  get reactionTotals(): Readonly<Partial<Record<HallReaction, number>>> {
    return this.totals;
  }

  /** Which session the totals belong to (id 0: no stage turn yet). */
  get reactionSession(): HallReactionSession {
    return this.session;
  }

  /** Whether the server counts this session as inside the Watch Hall. */
  get member(): boolean {
    return this.memberFlag;
  }

  get stage(): Readonly<HallStageState> {
    return this.stageState;
  }

  /** Occupied seats: seatId → playerId. */
  get seats(): ReadonlyMap<number, string> {
    return this.seatToPlayer;
  }

  /** Raised hands in raise order. */
  get hands(): readonly string[] {
    return this.handList;
  }

  /** The member given a hall-wide microphone, if any. */
  get floor(): string | null {
    return this.floorId;
  }

  /** Hosts currently in the hall. */
  get hosts(): readonly string[] {
    return this.hostList;
  }

  /** Whether this session holds the host role (from hall_state). */
  get isHost(): boolean {
    return this.hostFlag;
  }

  /**
   * The audience vote to end the live share — the count, the bar (0 while voting is closed) and whether
   * this session's own vote counts. Nobody's vote but our own is ever known here.
   */
  get vote(): Readonly<HallVoteState> {
    return this.voteState;
  }

  /** This session's playerId (from welcome), for the `am…` helpers. */
  get localPlayerId(): string | null {
    return this.localId;
  }

  setLocalPlayerId(playerId: string | null): void {
    this.localId = playerId;
  }

  isHolder(playerId: string): boolean {
    return this.stageState.holder === playerId;
  }

  isFloor(playerId: string): boolean {
    return this.floorId === playerId;
  }

  /** The seat `playerId` occupies, or null. */
  seatOf(playerId: string): number | null {
    return this.playerToSeat.get(playerId) ?? null;
  }

  occupantOf(seatId: number): string | null {
    return this.seatToPlayer.get(seatId) ?? null;
  }

  isSeatFree(seatId: number): boolean {
    return !this.seatToPlayer.has(seatId);
  }

  hasHandRaised(playerId: string): boolean {
    return this.handList.includes(playerId);
  }

  /** 1-based place in the stage queue, or 0 when not queued. */
  queuePosition(playerId: string): number {
    return this.stageState.queue.indexOf(playerId) + 1;
  }

  isQueued(playerId: string): boolean {
    return this.stageState.queue.includes(playerId);
  }

  isHostPlayer(playerId: string): boolean {
    return this.hostList.includes(playerId);
  }

  /** Whether `playerId`'s microphone is heard hall-wide (the stage holder or the floor). */
  hasStageMic(playerId: string): boolean {
    return this.memberFlag && (this.stageState.holder === playerId || this.floorId === playerId);
  }

  get amHolder(): boolean {
    return this.localId !== null && this.isHolder(this.localId);
  }

  get amQueued(): boolean {
    return this.localId !== null && this.isQueued(this.localId);
  }

  get mySeat(): number | null {
    return this.localId === null ? null : this.seatOf(this.localId);
  }

  get myHandRaised(): boolean {
    return this.localId !== null && this.hasHandRaised(this.localId);
  }

  subscribe(listener: HallStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Applies one server message. Deltas that arrive while not a member are ignored (the server only sends them to members). */
  apply(message: HallServerMessage): void {
    switch (message.type) {
      case "hall_state":
        this.memberFlag = true;
        this.stageState = message.stage;
        this.seatToPlayer.clear();
        this.playerToSeat.clear();
        for (const [seatId, playerId] of message.seats) this.setSeat(seatId, playerId);
        this.handList = [...message.hands];
        this.floorId = message.floor;
        this.hostList = [...message.hosts];
        this.hostFlag = message.host;
        this.totals = { ...message.totals };
        this.session = { ...message.session };
        this.voteState = { ...message.vote };
        this.emit({ type: "change", parts: ALL_PARTS });
        return;
      case "hall_exit":
        this.reset();
        return;
      case "hall_stage":
        if (!this.memberFlag) return;
        this.stageState = message.stage;
        this.emit({ type: "change", parts: ["stage"] });
        return;
      case "hall_seat":
        if (!this.memberFlag) return;
        this.setSeat(message.seatId, message.playerId);
        this.emit({ type: "change", parts: ["seats"] });
        return;
      case "hall_hands":
        if (!this.memberFlag) return;
        this.handList = [...message.hands];
        this.emit({ type: "change", parts: ["hands"] });
        return;
      case "hall_floor":
        if (!this.memberFlag) return;
        this.floorId = message.playerId;
        this.emit({ type: "change", parts: ["floor"] });
        return;
      case "hall_hosts":
        if (!this.memberFlag) return;
        this.hostList = [...message.hosts];
        this.emit({ type: "change", parts: ["hosts"] });
        return;
      case "hall_reactions":
        if (!this.memberFlag) return;
        this.totals = { ...message.totals };
        this.session = { ...message.session };
        this.emit({ type: "reactions", counts: message.counts, sample: message.sample });
        return;
      case "hall_vote":
        if (!this.memberFlag) return;
        this.voteState = { votes: message.votes, needed: message.needed, voted: message.voted };
        this.emit({ type: "change", parts: ["vote"] });
        return;
      case "hall_error":
        this.emit({ type: "error", op: message.op, reason: message.reason, ...(message.retryInMs !== undefined ? { retryInMs: message.retryInMs } : {}) });
        return;
      default:
        message satisfies never;
        return;
    }
  }

  /** Drops all hall state (hall_exit, disconnect). Keeps the local player id; listeners hear one change if anything was set. */
  reset(): void {
    const hadState =
      this.memberFlag ||
      this.stageState.holder !== null ||
      this.stageState.queue.length > 0 ||
      this.seatToPlayer.size > 0 ||
      this.handList.length > 0 ||
      this.floorId !== null ||
      this.hostList.length > 0 ||
      this.hostFlag ||
      this.voteState.votes > 0 ||
      this.voteState.needed > 0;
    this.memberFlag = false;
    this.voteState = NO_VOTE;
    this.stageState = idleStage();
    this.seatToPlayer.clear();
    this.playerToSeat.clear();
    this.handList = [];
    this.floorId = null;
    this.hostList = [];
    this.hostFlag = false;
    this.totals = {};
    this.session = NO_SESSION;
    if (hadState) this.emit({ type: "change", parts: ALL_PARTS });
  }

  /** Keeps both seat maps consistent: one seat per player, one player per seat. */
  private setSeat(seatId: number, playerId: string | null): void {
    const previous = this.seatToPlayer.get(seatId);
    if (previous !== undefined) this.playerToSeat.delete(previous);
    if (playerId === null) {
      this.seatToPlayer.delete(seatId);
      return;
    }
    const oldSeat = this.playerToSeat.get(playerId);
    if (oldSeat !== undefined) this.seatToPlayer.delete(oldSeat);
    this.seatToPlayer.set(seatId, playerId);
    this.playerToSeat.set(playerId, seatId);
  }

  private emit(event: HallStoreEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

/**
 * Wires a HallStore to NetworkClient callbacks. App calls each returned function from the matching
 * NetworkClientEvents handler (`onHall`, `onWelcome`, `onStateChange`), so the store tracks the
 * session's playerId and is cleared whenever the connection drops (a reconnect is a new session).
 */
export function hallStoreFeed(store: HallStore): {
  onHall: (message: HallServerMessage) => void;
  onWelcome: (message: { playerId: string }) => void;
  onStateChange: (state: ConnectionState) => void;
} {
  return {
    onHall: (message) => store.apply(message),
    onWelcome: (message) => store.setLocalPlayerId(message.playerId),
    onStateChange: (state) => {
      if (state === "connected") return;
      store.reset();
      store.setLocalPlayerId(null);
    },
  };
}
