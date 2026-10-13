import { HALL_CARD_LINKS_MAX, HALL_CARD_TITLE_MAX, HALL_EVENT_ID_PATTERN, type HallCardLink } from "@project/shared";
import { proxiedImage } from "../community/safeHtml.ts";
import { cleanHallCardUrl } from "../hall/hallCard.ts";
import { injectUiStyles } from "../ui/styles.ts";
import {
  bucketWatch,
  eventToIcs,
  formatCount,
  formatDate,
  formatDayLabel,
  formatDuration,
  formatEventWhen,
  formatTime,
  groupByDay,
  matchesFilter,
  type ScheduleItem,
  type WatchBuckets,
} from "./schedule.ts";
import type { WatchClient } from "./WatchClient.ts";
import type { WatchCollection, WatchEvent, WatchLink, WatchListing, WatchVideo } from "./types.ts";
import { supportsCredentialless, watchUrl, YOUTUBE_ID_PATTERN } from "./youtube.ts";

/**
 * The Watch panel (docs/architecture/WATCH_HALL.md): Live / Today / Upcoming /
 * Replays from our gateway's `/content/watch`, opened from the action bar, the hall's Live Now
 * board and the portal. Built like the Community Hub (CommunityPanel.ts): a backdrop panel, text
 * via textContent only, thumbnails only through `/content/media`, and every way out of the game
 * an explicit https new-tab link — except "Watch here", the opt-in personal player
 * (PersonalPlayer.ts), which App wires to `onWatchHere`.
 *
 * The in-hall stage comes from the stage system (`setStageInfo`), not from the gateway. The stage
 * holder (`setCanPresent(true)`) gets "Show on the big screen": the video opens in a new tab for
 * them to share, and `onShowOnStage` hands the stage system a card to set.
 */

export type WatchTab = "live" | "today" | "upcoming" | "replays";

export interface WatchStageInfo {
  /** The presenter's nickname (the caller resolves it from presence; shown as text). */
  readonly nickname: string;
  /** Players in the hall. */
  readonly viewers: number;
  /** The card title, if the presenter set one. */
  readonly title?: string;
  /** True once the share is live (false while the holder is still preparing). */
  readonly live?: boolean;
  /** The local player is already in the hall (hides "Go to the hall"). */
  readonly inHall?: boolean;
}

/** What "Show on the big screen" hands to the stage system (a HallCard draft; the server re-validates). */
export interface ShowOnStageRequest {
  readonly title: string;
  readonly videoId: string;
  readonly eventId?: string;
  readonly links?: HallCardLink[];
}

export interface WatchPanelCallbacks {
  /** "Watch here" — the opt-in personal player. */
  readonly onWatchHere?: (video: { id: string; title: string }) => void;
  /** "Go to the hall" on the stage entry. */
  readonly onGoToHall?: () => void;
}

export interface WatchPanelOptions {
  readonly now?: () => number;
  /** Live-tab refresh interval while open (default 60 s). */
  readonly pollMs?: number;
}

const TABS: { id: WatchTab; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "today", label: "Today" },
  { id: "upcoming", label: "Upcoming" },
  { id: "replays", label: "Replays" },
];

const LATEST = "latest";
const STAGE_GUIDE = "Opened in a new tab. Now: Start sharing → pick that tab → tick “Share tab audio”.";

export class WatchPanel {
  private readonly backdrop: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly footer: HTMLDivElement;
  private readonly toast: HTMLDivElement;
  private readonly tabButtons = new Map<WatchTab, HTMLButtonElement>();
  private readonly client: WatchClient;
  private readonly callbacks: WatchPanelCallbacks;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly stageListeners = new Set<(request: ShowOnStageRequest) => void>();
  private tab: WatchTab = "live";
  private listing: WatchListing | null = null;
  private stage: WatchStageInfo | null = null;
  private canPresent = false;
  private renderToken = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  /** Replays tab state: the chosen collection, loaded videos and the filter text. */
  private replays: { collection: string; videos: WatchVideo[]; page: number; pages: number; filter: string } = { collection: LATEST, videos: [], page: 0, pages: 1, filter: "" };

  /** The element that had focus when the panel opened (focus returns there on close). */
  private returnFocus: HTMLElement | null = null;

