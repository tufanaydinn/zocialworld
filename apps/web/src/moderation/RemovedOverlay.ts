import type { ModCloseReason } from "@project/shared";
import { removedText } from "./format.ts";
import { button, el, injectModerationStyles } from "./ui.ts";

/**
 * The full-screen notice when the server closed this connection on purpose (ADR-019 §§ 3, 5): kicked
 * ("you can come back at 14:32"), banned ("until …" / "until a moderator lifts it"), or too many connections from this
 * network. The client does not reconnect on its own after these; "Try again" asks the server once more (it decides).
 */

export interface RemovedOverlayOptions {
  readonly container: HTMLElement;
  /** "Try again": reconnect (NetworkClient.reconnect). */
  readonly retry: () => void;
  readonly now?: () => number;
}

export class RemovedOverlay {
  private readonly options: RemovedOverlayOptions;
  private root: HTMLDivElement | null = null;

  constructor(options: RemovedOverlayOptions) {
    this.options = options;
  }

  get isOpen(): boolean {
    return this.root !== null;
  }

  show(reason: ModCloseReason, until: number | null): void {
    injectModerationStyles();
    this.hide();
    const text = removedText(reason, until, (this.options.now ?? Date.now)());
    const root = el("div", `zw-ui zw-removed zw-removed-${reason}`);
    root.setAttribute("role", "alertdialog");
    root.setAttribute("aria-modal", "true");
    const card = el("div", "zw-panel zw-removed-card");
    const title = el("h2", "zw-removed-title");
    title.textContent = text.title;
    title.id = "zw-removed-title";
    root.setAttribute("aria-labelledby", title.id);
    const detail = el("p", "zw-removed-detail");
    detail.textContent = text.detail;
    const note = el("p", "zw-mod-note");
    note.textContent =
      reason === "too_many_connections"
        ? "Each network may have a few game tabs open at once, and open only a few new connections a minute."
        : "Moderation keeps the game friendly for everyone. Your wallet and anything you own are not affected.";
    const actions = el("div", "zw-mod-actions");
    actions.append(
      button("Try again", "Connect to the game server again", () => {
        this.hide();
        this.options.retry();
      }, true),
    );
    card.append(title, detail, note, actions);
    root.appendChild(card);
    document.exitPointerLock?.();
    this.options.container.appendChild(root);
    this.root = root;
  }

  hide(): void {
    this.root?.remove();
    this.root = null;
  }
}
