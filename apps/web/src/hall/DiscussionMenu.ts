import { injectUiStyles } from "../ui/styles.ts";
import { nameColor } from "./boardFeeds.ts";
import type { HallPerson } from "./hallPeople.ts";

/**
 * The Discussion Corner menu (docs/architecture/WATCH_HALL.md), opened with E at
 * the hall's Discussion Corner board (`wh-discussion`). Four actions, like the board's tiles:
 *
 *  - Live Chat & Reactions — the Hall chat tab (and the emote wheel's reactions when available);
 *  - Share Takeaways — the Hall chat input prefilled with "💡 " (takeaways are highlighted);
 *  - Start a Discussion — the Community Hub's forum in-game, at the stage card's forum link if any;
 *  - Find Your People — who is in the hall, with seat, raised hand, stage, floor and speaking state;
 *    a row opens the existing player menu.
 *
 * App wires the actions; this class only draws them. Nicknames are rendered with textContent.
 */

export interface DiscussionMenuCallbacks {
  readonly onLiveChat: () => void;
  readonly onShareTakeaway: () => void;
  readonly onStartDiscussion: () => void;
  /** The current hall members (hallPeople.ts). */
  readonly people: () => HallPerson[];
  /** Opens the player menu for a member. */
  readonly onOpenPlayer: (playerId: string) => void;
}

type View = "menu" | "people";

const ACTIONS: readonly { id: "chat" | "takeaway" | "discussion" | "people"; icon: string; color: string; title: string; text: string }[] = [
  { id: "chat", icon: "💬", color: "#7c4dd8", title: "Live Chat & Reactions", text: "Talk with everyone in the hall · react with keys 1–8" },
  { id: "takeaway", icon: "💡", color: "#e08a2a", title: "Share Takeaways", text: "Post a key point — it's highlighted on the board" },
  { id: "discussion", icon: "🗣", color: "#2a9e92", title: "Start a Discussion", text: "Continue on the Zcash Community Forum, in the game" },
  { id: "people", icon: "👥", color: "#3d6fd8", title: "Find Your People", text: "Who's here, where they sit, raised hands and who's talking" },
];

export class DiscussionMenu {
  private readonly callbacks: DiscussionMenuCallbacks;
  private readonly backdrop: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly title: HTMLHeadingElement;
  private view: View = "menu";
  private peopleKey = "";
  private peopleList: HTMLUListElement | null = null;
  private peopleCount: HTMLSpanElement | null = null;
  private readonly peopleRows = new Map<string, PersonRow>();
  private peopleOrder: string[] = [];