  constructor(container: HTMLElement, client: WatchClient, callbacks: WatchPanelCallbacks = {}, options: WatchPanelOptions = {}) {
    this.client = client;
    this.callbacks = callbacks;
    this.now = options.now ?? Date.now;
    this.pollMs = options.pollMs ?? 60_000;
    injectUiStyles();
    injectWatchStyles();
    this.backdrop = el("div", "zw-ui zw-watch-backdrop");
    const panel = el("div", "zw-panel zw-watch");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "Watch Hall");
    const header = el("div", "zw-watch-header");
    const title = el("div", "zw-watch-title");
    title.textContent = "Watch Hall";
    const tabs = el("div", "zw-watch-tabs");
    tabs.setAttribute("role", "tablist");
    for (const tab of TABS) {
      const button = el("button", "zw-watch-tab");
      button.dataset.tab = tab.id;
      button.setAttribute("role", "tab");
      button.addEventListener("click", () => this.show(tab.id));
      // Roving tabindex: Tab reaches the active tab; arrows (and Home/End) switch tabs.
      button.addEventListener("keydown", (event) => {
        const index = TABS.findIndex((candidate) => candidate.id === tab.id);
        let next = -1;
        if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
        else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = TABS.length - 1;
        if (next < 0) return;
        event.preventDefault();
        event.stopPropagation(); // never reaches the world (arrows walk)
        this.show(TABS[next]!.id);
        this.tabButtons.get(TABS[next]!.id)?.focus({ preventScroll: true });
      });
      this.tabButtons.set(tab.id, button);
      tabs.appendChild(button);
    }
    const close = el("button", "zw-button zw-watch-close");
    close.textContent = "Close (Esc)";
    close.addEventListener("click", () => this.close());
    header.append(title, tabs, close);
    this.toast = el("div", "zw-watch-toast");
    this.toast.setAttribute("role", "status");
    this.body = el("div", "zw-watch-body");
    this.footer = el("div", "zw-watch-footer");
    panel.append(header, this.toast, this.body, this.footer);
    this.backdrop.appendChild(panel);
    this.backdrop.addEventListener("click", (event) => {
      if (event.target === this.backdrop) this.close();
    });
    container.appendChild(this.backdrop);
    this.updateTabLabels();
  }

  get isOpen(): boolean {
    return this.backdrop.classList.contains("visible");
  }

  open(tab: WatchTab = this.tab): void {
    document.exitPointerLock?.();
    const wasOpen = this.isOpen;
    if (!wasOpen) {
      const active = document.activeElement;
      this.returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    this.backdrop.classList.add("visible");
    this.show(tab);
    // Keyboard focus moves into the dialog (the active tab), like the speaker card and the Discussion menu.
    if (!wasOpen) this.tabButtons.get(this.tab)?.focus({ preventScroll: true });
  }

  close(): void {
    const wasOpen = this.isOpen;
    this.backdrop.classList.remove("visible");
    this.stopPolling();
    this.renderToken++;
    if (!wasOpen) return;
    // Back to whatever opened the panel (an action-bar button), or out of the dialog so keys reach the world.
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.backdrop.contains(active)) active.blur();
    if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
    this.returnFocus = null;
  }

  /** The in-hall stage (shown first in Live), or null when nobody is presenting. */
  setStageInfo(info: WatchStageInfo | null): void {
    this.stage = info;
    this.updateTabLabels();
    if (this.isOpen && this.tab === "live" && this.listing) this.renderLive(this.listing);
  }

  /** Whether the local player holds the stage ("Show on the big screen" buttons). */
  setCanPresent(canPresent: boolean): void {
    if (this.canPresent === canPresent) return;
    this.canPresent = canPresent;
    if (this.isOpen) this.rerender();
  }

  /** Subscribe to "Show on the big screen"; returns the unsubscribe function. */
  onShowOnStage(listener: (request: ShowOnStageRequest) => void): () => void {
    this.stageListeners.add(listener);
    return () => this.stageListeners.delete(listener);
  }

  dispose(): void {
    this.close();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.stageListeners.clear();
    this.backdrop.remove();
  }

  // ---------------------------------------------------------------- tabs, loading, polling

  private show(tab: WatchTab): void {
    this.tab = tab;
    for (const [id, button] of this.tabButtons) {
      button.classList.toggle("active", id === tab);
      button.setAttribute("aria-selected", String(id === tab));
      button.tabIndex = id === tab ? 0 : -1;
    }
    if (tab === "live") this.startPolling();
    else this.stopPolling();
    void this.load();
  }

  private rerender(): void {
    if (!this.listing) return void this.load();
    if (this.tab === "replays") this.renderReplaysGrid();
    else this.renderTab(this.listing);
  }

  /** Loads the listing (the client reuses it for ~60 s) and renders the current tab, with a Retry face on failure. */
  private async load(fresh = false): Promise<void> {
    const token = ++this.renderToken;
    if (!this.listing) this.body.replaceChildren(statusLine("Loading…"));
    try {
      const listing = await this.client.listing(fresh);
      if (token !== this.renderToken) return;
      this.listing = listing;
      this.updateTabLabels();
      this.setFooter(listing);
      this.renderTab(listing);
    } catch (error) {
      if (token !== this.renderToken) return;
      console.warn("[watch] listing failed:", error instanceof Error ? error.message : error);
      if (this.listing && fresh) return; // a failed background refresh keeps what is shown
      const failure = statusLine("Couldn't reach the Watch catalogue. The game server may be offline, or the sources are temporarily unavailable.");
      const retry = el("button", "zw-button zw-watch-retry");
      retry.textContent = "Retry";
      retry.addEventListener("click", () => void this.load(true));
      this.body.replaceChildren(failure, retry);
      // The in-hall stage comes from the game server, not the catalogue: still show it.
      if (this.tab === "live" && this.stage) this.body.prepend(this.stageCard(this.stage));
    }
  }

  private startPolling(): void {
    if (this.pollTimer || !this.isOpen) return;
    this.pollTimer = setInterval(() => {
      if (this.isOpen && this.tab === "live") void this.load(true);
      else this.stopPolling();
    }, this.pollMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private buckets(listing: WatchListing): WatchBuckets {
    return bucketWatch(listing, this.now());
  }

  private updateTabLabels(): void {
    const buckets = this.listing ? this.buckets(this.listing) : null;
    const counts: Record<WatchTab, number | null> = {
      live: buckets ? buckets.live.length + (this.stage ? 1 : 0) : this.stage ? 1 : null,
      today: buckets ? buckets.today.length : null,
      upcoming: buckets ? buckets.upcoming.length : null,
      replays: this.listing ? this.listing.collections.reduce((sum, collection) => sum + collection.count, 0) : null,
    };
    for (const tab of TABS) {
      const button = this.tabButtons.get(tab.id)!;
      const count = counts[tab.id];
      button.replaceChildren(document.createTextNode(tab.label));
      if (count !== null) {
        const pill = el("span", `zw-watch-count${tab.id === "live" && count > 0 ? " zw-watch-count-live" : ""}`);
        pill.textContent = String(count);
        button.append(" ", pill);
      }
    }
  }

  private setFooter(listing: WatchListing, stale = listing.stale): void {
    const note = el("span", "zw-watch-attribution");
    // The credits name the sources of the server's catalogue: "Videos: YouTube — …" and the like.
    const credits = (listing.sources ?? []).map((source) => `${source.label}: ${source.text}`).join(" · ");
    note.textContent = `${credits ? `${credits}. ` : ""}Relayed by the Zocial World server.${stale ? " (cached)" : ""}`;
    this.footer.replaceChildren(note);
  }

  private renderTab(listing: WatchListing): void {
    if (this.tab === "live") this.renderLive(listing);
    else if (this.tab === "today") this.renderToday(listing);
    else if (this.tab === "upcoming") this.renderUpcoming(listing);
    else void this.renderReplays(listing);
  }

  // ---------------------------------------------------------------- Live / Today / Upcoming

  private renderLive(listing: WatchListing): void {
    const buckets = this.buckets(listing);
    const scroll = this.body.scrollTop;
    this.body.replaceChildren();
    if (this.stage) this.body.appendChild(this.stageCard(this.stage));
    const list = el("div", "zw-watch-list");
    for (const item of buckets.live) list.appendChild(this.itemCard(item));
    if (list.childElementCount > 0) this.body.appendChild(list);
    if (!this.stage && buckets.live.length === 0) {
      this.body.appendChild(statusLine("Nothing is live right now."));
      const next = [...buckets.today, ...buckets.upcoming].find((item) => item.kind === "video" || !item.ended);
      if (next) {
        this.body.appendChild(sectionTitle("Up next"));
        const upNext = el("div", "zw-watch-list");
        upNext.appendChild(this.itemCard(next));
        this.body.appendChild(upNext);
      }
    }
    if (listing.notice) this.body.appendChild(noteLine(listing.notice));
    this.body.scrollTop = scroll;
  }

  private renderToday(listing: WatchListing): void {
    const { today } = this.buckets(listing);
    this.body.replaceChildren();
    this.body.scrollTop = 0;
    if (today.length === 0) {
      this.body.appendChild(statusLine("Nothing else on today. See Upcoming for what's next."));
      return;
    }
    const list = el("div", "zw-watch-list");
    for (const item of today) list.appendChild(this.itemCard(item));
    this.body.appendChild(list);
  }

  private renderUpcoming(listing: WatchListing): void {
    const { upcoming } = this.buckets(listing);
    this.body.replaceChildren();
    this.body.scrollTop = 0;
    if (upcoming.length === 0) {
      this.body.appendChild(statusLine("Nothing scheduled in the next 30 days yet."));
      return;
    }
    for (const group of groupByDay(upcoming, this.now())) {
      this.body.appendChild(sectionTitle(group.label));
      const list = el("div", "zw-watch-list");
      for (const item of group.items) list.appendChild(this.itemCard(item));
      this.body.appendChild(list);
    }
  }

  private stageCard(stage: WatchStageInfo): HTMLElement {
    const card = el("div", "zw-watch-card zw-watch-stage");
    const badge = el("span", `zw-watch-badge${stage.live === false ? " zw-watch-badge-soon" : " zw-watch-badge-live"}`);
    badge.textContent = stage.live === false ? "ON STAGE SOON" : "LIVE";
    const head = el("div", "zw-watch-card-title");
    head.textContent = stage.live === false ? `In the Hall — ${stage.nickname} is getting ready · 👥 ${stage.viewers}` : `LIVE in the Hall — ${stage.nickname} is presenting · 👥 ${stage.viewers}`;
    const text = el("div", "zw-watch-card-text");
    text.append(badge, head);
    if (stage.title) {
      const subtitle = el("div", "zw-watch-card-meta");
      subtitle.textContent = stage.title;
      text.appendChild(subtitle);
    }
    card.appendChild(text);
    if (!stage.inHall) {
      const actions = el("div", "zw-watch-actions");
      const go = el("button", "zw-button zw-button-primary zw-watch-go");
      go.textContent = "Go to the hall";
      go.addEventListener("click", () => {
        this.close();
        this.callbacks.onGoToHall?.();
      });
      actions.appendChild(go);
      card.appendChild(actions);
    }
    return card;
  }

  private itemCard(item: ScheduleItem): HTMLElement {
    return item.kind === "video" ? this.videoCard(item.video, item.live) : this.eventCard(item.event, item.live, item.ended);
  }

  private eventCard(event: WatchEvent, live: boolean, ended: boolean): HTMLElement {
    const card = el("div", `zw-watch-card zw-watch-event${ended ? " zw-watch-ended" : ""}`);
    card.dataset.eventId = event.id;
    const text = el("div", "zw-watch-card-text");
    const top = el("div", "zw-watch-card-top");
    if (live) top.appendChild(liveBadge());
    const where = el("span", "zw-watch-chip");
    where.textContent = event.where === "zoom" ? "Zoom" : event.where === "in-person" ? "In person" : event.where === "hall" ? "In the Hall" : "YouTube";
    top.appendChild(where);
    const when = el("span", "zw-watch-when");
    when.textContent = formatEventWhen(event, this.now());
    top.appendChild(when);
    const title = el("div", "zw-watch-card-title");
    title.textContent = event.title;
    text.append(top, title);
    if (event.location) {
      const location = el("div", "zw-watch-card-meta");
      location.textContent = event.location;
      text.appendChild(location);
    }
    if (event.summary) {
      const summary = el("div", "zw-watch-summary");
      summary.textContent = event.summary;
      text.appendChild(summary);
    }
    const actions = el("div", "zw-watch-actions");
    if (event.videoId && YOUTUBE_ID_PATTERN.test(event.videoId)) {
      this.videoActions(actions, { id: event.videoId, title: event.title }, event);
    }
    if (event.joinUrl && !ended) {
      actions.appendChild(externalLink(event.where === "zoom" ? "Join on Zoom ↗" : "Event page ↗", event.joinUrl, event.where === "zoom" && live));
    }
    if (!ended) {
      const ics = el("button", "zw-button zw-watch-ics");
      ics.textContent = ".ics";
      ics.title = "Add to your calendar (made on this device)";
      ics.addEventListener("click", () => downloadIcs(event, this.now()));
      actions.appendChild(ics);
    }
    if (actions.childElementCount > 0) text.appendChild(actions);
    card.appendChild(text);
    return card;
  }

  private videoCard(video: WatchVideo, live = video.status === "live"): HTMLElement {
    const card = el("div", `zw-watch-card zw-watch-video${live ? " zw-watch-is-live" : ""}`);
    card.dataset.videoId = video.id;
    const thumb = el("div", "zw-watch-thumb");
    const src = proxiedImage(video.thumb);
    if (src) {
      const image = document.createElement("img");
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      image.crossOrigin = "anonymous";
      image.alt = "";
      image.addEventListener("error", () => image.replaceWith(thumbFallback()));
      image.src = src;
      thumb.appendChild(image);
    } else {
      thumb.appendChild(thumbFallback());
    }
    if (live) thumb.appendChild(liveBadge());
    const duration = formatDuration(video.durationSec);
    if (duration && !live) {
      const chip = el("span", "zw-watch-duration");
      chip.textContent = duration;
      thumb.appendChild(chip);
    }
    if (live && video.concurrentViewers !== null) {
      const viewers = el("span", "zw-watch-viewers");
      viewers.textContent = `👥 ${formatCount(video.concurrentViewers)}`;
      viewers.title = `${video.concurrentViewers} watching on YouTube`;
      thumb.appendChild(viewers);
    }
    const text = el("div", "zw-watch-card-text");
    const title = el("div", "zw-watch-card-title");
    title.textContent = video.title;
    const meta = el("div", "zw-watch-card-meta");
    const start = video.scheduledStart ? Date.parse(video.scheduledStart) : Number.NaN;
    const when = video.status === "upcoming" && Number.isFinite(start) ? `Premieres ${formatDayLabel(start, this.now())} · ${formatTime(start)}` : formatDate(video.publishedAt);
    const views = video.views !== null && !live ? `${formatCount(video.views)} views` : "";
    meta.textContent = [video.channel, when, views].filter(Boolean).join(" · ");
    const actions = el("div", "zw-watch-actions");
    this.videoActions(actions, video);
    text.append(title, meta, actions);
    card.append(thumb, text);
    return card;
  }

  /**
   * "Watch here" (opt-in player), "Open on YouTube ↗" and, for the stage holder, "Show on the big screen".
   * "Watch here" exists only where the in-game player can embed without the viewer's cookies
   * (credentialless iframes, Chromium): elsewhere it would just open youtube.com, which is what
   * "Open on YouTube ↗" already says, so the button never promises a dialog that doesn't come.
   */
  private videoActions(actions: HTMLElement, video: { id: string; title: string }, event?: WatchEvent): void {
    if (!YOUTUBE_ID_PATTERN.test(video.id)) return;
    if (supportsCredentialless()) {
      const here = el("button", "zw-button zw-button-primary zw-watch-here");
      here.append("Watch here");
      const optIn = el("span", "zw-watch-optin");
      optIn.textContent = " (YouTube, opt-in)";
      here.appendChild(optIn);
      here.title = "Plays in the game after you agree — this connects your browser to YouTube.";
      here.addEventListener("click", () => this.callbacks.onWatchHere?.({ id: video.id, title: video.title }));
      actions.append(here);
    }
    const open = externalLink("Open on YouTube ↗", watchUrl(video.id));
    open.title = "Opens youtube.com in a new tab, which sees your IP address and your YouTube cookies.";
    actions.append(open);
    if (this.canPresent) {
      const stage = el("button", "zw-button zw-watch-stage-button");
      stage.textContent = "Show on the big screen";
      stage.title = "Opens the video in a new tab for you to share on the hall screen, and sets the speaker card";
      stage.addEventListener("click", () => this.showOnStage(video, event));
      actions.appendChild(stage);
    }
  }

  private showOnStage(video: { id: string; title: string }, event?: WatchEvent): void {
    window.open(watchUrl(video.id), "_blank", "noopener,noreferrer");
    const links: HallCardLink[] = [];
    for (const link of event?.links ?? ([] as WatchLink[])) {
      const url = cleanHallCardUrl(link.url);
      if (url && links.length < HALL_CARD_LINKS_MAX) links.push({ kind: link.kind, url });
    }
    const title = [...video.title.replace(/\s+/g, " ").trim()].slice(0, HALL_CARD_TITLE_MAX).join("");
    const request: ShowOnStageRequest = {
      title,
      videoId: video.id,
      ...(event && HALL_EVENT_ID_PATTERN.test(event.id) ? { eventId: event.id } : {}),
      ...(links.length > 0 ? { links } : {}),
    };
    for (const listener of this.stageListeners) {
      try {
        listener(request);
      } catch (error) {
        console.warn("[watch] show-on-stage listener failed:", error);
      }
    }
    this.showToast(STAGE_GUIDE);
  }

  private showToast(text: string): void {
    this.toast.textContent = text;
    this.toast.classList.add("visible");
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.classList.remove("visible"), 12_000);
  }

  // ---------------------------------------------------------------- Replays

  private async renderReplays(listing: WatchListing): Promise<void> {
    this.body.replaceChildren();
    this.body.scrollTop = 0;
    const chips = el("div", "zw-watch-chips");
    const choices: { id: string; label: string; collection?: WatchCollection }[] = [
      { id: LATEST, label: "Latest" },
      ...listing.collections.map((collection) => ({ id: collection.id, label: collection.title, collection })),
    ];
    for (const choice of choices) {
      const chip = el("button", `zw-watch-chip-button${choice.id === this.replays.collection ? " active" : ""}`);
      chip.dataset.collection = choice.id;
      chip.textContent = choice.label;
      if (choice.collection) {
        const count = el("span", "zw-watch-chip-count");
        count.textContent = String(choice.collection.count);
        chip.append(" ", count);
        if (choice.collection.description) chip.title = choice.collection.description;
      }
      chip.addEventListener("click", () => {
        this.replays = { collection: choice.id, videos: [], page: 0, pages: 1, filter: this.replays.filter };
        void this.renderReplays(listing);
      });
      chips.appendChild(chip);
    }
    const filter = document.createElement("input");
    filter.className = "zw-input zw-watch-filter";
    filter.type = "search";
    filter.placeholder = "Filter by title or channel…";
    filter.value = this.replays.filter;
    filter.setAttribute("aria-label", "Filter replays");
    filter.addEventListener("keydown", (event) => blurOnEscape(event, filter));
    filter.addEventListener("keyup", (event) => event.stopPropagation());
    filter.addEventListener("input", () => {
      this.replays.filter = filter.value;
      this.renderReplaysGrid();
    });
    const grid = el("div", "zw-watch-grid");
    const more = el("div", "zw-watch-more");
    this.body.append(chips, filter, grid, more);

    if (this.replays.collection === LATEST) {
      this.replays.videos = listing.latest;
      this.replays.pages = 1;
      this.renderReplaysGrid();
      return;
    }
    const token = ++this.renderToken;
    grid.replaceChildren(statusLine("Loading…"));
    try {
      const page = await this.client.collection(this.replays.collection, 0);
      if (token !== this.renderToken) return;
      this.replays.videos = page.videos;
      this.replays.page = page.page;
      this.replays.pages = page.pages;
      this.setFooter(listing, listing.stale || page.stale);
      this.renderReplaysGrid();
    } catch (error) {
      if (token !== this.renderToken) return;
      console.warn("[watch] collection failed:", error instanceof Error ? error.message : error);
      const retry = el("button", "zw-button zw-watch-retry");
      retry.textContent = "Retry";
      retry.addEventListener("click", () => void this.renderReplays(listing));
      grid.replaceChildren(statusLine("Couldn't load this collection."), retry);
    }
  }

  /** Redraws the replay cards from the loaded videos and the filter (no network). */
  private renderReplaysGrid(): void {
    const grid = this.body.querySelector(".zw-watch-grid");
    const more = this.body.querySelector(".zw-watch-more");
    if (!grid || !more) return;
    const shown = this.replays.videos.filter((video) => matchesFilter(`${video.title} ${video.channel}`, this.replays.filter));
    grid.replaceChildren(...shown.map((video) => this.videoCard(video, false)));
    if (shown.length === 0) grid.appendChild(statusLine(this.replays.filter ? "No replays match this filter." : "No replays here yet."));
    more.replaceChildren();
    if (this.replays.collection !== LATEST && this.replays.page + 1 < this.replays.pages) {
      const button = el("button", "zw-button zw-watch-load-more");
      button.textContent = "Load more";
      button.addEventListener("click", () => void this.loadMoreReplays(button));
      more.appendChild(button);
    }
  }

  private async loadMoreReplays(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    const collection = this.replays.collection;
    try {
      const page = await this.client.collection(collection, this.replays.page + 1);
      if (collection !== this.replays.collection) return;
      const known = new Set(this.replays.videos.map((video) => video.id));
      this.replays.videos = [...this.replays.videos, ...page.videos.filter((video) => !known.has(video.id))];
      this.replays.page = page.page;
      this.replays.pages = page.pages;
      this.renderReplaysGrid();
    } catch {
      button.disabled = false;
      button.textContent = "Retry loading more";
    }
  }
}

