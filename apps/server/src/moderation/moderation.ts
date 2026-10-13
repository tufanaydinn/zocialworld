import {
  MOD_BAN_FOREVER,
  MOD_CONNECTION_KEY_MAX_MS,
  MOD_KICK_MS,
  MOD_LOG_MAX,
  MOD_PERSIST_MIN_MS,
  REPORT_QUEUE_MAX,
  REPORT_TTL_MS,
  REPORT_WINDOW_MS,
  REPORTS_PER_WINDOW,
  type ModAction,
  type ModBanEntry,
  type ModLogEntry,
  type ModLogMessage,
  type ModMuteEntry,
  type ModReport,
  type ReportLocation,
  type ReportReason,
} from "@project/shared";

/**
 * Moderation state (ADR-019 §§ 2–4) — a pure class with an injected clock, like WatchHall: no sockets,
 * no timers, no logging. WorldServer resolves sessions, delivers messages and closes sockets; this decides.
 *
 * What a kick, ban or mute is keyed by (§ 4):
 *  - an owned name by its name-key hash (`name`), for as long as the moderator chose;
 *  - every connection by the keyed hash of its network address (`connection`), for at most 24 hours from when the
 *    server saw it (an action taken from a report ends it 24 hours after the report) — the only key a guest or a holder
 *    without an owned name has. Both apply at once when the target has an owned name. Once the connection part of an
 *    entry ends, the hash is dropped from it while the name part runs on.
 *  - A ban's connection key covers everyone on that network: it is checked when a socket opens, before the server knows
 *    who is connecting. A mute's connection key covers only sessions without an owned name (a mute is checked on every
 *    line, when the server knows the sender's owned name), so an unrelated owned-name holder on the same network keeps
 *    chatting.
 * A ban of 24 hours or more on an owned name is handed to `persistBan` (the registry stores `bannedUntil` in that name's
 * record), so it survives a restart; everything else here is memory only and gone on restart.
 *
 * Reports (§ 2): the last REPORT_QUEUE_MAX, each until REPORT_TTL_MS or until handled; REPORTS_PER_WINDOW per reporter
 * and one per reporter–target pair per REPORT_WINDOW_MS. The moderation log (§ 3): the last MOD_LOG_MAX actions.
 * Nothing here is ever written to disk except `bannedUntil`, and nothing is logged.
 */

/** The keys an identity is known by: the owned name's key hash (if any) and the connection's address hash. */
export interface ModerationKeys {
  /** SHA-256 of the owned name's public key (ADR-016), or undefined without an owned name. */
  readonly name?: string;
  /** The keyed hash of the connection's network address (clientAddress.ts). */
  readonly connection?: string;
}

/** Who an action or report is about. */
export interface ModerationTarget {
  readonly nickname: string;
  readonly keys: ModerationKeys;
  /** The session it was taken against (to tell it about an unmute), if online. */
  readonly playerId?: string | null;
  /**
   * When the server saw `keys.connection` (a report's time, for an action taken from a report after the target left).
   * The connection key never outlives this + MOD_CONNECTION_KEY_MAX_MS. Default: now.
   */
  readonly capturedAt?: number;
}

/** Who is looking at the moderation state: a moderator never sees reports about themselves. */
export interface ModerationViewer {
  readonly playerId: string;
  /** The viewer's owned-name key hash, if any (never the connection hash: a household shares that). */
  readonly name?: string;
}

/** A lifted mute: its nickname, the session it was taken against and the keys it still covered. */
export interface LiftedMute {
  readonly nickname: string;
  readonly playerId: string | null;
  readonly name: string | null;
  readonly connection: string | null;
}

interface BanRecord {
  readonly id: string;
  readonly nickname: string;
  readonly kind: "kick" | "ban";
  readonly name: string | null;
  readonly nameUntil: number;
  readonly connection: string | null;
  readonly connectionUntil: number;
  /** Stored in names.json (a ban of 24 h or more on an owned name). */
  readonly persisted: boolean;
}

