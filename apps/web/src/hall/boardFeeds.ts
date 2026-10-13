import { HALL_REACTIONS, HALL_STAGE_PREPARE_TIMEOUT_MS, type HallLinkKind, type HallReaction, type HallReactionSession, type HallStageState } from "@project/shared";
import type { DiscussionLine, LiveNowEntry, SpeakerCardState } from "../world/hall/contract.ts";
import { REACTION_EMOJI } from "../social/EmoteWheel.ts";
import { bucketWatch, formatCount, formatDate, formatDayLabel, formatDuration, formatTime } from "../watch/schedule.ts";
import type { WatchListing } from "../watch/types.ts";

/**
 * What the Watch Hall's in-world boards and the screen's idle face show
 * (docs/architecture/WATCH_HALL.md): the Live Now board (the in-hall stage, then
 * YouTube live, today's events, the latest replays), the Discussion Corner board (the last hall
 * lines, the reaction tallies of the current or last stage turn, or of the last
 * 60 s before any turn, the member count) and the speaker-card
 * strip under the screen ("Up next: …" while nobody presents). HallBoards.ts runs these at most
 * once a second while the hall is the active location. Pure: `now`, names, colours and the
 * thumbnail proxy are injected; nothing here touches the DOM or the network.
 */

// ---------------------------------------------------------------- reactions

/** Reaction tallies cover this much recent history (the Discussion Corner board's counts fall back to 0 after it). */
export const REACTION_WINDOW_MS = 60_000;

export type ReactionCounts = Partial<Record<HallReaction, number>>;

/** Sums the server's reaction batches (HallStore "reactions" events) over the last REACTION_WINDOW_MS. */
export class ReactionWindow {
  private readonly windowMs: number;
  private readonly batches: { readonly at: number; readonly counts: ReactionCounts }[] = [];

  constructor(windowMs = REACTION_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /** Adds one batch received at `now` (unknown reactions and non-positive counts are ignored). */
  add(counts: Readonly<ReactionCounts>, now: number): void {
    const clean: ReactionCounts = {};
    let any = false;
    for (const reaction of HALL_REACTIONS) {
      const count = counts[reaction];
      if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) continue;
      clean[reaction] = Math.floor(count);
      any = true;
    }
    if (any) this.batches.push({ at: now, counts: clean });
  }

  /** Totals of the batches younger than the window at `now` (older ones are dropped). */
  totals(now: number): ReactionCounts {
    while (this.batches.length > 0 && now - this.batches[0]!.at >= this.windowMs) this.batches.shift();
    const totals: ReactionCounts = {};
    for (const batch of this.batches) {
      for (const reaction of HALL_REACTIONS) {
        const count = batch.counts[reaction];
        if (count) totals[reaction] = (totals[reaction] ?? 0) + count;
      }
    }
    return totals;
  }

  clear(): void {
    this.batches.length = 0;
  }
}

/** What the Discussion Corner board's reaction strip shows: a label and the counts under it. */
export interface ReactionTally {
  /** "This session" (a stage turn is on), "Last session" (the stage is idle after a turn), or "Last minute" (no turn yet). */
  readonly label: "This session" | "Last session" | "Last minute";
  readonly counts: ReactionCounts;
  /** The server's session id (0: no turn yet). */
  readonly session: number;
}

/**
 * The reaction counter resets with every stage turn. While a turn is on, the board shows the server's
 * totals for it ("This session"); after it ends they stay as "Last session" until the next turn starts. Every client
 * shows the same server numbers. Before the first turn, the board falls back to the last minute of reactions this
 * client saw, so an idle hall's reactions still show somewhere.
 */
export function reactionTally(session: HallReactionSession, totals: Readonly<ReactionCounts>, lastMinute: Readonly<ReactionCounts>): ReactionTally {
  if (session.id <= 0) return { label: "Last minute", counts: { ...lastMinute }, session: 0 };
  return { label: session.active ? "This session" : "Last session", counts: { ...totals }, session: session.id };
}

/** "This session: 👏 12 ❤️ 5" — the tally as one line (in HALL_REACTIONS order, zeros left out), or "This session: no reactions yet". */
export function reactionTallyText(tally: ReactionTally): string {
  const parts = HALL_REACTIONS.filter((reaction) => (tally.counts[reaction] ?? 0) > 0).map((reaction) => `${REACTION_EMOJI[reaction]} ${tally.counts[reaction]}`);
  return `${tally.label}: ${parts.length > 0 ? parts.join(" ") : "no reactions yet"}`;
}