// ---------------------------------------------------------------- helpers (module-private, CommunityPanel style)

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function statusLine(text: string): HTMLElement {
  const line = el("p", "zw-watch-status");
  line.textContent = text;
  return line;
}

function noteLine(text: string): HTMLElement {
  const line = el("p", "zw-watch-note");
  line.textContent = text;
  return line;
}

function sectionTitle(text: string): HTMLElement {
  const title = el("div", "zw-watch-section");
  title.textContent = text;
  return title;
}

function liveBadge(): HTMLElement {
  const badge = el("span", "zw-watch-badge zw-watch-badge-live");
  badge.textContent = "LIVE";
  return badge;
}

function thumbFallback(): HTMLElement {
  const fallback = el("div", "zw-watch-thumb-fallback");
  fallback.textContent = "No preview";
  return fallback;
}

/** Explicit "leave the game" link: https only, new tab, no referrer. */
function externalLink(label: string, url: string, primary = false): HTMLElement {
  const link = el("a", `zw-button${primary ? " zw-button-primary" : ""} zw-watch-external`);
  link.textContent = label;
  if (/^https:\/\//.test(url)) {
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  return link;
}

/** Typed keys never reach the game; Esc leaves the field, so the next Esc closes the panel. */
function blurOnEscape(event: KeyboardEvent, input: HTMLInputElement): void {
  event.stopPropagation();
  if (event.key === "Escape") input.blur();
}

/** "Add to calendar": a file made in the browser from the listing — no request anywhere. */
function downloadIcs(event: WatchEvent, now: number): void {
  const url = URL.createObjectURL(new Blob([eventToIcs(event, now)], { type: "text/calendar" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${event.id}.ics`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let stylesInjected = false;
function injectWatchStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.zw-watch-backdrop { position: absolute; inset: 0; z-index: 20; display: none; align-items: center; justify-content: center; background: rgba(8,6,16,0.6); }
.zw-watch-backdrop.visible { display: flex; }
.zw-watch { width: min(980px, 94vw); height: min(780px, 90vh); display: flex; flex-direction: column; padding: 0; overflow: hidden;
  background: linear-gradient(180deg, rgba(40,28,20,0.97), rgba(22,16,14,0.97)); border: 2px solid rgba(160,108,56,0.85); }
.zw-watch-header { display: flex; align-items: center; gap: 14px; padding: 14px 18px; border-bottom: 1px solid rgba(201,138,60,0.35); flex-wrap: wrap; }
.zw-watch-title { font: 700 22px Georgia, "Times New Roman", serif; color: #f4e3c1; }
.zw-watch-tabs { display: flex; gap: 4px; flex: 1; flex-wrap: wrap; }
.zw-watch-tab { background: rgba(255,255,255,0.06); color: #d9cdb8; border: 1px solid transparent; border-radius: 8px; padding: 6px 14px; font: 600 13px "Segoe UI", system-ui, sans-serif; cursor: pointer; }
.zw-watch-tab.active { background: rgba(227,154,45,0.25); border-color: rgba(227,154,45,0.6); color: #fff3dc; }
.zw-watch-count { display: inline-block; min-width: 18px; padding: 0 6px; border-radius: 999px; background: rgba(255,255,255,0.12); font-size: 11px; line-height: 18px; text-align: center; }
.zw-watch-count-live { background: #d83a34; color: #fff; }
.zw-watch-toast { display: none; padding: 8px 18px; background: rgba(143,227,176,0.14); border-bottom: 1px solid rgba(143,227,176,0.4); color: #cff3dc; font-size: 13px; }
.zw-watch-toast.visible { display: block; }
.zw-watch-body { flex: 1; overflow-y: auto; padding: 16px 20px; }
.zw-watch-footer { display: flex; align-items: center; gap: 10px; padding: 10px 18px; border-top: 1px solid rgba(201,138,60,0.25); font-size: 12px; color: #bfae96; }
.zw-watch-status { color: #cdbda5; font-size: 13px; line-height: 1.5; margin: 0 0 12px; }
.zw-watch-note { color: #a8987f; font-size: 12px; font-style: italic; margin: 14px 0 0; }
.zw-watch-section { margin: 14px 0 8px; font: 700 13px "Segoe UI", system-ui, sans-serif; color: #e8c58a; text-transform: uppercase; letter-spacing: 0.06em; }
.zw-watch-list { display: flex; flex-direction: column; gap: 10px; }
.zw-watch-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.zw-watch-grid .zw-watch-video { flex-direction: column; }
.zw-watch-grid .zw-watch-thumb { width: 100%; }
.zw-watch-card { display: flex; gap: 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(201,138,60,0.2); background: rgba(10,8,6,0.45); color: #f1e9dd; }
.zw-watch-card:hover { border-color: rgba(227,154,45,0.5); }
.zw-watch-ended { opacity: 0.6; }
.zw-watch-stage { border-color: rgba(216,58,52,0.75); background: linear-gradient(135deg, rgba(216,58,52,0.18), rgba(10,8,6,0.45)); align-items: center; margin-bottom: 12px; }
.zw-watch-is-live { border-color: rgba(216,58,52,0.6); }
.zw-watch-thumb { position: relative; flex: none; width: 240px; aspect-ratio: 16 / 9; border-radius: 8px; overflow: hidden; background: rgba(255,255,255,0.05); }
.zw-watch-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.zw-watch-thumb-fallback { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: #9d8f7a; font-size: 12px; font-style: italic; }
.zw-watch-thumb .zw-watch-badge-live { position: absolute; left: 6px; top: 6px; }
.zw-watch-duration, .zw-watch-viewers { position: absolute; bottom: 6px; padding: 1px 6px; border-radius: 4px; background: rgba(0,0,0,0.78); color: #fff; font: 700 11px "Segoe UI", system-ui, sans-serif; }
.zw-watch-duration { right: 6px; } .zw-watch-viewers { left: 6px; }
.zw-watch-card-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
.zw-watch-card-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.zw-watch-card-title { font: 700 14px "Segoe UI", system-ui, sans-serif; color: #f4e3c1; overflow-wrap: anywhere; }
.zw-watch-card-meta { font-size: 12px; color: #bfae96; }
.zw-watch-when { font-size: 12px; color: #e8c58a; font-weight: 600; }
.zw-watch-summary { font-size: 12px; color: #d4c6b0; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.zw-watch-badge { display: inline-block; padding: 1px 7px; border-radius: 4px; font: 800 11px "Segoe UI", system-ui, sans-serif; letter-spacing: 0.06em; align-self: flex-start; }
.zw-watch-badge-live { background: #d83a34; color: #fff; }
.zw-watch-badge-soon { background: #e39a2d; color: #24170b; }
.zw-watch-chip { padding: 1px 8px; border-radius: 999px; background: rgba(255,255,255,0.07); border: 1px solid rgba(201,138,60,0.3); font-size: 11px; color: #e6d8c0; }
.zw-watch-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
.zw-watch-actions .zw-button { padding: 4px 10px; font-size: 12px; }
.zw-watch-actions a.zw-button { text-decoration: none; display: inline-block; }
.zw-watch-optin { font-weight: 400; opacity: 0.8; font-size: 11px; }
.zw-watch-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.zw-watch-chip-button { padding: 4px 11px; border-radius: 999px; background: rgba(255,255,255,0.07); border: 1px solid rgba(201,138,60,0.3); color: #e6d8c0; font: 600 12px "Segoe UI", system-ui, sans-serif; cursor: pointer; }
.zw-watch-chip-button.active { background: rgba(227,154,45,0.28); border-color: rgba(227,154,45,0.7); color: #fff3dc; }
.zw-watch-chip-count { opacity: 0.7; font-weight: 400; }
.zw-watch-filter { width: 100%; margin: 0 0 12px; }
.zw-watch-more { display: flex; justify-content: center; margin-top: 12px; }
@media (max-width: 720px) {
  .zw-watch-card { flex-direction: column; }
  .zw-watch-thumb { width: 100%; }
}
`;
  document.head.appendChild(style);
}