interface MuteRecord {
  readonly id: string;
  readonly nickname: string;
  readonly playerId: string | null;
  readonly name: string | null;
  /** Until when the name key is muted (0 without one). */
  readonly until: number;
  readonly connection: string | null;
  /** Until when the connection key is muted: at most `until`, and at most 24 h after the hash was seen. */
  readonly connectionUntil: number;
}

interface ReportRecord {
  readonly report: ModReport;
  readonly targetKeys: ModerationKeys;
  readonly targetModerator: boolean;
}

/** A log line and, server side only, whose report a dismissal was about (that moderator never sees it). */
interface LogRecord {
  readonly entry: ModLogEntry;
  readonly about: { readonly playerId: string | null; readonly name: string | null } | null;
}

/** A stored ban the registry handed back at start-up. */
export interface PersistedBan {
  readonly keyHash: string;
  readonly nickname: string;
  readonly until: number;
}

export interface ModerationOptions {
  readonly now: () => number;
  /** Stores (`until`) or clears (null) the ban on every owned name with this key hash. */
  readonly persistBan?: (keyHash: string, until: number | null) => void;
  /** Bans the registry stored (bannedUntil), loaded once. */
  readonly persisted?: readonly PersistedBan[];
}

export interface NewReport {
  readonly reporter: { readonly nickname: string; readonly keys: ModerationKeys };
  readonly target: { readonly nickname: string; readonly keys: ModerationKeys; readonly playerId: string; readonly moderator: boolean };
  readonly reason: ReportReason;
  readonly note: string | null;
  readonly location: ReportLocation;
}

export type ReportOutcome = { readonly ok: true; readonly report: ModReport } | { readonly ok: false; readonly status: "rate_limited" };

/** At most this many active bans and mutes each (far more than moderators set by hand); the soonest to end goes first. */
export const MODERATION_ENTRIES_MAX = 1000;

export class Moderation {
  private readonly now: () => number;
  private readonly persistBan: (keyHash: string, until: number | null) => void;
  private readonly bans = new Map<string, BanRecord>();
  private readonly mutes = new Map<string, MuteRecord>();
  /** Newest first. */
  private reports: ReportRecord[] = [];
  /** Newest first. */
  private log: LogRecord[] = [];
  /** Report times per reporter key, and the last report per reporter–target pair. */
  private readonly reportTimes = new Map<string, number[]>();
  private readonly pairTimes = new Map<string, number>();
  private counter = 0;

  constructor(options: ModerationOptions) {
    this.now = options.now;
    this.persistBan = options.persistBan ?? (() => undefined);
    const now = this.now();
    for (const ban of options.persisted ?? []) {
      if (ban.until <= now) continue;
      const id = this.nextId("b");
      this.bans.set(id, { id, nickname: ban.nickname, kind: "ban", name: ban.keyHash, nameUntil: ban.until, connection: null, connectionUntil: 0, persisted: true });
    }
  }

  // ------------------------------------------------------------------ checks

  /** The ban that keeps these keys out longest (kick or ban, and until when), or null. */
  banFor(keys: ModerationKeys): { readonly kind: "kick" | "ban"; readonly until: number } | null {
    const now = this.now();
    let found: { kind: "kick" | "ban"; until: number } | null = null;
    for (const ban of this.bans.values()) {
      const until = Math.max(keys.name !== undefined && ban.name === keys.name ? ban.nameUntil : 0, keys.connection !== undefined && ban.connection === keys.connection ? ban.connectionUntil : 0);
      if (until <= now) continue;
      if (!found || until > found.until) found = { kind: ban.kind, until };
    }
    return found;
  }

  /**
   * Until when these keys are muted, or null. A mute's name key matches the owned name; its connection key matches only
   * keys without an owned name (guests and holders without one) — see the class comment.
   */
  muteFor(keys: ModerationKeys): number | null {
    const now = this.now();
    let until: number | null = null;
    for (const mute of this.mutes.values()) {
      const end = muteEndFor(mute, keys);
      if (end <= now) continue;
      if (until === null || end > until) until = end;
    }
    return until;
  }

