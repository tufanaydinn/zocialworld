import type { DiscussionLine, LiveNowEntry, SpeakerCardState, WatchHallHandles } from "../world/hall/contract.ts";
import type { WatchClient } from "../watch/WatchClient.ts";
import type { WatchListing } from "../watch/types.ts";
import type { HallStore } from "./HallStore.ts";
import {
  ReactionWindow,
  discussionLines,
  liveNowEntries,
  nextScheduled,
  reactionTally,
  reactionTallyText,
  speakerCardState,
  stageLiveEntry,
  upNextText,
  type HallChatEntry,
  type ReactionCounts,
  type ReactionTally,
  type StageView,
} from "./boardFeeds.ts";

/**
 * Feeds the Watch Hall's in-world boards (docs/architecture/WATCH_HALL.md):
 * the Live Now board, the Discussion Corner board, the speaker-card strip and — through
 * StageSystem.setUpNext, so the stage stays the only writer — the big screen's "Up next: …".
 *
 *  - Work happens at most once a second, and only while the hall is the active location (App
 *    passes that flag every frame); the boards themselves redraw only when their data changed.
 *  - The Watch catalogue is fetched at most every 60 s while in the hall (WatchClient shares the
 *    request with the Watch panel). If it never loaded, the Live Now board shows its offline face
 *    unless the in-hall stage is on.
 *  - Hall chat lines and reaction batches are kept in memory only (the last 40 lines, 60 s of
 *    reactions) and dropped when the server says we left the hall. Blocked players' lines are
 *    filtered when drawing, so blocking someone also hides what they said before.
 */

export interface HallBoardsOptions {
  /** The hall's board handles (null in ?world=prototype). */
  readonly boards: Pick<WatchHallHandles, "liveNow" | "discussion" | "speakerCard"> | null;
  readonly hall: HallStore;
  readonly watch: Pick<WatchClient, "listing">;
  /** StageSystem.setUpNext: the screen's idle subtitle. */
  readonly setUpNext: (text: string | null) => void;
  /** The holder's nickname from presence ("You" for the local player). */
  readonly nameOf: (playerId: string) => string;
  readonly isBlocked: (playerId: string) => boolean;
  /** Players this client sees inside the hall, plus itself. */
  readonly members: () => number;
  /** The gateway media proxy for thumbnails (community/safeHtml.ts proxiedImage). */
  readonly thumb: (src: string) => string | null;
  readonly now?: () => number;
}

/** What was last pushed to each board (DEV/e2e hook `__hallBoards.snapshot()`). */
export interface HallBoardsSnapshot {
  readonly liveNow: readonly LiveNowEntry[] | "offline" | null;
  /** `reactions` are the counts the board shows; `tally` says whose (this session, the last one, or the last minute). */
  readonly discussion: { readonly lines: readonly DiscussionLine[]; readonly reactions: ReactionCounts; readonly tally: ReactionTally; readonly tallyText: string; readonly members: number } | null;
  readonly speakerCard: SpeakerCardState | null;
  readonly upNext: string | null;
}

const FEED_INTERVAL_MS = 1000;
const LISTING_INTERVAL_MS = 60_000;
const MAX_CHAT_ENTRIES = 40;

export class HallBoards {
  private readonly options: HallBoardsOptions;
  private readonly now: () => number;
  private readonly chat: HallChatEntry[] = [];
  private readonly reactions = new ReactionWindow();
  private readonly unsubscribe: () => void;
  private listing: WatchListing | null = null;
  private listingFailed = false;
  private listingAt = Number.NEGATIVE_INFINITY;
  private loading = false;
  private lastRun = Number.NEGATIVE_INFINITY;
  private last: HallBoardsSnapshot = { liveNow: null, discussion: null, speakerCard: null, upNext: null };
  private disposed = false;

  constructor(options: HallBoardsOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.unsubscribe = options.hall.subscribe((event) => {
      if (event.type === "reactions") this.reactions.add(event.counts, this.now());
      else if (event.type === "change" && !options.hall.member) this.forget();
    });
  }

  /** A hall chat line the client showed (App already dropped lines from players blocked at arrival). */
  addChatLine(entry: HallChatEntry): void {
    this.chat.push({ playerId: entry.playerId, nickname: entry.nickname, text: entry.text });
    if (this.chat.length > MAX_CHAT_ENTRIES) this.chat.splice(0, this.chat.length - MAX_CHAT_ENTRIES);
  }

  /** Per frame from App. `active`: the hall is the active location. */
  update(active: boolean): void {
    if (!active || this.disposed) return;
    const now = this.now();
    if (!this.loading && now - this.listingAt >= LISTING_INTERVAL_MS) this.fetchListing(now);
    if (now - this.lastRun < FEED_INTERVAL_MS) return;
    this.lastRun = now;
    this.run(now);
  }

  snapshot(): HallBoardsSnapshot {
    return this.last;
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
  }

  private forget(): void {
    this.chat.length = 0;
    this.reactions.clear();
  }

  private fetchListing(now: number): void {
    this.loading = true;
    this.listingAt = now;
    this.options.watch
      .listing()
      .then((listing) => {
        this.listing = listing;
        this.listingFailed = false;
      })
      .catch(() => {
        // Keep an older listing if there is one; the board goes offline only when nothing ever loaded.
        this.listingFailed = this.listing === null;
      })
      .finally(() => {
        this.loading = false;
      });
  }

  private run(now: number): void {
    const { hall, boards } = this.options;
    const holder = hall.stage.holder;
    const view: StageView = { member: hall.member, stage: hall.stage, holderName: holder ? this.options.nameOf(holder) : null };
    const members = this.options.members();

    const stageEntry = stageLiveEntry(view, members);
    let liveNow: HallBoardsSnapshot["liveNow"];
    if (this.listing === null && this.listingFailed && stageEntry === null) {
      liveNow = "offline";
      boards?.liveNow.setOffline();
    } else {
      const entries = liveNowEntries({ stage: stageEntry, listing: this.listing, now, thumb: this.options.thumb });
      liveNow = entries;
      boards?.liveNow.setEntries(entries);
    }

    const lines = discussionLines(this.chat, { isBlocked: this.options.isBlocked });
    // The server's per-turn totals ("This session" / "Last session"); the last minute only before any turn.
    const tally = reactionTally(hall.reactionSession, hall.reactionTotals, this.reactions.totals(now));
    const reactions = tally.counts;
    const tallyText = reactionTallyText(tally);
    boards?.discussion.setLines(lines, reactions, members, tally.label);

    const next = nextScheduled(this.listing, now);
    const card = speakerCardState(view, next);
    boards?.speakerCard.set(card);
    const upNext = upNextText(next);
    this.options.setUpNext(upNext);

    this.last = { liveNow, discussion: { lines, reactions, tally, tallyText, members }, speakerCard: card, upNext };
  }
}
