import { HALL_VIDEO_ID_PATTERN, type HallCard } from "@project/shared";
import { routeLink } from "../community/links.ts";
import { injectUiStyles } from "../ui/styles.ts";
import { linkKindLabel } from "./cardForm.ts";
import { cleanHallCardUrl } from "./hallCard.ts";
import { supportsCredentialless } from "../watch/youtube.ts";

/**
 * The speaker / project card as a DOM dialog (docs/architecture/WATCH_HALL.md),
 * opened with E at the card under the stage (`wh-card`) or from the HUD's "Now on stage"
 * chip, which slides in at the right while the hall is active and the stage has a card (the
 * WorldHud featured-panel pattern).
 *
 *  - Title, presenter (from presence), speaker, project — all textContent.
 *  - Links: re-checked with hallCard.ts (https, allowlisted host). GitHub / ZecHub / forum links the
 *    Community Hub can show open in the game (community/links.ts); everything is still a real
 *    `<a target="_blank" rel="noopener noreferrer">`, so anything else is an explicit new tab.
 *  - "Watch here" when the card has a YouTube id: the opt-in personal player (it asks first).
 */

export interface SpeakerCardView {
  readonly mode: "live" | "preparing" | "next";
  readonly card: Readonly<HallCard> | null;
  /** The holder's nickname from presence ("You" for the local player); null while nobody holds the stage. */
  readonly presenter: string | null;
  /** The live share carries sound. */
  readonly audio: boolean;
}

export interface SpeakerCardCallbacks {
  /** In-game routing (CommunityPanel.openLink). False → the link opens in a new tab instead. */
  readonly openInGame: (href: string) => boolean;
  /** "Watch here": the opt-in personal YouTube player. */
  readonly watchHere: (video: { id: string; title: string }) => void;
}

const MODE_LABEL: Record<SpeakerCardView["mode"], string> = { live: "LIVE", preparing: "STARTING", next: "UP NEXT" };

export class SpeakerCardPanel {
  private readonly callbacks: SpeakerCardCallbacks;
  private readonly backdrop: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly chip: HTMLButtonElement;
  private readonly chipLabel: HTMLSpanElement;
  private readonly chipTitle: HTMLSpanElement;
  private readonly chipMeta: HTMLSpanElement;
  private view: SpeakerCardView | null = null;
  private renderedKey = "";

