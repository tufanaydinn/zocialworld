import { REPORT_NOTE_MAX, REPORT_REASONS, type ReportAckStatus, type ReportReason } from "@project/shared";
import { REPORT_REASON_LABELS, reportAckText } from "./format.ts";
import { button, choiceGroup, el, openModDialog, type ModDialogParts } from "./ui.ts";

/**
 * "Report" from the player menu (ADR-019 § 2): a reason, an optional note (at most 280 characters), and
 * a plain statement of what moderators see — the reporter's nickname, so a false report can be judged — and that the
 * reported player is never told who reported them. The server answers with `report_ack`; `sent` closes the dialog
 * ("Thanks — moderators were notified"), anything else is shown in it. Nothing is stored here.
 */

export interface ReportDialogOptions {
  readonly container: HTMLElement;
  readonly nickname: string;
  /** The reported player is a moderator: the report goes to the other moderators only, so the reported moderator never sees it. */
  readonly moderator?: boolean;
  /** Sends the report (App: NetworkClient.sendReport). */
  readonly send: (reason: ReportReason, note: string | undefined) => void;
  /** The dialog closed (sent, cancelled or Esc). */
  readonly onClose: () => void;
  /** The thank-you line after a `sent` ack (App: a chat system line). */
  readonly onSent: (text: string) => void;
}

const ACK_TIMEOUT_MS = 8000;

export class ReportDialog {
  private readonly parts: ModDialogParts;
  private readonly options: ReportDialogOptions;
  private readonly status: HTMLParagraphElement;
  private readonly submit: HTMLButtonElement;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private waiting = false;

  constructor(options: ReportDialogOptions) {
    this.options = options;
    this.parts = openModDialog(options.container, "zw-report-backdrop", `Report ${options.nickname}`, () => {
      if (this.timer) clearTimeout(this.timer);
      options.onClose();
    });
    const panel = this.parts.panel;
    panel.classList.add("zw-report-dialog");
    const reasons = choiceGroup(
      "What's wrong?",
      "zw-report-reason",
      REPORT_REASONS.map((reason) => ({ value: reason, label: REPORT_REASON_LABELS[reason] })),
      0,
    );
    const field = el("label", "zw-mod-field");
    const fieldText = el("span", "");
    fieldText.textContent = "Note for the moderators (optional)";
    const note = el("textarea", "zw-input zw-report-note");
    note.maxLength = REPORT_NOTE_MAX;
    note.rows = 3;
    note.placeholder = "What happened? (no personal details needed)";
    note.setAttribute("aria-label", "Note for the moderators");
    const count = el("span", "zw-mod-count");
    const updateCount = (): void => void (count.textContent = `${note.value.length} / ${REPORT_NOTE_MAX}`);
    note.addEventListener("input", updateCount);
    updateCount();
    field.append(fieldText, note, count);
    const privacy = el("p", "zw-mod-privacy zw-report-privacy");
    const told = options.moderator
      ? `${options.nickname} is a moderator: this report goes to the other moderators only — ${options.nickname} never sees it or who sent it.`
      : `${options.nickname} is never told who reported them.`;
    privacy.textContent = `Moderators will see your nickname with this report, so they can judge it. ${told} No chat history is attached — the server keeps none — and the report isn't saved anywhere; it disappears after 24 hours or once a moderator handles it.`;
    this.status = el("p", "zw-mod-status");
    this.status.setAttribute("role", "status");
    const actions = el("div", "zw-mod-actions");
    this.submit = el("button", "zw-button zw-button-primary");
    this.submit.type = "submit";
    this.submit.textContent = "Send report";
    actions.append(this.submit, button("Cancel", "Close without reporting", () => this.close()));
    panel.append(reasons.element, field, privacy, this.status, actions);
    panel.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.waiting) return;
      const text = note.value.trim();
      this.waiting = true;
      this.submit.disabled = true;
      this.status.classList.remove("bad");
      this.status.textContent = "Sending…";
      options.send(reasons.value(), text.length > 0 ? text : undefined);
      this.timer = setTimeout(() => this.fail("No answer from the server — try again."), ACK_TIMEOUT_MS);
    });
    note.focus();
  }

  /** The server's answer. */
  acknowledge(status: ReportAckStatus): void {
    if (!this.waiting) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.waiting = false;
    if (status === "sent") {
      this.options.onSent(reportAckText("sent", this.options.nickname));
      this.close();
      return;
    }
    this.fail(reportAckText(status, this.options.nickname));
  }

  close(): void {
    this.parts.close();
  }

  private fail(text: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.waiting = false;
    this.submit.disabled = false;
    this.status.textContent = text;
    this.status.classList.add("bad");
  }
}