  constructor(container: HTMLElement, callbacks: DiscussionMenuCallbacks) {
    injectUiStyles();
    injectDiscussionMenuStyles();
    this.callbacks = callbacks;
    this.backdrop = el("div", "zw-ui zw-hall-menu-backdrop");
    const panel = el("div", "zw-panel zw-hall-menu");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "zw-hall-menu-title");
    const header = el("div", "zw-hall-menu-header");
    this.title = el("h2", "zw-hall-menu-title");
    this.title.id = "zw-hall-menu-title";
    const close = el("button", "zw-button zw-hall-menu-close");
    close.type = "button";
    close.textContent = "Close (Esc)";
    close.setAttribute("aria-label", "Close (Esc) the Discussion Corner");
    close.addEventListener("click", () => this.close());
    header.append(this.title, close);
    this.body = el("div", "zw-hall-menu-body");
    panel.append(header, this.body);
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
  }

  get isOpen(): boolean {
    return this.backdrop.classList.contains("visible");
  }

  open(view: View = "menu"): void {
    document.exitPointerLock?.();
    this.backdrop.classList.add("visible");
    this.show(view);
  }

  close(): void {
    if (!this.isOpen) return;
    this.backdrop.classList.remove("visible");
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.backdrop.contains(active)) active.blur();
  }

  /** Re-draws the people list when it changed (App calls this on hall changes and about once a second). */
  refresh(): void {
    if (this.isOpen && this.view === "people") this.renderPeople(false);
  }

  dispose(): void {
    this.backdrop.remove();
  }

  private show(view: View): void {
    this.view = view;
    if (view === "people") {
      this.peopleKey = "";
      this.renderPeople(true);
      return;
    }
    this.title.textContent = "Discussion Corner";
    this.body.replaceChildren();
    const grid = el("div", "zw-hall-menu-actions");
    for (const action of ACTIONS) {
      const button = el("button", "zw-hall-menu-action");
      button.type = "button";
      button.dataset.action = action.id;
      button.setAttribute("aria-label", `${action.title}: ${action.text}`);
      const icon = el("span", "zw-hall-menu-icon");
      icon.style.background = action.color;
      icon.textContent = action.icon;
      icon.setAttribute("aria-hidden", "true");
      const text = el("span", "zw-hall-menu-text");
      const title = el("span", "zw-hall-menu-action-title");
      title.textContent = action.title;
      const detail = el("span", "zw-hall-menu-action-detail");
      detail.textContent = action.text;
      text.append(title, detail);
      button.append(icon, text);
      button.addEventListener("click", () => this.run(action.id));
      grid.appendChild(button);
    }
    this.body.appendChild(grid);
    grid.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }

  private run(id: (typeof ACTIONS)[number]["id"]): void {
    if (id === "people") {
      this.show("people");
      return;
    }
    this.close();
    if (id === "chat") this.callbacks.onLiveChat();
    else if (id === "takeaway") this.callbacks.onShareTakeaway();
    else this.callbacks.onStartDiscussion();
  }

  /**
   * The people list. App refreshes it about once a second and on every hall event, and speaking
   * state changes all the time, so when the same people are listed in the same order the rows are
   * updated IN PLACE: the focused row (keyboard, screen reader) and a mouse press in progress
   * survive. Only a change of who is listed (or their order) rebuilds the list, and then focus
   * goes back to the same person's row (or to Back if they left), never to <body>.
   */
  private renderPeople(focus: boolean): void {
    const people = this.callbacks.people();
    const key = JSON.stringify(people);
    if (key === this.peopleKey) return;
    this.peopleKey = key;
    this.title.textContent = "Find Your People";
    const order = people.map((person) => person.playerId);
    if (!focus && this.peopleList !== null && this.body.contains(this.peopleList) && order.length === this.peopleRows.size && order.every((id, index) => this.peopleOrder[index] === id)) {
      for (const person of people) this.fillPersonRow(this.peopleRows.get(person.playerId)!, person);
      if (this.peopleCount) this.peopleCount.textContent = `${people.length} in the hall`;
      return;
    }

    const active = document.activeElement;
    const hadFocus = active instanceof HTMLElement && this.body.contains(active);
    const focusedId = hadFocus ? ((active as HTMLElement).dataset.playerId ?? null) : null;
    const scroll = this.body.querySelector(".zw-hall-people")?.scrollTop ?? 0;
    this.body.replaceChildren();
    this.peopleRows.clear();
    this.peopleOrder = order;
    const top = el("div", "zw-hall-people-top");
    const back = el("button", "zw-button");
    back.type = "button";
    back.textContent = "← Back";
    back.setAttribute("aria-label", "Back to the Discussion Corner actions");
    back.addEventListener("click", () => this.show("menu"));
    const count = el("span", "zw-hall-people-count");
    count.textContent = `${people.length} in the hall`;
    this.peopleCount = count;
    top.append(back, count);
    this.body.appendChild(top);

    const list = el("ul", "zw-hall-people");
    list.setAttribute("aria-label", "People in the Watch Hall");
    this.peopleList = list;
    for (const person of people) {
      const item = el("li", "");
      const row = el("button", `zw-hall-person${person.self ? " zw-hall-person-self" : ""}`);
      row.type = "button";
      row.dataset.playerId = person.playerId;
      row.disabled = person.self;
      const swatch = el("span", "zw-hall-person-swatch");
      swatch.style.background = nameColor(person.playerId);
      swatch.setAttribute("aria-hidden", "true");
      const text = el("span", "zw-hall-person-text");
      const name = el("span", "zw-hall-person-name");
      const place = el("span", "zw-hall-person-place");
      text.append(name, place);
      const badges = el("span", "zw-hall-person-badges");
      row.append(swatch, text, badges);
      const parts: PersonRow = { row, name, place, badges, badgesKey: "", label: "" };
      this.fillPersonRow(parts, person);
      if (!person.self) {
        row.addEventListener("click", () => {
          this.close();
          this.callbacks.onOpenPlayer(person.playerId);
        });
      }
      this.peopleRows.set(person.playerId, parts);
      item.appendChild(row);
      list.appendChild(item);
    }
    this.body.appendChild(list);
    if (people.length <= 1) {
      const empty = el("p", "zw-hall-people-empty");
      empty.textContent = "Nobody else is here yet — invite a friend, or watch the replays on the Live Now board.";
      this.body.appendChild(empty);
    }
    list.scrollTop = scroll;
    const target = focusedId !== null ? this.peopleRows.get(focusedId)?.row : undefined;
    if (target && !target.disabled) target.focus({ preventScroll: true });
    else if (focus || hadFocus) back.focus({ preventScroll: true });
  }

  /** Writes one person's name, place and badges into their row; the aria-label changes only when what it says changes (speaking is a badge, not re-announced). */
  private fillPersonRow(parts: PersonRow, person: HallPerson): void {
    const name = person.self ? `${person.nickname} (you)` : person.nickname;
    if (parts.name.textContent !== name) parts.name.textContent = name;
    if (parts.place.textContent !== person.place) parts.place.textContent = person.place;
    const badges: [string, string][] = [];
    if (person.holder) badges.push(["🎤", "on stage"]);
    if (person.floor) badges.push(["🎙", "has the floor"]);
    if (person.hand > 0) badges.push([`✋${person.hand}`, `hand raised (#${person.hand})`]);
    if (person.speaking) badges.push(["🔊", "speaking"]);
    if (person.host) badges.push(["Host", "host"]);
    const badgesKey = JSON.stringify(badges);
    if (badgesKey !== parts.badgesKey) {
      parts.badgesKey = badgesKey;
      parts.badges.replaceChildren(
        ...badges.map(([symbol, label]) => {
          const span = el("span", "zw-hall-person-badge");
          span.textContent = symbol;
          span.title = label;
          return span;
        }),
      );
    }
    const states = badges.filter(([, label]) => label !== "speaking").map(([, label]) => label);
    const label = `${name} — ${person.place}${states.length ? `, ${states.join(", ")}` : ""}${person.self ? "" : ". Open the player menu"}`;
    if (label !== parts.label) {
      parts.label = label;
      parts.row.setAttribute("aria-label", label);
    }
  }
}