  /** `chipParent`: where the HUD chip goes (the stage widget's dock slot, so the two stack under the minimap). */
  constructor(container: HTMLElement, callbacks: SpeakerCardCallbacks, chipParent: HTMLElement = container) {
    injectUiStyles();
    injectSpeakerCardStyles();
    this.callbacks = callbacks;

    this.backdrop = el("div", "zw-ui zw-speaker-card-backdrop");
    const panel = el("div", "zw-panel zw-speaker-card");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "Speaker card");
    this.body = el("div", "zw-speaker-card-body");
    const close = el("button", "zw-button zw-speaker-card-close");
    close.type = "button";
    close.textContent = "Close (Esc)";
    close.setAttribute("aria-label", "Close (Esc) the speaker card");
    close.addEventListener("click", () => this.close());
    panel.append(this.body, close);
    this.backdrop.appendChild(panel);
    this.backdrop.addEventListener("click", (event) => {
      if (event.target === this.backdrop) this.close();
    });
    this.backdrop.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        this.close();
      }
    });
    container.appendChild(this.backdrop);

    this.chip = el("button", "zw-ui zw-panel zw-now-on-stage");
    this.chip.type = "button";
    this.chipLabel = el("span", "zw-now-on-stage-label");
    this.chipTitle = el("span", "zw-now-on-stage-title");
    this.chipMeta = el("span", "zw-now-on-stage-meta");
    this.chip.append(this.chipLabel, this.chipTitle, this.chipMeta);
    this.chip.addEventListener("click", () => {
      this.chip.blur();
      this.open();
    });
    this.setChipVisible(false);
    chipParent.appendChild(this.chip);
  }

  get isOpen(): boolean {
    return this.backdrop.classList.contains("visible");
  }

  /** The stage's card as the hall sees it (null while nobody holds the stage and no card is set), and whether the hall is active. */
  setView(view: SpeakerCardView | null, inHall: boolean): void {
    this.view = view;
    const card = view?.card ?? null;
    const showChip = inHall && card !== null;
    if (showChip && view && card) {
      this.chipLabel.textContent = view.mode === "next" ? "Up next" : "🎬 Now on stage";
      this.chipTitle.textContent = card.title;
      this.chipMeta.textContent = [view.presenter, card.speaker && card.speaker !== view.presenter ? card.speaker : null, card.project].filter(Boolean).join(" · ");
      this.chip.setAttribute("aria-label", `${view.mode === "next" ? "Up next" : "Now on stage"}: ${card.title}. Open the speaker card`);
    }
    this.setChipVisible(showChip);
    if (this.isOpen) this.render();
  }

  open(): void {
    document.exitPointerLock?.();
    this.renderedKey = "";
    this.render();
    this.backdrop.classList.add("visible");
    this.backdrop.querySelector<HTMLElement>(".zw-speaker-card-close")?.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.isOpen) return;
    this.backdrop.classList.remove("visible");
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.backdrop.contains(active)) active.blur();
  }

  dispose(): void {
    this.backdrop.remove();
    this.chip.remove();
  }

  private setChipVisible(visible: boolean): void {
    // `hidden` takes it out of the layout and the accessibility tree; `.visible` slides it in (WorldHud featured-panel style).
    this.chip.hidden = !visible;
    this.chip.classList.toggle("visible", visible);
  }

  private render(): void {
    const key = JSON.stringify(this.view);
    if (key === this.renderedKey) return;
    this.renderedKey = key;
    const view = this.view;
    const card = view?.card ?? null;
    this.body.replaceChildren();

    const top = el("div", "zw-speaker-card-top");
    const pill = el("span", "zw-speaker-card-pill");
    pill.dataset.mode = view?.mode ?? "idle";
    pill.textContent = view ? MODE_LABEL[view.mode] : "OPEN STAGE";
    top.appendChild(pill);
    if (view?.mode === "live") {
      const sound = el("span", "zw-speaker-card-sound");
      sound.textContent = view.audio ? "🔊 with sound" : "no sound";
      top.appendChild(sound);
    }
    this.body.appendChild(top);

    const title = el("h2", "zw-speaker-card-title");
    title.textContent = card?.title ?? (view?.presenter ? `${view.presenter} ${view.presenter === "You" ? "are" : "is"} on stage` : "Nobody is on stage");
    this.body.appendChild(title);

    const facts = el("dl", "zw-speaker-card-facts");
    const fact = (label: string, value: string | null | undefined): void => {
      if (!value) return;
      const dt = el("dt", "");
      dt.textContent = label;
      const dd = el("dd", "");
      dd.textContent = value;
      facts.append(dt, dd);
    };
    fact("Presented by", view?.presenter);
    fact("Speaker", card?.speaker);
    fact("Project", card?.project);
    if (facts.childElementCount > 0) this.body.appendChild(facts);

    if (!card) {
      const empty = el("p", "zw-speaker-card-empty");
      empty.textContent = view?.presenter ? "The presenter hasn't set a card yet." : "Request the stage at the podium to share a talk, a demo or a stream with everyone in the hall.";
      this.body.appendChild(empty);
      return;
    }

    const links = (card.links ?? []).map((link) => ({ kind: link.kind, url: cleanHallCardUrl(link.url) })).filter((link): link is { kind: typeof link.kind; url: string } => link.url !== null);
    if (links.length > 0) {
      const list = el("div", "zw-speaker-card-links");
      for (const link of links) list.appendChild(this.linkElement(link.kind, link.url));
      this.body.appendChild(list);
    }

    if (card.videoId && HALL_VIDEO_ID_PATTERN.test(card.videoId)) {
      const videoId = card.videoId;
      // Chromium embeds without the viewer's cookies after a consent dialog; other browsers open
      // youtube.com in a new tab (with that site's cookies), and the button says exactly that.
      const embeds = supportsCredentialless();
      const watch = el("button", "zw-button zw-button-primary zw-speaker-card-watch");
      watch.type = "button";
      watch.textContent = embeds ? "▶ Watch here" : "▶ Open on YouTube ↗";
      watch.setAttribute("aria-label", embeds ? "Watch here — opens the opt-in YouTube player (asks first)" : "Open the video on youtube.com in a new tab");
      watch.addEventListener("click", () => {
        this.close();
        this.callbacks.watchHere({ id: videoId, title: card.title });
      });
      const note = el("p", "zw-speaker-card-note");
      note.textContent = embeds
        ? "Watch here opens YouTube in your own player after you agree — the big screen keeps playing for the hall."
        : "Opens youtube.com in a new tab, which sees your IP address and your YouTube cookies. The big screen keeps playing for the hall.";
      this.body.append(watch, note);
    }
  }

  private linkElement(kind: Parameters<typeof linkKindLabel>[0], url: string): HTMLAnchorElement {
    const parsed = new URL(url);
    const a = el("a", "zw-button zw-speaker-card-link");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    const label = el("span", "zw-speaker-card-link-kind");
    const inGame = routeLink(url) !== null;
    label.textContent = `${linkKindLabel(kind)}${inGame ? "" : " ↗"}`;
    const where = el("span", "zw-speaker-card-link-url");
    where.textContent = `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
    a.append(label, where);
    if (inGame) {
      a.classList.add("zw-ingame-link");
      a.title = "Opens here in the game";
      a.setAttribute("aria-label", `${linkKindLabel(kind)}: ${where.textContent} (opens in the game)`);
      a.addEventListener("click", (event) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return; // a modified click still gets a new tab
        event.preventDefault();
        this.close();
        if (!this.callbacks.openInGame(url)) window.open(url, "_blank", "noopener,noreferrer");
      });
    } else {
      a.title = "Opens in a new tab";
      a.setAttribute("aria-label", `${linkKindLabel(kind)}: ${where.textContent} (opens in a new tab)`);
    }
    return a;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

let stylesInjected = false;
function injectSpeakerCardStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.zw-speaker-card-backdrop { position: absolute; inset: 0; z-index: 21; display: none; align-items: center; justify-content: center; background: rgba(4,5,10,0.55); }
.zw-speaker-card-backdrop.visible { display: flex; }
.zw-speaker-card { width: min(520px, 94vw); max-height: 86vh; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding: 18px 20px; backdrop-filter: none;
  background: linear-gradient(180deg, rgba(62,40,22,0.97), rgba(32,21,12,0.97)); border: 2px solid rgba(166,112,52,0.92); box-shadow: 0 12px 32px rgba(0,0,0,0.5); }
.zw-speaker-card-close { align-self: flex-end; }
.zw-speaker-card-body { display: flex; flex-direction: column; gap: 10px; }
.zw-speaker-card-top { display: flex; align-items: center; gap: 10px; }
.zw-speaker-card-pill { padding: 3px 10px; border-radius: 6px; font: 800 12px "Segoe UI", system-ui, sans-serif; letter-spacing: 0.05em; background: #5d6b8a; color: #fff; }
.zw-speaker-card-pill[data-mode="live"] { background: #d8323a; }
.zw-speaker-card-pill[data-mode="preparing"] { background: #e39a2d; color: #24170b; }
.zw-speaker-card-pill[data-mode="next"] { background: #5b63c8; }
.zw-speaker-card-sound { color: #d8c8a8; font-size: 12px; }
.zw-speaker-card-title { margin: 0; font: 700 22px Georgia, "Times New Roman", serif; color: #f4e3c1; overflow-wrap: anywhere; }
.zw-speaker-card-facts { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; font-size: 13px; }
.zw-speaker-card-facts dt { color: #d9b77a; font-weight: 600; }
.zw-speaker-card-facts dd { margin: 0; color: #f1e9dd; overflow-wrap: anywhere; }
.zw-speaker-card-empty, .zw-speaker-card-note { margin: 0; color: #cdbfa6; font-size: 12px; line-height: 1.5; }
.zw-speaker-card-links { display: flex; flex-direction: column; gap: 6px; }
.zw-speaker-card-link { display: flex; align-items: baseline; gap: 10px; text-align: left; }
.zw-speaker-card-link-kind { font-weight: 700; color: #f6deb0; min-width: 72px; }
.zw-speaker-card-link-url { color: #cdbfa6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.zw-speaker-card-watch { align-self: flex-start; }
.zw-now-on-stage { flex: none; width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 8px 12px; text-align: left; cursor: pointer; backdrop-filter: none;
  background: linear-gradient(180deg, rgba(58,38,22,0.94), rgba(36,24,14,0.94)); border: 2px solid rgba(140,92,48,0.9); color: #f1e9dd; font-family: inherit; }
.zw-now-on-stage[hidden] { display: none; }
.zw-now-on-stage.visible { animation: zw-now-on-stage-in 0.25s ease; }
@keyframes zw-now-on-stage-in { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: none; } }
.zw-now-on-stage:hover, .zw-now-on-stage:focus-visible { border-color: rgba(240,195,94,0.9); outline: none; }
.zw-now-on-stage-label { font: 800 11px "Segoe UI", system-ui, sans-serif; letter-spacing: 0.06em; text-transform: uppercase; color: #f0c35e; }
.zw-now-on-stage-title { max-width: 100%; font: 700 15px Georgia, "Times New Roman", serif; color: #f4e3c1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zw-now-on-stage-meta { max-width: 100%; font-size: 11px; color: #cdbfa6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zw-now-on-stage-meta:empty { display: none; }
@media (prefers-reduced-motion: reduce) { .zw-now-on-stage.visible { animation: none; } }
@media (max-width: 720px) { .zw-now-on-stage.visible { display: none; } }
`;
  document.head.appendChild(style);
}
