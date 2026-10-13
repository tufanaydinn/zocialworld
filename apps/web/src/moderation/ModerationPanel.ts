import type { ModActionMessage, ModBanEntry, ModLogEntry, ModMuteEntry, ModReport } from "@project/shared";
import { LOCATION_LABELS, REPORT_REASON_LABELS, formatClock, formatDuration, formatUntil } from "./format.ts";
import type { ModerationStore } from "./ModerationStore.ts";
import type { ModerationTargetRef, ModerationVerb } from "./ModerationActionDialog.ts";
import { button, el, openModDialog, type ModDialogParts } from "./ui.ts";

/**
 * The Moderation panel (ADR-019 § 3), for moderators only: the report queue (Mute… / Kick / Ban… /
 * Dismiss on each — also after the reported player left), the active bans and mutes (Unban / Unmute), and the
 * moderation log. It renders ModerationStore (the server's state, resent after every change) and never keeps
 * anything itself. Names and notes are rendered with textContent only.
 */

export type ModerationTab = "reports" | "active" | "log";

export interface ModerationPanelOptions {
  readonly container: HTMLElement;
  readonly store: ModerationStore;
  /** Opens the Mute… / Kick / Ban… dialog for a target. */
  readonly moderate: (verb: ModerationVerb, target: ModerationTargetRef) => void;
  /** Sends an action that needs no dialog (unban, unmute, dismiss). */
  readonly send: (message: Omit<ModActionMessage, "type">) => void;
  readonly onClose?: () => void;
  readonly now?: () => number;
}

export class ModerationPanel {
  private readonly options: ModerationPanelOptions;
  private readonly now: () => number;
  private parts: ModDialogParts | null = null;
  private list: HTMLDivElement | null = null;
  private readonly tabs = new Map<ModerationTab, HTMLButtonElement>();
  private tab: ModerationTab = "reports";
  private unsubscribe: (() => void) | null = null;