// ---------------------------------------------------------------- Discussion Corner lines

/** One hall chat line kept in memory for the board (never persisted; dropped on leaving the hall). */
export interface HallChatEntry {
  readonly playerId: string;
  readonly nickname: string;
  readonly text: string;
}

/** A takeaway is a hall line that starts with 💡 (Discussion Corner → "Share Takeaways" prefills it). */
export function isTakeaway(text: string): boolean {
  return text.trimStart().startsWith("💡");
}

/** A stable, readable nickname colour for the dark wooden board, from any id. */
export function nameColor(key: string): string {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `hsl(${(hash >>> 0) % 360}, 80%, 74%)`;
}

/** The last `max` lines from players who are not blocked (block is applied when drawing, so blocking later hides earlier lines too). */
export function discussionLines(entries: readonly HallChatEntry[], options: { readonly isBlocked: (playerId: string) => boolean; readonly colorOf?: (playerId: string) => string; readonly max?: number }): DiscussionLine[] {
  const colorOf = options.colorOf ?? nameColor;
  const visible = entries.filter((entry) => !options.isBlocked(entry.playerId));
  return visible.slice(-(options.max ?? 5)).map((entry) => ({
    nickname: entry.nickname,
    text: entry.text,
    color: colorOf(entry.playerId),
    ...(isTakeaway(entry.text) ? { takeaway: true } : {}),
  }));
}

// ---------------------------------------------------------------- stage status (widget, chip, boards)

/** Seconds left for a preparing holder to start sharing, from when this client saw the turn start (server clocks are not synced). */
export function prepareSecondsLeft(seenAt: number, now: number): number {
  return Math.max(0, Math.ceil((seenAt + HALL_STAGE_PREPARE_TIMEOUT_MS - now) / 1000));
}

export interface StageView {
  readonly member: boolean;
  readonly stage: Readonly<HallStageState>;
  /** The holder's nickname from presence ("You" for the local player), or null when nobody holds the stage. */
  readonly holderName: string | null;
}

/** "are" for the local player ("You"), "is" for everyone else. */
const be = (name: string): string => (name === "You" ? "are" : "is");

/** The in-hall stage as the Live Now board's first row (null while nobody holds it). */
export function stageLiveEntry(view: StageView, members: number): LiveNowEntry | null {
  const { stage } = view;
  if (!view.member || stage.holder === null || stage.status === "idle") return null;
  const name = view.holderName ?? "Someone";
  const live = stage.status === "live";
  return {
    kind: "stage",
    title: stage.card?.title ?? (live ? `${name} on the big screen` : `${name} ${be(name)} getting ready`),
    subtitle: live ? `${name} · in the Watch Hall now${stage.audio ? "" : " · no sound"}` : `${name} · starting soon`,
    badge: live ? "Live" : "Starting",
    meta: `👥 ${members}`,
  };
}

const WHERE_LABEL: Record<string, string> = { zoom: "Zoom", youtube: "YouTube", "in-person": "In person", hall: "Watch Hall" };

/**
 * The Live Now board: the in-hall stage first, then YouTube live streams, today's events (in
 * progress, then later today), then the latest replays — at most `max` rows. Thumbnails only
 * through `thumb` (the gateway media proxy; anything it refuses gets the board's placeholder).
 */
