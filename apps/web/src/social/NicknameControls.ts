import { injectUiStyles } from "../ui/styles.ts";
import { MAX_NICKNAME_LENGTH } from "@project/shared";

/**
 * Always-on (not dev-gated), minimal nickname entry/edit control
 * (CORE-003 §4). Deliberately not a blocking pre-join modal: it never
 * steals keyboard focus on its own (no auto-focus) and never shares a
 * CSS class with `ProjectDiscoveryPanel`'s backdrop, so it cannot
 * interfere with movement/interaction or with the existing CORE-001 e2e
 * suite.
 *
 * The user's nickname choice always reaches the server as a
 * `set_nickname` request (never a change to the initial `join`) — see
 * `App.ts`. This keeps exactly one code path for "the nickname changed",
 * rather than duplicating validation/conflict-handling for a pre-join
 * case. The server is authoritative either way: whatever actually lands
 * comes back via `nickname_updated` and is reflected here through
 * `setCurrentNickname()`.
 */
export class NicknameControls {
  private readonly element: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private onSubmitCallback: (nickname: string) => void = () => {};

  constructor(container: HTMLElement) {
    injectUiStyles();

    this.element = document.createElement("div");
    this.element.className = "zw-ui zw-panel zw-nickname-controls";

    const label = document.createElement("span");
    label.textContent = "Nickname:";
    this.element.appendChild(label);

    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "zw-input";
    this.input.maxLength = MAX_NICKNAME_LENGTH;
    this.input.placeholder = "Guest";
    this.element.appendChild(this.input);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "zw-button";
    button.textContent = "Set";
    button.addEventListener("click", () => this.submit());
    this.element.appendChild(button);

    this.input.addEventListener("keydown", (event) => {
      // Stop propagation so a held key here (e.g. typing "West") never
      // reaches the global InputManager listener on `window` — see
      // InputManager's own input-focus guard for the belt-and-suspenders
      // half of this fix.
      event.stopPropagation();
      if (event.key === "Enter") this.submit();
    });

    container.appendChild(this.element);
  }

  onNicknameSubmit(callback: (nickname: string) => void): void {
    this.onSubmitCallback = callback;
  }

  /** Reflects the server-confirmed nickname (e.g. after conflict-suffixing) — called from `welcome`/`nickname_updated`. Setting `.value` is a safe property assignment, never markup. */
  setCurrentNickname(nickname: string): void {
    this.input.value = nickname;
  }

  private submit(): void {
    const value = this.input.value.trim();
    if (value.length === 0) return;
    this.onSubmitCallback(value);
  }

  dispose(): void {
    this.element.remove();
  }
}