  /** Whether a lifted mute had covered these keys (who is told `unmuted`), by the same rule as `muteFor`. */
  static covered(mute: LiftedMute, keys: ModerationKeys): boolean {
    return (mute.name !== null && keys.name === mute.name) || (mute.connection !== null && keys.name === undefined && keys.connection === mute.connection);
  }

  // ------------------------------------------------------------------ actions

  /**
   * A kick (MOD_KICK_MS on every key) or a ban (`durationMs`, null until lifted; the connection key at most 24 h).
   * Returns the entry's id and until when the target is kept out.
   */
  ban(target: ModerationTarget, kind: "kick" | "ban", durationMs: number | null, moderator: string): { readonly id: string; readonly until: number } {
    const now = this.now();
    const length = kind === "kick" ? MOD_KICK_MS : durationMs;
    const name = target.keys.name ?? null;
    const nameUntil = name === null ? 0 : length === null ? MOD_BAN_FOREVER : now + length;
    const connectionEnd = Math.min(now + Math.min(length ?? Infinity, MOD_CONNECTION_KEY_MAX_MS), connectionKeyDeadline(target, now));
    const connection = target.keys.connection !== undefined && connectionEnd > now ? target.keys.connection : null;
    const connectionUntil = connection === null ? 0 : connectionEnd;
    const persisted = kind === "ban" && name !== null && (length === null || length >= MOD_PERSIST_MIN_MS);
    const id = this.nextId("b");
    this.bans.set(id, { id, nickname: target.nickname, kind, name, nameUntil, connection, connectionUntil, persisted });
    this.trimBans();
    if (persisted) this.persistBan(name!, this.persistedUntil(name!));
    const until = Math.max(nameUntil, connectionUntil);
    // The log says how long the target is really kept out: a guest's 7-day ban is 24 hours on its only key.
    this.record(moderator, kind, target.nickname, until >= MOD_BAN_FOREVER ? null : until - now);
    return { id, until };
  }

  /** A chat mute for `durationMs` on every key the target has (the connection key ends as in `ban`). */
  mute(target: ModerationTarget, durationMs: number, moderator: string): { readonly id: string; readonly until: number } {
    const now = this.now();
    const name = target.keys.name ?? null;
    const nameUntil = name === null ? 0 : now + Math.min(durationMs, MOD_CONNECTION_KEY_MAX_MS);
    const connectionEnd = Math.min(now + Math.min(durationMs, MOD_CONNECTION_KEY_MAX_MS), connectionKeyDeadline(target, now));
    const connection = target.keys.connection !== undefined && connectionEnd > now ? target.keys.connection : null;
    const connectionUntil = connection === null ? 0 : connectionEnd;
    const id = this.nextId("m");
    this.mutes.set(id, { id, nickname: target.nickname, playerId: target.playerId ?? null, name, until: nameUntil, connection, connectionUntil });
    this.trim(this.mutes, (mute) => Math.max(mute.until, mute.connectionUntil));
    const until = Math.max(nameUntil, connectionUntil);
    this.record(moderator, "mute", target.nickname, until - now);
    return { id, until };
  }

  /** Lifts a kick or ban. Returns its nickname, or null for an unknown (or already expired) entry. */
  unban(entryId: string, moderator: string): string | null {
    const ban = this.bans.get(entryId);
    if (!ban) return null;
    this.bans.delete(entryId);
    if (ban.persisted && ban.name !== null) this.persistBan(ban.name, this.persistedUntil(ban.name));
    this.record(moderator, "unban", ban.nickname);
    return ban.nickname;
  }

  /**
   * Lifts a mute. Returns the muted nickname, the session it was taken against (if it was online) and the keys it still
   * covered — WorldServer tells every session it silenced — or null for an unknown entry.
   */
  unmute(entryId: string, moderator: string): LiftedMute | null {
    const mute = this.mutes.get(entryId);
    if (!mute) return null;
    this.mutes.delete(entryId);
    this.record(moderator, "unmute", mute.nickname);
    const now = this.now();
    return { nickname: mute.nickname, playerId: mute.playerId, name: mute.until > now ? mute.name : null, connection: mute.connectionUntil > now ? mute.connection : null };
  }