  constructor(options: ModerationPanelOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  get isOpen(): boolean {
    return this.parts !== null;
  }

  open(tab: ModerationTab = this.tab): void {
    this.tab = tab;
    if (this.parts) {
      this.render();
      return;
    }
    this.parts = openModDialog(
      this.options.container,
      "zw-moderation-backdrop",
      "Moderation",
      () => {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.parts = null;
        this.list = null;
        this.tabs.clear();
        this.options.onClose?.();
      },
      true,
    );
    const panel = this.parts.panel;
    panel.classList.add("zw-moderation-panel");
    const intro = el("p", "zw-mod-note");
    intro.textContent = "Reports, the log and short bans live in the server's memory only (gone on restart). Moderators never see addresses, wallets or IPs.";
    const tabs = el("div", "zw-mod-tabs");
    tabs.setAttribute("role", "tablist");
    for (const id of ["reports", "active", "log"] as const) {
      const tabButton = el("button", "zw-mod-tab");
      tabButton.type = "button";
      tabButton.setAttribute("role", "tab");
      tabButton.dataset.tab = id;
      tabButton.addEventListener("click", () => {
        this.tab = id;
        this.render();
      });
      this.tabs.set(id, tabButton);
      tabs.appendChild(tabButton);
    }
    this.list = el("div", "zw-mod-list");
    const actions = el("div", "zw-mod-actions");
    actions.append(button("Close", "Close the Moderation panel (Esc)", () => this.close()));
    panel.append(intro, tabs, this.list, actions);
    this.unsubscribe = this.options.store.subscribe((event) => {
      if (event.type === "change") this.render();
    });
    this.render();
  }

  close(): void {
    this.parts?.close();
  }

  dispose(): void {
    this.close();
  }

  // ------------------------------------------------------------------

  private render(): void {
    const list = this.list;
    if (!list) return;
    const store = this.options.store;
    if (this.tab === "reports") store.markSeen();
    const labels: Record<ModerationTab, string> = {
      reports: `Reports (${store.reports.length})`,
      active: `Bans & mutes (${store.bans.length + store.mutes.length})`,
      log: "Log",
    };
    for (const [id, tabButton] of this.tabs) {
      tabButton.textContent = labels[id];
      tabButton.setAttribute("aria-selected", String(id === this.tab));
    }
    list.replaceChildren();
    if (this.tab === "reports") this.renderReports(list, store.reports);
    else if (this.tab === "active") this.renderActive(list, store.bans, store.mutes);
    else this.renderLog(list, store.log);
  }

  private renderReports(list: HTMLDivElement, reports: readonly ModReport[]): void {
    if (reports.length === 0) {
      list.appendChild(empty("No open reports. New ones appear here (and as a chat line) as they arrive."));
      return;
    }
    for (const report of reports) {
      const row = el("div", "zw-mod-row zw-mod-report");
      row.dataset.reportId = report.id;
      const head = el("div", "zw-mod-row-head");
      const name = el("span", "zw-mod-row-name");
      name.textContent = report.target;
      const reason = el("span", "zw-mod-row-tag");
      reason.textContent = REPORT_REASON_LABELS[report.reason];
      head.append(name, reason);
      if (report.targetId === null) {
        const left = el("span", "zw-mod-row-tag left");
        left.textContent = "left";
        left.title = "No longer online — you can still mute or ban them from this report";
        head.appendChild(left);
      }
      const meta = el("span", "zw-mod-row-meta");
      meta.textContent = `${formatClock(report.t, this.now())} · ${LOCATION_LABELS[report.location]}`;
      head.appendChild(meta);
      row.appendChild(head);
      if (report.note) {
        const note = el("div", "zw-mod-row-note");
        note.textContent = report.note;
        row.appendChild(note);
      }
      const by = el("div", "zw-mod-row-by");
      by.textContent = `Reported by ${report.reporter}`;
      row.appendChild(by);
      const target: ModerationTargetRef = { nickname: report.target, playerId: report.targetId, reportId: report.id };
      const actions = el("div", "zw-mod-row-actions");
      actions.append(
        button("Mute…", `Mute ${report.target}`, () => this.options.moderate("mute", target)),
        button("Kick", `Kick ${report.target} (10 minutes)`, () => this.options.moderate("kick", target)),
        button("Ban…", `Ban ${report.target}`, () => this.options.moderate("ban", target)),
        button("Dismiss", "Nothing to do — remove this report", () => this.options.send({ action: "dismiss_report", reportId: report.id })),
      );
      row.appendChild(actions);
      list.appendChild(row);
    }
  }

  private renderActive(list: HTMLDivElement, bans: readonly ModBanEntry[], mutes: readonly ModMuteEntry[]): void {
    const now = this.now();
    const bansTitle = el("h4", "zw-mod-section-title");
    bansTitle.textContent = "Kicks and bans";
    list.appendChild(bansTitle);
    if (bans.length === 0) list.appendChild(empty("Nobody is kicked or banned."));
    for (const ban of bans) {
      const row = el("div", "zw-mod-row zw-mod-ban");
      row.dataset.entryId = ban.id;
      const head = el("div", "zw-mod-row-head");
      const name = el("span", "zw-mod-row-name");
      name.textContent = ban.nickname;
      const kind = el("span", "zw-mod-row-tag");
      kind.textContent = ban.kind === "kick" ? "Kicked" : "Banned";
      const meta = el("span", "zw-mod-row-meta");
      meta.textContent = formatUntil(ban.until, now);
      head.append(name, kind, meta);
      const by = el("div", "zw-mod-row-by");
      by.textContent = [ban.byName ? "by owned name" : null, ban.byConnection ? "by network (24 h at most)" : null].filter(Boolean).join(" · ");
      const actions = el("div", "zw-mod-row-actions");
      actions.append(button(ban.kind === "kick" ? "Lift kick" : "Unban", `Let ${ban.nickname} back in now`, () => this.options.send({ action: "unban", entryId: ban.id })));
      row.append(head, by, actions);
      list.appendChild(row);
    }
    const mutesTitle = el("h4", "zw-mod-section-title");
    mutesTitle.textContent = "Chat mutes";
    list.appendChild(mutesTitle);
    if (mutes.length === 0) list.appendChild(empty("Nobody is muted."));
    for (const mute of mutes) {
      const row = el("div", "zw-mod-row zw-mod-mute");
      row.dataset.entryId = mute.id;
      const head = el("div", "zw-mod-row-head");
      const name = el("span", "zw-mod-row-name");
      name.textContent = mute.nickname;
      const kind = el("span", "zw-mod-row-tag");
      kind.textContent = "Muted";
      const meta = el("span", "zw-mod-row-meta");
      meta.textContent = formatUntil(mute.until, now);
      head.append(name, kind, meta);
      const actions = el("div", "zw-mod-row-actions");
      actions.append(button("Unmute", `Let ${mute.nickname} chat again`, () => this.options.send({ action: "unmute", entryId: mute.id })));
      row.append(head, actions);
      list.appendChild(row);
    }
  }

  private renderLog(list: HTMLDivElement, log: readonly ModLogEntry[]): void {
    if (log.length === 0) {
      list.appendChild(empty("No moderation actions yet this server run."));
      return;
    }
    const verbs: Record<ModLogEntry["action"], string> = { mute: "muted", unmute: "unmuted", kick: "kicked", ban: "banned", unban: "lifted the ban on", dismiss_report: "dismissed a report about" };
    for (const entry of log) {
      const line = el("div", "zw-mod-log-line");
      const time = el("time", "");
      time.textContent = formatClock(entry.t, this.now());
      const text = el("span", "");
      const duration = entry.durationMs !== undefined && (entry.action === "mute" || entry.action === "ban") ? ` (${formatDuration(entry.durationMs)})` : "";
      text.textContent = `${entry.moderator} ${verbs[entry.action]} ${entry.target ?? "someone"}${duration}`;
      line.append(time, text);
      list.appendChild(line);
    }
  }
}

function empty(text: string): HTMLParagraphElement {
  const p = el("p", "zw-mod-empty");
  p.textContent = text;
  return p;
}
