import type { ModBanEntry, ModerationServerMessage, ModLogEntry, ModMuteEntry, ModReport } from "@project/shared";

/**
 * Client-side moderation state (ADR-019), fed by NetworkClient's `onModeration`. The server decides
 * everything; this mirrors what it sent to this session:
 *
 *  - whether this session is a moderator (it signed in with a moderator key — the `mod_log` the server sends then);
 *  - for moderators: the report queue, the moderation log and the active bans and mutes, and how many reports arrived
 *    since the Moderation panel was last opened;
 *  - which players carry the Moderator tag (presence: `moderator` in a summary, `moderator_updated`);
 *  - until when this session is muted (from `moderation_notice`).
 *
 * Pure TypeScript (no DOM). Everything is dropped on disconnect (`reset`); nothing is persisted.
 */

export type ModerationStoreEvent =
  /** Moderator state, the lists, the tags or the mute changed. */
  | { readonly type: "change" }
  /** A new report arrived live (moderators only). */
  | { readonly type: "report"; readonly report: ModReport };

export type ModerationStoreListener = (event: ModerationStoreEvent) => void;

export class ModerationStore {
  private moderatorFlag = false;
  private reportList: ModReport[] = [];
  private logList: ModLogEntry[] = [];
  private banList: ModBanEntry[] = [];
  private muteList: ModMuteEntry[] = [];
  private unseen = 0;
  private readonly tagged = new Set<string>();
  private mutedUntilValue: number | null = null;
  private localId: string | null = null;
  private readonly listeners = new Set<ModerationStoreListener>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Whether this session signed in as a moderator. */
  get isModerator(): boolean {
    return this.moderatorFlag;
  }

  /** The report queue, newest first (moderators only). */
  get reports(): readonly ModReport[] {
    return this.reportList;
  }

  get log(): readonly ModLogEntry[] {
    return this.logList;
  }

  get bans(): readonly ModBanEntry[] {
    return this.banList;
  }

  get mutes(): readonly ModMuteEntry[] {
    return this.muteList;
  }

  /** Reports that arrived since the panel was last opened. */
  get unseenReports(): number {
    return this.unseen;
  }

  /** Until when this session is muted (server time), or null. */
  get mutedUntil(): number | null {
    if (this.mutedUntilValue !== null && this.mutedUntilValue <= this.now()) this.mutedUntilValue = null;
    return this.mutedUntilValue;
  }

  /** Whether `playerId` carries the Moderator tag. */
  isTagged(playerId: string): boolean {
    return this.tagged.has(playerId);
  }

  setLocalPlayerId(playerId: string | null): void {
    this.localId = playerId;
  }

  /** A player summary's tag (snapshot / joined). */
  setTagged(playerId: string, moderator: boolean): void {
    if (moderator === this.tagged.has(playerId)) return;
    if (moderator) this.tagged.add(playerId);
    else this.tagged.delete(playerId);
    this.emit({ type: "change" });
  }

  /** The player left: its tag goes. */
  forget(playerId: string): void {
    if (this.tagged.delete(playerId)) this.emit({ type: "change" });
  }

  /** The Moderation panel was opened: every report counts as seen. */
  markSeen(): void {
    if (this.unseen === 0) return;
    this.unseen = 0;
    this.emit({ type: "change" });
  }

  /** One moderation message from the server (acks and action results are App's to show; they change nothing here). */
  handle(message: ModerationServerMessage): void {
    switch (message.type) {
      case "mod_log": {
        // The server sends the state only to moderators — on sign-in and after every change.
        const known = new Set(this.reportList.map((report) => report.id));
        if (this.moderatorFlag) this.unseen += message.reports.filter((report) => !known.has(report.id)).length;
        else this.unseen = message.reports.length;
        this.moderatorFlag = true;
        this.reportList = [...message.reports];
        this.logList = [...message.log];
        this.banList = [...message.bans];
        this.muteList = [...message.mutes];
        this.unseen = Math.min(this.unseen, this.reportList.length);
        this.emit({ type: "change" });
        return;
      }
      case "mod_report":
        if (!this.moderatorFlag || this.reportList.some((report) => report.id === message.report.id)) return;
        this.reportList = [message.report, ...this.reportList];
        this.unseen++;
        this.emit({ type: "report", report: message.report });
        this.emit({ type: "change" });
        return;
      case "moderator_updated":
        if (message.playerId === this.localId) {
          if (message.moderator !== this.moderatorFlag && !message.moderator) this.moderatorFlag = false;
        }
        this.setTagged(message.playerId, message.moderator);
        return;
      case "moderation_notice":
        if (message.kind === "muted" && message.until !== undefined) {
          this.mutedUntilValue = message.until;
          this.emit({ type: "change" });
        } else if (message.kind === "unmuted") {
          this.mutedUntilValue = null;
          this.emit({ type: "change" });
        }
        return;
      case "report_ack":
      case "mod_action_result":
        return;
      default:
        message satisfies never;
        return;
    }
  }

  /** Disconnected: a moderator signs in again on the next session; tags and lists come back with the new state. */
  reset(): void {
    this.moderatorFlag = false;
    this.reportList = [];
    this.logList = [];
    this.banList = [];
    this.muteList = [];
    this.unseen = 0;
    this.tagged.clear();
    this.mutedUntilValue = null;
    this.emit({ type: "change" });
  }

  subscribe(listener: ModerationStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ModerationStoreEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}