  // ------------------------------------------------------------------ reports

  /**
   * Queues a report, unless the reporter is over its limits (REPORTS_PER_WINDOW, one per target per window). A report
   * counts against EVERY key the reporter has — the owned name and the connection — so dropping the name, or a second
   * tab without it, is no fresh budget. A pair's target is its owned name, or else its session: two
   * guests behind one address are two targets.
   */
  report(input: NewReport): ReportOutcome {
    const now = this.now();
    const reporterKeys = keyList(input.reporter.keys);
    const targetKey = input.target.keys.name !== undefined ? `name:${input.target.keys.name}` : `player:${input.target.playerId}`;
    const recent = (key: string): number[] => (this.reportTimes.get(key) ?? []).filter((t) => now - t < REPORT_WINDOW_MS && t <= now);
    const pairActive = (key: string): boolean => {
      const last = this.pairTimes.get(`${key}|${targetKey}`);
      return last !== undefined && now - last < REPORT_WINDOW_MS && last <= now;
    };
    if (reporterKeys.some((key) => recent(key).length >= REPORTS_PER_WINDOW || pairActive(key))) return { ok: false, status: "rate_limited" };
    for (const key of reporterKeys) {
      this.reportTimes.set(key, [...recent(key), now]);
      this.pairTimes.set(`${key}|${targetKey}`, now);
    }
    const report: ModReport = {
      id: this.nextId("r"),
      t: now,
      reporter: input.reporter.nickname,
      target: input.target.nickname,
      targetId: input.target.playerId,
      reason: input.reason,
      ...(input.note !== null ? { note: input.note } : {}),
      location: input.location,
    };
    this.reports.unshift({ report, targetKeys: input.target.keys, targetModerator: input.target.moderator });
    if (this.reports.length > REPORT_QUEUE_MAX) this.reports.length = REPORT_QUEUE_MAX;
    return { ok: true, report };
  }

  /**
   * What a report says about its target, for acting on it after they left: nickname, keys (seen at `t`, the report's
   * time) and whether a moderator.
   */
  reportTarget(
    reportId: string,
  ): { readonly nickname: string; readonly keys: ModerationKeys; readonly targetId: string | null; readonly moderator: boolean; readonly t: number } | null {
    const record = this.liveReports().find((entry) => entry.report.id === reportId);
    if (!record) return null;
    return { nickname: record.report.target, keys: record.targetKeys, targetId: record.report.targetId, moderator: record.targetModerator, t: record.report.t };
  }

  /**
   * Whether a report is about this viewer: its session, or its owned name. Such a report never reaches
   * that moderator, live or in the state — a reported moderator is not told who reported them, or that a report exists.
   */
  isAbout(reportId: string, viewer: ModerationViewer): boolean {
    const record = this.reports.find((entry) => entry.report.id === reportId);
    return record !== undefined && aboutViewer(record.report.targetId, record.targetKeys.name ?? null, viewer);
  }

  /** The reported session left: moderators can still act on the report, but no longer through the session. */
  targetLeft(playerId: string): boolean {
    let changed = false;
    this.reports = this.reports.map((entry) => {
      if (entry.report.targetId !== playerId) return entry;
      changed = true;
      return { ...entry, report: { ...entry.report, targetId: null } };
    });
    return changed;
  }

  /** Marks a report handled (it leaves the queue). `moderator` set: logged as a dismissal. */
  handleReport(reportId: string, moderator: string | null): boolean {
    const index = this.reports.findIndex((entry) => entry.report.id === reportId);
    if (index < 0) return false;
    const [entry] = this.reports.splice(index, 1);
    if (moderator !== null) this.record(moderator, "dismiss_report", entry!.report.target, undefined, { playerId: entry!.report.targetId, name: entry!.targetKeys.name ?? null });
    return true;
  }