export function liveNowEntries(input: {
  readonly stage: LiveNowEntry | null;
  readonly listing: WatchListing | null;
  readonly now: number;
  readonly thumb: (src: string) => string | null;
  readonly timeZone?: string;
  readonly max?: number;
}): LiveNowEntry[] {
  const max = input.max ?? 4;
  const entries: LiveNowEntry[] = input.stage ? [input.stage] : [];
  const listing = input.listing;
  if (listing) {
    const thumbUrl = (src: string): { thumbUrl?: string } => {
      const url = input.thumb(src);
      return url ? { thumbUrl: url } : {};
    };
    for (const video of listing.live) {
      if (video.status !== "live") continue;
      const viewers = formatCount(video.concurrentViewers);
      entries.push({ kind: "live", title: video.title, subtitle: video.channel, badge: "Live", ...(viewers ? { meta: `👁 ${viewers}` } : {}), ...thumbUrl(video.thumb) });
    }
    const buckets = bucketWatch(listing, input.now, input.timeZone);
    for (const item of buckets.live) {
      if (item.kind !== "event") continue;
      const where = item.event.location || WHERE_LABEL[item.event.where] || "";
      entries.push({ kind: "live", title: item.event.title, subtitle: [where, `until ${formatTime(item.end, input.timeZone)}`].filter(Boolean).join(" · "), badge: "Live" });
    }
    for (const item of buckets.today) {
      if (item.kind === "event") {
        if (item.ended) continue;
        entries.push({ kind: "today", title: item.event.title, subtitle: item.event.location || WHERE_LABEL[item.event.where] || "Today", badge: `Today ${formatTime(item.start, input.timeZone)}` });
      } else {
        entries.push({
          kind: "today",
          title: item.video.title,
          subtitle: item.video.channel,
          badge: item.start !== null && item.start > input.now ? `Today ${formatTime(item.start, input.timeZone)}` : "Soon",
          ...thumbUrl(item.video.thumb),
        });
      }
    }
    for (const video of listing.latest) {
      const duration = formatDuration(video.durationSec);
      const date = formatDate(video.publishedAt, input.timeZone);
      entries.push({ kind: "replay", title: video.title, subtitle: [video.channel, date].filter(Boolean).join(" · "), badge: "Replay", ...(duration ? { meta: duration } : {}), ...thumbUrl(video.thumb) });
    }
  }
  return entries.slice(0, max);
}

// ---------------------------------------------------------------- up next and the speaker card

export interface UpNext {
  readonly title: string;
  /** "Today 15:00", "Tomorrow 15:00", "Thu, 15 Oct 15:00". */
  readonly when: string;
}

/** The next scheduled event or premiere that has not started yet (today first, then upcoming), or null. */
export function nextScheduled(listing: WatchListing | null, now: number, timeZone?: string): UpNext | null {
  if (!listing) return null;
  const buckets = bucketWatch(listing, now, timeZone);
  for (const item of [...buckets.today, ...buckets.upcoming]) {
    if (item.start === null || item.start <= now) continue;
    const title = item.kind === "event" ? item.event.title : item.video.title;
    return { title, when: `${formatDayLabel(item.start, now, timeZone)} ${formatTime(item.start, timeZone)}` };
  }
  return null;
}

/** "Zcash Arborist Call · Today 15:00" — the big screen's idle subtitle ("Up next: …"). */
export function upNextText(next: UpNext | null): string | null {
  return next ? `${next.title} · ${next.when}` : null;
}

/** The speaker-card strip under the screen: the presenter and their card, a card a host set while idle, the next event, or the open stage. */
export function speakerCardState(view: StageView, next: UpNext | null): SpeakerCardState {
  const { stage } = view;
  const card = view.member ? stage.card : null;
  const details = (): Pick<SpeakerCardState, "speaker" | "project" | "links"> => ({
    ...(card?.speaker ? { speaker: card.speaker } : {}),
    ...(card?.project ? { project: card.project } : {}),
    ...(card?.links?.length ? { links: card.links.map((link) => link.kind as HallLinkKind) } : {}),
  });
  if (view.member && stage.holder !== null && stage.status !== "idle") {
    const name = view.holderName ?? "Someone";
    const live = stage.status === "live";
    const note = !card ? (live ? "Press E at the card for links · share with sound for everyone in the hall" : "Their screen appears on the big screen when they start sharing") : live && !stage.audio ? "No sound in this share" : undefined;
    return {
      mode: live ? "live" : "preparing",
      title: card?.title ?? (live ? `${name} ${be(name)} presenting` : `${name} ${be(name)} getting ready`),
      presenter: name,
      ...details(),
      ...(note ? { note } : {}),
    };
  }
  if (card) return { mode: "next", title: card.title, ...details(), note: "Up next on the stage · press E at the card for links" };
  if (view.member && stage.locked) return { mode: "idle", title: "The stage is locked", note: "A host hands the stage to the next presenter" };
  if (next) return { mode: "next", title: next.title, note: `${next.when} · see the Watch panel for the schedule` };
  return { mode: "idle", title: "The stage is open", note: "Request it at the podium · share a tab with sound · everyone in the hall watches together" };
}