interface PersonRow {
  readonly row: HTMLButtonElement;
  readonly name: HTMLSpanElement;
  readonly place: HTMLSpanElement;
  readonly badges: HTMLSpanElement;
  badgesKey: string;
  label: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

let stylesInjected = false;
function injectDiscussionMenuStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.zw-hall-menu-backdrop { position: absolute; inset: 0; z-index: 21; display: none; align-items: center; justify-content: center; background: rgba(4,5,10,0.55); }
.zw-hall-menu-backdrop.visible { display: flex; }
.zw-hall-menu { width: min(560px, 94vw); max-height: 86vh; display: flex; flex-direction: column; gap: 10px; padding: 16px 18px; backdrop-filter: none;
  background: linear-gradient(180deg, rgba(62,40,22,0.97), rgba(32,21,12,0.97)); border: 2px solid rgba(166,112,52,0.92); box-shadow: 0 12px 32px rgba(0,0,0,0.5); }
.zw-hall-menu-header { display: flex; align-items: center; gap: 12px; }
.zw-hall-menu-title { flex: 1; margin: 0; font: 700 22px Georgia, "Times New Roman", serif; color: #f4e3c1; }
.zw-hall-menu-body { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
.zw-hall-menu-actions { display: flex; flex-direction: column; gap: 8px; }
.zw-hall-menu-action { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(240,195,94,0.2); background: rgba(255,236,200,0.07); color: #f1e9dd; text-align: left; cursor: pointer; font-family: inherit; }
.zw-hall-menu-action:hover, .zw-hall-menu-action:focus-visible { background: rgba(255,214,140,0.16); border-color: rgba(240,195,94,0.6); outline: none; }
.zw-hall-menu-icon { flex: none; width: 42px; height: 42px; border-radius: 10px; display: grid; place-items: center; font-size: 22px; }
.zw-hall-menu-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.zw-hall-menu-action-title { font: 700 15px "Segoe UI", system-ui, sans-serif; color: #f6deb0; }
.zw-hall-menu-action-detail { font-size: 12px; color: #cdbfa6; }
.zw-hall-people-top { display: flex; align-items: center; gap: 10px; }
.zw-hall-people-count { color: #d9b77a; font-weight: 600; font-size: 13px; }
.zw-hall-people { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; overflow-y: auto; max-height: 56vh; }
.zw-hall-person { width: 100%; display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 8px; border: 1px solid transparent; background: rgba(10,6,2,0.3); color: #f1e9dd; font-family: inherit; text-align: left; cursor: pointer; }
.zw-hall-person:hover:not(:disabled), .zw-hall-person:focus-visible { border-color: rgba(240,195,94,0.55); background: rgba(255,214,140,0.12); outline: none; }
.zw-hall-person:disabled { cursor: default; opacity: 0.9; }
.zw-hall-person-swatch { flex: none; width: 12px; height: 12px; border-radius: 50%; }
.zw-hall-person-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.zw-hall-person-name { font-weight: 700; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zw-hall-person-self .zw-hall-person-name { color: #9fd4ff; }
.zw-hall-person-place { font-size: 11px; color: #b9ae9c; }
.zw-hall-person-badges { display: flex; gap: 4px; flex: none; }
.zw-hall-person-badge { padding: 1px 6px; border-radius: 999px; background: rgba(240,195,94,0.16); font-size: 12px; color: #f4e3c1; }
.zw-hall-people-empty { margin: 0; color: #b9ae9c; font-size: 12px; }
`;
  document.head.appendChild(style);
}