  // ------------------------------------------------------------------ state

  /**
   * The moderation state for moderators (mod_log): reports and log newest first, active bans and mutes. With a viewer,
   * the reports about that viewer and the dismissals of them are left out.
   */
  snapshot(viewer?: ModerationViewer): ModLogMessage {
    const now = this.now();
    const bans: ModBanEntry[] = [];
    for (const ban of this.bans.values()) {
      const nameActive = ban.name !== null && ban.nameUntil > now;
      const connectionActive = ban.connection !== null && ban.connectionUntil > now;
      if (!nameActive && !connectionActive) continue;
      bans.push({ id: ban.id, nickname: ban.nickname, kind: ban.kind, until: Math.max(nameActive ? ban.nameUntil : 0, connectionActive ? ban.connectionUntil : 0), byName: nameActive, byConnection: connectionActive });
    }
    const mutes: ModMuteEntry[] = [];
    for (const mute of this.mutes.values()) {
      const until = Math.max(mute.name !== null ? mute.until : 0, mute.connection !== null ? mute.connectionUntil : 0);
      if (until > now) mutes.push({ id: mute.id, nickname: mute.nickname, until });
    }
    const visible = (about: LogRecord["about"]): boolean => viewer === undefined || about === null || !aboutViewer(about.playerId, about.name, viewer);
    return {
      type: "mod_log",
      reports: this.liveReports()
        .filter((entry) => visible({ playerId: entry.report.targetId, name: entry.targetKeys.name ?? null }))
        .map((entry) => ({ ...entry.report })),
      log: this.log.filter((record) => visible(record.about)).map((record) => ({ ...record.entry })),
      bans: bans.sort((a, b) => a.until - b.until),
      mutes: mutes.sort((a, b) => a.until - b.until),
    };
  }

  /**
   * Drops what ran out: bans, mutes, reports (24 h), rate-limit times; clears stored bans that ended; drops the
   * connection hash from an entry whose connection key ended while its name key runs on. True if
   * moderators should get a fresh state.
   */
  sweep(): boolean {
    const now = this.now();
    let changed = false;
    for (const [id, ban] of this.bans) {
      if (Math.max(ban.nameUntil, ban.connectionUntil) > now) {
        if (ban.connection !== null && ban.connectionUntil <= now) {
          this.bans.set(id, { ...ban, connection: null, connectionUntil: 0 });
          changed = true;
        }
        continue;
      }
      this.bans.delete(id);
      if (ban.persisted && ban.name !== null) this.persistBan(ban.name, this.persistedUntil(ban.name));
      changed = true;
    }
    for (const [id, mute] of this.mutes) {
      if (Math.max(mute.until, mute.connectionUntil) > now) {
        if (mute.connection !== null && mute.connectionUntil <= now) {
          this.mutes.set(id, { ...mute, connection: null, connectionUntil: 0 });
          changed = true;
        }
        continue;
      }
      this.mutes.delete(id);
      changed = true;
    }
    const before = this.reports.length;
    this.reports = this.liveReports();
    if (this.reports.length !== before) changed = true;
    for (const [key, times] of this.reportTimes) {
      const recent = times.filter((t) => now - t < REPORT_WINDOW_MS && t <= now);
      if (recent.length === 0) this.reportTimes.delete(key);
      else this.reportTimes.set(key, recent);
    }
    for (const [pair, t] of this.pairTimes) if (now - t >= REPORT_WINDOW_MS || t > now) this.pairTimes.delete(pair);
    return changed;
  }

  /** How many entries are held (tests: everything stays bounded). `connectionKeys`: entries still holding a connection hash. */
  get sizes(): { readonly bans: number; readonly mutes: number; readonly reports: number; readonly log: number; readonly rateKeys: number; readonly connectionKeys: number } {
    let connectionKeys = 0;
    for (const ban of this.bans.values()) if (ban.connection !== null) connectionKeys++;
    for (const mute of this.mutes.values()) if (mute.connection !== null) connectionKeys++;
    return { bans: this.bans.size, mutes: this.mutes.size, reports: this.reports.length, log: this.log.length, rateKeys: this.reportTimes.size + this.pairTimes.size, connectionKeys };
  }

  // ------------------------------------------------------------------

  private liveReports(): ReportRecord[] {
    const now = this.now();
    return this.reports.filter((entry) => now - entry.report.t < REPORT_TTL_MS);
  }

  /** The latest end of the stored bans on this name key, or null (the registry clears `bannedUntil`). */
  private persistedUntil(name: string): number | null {
    const now = this.now();
    let until: number | null = null;
    for (const ban of this.bans.values()) {
      if (!ban.persisted || ban.name !== name || ban.nameUntil <= now) continue;
      if (until === null || ban.nameUntil > until) until = ban.nameUntil;
    }
    return until;
  }

  private record(moderator: string, action: ModAction, target: string, durationMs?: number | null, about: LogRecord["about"] = null): void {
    this.log.unshift({ entry: { id: this.nextId("l"), t: this.now(), moderator, action, target, ...(durationMs !== undefined ? { durationMs } : {}) }, about });
    if (this.log.length > MOD_LOG_MAX) this.log.length = MOD_LOG_MAX;
  }

  /** `trim` for bans: a stored ban it drops is cleared from (or shortened in) names.json too. */
  private trimBans(): void {
    for (const ban of this.trim(this.bans, (entry) => Math.max(entry.nameUntil, entry.connectionUntil))) {
      if (ban.persisted && ban.name !== null) this.persistBan(ban.name, this.persistedUntil(ban.name));
    }
  }

  /** Keeps a map at MODERATION_ENTRIES_MAX: expired entries first, then the ones ending soonest. Returns what it dropped. */
  private trim<T>(entries: Map<string, T>, endOf: (entry: T) => number): T[] {
    const dropped: T[] = [];
    if (entries.size <= MODERATION_ENTRIES_MAX) return dropped;
    const now = this.now();
    for (const [id, entry] of entries) {
      if (endOf(entry) > now) continue;
      entries.delete(id);
      dropped.push(entry);
    }
    while (entries.size > MODERATION_ENTRIES_MAX) {
      let soonest: string | null = null;
      let soonestAt = Infinity;
      for (const [id, entry] of entries) {
        const end = endOf(entry);
        if (end < soonestAt) {
          soonest = id;
          soonestAt = end;
        }
      }
      if (soonest === null) break;
      dropped.push(entries.get(soonest)!);
      entries.delete(soonest);
    }
    return dropped;
  }

  private nextId(prefix: string): string {
    return `${prefix}${++this.counter}`;
  }
}

/** Every key a reporter is counted by: the owned name and the connection (whichever it has). */
function keyList(keys: ModerationKeys): string[] {
  return [...(keys.name !== undefined ? [`name:${keys.name}`] : []), ...(keys.connection !== undefined ? [`connection:${keys.connection}`] : [])];
}

/** Until when a mute holds these keys (0: it doesn't) — by the owned name, or by the connection for keys without one. */
function muteEndFor(mute: MuteRecord, keys: ModerationKeys): number {
  const byName = mute.name !== null && keys.name === mute.name ? mute.until : 0;
  const byConnection = mute.connection !== null && keys.name === undefined && keys.connection === mute.connection ? mute.connectionUntil : 0;
  return Math.max(byName, byConnection);
}

/** The latest a connection key may last: 24 hours after the server saw the hash (now, or the report's time). */
function connectionKeyDeadline(target: ModerationTarget, now: number): number {
  return Math.min(target.capturedAt ?? now, now) + MOD_CONNECTION_KEY_MAX_MS;
}

/** Whether a report's target (its session, or its owned name's key hash) is this viewer. Never by the connection hash. */
function aboutViewer(targetId: string | null, targetName: string | null, viewer: ModerationViewer): boolean {
  return (targetId !== null && targetId === viewer.playerId) || (targetName !== null && viewer.name !== undefined && targetName === viewer.name);
}
